'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  createWorkspaceIdeWatcher,
  normalizeWatchedRelPath,
  isGitMetaPath,
} = require('../services/workspace-ide-watcher');
const { WORKSPACE_FS_ERROR_CODES } = require('../services/workspace-ide-errors');
const { workspaceIdePathKey } = require('../services/workspace-ide-config-schema');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createFakeWatchImpl() {
  const watchers = [];
  const impl = (root, options, listener) => {
    const watcher = {
      root,
      options,
      listener,
      closed: false,
      close() {
        this.closed = true;
      },
      errorHandler: null,
      on(event, handler) { if (event === 'error') this.errorHandler = handler; },
      emitError(error) { this.errorHandler?.(error); },
      emit(eventType, filename) {
        listener(eventType, filename);
      },
    };
    watchers.push(watcher);
    return watcher;
  };
  impl.watchers = watchers;
  return impl;
}

function createHarness({ root = 'C:\\ws', files = {}, recentWrites = new Set(), maxBatch = 500 } = {}) {
  const state = { root, files, recentWrites };
  const payloads = [];
  const gitMetaEvents = [];
  const lifecycleEvents = [];
  const logs = [];
  const watchImpl = createFakeWatchImpl();
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => state.root,
    service: {
      consumeRecentWrite: (absPath, stats) => state.recentWrites.delete(`${absPath}|${stats?.mtimeMs}`),
    },
    emitChange: (payload) => payloads.push(payload),
    emitGitMeta: () => gitMetaEvents.push(Date.now()),
    emitLifecycle: (payload) => lifecycleEvents.push(payload),
    logger: (level, event, details) => logs.push({ level, event, details }),
    watchImpl,
    statImpl: async (absPath) => {
      const entry = state.files[absPath];
      return entry ? { mtimeMs: entry.mtimeMs } : null;
    },
    debounceMs: 20,
    maxBatch,
  });
  return { state, watcher, watchImpl, payloads, gitMetaEvents, lifecycleEvents, logs };
}

test('workspace-ide-watcher coalesces events and classifies changed vs deleted', async () => {
  const root = 'C:\\ws';
  const { state, watcher, watchImpl, payloads } = createHarness({ root });
  state.files[path.join(root, 'src/app.js')] = { mtimeMs: 111 };
  watcher.start();
  const [fake] = watchImpl.watchers;

  // Native win32 events arrive with backslashes; duplicates coalesce.
  fake.emit('change', 'src\\app.js');
  fake.emit('change', 'src\\app.js');
  fake.emit('rename', 'src\\gone.js');
  await sleep(80);

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].truncated, false);
  assert.equal(payloads[0].context.generation, 0);
  assert.match(payloads[0].context.rootId, /^legacy-/);
  assert.deepEqual(
    payloads[0].changes.sort((a, b) => a.relPath.localeCompare(b.relPath)),
    [
      { relPath: 'src/app.js', pathKey: workspaceIdePathKey('src/app.js'), kind: 'changed' },
      { relPath: 'src/gone.js', pathKey: workspaceIdePathKey('src/gone.js'), kind: 'deleted' },
    ]
  );
  watcher.stop();
});

test('workspace-ide-watcher suppresses self-writes via the recent-writes record', async () => {
  const root = 'C:\\ws';
  const { state, watcher, watchImpl, payloads } = createHarness({ root });
  const selfPath = path.join(root, 'self.txt');
  const externalPath = path.join(root, 'external.txt');
  state.files[selfPath] = { mtimeMs: 500 };
  state.files[externalPath] = { mtimeMs: 900 };
  state.recentWrites.add(`${selfPath}|500`);
  watcher.start();
  const [fake] = watchImpl.watchers;

  fake.emit('change', 'self.txt');
  fake.emit('change', 'external.txt');
  await sleep(80);

  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].changes, [{
    relPath: 'external.txt', pathKey: workspaceIdePathKey('external.txt'), kind: 'changed',
  }]);
  fake.emit('change', 'self.txt');
  await sleep(80);
  assert.deepEqual(payloads[1].changes, [{
    relPath: 'self.txt', pathKey: workspaceIdePathKey('self.txt'), kind: 'changed',
  }], 'legacy self-write suppression is consumed exactly once');
  watcher.stop();
});

