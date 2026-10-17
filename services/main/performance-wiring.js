'use strict';

/* services/main/performance-wiring.js - composes the performance service against
 * the live desktop backend (row 59 checkpoint 6): one inference intake, one GPU
 * collector + warning tracker + sampler per host process, and the bridge service
 * over them. Published as `backendService.inferenceIntake` (the notification
 * router and the chat.send fill) and `backendService.performance` (the bridge).
 * Desktop only; the hosted composition never constructs it.
 *
 * Runtime identity: the managed NInfer {pid, createdAt} is resolved ONCE per
 * launch (cached by pid, reset by `refreshRuntime`, which the NInfer manager's
 * state-change hook calls) because the creation-time query is far too slow to run
 * per sample. "Active generation": a chat stream is live while the managed NInfer
 * serves the openai-compatible engine.
 */

const { createInferenceIntake } = require('../performance/inference-intake');
const { createGpuCollector } = require('../performance/gpu-collector');
const { createGpuWarningTracker } = require('../performance/gpu-warning-state');
const { createGpuSampler } = require('../performance/gpu-sampler');
const { createPerformanceService } = require('../performance/performance-service');
const { getProcessStartTime: defaultGetProcessStartTime } = require('../backend/process-utils');
const { isTerminalChatStreamType } = require('../chat-stream-bridge-support');

const RECHECK_AFTER_TERMINAL_MS = 250;

function createPerformanceWiring({
  backendService, shellConfigService, getNinferManager = () => null, sendBridgeEvent = () => {}, log = () => {},
  now = Date.now, platform = process.platform, getProcessStartTime = defaultGetProcessStartTime,
  createCollector = () => createGpuCollector({ platform, now }),
} = {}) {
  const intake = createInferenceIntake({ now });
  const tracker = createGpuWarningTracker({ now });
  let service = null;
  // The sampler runs the tracker on every sample; the service hears about changes through this wrapper.
  const observedTracker = {
    accept: (...args) => { const result = tracker.accept(...args); service?.noteGpuSample(); return result; },
    snapshot: () => tracker.snapshot(),
    dismiss: (id) => tracker.dismiss(id),
  };
  const sampler = createGpuSampler({ collector: createCollector(), tracker: observedTracker, now });
  service = createPerformanceService({
    shellConfig: shellConfigService, intake, sampler, tracker,
    emitChanged: (event) => sendBridgeEvent('performance.onChanged', event), now,
  });

  const ninferStatus = () => {
    try { return getNinferManager?.()?.getStatus?.() || null; } catch (_error) { return null; }
  };

  let cachedPid = 0;
  let ticket = 0;
  // A failed start-time lookup (the helper resolves '' on timeout) is retried, at most every 30 s.
  let failedPid = 0;
  let retryAfter = 0;
  function lookupFailed(pid, mine, message) {
    if (mine !== ticket) return;
    log('WARN', 'performance.runtime_identity_unavailable', { message: String(message).slice(0, 160) });
    cachedPid = 0; failedPid = pid; retryAfter = now() + 30000;
  }
  function refreshRuntime() {
    const status = ninferStatus();
    const pid = status?.state === 'ready' && Number.isSafeInteger(status.pid) && status.pid > 0 ? status.pid : 0;
    if (pid === cachedPid) return;
    if (pid && pid === failedPid && now() < retryAfter) return;
    cachedPid = pid;
    const mine = ++ticket;
    service.setRuntimeIdentity(null);
    if (!pid) return;
    Promise.resolve().then(() => getProcessStartTime(pid)).then((createdAt) => {
      // A newer launch (or a stop) retires this lookup.
      if (mine !== ticket) return;
      if (createdAt) { failedPid = 0; service.setRuntimeIdentity({ pid, createdAt: String(createdAt) }); }
      else lookupFailed(pid, mine, 'start_time_unavailable');
    }).catch((error) => lookupFailed(pid, mine, error?.message || error));
    refreshActive();
  }

  function refreshActive() {
    const engine = String(backendService?.currentEngineType || '').trim().toLowerCase();
    const live = Number(backendService?.activeStreams?.size) > 0 && ninferStatus()?.state === 'ready'
      && (!engine || engine === 'openai-compatible');
    service.setActiveGeneration(live);
  }

  let recheck = null;
  backendService?.on?.('chat-stream', (event) => {
    const type = event?.type;
    if (type === 'started') refreshActive();
    else if (isTerminalChatStreamType(type)) {
      refreshActive();
      clearTimeout(recheck);
      recheck = setTimeout(refreshActive, RECHECK_AFTER_TERMINAL_MS);
      recheck.unref?.();
    }
  });
  shellConfigService?.on?.('changed', (_state, details) => {
    if (details?.reason === 'performance_telemetry_updated') service.refreshDemand();
    // An import or reset replaces the block without updateSettings: open views refetch.
    else if (details?.reason === 'state_replaced') { service.refreshDemand(); service.notifySettingsChanged(); }
  });

  const dispose = service.dispose;
  service.refreshRuntime = refreshRuntime;
  service.dispose = () => { clearTimeout(recheck); dispose(); };
  if (backendService) {
    backendService.inferenceIntake = intake;
    backendService.performance = service;
  }
  refreshRuntime();
  return service;
}

module.exports = { createPerformanceWiring };
