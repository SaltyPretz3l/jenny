const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSurfaceStatePipeline } = require('../renderer/chat/renderer-render-pipeline-surface-state');

function createClassList(initialClasses = []) {
  const classes = new Set(initialClasses);
  return {
    add(...tokens) {
      tokens.forEach((token) => classes.add(token));
    },
    remove(...tokens) {
      tokens.forEach((token) => classes.delete(token));
    },
    contains(token) {
      return classes.has(token);
    },
    toggle(token, force) {
      if (force === undefined) {
        if (classes.has(token)) {
          classes.delete(token);
          return false;
        }
        classes.add(token);
        return true;
      }
      if (force) {
        classes.add(token);
        return true;
      }
      classes.delete(token);
      return false;
    },
  };
}

function createElement(initialClasses = []) {
  const attributes = new Map();
  return {
    dataset: {},
    classList: createClassList(initialClasses),
    setAttribute(name, value) {
      attributes.set(String(name), String(value));
    },
    removeAttribute(name) {
      attributes.delete(String(name));
    },
    getAttribute(name) {
      return attributes.has(String(name)) ? attributes.get(String(name)) : null;
    },
  };
}

test('production app chat send lifecycle normalizer admits failed token', () => {
  // The chat-send-lifecycle normalizer was extracted from renderer/app.js into
  // renderer/app/renderer-app-lifecycle-preferences.js (createChatSendLifecycleController,
  // wired into app.js). Assert the FAILED token mapping still lives in that production
  // module so the normalizer continues to admit a 'failed' lifecycle token.
  const lifecyclePreferencesSource = fs.readFileSync(
    path.join(__dirname, '..', 'renderer', 'app', 'renderer-app-lifecycle-preferences.js'),
    'utf8'
  );
  assert.match(lifecyclePreferencesSource, /FAILED:\s*'failed'/);
});

test('surface state pipeline preserves failed send lifecycle as a stable renderer token', () => {
  const chatView = { dataset: {} };
  const composerWrap = { dataset: {} };
  const composer = { dataset: {} };
  const state = {
    currentSessionId: 'session-failed',
    ui: { chatMode: 'thread' },
  };
  const pipeline = createSurfaceStatePipeline({
    state,
    dom: { chatView, composerWrap, composer },
    callbacks: {
      getChatSendLifecycle: () => 'failed',
      isSendPreflightPending: () => false,
      isSessionStreaming: () => false,
      hasPendingToolApprovalForSession: () => false,
    },
  });

  pipeline.syncStableChatSurfaceState();

  assert.equal(chatView.dataset.sendLifecycle, 'failed');
  assert.equal(composerWrap.dataset.sendLifecycle, 'failed');
  assert.equal(composer.dataset.sendLifecycle, 'failed');
});

test('pending approval keeps the DOM lifecycle on its existing streaming token', () => {
  for (const explicitLifecycle of ['idle', 'streaming']) {
    const chatView = { dataset: {} };
    const composerWrap = { dataset: {} };
    const composer = { dataset: {} };
    const pipeline = createSurfaceStatePipeline({
      state: { currentSessionId: 'session-approval', ui: { chatMode: 'thread' } },
      dom: { chatView, composerWrap, composer },
      callbacks: {
        getChatSendLifecycle: () => explicitLifecycle,
        isSendPreflightPending: () => false,
        isSessionStreaming: () => explicitLifecycle === 'streaming',
        hasPendingToolApprovalForSession: () => true,
      },
    });

    pipeline.syncStableChatSurfaceState();
    assert.equal(chatView.dataset.sendLifecycle, 'streaming');
    assert.equal(composerWrap.dataset.sendLifecycle, 'streaming');
    assert.equal(composer.dataset.sendLifecycle, 'streaming');
  }
});

test('syncChatState latches structural surface work during repeated streaming renders', () => {
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  let viewportFrameRequests = 0;
  global.requestAnimationFrame = () => {
    viewportFrameRequests += 1;
    return viewportFrameRequests;
  };
  try {
    let refreshActiveSurfaceEffectCalls = 0;
    const chatView = createElement(['chat-active', 'thread-transition-ready']);
    const composerWrap = createElement();
    const composer = createElement();
    const state = {
      currentSessionId: 'session-streaming',
      ui: {
        activeView: 'chat',
        appearance: { surfaceEffectId: 'playlist-scroll' },
        chatMode: 'thread',
      },
    };
    const pipeline = createSurfaceStatePipeline({
      state,
      dom: { chatView, composerWrap, composer },
      callbacks: {
        getChatSendLifecycle: () => 'streaming',
        refreshActiveSurfaceEffect: () => { refreshActiveSurfaceEffectCalls += 1; },
        updateComposerSafeOffset: () => {},
      },
    });

    pipeline.syncChatState(true);

    assert.equal(chatView.dataset.sendLifecycle, 'streaming');
    assert.equal(composerWrap.dataset.sendLifecycle, 'streaming');
    assert.equal(composer.dataset.sendLifecycle, 'streaming');
    assert.equal(chatView.classList.contains('thread-transition-ready'), true);
    assert.equal(refreshActiveSurfaceEffectCalls, 0);
    assert.equal(viewportFrameRequests, 0);
  } finally {
    if (previousRequestAnimationFrame === undefined) {
      delete global.requestAnimationFrame;
    } else {
      global.requestAnimationFrame = previousRequestAnimationFrame;
    }
  }
});

