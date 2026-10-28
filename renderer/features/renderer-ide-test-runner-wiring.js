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
 * (a disabled feature resolves a no-op envelope, which this wiring records as
 * "unavailable" so the host can hide the tab; it never blanks the cached configs). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTestRunnerWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const EMPTY_STATE = { configs: [], history: { byConfig: {} }, activeRun: null, activeConfigId: null };
  // abortRun answers that mean the activity path itself is off: Stop falls back to api.abort().
  const ABORT_FALLBACK_REASONS = new Set(['feature_disabled', 'source_unavailable', 'invalid_request', 'invalid_scope', 'scope_unavailable']);
  // ... and the ones that mean the run already ended (nothing left to stop, nothing to report).
  const ABORT_ENDED_REASONS = new Set(['not_found', 'not_active', 'stale_run']);
  const WORKSPACE_SCOPE = Object.freeze({ kind: 'workspace' });

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
    const onAvailabilityChange = typeof deps.onAvailabilityChange === 'function' ? deps.onAvailabilityChange : () => {};
    // F6: "Show output" on a row (the host selects the config + reveals the test-output view),
    // and a heads-up that a config's kept output changed (the host repaints that view).
    const onShowOutput = typeof deps.onShowOutput === 'function' ? deps.onShowOutput : () => {};
    const onOutputChange = typeof deps.onOutputChange === 'function' ? deps.onOutputChange : () => {};
    // An explicit run request from this window, before it starts (the host decides whether its output follows).
    const onRunRequest = typeof deps.onRunRequest === 'function' ? deps.onRunRequest : () => {};

    let cachedState = EMPTY_STATE;
    // Availability is tracked apart from the cached state: a feature_disabled
    // envelope keeps the last good configs but marks the runner unavailable.
    let available = true;
    // Most recent run output per config, in memory only (oldest evicted at the cap).
    const RUN_OUTPUT_CAP = 8;
    const lastRunOutput = new Map();
    let loadedOnce = false;
    // Bumped by resetForRoot: a run answer from the old root is dropped.
    let rootEpoch = 0;
    let unsubscribe = null;
    let unsubscribeFeatures = null;
    let disposed = false;

    // Await the bridge call, normalize thrown and typed failures into one
    // nonthrowing outcome shape, and always resolve.
    async function callMutation(fn, failureMessage) {
      if (disposed) {
        return { ok: false, code: '', message: failureMessage };
      }
      const api = getApi();
      if (!api) {
        return { ok: false, code: '', message: jt('ide.testRunner.unavailable', 'Test runner is unavailable.') };
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
        if (obj && obj.available === false) return disabledOutcome(obj);
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
          showShellErrorToast(outcome.message, { title: jt('ide.testRunner.title', 'Test Runner'), dedupeKey });
        }
        return outcome;
      });
    }

    // A main-process refusal because the feature is off (flag flipped live):
    // report it, and hide the tab when the reason is feature_disabled.
    function disabledOutcome(obj) {
      if (obj.reason === 'feature_disabled') setAvailable(false);
      return { ok: false, code: String(obj.reason || 'feature_disabled'), message: jt('ide.testRunner.disabled', 'Test running is turned off.') };
    }

    function setAvailable(next) {
      if (available === next) return;
      available = next;
      onAvailabilityChange(next);
    }

    function recordRunOutput(result) {
      const obj = asObject(result);
      if (!obj || obj.error || obj.available === false || typeof obj.runId !== 'string' || !obj.runId) {
        return;
      }
      const configId = String(obj.configId || '');
      lastRunOutput.delete(configId);
      lastRunOutput.set(configId, {
        configId,
        runId: obj.runId,
        status: String(obj.status || ''),
        exitCode: obj.exitCode != null ? obj.exitCode : null,
        stdoutTail: String(obj.stdoutTail || ''),
        stderrTail: String(obj.stderrTail || ''),
        finishedAt: obj.finishedAt != null ? obj.finishedAt : null,
      });
      while (lastRunOutput.size > RUN_OUTPUT_CAP) {
        lastRunOutput.delete(lastRunOutput.keys().next().value);
      }
      paintIfActive(); // the row's Show output action tracks the kept output
      onOutputChange(configId);
    }

    const stopFailedMessage = () => jt('ide.testRunner.stopFailed', 'Could not stop the test run.');

    // Stop through the waiting activity IPC (abortAndWait: resolves once the process tree is
    // dead). Resolves { activityAbort: 'aborted' | 'ended' | 'fallback' }; throws on any other
    // failure so callMutation turns it into the stop-failed toast. A stale epoch retries once.
    async function abortViaActivity(api, runId) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const snapshot = asObject(await win.jennyShell.activity.getSnapshot({ schema_version: 1, scope: WORKSPACE_SCOPE, epoch: '', after_revision: 0 }));
        if (!snapshot || snapshot.available === false || typeof snapshot.epoch !== 'string') return { activityAbort: 'fallback' };
        const result = asObject(await api.abortRun({ schema_version: 1, scope: WORKSPACE_SCOPE, epoch: snapshot.epoch, activity_id: `test:${runId}` }));
        if (result && result.aborted === true) return { activityAbort: 'aborted' };
        const reason = String((result && result.reason) || '');
        if (reason === 'stale_epoch' && attempt === 0) continue;
        if (ABORT_ENDED_REASONS.has(reason)) return { activityAbort: 'ended' };
        if (ABORT_FALLBACK_REASONS.has(reason)) return { activityAbort: 'fallback' };
        if (result && !reason && result.aborted === false && result.terminationConfirmed !== false) return { activityAbort: 'ended' };
        break;
      }
      throw new Error(stopFailedMessage());
    }

    let abortInFlight = null;

    async function abortActiveRun() {
      const api = getApi();
      const runId = cachedState.activeRun;
      if (api && typeof api.abortRun === 'function' && typeof win.jennyShell?.activity?.getSnapshot === 'function' && typeof runId === 'string' && runId) {
        const outcome = await callMutationAndToast((bridge) => abortViaActivity(bridge, runId), stopFailedMessage(), 'ide:test-runner:abort');
        const how = outcome.ok && outcome.result.activityAbort;
        if (how === 'ended') refresh();
        if (how !== 'fallback') return outcome;
      }
      return callMutationAndToast((bridge) => bridge.abort(), stopFailedMessage(), 'ide:test-runner:abort');
    }

    const panelActions = {
      showOutput: (configId) => onShowOutput(configId),
      runConfig: (configId) => {
        onRunRequest(configId);
        const epoch = rootEpoch;
        return callMutationAndToast(
          (api) => api.run({ configId, includeOutput: true }),
          jt('ide.testRunner.startFailed', 'Could not start the test run.'),
          `ide:test-runner:run:${configId}`
        ).then((outcome) => {
          if (outcome.ok && epoch === rootEpoch) recordRunOutput(outcome.result);
          return outcome;
        });
      },
      // One Stop in flight at a time: a second click while the waiting abort runs is a no-op.
      abort: () => {
        if (!abortInFlight) abortInFlight = abortActiveRun().finally(() => { abortInFlight = null; });
        return abortInFlight;
      },
      // WIDE-032: a typed result ({ok, configs} or {ok:false, code, message})
      // so the panel can roll back its optimistic composition baseline instead
      // of silently swallowing a refusal (e.g. CONFIG_ACTIVE_RUN) or a
      // rejected bridge call. A successful save re-fetches so the panel's
      // overlay is replaced by the canonical, normalized set the store wrote.
      saveConfigs: (configs) => callMutationAndToast(
        (api) => {
          if (typeof api.saveConfigs !== 'function') throw new Error(jt('ide.testRunner.unavailable', 'Test runner is unavailable.'));
          return api.saveConfigs(configs);
        },
        jt('ide.testRunner.saveFailed', 'Could not save the test configurations.'),
        'ide:test-runner:save'
      ).then((outcome) => {
        if (!outcome.ok) return outcome;
        const obj = asObject(outcome.result);
        return refresh().then(() => ({
          ok: true,
          configs: obj && Array.isArray(obj.configs) ? obj.configs : configs,
          // Entries the store dropped and why (invalid/duplicate id, ...),
          // so the panel can say so instead of reporting a silent success.
          rejected: obj && Array.isArray(obj.rejected) ? obj.rejected : [],
        }));
      }),
    };

    const panel = typeof panelFactory === 'function'
      ? panelFactory({
        getMountEl,
        getState: () => cachedState,
        getRunOutput: (configId) => lastRunOutput.get(String(configId)) || null,
        actions: panelActions,
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
          if (!obj) {
            return;
          }
          // The disabled envelope (available:false) keeps the last good cache
          // rather than blanking the panel; only feature_disabled marks the
          // runner unavailable (root_missing keeps the tab and its empty state).
          if (obj.available === false) {
            setAvailable(obj.reason !== 'feature_disabled');
            return;
          }
          setAvailable(true);
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
    // 'termination_failed' (main could not confirm the process tree died; it
    // still holds the run) re-fetches so the panel shows 'stop unconfirmed'.
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
      } else if (phase === 'termination_failed') {
        refresh();
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
      // The flag is read live in main: a Settings change can turn the runner on
      // or off mid-session, and a hidden tab never renders to notice it.
      const features = win.jennyShell?.features;
      if (features && typeof features.onChanged === 'function' && !unsubscribeFeatures) {
        unsubscribeFeatures = features.onChanged(() => { if (!disposed) refresh(); }) || null;
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
      if (typeof unsubscribeFeatures === 'function') {
        try { unsubscribeFeatures(); } catch (_error) { /* best-effort unsubscribe */ }
      }
      unsubscribeFeatures = null;
      if (panel) {
        panel.dispose();
      }
    }

    function resetForRoot() {
      if (disposed) return Promise.resolve();
      stateSeq += 1;
      rootEpoch += 1;
      cachedState = EMPTY_STATE;
      loadedOnce = false;
      lastRunOutput.clear(); // the old workspace's test output must not show in the new one
      panel?.resetForRoot?.(); // the old root's add-form draft must not reach the new root
      return refresh();
    }

    return {
      render, bindEvents, dispose, refresh, resetForRoot,
      // F6: the host's test-output view re-runs a config through the same path as the panel's Run.
      runConfig: (configId) => panelActions.runConfig(String(configId || '')),
      isAvailable: () => available,
      getLastRunOutput: (configId) => lastRunOutput.get(String(configId)) || null,
      getConfigLabel: (configId) => {
        const config = (Array.isArray(cachedState.configs) ? cachedState.configs : []).find((c) => c && c.id === String(configId));
        return config ? String(config.label || config.id) : String(configId || '');
      },
    };
  }

  return { createIdeTestRunnerWiring };
});
