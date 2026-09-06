'use strict';
// Orchestrator for the Workspace IDE Test Runner. The ONLY module the IPC layer
// calls; the renderer never touches child_process. Owns the single-run lock, the
// default-timeout floor, crash/reload reconciliation, status mapping, and the
// CMP error envelope. Delegates execution to backend/workspace-test-runner-runner
// and persistence to workspace-test-runner-history.

const path = require('path');

const {
  normalizeConfigs,
  normalizeConfigsDetailed,
  findConfig,
  REJECT_REASONS,
} = require('./workspace-test-runner-config');
const { parseSummaryBounded } = require('./workspace-test-runner-summary');
const { WORKSPACE_TEST_RUNNER_ERROR_CODES } = require('./backend/error-codes');
const { isChildPath, resolveRealPathSafe } = require('./backend/path-utils');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
// S18: an upper bound on stored configurations per workspace, so a malformed or
// runaway authoring write can't grow the per-root config file without limit.
const MAX_CONFIGS = 50;
// Who asked for a run. Absent on the renderer's own run path (the user), so
// every pre-existing record shape is unchanged; the model-facing `verify` tool
// sets 'jenny'. Anything else is dropped rather than recorded.
const RUN_INITIATORS = Object.freeze(['jenny', 'user']);
const MAX_GATE_ATTEMPT = 99;

const MESSAGES = {
  [WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING]: 'No workspace root is configured; choose a workspace folder first.',
  [WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_NOT_FOUND]: 'That test configuration no longer exists.',
  [WORKSPACE_TEST_RUNNER_ERROR_CODES.CWD_OUTSIDE_ROOT]: 'The test working directory must stay inside the workspace.',
  [WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_ACTIVE_RUN]: 'That configuration has an active test run and cannot be removed until it finishes or is stopped.',
  [WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING]: 'A test run is already in progress.',
};

// S16: resolve a config's declared cwd against the workspace root. Empty -> root;
// relative -> joined to root; absolute -> used as-is (path.resolve gives all three:
// resolve(root,'') === resolve(root); resolve(root, abs) === abs).
function resolveEffectiveCwd(root, configCwd) {
  return path.resolve(root, configCwd || '.');
}

// S16: the effective cwd must realpath-resolve INSIDE the root. isChildPath is
// realpath-based (so a symlink escape is caught) but returns false when the cwd IS
// the root (the relative path is ''); the root itself is an allowed working dir.
function cwdInsideRoot(root, effectiveCwd) {
  if (resolveRealPathSafe(effectiveCwd) === resolveRealPathSafe(root)) {
    return true;
  }
  return isChildPath(root, effectiveCwd);
}

function envelope(code, message = MESSAGES[code]) {
  return { error: { code, message: message || 'Test runner error.' } };
}

function readAttribution(payload) {
  const out = {};
  const initiator = payload && typeof payload.initiator === 'string' ? payload.initiator.trim() : '';
  if (RUN_INITIATORS.includes(initiator)) {
    out.initiator = initiator;
  }
  const attempt = payload ? Number(payload.gateAttempt) : NaN;
  if (Number.isInteger(attempt) && attempt > 0 && attempt <= MAX_GATE_ATTEMPT) {
    out.gateAttempt = attempt;
  }
  return out;
}

/**
 * @param {{
 *   runner:{runTestCommand:Function}, history:object,
 *   rootProvider:Function, configProvider:Function,
 *   now?:Function, defaultTimeoutMs?:number, makeRunId?:Function,
 * }} deps
 */
