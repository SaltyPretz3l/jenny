// Regression: terminal-error turns with streamed content lose their error card
// (2026-07-16).
//
// A turn that streamed any visible content and then settled with a terminal
// `error` event rendered as a false "Completed" turn: no `.chat-error-card`,
// no retry affordance, and the Active Turn V2 deck stayed frozen on its last
// live state. Root cause was a terminal-handoff gap, not projection logic:
//
//  1. `handleError` never fed the terminal event to the live turn reducer
//     (`applyLiveTurnPayload`), so the live overlay kept replacing the freshly
//     rebuilt canonical rows (which DO carry the `assistant_error` notice)
//     with the pre-error live row set.
//  2. The later terminal reconcile stored the corrected rows, but the render
//     that consumed them was no-op'd by the transcript render-signature guard
//     (messages unchanged since the immediate error render) — the corrected
//     rows were consumed, pruned, and never committed to the DOM.
//
// Contentless errored turns always worked (they render via the legacy
// message-article path), which is why engine-down errors showed cards while
// mid-turn failures looked like silently "completed" dead turns.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlags } = require('../services/feature-flags');

const PRE_TOOL_TEXT = 'Terminal error regression pre-tool text marker.';

function makeShell(sessionId) {
  let streamCounter = 0;
  let stateRef = null;
  const approvals = [];
  function buildSession() {
    return {
      id: sessionId,
      title: `Session ${sessionId}`,
      session_type: 'chat',
      conversation_mode: 'chat',
      preferred_model: 'gpt-test',
      reasoning_effort: 'default',
      plan_mode: false,
      pinned: false,
      archived_at: null,
      context_preferences: {
        history_scope: 'session',
        include_personality: true,
        include_memory: true,
      },
      linked_session_ids: [],
      interactive_round_count: 0,
      interactive_sequence_state: 'idle',
      pending_question_batch: null,
      updated_at: new Date().toISOString(),
    };
  }
  return {
    approvals,
    lastStreamId: () => `stream-tec-${streamCounter}`,
    shell: {
      tools: {
        async approve(callId, options) {
          approvals.push({ callId, options });
          return { ok: true, status: 'approved' };
        },
        async deny(callId) {
          approvals.push({ callId, denied: true });
          return { ok: true, status: 'denied' };
        },
      },
      sessions: {
        async getMessages() {
          const local = (stateRef && stateRef.messagesBySession.get(sessionId)) || [];
          return { data: local.map((message) => ({ ...message })) };
        },
      },
      chat: {
        async startStream(_payload, { state }) {
          streamCounter += 1;
          stateRef = state;
          state.sessions = [buildSession()];
          if (!state.messagesBySession.has(sessionId)) {
            state.messagesBySession.set(sessionId, []);
          }
          return { sessionId, streamId: `stream-tec-${streamCounter}` };
        },
      },
    },
  };
}

async function boot(t, sessionId) {
  const rig = makeShell(sessionId);
  const app = await loadRendererApp({ shell: rig.shell });
  t.after(async () => { await app.dispose(); });
  const { window, shell } = app;
  await shell.__emitFeaturesChanged({ featureFlags: { ...buildFeatureFlags({}) } });
  await waitForUi(window, 30);
  const doc = window.document;
  doc.getElementById('chatInput').value = 'Create a file called notes/demo.md';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);
  return { rig, window, shell, doc };
}

// Every test starts from the same shape: a booted app whose current stream
// has visible text on screen (the "contentful turn" precondition of this
// whole regression class).
async function bootStreamedTurn(t, sessionId) {
  const booted = await boot(t, sessionId);
  const streamId = booted.rig.lastStreamId();
  const emit = (payload) => booted.shell.__emitChat({ sessionId, streamId, ...payload });
  await emit({ type: 'started' });
  await emit({ type: 'delta', content: `${PRE_TOOL_TEXT}\n`, aggregate: `${PRE_TOOL_TEXT}\n` });
  await waitForUi(booted.window, 300);
  return { ...booted, streamId, emit };
}

// Production emit shape: buildTerminalErrorPayload (services/backend/
// chat-stream-terminal-utils.js) carries the terminal classification as
// `status` plus snake_case `terminal_subcode` — there is no terminalStatus
// field on the wire.
const TERMINAL_ERROR = {
  type: 'error',
  message: 'Turn settled with terminal status preempted.',
  retryable: true,
  category: 'managed_sidecar',
  status: 'preempted',
  terminal_subcode: 'plan_drift',
};


function snapshotTimeline(doc) {
  const timeline = doc.getElementById('chatTimeline');
  const html = timeline.innerHTML;
  return {
    textShown: html.includes(PRE_TOOL_TEXT),
    errorCard: /chat-error-card/.test(html),
    calmCard: /chat-error-card--calm/.test(html),
    retryAffordance: /data-inv-error-action/.test(html),
    toolRow: /data-row-kind="tool_call"/.test(html),
    metaText: (timeline.textContent.match(/\b(Failed|Completed)\b/) || [''])[0],
  };
}

test('text-only turn keeps its error card after a terminal error', async (t) => {
  const { window, doc, emit } = await bootStreamedTurn(t, 'sess-tec-text');
  await emit(TERMINAL_ERROR);
  await waitForUi(window, 700);

  const snap = snapshotTimeline(doc);
  assert.equal(snap.textShown, true, 'streamed text must survive the terminal error');
  assert.equal(snap.errorCard, true, 'the error card must render for an errored contentful turn');
  assert.equal(snap.retryAffordance, true, 'the retry affordance must render');
  assert.equal(snap.metaText, 'Failed', 'the turn footer must say Failed, not Completed');
});

