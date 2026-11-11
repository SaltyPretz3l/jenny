'use strict';

/* changePictures.* IPC registration, the working-tree loader behind it, and
 * the lazy desktop composition: the trusted-sender gate, raw payloads reaching
 * the service, the failure envelope, and which backend seams the composed
 * service reads. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  STORE_FOLDER,
  createLazyChangePicturesService,
  registerChangePicturesIpc,
} = require('../services/main/change-pictures-ipc-registration');
const { createWorkingTreeLoader, workingTreeFiles } = require('../services/change-pictures/working-tree');
const { JENNY_SHELL_BRIDGE_DESCRIPTORS, listBridgeMethodPaths } = require('../services/ipc-contract');
const { KNOWN_USER_DATA_CHILDREN } = require('../services/data-lifecycle/cleanup-service');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const CHANNELS = {
  capture: 'change-pictures:capture',
  captureWorkingTree: 'change-pictures:capture-working-tree',
  list: 'change-pictures:list',
};

function register({ allow = true, service, getService } = {}) {
  const handlers = new Map();
  registerChangePicturesIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    authorization: { authorize: () => allow },
    getService: getService || (() => service),
  });
  return { handlers, invoke: (channel, payload) => handlers.get(channel)({ sender: {} }, payload) };
}

test('exactly the three descriptor-backed invoke channels are registered', () => {
  const { handlers } = register({ service: {} });
  assert.deepEqual([...handlers.keys()].sort(), Object.values(CHANNELS).sort());
  for (const [method, channel] of Object.entries(CHANNELS)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[`changePictures.${method}`], { kind: 'invoke', channel });
  }
  assert.deepEqual(
    listBridgeMethodPaths().filter((methodPath) => methodPath.startsWith('changePictures.')).sort(),
    Object.keys(CHANNELS).map((method) => `changePictures.${method}`).sort()
  );
});

test('an untrusted sender reaches no service method', async () => {
  const calls = [];
  const service = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, args]); return { ok: true }; } });
  const denied = register({ allow: false, service });
  for (const channel of Object.values(CHANNELS)) {
    assert.equal((await denied.invoke(channel, { sessionId: 's' })).ok, false);
  }
  assert.equal(calls.length, 0);
});

test('payloads reach the service raw and its answer returns unchanged', async () => {
  const calls = [];
  const service = {
    async capture(raw) { calls.push(['capture', raw]); return { ok: true, enabled: true, record: null }; },
    async captureWorkingTree(raw) { calls.push(['captureWorkingTree', raw]); return { ok: true, enabled: true, record: null }; },
    async list(raw) { calls.push(['list', raw]); return { ok: true, enabled: true, records: [] }; },
  };
  const { invoke } = register({ service });
  const hostile = { sessionId: 's', turnId: 't', files: [{ path: '../../x' }], ref: 'HEAD~3' };
  assert.deepEqual(await invoke(CHANNELS.capture, hostile), { ok: true, enabled: true, record: null });
  await invoke(CHANNELS.captureWorkingTree, hostile);
  await invoke(CHANNELS.list, hostile);
  assert.deepEqual(calls, [['capture', hostile], ['captureWorkingTree', hostile], ['list', hostile]]);
});

test('a missing service or a throw answers the failure envelope with no exception text', async () => {
  const unavailable = { ok: false, reason: 'unavailable' };
  assert.deepEqual(await register({ service: null }).invoke(CHANNELS.capture, {}), unavailable);
  const throwing = register({ service: { async list() { throw new Error('C:\\Users\\someone\\secret'); } } });
  assert.deepEqual(await throwing.invoke(CHANNELS.list, {}), unavailable);
  const broken = register({ getService: () => { throw new Error('boom'); } });
  assert.deepEqual(await broken.invoke(CHANNELS.capture, {}), unavailable);
});

test('the store folder is a known child of the app data folder', () => {
  assert.equal(STORE_FOLDER, 'change-pictures');
  assert.ok(KNOWN_USER_DATA_CHILDREN.includes(STORE_FOLDER));
});

function makeBackend(root, overrides = {}) {
  return {
    hostMode: 'desktop',
    featureFlags: {},
    projectAuthority: { captureSession: (sessionId) => (sessionId === 'bound' ? { root_path: root } : null) },
    resolveProjectWorkspaceServices: () => null,
    ...overrides,
  };
}

function compose(backendService, parts = {}) {
  const userData = createTrackedTempDir('jenny-change-pictures-ipc-');
  return createLazyChangePicturesService({
    app: { getPath: (name) => (name === 'userData' ? userData : '') },
    backendService,
    browserSessionService: { open: async () => { throw new Error('not expected'); } },
    snapshotStore: { read: async () => ({ found: false }) },
    log: () => {},
    ...parts,
  });
}

test('the service is composed once, and only when its owners exist', () => {
  const root = fs.realpathSync(createTrackedTempDir('jenny-change-pictures-root-'));
  assert.equal(compose(makeBackend(root), { browserSessionService: null })(), null);
  assert.equal(compose(makeBackend(root), { snapshotStore: null })(), null);
  assert.equal(compose({ featureFlags: {} })(), null);
  const getService = compose(makeBackend(root));
  assert.equal(typeof getService().capture, 'function');
  assert.equal(getService(), getService());
});

test('the flag and the hosted host both switch the composed service off', async () => {
  const root = fs.realpathSync(createTrackedTempDir('jenny-change-pictures-root-'));
  const off = { ok: true, enabled: false, records: [] };
  const flagged = compose(makeBackend(root, { featureFlags: { change_pictures: false } }))();
  assert.deepEqual(await flagged.list({ sessionId: 'bound' }), off);
  const hosted = compose(makeBackend(root, { hostMode: 'server' }))();
  assert.deepEqual(await hosted.list({ sessionId: 'bound' }), off);
  const on = compose(makeBackend(root))();
  assert.deepEqual(await on.list({ sessionId: 'bound' }), { ok: true, enabled: true, records: [] });
  // A chat with no folder has nothing to picture.
  assert.deepEqual(await on.list({ sessionId: 'unbound' }), { ok: true, enabled: true, records: [] });
  assert.deepEqual(
    await on.capture({ sessionId: 'unbound', turnId: 't', files: [{ path: 'a.css', status: 'modified' }] }),
    { ok: true, enabled: true, record: null }
  );
});

test('the working tree comes from the chat\'s own git service', async () => {
  const root = fs.realpathSync(createTrackedTempDir('jenny-change-pictures-root-'));
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
  const asked = [];
  const git = {
    async getStatus() { return { ok: true, isRepo: true, files: [{ path: 'notes.txt', state: 'modified' }] }; },
    async getFileAtHead() { return { ok: true, found: true, content: 'old' }; },
  };
  const service = compose(makeBackend(root, {
    resolveProjectWorkspaceServices: (authority, options) => {
      asked.push([authority, options]);
      return { workspaceGitService: git };
    },
  }))();
  // Nothing in the tree is a web file, so there is nothing to picture.
  assert.deepEqual(await service.captureWorkingTree({ sessionId: 'bound' }), { ok: true, enabled: true, record: { sessionId: 'bound', turnId: '@working-tree', viewport: 'desktop', capturedAt: (await service.list({ sessionId: 'bound' })).records[0].capturedAt, pages: [] } });
  assert.deepEqual(asked[0], [{ root_path: root }, { sessionId: 'bound' }]);
});

test('status entries map to created, modified and deleted; a conflict pictures nothing', () => {
  assert.deepEqual(workingTreeFiles([
    { path: 'a.css', state: 'modified' },
    { path: 'b.css', state: 'untracked' },
    { path: 'c.css', state: 'added' },
    { path: 'd.css', state: 'deleted' },
    { path: 'new.css', origPath: 'old.css', state: 'renamed' },
    { path: 'copy.css', origPath: 'a.css', state: 'copied' },
    { path: 'e.css' },
    { state: 'modified' },
    null,
  ]), [
    { path: 'a.css', status: 'modified' },
    { path: 'b.css', status: 'created' },
    { path: 'c.css', status: 'created' },
    { path: 'd.css', status: 'deleted' },
    { path: 'new.css', status: 'created' },
    { path: 'old.css', status: 'deleted' },
    { path: 'copy.css', status: 'created' },
    { path: 'e.css', status: 'modified' },
  ]);
  assert.equal(workingTreeFiles([{ path: 'a.css', state: 'modified' }, { path: 'b.css', state: 'conflicted' }]), null);
  assert.deepEqual(workingTreeFiles(undefined), []);
});

test('the loader answers nothing without a repository, on a failed or cut-off status, and reads committed text', async () => {
  const load = (git) => createWorkingTreeLoader({ resolveGitService: async () => git })({ sessionId: 's' });
  assert.equal(await load(null), null);
  assert.equal(await load({}), null);
  const withStatus = (status, head) => ({ getStatus: async () => status, getFileAtHead: async (request) => head(request) });
  assert.equal(await load(withStatus({ ok: false }, () => null)), null);
  assert.equal(await load(withStatus({ ok: true, isRepo: false, files: [] }, () => null)), null);
  assert.equal(await load(withStatus({ ok: true, isRepo: true, truncated: true, files: [] }, () => null)), null);

  const requests = [];
  const tree = await load(withStatus({ ok: true, isRepo: true, files: [{ path: 'a.css', state: 'modified' }] }, (request) => {
    requests.push(request);
    if (request.path === 'a.css') return { ok: true, found: true, content: 'old' };
    if (request.path === 'new.css') return { ok: true, found: false, reason: 'not_in_head' };
    return { ok: false, message: 'fatal: something' };
  }));
  assert.deepEqual(tree.files, [{ path: 'a.css', status: 'modified' }]);
  assert.equal(await tree.readHead('a.css'), 'old');
  assert.equal(await tree.readHead('new.css'), null);
  assert.equal(await tree.readHead('broken.css'), null);
  assert.deepEqual(requests, [{ path: 'a.css' }, { path: 'new.css' }, { path: 'broken.css' }]);
});
