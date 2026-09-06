// Regression coverage for transcript ordering across a PREEMPTED-then-RETRIED
// turn, the live-incident shape behind the "assistant reply rendered ABOVE the
// user bubble that prompted it" report (IDE chat dock: terminal status
// "preempted" -> provider error CMP-AI-0002 Ollama connection dropped
// mid-stream -> user re-ask/retry).
//
// The proven anchored-reinsertion fix lives in mergeTerminalHydratedMessages
// (renderer-stream-handler-terminal.js). This file exercises the SEQUENCE the
// live handlers actually run and asserts the transcript invariant: for every
// turn, the user message's flat-array index is strictly less than its
// assistant reply's index. buildTranscriptThreadTree trusts flat order with no
// timestamp sort, so a blind tail-append anywhere in the settle path renders
// the reply out of position.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createDeferred } = require('./helpers/deferred');
const {
  createHarness,
  flushMicrotasks,
} = require('./helpers/renderer-stream-handler-buffering-harness');

function createDeferredHydrationHarness(t, { captureLogs = false } = {}) {
  const terminalHydration = createDeferred();
  const logs = [];
  const harness = createHarness({
    stateOverrides: {
      window: {
        jennyShell: {
          sessions: {
            async getMessages() {
              return terminalHydration.promise;
            },
          },
        },
      },
    },
    ...(captureLogs
      ? {
        callbackOverrides: {
          appendClientLog(level, event, data) {
            logs.push({ level, event, data });
          },
        },
      }
      : {}),
  });
  t.after(() => harness.restore());
  return { harness, terminalHydration, logs };
}

// Assert user-before-assistant ordering for every turn keyed by id pair.
function assertUserBeforeAssistant(messages, turns) {
  const indexById = new Map();
  messages.forEach((message, index) => {
    indexById.set(String(message.id), index);
  });
  turns.forEach(({ userId, assistantId }) => {
    const userIndex = indexById.get(userId);
    const assistantIndex = indexById.get(assistantId);
    assert.notEqual(userIndex, undefined, `user ${userId} must be present; got ${JSON.stringify([...indexById.keys()])}`);
    assert.notEqual(assistantIndex, undefined, `assistant ${assistantId} must be present; got ${JSON.stringify([...indexById.keys()])}`);
    assert.ok(
      userIndex < assistantIndex,
      `user ${userId} (index ${userIndex}) must render BEFORE its assistant reply ${assistantId} (index ${assistantIndex}); got order ${JSON.stringify(messages.map((m) => m.id))}`
    );
  });
}

// The direct-merge repro: mergeTerminalHydratedMessages must keep a preserved
// local-only user prompt above the reply that answered it even when the prompt
// and its (unpersisted) partial-assistant anchor are BOTH local-only.
test('preempted-then-retried turn: preserved local prompt + local partial both stay in original order above the retry reply', async (t) => {
  const { harness, terminalHydration } = createDeferredHydrationHarness(t, { captureLogs: true });

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-retry' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-retry', aggregate: 'Retry answer' });
  const completePromise = harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-retry', content: 'Retry answer' });
  await flushMicrotasks(20);
  const assistantRetry = harness.state.messagesBySession.get('session-1')[0];

  const user1 = { id: 'user_stream-first', role: 'user', content: 'First prompt', status: 'complete' };
  const assistant1Partial = {
    id: 'assistant_stream-first',
    role: 'assistant',
    content: 'Partial before preempt',
    status: 'error',
    stream_error: 'CMP-AI-0002 Ollama connection dropped mid-stream',
    streamId: 'stream-first',
  };
  const user2 = { id: 'user_local_1700000000010_retry001', role: 'user', content: 'Retry prompt', status: 'complete' };

  harness.state.messagesBySession.set('session-1', [user1, assistant1Partial, user2, assistantRetry]);
  terminalHydration.resolve({ data: [user1, assistantRetry] });
  await completePromise;

  const finalMessages = harness.state.messagesBySession.get('session-1');
  assertUserBeforeAssistant(finalMessages, [
    { userId: 'user_stream-first', assistantId: 'assistant_stream-first' },
    { userId: 'user_local_1700000000010_retry001', assistantId: 'assistant_stream-retry' },
  ]);
});

