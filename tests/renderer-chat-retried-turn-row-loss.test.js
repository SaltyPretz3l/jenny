// Regression: retried-turn timeline row loss (2026-07-16).
//
// After an error-card Retry, chat.editAndRegenerate keeps the original user
// message (id `user_<oldStreamId>`) and starts a NEW stream. The hydrated
// turn tree keys the turn by the user message's embedded stream id while the
// live reducer keys it by the new stream id, so the same logical turn exists
// twice in the projection maps. Render-bucket dedup then keeps the canonical
// (hydrated) copy of every duplicated row while turnIdByMessageId points the
// messages at the live turn — the canonical article is never dispatched and
// the live article's rows fail the bucket identity check, so streamed text
// and the approval block vanish from the timeline at the first tool event
// (reasoning survives only via the overlay's reasoning-dedup filter).
//
// The fresh-send scenario is the green control: identical event sequence,
// but the user message id embeds the current stream id, so the turn keys
// agree and everything renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlags } = require('../services/feature-flags');

const PRE_TOOL_TEXT = 'Retry regression pre-tool text marker.';

function makeShell(sessionId) {
  let streamCounter = 0;
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
    lastStreamId: () => `stream-rl-${streamCounter}`,
    shell: {
      chat: {
        async startStream(_payload, { state }) {
          streamCounter += 1;
          state.sessions = [buildSession()];
          if (!state.messagesBySession.has(sessionId)) {
            state.messagesBySession.set(sessionId, []);
          }
          return { sessionId, streamId: `stream-rl-${streamCounter}` };
        },
        // The error-card Retry path routes through editAndRegenerate (never
        // startStream): it reuses the anchor user message id from the failed
        // stream and returns the identity so reconcileAcceptedRegenerate can
        // truncate the superseded turn.
        async editAndRegenerate(payload, { state }) {
          streamCounter += 1;
          const editedMessageId = String(payload?.editedMessageId || '').trim();
          const messages = state.messagesBySession.get(sessionId) || [];
          const anchorIndex = messages.findIndex(
            (message) => String(message?.id || '').trim() === editedMessageId
          );
          if (anchorIndex >= 0) {
            state.messagesBySession.set(sessionId, messages.slice(0, anchorIndex + 1));
          }
          return {
            sessionId,
            streamId: `stream-rl-${streamCounter}`,
            identity: { userMessageId: editedMessageId },
          };
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
  doc.getElementById('chatInput').value = 'Create the fix notes file';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);
  return { rig, window, shell, doc };
}

async function streamTextThenApprovalTool(shell, window, sessionId, streamId) {
  const emit = (payload) => shell.__emitChat({ sessionId, streamId, ...payload });
  await emit({ type: 'started' });
  await emit({ type: 'thinking_status', status: 'Thinking...' });
  const phase = { phase_id: `phase_reasoning_${streamId}_iter1_1`, phase_kind: 'reasoning', iteration: 1 };
  await emit({ type: 'phase_started', phase });
  await emit({
    type: 'delta',
    content: '',
    aggregate: '',
    phase,
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: `reason-${streamId}`, text: 'Plan the file, then write it.' }],
    },
  });
  await waitForUi(window, 30);
  await emit({ type: 'phase_completed', phase });
  await emit({
    type: 'delta',
    content: `${PRE_TOOL_TEXT}\n\n`,
    aggregate: `${PRE_TOOL_TEXT}\n\n`,
  });
  await waitForUi(window, 300);
  await emit({
    type: 'tool_use',
    callId: `call-${streamId}`,
    toolName: 'write_file',
    summary: 'Write notes/fix.md',
    input: { path: 'notes/fix.md' },
    status: 'pending_approval',
  });
  await emit({
    type: 'tool_approval_needed',
    callId: `call-${streamId}`,
    approvalId: `approval-${streamId}`,
    toolName: 'write_file',
    input: { path: 'notes/fix.md' },
  });
  await waitForUi(window, 500);
}

function snapshotTimeline(doc) {
  const html = doc.getElementById('chatTimeline').innerHTML;
  return {
    textShown: html.includes(PRE_TOOL_TEXT),
    approvalBlock: html.includes('tool-approval-block'),
    reasoningShown: /reasoning-row|data-row-kind="reasoning"/.test(html),
  };
}

