class MainLifecycleController {
  constructor({
    appQuit,
    appExit,
    stopRuntime,
    onWillQuit = () => {},
    getPlatform = () => process.platform,
  }) {
    this._appQuit = typeof appQuit === 'function' ? appQuit : () => {};
    this._appExit = typeof appExit === 'function' ? appExit : () => {};
    this._stopRuntime = typeof stopRuntime === 'function' ? stopRuntime : async () => {};
    this._onWillQuit = typeof onWillQuit === 'function' ? onWillQuit : () => {};
    this._getPlatform = typeof getPlatform === 'function' ? getPlatform : () => process.platform;
    this._shutdownPromise = null;
    this._shutdownExitCode = 0;
    this._isQuitting = false;
    this._shutdownTasks = [];
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

    this._shutdownPromise = (async () => {
      try {
        await this._runShutdownTasks();
        await this._stopRuntime();
      } finally {
        this._appExit(this._shutdownExitCode);
      }
    })();

    return this._shutdownPromise;
  }

  async handleBeforeQuit(event) {
    if (event && typeof event.preventDefault === 'function') {
      event.preventDefault();
    }
    return this._beginShutdown(0);
  }

  async requestEmergencyShutdown({ exitCode = 1 } = {}) {
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

  async _runShutdownTasks() {
    const tasks = this._shutdownTasks.slice();
    for (const task of tasks) {
      try {
        await task();
      } catch (_error) {
        /* shutdown tasks are best-effort; runtime shutdown still owns exit */
      }
    }
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
