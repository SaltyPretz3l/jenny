const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createUnsavedReplyActionController,
  renderUnsavedReplyNotice,
} = require('../renderer/chat/renderer-unsaved-reply-actions');

function buildNoticeDom(messageId = 'assistant_1', artifactId = 'repair_1') {
  const markup = renderUnsavedReplyNotice(
    { id: messageId },
    { unsavedReply: { visible: true, artifactId } }
  );
  const dom = new JSDOM('<!DOCTYPE html><html><body>'
    + `<article class="chat-entry assistant" data-message-id="${messageId}">${markup}</article>`
    + '</body></html>');
  return { dom, notice: dom.window.document.querySelector('[data-unsaved-reply-notice]') };
}

test('renders a visible Unsaved badge with keyboard-native retry, copy, and discard actions', () => {
  const { dom, notice } = buildNoticeDom();

  assert.ok(notice);
  assert.equal(notice.textContent.includes('Unsaved'), true);
  assert.equal(notice.textContent.includes('Not yet saved to chat history.'), true);
  assert.deepEqual(
    [...notice.querySelectorAll('button')].map((button) => button.textContent.trim()),
    ['Retry save', 'Copy', 'Discard']
  );
  assert.deepEqual(
    [...notice.querySelectorAll('button')].map((button) => button.title),
    ['Retry saving this reply', 'Copy this reply', 'Discard this unsaved reply']
  );
  assert.equal(
    dom.window.document.querySelector('[data-unsaved-reply-action="retry"]').tagName,
    'BUTTON'
  );
});

test('retry save uses the additive IPC and mutates cache/DOM only after durable success', async () => {
  const { dom, notice } = buildNoticeDom();
  const current = {
    id: 'assistant_1', role: 'assistant', status: 'complete', content: 'keep me',
    durability: { state: 'unsaved', artifact_id: 'repair_1' },
  };
  const state = {
    currentSessionId: 'session_1',
    messagesBySession: new Map([['session_1', [current]]]),
  };
  const calls = [];
  const resolvedCalls = [];
  let regenerateCalls = 0;
  let resolveRetry;
  dom.window.jennyShell = {
    chat: {
      retryUnsavedReply(payload) {
        calls.push(payload);
        return new Promise((resolve) => { resolveRetry = resolve; });
      },
      editAndRegenerate() { regenerateCalls += 1; },
    },
  };
  const controller = createUnsavedReplyActionController({
    state,
    windowRef: dom.window,
    onResolved: async (value) => resolvedCalls.push(value),
  });
  const retryButton = notice.querySelector('[data-unsaved-reply-action="retry"]');

  const pending = controller.dispatch(retryButton);
  await Promise.resolve();

  assert.equal(notice.isConnected, true, 'the notice remains while durability is unconfirmed');
  assert.equal(state.messagesBySession.get('session_1')[0].durability.state, 'unsaved');
  assert.equal(retryButton.disabled, true);

  resolveRetry({
    ok: true,
    durable: true,
    reason: null,
    message: { id: 'assistant_1', role: 'assistant', status: 'complete', content: 'keep me' },
  });
  await pending;

  assert.deepEqual(calls, [{
    sessionId: 'session_1', messageId: 'assistant_1', artifactId: 'repair_1',
  }]);
  assert.equal(regenerateCalls, 0, 'save retry never regenerates model output');
  assert.equal(notice.isConnected, false);
  assert.equal(state.messagesBySession.get('session_1')[0].durability, undefined);
  assert.equal(resolvedCalls.length, 1);
  assert.equal(resolvedCalls[0].action, 'retry');
  assert.deepEqual(resolvedCalls[0].payload, calls[0]);
});

