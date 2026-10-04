/* renderer/chat/renderer-window-controls-utils.js – the title bar's window
   cluster (minimize, maximize/restore, close) and the one guarded entry point
   for window actions (UMD).

   The cluster is bound by the shell itself at load (bindShellWindowControls),
   before any chat controller exists, so a controller failure never leaves a
   frameless window without working controls. Reload is not a tile: it is the
   palette's "Reload window" and the guarded Ctrl+Shift+R, both through
   reloadWindow() and so through invokeWindowControl(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWindowControlsUtils = factory();
  root.rendererWindowControlsUtils.autoBind(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function maximizeLabel(maximized) {
    return maximized ? jt('titlebar.window.restore', 'Restore') : jt('titlebar.window.maximize', 'Maximize');
  }

  // The maximize tile carries both glyphs; data-maximized picks the two
  // overlapping squares (restore) or the single square (maximize) in CSS.
  function applyWindowStateToControls(documentRef, state) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null);
    if (!doc || typeof doc.querySelector !== 'function') {
      return;
    }
    const maximizeButton = doc.querySelector('[data-window-action="maximize"]');
    if (!maximizeButton) {
      return;
    }
    const maximized = state && state.maximized === true;
    const label = maximizeLabel(maximized);
    maximizeButton.setAttribute('aria-label', label);
    maximizeButton.setAttribute('title', label);
    maximizeButton.dataset.maximized = maximized ? 'true' : 'false';
  }

  // True when the tile already shows `state` (glyph and label). An i18n
  // re-apply can rewrite the label under an unchanged state, so the dedupe in
  // syncWindowState asks the DOM rather than only the last state it applied.
  function controlsMatchState(documentRef, state) {
    const maximizeButton = documentRef?.querySelector?.('[data-window-action="maximize"]');
    if (!maximizeButton) {
      return true;
    }
    const maximized = state && state.maximized === true;
    return maximizeButton.dataset.maximized === (maximized ? 'true' : 'false')
      && maximizeButton.getAttribute('aria-label') === maximizeLabel(maximized);
  }

  // The window-exit dirty preflight: an injected fn wins (tests), else the
  // coordinator the shell service registry self-registers on the window.
  function resolveExitPreflight(win, preflightExit) {
    if (typeof preflightExit === 'function') {
      return preflightExit;
    }
    const api = win && win.jennyWindowExitPreflight;
    return api && typeof api.preflightExit === 'function'
      ? (action) => api.preflightExit(action)
      : null;
  }

  // The one guarded entry point for window actions. Close and reload run the
  // exit preflight first and stop unless it proceeds (a thrown preflight
  // aborts: fail closed rather than discard unsaved work); minimize and
  // maximize never preflight. Resolves the shell's window state, or null when
  // nothing ran. The title-bar tiles and reloadWindow() (Ctrl+Shift+R, the
  // palette's "Reload window") all come through here.
  async function invokeWindowControl(action, options = {}) {
    const win = options.windowRef || (typeof window !== 'undefined' ? window : null);
    const shell = options.shell || (win && win.jennyShell) || null;
    if (!shell || typeof shell.windowControl !== 'function') {
      return null;
    }
    if (action === 'close' || action === 'reload') {
      const runPreflight = resolveExitPreflight(win, options.preflightExit);
      if (runPreflight) {
        let outcome;
        try {
          outcome = await runPreflight(action);
        } catch (error) {
          if (typeof options.onPreflightError === 'function') {
            options.onPreflightError(error);
          }
          return null;
        }
        if (!outcome || outcome.proceed !== true) {
          return null;
        }
      }
    }
    return shell.windowControl(action);
  }

  function logWindowWarning(log, event, error, fallback) {
    if (typeof log === 'function') log('WARN', event, { message: error?.message || String(error || fallback) });
  }

  // The guarded reload for the routes outside the title bar (Ctrl+Shift+R,
  // the palette's "Reload window"). A thrown preflight is logged through the
  // client logger the app shell handed the cluster, exactly as the tiles log
  // it; never rejects.
  function reloadWindow({ windowRef, appendClientLog } = {}) {
    const win = windowRef || (typeof window !== 'undefined' ? window : null);
    const log = typeof appendClientLog === 'function'
      ? appendClientLog
      : (win && win.document && shellBindings.get(win.document)?.logger) || null;
    return Promise.resolve()
      .then(() => invokeWindowControl('reload', {
        windowRef: win,
        onPreflightError: (error) => logWindowWarning(log, 'window.exit_preflight_failed', error, 'Could not run exit preflight.'),
      }))
      .catch((error) => {
        logWindowWarning(log, 'window.control_failed', error, 'Could not update window state.');
        return null;
      });
  }

  // Only the drag gutter maximizes on double-click (the OS already handles
  // its own drag region): never a control, a live status, or anything else
  // that owns its own clicks.
  const DOUBLE_CLICK_EXCLUDED = 'button, a, input, select, textarea, [role="button"], [role="status"], [role="tab"], [role="tablist"], [role="group"], [data-window-action], [tabindex]';

  function bindWindowControlEvents({
    documentRef,
    windowRef,
    shell,
    registerListener,
    listenerOptions,
    addCleanup,
    appendClientLog,
    preflightExit,
  } = {}) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null);
    const win = windowRef || (typeof window !== 'undefined' ? window : null);
    const activeShell = shell || win?.jennyShell || null;
    if (!doc || !activeShell || typeof registerListener !== 'function') {
      return;
    }

    const logWarning = (event, error, fallback) => logWindowWarning(appendClientLog, event, error, fallback);
    let disposed = false;
    let seenNewerState = false;
    let lastStateKey = '';
    let lastState = null;
    const stateKey = (state) => `${state?.ok === true}:${state?.maximized === true}:${state?.minimized === true}`;
    const syncWindowState = (state, { newer = false } = {}) => {
      if (disposed) {
        return;
      }
      if (newer) {
        seenNewerState = true;
      }
      lastState = state;
      const nextKey = stateKey(state);
      if (nextKey === lastStateKey && controlsMatchState(doc, state)) {
        return;
      }
      lastStateKey = nextKey;
      applyWindowStateToControls(doc, state);
    };
    const runWindowControl = async (action) => {
      try {
        const result = await invokeWindowControl(action, {
          windowRef: win,
          shell: activeShell,
          preflightExit,
          onPreflightError: (error) => logWarning('window.exit_preflight_failed', error, 'Could not run exit preflight.'),
        });
        if (result) syncWindowState(result, { newer: true });
      } catch (error) {
        logWarning('window.control_failed', error, 'Could not update window state.');
      }
    };
    const shellWindow = activeShell.window && typeof activeShell.window === 'object'
      ? activeShell.window
      : null;
    // The maximize tile's label is state-owned: localize it now, before the
    // first state read resolves.
    applyWindowStateToControls(doc, {
      maximized: doc.querySelector('[data-window-action="maximize"]')?.dataset.maximized === 'true',
    });

    if (typeof addCleanup === 'function') {
      addCleanup(() => {
        disposed = true;
      });
    }
    if (shellWindow && typeof shellWindow.onStateChanged === 'function') {
      const unsubscribe = shellWindow.onStateChanged((state) => {
        syncWindowState(state, { newer: true });
      });
      if (typeof addCleanup === 'function') addCleanup(unsubscribe);
    }
    if (shellWindow && typeof shellWindow.getState === 'function') {
      Promise.resolve(shellWindow.getState())
        .then((state) => {
          if (!seenNewerState) {
            syncWindowState(state);
          }
        })
        .catch((error) => {
          logWarning('window.state_sync_failed', error, 'Could not read window state.');
        });
    }

    doc.querySelectorAll('[data-window-action]').forEach((button) => {
      registerListener(button, 'click', () => {
        return runWindowControl(button.dataset.windowAction);
      }, listenerOptions);
    });

    registerListener(doc.querySelector('.titlebar'), 'dblclick', (event) => {
      const excluded = event.target && typeof event.target.closest === 'function'
        ? event.target.closest(DOUBLE_CLICK_EXCLUDED)
        : null;
      if (excluded) {
        return;
      }
      event.preventDefault();
      runWindowControl('maximize');
    }, listenerOptions);

    // The static i18n pass (data-i18n-*) rewrites the maximize tile's label to
    // "Maximize" whatever the state; a later state event, or this resync,
    // restores the state-owned label from the last state seen.
    return {
      resync() {
        applyWindowStateToControls(doc, lastState || {
          maximized: doc.querySelector('[data-window-action="maximize"]')?.dataset.maximized === 'true',
        });
      },
    };
  }

  // Shell-level binding: once per document, independent of the chat
  // controllers. The app shell calls it again at bootstrap to hand over its
  // client logger; later calls only update the logger.
  const shellBindings = new WeakMap();

  function bindShellWindowControls({ documentRef, windowRef, appendClientLog } = {}) {
    const doc = documentRef || (typeof document !== 'undefined' ? document : null);
    const win = windowRef || (doc && doc.defaultView) || (typeof window !== 'undefined' ? window : null);
    if (!doc || !win || !win.jennyShell) {
      return null;
    }
    const existing = shellBindings.get(doc);
    if (existing) {
      if (typeof appendClientLog === 'function') existing.logger = appendClientLog;
      return existing;
    }
    const binding = { logger: typeof appendClientLog === 'function' ? appendClientLog : null, controls: null };
    binding.controls = bindWindowControlEvents({
      documentRef: doc,
      windowRef: win,
      registerListener: (target, type, handler, options) => target?.addEventListener?.(type, handler, options),
      appendClientLog: (...args) => binding.logger?.(...args),
    }) || null;
    shellBindings.set(doc, binding);
    // Deferred scripts run before DOMContentLoaded, where i18n-bootstrap applies
    // the static labels: re-apply the state-owned one after that pass.
    doc.addEventListener?.('DOMContentLoaded', () => binding.controls?.resync(), { once: true });
    return binding;
  }

  // Browser load: the markup is parsed before this deferred script runs.
  function autoBind(rootRef) {
    const doc = rootRef && rootRef.document;
    if (!doc || typeof doc.querySelector !== 'function' || !doc.querySelector('.window-controls')) {
      return;
    }
    bindShellWindowControls({ documentRef: doc, windowRef: rootRef });
  }

  return {
    applyWindowStateToControls,
    bindShellWindowControls,
    bindWindowControlEvents,
    invokeWindowControl,
    reloadWindow,
    autoBind,
  };
});
