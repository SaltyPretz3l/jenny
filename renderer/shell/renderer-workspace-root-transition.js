/* renderer/shell/renderer-workspace-root-transition.js
 *
 * Renderer transaction for choose/clear workspace-root flows. The injected
 * bridge prepares a target without changing the canonical root, the existing
 * IDE close orchestrator preflights dirty buffers without discarding them, and
 * only an explicit backend commit permits old-root UI state to be closed.
 *
 * The backend remains authoritative for process/mutation rechecks and rollback.
 * This controller never infers commit success from a changed root payload. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererWorkspaceRootTransition = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function firstString(...values) {
    for (const value of values) {
      if (typeof value === 'string') {
        return value;
      }
    }
    return '';
  }

  function normalizeContext(value) {
    if (!isRecord(value)) {
      return null;
    }
    const rawGeneration = Number(value.generation);
    return {
      rootPath: firstString(value.rootPath, value.root_path),
      rootId: firstString(value.rootId, value.root_id),
      generation: Number.isSafeInteger(rawGeneration) && rawGeneration >= 0 ? rawGeneration : 0,
      phase: firstString(value.phase) || 'ready',
    };
  }

  function normalizePaths(values) {
    const seen = new Set();
    const paths = [];
    for (const value of Array.isArray(values) ? values : []) {
      const path = String(value || '');
      if (!path || seen.has(path)) {
        continue;
      }
      seen.add(path);
      paths.push(path);
    }
    return paths;
  }

  function samePathSet(left, right) {
    if (left.length !== right.length) {
      return false;
    }
    const rightSet = new Set(right);
    return left.every((path) => rightSet.has(path));
  }

  function normalizeBlockers(value) {
    return (Array.isArray(value) ? value : [])
      .filter(isRecord)
      .map((entry) => ({
        id: firstString(entry.id),
        reason: firstString(entry.reason),
      }));
  }

  function normalizeError(value) {
    if (!isRecord(value)) {
      return null;
    }
    return {
      code: firstString(value.code),
      message: firstString(value.message),
    };
  }

  function normalizeExternalPrepared(value) {
    if (!isRecord(value)) return null;
    const transitionId = firstString(value.transitionId, value.transition_id).trim();
    const previous = normalizeContext(value.previous);
    const candidate = normalizeContext(value.candidate);
    if (!transitionId || !previous || !candidate || candidate.generation <= previous.generation) {
      return null;
    }
    return {
      prepared: true,
      transitionId,
      changed: true,
      canceled: false,
      previous,
      candidate,
    };
  }

  function sameContext(left, right) {
    return Boolean(left && right
      && left.rootPath === right.rootPath
      && left.rootId === right.rootId
      && left.generation === right.generation
      && left.phase === right.phase);
  }

  function errorDetails(error, fallbackCode) {
    return {
      code: firstString(error?.code) || fallbackCode,
      message: firstString(error?.message, String(error || '')),
    };
  }

  function createWorkspaceRootTransitionController(deps) {
    const options = deps || {};
    const getBridge = typeof options.getBridge === 'function'
      ? options.getBridge
      : () => options.bridge || null;
    const closeOrchestrator = options.closeOrchestrator || null;
    const getOpenPaths = typeof options.getOpenPaths === 'function'
      ? options.getOpenPaths
      : () => [];
    const onCommitted = typeof options.onCommitted === 'function'
      ? options.onCommitted
      : async () => {};
    const beforePrepare = typeof options.beforePrepare === 'function'
      ? options.beforePrepare
      : async () => {};
    const onSettled = typeof options.onSettled === 'function'
      ? options.onSettled
      : async () => {};
    const onFailure = typeof options.onFailure === 'function' ? options.onFailure : () => {};
    const confirmProcessTermination = typeof options.confirmProcessTermination === 'function'
      ? options.confirmProcessTermination
      : async () => false;
    const appendClientLog = typeof options.appendClientLog === 'function'
      ? options.appendClientLog
      : () => {};
    const now = typeof options.now === 'function' ? options.now : () => Date.now();

    let inFlight = false;

    function reportFailure(outcome) {
      if (outcome.canceled !== true && outcome.noop !== true) {
        try {
          appendClientLog('WARN', 'workspace.root_transition_failed', {
            stage: outcome.stage,
            code: outcome.code,
            mode: outcome.mode,
          });
        } catch (_error) {
          /* logging must not change the transition result */
        }
        try {
          onFailure(outcome);
        } catch (_error) {
          /* notification is best-effort */
        }
      }
      return outcome;
    }

    function failure(mode, context, code, extra = {}) {
      return reportFailure({
        committed: false,
        changed: false,
        canceled: extra.canceled === true,
        blocked: extra.blocked === true,
        rolledBack: extra.rolledBack === true,
        noop: extra.noop === true,
        mode,
        stage: firstString(extra.stage) || 'transition',
        code,
        context: normalizeContext(extra.context) || normalizeContext(context),
        ...(extra.transitionId ? { transitionId: extra.transitionId } : {}),
        ...(extra.blockers ? { blockers: normalizeBlockers(extra.blockers) } : {}),
        ...(extra.error ? { error: normalizeError(extra.error) } : {}),
        ...(extra.cancelResult ? { cancelResult: extra.cancelResult } : {}),
      });
    }

    function capturePaths() {
      return normalizePaths(getOpenPaths());
    }

    async function cancelBackend(bridge, transitionId) {
      if (!transitionId || typeof bridge?.cancel !== 'function') {
        return { canceled: false, changed: false, code: 'bridge_unavailable' };
      }
      try {
        const result = await bridge.cancel({ transitionId });
        if (!isRecord(result)) {
          return { canceled: false, changed: false, code: 'invalid_cancel_response' };
        }
        return {
          canceled: result.canceled === true,
          changed: result.changed === true,
          code: firstString(result.code),
          context: normalizeContext(result.context),
        };
      } catch (error) {
        return {
          canceled: false,
          changed: false,
          ...errorDetails(error, 'cancel_failed'),
        };
      }
    }

    function cancelClosePlan(plan) {
      if (!plan || typeof closeOrchestrator?.cancel !== 'function') {
        return null;
      }
      try {
        return closeOrchestrator.cancel(plan);
      } catch (_error) {
        return { canceled: false, code: 'close_cancel_failed' };
      }
    }

    async function abortPrepared(bridge, transitionId, closePlan, { backendRolledBack = false } = {}) {
      const closeResult = cancelClosePlan(closePlan);
      const cancelResult = backendRolledBack
        ? null
        : await cancelBackend(bridge, transitionId);
      return { closeResult, cancelResult };
    }

    function externalDeadlineExpired(mode, request) {
      const deadlineMs = Number(request?.deadline_ms ?? request?.deadlineMs);
      return mode === 'external' && Number.isSafeInteger(deadlineMs) && now() >= deadlineMs;
    }

    async function commitWithProcessConsent({ bridge, transitionId, mode, request, openPaths }) {
      let backendResult = await bridge.commit({ transitionId, terminateProcesses: false });
      if (!isRecord(backendResult)
        || backendResult.committed === true
        || backendResult.blocked !== true
        || firstString(backendResult.code) !== 'participants_active') {
        return { backendResult };
      }

      let approved;
      try {
        approved = await confirmProcessTermination({
          mode,
          transitionId,
          blockers: normalizeBlockers(backendResult.blockers),
        });
      } catch (error) {
        return {
          refusal: {
            code: 'process_termination_confirmation_failed',
            blocked: true,
            stage: 'process_consent',
            error: errorDetails(error, 'process_termination_confirmation_failed'),
          },
        };
      }
      if (approved !== true) {
        return {
          refusal: {
            code: 'process_termination_canceled',
            canceled: true,
            stage: 'process_consent',
          },
        };
      }

      let currentPaths;
      try {
        currentPaths = capturePaths();
      } catch (error) {
        return {
          refusal: {
            code: 'renderer_context_capture_failed',
            blocked: true,
            stage: 'process_consent',
            error: errorDetails(error, 'renderer_context_capture_failed'),
          },
        };
      }
      if (!samePathSet(openPaths, currentPaths)) {
        return {
          refusal: {
            code: 'renderer_context_changed',
            blocked: true,
            stage: 'process_consent',
          },
        };
      }
      if (externalDeadlineExpired(mode, request)) {
        return {
          refusal: {
            code: 'external_transition_expired',
            blocked: true,
            stage: 'process_consent',
          },
        };
      }
      backendResult = await bridge.commit({ transitionId, terminateProcesses: true });
      return { backendResult };
    }

    async function run(mode, request) {
      if (inFlight) {
        return failure(mode, null, 'transition_in_progress', {
          blocked: true,
          stage: 'prepare',
        });
      }
      inFlight = true;
      let bridge;
      let initialContext;
      let transitionId;
      let closePlan;
      let lifecycleStarted = false;
      let backendCommitted = false;
      try {
        try {
          bridge = getBridge();
        } catch (error) {
          return failure(mode, null, 'bridge_unavailable', {
            blocked: true,
            stage: 'capture',
            error: errorDetails(error, 'bridge_unavailable'),
          });
        }
        if (typeof bridge?.captureContext !== 'function') {
          return failure(mode, null, 'bridge_unavailable', { blocked: true, stage: 'capture' });
        }
        try {
          initialContext = normalizeContext(await bridge.captureContext());
        } catch (error) {
          return failure(mode, null, 'capture_failed', {
            blocked: true,
            stage: 'capture',
            error: errorDetails(error, 'capture_failed'),
          });
        }
        if (!initialContext) {
          return failure(mode, null, 'invalid_context_response', { blocked: true, stage: 'capture' });
        }
        lifecycleStarted = true;
        try {
          await beforePrepare({ mode, context: initialContext });
        } catch (error) {
          return failure(mode, initialContext, 'persistence_preflight_failed', {
            blocked: true,
            stage: 'persistence',
            error: errorDetails(error, 'persistence_preflight_failed'),
          });
        }

        let prepared;
        if (mode === 'external') {
          prepared = normalizeExternalPrepared(request);
          if (!prepared) {
            return failure(mode, initialContext, 'invalid_external_prepare_request', {
              blocked: true,
              stage: 'prepare',
            });
          }
          transitionId = prepared.transitionId;
          if (!sameContext(initialContext, prepared.previous)) {
            const aborted = await abortPrepared(bridge, transitionId, null);
            return failure(mode, initialContext, 'prepared_context_mismatch', {
              blocked: true,
              stage: 'prepare',
              transitionId,
              cancelResult: aborted.cancelResult,
            });
          }
        } else {
          const prepareName = mode === 'clear' ? 'prepareClear' : 'prepareChoose';
          if (typeof bridge?.[prepareName] !== 'function') {
            return failure(mode, initialContext, 'bridge_unavailable', { blocked: true, stage: 'prepare' });
          }
          try {
            prepared = await bridge[prepareName]();
          } catch (error) {
            return failure(mode, initialContext, 'prepare_failed', {
              blocked: true,
              stage: 'prepare',
              error: errorDetails(error, 'prepare_failed'),
            });
          }
        }
        if (!isRecord(prepared)) {
          return failure(mode, initialContext, 'invalid_prepare_response', {
            blocked: true,
            stage: 'prepare',
          });
        }
        if (prepared.prepared !== true) {
          const canceled = prepared.canceled === true;
          const noop = prepared.noop === true || (!canceled && prepared.changed === false && prepared.blocked !== true);
          return failure(mode, initialContext, firstString(prepared.code)
            || (canceled ? 'user_canceled' : noop ? 'no_change' : 'transition_blocked'), {
            canceled,
            noop,
            blocked: prepared.blocked === true,
            stage: 'prepare',
            context: prepared.context,
            blockers: prepared.blockers,
          });
        }

        transitionId = transitionId || firstString(prepared.transitionId, prepared.transition_id).trim();
        if (!transitionId) {
          return failure(mode, initialContext, 'invalid_prepare_response', {
            blocked: true,
            stage: 'prepare',
          });
        }
        if (typeof closeOrchestrator?.preflight !== 'function'
          || typeof closeOrchestrator?.commit !== 'function') {
          const aborted = await abortPrepared(bridge, transitionId, null);
          return failure(mode, initialContext, 'close_orchestrator_unavailable', {
            blocked: true,
            stage: 'preflight',
            transitionId,
            cancelResult: aborted.cancelResult,
          });
        }

        let openPaths;
        try {
          openPaths = capturePaths();
          closePlan = await closeOrchestrator.preflight(openPaths);
        } catch (error) {
          const aborted = await abortPrepared(bridge, transitionId, closePlan);
          return failure(mode, initialContext, 'preflight_failed', {
            blocked: true,
            stage: 'preflight',
            transitionId,
            error: errorDetails(error, 'preflight_failed'),
            cancelResult: aborted.cancelResult,
          });
        }
        if (!isRecord(closePlan) || closePlan.ready !== true) {
          const aborted = await abortPrepared(bridge, transitionId, closePlan);
          return failure(mode, initialContext, firstString(closePlan?.code) || 'preflight_refused', {
            canceled: closePlan?.canceled === true,
            blocked: closePlan?.blocked === true,
            stage: 'preflight',
            transitionId,
            cancelResult: aborted.cancelResult,
          });
        }

        // A late open completion can add a model while Save is awaiting disk.
        // Do not commit a plan that did not preflight the current tab set.
        let currentPaths;
        try {
          currentPaths = capturePaths();
        } catch (error) {
          const aborted = await abortPrepared(bridge, transitionId, closePlan);
          return failure(mode, initialContext, 'renderer_context_capture_failed', {
            blocked: true,
            stage: 'preflight',
            transitionId,
            error: errorDetails(error, 'renderer_context_capture_failed'),
            cancelResult: aborted.cancelResult,
          });
        }
        if (!samePathSet(openPaths, currentPaths)) {
          const aborted = await abortPrepared(bridge, transitionId, closePlan);
          return failure(mode, initialContext, 'renderer_context_changed', {
            blocked: true,
            stage: 'preflight',
            transitionId,
            cancelResult: aborted.cancelResult,
          });
        }

        if (externalDeadlineExpired(mode, request)) {
          const aborted = await abortPrepared(bridge, transitionId, closePlan);
          return failure(mode, initialContext, 'external_transition_expired', {
            blocked: true,
            stage: 'preflight',
            transitionId,
            cancelResult: aborted.cancelResult,
          });
        }

        if (typeof bridge.commit !== 'function') {
          const aborted = await abortPrepared(bridge, transitionId, closePlan);
          return failure(mode, initialContext, 'bridge_unavailable', {
            blocked: true,
            stage: 'commit',
            transitionId,
            cancelResult: aborted.cancelResult,
          });
        }
        let commitAttempt;
        try {
          // commit is deliberately always called: it is the authoritative
          // process/participant/mutation recheck immediately before mutation.
          commitAttempt = await commitWithProcessConsent({
            bridge, transitionId, mode, request, openPaths,
          });
        } catch (error) {
          const aborted = await abortPrepared(bridge, transitionId, closePlan);
          return failure(mode, initialContext, 'commit_failed', {
            blocked: true,
            stage: 'commit',
            transitionId,
            error: errorDetails(error, 'commit_failed'),
            cancelResult: aborted.cancelResult,
          });
        }
        if (commitAttempt.refusal) {
          const refusal = commitAttempt.refusal;
          const aborted = await abortPrepared(bridge, transitionId, closePlan);
          return failure(mode, initialContext, refusal.code, {
            ...refusal,
            transitionId,
            cancelResult: aborted.cancelResult,
          });
        }
        const backendResult = commitAttempt.backendResult;
        const explicitCommit = isRecord(backendResult)
          && backendResult.committed === true
          && backendResult.changed !== false;
        if (!explicitCommit) {
          const rolledBack = backendResult?.rolledBack === true;
          const aborted = await abortPrepared(bridge, transitionId, closePlan, {
            backendRolledBack: rolledBack,
          });
          return failure(mode, initialContext, firstString(backendResult?.code)
            || 'invalid_commit_response', {
            blocked: backendResult?.blocked === true,
            rolledBack,
            stage: firstString(backendResult?.stage) || 'commit',
            transitionId,
            blockers: backendResult?.blockers,
            error: backendResult?.error,
            context: backendResult?.context,
            cancelResult: aborted.cancelResult,
          });
        }
        backendCommitted = true;

        const committedContext = normalizeContext(backendResult.context)
          || { ...(normalizeContext(prepared.candidate) || initialContext), phase: 'ready' };
        const previousContext = normalizeContext(backendResult.previous)
          || normalizeContext(prepared.previous)
          || initialContext;
        let closeResult;
        try {
          closeResult = closeOrchestrator.commit(closePlan);
        } catch (error) {
          closeResult = {
            committed: false,
            ...errorDetails(error, 'close_commit_failed'),
          };
        }
        let uiError = null;
        try {
          await onCommitted({
            mode,
            context: committedContext,
            previous: previousContext,
            backendResult,
            closeResult,
          });
        } catch (error) {
          uiError = errorDetails(error, 'ui_commit_failed');
        }
        const closeCommitted = closeResult?.committed === true;
        return {
          committed: true,
          changed: true,
          canceled: false,
          blocked: false,
          rolledBack: false,
          mode,
          transitionId,
          context: committedContext,
          previous: previousContext,
          closeResult,
          degraded: !closeCommitted || Boolean(uiError),
          ...(!closeCommitted ? { code: 'renderer_close_commit_failed' } : {}),
          ...(uiError ? { uiError } : {}),
        };
      } finally {
        if (lifecycleStarted) {
          let settledContext = initialContext;
          try {
            settledContext = normalizeContext(await bridge?.captureContext?.()) || settledContext;
          } catch (error) {
            appendClientLog('WARN', 'workspace.root_settle_capture_failed', {
              code: String(error?.code || 'capture_failed').slice(0, 80),
            });
          }
          try {
            await onSettled({ mode, context: settledContext, committed: backendCommitted });
          } catch (error) {
            appendClientLog('WARN', 'workspace.root_settle_failed', {
              code: String(error?.code || 'settle_failed').slice(0, 80),
            });
          }
        }
        inFlight = false;
      }
    }

    function choose(request) {
      return run('choose', request || {});
    }

    function clear(request) {
      return run('clear', request || {});
    }

    function external(request) {
      return run('external', request || {});
    }

    return { choose, clear, external };
  }

  return {
    createWorkspaceRootTransitionController,
    normalizeContext,
  };
});
