const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

/* Ht-B Step B2 — disposal-leak fixes.
 * Counting async-handle stubs are installed on globalThis BEFORE the
 * renderer modules load, because the pipeline factories capture
 * requestAnimationFrame/cancelAnimationFrame refs at module scope. */
const rafState = { nextHandle: 1, pending: new Set(), cancelled: [] };
global.requestAnimationFrame = function countingRequestAnimationFrame() {
  const handle = rafState.nextHandle++;
  rafState.pending.add(handle);
  return handle;
};
global.cancelAnimationFrame = function countingCancelAnimationFrame(handle) {
  if (rafState.pending.delete(handle)) {
    rafState.cancelled.push(handle);
  }
};

const roState = { instances: [] };
global.ResizeObserver = class CountingResizeObserver {
  constructor(callback) {
    this.callback = callback;
    this.observed = [];
    this.disconnected = false;
    roState.instances.push(this);
  }

  observe(target) {
    this.observed.push(target);
  }

  unobserve() {}

  disconnect() {
    this.disconnected = true;
  }
};

const dom = new JSDOM(`
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
global.window = dom.window;
global.document = dom.window.document;

const timerState = { cleared: [] };
const realClearTimeout = dom.window.clearTimeout.bind(dom.window);
dom.window.clearTimeout = function countingClearTimeout(handle) {
  timerState.cleared.push(handle);
  return realClearTimeout(handle);
};

const { createRenderPipeline } = require('../renderer/chat/renderer-render-pipeline-utils');
const messageIndexUtils = require('../renderer/chat/renderer-message-index-utils');
const surfaceStateUtils = require('../renderer/chat/renderer-render-pipeline-surface-state');
const pinToTopUtils = require('../renderer/chat/renderer-pin-to-top-utils');

global.rendererMessageIndexUtils = messageIndexUtils;

function createPipelineHarness() {
  const documentRef = dom.window.document;
  const uiRuntime = {
    projectionContextBySession: new Map(),
    toolRowProjectionFallbacksBySession: new Map(),
    toolRowProjectionFailuresBySession: new Map(),
  };
  const spriteRuntime = {};
  const state = {
    currentSessionId: 'session-disposal',
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
  const pipeline = createRenderPipeline({
    state,
    constants: {
      MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete' },
      ACTIVITY_SCOPE: {},
      staticModel: '',
    },
    dom: {
      homeView: documentRef.getElementById('homeView'),
      chatView: documentRef.getElementById('chatView'),
      ideView: documentRef.getElementById('ideView'),
      artifactsView: documentRef.getElementById('artifactsView'),
      logsView: documentRef.getElementById('logsView'),
      settingsView: documentRef.getElementById('settingsView'),
      chatTimeline: documentRef.getElementById('timeline'),
      chatThreadScroll: documentRef.getElementById('scroll'),
      chatThreadColumn: documentRef.getElementById('threadColumn'),
    },
    controllers: {
      thinkingController: {
        prune() {},
        resumeAutoScroll() {},
        shouldAutoScroll() { return true; },
      },
      reducedMotionQuery: { matches: false },
      thinkingIndicator: null,
    },
    runtime: {
      uiRuntime,
      spriteRuntime,
    },
    callbacks: {
      escapeHtml(value) { return String(value || ''); },
      getCurrentSessionMessages() { return []; },
      getCurrentVisibleMessages() { return []; },
      getVisibleSessionMessages() { return []; },
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
      renderThinkingWidget() { return ''; },
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
      scheduleMessageViewportSync() {},
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
      syncComposerModelSelectWidth() {},
      renderComposerEnhancements() {},
      renderMarkdown(text) { return String(text || ''); },
      renderStreamingMarkdownUnits(text) { return { html: String(text || ''), units: [], changedStart: -1 }; },
      publishLifecycleStatus() {},
      renderBackendBanner() {},
      getChatSendLifecycle() { return 'idle'; },
      getChatTimelineRowModelEnabled() { return false; },
      recordChatTimelineRolloutSignal() { return { logged: false, count: 0 }; },
      rollbackChatTimelineRowModel() { return false; },
      refreshActiveSurfaceEffect() {},
      appendClientLog() {},
      renderHeader() {},
      renderPrompts() {},
      stopFallbackRotation() {},
    },
  });
  return { pipeline, uiRuntime, spriteRuntime, state };
}

test('disposeRenderPipeline cancels the thinking pipeline sprite rAF (leak fix, idempotent)', () => {
  const { pipeline, spriteRuntime } = createPipelineHarness();

  pipeline.updateAssistantSpritePosition([]);
  assert.ok(spriteRuntime.frameHandle, 'the sprite position update schedules a pending rAF');
  const pendingHandle = spriteRuntime.frameHandle;

  pipeline.dispose();
  assert.ok(
    rafState.cancelled.includes(pendingHandle),
    'aggregated dispose must cancel the thinking pipeline sprite rAF'
  );
  assert.equal(spriteRuntime.frameHandle, 0, 'the sprite frame handle is cleared');

  const cancelledCount = rafState.cancelled.length;
  pipeline.dispose();
  assert.equal(rafState.cancelled.length, cancelledCount, 'a second dispose is a no-op');
});

test('surface-state pipeline exposes dispose() that clears the thread-transition timer (leak fix, idempotent)', () => {
  const chatView = dom.window.document.getElementById('chatView');
  const uiRuntime = {};
  const surfaceState = surfaceStateUtils.createSurfaceStatePipeline({
    state: { currentSessionId: 'session-disposal', ui: { chatMode: 'thread' } },
    dom: { chatView },
    runtime: { uiRuntime },
    callbacks: {},
  });

  assert.equal(typeof surfaceState.dispose, 'function', 'the surface-state pipeline must expose dispose()');

  surfaceState.scheduleThreadTransitionCleanup();
  assert.ok(uiRuntime.threadTransitionTimer, 'scheduling arms the thread-transition timer');
  const armedTimer = uiRuntime.threadTransitionTimer;
  chatView.classList.add('thread-transition-ready');

  surfaceState.dispose();
  assert.ok(timerState.cleared.includes(armedTimer), 'dispose must clear the pending timer');
  assert.equal(uiRuntime.threadTransitionTimer, 0);
  assert.equal(chatView.classList.contains('thread-transition-ready'), false);

  const clearedCount = timerState.cleared.length;
  surfaceState.dispose();
  assert.equal(timerState.cleared.length, clearedCount, 'a second dispose is a no-op');
});

test('disposeRenderPipeline tears down the surface-state pipeline (wiring)', () => {
  const { pipeline, uiRuntime } = createPipelineHarness();

  // Arm a fake pending transition timer through the shared runtime the
  // surface-state pipeline owns, then dispose the aggregate.
  uiRuntime.threadTransitionTimer = 987654;
  pipeline.dispose();

  assert.ok(
    timerState.cleared.includes(987654),
    'aggregated dispose must clear the surface-state thread-transition timer'
  );
  assert.equal(uiRuntime.threadTransitionTimer, 0);
});

test('pin-to-top dispose disconnects its layout ResizeObserver (regression pin — already fixed on main)', () => {
  const documentRef = dom.window.document;
  const controller = pinToTopUtils.createPinToTopController({
    scrollContainer: documentRef.getElementById('scroll'),
    timelineContainer: documentRef.getElementById('timeline'),
  });

  const observersBefore = roState.instances.length;
  controller.bind();
  assert.equal(roState.instances.length, observersBefore + 1, 'bind creates the layout ResizeObserver');
  const observer = roState.instances[roState.instances.length - 1];
  assert.ok(observer.observed.length >= 1, 'the observer watches at least the timeline container');

  controller.dispose();
  assert.equal(observer.disconnected, true, 'dispose must disconnect the layout observer');

  controller.dispose();
  assert.equal(observer.disconnected, true, 'a second dispose stays torn down');
});
