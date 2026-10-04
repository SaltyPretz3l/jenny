'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CHAT_GPU_HANDOFF_CODES: CODES,
  ChatGpuHandoffError,
  createChatGpuHandoff,
} = require('../services/backend/chat-gpu-handoff');
const {
  ExclusiveGpuCoordinator,
  STATE_CHAT_RESIDENT,
  STATE_PRIVILEGED_RESIDENT,
} = require('../services/backend/exclusive-gpu-coordinator');

const OWNER = Object.freeze({ kind: 'builtin', tool_name: 'image_generate', call_id: 'call-1', stream_id: 'stream-1' });
const PLUGIN_OWNER = Object.freeze({ kind: 'plugin', publisher_id: 'pub', plugin_id: 'plug', operation_id: 'op' });

// A fake backend on a managed llama-server (pid 4242) with 24 GB of VRAM that
// frees itself once the server is gone. Every collaborator records its calls.
function makeHarness({
  engineType = 'openai-compatible',
  managerStatus = { state: 'ready', pid: 4242, reused: false },
  serverDies = true,
  vramFreesAfterEviction = true,
  totalMb = 24_000,
  restoreStatus = { state: 'ready', identityReused: true },
  reconcileRenderProcesses,
  pendingInference = 0,
  barriers = () => [],
} = {}) {
  const calls = [];
  const logs = [];
  let alive = true;
  let stopped = false;
  const backendService = {
    currentEngineType: engineType,
    currentModel: 'gemma4:12b',
    activeStreams: new Map([[OWNER.stream_id, {}]]),
    sessionTurnActorRegistry: { pendingUnattachedLeaseSettlementBarriers: barriers },
  };
  const manager = {
    getStatus: () => ({ ...managerStatus, identityRetained: stopped }),
    async stop(options) {
      calls.push(['stop', options]);
      stopped = true;
      if (serverDies) alive = false;
      return { state: 'stopped', identityRetained: managerStatus.reused !== true, lastError: '' };
    },
    async ensureRunning(spec, options) {
      calls.push(['ensureRunning', spec, options]);
      return { ...restoreStatus, lastError: '' };
    },
  };
  const ollama = { resident: [{ name: 'gemma4:12b' }] };
  const fetchImpl = async (url, init = {}) => {
    calls.push(['fetch', url, init.method || 'GET', init.body || '']);
    if (url.endsWith('/api/generate')) {
      ollama.resident = [];
      return { ok: true, status: 200 };
    }
    if (url.endsWith('/api/ps')) {
      return { ok: true, status: 200, json: async () => ({ models: ollama.resident }) };
    }
    return { ok: false, status: 404 };
  };
  const coordinator = new ExclusiveGpuCoordinator();
  let clock = 0;
  const handoff = createChatGpuHandoff({
    backendService,
    coordinator,
    getLlamaServerManager: () => manager,
    probeVram: async () => {
      const evicted = engineType === 'ollama' ? ollama.resident.length === 0 : !alive;
      const usedMb = evicted && vramFreesAfterEviction ? 500 : 20_000;
      return { available: true, usedMb, totalMb, devices: [{ index: 0, usedMb, totalMb }] };
    },
    fetchImpl,
    reconcileRenderProcesses,
    pendingInferenceCount: () => pendingInference,
    isProcessAliveImpl: (pid) => pid === 4242 && alive,
    sleep: async () => { clock += 400; },
    now: () => clock,
    log: (level, event, payload) => logs.push({ level, event, payload }),
  });
  return { backendService, calls, coordinator, handoff, logs, manager, ollama };
}

const REQUIREMENTS = { minTotalVramMb: 8_000, requiredFreeMb: 8_000 };

async function rejectsWith(promise, code, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ChatGpuHandoffError, `expected ChatGpuHandoffError, got ${error?.message}`);
    assert.equal(error.code, code);
    if (reason) assert.equal(error.reason, reason);
    return true;
  });
}

test('step 1: a VRAM total below the family floor fails before any lease or eviction', async () => {
  const h = makeHarness({ totalMb: 6_000 });
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), CODES.VRAM_INSUFFICIENT, 'total_vram_below_floor');
  assert.equal(h.coordinator.getState().state, STATE_CHAT_RESIDENT);
  assert.deepEqual(h.calls, []);
});

