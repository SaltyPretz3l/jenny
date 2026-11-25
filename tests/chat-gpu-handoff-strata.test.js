'use strict';

// Managed Strata in the image-generation GPU handoff (row 200 S2 step 6): a
// ready Strata server, the highest GPU rank, is parked first with its port and
// key retained and restored with them; a stop that cannot retain the identity
// or a server that never exits is unverified, and the lease is released.
// (chat-gpu-handoff.test.js sits at the test-file line cap.)

const test = require('node:test');
const assert = require('node:assert/strict');

const { CHAT_GPU_HANDOFF_CODES: CODES, ChatGpuHandoffError, createChatGpuHandoff } = require('../services/backend/chat-gpu-handoff');
const { ExclusiveGpuCoordinator, STATE_CHAT_RESIDENT } = require('../services/backend/exclusive-gpu-coordinator');

const OWNER = Object.freeze({ kind: 'builtin', tool_name: 'image_generate', call_id: 'call-1', stream_id: 'stream-1' });
const REQUIREMENTS = { minTotalVramMb: 8_000, requiredFreeMb: 8_000 };

function harness({ retains = true, dies = true, restoreStatus = { state: 'ready', identityReused: true }, ninferReady = true } = {}) {
  const calls = [];
  let strataAlive = true;
  const managerFor = (name, state, pid) => ({
    getStatus: () => ({ state, pid, reused: false }),
    async stop(options) { calls.push([`${name}.stop`, options]); return { state: 'stopped', identityRetained: true, lastError: '' }; },
    async ensureRunning(spec, options) { calls.push([`${name}.ensureRunning`, spec, options]); return { state: 'ready', identityReused: true }; },
  });
  const strata = {
    getStatus: () => ({ state: 'ready', pid: 7070 }),
    async stop(options) {
      calls.push(['strata.stop', options]);
      if (dies) strataAlive = false;
      return { state: 'stopped', identityRetained: retains, lastError: '' };
    },
    async ensureRunning(spec, options) { calls.push(['strata.ensureRunning', spec, options]); return { ...restoreStatus, lastError: '' }; },
  };
  const coordinator = new ExclusiveGpuCoordinator();
  let clock = 0;
  const handoff = createChatGpuHandoff({
    backendService: {
      currentEngineType: 'openai-compatible', currentModel: 'inkling-2-mini-sq-20',
      activeStreams: new Map([[OWNER.stream_id, {}]]),
      sessionTurnActorRegistry: { pendingUnattachedLeaseSettlementBarriers: () => [] },
    },
    coordinator,
    getLlamaServerManager: () => managerFor('llama', 'stopped', 0),
    // Never ready alongside Strata in the app (launch gates); here a ready one proves Strata is parked first.
    getNinferManager: () => managerFor('ninfer', ninferReady ? 'ready' : 'stopped', 5151),
    getStrataManager: () => strata,
    probeVram: async () => ({ available: true, usedMb: strataAlive ? 30_000 : 1_600, totalMb: 32_607, devices: [] }),
    fetchImpl: async () => ({ ok: false, status: 404 }),
    pendingInferenceCount: () => 0,
    isProcessAliveImpl: (pid) => pid === 7070 && strataAlive,
    sleep: async () => { clock += 400; },
    now: () => clock,
    log: () => {},
  });
  return { calls, coordinator, handoff };
}

async function rejectsWith(promise, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ChatGpuHandoffError, error?.message);
    assert.equal(error.code, CODES.EVICTION_UNVERIFIED);
    assert.equal(error.reason, reason);
    return true;
  });
}

test('a ready Strata server is parked first with its identity and restored with it', async () => {
  const h = harness();
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  assert.deepEqual(h.calls, [['strata.stop', { retainIdentity: true }]], 'only Strata is stopped');
  assert.deepEqual(await h.handoff.restoreAndRelease({ reason: 'render_ok' }), { restored: true, released: true, reason: 'render_ok' });
  assert.deepEqual(h.calls.slice(1), [['strata.ensureRunning', null, { reuseIdentity: true }]]);
  assert.deepEqual(h.coordinator.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
});

test('a Strata stop that cannot retain the identity is unverified and the lease released', async () => {
  const h = harness({ retains: false, ninferReady: false });
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), 'strata_stop_unconfirmed');
  assert.deepEqual(h.coordinator.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
});

test('a Strata server that never exits is unverified, restored and the lease released', async () => {
  const h = harness({ dies: false, ninferReady: false });
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), 'strata_still_alive');
  assert.deepEqual(h.calls, [['strata.stop', { retainIdentity: true }], ['strata.ensureRunning', null, { reuseIdentity: true }]]);
  assert.deepEqual(h.coordinator.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
});

test('a Strata restore that comes back without its identity reports restored:false', async () => {
  const h = harness({ restoreStatus: { state: 'crashed', identityReused: false }, ninferReady: false });
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  assert.deepEqual(await h.handoff.restoreAndRelease(), { restored: false, released: true, reason: 'done' });
});
