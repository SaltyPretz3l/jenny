const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers/renderer-stream-handler-buffering-harness');

test('unsaved question batches remain inert until a durable retry rehydrates them', async (t) => {
  const interactiveDrafts = [];
  const summaryPatches = [];
  const harness = createHarness({
    callbackOverrides: {
      ensureInteractiveDraft: (...args) => interactiveDrafts.push(args),
      patchSessionSummary: (...args) => summaryPatches.push(args),
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-qb-unsaved' });
  await harness.emit({
    type: 'question_batch', sessionId: 'session-1', streamId: 'stream-qb-unsaved',
    durability: {
      state: 'unsaved', reason: 'write_failed', scope: 'assistant', artifact_id: 'repair-qb',
    },
    batch: {
      batch_id: 'batch-unsaved', round_index: 1, intro_text: 'Answer one question',
      questions: [{ id: 'q1', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }],
    },
  });

  const questionBatch = (harness.state.messagesBySession.get('session-1') || [])
    .find((message) => message.kind === 'question_batch');
  assert.equal(questionBatch.durability.artifact_id, 'repair-qb');
  assert.deepEqual(interactiveDrafts, []);
  assert.deepEqual(summaryPatches, []);
  assert.equal(harness.multiStreamController.getStreamIdForSession('session-1'), null);
});

test('a user-denied terminal logs stream.handle_error at INFO, a failure at ERROR', async (t) => {
  const logs = [];
  const harness = createHarness({
    callbackOverrides: {
      appendClientLog: (level, event, details) => logs.push({ level, event, details }),
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-denied' });
  await harness.emit({
    type: 'error', sessionId: 'session-1', streamId: 'stream-denied',
    message: 'User rejected approval for write_file', terminal_status: 'denied',
  });
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-failed' });
  await harness.emit({ type: 'error', sessionId: 'session-1', streamId: 'stream-failed', message: 'boom' });

  const entries = logs.filter((entry) => entry.event === 'stream.handle_error');
  assert.deepEqual(entries.map((entry) => [entry.details.streamId, entry.level, entry.details.terminalStatus]), [
    ['stream-denied', 'INFO', 'denied'], ['stream-failed', 'ERROR', undefined],
  ]);
});

// A question batch ends the turn like `complete`: the live turn is stamped
// terminal and its open Thinking row settles, so no spinner stays beside the card.
test('a question batch settles the live turn the way complete does', async (t) => {
  const { createHarness: createRowModelHarness } = require('./helpers/renderer-stream-handler-harness');
  const harness = createRowModelHarness();
  t.after(() => harness.restore());
  harness.state.ui.chatTimelineRowModelBySession = new Map([['session-qb', true]]);
  const base = { sessionId: 'session-qb', streamId: 'stream-qb' };
  await harness.emit({ type: 'started', ...base });
  await harness.emit({ type: 'phase_started', ...base, phaseId: 'phase-r1', phaseKind: 'reasoning', thinkingId: 'think-1' });
  await harness.emit({ type: 'delta', ...base, content: '', aggregate: '', thinkingId: 'think-1',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: 'Which file?', thinkingId: 'think-1' }] } });
  await harness.emit({
    type: 'question_batch', ...base,
    batch: { batch_id: 'batch-1', round_index: 1, intro_text: 'One question',
      questions: [{ id: 'q1', prompt: 'Pick one', options: [{ id: 'a', label: 'A' }] }] },
  });
  const liveState = harness.state.ui.chatTimelineLiveStateBySession?.get('session-qb');
  // Reconciled like a completed turn: no provisional turn is left to overlay.
  assert.equal(liveState?.turns_by_id?.['stream-qb'], undefined, 'the provisional turn is settled');
});
