// Ht-D: chat transcript content-visibility paint-skip.
//
// Pins the flag mirror (documentElement.dataset.chatContentVisibility),
// the data-cv-exempt exemption contract (pending/streaming turn, unresolved
// approval-gap turn, bottom-2 belt-and-braces is pure CSS and out of scope
// here), the settle-clears-the-attribute re-evaluation, the trickiest
// invariant (pending flips false while an approval_gap row is still present
// -> stays exempt), and the CSS rule text itself.
//
// Conventions mirrored from tests/renderer-turn-shell.test.js (global.document
// stub pattern for buildMessageShellArticle unit tests) and
// tests/renderer-approval-surface-dom.test.js (full-harness stream-event ->
// projection -> markup approval scenario).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const {
  createTurnShellRenderer,
  syncChatEntryCvExemptAttribute,
} = require('../renderer/chat/renderer-turn-shell');
const {
  loadRendererApp,
} = require('./helpers/renderer-shell-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

const CONTENDED_RENDER_TIMEOUT_MS = 10_000;

// Condition-waits shared by the full-harness tests below: fixed waitForUi tick
// counts flake under the 12-worker lane (and occasionally standalone) because
// the send pipeline + debounced/rAF renders can land after any fixed sleep.
async function waitForUserEntry(window) {
  await waitForUiState(
    window,
    () => Boolean(window.document.querySelector('.chat-entry.user')),
    { message: 'Timed out waiting for the sent user turn-article to render.' }
  );
}

function queryArticle(window, messageId) {
  return window.document.querySelector(`article[data-message-id="${messageId}"]`);
}

function createRenderer() {
  return createTurnShellRenderer({
    escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },
  });
}