// The terminal classification must survive from the wire to the message: a
// cancelled turn renders the CALM card treatment, which only happens when the
// payload's classification reached the stored message (resolveErrorSeverity
// reads message.terminal_status; the bare message status is always 'error').
test('production `status: cancelled` payload renders the calm card treatment', async (t) => {
  const { window, doc, emit } = await bootStreamedTurn(t, 'sess-tec-calm');
  await emit({
    type: 'error',
    message: 'Stream cancelled.',
    retryable: true,
    category: 'cancelled',
    status: 'cancelled',
    terminal_subcode: 'user_stop',
  });
  await waitForUi(window, 700);
  const snap = snapshotTimeline(doc);
  assert.equal(snap.errorCard, true, 'the error card must render');
  assert.equal(
    snap.calmCard,
    true,
    'a cancelled classification carried as payload.status must reach the message and render calm'
  );
});

test('camelCase terminalStatus payload spelling is still honored', async (t) => {
  const { window, doc, emit } = await bootStreamedTurn(t, 'sess-tec-camel');
  await emit({
    type: 'error',
    message: 'Stream cancelled.',
    retryable: true,
    category: 'cancelled',
    terminalStatus: 'cancelled',
    terminalSubcode: 'user_stop',
  });
  await waitForUi(window, 700);
  assert.equal(snapshotTimeline(doc).calmCard, true, 'the camelCase spelling must classify the card calm');
});

test('approved-tool turn keeps its error card after a terminal error (owner repro shape)', async (t) => {
  const { rig, window, doc, emit, streamId } = await bootStreamedTurn(t, 'sess-tec-approval');
  await emit({
    type: 'tool_use',
    callId: `call-${streamId}`,
    toolName: 'write_file',
    summary: 'Write notes/demo.md',
    input: { path: 'notes/demo.md' },
    status: 'pending_approval',
  });
  await emit({
    type: 'tool_approval_needed',
    callId: `call-${streamId}`,
    approvalId: `approval-${streamId}`,
    toolName: 'write_file',
    input: { path: 'notes/demo.md' },
  });
  await waitForUi(window, 500);

  const allowBtn = doc.getElementById('chatTimeline').querySelector('.tool-approve-btn');
  assert.ok(allowBtn, 'timeline approval block must offer an Allow button');
  allowBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await waitForUi(window, 300);
  assert.equal(rig.approvals.length, 1, 'Allow must call tools.approve');

  await emit({
    type: 'tool_use',
    callId: `call-${streamId}`,
    toolName: 'write_file',
    summary: 'Write notes/demo.md',
    input: { path: 'notes/demo.md' },
    status: 'approved',
  });
  await waitForUi(window, 300);
  await emit(TERMINAL_ERROR);
  await waitForUi(window, 700);

  const snap = snapshotTimeline(doc);
  assert.equal(snap.textShown, true, 'streamed text must survive the terminal error');
  assert.equal(snap.toolRow, true, 'the tool row must survive the terminal error');
  assert.equal(snap.errorCard, true, 'the error card must render after an approved tool errors out');
  assert.equal(snap.retryAffordance, true, 'the retry affordance must render');
});

test('active turn deck settles instead of freezing on the live tool state', async (t) => {
  const { window, doc, emit, streamId } = await bootStreamedTurn(t, 'sess-tec-deck');
  await emit({
    type: 'tool_use',
    callId: `call-${streamId}`,
    toolName: 'write_file',
    summary: 'Write notes/demo.md',
    input: { path: 'notes/demo.md' },
    status: 'pending_approval',
  });
  await emit({
    type: 'tool_approval_needed',
    callId: `call-${streamId}`,
    approvalId: `approval-${streamId}`,
    toolName: 'write_file',
    input: { path: 'notes/demo.md' },
  });
  await waitForUi(window, 500);
  await emit(TERMINAL_ERROR);
  await waitForUi(window, 700);

  const deck = doc.querySelector('.active-turn-deck, [class*="active-turn"]');
  const deckText = deck ? deck.textContent : '';
  assert.equal(
    /Jump to live/.test(deckText),
    false,
    'the deck must not stay frozen on a live state after the turn settled with an error'
  );
});

// applyLiveTurnPayload now runs on EVERY terminal payload, including ones for
// streams the pending registry no longer tracks (duplicates, late re-emits).
// The raw handler early-returns for those without reconciling, so the reducer
// keeps an empty-rows phantom turn; that is benign only because a turn with no
// projection rows falls back to the legacy message-article path. Pin it.
test('duplicate terminals on a settled stream never blank the turn or add a card', async (t) => {
  const sessionId = 'sess-tec-dup';
  const { rig, window, shell, doc, emit } = await bootStreamedTurn(t, sessionId);
  await emit({ type: 'complete', content: `${PRE_TOOL_TEXT}\n` });
  await waitForUi(window, 700);
  assert.equal(snapshotTimeline(doc).textShown, true, 'settled turn must show its text');

  // Duplicate complete, then a duplicate error, for the now-untracked stream.
  await emit({ type: 'complete', content: `${PRE_TOOL_TEXT}\n` });
  await emit(TERMINAL_ERROR);
  await waitForUi(window, 700);

  // The early-return path queues no render; force one so any phantom overlay
  // would actually commit.
  doc.getElementById('chatInput').value = 'follow-up to force a render';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);
  const streamId2 = rig.lastStreamId();
  await shell.__emitChat({ sessionId, streamId: streamId2, type: 'started' });
  await shell.__emitChat({
    sessionId, streamId: streamId2, type: 'delta', content: 'Second turn.', aggregate: 'Second turn.',
  });
  await waitForUi(window, 500);

  const snap = snapshotTimeline(doc);
  assert.equal(snap.textShown, true, 'the settled turn must keep its text after duplicate terminals');
  assert.equal(snap.errorCard, false, 'duplicate terminals on a completed stream must not surface an error card');
});
