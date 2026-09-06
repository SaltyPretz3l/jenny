(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function resolveDependencyModule(globalName, modulePath) {
    if (typeof globalThis !== 'undefined' && globalThis[globalName]) {
      return globalThis[globalName];
    }
    if (typeof require === 'function') {
      try { return require(modulePath); } catch (_error) { /* unavailable in browser script mode */ }
    }
    return null;
  }

  const _stringUtils = resolveDependencyModule('stringUtils', '../shared/string-utils');
  if (!_stringUtils || typeof _stringUtils.normalizeString !== 'function' || typeof _stringUtils.normalizeId !== 'function') {
    throw new Error('string-utils must load before renderer/chat/renderer-stream-handler.js');
  }
  const { normalizeString, normalizeId } = _stringUtils;
  const _renderFrameUtils = resolveDependencyModule('rendererStreamHandlerRenderFrame', './renderer-stream-handler-render-frame');
  if (!_renderFrameUtils
    || typeof _renderFrameUtils.isRenderableBufferedStreamEvent !== 'function'
    || typeof _renderFrameUtils.waitForRenderFrame !== 'function') {
    throw new Error('renderer-stream-handler-render-frame must load before renderer/chat/renderer-stream-handler.js');
  }
  const {
    FLUSH_RENDERABLE_BATCH_SIZE,
    isRenderableBufferedStreamEvent,
    waitForRenderFrame,
  } = _renderFrameUtils;
  const _agentStatusUtils = resolveDependencyModule('rendererStreamHandlerAgentStatus', './renderer-stream-handler-agent-status');
  if (!_agentStatusUtils
    || typeof _agentStatusUtils.normalizePhaseSummary !== 'function'
    || typeof _agentStatusUtils.appendAgentStatusStep !== 'function') {
    throw new Error('renderer-stream-handler-agent-status must load before renderer/chat/renderer-stream-handler.js');
  }
  const { normalizePhaseSummary, appendAgentStatusStep } = _agentStatusUtils;
  const _rowModelUtils = resolveDependencyModule('rendererStreamHandlerRowModel', './renderer-stream-handler-row-model');
  if (!_rowModelUtils || typeof _rowModelUtils.createRowModelStateUtils !== 'function') {
    throw new Error('renderer-stream-handler-row-model must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createRowModelStateUtils } = _rowModelUtils;
  const _reducerWiringUtils = resolveDependencyModule('rendererStreamHandlerReducerWiring', './renderer-stream-handler-reducer-wiring');
  if (!_reducerWiringUtils || typeof _reducerWiringUtils.createReducerWiring !== 'function') {
    throw new Error('renderer-stream-handler-reducer-wiring must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createReducerWiring } = _reducerWiringUtils;
  const _phaseStateUtils = resolveDependencyModule('rendererStreamHandlerPhaseState', './renderer-stream-handler-phase-state');
  if (!_phaseStateUtils || typeof _phaseStateUtils.createStreamPhaseStateUtils !== 'function') {
    throw new Error('renderer-stream-handler-phase-state must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createStreamPhaseStateUtils } = _phaseStateUtils;
  const _dispatchUtils = resolveDependencyModule('rendererStreamHandlerDispatch', './renderer-stream-handler-dispatch');
  if (!_dispatchUtils || typeof _dispatchUtils.createStreamDispatchRouter !== 'function') {
    throw new Error('renderer-stream-handler-dispatch must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createStreamDispatchRouter } = _dispatchUtils;
  const _liveTailUtils = resolveDependencyModule('rendererStreamToolLiveTail', './renderer-stream-tool-live-tail');
  if (!_liveTailUtils || typeof _liveTailUtils.createToolLiveTail !== 'function') {
    throw new Error('renderer-stream-tool-live-tail must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createToolLiveTail } = _liveTailUtils;
  const _terminalSettleUtils = resolveDependencyModule('rendererStreamHandlerTerminalSettle', './renderer-stream-handler-terminal-settle');
  if (!_terminalSettleUtils || typeof _terminalSettleUtils.createTerminalSettleHandlers !== 'function') {
    throw new Error('renderer-stream-handler-terminal-settle must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createTerminalSettleHandlers } = _terminalSettleUtils;
  // Optional: phantom activity row for silent arg-generation phases. Absence
  // degrades to the pre-existing dead-air behavior, never a load failure.
  const _activityRowUtils = resolveDependencyModule('rendererStreamActivityRow', './renderer-stream-activity-row');
  const createStreamActivityRow = typeof _activityRowUtils?.createStreamActivityRow === 'function'
    ? _activityRowUtils.createStreamActivityRow
    : function noopCreateStreamActivityRow() {
      return { noteStreamEvent() {}, tick() {}, reset() {}, dispose() {} };
    };
  // Optional (UIUX-029): the shared live-announcer factory. Absence degrades to
  // silent tool-status transitions, never a load failure.
  const _liveAnnouncerUtils = resolveDependencyModule('rendererLiveAnnouncer', '../shared/renderer-live-announcer');
  const _sessionHelpersUtils = resolveDependencyModule('rendererStreamHandlerSessionHelpers', './renderer-stream-handler-session-helpers');
  if (!_sessionHelpersUtils || typeof _sessionHelpersUtils.createStreamSessionHelpers !== 'function') {
    throw new Error('renderer-stream-handler-session-helpers must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createStreamSessionHelpers } = _sessionHelpersUtils;
  const _streamBufferUtils = resolveDependencyModule('rendererStreamBufferUtils', './renderer-stream-buffer-utils');
  if (!_streamBufferUtils || typeof _streamBufferUtils.createDegradedStreamRecovery !== 'function') {
    throw new Error('renderer-stream-buffer-utils must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createDegradedStreamRecovery } = _streamBufferUtils;
  const _streamRecoveryUtils = resolveDependencyModule('rendererStreamRecovery', './renderer-stream-recovery');
  if (!_streamRecoveryUtils || typeof _streamRecoveryUtils.createStreamRecoveryController !== 'function') {
    throw new Error('renderer-stream-recovery must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createStreamRecoveryController } = _streamRecoveryUtils;
  const _reasoningMergeUtils = resolveDependencyModule('rendererStreamHandlerReasoningMerge', './renderer-stream-handler-reasoning-merge');
  if (!_reasoningMergeUtils
    || typeof _reasoningMergeUtils.createReasoningStreamMerger !== 'function') {
    throw new Error('renderer-stream-handler-reasoning-merge must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createReasoningStreamMerger } = _reasoningMergeUtils;
  const _reasoningPhaseStatusUtils = resolveDependencyModule('rendererStreamHandlerReasoningPhaseStatus', './renderer-stream-handler-reasoning-phase-status');
  if (!_reasoningPhaseStatusUtils || typeof _reasoningPhaseStatusUtils.createStreamReasoningPhaseStatusHandlers !== 'function') {
    throw new Error('renderer-stream-handler-reasoning-phase-status must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createStreamReasoningPhaseStatusHandlers } = _reasoningPhaseStatusUtils;
  const _pendingMessageUtils = resolveDependencyModule('rendererStreamHandlerPendingMessage', './renderer-stream-handler-pending-message');
  if (!_pendingMessageUtils || typeof _pendingMessageUtils.createPendingMessageUtils !== 'function') {
    throw new Error('renderer-stream-handler-pending-message must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createPendingMessageUtils } = _pendingMessageUtils;
  const _lifecycleUtils = resolveDependencyModule('rendererStreamHandlerLifecycle', './renderer-stream-handler-lifecycle');
  if (!_lifecycleUtils || typeof _lifecycleUtils.createStreamHandlerLifecycle !== 'function') {
    throw new Error('renderer-stream-handler-lifecycle must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createStreamHandlerLifecycle } = _lifecycleUtils;
  const _liveEventsUtils = resolveDependencyModule('rendererStreamHandlerLiveEvents', './renderer-stream-handler-live-events');
  if (!_liveEventsUtils || typeof _liveEventsUtils.createStreamLiveEventHandlers !== 'function') {
    throw new Error('renderer-stream-handler-live-events must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createStreamLiveEventHandlers } = _liveEventsUtils;
  const _streamEnvelopeV2Utils = resolveDependencyModule('rendererStreamEnvelopeV2', './renderer-stream-envelope-v2');
  if (!_streamEnvelopeV2Utils
    || typeof _streamEnvelopeV2Utils.streamEnvelopeToLegacyPayload !== 'function'
    || typeof _streamEnvelopeV2Utils.createStreamEnvelopeSequenceGuard !== 'function'
    || typeof _streamEnvelopeV2Utils.createStreamEnvelopeReceiptTracker !== 'function') {
    throw new Error('renderer-stream-envelope-v2 must load before renderer/chat/renderer-stream-handler.js');
  }
  const {
    STREAM_ENVELOPE_SCHEMA_VERSION,
    createStreamEnvelopeReceiptTracker,
    createStreamEnvelopeSequenceGuard,
    streamEnvelopeToLegacyPayload,
  } = _streamEnvelopeV2Utils;
  const streamHandlerRuntime = resolveDependencyModule('rendererStreamHandlerRuntime', './renderer-stream-handler-runtime');
  const createStreamHandlerRuntime = streamHandlerRuntime?.createStreamHandlerRuntime || function missingStreamHandlerRuntime() { return {}; };
  const streamRevealUtils = resolveDependencyModule('rendererStreamRevealUtils', './renderer-stream-reveal-utils');
  const settleVisibleStreamAffordances = streamRevealUtils?.settleVisibleStreamAffordances || function noopSettleVisibleStreamAffordances() {
    return { cleared: false, roots: 0 };
  };
  const streamToolPatchUtils = resolveDependencyModule('rendererStreamToolPatchUtils', './renderer-stream-tool-patch-utils');
  const createLiveToolPatchController = streamToolPatchUtils?.createLiveToolPatchController || function missingLiveToolPatchController() {
    return { queueToolPatch() { return false; }, dispose() {} };
  };
  const streamHandlerTools = resolveDependencyModule('rendererStreamHandlerTools', './renderer-stream-handler-tools');
  const createStreamToolHandlers = streamHandlerTools?.createStreamToolHandlers || function missingStreamToolHandlers() { return {}; };
  const streamHandlerTerminal = resolveDependencyModule('rendererStreamHandlerTerminal', './renderer-stream-handler-terminal');
  const createStreamTerminalHandlers = streamHandlerTerminal?.createStreamTerminalHandlers || function missingStreamTerminalHandlers() { return {}; };
  const streamPendingCommitUtils = resolveDependencyModule('rendererStreamPendingCommitUtils', './renderer-stream-pending-commit-utils');
  const timelineVisibilityUtils = resolveDependencyModule('rendererTimelineVisibilityUtils', './renderer-timeline-visibility-utils');
  const createPendingStreamCommitQueue = streamPendingCommitUtils?.createPendingStreamCommitQueue
    || function missingPendingStreamCommitQueue(options) {
      return {
        stage(_key, value) { return options?.commit?.(value); },
        commitNow(value) { return options?.commit?.(value); },
        flush() { return null; },
        flushWhere() { return []; },
        drop() {},
        dispose() {},
        pendingCount() { return 0; },
      };
    };
  const getTimelineVisibilityTracker = timelineVisibilityUtils?.getTimelineVisibilityTracker
    || function fallbackGetTimelineVisibilityTracker() {
      return {
        markRenderableEvent() { return null; },
        hasHiddenCatchup() { return false; },
      };
    };
  // UIUX-029: build (once) the shared live-announcer over the persistent
  // #srAnnounce* regions from index.html. Returns null when the factory or the
  // regions are absent (stripped-down harness DOMs) — callers treat that as
  // "announcements off", never an error.
  function resolveSharedLiveAnnouncer() {
    const windowRef = globalThis.window || globalThis;
    if (windowRef.rendererLiveAnnouncerInstance) return windowRef.rendererLiveAnnouncerInstance;
    const factory = _liveAnnouncerUtils && typeof _liveAnnouncerUtils.createLiveAnnouncer === 'function'
      ? _liveAnnouncerUtils.createLiveAnnouncer
      : null;
    const doc = windowRef.document;
    if (!factory || !doc || typeof doc.getElementById !== 'function') return null;
    const politeRegion = doc.getElementById('srAnnouncePolite');
    const assertiveRegion = doc.getElementById('srAnnounceAssertive');
    if (!politeRegion && !assertiveRegion) return null;
    const announcer = factory({ dom: { politeRegion, assertiveRegion } });
    windowRef.rendererLiveAnnouncerInstance = announcer;
    return announcer;
  }

  function createStreamHandler(deps) {
    const { state } = deps;
    const thinkingIndicator = deps.thinkingIndicator || null;
    const timelineVirtualizer = deps.timelineVirtualizer || null;
    const multiStreamController = deps.multiStreamController || globalThis.rendererMultiStreamController || null;
    const {
      MESSAGE_STATUS,
      MAX_INTERACTIVE_QUESTIONS,
      MAX_INTERACTIVE_ROUNDS,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
      TOAST_SOURCE,
    } = deps.constants;
    const { chatInput, chatTimeline } = deps.dom;
    const {
      renderAll,
      renderHeader,
      renderMessages,
      syncTurnElapsedClock = () => {},
      renderSessions,
      renderSettings,
      renderComposerState,
      renderComposerStatusNotice,
      renderWorkspaceChrome,
      getSessionMessages,
      setSessionMessages,
      setSessionTurnEventState = () => {},
      createNormalizedMessage,
      setComposerStatusNotice,
      clearComposerStatusNotice,
      setTurnStatusPill = () => {},
      clearTurnStatusPill = () => {},
      clearTurnStatusPillSources = () => {},
      normalizePendingQuestionBatch,
      getInteractiveSequenceState,
      clearInteractiveDraft,
      ensureInteractiveDraft,
      patchSessionSummary,
      buildInteractiveQuestionBatchVisibleText,
      refreshSessionSummaries,
      // Test-only direct override (CTL-006): production wiring always relies on
      // the sessionHelpers-derived refreshSessionMetadata below, which wraps
      // refreshSessionSummaries + a chrome re-render. A caller that needs to
      // stub the exact terminal-handler dependency name (e.g. to simulate a
      // hung metadata refresh under a deadline) may pass this directly.
      refreshSessionMetadata: refreshSessionMetadataOverride,
      refreshSnapshots,
      refreshObservability = async () => {},
      showToastMessage,
      dismissStreamErrors,
      maybeSuggestMemoryCapture,
      appendClientLog,
      getInteractiveComposerStatusNotice,
      persistInteractiveFallbackRequest,
      requestInteractiveGuardrailAnswer,
      queueInteractiveComposerFocus,
      mergeMessageReasoning,
      getQueuedSend,
      restoreQueuedSendDraft,
      dispatchQueuedSendForSession,
      updateContextUsage = () => {},
      handlePresenceStreamEvent = () => {},
      handleWorkspaceActivityStreamEvent = () => {},
      setChatSendLifecycle = () => 'idle',
      clearChatSendLifecycle = () => false,
      getChatSendLifecycle = () => 'idle',
      getChatTimelineRowModelEnabled = () => false,
      recordChatTimelineRolloutSignal = () => ({ logged: false, count: 0 }),
      noteTimelineMessageCreated = () => false,
      invalidateProjectionStateForSession = () => 0,
      // Background Effects v3 S5 W1b: surface-activity impulse callbacks,
      // forwarded to the live-events / tool / runtime sub-factories below.
      publishFirstTokenImpulse = () => {},
      publishToolStartImpulse = () => {},
      publishCompleteImpulse = () => {},
    } = deps.callbacks;
    const MAX_BUFFER_PER_STREAM = 500;
    const BUFFER_EXPIRY_MS = 60000;
    const MAX_REASONING_MERGE_STREAMS = 128;
    const approvalToastSessionIds = new Set();
    let fallbackEnvelopeToLegacy = () => null;
    let rehydrateEnvelopeFault = () => null;
    let recoverEnvelopeFault = () => Promise.resolve({ ok: false, reason: 'recovery_unavailable' });
    const streamEnvelopeSequenceGuard = createStreamEnvelopeSequenceGuard({ appendClientLog });
    const streamEnvelopeReceiptTracker = createStreamEnvelopeReceiptTracker({
      appendClientLog,
      sendAck: (record) => globalThis.window?.jennyShell?.chat?.ackEnvelopeReceipt?.(record) || null,
      onRejected: (result, record) => {
        if (normalizeString(record?.recordType || record?.record_type) === 'stream_fault') {
          fallbackEnvelopeToLegacy(result?.reason || 'sequence_fault_rejected');
          return;
        }
        if (result?.recovery_ticket_issued === true) {
          fallbackEnvelopeToLegacy(result?.reason || 'receipt_rejected');
          return;
        }
        recoverEnvelopeFault({
          stream_id: record?.streamId || record?.stream_id,
          session_id: record?.sessionId || record?.session_id,
          turn_id: record?.turnId || record?.turn_id,
          reason: result?.reason || 'receipt_rejected',
        });
      },
    });
    let startupAuditFirstStreamEventMarked = false;

    function markStartupAudit(name, details = {}) {
      try {
        globalThis.__jennyStartupAudit?.mark?.(name, details);
      } catch (_error) {
        // Best effort only.
      }
    }
    const turnReducerUtils = resolveDependencyModule('rendererTurnReducer', './renderer-turn-reducer');
    const turnTreeProjectorUtils = resolveDependencyModule('rendererTurnTreeProjector', './renderer-turn-tree-projector');
    const turnRowProjectorUtils = resolveDependencyModule('rendererTurnRowProjector', './renderer-turn-row-projector');
    const streamRehydrateUtils = resolveDependencyModule('rendererStreamRehydrate', './renderer-stream-rehydrate');
    const createTurnReducerState = turnReducerUtils?.createTurnReducerState
      || function missingCreateTurnReducerState() { return { active_turn_id: '', turns_by_id: Object.create(null), reconciled_rows_by_turn_id: Object.create(null) }; };
    const buildTurnEventFromStreamPayload = turnReducerUtils?.buildTurnEventFromStreamPayload
      || function missingBuildTurnEventFromStreamPayload() { return null; };
    const applyTurnStreamEvent = turnReducerUtils?.applyTurnStreamEvent
      || function missingApplyTurnStreamEvent(currentState) { return currentState; };
    const reconcileTurnRows = turnReducerUtils?.reconcileTurnRows
      || function missingReconcileTurnRows(_provisionalRows, hydratedRows) { return { finalRows: Array.isArray(hydratedRows) ? hydratedRows.slice() : [], staleRows: [] }; };
    // Per-stream text segmentation state; aggregateOffset = cursor already projected into live row-model
    // text, segmentBaseOffset = where the current segment began (W3.6 mixed text+tool bubble slice base).
    const streamSegmentState = new Map();
    // Per-stream semantic phase state retained only for live renderer grouping.
    const streamPhaseState = new Map();
    const rowModelStateUtils = createRowModelStateUtils({
      state,
      normalizeId,
      getChatTimelineRowModelEnabled,
      createTurnReducerState,
    });
    const {
      getLiveStateStore,
      buildRolloutRowKey,
      isRowModelEnabled,
      isDeterministicRowIdEnabled,
      getSessionLiveTurnState,
      clearSessionLiveTurnState,
      pruneEmptySessionLiveState,
    } = rowModelStateUtils;
    const reducerWiring = createReducerWiring({
      streamSegmentState,
      normalizeId,
      normalizeString,
      getSessionMessages,
      isRowModelEnabled,
      getSessionLiveTurnState,
      pruneEmptySessionLiveState,
      buildRolloutRowKey,
      buildTurnEventFromStreamPayload,
      applyTurnStreamEvent,
      reconcileTurnRows,
      turnTreeProjectorUtils,
      turnRowProjectorUtils,
      streamRehydrateUtils,
      isCanonicalRendererProjectionEnabled(sessionId) {
        return state?.features?.featureFlags?.canonical_renderer_projection === true
          && isRowModelEnabled(sessionId);
      },
      isDeterministicRowIdEnabled,
      recordChatTimelineRolloutSignal,
      // chat_timeline_render_telemetry (Track A): TEMPORARY render-path
      // diagnostics for the streaming-flicker investigation. Same live-state
      // read pattern as isCanonicalRendererProjectionEnabled above; absent
      // state/flag-off = the affirmative "clean reconcile" signal never fires.
      isRenderTelemetryEnabled(sessionId) {
        return state?.features?.featureFlags?.chat_timeline_render_telemetry === true
          && isRowModelEnabled(sessionId);
      },
      appendClientLog,
    });
    const {
      buildAssistantShellMessageId,
      applyLiveTurnPayload,
      reconcileLiveTurnWithHydratedRows,
    } = reducerWiring;
    function isCurrentSession(sessionId) { return normalizeId(sessionId) === normalizeId(state.currentSessionId); }
    // Widened render gate (ide_chat_dock): the chat subtree is live when EITHER
    // the Chat view or the open Workspace dock is showing it. This predicate is
    // passed by reference into the 6 DI submodules (session-helpers, runtime,
    // live-events, terminal, reasoning-phase-status, tool-patch-utils), so
    // widening it here widens all six. Falls back to the pre-dock
    // `activeView === 'chat'` when the helper script is absent (flag-off-safe).
    function isChatSurfaceLive(current) {
      return (globalThis.rendererChatSurfaceLiveUtils || {}).isChatSurfaceLive?.(current)
        ?? (current?.ui?.activeView === 'chat');
    }
    function isVisibleChatSession(sessionId) { return isCurrentSession(sessionId) && isChatSurfaceLive(state); }
    const timelineVisibilityTracker = getTimelineVisibilityTracker(state, { appendClientLog });
    const sessionHelpers = createStreamSessionHelpers({
      state,
      normalizeId,
      appendClientLog,
      multiStreamController,
      maxBufferPerStream: MAX_BUFFER_PER_STREAM,
      bufferExpiryMs: BUFFER_EXPIRY_MS,
      timelineVisibilityTracker,
      isCurrentSession,
      isVisibleChatSession,
      refreshSessionSummaries,
      // queueRender is created by the runtime factory below — defer resolution.
      queueRender: (...args) => queueRender(...args),
      setComposerStatusNotice,
      clearComposerStatusNotice,
      setTurnStatusPill,
      clearTurnStatusPill,
      clearTurnStatusPillSources,
      showToastMessage,
      toastSource: TOAST_SOURCE,
      approvalToastSessionIds,
    });
    const {
      markHiddenRenderableEvent,
      markHiddenRenderableRender,
      resolvePayloadSessionId,
      getPreflightForPayload,
      notePreflightEvent,
      shouldBufferStreamEvent,
      bufferStreamEvent,
      consumeBufferedStreamDegradation,
      evictStaleBufferedEvents,
      clearBufferedStreamEvents,
      refreshSessionMetadata,
      setSessionComposerNotice,
      clearSessionComposerNotice,
      setSessionTurnStatusPill,
      clearSessionTurnStatusPill,
      clearSessionTurnStatusPillSources,
      showApprovalToast,
    } = sessionHelpers;

    const runtime = createStreamHandlerRuntime({
      state,
      thinkingIndicator,
      multiStreamController,
      appendClientLog,
      renderAll,
      renderHeader,
      renderMessages,
      renderSessions,
      renderSettings,
      renderComposerState,
      renderComposerStatusNotice,
      renderWorkspaceChrome,
      afterRender: () => {
        evictStaleBufferedEvents();
        syncTurnElapsedClock();
      },
      getQueuedSend,
      restoreQueuedSendDraft,
      clearSessionComposerNotice,
      clearSessionTurnStatusPill,
      clearSessionTurnStatusPillSources,
      getChatSendLifecycle,
      setChatSendLifecycle,
      clearChatSendLifecycle,
      isCurrentSession,
      isVisibleChatSession,
      markHiddenRenderableEvent: markHiddenRenderableRender,
      publishCompleteImpulse,
    });
    const syncThinkingIndicatorMode = runtime.syncThinkingIndicatorMode || function noopSyncThinkingIndicatorMode() {};
    const completeThinkingIndicator = runtime.completeThinkingIndicator || function noopCompleteThinkingIndicator() {};
    const resetThinkingIndicator = runtime.resetThinkingIndicator || function noopResetThinkingIndicator() {};
    const queueRender = runtime.queueRender || function noopQueueRender() {};
    const queueSessionRender = runtime.queueSessionRender || function noopQueueSessionRender() {};
    const handleBufferDegraded = createDegradedStreamRecovery({
      getPersistedSession: (sessionId) => globalThis.window?.jennyShell?.sessions?.getMessages?.(sessionId),
      setSessionMessages,
      setSessionTurnEventState,
      setSessionComposerNotice,
      queueSessionRender,
      appendClientLog,
    });
    const setStreamThinkingStatus = runtime.setStreamThinkingStatus || function noopSetStreamThinkingStatus() {};
    const clearStreamThinkingStatus = runtime.clearStreamThinkingStatus || function noopClearStreamThinkingStatus() {};
    const releaseApprovalToastSessions = runtime.releaseApprovalToastSessions
      ? (sessionIds) => runtime.releaseApprovalToastSessions(approvalToastSessionIds, sessionIds)
      : function noopReleaseApprovalToastSessions() {};
    const clearTerminalStreamState = runtime.clearTerminalStreamState
      ? (streamId) => runtime.clearTerminalStreamState(
        approvalToastSessionIds,
        streamSegmentState,
        streamPhaseState,
        streamId
      )
      : function noopClearTerminalStreamState() {};
    const finalizeTerminalStream = runtime.finalizeTerminalStream
      ? (payload, options) => runtime.finalizeTerminalStream(
        approvalToastSessionIds,
        streamSegmentState,
        streamPhaseState,
        payload,
        options
      )
      : function noopFinalizeTerminalStream() {};
    const resetLifecycleIfSettling = runtime.resetLifecycleIfSettling || function noopResetLifecycleIfSettling() {};
    let recoveryRehydrateLiveTurnState = () => null;
    let clearRecoveredTerminalState = (streamId) => clearTerminalStreamState(streamId);
    const streamRecoveryController = createStreamRecoveryController({
      // JCA-011: thread the controller's read options (abort signal) through to
      // the bridge instead of dropping them, so disposal can cancel the read.
      getPersistedSession: (sessionId, options) => globalThis.window?.jennyShell?.sessions?.getMessages?.(sessionId, options),
      setSessionMessages,
      setSessionTurnEventState,
      clearRecoveredTerminalState: (streamId, sessionId) => clearRecoveredTerminalState(streamId, sessionId),
      clearSessionLiveTurnState,
      rehydrateLiveTurnState: (sessionId) => recoveryRehydrateLiveTurnState(sessionId),
      clearChatSendLifecycle,
      queueSessionRender,
      setSessionComposerNotice,
      fallbackToLegacy: (reason) => fallbackEnvelopeToLegacy(reason),
      isStreamCurrentForSession: (sessionId, streamId) => (
        multiStreamController?.isStreamCurrentForSession?.(sessionId, streamId) !== false
      ),
      hasSession: (sessionId) => (
        Array.isArray(state.sessions)
        && state.sessions.some((session) => normalizeId(session?.id) === normalizeId(sessionId))
      ),
      acknowledgeRecovery: (record) => globalThis.window?.jennyShell?.chat?.ackEnvelopeReceipt?.(record),
      appendClientLog,
    });
    recoverEnvelopeFault = (request) => streamRecoveryController.recover(request);
    // UIUX-029: tool-activity terminal statuses route through the one shared
    // live-announcer channel. Injectable for tests (pass announcer: null to
    // disable); otherwise built once from the persistent #srAnnounce* regions
    // and stashed on the window so future consumers reuse the same throttled
    // channel instead of growing another bespoke live region.
    const liveAnnouncer = deps.announcer !== undefined
      ? deps.announcer
      : resolveSharedLiveAnnouncer();
    const liveToolPatchController = createLiveToolPatchController({
      windowRef: globalThis.window || globalThis,
      announcer: liveAnnouncer,
      chatTimeline,
      timelineVirtualizer,
      appendClientLog,
      isVisibleChatSession,
      shouldBlockLivePatch() {
        return state.ui?.editCommitting === true || state.ui?.bulkTruncateCommitting === true;
      },
      onFallback(sessionId) {
        queueSessionRender(sessionId, {
          messages: true,
          composerStatus: true,
          composer: true,
          header: true,
          sessions: true,
        });
      },
    });

    const phaseStateUtils = createStreamPhaseStateUtils({
      streamPhaseState,
      state,
      normalizeId,
      normalizeString,
      normalizePhaseSummary,
      getSessionMessages,
      setSessionMessages,
    });
    const {
      getReasoningPhasesForStream,
      settleUnfinishedReasoningPhases,
      updateStreamPhaseState,
      syncPendingMessagePhaseState,
    } = phaseStateUtils;
    const pendingMessageUtils = createPendingMessageUtils({
      state,
      normalizeId,
      normalizeString,
      streamSegmentState,
      MESSAGE_STATUS,
      appendClientLog,
      getSessionMessages,
      setSessionMessages,
      createNormalizedMessage,
      getReasoningPhasesForStream,
      createPendingStreamCommitQueue,
      queueRender,
      timelineVisibilityTracker,
      noteTimelineMessageCreated,
      isStreamFinalized: (streamId) => multiStreamController?.isStreamFinalized?.(streamId) === true,
    });
    const {
      optimisticAppend,
      ensurePendingStreamEntry,
      ensureRenderableReasoningStreamEntry,
      updatePendingMessage,
      pendingStreamCommitQueue,
      flushPendingStreamCommit,
      flushPendingStreamCommitsForSession,
    } = pendingMessageUtils;
    const reasoningStreamMerger = createReasoningStreamMerger({
      normalizeId,
      mergeMessageReasoning,
      appendClientLog,
      flushPendingStreamCommit,
      bufferExpiryMs: BUFFER_EXPIRY_MS,
      maxStreams: MAX_REASONING_MERGE_STREAMS,
    });
    clearRecoveredTerminalState = (streamId, sessionId) => {
      pendingStreamCommitQueue.drop(streamId);
      clearTerminalStreamState(streamId);
      reasoningStreamMerger.drop(streamId);
      multiStreamController?.finishStreamTerminalCommit?.(streamId, true, sessionId);
    };
    const reasoningPhaseStatusHandlers = createStreamReasoningPhaseStatusHandlers({
      state,
      normalizeId,
      normalizeString,
      streamSegmentState,
      setStreamThinkingStatus,
      syncThinkingIndicatorMode,
      ensureRenderableReasoningStreamEntry,
      markHiddenRenderableEvent,
      isVisibleChatSession,
      queueRender,
      appendClientLog,
      applyLiveTurnPayload,
      buildAssistantShellMessageId,
      updateStreamPhaseState,
      syncPendingMessagePhaseState,
    });
    const { handleThinkingStatus, handlePhaseStarted, handlePhaseCompleted } = reasoningPhaseStatusHandlers;

    // W2-1: live output tail for running tool rows (ephemeral DOM patches).
    const toolLiveTail = createToolLiveTail({
      getChatTimeline: () => chatTimeline,
    });
    // Phantom activity row: covers the silent window while the model
    // generates tool-call arguments (no provider events exist to render).
    // Ephemeral DOM only — never enters the row model or persistence.
    const streamActivityRow = createStreamActivityRow({
      getChatTimeline: () => chatTimeline,
      isStreamLive: (sessionId, streamId) => (
        multiStreamController?.isSessionStreaming?.(sessionId) === true
        && multiStreamController?.isStreamFinalized?.(streamId) !== true
      ),
      isSessionVisible: (sessionId) => isVisibleChatSession(sessionId),
      hasBlockingToolState: (sessionId, streamId) => {
        const streamTools = state.toolCallsByStream.get(streamId) || [];
        const hasBlockingTool = streamTools.some((tool) => {
          const status = String(tool?.status || '').trim();
          return status === 'running'
            || status === 'pending_approval'
            || status === 'awaiting_approval'
            || status === 'pending_user_input'
            || status === 'approved';
        });
        if (hasBlockingTool) return true;
        for (const approval of state.pendingToolApprovals.values()) {
          if (normalizeId(approval?.sessionId) === normalizeId(sessionId)) {
            return true;
          }
        }
        return false;
      },
    });
    const toolHandlers = createStreamToolHandlers({
      state,
      syncThinkingIndicatorMode,
      streamSegmentState,
      getSessionMessages,
      setSessionMessages,
      createNormalizedMessage,
      releaseApprovalToastSessions,
      clearSessionComposerNotice,
      setSessionTurnStatusPill,
      clearSessionTurnStatusPill,
      patchSessionSummary,
      queueSessionRender,
      scheduleLiveToolPatch: (payload, details) => liveToolPatchController.queueToolPatch(payload, details),
      showApprovalToast,
      isCurrentSession,
      isRowModelEnabled,
      applyLiveTurnPayload,
      noteTimelineMessageCreated,
      invalidateProjectionStateForSession,
      MESSAGE_STATUS,
      publishToolStartImpulse,
      applyToolLiveOutputChunk: (payload) => toolLiveTail.appendChunk(payload),
      settleToolLiveOutput: (callId) => toolLiveTail.settle(callId),
    });
    const handleToolUse = toolHandlers.handleToolUse || (async function noopHandleToolUse() {
      return { buffered: false, terminal: false };
    });
    const handleToolOutputChunk = toolHandlers.handleToolOutputChunk || (async function noopHandleToolOutputChunk() {
      return { buffered: false, terminal: false };
    });
    const handleApprovalNeeded = toolHandlers.handleApprovalNeeded || (async function noopHandleApprovalNeeded() {
      return { buffered: false, terminal: false };
    });
    const handleUserQuestionsRequested = toolHandlers.handleUserQuestionsRequested || (async function noopHandleUserQuestionsRequested() {
      return { buffered: false, terminal: false };
    });
    const handleToolResult = toolHandlers.handleToolResult || (async function noopHandleToolResult() {
      return { buffered: false, terminal: false };
    });
    const terminalHandlers = createStreamTerminalHandlers({
      state,
      chatInput,
      MAX_INTERACTIVE_QUESTIONS,
      MAX_INTERACTIVE_ROUNDS,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED,
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE,
      MESSAGE_STATUS,
      TOAST_SOURCE,
      appendClientLog,
      normalizePendingQuestionBatch,
      getInteractiveSequenceState,
      clearInteractiveDraft,
      ensureInteractiveDraft,
      patchSessionSummary,
      buildInteractiveQuestionBatchVisibleText,
      refreshSessionMetadata: typeof refreshSessionMetadataOverride === 'function'
        ? refreshSessionMetadataOverride
        : refreshSessionMetadata,
      refreshSnapshots,
      refreshObservability,
      dismissStreamErrors,
      maybeSuggestMemoryCapture,
      getInteractiveComposerStatusNotice,
      persistInteractiveFallbackRequest,
      requestInteractiveGuardrailAnswer,
      queueInteractiveComposerFocus,
      getQueuedSend,
      restoreQueuedSendDraft,
      dispatchQueuedSendForSession,
      updateContextUsage,
      completeThinkingIndicator,
      resetThinkingIndicator,
      clearStreamThinkingStatus,
      finalizeTerminalStream,
      resetLifecycleIfSettling,
      ensurePendingStreamEntry,
      getSessionMessages,
      setSessionMessages,
      setSessionTurnEventState,
      createNormalizedMessage,
      setSessionComposerNotice,
      clearSessionComposerNotice,
      queueSessionRender,
      isCurrentSession,
      isVisibleChatSession,
      normalizeId,
      showToastMessage,
      isRowModelEnabled,
      reconcileLiveTurnWithHydratedRows, clearSessionLiveTurnState,
      isSessionStreaming: (sessionId) => multiStreamController?.isSessionStreaming?.(sessionId) === true,
      clearTerminalPostwork: (sessionId) => multiStreamController?.clearTerminalPostwork?.(sessionId),
      // Audit A5: compare-and-clear close of the postwork window; falls back
      // to the unconditional clear when the controller predates the token API.
      finishTerminalPostwork: (sessionId, token) => (
        typeof multiStreamController?.finishTerminalPostwork === 'function'
          ? multiStreamController.finishTerminalPostwork(sessionId, token)
          : multiStreamController?.clearTerminalPostwork?.(sessionId)
      ),
      // CTL-013: generation/abort token for the postwork window. A late
      // continuation validates its captured token against the CURRENT
      // generation (bumped by every new beginTerminalPostworkGeneration call
      // and invalidated by clearTerminalPostwork) before mutating state.
      beginTerminalPostworkGeneration: (sessionId) => multiStreamController?.beginTerminalPostworkGeneration?.(sessionId) ?? null,
      isTerminalPostworkGenerationCurrent: (sessionId, token) => (
        typeof multiStreamController?.isTerminalPostworkGenerationCurrent === 'function'
          ? multiStreamController.isTerminalPostworkGenerationCurrent(sessionId, token) === true
          : true
      ),
      captureStreamGeneration: (sessionId, streamId) => multiStreamController?.captureStreamGeneration?.(sessionId, streamId) || null,
      isStreamGenerationCurrent: (token) => multiStreamController?.isStreamGenerationCurrent?.(token) === true,
    });
    const handleQuestionBatch = terminalHandlers.handleQuestionBatch || (async function noopHandleQuestionBatch() {
      return { buffered: false, terminal: false };
    });
    const handleMessageUpdated = terminalHandlers.handleMessageUpdated || (async function noopHandleMessageUpdated() {
      return { buffered: false, terminal: false };
    });
    const rawHandleComplete = terminalHandlers.handleComplete || (async function noopHandleComplete() {
      return { buffered: false, terminal: false };
    });
    const rawHandleError = terminalHandlers.handleError || (async function noopHandleError() {
      return { buffered: false, terminal: false };
    });
    // Terminal settle wrappers extracted to renderer-stream-handler-terminal-settle.js
    // (file-size ceiling); behavior is unchanged.
    const { handleComplete, handleError } = createTerminalSettleHandlers({
      getChatTimeline: () => chatTimeline,
      state,
      normalizeId,
      isCurrentSession,
      appendClientLog,
      settleVisibleStreamAffordances,
      settleUnfinishedReasoningPhases,
      applyLiveTurnPayload,
      flushPendingStreamCommit,
      clearTerminalStreamState,
      dropReasoningStream: (streamId) => reasoningStreamMerger.drop(streamId),
      rawHandleComplete,
      rawHandleError,
    });

    const liveEventHandlers = createStreamLiveEventHandlers({
      state,
      normalizeId,
      normalizeString,
      appendClientLog,
      MESSAGE_STATUS,
      streamSegmentState,
      streamPhaseState,
      reasoningStreamMerger,
      multiStreamController,
      pendingStreamCommitQueue,
      appendAgentStatusStep,
      notePreflightEvent,
      clearStreamThinkingStatus,
      flushPendingStreamCommit,
      applyLiveTurnPayload,
      buildAssistantShellMessageId,
      setChatSendLifecycle,
      syncThinkingIndicatorMode,
      queueSessionRender,
      queueRender,
      ensurePendingStreamEntry,
      getSessionMessages,
      setSessionMessages,
      updatePendingMessage,
      markHiddenRenderableEvent,
      isVisibleChatSession,
      isCurrentSession,
      isRowModelEnabled,
      getReasoningPhasesForStream,
      completeThinkingIndicator,
      updateContextUsage,
      publishFirstTokenImpulse,
    });
    const {
      handleStarted,
      handleAgentStatus,
      handleStreamReset,
      handleContextCompacted,
      handleContextUsage,
      handleDelta,
    } = liveEventHandlers;

    const dispatchRouter = createStreamDispatchRouter({
      state,
      normalizeId,
      normalizeString,
      appendClientLog,
      markStartupAudit,
      resolvePayloadSessionId,
      shouldBufferStreamEvent,
      bufferStreamEvent,
      consumeBufferedStreamDegradation,
      notePreflightEvent,
      flushPendingStreamCommit,
      handlePresenceStreamEvent,
      handleWorkspaceActivityStreamEvent,
      handlers: {
        handleBufferDegraded,
        handleStarted,
        handleThinkingStatus,
        handlePhaseStarted,
        handlePhaseCompleted,
        handleAgentStatus,
        handleToolUse,
        handleApprovalNeeded,
        handleUserQuestionsRequested,
        handleToolOutputChunk,
        handleToolResult,
        handleStreamReset,
        handleContextCompacted,
        handleContextUsage,
        handleDelta,
        handleQuestionBatch,
        handleMessageUpdated,
        handleComplete,
        handleError,
      },
      isRenderableBufferedStreamEvent,
      waitForRenderFrame,
      flushRenderableBatchSize: FLUSH_RENDERABLE_BATCH_SIZE,
      onStartupFirstEvent() {
        if (startupAuditFirstStreamEventMarked) {
          return false;
        }
        startupAuditFirstStreamEventMarked = true;
        return true;
      },
      onBufferedStreamFlushed: (streamId, outcome = {}) => {
        if (outcome.degraded === true || Number(outcome.discardedCount || 0) > 0) {
          streamEnvelopeReceiptTracker.faultBufferedReceipts(streamId, 'buffer_replay_degraded');
          return;
        }
        streamEnvelopeReceiptTracker.flushBufferedReceipts(streamId);
      },
      // Terminal-absorbing gate (CTL-003): the multi-stream controller's
      // bounded finalized registry is the single source of truth for "this
      // stream is done"; dispatch consults it before any handler runs. The
      // settled registry additionally distinguishes "terminal handler ran"
      // from "finalized by a stop/preempt clearStream", so the one genuine
      // late terminal for a preempted stream can still reconcile its partial
      // bubble (preempt-retry ordering contract).
      isStreamFinalized: (streamId) => multiStreamController?.isStreamFinalized?.(streamId) === true,
      isStreamTerminalSettled: (streamId) => multiStreamController?.isStreamTerminalSettled?.(streamId) === true,
      markStreamTerminalSettled: (streamId) => multiStreamController?.markStreamTerminalSettled?.(streamId),
      getStreamTerminalCommitState: (streamId, sessionId) => multiStreamController?.getStreamTerminalCommitState?.(streamId, sessionId) || '',
      beginStreamTerminalCommit: (streamId, sessionId) => multiStreamController?.beginStreamTerminalCommit?.(streamId, sessionId),
      finishStreamTerminalCommit: (streamId, committed, sessionId) => multiStreamController?.finishStreamTerminalCommit?.(streamId, committed, sessionId),
      isStreamCurrentForSession: (sessionId, streamId) => multiStreamController?.isStreamCurrentForSession?.(sessionId, streamId) !== false,
    });
    const {
      handleStreamPayload: dispatchStreamPayload,
      flushBufferedStreamEvents,
      dropBufferedStreamEvents,
    } = dispatchRouter;
    // Every dispatched event doubles as the activity row's heartbeat: it
    // resets the silence clock and dismisses a visible phantom row before the
    // authoritative handler renders.
    function handleStreamPayload(payload, callOptions = {}) {
      try {
        streamActivityRow.noteStreamEvent(payload);
      } catch (_error) { /* affordance only — never blocks dispatch */ }
      return dispatchStreamPayload(payload, callOptions);
    }

    function isStreamEnvelopeV2Enabled() {
      return state?.features?.featureFlags?.stream_envelope_v2 === true;
    }

    async function handleStreamEnvelope(envelope, callOptions = {}) {
      const envelopeStreamId = normalizeString(envelope?.streamId);
      const payload = streamEnvelopeToLegacyPayload(envelope);
      if (!payload || typeof payload !== 'object') {
        appendClientLog('WARN', 'stream.envelope_v2_invalid', {
          streamId: String(envelope?.streamId || '').slice(0, 30),
          channel: String(envelope?.channel || '').slice(0, 30),
          eventKind: String(envelope?.eventKind || '').slice(0, 30),
          schemaVersion: String(envelope?.schemaVersion ?? '').slice(0, 30),
        });
        // A version mismatch is permanent; other invalid envelopes may be transient,
        // so the tolerant envelope seam deliberately stays live for those drops.
        if (envelope?.schemaVersion != null && envelope.schemaVersion !== STREAM_ENVELOPE_SCHEMA_VERSION) {
          fallbackEnvelopeToLegacy('envelope_schema_mismatch');
        }
        return { buffered: false, terminal: false };
      }
      if (!streamEnvelopeSequenceGuard.shouldAccept(envelope)) {
        const faultReason = streamEnvelopeSequenceGuard.consumeFault(envelopeStreamId) || 'sequence_fault';
        rehydrateEnvelopeFault(normalizeString(envelope?.sessionId));
        streamEnvelopeReceiptTracker.noteFault(envelope, faultReason);
        fallbackEnvelopeToLegacy(faultReason);
        return { buffered: false, terminal: false };
      }
      const result = await handleStreamPayload(payload, callOptions); // count only after processing (#8)
      if (result?.handlerError === true && normalizeString(envelope?.eventKind) === 'terminal') {
        streamEnvelopeReceiptTracker.noteFault(envelope, 'terminal_handler_failed');
        streamEnvelopeSequenceGuard.clear(envelopeStreamId);
        fallbackEnvelopeToLegacy('terminal_handler_failed');
        return result;
      }
      streamEnvelopeReceiptTracker.noteProcessed(envelope, result?.buffered === true);
      if (result?.buffered !== true && normalizeString(envelope?.eventKind) === 'terminal' && envelopeStreamId) {
        streamEnvelopeSequenceGuard.clear(envelopeStreamId);
        streamEnvelopeReceiptTracker.flushAck(envelope);
      }
      return result;
    }

    const lifecycle = createStreamHandlerLifecycle({
      state,
      normalizeId,
      appendClientLog,
      handleStreamPayload,
      handleStreamEnvelope,
      handleStreamRecovery: (ticket) => streamRecoveryController.recover(ticket),
      pendingStreamCommitQueue,
      runtime,
      approvalToastSessionIds,
      reasoningStreamMerger,
      streamRehydrateUtils,
      isRowModelEnabled,
      getLiveStateStore,
      isStreamEnvelopeV2Enabled,
      streamEnvelopeReceiptTracker,
      clearBufferedStreamEvents,
    });
    recoveryRehydrateLiveTurnState = lifecycle.rehydrateSessionFromPersistedTurnEvents;
    rehydrateEnvelopeFault = lifecycle.rehydrateSessionFromPersistedTurnEvents;
    fallbackEnvelopeToLegacy = lifecycle.fallbackToLegacy;
    const {
      registerStreamHandler, resyncStreamSubscriptionMode,
      dispose: disposeLifecycle,
      rehydrateSessionFromPersistedTurnEvents,
    } = lifecycle;

    return {
      registerStreamHandler, resyncStreamSubscriptionMode,
      optimisticAppend,
      ensurePendingStreamEntry,
      flushBufferedStreamEvents,
      flushPendingStreamCommitsForSession,
      dropBufferedStreamEvents,
      rehydrateSessionFromPersistedTurnEvents,
      dispose() {
        streamActivityRow.dispose?.();
        liveToolPatchController.dispose?.();
        streamRecoveryController.dispose();
        disposeLifecycle();
      },
    };
  }

  return { createStreamHandler, appendAgentStatusStep };
});
