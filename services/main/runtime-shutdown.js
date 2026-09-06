const { shutdownAnyLocalOllamaSync } = require('../backend/ollama-shutdown');
const { drainSessionStoresSync } = require('../backend/session-store-drain');
const { shutdownManagedSidecarSync } = require('../backend/sidecar-shutdown');
const llamaServerLifecycle = require('../llama-server-lifecycle');
const { stopRuntimeWithDependencies } = require('../runtime-stop');
const { resolveLaunchAcceleration } = require('./llama-server-acceleration-launch');
const { createLlamaServerManager } = require('./llama-server-manager');

const STARTUP_STEP_COUNT = 7;
const SHUTDOWN_STEP_COUNT = 7;
// ollama_ready is sequenced *after* sidecar_spawned: the Ollama cold-start is now
// kicked off concurrently with the sidecar spawn and joined just before the
// engine handshake, so its progress step lands after the sidecar is up. Ordering
// the index this way keeps the startup progress bar monotonic (no backward dip).
const STARTUP_STEP_INDEX = {
  ollama_start: 0,
  sidecar_spawn: 1,
  sidecar_ready: 2,
  sidecar_spawned: 2,
  ollama_ready: 3,
  sidecar_initialize: 4,
  model_acquiring: 4,
  model_load: 5,
  model_loading: 5,
  model_ready: 6,
  model_unavailable: 6,
  ready: 6,
};
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
  // Workspace child-process services (piped terminal, ConPTY, and test runner).
  // teardown runs inside this awaited shutdown path rather than an
  // app.once('will-quit', …) hook — see disposeWorkspaceProcesses below.
  getWorkspaceTerminalService = () => null,
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
    // Every launch mints a new api key; a sidecar already talking to the
    // openai-compatible engine must receive it or every request 401s.
    onStateChange: (status) => {
      if (status.state !== 'ready') {
        return;
      }
      const backendService = getBackendService();
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

  async function runShutdownStage(stage, operation) {
    const startedAt = Date.now();
    try {
      const value = await operation();
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

  async function startLlamaServerBeforeBackend() {
    await managedLlamaServer.startFromSettings();
  }

  async function stopLlamaServerOnShutdown() {
    await managedLlamaServer.stop();
  }

  // Dispose workspace child-process services inside the AWAITED quit sequence:
  // a will-quit listener cannot delay quit for async work, so an un-awaited
  // tree kill races process exit and can orphan the piped shell children.
  // Isolate each disposer so one failure cannot block shutdown.
  async function disposeWorkspaceProcesses() {
    const disposers = [
      ['workspaceTerminal', getWorkspaceTerminalService()],
      ['workspacePty', getWorkspacePtyService()],
      ['workspaceRunTask', getWorkspaceRunTaskService()],
      ['workspaceTestRunner', getWorkspaceTestRunnerService()],
    ];
    const results = await Promise.allSettled(
      disposers.map(([, service]) => Promise.resolve().then(() => service?.dispose?.()))
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        log('WARN', 'workspace.process.dispose_failed', {
          service: disposers[index][0],
          message: String(result.reason && result.reason.message || result.reason),
        });
      }
    });
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

  async function stopRuntimeBeforeQuit() {
    const shutdownStartedAt = Date.now();
    await runShutdownStage('setup_operations', () => drainSetupChildren());
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
      await runShutdownStage('llama_server', () => stopLlamaServerOnShutdown());
    } catch (_error) {
      // stopLlamaServerOnShutdown already logs on failure
    }
    // disposeWorkspaceProcesses isolates + logs per-service failures internally
    // (Promise.allSettled), so it never rejects — no try/catch needed here.
    await runShutdownStage('workspace_processes', () => disposeWorkspaceProcesses());
    try {
      return await runShutdownStage(
        'backend_runtime',
        () => stopRuntimeWithDependencies({
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
        })
      );
    } finally {
      const flushStartedAt = Date.now();
      let flushStatus = 'ok';
      try {
        await getProcessLogWriter()?.flush?.({ timeoutMs: 2000 });
      } catch (error) {
        flushStatus = 'failed';
        log('WARN', 'logs.process_log_flush_failed', {
          message: String(error && error.message || error).slice(0, 240),
        });
      }
      log(flushStatus === 'ok' ? 'INFO' : 'WARN', 'runtime.shutdown_stage', {
        stage: 'process_log_flush',
        status: flushStatus,
        durationMs: Math.max(Date.now() - flushStartedAt, 0),
        remainingBudgetMs: null,
        forced: false,
        confirmed: flushStatus === 'ok',
      });
      log('INFO', 'runtime.shutdown_stage', {
        stage: 'total',
        status: flushStatus === 'ok' ? 'ok' : 'bounded',
        durationMs: Math.max(Date.now() - shutdownStartedAt, 0),
        remainingBudgetMs: null,
        forced: false,
        confirmed: flushStatus === 'ok',
      });
    }
  }

  function runEmergencyRuntimeShutdownSync() {
    if (emergencyRuntimeShutdownTriggered) {
      return;
    }
    emergencyRuntimeShutdownTriggered = true;
    const startedAt = Date.now();
    let sidecarExitConfirmed;
    let llamaExitConfirmed;
    let ollamaSweepSkipped = '';
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
    } catch (_error) {
      // best effort only
    }
    const emergencyConfirmed = sidecarExitConfirmed && llamaExitConfirmed
      && setupSignals.failed !== true && setupSignals.signalled === 0;
    log(emergencyConfirmed ? 'INFO' : 'WARN', 'runtime.shutdown_stage', {
      stage: 'emergency_fallback',
      status: emergencyConfirmed ? 'ok' : 'unconfirmed',
      durationMs: Math.max(Date.now() - startedAt, 0),
      remainingBudgetMs: 0,
      forced: true,
      confirmed: emergencyConfirmed,
      setupSignals: setupSignals.signalled,
      ...(ollamaSweepSkipped ? { ollamaSweepSkipped } : {}),
    });
  }

  return {
    emitLifecycleProgress,
    getLlamaServerApiKey,
    getLlamaServerManager,
    runEmergencyRuntimeShutdownSync,
    shutdownStepCount: SHUTDOWN_STEP_COUNT,
    shutdownStepIndex: SHUTDOWN_STEP_INDEX,
    startLlamaServerBeforeBackend,
    startupStepCount: STARTUP_STEP_COUNT,
    startupStepIndex: STARTUP_STEP_INDEX,
    stopRuntimeBeforeQuit,
  };
}

module.exports = {
  STARTUP_STEP_COUNT,
  SHUTDOWN_STEP_COUNT,
  STARTUP_STEP_INDEX,
  SHUTDOWN_STEP_INDEX,
  createRuntimeShutdownController,
};
