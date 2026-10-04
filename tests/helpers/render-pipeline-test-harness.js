// Shared jsdom + createRenderPipeline harness for render-pipeline suites.
// Extracted verbatim from tests/renderer-render-pipeline-utils.test.js so the
// rollout-signal suite can drive the same pipeline without duplicating the
// ~150-line callback surface.
const { JSDOM } = require('jsdom');

const { createRenderPipeline } = require('../../renderer/chat/renderer-render-pipeline-utils');
const messageIndexUtils = require('../../renderer/chat/renderer-message-index-utils');

/* The harness `state`. Exported so a split-view suite can build ONE state and
 * hand it to two harnesses (`createPipelineHarness({ state })`), the way both
 * panes read one `state` in production. */
function createHarnessState(options = {}) {
  const settings = options || {};
  const state = {
    currentSessionId: settings.currentSessionId || 'session-source',
    streamThinkingStatusByStream: new Map(),
    activeStreamSessionId: '',
    activeStreamId: '',
    ui: {
      threadBranchesCollapsedBySession: new Map(),
      chatTimelineRowModelBySession: new Map(),
      chatTimelineLiveStateBySession: new Map(),
      chatTimelineRowModelMetaBySession: new Map(),
      activeView: 'chat',
      chatMode: 'thread',
      animateNextChatActivation: false,
      appearance: { surfaceEffectId: 'none' },
    },
    messagesBySession: new Map(),
    auth: { authenticated: true },
    backend: { phase: 'ready' },
  };
  if (settings.turnEventsBySession instanceof Map) {
    state.turnEventsBySession = settings.turnEventsBySession;
  }
  return state;
}

