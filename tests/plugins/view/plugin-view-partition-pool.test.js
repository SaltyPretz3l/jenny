'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PluginViewController } = require('../../../services/main/plugin-view-controller');
const { STAGE7_LIMITS } = require('../../../services/plugins/view/stage7-budgets');
const { installPluginViewSessionPolicy } = require('../../../services/main/plugin-view-session-policy');
const { installPluginViewProtocol } = require('../../../services/main/plugin-view-protocol');

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const bounds = { x: 0, y: 0, width: 600, height: 400 };
const turn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function descriptor(digest = DIGEST, plugin = 'first') {
  return { publisher_id: 'acme', plugin_id: plugin, contribution_id: 'panel',
    artifact_digest: digest, commit_epoch: 3, generation_id: 'generation_3',
    content: { entry_path: 'view/index.html', allowed_bridge_operations: [], allowed_event_topics: [] } };
}

function harness(options = {}) {
  const views = [];
  const calls = [];
  const sessions = new Map();
  let clock = 0;
  class FakeView {
    constructor({ webPreferences }) {
      this.session = webPreferences.session;
      this.webContents = new EventEmitter();
      this.webContents.id = views.length + 1;
      this.webContents.closed = false;
      this.webContents.isDestroyed = () => this.webContents.closed;
      this.webContents.close = () => {
        if (options.close) return options.close(this.webContents);
        this.webContents.closed = true;
        this.webContents.emit('destroyed');
      };
      this.webContents.loadURL = () => options.load?.(this) || Promise.resolve();
      this.webContents.setWindowOpenHandler = () => {};
      views.push(this);
    }
    setVisible() {}
    setBounds() {}
  }
  const provider = {
    fromPartition(name, config) {
      calls.push(name);
      assert.deepEqual(config, { cache: false });
      assert.equal(name.startsWith('persist:'), false);
      if (sessions.has(name)) return sessions.get(name);
      const value = new EventEmitter();
      value.partition = name;
      value.clears = 0;
      value.handlers = new Map();
      for (const setter of ['setPermissionCheckHandler', 'setPermissionRequestHandler',
        'setDevicePermissionHandler', 'setDisplayMediaRequestHandler', 'setFileSystemAccessRequestHandler']) {
        value[setter] = (handler) => value.handlers.set(setter, handler);
      }
      value.webRequest = { onBeforeRequest: (handler) => { value.requestHandler = handler; } };
      value.protocol = {
        isProtocolHandled: async () => !!value.protocolHandler,
        unhandle: () => { value.protocolHandler = null; },
        handle: async (_scheme, handler) => {
          if (value.protocolHandler) throw new Error('handler already installed');
          await options.install?.(value);
          value.protocolHandler = handler;
        },
      };
      value.clearData = async () => {
        value.clears += 1;
        await options.clear?.(value);
      };
      value.clearStorageData = async () => {};
      value.clearCache = async () => {};
      value.closeAllConnections = async () => {};
      sessions.set(name, value);
      return value;
    },
  };
  const bytes = Buffer.from('<html>safe</html>');
  const createController = () => new PluginViewController({
    WebContentsView: FakeView, session: provider, now: () => clock,
    getMainWindow: () => ({ contentView: { addChildView() {}, removeChildView() {} },
      getContentBounds: () => ({ width: 800, height: 600 }) }),
    resolveAsset: () => ({ bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      mediaType: 'text/html' }),
  });
  const controller = createController();
  return { controller, createController, views, sessions, calls, setClock: (time) => { clock = time; } };
}

async function ready(controller) {
  assert.equal((await controller.commitGeneration({ commit_epoch: 3 })).ok, true);
}

const open = (controller, value = descriptor()) => controller.open(value, { bounds });
function cancelled(session, digest) {
  let result;
  session.requestHandler({ url: `jenny-plugin-view://${digest}/view/index.html` }, (value) => { result = value; });
  return result.cancel;
}

test('20 open/close cycles use at most four isolated oldest-free-first partitions', async () => {
  const { controller, calls } = harness();
  await ready(controller);
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await open(controller)).ok, true);
    await controller.destroyAll();
  }
  assert.ok(new Set(calls).size <= 4, 'historical partition count must stay at most 4');
  for (const name of calls) assert.match(name, /^plugin-view-pool-[0-3]$/);
  assert.equal(calls[4], calls[0], 'the longest-free partition is reused first');
});

