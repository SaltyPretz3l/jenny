/* Composer V2 failed-send notice — surfaces `message.send_failure` annotation
 * (from Phase 1A / N1) as a danger-toned notice with Retry / Dismiss buttons,
 * and tags the corresponding user-message bubble with data-message-state="failed". */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createComposerFailedSendNoticeRenderer } = require('../renderer/chat/renderer-composer-v2-render');

function buildHarness(t) {
  const dom = new JSDOM('<!doctype html><body>'
    + '<div id="composerV2FailedSendNotice" class="hidden"></div>'
    + '<div id="chatTimeline"></div>'
    + '</body>');
  const doc = dom.window.document;
  const noticeNode = doc.getElementById('composerV2FailedSendNotice');
  const chatThread = doc.getElementById('chatTimeline');

  const state = { currentSessionId: 's1', messagesBySession: new Map([['s1', []]]) };
  const calls = { retries: [], dismisses: [] };

  function getMessagesForSession(sessionId) {
    return state.messagesBySession.get(sessionId) || [];
  }
  function setMessagesForSession(sessionId, msgs) {
    state.messagesBySession.set(sessionId, msgs);
    renderThread();
  }
  function renderThread() {
    const msgs = state.messagesBySession.get(state.currentSessionId) || [];
    chatThread.replaceChildren();
    for (const message of msgs) {
      const article = doc.createElement('article');
      article.setAttribute('data-message-id', String(message.id || ''));
      article.className = 'chat-entry ' + String(message.role || '');
      const bubble = doc.createElement('div');
      bubble.className = 'chat-bubble';
      bubble.textContent = String(message.content || '');
      article.appendChild(bubble);
      chatThread.appendChild(article);
    }
  }

  return { dom, doc, noticeNode, chatThread, state, calls, getMessagesForSession, setMessagesForSession, renderThread };
}

function buildDeps(harness) {
  return {
    noticeNode: harness.noticeNode,
    chatThread: harness.chatThread,
    getCurrentSessionId: () => harness.state.currentSessionId,
    getMessagesForSession: (sid) => harness.getMessagesForSession(sid),
    onRetry: (info) => { harness.calls.retries.push(info); },
    onDismiss: (info) => {
      harness.calls.dismisses.push(info);
      const sid = info.sessionId;
      const next = harness.getMessagesForSession(sid).map((m) => {
        if (String(m.id) !== info.messageId) return m;
        return { ...m, send_failure: { ...m.send_failure, dismissed: true } };
      });
      harness.setMessagesForSession(sid, next);
    },
  };
}

function waitMicrotask(win) {
  return new Promise((resolve) => win.setTimeout(resolve, 0));
}

test('notice hidden when no message has send_failure annotation', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  t.after(() => renderer.destroy());
  harness.setMessagesForSession('s1', [
    { id: 'm1', role: 'user', content: 'hello' },
  ]);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.noticeNode.classList.contains('hidden'), true);
  assert.equal(harness.chatThread.querySelectorAll('[data-message-state="failed"]').length, 0);
});

test('notice appears and bubble is tagged when a user message has send_failure', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  t.after(() => renderer.destroy());
  harness.setMessagesForSession('s1', [
    { id: 'm1', role: 'user', content: 'hi', send_failure: { state: 'failed', reason: 'start_stream_rejected' } },
  ]);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.noticeNode.classList.contains('hidden'), false);
  assert.match(harness.noticeNode.textContent, /Last message failed to send/);
  const retry = harness.noticeNode.querySelector('.composer-failed-send-notice-button--retry');
  const dismiss = harness.noticeNode.querySelector('.composer-failed-send-notice-button--dismiss');
  assert.equal(retry.title, 'Retry sending this message');
  assert.equal(dismiss.title, 'Dismiss this error');
  const tagged = harness.chatThread.querySelector('[data-message-id="m1"] .chat-bubble');
  assert.equal(tagged.getAttribute('data-message-state'), 'failed');
});

