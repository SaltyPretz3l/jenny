const { JSDOM } = require('jsdom');

const viewportUtils = require('../../renderer/shell/renderer-viewport-utils.js');
const { shouldAutoScrollThread } = require('../../renderer/chat/chat-scroll-utils.js');
const { ThinkingPanelController } = require('../../renderer/chat/chat-thinking-utils.js');

function createStyleRecorder() {
  const values = new Map();
  return {
    setProperty(name, value) {
      values.set(name, value);
    },
    removeProperty(name) {
      values.delete(name);
    },
    getPropertyValue(name) {
      return values.get(name) || '';
    },
  };
}

function createTarget(getRect) {
  const target = {
    _querySelectorImpl: null,
    _querySelectorAllImpl: null,
    style: createStyleRecorder(),
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    getBoundingClientRect() {
      return getRect();
    },
    querySelector(selector) {
      return typeof target._querySelectorImpl === 'function'
        ? target._querySelectorImpl(selector)
        : null;
    },
    querySelectorAll(selector) {
      return typeof target._querySelectorAllImpl === 'function'
        ? target._querySelectorAllImpl(selector)
        : [];
    },
    scrollTo(options) {
      if (options && typeof options === 'object' && Number.isFinite(Number(options.top))) {
        target.scrollTop = Number(options.top);
      }
    },
  };
  return target;
}

function createResizeObserverHarness() {
  const instances = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = [];
      this.disconnectCalls = 0;
      instances.push(this);
    }
    observe(target) {
      this.observeCalls.push(target);
    }
    disconnect() {
      this.disconnectCalls += 1;
    }
  }
  return { FakeResizeObserver, instances };
}

