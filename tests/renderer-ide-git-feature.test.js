'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeGitFeature } = require('../renderer/features/renderer-ide-git-feature');
const { createIdeConfirmDialog } = require('../renderer/features/renderer-ide-confirm-dialog');
const actionButton = require('../renderer/inventory/action-button');

// ── git-feature (fakes for store / editorHost / fs / confirm) ─────────────────

function fakeStore(opts = {}) {
  const calls = { stage: [], unstage: [], commit: [], discard: [], refresh: 0, refreshNow: 0, fileAtHead: [] };
  let subscriber = null;
  return {
    calls,
    notify: () => subscriber && subscriber(),
    getFileAtHead: async (payload) => { calls.fileAtHead.push(payload); return opts.head || { found: true, content: 'old\r\n' }; },
    discardFile: async (payload) => { calls.discard.push(payload); return { ok: true, discarded: true }; },
    stage: async (payload) => { calls.stage.push(payload); return { ok: true }; },
    unstage: async (payload) => { calls.unstage.push(payload); return { ok: true }; },
    commit: async (payload) => { calls.commit.push(payload); return { ok: true, committed: true }; },
    getBranch: () => (opts.branch != null ? opts.branch : 'main'),
    getDirtyCount: () => (opts.dirty != null ? opts.dirty : 2),
    getDecoration: (rel) => (opts.dec || {})[rel] || null,
    getFolderRollup: (rel) => (opts.roll || {})[rel] || null,
    isRepo: () => opts.isRepo !== false,
    isAvailable: () => opts.available !== false,
    refresh: () => { calls.refresh += 1; },
    refreshNow: () => { calls.refreshNow += 1; return Promise.resolve(); },
    subscribe: (fn) => { subscriber = fn; return () => { subscriber = null; }; },
    dispose: () => {},
  };
}

function fakeEditorHost() {
  const calls = { openDiff: [], activate: [] };
  return {
    calls,
    openDiffDocument: async (cfg) => { calls.openDiff.push(cfg); },
    activateDocument: (id) => { calls.activate.push(id); },
  };
}