test('workspace-ide-watcher drops invalid, .git, and service temp-file paths', async () => {
  const { watcher, watchImpl, payloads } = createHarness({});
  watcher.start();
  const [fake] = watchImpl.watchers;

  fake.emit('rename', '..\\outside.txt');
  fake.emit('rename', 'C:\\absolute.txt');
  fake.emit('change', '.git\\config');
  fake.emit('change', 'src\\.git\\HEAD');
  fake.emit('rename', 'src\\file.txt.tmp-1749600000000-a1b2c3d4');
  fake.emit('rename', 'src\\.file.txt.jenny-vfs-123-a1b2c3d4');
  fake.emit('rename', '');
  await sleep(80);

  assert.deepEqual(payloads, []);
  watcher.stop();
});

test('workspace-ide-watcher emits one coalesced git-meta signal for ref/HEAD moves, never a file payload', async () => {
  const { watcher, watchImpl, payloads, gitMetaEvents } = createHarness({});
  watcher.start();
  const [fake] = watchImpl.watchers;

  // A single external commit/checkout touches several `.git` ref entries in a
  // burst; they must coalesce into ONE refresh signal and produce no file-change
  // payload (the tree/editor reconcile path must never see a `.git` path).
  fake.emit('change', '.git\\HEAD');
  fake.emit('change', '.git\\refs\\heads\\main');
  fake.emit('change', '.git\\packed-refs');
  await sleep(80);

  assert.equal(payloads.length, 0, 'no file-change payload for .git ref moves');
  assert.equal(gitMetaEvents.length, 1, 'a burst of ref writes coalesces to one git-meta signal');
  watcher.stop();
});

test('workspace-ide-watcher treats .git/index as a git-meta move (external stage/reset), never .git/config', async () => {
  // WIDE-028 (b): external `git add`/`git reset` touch ONLY the index; before
  // this fix they emitted nothing and the SCM view stayed stale. The self-echo
  // loop the old exclusion feared is broken at the source instead: every
  // workspace git invocation runs with GIT_OPTIONAL_LOCKS=0, so our own
  // `git status` re-pull can never rewrite the index. .git/config is still not
  // a metadata move, and lock-file churn never matches.
  const { watcher, watchImpl, payloads, gitMetaEvents } = createHarness({});
  watcher.start();
  const [fake] = watchImpl.watchers;

  fake.emit('change', '.git\\index');
  fake.emit('rename', '.git\\index.lock');
  fake.emit('change', '.git\\config');
  fake.emit('change', 'src\\.git\\HEAD'); // nested repo, not the workspace root .git
  await sleep(80);

  assert.equal(payloads.length, 0, 'no file-change payload for .git paths');
  assert.equal(gitMetaEvents.length, 1, 'an external index write coalesces to one git-meta signal');
  watcher.stop();
});

test('isGitMetaPath matches root .git HEAD/refs/packed-refs/index entries only', () => {
  assert.equal(isGitMetaPath('.git/HEAD'), true);
  assert.equal(isGitMetaPath('.git\\HEAD'), true);
  assert.equal(isGitMetaPath('.git/refs/heads/main'), true);
  assert.equal(isGitMetaPath('.git/packed-refs'), true);
  assert.equal(isGitMetaPath('.git/index'), true);
  assert.equal(isGitMetaPath('.git\\index'), true);
  assert.equal(isGitMetaPath('.git/index.lock'), false);
  assert.equal(isGitMetaPath('.git/config'), false);
  assert.equal(isGitMetaPath('.git'), false);
  assert.equal(isGitMetaPath('src/.git/HEAD'), false);
  assert.equal(isGitMetaPath('refs/heads/main'), false);
  assert.equal(isGitMetaPath(''), false);
});

