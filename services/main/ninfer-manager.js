'use strict';

// Owns the managed NInfer process (ninfer-serve) for the lifetime of the app:
// the sibling of services/main/llama-server-manager.js for the RTX 5090
// runtime (row 54). The lifecycle module (services/ninfer-lifecycle.js) spawns
// ONE server and hands back a handle; this manager adds the explicit state
// machine, one serial operation chain, the launch plan (eligibility, installed
// runtime, downloaded artifact, saved context/MTP/vision), identity retention for
// the chat GPU handoff and the opt-in GPU watchdog (Step 6b).
//
//   stopped -> starting -> ready -> stopping -> stopped
//                   \-> stopped (start failed)      ready -> crashed (child exit,
//                                                            watchdog trip)
//
// One managed server owns the GPU: a launch here first stops the managed
// llama-server (confirmed) and refuses when that stop is unconfirmed. The
// reverse direction is a synchronous gate on the llama-server manager
// (runtime-shutdown.js composes it) plus the load path's explicit stop, so
// neither chain ever awaits the other from inside its own chain (no deadlock).
//
// Crash policy mirrors llama-server: a child that exits while `ready` is
// recorded as `crashed` and surfaced, never respawned here; ensureRunning()
// (chat preflight, Use, Restart) is the recovery gate.

const ninferLifecycle = require('../ninfer-lifecycle');
const { reconcileRetainedPid } = require('../llama-server-pidfile');
const { createNinferGpuWatchdog } = require('../ninfer-gpu-watchdog');
const { NINFER_CONTEXT_SIZES } = require('../shell-config-engines');