function buildFeature(over = {}) {
  const store = over.store || fakeStore(over.storeOpts || {});
  const editorHost = over.editorHost || fakeEditorHost();
  const fsApi = over.fsApi || { readFile: async (payload) => ({ content: `disk:${payload.path}` }) };
  const ide = { openTabs: [], railPanel: over.railPanel || 'explorer' };
  const spies = { renderTabs: 0, schedulePersist: 0, requestRender: 0, change: 0, toasts: [], logs: [] };
  const confirmDialog = over.confirmDialog || { confirm: async () => over.confirmResult !== false };
  const feature = createIdeGitFeature({
    store,
    editorHost,
    getIde: () => ide,
    getWorkspaceFsApi: () => fsApi,
    renderTabs: () => { spies.renderTabs += 1; },
    schedulePersist: () => { spies.schedulePersist += 1; },
    requestRender: () => { spies.requestRender += 1; },
    onChange: () => { spies.change += 1; },
    appendClientLog: (level, event, meta) => spies.logs.push({ level, event, meta }),
    showShellErrorToast: (message, meta) => spies.toasts.push({ message, meta }),
    confirmDialog,
    ...(over.getDom ? { getDom: over.getDom } : {}),
    ...(over.getFileLifecycle ? { getFileLifecycle: over.getFileLifecycle } : {}),
    ...(over.onDeleteUntracked ? { onDeleteUntracked: over.onDeleteUntracked } : {}),
    ...(over.client ? { client: over.client } : {}),
    ...(over.windowRef ? { windowRef: over.windowRef } : {}),
  });
  return { feature, store, editorHost, ide, spies };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// Mounts the REAL Source Control panel (built inside the feature) into a jsdom
// rail host so a stage/unstage/stage-all CLICK exercises the actual wiring:
// panel handler -> feature callback -> store mutation -> toast. `mutateResult`
// is the { ok } shape the store mutation resolves.
function mountedScmPanel(over = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const panelEl = dom.window.document.getElementById('ideRailPanel');
  const snapshot = {
    available: true, isRepo: true, branch: 'main', detached: false, unborn: false,
    files: [
      { path: 'src/a.js', state: 'modified', staged: false, worktree: 'M', index: ' ' },
      { path: 'staged.js', state: 'modified', staged: true, worktree: ' ', index: 'M' },
    ],
  };
  const mutateResult = over.mutateResult || { ok: false };
  const store = {
    calls: { stage: [], unstage: [] },
    getSnapshot: () => snapshot,
    getBranch: () => 'main',
    getDirtyCount: () => 1,
    getDecoration: () => null,
    getFolderRollup: () => null,
    isRepo: () => true,
    isAvailable: () => true,
    stage: async (payload) => { store.calls.stage.push(payload); return mutateResult; },
    unstage: async (payload) => { store.calls.unstage.push(payload); return mutateResult; },
    refresh: () => {},
    refreshNow: () => Promise.resolve(),
    subscribe: () => () => {},
    dispose: () => {},
  };
  const { feature, spies } = buildFeature({
    store,
    getDom: () => ({ ideRailPanel: panelEl }),
    railPanel: 'source-control',
  });
  feature.bindEvents();
  feature.renderPanel();
  return { panelEl, store, spies, feature };
}

test('openHeadCompare diffs the HEAD version (CRLF-normalized) against disk', async () => {
  const { feature, editorHost } = buildFeature({ storeOpts: { head: { found: true, content: 'old\r\n' } } });
  const ok = await feature.openHeadCompare('src/a.js');
  assert.equal(ok, true);
  assert.equal(editorHost.calls.openDiff.length, 1);
  const cfg = editorHost.calls.openDiff[0];
  assert.equal(cfg.original, 'old\n');
  assert.equal(cfg.modified, 'disk:src/a.js');
  assert.ok(cfg.id.startsWith('diff://head/src/a.js'));
  assert.match(cfg.label, /a\.js \(vs HEAD\)/);
  assert.deepEqual(editorHost.calls.activate, [cfg.id]);
});

test('openHeadCompare on a file with no HEAD version uses an empty original (all-additions, no error)', async () => {
  const { feature, editorHost, spies } = buildFeature({ storeOpts: { head: { found: false, reason: 'no_head' } } });
  const ok = await feature.openHeadCompare('new.txt');
  assert.equal(ok, true);
  assert.equal(editorHost.calls.openDiff[0].original, '');
  assert.equal(spies.toasts.length, 0);
});

test('openHeadCompare surfaces a disk-read failure and aborts', async () => {
  const fsApi = { readFile: async () => { throw new Error('boom'); } };
  const { feature, editorHost, spies } = buildFeature({ fsApi, storeOpts: { head: { found: true, content: 'x' } } });
  const ok = await feature.openHeadCompare('src/a.js');
  assert.equal(ok, false);
  assert.equal(editorHost.calls.openDiff.length, 0);
  assert.equal(spies.toasts.length, 1);
});

test('openHeadCompare on a deleted file diffs HEAD against empty (no error toast)', async () => {
  const store = fakeStore({ head: { found: true, content: 'old\n' }, dec: { 'gone.txt': 'deleted' } });
  const fsApi = { readFile: async () => { const error = new Error('gone'); error.code = 'CMP-WORKSPACEFS-0004'; throw error; } };
  const { feature, editorHost, spies } = buildFeature({ store, fsApi });
  const ok = await feature.openHeadCompare('gone.txt');
  assert.equal(ok, true);
  assert.equal(editorHost.calls.openDiff[0].original, 'old\n');
  assert.equal(editorHost.calls.openDiff[0].modified, '', 'deleted file diffs against empty');
  assert.equal(spies.toasts.length, 0, 'no error toast for the deletion diff');
});

test('openHeadCompare aborts instead of fabricating content when either required read is unavailable', async () => {
  const throwingStore = fakeStore();
  throwingStore.getFileAtHead = async () => { throw new Error('head failed'); };
  const cases = [
    buildFeature({ store: throwingStore }),
    buildFeature({ storeOpts: { head: { ok: false, found: false, reason: 'bridge_unavailable' } } }),
    buildFeature({ fsApi: {}, storeOpts: { head: { found: true, content: 'HEAD' } } }),
  ];

  for (const entry of cases) {
    assert.equal(await entry.feature.openHeadCompare('src/a.js'), false);
    assert.equal(entry.editorHost.calls.openDiff.length, 0);
    assert.equal(entry.spies.toasts.length, 1);
    assert.equal(entry.spies.logs.at(-1).level, 'WARN');
  }
});

test('confirmDiscard discards only when the confirm resolves true', async () => {
  const yes = buildFeature({ confirmResult: true });
  assert.equal(await yes.feature.confirmDiscard('src/a.js'), true);
  assert.deepEqual(yes.store.calls.discard, [{ path: 'src/a.js' }]);

  const no = buildFeature({ confirmResult: false });
  assert.equal(await no.feature.confirmDiscard('src/a.js'), false);
  assert.equal(no.store.calls.discard.length, 0);
});

test('confirmDiscard surfaces a toast and returns false when the discard degrades to { ok:false }', async () => {
  const store = fakeStore();
  // Model a locked-file git op: the client degrades-never to a non-ok shape.
  store.discardFile = async (payload) => { store.calls.discard.push(payload); return { ok: false, reason: 'locked' }; };
  const { feature, spies } = buildFeature({ store, confirmResult: true });
  const ok = await feature.confirmDiscard('src/a.js');
  assert.equal(ok, false, 'a failed discard reports false (no silent success)');
  assert.deepEqual(store.calls.discard, [{ path: 'src/a.js' }], 'the discard was still attempted');
  assert.equal(spies.toasts.length, 1, 'one failure toast');
  assert.match(spies.toasts[0].message, /discard/i);
  assert.equal(spies.toasts[0].meta.dedupeKey, 'ide:discard:src/a.js');
});

test('confirmDiscard explicitly warns about a dirty editor and reloads its approved revision', async () => {
  const editorHost = fakeEditorHost();
  editorHost.isDirty = () => true;
  editorHost.hasDocument = () => true;
  const snapshot = { path: 'src/a.js', editVersion: 4 };
  const calls = { confirm: [], capture: [], reload: [], release: [] };
  const lifecycle = {
    captureGitDiscard(path) { calls.capture.push(path); return snapshot; },
    async reloadAfterGitDiscard(value) { calls.reload.push(value); return true; },
    releaseGitDiscard(value) { calls.release.push(value); },
  };
  const { feature, store } = buildFeature({
    editorHost,
    getFileLifecycle: () => lifecycle,
    confirmDialog: { confirm: async (payload) => { calls.confirm.push(payload); return true; } },
  });

  assert.equal(await feature.confirmDiscard('src/a.js'), true);
  assert.match(calls.confirm[0].message, /Unsaved editor changes will also be lost/);
  assert.deepEqual(calls.capture, ['src/a.js']);
  assert.deepEqual(store.calls.discard, [{ path: 'src/a.js' }]);
  assert.deepEqual(calls.reload, [snapshot]);
  assert.deepEqual(calls.release, [snapshot]);
});

// UIUX-032: discardFile now classifies tracked vs untracked and DELETES an
// untracked path rather than restoring content (there is nothing to restore
// it to). An open dirty buffer for that path must not attempt a disk reload
// (the file is gone — reload would fail and mislead the user with "restored
// on disk" copy); the documented decision is to close the tab, same as any
// other deliberate delete of the file the buffer was viewing.
test('confirmDiscard closes the open tab (not a reload) when the backend deleted an untracked file', async () => {
  const editorHost = fakeEditorHost();
  editorHost.isDirty = () => true;
  editorHost.hasDocument = () => true;
  const snapshot = { path: 'scratch.txt', editVersion: 1 };
  const calls = { capture: [], reload: [], release: [], closeTab: [] };
  const lifecycle = {
    captureGitDiscard(path) { calls.capture.push(path); return snapshot; },
    async reloadAfterGitDiscard(value) { calls.reload.push(value); return true; },
    releaseGitDiscard(value) { calls.release.push(value); },
    closeTab(path) { calls.closeTab.push(path); },
  };
  const store = fakeStore();
  store.discardFile = async (payload) => {
    store.calls.discard.push(payload);
    return { ok: true, discarded: true, class: 'untracked', deleted: true };
  };
  const { feature, spies } = buildFeature({
    store, editorHost, getFileLifecycle: () => lifecycle, confirmResult: true,
  });

  assert.equal(await feature.confirmDiscard('scratch.txt'), true);
  assert.deepEqual(calls.closeTab, ['scratch.txt'], 'the buffer for the deleted file was closed');
  assert.deepEqual(calls.reload, [], 'no disk reload was attempted — the file no longer exists');
  assert.deepEqual(calls.release, [snapshot]);
  assert.equal(spies.toasts.length, 0, 'no "restored on disk" toast for a file that was actually deleted');
});

test('discard keeps the SCM row published until deferred editor reload reaches terminal state', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="ideRailPanel"></div></body>');
  const panelEl = dom.window.document.getElementById('ideRailPanel');
  const reload = deferred();
  let subscriber = null;
  let releaseCalls = 0;
  const snapshot = {
    available: true, isRepo: true, branch: 'main', detached: false, unborn: false,
    files: [{ path: 'src/a.js', state: 'modified', staged: false, worktree: 'M', index: ' ' }],
  };
  const store = {
    getSnapshot: () => snapshot,
    getBranch: () => 'main', getDirtyCount: () => snapshot.files.length,
    getDecoration: () => 'modified', getFolderRollup: () => null,
    isRepo: () => true, isAvailable: () => true,
    refresh() {}, refreshNow: async () => {}, dispose() {},
    subscribe(fn) { subscriber = fn; return () => { subscriber = null; }; },
    beginRefreshHold() {
      return async () => {
        releaseCalls += 1;
        snapshot.files = [];
        subscriber?.();
      };
    },
    async discardFile(_payload, options) {
      assert.equal(options.refreshAfter, false);
      return { ok: true, discarded: true };
    },
  };
  const editorHost = fakeEditorHost();
  editorHost.isDirty = () => true;
  editorHost.hasDocument = () => true;
  const lifecycle = {
    captureGitDiscard: () => ({ path: 'src/a.js', editVersion: 1 }),
    reloadAfterGitDiscard: () => reload.promise,
  };
  const { feature } = buildFeature({
    store, editorHost, railPanel: 'source-control', getDom: () => ({ ideRailPanel: panelEl }),
    getFileLifecycle: () => lifecycle, confirmResult: true,
  });
  feature.bindEvents();
  feature.renderPanel();

  const pending = feature.confirmDiscard('src/a.js');
  await settle();
  assert.ok(panelEl.querySelector('[data-ide-scm-path="src/a.js"]'), 'row stays visible while reload is pending');
  assert.equal(releaseCalls, 0);
  reload.resolve(true);
  assert.equal(await pending, true);
  assert.equal(releaseCalls, 1);
  assert.equal(panelEl.querySelector('[data-ide-scm-path="src/a.js"]'), null, 'row clears only after terminal reload');
});

