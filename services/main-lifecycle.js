const DEFAULT_SHUTDOWN_TIMEOUT_MS = 15_000;
const MIN_SHUTDOWN_TIMEOUT_MS = 1_000;
const MAX_SHUTDOWN_TIMEOUT_MS = 120_000;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 200;

function normalizeShutdownTimeoutMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  }
  return Math.min(
    MAX_SHUTDOWN_TIMEOUT_MS,
    Math.max(MIN_SHUTDOWN_TIMEOUT_MS, Math.trunc(value))
  );
}

function boundedErrorMessage(error) {
  const message = String(error && error.message || error || 'unknown');
  const redacted = redactLogValue({ message }).message;
  return String(redacted).slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
}

class MainLifecycleController {
  constructor({
    appQuit,
    appExit,
    stopRuntime,
    onWillQuit = () => {},
    getPlatform = () => process.platform,
    shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    onEmergencyShutdown = () => {},
    log = () => {},
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    nowImpl = Date.now,
  }) {
    this._appQuit = typeof appQuit === 'function' ? appQuit : () => {};
    this._appExit = typeof appExit === 'function' ? appExit : () => {};
    this._stopRuntime = typeof stopRuntime === 'function' ? stopRuntime : async () => {};
    this._onWillQuit = typeof onWillQuit === 'function' ? onWillQuit : () => {};
    this._getPlatform = typeof getPlatform === 'function' ? getPlatform : () => process.platform;
    this._shutdownTimeoutMs = normalizeShutdownTimeoutMs(shutdownTimeoutMs);
    this._onEmergencyShutdown = typeof onEmergencyShutdown === 'function'
      ? onEmergencyShutdown
      : () => {};
    this._log = typeof log === 'function' ? log : () => {};
    this._setTimeout = typeof setTimeoutImpl === 'function' ? setTimeoutImpl : setTimeout;
    this._clearTimeout = typeof clearTimeoutImpl === 'function' ? clearTimeoutImpl : clearTimeout;
    this._now = typeof nowImpl === 'function' ? nowImpl : Date.now;
    this._shutdownPromise = null;
    this._shutdownExitCode = 0;
    this._isQuitting = false;
    this._shutdownFences = [];
    this._shutdownTasks = [];
    this._shutdownStage = 'idle';
    this._shutdownTaskIndex = null;
    this._emergencyShutdownTriggered = false;
    this._appExitTriggered = false;
  }

  isAppQuitting() {
    return this._isQuitting;
  }

  _beginShutdown(exitCode = 0) {
    if (this._shutdownPromise) {
      return this._shutdownPromise;
    }

    this._isQuitting = true;
    this._shutdownExitCode = Number.isInteger(exitCode) ? exitCode : 0;
    const startedAt = this._nowMs();
    const deadlineAt = Math.min(
      Number.MAX_SAFE_INTEGER,
      startedAt + this._shutdownTimeoutMs
    );
    const abortController = new AbortController();
    const shutdownContext = Object.freeze({
      signal: abortController.signal,
      deadlineAt,
    });

    // Publish the canonical promise before injected timers, shutdown tasks, or
    // runtime callbacks can synchronously re-enter the quit path.
    this._shutdownPromise = Promise.resolve()
      .then(() => this._coordinateShutdown(shutdownContext, abortController));
    this._runShutdownFences();

    return this._shutdownPromise;
  }

  async _coordinateShutdown(shutdownContext, abortController) {
    let timeoutHandle = null;
    let timeoutResolve;
    const timeoutPromise = new Promise((resolve) => {
      timeoutResolve = resolve;
    });

    try {
      timeoutHandle = this._setTimeout(() => {
        timeoutResolve({ status: 'timeout' });
      }, this._shutdownTimeoutMs);
    } catch (error) {
      this._safeLog('ERROR', 'app.shutdown_timer_failed', {
        message: boundedErrorMessage(error),
      });
      timeoutResolve({ status: 'timeout' });
    }

    const gracefulPromise = this._runGracefulShutdown(shutdownContext);
    const outcome = await Promise.race([gracefulPromise, timeoutPromise]);

    if (timeoutHandle !== null) {
      try {
        this._clearTimeout(timeoutHandle);
      } catch (_error) {
        // Timer cleanup is best-effort and must not prevent process exit.
      }
    }

    if (outcome.status === 'timeout') {
      abortController.abort();
      this._safeLog('WARN', 'app.shutdown_deadline_exceeded', {
        timeoutMs: this._shutdownTimeoutMs,
        phase: this._shutdownStage,
        taskIndex: this._shutdownTaskIndex,
      });
      this._invokeEmergencyShutdown('deadline_exceeded');
    } else if (outcome.status === 'runtime_failed') {
      this._invokeEmergencyShutdown('runtime_failed');
    }

    this._exitApp();
  }

  async _runGracefulShutdown(shutdownContext) {
    const tasksCompleted = await this._runShutdownTasks(shutdownContext);
    if (!tasksCompleted || shutdownContext.signal.aborted) {
      return { status: 'cancelled' };
    }

    this._shutdownStage = 'runtime';
    this._shutdownTaskIndex = null;
    try {
      await this._stopRuntime(shutdownContext);
    } catch (error) {
      if (!shutdownContext.signal.aborted) {
        this._safeLog('ERROR', 'app.runtime_shutdown_failed', {
          message: boundedErrorMessage(error),
        });
      }
      return { status: 'runtime_failed' };
    }

    if (shutdownContext.signal.aborted) {
      return { status: 'cancelled' };
    }
    this._shutdownStage = 'complete';
    return { status: 'complete' };
  }

