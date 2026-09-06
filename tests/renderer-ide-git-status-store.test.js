'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createIdeGitStatusStore, buildSnapshot } = require('../renderer/features/renderer-ide-git-status-store');

const settle = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function repoResult(overrides) {
  return Object.assign({
    ok: true, available: true, isRepo: true, op: 'getStatus',
    branch: 'main', detached: false, unborn: false, ahead: 0, behind: 0,
    files: [
      { path: 'src/a.js', index: ' ', worktree: 'M', state: 'modified', staged: false },
      { path: 'src/deep/x.js', index: ' ', worktree: 'M', state: 'modified', staged: false },
      { path: 'new.txt', index: ' ', worktree: '?', state: 'untracked', staged: false },
      { path: 'staged.js', index: 'M', worktree: ' ', state: 'modified', staged: true },
    ],
    summary: { staged_count: 1, modified_count: 2, untracked_count: 1 },
  }, overrides || {});
}

// A fake client whose getStatus() yields queued results (last repeats), and
// whose mutations resolve ok. `count` records getStatus invocations.
function fakeClient(queue) {
  const results = Array.isArray(queue) ? queue : [queue];
  let index = 0;
  const state = { count: 0, stage: [], unstage: [], commit: [], discard: [] };
  return {
    state,
    getStatus: async () => {
      state.count += 1;
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return typeof result === 'function' ? result() : result;
    },
    stage: async (payload) => { state.stage.push(payload); return { ok: true, op: 'stage' }; },
    unstage: async (payload) => { state.unstage.push(payload); return { ok: true, op: 'unstage' }; },
    commit: async (payload) => { state.commit.push(payload); return { ok: true, op: 'commit', committed: true }; },
    discardFile: async (payload) => { state.discard.push(payload); return { ok: true, op: 'discardFile', discarded: true }; },
    getFileAtHead: async (payload) => ({ ok: true, found: true, content: `head:${payload.path}` }),
  };
}

test('buildSnapshot derives byPath, folder roll-ups, dirty + staged counts', () => {
  const snapshot = buildSnapshot(repoResult());
  assert.equal(snapshot.available, true);
  assert.equal(snapshot.isRepo, true);
  assert.equal(snapshot.branch, 'main');
  // Dirty = working-tree changes only: a.js (M) + x.js (M) + new.txt (?) = 3.
  // staged.js (worktree ' ') is "ready", not dirty.
  assert.equal(snapshot.dirtyCount, 3);
  assert.equal(snapshot.stagedCount, 1);
  assert.equal(snapshot.byPath.get('src/a.js'), 'modified');
  assert.equal(snapshot.byPath.get('new.txt'), 'untracked');
  assert.equal(snapshot.folderRollup.get('src'), 'modified');
  assert.equal(snapshot.folderRollup.get('src/deep'), 'modified');
});

// UIUX-032: getStatus already truncates its own 8MB execFile buffer and
// reports { truncated, droppedBytes } (workspace-git-service.js getStatus),
// but buildSnapshot used to drop that metadata entirely — the SCM panel had no
// way to know (or tell the user) that the status it's rendering is partial.
test('buildSnapshot passes truncated/droppedBytes metadata through from getStatus', () => {
  const clean = buildSnapshot(repoResult());
  assert.equal(clean.truncated, false);
  assert.equal(clean.droppedBytes, 0);

  const partial = buildSnapshot(repoResult({ truncated: true, droppedBytes: 4096 }));
  assert.equal(partial.truncated, true);
  assert.equal(partial.droppedBytes, 4096);
});

// UIUX-032: "bound the render" — a pathological dirty tree (an accidentally
// untracked build directory, a huge merge) must not hand the Source Control
// panel an unbounded files array to paint into DOM rows one-for-one. The store
// caps a PANEL-facing view of the files while keeping the full set for
// byPath/folderRollup/dirtyCount (the tree's decorations must stay correct for
// every file, not just the first N).
test('buildSnapshot bounds panelFiles for render while keeping full byPath/dirtyCount fidelity', () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({
    path: `gen/file-${i}.js`, index: ' ', worktree: 'M', state: 'modified', staged: false,
  }));
  const snapshot = buildSnapshot(repoResult({
    files: many,
    summary: { staged_count: 0, modified_count: 2500, untracked_count: 0 },
  }));
  assert.ok(snapshot.panelFiles.length < many.length, 'the panel-facing list is capped');
  assert.equal(snapshot.panelFilesOmitted, many.length - snapshot.panelFiles.length);
  // Full fidelity is preserved for the tree/statusbar even when the panel list is capped.
  assert.equal(snapshot.dirtyCount, many.length);
  assert.equal(snapshot.byPath.size, many.length);
  assert.equal(snapshot.byPath.get('gen/file-2499.js'), 'modified');
});