test('confirmDiscard fails closed when an open editor cannot capture a versioned reload', async () => {
  const editorHost = fakeEditorHost();
  editorHost.hasDocument = () => true;
  editorHost.isDirty = () => true;
  const { feature, store, spies } = buildFeature({
    editorHost,
    getFileLifecycle: () => ({ captureGitDiscard: () => null }),
    confirmResult: true,
  });

  assert.equal(await feature.confirmDiscard('src/a.js'), false);
  assert.equal(store.calls.discard.length, 0, 'disk is untouched when editor reconciliation cannot be prepared');
  assert.equal(spies.toasts[0].meta.dedupeKey, 'ide:discard-preflight:src/a.js');
});

test('discard reload diagnostics never persist raw error messages or local paths', async () => {
  const editorHost = fakeEditorHost();
  editorHost.hasDocument = () => true;
  editorHost.isDirty = () => true;
  const error = Object.assign(new Error('failed at C:\\Users\\private\\file.txt'), {
    name: 'ReloadError', code: 'reload_stale',
  });
  const { feature, spies } = buildFeature({
    editorHost,
    getFileLifecycle: () => ({
      captureGitDiscard: () => ({ path: 'src/a.js' }),
      reloadAfterGitDiscard: async () => { throw error; },
    }),
    confirmResult: true,
  });

  assert.equal(await feature.confirmDiscard('src/a.js'), false);
  const log = spies.logs.find((entry) => entry.event === 'ide.git_discard_reload_failed');
  assert.deepEqual(log.meta, { error_name: 'ReloadError', error_code: 'reload_stale' });
  assert.doesNotMatch(JSON.stringify(log), /Users|private|file\.txt/);
});