test('syncChatState still performs the first thread transition when streaming begins from empty mode', () => {
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  let viewportFrameRequests = 0;
  global.requestAnimationFrame = () => {
    viewportFrameRequests += 1;
    return viewportFrameRequests;
  };
  try {
    let refreshActiveSurfaceEffectCalls = 0;
    const chatView = createElement(['chat-empty']);
    const composerWrap = createElement();
    const composer = createElement();
    const state = {
      currentSessionId: 'session-streaming',
      ui: {
        activeView: 'chat',
        appearance: { surfaceEffectId: 'playlist-scroll' },
        chatMode: 'empty',
      },
    };
    const pipeline = createSurfaceStatePipeline({
      state,
      dom: { chatView, composerWrap, composer },
      callbacks: {
        getChatSendLifecycle: () => 'streaming',
        refreshActiveSurfaceEffect: () => { refreshActiveSurfaceEffectCalls += 1; },
        updateComposerSafeOffset: () => {},
      },
    });

    pipeline.syncChatState(true);

    assert.equal(state.ui.chatMode, 'thread');
    assert.equal(chatView.dataset.chatMode, 'thread');
    assert.equal(chatView.classList.contains('chat-active'), true);
    assert.equal(chatView.classList.contains('chat-empty'), false);
    assert.equal(chatView.dataset.sendLifecycle, 'streaming');
    assert.equal(refreshActiveSurfaceEffectCalls, 1);
    assert.equal(viewportFrameRequests, 1);
  } finally {
    if (previousRequestAnimationFrame === undefined) {
      delete global.requestAnimationFrame;
    } else {
      global.requestAnimationFrame = previousRequestAnimationFrame;
    }
  }
});

test('syncChatState preserves idle viewport refresh while avoiding unchanged surface-effect rebinds', () => {
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  let viewportFrameRequests = 0;
  global.requestAnimationFrame = () => {
    viewportFrameRequests += 1;
    return viewportFrameRequests;
  };
  try {
    let refreshActiveSurfaceEffectCalls = 0;
    const chatView = createElement(['chat-active', 'thread-transition-ready']);
    const composerWrap = createElement();
    const composer = createElement();
    const state = {
      currentSessionId: 'session-idle',
      ui: {
        activeView: 'chat',
        appearance: { surfaceEffectId: 'playlist-scroll' },
        chatMode: 'thread',
      },
    };
    const pipeline = createSurfaceStatePipeline({
      state,
      dom: { chatView, composerWrap, composer },
      callbacks: {
        getChatSendLifecycle: () => 'idle',
        refreshActiveSurfaceEffect: () => { refreshActiveSurfaceEffectCalls += 1; },
        updateComposerSafeOffset: () => {},
      },
    });

    pipeline.syncChatState(true);

    assert.equal(chatView.classList.contains('thread-transition-ready'), false);
    assert.equal(refreshActiveSurfaceEffectCalls, 0);
    assert.equal(viewportFrameRequests, 1);
  } finally {
    if (previousRequestAnimationFrame === undefined) {
      delete global.requestAnimationFrame;
    } else {
      global.requestAnimationFrame = previousRequestAnimationFrame;
    }
  }
});

test('viewport refresh frames coalesce and cannot update after pipeline disposal', (t) => {
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  const callbacks = [];
  const canceledHandles = [];
  global.requestAnimationFrame = (callback) => {
    callbacks.push(callback);
    return 40 + callbacks.length;
  };
  global.cancelAnimationFrame = (handle) => {
    canceledHandles.push(handle);
  };
  t.after(() => {
    if (previousRequestAnimationFrame === undefined) {
      delete global.requestAnimationFrame;
    } else {
      global.requestAnimationFrame = previousRequestAnimationFrame;
    }
    if (previousCancelAnimationFrame === undefined) {
      delete global.cancelAnimationFrame;
    } else {
      global.cancelAnimationFrame = previousCancelAnimationFrame;
    }
  });

  let offsetCalls = 0;
  const chatView = createElement(['chat-active']);
  chatView.ownerDocument = { getElementById: () => null };
  const pipeline = createSurfaceStatePipeline({
    state: {
      currentSessionId: 'session-viewport',
      ui: { activeView: 'chat', appearance: { surfaceEffectId: 'none' }, chatMode: 'thread' },
    },
    dom: { chatView },
    runtime: { uiRuntime: {} },
    callbacks: { updateComposerSafeOffset: () => { offsetCalls += 1; } },
  });

  pipeline.syncChatState(true);
  pipeline.syncChatState(true);
  pipeline.dispose();
  callbacks.forEach((callback) => callback());

  assert.deepEqual(
    { frameRequests: callbacks.length, canceledHandles, offsetCalls },
    { frameRequests: 1, canceledHandles: [41], offsetCalls: 0 }
  );
});

test('empty sessions remain in the empty surface state', (t) => {
  // Brief D7 regression (owner smoke 2026-07-31): the setup card renders
  // inside the thread shell, and `.chat-view.chat-empty` fades that shell to
  // opacity 0 — an empty image session must therefore present as active only
  // once provisioning is known to be not ready.
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  global.requestAnimationFrame = () => 1;
  t.after(() => {
    if (previousRequestAnimationFrame === undefined) {
      delete global.requestAnimationFrame;
    } else {
      global.requestAnimationFrame = previousRequestAnimationFrame;
    }
  });
  const chatView = createElement(['chat-empty']);
  const state = {
    currentSessionId: 'session-chat',
    ui: { activeView: 'chat', appearance: { surfaceEffectId: 'none' }, chatMode: 'empty' },
  };
  const pipeline = createSurfaceStatePipeline({
    state,
    dom: { chatView, composerWrap: createElement(), composer: createElement() },
    callbacks: {
      getChatSendLifecycle: () => 'idle',
      refreshActiveSurfaceEffect: () => {},
      updateComposerSafeOffset: () => {},
    },
  });

  pipeline.syncChatState(false);
  assert.equal(chatView.classList.contains('chat-active'), false);
  assert.equal(chatView.classList.contains('chat-empty'), true);
});
