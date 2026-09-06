'use strict';

// Owns the managed llama-server process for the lifetime of the app.
//
// The lifecycle module (services/llama-server-lifecycle.js) knows how to spawn
// ONE server and hand back a handle; this manager adds the state that used to
// live as loose closure variables in runtime-shutdown.js — the current handle,
// the startup abort controller — and turns it into an explicit state machine:
//
//   stopped -> starting -> ready -> stopping -> stopped
//                   \-> stopped (start failed)      ready -> crashed (child exit)
//
// Every public async operation runs on one serial chain, so a start that
// arrives during a stop waits for the stop (and vice versa) instead of racing
// it; stopSync() is the only unserialized entry and is guarded by a launch
// generation counter.
//
// Crash policy (owner decision 2026-09-01, mirrors ollama-process-manager.js):
// a child that exits while `ready` is recorded as `crashed` and surfaced; it
// is NOT respawned here. `ensureRunning()` — called by the chat preflight, by
// an explicit model load, and by the health-pill Restart row — is the recovery
// gate, so a permanently failing binary cannot restart-loop.

const path = require('path');

const {
  DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
  DEFAULT_MANAGED_SHELL_MODEL,
  loadLlamaServerProfile,
  resolveLlamaServerSettings,
} = require('../backend/backend-config');
const { isManagedModelPath, managedModelKey } = require('../shell-config-engines');
const { buildFeatureFlags } = require('../feature-flags');
const llamaServerLifecycle = require('../llama-server-lifecycle');
const { stripLatestTag } = require('../llama-server-readiness');
const {
  resolveLaunchAcceleration,
  shouldRetryWithoutAcceleration,
} = require('./llama-server-acceleration-launch');

const STATES = Object.freeze(['stopped', 'starting', 'ready', 'stopping', 'crashed']);
const MTP_MODES = Object.freeze(['off', 'mtp', 'ngram']);

