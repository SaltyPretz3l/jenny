'use strict';

// Chat GPU handoff: parks the local chat engine so one built-in tool call
// (image_generate) can own the GPU, then brings the engine back exactly as it
// was. The only writer of the coordinator's `builtin` lease; the plugin
// broker keeps its own inline sequence.
//
//   suspend(owner)          lease -> busy check -> evict (identity kept) -> verify
//   restoreAndRelease()     relaunch the chat engine, then release (once)
//   reconcile()             confirm an orphan cleanup, then release a retained lease
//   close()                 shutdown latch: cancel the render, never restore
//
// Identity matters: the parked chat turn keeps its engine stack, so a managed
// llama-server comes back on the same port with the same api key (the manager's
// stop({ retainIdentity }) / ensureRunning(null, { reuseIdentity })), and Ollama
// is evicted over HTTP directly, never through the sidecar's unload (which
// resets the engine's bound-model state and the turn's next call would fail).

const { t } = require('../i18n-main');
const { probeNvidiaSmiVram } = require('../gpu-vram-probe');
const { pendingRuntimeInferenceCount } = require('./backend-runtime-inference');
const { verifyGpuEvictedForEngine, verifyOllamaGpuEvicted } = require('./exclusive-gpu-preflight');
const { isProcessAlive, wait } = require('./process-utils');

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const OLLAMA_REQUEST_TIMEOUT_MS = 3_000;
const EVICTION_SETTLE_TIMEOUT_MS = 8_000;
const EVICTION_POLL_INTERVAL_MS = 400;

const CODES = Object.freeze({
  BUSY: 'image_gpu_busy',
  EVICTION_UNVERIFIED: 'image_gpu_eviction_unverified',
  VRAM_INSUFFICIENT: 'image_vram_insufficient',
  CLEANUP_PENDING: 'image_engine_cleanup_pending',
  CHAT_RESTORE_FAILED: 'image_chat_restore_failed',
});

const MESSAGES = Object.freeze({
  [CODES.BUSY]: () => t('error.imageGen.gpuBusy',
    'The GPU is busy with another local workload. Wait for it to finish, then try again.'),
  [CODES.EVICTION_UNVERIFIED]: () => t('error.imageGen.evictionUnverified',
    'Jenny could not confirm the chat engine released the GPU, so the image was not started.'),
  [CODES.VRAM_INSUFFICIENT]: () => t('error.imageGen.vramInsufficient',
    'This model set needs more GPU memory than this machine reports.'),
  [CODES.CLEANUP_PENDING]: () => t('error.imageGen.cleanupPending',
    'The image engine did not shut down cleanly. Use Clean up now in Settings > Models > Image engine before the next image.'),
});

class ChatGpuHandoffError extends Error {
  constructor(code, reason = '', details = {}) {
    super((MESSAGES[code] || MESSAGES[CODES.EVICTION_UNVERIFIED])());
    this.name = 'ChatGpuHandoffError';
    this.code = code;
    this.reason = String(reason || code);
    this.details = details;
  }
}

function largestDevice(sample) {
  if (!sample || sample.available === false) {
    return null;
  }
  const devices = Array.isArray(sample.devices) ? sample.devices : [];
  const candidates = devices.filter((device) => Number(device?.totalMb) > 0);
  if (candidates.length === 0) {
    return Number(sample.totalMb) > 0
      ? { usedMb: Number(sample.usedMb) || 0, totalMb: Number(sample.totalMb) }
      : null;
  }
  return candidates.reduce((best, device) => (device.totalMb > best.totalMb ? device : best));
}

