'use strict';

// Both terminal drains (complete and error) must name their own stream when
// they ask the outbox to dispatch a queued send: a Stop hold scoped to that
// stream (renderer-send-outbox-dispatch.js holdNextDispatch) is consumed only
// by a drain carrying the matching id. Without it the hold survives the
// cancelled turn's terminal and blocks every later queued dispatch in the
// session (Astra round 2, R17).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHarness,
  flushMicrotasks,
} = require('./helpers/renderer-stream-handler-buffering-harness');

for (const terminalType of ['complete', 'error']) {
  test(`the ${terminalType} terminal drain passes its own stream id to the queued-send dispatcher`, async (t) => {
    const dispatches = [];
    const harness = createHarness({
      stateOverrides: {
        window: {
          jennyShell: {
            sessions: {
              async getMessages() {
                return { data: [] };
              },
            },
          },
        },
      },
      callbackOverrides: {
        isCurrentSession: () => true,
        getQueuedSend: () => ({ sessionId: 'session-1', prompt: 'queued while streaming' }),
        dispatchQueuedSendForSession: async (sessionId, options) => {
          dispatches.push({ sessionId, streamId: String(options?.streamId || '') });
          return { sessionId };
        },
      },
    });
    t.after(() => harness.restore());

    const streamId = `stream-drain-${terminalType}`;
    await harness.emit({ type: 'started', sessionId: 'session-1', streamId });
    await harness.emit({ type: 'delta', sessionId: 'session-1', streamId, aggregate: 'Hi!' });
    await harness.emit(terminalType === 'complete'
      ? { type: 'complete', sessionId: 'session-1', streamId, content: 'Hi!' }
      : { type: 'error', sessionId: 'session-1', streamId, status: 'runtime_error', message: 'provider failed' });
    await flushMicrotasks(20);

    assert.deepEqual(dispatches, [{ sessionId: 'session-1', streamId }]);
  });
}
