'use strict';

// Owns the managed Strata server (row 200 S2 step 4) for the lifetime of the
// app: the sibling of services/main/ninfer-manager.js. The lifecycle module
// (services/strata-lifecycle.js) spawns ONE server and hands back a handle;
// this manager adds the explicit state machine, one serial operation chain,
// the launch plan (the runtime's discovery, pack check and engine config),
// identity retention for the chat GPU handoff and the opt-in GPU watchdog.
//
//   stopped -> starting -> ready -> stopping -> stopped
//                   \-> stopped (start failed)      ready -> crashed (child exit,
//                                                            watchdog trip)
//
// One managed server owns the GPU, ranked llama-server < NInfer < Strata (plan
// S2 step 6). A launch here first stops every lower-ranked manager (confirmed)
// and refuses when one stop is unconfirmed. The reverse direction is each
// lower manager's synchronous launch gate (runtime-shutdown.js composes it)
// plus the load path's explicit stop, so no chain ever awaits a higher-ranked
// one from inside its own chain (no deadlock).
//
// Crash policy mirrors NInfer: a child that exits while `ready` is recorded as
// `crashed` and surfaced, never respawned here; ensureRunning() is the
// recovery gate.

const strataLifecycle = require('../strata-lifecycle');
const { reconcileRetainedPid } = require('../llama-server-pidfile');
const { createNinferGpuWatchdog } = require('../ninfer-gpu-watchdog');
const {
  MAX_CONTEXT, MIN_CONTEXT, STRATA_DRAFTING, STRATA_KV_FORMATS, STRATA_SLOTS, normalizeStrataSettings,
} = require('../strata-settings');

const STATES = Object.freeze(['stopped', 'starting', 'ready', 'stopping', 'crashed']);