function assertToolTurnRendered(snapshot, label) {
  assert.equal(
    snapshot.textShown,
    true,
    `${label}: streamed pre-tool text must stay visible after the tool event`
  );
  assert.equal(
    snapshot.approvalBlock,
    true,
    `${label}: the timeline approval block must render for the pending tool`
  );
  assert.equal(
    snapshot.reasoningShown,
    true,
    `${label}: reasoning rows must stay visible`
  );
}

test('fresh turn keeps text + approval block at the first tool event (control)', async (t) => {
  const sessionId = 'sess-rowloss-fresh';
  const { rig, window, shell, doc } = await boot(t, sessionId);
  const streamId = rig.lastStreamId();
  await streamTextThenApprovalTool(shell, window, sessionId, streamId);
  assertToolTurnRendered(snapshotTimeline(doc), 'fresh turn');
});

test('retried turn keeps text + approval block at the first tool event', async (t) => {
  const sessionId = 'sess-rowloss-retry';
  const { rig, window, shell, doc } = await boot(t, sessionId);
  const streamA = rig.lastStreamId();

  await shell.__emitChat({ sessionId, streamId: streamA, type: 'started' });
  await shell.__emitChat({
    sessionId,
    streamId: streamA,
    type: 'error',
    message: 'Local engine is not reachable.',
    errorCode: 'CMP-ENGINE-0001',
    retryable: true,
    category: 'provider_unavailable',
    terminalStatus: 'error',
  });
  await waitForUi(window, 300);

  const retryButton = doc
    .getElementById('chatTimeline')
    .querySelector('[data-inv-error-action="retry"], [data-inv-error-action="retry_turn"]');
  assert.ok(retryButton, 'error card must offer a retry affordance');
  retryButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await waitForUi(window, 500);

  const streamB = rig.lastStreamId();
  assert.notEqual(streamB, streamA, 'retry must open a new stream');

  await streamTextThenApprovalTool(shell, window, sessionId, streamB);

  const messages = window.__rendererState.messagesBySession.get(sessionId) || [];
  // Two assistant messages now, not one: since 2026-08-26 a failure Retry
  // PRESERVES the attempt it is retrying instead of truncating it away, so the
  // store holds the failed attempt (empty content, terminated by the error)
  // followed by the retry's reply. This assertion used to `.find()` the first
  // assistant message, which was unambiguous only while the failed one was
  // being deleted. Asserting the count as well pins the new behaviour rather
  // than merely tolerating it -- a regression back to truncation fails here.
  const assistantMessages = messages.filter(
    (message) => String(message?.role) === 'assistant' && !message.kind
  );
  assert.equal(
    assistantMessages.length,
    2,
    'the failed attempt must survive the retry alongside the new reply'
  );
  const assistant = assistantMessages[assistantMessages.length - 1];
  assert.ok(
    String(assistant?.content || '').includes(PRE_TOOL_TEXT),
    'message store must hold the streamed text (store is not the defect)'
  );

  assertToolTurnRendered(snapshotTimeline(doc), 'retried turn');

  // Settle the retry stream: the terminal reconcile must find the hydrated
  // turn (it looks the turn up by the current stream id) and keep the text.
  const emit = (payload) => shell.__emitChat({ sessionId, streamId: streamB, ...payload });
  await emit({
    type: 'tool_result',
    callId: `call-${streamB}`,
    toolName: 'write_file',
    content: 'Wrote notes/fix.md',
    summary: 'Wrote notes/fix.md',
    isError: false,
    approvalState: 'approved',
    durationMs: 20,
  });
  await emit({
    type: 'complete',
    content: `${PRE_TOOL_TEXT}\n\nDone.`,
    aggregate: `${PRE_TOOL_TEXT}\n\nDone.`,
  });
  await waitForUi(window, 500);
  const settled = snapshotTimeline(doc);
  assert.equal(
    settled.textShown,
    true,
    'retried turn: text must survive the terminal reconcile'
  );
});
