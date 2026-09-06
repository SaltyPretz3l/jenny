const test = require('node:test');

// Every controller this file builds is disposed after its test. A citation jump
// arms a REFERENCED highlight timer (renderer-chat-citation-jump-utils.js:368)
// and attach() adds a click listener; dispose() clears both. Fourteen cases
// called attach() and none disposed, so the file held the event loop ~2.2s past
// its last assertion.
const liveCitationControllers = [];
test.afterEach(() => {
  while (liveCitationControllers.length) {
    try { liveCitationControllers.pop().dispose(); } catch { /* already disposed */ }
  }
});
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createCitationJumpController,
  parseCitationHref,
} = require('../renderer/chat/renderer-chat-citation-jump-utils');

function buildDom(bodyHtml) {
  const dom = new JSDOM(
    '<!doctype html><html><body>'
      + '<div id="chatView">'
      + '<div id="chatTimeline" role="feed">'
      + bodyHtml
      + '</div>'
      + '</div>'
      + '</body></html>',
    { url: 'https://jenny.local/chat' }
  );
  const scrollCalls = [];
  dom.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) {
    scrollCalls.push([this.getAttribute('data-message-id') || this.getAttribute('data-row-id') || this.id || this.className, options]);
  };
  return { dom, scrollCalls };
}

function click(win, target) {
  const event = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function createRevealRecorder() {
  // W1a seam: row/tool jumps route through the shared reveal helper, so these
  // suites observe the jump there instead of on a raw scrollIntoView stub.
  const revealCalls = [];
  const viewportReveal = {
    revealElement(element, options) {
      revealCalls.push([
        element.getAttribute('data-row-id') || element.getAttribute('data-tool-call-id')
          || element.getAttribute('data-message-id') || '',
        options && options.followLatest,
        options && options.reason,
      ]);
      return true;
    },
  };
  return { revealCalls, viewportReveal };
}

test('F12 parser accepts only encoded internal citation fragments', () => {
  assert.deepEqual(parseCitationHref('#message:user_1'), { kind: 'message', id: 'user_1' });
  assert.deepEqual(parseCitationHref('#tool:call%3A1'), { kind: 'tool', id: 'call:1' });
  assert.deepEqual(
    parseCitationHref('https://jenny.local/chat#row:turn%3Atool%3A1', 'https://jenny.local/chat'),
    { kind: 'row', id: 'turn:tool:1' }
  );

  assert.equal(parseCitationHref('#message:'), null);
  assert.equal(parseCitationHref('#message:bad%0Aid'), null);
  assert.equal(parseCitationHref('#unknown:m1'), null);
  assert.equal(parseCitationHref('https://example.test/#message:m1'), null);
});

test('F12 message citation click scrolls, focuses, highlights, and prevents default', () => {
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="cite" href="#message:m2">previous</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="m2" tabindex="-1"></article>'
  );
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    scrollMessageIntoView(messageId, options) {
      calls.push(['scroll', messageId, options.block, options.followLatest]);
      return true;
    },
    focusEntryByMessageId(messageId) {
      calls.push(['focus', messageId]);
      return true;
    },
    appendClientLog(level, eventName, payload) {
      calls.push(['log', level, eventName, payload.targetKind]);
    },
  });
  liveCitationControllers.push(controller);
  controller.attach();

  const event = click(dom.window, dom.window.document.getElementById('cite'));

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(calls, [
    ['scroll', 'm2', 'center', false],
    ['focus', 'm2'],
    ['log', 'INFO', 'chat.citation_jump', 'message'],
  ]);
  assert.equal(
    dom.window.document.querySelector('[data-message-id="m2"]').classList.contains('chat-citation-target-highlight'),
    true
  );
});

test('F12 ordinary links are not intercepted', () => {
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="plain" href="#plain-anchor">plain</a></div>'
      + '</article>'
  );
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    appendClientLog(level, eventName) {
      calls.push([level, eventName]);
    },
  });
  liveCitationControllers.push(controller);
  controller.attach();

  const event = click(dom.window, dom.window.document.getElementById('plain'));

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(calls, []);
});

test('F12 citation fragments outside Markdown bubbles are not intercepted', () => {
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble"><a id="plainBubble" href="#message:m2">plain</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="m2" tabindex="-1"></article>'
  );
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    scrollMessageIntoView(messageId) {
      calls.push(['scroll', messageId]);
      return true;
    },
  });
  liveCitationControllers.push(controller);
  controller.attach();

  const event = click(dom.window, dom.window.document.getElementById('plainBubble'));

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(calls, []);
});