test('untracked Delete delegates to the Explorer recycle-bin transaction', () => {
  const deleted = [];
  const { feature } = buildFeature({ onDeleteUntracked: (path) => { deleted.push(path); return true; } });
  assert.equal(feature.deleteUntracked('new.txt'), true);
  assert.deepEqual(deleted, ['new.txt']);
});

test('a failed stage / unstage / stage-all surfaces a toast (no silent no-op)', async () => {
  const stage = mountedScmPanel({ mutateResult: { ok: false } });
  stage.panelEl.querySelector('[data-ide-scm-path="src/a.js"] [data-ide-scm-action="stage"]').click();
  await settle();
  assert.equal(stage.spies.toasts.length, 1, 'stage failure toasts');
  assert.match(stage.spies.toasts[0].message, /stage/i);
  assert.deepEqual(stage.store.calls.stage, [{ paths: ['src/a.js'] }], 'mutation attempted');

  const unstage = mountedScmPanel({ mutateResult: { ok: false } });
  unstage.panelEl.querySelector('[data-ide-scm-path="staged.js"] [data-ide-scm-action="unstage"]').click();
  await settle();
  assert.equal(unstage.spies.toasts.length, 1, 'unstage failure toasts');
  assert.match(unstage.spies.toasts[0].message, /unstage/i);

  const all = mountedScmPanel({ mutateResult: { ok: false } });
  all.panelEl.querySelector('[data-ide-scm-action="stage-all"]').click();
  await settle();
  assert.equal(all.spies.toasts.length, 1, 'stage-all failure toasts');
  assert.deepEqual(all.store.calls.stage, [{ paths: ['src/a.js'] }], 'stage-all routes the changed paths to store.stage');
});

