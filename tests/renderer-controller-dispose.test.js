const test = require('node:test');
const assert = require('node:assert/strict');

const attachmentUtils = require('../renderer/features/renderer-attachment-event-utils.js');
const viewportUtils = require('../renderer/shell/renderer-viewport-utils.js');
const composerHoloUtils = require('../renderer/chat/renderer-composer-holo-utils.js');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

const HARNESS_RAF_FRAME_MS = 16;

function createEventTarget(name = 'target') {
  const styleValues = new Map();
  const listeners = new Map();
  return {
    name,
    dataset: {},
    style: {
      setProperty(name, value) {
        styleValues.set(name, value);
      },
      getPropertyValue(name) {
        return styleValues.get(name) || '';
      },
    },
    textContent: '',
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    listeners,
    added: [],
    removed: [],
    addEventListener(eventName, handler, options) {
      this.added.push({ eventName, handler, options });
      listeners.set(`${eventName}:${this.added.length}`, handler);
    },
    removeEventListener(eventName, handler, options) {
      this.removed.push({ eventName, handler, options });
    },
    contains() {
      return false;
    },
    focus() {},
    select() {},
    click() {},
    appendChild() {},
    remove() {},
    scrollTo() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute() {},
    removeAttribute() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 200, height: 120 };
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  };
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

function dispatchPastedImage(window, input, name = 'clipboard.png') {
  const pastedBlob = new window.Blob([Uint8Array.from([137, 80, 78, 71])], { type: 'image/png' });
  pastedBlob.name = name;
  const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(pasteEvent, 'clipboardData', {
    value: {
      items: [{
        type: 'image/png',
        getAsFile() {
          return pastedBlob;
        },
      }],
    },
  });
  input.dispatchEvent(pasteEvent);
}

function navigateToArtifacts(doc) {
  // The legacy sidebar nav (and its [data-tab-id] click routing) is gone, and
  // Artifacts is not a permanent top-rail tab. The rail's delegated
  // handleRailClick listener (on #topRailTabs) activates any
  // .toprail-tab[data-tab-id] and drives the real setActiveView('artifacts'),
  // so synthesize a transient rail tab to reach the full Artifacts view, then
  // remove it. Mirrors tests/renderer-shell-settings.test.js. No null guard on
  // purpose: a missing #topRailTabs should throw loudly, not silently no-op.
  const railTabs = doc.getElementById('topRailTabs');
  const tmp = doc.createElement('button');
  tmp.className = 'toprail-tab';
  tmp.dataset.tabId = 'artifacts';
  railTabs.appendChild(tmp);
  tmp.click();
  tmp.remove();
}

test('attachment event bindings dispose removes document and window listeners idempotently', () => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousNavigator = global.navigator;
  const fakeWindow = createEventTarget('window');
  const fakeDocument = createEventTarget('document');
  global.window = fakeWindow;
  global.document = fakeDocument;
  global.navigator = { mediaDevices: {} };

  try {
    const controller = attachmentUtils.createAttachmentEventBindings({
      state: { ui: { composerPopoverOpen: false } },
      constants: { TOAST_SOURCE: { attachments: 'attachments' } },
      dom: {
        attachmentTray: createEventTarget('attachmentTray'),
        composerSettingsPopover: createEventTarget('composerSettingsPopover'),
        composerSettingsButton: createEventTarget('composerSettingsButton'),
        composerAttachShortcut: createEventTarget('composerAttachShortcut'),
        chatInput: createEventTarget('chatInput'),
        chatView: createEventTarget('chatView'),
        attachFilesButton: createEventTarget('attachFilesButton'),
        captureScreenButton: createEventTarget('captureScreenButton'),
      },
      callbacks: {
        resetAttachmentQueue() {},
        removeQueuedAttachment() {},
        renderAttachmentTray() {},
        suppressFileDropNavigation() {},
        setDropActive() {},
        prepareDroppedAttachments: async () => {},
        getDroppedFilePaths() { return []; },
        renderComposerPopover() {},
        syncComposerModelSelectWidth() {},
        updateComposerSafeOffset() {},
        closeComposerPopover() {},
        queueInlineImageAttachment: async () => {},
        handleAttachmentPicker: async () => {},
        showToastMessage() {},
        toErrorMessage(error, fallback) {
          return error?.message || fallback;
        },
      },
    });

    controller.bind();
    const removalBaseline = fakeWindow.removed.length + fakeDocument.removed.length;
    assert.ok(fakeWindow.added.length > 0);
    assert.ok(fakeDocument.added.length > 0);

    controller.dispose();
    assert.ok(fakeWindow.removed.length + fakeDocument.removed.length > removalBaseline);

    const removedAfterFirstDispose = fakeWindow.removed.length + fakeDocument.removed.length;
    controller.dispose();
    assert.equal(fakeWindow.removed.length + fakeDocument.removed.length, removedAfterFirstDispose);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.navigator = previousNavigator;
  }
});

