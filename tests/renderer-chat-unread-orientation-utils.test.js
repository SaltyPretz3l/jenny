const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createUnreadOrientationController,
} = require('../renderer/chat/renderer-chat-unread-orientation-utils');

function buildHarness(options = {}) {
  const dom = new JSDOM(
    '<!doctype html><html><body>'
      + '<div id="scroll"><div id="timeline">'
      + '<article class="chat-entry" data-message-id="a1" tabindex="-1"></article>'
      + '<article class="chat-entry" data-message-id="a2" tabindex="-1" data-virtualized="true"></article>'
      + '</div></div>'
      + '</body></html>'
  );
  const calls = [];
  const state = {
    currentSessionId: 's1',
    ui: { activeView: 'chat' },
  };
  let metrics = options.metrics || { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 };
  const controller = createUnreadOrientationController({
    state,
    document: dom.window.document,
    chatTimeline: dom.window.document.getElementById('timeline'),
    chatThreadScroll: dom.window.document.getElementById('scroll'),
    getCurrentSessionId: () => state.currentSessionId,
    getCurrentSessionMessages: options.getCurrentSessionMessages || (() => options.messages || [
      { id: 'a1', role: 'assistant' },
      { id: 'a2', role: 'assistant' },
    ]),
    getScrollMetrics: () => metrics,
    scrollMessageIntoView(messageId, scrollOptions) {
      calls.push(['scroll', messageId, scrollOptions.block, scrollOptions.followLatest]);
      return options.scrollResult !== false;
    },
    focusEntryByMessageId(messageId) {
      calls.push(['focus', messageId]);
      return true;
    },
    timelineVirtualizer: {
      ensureMounted(entryEl) {
        calls.push(['ensureMounted', entryEl.getAttribute('data-message-id')]);
        entryEl.removeAttribute('data-virtualized');
      },
    },
  });
  return {
    calls,
    controller,
    dom,
    state,
    setMetrics(next) {
      metrics = next;
    },
  };
}

test('F10: marks first unread for a visible assistant append when user is not near bottom', () => {
  const harness = buildHarness();

  const didMark = harness.controller.noteTimelineMessageCreated({
    sessionId: 's1',
    messageId: 'a1',
    role: 'assistant',
    visible: true,
  });

  assert.equal(didMark, true);
  assert.equal(harness.state.ui.firstUnreadMessageIdBySession.get('s1'), 'a1');
  assert.equal(harness.calls.length, 0, 'marking unread is pure state - the Wayfinder renders it');
});

test('F10: ignores user rows, hidden sessions, and near-bottom appends', () => {
  const harness = buildHarness({
    metrics: { scrollTop: 652, scrollHeight: 1000, clientHeight: 300 },
  });

  assert.equal(harness.controller.noteTimelineMessageCreated({
    sessionId: 's1',
    messageId: 'u1',
    role: 'user',
    visible: true,
  }), false);
  assert.equal(harness.controller.noteTimelineMessageCreated({
    sessionId: 'other',
    messageId: 'a1',
    role: 'assistant',
    visible: true,
  }), false);
  assert.equal(harness.controller.noteTimelineMessageCreated({
    sessionId: 's1',
    messageId: 'a1',
    role: 'assistant',
    visible: true,
  }), false);
  assert.equal(harness.state.ui.firstUnreadMessageIdBySession?.has('s1'), false);
});

test('F10: jump mounts virtualized target, scrolls, focuses, and clears unread state', () => {
  const harness = buildHarness();
  harness.controller.noteTimelineMessageCreated({
    sessionId: 's1',
    messageId: 'a2',
    role: 'assistant',
    visible: true,
  });

  const didJump = harness.controller.jumpToFirstUnread();

  assert.equal(didJump, true);
  assert.deepEqual(harness.calls.filter((entry) => ['ensureMounted', 'scroll', 'focus'].includes(entry[0])), [
    ['ensureMounted', 'a2'],
    ['scroll', 'a2', 'center', false],
    ['focus', 'a2'],
  ]);
  assert.equal(harness.state.ui.firstUnreadMessageIdBySession.has('s1'), false);
});