test('workspace-ide-watcher caps a batch and flags truncation', async () => {
  const root = 'C:\\ws';
  const { state, watcher, watchImpl, payloads } = createHarness({ root, maxBatch: 2 });
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    state.files[path.join(root, name)] = { mtimeMs: 1 };
  }
  watcher.start();
  const [fake] = watchImpl.watchers;

  fake.emit('change', 'a.txt');
  fake.emit('change', 'b.txt');
  fake.emit('change', 'c.txt');
  await sleep(80);

  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].changes.length, 2);
  assert.equal(payloads[0].truncated, true);
  watcher.stop();
});

test('workspace-ide-watcher start errors map to ROOT_MISSING and WATCH_FAILED', () => {
  const { watcher } = createHarness({ root: '' });
  assert.throws(() => watcher.start(), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.ROOT_MISSING);
    return true;
  });

  const failing = createWorkspaceIdeWatcher({
    getRoot: () => 'C:\\ws',
    emitChange: () => {},
    watchImpl: () => {
      throw new Error('EPERM-ish');
    },
  });
  assert.throws(() => failing.start(), (error) => {
    assert.equal(error.code, WORKSPACE_FS_ERROR_CODES.WATCH_FAILED);
    return true;
  });
  assert.equal(failing.isRunning(), false);
});

test('workspace-ide-watcher start is idempotent and syncRoot follows root changes', () => {
  const { state, watcher, watchImpl } = createHarness({ root: 'C:\\ws-one' });
  watcher.start();
  watcher.start();
  assert.equal(watchImpl.watchers.length, 1);
  assert.equal(watcher.getWatchedRoot(), 'C:\\ws-one');

  // syncRoot with an unchanged root is a no-op.
  watcher.syncRoot();
  assert.equal(watchImpl.watchers.length, 1);

  state.root = 'C:\\ws-two';
  watcher.syncRoot();
  assert.equal(watchImpl.watchers.length, 2);
  assert.equal(watchImpl.watchers[0].closed, true);
  assert.equal(watcher.getWatchedRoot(), 'C:\\ws-two');

  state.root = '';
  watcher.syncRoot();
  assert.equal(watcher.isRunning(), false);
  assert.equal(watchImpl.watchers[1].closed, true);

  // A stopped watcher stays stopped on further root changes.
  state.root = 'C:\\ws-three';
  watcher.syncRoot();
  assert.equal(watcher.isRunning(), false);
});

test('workspace-ide-watcher binds native callbacks to root generation and ignores stale watcher errors', async () => {
  const contexts = {
    current: { rootPath: 'C:\\one', rootId: 'root-one', generation: 1, phase: 'ready' },
  };
  const files = new Map();
  const payloads = [];
  const watchImpl = createFakeWatchImpl();
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => contexts.current.rootPath,
    getContext: () => contexts.current,
    emitChange: (payload) => payloads.push(payload),
    watchImpl,
    statImpl: async (absPath) => files.get(absPath) || null,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  watcher.start(contexts.current);
  const oldWatcher = watchImpl.watchers[0];
  contexts.current = { rootPath: 'C:\\two', rootId: 'root-two', generation: 2, phase: 'ready' };
  watcher.start(contexts.current);
  const currentWatcher = watchImpl.watchers[1];
  files.set(path.join(contexts.current.rootPath, 'current.txt'), {
    dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5,
  });

  oldWatcher.emit('change', 'stale.txt');
  oldWatcher.emitError(Object.assign(new Error('late old error'), { code: 'EIO' }));
  currentWatcher.emit('change', 'current.txt');
  await watcher.flush();

  assert.equal(watcher.isRunning(), true);
  assert.equal(watcher.getWatchedContext().rootId, 'root-two');
  assert.deepEqual(payloads, [{
    context: { rootId: 'root-two', generation: 2 },
    changes: [{ relPath: 'current.txt', pathKey: workspaceIdePathKey('current.txt'), kind: 'changed' }],
    truncated: false,
  }]);
  watcher.stop();
});

