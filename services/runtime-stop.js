async function stopRuntimeWithDependencies({
  shellConfigService,
  systemStats,
  schedulerService,
  backendService,
  clearSuggestionCacheImpl,
  suggestionCacheValue,
  emitLifecycleProgressImpl,
  logImpl,
  runEmergencyShutdownImpl,
  shutdownStepCount = 7,
  shutdownDoneStepIndex = 6,
  shutdownStepIndexByPhase = {},
} = {}) {
  try {
    if (
      shellConfigService
      && typeof shellConfigService.flushPendingWorkspaceWrite === 'function'
    ) {
      shellConfigService.flushPendingWorkspaceWrite();
    }
    if (systemStats) {
      systemStats.stop();
    }
    if (schedulerService) {
      schedulerService.stop();
    }
    clearSuggestionCacheImpl(suggestionCacheValue);
    if (backendService) {
      await backendService.stop({
        ollamaShutdownScope: 'any_local',
        onProgress: (phase, detail) => {
          const idx = shutdownStepIndexByPhase[phase] ?? 0;
          emitLifecycleProgressImpl('shutdown', phase, detail, idx, shutdownStepCount);
        },
      });
    }
    emitLifecycleProgressImpl(
      'shutdown',
      'done',
      'Shutdown complete',
      shutdownDoneStepIndex,
      shutdownStepCount
    );
  } catch (error) {
    logImpl('ERROR', 'backend.stop_failed', { message: String(error.message || error) });
    if (backendService) {
      try {
        await backendService.ollamaManager.stop({ scope: 'any_local' });
      } catch (_ollamaError) {
        // best effort
      }
    }
    emitLifecycleProgressImpl(
      'shutdown',
      'done',
      'Shutdown complete',
      shutdownDoneStepIndex,
      shutdownStepCount,
      String(error.message || error)
    );
  } finally {
    runEmergencyShutdownImpl();
  }
}

module.exports = {
  stopRuntimeWithDependencies,
};
