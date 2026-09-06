'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { startManagedSidecarChatStream } = require('../services/backend/managed-sidecar-chat');
const {
  MAX_TRACKED_WORKSPACES,
  STORE_KEY,
  WorkspaceActiveUseTracker,
  createTrackerForService,
} = require('../services/workspace-active-use-tracker');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('./helpers/managed-sidecar-chat-lifecycle-helpers');

class MemoryStore {
  constructor(initial = {}) {
    this.value = structuredClone(initial);
    this.writes = [];
  }

  read() {
    return structuredClone(this.value);
  }

  write(value) {
    this.value = structuredClone(value);
    this.writes.push(structuredClone(value));
  }
}

class FakeWindow extends EventEmitter {
  constructor() {
    super();
    this.visible = true;
    this.focused = true;
    this.destroyed = false;
  }

  isVisible() { return this.visible; }
  isFocused() { return this.focused; }
  isDestroyed() { return this.destroyed; }

  setVisible(value) {
    this.visible = value;
    this.emit(value ? 'show' : 'hide');
  }

  setFocused(value) {
    this.focused = value;
    this.emit(value ? 'focus' : 'blur');
  }
}

function createHarness({ root = 'G:\\workspace', initialStore = {} } = {}) {
  const store = new MemoryStore(initialStore);
  const backend = new EventEmitter();
  const config = new EventEmitter();
  const app = new EventEmitter();
  const windowRef = new FakeWindow();
  const state = { root, backendPhase: 'starting', nowMs: 0 };
  const intervals = [];
  const tracker = new WorkspaceActiveUseTracker({
    store,
    getWorkspaceRoot: () => state.root,
    getBackendStatus: () => ({ phase: state.backendPhase }),
    getWindow: () => windowRef,
    backendEvents: backend,
    configEvents: config,
    appEvents: app,
    now: () => state.nowMs,
    setIntervalImpl: (callback) => {
      const handle = { callback, unref() {} };
      intervals.push(handle);
      return handle;
    },
    clearIntervalImpl: () => {},
  }).start();
  return { app, backend, config, intervals, state, store, tracker, windowRef };
}

for (const missingWindow of [undefined, null]) {
  test(`tracker tolerates ${String(missingWindow)} before window creation and after close`, () => {
    const app = new EventEmitter();
    let windowRef = missingWindow;
    let nowMs = 0;
    const tracker = new WorkspaceActiveUseTracker({
      store: new MemoryStore(),
      getWorkspaceRoot: () => 'G:\\workspace',
      getBackendStatus: () => ({ phase: 'ready' }),
      getWindow: () => windowRef,
      appEvents: app,
      now: () => nowMs,
      setIntervalImpl: () => ({ unref() {} }),
      clearIntervalImpl: () => {},
    });
    try {
      tracker.start();
      nowMs = 5_000;
      assert.deepEqual(tracker.requestFields(), { workspace_active_use_seconds: 0 });
      assert.equal(tracker.flush(), false);

      windowRef = new FakeWindow();
      app.emit('browser-window-created', {}, windowRef);
      nowMs = 8_000;
      assert.deepEqual(tracker.requestFields(), { workspace_active_use_seconds: 3 });

      const closedWindow = windowRef;
      windowRef = missingWindow;
      closedWindow.destroyed = true;
      closedWindow.emit('closed');
      nowMs = 12_000;
      assert.deepEqual(tracker.requestFields(), { workspace_active_use_seconds: 3 });
    } finally {
      tracker.dispose();
    }
    assert.equal(app.listenerCount('browser-window-created'), 0);
  });
}

test('seconds accrue only while mounted, backend-ready, visible, and focused', () => {
  const harness = createHarness();
  const { backend, config, state, tracker, windowRef } = harness;

  state.nowMs = 5_000;
  assert.deepEqual(tracker.requestFields(), { workspace_active_use_seconds: 0 });

  backend.emit('backend-status', { phase: 'ready' });
  state.backendPhase = 'ready';
  state.nowMs = 15_000;
  assert.deepEqual(tracker.requestFields(), { workspace_active_use_seconds: 10 });

  windowRef.setFocused(false);
  state.nowMs = 75_000;
  assert.deepEqual(tracker.requestFields(), { workspace_active_use_seconds: 10 });

  windowRef.setFocused(true);
  state.nowMs = 80_000;
  windowRef.setVisible(false);
  state.nowMs = 120_000;
  assert.deepEqual(tracker.requestFields(), { workspace_active_use_seconds: 15 });

  windowRef.setVisible(true);
  windowRef.setFocused(false);
  state.nowMs = 140_000;
  assert.deepEqual(tracker.requestFields(), { workspace_active_use_seconds: 15 });

  windowRef.setFocused(true);
  state.nowMs = 145_000;
  state.root = '';
  config.emit('changed', {}, { reason: 'workspace_root_cleared' });
  state.nowMs = 200_000;
  assert.deepEqual(tracker.requestFields(), {});
  tracker.dispose();
});

