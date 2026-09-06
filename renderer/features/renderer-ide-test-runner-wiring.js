/* renderer/features/renderer-ide-test-runner-wiring.js — renderer composition for
 * the Workspace IDE bottom-panel "Test Runner" view. The panel itself is
 * render-only off a synchronous snapshot, but the bridge getState() is async — so
 * this wiring owns a cached state snapshot, keeps it fresh (an initial getState()
 * refresh, the workspaceTestRunner.onStateChanged push, and a re-fetch after each
 * config write), and routes the panel's run/abort/saveConfigs actions to the
 * bridge. The IDE controller constructs this once and injects render() as the
 * bottom panel's renderTestRunner (mirrors how renderRun routes to run-scripts).
 *
 * No child_process, no direct IPC: every side effect goes through the injected
 * window.jennyShell.workspaceTestRunner bridge, which is itself flag-gated in main
 * (a disabled feature resolves a no-op envelope, which this wiring ignores). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTestRunnerWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const EMPTY_STATE = { configs: [], history: { byConfig: {} }, activeRun: null, activeConfigId: null };

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function createIdeTestRunnerWiring(deps = {}) {
    const win = deps.windowRef || (typeof globalThis !== 'undefined' ? globalThis : {});
    const getApi = typeof deps.getApi === 'function'
      ? deps.getApi
      : () => (win.jennyShell && win.jennyShell.workspaceTestRunner) || null;
    const getMountEl = typeof deps.getMountEl === 'function' ? deps.getMountEl : () => null;
    const isActiveView = typeof deps.isActiveView === 'function' ? deps.isActiveView : () => false;
    const panelFactory = typeof deps.panelFactory === 'function'
      ? deps.panelFactory
      : (win.rendererIdeTestRunnerPanel && win.rendererIdeTestRunnerPanel.createIdeTestRunnerPanel) || null;
    const actionButton = typeof deps.actionButton === 'function'
      ? deps.actionButton
      : (typeof win.inventoryActionButton === 'function' ? win.inventoryActionButton : null);
    const textField = typeof deps.textField === 'function'
      ? deps.textField
      : (typeof win.inventoryTextField === 'function' ? win.inventoryTextField : null);
    const selectField = typeof deps.selectField === 'function'
      ? deps.selectField
      : (typeof win.inventorySelectField === 'function' ? win.inventorySelectField : null);
    const showShellErrorToast = typeof deps.showShellErrorToast === 'function' ? deps.showShellErrorToast : () => {};

    let cachedState = EMPTY_STATE;
    let loadedOnce = false;
    let unsubscribe = null;
    let disposed = false;

    // Await the bridge call, normalize thrown and typed failures into one
    // nonthrowing outcome shape, and always resolve.
    async function callMutation(fn, failureMessage) {
      if (disposed) {
        return { ok: false, code: '', message: failureMessage };
      }
      const api = getApi();
      if (!api) {
        return { ok: false, code: '', message: 'Test runner is unavailable.' };
      }
      try {
        const result = await fn(api);
        const obj = asObject(result);
        if (obj && obj.error) {
          return {
            ok: false,
            code: String(obj.error.code || ''),
            message: String(obj.error.message || failureMessage),
          };
        }
        return { ok: true, result };
      } catch (error) {
        return { ok: false, code: '', message: String(error?.message || error || failureMessage) };
      }
    }

    // Surfaces a failed run/abort as a toast (there is no optimistic UI state
    // for either to roll back — buildRow/buildActiveRunCard derive isRunning
    // purely from the canonical activeRun/activeConfigId, never a local
    // override — so awaiting + surfacing is the whole fix here).
    function callMutationAndToast(fn, failureMessage, dedupeKey) {
      return callMutation(fn, failureMessage).then((outcome) => {
        if (!outcome.ok) {
          showShellErrorToast(outcome.message, { title: 'Test Runner', dedupeKey });
        }
        return outcome;
      });
    }

    const panel = typeof panelFactory === 'function'
      ? panelFactory({
        getMountEl,
        getState: () => cachedState,
        actions: {
          runConfig: (configId) => callMutationAndToast(
            (api) => api.run({ configId }),
            'Could not start the test run.',
            `ide:test-runner:run:${configId}`
          ),
          abort: () => callMutationAndToast(
            (api) => api.abort(),
            'Could not stop the test run.',
            'ide:test-runner:abort'
          ),
          // WIDE-032: a typed result ({ok, configs} or {ok:false, code, message})
          // so the panel can roll back its optimistic composition baseline instead
          // of silently swallowing a refusal (e.g. CONFIG_ACTIVE_RUN) or a
          // rejected bridge call. A successful save re-fetches so the panel's
          // overlay is replaced by the canonical, normalized set the store wrote.
          saveConfigs: (configs) => {
            const api = getApi();
            if (!api || typeof api.saveConfigs !== 'function') {
              const unavailable = { ok: false, code: '', message: 'Test runner is unavailable.' };
              showShellErrorToast(unavailable.message, { title: 'Test Runner', dedupeKey: 'ide:test-runner:save' });
              return Promise.resolve(unavailable);
            }
            return Promise.resolve(api.saveConfigs(configs))
              .then((result) => {
                const obj = asObject(result);
                if (obj && obj.error) {
                  return {
                    ok: false,
                    code: String(obj.error.code || ''),
                    message: String(obj.error.message || 'Could not save the test configurations.'),
                  };
                }
                return refresh().then(() => ({
                  ok: true,
                  configs: obj && Array.isArray(obj.configs) ? obj.configs : configs,
                  // Entries the store dropped and why (invalid/duplicate id, ...),
                  // so the panel can say so instead of reporting a silent success.
                  rejected: obj && Array.isArray(obj.rejected) ? obj.rejected : [],
                }));
              })
              .catch((error) => ({
                ok: false,
                code: '',
                message: String(error?.message || error || 'Could not save the test configurations.'),
              }))
              // Normalized save failures are toasted after the panel receives
              // its rollback outcome.
              .then((outcome) => {
                if (!outcome.ok) {
                  showShellErrorToast(outcome.message, { title: 'Test Runner', dedupeKey: 'ide:test-runner:save' });
                }
                return outcome;
              });
          },
        },
        actionButton,
        textField,
        selectField,
      })
      : null;

    // Repaint only when the test-runner view is the active bottom-panel view — a
    // push that arrives while another view is showing must not clobber its host.
    function paintIfActive() {
      if (panel && isActiveView()) {
        panel.render();
      }
    }

    // Monotonic sequence bumped by every onStateChanged push. getState() is an
    // async round-trip, so a fetch ISSUED before a push can RESOLVE after it; the
    // seq lets such a stale snapshot be dropped instead of clobbering the fresher
    // push state (e.g. an optimistic 'started' badge).
    let stateSeq = 0;

    function refresh(clearRunningOnFail) {
      if (disposed) return Promise.resolve();
      const api = getApi();
      if (!api || typeof api.getState !== 'function') {
        return Promise.resolve();
      }
      const seqAtIssue = ++stateSeq;
      return Promise.resolve(api.getState())
        .then((next) => {
          // A newer push landed after this fetch was issued — its state is fresher
          // than this snapshot; drop the stale result.
          if (disposed || seqAtIssue !== stateSeq) {
            return;
          }
          const obj = asObject(next);
          // Ignore the disabled envelope (available:false) — keep the last good
          // cache rather than blanking the panel on a flag rollback.
          if (!obj || obj.available === false) {
            return;
          }
          cachedState = {
            configs: Array.isArray(obj.configs) ? obj.configs : [],
            history: asObject(obj.history) || { byConfig: {} },
            activeRun: obj.activeRun != null ? obj.activeRun : null,
            activeConfigId: obj.activeConfigId != null ? obj.activeConfigId : null,
          };
          loadedOnce = true;
          paintIfActive();
        })
        .catch(() => {
          // A failed terminal refresh clears the running badge unless a newer
          // push superseded it.
          if (clearRunningOnFail && seqAtIssue === stateSeq && cachedState.activeRun) {
            cachedState = { ...cachedState, activeRun: null, activeConfigId: null };
            paintIfActive();
          }
        });
    }

    // Live run-state push. 'started' badges the running config instantly (no
    // round-trip); 'finished' re-fetches to pull the completed run into the trend
    // and clear the badge; 'aborted' is informational — the finished follows.
    function handleStateChange(payload) {
      if (disposed) return;
      const src = asObject(payload);
      if (!src) {
        return;
      }
      // Every push supersedes any getState() already in flight (see stateSeq).
      stateSeq += 1;
      const phase = String(src.phase || '');
      if (phase === 'started') {
        cachedState = {
          ...cachedState,
          activeRun: src.runId != null ? src.runId : null,
          activeConfigId: src.configId != null ? src.configId : null,
        };
        paintIfActive();
        return;
      }
      if (phase === 'finished') {
        refresh(true);
      }
    }

    // Injected as the bottom panel's renderTestRunner; the bottom panel only calls
    // it when 'test-runner' is the active view, so painting the host here is safe.
    function render() {
      if (!panel) {
        return;
      }
      if (!loadedOnce) {
        // Warm the cache on first paint; refresh() repaints when it resolves.
        refresh();
      }
      panel.render();
    }

    function bindEvents() {
      if (disposed) return;
      if (panel) {
        panel.bindEvents();
      }
      const api = getApi();
      if (api && typeof api.onStateChanged === 'function' && !unsubscribe) {
        unsubscribe = api.onStateChanged(handleStateChange) || null;
      }
      refresh();
    }

    function dispose() {
      disposed = true;
      stateSeq += 1;
      if (typeof unsubscribe === 'function') {
        try {
          unsubscribe();
        } catch (_error) {
          /* best-effort unsubscribe */
        }
      }
      unsubscribe = null;
      if (panel) {
        panel.dispose();
      }
    }

    function resetForRoot() {
      if (disposed) return Promise.resolve();
      stateSeq += 1;
      cachedState = EMPTY_STATE;
      loadedOnce = false;
      return refresh();
    }

    return { render, bindEvents, dispose, refresh, resetForRoot };
  }

  return { createIdeTestRunnerWiring };
});
