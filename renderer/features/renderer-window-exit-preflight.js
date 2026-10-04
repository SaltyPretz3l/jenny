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
 * The action ('close' | 'reload' | 'update-restart') flows into the prompt as
 * its intent so the copy says what is about to happen. Non-IDE editors with
 * unsaved state (Settings > Memory long-term notes, Personality) register with
 * the dirty-surface registry below and join the SAME prompt; on Save each
 * surface's save runs after the IDE buffers, and one failure cancels the exit.
 * No beforeunload handler may cancel an unload: this preflight is the only
 * guard, and main treats a prevented unload as a stray handler.
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
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function basename(path) {
    const str = String(path || '');
    const slash = Math.max(str.lastIndexOf('/'), str.lastIndexOf('\\'));
    return slash === -1 ? str : str.slice(slash + 1);
  }

  const EXIT_INTENTS = ['close', 'reload', 'update-restart'];

  function normalizeIntent(action) {
    const value = String(action || 'close');
    return EXIT_INTENTS.indexOf(value) === -1 ? 'close' : value;
  }

  // Dirty-surface registry: register({ id, label, isDirty, save }) returns an
  // unregister function; listDirty() returns the surfaces with unsaved state.
  // `save` must resolve true on success. Re-registering an id replaces the
  // older entry (an editor rebuilt without dispose never leaves a ghost).
  function createDirtySurfaceRegistry() {
    const surfaces = new Map();

    function register(spec) {
      const s = spec || {};
      const id = String(s.id || '');
      if (!id || typeof s.isDirty !== 'function' || typeof s.save !== 'function') {
        return function noopUnregister() {};
      }
      const entry = { id, label: String(s.label || id), isDirty: s.isDirty, save: s.save };
      surfaces.set(id, entry);
      return function unregister() {
        if (surfaces.get(id) === entry) {
          surfaces.delete(id);
        }
      };
    }

    function listDirty() {
      const dirty = [];
      for (const entry of surfaces.values()) {
        let isDirty;
        try {
          isDirty = entry.isDirty() === true;
        } catch (_error) {
          isDirty = false;
        }
        if (isDirty) {
          dirty.push({ id: entry.id, label: entry.label, save: entry.save });
        }
      }
      return dirty;
    }

    return { register, listDirty };
  }

  const dirtySurfaces = createDirtySurfaceRegistry();

  function surfaceLabels(surfaces) {
    return surfaces.map(({ id, label }) => ({ id, label }));
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
    const registry = options.dirtySurfaces && typeof options.dirtySurfaces.listDirty === 'function'
      ? options.dirtySurfaces
      : dirtySurfaces;
    const getConfirmDialog = typeof options.getConfirmDialog === 'function'
      ? options.getConfirmDialog
      : defaultConfirmDialog;
    let fallbackDialog = null;

    // Used only when no IDE controller is mounted but a registered surface is
    // dirty: the same confirm dialog, on its own overlay host.
    function defaultConfirmDialog() {
      if (fallbackDialog) {
        return fallbackDialog;
      }
      const factory = rootRef.rendererIdeConfirmDialog && rootRef.rendererIdeConfirmDialog.createIdeConfirmDialog;
      const overlay = rootRef.inventoryHelpOverlay && rootRef.inventoryHelpOverlay.createHelpOverlay;
      if (typeof factory !== 'function' || typeof overlay !== 'function') {
        return null;
      }
      fallbackDialog = factory({
        document: rootRef.document || null,
        actionButton: typeof rootRef.inventoryActionButton === 'function' ? rootRef.inventoryActionButton : null,
        helpOverlayFactory: overlay,
        hostId: 'windowExitConfirmOverlay',
      }) || null;
      return fallbackDialog;
    }

    function listDirtySurfaces() {
      try {
        const listed = registry.listDirty();
        return Array.isArray(listed) ? listed : [];
      } catch (_error) {
        return [];
      }
    }

    // Save each dirty surface in order; the first failure (false, or a throw)
    // stops the batch and cancels the exit.
    async function saveSurfaces(surfaces) {
      for (const surface of surfaces) {
        let saved;
        try {
          saved = await surface.save() === true;
        } catch (_error) {
          saved = false;
        }
        if (!saved) {
          showToast(jt('window.exit.surfaceSaveFailed', 'Couldn’t save {label}. Canceled so you don’t lose changes.', { label: surface.label }));
          return { proceed: false, reason: 'save_failed', failedSurface: surface.id };
        }
      }
      return null;
    }

    async function promptWithoutIde(intent, surfaces) {
      let dialog;
      try {
        dialog = getConfirmDialog();
      } catch (_error) {
        dialog = null;
      }
      let decision = 'cancel';
      if (dialog && typeof dialog.confirmClose === 'function') {
        try {
          decision = await dialog.confirmClose({ dirtyPaths: [], surfaces: surfaceLabels(surfaces), intent });
        } catch (_error) {
          decision = 'cancel';
        }
      }
      if (decision !== 'save' && decision !== 'discard') {
        return { proceed: false, reason: 'canceled' };
      }
      const failed = decision === 'save' ? await saveSurfaces(surfaces) : null;
      return failed || { proceed: true, reason: decision };
    }

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
      const intent = normalizeIntent(action);
      const surfaces = listDirtySurfaces();
      const orch = resolveOrchestrator();
      if (!orch) {
        // No IDE controller mounted: only registered surfaces can hold
        // unsaved state. Nothing dirty -> nothing to lose. Fail open.
        return surfaces.length ? promptWithoutIde(intent, surfaces) : { proceed: true, reason: 'no_ide' };
      }
      let dirty;
      try {
        dirty = typeof orch.getDirtyPaths === 'function' ? orch.getDirtyPaths() : [];
      } catch (_error) {
        dirty = [];
      }
      if ((!Array.isArray(dirty) || dirty.length === 0) && surfaces.length === 0) {
        // Cheap check: no dirty tabs or surfaces, so no prompt.
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
        plan = await orch.preflight(paths, { intent, surfaces: surfaceLabels(surfaces) });
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
          showToast(jt('ide.monaco.exitSaveFailed', 'Couldn’t save “{file}”. Canceled so you don’t lose changes.', { file }));
          return { proceed: false, reason: 'save_failed', failedPath: plan.failedPath || '' };
        }
        return {
          proceed: false,
          reason: (plan && (plan.canceled ? 'canceled' : plan.code)) || 'canceled',
        };
      }
      // IDE buffers were saved during preflight; the surfaces save now. Either
      // way release the plan WITHOUT committing (see the module header for why
      // the frame's tabs are not force-closed on exit/reload).
      const failed = plan.decision === 'save' ? await saveSurfaces(surfaces) : null;
      try {
        if (typeof orch.cancel === 'function') {
          orch.cancel(plan);
        }
      } catch (_error) {
        /* best-effort release */
      }
      return failed || { proceed: true, reason: plan.decision || 'ready' };
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

  return { createWindowExitPreflight, createDirtySurfaceRegistry, dirtySurfaces };
});