test('F12 tool citations resolve the owning message and fall back to article highlight', () => {
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeTool" href="#tool:call-1">tool</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="tool-source" tabindex="-1" data-virtualized="true"></article>'
  );
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    getCurrentSessionMessages: () => [
      { id: 'tool-source', kind: 'tool_use', tool_call: { call_id: 'call-1' } },
    ],
    timelineVirtualizer: {
      ensureMounted(entryEl) {
        calls.push(['ensureMounted', entryEl.getAttribute('data-message-id')]);
        entryEl.removeAttribute('data-virtualized');
      },
    },
    scrollMessageIntoView(messageId, options) {
      calls.push(['scroll', messageId, options.block, options.followLatest]);
      return true;
    },
    focusEntryByMessageId(messageId) {
      calls.push(['focus', messageId]);
      return true;
    },
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeTool'));

  assert.deepEqual(calls, [
    ['ensureMounted', 'tool-source'],
    ['scroll', 'tool-source', 'center', false],
    ['focus', 'tool-source'],
  ]);
  assert.equal(
    dom.window.document.querySelector('[data-message-id="tool-source"]').classList.contains('chat-citation-target-highlight'),
    true
  );
});

test('F12 tool citations prefer the tool row after virtualizer mount restores it', () => {
  const reveal = createRevealRecorder();
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeTool" href="#tool:call-2">tool</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="tool-source" tabindex="-1" data-virtualized="true"></article>'
  );
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    getCurrentSessionMessages: () => [
      { id: 'tool-source', kind: 'tool_result', tool_result: { call_id: 'call-2' } },
    ],
    timelineVirtualizer: {
      ensureMounted(entryEl) {
        calls.push(['ensureMounted', entryEl.getAttribute('data-message-id')]);
        entryEl.removeAttribute('data-virtualized');
        entryEl.innerHTML = '<div class="chat-row" data-row-id="row:call-2" data-tool-call-id="call-2"></div>';
      },
    },
    scrollMessageIntoView(messageId, options) {
      calls.push(['scroll', messageId, options.block, options.followLatest]);
      return true;
    },
    focusEntryByMessageId(messageId) {
      calls.push(['focus', messageId]);
      return true;
    },
    viewportReveal: reveal.viewportReveal,
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeTool'));

  assert.deepEqual(calls, [
    ['ensureMounted', 'tool-source'],
    ['scroll', 'tool-source', 'center', false],
    ['focus', 'tool-source'],
  ]);
  assert.deepEqual(reveal.revealCalls.map((entry) => entry[0]), ['row:call-2']);
  assert.equal(dom.window.document.querySelector('[data-row-id="row:call-2"]').classList.contains('chat-citation-target-highlight'), true);
  assert.equal(dom.window.document.querySelector('[data-message-id="tool-source"]').classList.contains('chat-citation-target-highlight'), false);
});

test('F12 tool citations resolve assistant tool_calls arrays from session messages', () => {
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeTool" href="#tool:call-array-1">tool</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="assistant-tools" tabindex="-1" data-virtualized="true"></article>'
  );
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    getCurrentSessionMessages: () => [
      { id: 'assistant-tools', role: 'assistant', tool_calls: [{ id: 'call-array-1', function: { name: 'search' } }] },
    ],
    timelineVirtualizer: {
      ensureMounted(entryEl) {
        calls.push(['ensureMounted', entryEl.getAttribute('data-message-id')]);
        entryEl.removeAttribute('data-virtualized');
      },
    },
    scrollMessageIntoView(messageId, options) {
      calls.push(['scroll', messageId, options.block, options.followLatest]);
      return true;
    },
    focusEntryByMessageId(messageId) {
      calls.push(['focus', messageId]);
      return true;
    },
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeTool'));

  assert.deepEqual(calls, [
    ['ensureMounted', 'assistant-tools'],
    ['scroll', 'assistant-tools', 'center', false],
    ['focus', 'assistant-tools'],
  ]);
  assert.equal(
    dom.window.document.querySelector('[data-message-id="assistant-tools"]').classList.contains('chat-citation-target-highlight'),
    true
  );
});