test('buildSnapshot and the store snapshot distinguish detached HEAD from an unborn repo', async () => {
  const detached = buildSnapshot(repoResult({ branch: '(detached)', detached: true, files: [] }));
  assert.equal(detached.detached, true);
  assert.equal(detached.unborn, false);

  const unborn = buildSnapshot(repoResult({ branch: 'main', unborn: true, files: [] }));
  assert.equal(unborn.unborn, true);
  assert.equal(unborn.detached, false);

  const store = createIdeGitStatusStore({ client: fakeClient(repoResult({ branch: '(detached)', detached: true })) });
  await store.refreshNow();
  assert.equal(store.getSnapshot().detached, true);
  assert.equal(store.getSnapshot().unborn, false);
});

test('folder roll-up keeps the worst descendant state (conflicted > modified)', () => {
  const snapshot = buildSnapshot(repoResult({
    files: [
      { path: 'src/a.js', worktree: 'M', state: 'modified' },
      { path: 'src/b.js', worktree: 'U', state: 'conflicted' },
    ],
    summary: { staged_count: 0, modified_count: 1, untracked_count: 0 },
  }));
  assert.equal(snapshot.folderRollup.get('src'), 'conflicted');
});

test('refreshNow loads the snapshot and exposes getters', async () => {
  const client = fakeClient(repoResult());
  const store = createIdeGitStatusStore({ client });
  await store.refreshNow();
  assert.equal(store.getBranch(), 'main');
  assert.equal(store.getDirtyCount(), 3);
  assert.equal(store.isAvailable(), true);
  assert.equal(store.isRepo(), true);
  assert.equal(store.getDecoration('src/a.js'), 'modified');
  assert.equal(store.getFolderRollup('src'), 'modified');
  assert.equal(store.getDecoration('absent'), null);
});

test('available:false and isRepo:false degrade cleanly', async () => {
  const off = createIdeGitStatusStore({ client: fakeClient({ ok: false, available: false, isRepo: false, op: 'getStatus', reason: 'feature_disabled' }) });
  await off.refreshNow();
  assert.equal(off.isAvailable(), false);
  assert.equal(off.getBranch(), '');
  assert.equal(off.getDirtyCount(), 0);

  const notRepo = createIdeGitStatusStore({ client: fakeClient({ ok: false, available: true, isRepo: false, op: 'getStatus' }) });
  await notRepo.refreshNow();
  assert.equal(notRepo.isAvailable(), true);
  assert.equal(notRepo.isRepo(), false);
  assert.deepEqual(notRepo.getSnapshot().files, []);
});

test('debounced refresh coalesces a burst into one fetch', async () => {
  const client = fakeClient(repoResult());
  const store = createIdeGitStatusStore({ client, debounceMs: 5 });
  store.refresh();
  store.refresh();
  store.refresh();
  store.refresh();
  store.refresh();
  await settle(25);
  assert.equal(client.state.count, 1);
});

test('subscribers fire on change only (no churn on an identical refresh)', async () => {
  const client = fakeClient([repoResult(), repoResult(), repoResult({ branch: 'dev' })]);
  const store = createIdeGitStatusStore({ client });
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  await store.refreshNow();           // empty -> repo: change
  assert.equal(notifications, 1);
  await store.refreshNow();           // identical repo: no change
  assert.equal(notifications, 1);
  await store.refreshNow();           // branch changed: change
  assert.equal(notifications, 2);
});

test('subscribers are notified when only ahead and behind metadata changes', async () => {
  const client = fakeClient([
    repoResult({ ahead: 0, behind: 0 }),
    repoResult({ ahead: 1, behind: 2 }),
  ]);
  const store = createIdeGitStatusStore({ client });
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });

  await store.refreshNow();
  await store.refreshNow();

  assert.equal(notifications, 2);
  assert.equal(store.getSnapshot().ahead, 1);
  assert.equal(store.getSnapshot().behind, 2);
});

test('an overlapping refresh re-runs exactly once and the fresher snapshot wins', async () => {
  const client = fakeClient([repoResult({ branch: 'first' }), repoResult({ branch: 'second' })]);
  const store = createIdeGitStatusStore({ client });
  const p1 = store.refreshNow();
  const p2 = store.refreshNow();      // arrives while the first is in flight
  await Promise.all([p1, p2]);
  assert.equal(client.state.count, 2);
  assert.equal(store.getBranch(), 'second');
});