test('a refresh failure does not reverse confirmed retry durability', async () => {
  const { dom, notice } = buildNoticeDom();
  const logs = [];
  const state = {
    currentSessionId: 'session_1',
    messagesBySession: new Map([['session_1', [{
      id: 'assistant_1', role: 'assistant', status: 'complete', content: 'keep me',
      durability: { state: 'unsaved', artifact_id: 'repair_1' },
    }]]]),
  };
  dom.window.jennyShell = {
    chat: {
      retryUnsavedReply: async () => ({ ok: true, durable: true, reason: null }),
    },
  };
  const controller = createUnsavedReplyActionController({
    state,
    windowRef: dom.window,
    onResolved: async () => { throw new Error('refresh unavailable'); },
    appendClientLog: (level, event) => logs.push({ level, event }),
  });

  assert.equal(await controller.dispatch(
    notice.querySelector('[data-unsaved-reply-action="retry"]')
  ), true);

  assert.equal(notice.isConnected, false);
  assert.equal(state.messagesBySession.get('session_1')[0].durability, undefined);
  assert.equal(logs.some((entry) => entry.event === 'chat.unsaved_reply_refresh_failed'), true);
});

test('non-durable retry result leaves the unsaved reply and cache untouched', async () => {
  const { dom, notice } = buildNoticeDom();
  const current = {
    id: 'assistant_1', role: 'assistant', status: 'complete', content: 'keep me',
    durability: { state: 'unsaved', artifact_id: 'repair_1' },
  };
  const state = {
    currentSessionId: 'session_1',
    messagesBySession: new Map([['session_1', [current]]]),
  };
  dom.window.jennyShell = {
    chat: {
      retryUnsavedReply: async () => ({ ok: true, durable: false, reason: 'write_failed' }),
    },
  };
  const controller = createUnsavedReplyActionController({ state, windowRef: dom.window });
  const retryButton = notice.querySelector('[data-unsaved-reply-action="retry"]');

  await assert.rejects(() => controller.dispatch(retryButton), /could not save/i);

  assert.equal(notice.isConnected, true);
  assert.equal(state.messagesBySession.get('session_1')[0], current);
  assert.equal(retryButton.disabled, false);
});

test('discard removes the cached reply and visible article only after durable success', async () => {
  const { dom, notice } = buildNoticeDom();
  const current = {
    id: 'assistant_1', role: 'assistant', status: 'complete', content: 'discard me',
    durability: { state: 'unsaved', artifact_id: 'repair_1' },
  };
  const state = {
    currentSessionId: 'session_1',
    messagesBySession: new Map([['session_1', [current]]]),
  };
  let resolveDiscard;
  dom.window.jennyShell = {
    chat: {
      discardUnsavedReply: () => new Promise((resolve) => { resolveDiscard = resolve; }),
    },
  };
  const controller = createUnsavedReplyActionController({ state, windowRef: dom.window });
  const discardButton = notice.querySelector('[data-unsaved-reply-action="discard"]');

  const pending = controller.dispatch(discardButton);
  await Promise.resolve();
  assert.equal(dom.window.document.querySelector('.chat-entry').isConnected, true);
  assert.equal(state.messagesBySession.get('session_1').length, 1);

  resolveDiscard({
    ok: true, durable: true, reason: null, removedMessageId: 'assistant_1',
  });
  await pending;

  assert.equal(dom.window.document.querySelector('.chat-entry'), null);
  assert.deepEqual(state.messagesBySession.get('session_1'), []);
});

test('copy delegates to the existing copy handler without calling durability IPC', async () => {
  const { dom, notice } = buildNoticeDom();
  const copied = [];
  let durabilityCalls = 0;
  dom.window.jennyShell = {
    chat: {
      retryUnsavedReply: () => { durabilityCalls += 1; },
      discardUnsavedReply: () => { durabilityCalls += 1; },
    },
  };
  const controller = createUnsavedReplyActionController({
    state: { currentSessionId: 'session_1' },
    windowRef: dom.window,
    handleCopyMessage: async (messageId) => copied.push(messageId),
  });

  await controller.dispatch(notice.querySelector('[data-unsaved-reply-action="copy"]'));

  assert.deepEqual(copied, ['assistant_1']);
  assert.equal(durabilityCalls, 0);
});