test('F12 tool citations prefer result messages over assistant tool_calls fallback', () => {
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeTool" href="#tool:call-shared">tool</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="assistant-call" tabindex="-1" data-virtualized="true"></article>'
      + '<article class="chat-entry" data-message-id="tool-result-message" tabindex="-1" data-virtualized="true"></article>'
  );
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    getCurrentSessionMessages: () => [
      { id: 'assistant-call', role: 'assistant', tool_calls: [{ id: 'call-shared' }] },
      { id: 'tool-result-message', role: 'tool', tool_call_id: 'call-shared', content: 'done' },
    ],
    timelineVirtualizer: {
      ensureMounted(entryEl) {
        calls.push(['ensureMounted', entryEl.getAttribute('data-message-id')]);
        entryEl.removeAttribute('data-virtualized');
      },
    },
    scrollMessageIntoView(messageId, options) {
      calls.push(['scroll', messageId, options.block, options.followLatest]);
      return true;
    },
    focusEntryByMessageId(messageId) {
      calls.push(['focus', messageId]);
      return true;
    },
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeTool'));

  assert.deepEqual(calls, [
    ['ensureMounted', 'tool-result-message'],
    ['scroll', 'tool-result-message', 'center', false],
    ['focus', 'tool-result-message'],
  ]);
});

test('F12 tool citation cache rebuilds after an in-place same-length message update', () => {
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeTool" href="#tool:call-mutated">tool</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="tool-source" tabindex="-1"></article>'
  );
  const messages = [
    { id: 'other-tool-source', role: 'tool', tool_call_id: 'other-call', content: 'old' },
  ];
  const calls = [];
  const logs = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    getCurrentSessionMessages: () => messages,
    scrollMessageIntoView(messageId, options) {
      calls.push(['scroll', messageId, options.block, options.followLatest]);
      return true;
    },
    focusEntryByMessageId(messageId) {
      calls.push(['focus', messageId]);
      return true;
    },
    appendClientLog(level, eventName, payload) {
      logs.push([level, eventName, payload.targetKind, payload.reason || '']);
    },
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeTool'));
  messages[0] = { id: 'tool-source', role: 'tool', tool_call_id: 'call-mutated', content: 'new' };
  click(dom.window, dom.window.document.getElementById('citeTool'));

  assert.deepEqual(calls, [
    ['scroll', 'tool-source', 'center', false],
    ['focus', 'tool-source'],
  ]);
  assert.deepEqual(logs, [
    ['WARN', 'chat.citation_jump_failed', 'tool', 'target_not_found'],
    ['INFO', 'chat.citation_jump', 'tool', ''],
  ]);
});

test('F12 tool citation cache validates stale hits after same-length message replacement', () => {
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeTool" href="#tool:call-stale">tool</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="old-tool-source" tabindex="-1"></article>'
      + '<article class="chat-entry" data-message-id="new-tool-source" tabindex="-1"></article>'
  );
  const messages = [
    { id: 'old-tool-source', role: 'tool', tool_call_id: 'call-stale', content: 'old' },
  ];
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    getCurrentSessionMessages: () => messages,
    scrollMessageIntoView(messageId, options) {
      calls.push(['scroll', messageId, options.block, options.followLatest]);
      return true;
    },
    focusEntryByMessageId(messageId) {
      calls.push(['focus', messageId]);
      return true;
    },
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeTool'));
  messages[0] = { id: 'new-tool-source', role: 'tool', tool_call_id: 'call-stale', content: 'new' };
  click(dom.window, dom.window.document.getElementById('citeTool'));

  assert.deepEqual(calls, [
    ['scroll', 'old-tool-source', 'center', false],
    ['focus', 'old-tool-source'],
    ['scroll', 'new-tool-source', 'center', false],
    ['focus', 'new-tool-source'],
  ]);
});

test('F12 mounted tool citations re-resolve the row after virtualizer remount', () => {
  const reveal = createRevealRecorder();
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeTool" href="#tool:stale-call">tool</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="tool-source" tabindex="-1" data-virtualized="true">'
      + '<div class="chat-row" data-row-id="stale-row" data-tool-call-id="stale-call"></div>'
      + '</article>'
  );
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    timelineVirtualizer: {
      ensureMounted(entryEl) {
        calls.push(['ensureMounted', entryEl.getAttribute('data-message-id')]);
        entryEl.removeAttribute('data-virtualized');
        entryEl.innerHTML = '<div class="chat-row" data-row-id="fresh-row" data-tool-call-id="stale-call"></div>';
      },
    },
    viewportReveal: reveal.viewportReveal,
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeTool'));

  assert.deepEqual(calls, [['ensureMounted', 'tool-source']]);
  assert.deepEqual(reveal.revealCalls.map((entry) => entry[0]), ['fresh-row']);
  assert.equal(dom.window.document.querySelector('[data-row-id="fresh-row"]').classList.contains('chat-citation-target-highlight'), true);
});