test('mutations delegate to the client and trigger a refresh', async () => {
  const client = fakeClient(repoResult());
  const store = createIdeGitStatusStore({ client });
  await store.refreshNow();
  const before = client.state.count;
  await store.stage({ paths: ['src/a.js'] });
  assert.deepEqual(client.state.stage, [{ paths: ['src/a.js'] }]);
  assert.equal(client.state.count, before + 1, 'stage triggers a status refresh');
  await store.commit({ message: 'ship it' });
  assert.deepEqual(client.state.commit, [{ message: 'ship it' }]);
});

test('discard refresh hold blocks eager, watcher, and pre-existing status publication until release', async () => {
  const inFlight = deferred();
  const clean = repoResult({ files: [], summary: { staged_count: 0, modified_count: 0, untracked_count: 0 } });
  const client = fakeClient([repoResult(), () => inFlight.promise, clean]);
  const store = createIdeGitStatusStore({ client, debounceMs: 1 });
  await store.refreshNow();
  assert.equal(store.getSnapshot().files.length, 4);

  const staleRead = store.refreshNow();
  const release = store.beginRefreshHold();
  await store.discardFile({ path: 'src/a.js' }, { refreshAfter: false });
  store.refresh(); // model the workspaceFs watcher arriving during editor reload
  inFlight.resolve(clean);
  await staleRead;
  assert.equal(store.getSnapshot().files.length, 4, 'in-flight pre-discard status cannot publish across the barrier');
  assert.equal(client.state.count, 2, 'neither discard nor watcher starts a held refresh');

  await release();
  await settle(10);
  assert.equal(client.state.count, 3, 'release coalesces held refresh demand into one fetch');
  assert.equal(store.getSnapshot().files.length, 0);
});

// JCA-002: a committed workspace-root transition previously left the old
// root's snapshot in place until the next watcher-driven run() — the panel
// kept offering root-A rows whose Stage/Discard actions would execute against
// root B. resetForRoot must empty the snapshot SYNCHRONOUSLY (so a stale
// same-path action has no row to act from) and then pull the new root's truth.
test('resetForRoot synchronously empties the snapshot, then refetches for the new root', async () => {
  const rootB = repoResult({
    branch: 'root-b',
    files: [{ path: 'src/app.js', index: ' ', worktree: 'M', state: 'modified', staged: false }],
    summary: { staged_count: 0, modified_count: 1, untracked_count: 0 },
  });
  const client = fakeClient([repoResult(), rootB]);
  const store = createIdeGitStatusStore({ client });
  await store.refreshNow();
  assert.equal(store.getBranch(), 'main');
  assert.equal(store.getDecoration('src/a.js'), 'modified');

  const reset = store.resetForRoot();
  // Synchronously — before the new fetch settles — nothing from root A remains
  // renderable or actionable.
  assert.equal(store.getBranch(), '', 'branch cleared at commit time');
  assert.deepEqual(store.getSnapshot().files, [], 'no stale rows a same-path action could target');
  assert.equal(store.getDecoration('src/a.js'), null);
  assert.equal(store.getSnapshot().panelFiles.length, 0);

  await reset;
  assert.equal(store.getBranch(), 'root-b', 'the committed root\'s status landed');
  assert.equal(store.getDecoration('src/app.js'), 'modified');
});

test('resetForRoot discards an in-flight old-root status result', async () => {
  const inFlight = deferred();
  const rootBInFlight = deferred();
  const rootA = repoResult({ branch: 'root-a' });
  const rootB = repoResult({
    branch: 'root-b',
    files: [],
    summary: { staged_count: 0, modified_count: 0, untracked_count: 0 },
  });
  const client = fakeClient([() => inFlight.promise, () => rootBInFlight.promise]);
  const store = createIdeGitStatusStore({ client });
  const stale = store.refreshNow(); // root-A read hangs across the transition
  const reset = store.resetForRoot(); // root B commits mid-flight
  let resetSettled = false;
  reset.then(() => { resetSettled = true; });
  inFlight.resolve(rootA); // the old root's result lands late
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.state.count, 2, 'the new-root refresh started');
  assert.equal(resetSettled, false, 'reset remains pending for the refresh it requested');
  rootBInFlight.resolve(rootB);
  await Promise.all([stale, reset]);
  assert.equal(store.getBranch(), 'root-b', 'the late root-A result never overwrites root B');
  assert.deepEqual(store.getSnapshot().files, []);
});

test('dispose stops further refreshes and clears subscribers', async () => {
  const client = fakeClient(repoResult());
  const store = createIdeGitStatusStore({ client });
  let notifications = 0;
  store.subscribe(() => { notifications += 1; });
  await store.refreshNow();
  const baseline = client.state.count;
  store.dispose();
  store.refresh();
  await store.refreshNow();
  await settle(10);
  assert.equal(client.state.count, baseline, 'no fetch after dispose');
  assert.equal(notifications, 1, 'no notify after dispose');
});
