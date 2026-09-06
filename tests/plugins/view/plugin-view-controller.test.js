'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PluginViewController } = require('../../../services/main/plugin-view-controller');

const DIGEST = 'a'.repeat(64);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(load = Promise.resolve(), options = {}) {
  const views = [];
  const sessions = [];
  const intervalCallbacks = [];
  class FakeWebContents extends EventEmitter {
    constructor() {
      super(); this.id = 42 + views.length; this.closed = false;
      if (options.memoryInfo) this.getProcessMemoryInfo = async () => options.memoryInfo();
    }
    loadURL(url) { this.url = url; return load; }
    setWindowOpenHandler(handler) { this.windowHandler = handler; }
    setZoomFactor(value) { this.zoom = value; }
    close() { this.closed = true; }
    isDestroyed() { return this.closed; }
    send() {}
    focus() {}
  }
  class FakeView {
    constructor(options) { this.options = options; this.webContents = new FakeWebContents(); this.visible = []; views.push(this); }
    setVisible(value) { this.visible.push(value); }
    setBounds(value) { this.bounds = value; }
  }
  const session = {
    fromPartition(partition, options) {
      const value = {
        partition, options,
        protocol: { handle: async (_scheme, handler) => { value.protocolHandler = handler; }, isProtocolHandled: async () => false },
        webRequest: { onBeforeRequest(handler) { value.requestHandler = handler; } },
        on() {}, clearData: async () => {}, clearStorageData: async () => {}, clearCache: async () => {},
        closeAllConnections: async () => {},
      };
      sessions.push(value);
      return value;
    },
  };
  const children = [];
  const hostCommands = [];
  const mainWindow = {
    contentView: {
      addChildView(view) { children.push(view); },
      removeChildView(view) { const index = children.indexOf(view); if (index >= 0) children.splice(index, 1); },
    },
    getContentBounds: () => ({ width: 900, height: 700 }),
    isDestroyed: () => false,
    webContents: { send: (...args) => hostCommands.push(args), focus() {} },
  };
  const controller = new PluginViewController({
    WebContentsView: FakeView, session, preloadPath: 'fixed-preload.js', getMainWindow: () => mainWindow,
    onQuarantine: options.onQuarantine, log: options.log,
    setIntervalFn: (callback) => { intervalCallbacks.push(callback); return { unref() {} }; },
    clearIntervalFn: () => {},
  });
  return { controller, views, sessions, children, intervalCallbacks, hostCommands };
}

function descriptor(epoch = 3) {
  return {
    publisher_id: 'acme', plugin_id: 'safe', contribution_id: 'panel', artifact_digest: DIGEST,
    commit_epoch: epoch, generation_id: 'generation_1', content: {
      entry_path: 'view/index.html', allowed_bridge_operations: ['get_context'], allowed_event_topics: [],
    },
  };
}

test('a view uses an ephemeral sandboxed partition and remains hidden until trusted bounds exist', async () => {
  const { controller, views, sessions } = harness();
  await controller.commitGeneration({ commit_epoch: 3, assets: new Map(), descriptors: new Map() });
  const missingBounds = await controller.open(descriptor());
  assert.equal(missingBounds.reason, 'view_bounds_required');
  const result = await controller.open(descriptor(), { bounds: { x: 10, y: 100, width: 800, height: 550 } });
  assert.equal(result.ok, true);
  const view = views.at(-1);
  assert.equal(view.options.webPreferences.sandbox, true);
  assert.equal(view.options.webPreferences.contextIsolation, true);
  assert.equal(view.options.webPreferences.nodeIntegration, false);
  assert.match(sessions.at(-1).partition, /^plugin-view-view_[a-f0-9]{24}$/);
  assert.deepEqual(view.visible, [false, true]);
  assert.deepEqual(view.bounds, { x: 10, y: 100, width: 800, height: 550 });
});

test('a superseded generation cannot become visible after an awaited load finishes', async () => {
  const pending = deferred();
  const { controller, views } = harness(pending.promise);
  await controller.commitGeneration({ commit_epoch: 3, assets: new Map(), descriptors: new Map() });
  const opening = controller.open(descriptor(), { bounds: { x: 0, y: 80, width: 700, height: 500 } });
  await new Promise((resolve) => setImmediate(resolve));
  await controller.commitGeneration({ commit_epoch: 4, assets: new Map(), descriptors: new Map() });
  pending.resolve();
  const result = await opening;
  assert.equal(result.reason, 'view_lifecycle_superseded');
  assert.deepEqual(views[0].visible, [false, false]);
});

