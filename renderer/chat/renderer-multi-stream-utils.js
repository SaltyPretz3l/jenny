(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererMultiStreamUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function normalizeToken(value) {
    return String(value || '').trim();
  }

  // CTL-009: chat.cancelStream resolves `false` (legacy shape) or an
  // `{ ok: false }` outcome when the backend refused the cancel — most
  // commonly the stream had already finished/was unknown by the time the IPC
  // round-trip landed. Single owner of that refusal contract; cancel call
  // sites must use this instead of re-deriving the shape.
  function isCancelStreamRefused(cancelResult) {
    return cancelResult === false
      || Boolean(cancelResult && typeof cancelResult === 'object' && cancelResult.ok === false);
  }

  function createMultiStreamController(deps) {
    const getState = typeof deps?.getState === 'function' ? deps.getState : () => ({});
    const activeStreamsBySession = new Map();
    const streamSessionById = new Map();
    const sendPreflightBySession = new Map();
    // Per-session renderer generation is the durable-in-memory correctness
    // fence for stale stream continuations. It is bounded by live/session ids,
    // not by the number of completed turns, so correctness does not expire
    // when the diagnostic stream-id tombstones roll over.
    const streamGenerationBySession = new Map();
    // Sessions whose stream has ended but whose terminal post-work (hydration
    // round-trip + refreshes + queued-send drain) is still running. During this
    // window the stream is cleared and the lifecycle is already reset to idle,
    // so without this guard a follow-up send sees an idle session, skips the
    // queue, and starts a doomed concurrent turn that races the hydration —
    // hoisting later prompts below the settled response.
    // Keyed by the CANONICAL session id: entries are only ever added in the
    // terminal handlers, which run after the first-turn optimistic→canonical
    // rekey. So — unlike queuedSendBySession / the preflight stores — this set
    // never needs a rekey hook; no entry can exist at rekey time.
    const terminalPostworkBySession = new Set();
    // CTL-013: a monotonic per-session generation counter backing the postwork
    // continuation token. beginTerminalPostworkGeneration mints a fresh token
    // when a postwork window opens; clearTerminalPostwork (deadline, normal
    // completion, or an explicit delete/dispose teardown) drops the entry so
    // any continuation still holding the old token is provably stale even
    // when the session id itself survives.
    const terminalPostworkGenerationBySession = new Map();
    // Stream ids that have reached a terminal state (recorded by clearStream,
    // which is called exclusively from the terminal stream cleanup). Consulted
    // to reject any post-terminal resurrection of a finished stream's in-flight
    // state: a late or duplicate `started` re-registering here, and — via the
    // stream handler's ensurePendingStreamEntry, which calls isStreamFinalized —
    // a trailing delta/agent_status/reasoning event re-adding the stream to
    // state.pendingStreams. Either would leave the renderer permanently
    // "streaming" (waitForIdle never resolves; follow-up actions disabled).
    // streamIds are unique per turn, so refusing re-use is always correct; the
    // optimistic→canonical session rekey re-registers a MID-FLIGHT stream via
    // clearSessionStream (which never finalizes), so it is unaffected. Bounded
    // so a long-lived renderer cannot grow it without limit.
    const FINALIZED_STREAM_ID_CAP = 1024;
    const finalizedStreamIds = new Set();
    // Stream ids whose terminal event (complete/error) actually reached its
    // terminal handler. Distinct from finalizedStreamIds: a stop/preempt calls
    // clearStream — finalizing the stream — WITHOUT any terminal ever settling
    // its partial bubble (status stays 'streaming'). The provider's genuine
    // late terminal for such a stream must still be allowed to reconcile onto
    // that bubble exactly once (the dispatch router's terminal-absorbing gate
    // consults this to grant that one-shot passthrough). Recorded by the
    // dispatch router when it routes a terminal event, so it is authoritative
    // regardless of which path called clearStream.
    const settledTerminalStreamIds = new Set();
    // L5: terminal receipt is not the same as terminal commit. Keep duplicate
    // terminals repair-eligible after an interrupted/throwing renderer commit;
    // only `committed` is absorbing. The later generation-fence slice moves
    // correctness off the bounded diagnostic tombstones below.
    const terminalCommitStateByStreamId = new Map();

    // Shared bounded-add for both stream-id registries above: evict the
    // oldest-inserted entry once past FINALIZED_STREAM_ID_CAP so a long-lived
    // renderer cannot grow either set without limit.
    function addStreamIdWithCap(registry, streamId) {
      const normalizedStreamId = normalizeToken(streamId);
      if (!normalizedStreamId) {
        return false;
      }
      registry.add(normalizedStreamId);
      if (registry.size > FINALIZED_STREAM_ID_CAP) {
        const oldest = registry.values().next().value;
        if (oldest !== undefined) {
          registry.delete(oldest);
        }
      }
      return true;
    }

    function markStreamTerminalSettled(streamId) {
      return addStreamIdWithCap(settledTerminalStreamIds, streamId);
    }

    function isStreamTerminalSettled(streamId) {
      return settledTerminalStreamIds.has(normalizeToken(streamId));
    }

    function getStreamTerminalCommitState(streamId, sessionId = '') {
      const normalizedStreamId = normalizeToken(streamId);
      const sessionRecord = streamGenerationBySession.get(normalizeToken(sessionId));
      if (sessionRecord?.streamId === normalizedStreamId) {
        return sessionRecord.terminalState === 'live' ? '' : (sessionRecord.terminalState || '');
      }
      return terminalCommitStateByStreamId.get(normalizedStreamId) || '';
    }

    function setDiagnosticTerminalState(streamId, state) {
      terminalCommitStateByStreamId.set(streamId, state);
      while (terminalCommitStateByStreamId.size > FINALIZED_STREAM_ID_CAP) {
        terminalCommitStateByStreamId.delete(terminalCommitStateByStreamId.keys().next().value);
      }
    }

    function beginStreamTerminalCommit(streamId, sessionId = '') {
      const normalizedStreamId = normalizeToken(streamId);
      if (!normalizedStreamId) return { accepted: false, state: '' };
      const normalizedSessionId = normalizeToken(sessionId);
      const state = getStreamTerminalCommitState(normalizedStreamId, normalizedSessionId);
      if (state === 'committed' || state === 'committing') {
        return { accepted: false, state };
      }
      setDiagnosticTerminalState(normalizedStreamId, 'committing');
      const sessionRecord = streamGenerationBySession.get(normalizedSessionId);
      if (sessionRecord?.streamId === normalizedStreamId) sessionRecord.terminalState = 'committing';
      markStreamTerminalSettled(normalizedStreamId);
      return { accepted: true, state: state || 'received' };
    }

    function finishStreamTerminalCommit(streamId, committed, sessionId = '') {
      const normalizedStreamId = normalizeToken(streamId);
      if (!normalizedStreamId) return '';
      const state = committed === true ? 'committed' : 'failed_repairable';
      setDiagnosticTerminalState(normalizedStreamId, state);
      const sessionRecord = streamGenerationBySession.get(normalizeToken(sessionId));
      if (sessionRecord?.streamId === normalizedStreamId) sessionRecord.terminalState = state;
      markStreamTerminalSettled(normalizedStreamId);
      return state;
    }

    function markStreamFinalized(streamId) {
      return addStreamIdWithCap(finalizedStreamIds, streamId);
    }

    function isStreamFinalized(streamId) {
      return finalizedStreamIds.has(normalizeToken(streamId));
    }

    function registerStream(sessionId, streamId) {
      const normalizedSessionId = normalizeToken(sessionId);
      const normalizedStreamId = normalizeToken(streamId);
      if (!normalizedSessionId || !normalizedStreamId) {
        return null;
      }
      // A finalized stream is done for good: never re-register it as in-flight,
      // or a late/duplicate `started` would strand the session as send-busy.
      if (isStreamFinalized(normalizedStreamId)) {
        return null;
      }
      const priorGeneration = streamGenerationBySession.get(normalizedSessionId);
      if (!priorGeneration || priorGeneration.streamId !== normalizedStreamId) {
        streamGenerationBySession.set(normalizedSessionId, {
          streamId: normalizedStreamId,
          generation: (priorGeneration?.generation || 0) + 1,
          terminalState: 'live',
        });
      } else if (priorGeneration.terminalState && priorGeneration.terminalState !== 'live') {
        return null;
      }
      const previousStreamId = normalizeToken(activeStreamsBySession.get(normalizedSessionId)?.streamId);
      if (previousStreamId && previousStreamId !== normalizedStreamId) {
        streamSessionById.delete(previousStreamId);
      }
      const previousSessionId = normalizeToken(streamSessionById.get(normalizedStreamId));
      if (previousSessionId && previousSessionId !== normalizedSessionId) {
        activeStreamsBySession.delete(previousSessionId);
      }
      activeStreamsBySession.set(normalizedSessionId, { streamId: normalizedStreamId });
      streamSessionById.set(normalizedStreamId, normalizedSessionId);
      const preflight = sendPreflightBySession.get(normalizedSessionId);
      if (preflight && typeof preflight === 'object') {
        preflight.streamId = normalizedStreamId;
      }
      return normalizedStreamId;
    }

    function clearSessionStream(sessionId) {
      const normalizedSessionId = normalizeToken(sessionId);
      if (!normalizedSessionId) {
        return null;
      }
      const streamId = normalizeToken(activeStreamsBySession.get(normalizedSessionId)?.streamId);
      if (streamId) {
        streamSessionById.delete(streamId);
      }
      activeStreamsBySession.delete(normalizedSessionId);
      return streamId || null;
    }

    function rekeySessionStream(sourceSessionId, targetSessionId) {
      const source = normalizeToken(sourceSessionId);
      const target = normalizeToken(targetSessionId);
      if (!source || !target) return null;
      if (source === target) return getStreamIdForSession(source);

      const streamId = normalizeToken(activeStreamsBySession.get(source)?.streamId);
      const sourceGeneration = streamGenerationBySession.get(source) || null;
      const targetGeneration = streamGenerationBySession.get(target) || null;
      activeStreamsBySession.delete(source);
      streamGenerationBySession.delete(source);
      if (streamId) {
        const targetStreamId = normalizeToken(activeStreamsBySession.get(target)?.streamId);
        if (targetStreamId && targetStreamId !== streamId) {
          streamSessionById.delete(targetStreamId);
        }
        activeStreamsBySession.set(target, { streamId });
        streamSessionById.set(streamId, target);
      }
      if (sourceGeneration || streamId) {
        streamGenerationBySession.set(target, {
          streamId: sourceGeneration?.streamId || streamId,
          generation: targetGeneration
            ? Math.max(sourceGeneration?.generation || 0, targetGeneration.generation || 0) + 1
            : (sourceGeneration?.generation || 1),
          terminalState: sourceGeneration?.terminalState || 'live',
        });
      }
      return streamId || null;
    }

    function forgetSessionGeneration(sessionId) {
      return streamGenerationBySession.delete(normalizeToken(sessionId));
    }

    function clearStream(streamId) {
      const normalizedStreamId = normalizeToken(streamId);
      if (!normalizedStreamId) {
        return null;
      }
      const sessionId = normalizeToken(streamSessionById.get(normalizedStreamId));
      streamSessionById.delete(normalizedStreamId);
      if (sessionId) {
        activeStreamsBySession.delete(sessionId);
        const preflight = sendPreflightBySession.get(sessionId);
        if (preflight && normalizeToken(preflight.streamId) === normalizedStreamId) {
          sendPreflightBySession.delete(sessionId);
        }
      }
      // Record the terminal so no trailing event can resurrect this stream.
      markStreamFinalized(normalizedStreamId);
      return sessionId || null;
    }

    function getStreamIdForSession(sessionId) {
      return normalizeToken(activeStreamsBySession.get(normalizeToken(sessionId))?.streamId) || null;
    }

    function getSessionIdForStream(streamId) {
      return normalizeToken(streamSessionById.get(normalizeToken(streamId))) || null;
    }

    function captureStreamGeneration(sessionId, streamId) {
      const normalizedSessionId = normalizeToken(sessionId);
      const normalizedStreamId = normalizeToken(streamId);
      const current = streamGenerationBySession.get(normalizedSessionId);
      if (!current || current.streamId !== normalizedStreamId) return null;
      return Object.freeze({
        sessionId: normalizedSessionId,
        streamId: normalizedStreamId,
        generation: current.generation,
      });
    }

    function isStreamGenerationCurrent(token) {
      if (!token || typeof token !== 'object') return false;
      const sessionId = normalizeToken(token.sessionId);
      const streamId = normalizeToken(token.streamId);
      const current = streamGenerationBySession.get(sessionId);
      return Boolean(current)
        && current.streamId === streamId
        && current.generation === Number(token.generation);
    }

    function isStreamCurrentForSession(sessionId, streamId) {
      const current = streamGenerationBySession.get(normalizeToken(sessionId));
      return !current || current.streamId === normalizeToken(streamId);
    }

    function isSessionStreaming(sessionId) {
      return Boolean(getStreamIdForSession(sessionId));
    }

    function getStreamingSessionIds() {
      return [...activeStreamsBySession.keys()].filter(Boolean);
    }

    function registerPreflight(sessionId, preflightState) {
      const normalizedSessionId = normalizeToken(sessionId);
      if (!normalizedSessionId || !preflightState || typeof preflightState !== 'object') {
        return null;
      }
      sendPreflightBySession.set(normalizedSessionId, preflightState);
      return preflightState;
    }

    function isPreflightPending(preflightState) {
      if (!preflightState || typeof preflightState !== 'object') {
        return false;
      }
      if (Object.prototype.hasOwnProperty.call(preflightState, 'pending')) {
        return preflightState.pending === true;
      }
      return true;
    }

    function clearPreflight(sessionId) {
      const normalizedSessionId = normalizeToken(sessionId);
      if (!normalizedSessionId) {
        return false;
      }
      return sendPreflightBySession.delete(normalizedSessionId);
    }

    function getPreflight(sessionId) {
      return sendPreflightBySession.get(normalizeToken(sessionId)) || null;
    }

    function getPreflightSessionIds() {
      return [...sendPreflightBySession.keys()].filter(Boolean);
    }

    function findPreflightSessionIdByStream(streamId) {
      const normalizedStreamId = normalizeToken(streamId);
      if (!normalizedStreamId) {
        return null;
      }
      for (const [sessionId, preflight] of sendPreflightBySession.entries()) {
        if (normalizeToken(preflight?.streamId) === normalizedStreamId) {
          return sessionId;
        }
      }
      return null;
    }

    function isSessionInPreflight(sessionId) {
      return isPreflightPending(getPreflight(sessionId));
    }

    function clearTerminalPostwork(sessionId) {
      const normalizedSessionId = normalizeToken(sessionId);
      terminalPostworkGenerationBySession.delete(normalizedSessionId);
      return terminalPostworkBySession.delete(normalizedSessionId);
    }

    function isSessionInTerminalPostwork(sessionId) {
      return terminalPostworkBySession.has(normalizeToken(sessionId));
    }

    // CTL-013: mint a fresh generation token for a postwork window. Capture the
    // return value before the first await and pass it through so every later
    // await can validate isTerminalPostworkGenerationCurrent before mutating
    // renderer state. This is the sole owner of postwork membership creation.
    function beginTerminalPostworkGeneration(sessionId) {
      const normalizedSessionId = normalizeToken(sessionId);
      if (!normalizedSessionId) {
        return null;
      }
      const nextGeneration = (terminalPostworkGenerationBySession.get(normalizedSessionId) || 0) + 1;
      terminalPostworkGenerationBySession.set(normalizedSessionId, nextGeneration);
      terminalPostworkBySession.add(normalizedSessionId);
      return nextGeneration;
    }

    function isTerminalPostworkGenerationCurrent(sessionId, token) {
      const normalizedSessionId = normalizeToken(sessionId);
      if (!normalizedSessionId || token === null || token === undefined) {
        return false;
      }
      return terminalPostworkGenerationBySession.get(normalizedSessionId) === token;
    }

    // Audit A5: an overlapping OLDER postwork continuation's `finally` must
    // not tear down a NEWER generation's window (e.g. a late preempt-terminal
    // settle overlapping the current turn's postwork on the same session).
    // finish is compare-and-clear: it only clears when the caller's token
    // still owns the window. A null/undefined token (stub controller wiring
    // or blank session id) falls back to the unconditional clear so the busy
    // gate can never stick. clearTerminalPostwork stays the unconditional
    // invalidation for delete/dispose/evict teardowns.
    function finishTerminalPostwork(sessionId, token) {
      const normalizedSessionId = normalizeToken(sessionId);
      if (!normalizedSessionId) {
        return false;
      }
      if (token === null || token === undefined) {
        return clearTerminalPostwork(normalizedSessionId);
      }
      if (terminalPostworkGenerationBySession.get(normalizedSessionId) !== token) {
        return false;
      }
      return clearTerminalPostwork(normalizedSessionId);
    }

    // Single source of truth for "this session cannot start a new turn right
    // now." Every send-gating call site (isSessionBusy, canQueueForSession,
    // isSendBusy) must derive from this so a future lifecycle phase can't be
    // added to one checker and missed by the others.
    function isSessionSendBusy(sessionId) {
      const normalizedSessionId = normalizeToken(sessionId);
      if (!normalizedSessionId) {
        return false;
      }
      return (
        isSessionStreaming(normalizedSessionId)
        || isSessionInPreflight(normalizedSessionId)
        || isSessionInTerminalPostwork(normalizedSessionId)
      );
    }

    function isAnySendBusy() {
      if (activeStreamsBySession.size > 0 || terminalPostworkBySession.size > 0) {
        return true;
      }
      for (const preflightState of sendPreflightBySession.values()) {
        if (isPreflightPending(preflightState)) {
          return true;
        }
      }
      return false;
    }

    function getActiveStreamIdForCancel(currentSessionId) {
      return getStreamIdForSession(currentSessionId);
    }

    function getApprovalPendingSessionIds() {
      const pending = new Set();
      for (const approval of getState()?.pendingToolApprovals?.values?.() || []) {
        const sessionId = normalizeToken(approval?.sessionId);
        if (sessionId) {
          pending.add(sessionId);
        }
      }
      return [...pending];
    }

    function dispose() {
      activeStreamsBySession.clear();
      streamSessionById.clear();
      sendPreflightBySession.clear();
      streamGenerationBySession.clear();
      terminalPostworkBySession.clear();
      terminalPostworkGenerationBySession.clear();
      finalizedStreamIds.clear();
      settledTerminalStreamIds.clear();
      terminalCommitStateByStreamId.clear();
    }

    return {
      registerStream,
      clearStream,
      clearSessionStream,
      rekeySessionStream,
      forgetSessionGeneration,
      markStreamFinalized,
      isStreamFinalized,
      markStreamTerminalSettled,
      isStreamTerminalSettled,
      getStreamTerminalCommitState,
      beginStreamTerminalCommit,
      finishStreamTerminalCommit,
      getStreamIdForSession,
      getSessionIdForStream,
      captureStreamGeneration,
      isStreamGenerationCurrent,
      isStreamCurrentForSession,
      isSessionStreaming,
      getStreamingSessionIds,
      registerPreflight,
      clearPreflight,
      getPreflight,
      getPreflightSessionIds,
      findPreflightSessionIdByStream,
      isSessionInPreflight,
      clearTerminalPostwork,
      finishTerminalPostwork,
      isSessionInTerminalPostwork,
      beginTerminalPostworkGeneration,
      isTerminalPostworkGenerationCurrent,
      isSessionSendBusy,
      isAnySendBusy,
      getActiveStreamIdForCancel,
      isCancelStreamRefused,
      getApprovalPendingSessionIds,
      dispose,
    };
  }

  return { createMultiStreamController, isCancelStreamRefused };
});
