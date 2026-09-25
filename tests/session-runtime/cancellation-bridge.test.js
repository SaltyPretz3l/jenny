'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cancelChatStream } = require('../../services/backend/backend-chat-stream');

function fixture({ failIntent = false } = {}) {
  const events = [];
  const controller = new AbortController();
  controller.signal.addEventListener('abort', () => events.push('abort'));
  const service = {
    activeStreams: new Map([['stream_1', controller]]),
    sessionRuntime: { noteStreamCancellation(streamId, reason) {
      assert.equal(streamId, 'stream_1');
      assert.equal(reason, 'user');
      events.push('fence');
      if (failIntent) throw Object.assign(new Error('private write detail'), { code: 'write_failed' });
    } },
    pendingToolApprovals: new Map([['call_1', { streamId: 'stream_1', resolve(approved, state) {
      assert.equal(approved, false);
      assert.equal(state, 'cancelled');
      events.push('approval_invalidated');
    } }]]),
    pendingUserQuestions: new Map([['question_1', { streamId: 'stream_1', resolve(value) {
      assert.deepEqual(value, { declined: true });
      events.push('answer_invalidated');
    } }]]),
    toolExecutor: { cancelPendingForStream(id) { assert.equal(id, 'stream_1'); events.push('pending_tools'); } },
    _emitServiceLog(level, event, details) {
      if (level === 'ERROR') {
        assert.equal(event, 'session_runtime.cancellation_intent_failed');
        assert.deepEqual(details, { reason: 'write_failed' });
        events.push('intent_attention');
      }
    },
  };
  return { service, controller, events };
}

test('stream cancellation fences runtime admission before aborting and invalidating live decisions', () => {
  const f = fixture();
  assert.equal(cancelChatStream(f.service, 'stream_1', 'user'), true);
  assert.deepEqual(f.events, ['fence', 'abort', 'approval_invalidated', 'answer_invalidated', 'pending_tools']);
  assert.equal(f.controller.signal.aborted, true);
  assert.equal(f.service.activeStreams.size, 0);
  assert.equal(f.service.pendingToolApprovals.size, 0);
  assert.equal(f.service.pendingUserQuestions.size, 0);
});

test('an intent write failure is reported but cannot suppress physical cancellation', () => {
  const f = fixture({ failIntent: true });
  assert.equal(cancelChatStream(f.service, 'stream_1', 'user'), true);
  assert.deepEqual(f.events.slice(0, 3), ['fence', 'intent_attention', 'abort']);
  assert.equal(f.controller.signal.aborted, true);
});

test('a missing active-stream map entry still fences the runtime without claiming cleanup', () => {
  const f = fixture();
  f.service.activeStreams.clear();
  assert.equal(cancelChatStream(f.service, 'stream_1', 'user'), false);
  assert.deepEqual(f.events, ['fence']);
  assert.equal(f.controller.signal.aborted, false);
});