  _invokeEmergencyShutdown(reason) {
    if (this._emergencyShutdownTriggered) {
      return;
    }
    this._emergencyShutdownTriggered = true;
    try {
      // This callback is deliberately synchronous: the graceful deadline has
      // expired (or runtime shutdown failed), so awaiting more work could hang.
      const result = this._onEmergencyShutdown({ reason });
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch((error) => {
          this._safeLog('ERROR', 'app.emergency_shutdown_failed', {
            message: boundedErrorMessage(error),
          });
        });
      }
    } catch (error) {
      this._safeLog('ERROR', 'app.emergency_shutdown_failed', {
        message: boundedErrorMessage(error),
      });
    }
  }

  _exitApp() {
    if (this._appExitTriggered) {
      return;
    }
    this._appExitTriggered = true;
    try {
      const result = this._appExit(this._shutdownExitCode);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch((error) => {
          this._safeLog('ERROR', 'app.exit_failed', {
            message: boundedErrorMessage(error),
          });
        });
      }
    } catch (error) {
      this._safeLog('ERROR', 'app.exit_failed', {
        message: boundedErrorMessage(error),
      });
    }
  }

  _nowMs() {
    try {
      const value = Number(this._now());
      return Number.isFinite(value) ? value : Date.now();
    } catch (_error) {
      return Date.now();
    }
  }

  _safeLog(level, event, details) {
    try {
      this._log(level, event, details);
    } catch (_error) {
      // Observability must not interrupt shutdown.
    }
  }

  handleBeforeQuit(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    return this._beginShutdown(0);
  }

  requestEmergencyShutdown({ exitCode = 1 } = {}) {
    return this._beginShutdown(exitCode);
  }

  registerShutdownTask(task) {
    if (typeof task !== 'function') {
      return () => {};
    }
    this._shutdownTasks.push(task);
    return () => {
      const index = this._shutdownTasks.indexOf(task);
      if (index >= 0) {
        this._shutdownTasks.splice(index, 1);
      }
    };
  }

  registerShutdownFence(fence) {
    if (typeof fence !== 'function') return () => {};
    this._shutdownFences.push(fence);
    return () => {
      const index = this._shutdownFences.indexOf(fence);
      if (index >= 0) this._shutdownFences.splice(index, 1);
    };
  }

  _runShutdownFences() {
    const fences = this._shutdownFences.splice(0);
    for (const fence of fences) {
      try { fence(); } catch (_error) { /* synchronous fences are best-effort */ }
    }
  }

  async _runShutdownTasks(shutdownContext) {
    const tasks = this._shutdownTasks.slice();
    this._shutdownStage = 'shutdown_tasks';
    for (let index = 0; index < tasks.length; index += 1) {
      if (shutdownContext.signal.aborted) {
        return false;
      }
      this._shutdownTaskIndex = index;
      try {
        await tasks[index](shutdownContext);
      } catch (error) {
        if (!shutdownContext.signal.aborted) {
          this._safeLog('WARN', 'app.shutdown_task_failed', {
            taskIndex: index,
            message: boundedErrorMessage(error),
          });
        }
      }
      if (shutdownContext.signal.aborted) {
        return false;
      }
    }
    this._shutdownTaskIndex = null;
    return true;
  }

  handleWillQuit() {
    this._onWillQuit();
  }

  handleWindowAllClosed() {
    if (this._getPlatform() !== 'darwin') {
      this._appQuit();
    }
  }
}

function registerMainProcessLifecycleHandlers(app, lifecycle) {
  app.on('before-quit', (event) => lifecycle.handleBeforeQuit(event));
  app.on('will-quit', () => lifecycle.handleWillQuit());
  app.on('window-all-closed', () => lifecycle.handleWindowAllClosed());
}

function registerMainWindowSessionEndHandlers(window, lifecycle) {
  window.on('query-session-end', (event) => lifecycle.handleBeforeQuit(event));
  window.on('session-end', () => lifecycle.requestEmergencyShutdown({ exitCode: 0 }));
}

// Platform notes for the handlers below:
//   - SIGINT: delivered on Ctrl+C on all platforms (Node emulates on Windows).
//   - SIGTERM: POSIX-only. Windows never delivers SIGTERM; the equivalent exit
//     paths there are app.on('before-quit') and window.on('query-session-end'),
//     wired by registerMainProcessLifecycleHandlers() and
//     registerMainWindowSessionEndHandlers() above. Both route to the same
//     handleBeforeQuit() entry point, so registering SIGTERM on Windows is a
//     harmless no-op.
//   - process.on('exit'): fires on normal exit only. Does NOT fire on SIGKILL
//     or OS-forced termination; crash-recovery relies on stale-state sweeps in
//     the per-process managers (see ollama-process-manager, vllm-process-manager)
//     on the next start().
function registerEmergencyShutdownHandlers(nodeProcess, {
  onExit,
  onSignal,
} = {}) {
  const handleExit = typeof onExit === 'function' ? onExit : () => {};
  const handleSignal = typeof onSignal === 'function' ? onSignal : () => {};

  nodeProcess.on('exit', () => {
    handleExit();
  });

  nodeProcess.once('SIGINT', () => {
    handleSignal('SIGINT');
  });
  nodeProcess.once('SIGTERM', () => {
    handleSignal('SIGTERM');
  });
}

module.exports = {
  MainLifecycleController,
  registerEmergencyShutdownHandlers,
  registerMainProcessLifecycleHandlers,
  registerMainWindowSessionEndHandlers,
};
const { redactLogValue } = require('./log-entry-normalizer');