function buildSession(sessionId, overrides = {}) {
  return {
    id: sessionId,
    title: `Session ${sessionId}`,
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    context_preferences: {
      history_scope: 'session',
      include_personality: true,
      include_memory: true,
    },
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function loadRendererTestApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function makeStartStreamShell(sessionId, streamId) {
  return {
    chat: {
      async startStream(payload, { state }) {
        state.sessions = [buildSession(sessionId, {
          conversation_mode: payload.conversationMode || 'chat',
          preferred_model: payload.preferredModel || 'gpt-test',
          reasoning_effort: payload.reasoningEffort || 'default',
        })];
        state.messagesBySession.set(sessionId, []);
        return { sessionId, streamId };
      },
    },
  };
}

/* ── A. buildMessageShellArticle direct unit tests (no full harness) ── */

test('buildMessageShellArticle never emits data-cv-exempt when no document global is set, even with cvExempt:true (safe default)', () => {
  assert.equal(typeof global.document, 'undefined', 'precondition: no leaked document from a sibling test');
  const renderer = createRenderer();
  const markup = renderer.buildMessageShellArticle({
    className: 'assistant pending',
    messageId: 'assistant_1',
    messageRole: 'assistant',
    cvExempt: true,
    innerHtml: '<div class="chat-bubble">Hi</div>',
  });
  assert.equal(markup.includes('data-cv-exempt'), false);
});

test('buildMessageShellArticle emits data-cv-exempt="true" only when cvExempt:true AND the flag mirror reads "on"', () => {
  const previousDocument = global.document;
  assert.equal(previousDocument, undefined, 'precondition: no leaked document from a sibling test');
  global.document = { documentElement: { dataset: { chatContentVisibility: 'on' } } };
  try {
    const renderer = createRenderer();
    const exemptMarkup = renderer.buildMessageShellArticle({
      className: 'assistant pending',
      messageId: 'assistant_1',
      messageRole: 'assistant',
      cvExempt: true,
      innerHtml: '<div class="chat-bubble">Hi</div>',
    });
    assert.match(exemptMarkup, /data-cv-exempt="true"/);

    const nonExemptMarkup = renderer.buildMessageShellArticle({
      className: 'assistant',
      messageId: 'assistant_2',
      messageRole: 'assistant',
      cvExempt: false,
      innerHtml: '<div class="chat-bubble">Hi</div>',
    });
    assert.equal(nonExemptMarkup.includes('data-cv-exempt'), false);
  } finally {
    if (previousDocument === undefined) {
      delete global.document;
    } else {
      global.document = previousDocument;
    }
  }
});

test('buildMessageShellArticle withholds data-cv-exempt when cvExempt:true but the flag mirror is NOT "on"', () => {
  const previousDocument = global.document;
  assert.equal(previousDocument, undefined, 'precondition: no leaked document from a sibling test');
  global.document = { documentElement: { dataset: {} } };
  try {
    const renderer = createRenderer();
    const markup = renderer.buildMessageShellArticle({
      className: 'assistant pending',
      messageId: 'assistant_1',
      messageRole: 'assistant',
      cvExempt: true,
      innerHtml: '<div class="chat-bubble">Hi</div>',
    });
    assert.equal(markup.includes('data-cv-exempt'), false);
  } finally {
    if (previousDocument === undefined) {
      delete global.document;
    } else {
      global.document = previousDocument;
    }
  }
});

/* ── B. syncChatEntryCvExemptAttribute direct unit tests (hand-built JSDOM) ── */

function buildSyncFixture({ pending, hasApprovalGapRow, flagOn }) {
  const dom = new JSDOM(`<!doctype html><html><body>
    <article class="chat-entry${pending ? ' pending' : ''}">
      ${hasApprovalGapRow ? '<div class="chat-row" data-row-kind="approval_gap"></div>' : ''}
    </article>
  </body></html>`);
  if (flagOn) {
    dom.window.document.documentElement.dataset.chatContentVisibility = 'on';
  }
  return { dom, article: dom.window.document.querySelector('article.chat-entry') };
}

test('syncChatEntryCvExemptAttribute (unit): pending=true sets data-cv-exempt="true" (flag on)', () => {
  const { dom, article } = buildSyncFixture({ pending: true, hasApprovalGapRow: false, flagOn: true });
  const previousDocument = global.document;
  global.document = dom.window.document;
  try {
    syncChatEntryCvExemptAttribute(article, { pending: true });
    assert.equal(article.getAttribute('data-cv-exempt'), 'true');
  } finally {
    if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
  }
});

test('syncChatEntryCvExemptAttribute (unit): pending=false + no approval_gap row clears the attribute (flag on)', () => {
  const { dom, article } = buildSyncFixture({ pending: false, hasApprovalGapRow: false, flagOn: true });
  article.setAttribute('data-cv-exempt', 'true'); // simulate stale exempt state
  const previousDocument = global.document;
  global.document = dom.window.document;
  try {
    syncChatEntryCvExemptAttribute(article, { pending: false });
    assert.equal(article.hasAttribute('data-cv-exempt'), false);
  } finally {
    if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
  }
});

test('syncChatEntryCvExemptAttribute (unit) TRICKY INVARIANT: pending flips to false while a [data-row-kind="approval_gap"] row is still present in the DOM -> attribute stays "true", not cleared', () => {
  const { dom, article } = buildSyncFixture({ pending: true, hasApprovalGapRow: true, flagOn: true });
  const previousDocument = global.document;
  global.document = dom.window.document;
  try {
    // Establish the exempt baseline while pending + gap row present.
    syncChatEntryCvExemptAttribute(article, { pending: true });
    assert.equal(article.getAttribute('data-cv-exempt'), 'true');

    // pending settles to false (token-streaming finished) but the approval_gap
    // row is untouched (these patch call sites never touch the row list).
    syncChatEntryCvExemptAttribute(article, { pending: false });
    assert.equal(
      article.getAttribute('data-cv-exempt'),
      'true',
      'must stay exempt: an unresolved approval gate outlives the pending flag'
    );
    assert.ok(article.querySelector('[data-row-kind="approval_gap"]'), 'sanity: gap row is still in the DOM');

    // Once the gap row is actually gone (approval resolved), re-sync clears it.
    article.querySelector('[data-row-kind="approval_gap"]').remove();
    syncChatEntryCvExemptAttribute(article, { pending: false });
    assert.equal(article.hasAttribute('data-cv-exempt'), false);
  } finally {
    if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
  }
});

test('syncChatEntryCvExemptAttribute (unit): flag OFF always removes the attribute regardless of pending/approval-gap state', () => {
  const { dom, article } = buildSyncFixture({ pending: true, hasApprovalGapRow: true, flagOn: false });
  article.setAttribute('data-cv-exempt', 'true');
  const previousDocument = global.document;
  global.document = dom.window.document;
  try {
    syncChatEntryCvExemptAttribute(article, { pending: true });
    assert.equal(article.hasAttribute('data-cv-exempt'), false);
  } finally {
    if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
  }
});

/* ── C. Full-harness integration tests ── */

test('flag ON (explicit true): document.documentElement.dataset.chatContentVisibility === "on"', async (t) => {
  const app = await loadRendererTestApp(t);
  const { window } = app;
  window.__rendererState.features.featureFlags.chat_render_content_visibility = true;

  const input = window.document.getElementById('chatInput');
  input.value = 'trigger a render';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  await waitForUiState(
    window,
    () => window.document.documentElement.dataset.chatContentVisibility === 'on',
    { message: 'Timed out waiting for the chatContentVisibility flag mirror to flip to "on".' }
  );

  assert.equal(window.document.documentElement.dataset.chatContentVisibility, 'on');
});

test('flag OFF: dataset attribute is absent (undefined), not "false" -- and no .chat-entry anywhere carries data-cv-exempt across a streaming turn + an approval-gap turn (byte-identical markup contract)', async (t) => {
  const sessionId = 'session-cv-off';
  const streamId = 'stream-cv-off';
  const { window, shell } = await loadRendererTestApp(t, {
    shell: makeStartStreamShell(sessionId, streamId),
  });
  window.__rendererState.features.featureFlags.chat_render_content_visibility = false;

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  input.value = 'off scenario';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUserEntry(window);

  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: '',
    aggregate: '',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'reason-1', text: 'thinking' }] },
  });
  await shell.__emitChat({ type: 'delta', sessionId, streamId, content: 'Working. ', aggregate: 'Working. ' });
  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-cv-off',
    toolName: 'write_file',
    summary: 'Write x',
    input: { path: 'x.md' },
    status: 'pending_approval',
  });
  await shell.__emitChat({
    type: 'tool_approval_needed',
    sessionId,
    streamId,
    callId: 'call-cv-off',
    approvalId: 'approval-cv-off-1',
    toolName: 'write_file',
    input: { path: 'x.md' },
  });
  await waitForUiState(
    window,
    () => Boolean(window.document.querySelector('[data-row-kind="approval_gap"]')),
    { message: 'Timed out waiting for the approval_gap row to render (flag-off scenario).' }
  );

  assert.equal(window.document.documentElement.dataset.chatContentVisibility, undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(window.document.documentElement.dataset, 'chatContentVisibility'),
    false,
    'attribute must be ABSENT, not present with a false-y value'
  );

  const timeline = window.document.getElementById('chatTimeline') || window.document.body;
  assert.equal(timeline.innerHTML.includes('data-cv-exempt'), false, 'flag off must never emit data-cv-exempt anywhere');
  // Sanity: the approval gate DID render (so this is a real negative, not a no-op scenario).
  assert.ok(timeline.querySelector('[data-row-kind="approval_gap"]'), 'sanity: approval gap row rendered under flag-off too');
});

