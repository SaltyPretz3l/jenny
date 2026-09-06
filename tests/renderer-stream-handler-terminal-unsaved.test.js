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
