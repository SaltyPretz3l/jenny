const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness } = require('./helpers/renderer-stream-handler-harness');

// Owner decision 2026-09-15: a current-session error restores the queued head
// to the composer; only background sessions drain their outbox on error.

test('a current-session error restores the queued head to the composer and does not dispatch it', async (t) => {
  let queued = { sessionId: 'session-1', prompt: 'restore me' };
  const restores = [];
  const dispatches = [];
  const harness = createHarness({
    callbackOverrides: {
      getQueuedSend: () => queued,
      restoreQueuedSendDraft(sessionId) {
        restores.push(sessionId);
        queued = null;
      },
      async dispatchQueuedSendForSession(sessionId) {
        dispatches.push(sessionId);
        return { sessionId };
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-current-error' });
  await harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-current-error',
    message: 'provider failed',
  });

  assert.deepEqual(restores, ['session-1']);
  assert.deepEqual(dispatches, []);
});

test('a background-session error dispatches the queued head', async (t) => {
  let queued = { sessionId: 'session-2', prompt: 'send me' };
  const restores = [];
  const dispatches = [];
  const harness = createHarness({
    callbackOverrides: {
      getQueuedSend: (sessionId) => (sessionId === 'session-2' ? queued : null),
      restoreQueuedSendDraft: (sessionId) => restores.push(sessionId),
      async dispatchQueuedSendForSession(sessionId) {
        dispatches.push(sessionId);
        queued = null;
        return { sessionId };
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-2', streamId: 'stream-background-error' });
  await harness.emit({
    type: 'error',
    sessionId: 'session-2',
    streamId: 'stream-background-error',
    message: 'provider failed',
  });

  assert.deepEqual(restores, []);
  assert.deepEqual(dispatches, ['session-2']);
});
