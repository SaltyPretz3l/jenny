const { observeManagedLlamaServerState } = require('../backend/local-engine-status');
const { shutdownAnyLocalOllamaSync } = require('../backend/ollama-shutdown');
const { drainSessionStoresSync } = require('../backend/session-store-drain');
const { shutdownManagedSidecarSync } = require('../backend/sidecar-shutdown');
const llamaServerLifecycle = require('../llama-server-lifecycle');
const { chatModelRefusal } = require('../llama-server-gguf-files');
const { stopRuntimeWithDependencies } = require('../runtime-stop');
const { resolveLaunchAcceleration } = require('./llama-server-acceleration-launch');
const { createLlamaServerManager } = require('./llama-server-manager');

const SHUTDOWN_STEP_COUNT = 7;
// Startup reports phase keys and facts (see emitStartupProgress); only
// shutdown still narrates numbered steps.
const SHUTDOWN_STEP_INDEX = { streams_abort: 0, model_unload: 1, sidecar_shutdown: 2, sidecar_stopped: 3, ollama_stop: 4, ollama_stopped: 5, done: 6 };

function createRuntimeShutdownController({
  app,
  processRef = process,
  rootDir,
  clearSuggestionCache,
  suggestionCache,
  getShellConfigService = () => null,
  getSystemStats = () => null,
  getSchedulerService = () => null,
  getBackendService = () => null,
  getProcessLogWriter = () => null,
  // Workspace child-process services (ConPTY terminal, run task, test runner).
  // teardown runs inside this awaited shutdown path rather than an
  // app.once('will-quit', …) hook — see disposeWorkspaceProcesses below.
  getWorkspacePtyService = () => null,
  getWorkspaceRunTaskService = () => null,
  getWorkspaceTestRunnerService = () => null,
  // Onboarding child-process services: in-flight `ollama pull` children
  // (SetupService.activePullsBy*) and installer/download children
  // (OllamaInstallService._active) are NOT covered by the daemon/sidecar kills
  // below, so without an explicit reap a download started in the first-run
  // wizard outlives the app. Normal shutdown awaits disposal; emergency
  // shutdown only sends synchronous best-effort signals.
  getSetupService = () => null,
  getOllamaInstallService = () => null,
  getUpdateService = () => null,
  getWindowStateDisplayUnsubscribe = () => null,
  setWindowStateDisplayUnsubscribe = () => {},
  getPackagedSmokeController = () => null,
  setPackagedSmokeController = () => {},
  sendBridgeEvent = () => {},
  emitStartupAuditMark = () => {},
  log = () => {},
  // Injectable shutdown impls. The defaults preserve production behavior; the
  // helpers they wrap capture spawnSync/execFileSync via destructure at module
  // load and run real, destructive subprocesses (ollama stop, taskkill,
  // `wsl --shutdown`). Threading them here lets tests substitute inert fakes
  // instead of patching child_process globals before require — and assert the
  // emergency path actually invokes each one.
  shutdownAnyLocalOllamaSyncImpl = shutdownAnyLocalOllamaSync,
  shutdownManagedSidecarSyncImpl = shutdownManagedSidecarSync,
  shutdownLlamaServerSyncImpl = llamaServerLifecycle.shutdownLlamaServerSync,
  llamaServerLifecycleImpl = llamaServerLifecycle,
  resolveLaunchAccelerationImpl = resolveLaunchAcceleration,
  // Image engine (stable-diffusion.cpp) hooks. Startup: reap an orphan render
  // with proof BEFORE llama-server autostart takes the GPU. Shutdown: the chat
  // GPU handoff's closing latch (cancel the render, never restore) runs before
  // the llama_server stage; the emergency path gets one synchronous best-effort
  // kill. main.js is at its line ceiling, so the defaults read the hooks off the
  // backend service (backend-service-wiring attaches chatGpuHandoff and
  // imageEngineRuntime); the options exist for tests.
  reconcileImageEngine = () => getBackendService()?.chatGpuHandoff?.reconcile?.(),
  killImageEngineSync = () => getBackendService()?.imageEngineRuntime?.killRenderSync?.(),
  imageEngineReconcileTimeoutMs = 15_000,
  // The managed llama-server process is owned by its manager (state machine,
  // crash surface, restart-on-next-chat). This controller only sequences it
  // into startup and the two shutdown paths.
  llamaServerManager = null,
} = {}) {
  const managedLlamaServer = llamaServerManager || createLlamaServerManager({
    processRef,
    rootDir,
    userDataPath: () => app.getPath('userData'),
    getShellConfigService,
    emitStartupAuditMark,
    log,
    lifecycle: llamaServerLifecycleImpl,
    resolveLaunchAccelerationImpl,
    // A diffusion GGUF (image model) picked or persisted as a chat model is
    // refused at plan resolution, so boot autostart and the chat reconnect
    // never serve it through llama-server.
    chatModelGate: ({ modelPath }) => (modelPath ? chatModelRefusal(modelPath) : ''),
    // While the chat GPU handoff holds the lease (or the app is closing) no
    // launch may take the GPU back except the handoff's own identity restore.
    launchGate: () => {
      try {
        return getBackendService()?.chatGpuHandoff?.launchRefusal?.() || '';
      } catch (_error) {
        return '';
      }
    },
    // Managed-engine liveness heartbeat for the sidecar's stream-inactivity
    // watchdog: llama-server streams no chat chunks while the model composes a
    // buffered tool call, but keeps printing decode telemetry (mirrors the
    // Ollama manager's sink in services/main/backend-service-wiring.js).
    onEngineActivity: () => {
      try {
        getBackendService()?.sidecarClient?.notifyEngineActivity?.();
      } catch (_error) {
        /* best-effort */
      }
    },
    // Every launch mints a new api key; a sidecar already talking to the
    // openai-compatible engine must receive it or every request 401s.
    onStateChange: (status) => {
      const backendService = getBackendService();
      // A cold start reads as a model load with a clock (and feeds the
      // last-load record) instead of a bare "Starting engine".
      // Isolated so a status fault can never skip the key re-broker below.
      try {
        if (backendService) observeManagedLlamaServerState(backendService, status);
      } catch (_error) { /* the status is advisory; the launch proceeds */ }
      if (status.state !== 'ready') {
        return;
      }
      // An identity restore (chat GPU handoff) relaunched with the key the
      // parked turn already holds: nothing to re-broker, and a stack rebuild
      // here would race the turn that is about to resume.
      if (status.identityReused === true) {
        return;
      }
      if (backendService?.currentEngineType !== 'openai-compatible'
        || typeof backendService.refreshManagedConfig !== 'function') {
        return;
      }
      // Returned so the manager holds ensureRunning() until the key is brokered.
      return Promise.resolve(backendService.refreshManagedConfig('llama_server_ready'))
        .catch(() => null); // refreshManagedConfig logs its own failure
    },
  });
  let emergencyRuntimeShutdownTriggered = false;
  let workspaceDisposalStarted = false;
  let workspaceDisposalConfirmed = false;

  function beginSessionRuntimeShutdown(reason, observeResult = false) {
    const runtime = getBackendService()?.sessionRuntime;
    if (typeof runtime?.beginShutdown !== 'function') return false;
    try {
      const request = runtime.beginShutdown({ reason, timeoutMs: 1500 });
      Promise.resolve(request?.completion).then((result) => {
        if (observeResult && result?.reason === 'runtime_cleanup_awaits_backend_restart') {
          // Work parked for the next start's recovery; nothing failed.
          log('INFO', 'session_runtime.shutdown_awaits_restart', {});
        } else if (observeResult && result?.ok !== true) {
          log('WARN', 'session_runtime.shutdown_unconfirmed', {
            reason: String(result?.reason || 'runtime_shutdown_unconfirmed').slice(0, 240),
            timedOut: result?.timedOut === true,
          });
        }
      }).catch((error) => {
        log('WARN', 'session_runtime.shutdown_unconfirmed', {
          reason: String(error?.message || error).slice(0, 240),
          timedOut: false,
        });
      });
      return request?.requested === true;
    } catch (error) {
      log('WARN', 'session_runtime.shutdown_unconfirmed', {
        reason: String(error?.message || error).slice(0, 240),
        timedOut: false,
      });
      return true;
    }
  }

  function getLlamaServerManager() {
    return managedLlamaServer;
  }

  function getLlamaServerApiKey() {
    return managedLlamaServer.getApiKey();
  }

  function emitLifecycleProgress(scenario, phase, detail, stepIndex, stepCount, error) {
    sendBridgeEvent('lifecycle.onProgress', {
      scenario,
      phase,
      detail,
      stepIndex,
      stepCount,
      percent: Math.round((stepIndex / Math.max(stepCount, 1)) * 100),
      error: error || '',
      timestamp: Date.now(),
    });
  }

  // The renderer owns the startup copy and shows no percent: main sends the
  // phase key and the facts it knows (modelId, elapsedMs, bytes when known).
  function emitStartupProgress(phase, facts, error) {
    sendBridgeEvent('lifecycle.onProgress', {
      scenario: 'startup',
      phase,
      facts: facts && typeof facts === 'object' ? facts : {},
      error: error || '',
      timestamp: Date.now(),
    });
  }

  async function runShutdownStage(stage, operation, signal) {
    if (signal?.aborted) return;
    const startedAt = Date.now();
    try {
      const value = await operation();
      if (signal?.aborted) return;
      log('INFO', 'runtime.shutdown_stage', {
        stage,
        status: 'ok',
        durationMs: Math.max(Date.now() - startedAt, 0),
        remainingBudgetMs: null,
        forced: false,
        confirmed: true,
      });
      return value;
    } catch (error) {
      if (signal?.aborted) return;
      log('WARN', 'runtime.shutdown_stage', {
        stage,
        status: 'failed',
        durationMs: Math.max(Date.now() - startedAt, 0),
        remainingBudgetMs: null,
        forced: false,
        confirmed: false,
      });
      throw error;
    }
  }

  // Resolves to true when the chat engine may take the GPU.
  async function reconcileImageEngineOnStartup() {
    if (typeof reconcileImageEngine !== 'function') {
      return true;
    }
    const startedAt = Date.now();
    try {
      // A hung process query must not hold llama-server autostart forever;
      // an unanswered reconcile is reported unconfirmed, never assumed clean.
      let timer;
      const result = await Promise.race([
        Promise.resolve(reconcileImageEngine()),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ confirmed: false, timedOut: true }), imageEngineReconcileTimeoutMs); }),
      ]).finally(() => clearTimeout(timer));
      log(result?.confirmed === false ? 'WARN' : 'INFO', 'runtime.startup_step', {
        step: 'image_engine_reconcile',
        status: result?.confirmed === false ? 'unconfirmed' : 'ok',
        timedOut: result?.timedOut === true,
        durationMs: Math.max(Date.now() - startedAt, 0),
      });
      return result?.confirmed !== false;
    } catch (error) {
      log('WARN', 'runtime.startup_step', {
        step: 'image_engine_reconcile',
        status: 'failed',
        durationMs: Math.max(Date.now() - startedAt, 0),
        message: String(error?.message || error),
      });
      return false;
    }
  }

  async function startLlamaServerBeforeBackend() {
    // An orphan sd-cli from a killed session must be gone before the chat
    // engine takes the GPU, or the model load fails on the VRAM it still holds.
    // Without proof the chat engine stays down: the handoff holds an orphan
    // lease and the Model Library offers Clean up; the next turn relaunches.
    if (!(await reconcileImageEngineOnStartup())) {
      log('WARN', 'runtime.startup_step', { step: 'llama_server_autostart', status: 'skipped', reason: 'image_engine_unconfirmed' });
      return;
    }
    // The engine the backend boots with (preferred, else inferred from the
    // default model); without a backend the manager reads the preferred one.
    const engineType = getBackendService()?.currentEngineType;
    await managedLlamaServer.startFromSettings(engineType ? { engineType } : {});
  }

  // Closing latch first: an active render is cancelled with proof and no
  // chat-engine restore follows, so the llama_server stage below never races
  // a relaunch (chat-gpu-handoff.js close()).
  async function closeImageEngineOnShutdown() {
    const handoff = getBackendService()?.chatGpuHandoff;
    if (!handoff || typeof handoff.close !== 'function') {
      return null;
    }
    return handoff.close();
  }

  async function stopLlamaServerOnShutdown() {
    await managedLlamaServer.stop();
  }

  // Dispose workspace child-process services inside the AWAITED quit sequence:
  // a will-quit listener cannot delay quit for async work, so an un-awaited
  // tree kill races process exit and can orphan shell children.
  // Isolate each disposer so one failure cannot block shutdown.
  function workspaceProcessDisposers() {
    return [
      ['workspacePty', getWorkspacePtyService()],
      ['workspaceRunTask', getWorkspaceRunTaskService()],
      ['workspaceTestRunner', getWorkspaceTestRunnerService()],
    ];
  }

  async function disposeWorkspaceProcesses(signal) {
    workspaceDisposalStarted = true;
    const disposers = workspaceProcessDisposers();
    const results = await Promise.allSettled(
      disposers.map(([, service]) => Promise.resolve().then(() => service?.dispose?.()))
    );
    if (signal?.aborted) return;
    workspaceDisposalConfirmed = results.every((result) =>
      result.status === 'fulfilled' && result.value?.terminationConfirmed !== false);
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log('WARN', 'workspace.process.dispose_failed', {
          service: disposers[index][0],
          message: String(result.reason && result.reason.message || result.reason),
        });
      }
    });
  }

  function signalWorkspaceChildrenSync() {
    if (workspaceDisposalStarted) return { signalled: 0, confirmed: workspaceDisposalConfirmed };
    workspaceDisposalStarted = true;
    let signalled = 0;
    let failed = false;
    for (const [name, service] of workspaceProcessDisposers()) {
      if (typeof service?.dispose !== 'function') continue;
      try {
        // Initiate each owner's idempotent cancellation before exiting. The
        // emergency path cannot await it and must not claim confirmed cleanup.
        signalled += 1;
        Promise.resolve(service.dispose()).catch(() => {
          log('WARN', 'workspace.process.emergency_dispose_failed', { service: name });
        });
      } catch (_error) {
        failed = true;
        log('WARN', 'workspace.process.emergency_dispose_failed', { service: name });
      }
    }
    return { signalled, confirmed: !failed && signalled === 0 };
  }
  function signalSetupChildrenSync() {
    let signalled = 0;
    let failed = false;
    try {
      const service = getSetupService();
      if (typeof service?.signalActivePulls === 'function') {
        signalled += Math.max(0, Number(service.signalActivePulls()) || 0);
      }
    } catch (error) {
      failed = true;
      log('WARN', 'setup.pull_reap_failed', { message: String(error && error.message || error) });
    }
    try {
      const service = getOllamaInstallService();
      if (typeof service?.signalActiveInstalls === 'function') {
        signalled += Math.max(0, Number(service.signalActiveInstalls()) || 0);
      }
    } catch (error) {
      failed = true;
      log('WARN', 'setup.install_reap_failed', { message: String(error && error.message || error) });
    }
    return { signalled, failed };
  }

  async function drainSetupChildren() {
    const operations = [
      ['pull', getSetupService(), 'disposeActivePulls'],
      ['install', getOllamaInstallService(), 'disposeActiveInstalls'],
    ];
    const results = await Promise.allSettled(operations.map(([, service, method]) => (
      Promise.resolve().then(() => service?.[method]?.())
    )));
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log('WARN', `setup.${operations[index][0]}_reap_failed`, {
          message: String(result.reason?.message || result.reason),
        });
      }
    });
  }

  async function stopRuntimeBeforeQuit({ signal } = {}) {
    if (signal?.aborted) return;
    beginSessionRuntimeShutdown('app_shutdown');
    const shutdownStartedAt = Date.now();
    await runShutdownStage('setup_operations', () => drainSetupChildren(), signal);
    if (signal?.aborted) return;
    const packagedSmokeController = getPackagedSmokeController();
    if (packagedSmokeController) {
      packagedSmokeController.dispose();
      setPackagedSmokeController(null);
    }
    const updateService = getUpdateService();
    if (updateService && typeof updateService.dispose === 'function') {
      updateService.dispose();
    }
    const unsubscribe = getWindowStateDisplayUnsubscribe();
    if (typeof unsubscribe === 'function') {
      unsubscribe();
      setWindowStateDisplayUnsubscribe(null);
    }
    try {
      await runShutdownStage('image_engine', () => closeImageEngineOnShutdown(), signal);
    } catch (_error) {
      // runShutdownStage already logged the failure; llama-server still stops
    }
    // Row 41: stop the catalog scheduler and its embedding server first.
    try {
      await runShutdownStage('semantic_catalog', async () => getBackendService()?.semanticCatalogService?.dispose?.(), signal);
    } catch (_error) {
      // runShutdownStage already logged the failure
    }
    try {
      await runShutdownStage('llama_server', () => stopLlamaServerOnShutdown(), signal);
    } catch (_error) {
      // stopLlamaServerOnShutdown already logs on failure
    }
    // disposeWorkspaceProcesses isolates + logs per-service failures internally
    // (Promise.allSettled), so it never rejects — no try/catch needed here.
    await runShutdownStage('workspace_processes', () => disposeWorkspaceProcesses(signal), signal);
    try {
      return await runShutdownStage(
        'backend_runtime',
        () => stopRuntimeWithDependencies({
          signal,
          shellConfigService: getShellConfigService(),
          systemStats: getSystemStats(),
          schedulerService: getSchedulerService(),
          backendService: getBackendService(),
          clearSuggestionCacheImpl: clearSuggestionCache,
          suggestionCacheValue: suggestionCache,
          emitLifecycleProgressImpl: emitLifecycleProgress,
          logImpl: log,
          runEmergencyShutdownImpl: runEmergencyRuntimeShutdownSync,
          shutdownStepCount: SHUTDOWN_STEP_COUNT,
          shutdownDoneStepIndex: 6,
          shutdownStepIndexByPhase: SHUTDOWN_STEP_INDEX,
        }),
        signal
      );
    } finally {
      await flushShutdownLog(shutdownStartedAt, signal);
    }
  }

  async function flushShutdownLog(shutdownStartedAt, signal) {
    if (signal?.aborted) return;
    const flushStartedAt = Date.now();
    let flushStatus = 'ok';
    try {
      const outcome = await getProcessLogWriter()?.flush?.({ timeoutMs: 2000 });
      // timedOutCount is the writer's lifetime total; only this drain's result counts.
      if (outcome?.persisted === false) {
        flushStatus = 'failed';
      } else if (outcome?.flushed === false) {
        flushStatus = 'bounded';
      }
    } catch (error) {
      if (signal?.aborted) return;
      flushStatus = 'failed';
      log('WARN', 'logs.process_log_flush_failed', {
        message: String(error && error.message || error).slice(0, 240),
        recordFlushed: false,
      });
    }
    if (signal?.aborted) return;
    // These outcome records require the drain result, so they cannot be part
    // of that last bounded drain. Never claim the records themselves flushed.
    for (const [stage, status, startedAt, level] of [
      ['process_log_flush', flushStatus, flushStartedAt, flushStatus === 'ok' ? 'INFO' : 'WARN'],
      ['total', flushStatus === 'ok' ? 'ok' : 'bounded', shutdownStartedAt, 'INFO'],
    ]) {
      log(level, 'runtime.shutdown_stage', {
        stage,
        status,
        durationMs: Math.max(Date.now() - startedAt, 0),
        remainingBudgetMs: null,
        forced: false,
        confirmed: flushStatus === 'ok',
        recordFlushed: false,
      });
    }
    // Best effort for the two records above; they still claim nothing.
    try {
      await getProcessLogWriter()?.flush?.({ timeoutMs: 250 });
    } catch (_error) { /* the confirmed drain already ran */ }
  }

  function runEmergencyRuntimeShutdownSync() {
    if (emergencyRuntimeShutdownTriggered) {
      return;
    }
    emergencyRuntimeShutdownTriggered = true;
    const startedAt = Date.now();
    let sidecarExitConfirmed;
    let llamaExitConfirmed;
    let ollamaExitConfirmed = false;
    let ollamaSweepSkipped = '';
    const runtimeShutdownRequested = beginSessionRuntimeShutdown('emergency_shutdown', true);
    try {
      // Drain debounced session-store writes FIRST: every step below only
      // kills processes, and an emergency exit (SIGINT, second-instance kill)
      // otherwise discards up to 500ms of chat history sitting in the
      // FileJsonStore debounce window.
      drainSessionStoresSync(getBackendService());
    } catch (_error) {
      // best effort only
    }
    const setupSignals = signalSetupChildrenSync();
    const workspaceSignals = signalWorkspaceChildrenSync();
    try {
      // Latch first so an in-flight suspend can no longer spawn a render or
      // re-park the chat engine's identity behind the synchronous stop below.
      getBackendService()?.chatGpuHandoff?.markClosing?.();
      if (typeof killImageEngineSync === 'function') killImageEngineSync();
    } catch (_error) {
      // best effort only
    }
    try {
      getBackendService()?.semanticCatalogService?.dispose?.();
    } catch (_error) {
      // best effort only
    }
    try {
      managedLlamaServer.stopSync();
    } catch (_error) {
      // best effort only
    }
    try {
      // F2d: consume {hadState, killed} exactly like the sidecar result below —
      // a retained (unconfirmed) llama-server kill must not be reported as a
      // clean emergency shutdown.
      const llamaResult = shutdownLlamaServerSyncImpl({
        userDataPath: app.getPath('userData'),
        logger: log,
      });
      llamaExitConfirmed = llamaResult?.hadState === true
        ? llamaResult.killed === true
        : true;
    } catch (_error) {
      llamaExitConfirmed = false;
    }
    try {
      const sidecarResult = shutdownManagedSidecarSyncImpl({
        userDataPath: app.getPath('userData'),
        logger: log,
      });
      sidecarExitConfirmed = sidecarResult?.hadState === true
        ? sidecarResult.killed === true
        : true;
    } catch (_error) {
      sidecarExitConfirmed = false;
    }
    try {
      // F2/F2a: this sweep is residue-gated inside shutdownAnyLocalOllamaSync —
      // it returns skipped:'no_owned_state' rather than force-killing every
      // ollama.exe on the machine when this install never owned one.
      const ollamaResult = shutdownAnyLocalOllamaSyncImpl({
        userDataPath: app.getPath('userData'),
        logger: log,
      });
      ollamaSweepSkipped = String(ollamaResult?.skipped || '');
      ollamaExitConfirmed = ollamaResult?.verifiedAllKilled === true
        || ['no_owned_state', 'stale_owned_pid'].includes(ollamaSweepSkipped);
    } catch (_error) {
      // best effort only
    }
    // The awaited quit path has already requested the runtime shutdown, so
    // "requested" is always true here; judge the runtime by its settled state.
    let runtimeCleanupConfirmed = !runtimeShutdownRequested;
    try {
      const runtime = getBackendService()?.sessionRuntime;
      if (typeof runtime?.isCleanupConfirmed === 'function') {
        runtimeCleanupConfirmed = runtime.isCleanupConfirmed() === true;
      }
    } catch (_error) {
      runtimeCleanupConfirmed = false;
    }
    const emergencyConfirmed = sidecarExitConfirmed && llamaExitConfirmed && ollamaExitConfirmed
      && setupSignals.failed !== true && setupSignals.signalled === 0
      && workspaceSignals.confirmed === true && runtimeCleanupConfirmed;
    log(emergencyConfirmed ? 'INFO' : 'WARN', 'runtime.shutdown_stage', {
      stage: 'emergency_fallback',
      status: emergencyConfirmed ? 'ok' : 'unconfirmed',
      durationMs: Math.max(Date.now() - startedAt, 0),
      remainingBudgetMs: 0,
      forced: true,
      confirmed: emergencyConfirmed,
      setupSignals: setupSignals.signalled,
      workspaceSignals: workspaceSignals.signalled,
      runtimeShutdownRequested,
      runtimeCleanupConfirmed,
      ...(ollamaSweepSkipped ? { ollamaSweepSkipped } : {}),
    });
  }

  return {
    emitLifecycleProgress,
    emitStartupProgress,
    getLlamaServerApiKey,
    getLlamaServerManager,
    runEmergencyRuntimeShutdownSync,
    shutdownStepCount: SHUTDOWN_STEP_COUNT,
    shutdownStepIndex: SHUTDOWN_STEP_INDEX,
    startLlamaServerBeforeBackend,
    stopRuntimeBeforeQuit,
  };
}

module.exports = {
  SHUTDOWN_STEP_COUNT,
  SHUTDOWN_STEP_INDEX,
  createRuntimeShutdownController,
};
