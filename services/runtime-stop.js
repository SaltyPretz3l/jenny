async function stopRuntimeWithDependencies({
  shellConfigService,
  systemStats,
  unattendedGuard = systemStats?.unattendedGuard,
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
  signal,
} = {}) {
  if (signal?.aborted) return;
  try {
    if (
      shellConfigService
      && typeof shellConfigService.flushPendingWorkspaceWrite === 'function'
    ) {
      shellConfigService.flushPendingWorkspaceWrite();
    }
    if (unattendedGuard) {
      unattendedGuard.stop();
    }
    if (systemStats) {
      systemStats.stop();
    }
    if (schedulerService) {
      schedulerService.stop();
    }
    clearSuggestionCacheImpl(suggestionCacheValue);
    if (backendService) {
      await backendService.commandSandbox?.close();
      await backendService.stop({
        ollamaShutdownScope: 'any_local',
        onProgress: (phase, detail) => {
          if (signal?.aborted) return;
          const idx = shutdownStepIndexByPhase[phase] ?? 0;
          emitLifecycleProgressImpl('shutdown', phase, detail, idx, shutdownStepCount);
        },
      });
    }
    if (signal?.aborted) return;
    emitLifecycleProgressImpl(
      'shutdown',
      'done',
      'Shutdown complete',
      shutdownDoneStepIndex,
      shutdownStepCount
    );
  } catch (error) {
    if (signal?.aborted) return;
    logImpl('ERROR', 'backend.stop_failed', { message: String(error.message || error) });
    if (backendService) {
      try {
        await backendService.ollamaManager.stop({ scope: 'any_local' });
      } catch (_ollamaError) {
        // best effort
      }
    }
    if (signal?.aborted) return;
    emitLifecycleProgressImpl(
      'shutdown',
      'done',
      'Shutdown complete',
      shutdownDoneStepIndex,
      shutdownStepCount,
      String(error.message || error)
    );
  } finally {
    if (!signal?.aborted) runEmergencyShutdownImpl();
  }
}

module.exports = {
  stopRuntimeWithDependencies,
};
