'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  answerUserQuestions,
  cancelChatStream,
  declineUserQuestions,
  handleChatStreamEnd,
  hasPendingUserQuestions,
} = require('../services/backend/backend-chat-stream');

function pendingEntry(overrides = {}) {
  const resolutions = [];
  return {
    resolutions,
    pending: {
      questionId: 'question_1',
      questionRef: 'question_session_stream_call_question_1',
      callId: 'call_1',
      streamId: 'stream_1',
      resolve(payload) {
        resolutions.push(payload);
      },
      ...overrides,
    },
  };
}

test('answerUserQuestions resolves and deletes by exact ref or unique question id', () => {
  const first = pendingEntry();
  const second = pendingEntry({
    questionId: 'question_2',
    questionRef: 'question_session_stream_call_question_2',
    callId: 'call_2',
  });
  const service = {
    pendingUserQuestions: new Map([
      [first.pending.questionRef, first.pending],
      [second.pending.questionRef, second.pending],
    ]),
  };
  const payload = { answers: [{ id: 'choice', value: 'A' }] };

  assert.equal(answerUserQuestions(service, first.pending.questionRef, payload), true);
  assert.deepEqual(first.resolutions, [payload]);
  assert.equal(service.pendingUserQuestions.has(first.pending.questionRef), false);
  assert.equal(answerUserQuestions(service, 'question_2', payload), true);
  assert.deepEqual(second.resolutions, [payload]);
  assert.equal(service.pendingUserQuestions.size, 0);
});

test('declineUserQuestions resolves as declined and unknown refs return false', () => {
  const entry = pendingEntry();
  const service = {
    pendingUserQuestions: new Map([[entry.pending.questionRef, entry.pending]]),
  };

  assert.equal(declineUserQuestions(service, entry.pending.callId), true);
  assert.deepEqual(entry.resolutions, [{ declined: true }]);
  assert.equal(service.pendingUserQuestions.size, 0);
  assert.equal(declineUserQuestions(service, 'missing'), false);
  assert.equal(answerUserQuestions(service, 'missing', { answers: [] }), false);
});

test('hasPendingUserQuestions reports live refs and becomes false after answer', () => {
  const entry = pendingEntry();
  const service = {
    pendingUserQuestions: new Map([[entry.pending.questionRef, entry.pending]]),
  };

  assert.equal(hasPendingUserQuestions(service, entry.pending.questionRef), true);
  assert.equal(hasPendingUserQuestions(service, 'missing'), false);
  assert.equal(answerUserQuestions(service, entry.pending.questionRef, { answers: [] }), true);
  assert.equal(hasPendingUserQuestions(service, entry.pending.questionRef), false);
});

test('cancelChatStream declines pending questions for only the cancelled stream', () => {
  const cancelled = pendingEntry();
  const retained = pendingEntry({
    questionId: 'question_2',
    questionRef: 'question_session_other_call_question_2',
    callId: 'call_2',
    streamId: 'stream_2',
  });
  let aborted = false;
  const service = {
    activeStreams: new Map([['stream_1', {
      abort() { aborted = true; },
      traceId: 'trace_1',
    }]]),
    pendingToolApprovals: new Map(),
    pendingUserQuestions: new Map([
      [cancelled.pending.questionRef, cancelled.pending],
      [retained.pending.questionRef, retained.pending],
    ]),
    toolExecutor: { cancelPendingForStream() {} },
    _emitServiceLog() {},
  };

  assert.equal(cancelChatStream(service, 'stream_1'), true);
  assert.equal(aborted, true);
  assert.deepEqual(cancelled.resolutions, [{ declined: true }]);
  assert.deepEqual(retained.resolutions, []);
  assert.equal(service.pendingUserQuestions.has(retained.pending.questionRef), true);
});

test('stream end declines pending questions for only the ending stream', () => {
  const ended = pendingEntry();
  const retained = pendingEntry({
    questionId: 'question_2',
    questionRef: 'question_session_other_call_question_2',
    callId: 'call_2',
    streamId: 'stream_2',
  });
  const service = {
    pendingUserQuestions: new Map([
      [ended.pending.questionRef, ended.pending],
      [retained.pending.questionRef, retained.pending],
    ]),
  };

  handleChatStreamEnd(service, { type: 'error', streamId: 'stream_1' });

  assert.deepEqual(ended.resolutions, [{ declined: true }]);
  assert.deepEqual(retained.resolutions, []);
  assert.equal(service.pendingUserQuestions.has(ended.pending.questionRef), false);
  assert.equal(service.pendingUserQuestions.has(retained.pending.questionRef), true);
});
