'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createSessionLifecycleAdapter,
  settleQuestionBatch,
} = require('../services/backend/chat-stream-session-lifecycle');

test('settleQuestionBatch preserves recovery state when message persistence is refused', async () => {
  const writes = [];
  let activeTurn = { request_id: 'request-1', stream_id: 'stream-1' };
  const adapter = createSessionLifecycleAdapter({
    appendMessage() {
      writes.push('append_refused');
      return false;
    },
    setSessionPreferences() {
      writes.push('preferences_written');
      return true;
    },
    applySessionTitle() {
      writes.push('title_applied');
    },
    getActiveTurn() {
      return activeTurn;
    },
    setActiveTurn(next) {
      activeTurn = next;
      return true;
    },
    touchActiveTurn() {
      return true;
    },
    clearActiveTurn() {
      writes.push('active_turn_cleared');
      activeTurn = null;
      return true;
    },
  });

  const result = await settleQuestionBatch(adapter, {
    messageId: 'question-batch-1',
    questionBatch: {
      round_index: 1,
      questions: [{ id: 'question-1', text: '?' }],
    },
    requestId: 'request-1',
    streamId: 'stream-1',
    exchangeTitle: 'Question title',
  });

  assert.deepEqual(result, { ok: false, reason: 'question_batch_persist_refused' });
  assert.deepEqual(writes, ['append_refused']);
  assert.deepEqual(activeTurn, { request_id: 'request-1', stream_id: 'stream-1' });
});