test('step 1: an unavailable VRAM probe fails closed', async () => {
  const h = makeHarness();
  const handoff = createChatGpuHandoff({
    backendService: h.backendService, coordinator: h.coordinator,
    probeVram: async () => ({ available: false }),
  });
  await rejectsWith(handoff.suspend(OWNER, REQUIREMENTS), CODES.VRAM_INSUFFICIENT, 'vram_probe_unavailable');
});

test('step 2: a lease held by a plugin operation refuses the handoff as busy', async () => {
  const h = makeHarness();
  await h.coordinator.acquireExclusiveLease({ owner: PLUGIN_OWNER });
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), CODES.BUSY, 'gpu_busy');
  assert.deepEqual(h.calls, []);
});

test('step 3: another active stream releases the fresh lease and never evicts', async () => {
  const h = makeHarness();
  h.backendService.activeStreams.set('stream-2', {});
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), CODES.BUSY, 'other_stream_active');
  assert.deepEqual(h.coordinator.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
  assert.deepEqual(h.calls, []);
  assert.equal(h.handoff.launchRefusal(), '');
});

test('step 3: pending auxiliary inference and unsettled turn barriers are busy', async () => {
  const aux = makeHarness({ pendingInference: 1 });
  await rejectsWith(aux.handoff.suspend(OWNER, REQUIREMENTS), CODES.BUSY, 'auxiliary_inference_pending');
  const barrier = makeHarness({ barriers: () => [Promise.resolve()] });
  await rejectsWith(barrier.handoff.suspend(OWNER, REQUIREMENTS), CODES.BUSY, 'turn_settlement_pending');
  const broken = makeHarness();
  broken.backendService.sessionTurnActorRegistry = {};
  await rejectsWith(broken.handoff.suspend(OWNER, REQUIREMENTS), CODES.BUSY, 'turn_registry_unverifiable');
  for (const h of [aux, barrier, broken]) {
    assert.equal(h.coordinator.getState().state, STATE_CHAT_RESIDENT);
    assert.deepEqual(h.calls, []);
  }
});

test('steps 4-5: a managed llama-server is stopped with identity retained, its exit and freed VRAM verified', async () => {
  const h = makeHarness();
  const { leaseId } = await h.handoff.suspend(OWNER, REQUIREMENTS);
  assert.deepEqual(h.calls, [['stop', { retainIdentity: true }]]);
  assert.deepEqual(h.coordinator.getState(), { state: STATE_PRIVILEGED_RESIDENT, leaseId });
  assert.equal(h.handoff.launchRefusal(), 'gpu_lease_held');
  assert.deepEqual(h.handoff.getState(), { active: true, retained: false, closing: false, admission: STATE_PRIVILEGED_RESIDENT });
});

test('step 4: an adopted (reused) server or an unknown engine state is never evicted', async () => {
  const reused = makeHarness({ managerStatus: { state: 'ready', pid: 0, reused: true } });
  await rejectsWith(reused.handoff.suspend(OWNER, REQUIREMENTS), CODES.EVICTION_UNVERIFIED, 'llama_server_not_owned');
  assert.deepEqual(reused.calls, []);
  const crashed = makeHarness({ managerStatus: { state: 'crashed', pid: 0, reused: false } });
  await rejectsWith(crashed.handoff.suspend(OWNER, REQUIREMENTS), CODES.EVICTION_UNVERIFIED, 'chat_engine_state_unknown');
  for (const h of [reused, crashed]) {
    assert.equal(h.coordinator.getState().state, STATE_CHAT_RESIDENT, 'the lease is released on refusal');
  }
});

test('step 4: Ollama is evicted over HTTP directly (keep_alive 0) and verified through /api/ps', async () => {
  const h = makeHarness({ engineType: 'ollama' });
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  const unload = h.calls.find((call) => call[0] === 'fetch' && call[1].endsWith('/api/generate'));
  assert.ok(unload, 'the eviction POSTs /api/generate');
  assert.equal(unload[2], 'POST');
  assert.deepEqual(JSON.parse(unload[3]), { model: 'gemma4:12b', keep_alive: 0 });
  assert.ok(h.calls.some((call) => call[0] === 'fetch' && call[1].endsWith('/api/ps')), 'residency is verified');
  assert.ok(!h.calls.some((call) => call[0] === 'stop' || call[0] === 'ensureRunning'), 'the llama-server manager is untouched');
  assert.equal(h.coordinator.getState().state, STATE_PRIVILEGED_RESIDENT);
  // Ollama reloads on its next request: restore is a no-op, release still happens.
  assert.deepEqual(await h.handoff.restoreAndRelease(), { restored: true, released: true, reason: 'done' });
  assert.equal(h.coordinator.getState().state, STATE_CHAT_RESIDENT);
});

