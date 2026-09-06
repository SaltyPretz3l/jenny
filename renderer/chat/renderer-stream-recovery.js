/* renderer/chat/renderer-stream-recovery.js -- canonical recovery for lost envelope terminals (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamRecovery = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_APPLIED_RECOVERY_CAP = 128;
  const DEFAULT_CANONICAL_READ_DEADLINE_MS = 20_000;

  function normalizeToken(value) {
    return String(value || '').trim();
  }

  function createStreamRecoveryController(options = {}) {
    const {
      getPersistedSession = async () => null,
      setSessionMessages = () => {},
      setSessionTurnEventState = () => {},
      clearRecoveredTerminalState = () => {},
      clearSessionLiveTurnState = () => {},
      rehydrateLiveTurnState = () => {},
      clearChatSendLifecycle = () => {},
      queueSessionRender = () => {},
      setSessionComposerNotice = () => {},
      fallbackToLegacy = () => {},
      isStreamCurrentForSession = () => true,
      hasSession = () => true,
      acknowledgeRecovery = async () => ({ ok: true }),
      appendClientLog = () => {},
      maxAppliedRecoveries = DEFAULT_APPLIED_RECOVERY_CAP,
      canonicalReadDeadlineMs = DEFAULT_CANONICAL_READ_DEADLINE_MS,
      setTimeoutImpl = (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeoutImpl = (handle) => clearTimeout(handle),
    } = options;
    const inFlightById = new Map();
    const latestRequestById = new Map();
    const tailsBySession = new Map();
    const appliedById = new Map();
    const appliedCap = Number.isSafeInteger(maxAppliedRecoveries) && maxAppliedRecoveries > 0
      ? maxAppliedRecoveries
      : DEFAULT_APPLIED_RECOVERY_CAP;
    const readDeadlineMs = Number.isSafeInteger(canonicalReadDeadlineMs) && canonicalReadDeadlineMs > 0
      ? canonicalReadDeadlineMs
      : DEFAULT_CANONICAL_READ_DEADLINE_MS;
    let generation = 1;
    let disposed = false;

    function normalizeRequest(request = {}) {
      const streamId = normalizeToken(request.streamId || request.stream_id);
      const sessionId = normalizeToken(request.sessionId || request.session_id);
      const recoveryId = normalizeToken(request.recoveryId || request.recovery_id);
      const rendererEpoch = request.rendererEpoch ?? request.renderer_epoch;
      const reason = normalizeToken(request.reason).slice(0, 80) || 'envelope_recovery_required';
      return {
        recoveryId,
        rendererEpoch: typeof rendererEpoch === 'number' && Number.isSafeInteger(rendererEpoch)
          ? rendererEpoch
          : 0,
        streamId,
        sessionId,
        reason,
        key: recoveryId || `${sessionId}:${streamId}:${reason}`,
      };
    }

    function rememberApplied(request, outcome) {
      appliedById.set(request.key, { request, outcome });
      while (appliedById.size > appliedCap) {
        appliedById.delete(appliedById.keys().next().value);
      }
    }

    async function acknowledge(request, outcome) {
      if (!request.recoveryId || request.rendererEpoch < 1) return { ok: true };
      try {
        const result = await acknowledgeRecovery({
          record_type: 'recovery_applied',
          recovery_id: request.recoveryId,
          renderer_epoch: request.rendererEpoch,
          stream_id: request.streamId,
          session_id: request.sessionId,
          outcome,
        });
        if (!result || result.ok !== true) {
          appendClientLog('WARN', 'stream.envelope_recovery_ack_failed', {
            recoveryId: request.recoveryId.slice(0, 30),
            reason: normalizeToken(result?.reason).slice(0, 80) || 'ack_refused',
          });
          return { ok: false };
        }
        return { ok: true };
      } catch (error) {
        appendClientLog('WARN', 'stream.envelope_recovery_ack_failed', {
          recoveryId: request.recoveryId.slice(0, 30),
          message: String(error?.message || error).slice(0, 200),
        });
        return { ok: false };
      }
    }

    async function finishApplied(request, outcome) {
      rememberApplied(request, outcome);
      const ack = await acknowledge(request, outcome);
      return ack.ok === true
        ? { ok: true, outcome }
        : { ok: false, reason: 'recovery_ack_failed', outcome };
    }

    async function acknowledgeApplied(request, outcome) {
      const ack = await acknowledge(request, outcome);
      return ack.ok === true
        ? { ok: true, outcome }
        : { ok: false, reason: 'recovery_ack_failed', outcome };
    }

    // JCA-011: every in-flight canonical read's abort controller, deadline
    // timer, and settle hook are owned here so dispose() can reach them — a
    // read that never settles must not keep its 20s timer (or the underlying
    // bridge read) alive past renderer teardown.
    const activeReads = new Set();

    async function readCanonicalSession(request) {
      const entry = { abortController: new AbortController(), timer: null, settleDisposed: null };
      activeReads.add(entry);
      const read = Promise.resolve().then(() => getPersistedSession(
        request.sessionId,
        { signal: entry.abortController.signal }
      ));
      const timeout = new Promise((_, reject) => {
        entry.settleDisposed = reject;
        entry.timer = setTimeoutImpl(() => {
          entry.abortController.abort();
          reject(new Error('canonical session refresh timed out'));
        }, readDeadlineMs);
      });
      try {
        return await Promise.race([read, timeout]);
      } finally {
        if (entry.timer !== null) clearTimeoutImpl(entry.timer);
        activeReads.delete(entry);
      }
    }

    function canonicalActiveStreamId(activeTurn) {
      return normalizeToken(activeTurn?.stream_id || activeTurn?.streamId);
    }

    async function runRecovery(request, expectedGeneration) {
      try {
        fallbackToLegacy(request.reason);
      } catch (error) {
        appendClientLog('WARN', 'stream.envelope_recovery_fallback_failed', {
          sessionId: request.sessionId.slice(0, 30),
          streamId: request.streamId.slice(0, 30),
          message: String(error?.message || error).slice(0, 200),
        });
      }

      try {
        const persisted = await readCanonicalSession(request);
        if (disposed || generation !== expectedGeneration) {
          return { ok: false, reason: 'disposed' };
        }
        if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)
          || !Array.isArray(persisted.data)) {
          throw new Error('canonical session payload unavailable');
        }
        if (isStreamCurrentForSession(request.sessionId, request.streamId) === false) {
          appendClientLog('INFO', 'stream.envelope_recovery_superseded', {
            sessionId: request.sessionId.slice(0, 30),
            streamId: request.streamId.slice(0, 30),
          });
          return finishApplied(latestRequestById.get(request.key) || request, 'superseded');
        }

        const turnEvents = Array.isArray(persisted.turn_events) ? persisted.turn_events : [];
        const activeTurn = persisted.active_turn && typeof persisted.active_turn === 'object'
          && !Array.isArray(persisted.active_turn)
          ? persisted.active_turn
          : null;
        const activeStreamId = canonicalActiveStreamId(activeTurn);
        if (activeStreamId && activeStreamId !== request.streamId) {
          return finishApplied(latestRequestById.get(request.key) || request, 'superseded');
        }
        if (!hasSession(request.sessionId) && persisted.data.length === 0
          && turnEvents.length === 0 && !activeTurn) {
          return finishApplied(latestRequestById.get(request.key) || request, 'session_missing');
        }

        setSessionMessages(request.sessionId, persisted.data, `session_${request.sessionId}`);
        setSessionTurnEventState(request.sessionId, {
          turnEventLogVersion: Math.max(Number(persisted.turn_event_log_version || 0), 0),
          turnEvents,
          activeTurn,
        });
        if (activeTurn) {
          rehydrateLiveTurnState(request.sessionId);
        } else {
          clearRecoveredTerminalState(request.streamId, request.sessionId);
          clearSessionLiveTurnState(request.sessionId);
          clearChatSendLifecycle(request.sessionId);
        }
        setSessionComposerNotice(
          request.sessionId,
          'Live updates were restored from Jenny\'s saved conversation state.'
        );
        queueSessionRender(request.sessionId, {
          messages: true,
          header: true,
          composer: true,
          composerStatus: true,
          sessions: true,
          chrome: true,
        });
        appendClientLog('INFO', 'stream.envelope_recovery_applied', {
          sessionId: request.sessionId.slice(0, 30),
          streamId: request.streamId.slice(0, 30),
          activeTurn: Boolean(activeTurn),
        });
        return finishApplied(latestRequestById.get(request.key) || request, 'applied');
      } catch (error) {
        if (disposed || generation !== expectedGeneration) {
          return { ok: false, reason: 'disposed' };
        }
        appendClientLog('WARN', 'stream.envelope_recovery_failed', {
          sessionId: request.sessionId.slice(0, 30),
          streamId: request.streamId.slice(0, 30),
          message: String(error?.message || error).slice(0, 200),
        });
        try {
          setSessionComposerNotice(
            request.sessionId,
            'Live updates were interrupted. Jenny will retry recovery when the stream reconnects.'
          );
          queueSessionRender(request.sessionId, { composer: true, composerStatus: true, chrome: true });
        } catch (_error) { /* best-effort visible degradation */ }
        return { ok: false, reason: 'canonical_refresh_failed' };
      }
    }

    function recover(rawRequest = {}) {
      if (disposed) {
        return Promise.resolve({ ok: false, reason: 'disposed' });
      }
      const request = normalizeRequest(rawRequest);
      if (!request.streamId || !request.sessionId) {
        return Promise.resolve({ ok: false, reason: 'invalid_recovery_identity' });
      }
      const applied = appliedById.get(request.key);
      if (applied) {
        return acknowledgeApplied(request, applied.outcome);
      }
      const existing = inFlightById.get(request.key);
      if (existing) {
        const latest = latestRequestById.get(request.key);
        if (latest?.streamId === request.streamId && latest?.sessionId === request.sessionId
          && request.rendererEpoch >= latest.rendererEpoch) {
          latestRequestById.set(request.key, request);
        }
        return existing;
      }
      const expectedGeneration = generation;
      latestRequestById.set(request.key, request);
      const previous = tailsBySession.get(request.sessionId) || Promise.resolve();
      const task = previous.catch(() => undefined).then(() => runRecovery(request, expectedGeneration));
      inFlightById.set(request.key, task);
      const tail = task.finally(() => {
        if (inFlightById.get(request.key) === task) inFlightById.delete(request.key);
        latestRequestById.delete(request.key);
        if (tailsBySession.get(request.sessionId) === tail) tailsBySession.delete(request.sessionId);
      });
      tailsBySession.set(request.sessionId, tail);
      return task;
    }

    function dispose() {
      if (disposed) return false;
      disposed = true;
      generation += 1;
      // JCA-011: settle every stalled canonical read NOW. Rejecting the race's
      // timeout arm promptly resolves the pending recovery promise (which then
      // reports 'disposed'), the abort reaches the underlying bridge read, and
      // no deadline timer outlives the controller.
      for (const entry of [...activeReads]) {
        if (entry.timer !== null) {
          clearTimeoutImpl(entry.timer);
          entry.timer = null;
        }
        try { entry.abortController.abort(); } catch (_error) { /* best-effort */ }
        try {
          entry.settleDisposed?.(new Error('stream recovery controller disposed'));
        } catch (_error) { /* best-effort */ }
      }
      activeReads.clear();
      inFlightById.clear();
      appliedById.clear();
      latestRequestById.clear();
      tailsBySession.clear();
      return true;
    }

    return { dispose, recover };
  }

  return { createStreamRecoveryController };
});
