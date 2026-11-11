(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererStreamHandlerDeps = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Dependency resolution of renderer-stream-handler.js and renderer-stream-handler-wiring.js: every
  // sibling is looked up once at load (browser global, else require); the required ones fail loudly
  // when absent and the optional ones degrade to the fallbacks below, never a load failure.
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
  const _imageRenderUtils = resolveDependencyModule('rendererStreamImageRenderProgress', './renderer-stream-image-render-progress');
  if (!_imageRenderUtils || typeof _imageRenderUtils.createImageRenderProgress !== 'function') {
    throw new Error('renderer-stream-image-render-progress must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createImageRenderProgress } = _imageRenderUtils;
  const _testProgressUtils = resolveDependencyModule('rendererStreamTestProgress', './renderer-stream-test-progress');
  if (!_testProgressUtils || typeof _testProgressUtils.createToolTestProgress !== 'function') {
    throw new Error('renderer-stream-test-progress must load before renderer/chat/renderer-stream-handler.js');
  }
  const { createToolTestProgress } = _testProgressUtils;
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
  const createWaitingRowWiring = resolveDependencyModule('rendererStreamWaitingLine', './renderer-stream-waiting-line')?.createWaitingRowWiring
    || (() => ({ rowOptions: {} }));
  // Optional (row 121): Follow Jenny's store, chat tail and Workspace hub. Absence is today's behavior.
  const createFollowWiring = resolveDependencyModule('rendererFollowStore', './renderer-follow-store')?.createFollowWiring
    || (() => ({ noteStreamEvent() {}, dispose() {} }));
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

  // A handler slot a sub-factory did not provide: reports 'not buffered, not terminal'.
  const noopStreamHandler = async function noopStreamHandler() {
    return { buffered: false, terminal: false };
  };

  return {
    resolveDependencyModule,
    normalizeString,
    normalizeId,
    FLUSH_RENDERABLE_BATCH_SIZE,
    isRenderableBufferedStreamEvent,
    waitForRenderFrame,
    normalizePhaseSummary,
    appendAgentStatusStep,
    createRowModelStateUtils,
    createReducerWiring,
    createStreamPhaseStateUtils,
    createStreamDispatchRouter,
    createToolLiveTail,
    createImageRenderProgress,
    createToolTestProgress,
    createTerminalSettleHandlers,
    createStreamSessionHelpers,
    createDegradedStreamRecovery,
    createReasoningStreamMerger,
    createStreamReasoningPhaseStatusHandlers,
    createPendingMessageUtils,
    createStreamHandlerLifecycle,
    createStreamLiveEventHandlers,
    createStreamActivityRow,
    createWaitingRowWiring,
    createFollowWiring,
    createStreamHandlerRuntime,
    settleVisibleStreamAffordances,
    createLiveToolPatchController,
    createStreamToolHandlers,
    createStreamTerminalHandlers,
    createPendingStreamCommitQueue,
    getTimelineVisibilityTracker,
    resolveSharedLiveAnnouncer,
    noopStreamHandler,
  };
});
