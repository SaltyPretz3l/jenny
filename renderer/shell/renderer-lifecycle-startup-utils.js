(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLifecycleStartupUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createDeferredVisualStartupController(deps) {
    const settings = deps || {};
    const windowObject = settings.window || (typeof window !== 'undefined' ? window : null);
    const fwd = settings.fwd || {};
    const appendClientLog = typeof settings.appendClientLog === 'function'
      ? settings.appendClientLog
      : function noopAppendClientLog() {};
    const getElapsedMs = typeof settings.getElapsedMs === 'function'
      ? settings.getElapsedMs
      : function fallbackGetElapsedMs() { return 0; };
    let rendererFirstRenderLogged = false;
    let deferredVisualStartupScheduled = false;
    let deferredVisualStartupComplete = false;
    let deferredVisualStartupIdleHandle = 0;
    let deferredVisualStartupTimeoutHandle = 0;
    let lifecycleDisposed = false;

    function noteFirstRenderComplete() {
      if (rendererFirstRenderLogged) {
        return;
      }
      rendererFirstRenderLogged = true;
      appendClientLog('INFO', 'renderer.first_render_complete', {
        elapsedMs: getElapsedMs(),
      });
    }

    function runDeferredVisualStartup() {
      if (deferredVisualStartupComplete || lifecycleDisposed) {
        return;
      }
      appendClientLog('INFO', 'renderer.visual_startup_begin', {
        elapsedMs: getElapsedMs(),
      });
      fwd.initializeComposerHolo?.();
      fwd.initializeSpriteHolo?.();
      // Chromium may restore textarea contents during a shell reload without
      // dispatching an input event. Recompute the active/typing state after
      // the holo canvases exist so a restored draft does not keep only the
      // subdued passive composer ring until the next user interaction.
      fwd.syncComposerVisualState?.();
      fwd.initializeComposerLayoutObserver?.();
      Promise.resolve(fwd.warmCodeHighlighting?.()).catch(() => {});
      deferredVisualStartupComplete = true;
      appendClientLog('INFO', 'renderer.visual_startup_complete', {
        elapsedMs: getElapsedMs(),
      });
    }

    function scheduleDeferredVisualStartup() {
      if (deferredVisualStartupScheduled || deferredVisualStartupComplete || lifecycleDisposed) {
        return;
      }
      deferredVisualStartupScheduled = true;
      const run = () => {
        deferredVisualStartupIdleHandle = 0;
        deferredVisualStartupTimeoutHandle = 0;
        if (lifecycleDisposed) { return; }
        runDeferredVisualStartup();
      };
      if (windowObject && typeof windowObject.requestIdleCallback === 'function') {
        deferredVisualStartupIdleHandle = windowObject.requestIdleCallback(run, { timeout: 400 }) || 0;
        return;
      }
      if (windowObject && typeof windowObject.setTimeout === 'function') {
        deferredVisualStartupTimeoutHandle = windowObject.setTimeout(run, 32);
      }
    }

    function disposeLifecycleController() {
      if (lifecycleDisposed) { return; }
      lifecycleDisposed = true;
      fwd.disposeCodeHighlighting?.();
      if (deferredVisualStartupIdleHandle && windowObject && typeof windowObject.cancelIdleCallback === 'function') {
        try { windowObject.cancelIdleCallback(deferredVisualStartupIdleHandle); } catch (_error) {
          // Best-effort cleanup during renderer teardown.
        }
      }
      deferredVisualStartupIdleHandle = 0;
      if (deferredVisualStartupTimeoutHandle && windowObject && typeof windowObject.clearTimeout === 'function') {
        try { windowObject.clearTimeout(deferredVisualStartupTimeoutHandle); } catch (_error) {
          // Best-effort cleanup during renderer teardown.
        }
      }
      deferredVisualStartupTimeoutHandle = 0;
    }

    return {
      disposeLifecycleController,
      noteFirstRenderComplete,
      runDeferredVisualStartup,
      scheduleDeferredVisualStartup,
    };
  }

  return {
    createDeferredVisualStartupController,
  };
});