test('pending/streaming turn-article gets data-cv-exempt="true" while streaming (flag on)', async (t) => {
  const sessionId = 'session-cv-pending';
  const streamId = 'stream-cv-pending';
  const { window, shell } = await loadRendererTestApp(t, {
    shell: makeStartStreamShell(sessionId, streamId),
  });
  window.__rendererState.features.featureFlags.chat_render_content_visibility = true;

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  input.value = 'streaming scenario';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUserEntry(window);

  await shell.__emitChat({ type: 'started', sessionId, streamId });
  // A reasoning delta before content materializes the streaming article early
  // (mirrors renderer-approval-surface-dom.test.js's realistic ordering).
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: '',
    aggregate: '',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'reason-1', text: 'thinking' }] },
  });
  await shell.__emitChat({ type: 'delta', sessionId, streamId, content: 'Working. ', aggregate: 'Working. ' });
  await waitForUiState(
    window,
    () => Boolean(queryArticle(window, `assistant_${streamId}`)),
    {
      timeoutMs: CONTENDED_RENDER_TIMEOUT_MS,
      message: 'Timed out waiting for the streaming assistant turn-article to render.',
    }
  );

  const timeline = window.document.getElementById('chatTimeline') || window.document.body;
  const assistantArticle = timeline.querySelector(`article[data-message-id="assistant_${streamId}"]`);
  assert.ok(assistantArticle, 'streaming assistant turn-article should be present in the DOM');
  assert.equal(assistantArticle.classList.contains('pending'), true, 'sanity: article is pending while streaming');
  assert.equal(assistantArticle.getAttribute('data-cv-exempt'), 'true');
});