test('attachment event bindings let image paste win over oversized clipboard text', async () => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousNavigator = global.navigator;
  const fakeWindow = createEventTarget('window');
  const fakeDocument = createEventTarget('document');
  const chatInput = createEventTarget('chatInput');
  const queuedImages = [];
  global.window = fakeWindow;
  global.document = fakeDocument;
  global.navigator = { mediaDevices: {} };

  try {
    const controller = attachmentUtils.createAttachmentEventBindings({
      state: { ui: { composerPopoverOpen: false } },
      constants: { TOAST_SOURCE: { attachments: 'attachments', composerAction: 'composerAction' } },
      dom: {
        attachmentTray: createEventTarget('attachmentTray'),
        composerSettingsPopover: createEventTarget('composerSettingsPopover'),
        composerSettingsButton: createEventTarget('composerSettingsButton'),
        composerAttachShortcut: createEventTarget('composerAttachShortcut'),
        chatInput,
        chatView: createEventTarget('chatView'),
        attachFilesButton: createEventTarget('attachFilesButton'),
        captureScreenButton: createEventTarget('captureScreenButton'),
      },
      callbacks: {
        resetAttachmentQueue() {},
        removeQueuedAttachment() {},
        renderAttachmentTray() {},
        suppressFileDropNavigation() {},
        setDropActive() {},
        prepareDroppedAttachments: async () => {},
        getDroppedFilePaths() { return []; },
        renderComposerPopover() {},
        renderCommandPopover() {},
        syncComposerModelSelectWidth() {},
        updateComposerSafeOffset() {},
        closeComposerPopover() {},
        closeCommandPopover() {},
        queueInlineImageAttachment: async (payload) => {
          queuedImages.push(payload);
        },
        handleAttachmentPicker: async () => {},
        showToastMessage() {},
        appendClientLog() {},
        toErrorMessage(error, fallback) {
          return error?.message || fallback;
        },
      },
    });
    controller.bind();

    const pasteListener = chatInput.added.find((entry) => entry.eventName === 'paste');
    assert.ok(pasteListener);
    let defaultPrevented = false;
    pasteListener.handler({
      get defaultPrevented() {
        return defaultPrevented;
      },
      preventDefault() {
        defaultPrevented = true;
      },
      clipboardData: {
        getData() {
          return 'x'.repeat(1024 * 1024 + 1);
        },
        items: [{
          type: 'image/png',
          getAsFile() {
            return {
              name: 'clipboard.png',
              type: 'image/png',
              async arrayBuffer() {
                return Uint8Array.from([137, 80, 78, 71]).buffer;
              },
            };
          },
        }],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(defaultPrevented, true);
    assert.equal(queuedImages.length, 1);
    assert.equal(queuedImages[0].displayName, 'clipboard.png');
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.navigator = previousNavigator;
  }
});

test('attachment event bindings fail closed when popover targets are missing', () => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousNavigator = global.navigator;
  const fakeWindow = createEventTarget('window');
  const fakeDocument = createEventTarget('document');
  global.window = fakeWindow;
  global.document = fakeDocument;
  global.navigator = { mediaDevices: {} };

  let composerPopoverCloseCalls = 0;
  let commandPopoverCloseCalls = 0;
  const uiState = { composerPopoverOpen: true, commandPopoverOpen: true };

  try {
    const controller = attachmentUtils.createAttachmentEventBindings({
      state: { ui: uiState },
      constants: { TOAST_SOURCE: { attachments: 'attachments' } },
      dom: {
        attachmentTray: createEventTarget('attachmentTray'),
        composerAttachShortcut: createEventTarget('composerAttachShortcut'),
        chatInput: createEventTarget('chatInput'),
        chatView: createEventTarget('chatView'),
        attachFilesButton: createEventTarget('attachFilesButton'),
        captureScreenButton: createEventTarget('captureScreenButton'),
      },
      callbacks: {
        resetAttachmentQueue() {},
        removeQueuedAttachment() {},
        renderAttachmentTray() {},
        suppressFileDropNavigation() {},
        setDropActive() {},
        prepareDroppedAttachments: async () => {},
        getDroppedFilePaths() { return []; },
        renderComposerPopover() {},
        renderCommandPopover() {},
        syncComposerModelSelectWidth() {},
        updateComposerSafeOffset() {},
        closeComposerPopover() { composerPopoverCloseCalls += 1; uiState.composerPopoverOpen = false; },
        closeCommandPopover() { commandPopoverCloseCalls += 1; uiState.commandPopoverOpen = false; },
        queueInlineImageAttachment: async () => {},
        handleAttachmentPicker: async () => {},
        showToastMessage() {},
        toErrorMessage(error, fallback) {
          return error?.message || fallback;
        },
      },
    });

    controller.bind();

    const documentMouseDown = fakeDocument.added.find((entry) => entry.eventName === 'mousedown');
    const documentKeydown = fakeDocument.added.find((entry) => entry.eventName === 'keydown');
    assert.ok(documentMouseDown, 'bind registers global mousedown handler');
    assert.ok(documentKeydown, 'bind registers global keydown handler');

    assert.doesNotThrow(() => {
      documentMouseDown.handler({ target: {} });
      documentKeydown.handler({ key: 'Tab', preventDefault() {}, shiftKey: false });
    });

    assert.equal(composerPopoverCloseCalls, 1);
    assert.equal(commandPopoverCloseCalls, 1);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.navigator = previousNavigator;
  }
});


test('viewport controller dispose clears the resize observer idempotently', () => {
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousResizeObserver = global.ResizeObserver;
  const { FakeResizeObserver, instances } = createResizeObserverHarness();
  global.window = { setTimeout, clearTimeout, requestAnimationFrame: (callback) => callback(), getComputedStyle() { return { scrollBehavior: 'auto' }; } };
  global.document = { getElementById() { return null; } };
  global.ResizeObserver = FakeResizeObserver;

  try {
    const controller = viewportUtils.createViewportController({
      state: {
        currentSessionId: 'session-1',
        ui: { followLatest: true },
      },
      constants: { MESSAGE_STATUS: { COMPLETE: 'complete' } },
      dom: {
        chatView: createEventTarget('chatView'),
        composerWrap: createEventTarget('composerWrap'),
        chatTimeline: createEventTarget('chatTimeline'),
        chatThreadScroll: {
          ...createEventTarget('chatThreadScroll'),
          scrollHeight: 100,
          clientHeight: 50,
          scrollTop: 0,
        },
      },
      controllers: {
        thinkingController: {
          resumeAutoScroll() {},
          shouldAutoScroll() { return false; },
          handleScroll() {},
          isExpanded() { return false; },
        },
        reducedMotionQuery: { matches: false },
      },
      callbacks: {
        mergeReasoningEntries() { return []; },
        deriveFollowLatestFromScroll() { return true; },
        shouldAutoScrollThread() { return false; },
        escapeSelectorValue(value) { return value; },
        getCurrentSessionMessages() { return []; },
        setSessionMessages() {},
        renderMessages() {},
        updateAssistantSpritePosition() {},
      },
    });

    controller.initializeComposerLayoutObserver();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].observeCalls.length, 2);

    controller.disposeViewportController();
    assert.equal(instances[0].disconnectCalls, 1);

    controller.disposeViewportController();
    assert.equal(instances[0].disconnectCalls, 1);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.ResizeObserver = previousResizeObserver;
  }
});

