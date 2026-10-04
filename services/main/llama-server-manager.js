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

const fs = require('fs');
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
const {
  createRuntimePickRegistry,
  describeRuntimeLabel,
  resolveLaunchRuntime,
  runtimeFolderToken,
} = require('./llama-server-runtime');

const STATES = Object.freeze(['stopped', 'starting', 'ready', 'stopping', 'crashed']);
const MTP_MODES = Object.freeze(['off', 'mtp', 'ngram']);

// Only the five keys a caller may steer; everything else is dropped so an IPC
// payload can never smuggle launch arguments in, and never an executable: the
// binary is the model's saved runtime (accepted only from a main-owned pick) or
// the bundled build. Mirrors the persisted-config normalizer in
// shell-config-engines.js (a local absolute .gguf or Ollama blob path, never a
// network one; bounded draft).
function normalizeSpec(spec, { platform = process.platform } = {}) {
  const source = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
  if (!source) {
    return null;
  }
  const normalized = {};
  const modelTag = String(source.modelTag || '').trim();
  const modelPath = String(source.modelPath || '').trim();
  const profileId = String(source.profileId || '').trim().toLowerCase();
  if (modelTag && !/[\r\n\0]/.test(modelTag)) normalized.modelTag = modelTag;
  if (isManagedModelPath(modelPath, { platform })) {
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
  // Passed straight to each launch: the lifecycle forwards llama-server's
  // decode telemetry here so the sidecar's stream-inactivity watchdog can tell
  // a busy engine from a hung one.
  onEngineActivity = null,
  log = () => {},
  // Returns a refusal reason ('' admits) consulted before every launch that
  // is not an identity restore: the chat GPU handoff refuses launches while
  // it holds the GPU lease or the app is closing (chat-gpu-handoff.js).
  launchGate = () => '',
  // Returns a refusal reason for a model file that is not a chat model
  // ('' admits). Boot autostart and the chat reconnect resolve plans without
  // the IPC handlers, so the refusal lives here rather than in discovery.
  chatModelGate = () => '',
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
  // The resolved plan the tracked server was launched from, and the identity
  // (api key + plan) a stop({ retainIdentity }) parked for an exact relaunch.
  let currentPlan = null;
  let retainedIdentity = null;
  // Builds the user picked this session (llama-server-runtime.js); the
  // engines.updateSettings write accepts a new runtime path only from here.
  const runtimePicks = createRuntimePickRegistry();
  // The executable the tracked server was spawned from. Main-only: getStatus()
  // crosses IPC, so the status carries just the bounded runtimeLabel.
  let runningBinaryPath = '';
  // The tag the tracked server was launched for, unstripped: status.alias drops
  // ':latest', but per-model settings are keyed by the full tag.
  let runningModelTag = '';
  let chain = Promise.resolve();
  // Set when a launch or stop could not prove its child dead (the PID record
  // is retained): a clean 'stopped' is not reported and no second server
  // launches until reconcileCleanup() sees the record gone.
  let cleanupPending = false;
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
    runtimeLabel: '',
    reused: false,
    identityRetained: false,
    identityReused: false,
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
    const down = ['stopped', 'crashed'].includes(next);
    if (down) {
      runningBinaryPath = '';
      runningModelTag = '';
    }
    Object.assign(status, patch, {
      ...(down ? { mmproj: '', runtimeLabel: '' } : {}),
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

  // True when no uncertainty is pending, or the retained record has been
  // settled with proof (llama-server-pidfile.js reconcileRetainedPid). Fails
  // closed; never signals a pid itself.
  function reconcileCleanup() {
    if (!cleanupPending) {
      return true;
    }
    try {
      const settled = lifecycle.reconcileRetainedPid({
        userDataPath: resolveUserDataPath(),
        logger: log,
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

  // The projector a launch of this model would carry: one directory listing,
  // shared by the launch plan and the ready-server relaunch check.
  function resolveSpecProjector(modelTag, modelPath) {
    return modelPath
      ? lifecycle.resolveProjectorPath?.({ modelPath }) || ''
      : lifecycle.resolveGgufPath?.({ modelTag, userDataPath: resolveUserDataPath(), repoRoot: rootDir })?.projectorPath || '';
  }

  function localEngineSettings() {
    return getShellConfigService()?.getLocalEngines?.() || null;
  }

  function managedSettings() {
    return localEngineSettings()?.openaiCompatible?.managed || null;
  }

  function preferredEngineType() {
    try {
      return String(getShellConfigService()?.getState?.()?.preferredEngineType || '');
    } catch (_error) {
      return '';
    }
  }

  function persistedEntryFor(managed, modelTag) {
    const perModel = managed?.perModel;
    const key = managedModelKey(modelTag);
    return perModel && typeof perModel === 'object' && Object.prototype.hasOwnProperty.call(perModel, key)
      ? perModel[key] || null
      : null;
  }

  // The executable a launch of this model would run: env override > the
  // model's saved build > bundled. Resolved once per launch so the spawn and
  // the acceleration probe can never disagree.
  function resolveRuntimeFor(settings, managed, modelTag) {
    const entry = persistedEntryFor(managed, modelTag);
    const runtime = resolveLaunchRuntime({
      binaryOverride: settings.binaryOverride,
      runtimePath: typeof entry?.runtimePath === 'string' ? entry.runtimePath : '',
      resolveBundledPath: () => lifecycle.resolveBinaryPath?.({
        repoRoot: rootDir,
        resourcesPath: processRef.resourcesPath,
      }) || '',
    });
    return { runtime, runtimeBuild: Number(entry?.runtimeBuild) || 0 };
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
    // The persisted path is the last-used model's own file: a spec naming any
    // other model must not inherit it, or that file would be served under the
    // other model's name (and on its build). The env path is a global fallback.
    const inheritsPath = settings.modelPathSource !== 'config' || !spec?.modelTag
      || managedModelKey(spec.modelTag) === managedModelKey(settings.modelTagOverride);
    const modelPath = spec?.modelPath || (inheritsPath ? settings.modelPathOverride : '') || '';
    const modelError = String(chatModelGate({ modelTag, modelPath }) || '');
    if (modelError) {
      return { settings, profileError: '', profileId, modelTag, modelError };
    }
    const { runtime, runtimeBuild } = resolveRuntimeFor(settings, managed, modelTag);
    if (runtime.error) {
      // A saved build that is gone fails the launch: nothing is spawned or
      // probed, and it never falls back to the bundled build.
      return { settings, profileError: '', profileId, modelTag, runtimeError: runtime.error };
    }
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
      binaryPath: runtime.binaryPath,
      profile: effectiveProfile,
      featureFlags,
      shellAcceleration,
      repoRoot: rootDir,
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
      runtimeShadowed: runtime.shadowed,
      accel,
      launchOptions: {
        modelTag,
        binaryPath: runtime.binaryPath,
        // After the acceleration probe, so a probed build reads from the cache.
        runtimeLabel: describeRuntimeLabel(runtime, { runtimeBuild }),
        runtimeSource: runtime.source,
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

  // Exits reported while a launch of the same generation is still 'starting',
  // by pid: the child died between answering its readiness probe and the launch
  // recording it. launch() consults this before promoting the handle. Keyed by
  // pid because the killed accelerated attempt's late exit shares this hook
  // with its retry and must not overwrite the retry's.
  let earlyExits = new Map();

  function onChildExit(startGeneration, info) {
    // Only the handle we are currently tracking may move the state; a stale
    // exit from a server we already replaced is noise.
    if (startGeneration !== generation) {
      return;
    }
    if (state === 'starting') {
      if (info && info.pid) earlyExits.set(info.pid, info);
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

  // A saved build deleted or renamed after the plan resolved it fails the spawn
  // with a generic error: name it the way the plan would have, and never spawn
  // the missing file again for the unaccelerated retry.
  function vanishedRuntimeError(launchOptions) {
    if (launchOptions.runtimeSource !== 'saved') {
      return '';
    }
    try {
      if (fs.statSync(launchOptions.binaryPath).isFile()) {
        return '';
      }
    } catch (error) {
      // Only a build that is gone; a refused stat (antivirus, permissions)
      // proves nothing, so the usual retry decides.
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
        return '';
      }
    }
    return `llama_server_runtime_missing:${runtimeFolderToken(launchOptions.binaryPath)}`;
  }

  async function launch(plan, launchExtras = {}) {
    const { accel, profile, launchOptions } = plan;
    if (!reconcileCleanup()) {
      // The previous server may still hold the GPU: never start a second one.
      setState('stopped', { lastError: 'stop_unconfirmed' });
      log('WARN', 'llama.server.launch_refused', { reason: 'stop_unconfirmed' });
      return getStatus();
    }
    const reuseIdentity = Boolean(launchExtras.retainedApiKey);
    if (!reuseIdentity) {
      // A fresh launch mints a fresh key: any parked identity is abandoned.
      retainedIdentity = null;
    }
    if (plan.runtimeShadowed) {
      log('WARN', 'llama.server.runtime_env_shadowed', { model: managedModelKey(plan.modelTag) });
    }
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
    earlyExits = new Map();
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
          ...launchExtras,
          extraArgs: [...profileExtraArgs, ...accel.extraArgs],
          abortSignal: abortController.signal,
          onExit,
          onEngineActivity,
        });
      } catch (error) {
        const vanished = vanishedRuntimeError(launchOptions);
        if (vanished) {
          throw new Error(vanished, { cause: error });
        }
        // The failed attempt's child may still be alive: no unaccelerated retry
        // beside it.
        if (error && error.cleanupUnconfirmed === true) {
          throw error;
        }
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
          ...launchExtras,
          extraArgs: profileExtraArgs,
          abortSignal: abortController.signal,
          onExit,
          onEngineActivity,
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
      const early = nextHandle.pid ? earlyExits.get(nextHandle.pid) : null;
      earlyExits = new Map();
      if (early) {
        throw new Error(`llama_server_exited:${early.code != null ? early.code : early.signal || 'unknown'}`);
      }
      handle = nextHandle;
      currentPlan = plan;
      runningBinaryPath = nextHandle.reused ? '' : String(launchOptions.binaryPath || '');
      runningModelTag = String(launchOptions.modelTag || '');
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
        runtimeLabel: nextHandle.reused ? 'unknown' : String(launchOptions.runtimeLabel || ''),
        identityRetained: false,
        identityReused: reuseIdentity,
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
      currentPlan = null;
      if (error && error.cleanupUnconfirmed === true) {
        cleanupPending = true;
      }
      const message = vanishedRuntimeError(launchOptions) || String(error && error.message || error);
      setState('stopped', {
        pid: 0, reused: false, accelerationMode: 'off', accelerationReason: '',
        accelerationDrafter: '', contextSize: 0, identityReused: false, lastError: message,
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
    if (plan.modelError) {
      log('WARN', 'llama.server.model_refused', { reason: plan.modelError, model: managedModelKey(plan.modelTag) });
      setState('stopped', { alias: stripLatestTag(plan.modelTag), lastError: plan.modelError });
      return Promise.resolve(getStatus());
    }
    if (plan.runtimeError) {
      log('WARN', 'llama.server.runtime_missing', {
        runtime: plan.runtimeError.slice('llama_server_runtime_missing:'.length),
      });
      setState('stopped', { alias: stripLatestTag(plan.modelTag), lastError: plan.runtimeError });
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
    if (spec.modelTag && managedModelKey(spec.modelTag) !== managedModelKey(runningModelTag || status.alias)) {
      return true;
    }
    if (spec.modelPath && spec.modelPath !== status.modelPath) {
      return true;
    }
    if (spec.profileId && spec.profileId !== status.profileId) {
      return true;
    }
    // A build change applies to the model it belongs to. A reused server's
    // executable is not ours to replace (stopCurrent() cannot kill it), so it
    // is skipped rather than relaunched in a loop.
    if (runningBinaryPath) {
      const managed = managedSettings();
      const settings = resolveSettingsImpl({ env: processRef.env, repoRoot: rootDir, managed });
      const { runtime } = resolveRuntimeFor(settings, managed, spec.modelTag || runningModelTag || status.alias);
      if (runtime.error || runtime.binaryPath !== runningBinaryPath) {
        return true;
      }
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

  async function stopCurrent({ retainIdentity = false } = {}) {
    const current = handle;
    const plan = currentPlan;
    handle = null;
    currentPlan = null;
    retainedIdentity = null;
    if (!current) {
      if (!reconcileCleanup()) {
        setState('stopped', { pid: 0, lastError: 'stop_unconfirmed' });
      } else if (state !== 'stopped' || status.lastError) {
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
        cleanupPending = true;
      }
    } catch (error) {
      cleanupPending = true;
      // The child may still be alive; the error stays visible on the status
      // instead of being laundered into a clean 'stopped'.
      stopError = `stop_failed:${String(error && error.message || error)}`;
      log('WARN', 'llama.server.stop_failed', {
        message: String(error && error.message || error),
      });
    }
    // Only a confirmed stop of our own child parks its identity: an unconfirmed
    // one may still hold the port, and a reused server's key was never ours.
    if (retainIdentity && !stopError && !current.reused && current.apiKey && plan) {
      retainedIdentity = { apiKey: current.apiKey, plan, spec: lastSpec };
    }
    setState('stopped', {
      pid: 0, reused: false, accelerationMode: 'off', accelerationReason: '',
      accelerationDrafter: '', contextSize: 0, identityReused: false,
      identityRetained: Boolean(retainedIdentity), lastError: stopError,
    });
    return getStatus();
  }

  function launchRefusal() {
    try {
      return String(launchGate() || '');
    } catch (_error) {
      return '';
    }
  }

  // A refused launch never touches a ready server; a down one records why.
  function refusedStatus(refusal) {
    log('WARN', 'llama.server.launch_refused', { reason: refusal, state });
    if (state !== 'ready') {
      status.lastError = refusal;
    }
    return getStatus();
  }

  // Relaunches the parked identity exactly: same plan, same key, same port,
  // never adopting a foreign server. Status.identityReused reports success.
  function resumeRetainedIdentity() {
    const identity = retainedIdentity;
    retainedIdentity = null;
    status.identityRetained = false;
    if (state === 'ready') {
      return Promise.resolve(getStatus());
    }
    if (!identity) {
      log('WARN', 'llama.server.identity_restore_skipped', { state });
      status.lastError = 'llama_server_identity_missing';
      return Promise.resolve(getStatus());
    }
    lastSpec = identity.spec;
    return launch(identity.plan, { retainedApiKey: identity.apiKey, adopt: false });
  }

  // Start / recover / switch in one call: ready and already matching `spec`
  // is a no-op, ready with a different model or MTP setting is replaced,
  // anything else (stopped, crashed) launches. Exposed as both `ensureRunning`
  // and `start`.
  function ensureRunning(rawSpec, { reuseIdentity = false } = {}) {
    const spec = normalizeSpec(rawSpec);
    return serialize(async () => {
      if (reuseIdentity) {
        return resumeRetainedIdentity();
      }
      if (!needsRelaunch(spec)) {
        return getStatus();
      }
      const refusal = launchRefusal();
      if (refusal) {
        return refusedStatus(refusal);
      }
      if (state === 'ready') {
        await stopCurrent();
      }
      return launchFromSpec(spec || refreshedLastSpec());
    });
  }

  // A relaunch without a spec takes the last model with its CURRENT saved
  // engine settings, built exactly as a Use builds them (backend-runtime.js),
  // so a Tune Apply (build, MTP, GGUF file) is live after the restart. Before
  // any Use (boot autostart) that model is the last-used one, unless an env
  // model or profile chose the launch.
  function refreshedLastSpec() {
    const managed = managedSettings();
    const modelTag = lastSpec?.modelTag || (lastSpec ? '' : String(
      resolveSettingsImpl({ env: processRef.env, repoRoot: rootDir, managed }).modelTagOverride || ''
    ));
    if (!modelTag) {
      return lastSpec;
    }
    const entry = persistedEntryFor(managed, modelTag);
    if (!entry || entry.engine !== 'llama-server') {
      return lastSpec;
    }
    return normalizeSpec({
      modelTag,
      modelPath: entry.modelPath,
      profileId: managed?.profileId,
      mtp: entry.mtp,
    });
  }

  // Always replaces the server; without a spec it relaunches the last model.
  function restart(rawSpec) {
    const spec = normalizeSpec(rawSpec);
    // A restart the gate refuses must not abort the identity restore that is
    // in flight for a parked chat turn; the gate is re-read under the chain.
    const early = launchRefusal();
    if (early) {
      return Promise.resolve(refusedStatus(early));
    }
    abortStartup();
    return serialize(async () => {
      const refusal = launchRefusal();
      if (refusal) {
        return refusedStatus(refusal);
      }
      await stopCurrent();
      return launchFromSpec(spec || refreshedLastSpec());
    });
  }

  // Boot path: honors the resolved autostart decision (env, then persisted
  // managed config). This is the pre-manager startLlamaServerBeforeBackend.
  // `engineType` is the engine the backend boots with; without one the
  // persisted preferred engine decides. Only openai-compatible autostarts.
  function startFromSettings({ engineType } = {}) {
    return serialize(() => {
      if (state === 'ready') {
        return getStatus();
      }
      const refusal = launchRefusal();
      if (refusal) {
        return refusedStatus(refusal);
      }
      lastSpec = null;
      // A key file left by a main process that died mid-launch must not wait
      // for the next launch (autostart may be off for a long time).
      try {
        lifecycle.sweepStaleApiKeyFiles?.(resolveUserDataPath());
      } catch (_error) { /* best effort; the launch sweeps again */ }
      // Decided before any plan: resolving one probes the saved build.
      const startupModelLoad = localEngineSettings()?.startupModelLoad !== false;
      const settings = resolveSettingsImpl({
        env: processRef.env,
        repoRoot: rootDir,
        managed: managedSettings(),
        startupModelLoad,
        // Unknown (no backend, no preferred engine) keeps the ungated decision.
        activeEngineType: String(engineType || preferredEngineType()) || null,
      });
      if (!settings.autostart && settings.autostartSkipReason === 'engine_not_active') {
        log('INFO', 'llama.server.autostart_skipped', { reason: 'engine_not_active' });
        return getStatus();
      }
      if (!settings.autostart) {
        const envAutostartOverride = /^(1|true|yes|on|0|false|no|off)$/i
          .test(String(processRef.env.JENNY_LLAMA_SERVER_AUTOSTART || '').trim());
        log('INFO', 'llama.server.autostart_disabled',
          !startupModelLoad && !envAutostartOverride ? { reason: 'startup_model_load_off' } : undefined);
        return getStatus();
      }
      // The last-used model starts with its saved engine settings (MTP, file,
      // build), as a Use would, and that spec is recorded, so an identical Use
      // keeps this server. An env model or profile keeps the global settings.
      return launchFromSpec(refreshedLastSpec());
    });
  }

  // Aborts an in-flight startup immediately, then stops whatever is running
  // once the chain reaches it. Idempotent.
  // `retainIdentity` parks the api key and launch plan of a confirmed stop so
  // ensureRunning(null, { reuseIdentity: true }) can bring the same server
  // back for a chat turn that is still holding its key.
  function stop({ retainIdentity = false } = {}) {
    abortStartup();
    return serialize(() => stopCurrent({ retainIdentity }));
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
    currentPlan = null;
    retainedIdentity = null;
    generation += 1;
    try {
      if (current && !current.reused && typeof current.stopSync === 'function') {
        current.stopSync();
      }
    } catch (_error) { /* best effort only */ }
    if (state !== 'stopped') {
      setState('stopped', {
        pid: 0, reused: false, accelerationMode: 'off', accelerationReason: '',
        accelerationDrafter: '', contextSize: 0, identityRetained: false, identityReused: false,
      });
    }
  }

  return {
    ensureRunning,
    getApiKey,
    getBaseUrl,
    getStatus,
    restart,
    runtimePicks,
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