test('step 4: engines without a verifiable eviction fail closed', async () => {
  const h = makeHarness({ engineType: 'vllm' });
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), CODES.EVICTION_UNVERIFIED, 'gpu_eviction_unverifiable');
  assert.equal(h.coordinator.getState().state, STATE_CHAT_RESIDENT);
});

test('step 5: a server that never exits is reported unverified, the chat engine restored and the lease released', async () => {
  const h = makeHarness({ serverDies: false });
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), CODES.EVICTION_UNVERIFIED, 'llama_server_still_alive');
  assert.deepEqual(h.calls.map((call) => call[0]), ['stop', 'ensureRunning']);
  assert.deepEqual(h.calls[1].slice(1), [null, { reuseIdentity: true }]);
  assert.equal(h.coordinator.getState().state, STATE_CHAT_RESIDENT);
  assert.equal(h.handoff.launchRefusal(), '');
});

test('step 5: VRAM that stays occupied after the exit is unverified', async () => {
  const h = makeHarness({ vramFreesAfterEviction: false });
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), CODES.EVICTION_UNVERIFIED, 'vram_not_freed');
  assert.equal(h.coordinator.getState().state, STATE_CHAT_RESIDENT);
});

test('steps 7-8: restoreAndRelease relaunches with the retained identity, then releases, exactly once', async () => {
  const h = makeHarness();
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  const first = h.handoff.restoreAndRelease({ reason: 'render_ok' });
  const second = h.handoff.restoreAndRelease({ reason: 'render_ok' });
  assert.deepEqual(await first, { restored: true, released: true, reason: 'render_ok' });
  assert.deepEqual(await second, await first, 'the second call settles on the same outcome');
  assert.equal(h.calls.filter((call) => call[0] === 'ensureRunning').length, 1);
  assert.deepEqual(h.coordinator.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
  assert.deepEqual(await h.handoff.restoreAndRelease(), await first, 'a late call after settlement answers the same outcome');
  assert.equal(h.calls.filter((call) => call[0] === 'ensureRunning').length, 1);
  const idle = makeHarness();
  assert.deepEqual(await idle.handoff.restoreAndRelease(), { restored: false, released: false, reason: 'no_active_handoff' });
});

test('step 8: a failed restore still releases the lease and reports restored:false', async () => {
  const h = makeHarness({ restoreStatus: { state: 'stopped', identityReused: false } });
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  assert.deepEqual(await h.handoff.restoreAndRelease(), { restored: false, released: true, reason: 'done' });
  assert.equal(h.coordinator.getState().state, STATE_CHAT_RESIDENT);
  assert.ok(h.logs.some((entry) => entry.event === 'gpu_handoff.restore_failed'));
  // A server that came back under a different key is not a restore either.
  const wrongKey = makeHarness({ restoreStatus: { state: 'ready', identityReused: false } });
  await wrongKey.handoff.suspend(OWNER, REQUIREMENTS);
  assert.equal((await wrongKey.handoff.restoreAndRelease()).restored, false);
});

test('step 9: an unconfirmed cleanup keeps the lease until reconcile proves the render is gone', async () => {
  let confirmed = false;
  const h = makeHarness({ reconcileRenderProcesses: async () => ({ confirmed }) });
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  const outcome = await h.handoff.restoreAndRelease({ cleanupConfirmed: false, reason: 'kill_unconfirmed' });
  assert.deepEqual(outcome, { restored: false, released: false, reason: CODES.CLEANUP_PENDING });
  assert.ok(!h.calls.some((call) => call[0] === 'ensureRunning'), 'no chat engine shares the GPU with an unproven render');
  assert.ok(h.logs.some((entry) => entry.event === 'gpu_handoff.restore_skipped_unconfirmed'));
  assert.equal(h.coordinator.getState().state, STATE_PRIVILEGED_RESIDENT, 'the lease is retained');
  assert.equal(h.handoff.launchRefusal(), 'gpu_lease_held');
  assert.equal(h.handoff.getState().retained, true);

  // The next handoff reconciles first and fails while the orphan is unproven.
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), CODES.CLEANUP_PENDING, 'render_cleanup_unconfirmed');
  assert.deepEqual(await h.handoff.reconcile(), { confirmed: false, released: false });
  assert.equal(h.coordinator.getState().state, STATE_PRIVILEGED_RESIDENT);

  confirmed = true;
  assert.deepEqual(await h.handoff.reconcile(), { confirmed: true, released: true });
  assert.deepEqual(h.coordinator.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
  assert.equal(h.handoff.launchRefusal(), '');
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  assert.equal(h.coordinator.getState().state, STATE_PRIVILEGED_RESIDENT, 'a later handoff proceeds');
});

