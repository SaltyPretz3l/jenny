// Shared jsdom harness for the thinking pipeline (sprite positioning + live
// reasoning status) suites; extracted from renderer-render-pipeline-thinking.test.js.
const { JSDOM } = require('jsdom');

function createFrameScheduler() {
  let nextHandle = 1;
  const pending = new Map();
  return {
    request(callback) {
      const handle = nextHandle++;
      pending.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
    flushNext(timestamp = 16) {
      const next = pending.entries().next().value;
      if (!next) return false;
      pending.delete(next[0]);
      next[1](timestamp);
      return true;
    },
    flushAll(limit = 20) {
      let count = 0;
      while (count < limit && this.flushNext(16 + count * 16)) count += 1;
      return count;
    },
    get size() {
      return pending.size;
    },
  };
}

function loadThinkingUtils() {
  const modulePath = require.resolve('../../renderer/chat/renderer-render-pipeline-thinking');
  delete require.cache[modulePath];
  return require(modulePath);
}

// Stands in for rendererMultiStreamController: per-session stream and preflight maps.
function createMultiStreamStub() {
  const streams = new Map();
  const preflights = new Map();
  const finalized = new Set();
  const settled = new Set();
  return {
    streams,
    preflights,
    finalized,
    settled,
    getStreamIdForSession: (id) => streams.get(id) || '',
    getSessionIdForStream: (streamId) => [...streams].find(([, value]) => value === streamId)?.[0] || '',
    getPreflight: (id) => preflights.get(id) || null,
    isStreamFinalized: (streamId) => finalized.has(streamId),
    isStreamTerminalSettled: (streamId) => settled.has(streamId),
  };
}

// paneSessionId, state and multiStream let two harnesses stand in for two panes of one app.
function createHarness({
  messages = [],
  preflight = false,
  cancelFrames = true,
  paneSessionId = '',
  state: sharedState = null,
  multiStream = createMultiStreamStub(),
  toolCallUtils = null,
  runtimeSendController = undefined,
} = {}) {
  const scheduler = createFrameScheduler();
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="column">
      <div id="layer"><div id="sprite"></div></div>
      <div id="timeline"></div>
    </div>
  </body></html>`);
  const documentRef = dom.window.document;
  // jsdom reports a never-painted document as hidden, which would suspend the activity dot.
  Object.defineProperty(documentRef, 'hidden', { configurable: true, get: () => false });
  const timeline = documentRef.getElementById('timeline');
  const layer = documentRef.getElementById('layer');
  const sprite = documentRef.getElementById('sprite');
  const column = documentRef.getElementById('column');
  let layerDisplay = 'block';
  const resizeObservers = [];
  dom.window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); resizeObservers.push(this); }
    observe(target) { this.targets.add(target); }
    disconnect() { this.targets.clear(); }
  };

  global.window = dom.window;
  global.document = documentRef;
  const { createThinkingPipeline } = loadThinkingUtils();

  dom.window.getComputedStyle = (element) => ({
    display: element === layer ? layerDisplay : 'block',
    visibility: 'visible',
    rowGap: '16px',
    gap: '16px',
    transform: 'none',
    opacity: '1',
    getPropertyValue: () => '',
  });
  layer.getBoundingClientRect = () => ({ top: 0, left: 0, right: 52, bottom: 800, width: 52, height: 800 });
  sprite.getBoundingClientRect = () => ({ top: 0, left: 2, right: 32, bottom: 30, width: 30, height: 30 });

  for (const [index, message] of messages.entries()) {
    if (!message?.id) continue;
    const node = documentRef.createElement('article');
    node.dataset.messageId = message.id;
    node.className = 'chat-entry';
    node.getBoundingClientRect = () => ({
      top: 100 + index * 100,
      left: 60,
      right: 500,
      bottom: 160 + index * 100,
      width: 440,
      height: 60,
    });
    const bubble = documentRef.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.getBoundingClientRect = node.getBoundingClientRect;
    node.appendChild(bubble);
    timeline.appendChild(node);
  }

  const state = sharedState || {
    currentSessionId: 'session-1',
    activeStreamSessionId: '',
    activeStreamId: '',
    streamThinkingStatusByStream: new Map(),
    toolCallsByStream: new Map(),
    streamDeltaKindByStream: new Map(),
    pendingToolApprovals: new Map(),
    features: { featureFlags: {} },
    ui: { activeView: 'chat', chatMode: 'thread', chatSendLifecycleBySession: new Map() },
  };
  globalThis.rendererMultiStreamController = multiStream;
  globalThis.toolCallUtils = toolCallUtils || require('../../renderer/chat/tool-call-utils');
  globalThis.rendererApprovalBlock = require('../../renderer/chat/renderer-approval-block');
  if (preflight) multiStream.preflights.set(paneSessionId || state.currentSessionId, { pending: true });
  const spriteRuntime = {};
  const pipeline = createThinkingPipeline({
    requestAnimationFrame: (callback) => scheduler.request(callback),
    cancelAnimationFrame: cancelFrames
      ? (handle) => scheduler.cancel(handle)
      : () => {},
    state,
    constants: { MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete', ERROR: 'error' } },
    dom: {
      chatTimeline: timeline,
      chatThreadColumn: column,
      chatSpriteLayer: layer,
      chatAssistantSprite: sprite,
    },
    controllers: {
      thinkingIndicator: {
        getDisplayState() { return { mode: 'idle' }; },
      },
      ...(runtimeSendController === undefined ? {} : { getRuntimeSendController: () => runtimeSendController }),
    },
    runtime: { spriteRuntime },
    callbacks: {
      ...(paneSessionId ? { getPaneSessionId: () => paneSessionId } : {}),
      getCurrentSessionMessages: () => messages,
      getLatestAssistantMessageId: (items) => {
        const match = [...items].reverse().find((message) => message?.role === 'assistant');
        return match?.id || '';
      },
      getLatestUserMessageId: (items) => {
        const match = [...items].reverse().find((message) => message?.role === 'user');
        return match?.id || '';
      },
      escapeSelectorValue: (value) => String(value),
    },
  });

  return {
    dom,
    resizeObservers,
    layer,
    messages,
    multiStream,
    pipeline,
    scheduler,
    sprite,
    spriteRuntime,
    state,
    setLayerDisplay: (value) => { layerDisplay = value; },
    setLifecycle: (sessionId, phase) => {
      if (phase) state.ui.chatSendLifecycleBySession.set(sessionId, phase);
      else state.ui.chatSendLifecycleBySession.delete(sessionId);
    },
  };
}

function appendReasoningRow(article, {
  thinkingId = 'shared-thinking',
  status = 'streaming',
  label = 'Original label',
} = {}) {
  const row = article.ownerDocument.createElement('div');
  row.className = 'reasoning-row-block';
  row.dataset.thinkingId = thinkingId;
  row.dataset.reasoningStatus = status;
  const main = article.ownerDocument.createElement('div');
  main.className = 'reasoning-row-main';
  main.textContent = label;
  row.appendChild(main);
  article.appendChild(row);
  return { main, row };
}

function setLiveThinkingState(harness, {
  streamId = 'stream-1',
  thinkingId = 'shared-thinking',
  text = 'Updated live status',
} = {}) {
  harness.state.activeStreamSessionId = 'session-1';
  harness.state.activeStreamId = streamId;
  harness.state.streamThinkingStatusByStream.set(streamId, { text, thinkingId });
}

module.exports = { appendReasoningRow, createHarness, setLiveThinkingState };