// Only the keys a caller may steer; everything else is dropped so an IPC
// payload can never smuggle launch arguments in.
function normalizeStrataSpec(spec) {
  const source = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
  if (!source) return null;
  const normalized = {};
  if (STRATA_SLOTS.includes(source.slots)) normalized.slots = source.slots;
  if (STRATA_KV_FORMATS.includes(source.kv)) normalized.kv = source.kv;
  if (STRATA_DRAFTING.includes(source.drafting)) normalized.drafting = source.drafting;
  if (typeof source.vision === 'boolean') normalized.vision = source.vision;
  if (Number.isInteger(source.context) && source.context >= MIN_CONTEXT && source.context <= MAX_CONTEXT) {
    normalized.context = source.context;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function createStrataManager({
  // String, or a thunk (main passes () => app.getPath('userData')).
  userDataPath = '',
  getShellConfigService = () => null,
  // { enabled, plan({ settings, userDataPath, onPhase }) } from
  // strata-runtime-wiring.js; null refuses every launch.
  getRuntime = () => null,
  // Lower-ranked managed servers, stopped (confirmed) before a Strata launch,
  // in order: [['ninfer', manager], ['llama-server', manager]].
  getLowerManagers = () => [],
  // Called with getStatus() after every transition; may return a promise the
  // launch waits for (the sidecar re-broker). Exceptions are swallowed.
  onStateChange = () => {},
  // Refusal reason ('' admits) read before every launch that is not an
  // identity restore (the chat GPU handoff's lease / closing latch).
  launchGate = () => '',
  // The engine's own window at a pairing without a measured fit, saved for the
  // next launch's cap (plan D5 revisit).
  onWindowLearned = () => {},
  onEngineActivity = null,
  lifecycle = strataLifecycle,
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
    // The id the sidecar addresses the model by; displayName is the human label.
    alias: '',
    displayName: '',
    // 'verifying' (pack check), 'loading' (server starting) or '' (idle/ready).
    phase: '',
    slots: 0,
    kv: '',
    contextSize: 0,
    contextFit: 0,
    fitSource: '',
    vision: false,
    drafting: 'off',
    runtimeLabel: '',
    identityRetained: false,
    identityReused: false,
    lastError: '',
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

  function rawSettings() {
    try {
      return getShellConfigService()?.getLocalEngines?.()?.strata || null;
    } catch (_error) {
      return null;
    }
  }

  const watchdog = createWatchdog({
    getSettings: () => rawSettings()?.watchdog || null,
    onTrip: (trip) => { void tripWatchdog(trip); },
    log,
  });

  function setState(next, patch = {}) {
    if (!STATES.includes(next)) {
      throw new Error(`strata_manager_invalid_state:${next}`);
    }
    state = next;
    const down = ['stopped', 'crashed'].includes(next);
    if (down) watchdog.stop();
    Object.assign(status, patch, {
      ...(down ? { pid: 0, runtimeLabel: '', vision: false, phase: '' } : {}),
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

  // `http://127.0.0.1:8035/v1` while a server is tracked, '' otherwise.
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
        pidFileName: lifecycle.STRATA_PID_FILENAME,
        logger: (level, event, details) => log(level, String(event).replace(/^llama\.server\./, 'strata.server.'), details),
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

  // Saved settings overlaid by the explicit spec, then normalized.
  function effectiveSettings(spec) {
    return normalizeStrataSettings({ ...(rawSettings() || {}), ...(spec || {}) });
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
      contextSize: 0, identityReused: false, stoppedBy: '',
      lastError: `strata_exited:${code != null ? code : signal || 'unknown'}`,
    });
    log('WARN', 'strata.server.crashed_pending_recovery', { port: status.port, alias: status.alias, code, signal });
  }

  // Stops every lower-ranked managed server before Strata takes the GPU.
  // Returns a refusal reason when one stop could not be confirmed.
  async function stopLowerFirst() {
    let pairs;
    try { pairs = getLowerManagers() || []; } catch (_error) { pairs = []; }
    for (const [kind, other] of pairs) {
      if (!other || typeof other.stop !== 'function') continue;
      const before = other.getStatus?.() || {};
      const stopped = await other.stop();
      const failure = String(stopped?.lastError || '');
      const refusal = `${kind.replace(/-/gu, '_')}_stop_unconfirmed`; // llama_server_stop_unconfirmed, like the GPU hand-off's
      if (failure === 'stop_unconfirmed' || failure.startsWith('stop_failed')) return refusal;
      if (typeof other.cleanupUnconfirmed === 'function' && other.cleanupUnconfirmed()) return refusal;
      if (['ready', 'starting', 'stopping'].includes(String(before.state || ''))) {
        log('INFO', 'strata.server.lower_stopped_first', { kind });
      }
    }
    return '';
  }

  function failLaunch(abortController, reason, patch = {}) {
    if (startupAbortController === abortController) startupAbortController = null;
    handle = null;
    currentPlan = null;
    setState('stopped', { contextSize: 0, identityReused: false, lastError: reason, ...patch });
    log('WARN', 'strata.server.start_failed', { reason });
    emitStartupAuditMark('strata-failed', { source: 'main', reason });
    return getStatus();
  }

  async function resolvePlan(settings, abortController, startGeneration) {
    const runtime = getRuntime();
    if (!runtime || runtime.enabled !== true || typeof runtime.plan !== 'function') return { error: 'strata_runtime_unavailable' };
    try {
      const plan = await runtime.plan({
        settings, userDataPath: resolveUserDataPath(), abortSignal: abortController.signal,
        onPhase: (phase) => { if (startGeneration === generation && state === 'starting') setState('starting', { phase }); },
      });
      return plan && typeof plan === 'object' ? plan : { error: 'strata_plan_failed' };
    } catch (error) {
      return { error: String(error?.reason || 'strata_plan_failed') };
    }
  }

  async function startServer(plan, launchExtras, abortController, startGeneration) {
    const nextHandle = await lifecycle.startStrataServer({
      install: plan.install,
      config: plan.config,
      userDataPath: resolveUserDataPath(),
      slots: plan.slots,
      logger: log,
      onEngineActivity,
      ...launchExtras,
      abortSignal: abortController.signal,
      onExit: (info) => onChildExit(startGeneration, info),
    });
    if (startGeneration !== generation) {
      // stopSync() ran while the child was coming up (emergency shutdown).
      try { nextHandle.stopSync?.(); } catch (_error) { /* best effort only */ }
      return null;
    }
    const early = nextHandle.pid ? earlyExits.get(nextHandle.pid) : null;
    earlyExits = new Map();
    if (early) {
      const reason = `strata_exited:${early.code != null ? early.code : early.signal || 'unknown'}`;
      throw Object.assign(new Error(reason), { reason });
    }
    return nextHandle;
  }

  function noteLearnedWindow(plan, nextHandle) {
    if (plan.fitSource === 'measured' || !Number.isInteger(nextHandle.contextSize) || nextHandle.contextSize < MIN_CONTEXT) return;
    try { onWindowLearned(`${plan.slots}:${plan.kv}`, nextHandle.contextSize); } catch (_error) { /* best effort */ }
  }

  async function promoteReady(plan, nextHandle, reuseIdentity, abortController) {
    handle = nextHandle;
    currentPlan = plan;
    noteLearnedWindow(plan, nextHandle);
    log('INFO', 'strata.server.started', { baseUrl: nextHandle.baseUrl, pid: nextHandle.pid, slots: plan.slots });
    const observed = setState('ready', {
      pid: nextHandle.pid || 0,
      port: nextHandle.port || lifecycle.DEFAULT_STRATA_PORT,
      alias: nextHandle.modelId || plan.modelId,
      phase: '',
      contextSize: nextHandle.contextSize || plan.maxContext,
      vision: Boolean(nextHandle.vision),
      identityRetained: false,
      identityReused: reuseIdentity,
      lastError: '',
    });
    watchdog.start();
    emitStartupAuditMark('strata-ready', { source: 'main', pid: nextHandle.pid || 0 });
    // Callers resume only once the sidecar holds this launch's key; a
    // stop()/restart() must not queue behind a stalled re-broker.
    await new Promise((resolve) => {
      Promise.resolve(observed).then(resolve, resolve);
      abortController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    if (startupAbortController === abortController) startupAbortController = null;
  }

  function startingPatch(plan, settings) {
    const source = plan || {};
    return {
      port: lifecycle.DEFAULT_STRATA_PORT,
      alias: source.modelId || status.alias,
      displayName: source.displayName || status.displayName || 'Inkling 2 Mini',
      phase: plan ? 'loading' : 'verifying',
      slots: source.slots || settings.slots,
      kv: source.kv || settings.kv,
      contextSize: source.maxContext || 0,
      contextFit: source.fit || 0,
      fitSource: source.fitSource || '',
      vision: Boolean(source.vision ?? settings.vision),
      drafting: source.drafting || settings.drafting,
      runtimeLabel: source.version || '',
      lastError: '', stoppedBy: '', watchdogWatts: 0, watchdogTempC: 0,
    };
  }

  // One launch. A retained identity carries its plan and key, so it skips the
  // plan step (no re-verification on the image-generation round trip).
  async function launch({ settings, plan: retainedPlan = null, launchExtras = {} }) {
    if (halted) return refusedStatus('strata_halted');
    if (!reconcileCleanup()) {
      setState('stopped', { lastError: 'stop_unconfirmed' });
      log('WARN', 'strata.server.launch_refused', { reason: 'stop_unconfirmed' });
      return getStatus();
    }
    const reuseIdentity = Boolean(launchExtras.retainedApiKey);
    if (!reuseIdentity) retainedIdentity = null;
    emitStartupAuditMark('strata-start', { source: 'main' });
    // The GPU is reserved (`starting`) before the lower managers' stops are
    // awaited: their launch gates read this state, so a Use queued behind a
    // stop is refused instead of racing this launch.
    const startGeneration = ++generation;
    earlyExits = new Map();
    const abortController = new AbortController();
    startupAbortController = abortController;
    setState('starting', startingPatch(retainedPlan, settings));
    const exclusivity = await stopLowerFirst();
    if (startGeneration !== generation) {
      if (startupAbortController === abortController) startupAbortController = null;
      return getStatus();
    }
    if (exclusivity) return failLaunch(abortController, exclusivity);
    const plan = retainedPlan || await resolvePlan(settings, abortController, startGeneration);
    if (startGeneration !== generation) {
      if (startupAbortController === abortController) startupAbortController = null;
      return getStatus();
    }
    if (plan.error) return failLaunch(abortController, plan.error);
    setState('starting', startingPatch(plan, settings));
    try {
      const nextHandle = await startServer(plan, launchExtras, abortController, startGeneration);
      if (!nextHandle) return getStatus();
      await promoteReady(plan, nextHandle, reuseIdentity, abortController);
    } catch (error) {
      if (error && error.cleanupUnconfirmed === true) cleanupPending = true;
      return failLaunch(abortController, String(error?.reason || error?.message || error));
    }
    return getStatus();
  }

  function launchFromSpec(spec) {
    lastSpec = spec;
    if (halted) return refusedStatus('strata_halted');
    return launch({ settings: effectiveSettings(spec) });
  }

  // Would a ready server have to be replaced to honor `spec`?
  function needsRelaunch(spec) {
    if (state !== 'ready') return true;
    if (!spec) return false;
    const wanted = effectiveSettings(spec);
    const plan = currentPlan || {};
    if (wanted.slots !== plan.slots || wanted.kv !== plan.kv || wanted.drafting !== plan.drafting) return true;
    if (wanted.vision !== plan.vision) return true;
    return Number.isInteger(spec.context) && spec.context !== plan.maxContext;
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
        setState('stopped', { lastError: '', stoppedBy });
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
      stopError = 'stop_failed';
      log('WARN', 'strata.server.stop_failed', { message: String(error && error.message || error) });
    }
    if (retainIdentity && !stopError && current.apiKey && plan) {
      retainedIdentity = { apiKey: current.apiKey, plan, spec: lastSpec };
    }
    if (stoppedBy === 'watchdog' && !stopError) {
      setState('crashed', {
        contextSize: 0, identityReused: false, identityRetained: false,
        lastError: 'strata_watchdog_tripped', stoppedBy: 'watchdog',
        watchdogWatts: Math.round(Number(trip?.watts) || 0), watchdogTempC: Math.round(Number(trip?.tempC) || 0),
      });
      return getStatus();
    }
    setState('stopped', {
      contextSize: 0, identityReused: false,
      identityRetained: Boolean(retainedIdentity), lastError: stopError, stoppedBy: stopError ? '' : stoppedBy,
    });
    return getStatus();
  }

  function tripWatchdog(trip) {
    const tripPid = status.pid;
    if (state === 'ready' && handle && handle.pid === tripPid) abortStartup();
    return serialize(async () => {
      if (state !== 'ready' || !handle || (tripPid && handle.pid !== tripPid)) return getStatus();
      log('WARN', 'strata.server.watchdog_stop', { pid: handle.pid, watts: trip.watts, tempC: trip.tempC });
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

  // True while an earlier stop could not be confirmed and the recorded server
  // pid is still alive: the lower managers' launch gates treat it as running.
  function cleanupUnconfirmed() {
    return !reconcileCleanup();
  }

  function refusedStatus(refusal) {
    log('WARN', 'strata.server.launch_refused', { reason: refusal, state });
    if (state !== 'ready') status.lastError = refusal;
    return getStatus();
  }

  function resumeRetainedIdentity() {
    const identity = retainedIdentity;
    retainedIdentity = null;
    status.identityRetained = false;
    if (state === 'ready') return Promise.resolve(getStatus());
    if (!identity) {
      log('WARN', 'strata.server.identity_restore_skipped', { state });
      status.lastError = 'strata_identity_missing';
      return Promise.resolve(getStatus());
    }
    lastSpec = identity.spec;
    return launch({ settings: effectiveSettings(identity.spec), plan: identity.plan, launchExtras: { retainedApiKey: identity.apiKey } });
  }

  // Start / recover / switch in one call (ready and matching is a no-op).
  function ensureRunning(rawSpec, { reuseIdentity = false } = {}) {
    const spec = normalizeStrataSpec(rawSpec);
    return serialize(async () => {
      if (reuseIdentity) return resumeRetainedIdentity();
      if (!needsRelaunch(spec)) return getStatus();
      const refusal = launchRefusal();
      if (refusal) return refusedStatus(refusal);
      if (state === 'ready') await stopCurrent();
      return launchFromSpec(spec || (state === 'crashed' ? lastSpec : null));
    });
  }

  function restart(rawSpec) {
    const spec = normalizeStrataSpec(rawSpec);
    const early = launchRefusal();
    if (early) return Promise.resolve(refusedStatus(early));
    abortStartup();
    return serialize(async () => {
      const refusal = launchRefusal();
      if (refusal) return refusedStatus(refusal);
      await stopCurrent();
      return launchFromSpec(spec || lastSpec);
    });
  }

  // Boot path: autostarts only when Strata was the last-used managed server,
  // startup model loading is on and the backend boots openai-compatible.
  function startFromSettings({ engineType } = {}) {
    return serialize(async () => {
      if (state === 'ready') return { ...getStatus(), autostarted: false };
      const settings = rawSettings();
      const localEngines = getShellConfigService()?.getLocalEngines?.() || null;
      if (settings?.lastUsed !== true || localEngines?.startupModelLoad === false) {
        if (settings?.lastUsed === true) log('INFO', 'strata.server.autostart_disabled', { reason: 'startup_model_load_off' });
        return { ...getStatus(), autostarted: false };
      }
      const activeEngine = String(engineType || getShellConfigService()?.getState?.()?.preferredEngineType || '');
      if (activeEngine && activeEngine !== 'openai-compatible') {
        log('INFO', 'strata.server.autostart_skipped', { reason: 'engine_not_active' });
        return { ...getStatus(), autostarted: false };
      }
      const refusal = launchRefusal();
      if (refusal) return { ...refusedStatus(refusal), autostarted: false };
      const launched = await launchFromSpec(null);
      return { ...launched, autostarted: true };
    });
  }

  // stoppedBy 'engine_switch': a model load stops Strata and initializes the
  // sidecar for the new engine itself, so the stop must not re-broker it.
  function stop({ retainIdentity = false, stoppedBy = '' } = {}) {
    abortStartup();
    return serialize(() => stopCurrent({ retainIdentity, stoppedBy }));
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
      setState('stopped', { contextSize: 0, identityRetained: false, identityReused: false, stoppedBy: '' });
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
  createStrataManager,
  normalizeStrataSpec,
};