test('composer holo dispose disconnects observers idempotently', () => {
  const previousResizeObserver = global.ResizeObserver;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  const previousWindow = global.window;
  const { FakeResizeObserver, instances } = createResizeObserverHarness();

  global.ResizeObserver = FakeResizeObserver;
  global.requestAnimationFrame = () => 1;
  global.cancelAnimationFrame = () => {};
  global.window = { devicePixelRatio: 1 };

  try {
    const controller = composerHoloUtils.createComposerHoloController({
      composer: createEventTarget('composer'),
      composerHolo: {
        ...createEventTarget('composerHolo'),
        getBoundingClientRect() {
          return { width: 320, height: 180 };
        },
      },
      composerHoloContext: {
        createConicGradient() {
          return { addColorStop() {} };
        },
        clearRect() {},
        save() {},
        restore() {},
        beginPath() {},
        arc() {},
        stroke() {},
        fillRect() {},
        setTransform() {},
        scale() {},
        lineWidth: 0,
        strokeStyle: '',
        globalAlpha: 1,
      },
      composerHoloRuntime: {
        active: false,
        mode: 'idle',
        angle: 0,
        frameHandle: 0,
        lastFrame: 0,
        pixelRatio: 1,
        cssWidth: 0,
        cssHeight: 0,
        resizeObserver: null,
        supported: true,
      },
      reducedMotionQuery: { matches: true },
    });

    controller.initializeComposerHolo();
    assert.equal(instances.length, 1);
    assert.equal(instances[0].observeCalls.length, 1);

    controller.disposeComposerHolo();
    assert.equal(instances[0].disconnectCalls, 1);

    controller.disposeComposerHolo();
    assert.equal(instances[0].disconnectCalls, 1);
  } finally {
    global.ResizeObserver = previousResizeObserver;
    global.requestAnimationFrame = previousRequestAnimationFrame;
    global.cancelAnimationFrame = previousCancelAnimationFrame;
    global.window = previousWindow;
  }
});

