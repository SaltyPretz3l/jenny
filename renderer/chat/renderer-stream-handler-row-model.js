/* renderer/chat/renderer-stream-handler-row-model.js -- per-session row-model + live-turn state stores (UMD) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerRowModel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createRowModelStateUtils(options = {}) {
    const {
      state,
      normalizeId,
      getChatTimelineRowModelEnabled,
      createTurnReducerState,
    } = options || {};

    if (!state || typeof state !== 'object') {
      throw new Error('createRowModelStateUtils requires options.state');
    }
    if (typeof normalizeId !== 'function') {
      throw new Error('createRowModelStateUtils requires options.normalizeId');
    }
    if (typeof createTurnReducerState !== 'function') {
      throw new Error('createRowModelStateUtils requires options.createTurnReducerState');
    }

    function getRowModelStore() {
      if (!state.ui || typeof state.ui !== 'object') {
        state.ui = {};
      }
      if (!(state.ui.chatTimelineRowModelBySession instanceof Map)) {
        state.ui.chatTimelineRowModelBySession = new Map();
      }
      return state.ui.chatTimelineRowModelBySession;
    }

    function getLiveStateStore() {
      if (!state.ui || typeof state.ui !== 'object') {
        state.ui = {};
      }
      if (!(state.ui.chatTimelineLiveStateBySession instanceof Map)) {
        state.ui.chatTimelineLiveStateBySession = new Map();
      }
      return state.ui.chatTimelineLiveStateBySession;
    }

    function resolveDefaultRowModelEnabled() {
      const userAgent = String(globalThis?.window?.navigator?.userAgent || globalThis?.navigator?.userAgent || '').toLowerCase();
      if (userAgent.includes('jsdom')) {
        return true;
      }
      return String(state.backend?.mode || '').trim().toLowerCase() === 'managed-dev';
    }

    function buildRolloutRowKey(row) {
      const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
      return [
        String(row?.kind || ''),
        String(row?.row_id || ''),
        String(row?.primary_message_id || ''),
        String(row?.tool_call_id || payload.tool_call_id || ''),
        String(row?.phase_id || payload.phase_id || ''),
        String(payload.subkind || ''),
      ].join('|');
    }

    function isRowModelEnabled(sessionId) {
      const normalizedSessionId = normalizeId(sessionId);
      if (!normalizedSessionId) {
        return false;
      }
      if (typeof getChatTimelineRowModelEnabled === 'function') {
        return getChatTimelineRowModelEnabled(normalizedSessionId) === true;
      }
      const store = getRowModelStore();
      if (!store.has(normalizedSessionId)) {
        store.set(normalizedSessionId, resolveDefaultRowModelEnabled());
      }
      return store.get(normalizedSessionId) === true;
    }

    // DC1 flicker cure: a session opts into deterministic row_ids when the
    // internal flag is on AND its row model is live. Global-flag off (the
    // default) => false => createTurnReducerState is called with no opt-in and
    // the live rows are byte-identical.
    function isDeterministicRowIdEnabled(sessionId) {
      return state?.features?.featureFlags?.chat_timeline_deterministic_row_id === true
        && isRowModelEnabled(sessionId);
    }

    function getSessionLiveTurnState(sessionId, callOptions = {}) {
      const normalizedSessionId = normalizeId(sessionId);
      if (!normalizedSessionId) {
        return null;
      }
      const store = getLiveStateStore();
      let sessionLiveState = store.get(normalizedSessionId) || null;
      if (!sessionLiveState && callOptions.create) {
        sessionLiveState = createTurnReducerState({
          deterministicRowId: isDeterministicRowIdEnabled(normalizedSessionId),
        });
        store.set(normalizedSessionId, sessionLiveState);
      }
      return sessionLiveState;
    }

    function clearSessionLiveTurnState(sessionId) {
      const normalizedSessionId = normalizeId(sessionId);
      if (!normalizedSessionId) {
        return false;
      }
      return getLiveStateStore().delete(normalizedSessionId);
    }

    function pruneEmptySessionLiveState(sessionId, sessionLiveState) {
      const normalizedSessionId = normalizeId(sessionId);
      const liveState = sessionLiveState && typeof sessionLiveState === 'object'
        ? sessionLiveState
        : getSessionLiveTurnState(normalizedSessionId);
      if (!normalizedSessionId || !liveState) {
        return false;
      }
      const hasLiveTurns = Boolean(liveState.turns_by_id && Object.keys(liveState.turns_by_id).length);
      const hasReconciledTurns = Boolean(
        liveState.reconciled_rows_by_turn_id
        && Object.keys(liveState.reconciled_rows_by_turn_id).length
      );
      const hasPendingReconciliations = Boolean(
        liveState.pending_reconciliation_by_turn_id
        && Object.keys(liveState.pending_reconciliation_by_turn_id).length
      );
      if (!hasLiveTurns && !hasReconciledTurns && !hasPendingReconciliations) {
        return clearSessionLiveTurnState(normalizedSessionId);
      }
      return false;
    }

    return {
      getLiveStateStore,
      buildRolloutRowKey,
      isRowModelEnabled,
      isDeterministicRowIdEnabled,
      getSessionLiveTurnState,
      clearSessionLiveTurnState,
      pruneEmptySessionLiveState,
    };
  }

  return { createRowModelStateUtils };
});