function createWorkspaceTestRunnerService(deps = {}) {
  const runner = deps.runner;
  const history = deps.history;
  const rootProvider = typeof deps.rootProvider === 'function' ? deps.rootProvider : () => '';
  const configProvider = typeof deps.configProvider === 'function' ? deps.configProvider : () => [];
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const defaultTimeoutMs = Number.isFinite(Number(deps.defaultTimeoutMs)) && Number(deps.defaultTimeoutMs) > 0
    ? Number(deps.defaultTimeoutMs)
    : DEFAULT_TIMEOUT_MS;
  // S13: optional live-state callback. The wiring turns each call into a
  // workspaceTestRunner.onStateChanged bridge push so the Home widget can badge
  // the running config without a per-widget poll. Best-effort; a throwing
  // listener never derails a run.
  const onStateChange = typeof deps.onStateChange === 'function' ? deps.onStateChange : null;
  // S18: persistence sink for the config authoring write path. The wiring writes
  // the per-root config FileJsonStore; absent (bare unit), saveConfigs still
  // normalizes + returns but persists nothing.
  const configWriter = typeof deps.configWriter === 'function' ? deps.configWriter : null;
  const summaryParser = typeof deps.summaryParser === 'function' ? deps.summaryParser : parseSummaryBounded;
  const log = typeof deps.log === 'function' ? deps.log : null;
  let runCounter = 0;
  const makeRunId = typeof deps.makeRunId === 'function'
    ? deps.makeRunId
    : () => `run-${now().getTime().toString(36)}-${(runCounter += 1)}`;

  // S5b: reconcile crash/reload-orphaned 'running' records on construction, so a
  // phantom 'running' can never poison trend math.
  let activeRun = null;
  // S14: the AbortController for the in-flight run; abort() trips its signal, which
  // the runner observes (kills the process tree + resolves status:'aborted').
  let activeController = null;
  let activeSettlement = null;
  let resolveActiveSettlement = null;
  let activeTerminationRetry = null;
  let activeTerminationRetryPromise = null;
  let disposePromise = null;
  let disposed = false;
  try {
    history?.reconcileRunning?.();
  } catch (_error) {
    /* best-effort reconcile */
  }

  // S13: notify the injected listener of a run lifecycle transition. activeRun
  // reflects the post-transition state (the runId still in flight, or null once
  // cleared) so a late subscriber can reconcile from getState.
  function emitState(phase, configId, runId) {
    if (!onStateChange) {
      return;
    }
    try {
      onStateChange({ phase, configId, runId, activeRun: activeRun ? activeRun.runId : null });
    } catch (_error) {
      /* a listener must never derail a run */
    }
  }

  function releaseActiveRun(configId, runId) {
    if (!activeRun || activeRun.runId !== runId) return false;
    activeRun = null;
    activeController = null;
    activeTerminationRetry = null;
    activeTerminationRetryPromise = null;
    emitState('finished', configId, runId);
    return true;
  }

  function resolveRoot() {
    return String(rootProvider() || '').trim();
  }

  function currentConfigs() {
    return normalizeConfigs(configProvider());
  }

  function listConfigs() {
    if (!resolveRoot()) {
      return envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING);
    }
    return { configs: currentConfigs() };
  }

  // S18: persist the authored configurations. Malformed/duplicate/over-cap
  // entries are normalize-dropped (never thrown), so the store always holds a
  // valid, bounded set; the normalized result is returned so the caller can
  // reflect exactly what persisted, and every drop is named in `rejected` so
  // the authoring UI can say why a configuration did not appear instead of
  // reporting success for one that silently vanished. No root -> nothing is
  // written.
  // WIDE-032: a save that would drop the configuration with an active run is
  // refused outright (typed CONFIG_ACTIVE_RUN, nothing written) rather than
  // silently persisting a set whose Stop control the renderer can no longer
  // reach while the process keeps running.
  function saveConfigs(configs) {
    if (!resolveRoot()) {
      return envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING);
    }
    const detailed = normalizeConfigsDetailed(configs);
    const normalized = detailed.configs.slice(0, MAX_CONFIGS);
    const rejected = detailed.rejected.concat(
      detailed.configs.slice(MAX_CONFIGS).map((config) => ({ id: config.id, reason: REJECT_REASONS.OVER_CAP }))
    );
    if (activeRun && !findConfig(normalized, activeRun.configId)) {
      return envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_ACTIVE_RUN);
    }
    if (configWriter) {
      configWriter(normalized);
    }
    return { configs: normalized, rejected };
  }

  async function run(payload) {
    if (disposed) {
      return envelope(
        WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING,
        'The test runner is shutting down and cannot start another run.'
      );
    }
    const root = resolveRoot();
    if (!root) {
      return envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.ROOT_MISSING);
    }
    const configId = String((payload && payload.configId) || '').trim();
    const includeOutput = payload ? payload.includeOutput === true : false;
    const attribution = readAttribution(payload);
    const config = findConfig(currentConfigs(), configId);
    if (!config) {
      return envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.CONFIG_NOT_FOUND);
    }
    // S16: validate the effective cwd is contained within the root BEFORE the lock
    // or any history write, so an escaping config never spawns or records a run.
    const effectiveCwd = resolveEffectiveCwd(root, config.cwd);
    if (!cwdInsideRoot(root, effectiveCwd)) {
      return envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.CWD_OUTSIDE_ROOT);
    }
    if (activeRun) {
      // A run Jenny asked for that the user's own run pre-empted is worth a
      // history mark: it is the only way the panel can say "skipped" for the
      // verification gate. The user's own double-click stays silent, as before.
      if (attribution.initiator === 'jenny') {
        try {
          history?.recordSkip?.(configId, {
            runId: String(makeRunId()),
            startedAt: now().toISOString(),
            reason: 'already_running',
            ...attribution,
          });
        } catch (_error) {
          /* a history hiccup must not turn a refusal into a throw */
        }
      }
      return envelope(WORKSPACE_TEST_RUNNER_ERROR_CODES.ALREADY_RUNNING);
    }

    const runId = String(makeRunId());
    activeRun = { runId, configId };
    const controller = new AbortController();
    activeController = controller;
    activeSettlement = new Promise((resolve) => { resolveActiveSettlement = resolve; });
    activeTerminationRetry = null;
    activeTerminationRetryPromise = null;
    const startedAt = now().toISOString();
    let terminationConfirmed = true;
    try {
      history?.recordStart?.(configId, { runId, startedAt, ...attribution });
      // S13: the run is now live — push 'started' so the widget badges it running.
      emitState('started', configId, runId);
      const result = await runner.runTestCommand({
        command: config.command,
        // S16: the runner receives the VALIDATED ABSOLUTE cwd, never the raw value.
        cwd: effectiveCwd,
        userEnv: config.env,
        timeoutMs: config.timeoutMs || defaultTimeoutMs,
        // S14: the runner kills the tree + resolves status:'aborted' when this fires.
        abortSignal: controller.signal,
        now,
      });
      const record = {
        status: result.status,
        exitCode: result.exitCode ?? null,
        durationMs: result.durationMs ?? null,
        startedAt: result.startedAt ?? startedAt,
        finishedAt: result.finishedAt ?? null,
        ...attribution,
      };
      // S2: when the process never started the runner sets a CMP-TESTRUNNER-*
      // code; surface it on both the returned record and history so callers can
      // distinguish "couldn't run it" from "ran and failed".
      if (result.errorCode) {
        record.errorCode = result.errorCode;
      }
      // S17: an optional summaryRegex parses the stdout tail into advisory counts.
      // Status is NEVER changed by parsing; counts are omitted on any miss.
      let counts = {};
      try {
        counts = await summaryParser(result.stdoutTail, config.summaryRegex);
      } catch (_error) {
        counts = {};
      }
      if (counts.passedCount !== undefined) {
        record.passedCount = counts.passedCount;
      }
      if (counts.failedCount !== undefined) {
        record.failedCount = counts.failedCount;
      }
      terminationConfirmed = result.terminationConfirmed !== false;
      if (!terminationConfirmed && typeof result.retryTermination === 'function') {
        activeTerminationRetry = result.retryTermination;
      }
      if (!terminationConfirmed) {
        try {
          log?.('WARN', 'workspace_test_runner.termination_unconfirmed', {
            reason: String(result.terminationWarning || 'kill_unconfirmed').slice(0, 80),
          });
        } catch (_error) { /* logging cannot release process ownership */ }
      }
      if (typeof result.terminationConfirmed === 'boolean') {
        record.terminationConfirmed = result.terminationConfirmed;
      }
      if (result.terminationWarning) {
        record.terminationWarning = String(result.terminationWarning).slice(0, 80);
      }
      history?.recordFinish?.(configId, runId, record);
      // The bounded, token-masked output tails are OPT-IN and ride the returned
      // record only. History stays lean because the renderer reads it wholesale
      // on every panel render, and the renderer's own run path never asks for the
      // tails; the model-facing `verify` tool is the one caller that needs the
      // actual failing lines, so it is the one caller that sets includeOutput.
      if (!includeOutput) {
        return { configId, runId, ...record };
      }
      return {
        configId,
        runId,
        ...record,
        stdoutTail: result.stdoutTail || '',
        stderrTail: result.stderrTail || '',
      };
    } catch (error) {
      // S13/S5a: an unexpected runner rejection must not leave a phantom 'running'
      // in history OR a stuck running badge in the renderer. Finalize the run as
      // 'error' (the finally still emits the settle event below) and re-throw so
      // callers still see the failure (the single-run lock test depends on this).
      history?.recordFinish?.(configId, runId, {
        status: 'error',
        exitCode: null,
        durationMs: null,
        startedAt,
        finishedAt: now().toISOString(),
      });
      throw error;
    } finally {
      const settle = resolveActiveSettlement;
      resolveActiveSettlement = null;
      settle?.({ terminationConfirmed });
      if (terminationConfirmed) {
        releaseActiveRun(configId, runId);
      } else {
        emitState('termination_failed', configId, runId);
      }
    }
  }

  // S14: cancel the in-flight run, if any. Tripping the controller's signal lets
  // the runner kill the process tree and resolve the run as 'aborted' (which then
  // flows through recordFinish into history). A clean structured no-op when idle.
  function abort() {
    if (!activeController) {
      return { aborted: false };
    }
    // activeController is non-null only while a run is in flight, so activeRun is
    // always set here (the two are set and cleared together, synchronously).
    const { runId, configId } = activeRun;
    const alreadyRequested = activeController.signal.aborted;
    if (!alreadyRequested) activeController.abort();
    // S13: surface the cancel request immediately (the authoritative 'finished'
    // still follows once the runner resolves the run as 'aborted').
    if (!alreadyRequested) emitState('aborted', configId, runId);
    return { aborted: true, runId, ...(alreadyRequested ? { alreadyRequested: true } : {}) };
  }

  async function abortAndWait() {
    if (!activeRun) return { aborted: false, terminationConfirmed: true };
    const { runId, configId } = activeRun;
    const settlement = activeSettlement;
    abort();
    const first = settlement ? await settlement : { terminationConfirmed: false };
    if (first.terminationConfirmed === false && !activeTerminationRetry) {
      return { aborted: true, runId, terminationConfirmed: false, reason: 'kill_unconfirmed' };
    }
    if (first.terminationConfirmed === false) {
      if (!activeTerminationRetryPromise) {
        activeTerminationRetryPromise = Promise.resolve().then(() => activeTerminationRetry());
      }
      const retried = await activeTerminationRetryPromise;
      if (retried?.confirmed !== true) activeTerminationRetryPromise = null;
      if (retried?.confirmed === true) {
        releaseActiveRun(configId, runId);
        return { aborted: true, runId, terminationConfirmed: true };
      }
      return { aborted: true, runId, terminationConfirmed: false, reason: retried?.warning || 'kill_unconfirmed' };
    }
    return { aborted: true, runId, terminationConfirmed: true };
  }

  function dispose() {
    disposed = true;
    if (!disposePromise) {
      disposePromise = (async () => {
        const result = await abortAndWait();
        return { disposed: !activeRun, terminationConfirmed: result.terminationConfirmed !== false };
      })();
      void disposePromise.then((result) => { if (!result.disposed) disposePromise = null; });
    }
    return disposePromise;
  }

  function getState() {
    return {
      configs: currentConfigs(),
      history: history && typeof history.read === 'function' ? history.read() : { byConfig: {} },
      activeRun: activeRun ? activeRun.runId : null,
      // S13: the running config id lets the widget badge the right row as running
      // (activeRun alone is just the opaque runId).
      activeConfigId: activeRun ? activeRun.configId : null,
    };
  }

  return { listConfigs, run, abort, abortAndWait, dispose, saveConfigs, getState };
}

module.exports = {
  createWorkspaceTestRunnerService,
  DEFAULT_TIMEOUT_MS,
};