test('F12 row citations scroll and highlight direct row targets', () => {
  const reveal = createRevealRecorder();
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeRow" href="#row:turn%3Atool%3A1">row</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="m2" tabindex="-1">'
      + '<div class="chat-row" data-row-id="turn:tool:1"></div>'
      + '</article>'
  );
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    focusEntryByMessageId(messageId) {
      calls.push(['focus', messageId]);
      return true;
    },
    viewportReveal: reveal.viewportReveal,
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeRow'));

  assert.equal(reveal.revealCalls.length, 1);
  assert.equal(reveal.revealCalls[0][0], 'turn:tool:1');
  assert.deepEqual(calls, [['focus', 'm2']]);
  assert.equal(dom.window.document.querySelector('[data-row-id="turn:tool:1"]').classList.contains('chat-citation-target-highlight'), true);
});

test('F12 row citations mount a virtualized owning entry before resolving row DOM', () => {
  const reveal = createRevealRecorder();
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="citeRow" href="#row:virtual-row">row</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="m2" tabindex="-1" data-virtualized="true">'
      + '<div class="chat-entry-virtualized" aria-hidden="true"></div>'
      + '</article>'
  );
  const calls = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    timelineVirtualizer: {
      ensureMountedForRowId(rowId) {
        calls.push(['ensureRow', rowId]);
        const entry = dom.window.document.querySelector('[data-message-id="m2"]');
        entry.removeAttribute('data-virtualized');
        entry.innerHTML = '<div class="chat-row" data-row-id="virtual-row"></div>';
        return true;
      },
    },
    viewportReveal: reveal.viewportReveal,
  });
  liveCitationControllers.push(controller);
  controller.attach();

  click(dom.window, dom.window.document.getElementById('citeRow'));

  assert.deepEqual(calls, [['ensureRow', 'virtual-row']]);
  assert.deepEqual(reveal.revealCalls.map((entry) => entry[0]), ['virtual-row']);
  assert.equal(dom.window.document.querySelector('[data-row-id="virtual-row"]').classList.contains('chat-citation-target-highlight'), true);
});

test('F12 missing citation targets log a bounded warning and do not throw', () => {
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="missing" href="#message:missing">missing</a></div>'
      + '</article>'
  );
  const logs = [];
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    scrollMessageIntoView() {
      return false;
    },
    appendClientLog(level, eventName, payload) {
      logs.push([level, eventName, payload.targetKind, payload.reason]);
    },
  });
  liveCitationControllers.push(controller);
  controller.attach();

  assert.doesNotThrow(() => click(dom.window, dom.window.document.getElementById('missing')));
  assert.deepEqual(logs, [['WARN', 'chat.citation_jump_failed', 'message', 'target_not_found']]);
});

test('F12 detach removes the click listener and dispose clears highlights', () => {
  const { dom } = buildDom(
    '<article class="chat-entry" data-message-id="m1" tabindex="-1">'
      + '<div class="chat-bubble-markdown"><a id="cite" href="#message:m2">previous</a></div>'
      + '</article>'
      + '<article class="chat-entry" data-message-id="m2" tabindex="-1"></article>'
  );
  const target = dom.window.document.querySelector('[data-message-id="m2"]');
  const controller = createCitationJumpController({
    document: dom.window.document,
    window: dom.window,
    chatTimeline: dom.window.document.getElementById('chatTimeline'),
    scrollMessageIntoView() {
      return true;
    },
    highlightDurationMs: 9999,
  });
  liveCitationControllers.push(controller);
  const detach = controller.attach();

  const firstClick = click(dom.window, dom.window.document.getElementById('cite'));
  assert.equal(firstClick.defaultPrevented, true);
  assert.equal(target.classList.contains('chat-citation-target-highlight'), true);

  controller.dispose();
  assert.equal(target.classList.contains('chat-citation-target-highlight'), false);

  detach();
  const secondClick = click(dom.window, dom.window.document.getElementById('cite'));
  assert.equal(secondClick.defaultPrevented, false);
});