test('a crash restart uses another free partition and remains inside the bounded pool', async () => {
  const { controller, calls, views } = harness();
  await ready(controller);
  await open(controller);
  views[0].webContents.emit('render-process-gone');
  await turn();
  assert.equal(views.length, 2);
  assert.notEqual(calls[0], calls[1]);
  for (let i = 0; i < 8; i += 1) await open(controller);
  assert.ok(new Set(calls).size <= 4, 'crash recovery must use the bounded pool');
  await controller.dispose();
});

test('failed clearing quarantines each partition permanently and refuses when exhausted', async () => {
  const { controller, createController, calls } = harness({ clear: () => { throw new Error('clear failed'); } });
  await ready(controller);
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await open(controller)).ok, true);
    await controller.destroyAll();
  }
  assert.deepEqual(await open(controller), { ok: false, reason: 'view_host_unavailable' });
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls).size, 4);
  const replacement = createController();
  await ready(replacement);
  assert.equal((await open(replacement)).reason, 'view_host_unavailable');
});

test('unconfirmed WebContents closure quarantines rather than recycling a partition', async () => {
  const { controller, calls } = harness({ close: () => {} });
  await ready(controller);
  for (let i = 0; i < 4; i += 1) {
    await open(controller);
    await controller.destroyAll();
  }
  assert.equal((await open(controller)).reason, 'view_host_unavailable');
  assert.equal(calls.length, 4);
});

test('already destroyed WebContents can retire without calling closed native methods', async () => {
  const { controller, views, calls } = harness({ close: () => { throw new Error('object destroyed'); } });
  await ready(controller);
  for (let i = 0; i < 20; i += 1) {
    assert.equal((await open(controller)).ok, true, 'confirmed destruction must not exhaust the pool');
    const contents = views.at(-1).webContents;
    contents.closed = true;
    contents.destroy = () => { throw new Error('object destroyed'); };
    await controller.destroyAll();
  }
  assert.ok(new Set(calls).size <= 4);
});

test('cleanup timeout quarantines even if clearing completes later', async () => {
  const pending = deferred();
  const { controller, calls } = harness({ clear: (session) => session.partition === calls[0] ? pending.promise : undefined });
  await ready(controller);
  await open(controller);
  await controller.destroyAll();
  pending.resolve();
  for (let i = 0; i < 12; i += 1) await open(controller);
  assert.equal(calls.filter((name) => name === calls[0]).length, 1,
    'a timed-out partition must never be checked out again');
  assert.ok(new Set(calls).size <= 4, 'cleanup timeout must not mint replacement partitions');
  await controller.dispose();
});

test('repeated policy installation keeps one download listener and replaces the digest filter', () => {
  const value = new EventEmitter();
  value.webRequest = { onBeforeRequest: (handler) => { value.requestHandler = handler; } };
  for (let i = 0; i < 20; i += 1) installPluginViewSessionPolicy(value, DIGEST);
  installPluginViewSessionPolicy(value, OTHER_DIGEST);
  assert.equal(value.listenerCount('will-download'), 1, 'download listener count must stay constant');
  assert.equal(cancelled(value, DIGEST), true);
  assert.equal(cancelled(value, OTHER_DIGEST), false);
});

test('reinstalling the protocol replaces the previous digest resolver', async () => {
  const { controller, sessions } = harness();
  await ready(controller);
  await open(controller);
  const value = sessions.values().next().value;
  await installPluginViewProtocol(value, { resolveAsset: () => null });
  assert.equal((await value.protocolHandler({ url: `jenny-plugin-view://${DIGEST}/view/index.html` })).status,
    404, 'reinstallation must replace the previous asset resolver');
  await controller.dispose();
});

