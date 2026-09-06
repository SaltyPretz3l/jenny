(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWindowControlsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
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
    const label = maximized ? 'Restore window' : 'Maximize window';
    maximizeButton.setAttribute('aria-label', label);
    maximizeButton.setAttribute('title', label);
    maximizeButton.textContent = maximized ? '❐' : '□';
  }

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

    const logWarning = (event, error, fallback) => {
      if (typeof appendClientLog !== 'function') {
        return;
      }
      appendClientLog('WARN', event, {
        message: error?.message || String(error || fallback),
      });
    };
    let disposed = false;
    let seenNewerState = false;
    let lastStateKey = '';
    const stateKey = (state) => `${state?.ok === true}:${state?.maximized === true}:${state?.minimized === true}`;
    const syncWindowState = (state, { newer = false } = {}) => {
      if (disposed) {
        return;
      }
      if (newer) {
        seenNewerState = true;
      }
      const nextKey = stateKey(state);
      if (nextKey === lastStateKey) {
        return;
      }
      lastStateKey = nextKey;
      applyWindowStateToControls(doc, state);
    };
    // Resolve the window-exit dirty-buffer preflight lazily: an injected fn wins
    // (tests), else the coordinator self-registered on the window global. Only
    // the destructive controls (close/reload) gate on it; minimize/maximize are
    // untouched.
    const resolveExitPreflight = () => {
      if (typeof preflightExit === 'function') {
        return preflightExit;
      }
      const api = win && win.jennyWindowExitPreflight;
      return api && typeof api.preflightExit === 'function'
        ? (action) => api.preflightExit(action)
        : null;
    };
    const invokeWindowControl = async (action) => {
      if (typeof activeShell.windowControl !== 'function') {
        return;
      }
      if (action === 'close' || action === 'reload') {
        const runPreflight = resolveExitPreflight();
        if (runPreflight) {
          let outcome;
          try {
            outcome = await runPreflight(action);
          } catch (error) {
            // A thrown preflight aborts the destructive action rather than risk
            // discarding unsaved buffers.
            logWarning('window.exit_preflight_failed', error, 'Could not run exit preflight.');
            return;
          }
          if (!outcome || outcome.proceed !== true) {
            return;
          }
        }
      }
      try {
        const result = await activeShell.windowControl(action);
        syncWindowState(result, { newer: true });
      } catch (error) {
        logWarning('window.control_failed', error, 'Could not update window state.');
      }
    };
    const shellWindow = activeShell.window && typeof activeShell.window === 'object'
      ? activeShell.window
      : null;

    if (typeof addCleanup === 'function') {
      addCleanup(() => {
        disposed = true;
      });
    }
    if (shellWindow && typeof shellWindow.onStateChanged === 'function' && typeof addCleanup === 'function') {
      addCleanup(shellWindow.onStateChanged((state) => {
        syncWindowState(state, { newer: true });
      }));
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
        return invokeWindowControl(button.dataset.windowAction);
      }, listenerOptions);
    });

    registerListener(doc.querySelector('.titlebar'), 'dblclick', (event) => {
      const interactiveTarget = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('button, a, input, select, textarea, [role="button"], [data-window-action]')
        : null;
      if (interactiveTarget) {
        return;
      }
      event.preventDefault();
      invokeWindowControl('maximize');
    }, listenerOptions);
  }

  return {
    applyWindowStateToControls,
    bindWindowControlEvents,
  };
});
