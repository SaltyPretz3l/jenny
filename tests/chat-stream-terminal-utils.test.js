const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTerminalErrorPayload,
  streamErrorDetailsFromAbortSignal,
} = require('../services/backend/chat-stream-terminal-utils');

test('terminal error payload centralizes cancellation metadata', () => {
  const error = new Error('User stopped the stream.');
  error.category = 'cancelled';
  error.cancel_reason = 'user_cancel';

  assert.deepEqual(buildTerminalErrorPayload(error, 'managed_sidecar'), {
    message: 'User stopped the stream.',
    retryable: true,
    category: 'cancelled',
    status: 'cancelled',
    terminal_subcode: 'user_cancel',
    cancel_reason: 'user_cancel',
  });
});

test('terminal error payload preserves non-cancellation terminal subcodes', () => {
  const error = new Error('Plan drifted after approval.');
  error.status = 'preempted';
  error.category = 'managed_sidecar';
  error.terminal_subcode = 'plan_drift';

  assert.deepEqual(buildTerminalErrorPayload(error, 'managed_sidecar'), {
    message: 'Plan drifted after approval.',
    retryable: true,
    category: 'managed_sidecar',
    status: 'preempted',
    terminal_subcode: 'plan_drift',
  });
});

test('abort signal error reasons preserve timeout cancellation category', () => {
  const controller = new AbortController();
  const timeoutError = new Error('Custom timeout abort');
  timeoutError.cancel_reason = 'timeout';

  controller.abort(timeoutError);

  const { error, cancelReason } = streamErrorDetailsFromAbortSignal(controller.signal);

  assert.equal(error, timeoutError);
  assert.equal(cancelReason, 'timeout');
  assert.equal(error.category, 'timeout');
  assert.equal(error.cancel_reason, 'timeout');
  assert.equal(error.cancelReason, 'timeout');
  assert.equal(error.terminal_subcode, 'timeout');
  assert.equal(error.retryable, true);
});