test('a successful stage does NOT toast', async () => {
  const ok = mountedScmPanel({ mutateResult: { ok: true } });
  ok.panelEl.querySelector('[data-ide-scm-path="src/a.js"] [data-ide-scm-action="stage"]').click();
  await settle();
  assert.equal(ok.spies.toasts.length, 0, 'no toast on success');
  assert.deepEqual(ok.store.calls.stage, [{ paths: ['src/a.js'] }]);
});

test('decoration getter dispatches file vs directory; branch/dirty proxy the store', () => {
  const { feature } = buildFeature({ storeOpts: { dec: { 'a.js': 'modified' }, roll: { src: 'untracked' }, branch: 'dev', dirty: 5 } });
  assert.equal(feature.getDecoration('a.js', 'file'), 'modified');
  assert.equal(feature.getDecoration('src', 'directory'), 'untracked');
  assert.equal(feature.getBranch(), 'dev');
  assert.equal(feature.getDirtyCount(), 5);
});

test('openPanel switches the rail to source-control and persists + renders', () => {
  const { feature, ide, spies } = buildFeature();
  feature.openPanel();
  assert.equal(ide.railPanel, 'source-control');
  assert.equal(spies.schedulePersist, 1);
  assert.equal(spies.requestRender, 1);
});

test('bindEvents kicks an initial refresh and fans store changes out to onChange', () => {
  const { feature, store, spies } = buildFeature();
  feature.bindEvents();
  assert.equal(store.calls.refresh, 1);
  store.notify();
  assert.equal(spies.change, 1);
});