test('zoom clamps to the frozen range and teardown detaches bridge state', async () => {
  const { controller } = harness();
  const destroyed = [];
  controller.setOnViewDestroyed((id) => destroyed.push(id));
  await controller.commitGeneration({ commit_epoch: 3, assets: new Map(), descriptors: new Map() });
  const opened = await controller.open(descriptor(), { bounds: { x: 0, y: 80, width: 700, height: 500 } });
  assert.equal(controller.setZoom(99).zoom_factor, 2);
  assert.equal(controller.setZoom(0).zoom_factor, 0.5);
  await controller.destroyAll('test');
  assert.deepEqual(destroyed, [opened.view_instance_id]);
});

test('failed session teardown is retained and retried after the view is detached', async () => {
  const { controller } = harness();
  let attempts = 0;
  controller.setOnViewDestroyed((_id, _reason, context) => {
    attempts += 1;
    assert.equal(context.sessionId, 'plugin-session');
    return attempts === 1 ? { ok: false, reason: 'tree_death_unproven' } : { ok: true };
  });
  await controller.commitGeneration({ commit_epoch: 3, assets: new Map(), descriptors: new Map() });
  await controller.open(descriptor(), {
    bounds: { x: 0, y: 80, width: 700, height: 500 },
    sessionId: 'plugin-session',
    sessionIncarnation: 'incarnation-1',
  });

  assert.equal((await controller.destroyAll('session_left')).reason, 'tree_death_unproven');
  assert.equal(controller.active, null);
  assert.equal((await controller.destroyAll('session_left')).ok, true);
  assert.equal(attempts, 2);
});

test('trusted host commands are scoped to the expected live view instance', async () => {
  const { controller, hostCommands } = harness();
  await controller.commitGeneration({ commit_epoch: 3, assets: new Map(), descriptors: new Map() });
  const opened = await controller.open(descriptor(), { bounds: { x: 0, y: 80, width: 700, height: 500 } });
  assert.equal(controller.sendHostCommand('provider_activated', { provider_id: 'chatgpt' },
    'stale-view'), false);
  assert.equal(controller.sendHostCommand('provider_activated', { provider_id: 'chatgpt' },
    opened.view_instance_id), true);
  assert.equal(hostCommands.length, 1);
  assert.deepEqual(hostCommands[0][1], { command: 'provider_activated', provider_id: 'chatgpt' });
});

test('malformed renderer bounds and zoom fail closed without reaching Electron', async () => {
  const { controller, views } = harness();
  await controller.commitGeneration({ commit_epoch: 3, assets: new Map(), descriptors: new Map() });
  await controller.open(descriptor(), { bounds: { x: 0, y: 80, width: 700, height: 500 } });
  const originalBounds = views.at(-1).bounds;
  assert.equal(controller.setBounds({ x: 'bad', y: 0, width: 10, height: 10 }).reason,
    'view_bounds_invalid');
  assert.deepEqual(views.at(-1).bounds, originalBounds);
  assert.equal(controller.setZoom(Number.NaN).reason, 'view_zoom_invalid');
  assert.equal(views.at(-1).webContents.zoom, undefined);
});

test('the first two renderer crashes restart in fresh partitions and the third quarantines', async () => {
  const quarantines = [];
  const { controller, views, sessions } = harness(Promise.resolve(), {
    onQuarantine: (value) => quarantines.push(value),
  });
  await controller.commitGeneration({ commit_epoch: 3, assets: new Map(), descriptors: new Map() });
  await controller.open(descriptor(), {
    bounds: { x: 0, y: 80, width: 700, height: 500 },
    sessionId: 'plugin-session',
    sessionIncarnation: 'incarnation-1',
  });
  views[0].webContents.emit('render-process-gone');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(views.length, 2);
  assert.notEqual(sessions[0].partition, sessions[1].partition);
  assert.equal(controller.contextForEvent({ sender: views[1].webContents }).sessionId, 'plugin-session');
  views[1].webContents.emit('render-process-gone');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(views.length, 3);
  views[2].webContents.emit('render-process-gone');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(views.length, 3);
  assert.equal(quarantines.at(-1).reason, 'view_crash_circuit_open');
  assert.equal(controller.active, null);
});

test('memory warning and hard limits are enforced against renderer private memory', async () => {
  let privateKb = 200 * 1024;
  const logs = [];
  const quarantines = [];
  const { controller, intervalCallbacks } = harness(Promise.resolve(), {
    memoryInfo: () => ({ private: privateKb }),
    log: (event, data) => logs.push([event, data]),
    onQuarantine: (value) => quarantines.push(value),
  });
  await controller.commitGeneration({ commit_epoch: 3, assets: new Map(), descriptors: new Map() });
  await controller.open(descriptor(), { bounds: { x: 0, y: 80, width: 700, height: 500 } });
  intervalCallbacks.at(-1)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(logs.filter(([event]) => event === 'plugin.view.memory_warning').length, 1);
  privateKb = 300 * 1024;
  intervalCallbacks.at(-1)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quarantines.at(-1).reason, 'view_memory_hard_limit');
  assert.equal(controller.active, null);
});