test('workspace-ide-watcher defers candidate events until the coordinator publishes ready', async () => {
  const candidate = { rootPath: 'C:\\next', rootId: 'root-next', generation: 8, phase: 'transitioning' };
  let live = { rootPath: 'C:\\old', rootId: 'root-old', generation: 8, phase: 'transitioning' };
  const payloads = [];
  const watchImpl = createFakeWatchImpl();
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => live.rootPath,
    getContext: () => live,
    emitChange: (payload) => payloads.push(payload),
    watchImpl,
    statImpl: async () => ({ dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 }),
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  watcher.start(candidate);
  watchImpl.watchers[0].emit('change', 'ready-later.txt');
  await watcher.flush();
  assert.deepEqual(payloads, []);

  live = { ...candidate, phase: 'ready' };
  await watcher.flush();
  assert.equal(payloads.length, 1);
  assert.deepEqual(payloads[0].context, { rootId: 'root-next', generation: 8 });
  watcher.stop();
});

test('workspace-ide-watcher two-phase write observation suppresses canonical events once and abort fails open', async () => {
  const context = { rootPath: 'C:\\ws', rootId: 'root-a', generation: 3, phase: 'ready' };
  const stats = { dev: 1, ino: 9, size: 4, mtimeMs: 10, ctimeMs: 11 };
  const payloads = [];
  const watchImpl = createFakeWatchImpl();
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => context.rootPath,
    getContext: () => context,
    emitChange: (payload) => payloads.push(payload),
    watchImpl,
    statImpl: async () => stats,
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  watcher.start(context);
  const native = watchImpl.watchers[0];
  const identity = {
    path: 'note.txt', pathKey: workspaceIdePathKey('note.txt'),
    rootId: context.rootId, generation: context.generation,
  };

  const committed = watcher.writeObserver.begin(identity);
  native.emit('change', 'note.txt');
  await watcher.flush();
  assert.deepEqual(payloads, [], 'an active canonical write holds its native event');
  assert.equal(watcher.writeObserver.commit(committed, stats), true);
  native.emit('change', 'note.txt');
  await watcher.flush();
  assert.deepEqual(payloads, [], 'the late duplicate is consumed once');
  native.emit('change', 'note.txt');
  await watcher.flush();
  assert.equal(payloads.length, 1, 'a later genuine event is not hidden indefinitely');

  const aborted = watcher.writeObserver.begin(identity);
  native.emit('change', 'note.txt');
  await watcher.flush();
  assert.equal(watcher.writeObserver.abort(aborted), true);
  await watcher.flush();
  assert.equal(payloads.length, 2, 'aborting a durability-uncertain write releases the held change');
  watcher.stop();
});

// ---------------------------------------------------------------------------
// WIDE-028 (a): watcher lifecycle is observable — a native error is no longer
// a silent stop, and every teardown/start announces itself with a typed phase.
// ---------------------------------------------------------------------------

test('wide-028: start announces watching; a native error announces degraded with the error code', () => {
  const { watcher, watchImpl, lifecycleEvents } = createHarness({});
  watcher.start();
  assert.equal(lifecycleEvents.length, 1);
  assert.equal(lifecycleEvents[0].phase, 'watching');
  assert.match(lifecycleEvents[0].context.rootId, /^legacy-/);

  const [fake] = watchImpl.watchers;
  fake.emitError(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
  assert.equal(watcher.isRunning(), false, 'the native error stopped the watch');
  assert.equal(lifecycleEvents.length, 2);
  assert.deepEqual(
    { phase: lifecycleEvents[1].phase, reason: lifecycleEvents[1].reason },
    { phase: 'degraded', reason: 'ENOSPC' },
    'the death is pushed as degraded (not silent) with the native code as reason'
  );

  // The renderer latch reset by that push makes THIS restart possible.
  watcher.start();
  assert.equal(watcher.isRunning(), true, 'a restart after the degraded push succeeds');
  assert.equal(lifecycleEvents[2].phase, 'watching');
  watcher.stop();
});

test('wide-028: an orderly stop announces stopped; a root-switch restart announces restarting then watching', () => {
  const { state, watcher, lifecycleEvents } = createHarness({ root: 'C:\\ws-one' });
  watcher.start();
  state.root = 'C:\\ws-two';
  watcher.syncRoot();
  assert.deepEqual(
    lifecycleEvents.map((e) => [e.phase, e.reason]),
    [['watching', ''], ['stopped', 'restarting'], ['watching', '']],
    'the root switch is a restarting teardown followed immediately by watching'
  );

  watcher.stop();
  assert.deepEqual(
    lifecycleEvents.at(-1),
    { phase: 'stopped', reason: 'stopped', context: { rootId: lifecycleEvents.at(-1).context.rootId, generation: 0 } },
    'an explicit stop announces a plain stopped'
  );
  // An idle stop (nothing live) announces nothing.
  const before = lifecycleEvents.length;
  watcher.stop();
  assert.equal(lifecycleEvents.length, before, 'a stop with no live watch is silent');
});

test('wide-028: a throwing lifecycle bridge never derails the watcher', () => {
  const watchImpl = createFakeWatchImpl();
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => 'C:\\ws',
    emitChange: () => {},
    emitLifecycle: () => { throw new Error('window mid-teardown'); },
    watchImpl,
  });
  assert.deepEqual(watcher.start(), { watching: true }, 'start survives a throwing lifecycle sink');
  assert.equal(watcher.isRunning(), true);
  watcher.stop();
  assert.equal(watcher.isRunning(), false, 'stop survives it too');
});