test('a settled (non-streaming, no approval gate) historical turn-article does NOT carry data-cv-exempt (flag on) -- the common case', async (t) => {
  // Default shell session id (mirrors tests/renderer-turn-shell.test.js:108-174):
  // sendButton.click() with no custom startStream binds to 'session-1'.
  const sessionId = 'session-1';
  const streamId = 'stream-cv-hist';
  const { window, shell } = await loadRendererTestApp(t);
  window.__rendererState.features.featureFlags.chat_render_content_visibility = true;

  const input = window.document.getElementById('chatInput');
  input.value = 'seed history';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  // Also wait for the default startStream stub to bind session-1: it resets
  // messagesBySession, so seeding history before it runs would be wiped.
  await waitForUiState(
    window,
    () => Boolean(window.document.querySelector('.chat-entry.user'))
      && shell.__state.messagesBySession.has(sessionId),
    { message: 'Timed out waiting for the send pipeline to bind session-1.' }
  );

  shell.__state.messagesBySession.set(sessionId, [
    { id: 'user_hist_1', role: 'user', content: 'Hi', status: 'complete' },
    {
      id: 'assistant_hist_1',
      role: 'assistant',
      content: 'Hello there.',
      status: 'complete',
      streamId,
      finalizedAt: new Date().toISOString(),
    },
  ]);
  await shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: 'Hello there.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUiState(
    window,
    () => Boolean(queryArticle(window, 'user_hist_1')) && Boolean(queryArticle(window, 'assistant_hist_1')),
    { message: 'Timed out waiting for the historical user + assistant turn-articles to render.' }
  );

  const timeline = window.document.getElementById('chatTimeline') || window.document.body;
  const userArticle = timeline.querySelector('article[data-message-id="user_hist_1"]');
  const assistantArticle = timeline.querySelector('article[data-message-id="assistant_hist_1"]');
  assert.ok(userArticle, 'user turn-article should be present');
  assert.ok(assistantArticle, 'assistant turn-article should be present');
  assert.equal(userArticle.getAttribute('data-cv-exempt'), null);
  assert.equal(assistantArticle.getAttribute('data-cv-exempt'), null);
});

test('a turn-article with an unresolved approval gate gets data-cv-exempt="true" even when NOT .pending (flag on)', async (t) => {
  const sessionId = 'session-cv-gap';
  const streamId = 'stream-cv-gap';
  const { window, shell } = await loadRendererTestApp(t, {
    shell: makeStartStreamShell(sessionId, streamId),
  });
  window.__rendererState.features.featureFlags.chat_render_content_visibility = true;

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  input.value = 'approval gap scenario';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUserEntry(window);

  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: '',
    aggregate: '',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'reason-1', text: 'thinking' }] },
  });
  await shell.__emitChat({ type: 'delta', sessionId, streamId, content: 'Working. ', aggregate: 'Working. ' });
  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call-cv-gap',
    toolName: 'write_file',
    summary: 'Write x',
    input: { path: 'x.md' },
    status: 'pending_approval',
  });
  await shell.__emitChat({
    type: 'tool_approval_needed',
    sessionId,
    streamId,
    callId: 'call-cv-gap',
    approvalId: 'approval-cv-gap-1',
    toolName: 'write_file',
    input: { path: 'x.md' },
  });
  await waitForUiState(
    window,
    () => Boolean(
      queryArticle(window, `tool_use_${streamId}_call-cv-gap`)
        ?.querySelector('[data-row-kind="approval_gap"]')
    ),
    { message: 'Timed out waiting for the tool-call turn-article with its approval_gap row to render.' }
  );

  const timeline = window.document.getElementById('chatTimeline') || window.document.body;
  const toolArticle = timeline.querySelector(`article[data-message-id="tool_use_${streamId}_call-cv-gap"]`);
  assert.ok(toolArticle, 'tool-call turn-article carrying the approval gap should be present');
  assert.equal(toolArticle.classList.contains('pending'), false, 'sanity: the tool-call turn-article is not the .pending streaming article');
  assert.ok(
    toolArticle.querySelector('[data-row-kind="approval_gap"]'),
    'sanity: the article actually contains an unresolved approval_gap row'
  );
  assert.equal(toolArticle.getAttribute('data-cv-exempt'), 'true');
});