test('reuse replaces digest policy and protocol without accumulating session handlers', async () => {
  const { controller, views } = harness();
  await ready(controller);
  await open(controller);
  const first = views[0].session;
  for (let i = 0; i < 3; i += 1) await open(controller);
  await open(controller, descriptor(OTHER_DIGEST, 'second'));
  assert.equal(views.at(-1).session, first, 'the oldest-free session should be reused');
  assert.equal(cancelled(first, DIGEST), true);
  assert.equal(cancelled(first, OTHER_DIGEST), false);
  assert.equal((await first.protocolHandler({ url: `jenny-plugin-view://${DIGEST}/view/index.html` })).status, 404);
  assert.equal((await first.protocolHandler({ url: `jenny-plugin-view://${OTHER_DIGEST}/view/index.html` })).status, 200);
  assert.equal(first.listenerCount('will-download'), 1);
  assert.equal(first.eventNames().length, 1);
  assert.equal(first.handlers.size, 5);
  assert.equal(first.handlers.get('setPermissionCheckHandler')(), false);
  let denied = 0;
  first.emit('will-download', { preventDefault: () => { denied += 1; } });
  assert.equal(denied, 1);
  await controller.dispose();
});

test('stale load completion cannot clear or release a session now owned by a newer view', async () => {
  const pending = deferred();
  const { controller, views } = harness({ load: (view) => views.indexOf(view) === 0 ? pending.promise : undefined });
  await ready(controller);
  const opening = open(controller);
  await turn();
  const first = views[0].session;
  for (let i = 0; i < 4; i += 1) await open(controller, descriptor(OTHER_DIGEST));
  assert.equal(views.at(-1).session, first);
  const clearCount = first.clears;
  pending.resolve();
  assert.equal((await opening).reason, 'view_lifecycle_superseded');
  assert.equal(first.clears, clearCount, 'stale discard must not clear the newer session owner');
  assert.equal(controller.active.view, views.at(-1));
  assert.equal(cancelled(first, OTHER_DIGEST), false);
  await controller.dispose();
});

test('a free partition is not handed out while its prior clearing is in flight', async () => {
  const pending = deferred();
  const { controller, createController, calls } = harness({ clear: () => pending.promise });
  await ready(controller);
  await open(controller);
  const closing = controller.destroyAll();
  await turn();
  const other = createController();
  await ready(other);
  await open(other);
  assert.notEqual(calls[0], calls[1]);
  pending.resolve();
  await closing;
  await other.dispose();
});

test('crash bookkeeping expires all old identities on crash and teardown', async () => {
  const { controller, views, setClock } = harness();
  await ready(controller);
  await open(controller);
  controller.crashes.set('acme/expired', [0]);
  controller.crashes.set('acme/mixed', [0, STAGE7_LIMITS.crash_window_ms]);
  setClock(STAGE7_LIMITS.crash_window_ms + 1);
  views[0].webContents.emit('render-process-gone');
  await turn();
  assert.equal(controller.crashes.has('acme/expired'), false, 'expired crash identities must be deleted');
  assert.deepEqual(controller.crashes.get('acme/mixed'), [STAGE7_LIMITS.crash_window_ms]);
  assert.equal(controller.crashes.get('acme/first').length, 1);
  setClock(2 * STAGE7_LIMITS.crash_window_ms + 2);
  await controller.destroyAll();
  assert.equal(controller.crashes.size, 0);
});

test('committing a generation keeps live recovery windows and drops uninstalled plugins', async () => {
  const { controller } = harness();
  await ready(controller);
  controller.crashes.set('acme/removed', [0]);
  controller.crashes.set('acme/kept', [0]);
  await controller.commitGeneration({ commit_epoch: 4,
    descriptors: new Map([['acme/kept/view', { publisher_id: 'acme', plugin_id: 'kept' }]]) });
  assert.deepEqual([...controller.crashes.keys()], ['acme/kept']);
});

test('a synchronous attach failure retires the lease instead of leaking the partition', async () => {
  const { controller, calls } = harness();
  await ready(controller);
  const attach = controller.getMainWindow;
  controller.getMainWindow = () => ({ ...attach(), contentView: {
    addChildView() { throw new Error('attach failed'); }, removeChildView() {} } });
  assert.deepEqual(await open(controller), { ok: false, reason: 'view_create_failed' });
  const failed = calls[0];
  controller.getMainWindow = attach;
  for (let i = 0; i < 4; i += 1) {
    assert.equal((await open(controller)).ok, true);
    await controller.destroyAll();
  }
  assert.ok(calls.slice(1).includes(failed), 'the failed partition must return to the pool');
});