test('renderer app dispose is safe when lazy surfaces were never initialized', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => { await app.dispose(); });
  await waitForUi(app.window, 20);
  app.window.document.getElementById('chatTopRailTab').click();
  await waitForUi(app.window, 20);
  app.window.document.getElementById('chatsPanelCollapseToggle').click();
  await waitForUi(app.window, 20);
  const portaledPeek = app.window.document.getElementById('chatsStripPeek');
  assert.ok(portaledPeek, 'the strip tooltip portal is mounted during shell setup');

  await app.dispose();
  assert.equal(portaledPeek.isConnected, false, 'dispose removes the portaled tooltip node');
  await app.dispose();
});

test('renderer rebootstrap clears and recreates Chats controller-owned DOM exactly once', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => { await app.dispose(); });
  const { window, shell } = app;
  const session = {
    id: 'dispose-rebootstrap-chat',
    title: 'Lifecycle chat',
    message_count: 1,
    last_message_preview: 'Lifecycle preview',
    updated_at: '2026-08-14T12:00:00.000Z',
    created_at: '2026-08-14T12:00:00.000Z',
    archived_at: null,
    pinned: false,
  };
  shell.__state.sessions = [session];
  await shell.__emitAuthState({ authenticated: true, user: { email: 'dev@example.com' } });
  await waitForUi(window, 40);
  assert.equal(window.document.querySelectorAll('.conversation-item[data-session-id="dispose-rebootstrap-chat"]').length, 1);

  await window.__disposeRenderer();
  assert.equal(window.document.querySelectorAll('#conversationGroups .conversation-group').length, 0);
  assert.equal(window.document.getElementById('chatsScopeSlot').childElementCount, 0);

  await app.reloadRendererApp();
  await waitForUi(window, 40);
  assert.equal(
    window.document.querySelectorAll('.conversation-item[data-session-id="dispose-rebootstrap-chat"]').length,
    1,
    'same-document rebootstrap owns one row rather than accumulating stale controller DOM'
  );
  assert.equal(window.document.querySelectorAll('#chatsScopeSlot [data-inv-segmented="chats-scope"]').length, 1);
});