const STATES = Object.freeze(['stopped', 'starting', 'ready', 'stopping', 'crashed']);
const ARTIFACT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Only the four keys a caller may steer; everything else is dropped so an
// IPC payload can never smuggle launch arguments in.
function normalizeNinferSpec(spec) {
  const source = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
  if (!source) return null;
  const normalized = {};
  const artifactId = String(source.artifactId || '').trim();
  if (artifactId && ARTIFACT_ID.test(artifactId)) normalized.artifactId = artifactId;
  if (NINFER_CONTEXT_SIZES.includes(source.contextSize)) normalized.contextSize = source.contextSize;
  if (typeof source.mtp === 'boolean') normalized.mtp = source.mtp;
  if (typeof source.vision === 'boolean') normalized.vision = source.vision;
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function createNinferManager({
  // String, or a thunk (main.js passes () => app.getPath('userData')).
  userDataPath = '',
  getShellConfigService = () => null,
  // { install, artifacts, eligibility } (backend-service-wiring.js attaches
  // them to backendService.ninferRuntime); null refuses every launch.
  getRuntime = () => null,
  // The managed llama-server: stopped (confirmed) before any NInfer launch.
  getLlamaServerManager = () => null,
  // Called with getStatus() after every transition; the backend re-brokers
  // the per-launch api key to the sidecar when a server comes up. May return
  // a promise the launch waits for. Exceptions are swallowed.
  onStateChange = () => {},
  // Refusal reason ('' admits) read before every launch that is not an
  // identity restore (the chat GPU handoff's lease / closing latch).
  launchGate = () => '',
  lifecycle = ninferLifecycle,
  createWatchdog = createNinferGpuWatchdog,
  emitStartupAuditMark = () => {},
  log = () => {},
  now = Date.now,
} = {}) {
  let state = 'stopped';
  let handle = null;
  let startupAbortController = null;
  let generation = 0;
  let lastSpec = null;
  let currentPlan = null;
  let retainedIdentity = null;
  let chain = Promise.resolve();
  let cleanupPending = false;
  // stopSync() (emergency shutdown) sets this: no launch queued behind it runs.
  let halted = false;
  let earlyExits = new Map();
  const status = {
    pid: 0,
    port: 0,
    // The id the sidecar addresses the model by (artifact model_id), like
    // llama-server's alias; displayName is the human label.
    alias: '',
    displayName: '',
    artifactId: '',
    contextSize: 0,
    mtp: false,
    vision: false,
    hostKvMib: 0,
    runtimeLabel: '',
    reused: false,
    identityRetained: false,
    identityReused: false,
    lastError: '',
    // C9 copy: the pinned host memory the runtime could not reserve.
    hostMemoryGb: 0,
    // 'watchdog' when the GPU watchdog stopped the server; '' otherwise.
    stoppedBy: '',
    watchdogWatts: 0,
    watchdogTempC: 0,
    changedAt: 0,
  };

  function getStatus() {
    return { state, ...status };
  }

  function resolveUserDataPath() {
    return String((typeof userDataPath === 'function' ? userDataPath() : userDataPath) || '');
  }

  function ninferSettings() {
    try {
      return getShellConfigService()?.getLocalEngines?.()?.ninfer || null;
    } catch (_error) {
      return null;
    }
  }

  const watchdog = createWatchdog({
    getSettings: () => ninferSettings()?.watchdog || null,
    onTrip: (trip) => { void tripWatchdog(trip); },
    log,
  });

  function setState(next, patch = {}) {
    if (!STATES.includes(next)) {
      throw new Error(`ninfer_manager_invalid_state:${next}`);
    }
    state = next;
    const down = ['stopped', 'crashed'].includes(next);
    if (down) watchdog.stop();
    Object.assign(status, patch, {
      ...(down ? { pid: 0, hostKvMib: 0, runtimeLabel: '', vision: false } : {}),
      changedAt: now(),
    });
    try {
      return onStateChange(getStatus());
    } catch (_error) { /* observers never break the state machine */ }
    return undefined;
  }

  function getApiKey() {
    return String(handle?.apiKey || '');
  }

  // `http://127.0.0.1:8034/v1` while a server is tracked, '' otherwise.
  function getBaseUrl() {
    return String(handle?.baseUrl || '');
  }

  function serialize(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  function reconcileCleanup() {
    if (!cleanupPending) return true;
    try {
      const settled = reconcileRetainedPid({
        userDataPath: resolveUserDataPath(),
        pidFileName: lifecycle.NINFER_PID_FILENAME,
        logger: (level, event, details) => log(level, String(event).replace(/^llama\.server\./, 'ninfer.server.'), details),
      });
      if (settled && settled.confirmed === true) {
        cleanupPending = false;
        return true;
      }
    } catch (_error) { /* fail closed: still unconfirmed */ }
    return false;
  }

  function abortStartup() {
    if (startupAbortController) {
      startupAbortController.abort();
      startupAbortController = null;
    }
  }

  function planError(reason, extra = {}) {
    return { error: reason, ...extra };
  }

  // Everything a launch needs, from (explicit spec) > (saved settings) >
  // (artifact defaults). Every refusal is a typed reason, nothing is spawned.
  async function resolveLaunchPlan(spec) {
    const runtime = getRuntime();
    if (!runtime || !runtime.install || !runtime.artifacts) return planError('ninfer_runtime_unavailable');
    let eligibility;
    try {
      eligibility = typeof runtime.eligibility === 'function' ? await runtime.eligibility() : null;
    } catch (_error) { eligibility = null; }
    if (!eligibility || eligibility.eligible !== true) {
      return planError(`ninfer_ineligible:${eligibility?.reason || 'ninfer_probe_failed'}`);
    }
    const executable = runtime.install.resolveExecutable();
    if (!executable || executable.ok !== true) return planError('ninfer_runtime_missing');
    const settings = ninferSettings();
    const pins = Array.isArray(runtime.artifacts.artifacts) ? runtime.artifacts.artifacts : [];
    const artifactId = spec?.artifactId || settings?.lastUsedArtifactId || pins[0]?.id || '';
    const artifact = pins.find((pin) => pin.id === artifactId) || null;
    if (!artifact) return planError('ninfer_artifact_unknown', { artifactId });
    const located = await runtime.artifacts.resolveArtifactPath(artifact.id);
    if (!located || located.ok !== true) {
      return planError(`ninfer_artifact_missing:${located?.reason || 'not_downloaded'}`, { artifactId: artifact.id });
    }
    const requestedContext = spec?.contextSize || settings?.contextSize;
    const contextSize = artifact.context_windows.includes(requestedContext)
      ? requestedContext : artifact.default_context_window;
    const mtp = artifact.supports_mtp === true && (typeof spec?.mtp === 'boolean' ? spec.mtp : settings?.mtp !== false);
    return {
      artifact,
      gpuIndex: Number.isInteger(eligibility.device?.index) ? eligibility.device.index : null,
      launchOptions: {
        binaryPath: executable.path,
        artifactPath: located.path,
        userDataPath: resolveUserDataPath(),
        runtimeVersion: String(executable.version || ''),
        modelId: artifact.model_id,
        contextSize,
        mtp,
        vision: typeof spec?.vision === 'boolean' ? spec.vision : settings?.vision !== false,
        draftTokens: ninferLifecycle.DEFAULT_DRAFT_TOKENS,
        kvDtype: Array.isArray(artifact.fp8_kv_windows) && artifact.fp8_kv_windows.includes(contextSize) ? 'fp8' : '',
        logger: log,
      },
    };
  }

  function onChildExit(startGeneration, info) {
    if (startGeneration !== generation) return;
    if (state === 'starting') {
      if (info && info.pid) earlyExits.set(info.pid, info);
      return;
    }
    if (state !== 'ready') return;
    if (handle && handle.pid && info && info.pid && info.pid !== handle.pid) return;
    const code = info && info.code != null ? info.code : null;
    const signal = info && info.signal ? String(info.signal) : '';
    handle = null;
    currentPlan = null;
    setState('crashed', {
      contextSize: 0, mtp: false, identityReused: false, stoppedBy: '',
      lastError: `ninfer_exited:${code != null ? code : signal || 'unknown'}`,
    });
    log('WARN', 'ninfer.server.crashed_pending_recovery', {
      port: status.port, alias: status.alias, code, signal,
      message: 'ninfer-serve exited unexpectedly; it will be restarted on the next chat.',
    });
  }

  // Stops the managed llama-server before NInfer takes the GPU. Returns a
  // refusal reason when that stop could not be confirmed.
  async function stopLlamaServerFirst() {
    const other = getLlamaServerManager();
    if (!other || typeof other.stop !== 'function') return '';
    const before = other.getStatus?.() || {};
    const stopped = await other.stop();
    const failure = String(stopped?.lastError || '');
    if (failure) return `llama_server_stop_unconfirmed:${failure}`;
    if (['ready', 'starting', 'stopping'].includes(String(before.state || ''))) {
      log('INFO', 'ninfer.server.llama_server_stopped_first', { alias: before.alias || '' });
    }
    return '';
  }

  async function launch(plan, launchExtras = {}) {
    const { artifact, launchOptions } = plan;
    if (halted) return refusedStatus('ninfer_halted');
    if (!reconcileCleanup()) {
      setState('stopped', { lastError: 'stop_unconfirmed' });
      log('WARN', 'ninfer.server.launch_refused', { reason: 'stop_unconfirmed' });
      return getStatus();
    }
    const reuseIdentity = Boolean(launchExtras.retainedApiKey);
    if (!reuseIdentity) retainedIdentity = null;
    emitStartupAuditMark('ninfer-start', { source: 'main' });
    // The GPU is reserved (`starting`) before the other manager's stop is
    // awaited: the llama-server launch gate reads that state, so a Use queued
    // behind that stop is refused instead of racing this launch. The
    // generation and abort controller are captured first too, so a stopSync()
    // during the stop retires this launch rather than a later one.
    const startGeneration = ++generation;
    earlyExits = new Map();
    const abortController = new AbortController();
    startupAbortController = abortController;
    const onExit = (info) => onChildExit(startGeneration, info);
    setState('starting', {
      port: lifecycle.DEFAULT_NINFER_PORT,
      alias: artifact.model_id,
      displayName: String(artifact.display_name || artifact.id),
      artifactId: artifact.id,
      contextSize: launchOptions.contextSize,
      mtp: launchOptions.mtp,
      vision: launchOptions.vision,
      runtimeLabel: launchOptions.runtimeVersion,
      lastError: '', hostMemoryGb: 0, stoppedBy: '', watchdogWatts: 0, watchdogTempC: 0,
    });
    const exclusivity = await stopLlamaServerFirst();
    if (startGeneration !== generation) {
      // stopSync() ran while llama-server was stopping; it already set `stopped`.
      if (startupAbortController === abortController) startupAbortController = null;
      return getStatus();
    }
    if (exclusivity) {
      if (startupAbortController === abortController) startupAbortController = null;
      setState('stopped', { contextSize: 0, mtp: false, lastError: exclusivity });
      log('WARN', 'ninfer.server.launch_refused', { reason: 'llama_server_stop_unconfirmed' });
      return getStatus();
    }
    try {
      const nextHandle = await lifecycle.startNinferServer({
        ...launchOptions,
        ...launchExtras,
        abortSignal: abortController.signal,
        onExit,
      });
      if (startGeneration !== generation) {
        // stopSync() ran while the child was coming up (emergency shutdown).
        try { nextHandle.stopSync?.(); } catch (_error) { /* best effort only */ }
        return getStatus();
      }
      const early = nextHandle.pid ? earlyExits.get(nextHandle.pid) : null;
      earlyExits = new Map();
      if (early) {
        throw Object.assign(new Error(`ninfer_exited:${early.code != null ? early.code : early.signal || 'unknown'}`),
          { reason: `ninfer_exited:${early.code != null ? early.code : early.signal || 'unknown'}` });
      }
      handle = nextHandle;
      currentPlan = plan;
      log('INFO', 'ninfer.server.started', { baseUrl: nextHandle.baseUrl, pid: nextHandle.pid, mtp: nextHandle.mtp, vision: nextHandle.vision });
      const observed = setState('ready', {
        pid: nextHandle.pid || 0,
        port: nextHandle.port || lifecycle.DEFAULT_NINFER_PORT,
        contextSize: nextHandle.contextSize || launchOptions.contextSize,
        mtp: Boolean(nextHandle.mtp),
        vision: Boolean(nextHandle.vision),
        hostKvMib: Number(nextHandle.hostKvMib) || 0,
        identityRetained: false,
        identityReused: reuseIdentity,
        lastError: '',
      });
      watchdog.start();
      emitStartupAuditMark('ninfer-ready', { source: 'main', pid: nextHandle.pid || 0 });
      // Callers resume only once the sidecar holds this launch's key; a
      // stop()/restart() must not queue behind a stalled re-broker.
      await new Promise((resolve) => {
        Promise.resolve(observed).then(resolve, resolve);
        abortController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (startupAbortController === abortController) startupAbortController = null;
    } catch (error) {
      if (startupAbortController === abortController) startupAbortController = null;
      handle = null;
      currentPlan = null;
      if (error && error.cleanupUnconfirmed === true) cleanupPending = true;
      const reason = String(error?.reason || error?.message || error);
      setState('stopped', {
        contextSize: 0, mtp: false, identityReused: false, lastError: reason,
        hostMemoryGb: Number(error?.pinnedGb) || 0,
      });
      log('WARN', 'ninfer.server.start_failed', { reason, pinnedGb: Number(error?.pinnedGb) || 0 });
      emitStartupAuditMark('ninfer-failed', { source: 'main', reason });
    }
    return getStatus();
  }

  async function launchFromSpec(spec) {
    lastSpec = spec;
    if (halted) return refusedStatus('ninfer_halted');
    // Only stopSync() moves the generation while the plan resolves (the
    // chain holds every other mutation): a shutdown meanwhile cancels the launch.
    const planGeneration = generation;
    const plan = await resolveLaunchPlan(spec);
    if (halted || planGeneration !== generation) return refusedStatus('ninfer_halted');
    if (plan.error) {
      log('WARN', 'ninfer.server.launch_refused', { reason: plan.error });
      setState('stopped', { lastError: plan.error, artifactId: plan.artifactId || status.artifactId });
      return getStatus();
    }
    return launch(plan);
  }

  // Would a ready server have to be replaced to honor `spec`?
  function needsRelaunch(spec) {
    if (state !== 'ready') return true;
    if (!spec) return false;
    if (spec.artifactId && spec.artifactId !== status.artifactId) return true;
    if (spec.contextSize && spec.contextSize !== status.contextSize) return true;
    if (typeof spec.mtp === 'boolean' && spec.mtp !== status.mtp) return true;
    return typeof spec.vision === 'boolean' && spec.vision !== status.vision;
  }

  async function stopCurrent({ retainIdentity = false, stoppedBy = '', trip = null } = {}) {
    const current = handle;
    const plan = currentPlan;
    handle = null;
    currentPlan = null;
    retainedIdentity = null;
    watchdog.stop();
    if (!current) {
      if (!reconcileCleanup()) {
        setState('stopped', { lastError: 'stop_unconfirmed' });
      } else if (state !== 'stopped' || status.lastError) {
        setState('stopped', { lastError: '', stoppedBy: '' });
      }
      return getStatus();
    }
    generation += 1; // retire the exit hook of the handle we are stopping
    setState('stopping');
    let stopError = '';
    try {
      const result = await current.stop();
      if (result && result.confirmed === false) {
        stopError = 'stop_unconfirmed';
        cleanupPending = true;
      }
    } catch (error) {
      cleanupPending = true;
      stopError = `stop_failed:${String(error && error.message || error)}`;
      log('WARN', 'ninfer.server.stop_failed', { message: String(error && error.message || error) });
    }
    if (retainIdentity && !stopError && current.apiKey && plan) {
      retainedIdentity = { apiKey: current.apiKey, plan, spec: lastSpec };
    }
    if (stoppedBy === 'watchdog' && !stopError) {
      // Surfaced like a crash (Restart / next message recovers), named so
      // the pill can say the watchdog did it.
      setState('crashed', {
        contextSize: 0, mtp: false, identityReused: false, identityRetained: false,
        lastError: 'ninfer_watchdog_tripped', stoppedBy: 'watchdog',
        watchdogWatts: Math.round(Number(trip?.watts) || 0), watchdogTempC: Math.round(Number(trip?.tempC) || 0),
      });
      return getStatus();
    }
    setState('stopped', {
      contextSize: 0, mtp: false, identityReused: false,
      identityRetained: Boolean(retainedIdentity), lastError: stopError, stoppedBy: '',
    });
    return getStatus();
  }

  // The watchdog's trip lands on the chain like any stop; a trip for a server
  // already replaced is ignored by the generation check inside stopCurrent.
  function tripWatchdog(trip) {
    const tripPid = status.pid;
    // A ready launch may still hold the chain while the sidecar takes its key
    // (the re-broker wait); the trip must not queue behind that, so it ends
    // the wait first, exactly as stop() and restart() do.
    if (state === 'ready' && handle && handle.pid === tripPid) abortStartup();
    return serialize(async () => {
      if (state !== 'ready' || !handle || (tripPid && handle.pid !== tripPid)) return getStatus();
      log('WARN', 'ninfer.server.watchdog_stop', { pid: handle.pid, watts: trip.watts, tempC: trip.tempC });
      return stopCurrent({ stoppedBy: 'watchdog', trip });
    });
  }

  function launchRefusal() {
    try {
      return String(launchGate() || '');
    } catch (_error) {
      return '';
    }
  }

  // True while an earlier stop could not be confirmed and the recorded
  // ninfer-serve pid is still alive: the GPU may still be held, so the
  // llama-server launch gate and the unload path treat it as running.
  function cleanupUnconfirmed() {
    return !reconcileCleanup();
  }

  function refusedStatus(refusal) {
    log('WARN', 'ninfer.server.launch_refused', { reason: refusal, state });
    if (state !== 'ready') status.lastError = refusal;
    return getStatus();
  }

  function resumeRetainedIdentity() {
    const identity = retainedIdentity;
    retainedIdentity = null;
    status.identityRetained = false;
    if (state === 'ready') return Promise.resolve(getStatus());
    if (!identity) {
      log('WARN', 'ninfer.server.identity_restore_skipped', { state });
      status.lastError = 'ninfer_identity_missing';
      return Promise.resolve(getStatus());
    }
    lastSpec = identity.spec;
    return launch(identity.plan, { retainedApiKey: identity.apiKey });
  }

  // Start / recover / switch in one call (ready and matching is a no-op).
  function ensureRunning(rawSpec, { reuseIdentity = false } = {}) {
    const spec = normalizeNinferSpec(rawSpec);
    return serialize(async () => {
      if (reuseIdentity) return resumeRetainedIdentity();
      if (!needsRelaunch(spec)) return getStatus();
      const refusal = launchRefusal();
      if (refusal) return refusedStatus(refusal);
      if (state === 'ready') await stopCurrent();
      // A plain start keeps the artifact; tunables come from saved settings (a deferred Tune save applies).
      return launchFromSpec(spec || (state === 'crashed' ? lastSpec : { artifactId: lastSpec?.artifactId }));
    });
  }

  function restart(rawSpec) {
    const spec = normalizeNinferSpec(rawSpec);
    const early = launchRefusal();
    if (early) return Promise.resolve(refusedStatus(early));
    abortStartup();
    return serialize(async () => {
      const refusal = launchRefusal();
      if (refusal) return refusedStatus(refusal);
      await stopCurrent();
      return launchFromSpec(spec || { artifactId: lastSpec?.artifactId });
    });
  }

  // Boot path: autostarts only when NInfer was the last-used managed server,
  // startup model loading is on and the backend boots openai-compatible.
  // Returns the status; the caller skips the llama-server autostart when a
  // launch happened here (`autostarted` on the result).
  function startFromSettings({ engineType } = {}) {
    return serialize(async () => {
      if (state === 'ready') return { ...getStatus(), autostarted: false };
      const settings = ninferSettings();
      const localEngines = getShellConfigService()?.getLocalEngines?.() || null;
      if (!settings?.lastUsedArtifactId || localEngines?.startupModelLoad === false) {
        // Named in the log like llama-server's, so "NInfer did not start at boot" has a line.
        if (settings?.lastUsedArtifactId) log('INFO', 'ninfer.server.autostart_disabled', { reason: 'startup_model_load_off' });
        return { ...getStatus(), autostarted: false };
      }
      const activeEngine = String(engineType || getShellConfigService()?.getState?.()?.preferredEngineType || '');
      if (activeEngine && activeEngine !== 'openai-compatible') {
        log('INFO', 'ninfer.server.autostart_skipped', { reason: 'engine_not_active' });
        return { ...getStatus(), autostarted: false };
      }
      const refusal = launchRefusal();
      if (refusal) return { ...refusedStatus(refusal), autostarted: false };
      lastSpec = null;
      const launched = await launchFromSpec({ artifactId: settings.lastUsedArtifactId });
      return { ...launched, autostarted: true };
    });
  }

  function stop({ retainIdentity = false } = {}) {
    abortStartup();
    return serialize(() => stopCurrent({ retainIdentity }));
  }

  function settled() {
    return chain.then(() => getStatus());
  }

  // Emergency path: synchronous, best effort; a launch completing afterwards
  // kills its own child (generation bump).
  function stopSync() {
    halted = true;
    try { abortStartup(); } catch (_error) { /* best effort only */ }
    const current = handle;
    handle = null;
    currentPlan = null;
    retainedIdentity = null;
    generation += 1;
    try {
      if (current && typeof current.stopSync === 'function') current.stopSync();
    } catch (_error) { /* best effort only */ }
    if (state !== 'stopped') {
      setState('stopped', { contextSize: 0, mtp: false, identityRetained: false, identityReused: false, stoppedBy: '' });
    }
  }

  return {
    cleanupUnconfirmed,
    ensureRunning,
    getApiKey,
    getBaseUrl,
    getStatus,
    restart,
    settled,
    start: ensureRunning,
    startFromSettings,
    stop,
    stopSync,
    // Tests drive the sampler loop by hand.
    watchdog,
  };
}

module.exports = {
  createNinferManager,
  normalizeNinferSpec,
};
