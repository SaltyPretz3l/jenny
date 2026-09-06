'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStreamHandlerLifecycle,
} = require('../renderer/chat/renderer-stream-handler-lifecycle');

test('stream lifecycle installs recovery listener before subscription proof and rejects stale epochs', async () => {
  const order = [];
  const recoveries = [];
  const listeners = {};
  let recoveryUnsubscribed = 0;
  const lifecycle = createStreamHandlerLifecycle({
    state: { turnEventsBySession: new Map() },
    normalizeId: (value) => String(value || '').trim(),
    appendClientLog: (...args) => order.push(['log', ...args]),
    handleStreamPayload: async () => ({ buffered: false, terminal: false }),
    handleStreamEnvelope: async () => ({ buffered: false, terminal: false }),
    handleStreamRecovery: async (ticket) => { recoveries.push(ticket); return { ok: true }; },
    pendingStreamCommitQueue: { dispose() {} },
    runtime: { disposeRenderQueue() {} },
    approvalToastSessionIds: new Set(),
    reasoningStreamMerger: { clearAll() {} },
    streamRehydrateUtils: null,
    isRowModelEnabled: () => false,
    getLiveStateStore: () => null,
    isStreamEnvelopeV2Enabled: () => true,
    streamEnvelopeReceiptTracker: {
      beginSubscription(epoch, mode) { order.push(['begin-subscription', epoch, mode]); },
    },
    clearBufferedStreamEvents() {},
  });
  const shell = {
    chat: {
      onStreamRecoveryRequired(listener) {
        order.push(['recovery-listener']);
        listeners.recovery = listener;
        return () => { recoveryUnsubscribed += 1; };
      },
      onStreamEnvelope(listener) {
        order.push(['envelope-listener']);
        listeners.envelope = listener;
        return () => {};
      },
      onStream() { return () => {}; },
    },
    features: { onChanged() { return () => {}; } },
  };

  lifecycle.registerStreamHandler(shell);
  const begin = order.find((entry) => entry[0] === 'begin-subscription');
  assert.ok(begin);
  assert.ok(order.findIndex((entry) => entry[0] === 'recovery-listener') < order.indexOf(begin));

  await listeners.recovery({
    recovery_id: 'stream-1',
    renderer_epoch: begin[1],
    stream_id: 'stream-1',
    session_id: 'session-1',
  });
  assert.equal(recoveries.length, 1);

  await listeners.recovery({
    recovery_id: 'stale',
    renderer_epoch: begin[1] - 1,
    stream_id: 'stale',
    session_id: 'session-1',
  });
  assert.equal(recoveries.length, 1);

  lifecycle.dispose();
  assert.equal(recoveryUnsubscribed, 1);
});