test('renderer app close clears pending harness animation frame timers', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => {
    await app.dispose();
  });
  const originalSetTimeout = app.window.setTimeout;
  const originalClearTimeout = app.window.clearTimeout;
  let rafTimer = null;
  let rafTimerCleared = false;
  let frameRan = false;

  app.window.setTimeout = (callback, ms = 0, ...args) => {
    const id = originalSetTimeout(callback, ms, ...args);
    if (ms === HARNESS_RAF_FRAME_MS) {
      rafTimer = id;
    }
    return id;
  };
  app.window.clearTimeout = (id) => {
    if (id === rafTimer) {
      rafTimerCleared = true;
    }
    return originalClearTimeout(id);
  };

  app.window.requestAnimationFrame(() => {
    frameRan = true;
  });
  assert.ok(rafTimer, 'requestAnimationFrame is backed by a tracked harness timeout');

  await app.window.close();
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(rafTimerCleared, true, 'window close clears the RAF timeout handle');
  assert.equal(frameRan, false);
});

test('renderer app dispose is safe after lazy surfaces initialize once', async (t) => {
  const app = await loadRendererApp({
    artifactReviewPreferences: { enabled: true, collapsed: false, width: 420 },
  });
  // t.after (not just the trailing dispose() calls) is load-bearing: without it
  // any assertion/TypeError below leaves the JSDOM window undisposed, and its
  // live timers keep the event loop alive until the 120s per-file timeout
  // instead of failing fast.
  t.after(async () => { await app.dispose(); });
  const { window } = app;
  const doc = window.document;
  const input = doc.getElementById('chatInput');
  const sendButton = doc.getElementById('sendButton');

  doc.getElementById('homeTopRailTab').click();
  await waitForUi(window, 30);

  doc.getElementById('settingsTopRailTab').click();
  await waitForUi(window, 20);
  // Any lazy settings section works here; Personality is registry-declared
  // lazy: true. Assert before clicking so a future section retirement fails
  // with this message rather than a bare null-dereference.
  const lazySectionNavItem = doc.querySelector('.settings-nav-item[data-settings-section="personality"]');
  assert.ok(lazySectionNavItem, 'a lazy settings section nav item is rendered');
  lazySectionNavItem.click();
  await waitForUi(window, 30);
  // The point of the fixture: prove the lazy surface actually initialized,
  // so a later dispose is exercising a mounted section rather than a no-op.
  assert.equal(
    doc.querySelector('.settings-card[data-settings-section="personality"]')
      ?.classList.contains('settings-section-active'),
    true,
    'clicking the nav item initializes and activates the lazy settings section',
  );

  doc.getElementById('chatTopRailTab').click();
  await waitForUi(window, 20);
  dispatchPastedImage(window, input, 'dispose-artifact.png');
  await waitForUi(window, 20);
  input.value = 'Create an artifact before dispose';
  sendButton.click();
  await waitForUi(window, 90);

  navigateToArtifacts(doc);
  await waitForUi(window, 30);

  await app.dispose();
  await app.dispose();
});
