'use strict';

// Measures streaming IPC bytes by driving the REAL delta producer
// (chat-stream-managed-runtime-notifications) into the REAL bridge, exactly as
// backend-service-wiring.js:354 does. Shared by the gated ratchet
// (tests/streaming-ipc-bytes.load.test.js) and the manual profile
// (scripts/observe/streaming-soak.js) so neither measures a hand-built
// `aggregate` fixture instead of the producer.

const { createChatStreamBridge } = require('../../services/chat-stream-bridge');
const {
  handleNotification,
} = require('../../services/backend/chat-stream-managed-runtime-notifications');
const {
  callsOf,
  makeCtx,
  makeHandleToolNotification,
} = require('./managed-runtime-notification-harness');

// The bridge coalesces on a 50 ms window (DELTA_COALESCE_WINDOW_MS,
// chat-stream-bridge.js:44) and flushes early once two deltas are queued and a
// frame has passed, so a flush every 2 deltas at 25 ms each reproduces the
// production cadence for a 40 tok/s model. A faster model also flushes every 2
// deltas, just sooner, so its bytes per token stay at this measurement. This matters more than it looks: the checkpoint
// safety net is time-based, so the byte win is the ratio of frame rate to
// checkpoint rate. Measuring with a slower flush understates it, and measuring
// with a frozen clock (no checkpoints after the first) wildly overstates it.
const DEFAULT_DELTAS_PER_FLUSH = 2;
const DEFAULT_MS_PER_DELTA = 25;

function createQueuedTimerController() {
  let nextHandle = 1;
  const callbacks = new Map();
  return {
    setTimer(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    clearTimer(handle) {
      callbacks.delete(handle);
    },
    drainAll() {
      while (callbacks.size > 0) {
        const pending = [...callbacks.values()];
        callbacks.clear();
        for (const callback of pending) callback();
      }
    },
    pendingCount() {
      return callbacks.size;
    },
  };
}

function makeBridge(timers) {
  const sent = [];
  const bridge = createChatStreamBridge({
    sendBridgeEvent: (channel, payload) => sent.push({ channel, payload }),
    log: () => {},
    setCoalesceTimer: (callback) => timers.setTimer(callback),
    clearCoalesceTimer: (handle) => timers.clearTimer(handle),
  });
  return { bridge, sent };
}

function measureProducerIpcAmplification(contents, {
  aggregateCheckpoints,
  deltasPerFlush = DEFAULT_DELTAS_PER_FLUSH,
  msPerDelta = DEFAULT_MS_PER_DELTA,
  onDelta = () => {},
} = {}) {
  const realNow = Date.now;
  let nowMs = 1_000_000;
  Date.now = () => nowMs;
  try {
    const timers = createQueuedTimerController();
    const { bridge, sent } = makeBridge(timers);
    const ctx = makeCtx({
      canonicalBridgeEnabled: false,
      textSegmentIndex: 0,
      // The production eventBase (chat-stream-managed-runtime.js:101). streamId is
      // load-bearing here: the bridge coalesces deltas per stream, so without it
      // every delta forwards on its own and the measurement reflects a shape
      // production never sends. The runtime also stamps sequence/channel/phase at
      // emit time, which add a small constant per event this measurement omits.
      eventBase: {
        streamId: 'stream-ipc-bytes',
        sessionId: 'session-ipc-bytes',
        model: 'test-model',
        requestId: 'stream-ipc-bytes',
        traceId: 'stream-ipc-bytes',
        trace_id: 'stream-ipc-bytes',
      },
    });
    ctx.service.featureFlags = { ...ctx.service.featureFlags, aggregate_checkpoints: aggregateCheckpoints };

    let generatedChars = 0;
    let consumed = 0;
    // The recorder's live array; advance a cursor over it rather than copying it per delta.
    const emitted = callsOf(ctx, 'emitChatStream');
    contents.forEach((content, index) => {
      generatedChars += content.length;
      handleNotification(ctx, { method: 'chat.token', params: { delta: content } }, {
        toolContext: {},
        handleToolNotification: makeHandleToolNotification(ctx),
      });
      for (; consumed < emitted.length; consumed += 1) bridge.handleEvent(emitted[consumed].payload);
      if ((index + 1) % deltasPerFlush === 0) timers.drainAll();
      nowMs += msPerDelta;
      onDelta();
    });
    timers.drainAll();
    if (timers.pendingCount() !== 0) throw new Error('final coalesce flush left pending work');

    const totalBytes = sent.reduce((sum, event) => sum + JSON.stringify(event.payload).length, 0);
    return { events: sent.length, totalBytes, generatedChars, ratio: totalBytes / generatedChars };
  } finally {
    Date.now = realNow;
  }
}

module.exports = {
  createQueuedTimerController,
  measureProducerIpcAmplification,
};