test('F10: scrolling back near bottom clears unread state', () => {
  const harness = buildHarness();
  harness.controller.noteTimelineMessageCreated({
    sessionId: 's1',
    messageId: 'a1',
    role: 'assistant',
    visible: true,
  });

  harness.setMetrics({ scrollTop: 660, scrollHeight: 1000, clientHeight: 300 });
  assert.equal(harness.controller.handleScroll(), true);

  assert.equal(harness.state.ui.firstUnreadMessageIdBySession.has('s1'), false);
});

test('F10: off-bottom scroll affordance sync avoids message scans', () => {
  let messageReads = 0;
  const harness = buildHarness({
    getCurrentSessionMessages() {
      messageReads += 1;
      return [{ id: 'a1', role: 'assistant' }];
    },
  });
  harness.controller.noteTimelineMessageCreated({
    sessionId: 's1',
    messageId: 'a1',
    role: 'assistant',
    visible: true,
  });
  messageReads = 0;

  assert.equal(harness.controller.handleScroll(), false);

  assert.equal(messageReads, 0);
  assert.equal(harness.state.ui.firstUnreadMessageIdBySession.get('s1'), 'a1');
});

test('F10: timeline rerender after a session switch syncs the unread affordance', async () => {
  const harness = buildHarness();
  harness.controller.attachAffordance();
  harness.controller.noteTimelineMessageCreated({
    sessionId: 's1',
    messageId: 'a1',
    role: 'assistant',
    visible: true,
  });
  harness.calls.length = 0;

  harness.state.currentSessionId = 's2';
  harness.dom.window.document
    .getElementById('timeline')
    .appendChild(harness.dom.window.document.createElement('article'));
  await new Promise((resolve) => harness.dom.window.setTimeout(resolve, 0));

  assert.deepEqual(harness.calls, [], 'the mutation-observer sync is renderless');
  assert.equal(harness.state.ui.firstUnreadMessageIdBySession.get('s1'), 'a1');
});

test('F10 hardening: malformed message ids do not throw during jump resolution', () => {
  const malformedId = 'assistant\nbad';
  const harness = buildHarness({
    messages: [{ id: malformedId, role: 'assistant' }],
    scrollResult: false,
  });
  harness.controller.noteTimelineMessageCreated({
    sessionId: 's1',
    messageId: malformedId,
    role: 'assistant',
    visible: true,
  });

  assert.doesNotThrow(() => {
    assert.equal(harness.controller.jumpToFirstUnread(), false);
  });
  assert.equal(harness.state.ui.firstUnreadMessageIdBySession.has('s1'), false);
});

test('F10: unread orientation reports state changes for the Wayfinder', () => {
  const stateChanges = [];
  const harness = buildHarness();
  const controller = createUnreadOrientationController({
    state: harness.state,
    document: harness.dom.window.document,
    chatTimeline: harness.dom.window.document.getElementById('timeline'),
    chatThreadScroll: harness.dom.window.document.getElementById('scroll'),
    getCurrentSessionId: () => harness.state.currentSessionId,
    getCurrentSessionMessages: () => [{ id: 'a1', role: 'assistant' }],
    getScrollMetrics: () => ({ scrollTop: 0, scrollHeight: 1000, clientHeight: 300 }),
    onStateChange(nextState) {
      stateChanges.push(nextState);
    },
  });

  assert.equal(controller.noteTimelineMessageCreated({
    sessionId: 's1',
    messageId: 'a1',
    role: 'assistant',
    visible: true,
  }), true);

  assert.equal(stateChanges.at(-1).visible, true);
  assert.equal(stateChanges.at(-1).hasUnread, true);
  assert.equal(stateChanges.at(-1).messageId, 'a1');

  const changeCountAfterFirstSync = stateChanges.length;
  controller.handleScroll();
  assert.equal(stateChanges.length, changeCountAfterFirstSync);
  assert.equal(stateChanges.at(-1).visible, true);

  controller.dispose();
});