// Only the five keys a caller may steer; everything else is dropped so an IPC
// payload can never smuggle launch arguments in. Mirrors the persisted-config
// normalizer in shell-config-engines.js (absolute .gguf or Ollama blob path, bounded draft).
function normalizeSpec(spec) {
  const source = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
  if (!source) {
    return null;
  }
  const normalized = {};
  const modelTag = String(source.modelTag || '').trim();
  const modelPath = String(source.modelPath || '').trim();
  const profileId = String(source.profileId || '').trim().toLowerCase();
  if (modelTag && !/[\r\n\0]/.test(modelTag)) normalized.modelTag = modelTag;
  if (isManagedModelPath(modelPath)) {
    normalized.modelPath = modelPath;
  }
  if (profileId && /^[a-z0-9][a-z0-9._-]{0,79}$/.test(profileId)) normalized.profileId = profileId;
  if (Number.isInteger(source.contextSize)
      && source.contextSize >= 1024 && source.contextSize <= 1_048_576) {
    normalized.contextSize = source.contextSize;
  }
  const mtp = source.mtp && typeof source.mtp === 'object' ? source.mtp : null;
  const mtpMode = mtp ? String(mtp.mode || '').trim().toLowerCase() : '';
  if (mtp && MTP_MODES.includes(mtpMode)) {
    const draftNMax = Number(mtp.draftNMax);
    normalized.mtp = {
      mode: mtpMode,
      ...(Number.isInteger(draftNMax) && draftNMax >= 1 && draftNMax <= 6 ? { draftNMax } : {}),
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function sameMtp(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.mode === right.mode && (left.draftNMax || null) === (right.draftNMax || null);
}

function createLlamaServerManager({
  processRef = process,
  rootDir = process.cwd(),
  // String, or a thunk (main.js passes () => app.getPath('userData') so the
  // controller can be constructed before the app is ready).
  userDataPath = '',
  getShellConfigService = () => null,
  emitStartupAuditMark = () => {},
  // Called with getStatus() after every state transition; the backend uses it
  // to re-broker the (per-launch) api key to the sidecar when a server comes
  // up. Exceptions are swallowed.
  onStateChange = () => {},
  log = () => {},
  lifecycle = llamaServerLifecycle,
  resolveLaunchAccelerationImpl = resolveLaunchAcceleration,
  resolveSettingsImpl = resolveLlamaServerSettings,
  loadProfileImpl = loadLlamaServerProfile,
  buildFeatureFlagsImpl = buildFeatureFlags,
  now = Date.now,
} = {}) {
  let state = 'stopped';
  let handle = null;
  let startupAbortController = null;
  let generation = 0;
  // The normalized spec the current (or last) launch was steered by; restart()
  // and a crash recovery without a spec relaunch exactly this.
  let lastSpec = null;
  let chain = Promise.resolve();
  const status = {
    pid: 0,
    port: 0,
    alias: '',
    modelPath: '',
    profileId: '',
    accelerationMode: 'off',
    accelerationReason: '',
    accelerationDrafter: '',
    contextSize: 0,
    mmproj: '',
    reused: false,
    lastError: '',
    changedAt: 0,
  };

  function getStatus() {
    return { state, ...status };
  }

  function setState(next, patch = {}) {
    if (!STATES.includes(next)) {
      throw new Error(`llama_server_manager_invalid_state:${next}`);
    }
    state = next;
    Object.assign(status, patch, {
      ...(['stopped', 'crashed'].includes(next) ? { mmproj: '' } : {}),
      changedAt: now(),
    });
    // The observer's return value (a promise for the 'ready' re-brokering of
    // the api key) is handed back so a launch can wait for it.
    try {
      return onStateChange(getStatus());
    } catch (_error) { /* observers never break the state machine */ }
    return undefined;
  }

  function getApiKey() {
    return String(handle?.apiKey || '');
  }

  // Base URL of the server we are tracking (`http://host:port/v1`), '' when
  // none. Consumers use it to decide whether an endpoint IS the managed
  // server before handing it the api key.
  function getBaseUrl() {
    return String(handle?.baseUrl || '');
  }

  function resolveUserDataPath() {
    return String((typeof userDataPath === 'function' ? userDataPath() : userDataPath) || '');
  }

  // Serializes the async operations: each waits for the previous to settle.
  function serialize(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  function abortStartup() {
    if (startupAbortController) {
      startupAbortController.abort();
      startupAbortController = null;
    }
  }

  // The projector a launch of this model would carry: one directory listing,
  // shared by the launch plan and the ready-server relaunch check.
  function resolveSpecProjector(modelTag, modelPath) {
    return modelPath
      ? lifecycle.resolveProjectorPath?.({ modelPath }) || ''
      : lifecycle.resolveGgufPath?.({ modelTag, userDataPath: resolveUserDataPath(), repoRoot: rootDir })?.projectorPath || '';
  }

  // Builds everything the launch needs from (explicit spec) > (env) > (persisted
  // managed config) > (profile) > defaults. With no spec and no managed config
  // this is byte-for-byte the pre-manager boot path.
  function resolveLaunchPlan(spec) {
    const shellConfigService = getShellConfigService();
    const localEngines = shellConfigService?.getLocalEngines?.() || null;
    let shellConfigState = null;
    try {
      shellConfigState = shellConfigService?.getState?.() || null;
    } catch (_error) { /* fall through to profile defaults */ }
    const managed = localEngines?.openaiCompatible?.managed || null;
    const settings = resolveSettingsImpl({ env: processRef.env, repoRoot: rootDir, managed });
    let profile = settings.profile;
    let profileError = settings.profileError;
    let profileId = settings.profileId;
    if (spec?.profileId && spec.profileId !== settings.profileId) {
      const loaded = loadProfileImpl({ profileId: spec.profileId, repoRoot: rootDir });
      profile = loaded.profile;
      profileError = loaded.error;
      profileId = spec.profileId;
    }
    if (profileError) {
      return { settings, profileError, profileId };
    }
    const modelTag = spec?.modelTag
      || settings.modelTagOverride
      || (profile ? profile.modelTag : DEFAULT_MANAGED_SHELL_MODEL);
    const modelPath = spec?.modelPath || settings.modelPathOverride || '';
    const resolvedUserDataPath = resolveUserDataPath();
    const projectorPath = resolveSpecProjector(modelTag, modelPath);
    const featureFlags = buildFeatureFlagsImpl(
      processRef.env,
      shellConfigState?.featureOverrides || {}
    );
    const shellAcceleration = spec?.mtp
      ? { mode: spec.mtp.mode, draftNMax: spec.mtp.draftNMax }
      : (localEngines?.openaiCompatible?.acceleration || null);
    // A spec that steers the model, context, or MTP needs a profile view that reflects
    // it; otherwise the resolver sees the exact profile object it always did.
    const overridesProfile = Boolean(spec?.modelTag || spec?.mtp || spec?.contextSize);
    const effectiveProfile = overridesProfile
      ? {
        ...(profile || { extraArgs: [], contextSize: DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH }),
        modelTag,
        ...(spec?.contextSize ? { contextSize: spec.contextSize } : {}),
        acceleration: spec?.mtp ? null : (profile?.acceleration ?? null),
      }
      : profile;
    const contextLengthByModel = shellConfigState?.compactionTuning?.contextLengthByModel;
    // The sidecar keys off the stripped alias, so :latest launches must agree with it.
    const configuredContextSize = contextLengthByModel && typeof contextLengthByModel === 'object'
      ? (Object.prototype.hasOwnProperty.call(contextLengthByModel, modelTag)
        ? contextLengthByModel[modelTag]
        : contextLengthByModel[stripLatestTag(modelTag)])
      : null;
    const contextSize = spec?.contextSize
      || (Number.isInteger(configuredContextSize)
        && configuredContextSize >= 1024 && configuredContextSize <= 1_048_576
        ? configuredContextSize
        : null)
      || (effectiveProfile ? effectiveProfile.contextSize : DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH);
    const accel = resolveLaunchAccelerationImpl({
      settings: modelPath === settings.modelPathOverride
        ? settings
        : { ...settings, modelPathOverride: modelPath },
      profile: effectiveProfile,
      featureFlags,
      shellAcceleration,
      repoRoot: rootDir,
      resourcesPath: processRef.resourcesPath,
      userDataPath: resolvedUserDataPath,
      log,
    });
    return {
      settings,
      profile: effectiveProfile,
      profileId,
      profileError: '',
      modelTag,
      modelPath,
      accel,
      launchOptions: {
        modelTag,
        binaryPath: settings.binaryOverride,
        modelPath,
        projectorPath,
        userDataPath: resolvedUserDataPath,
        repoRoot: rootDir,
        resourcesPath: processRef.resourcesPath,
        host: settings.host,
        port: settings.port,
        contextSize,
        readinessTimeoutMs: settings.readinessTimeoutMs,
        logger: log,
      },
    };
  }

  // An exit reported while a launch of the same generation is still
  // 'starting': the child died between answering its readiness probe and the
  // launch recording it. launch() consults this before promoting the handle.
  let earlyExit = null;

  function onChildExit(startGeneration, info) {
    // Only the handle we are currently tracking may move the state; a stale
    // exit from a server we already replaced is noise.
    if (startGeneration !== generation) {
      return;
    }
    if (state === 'starting') {
      earlyExit = { generation: startGeneration, info: info || {} };
      return;
    }
    if (state !== 'ready') {
      return;
    }
    // A failed accelerated attempt and its unaccelerated retry share this
    // hook; the first child's late exit must not crash the replacement.
    if (handle && handle.pid && info && info.pid && info.pid !== handle.pid) {
      return;
    }
    const code = info && info.code != null ? info.code : null;
    const signal = info && info.signal ? String(info.signal) : '';
    handle = null;
    setState('crashed', {
      pid: 0,
      accelerationMode: 'off',
      accelerationReason: '',
      accelerationDrafter: '',
      contextSize: 0,
      lastError: `llama_server_exited:${code != null ? code : signal || 'unknown'}`,
    });
    log('WARN', 'llama.server.crashed_pending_recovery', {
      port: status.port,
      alias: status.alias,
      code,
      signal,
      message: 'llama-server exited unexpectedly; it will be restarted on the next chat.',
    });
  }

  async function launch(plan) {
    const { accel, profile, launchOptions } = plan;
    if (accel.reason !== 'flag_off') {
      log('INFO', 'llama.server.acceleration_resolved', {
        mode: accel.mode,
        reason: accel.reason,
        drafter: accel.drafter,
        vramHeadroomMb: accel.vramHeadroomMb,
        extraArgs: accel.extraArgs,
      });
    }
    emitStartupAuditMark('llama-server-start', { source: 'main' });
    const startGeneration = ++generation;
    earlyExit = null;
    let abortController = new AbortController();
    startupAbortController = abortController;
    let accelerationMode = accel.extraArgs.length > 0 ? accel.mode : 'off';
    let accelerationReason = String(accel.reason || '');
    const profileExtraArgs = profile ? profile.extraArgs : [];
    const onExit = (info) => onChildExit(startGeneration, info);
    setState('starting', {
      port: launchOptions.port,
      alias: stripLatestTag(launchOptions.modelTag),
      modelPath: launchOptions.modelPath,
      profileId: plan.profileId,
      lastError: '',
    });
    let nextHandle;
    try {
      try {
        nextHandle = await lifecycle.startLlamaServer({
          ...launchOptions,
          extraArgs: [...profileExtraArgs, ...accel.extraArgs],
          abortSignal: abortController.signal,
          onExit,
        });
      } catch (error) {
        if (!shouldRetryWithoutAcceleration({
          error, accelExtraArgs: accel.extraArgs, aborted: abortController.signal.aborted,
        })) {
          throw error;
        }
        log('WARN', 'llama.server.acceleration_fallback', {
          mode: accel.mode,
          reason: 'spawn_failed',
          message: String(error && error.message || error),
        });
        abortController = new AbortController();
        startupAbortController = abortController;
        accelerationMode = 'off';
        accelerationReason = 'spawn_failed';
        nextHandle = await lifecycle.startLlamaServer({
          ...launchOptions,
          extraArgs: profileExtraArgs,
          abortSignal: abortController.signal,
          onExit,
        });
      }
      if (startGeneration !== generation) {
        // stopSync() ran while the child was coming up (emergency shutdown);
        // the child must not outlive the decision that already retired it.
        try {
          nextHandle.stopSync?.();
        } catch (_error) { /* best effort only */ }
        return getStatus();
      }
      if (earlyExit && earlyExit.generation === startGeneration
        && nextHandle.pid && earlyExit.info.pid === nextHandle.pid) {
        const early = earlyExit.info;
        earlyExit = null;
        throw new Error(`llama_server_exited:${early.code != null ? early.code : early.signal || 'unknown'}`);
      }
      handle = nextHandle;
      if (nextHandle.reused) {
        log('INFO', 'llama.server.start_skipped_reused', { baseUrl: nextHandle.baseUrl });
      } else {
        log('INFO', 'llama.server.started', { baseUrl: nextHandle.baseUrl, pid: nextHandle.pid });
      }
      // A reused server is a pre-existing process whose launch args are
      // unknown — never claim an acceleration verdict this start did not apply
      // (benchmarks and the Model library trust these fields).
      const reportedMode = nextHandle.reused ? 'unknown' : accelerationMode;
      const reportedReason = nextHandle.reused ? 'unknown' : accelerationReason;
      const reportedDrafter = nextHandle.reused ? '' : String(accel.drafter || '');
      const reportedContextSize = nextHandle.reused ? 0 : launchOptions.contextSize;
      const observed = setState('ready', {
        pid: nextHandle.pid || 0,
        reused: Boolean(nextHandle.reused),
        accelerationMode: reportedMode,
        accelerationReason: reportedReason,
        accelerationDrafter: reportedDrafter,
        contextSize: reportedContextSize,
        mmproj: nextHandle.reused ? 'unknown' : String(nextHandle.mmproj || ''),
        lastError: '',
      });
      emitStartupAuditMark('llama-server-ready', {
        source: 'main',
        reused: Boolean(nextHandle.reused),
        pid: nextHandle.pid || 0,
        // Flag-off startups stay byte-identical to the pre-feature payload.
        ...(accel.reason === 'flag_off' ? {} : { accelerationMode: reportedMode }),
      });
      // Callers resume only once the sidecar holds this launch's key;
      // otherwise the next request goes out with the previous one and 401s.
      // A stop()/restart() must not queue behind a stalled re-broker, so the
      // startup signal stays armed until the observer settles.
      await new Promise((resolve) => {
        Promise.resolve(observed).then(resolve, resolve);
        abortController.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      if (startupAbortController === abortController) {
        startupAbortController = null;
      }
    } catch (error) {
      if (startupAbortController === abortController) {
        startupAbortController = null;
      }
      handle = null;
      const message = String(error && error.message || error);
      setState('stopped', {
        pid: 0, reused: false, accelerationMode: 'off', accelerationReason: '',
        accelerationDrafter: '', contextSize: 0, lastError: message,
      });
      log('WARN', 'llama.server.start_failed', { message });
      emitStartupAuditMark('llama-server-failed', { source: 'main', message });
    }
    return getStatus();
  }

  function launchFromPlan(plan) {
    if (plan.profileError) {
      log('WARN', 'llama.server.profile_invalid', {
        profileId: plan.profileId,
        error: plan.profileError,
      });
      setState('stopped', { lastError: `profile_invalid:${plan.profileError}` });
      return Promise.resolve(getStatus());
    }
    return launch(plan);
  }

  function launchFromSpec(spec) {
    lastSpec = spec;
    return launchFromPlan(resolveLaunchPlan(spec));
  }

  // Would a ready server have to be replaced to honor `spec`? A spec that
  // names nothing is satisfied by whatever is running; otherwise every key it
  // names must match what the current launch was steered by.
  function needsRelaunch(spec) {
    if (state !== 'ready') {
      return true;
    }
    // A projector that appeared after a text-only spawn needs a relaunch to be
    // served; cheap enough (one readdir) to ask on every preflight.
    if (status.mmproj === '' && status.reused === false
        && resolveSpecProjector(status.alias, status.modelPath)) {
      return true;
    }
    if (!spec) {
      return false;
    }
    // Size-preserving key: 'ornith:9b' and 'ornith:27b' are different servers.
    if (spec.modelTag && managedModelKey(spec.modelTag) !== managedModelKey(status.alias)) {
      return true;
    }
    if (spec.modelPath && spec.modelPath !== status.modelPath) {
      return true;
    }
    if (spec.profileId && spec.profileId !== status.profileId) {
      return true;
    }
    // Every launch-steering spec key must be compared or it silently never takes
    // effect. A reused server reports contextSize 0 because this process never
    // applied its launch args; relaunching on an unknown value would loop, since
    // stopCurrent() cannot kill a handle it does not own.
    if (spec.contextSize && status.contextSize > 0 && spec.contextSize !== status.contextSize) {
      return true;
    }
    return Boolean(spec.mtp) && !sameMtp(spec.mtp, lastSpec?.mtp || null);
  }

  async function stopCurrent() {
    const current = handle;
    handle = null;
    if (!current) {
      if (state !== 'stopped' || status.lastError) {
        setState('stopped', { pid: 0, lastError: '' });
      }
      return getStatus();
    }
    generation += 1; // retire the exit hook of the handle we are stopping
    if (current.reused) {
      setState('stopped', {
        pid: 0, reused: false, accelerationMode: 'off', accelerationReason: '',
        accelerationDrafter: '', contextSize: 0, lastError: '',
      });
      return getStatus();
    }
    setState('stopping');
    let stopError = '';
    try {
      const result = await current.stop();
      if (result && result.confirmed === false) {
        stopError = 'stop_unconfirmed';
      }
    } catch (error) {
      // The child may still be alive; the error stays visible on the status
      // instead of being laundered into a clean 'stopped'.
      stopError = `stop_failed:${String(error && error.message || error)}`;
      log('WARN', 'llama.server.stop_failed', {
        message: String(error && error.message || error),
      });
    }
    setState('stopped', {
      pid: 0, reused: false, accelerationMode: 'off', accelerationReason: '',
      accelerationDrafter: '', contextSize: 0, lastError: stopError,
    });
    return getStatus();
  }

  // Start / recover / switch in one call: ready and already matching `spec`
  // is a no-op, ready with a different model or MTP setting is replaced,
  // anything else (stopped, crashed) launches. Exposed as both `ensureRunning`
  // and `start`.
  function ensureRunning(rawSpec) {
    const spec = normalizeSpec(rawSpec);
    return serialize(async () => {
      if (!needsRelaunch(spec)) {
        return getStatus();
      }
      if (state === 'ready') {
        await stopCurrent();
      }
      return launchFromSpec(spec || lastSpec);
    });
  }

  // Always replaces the server; without a spec it relaunches the last one.
  function restart(rawSpec) {
    const spec = normalizeSpec(rawSpec);
    abortStartup();
    return serialize(async () => {
      await stopCurrent();
      return launchFromSpec(spec || lastSpec);
    });
  }

  // Boot path: honors the resolved autostart decision (env, then persisted
  // managed config). This is the pre-manager startLlamaServerBeforeBackend.
  function startFromSettings() {
    return serialize(() => {
      if (state === 'ready') {
        return getStatus();
      }
      lastSpec = null;
      // A key file left by a main process that died mid-launch must not wait
      // for the next launch (autostart may be off for a long time).
      try {
        lifecycle.sweepStaleApiKeyFiles?.(resolveUserDataPath());
      } catch (_error) { /* best effort; the launch sweeps again */ }
      const plan = resolveLaunchPlan(null);
      if (!plan.settings.autostart) {
        log('INFO', 'llama.server.autostart_disabled');
        return getStatus();
      }
      return launchFromPlan(plan);
    });
  }

  // Aborts an in-flight startup immediately, then stops whatever is running
  // once the chain reaches it. Idempotent.
  function stop() {
    abortStartup();
    return serialize(stopCurrent);
  }

  // Resolves once every queued operation (including a launch's ready
  // observer) has settled — the chat preflight's "is ready really ready".
  function settled() {
    return chain.then(() => getStatus());
  }

  // Emergency path (SIGINT, second-instance kill): synchronous, best effort.
  // Bumping the generation makes a launch that completes afterwards kill its
  // own child instead of resurrecting the state.
  function stopSync() {
    try {
      abortStartup();
    } catch (_error) { /* best effort only */ }
    const current = handle;
    handle = null;
    generation += 1;
    try {
      if (current && !current.reused && typeof current.stopSync === 'function') {
        current.stopSync();
      }
    } catch (_error) { /* best effort only */ }
    if (state !== 'stopped') {
      setState('stopped', {
        pid: 0, reused: false, accelerationMode: 'off', accelerationReason: '',
        accelerationDrafter: '', contextSize: 0,
      });
    }
  }

  return {
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
  };
}

module.exports = {
  createLlamaServerManager,
  normalizeSpec,
};