test('counter flushes on visibility, interval, and quit and survives a store round-trip', () => {
  const first = createHarness();
  first.state.backendPhase = 'ready';
  first.backend.emit('backend-status', { phase: 'ready' });
  first.state.nowMs = 12_750;
  first.windowRef.setFocused(false);
  assert.equal(first.store.writes.at(-1)[STORE_KEY][Object.keys(first.store.writes.at(-1)[STORE_KEY])[0]], 12);

  first.intervals[0].callback();
  first.app.emit('before-quit');
  assert.equal(first.store.writes.length, 1);
  const persisted = first.store.read();
  first.tracker.dispose();

  const second = createHarness({ initialStore: persisted });
  assert.deepEqual(second.tracker.requestFields(), { workspace_active_use_seconds: 12 });
  second.tracker.dispose();
});

test('persisted counters are bounded to one integer per workspace', () => {
  const stored = {};
  for (let index = 0; index < MAX_TRACKED_WORKSPACES + 5; index += 1) {
    stored[`root_${index.toString(16).padStart(24, '0')}`] = index;
  }
  stored.invalid = 'not-a-counter';
  const harness = createHarness({ initialStore: { untouched: true, [STORE_KEY]: stored } });

  harness.state.backendPhase = 'ready';
  harness.backend.emit('backend-status', { phase: 'ready' });
  harness.state.nowMs = 1_000;
  harness.tracker.flush();

  const output = harness.store.read();
  assert.equal(Object.keys(output[STORE_KEY]).length, MAX_TRACKED_WORKSPACES);
  assert.equal(Object.values(output[STORE_KEY]).every(Number.isSafeInteger), true);
  assert.equal(output.untouched, true, 'tracker preserves unrelated shell-config fields');
  harness.tracker.dispose();
});

test('active-use counters use a store separate from unrelated config writes', () => {
  const trackerStore = new MemoryStore();
  const configStore = new MemoryStore({ theme: 'dark' });
  const configService = new EventEmitter();
  configService.store = configStore;
  configService.getToolsWorkspaceRoot = () => 'G:\\workspace';
  configService.getState = () => ({ toolsWorkspaceRoot: 'G:\\workspace' });
  const service = new EventEmitter();
  service.configService = configService;
  service.getBackendStatus = () => ({ phase: 'ready' });
  const app = new EventEmitter();
  const windowRef = new FakeWindow();
  let nowMs = 0;
  const tracker = createTrackerForService(service, {
    app,
    store: trackerStore,
    getWindow: () => windowRef,
    now: () => nowMs,
    setIntervalImpl: () => ({ unref() {} }),
    clearIntervalImpl: () => {},
  });
  nowMs = 1_000;
  assert.equal(tracker.flush(), true);
  const persisted = trackerStore.read();

  configStore.write({ theme: 'light' });
  configService.emit('changed', { theme: 'light' }, { reason: 'theme_updated' });

  assert.deepEqual(trackerStore.read(), persisted);
  assert.deepEqual(configStore.read(), { theme: 'light' });
  tracker.dispose();
});

test('flush performs no write when no active-use milliseconds accrued', () => {
  const harness = createHarness();
  harness.state.backendPhase = 'ready';
  harness.backend.emit('backend-status', { phase: 'ready' });
  harness.state.nowMs = 1_000;

  assert.equal(harness.tracker.flush(), true);
  assert.equal(harness.store.writes.length, 1);
  assert.equal(harness.tracker.flush(), false);
  assert.equal(harness.store.writes.length, 1);
  harness.tracker.dispose();
});

test('an eight-hour clock jump accrues at most two flush intervals', () => {
  const harness = createHarness();
  harness.state.backendPhase = 'ready';
  harness.backend.emit('backend-status', { phase: 'ready' });
  harness.state.nowMs = 8 * 60 * 60 * 1_000;

  assert.deepEqual(harness.tracker.requestFields(), { workspace_active_use_seconds: 120 });
  harness.tracker.dispose();
});

test('a secondary BrowserWindow does not replace the tracked main window', () => {
  const harness = createHarness();
  harness.state.backendPhase = 'ready';
  harness.backend.emit('backend-status', { phase: 'ready' });
  const secondary = new FakeWindow();
  secondary.focused = false;

  harness.app.emit('browser-window-created', {}, secondary);
  harness.state.nowMs = 10_000;

  assert.equal(harness.tracker.windowRef, harness.windowRef);
  assert.deepEqual(harness.tracker.requestFields(), { workspace_active_use_seconds: 10 });
  harness.tracker.dispose();
});

async function captureChatSend(activeUseFields) {
  const service = createManagedChatServiceStub({
    configState: { toolsWorkspaceRoot: 'G:\\workspace' },
  });
  service.workspaceActiveUseTracker = { requestFields: () => activeUseFields };
  let captured = null;
  service.sidecarClient = {
    async chatSend(params, options) {
      captured = params;
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest());
  await service.activeStreams.get(stream.streamId)._pendingPromise;
  return captured;
}

test('chat.send carries a known active-use value and omits an unknown value', async () => {
  const known = await captureChatSend({ workspace_active_use_seconds: 37 });
  const unknown = await captureChatSend({});

  assert.equal(known.workspace_active_use_seconds, 37);
  assert.equal(Object.hasOwn(unknown, 'workspace_active_use_seconds'), false);
});