function createPipelineHarness(options = {}) {
  const settings = options || {};
  const dom = settings.dom || null;
  const documentRef = dom?.window.document || null;
  const visibleMessages = Array.isArray(settings.visibleMessages) ? settings.visibleMessages : [];
  // Split view W1-4a: a shared session store (`messagesBySession`, a Map of
  // session id -> messages) makes every message getter answer per session, the
  // current-session ones through `state.currentSessionId`. Omitted, every getter
  // returns `visibleMessages` whatever it is asked, exactly as before.
  const messagesBySession = settings.messagesBySession instanceof Map ? settings.messagesBySession : null;
  const readSessionMessages = (sessionId) => (messagesBySession
    ? (messagesBySession.get(String(sessionId || '').trim()) || [])
    : visibleMessages);
  const rolloutSignals = [];
  const logs = [];
  global.rendererMessageIndexUtils = messageIndexUtils;
  // Split view W0-6: a caller may hand in the render-memo bag
  // (`createPipelineHarness({ uiRuntime })`), so two harnesses can be driven
  // with two pane runtimes over one shared session store -- or, for a negative
  // control, with the one object the renderer used before that slice. Omitted,
  // it is the private bag with the three session-keyed Maps this harness has
  // always built, unchanged.
  const uiRuntime = settings.uiRuntime && typeof settings.uiRuntime === 'object'
    ? settings.uiRuntime
    : {
      projectionContextBySession: new Map(),
      toolRowProjectionFallbacksBySession: new Map(),
      toolRowProjectionFailuresBySession: new Map(),
    };
  // Split view W1-4a: `state` may be injected so two harnesses SHARE one state
  // (each with its own `uiRuntime.paneId`); omitted, it is built exactly as before.
  const state = settings.state && typeof settings.state === 'object' ? settings.state : createHarnessState(settings);
  const pipeline = createRenderPipeline({
    state,
    constants: {
      MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete' },
      ACTIVITY_SCOPE: {},
      staticModel: '',
    },
    dom: {
      ...settings.composerDom,
      homeView: documentRef?.getElementById('homeView') || documentRef?.createElement('div') || null,
      chatView: documentRef?.getElementById('chatView') || documentRef?.createElement('div') || null,
      ideView: documentRef?.getElementById('ideView') || documentRef?.createElement('div') || null,
      artifactsView: documentRef?.getElementById('artifactsView') || documentRef?.createElement('div') || null,
      logsView: documentRef?.getElementById('logsView') || documentRef?.createElement('div') || null,
      settingsView: documentRef?.getElementById('settingsView') || documentRef?.createElement('div') || null,
      chatTimeline: documentRef?.getElementById('timeline') || null,
      chatThreadScroll: documentRef?.getElementById('scroll') || null,
      chatThreadColumn: documentRef?.getElementById('threadColumn') || documentRef?.getElementById('timeline') || null,
    },
    controllers: {
      ...settings.controllers,
      thinkingController: settings.thinkingController || {
        prune() {},
        resumeAutoScroll() {},
        shouldAutoScroll() { return true; },
      },
      reducedMotionQuery: { matches: false },
      thinkingIndicator: settings.thinkingIndicator || null,
    },
    runtime: {
      uiRuntime,
      spriteRuntime: {},
    },
    callbacks: {
      escapeHtml(value) { return String(value || ''); },
      getCurrentSessionMessages() { return readSessionMessages(state.currentSessionId); },
      getCurrentVisibleMessages() { return readSessionMessages(state.currentSessionId); },
      getVisibleSessionMessages(sessionId) { return readSessionMessages(sessionId); },
      getSessionMessages(sessionId) { return readSessionMessages(sessionId); },
      getLatestAssistantMessageId() { return ''; },
      getLatestReplyAssistantMessageId() { return ''; },
      getLatestUserMessageId() { return ''; },
      resolveRegenerateRequest() { return null; },
      buildAssistantMetaLabel() { return ''; },
      shouldShowThinkingToggle() { return false; },
      renderMessageAttachments() { return ''; },
      renderToolCallBlock() { return ''; },
      buildInteractiveRecapViewModel() { return null; },
      renderInteractiveRoundRecap() { return ''; },
      renderProactiveSuggestionBlock() { return ''; },
      renderSlashCommandOutput() { return ''; },
      renderThinkingWidget: settings.renderThinkingWidget || function noopRenderThinkingWidget() { return ''; },
      renderAssistantFailureNotice() { return ''; },
      renderContextCompactedNotice() { return ''; },
      renderMessageHoverRow() { return ''; },
      isSendBusy() { return false; },
      isAnySendBusy() { return false; },
      isSessionStreaming() { return false; },
      hasPendingToolApprovalForSession() { return false; },
      getActiveStreamSessionId() { return ''; },
      isSendPreflightPending() { return false; },
      updateTokenDisplay() {},
      isInteractiveRoundRecapExpanded() { return false; },
      pruneInteractiveRoundRecapExpansionState() {},
      setFollowLatest() {},
      scheduleMessageViewportSync: settings.scheduleMessageViewportSync || function noopScheduleMessageViewportSync() {},
      normalizeConversationMode() { return 'chat'; },
      getPendingQuestionBatch() { return null; },
      hasStalePendingQuestionBatch() { return false; },
      getActivitySnapshot() { return null; },
      getMostRecentActivity() { return null; },
      isActivityBusy() { return false; },
      applyActivityAttributes() {},
      renderComposerInteractivePanel() { return ''; },
      closeComposerPopover() {},
      syncComposerInputHeight() {},
      setComposerHoloState() {},
      updateComposerSafeOffset() {},
      renderSessions() {},
      renderWorkspaceChrome() {},
      renderSettings() {},
      renderArtifactsPanel() {},
      renderArtifactReviewPanel() {},
      getArtifactsForSession() { return []; },
      selectArtifact() {},
      isArtifactReviewVisible() { return false; },
      renderContextPanel() {},
      renderHomePanel() {},
      shouldRenderHomePanel() { return false; },
      renderAttachmentTray() {},
      renderComposerStatusNotice() {},
      renderToastViewport() {},
      renderComposerPopover() {},
      renderCommandPopover() {},
      clearActivity() {},
      failActivity() {},
      beginActivity() {},
      getCurrentRuntimePreferences() { return {}; },
      renderComposerEnhancements() {},
      renderMarkdown(text) { return String(text || ''); },
      renderStreamingMarkdownUnits(text) { return { html: String(text || ''), units: [], changedStart: -1 }; },
      renderBackendBanner() {},
      getChatSendLifecycle() { return 'idle'; },
      getChatTimelineRowModelEnabled() { return settings.rowModelEnabled === true; },
      recordChatTimelineRolloutSignal(sessionId, signal, details) {
        rolloutSignals.push({ sessionId, signal, details });
        return {
          logged: true,
          count: rolloutSignals.filter((entry) => entry.signal === signal).length,
        };
      },
      rollbackChatTimelineRowModel() { return false; },
      refreshActiveSurfaceEffect() {},
      appendClientLog(level, event, data) {
        logs.push({ level, event, data });
      },
      renderHeader() {},
      // Split view W1-4a: per-test overrides, applied last. A key set to
      // `undefined` REMOVES that callback (e.g. the per-session getters, to
      // prove the current-session fallback).
      ...settings.callbacks,
    },
  });
  return { pipeline, uiRuntime, rolloutSignals, logs, state, dom };
}

function withWindowGlobals(dom, run) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousResizeObserver = global.ResizeObserver;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  global.window = dom.window;
  global.document = dom.window.document;
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    disconnect() {}
  };
  global.requestAnimationFrame = dom.window.requestAnimationFrame || ((callback) => {
    callback();
    return 1;
  });
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame || (() => {});
  try {
    return run();
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.ResizeObserver = previousResizeObserver;
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
  }
}

function createRenderDom() {
  return new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="homeView"></div>
        <div id="ideView"></div>
        <div id="artifactsView"></div>
        <div id="logsView"></div>
        <div id="settingsView"></div>
        <div id="chatView" class="chat-empty">
          <div id="scroll">
            <div id="threadColumn">
              <div id="timeline"></div>
            </div>
          </div>
        </div>
      </body>
    </html>
  `);
}

module.exports = { createPipelineHarness, createHarnessState, withWindowGlobals, createRenderDom };