test('retry button invokes onRetry with sessionId + messageId', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  t.after(() => renderer.destroy());
  harness.setMessagesForSession('s1', [
    { id: 'm1', role: 'user', content: 'hi', send_failure: { state: 'failed', restored_to_composer: true } },
  ]);
  await waitMicrotask(harness.dom.window);
  harness.noticeNode.querySelector('.composer-failed-send-notice-button--retry').click();
  assert.equal(harness.calls.retries.length, 1);
  assert.equal(harness.calls.retries[0].sessionId, 's1');
  assert.equal(harness.calls.retries[0].messageId, 'm1');
});
test('retry is disabled with a reason when its immutable payload is unavailable', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer({
    ...buildDeps(harness),
    getRetryAvailability: () => ({ available: false, reason: 'The original failed payload is no longer available.' }),
  });
  t.after(() => renderer.destroy());
  harness.setMessagesForSession('s1', [{ id: 'm1', role: 'user', content: 'hi', send_failure: { state: 'failed', payload_id: 'missing' } }]);
  await waitMicrotask(harness.dom.window);
  const retry = harness.noticeNode.querySelector('.composer-failed-send-notice-button--retry');
  assert.equal(retry.disabled, true);
  assert.equal(retry.title, 'The original failed payload is no longer available.');
  retry.click();
  assert.equal(harness.calls.retries.length, 0);
});
test('dismiss button invokes onDismiss and hides notice after annotation update', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  t.after(() => renderer.destroy());
  harness.setMessagesForSession('s1', [
    { id: 'm1', role: 'user', content: 'hi', send_failure: { state: 'failed' } },
  ]);
  await waitMicrotask(harness.dom.window);
  harness.noticeNode.querySelector('.composer-failed-send-notice-button--dismiss').click();
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.calls.dismisses.length, 1);
  assert.equal(harness.noticeNode.classList.contains('hidden'), true);
  // Bubble tag should also clear after dismiss propagates through the harness
  await waitMicrotask(harness.dom.window);
  const tagged = harness.chatThread.querySelectorAll('[data-message-state="failed"]');
  assert.equal(tagged.length, 0);
});

test('notice surfaces the most recent failed user message when multiple exist', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  t.after(() => renderer.destroy());
  harness.setMessagesForSession('s1', [
    { id: 'm1', role: 'user', content: 'first', send_failure: { state: 'failed' } },
    { id: 'm2', role: 'assistant', content: 'reply' },
    { id: 'm3', role: 'user', content: 'second', send_failure: { state: 'failed' } },
  ]);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.noticeNode.classList.contains('hidden'), false);
  // Most recent (m3) should be the tagged one
  assert.equal(harness.chatThread.querySelector('[data-message-id="m3"] .chat-bubble').getAttribute('data-message-state'), 'failed');
  // Earlier failed message should NOT be tagged (only one visible at a time)
  assert.equal(harness.chatThread.querySelector('[data-message-id="m1"] .chat-bubble').getAttribute('data-message-state'), null);
});

test('notice tags failed bubbles when message ids contain CSS selector punctuation', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  t.after(() => renderer.destroy());
  const specialId = 'm1"] .chat-bubble,[data-message-id="other';
  harness.setMessagesForSession('s1', [
    { id: specialId, role: 'user', content: 'hi', send_failure: { state: 'failed' } },
  ]);
  await waitMicrotask(harness.dom.window);
  const article = [...harness.chatThread.querySelectorAll('article')].find(
    (node) => node.getAttribute('data-message-id') === specialId
  );
  assert.ok(article, 'the harness should render the special message id as an attribute');
  assert.equal(article.querySelector('.chat-bubble').getAttribute('data-message-state'), 'failed');
});

test('notice ignores messages with send_failure.dismissed === true', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  t.after(() => renderer.destroy());
  harness.setMessagesForSession('s1', [
    { id: 'm1', role: 'user', content: 'hi', send_failure: { state: 'failed', dismissed: true } },
  ]);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.noticeNode.classList.contains('hidden'), true);
});

test('notice ignores send_failure on non-user messages', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  t.after(() => renderer.destroy());
  harness.setMessagesForSession('s1', [
    { id: 'm1', role: 'assistant', content: 'oops', send_failure: { state: 'failed' } },
  ]);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.noticeNode.classList.contains('hidden'), true);
});