function createViewportControllerHarness(options = {}) {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousResizeObserver = global.ResizeObserver;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  const { FakeResizeObserver, instances } = createResizeObserverHarness();
  const rootStyle = createStyleRecorder();
  const deferAnimationFrame = options.deferAnimationFrame === true;
  const rafQueue = [];
  let nextRafHandle = 1;
  let rafNow = 0;

  let stageBottom = 600;
  let composerTop = 610;
  let composerHeight = 130;
  const scrollbarClearance = 12;
  let layerLeft = 0;
  let layerWidth = 760 - scrollbarClearance;
  let threadColumnLeft = 44;
  let threadColumnWidth = 604;
  let spriteUpdateCount = 0;
  let lastSpriteMessages = null;
  let syncThreadScrollStateCount = 0;
  let thinkingHandleScrollCount = 0;
  const thinkingResumeReasons = [];
  let thinkingAutoScroll = false;
  let autoScrollThread = options.autoScrollThread === true;
  let reducedMotion = options.reducedMotion === true;
  let pendingApprovalVisible = false;
  let threadScrollTopWriteCount = 0;

  const chatView = createTarget(() => ({ top: 0, bottom: 760, width: 900, height: 760 }));
  const chatSurfaceEffects = createTarget(() => ({
    left: layerLeft,
    top: 0,
    width: layerWidth,
    height: stageBottom,
    right: layerLeft + layerWidth,
    bottom: stageBottom,
  }));
  const chatSurfaceEffectLeft = createTarget(() => ({
    left: layerLeft,
    top: 0,
    width: Math.max(threadColumnLeft - layerLeft, 0),
    height: stageBottom,
    right: threadColumnLeft,
    bottom: stageBottom,
  }));
  const chatSurfaceEffectRight = createTarget(() => {
    const rightWidth = Math.max((layerLeft + layerWidth) - (threadColumnLeft + threadColumnWidth), 0);
    return {
      left: Math.max(layerLeft + layerWidth - rightWidth, layerLeft),
      top: 0,
      width: rightWidth,
      height: stageBottom,
      right: layerLeft + layerWidth,
      bottom: stageBottom,
    };
  });
  const chatThreadStage = createTarget(() => ({ top: 0, bottom: stageBottom, width: 620, height: 600 }));
  const chatThreadColumn = createTarget(() => ({
    left: threadColumnLeft,
    top: 0,
    width: threadColumnWidth,
    height: stageBottom,
    right: threadColumnLeft + threadColumnWidth,
    bottom: stageBottom,
  }));
  const composerWrap = createTarget(() => ({
    top: composerTop,
    bottom: composerTop + composerHeight,
    width: 620,
    height: composerHeight,
  }));
  const chatTimeline = createTarget(() => ({ top: 0, bottom: 0, width: 0, height: 0 }));
  const chatThreadScroll = createTarget(() => ({ top: 0, bottom: 600, width: 620, height: 600 }));
  if (options.useRealAutoScrollGate) {
    let threadScrollTop = chatThreadScroll.scrollTop;
    Object.defineProperty(chatThreadScroll, 'scrollTop', {
      configurable: true,
      get() { return threadScrollTop; },
      set(value) {
        threadScrollTop = value;
        threadScrollTopWriteCount += 1;
      },
    });
  }
  chatThreadScroll._querySelectorAllImpl = (selector) => {
    if (!pendingApprovalVisible || !String(selector || '').includes('approval-gap-row')) {
      return [];
    }
    return [{
      getBoundingClientRect() {
        return { top: 120, bottom: 160, width: 600, height: 40 };
      },
    }];
  };
  let currentMessages = [];
  let renderedCount = 0;
  const viewportState = {
    currentSessionId: 'session-1',
    ui: {
      activeView: 'chat',
      chatMode: 'thread',
      followLatest: true,
      interactiveRecapExpandedBySession: new Map(),
    },
  };

  function requestFrame(callback) {
    const handle = nextRafHandle;
    nextRafHandle += 1;
    if (deferAnimationFrame) {
      rafQueue.push({ handle, callback, cancelled: false });
      return handle;
    }
    rafNow += 16;
    callback(rafNow);
    return handle;
  }

  function cancelFrame(handle) {
    const item = rafQueue.find((entry) => entry.handle === handle);
    if (item) {
      item.cancelled = true;
    }
  }

  global.window = {
    innerHeight: 777,
    requestAnimationFrame: requestFrame,
    setTimeout,
    clearTimeout,
    getComputedStyle() {
      return { scrollBehavior: 'auto' };
    },
  };
  global.document = {
    documentElement: { style: rootStyle },
    getElementById() {
      return null;
    },
  };
  global.ResizeObserver = FakeResizeObserver;
  global.requestAnimationFrame = requestFrame;
  global.cancelAnimationFrame = cancelFrame;

  const thinkingController = options.useRealAutoScrollGate
    ? new ThinkingPanelController()
    : {
      resumeAutoScroll(reason) { thinkingResumeReasons.push(reason); },
      shouldAutoScroll() { return thinkingAutoScroll; },
      handleScroll() {
        thinkingHandleScrollCount += 1;
        return true;
      },
      isExpanded() { return false; },
    };

  const controller = viewportUtils.createViewportController({
    state: viewportState,
    constants: { MESSAGE_STATUS: { COMPLETE: 'complete' } },
    dom: {
      chatView,
      chatSurfaceEffects,
      chatSurfaceEffectLeft,
      chatSurfaceEffectRight,
      chatThreadStage,
      chatThreadColumn,
      composerWrap,
      chatTimeline,
      chatThreadScroll,
    },
    controllers: {
      thinkingController,
      reducedMotionQuery: { get matches() { return reducedMotion; } },
      timelineVirtualizer: options.timelineVirtualizer || null,
    },
    callbacks: {
      mergeReasoningEntries() { return []; },
      deriveFollowLatestFromScroll(metrics) {
        syncThreadScrollStateCount += 1;
        if (typeof options.deriveFollowLatestFromScroll === 'function') {
          return options.deriveFollowLatestFromScroll(metrics);
        }
        return true;
      },
      shouldAutoScrollThread: options.useRealAutoScrollGate
        ? shouldAutoScrollThread
        : function shouldAutoScrollThreadStub() { return autoScrollThread; },
      escapeSelectorValue(value) { return value; },
      getCurrentSessionMessages() { return currentMessages; },
      buildInteractiveRecapViewModel(message) {
        const recap = message && message.interactive_round_recap && typeof message.interactive_round_recap === 'object'
          ? message.interactive_round_recap
          : null;
        if (!recap) {
          return null;
        }
        const items = Array.isArray(recap.items)
          ? recap.items.filter((item) => item && typeof item === 'object')
          : [];
        const askedCount = Math.max(1, Number(recap.answer_count) || items.length);
        if (!askedCount && !items.length) {
          return null;
        }
        return {
          recapId: String(recap.recap_id || `interactive-recap:${message.id}`),
          askedCount,
          questionSummaries: items.map((item, index) => ({
            questionId: String(item.question_id || `q${index + 1}`),
            prompt: String(item.prompt || ''),
            answerLabel: String(item.answer_label || ''),
          })),
          sourceMessageRefs: [],
          isPartial: false,
          isStreaming: false,
        };
      },
      renderMessages() {
        renderedCount += 1;
      },
      updateAssistantSpritePosition(messages) {
        spriteUpdateCount += 1;
        lastSpriteMessages = messages;
      },
      appendClientLog() {},
    },
  });

  return {
    controller,
    chatView,
    chatSurfaceEffects,
    chatSurfaceEffectLeft,
    chatSurfaceEffectRight,
    composerWrap,
    chatThreadStage,
    chatThreadColumn,
    chatTimeline,
    chatThreadScroll,
    rootStyle,
    instances,
    getCurrentMessages() {
      return currentMessages;
    },
    setCurrentMessages(messages) {
      currentMessages = Array.isArray(messages) ? messages : [];
    },
    getRenderedCount() {
      return renderedCount;
    },
    getSpriteUpdateCount() {
      return spriteUpdateCount;
    },
    getLastSpriteMessages() {
      return lastSpriteMessages;
    },
    getSyncThreadScrollStateCount() {
      return syncThreadScrollStateCount;
    },
    getThinkingHandleScrollCount() {
      return thinkingHandleScrollCount;
    },
    getThinkingResumeReasons() {
      return thinkingResumeReasons.slice();
    },
    getThreadScrollTopWriteCount() {
      return threadScrollTopWriteCount;
    },
    setThinkingAutoScroll(value) {
      thinkingAutoScroll = Boolean(value);
    },
    setAutoScrollThread(value) {
      autoScrollThread = Boolean(value);
    },
    setReducedMotion(value) {
      reducedMotion = Boolean(value);
    },
    setPendingApprovalVisible(value) {
      pendingApprovalVisible = Boolean(value);
    },
    setScrollMetrics({ scrollTop, scrollHeight, clientHeight } = {}) {
      if (Number.isFinite(Number(scrollTop))) chatThreadScroll.scrollTop = Number(scrollTop);
      if (Number.isFinite(Number(scrollHeight))) chatThreadScroll.scrollHeight = Number(scrollHeight);
      if (Number.isFinite(Number(clientHeight))) chatThreadScroll.clientHeight = Number(clientHeight);
    },
    setStageBottom(value) {
      stageBottom = value;
    },
    setComposerTop(value) {
      composerTop = value;
    },
    setComposerHeight(value) {
      composerHeight = value;
    },
    setSurfaceLayerRect({ left = layerLeft, width = layerWidth } = {}) {
      layerLeft = left;
      layerWidth = width;
    },
    setThreadColumnRect({ left = threadColumnLeft, width = threadColumnWidth } = {}) {
      threadColumnLeft = left;
      threadColumnWidth = width;
    },
    flushAnimationFrame() {
      const entry = rafQueue.shift();
      if (entry && !entry.cancelled) {
        rafNow += 16;
        entry.callback(rafNow);
      }
    },
    getAnimationFrameQueueLength() {
      return rafQueue.filter((entry) => !entry.cancelled).length;
    },
    state: viewportState,
    thinkingController,
    restore() {
      global.window = previousWindow;
      global.document = previousDocument;
      global.ResizeObserver = previousResizeObserver;
      global.requestAnimationFrame = previousRequestAnimationFrame;
      global.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

function createThinkingViewportHarness() {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;

  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="timeline">
      <article class="chat-entry assistant" data-message-id="assistant_1">
        <div class="reasoning-row-stack">
          <div class="reasoning-row-block" data-thinking-id="phase_1">
            <button
              type="button"
              class="reasoning-row-header"
              data-reasoning-toggle="true"
              data-message-id="assistant_1"
              data-phase-key="phase_1"
              data-thinking-id="phase_1"
              data-default-expanded="false"
              aria-controls="reasoning-panel-assistant_1-phase_1"
              aria-expanded="false"
            >Toggle</button>
            <div class="reasoning-row-panel" id="reasoning-panel-assistant_1-phase_1" hidden>
              <div class="reasoning-row-panel-body">Reasoning body</div>
            </div>
          </div>
          <div class="reasoning-row-block" data-thinking-id="phase_2">
            <button
              type="button"
              class="reasoning-row-header"
              data-reasoning-toggle="true"
              data-message-id="assistant_1"
              data-phase-key="phase_2"
              data-thinking-id="phase_2"
              data-default-expanded="false"
              aria-controls="reasoning-panel-assistant_1-phase_2"
              aria-expanded="false"
            >Toggle</button>
            <div class="reasoning-row-panel" id="reasoning-panel-assistant_1-phase_2" hidden>
              <div class="reasoning-row-panel-body">Second reasoning body</div>
            </div>
          </div>
        </div>
      </article>
    </div>
  </body></html>`);

  const rafQueue = [];
  const timeoutQueue = [];
  let nextTimerId = 1;
  let spriteUpdateCount = 0;
  let thinkingHandleScrollCount = 0;
  const expandedPhases = new Map([['phase_1', false], ['phase_2', false]]);
  let currentMessages = [{ id: 'assistant_1', role: 'assistant' }];

  function queueAnimationFrame(callback) {
    rafQueue.push(callback);
    return rafQueue.length;
  }

  function queueTimeout(callback, delayMs) {
    const id = nextTimerId;
    nextTimerId += 1;
    timeoutQueue.push({ id, callback, delayMs: Number(delayMs) || 0 });
    return id;
  }

  function clearQueuedTimeout(timerId) {
    const targetId = Number(timerId) || 0;
    const index = timeoutQueue.findIndex((entry) => entry.id === targetId);
    if (index !== -1) {
      timeoutQueue.splice(index, 1);
    }
  }

  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = queueAnimationFrame;
  global.cancelAnimationFrame = () => {};
  dom.window.requestAnimationFrame = queueAnimationFrame;
  dom.window.cancelAnimationFrame = () => {};
  dom.window.setTimeout = queueTimeout;
  dom.window.clearTimeout = clearQueuedTimeout;
  dom.window.innerHeight = 777;
  dom.window.getComputedStyle = () => ({
    getPropertyValue() { return ''; },
    scrollBehavior: 'auto',
  });

  const controller = viewportUtils.createViewportController({
    state: {
      currentSessionId: 'session-1',
      ui: {
        activeView: 'chat',
        chatMode: 'thread',
        followLatest: true,
        interactiveRecapExpandedBySession: new Map(),
      },
    },
    constants: { MESSAGE_STATUS: { COMPLETE: 'complete' } },
    dom: {
      chatView: createTarget(() => ({ top: 0, bottom: 760, width: 900, height: 760 })),
      chatThreadStage: createTarget(() => ({ top: 0, bottom: 600, width: 620, height: 600 })),
      composerWrap: createTarget(() => ({ top: 610, bottom: 740, width: 620, height: 130 })),
      chatTimeline: dom.window.document.getElementById('timeline'),
      chatThreadScroll: createTarget(() => ({ top: 0, bottom: 600, width: 620, height: 600 })),
    },
    controllers: {
      thinkingController: {
        resumeAutoScroll() {},
        shouldAutoScroll() { return false; },
        handleScroll() {
          thinkingHandleScrollCount += 1;
          return true;
        },
        isPhaseExpanded(_messageId, phaseKey, defaultExpanded) {
          return expandedPhases.has(phaseKey) ? expandedPhases.get(phaseKey) : defaultExpanded === true;
        },
        isExpanded() {
          return [...expandedPhases.values()].some(Boolean);
        },
      },
      reducedMotionQuery: { matches: false },
    },
    callbacks: {
      mergeReasoningEntries() { return []; },
      deriveFollowLatestFromScroll() { return true; },
      shouldAutoScrollThread() { return false; },
      escapeSelectorValue(value) { return value; },
      getCurrentSessionMessages() { return currentMessages; },
      buildInteractiveRecapViewModel() { return null; },
      renderMessages() {},
      updateAssistantSpritePosition(messages) {
        spriteUpdateCount += 1;
        currentMessages = Array.isArray(messages) ? messages : currentMessages;
      },
      appendClientLog() {},
    },
  });

  return {
    controller,
    setExpanded(value) {
      expandedPhases.set('phase_1', Boolean(value));
    },
    setPhaseExpanded(phaseKey, value) {
      expandedPhases.set(String(phaseKey || ''), Boolean(value));
    },
    getSpriteUpdateCount() {
      return spriteUpdateCount;
    },
    getThinkingHandleScrollCount() {
      return thinkingHandleScrollCount;
    },
    getPendingTimeoutCount() {
      return timeoutQueue.length;
    },
    flushAnimationFrames() {
      while (rafQueue.length) {
        const callbacks = rafQueue.splice(0);
        callbacks.forEach((callback) => callback());
      }
    },
    flushAnimationFrame() {
      const callback = rafQueue.shift();
      if (callback) callback();
    },
    flushTimeouts() {
      while (timeoutQueue.length) {
        const callbacks = timeoutQueue.splice(0);
        callbacks.forEach((entry) => entry.callback());
      }
    },
    flushTimeoutsByDelay(delayMs) {
      const matching = timeoutQueue.filter((entry) => entry.delayMs === delayMs);
      matching.forEach((entry) => clearQueuedTimeout(entry.id));
      matching.forEach((entry) => entry.callback());
    },
    restore() {
      global.window = previousWindow;
      global.document = previousDocument;
      global.requestAnimationFrame = previousRequestAnimationFrame;
      global.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

module.exports = {
  createThinkingViewportHarness,
  createViewportControllerHarness,
};
