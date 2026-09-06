'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_EXTERNAL_LIVE_SNAPSHOT_BYTES,
  createExternalTranscriptSnapshot,
  settleExternalCompletion,
  settleExternalFailure,
  settleExternalQuestionBatch,
} = require('../services/backend/external-chat-terminal-driver');

test('external live snapshots retain only the latest observation and bound it on read', () => {
  const snapshot = createExternalTranscriptSnapshot();
  snapshot.observe({ content: 'stale' });
  snapshot.observe({
    content: 'x'.repeat(300 * 1024),
    reasoningEntries: [{ text: 'reason', timestamp: '2026-07-14T12:00:00.000Z' }],
  });

  const value = snapshot.read();

  assert.equal(Buffer.byteLength(value.content, 'utf8'), 256 * 1024);
  assert.equal(value.reasoningEntries[0].text, 'reason');
  assert.equal(Buffer.byteLength(JSON.stringify(value), 'utf8') <= MAX_EXTERNAL_LIVE_SNAPSHOT_BYTES, true);
});

const identity = {
  sessionId: 'session_1', sessionIncarnation: 'inc_1', generation: 1,
  turnId: 'turn_1', streamId: 'stream_1', userMessageId: 'user_1',
};

function harness() {
  const captured = [];
  const store = { getSessionMessages: () => [], commitTerminal() {} };
  const service = {
    terminalCoordinator: {
      async settle(request) {
        captured.push(request);
        return { ok: true, visibleTerminal: true, durableTerminal: true };
      },
    },
  };
  return { captured, lease: { identity, store }, service, store };
}

test('external completion delegates its full terminal mutation to the coordinator', async () => {
  const { captured, lease, service, store } = harness();
  const settled = await settleExternalCompletion(service, {
    lease, rawStore: store, eventBase: { sessionId: 'session_1', streamId: 'stream_1' },
    content: 'done', model: 'local', normalizedPreferences: {},
  });
  assert.equal(settled.handled, true);
  assert.equal(captured[0].terminal.kind, 'complete');
  assert.equal(captured[0].messages[0].content, 'done');
  assert.equal(captured[0].terminal.rendererPayload.type, 'complete');
});

test('external question batch and denial are coordinator-owned terminals', async () => {
  const { captured, lease, service, store } = harness();
  await settleExternalQuestionBatch(service, {
    lease, rawStore: store, eventBase: {}, model: 'local', normalizedPreferences: {},
    questionBatch: { batch_id: 'batch_1', round_index: 1, questions: [{ id: 'q1' }] },
  });
  assert.equal(captured[0].terminal.kind, 'question_batch');
  assert.equal(captured[0].messages[0].kind, 'question_batch');

  lease.terminalCoordinatorRequest = null;
  await settleExternalFailure(service, {
    lease, rawStore: store, eventBase: {}, model: 'local',
    errorPayload: { message: 'denied', status: 'denied' },
    terminal: { status: 'denied', persistAssistantFailure: false, emitErrorEvent: false },
  });
  assert.equal(captured[1].terminal.kind, 'denied');
  assert.equal(captured[1].terminal.rendererPayload.type, 'error');
  assert.deepEqual(captured[1].messages, []);
});

test('external terminal helpers preserve the legacy fallback when no coordinator exists', async () => {
  const store = { getSessionMessages: () => [], commitTerminal() {} };
  const settled = await settleExternalCompletion({}, {
    lease: { identity, store }, rawStore: store, eventBase: {}, content: 'done',
  });
  assert.equal(settled.handled, false);
});