test('notice clears when user switches to a session without failures', async (t) => {
  const harness = buildHarness(t);
  harness.state.messagesBySession.set('s2', []);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  t.after(() => renderer.destroy());
  harness.setMessagesForSession('s1', [
    { id: 'm1', role: 'user', content: 'hi', send_failure: { state: 'failed' } },
  ]);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.noticeNode.classList.contains('hidden'), false);
  harness.state.currentSessionId = 's2';
  // s2 thread render
  harness.chatThread.innerHTML = '';
  renderer.refresh();
  assert.equal(harness.noticeNode.classList.contains('hidden'), true);
});

test('destroy() disconnects observer, clears notice and bubble tags', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  harness.setMessagesForSession('s1', [
    { id: 'm1', role: 'user', content: 'hi', send_failure: { state: 'failed' } },
  ]);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.noticeNode.classList.contains('hidden'), false);
  renderer.destroy();
  assert.equal(harness.noticeNode.classList.contains('hidden'), true);
  assert.equal(harness.chatThread.querySelectorAll('[data-message-state="failed"]').length, 0);
  // Subsequent mutations should not re-render the notice
  harness.setMessagesForSession('s1', [
    { id: 'm2', role: 'user', content: 'next', send_failure: { state: 'failed' } },
  ]);
  await waitMicrotask(harness.dom.window);
  assert.equal(harness.noticeNode.classList.contains('hidden'), true);
});

test('renderer throws clear errors when deps are missing', () => {
  assert.throws(() => createComposerFailedSendNoticeRenderer({}), /noticeNode is required/);
  assert.throws(
    () => createComposerFailedSendNoticeRenderer({ noticeNode: {} }),
    /chatThread is required/,
  );
  assert.throws(
    () => createComposerFailedSendNoticeRenderer({ noticeNode: {}, chatThread: {} }),
    /getCurrentSessionId must be a function/,
  );
  assert.throws(
    () => createComposerFailedSendNoticeRenderer({
      noticeNode: {}, chatThread: {}, getCurrentSessionId: () => 's1',
    }),
    /getMessagesForSession must be a function/,
  );
  assert.throws(
    () => createComposerFailedSendNoticeRenderer({
      noticeNode: {}, chatThread: {}, getCurrentSessionId: () => 's1', getMessagesForSession: () => [],
    }),
    /onRetry must be a function/,
  );
  assert.throws(
    () => createComposerFailedSendNoticeRenderer({
      noticeNode: {}, chatThread: {}, getCurrentSessionId: () => 's1', getMessagesForSession: () => [], onRetry: () => {},
    }),
    /onDismiss must be a function/,
  );
});

test('retry button threads the failure metadata through to onRetry for branch selection', async (t) => {
  const harness = buildHarness(t);
  const renderer = createComposerFailedSendNoticeRenderer(buildDeps(harness));
  t.after(() => renderer.destroy());
  harness.setMessagesForSession('s1', [
    { id: 'm1', role: 'user', content: 'hi', send_failure: { state: 'failed', restored_to_composer: false } },
  ]);
  await waitMicrotask(harness.dom.window);
  harness.noticeNode.querySelector('.composer-failed-send-notice-button--retry').click();
  assert.equal(harness.calls.retries.length, 1);
  assert.equal(harness.calls.retries[0].failure.restored_to_composer, false, 'failure object reaches onRetry');
});

/* Chip rendering — the bubble builders emit .chat-bubble-send-status
 * straight from message.send_failure (single source of truth). */

const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');

function escapeHtmlForBuilder(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function createUserRowRenderer() {
  return createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml: escapeHtmlForBuilder,
    renderMarkdown(text) { return `<p>${escapeHtmlForBuilder(text)}</p>`; },
    renderStreamingMarkdownUnits(text) {
      return { html: `<p>${escapeHtmlForBuilder(text)}</p>`, units: [], changedStartIndex: 0 };
    },
    renderThinkingWidget() { return ''; },
    renderToolCallBlock() { return ''; },
    renderAgentStatusWidget() { return ''; },
    renderAssistantFailureNotice() { return ''; },
    renderContextCompactedNotice() { return ''; },
  });
}

