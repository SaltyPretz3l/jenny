/* renderer/chat/renderer-stream-handler-phase-state.js -- per-stream reasoning-phase state accessors (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerPhaseState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createStreamPhaseStateUtils(options = {}) {
    const {
      streamPhaseState,
      state,
      normalizeId,
      normalizeString,
      normalizePhaseSummary,
      getSessionMessages,
      setSessionMessages,
    } = options || {};

    if (!(streamPhaseState instanceof Map)) {
      throw new Error('createStreamPhaseStateUtils requires options.streamPhaseState (Map)');
    }
    if (!state || typeof state !== 'object') {
      throw new Error('createStreamPhaseStateUtils requires options.state');
    }
    if (typeof normalizeId !== 'function' || typeof normalizeString !== 'function') {
      throw new Error('createStreamPhaseStateUtils requires options.normalizeId and options.normalizeString');
    }
    if (typeof normalizePhaseSummary !== 'function') {
      throw new Error('createStreamPhaseStateUtils requires options.normalizePhaseSummary');
    }
    if (typeof getSessionMessages !== 'function' || typeof setSessionMessages !== 'function') {
      throw new Error('createStreamPhaseStateUtils requires options.getSessionMessages and options.setSessionMessages');
    }

    function getOrCreateStreamPhaseState(streamId) {
      const normalizedStreamId = normalizeId(streamId);
      if (!normalizedStreamId) {
        return { phases: [] };
      }
      let entry = streamPhaseState.get(normalizedStreamId);
      if (!entry) {
        entry = { phases: [] };
        streamPhaseState.set(normalizedStreamId, entry);
      }
      return entry;
    }

    function getReasoningPhasesForStream(streamId) {
      const entry = streamPhaseState.get(normalizeId(streamId));
      return Array.isArray(entry?.phases) ? entry.phases.map((phase) => ({ ...phase })) : [];
    }

    function updateStreamPhaseState(payload, completed) {
      const entry = getOrCreateStreamPhaseState(payload.streamId);
      const phaseId = normalizeString(payload.phaseId);
      if (!phaseId) {
        return getReasoningPhasesForStream(payload.streamId);
      }
      const summary = normalizePhaseSummary(payload.summary);
      const nextPhase = {
        phaseId,
        phaseKind: normalizeString(payload.phaseKind),
        iteration: Number(payload.iteration || 0) || 0,
        thinkingId: normalizeString(payload.thinkingId),
        toolCallId: normalizeString(payload.toolCallId),
        toolName: normalizeString(payload.toolName),
        completed: completed === true,
        // The message normaliser (chat-message-utils normalizeReasoningPhases)
        // derives `completed` from completedAt, not from this boolean, so a
        // completed phase must carry its timestamp or the row keeps streaming.
        ...(completed === true ? { completedAt: new Date().toISOString() } : { startedAt: new Date().toISOString() }),
      };
      if (summary) {
        nextPhase.summary = summary;
      }
      const existingIndex = entry.phases.findIndex((phase) => phase.phaseId === phaseId);
      if (existingIndex !== -1) {
        const existingPhase = entry.phases[existingIndex];
        const existingSummary = normalizePhaseSummary(existingPhase.summary);
        const isNewerIteration = nextPhase.iteration > 0
          && nextPhase.iteration > (Number(existingPhase.iteration || 0) || 0);
        const mergedPhase = {
          ...existingPhase,
          ...nextPhase,
          completed: isNewerIteration
            ? completed === true
            : completed === true || existingPhase.completed === true,
        };
        if (isNewerIteration) {
          // Reopening the round must drop the prior round's completedAt too, or
          // the normaliser derives `completed` from it and re-settles the row.
          delete mergedPhase.completedAt;
        } else if (existingPhase.startedAt) {
          // Earliest start wins (renderer-turn-reducer.js:443): a repeated
          // phase_started echo must not push startedAt past completedAt.
          mergedPhase.startedAt = existingPhase.startedAt;
        }
        // A newer iteration starts a fresh reasoning round: like `completed`
        // above, it must not inherit the prior iteration's summary, or the
        // live header shows last round's text next to this round's throbber.
        if (summary) {
          mergedPhase.summary = summary;
        } else if (!isNewerIteration && existingSummary) {
          mergedPhase.summary = existingSummary;
        } else {
          delete mergedPhase.summary;
        }
        entry.phases[existingIndex] = mergedPhase;
      } else {
        entry.phases.push(nextPhase);
      }
      return getReasoningPhasesForStream(payload.streamId);
    }

    function syncPendingMessagePhaseState(payload) {
      const pendingId = state.pendingStreams?.get?.(payload.streamId);
      if (!pendingId) {
        return null;
      }
      const sessionMessages = [...getSessionMessages(payload.sessionId)];
      const idx = sessionMessages.findIndex((message) => message.id === pendingId);
      if (idx === -1) {
        return null;
      }
      sessionMessages[idx] = {
        ...sessionMessages[idx],
        reasoning_phases: getReasoningPhasesForStream(payload.streamId),
      };
      setSessionMessages(payload.sessionId, sessionMessages, `session_${payload.sessionId}`);
      return sessionMessages[idx];
    }

    function settleUnfinishedReasoningPhases(payload) {
      const streamId = normalizeId(payload?.streamId);
      const entry = streamPhaseState.get(streamId);
      const completedAt = new Date().toISOString();
      if (Array.isArray(entry?.phases)) {
        entry.phases = entry.phases.map((phase) => (
          phase.completed === true ? phase : { ...phase, completed: true, completedAt }
        ));
      }
      const pendingId = state.pendingStreams?.get?.(payload?.streamId);
      if (!pendingId) return 0;
      const sessionMessages = [...getSessionMessages(payload?.sessionId)];
      const idx = sessionMessages.findIndex((message) => message.id === pendingId);
      if (idx === -1) return 0;
      const messagePhases = Array.isArray(sessionMessages[idx]?.reasoning_phases)
        ? sessionMessages[idx].reasoning_phases
        : [];
      const sourcePhases = messagePhases.length ? messagePhases : getReasoningPhasesForStream(streamId);
      const unfinishedCount = sourcePhases.filter((phase) => phase?.completed !== true).length;
      if (!sourcePhases.length) return 0;
      sessionMessages[idx] = {
        ...sessionMessages[idx],
        reasoning_phases: sourcePhases.map((phase) => (
          phase?.completed === true ? phase : { ...phase, completed: true, completedAt }
        )),
      };
      setSessionMessages(payload.sessionId, sessionMessages, `session_${payload.sessionId}`);
      return unfinishedCount;
    }

    return {
      getReasoningPhasesForStream,
      settleUnfinishedReasoningPhases,
      updateStreamPhaseState,
      syncPendingMessagePhaseState,
    };
  }

  return { createStreamPhaseStateUtils };
});