test('re-evaluation on settle: a turn that starts pending/exempt and finishes streaming (no approval gate) loses data-cv-exempt after the settle-render (flag on)', async (t) => {
  const sessionId = 'session-cv-settle';
  const streamId = 'stream-cv-settle';
  const { window, shell } = await loadRendererTestApp(t, {
    shell: makeStartStreamShell(sessionId, streamId),
  });
  window.__rendererState.features.featureFlags.chat_render_content_visibility = true;

  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  input.value = 'settle scenario';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUserEntry(window);

  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: '',
    aggregate: '',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'reason-1', text: 'thinking' }] },
  });
  await shell.__emitChat({ type: 'delta', sessionId, streamId, content: 'Working. ', aggregate: 'Working. ' });
  await waitForUiState(
    window,
    () => Boolean(queryArticle(window, `assistant_${streamId}`)),
    { message: 'Timed out waiting for the streaming assistant turn-article to render mid-stream.' }
  );

  const timeline = window.document.getElementById('chatTimeline') || window.document.body;
  const midStreamArticle = timeline.querySelector(`article[data-message-id="assistant_${streamId}"]`);
  assert.ok(midStreamArticle, 'streaming assistant turn-article should be present mid-stream');
  assert.equal(midStreamArticle.getAttribute('data-cv-exempt'), 'true', 'exempt while pending, pinned as the starting condition');

  await shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: 'Working. Done.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  // Wait for the fully settled state, not just the pending-class removal:
  // settleVisibleStreamAffordances can strip streaming markers before the
  // settle re-render re-evaluates data-cv-exempt. A stuck attribute times
  // out here and the assertions below still pin each facet individually.
  await waitForUiState(
    window,
    () => {
      const article = queryArticle(window, `assistant_${streamId}`);
      return Boolean(article)
        && !article.classList.contains('pending')
        && !article.hasAttribute('data-cv-exempt');
    },
    { message: 'Timed out waiting for the settled assistant turn-article to drop pending + data-cv-exempt.' }
  );

  const settledArticle = timeline.querySelector(`article[data-message-id="assistant_${streamId}"]`);
  assert.ok(settledArticle, 'assistant turn-article should still be present after settle');
  assert.equal(settledArticle.classList.contains('pending'), false, 'sanity: no longer pending after settle');
  assert.equal(settledArticle.getAttribute('data-cv-exempt'), null, 'data-cv-exempt must NOT be permanently stuck after settle');
});

/* ── D. CSS pin ── */

test('styles/chat-thread.css pins the content-visibility rule + the exemption override rule', () => {
  const cssPath = path.resolve(__dirname, '..', 'styles', 'chat-thread.css');
  const css = fs.readFileSync(cssPath, 'utf8');

  // The paint-skip rule itself, scoped to the flag-mirror attribute selector.
  assert.match(
    css,
    /:root\[data-chat-content-visibility="on"\]\s*#chatTimeline\[data-timeline-render-strategy="content-visibility"\]\s*\.chat-entry\s*\{[^}]*content-visibility:\s*auto;/,
    'expected content-visibility only under the CSS-only timeline strategy'
  );

  // The exemption override: data-cv-exempt="true" restores visible painting.
  assert.match(
    css,
    /data-cv-exempt="true"/,
    'expected an exemption rule referencing data-cv-exempt="true"'
  );

  // The bottom-2 belt-and-braces structural selector (pure CSS, no JS).
  assert.match(
    css,
    /\.chat-thread-root:nth-last-child\(-n\+2\)/,
    'expected the bottom-2 nth-last-child(-n+2) structural exemption selector'
  );

  // Both exemptions resolve back to visible (undo the paint-skip).
  const exemptionBlockMatch = css.match(
    /:root\[data-chat-content-visibility="on"\]\s*#chatTimeline\[data-timeline-render-strategy="content-visibility"\]\s*\.chat-entry\[data-cv-exempt="true"\][\s\S]{0,500}?content-visibility:\s*visible;/
  );
  assert.ok(exemptionBlockMatch, 'expected the data-cv-exempt selector rule to set content-visibility: visible');
  assert.match(
    css,
    /#chatTimeline\[data-timeline-render-strategy="dom-window"\]\s*\.chat-entry,[\s\S]{0,200}?#chatTimeline\[data-timeline-render-strategy="none"\]\s*\.chat-entry\s*\{[^}]*content-visibility:\s*visible;/,
    'DOM-window and fully-mounted strategies must explicitly disable CSS skipping'
  );
});