function buildUserRow() {
  return {
    row_id: 'row:user',
    turn_id: 'turn_1',
    kind: 'user_bubble',
    primary_message_id: 'user_1',
    payload: { content: 'A prompt that failed to send' },
  };
}

test('V2 user bubble renders the failed-send chip from message.send_failure', () => {
  const renderer = createUserRowRenderer();
  const html = renderer.buildTurnRowListMarkup([buildUserRow()], [
    { id: 'user_1', role: 'user', content: 'A prompt that failed to send', send_failure: { state: 'failed' } },
  ]);

  assert.match(html, /chat-bubble-send-status/);
  assert.match(html, /Failed to send/);
  assert.match(html, /data-send-state="failed"/);
  assert.match(html, /role="status"/);
});

test('V2 user bubble renders no chip when the failure was dismissed or absent', () => {
  const renderer = createUserRowRenderer();
  const dismissedHtml = renderer.buildTurnRowListMarkup([buildUserRow()], [
    { id: 'user_1', role: 'user', content: 'A prompt that failed to send', send_failure: { state: 'failed', dismissed: true } },
  ]);
  const cleanHtml = renderer.buildTurnRowListMarkup([buildUserRow()], [
    { id: 'user_1', role: 'user', content: 'A prompt that failed to send' },
  ]);

  assert.ok(!dismissedHtml.includes('chat-bubble-send-status'), 'dismissed failure renders no chip');
  assert.ok(!cleanHtml.includes('chat-bubble-send-status'), 'clean message renders no chip');
  assert.ok(!cleanHtml.includes('data-send-state'), 'clean message carries no send-state attribute');
});

/* ── UIUX-027: the notice used to do a full reverse array scan (role +
 * send_failure checks) of every session message on EVERY MutationObserver
 * callback, including the near-per-frame DOM patches the stream-commit
 * pipeline fires while a response streams (renderer-stream-handler-pending-
 * message.js shallow-copies the messages array and replaces one entry per
 * coalesced commit). Cost grew with total message count x mutation count.
 * These tests pin the signature-gated incremental scan that replaced it:
 * bounded work per call, not a bound on wall-clock time. */

function buildScaleHarness() {
  const dom = new JSDOM('<!doctype html><body>'
    + '<div id="composerV2FailedSendNotice" class="hidden"></div>'
    + '<div id="chatTimeline"></div>'
    + '</body>');
  const doc = dom.window.document;
  const noticeNode = doc.getElementById('composerV2FailedSendNotice');
  const chatThread = doc.getElementById('chatTimeline');

  function addArticle(id) {
    const article = doc.createElement('article');
    article.setAttribute('data-message-id', id);
    const bubble = doc.createElement('div');
    bubble.className = 'chat-bubble';
    article.appendChild(bubble);
    chatThread.appendChild(article);
    return article;
  }

  return { dom, doc, noticeNode, chatThread, addArticle };
}

function trackFailureScanAccess(message, counter) {
  return new Proxy(message, {
    get(target, property, receiver) {
      if (counter.enabled && (property === 'role' || property === 'send_failure')) counter.count += 1;
      return Reflect.get(target, property, receiver);
    },
  });
}