test('step 1: a free-VRAM requirement above the device total fails before eviction', async () => {
  const h = makeHarness({ totalMb: 24_000 });
  await rejectsWith(h.handoff.suspend(OWNER, { minTotalVramMb: 8_000, requiredFreeMb: 30_000 }),
    CODES.VRAM_INSUFFICIENT, 'required_free_exceeds_total');
  assert.ok(!h.calls.some((call) => call[0] === 'stop'), 'the chat engine was never stopped');
  assert.equal(h.coordinator.getState().state, STATE_CHAT_RESIDENT);
});

test('step 7: launches are refused while the identity restore is in flight', async () => {
  const h = makeHarness();
  let finishRestore;
  h.manager.ensureRunning = async (spec, options) => {
    h.calls.push(['ensureRunning', spec, options]);
    await new Promise((resolve) => { finishRestore = resolve; });
    return { state: 'ready', identityReused: true, lastError: '' };
  };
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  const settling = h.handoff.restoreAndRelease({ reason: 'render_ok' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.handoff.launchRefusal(), 'gpu_lease_held', 'no autostart may race the relaunch');
  finishRestore();
  assert.equal((await settling).released, true);
  assert.equal(h.handoff.launchRefusal(), '');
});

test('step 9: reconcile is refused while a handoff is active and does not kill the live render', async () => {
  let reaps = 0;
  const h = makeHarness({ reconcileRenderProcesses: async () => { reaps += 1; return { confirmed: true }; } });
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  assert.deepEqual(await h.handoff.reconcile(), { confirmed: false, released: false, reason: 'handoff_active' });
  assert.equal(reaps, 0);
  assert.equal(h.coordinator.getState().state, STATE_PRIVILEGED_RESIDENT);
  await h.handoff.restoreAndRelease();
  assert.deepEqual(await h.handoff.reconcile(), { confirmed: true, released: false });
  assert.equal(reaps, 1);
});

test('step 9: a missing pidfile is not proof for a render that never wrote one', async () => {
  let action = 'none';
  const h = makeHarness({ reconcileRenderProcesses: async () => ({ confirmed: true, action }) });
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  await h.handoff.restoreAndRelease({ cleanupConfirmed: false, recorded: false });
  assert.deepEqual(await h.handoff.reconcile(), { confirmed: false, released: false });
  assert.equal(h.coordinator.getState().state, STATE_PRIVILEGED_RESIDENT);
  action = 'killed';
  assert.deepEqual(await h.handoff.reconcile(), { confirmed: true, released: true });
  // A recorded render with no record left is the normal clean case.
  const recorded = makeHarness({ reconcileRenderProcesses: async () => ({ confirmed: true, action: 'none' }) });
  await recorded.handoff.suspend(OWNER, REQUIREMENTS);
  await recorded.handoff.restoreAndRelease({ cleanupConfirmed: false });
  assert.deepEqual(await recorded.handoff.reconcile(), { confirmed: true, released: true });
});

test('a sidecar config refresh deferred during the handoff is replayed once after release', async () => {
  const h = makeHarness({ reconcileRenderProcesses: async () => ({ confirmed: true, action: 'killed' }) });
  const refreshes = [];
  h.backendService.refreshManagedConfig = async (reason) => { refreshes.push(reason); };
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  h.backendService.deferredConfigRefreshReason = 'config_updated';
  await h.handoff.restoreAndRelease();
  assert.deepEqual(refreshes, ['config_updated']);
  assert.equal(h.backendService.deferredConfigRefreshReason, null);
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  h.backendService.deferredConfigRefreshReason = 'llama_server_ready';
  await h.handoff.restoreAndRelease({ cleanupConfirmed: false });
  assert.deepEqual(refreshes, ['config_updated'], 'a retained lease keeps the refresh deferred');
  await h.handoff.reconcile();
  assert.deepEqual(refreshes, ['config_updated', 'llama_server_ready']);
});

test('step 9: an unproven orphan with no lease takes one, so chat stays off the GPU until proof', async () => {
  let confirmed = false;
  const h = makeHarness({ reconcileRenderProcesses: async () => ({ confirmed }) });
  assert.deepEqual(await h.handoff.reconcile(), { confirmed: false, released: false });
  assert.equal(h.coordinator.getState().state, STATE_PRIVILEGED_RESIDENT, 'an orphan lease is held');
  assert.equal(h.handoff.launchRefusal(), 'gpu_lease_held');
  assert.equal(h.handoff.getState().retained, true);
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), CODES.CLEANUP_PENDING, 'render_cleanup_unconfirmed');
  confirmed = true;
  assert.deepEqual(await h.handoff.reconcile(), { confirmed: true, released: true });
  assert.deepEqual(h.coordinator.getState(), { state: STATE_CHAT_RESIDENT, leaseId: null });
  assert.equal(h.handoff.launchRefusal(), '');
  // A lease already held by a plugin cannot be taken; the refusal is logged, not thrown.
  const busy = makeHarness({ reconcileRenderProcesses: async () => ({ confirmed: false }) });
  await busy.coordinator.acquireExclusiveLease({ owner: PLUGIN_OWNER });
  assert.deepEqual(await busy.handoff.reconcile(), { confirmed: false, released: false });
  assert.equal(busy.handoff.getState().retained, false);
  assert.ok(busy.logs.some((entry) => entry.event === 'gpu_handoff.orphan_lease_unavailable'));
});