// The end-to-end sequence repro. A late provider error arrives for a stream
// that was already finalized by a preempt, AFTER the user has re-asked. The
// error handler must place the turn-1 error bubble at its turn-1 position
// (right after user1), NOT blind-append it to the tail below the re-ask turn.
test('late provider error for an already-preempted stream must land at its turn position, not the tail below the re-ask', async (t) => {
  const { harness, terminalHydration } = createDeferredHydrationHarness(t, { captureLogs: true });
  const sessionId = 'session-1';

  // --- Turn 1: user1 asks, assistant1 streams a partial, then is PREEMPTED. ---
  harness.state.messagesBySession.set(sessionId, [
    { id: 'user_stream-first', role: 'user', content: 'First prompt', status: 'complete' },
  ]);
  await harness.emit({ type: 'started', sessionId, streamId: 'stream-first' });
  await harness.emit({ type: 'delta', sessionId, streamId: 'stream-first', aggregate: 'Partial before preempt' });
  await flushMicrotasks(10);
  // At this point the store holds the live partial assistant bubble
  // (assistant_stream-first, streamId=stream-first) right after user1.
  // Preempt: the multi-stream controller clears + finalizes stream-first (as a
  // stop/preempt does) WITHOUT going through the error settle. The partial
  // assistant bubble stays in the store at its turn position.
  harness.multiStreamController.clearStream('stream-first');
  await flushMicrotasks(5);

  // --- User re-asks: a new optimistic user bubble is appended at the tail. ---
  const afterPreempt = [...harness.state.messagesBySession.get(sessionId)];
  afterPreempt.push({ id: 'user_local_1700000000010_retry001', role: 'user', content: 'Retry prompt', status: 'complete' });
  harness.state.messagesBySession.set(sessionId, afterPreempt);

  // --- The LATE provider error for the already-finalized stream-first arrives. ---
  // ensurePendingStreamEntry returns -1 (finalized guard). handleError must
  // reconcile the error onto the EXISTING partial bubble for stream-first (at
  // its turn position) instead of synthesizing a NEW error bubble that gets
  // blind-appended below the re-ask prompt.
  const errorPromise = harness.emit({
    type: 'error',
    sessionId,
    streamId: 'stream-first',
    message: 'CMP-AI-0002 Ollama connection dropped mid-stream',
    error_code: 'CMP-AI-0002',
  });
  await flushMicrotasks(5);
  // handleError blocks on getMessages (terminal hydration). The store snapshot
  // holds user1 + the re-ask prompt at their canonical positions but has NOT
  // yet persisted the turn-1 error row.
  terminalHydration.resolve({
    data: [
      { id: 'user_stream-first', role: 'user', content: 'First prompt', status: 'complete' },
      { id: 'assistant_stream-first', role: 'assistant', content: 'Partial before preempt', status: 'streaming', streamId: 'stream-first' },
      { id: 'user_local_1700000000010_retry001', role: 'user', content: 'Retry prompt', status: 'complete' },
    ],
  });
  await flushMicrotasks(20);

  const finalMessages = harness.state.messagesBySession.get(sessionId);
  const ids = finalMessages.map((m) => m.id);
  const user1Idx = ids.indexOf('user_stream-first');
  const user2Idx = ids.indexOf('user_local_1700000000010_retry001');
  // The turn-1 error must be reconciled onto the partial (assistant_stream-first)
  // at its turn position, NOT a new error_* bubble appended at the tail.
  const errorIdx = ids.indexOf('assistant_stream-first');
  const strandedSyntheticIdx = ids.findIndex((id) => id.indexOf('error_') === 0);
  assert.equal(
    strandedSyntheticIdx,
    -1,
    `handleError must not synthesize a NEW error bubble when a partial for the stream already exists; got ${JSON.stringify(ids)}`
  );
  assert.ok(errorIdx !== -1, `the turn-1 assistant bubble must exist; got ${JSON.stringify(ids)}`);
  // And it must carry the error status/text.
  const errorBubble = finalMessages[errorIdx];
  assert.equal(errorBubble.status, 'error', 'turn-1 bubble must be marked error after the late provider error');
  assert.ok(
    user1Idx < errorIdx,
    `turn-1 error (index ${errorIdx}) must render BELOW its user prompt user1 (index ${user1Idx}); got ${JSON.stringify(ids)}`
  );
  assert.ok(
    errorIdx < user2Idx,
    `turn-1 error (index ${errorIdx}) must render ABOVE the re-ask prompt user2 (index ${user2Idx}); a blind tail-append sinks it below the next turn; got ${JSON.stringify(ids)}`
  );

  // Drain the pending hydration promise so no unhandled rejection leaks.
  await errorPromise.catch(() => {});
});