test('UIUX-027: scan cost stays bounded across 200 streaming-shaped mutations at 500+ message scale', () => {
  const { noticeNode, chatThread, addArticle } = buildScaleHarness();

  const MESSAGE_COUNT = 520;
  const scanAccesses = { count: 0, enabled: false };
  let messages = [];
  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    const id = 'm' + i;
    messages.push(trackFailureScanAccess(
      { id, role: i % 2 === 0 ? 'user' : 'assistant', content: 'seed ' + i },
      scanAccesses
    ));
    addArticle(id);
  }
  // The actively-streaming message -- appended last, patched repeatedly
  // below, matching the real commit shape (shallow array copy, one entry
  // replaced per coalesced commit).
  const streamingId = 'stream_target';
  messages.push(trackFailureScanAccess({ id: streamingId, role: 'assistant', content: '' }, scanAccesses));
  addArticle(streamingId);

  const sessionId = 's1';
  const renderer = createComposerFailedSendNoticeRenderer({
    noticeNode,
    chatThread,
    getCurrentSessionId: () => sessionId,
    getMessagesForSession: () => messages,
    onRetry: () => {},
    onDismiss: () => {},
  });

  const baselineAccesses = scanAccesses.count;

  const STREAM_MUTATIONS = 200;
  for (let i = 0; i < STREAM_MUTATIONS; i += 1) {
    const next = messages.slice();
    const idx = next.length - 1;
    next[idx] = trackFailureScanAccess({ ...next[idx], content: 'chunk ' + i }, scanAccesses);
    messages = next;
    scanAccesses.enabled = true;
    renderer.refresh();
    scanAccesses.enabled = false;
  }

  // Old behavior: MESSAGE_COUNT+1 expensive checks on EVERY one of the 200
  // calls -> 200 * 521 = 104,200. The fix must not scale with message count
  // at all in the streaming-patch shape -- only with the (small, constant)
  // number of entries that actually changed per call.
  const expensiveChecksDuringStreaming = scanAccesses.count - baselineAccesses;
  assert.ok(
    expensiveChecksDuringStreaming < STREAM_MUTATIONS * 5,
    `expected expensiveChecks to stay a small multiple of the mutation count (not of message count); `
    + `got ${expensiveChecksDuringStreaming} over ${STREAM_MUTATIONS} mutations at ${messages.length} messages`
  );
  assert.equal(noticeNode.classList.contains('hidden'), true, 'no failure was ever introduced');

  renderer.destroy();
});

test('UIUX-027: a same-length mutation elsewhere in a large array does not force a full rescan', () => {
  const { noticeNode, chatThread, addArticle } = buildScaleHarness();

  const MESSAGE_COUNT = 500;
  const scanAccesses = { count: 0, enabled: false };
  let messages = [];
  for (let i = 0; i < MESSAGE_COUNT; i += 1) {
    const id = 'm' + i;
    messages.push(trackFailureScanAccess(
      { id, role: i % 2 === 0 ? 'user' : 'assistant', content: 'seed ' + i },
      scanAccesses
    ));
    addArticle(id);
  }

  const sessionId = 's1';
  const renderer = createComposerFailedSendNoticeRenderer({
    noticeNode,
    chatThread,
    getCurrentSessionId: () => sessionId,
    getMessagesForSession: () => messages,
    onRetry: () => {},
    onDismiss: () => {},
  });
  const baselineAccesses = scanAccesses.count;

  // Patch a single unrelated message far from any failure (e.g. an edited
  // historical assistant bubble) -- must take the cheap diff path, not fall
  // back to a full scan, and must not disturb the (absent) result.
  const next = messages.slice();
  next[10] = trackFailureScanAccess({ ...next[10], content: 'edited' }, scanAccesses);
  messages = next;
  scanAccesses.enabled = true;
  renderer.refresh();
  scanAccesses.enabled = false;

  const expensiveChecksForThisMutation = scanAccesses.count - baselineAccesses;
  assert.ok(
    expensiveChecksForThisMutation <= 2,
    `expected O(1) expensive checks for a single changed slot (not proportional to the 500-message array), got ${expensiveChecksForThisMutation}`
  );
  assert.equal(noticeNode.classList.contains('hidden'), true);

  renderer.destroy();
});

