const { normalizeRendererDiagnosticsDetails } = require('./log-entry-normalizer');

function createMainErrorHardening({
  app,
  processRef,
  log,
  stopRuntimeBeforeQuit,
  getMainLifecycle,
  emitFailedBackendStatus,
  unhandledFailureEvent = 'app.unhandled_failure',
}) {
  let crashGuardsRegistered = false;
  let emergencyShutdownTriggered = false;

  function resetForStartup() {
    emergencyShutdownTriggered = false;
  }

  function requestEmergencyShutdown(reason, details = {}) {
    if (emergencyShutdownTriggered) {
      return;
    }
    emergencyShutdownTriggered = true;
    const failureDetail = String(details.message || details.detail || reason || 'Unhandled failure');
    log('ERROR', unhandledFailureEvent, {
      reason: String(reason || 'unknown'),
      status: 'failed',
      ...details,
      message: failureDetail,
    });
    if (typeof emitFailedBackendStatus === 'function') {
      emitFailedBackendStatus(failureDetail, {
        reason: String(reason || 'unknown'),
        event: String(details.event || '').trim(),
      });
    }
    const lifecycle = typeof getMainLifecycle === 'function' ? getMainLifecycle() : null;
    if (lifecycle && typeof lifecycle.requestEmergencyShutdown === 'function') {
      void lifecycle.requestEmergencyShutdown({ exitCode: 1 }).catch(() => {
        app.exit(1);
      });
      return;
    }
    void Promise.resolve(stopRuntimeBeforeQuit())
      .catch(() => null)
      .finally(() => {
        app.exit(1);
      });
  }

  function registerGlobalCrashGuards() {
    if (crashGuardsRegistered) {
      return;
    }
    crashGuardsRegistered = true;
    processRef.on('uncaughtException', (error) => {
      requestEmergencyShutdown('uncaughtException', {
        event: 'process.uncaughtException',
        message: String(error && error.message || error),
        stack: String(error && error.stack || ''),
      });
    });
    processRef.on('unhandledRejection', (reason) => {
      requestEmergencyShutdown('unhandledRejection', {
        event: 'process.unhandledRejection',
        message: String(reason && reason.message || reason),
        stack: String(reason && reason.stack || ''),
      });
    });
  }

  function attachWindowCrashGuards(windowRef) {
    if (!windowRef || windowRef.isDestroyed()) {
      return;
    }
    windowRef.webContents.on('render-process-gone', (_event, details) => {
      const detail = details && typeof details === 'object' ? details : {};
      requestEmergencyShutdown('render-process-gone', {
        event: 'window.render_process_gone',
        reason: String(detail.reason || 'unknown'),
        exitCode: Number.isFinite(detail.exitCode) ? Number(detail.exitCode) : null,
        message: `Renderer process exited unexpectedly (${String(detail.reason || 'unknown')}).`,
      });
    });
    windowRef.on('unresponsive', () => {
      requestEmergencyShutdown('renderer-unresponsive', {
        event: 'window.unresponsive',
        message: 'Renderer became unresponsive.',
      });
    });
  }

  return {
    attachWindowCrashGuards,
    registerGlobalCrashGuards,
    resetForStartup,
    requestEmergencyShutdown,
  };
}

function createRendererDiagnosticsHandler(log) {
  return (_event, payload) => {
    log('ERROR', 'renderer.unhandled_error', normalizeRendererDiagnosticsDetails(payload));
    return { ok: true };
  };
}

module.exports = {
  createMainErrorHardening,
  createRendererDiagnosticsHandler,
};