test('wide-028: truncated/null-filename native events do not wedge the watch lifecycle', async () => {
  const root = 'C:\\ws';
  const { state, watcher, watchImpl, payloads, lifecycleEvents } = createHarness({ root });
  state.files[path.join(root, 'real.txt')] = { mtimeMs: 7 };
  watcher.start();
  const [fake] = watchImpl.watchers;

  // Node's fs.watch can deliver a null/undefined filename (event truncation);
  // the raw handler must drop it without erroring or stopping the watch.
  fake.emit('rename', null);
  fake.emit('change', undefined);
  fake.emit('change', '');
  await sleep(80);
  assert.equal(watcher.isRunning(), true, 'null-filename events do not stop the watch');
  assert.equal(payloads.length, 0, 'nothing to emit for an unattributable event');
  assert.equal(lifecycleEvents.filter((e) => e.phase === 'degraded').length, 0, 'no degraded push');

  // The watch keeps delivering real events afterwards.
  fake.emit('change', 'real.txt');
  await sleep(80);
  assert.equal(payloads.length, 1, 'a later attributable event still flows');
  watcher.stop();
});

// ---------------------------------------------------------------------------
// WIDE-028 (b): linked-worktree git metadata lives OUTSIDE the root; the
// watcher arms auxiliary watches on the resolved gitDir/commonDir/refs.
// ---------------------------------------------------------------------------

function createExternalLayoutHarness({ layout } = {}) {
  const gitMetaEvents = [];
  const watchImpl = createFakeWatchImpl();
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => 'C:\\wt-root',
    emitChange: () => {},
    emitGitMeta: () => gitMetaEvents.push(Date.now()),
    resolveGitMetaLayoutImpl: async () => layout,
    watchImpl,
    debounceMs: 20,
  });
  return { watcher, watchImpl, gitMetaEvents };
}

const EXTERNAL_LAYOUT = Object.freeze({
  mode: 'external',
  gitDir: 'C:\\repo\\.git\\worktrees\\wt',
  commonDir: 'C:\\repo\\.git',
});

test('wide-028: an external layout arms aux watches on gitDir, commonDir, and commonDir/refs', async () => {
  const { watcher, watchImpl } = createExternalLayoutHarness({ layout: EXTERNAL_LAYOUT });
  watcher.start();
  await sleep(20); // let the async arm settle
  const roots = watchImpl.watchers.map((w) => w.root);
  assert.deepEqual(roots.slice(1), [
    'C:\\repo\\.git\\worktrees\\wt',
    'C:\\repo\\.git',
    path.join('C:\\repo\\.git', 'refs'),
  ], 'gitDir (HEAD/index), commonDir (packed-refs), and refs/ are all covered');
  assert.equal(watchImpl.watchers[3].options.recursive, true, 'refs/ is watched recursively');
  assert.equal(watchImpl.watchers[1].options.recursive, false, 'gitDir is watched flat');

  watcher.stop();
  assert.ok(watchImpl.watchers.every((w) => w.closed), 'stop closes the aux watches with the main one');
});