test('bindEvents refreshes the store on an external git-meta change (commit/checkout/branch switch)', () => {
  const listeners = { change: null, gitMeta: null };
  const fsApi = {
    readFile: async (payload) => ({ content: `disk:${payload.path}` }),
    onChange: (fn) => { listeners.change = fn; return () => { listeners.change = null; }; },
    onGitMetaChange: (fn) => { listeners.gitMeta = fn; return () => { listeners.gitMeta = null; }; },
  };
  const { feature, store, spies } = buildFeature({ fsApi });
  feature.bindEvents();
  assert.equal(store.calls.refresh, 1, 'initial load');
  assert.equal(typeof listeners.gitMeta, 'function', 'subscribed to onGitMetaChange');

  // External `git commit` -> main emits the dedicated signal -> store re-pulls so
  // the tree/statusbar/gutter (all store subscribers) refresh.
  listeners.gitMeta();
  assert.equal(store.calls.refresh, 2);
  assert.equal(spies.change, 1, 'HEAD-dependent consumers refresh even when status is unchanged');

  feature.dispose();
  assert.equal(listeners.gitMeta, null, 'git-meta subscription cleaned up on dispose');
});

// ── AI commit message: staged diff + off-transcript model call ────────────────

test('getStagedDiff requests the index-vs-HEAD diff via the git client', async () => {
  const diffCalls = [];
  const client = { getDiff: async (payload) => { diffCalls.push(payload); return { ok: true, diff: 'staged-diff' }; } };
  const { feature } = buildFeature({ client });
  const res = await feature.getStagedDiff();
  assert.deepEqual(diffCalls, [{ path: null, staged: true }], 'asks the client for the staged diff');
  assert.deepEqual(res, { ok: true, diff: 'staged-diff' });
});

test('getStagedDiff degrades (no throw) when the client is unavailable', async () => {
  const { feature } = buildFeature({ client: {} });
  const res = await feature.getStagedDiff();
  assert.equal(res.ok, false);
  assert.equal(res.available, false);
});

// ── commit diff: open a single commit's changes as a read-only tab ────────────

test('openCommitDiff opens a read-only "Commit <short>" tab from the commit diff text', async () => {
  const diffCalls = [];
  const client = {
    getCommitDiff: async (payload) => {
      diffCalls.push(payload);
      return {
        ok: true, available: true, isRepo: true, op: 'getCommitDiff',
        hash: payload.hash, diff: 'commit abc1234\n\n    add feature\n\n+added line\n', truncated: false,
      };
    },
  };
  const { feature, editorHost, ide, spies } = buildFeature({ client });
  const res = await feature.openCommitDiff({ hash: 'abc1234def' });
  assert.deepEqual(diffCalls, [{ hash: 'abc1234def' }], 'fetches the commit diff via the client');
  assert.equal(res.opened, true);
  assert.equal(editorHost.calls.openDiff.length, 1);
  const cfg = editorHost.calls.openDiff[0];
  assert.equal(cfg.id, 'diff://commit/abc1234def');
  assert.match(cfg.label, /Commit abc1234/);
  // The unified diff text lands in the read-only <pre> placeholder, not a
  // two-pane editor (no original/modified content).
  assert.match(cfg.placeholderText, /\+added line/);
  assert.deepEqual(editorHost.calls.activate, ['diff://commit/abc1234def']);
  assert.ok(ide.openTabs.some((tab) => tab.path === 'diff://commit/abc1234def' && tab.kind === 'diff'));
  assert.equal(spies.toasts.length, 0);
});

