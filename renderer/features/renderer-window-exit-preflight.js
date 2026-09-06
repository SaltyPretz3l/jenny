/* renderer/features/renderer-window-exit-preflight.js
 *
 * Window-exit dirty-buffer coordinator (UIUX-003). Every renderer-initiated or
 * native destructive window transition — the custom title-bar Close/Reload, an
 * update "Restart and Install", and the native OS X — runs through
 * preflightExit() so open dirty Workspace IDE buffers get one batched
 * Save / Don't Save / Cancel prompt (reusing the existing close orchestrator +
 * confirm dialog) instead of being discarded silently.
 *
 * The orchestrator preflight is non-destructive:
 *   - 'save'    awaits every open file with per-file failure isolation; a single
 *               failed save cancels the whole exit and names the file.
 *   - 'discard' proceeds without saving.
 *   - Cancel / Esc / scrim block the exit (proceed:false).
 *
 * The ready plan is deliberately NOT committed. The frame is about to be
 * destroyed (close) or rebuilt (reload); force-closing the tabs would only drop
 * the open-tab set on reload even though the files were already saved during
 * preflight. We release the plan via cancel() instead. Saves already happened,
 * so nothing is lost.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWindowExitPreflight = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function basename(path) {
    const str = String(path || '');
    const slash = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'));
    return slash === -1 ? str : str.slice(slash + 1);
  }

  function createWindowExitPreflight(deps) {
    const options = deps || {};
    const rootRef = options.root || (typeof globalThis !== 'undefined' ? globalThis : {});
    const getCloseOrchestrator = typeof options.getCloseOrchestrator === 'function'
      ? options.getCloseOrchestrator
      : () => null;
    const getShell = typeof options.getShell === 'function'
      ? options.getShell
      : () => (rootRef && rootRef.jennyShell) || null;
    const showToast = typeof options.showToast === 'function' ? options.showToast : () => {};
    const appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : () => {};

    function resolveOrchestrator() {
      try {
        const orch = getCloseOrchestrator();
        return orch && typeof orch.preflight === 'function' ? orch : null;
      } catch (_error) {
        return null;
      }
    }

    async function preflightExit(action) {
      // A session-bound plugin view may own a supervised native process. The
      // renderer does not acknowledge exit until main proves teardown complete.
      const pluginSessions = rootRef.rendererPluginSessions?.instance || null;
      const activePluginSessionId = pluginSessions?.getActiveSessionId?.() || '';
      if (pluginSessions && activePluginSessionId) {
        let allowExit;
        try {
          allowExit = await pluginSessions.guardLeaveSession(
            activePluginSessionId, `window_${String(action || 'close')}`,
          );
        } catch (_error) {
          allowExit = false;
        }
        if (!allowExit) {
          return { proceed: false, reason: 'plugin_session_active' };
        }
      }
      const orch = resolveOrchestrator();
      if (!orch) {
        // No IDE controller mounted → there is nothing to lose. Fail open.
        return { proceed: true, reason: 'no_ide' };
      }
      let dirty;
      try {
        dirty = typeof orch.getDirtyPaths === 'function' ? orch.getDirtyPaths() : [];
      } catch (_error) {
        dirty = [];
      }
      if (!Array.isArray(dirty) || dirty.length === 0) {
        // Cheap check: no dirty tabs, so no prompt.
        return { proceed: true, reason: 'clean' };
      }
      let paths;
      try {
        paths = typeof orch.openTabPaths === 'function' ? orch.openTabPaths() : dirty;
      } catch (_error) {
        paths = dirty;
      }
      let plan;
      try {
        plan = await orch.preflight(paths);
      } catch (error) {
        appendClientLog('WARN', 'window.exit_preflight_error', {
          action: String(action || ''),
          message: String((error && error.message) || error || ''),
        });
        // A thrown preflight is the safe-to-block case: abort the exit rather
        // than risk silently discarding unsaved buffers.
        return { proceed: false, reason: 'preflight_error' };
      }
      if (!plan || plan.ready !== true) {
        if (plan && plan.code === 'save_failed') {
          const file = basename(plan.failedPath || '');
          showToast(`Couldn’t save “${file}”. Canceled so you don’t lose changes.`);
          return { proceed: false, reason: 'save_failed', failedPath: plan.failedPath || '' };
        }
        return {
          proceed: false,
          reason: (plan && (plan.canceled ? 'canceled' : plan.code)) || 'canceled',
        };
      }
      // Ready. Saves (if any) already happened during preflight; release the
      // plan WITHOUT committing (see the module header for why the frame's tabs
      // are not force-closed on exit/reload).
      try {
        if (typeof orch.cancel === 'function') {
          orch.cancel(plan);
        }
      } catch (_error) {
        /* best-effort release */
      }
      return { proceed: true, reason: plan.decision || 'ready' };
    }

    let unsubscribe = null;
    let bound = false;

    async function handleNativeCloseRequest(payload) {
      const requestId = String((payload && payload.requestId) || '');
      const shell = getShell();
      const respond = shell && shell.window && typeof shell.window.respondExitPreflight === 'function'
        ? shell.window.respondExitPreflight
        : null;
      // Ack IMMEDIATELY — before the (potentially minutes-long) interactive
      // Save / Don't Save / Cancel dialog — so the main-side guard can cancel
      // its fail-open timer. Without this, the guard cannot tell "human at
      // the dialog" from "wedged renderer" and force-closes at timeoutMs,
      // discarding the buffers the preflight exists to protect. Fire-and-
      // forget: the ack must never delay or gate the dialog itself.
      if (respond) {
        try {
          Promise.resolve(respond({ requestId, ack: true })).catch(() => {});
        } catch (_error) {
          /* an unsendable ack degrades to the old timer behavior */
        }
      }
      let proceed;
      try {
        const result = await preflightExit('close');
        proceed = Boolean(result && result.proceed === true);
      } catch (_error) {
        proceed = false;
      }
      if (!respond) {
        return;
      }
      try {
        await respond({ requestId, proceed });
      } catch (error) {
        appendClientLog('WARN', 'window.exit_preflight_respond_failed', {
          message: String((error && error.message) || error || ''),
        });
      }
    }

    function bind() {
      if (bound) {
        return dispose;
      }
      bound = true;
      const shell = getShell();
      const onRequest = shell && shell.window && typeof shell.window.onExitPreflightRequest === 'function'
        ? shell.window.onExitPreflightRequest
        : null;
      if (onRequest) {
        try {
          unsubscribe = onRequest((payload) => { handleNativeCloseRequest(payload); });
        } catch (_error) {
          unsubscribe = null;
        }
      }
      return dispose;
    }

    function dispose() {
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe();
        } catch (_error) {
          /* best-effort */
        }
      }
      unsubscribe = null;
      bound = false;
    }

    return { preflightExit, bind, dispose };
  }

  return { createWindowExitPreflight };
});