test('wide-028: an internal layout (regular repo) arms no aux watches - the root watch covers .git', async () => {
  const { watcher, watchImpl } = createExternalLayoutHarness({
    layout: { mode: 'internal', gitDir: 'C:\\wt-root\\.git', commonDir: 'C:\\wt-root\\.git' },
  });
  watcher.start();
  await sleep(20);
  assert.equal(watchImpl.watchers.length, 1, 'only the root watch exists');
  watcher.stop();
});

test('wide-028: aux events (external HEAD/index/refs moves) coalesce into git-meta; lock churn is ignored', async () => {
  const { watcher, watchImpl, gitMetaEvents } = createExternalLayoutHarness({ layout: EXTERNAL_LAYOUT });
  watcher.start();
  await sleep(20);
  const [, gitDirWatch, , refsWatch] = watchImpl.watchers;

  // External `git -C <worktree> checkout -b` (linked worktree): HEAD in the
  // external gitDir moves and a ref is born under the shared refs/.
  gitDirWatch.emit('change', 'HEAD');
  gitDirWatch.emit('rename', 'index.lock'); // lock churn must not double-fire
  refsWatch.emit('rename', 'heads\\feature');
  await sleep(80);
  assert.equal(gitMetaEvents.length, 1, 'the external metadata burst coalesces to one refresh signal');

  // External `git add` in the worktree: only the external index moves.
  gitDirWatch.emit('change', 'index');
  await sleep(80);
  assert.equal(gitMetaEvents.length, 2, 'an external stage refreshes too');
  watcher.stop();
});

test('wide-028: a failing aux watch degrades git freshness only - the file watch stays up', async () => {
  const gitMetaEvents = [];
  const watchImpl = createFakeWatchImpl();
  let watchCalls = 0;
  const failingWatchImpl = (root, options, listener) => {
    watchCalls += 1;
    if (watchCalls > 1) throw Object.assign(new Error('EPERM aux'), { code: 'EPERM' });
    return watchImpl(root, options, listener);
  };
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => 'C:\\wt-root',
    emitChange: () => {},
    emitGitMeta: () => gitMetaEvents.push(Date.now()),
    resolveGitMetaLayoutImpl: async () => EXTERNAL_LAYOUT,
    watchImpl: failingWatchImpl,
    debounceMs: 20,
  });
  watcher.start();
  await sleep(20);
  assert.equal(watcher.isRunning(), true, 'aux failures never take down the main watch');
  watcher.stop();
});

test('wide-028: an arm resolving after stop() is discarded (epoch guard)', async () => {
  let releaseLayout;
  const watchImpl = createFakeWatchImpl();
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => 'C:\\wt-root',
    emitChange: () => {},
    resolveGitMetaLayoutImpl: () => new Promise((resolve) => { releaseLayout = resolve; }),
    watchImpl,
    debounceMs: 20,
  });
  watcher.start();
  watcher.stop();
  releaseLayout(EXTERNAL_LAYOUT);
  await sleep(20);
  assert.equal(watchImpl.watchers.length, 1, 'no aux watch is armed for a stopped epoch');
  assert.ok(watchImpl.watchers[0].closed);
});

test('normalizeWatchedRelPath applies the lexical gate', () => {
  assert.equal(normalizeWatchedRelPath('src\\nested\\file.txt'), 'src/nested/file.txt');
  assert.equal(normalizeWatchedRelPath('./src/file.txt'), 'src/file.txt');
  assert.equal(normalizeWatchedRelPath('../escape.txt'), '');
  assert.equal(normalizeWatchedRelPath('C:/abs.txt'), '');
  assert.equal(normalizeWatchedRelPath('/abs.txt'), '');
  assert.equal(normalizeWatchedRelPath('.git/config'), '');
  assert.equal(normalizeWatchedRelPath(`bad${String.fromCharCode(0)}name`), '');
  assert.equal(normalizeWatchedRelPath(''), '');
});
