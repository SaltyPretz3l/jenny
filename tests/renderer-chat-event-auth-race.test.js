'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const asyncFence = require('../renderer/shared/async-fence');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createMapState() {
  return {
    auth: { authenticated: false },
    backendReadyLoadHandled: false,
    sessions: [],
    currentSessionId: '',
    messagesBySession: new Map(),
    turnEventsBySession: new Map(),
    sessionMessageAccessOrder: new Map(),
    pendingStreams: new Map(),
    streamThinkingStatusByStream: new Map(),
    toolCallsByStream: new Map(),
    pendingToolApprovals: new Map(),
    queuedSendBySession: new Map(),
    sendOutboxBySession: new Map(),
    interactiveDraftsBySession: new Map(),
    ui: {
      activeView: 'chat',
      chatSendLifecycleBySession: new Map(),
      chatSendFailuresBySession: new Map(),
      interactiveRecapExpandedBySession: new Map(),
    },
    memoryManager: {
      memories: [], draftsById: new Map(), pendingActionById: new Map(),
    },
  };
}

function buildHarness(t) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const listeners = {};
  const noopSubscription = () => () => {};
  dom.window.jennyShell = {
    system: { onStats: noopSubscription },
    diagnostics: { logs: { onEntry: noopSubscription } },
    backend: { onStatus(listener) { listeners.backend = listener; return () => {}; } },
    auth: {
      getState: async () => ({ authenticated: true }),
      onState(listener) { listeners.auth = listener; return () => {}; },
    },
  };
  const bindingStub = {
    createTranscriptEventBindings: () => ({ bindTranscriptEvents() {}, dispose() {} }),
    createSettingsEventBindings: () => ({ bindSettingsEvents() {} }),
    bindComposerContextMenu() {},
    bindInteractiveComposerEvents() {},
  };
  const context = {
    console,
    AbortController: dom.window.AbortController,
    document: dom.window.document,
    window: dom.window,
    rendererAsyncFence: asyncFence,
    rendererChatEventTranscriptBindings: bindingStub,
    rendererChatEventSettingsBindings: bindingStub,
    rendererChatEventInteractiveBindings: bindingStub,
    rendererChatBackendRecoveryUtils: { recoverInflightSendsForUnusableBackend() {} },
    rendererWindowControlsUtils: { bindWindowControlEvents() {} },
    rendererRenderPipelineThreadStateUtils: { clearThreadBranchCollapseState() {} },
    rendererEnterKeydownUtils: require('../renderer/chat/renderer-enter-keydown-utils'),
  };
  context.globalThis = context;
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'renderer/chat/renderer-chat-event-utils.js'),
    'utf8'
  );
  vm.runInNewContext(source, context, { filename: 'renderer-chat-event-utils.js' });

  const load = deferred();
  const calls = { snapshots: 0, memories: 0, renders: 0 };
  const element = dom.window.document.createElement('div');
  const callbackDefaults = new Proxy({
    setActivityChangeListener() {},
    loadSessions: () => load.promise,
    refreshSnapshots: async () => { calls.snapshots += 1; },
    refreshApprovedMemories: async () => { calls.memories += 1; },
    renderAll: () => { calls.renders += 1; },
  }, {
    get(target, property) {
      if (property in target) return target[property];
      return () => {};
    },
  });
  const state = createMapState();
  const controller = context.rendererChatEventUtils.createChatEventBindings({
    state,
    constants: {
      TOAST_SOURCE: { memory: 'memory', chatStream: 'chat' },
      ACTIVITY_SCOPE: {},
    },
    dom: new Proxy({}, { get: () => element }),
    callbacks: callbackDefaults,
    controllers: {
      thinkingController: { prune() {}, resumeAutoScroll() {} },
      toastActionHandlers: new Map(),
      timelineVirtualizer: null,
      chatScrollCoordinator: { attach: () => () => {} },
      messageEditController: null,
      messageBranchController: null,
      selectionController: null,
      bulkActionsController: null,
      unreadOrientationController: null,
    },
  });
  controller.bind();
  t.after(() => controller.dispose());
  return { calls, controller, listeners, load, state };
}

test('a later logout invalidates an older authenticated refresh', async (t) => {
  const harness = buildHarness(t);
  const loginRefresh = harness.listeners.auth({ authenticated: true });
  await Promise.resolve();

  await harness.listeners.auth({ authenticated: false });
  assert.equal(harness.calls.renders, 1, 'logout renders the cleared state once');
  harness.load.resolve();
  await loginRefresh;

  assert.equal(harness.calls.snapshots, 0);
  assert.equal(harness.calls.memories, 0);
  assert.equal(harness.calls.renders, 1);
  assert.equal(harness.state.auth.authenticated, false);
});

test('dispose invalidates an authenticated refresh that is still awaiting sessions', async (t) => {
  const harness = buildHarness(t);
  const loginRefresh = harness.listeners.auth({ authenticated: true });
  await Promise.resolve();

  harness.controller.dispose();
  harness.load.resolve();
  await loginRefresh;

  assert.equal(harness.calls.snapshots, 0);
  assert.equal(harness.calls.memories, 0);
  assert.equal(harness.calls.renders, 0);
});
