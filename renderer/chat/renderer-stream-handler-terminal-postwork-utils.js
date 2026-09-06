(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerTerminalPostworkUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Terminal postwork has bounded deadlines, and stale continuations must not mutate renderer state.
  // Bare `setTimeout` calls let node:test mock timers intercept them regardless of module-load order.
  const HYDRATION_DEADLINE_MS = 20000;
  const REFRESH_DEADLINE_MS = 8000;
  const MEMORY_CAPTURE_DEADLINE_MS = 10000;
  // Terminal post-work slower than this is worth a WARN with its breakdown.
  const SLOW_POSTWORK_WARN_MS = 500;

  // Races `taskPromise` against a bounded timer. Resolves (never rejects) with
  // { timedOut: true } if the deadline wins; resolves with { timedOut: false,
  // value } if the task settles first; rejects with the task's own error if it
  // rejects before the deadline (timeout is for HANGS, not failures — a real
  // rejection still propagates so callers can log/handle it as before).
  function withPostworkDeadline(taskPromise, deadlineMs, onTimeout, options = {}) {
    let timerId = null;
    const timeoutPromise = new Promise((resolve) => {
      timerId = setTimeout(() => {
        timerId = null;
        options.abortController?.abort?.('postwork_deadline');
        resolve({ timedOut: true, value: undefined });
      }, deadlineMs);
    });
    const guardedTask = Promise.resolve(taskPromise).then(
      (value) => {
        if (timerId !== null) { clearTimeout(timerId); timerId = null; }
        return { timedOut: false, value };
      },
      (error) => {
        if (timerId !== null) { clearTimeout(timerId); timerId = null; }
        throw error;
      }
    );
    return Promise.race([guardedTask, timeoutPromise]).then((result) => {
      if (result.timedOut && typeof onTimeout === 'function') {
        try { onTimeout(); } catch (_error) { /* diagnostic is best-effort only */ }
      }
      return result;
    });
  }

  function createTerminalPostworkUtils(options = {}) {
    const state = options.state || {};
    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : () => {};
    const isTerminalPostworkGenerationCurrent = typeof options.isTerminalPostworkGenerationCurrent === 'function'
      ? options.isTerminalPostworkGenerationCurrent
      : () => true;
    const normalizeId = typeof options.normalizeId === 'function'
      ? options.normalizeId
      : (value) => String(value || '').trim();

    // L1 diagnostics (Chat Lifecycle v2 plan §4): running total of
    // isPostworkContinuationValid rejections. Per-controller (one
    // createTerminalPostworkUtils instance per multi-stream controller),
    // mirroring the HYDRATION/REFRESH/MEMORY_CAPTURE deadline constants above
    // — not a global count.
    let staleContinuationDropCount = 0;

    function logPostworkTimeout(stageName, sessionId, streamId, durationMs) {
      appendClientLog('WARN', 'stream.terminal_postwork_timeout', {
        stage: String(stageName || '').slice(0, 40),
        sessionId: String(sessionId || '').slice(0, 30),
        streamId: String(streamId || '').slice(0, 30),
        durationMs: Math.max(0, Number(durationMs) || 0),
      });
    }

    // stream.terminal_postwork_slow reports only a total, so a slow settle
    // names no culprit. Record each stage duration under its stream so the
    // WARN can carry the breakdown and the dominant stage is identifiable
    // from a real turn instead of guessed at.
    const MAX_TRACKED_POSTWORK_STREAMS = 16;
    const stageDurationsByStreamId = new Map();

    function noteStageDuration(streamId, stageName, durationMs) {
      const key = normalizeId(streamId);
      const stage = String(stageName || '').trim();
      if (!key || !stage) {
        return;
      }
      let stages = stageDurationsByStreamId.get(key);
      if (!stages) {
        stages = Object.create(null);
        stageDurationsByStreamId.set(key, stages);
        if (stageDurationsByStreamId.size > MAX_TRACKED_POSTWORK_STREAMS) {
          stageDurationsByStreamId.delete(stageDurationsByStreamId.keys().next().value);
        }
      }
      // Same stage twice in a turn (retry path) accumulates rather than
      // overwriting, so the total still reconciles against durationMs.
      stages[stage] = (stages[stage] || 0) + Math.max(0, Math.round(durationMs));
    }

    // Drains: the caller logs it once, and the entry must not outlive the
    // turn whether or not the WARN threshold was crossed.
    function takePostworkStageDurations(streamId) {
      const key = normalizeId(streamId);
      const stages = key ? stageDurationsByStreamId.get(key) : null;
      if (key) {
        stageDurationsByStreamId.delete(key);
      }
      return stages ? { ...stages } : {};
    }

    // Emits stream.terminal_postwork_slow with its stage breakdown. Always
    // drains the stage entry, threshold or not, so it cannot outlive the turn.
    // The refreshes run concurrently (Promise.allSettled), so the stage times
    // OVERLAP — read them as "slowest wins", not as a partition of the total.
    function reportSlowPostwork(payload, durationMs) {
      const totalMs = Math.max(0, Math.round(Number(durationMs) || 0));
      const stages = takePostworkStageDurations(payload?.streamId);
      if (totalMs <= SLOW_POSTWORK_WARN_MS) {
        return;
      }
      appendClientLog('WARN', 'stream.terminal_postwork_slow', {
        streamId: String(payload?.streamId || '').slice(0, 30),
        sessionId: String(payload?.sessionId || '').slice(0, 30),
        durationMs: totalMs,
        stages,
      });
    }

    // Runs one postwork stage under a bounded deadline. A synchronous throw
    // from taskFactory is normalized into a rejection (same as an async
    // rejection) so callers can treat every stage uniformly.
    function runDeadlineStage(stageName, sessionId, streamId, taskFactory, deadlineMs, stageOptions = {}) {
      const stageStartedAt = Date.now();
      const abortController = new AbortController();
      const externalGuard = stageOptions?.continuationGuard;
      const postworkToken = stageOptions?.postworkToken;
      const guard = Object.freeze({
        isCurrent() {
          if (abortController.signal.aborted) return false;
          if (externalGuard && typeof externalGuard.isCurrent === 'function'
            && externalGuard.isCurrent() !== true) return false;
          return postworkToken === null || postworkToken === undefined
            ? true
            : isPostworkContinuationValid(sessionId, postworkToken);
        },
        mutate(mutation) {
          if (!this.isCurrent() || typeof mutation !== 'function') return false;
          mutation();
          return true;
        },
      });
      let task;
      try {
        task = Promise.resolve(taskFactory({ signal: abortController.signal, guard }));
      } catch (syncError) {
        task = Promise.reject(syncError);
      }
      return withPostworkDeadline(task, deadlineMs, () => {
        logPostworkTimeout(stageName, sessionId, streamId, Date.now() - stageStartedAt);
      }, { abortController }).then((result) => {
        noteStageDuration(streamId, stageName, Date.now() - stageStartedAt);
        return result;
      });
    }

    // CTL-013 validity gate, part 1: a session is "alive" if it still appears
    // in the session list OR still owns a messagesBySession entry. The frozen
    // suite's delete simulation clears BOTH, so either check alone already
    // catches it; OR-ing them avoids a false "dead" verdict against a
    // legitimate session mid-bootstrap (e.g. present in the list before its
    // message cache is first populated).
    function isSessionAlive(sessionId) {
      const normalizedId = normalizeId(sessionId);
      if (!normalizedId) {
        return false;
      }
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const inSessionsList = sessions.some((session) => normalizeId(session?.id) === normalizedId);
      const messagesMap = state.messagesBySession;
      const inMessagesMap = messagesMap && typeof messagesMap.has === 'function'
        ? messagesMap.has(normalizedId)
        : false;
      return inSessionsList || inMessagesMap;
    }

    // CTL-013 validity gate, part 2: the generation token. Deletion, dispose,
    // and a fresh postwork generation for the same session all invalidate the
    // previous token (see renderer-multi-stream-utils.js), so a stale
    // continuation is rejected even when the session id itself still exists.
    function isPostworkContinuationValid(sessionId, token) {
      const sessionAlive = isSessionAlive(sessionId);
      const valid = sessionAlive && isTerminalPostworkGenerationCurrent(sessionId, token) !== false;
      if (!valid) {
        staleContinuationDropCount += 1;
        try {
          appendClientLog('INFO', 'lifecycle.stale_continuation_drop', {
            count: staleContinuationDropCount,
            sessionId: String(sessionId || '').slice(0, 30),
            reason: sessionAlive ? 'stale_generation' : 'dead_session',
          });
        } catch (_error) {
          // Diagnostic emission is best-effort only.
        }
      }
      return valid;
    }

    return {
      HYDRATION_DEADLINE_MS,
      REFRESH_DEADLINE_MS,
      MEMORY_CAPTURE_DEADLINE_MS,
      runDeadlineStage,
      noteStageDuration,
      reportSlowPostwork,
      isSessionAlive,
      isPostworkContinuationValid,
    };
  }

  return { createTerminalPostworkUtils, withPostworkDeadline };
});
