'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { holdEventLoopUntilTestsFinish } = require('./helpers/event-loop-hold');

// Production timers in this module are unref'd; see the helper.
holdEventLoopUntilTestsFinish(test);

const {
  drainActiveChatStreams,
  verifyGpuEvictedForEngine,
  verifyOllamaGpuEvicted,
} = require('../services/backend/exclusive-gpu-preflight');
const {
  SessionTurnActorRegistry,
} = require('../services/backend/session-turn-actor');

function fetchPayload(payload) {
  return async () => ({ ok: true, json: async () => payload });
}

test('GPU eviction requires an explicit empty Ollama model list', async () => {
  assert.deepEqual(await verifyOllamaGpuEvicted({ fetchImpl: fetchPayload({ models: [] }) }),
    { ok: true });
  assert.deepEqual(await verifyOllamaGpuEvicted({ fetchImpl: fetchPayload({ models: [{}] }) }),
    { ok: false, reason: 'gpu_model_still_resident', resident_count: 1 });
});

test('GPU eviction proof rejects local engines without an authoritative unload proof', async () => {
  for (const engineType of ['vllm', 'openai-compatible', 'plugin_host', '']) {
    assert.deepEqual(await verifyGpuEvictedForEngine({ engineType }),
      { ok: false, reason: 'gpu_eviction_unverifiable' });
  }
  assert.deepEqual(await verifyGpuEvictedForEngine({ engineType: 'replay',
    fetchImpl: fetchPayload({ models: [] }) }),
    { ok: true, proof: 'engine_has_no_local_gpu_runtime' });
});

test('chat drain fails closed when an active stream does not settle before its bound', async () => {
  const never = new Promise(() => {});
  const activeStreams = new Map([['stream-1', { settledPromise: never }]]);
  const cancelled = [];
  const result = await drainActiveChatStreams({ activeStreams,
    cancelStream: (streamId) => cancelled.push(streamId), timeoutMs: 5 });
  assert.deepEqual(result, { ok: false, reason: 'chat_drain_unverified' });
  assert.deepEqual(cancelled, ['stream-1']);
});

test('chat drain rejects an active stream without a settlement proof', async () => {
  const cancelled = [];
  const result = await drainActiveChatStreams({
    activeStreams: new Map([['stream-1', {}]]),
    cancelStream: (streamId) => cancelled.push(streamId),
  });

  assert.deepEqual(result, { ok: false, reason: 'chat_drain_unverified' });
  assert.deepEqual(cancelled, ['stream-1']);
});

test('chat drain preserves the legacy empty result without a lease barrier source', async () => {
  assert.deepEqual(await drainActiveChatStreams({ activeStreams: new Map() }),
    { ok: true, stream_count: 0 });
});

test('chat drain fails closed for a reserved turn without an attached controller', async () => {
  const session = { id: 's1', active_turn: null };
  const store = {
    getSession: () => session,
    getSessionMessages: () => [],
    getActiveTurn: () => session.active_turn,
    setTurnIdentity: (_sessionId, identity) => Object.assign(session, identity),
    setActiveTurn: (_sessionId, activeTurn) => (session.active_turn = activeTurn),
    clearActiveTurn: () => (session.active_turn = null),
    flushSession: () => true,
  };
  const registry = new SessionTurnActorRegistry();
  const activeStreams = new Map();
  const lease = registry.reserveStart({ sessionId: 's1', store, activeStreams });

  const result = await drainActiveChatStreams({
    activeStreams,
    getPendingLeaseSettlementBarriers:
      () => registry.pendingUnattachedLeaseSettlementBarriers(),
    timeoutMs: 5,
  });

  assert.deepEqual(result, { ok: false, reason: 'chat_drain_unverified' });
});

test('chat drain re-snapshots streams that attach while lease barriers settle', async () => {
  let settleBarrier;
  let settleStream;
  const barrier = new Promise((resolve) => { settleBarrier = resolve; });
  const controller = {
    settledPromise: new Promise((resolve) => { settleStream = resolve; }),
  };
  const activeStreams = new Map();
  const cancelled = [];
  const draining = drainActiveChatStreams({
    activeStreams,
    cancelStream: (streamId) => {
      cancelled.push(streamId);
      settleStream();
    },
    getPendingLeaseSettlementBarriers: () => [barrier],
  });

  activeStreams.set('stream-attached-during-drain', controller);
  settleBarrier();

  assert.deepEqual(await draining, { ok: true, stream_count: 1 });
  assert.deepEqual(cancelled, ['stream-attached-during-drain']);
});

test('chat drain fails closed when the active-stream snapshot is unavailable', async () => {
  assert.deepEqual(await drainActiveChatStreams({
    getPendingLeaseSettlementBarriers: () => [],
  }), { ok: false, reason: 'chat_drain_unverified' });
});

test('GPU eviction fails closed for malformed probe payloads', async () => {
  for (const payload of [{}, { models: null }, [], null]) {
    assert.deepEqual(await verifyOllamaGpuEvicted({ fetchImpl: fetchPayload(payload) }),
      { ok: false, reason: 'gpu_eviction_probe_failed' });
  }
});
