'use strict';

// Git feature (renderer-ide-git-feature): review fixes for the workspace-root
// fence, renamed-file HEAD compares, the git-meta echo of the app's own
// mutations and the unsaved-buffer count. Split from
// renderer-ide-git-feature.test.js at its 600-line ratchet.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeGitFeature } = require('../renderer/features/renderer-ide-git-feature');

function fakeStore() {
  const calls = { refresh: 0, refreshNow: 0, fileAtHead: [] };
  return {
    calls,
    getFileAtHead: async (payload) => { calls.fileAtHead.push(payload); return { found: true, content: 'old\r\n' }; },
    getBranch: () => 'main',
    getDirtyCount: () => 0,
    getDecoration: () => null,
    getFolderRollup: () => null,
    isRepo: () => true,
    isAvailable: () => true,
    refresh: () => { calls.refresh += 1; },
    refreshNow: () => { calls.refreshNow += 1; return Promise.resolve(); },
    subscribe: () => () => {},
    dispose: () => {},
  };
}

function buildFeature(over = {}) {
  const store = over.store || fakeStore();
  const calls = { openDiff: [], activate: [] };
  const editorHost = {
    calls,
    openDiffDocument: async (cfg) => { calls.openDiff.push(cfg); },
    activateDocument: (id) => { calls.activate.push(id); },
  };
  const fsApi = over.fsApi || { readFile: async (payload) => ({ content: `disk:${payload.path}` }) };
  const ide = { openTabs: [], railPanel: 'explorer' };
  const spies = { toasts: [], logs: [] };
  const feature = createIdeGitFeature({
    store,
    editorHost,
    getIde: () => ide,
    getWorkspaceFsApi: () => fsApi,
    renderTabs: () => {},
    schedulePersist: () => {},
    requestRender: () => {},
    onChange: () => {},
    appendClientLog: (level, event, meta) => spies.logs.push({ level, event, meta }),
    showShellErrorToast: (message, meta) => spies.toasts.push({ message, meta }),
    confirmDialog: { confirm: async () => true },
    ...(over.client ? { client: over.client } : {}),
  });
  return { feature, store, editorHost, ide, spies };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// ── review fixes: root fence, renames, git-meta echo, unsaved count ───────────

test('openHeadCompare reads HEAD at the original path of a renamed file', async () => {
  const { feature, store, editorHost } = buildFeature();
  const ok = await feature.openHeadCompare('src/new-name.js', { origPath: 'src/old-name.js' });
  assert.equal(ok, true);
  assert.deepEqual(store.calls.fileAtHead, [{ path: 'src/old-name.js' }]);
  assert.equal(editorHost.calls.openDiff[0].modified, 'disk:src/new-name.js');
});

test('openHeadCompare and openCommitDiff drop results that land after a root switch', async () => {
  const head = deferred();
  const store = fakeStore();
  store.getFileAtHead = async (payload) => { store.calls.fileAtHead.push(payload); return head.promise; };
  const commit = deferred();
  const client = { getCommitDiff: () => commit.promise };
  const { feature, editorHost, ide, spies } = buildFeature({ store, client });
  const compare = feature.openHeadCompare('src/a.js');
  const commitOpen = feature.openCommitDiff({ hash: 'abc1234' });
  await feature.resetForRoot();
  head.resolve({ found: true, content: 'old' });
  commit.resolve({ ok: true, diff: '+x\n' });
  assert.equal(await compare, false);
  assert.deepEqual(await commitOpen, { opened: false });
  assert.equal(editorHost.calls.openDiff.length, 0, 'no old-root diff tab opens under the new root');
  assert.equal(ide.openTabs.length, 0);
  assert.equal(spies.toasts.length, 0, 'a superseded open is silent');
});

test('the git-meta echo of the app\'s own mutation does not re-run status', () => {
  const listeners = { gitMeta: null };
  const fsApi = {
    readFile: async () => ({ content: '' }),
    onGitMetaChange: (fn) => { listeners.gitMeta = fn; return () => {}; },
  };
  const store = fakeStore();
  const refreshArgs = [];
  store.refresh = (opts) => { store.calls.refresh += 1; refreshArgs.push(opts); };
  const { feature } = buildFeature({ fsApi, store });
  feature.bindEvents();
  listeners.gitMeta();
  assert.ok(refreshArgs[1] && refreshArgs[1].unlessRefreshedWithinMs > 0, 'git-meta refresh is skipped right after an eager refresh');
});

test('getUnsavedCount counts dirty editor buffers for the branch-switch guard', () => {
  const { feature, ide } = buildFeature();
  assert.equal(feature.getUnsavedCount(), 0);
  ide.dirtyByPath = { 'a.js': true, 'b.js': false, 'c.js': true };
  assert.equal(feature.getUnsavedCount(), 2);
});