test('UIUX-027: a newer failure among changed entries correctly outranks an untouched active one', () => {
  const { noticeNode, chatThread, addArticle } = buildScaleHarness();
  addArticle('u_old');
  addArticle('a_old');
  addArticle('u_new');
  addArticle('a_streaming');

  let messages = [
    { id: 'u_old', role: 'user', content: 'first', send_failure: { state: 'failed' } },
    { id: 'a_old', role: 'assistant', content: 'reply' },
    { id: 'u_new', role: 'user', content: 'second' },
    { id: 'a_streaming', role: 'assistant', content: '' },
  ];
  const sessionId = 's1';
  const renderer = createComposerFailedSendNoticeRenderer({
    noticeNode,
    chatThread,
    getCurrentSessionId: () => sessionId,
    getMessagesForSession: () => messages,
    onRetry: () => {},
    onDismiss: () => {},
  });

  assert.equal(chatThread.querySelector('[data-message-id="u_old"] .chat-bubble').getAttribute('data-message-state'), 'failed');

  // Unrelated streaming patch on the trailing assistant message -- must not
  // disturb the active failure or force a fallback scan.
  let next = messages.slice();
  next[3] = { ...next[3], content: 'partial' };
  messages = next;
  renderer.refresh();
  assert.equal(chatThread.querySelector('[data-message-id="u_old"] .chat-bubble').getAttribute('data-message-state'), 'failed');

  // u_new (a later array position than u_old) also fails -- it must take
  // over as the shown failure since it is the more recent one.
  next = messages.slice();
  next[2] = { ...next[2], send_failure: { state: 'failed' } };
  messages = next;
  renderer.refresh();
  assert.equal(chatThread.querySelector('[data-message-id="u_new"] .chat-bubble').getAttribute('data-message-state'), 'failed', 'the newer failure takes precedence');
  assert.equal(chatThread.querySelector('[data-message-id="u_old"] .chat-bubble').getAttribute('data-message-state'), null, 'the older failure is no longer the shown one');

  // Dismissing u_new (the active failure's own slot changes) must fall back
  // to exactly one full scan and correctly resurface the older u_old
  // failure, which this incremental scan never individually tracked.
  next = messages.slice();
  next[2] = { ...next[2], send_failure: { ...next[2].send_failure, dismissed: true } };
  messages = next;
  renderer.refresh();
  assert.equal(chatThread.querySelector('[data-message-id="u_old"] .chat-bubble').getAttribute('data-message-state'), 'failed', 'the older failure resurfaces after the newer one is dismissed');
  assert.equal(chatThread.querySelector('[data-message-id="u_new"] .chat-bubble').getAttribute('data-message-state'), null);

  renderer.destroy();
});

test('UIUX-027: a new lower-index failure never outranks an untouched, still-active later one', () => {
  // Adversarial-audit finding on d49df22c: the diff path took any changed
  // slot's failure unconditionally, so a retried EARLIER message re-failing
  // in place (same-length array, lower index) stole the notice from a
  // standing tail failure that was never touched -- pointing the user at the
  // wrong (older) message while staying green on the diff path.
  const { noticeNode, chatThread, addArticle } = buildScaleHarness();
  ['u_a', 'a_b', 'u_mid', 'a_d', 'u_tail'].forEach(addArticle);

  let messages = [
    { id: 'u_a', role: 'user', content: 'one' },
    { id: 'a_b', role: 'assistant', content: 'r1' },
    { id: 'u_mid', role: 'user', content: 'two' },
    { id: 'a_d', role: 'assistant', content: 'r2' },
    { id: 'u_tail', role: 'user', content: 'three', send_failure: { state: 'failed' } },
  ];
  const sessionId = 's1';
  const renderer = createComposerFailedSendNoticeRenderer({
    noticeNode,
    chatThread,
    getCurrentSessionId: () => sessionId,
    getMessagesForSession: () => messages,
    onRetry: () => {},
    onDismiss: () => {},
  });

  assert.equal(chatThread.querySelector('[data-message-id="u_tail"] .chat-bubble').getAttribute('data-message-state'), 'failed');

  // u_mid (index 2, LOWER than the untouched u_tail at index 4) newly fails
  // via a same-length in-place replace.
  const next = messages.slice();
  next[2] = { ...next[2], send_failure: { state: 'failed' } };
  messages = next;
  renderer.refresh();

  assert.equal(
    chatThread.querySelector('[data-message-id="u_tail"] .chat-bubble').getAttribute('data-message-state'),
    'failed',
    'the untouched later failure remains the shown one'
  );
  assert.equal(
    chatThread.querySelector('[data-message-id="u_mid"] .chat-bubble').getAttribute('data-message-state'),
    null,
    'the newly-failed earlier message must not steal the notice from a later live failure'
  );

  renderer.destroy();
});