test('step 9: without a render reaper a retained lease is never released', async () => {
  const h = makeHarness();
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  await h.handoff.restoreAndRelease({ cleanupConfirmed: false });
  assert.deepEqual(await h.handoff.reconcile(), { confirmed: false, released: false });
  assert.equal(h.coordinator.getState().state, STATE_PRIVILEGED_RESIDENT);
});

test('step 10: close() cancels the registered render, skips the restore and refuses later handoffs', async () => {
  const h = makeHarness();
  await h.handoff.suspend(OWNER, REQUIREMENTS);
  const cancels = [];
  h.handoff.registerRender({ cancel: async (reason) => { cancels.push(reason); return { confirmed: true }; } });
  assert.deepEqual(await h.handoff.close(), { cancelled: true, confirmed: true });
  assert.deepEqual(cancels, ['runtime_closing']);
  // Only the runner's settlement counts as proof.
  const unproven = makeHarness();
  await unproven.handoff.suspend(OWNER, REQUIREMENTS);
  unproven.handoff.registerRender({ cancel: async () => ({}) });
  assert.deepEqual(await unproven.handoff.close(), { cancelled: true, confirmed: false });
  const latched = makeHarness();
  latched.handoff.markClosing();
  assert.equal(latched.handoff.closing, true);
  await rejectsWith(latched.handoff.suspend(OWNER, REQUIREMENTS), CODES.BUSY, 'runtime_closing');
  assert.equal(h.handoff.closing, true);
  assert.equal(h.handoff.launchRefusal(), 'runtime_closing');
  assert.deepEqual(await h.handoff.restoreAndRelease(), { restored: false, released: true, reason: 'done' });
  assert.ok(!h.calls.some((call) => call[0] === 'ensureRunning'), 'no llama-server relaunch during shutdown');
  await rejectsWith(h.handoff.suspend(OWNER, REQUIREMENTS), CODES.BUSY, 'runtime_closing');
  assert.deepEqual(await h.handoff.close(), { cancelled: false }, 'idle close has nothing to cancel');
});

test('every error code carries a translated user-facing message', () => {
  for (const code of Object.values(CODES)) {
    const error = new ChatGpuHandoffError(code, 'why');
    assert.equal(error.code, code);
    assert.equal(error.reason, 'why');
    assert.ok(error.message.length > 20, `${code} has a message`);
  }
});