function createChatGpuHandoff({
  backendService,
  coordinator,
  getLlamaServerManager = () => null,
  probeVram = probeNvidiaSmiVram,
  fetchImpl = globalThis.fetch,
  ollamaBaseUrl = DEFAULT_OLLAMA_BASE_URL,
  // Kills any render recorded by the engine runner's pidfile and confirms
  // every pid is gone: () => Promise<{ confirmed: boolean }> (S4 supplies it).
  reconcileRenderProcesses = null,
  pendingInferenceCount = pendingRuntimeInferenceCount,
  isProcessAliveImpl = isProcessAlive,
  sleep = wait,
  now = Date.now,
  log = () => {},
} = {}) {
  if (!coordinator || typeof coordinator.acquireExclusiveLease !== 'function') {
    throw new TypeError('chat_gpu_handoff_coordinator_required');
  }
  const state = {
    closing: false,
    // The in-flight handoff: lease, what was evicted, and its settlement.
    active: null,
    // A lease kept after an unconfirmed render cleanup (release needs proof).
    retained: null,
    restoring: false,
    // The last handoff's settlement: restoreAndRelease() keeps answering the
    // same outcome until the next suspend() starts a new one.
    settled: null,
    // The render the tool registered so close() can cancel it.
    render: null,
  };

  function emit(level, event, payload = {}) {
    try {
      log(level, `gpu_handoff.${event}`, payload);
    } catch (_error) { /* logging never breaks the handoff */ }
  }

  function admissionState() {
    return coordinator.getState?.()?.state || 'chat_resident';
  }

  // Consulted by the llama-server manager before every non-restore launch.
  function launchRefusal() {
    if (state.closing) return 'runtime_closing';
    // The restore window counts: the lease is still held while the chat
    // engine relaunches, and only that identity relaunch may take the GPU.
    if (state.active || state.retained || state.restoring) return 'gpu_lease_held';
    return '';
  }

  function getState() {
    return {
      active: Boolean(state.active),
      retained: Boolean(state.retained),
      closing: state.closing,
      admission: admissionState(),
    };
  }

  function busyReason(owner) {
    const streams = backendService?.activeStreams;
    if (streams && typeof streams.size === 'number') {
      for (const streamId of streams.keys()) {
        if (String(streamId) !== owner.stream_id) return 'other_stream_active';
      }
    }
    if (pendingInferenceCount(backendService) > 0) return 'auxiliary_inference_pending';
    const registry = backendService?.sessionTurnActorRegistry || backendService?.sessionTurnActors;
    if (registry) {
      if (typeof registry.pendingUnattachedLeaseSettlementBarriers !== 'function') return 'turn_registry_unverifiable';
      if (registry.pendingUnattachedLeaseSettlementBarriers().length > 0) return 'turn_settlement_pending';
    }
    return '';
  }

  async function vramSample() {
    try {
      return largestDevice(await probeVram());
    } catch (_error) {
      return null;
    }
  }

  async function ollamaRequest(pathname, init) {
    return fetchImpl(`${String(ollamaBaseUrl).replace(/\/+$/, '')}${pathname}`, {
      ...init, signal: AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS),
    });
  }

  // Step 4: evict without touching the engine's logical state. Returns the
  // restore plan, or throws EVICTION_UNVERIFIED when the engine cannot be
  // evicted with proof (external endpoints, adopted servers, unknown state).
  async function evict() {
    const engineType = String(backendService?.currentEngineType || '').trim().toLowerCase();
    if (engineType === 'openai-compatible') {
      const manager = getLlamaServerManager();
      const status = manager?.getStatus?.() || null;
      if (!manager || !status || status.state !== 'ready') {
        throw new ChatGpuHandoffError(CODES.EVICTION_UNVERIFIED, 'chat_engine_state_unknown', { state: status?.state || 'none' });
      }
      if (status.reused || !status.pid) {
        throw new ChatGpuHandoffError(CODES.EVICTION_UNVERIFIED, 'llama_server_not_owned');
      }
      const plan = { engine: 'llama-server', pid: status.pid };
      // Recorded before the stop so a failure past this point still restores.
      state.active.plan = plan;
      const stopped = await manager.stop({ retainIdentity: true });
      if (stopped?.identityRetained !== true) {
        throw new ChatGpuHandoffError(CODES.EVICTION_UNVERIFIED, 'llama_server_stop_unconfirmed', { lastError: stopped?.lastError || '' });
      }
      return plan;
    }
    if (engineType === 'ollama') {
      const model = String(backendService?.currentModel || '').trim();
      if (!model) {
        return { engine: 'ollama', model: '' };
      }
      try {
        const response = await ollamaRequest('/api/generate', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, keep_alive: 0 }),
        });
        if (!response?.ok) {
          throw new Error(`ollama_unload_http_${response?.status || 0}`);
        }
      } catch (error) {
        throw new ChatGpuHandoffError(CODES.EVICTION_UNVERIFIED, 'ollama_unload_failed', { message: String(error?.message || error) });
      }
      return { engine: 'ollama', model };
    }
    const verdict = await verifyGpuEvictedForEngine({ engineType, fetchImpl, url: `${ollamaBaseUrl}/api/ps` });
    if (verdict.ok !== true) {
      throw new ChatGpuHandoffError(CODES.EVICTION_UNVERIFIED, verdict.reason || 'gpu_eviction_unverifiable', { engineType });
    }
    return { engine: 'none' };
  }

  // Step 5: process gone (llama-server) / nothing resident (Ollama), then the
  // largest device shows the free VRAM the render needs. Polled briefly: the
  // driver reclaims memory a beat after the process exits.
  async function verifyEviction(plan, requiredFreeMb) {
    const deadline = now() + EVICTION_SETTLE_TIMEOUT_MS;
    let reason = 'vram_not_freed';
    while (true) {
      let evicted = true;
      if (plan.engine === 'llama-server') {
        evicted = !isProcessAliveImpl(plan.pid);
        if (!evicted) reason = 'llama_server_still_alive';
      } else if (plan.engine === 'ollama') {
        const verdict = await verifyOllamaGpuEvicted({ fetchImpl, url: `${ollamaBaseUrl}/api/ps` });
        evicted = verdict.ok === true;
        if (!evicted) reason = verdict.reason || 'gpu_model_still_resident';
      }
      if (evicted) {
        const device = await vramSample();
        if (!device) return 'vram_probe_unavailable';
        if (device.totalMb - device.usedMb >= requiredFreeMb) return '';
        reason = 'vram_not_freed';
      }
      if (now() >= deadline) return reason;
      await sleep(EVICTION_POLL_INTERVAL_MS);
    }
  }

  // Step 7: bring the chat engine back exactly. Ollama reloads on its next
  // request; a GPU-free engine needs nothing.
  async function restore(plan) {
    if (plan.engine !== 'llama-server') {
      return { restored: true };
    }
    const manager = getLlamaServerManager();
    let status = null;
    try {
      status = await manager?.ensureRunning?.(null, { reuseIdentity: true });
    } catch (error) {
      emit('WARN', 'restore_failed', { message: String(error?.message || error) });
    }
    const restored = status?.state === 'ready' && status?.identityReused === true;
    if (!restored) {
      emit('WARN', 'restore_failed', { state: status?.state || 'unknown', lastError: status?.lastError || '' });
    }
    return { restored };
  }

  function releaseActive(active, reason) {
    const released = coordinator.releaseLease(active.leaseId, active.owner);
    emit(released ? 'INFO' : 'WARN', 'released', { reason, released });
    return released;
  }

  /**
   * Steps 1-5. Resolves `{ leaseId }` with the GPU verified free for the render;
   * throws ChatGpuHandoffError (code image_gpu_busy / image_gpu_eviction_unverified /
   * image_vram_insufficient / image_engine_cleanup_pending). A failure after
   * eviction restores the chat engine before the lease is released.
   */
  async function suspend(owner, { minTotalVramMb = 0, requiredFreeMb = 0 } = {}) {
    if (state.closing) {
      throw new ChatGpuHandoffError(CODES.BUSY, 'runtime_closing');
    }
    if (state.retained) {
      await reconcile();
      if (state.retained) throw new ChatGpuHandoffError(CODES.CLEANUP_PENDING, 'render_cleanup_unconfirmed');
    }
    if (state.active) {
      throw new ChatGpuHandoffError(CODES.BUSY, 'handoff_active');
    }
    const device = await vramSample();
    if (!device) {
      throw new ChatGpuHandoffError(CODES.VRAM_INSUFFICIENT, 'vram_probe_unavailable');
    }
    if (device.totalMb < (Number(minTotalVramMb) || 0)) {
      throw new ChatGpuHandoffError(CODES.VRAM_INSUFFICIENT, 'total_vram_below_floor', { totalMb: device.totalMb, minTotalVramMb });
    }
    // A set that cannot fit even on an empty card fails here, before the chat
    // engine is evicted for nothing.
    if (device.totalMb < (Number(requiredFreeMb) || 0)) {
      throw new ChatGpuHandoffError(CODES.VRAM_INSUFFICIENT, 'required_free_exceeds_total', { totalMb: device.totalMb, requiredFreeMb });
    }
    let leaseId;
    try {
      ({ leaseId } = await coordinator.acquireExclusiveLease({ owner }));
    } catch (error) {
      throw new ChatGpuHandoffError(CODES.BUSY, error?.code || 'lease_unavailable');
    }
    const active = { leaseId, owner, plan: null, settled: null };
    state.active = active;
    state.settled = null;
    emit('INFO', 'lease_acquired', { tool: owner.tool_name, stream: owner.stream_id });
    const busy = busyReason(owner);
    if (busy) {
      state.active = null;
      releaseActive(active, busy);
      throw new ChatGpuHandoffError(CODES.BUSY, busy);
    }
    try {
      active.plan = await evict();
      emit('INFO', 'evicted', { engine: active.plan.engine });
      const unverified = await verifyEviction(active.plan, Number(requiredFreeMb) || 0);
      if (unverified) {
        throw new ChatGpuHandoffError(CODES.EVICTION_UNVERIFIED, unverified);
      }
      coordinator.markPrivilegedResident(leaseId, owner);
      return { leaseId };
    } catch (error) {
      // Eviction may have happened: restore first, release second, then report.
      await restoreAndRelease({ cleanupConfirmed: true, reason: error?.reason || 'suspend_failed' });
      throw error instanceof ChatGpuHandoffError
        ? error
        : new ChatGpuHandoffError(CODES.EVICTION_UNVERIFIED, String(error?.message || error));
    }
  }

  /**
   * Steps 7-8, exactly once. `cleanupConfirmed: false` keeps the lease after
   * the restore attempt (reconcile() releases it with proof). Never throws.
   */
  function restoreAndRelease({ cleanupConfirmed = true, reason = 'done', recorded = true } = {}) {
    const active = state.active || state.settled;
    if (!active) {
      return Promise.resolve({ restored: false, released: false, reason: 'no_active_handoff' });
    }
    if (!active.settled) {
      active.settled = (async () => {
        state.active = null;
        state.settled = active;
        state.render = null;
        state.restoring = true;
        let restored = false;
        try {
          if (state.closing) {
            emit('INFO', 'restore_skipped_closing', {});
          } else if (!cleanupConfirmed) {
            // A render that may still hold the GPU must not share it with a
            // relaunched chat engine; the retained lease blocks chat anyway
            // and the next turn relaunches once reconcile() has proof.
            emit('WARN', 'restore_skipped_unconfirmed', { reason });
          } else if (active.plan) {
            ({ restored } = await restore(active.plan));
          } else {
            restored = true;
          }
        } finally {
          state.restoring = false;
        }
        let released = false;
        if (cleanupConfirmed) {
          released = releaseActive(active, reason);
          replayDeferredRefresh();
        } else {
          // `recorded: false` means the runner could not write the pidfile, so
          // a later reconcile has no record to prove anything with.
          state.retained = { leaseId: active.leaseId, owner: active.owner, recorded: recorded !== false };
          emit('WARN', 'lease_retained', { reason });
        }
        return {
          restored,
          released,
          reason: released ? reason : (cleanupConfirmed ? reason : CODES.CLEANUP_PENDING),
        };
      })();
    }
    return active.settled;
  }

  /** Step 9: kill recorded render pids with proof, then release a retained lease. */
  async function reconcile() {
    // A live handoff owns the pidfile record: reconciling now would kill a
    // healthy render (the Model Library button can be stale).
    if (state.active) {
      emit('INFO', 'reconcile_refused', { reason: 'handoff_active' });
      return { confirmed: false, released: false, reason: 'handoff_active' };
    }
    let confirmed = true;
    const retained = state.retained;
    if (typeof reconcileRenderProcesses === 'function') {
      try {
        const outcome = await reconcileRenderProcesses();
        confirmed = outcome?.confirmed === true;
        // No record is only proof when the retained render had written one.
        if (confirmed && retained && retained.recorded === false && outcome?.action === 'none') {
          confirmed = false;
          emit('WARN', 'reconcile_unrecorded', {});
        }
      } catch (error) {
        confirmed = false;
        emit('WARN', 'reconcile_failed', { message: String(error?.message || error) });
      }
    } else if (retained) {
      confirmed = false;
    }
    if (retained && confirmed) {
      state.retained = null;
      releaseActive(retained, 'reconciled');
      replayDeferredRefresh();
    } else if (!retained && !confirmed) {
      await retainOrphanLease();
    }
    emit(confirmed ? 'INFO' : 'WARN', 'reconciled', { confirmed, released: Boolean(retained && confirmed) });
    return { confirmed, released: Boolean(retained && confirmed) };
  }

  // An orphan render that cannot be proven gone (startup after a crash, or a
  // stale record whose process will not answer) holds the GPU as far as Jenny
  // knows: take the lease so chat launches and turns are refused until a later
  // reconcile() proves the render ended, and the Model Library offers Clean up.
  async function retainOrphanLease() {
    const owner = { kind: 'builtin', tool_name: 'image_generate', call_id: 'orphan_render', stream_id: 'reconcile' };
    try {
      const { leaseId } = await coordinator.acquireExclusiveLease({ owner });
      coordinator.markPrivilegedResident(leaseId, owner);
      state.retained = { leaseId, owner, recorded: true };
      emit('WARN', 'orphan_lease_retained', {});
    } catch (error) {
      emit('WARN', 'orphan_lease_unavailable', { code: String(error?.code || error?.message || error) });
    }
  }

  // A sidecar config refresh dropped while the lease was held runs once now,
  // after the identity restore, so a settings or sign-out change is not lost.
  function replayDeferredRefresh() {
    const reason = backendService?.deferredConfigRefreshReason;
    if (!reason || typeof backendService.refreshManagedConfig !== 'function') return;
    backendService.deferredConfigRefreshReason = null;
    emit('INFO', 'config_refresh_replayed', { reason });
    try {
      Promise.resolve(backendService.refreshManagedConfig(reason)).catch(() => {});
    } catch (_error) { /* the next refresh trigger runs it */ }
  }

  /** The tool registers its running render so close() can cancel it. */
  function registerRender(render) {
    state.render = render && typeof render.cancel === 'function' ? render : null;
  }

  /** Step 10: shutdown latch. Cancels an active render; no restore follows. */
  async function close() {
    state.closing = true;
    const render = state.render;
    state.render = null;
    if (!render) {
      return { cancelled: false };
    }
    try {
      // Proof comes from the runner's settlement; a cancel that answers
      // nothing has proven nothing.
      const outcome = await render.cancel('runtime_closing');
      return { cancelled: true, confirmed: outcome?.confirmed === true };
    } catch (error) {
      emit('WARN', 'close_cancel_failed', { message: String(error?.message || error) });
      return { cancelled: true, confirmed: false };
    }
  }

  // The emergency (synchronous) shutdown path: latch without waiting.
  function markClosing() {
    state.closing = true;
    state.render = null;
  }

  return {
    get closing() { return state.closing; },
    close,
    markClosing,
    getState,
    launchRefusal,
    reconcile,
    registerRender,
    restoreAndRelease,
    suspend,
  };
}

module.exports = {
  CHAT_GPU_HANDOFF_CODES: CODES,
  ChatGpuHandoffError,
  createChatGpuHandoff,
};