test('openCommitDiff appends a truncation note when the diff overflowed the cap', async () => {
  const client = {
    getCommitDiff: async () => ({ ok: true, available: true, isRepo: true, diff: 'partial diff', truncated: true }),
  };
  const { feature, editorHost } = buildFeature({ client });
  await feature.openCommitDiff({ hash: 'deadbeef' });
  assert.match(editorHost.calls.openDiff[0].placeholderText, /truncated/);
});

test('openCommitDiff degrades to a toast on an empty/failed result (no tab opened)', async () => {
  const client = { getCommitDiff: async () => ({ ok: false, available: true, isRepo: true, op: 'getCommitDiff' }) };
  const { feature, editorHost, spies } = buildFeature({ client });
  const res = await feature.openCommitDiff({ hash: 'deadbeef' });
  assert.equal(res.opened, false);
  assert.equal(editorHost.calls.openDiff.length, 0, 'no tab opened on a failed fetch');
  assert.equal(spies.toasts.length, 1, 'surfaces a toast');
});

test('getCommitDiff degrades (no throw) when the client is unavailable', async () => {
  const { feature } = buildFeature({ client: {} });
  const res = await feature.getCommitDiff('abc1234');
  assert.equal(res.ok, false);
  assert.equal(res.available, false);
});

test('generateCommitMessage forwards the diff to the off-transcript commit bridge', async () => {
  const sent = [];
  const windowRef = {
    jennyShell: {
      commit: {
        generateMessage: async (payload) => { sent.push(payload); return { ok: true, message: 'feat: do the thing' }; },
      },
    },
  };
  const { feature } = buildFeature({ windowRef });
  const res = await feature.generateCommitMessage('the-diff');
  assert.deepEqual(sent, [{ diff: 'the-diff' }], 'diff handed straight to the bridge (never the transcript)');
  assert.deepEqual(res, { ok: true, message: 'feat: do the thing' });
});

test('generateCommitMessage degrades when the commit bridge is unavailable', async () => {
  const { feature } = buildFeature({ windowRef: { jennyShell: {} } });
  const res = await feature.generateCommitMessage('the-diff');
  assert.deepEqual(res, { ok: false, available: false, reason: 'bridge_unavailable' });
});

test('generateCommitMessage catches a thrown bridge error into a structured shape', async () => {
  const windowRef = {
    jennyShell: { commit: { generateMessage: async () => { throw new Error('rpc boom'); } } },
  };
  const { feature } = buildFeature({ windowRef });
  const res = await feature.generateCommitMessage('the-diff');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'call_failed');
  assert.match(res.message, /rpc boom/);
});

// ── generic confirm() dialog (fake overlay rendering into a real jsdom doc) ────

test('confirm() resolves true on confirm and false on cancel', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const doc = dom.window.document;
  const host = doc.createElement('div');
  doc.body.appendChild(host);
  const helpOverlayFactory = () => ({
    open: (cfg) => { host.innerHTML = cfg.bodyHtml; },
    close: () => { host.innerHTML = ''; },
    destroy: () => { host.remove(); },
  });
  const dialog = createIdeConfirmDialog({ document: doc, actionButton, helpOverlayFactory });

  const accepted = dialog.confirm({ title: 'Discard?', message: 'Discard changes?', confirmLabel: 'Discard', variant: 'danger' });
  const confirmBtn = doc.body.querySelector('[data-ide-confirm-action="confirm"]');
  assert.ok(confirmBtn, 'confirm button rendered');
  assert.match(confirmBtn.textContent, /Discard/);
  confirmBtn.click();
  assert.equal(await accepted, true);

  const declined = dialog.confirm({ message: 'again?' });
  doc.body.querySelector('[data-ide-confirm-action="cancel"]').click();
  assert.equal(await declined, false);
});

test('confirm() resolves false when the overlay primitive is unavailable', async () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const dialog = createIdeConfirmDialog({ document: dom.window.document, actionButton, helpOverlayFactory: null });
  assert.equal(await dialog.confirm({ message: 'x' }), false);
});
