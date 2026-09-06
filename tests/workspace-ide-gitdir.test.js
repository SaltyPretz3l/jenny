'use strict';

// WIDE-028 (b): trusted git-layout resolution + end-to-end git-metadata
// freshness against REAL repositories. A regular repo keeps HEAD/index/refs
// under <root>/.git; a linked worktree's
// `.git` is a FILE pointing at <main>/.git/worktrees/<name>, whose metadata
// lives entirely outside the root - the watcher arms auxiliary watches there.
//
// The real-fs.watch integration tests use a bounded waitFor (poll until the
// signal or a hard deadline) because native watch delivery latency is not
// deterministic; the assertions themselves are exact.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { resolveGitMetaLayout } = require('../services/workspace-ide-gitdir');
const { createWorkspaceIdeWatcher } = require('../services/workspace-ide-watcher');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

const execFileAsync = promisify(execFile);

function git(cwd, args) {
  return execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
}

async function createGitRepo(prefix = 'jenny-ide-gitdir-') {
  const repoRoot = createTrackedTempDir(prefix);
  await git(repoRoot, ['init']);
  await git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(repoRoot, ['config', 'user.email', 'jenny@example.invalid']);
  await git(repoRoot, ['config', 'user.name', 'Jenny Tests']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  await git(repoRoot, ['config', 'core.autocrlf', 'false']);
  await fsPromises.writeFile(path.join(repoRoot, 'README.md'), 'one\n', 'utf8');
  await git(repoRoot, ['add', 'README.md']);
  await git(repoRoot, ['commit', '-m', 'initial']);
  return repoRoot;
}

// Bounded condition wait for native watch delivery (25ms poll, hard deadline).
async function waitFor(condition, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return condition();
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// ── resolveGitMetaLayout: unit (injected fs) ─────────────────────────────────

function fakeFsFor({ entries = {}, files = {} } = {}) {
  return {
    async lstat(target) {
      const kind = entries[target];
      if (!kind) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return { isDirectory: () => kind === 'directory', isFile: () => kind === 'file' };
    },
    async readFile(target) {
      if (!(target in files)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return files[target];
    },
  };
}

test('wide-028: resolveGitMetaLayout classifies a .git directory as internal', async () => {
  const root = 'C:\\ws';
  const dotGit = path.join(root, '.git');
  const layout = await resolveGitMetaLayout(root, {
    fs: fakeFsFor({ entries: { [dotGit]: 'directory' } }),
  });
  assert.deepEqual(layout, { mode: 'internal', gitDir: dotGit, commonDir: dotGit });
});

test('wide-028: resolveGitMetaLayout resolves a linked-worktree .git file plus commondir', async () => {
  const root = 'C:\\wt';
  const dotGit = path.join(root, '.git');
  const gitDir = 'C:\\repo\\.git\\worktrees\\wt';
  const layout = await resolveGitMetaLayout(root, {
    fs: fakeFsFor({
      entries: { [dotGit]: 'file' },
      files: {
        [dotGit]: `gitdir: ${gitDir}\n`,
        [path.join(gitDir, 'commondir')]: '../..\n',
      },
    }),
  });
  assert.equal(layout.mode, 'external');
  assert.equal(layout.gitDir, path.resolve(gitDir));
  assert.equal(layout.commonDir, path.resolve(gitDir, '../..'), 'commondir resolves relative to gitDir');
});

test('wide-028: resolveGitMetaLayout handles a relative gitdir pointer and a missing commondir', async () => {
  const root = 'C:\\sub';
  const dotGit = path.join(root, '.git');
  const layout = await resolveGitMetaLayout(root, {
    fs: fakeFsFor({
      entries: { [dotGit]: 'file' },
      files: { [dotGit]: 'gitdir: ../parent/.git/modules/sub\n' },
    }),
  });
  assert.equal(layout.mode, 'external');
  assert.equal(layout.gitDir, path.resolve(root, '../parent/.git/modules/sub'), 'relative pointers resolve against the root');
  assert.equal(layout.commonDir, layout.gitDir, 'no commondir file -> the gitdir owns all its metadata');
});

test('wide-028: resolveGitMetaLayout returns none for missing, malformed, or oversized .git entries', async () => {
  const root = 'C:\\plain';
  const dotGit = path.join(root, '.git');
  assert.deepEqual(await resolveGitMetaLayout(root, { fs: fakeFsFor({}) }), { mode: 'none' });
  assert.deepEqual(await resolveGitMetaLayout('', { fs: fakeFsFor({}) }), { mode: 'none' });
  assert.deepEqual(
    await resolveGitMetaLayout(root, {
      fs: fakeFsFor({ entries: { [dotGit]: 'file' }, files: { [dotGit]: 'not a pointer\n' } }),
    }),
    { mode: 'none' },
    'a malformed pointer file is refused, not guessed at'
  );
  assert.deepEqual(
    await resolveGitMetaLayout(root, {
      fs: fakeFsFor({ entries: { [dotGit]: 'file' }, files: { [dotGit]: `gitdir: ${'x'.repeat(5000)}\n` } }),
    }),
    { mode: 'none' },
    'an oversized pointer file is refused'
  );
});

// ── resolveGitMetaLayout + watcher: REAL repositories ────────────────────────

test('wide-028: a real `git worktree add` resolves to the external layout', async () => {
  const repo = await createGitRepo();
  const wtRoot = path.join(createTrackedTempDir('jenny-ide-wt-'), 'wt');
  await git(repo, ['worktree', 'add', wtRoot, '-b', 'wt-branch']);

  const mainLayout = await resolveGitMetaLayout(repo);
  assert.equal(mainLayout.mode, 'internal', 'the main checkout keeps its metadata under <root>/.git');

  const wtLayout = await resolveGitMetaLayout(wtRoot);
  assert.equal(wtLayout.mode, 'external');
  assert.ok(
    /[\\/]\.git[\\/]worktrees[\\/]/.test(wtLayout.gitDir),
    `the worktree gitDir lives under the main repo (${wtLayout.gitDir})`
  );
  assert.equal(
    path.resolve(wtLayout.commonDir).toLowerCase(),
    path.resolve(repo, '.git').toLowerCase(),
    'commonDir is the shared main .git'
  );
  assert.ok(fs.existsSync(path.join(wtLayout.gitDir, 'HEAD')), 'the external gitDir holds the worktree HEAD');
});

function startRealWatcher(root) {
  const gitMetaEvents = [];
  const changes = [];
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => root,
    emitChange: (payload) => changes.push(payload),
    emitGitMeta: () => gitMetaEvents.push(Date.now()),
    debounceMs: 20,
  });
  watcher.start();
  return { watcher, gitMetaEvents, changes };
}

test('wide-028: external `git add` then `git reset` in a real repo fire SCM refresh signals', async () => {
  const repo = await createGitRepo();
  await fsPromises.writeFile(path.join(repo, 'staged.txt'), 'body\n', 'utf8');
  const { watcher, gitMetaEvents } = startRealWatcher(repo);
  try {
    // External stage: only .git/index moves. Before WIDE-028 this emitted
    // nothing and the SCM panel stayed stale until an unrelated file changed.
    await git(repo, ['add', 'staged.txt']);
    assert.equal(
      await waitFor(() => gitMetaEvents.length >= 1),
      true,
      'an external git add produced a git-meta refresh signal'
    );

    const afterAdd = gitMetaEvents.length;
    await git(repo, ['reset']);
    assert.equal(
      await waitFor(() => gitMetaEvents.length > afterAdd),
      true,
      'an external git reset produced a git-meta refresh signal'
    );
  } finally {
    watcher.stop();
  }
});

test('wide-028: an external commit in a real repo fires an SCM refresh signal', async () => {
  const repo = await createGitRepo();
  const { watcher, gitMetaEvents } = startRealWatcher(repo);
  try {
    await fsPromises.writeFile(path.join(repo, 'README.md'), 'two\n', 'utf8');
    await git(repo, ['add', 'README.md']);
    assert.equal(
      await waitFor(() => gitMetaEvents.length >= 1),
      true,
      'the external git add produced a git-meta refresh signal'
    );
    const beforeCommit = gitMetaEvents.length;

    await git(repo, ['commit', '-m', 'external edit']);
    assert.equal(
      await waitFor(() => gitMetaEvents.length > beforeCommit),
      true,
      'an external commit produced a git-meta refresh signal'
    );
  } finally {
    watcher.stop();
  }
});

test('wide-028: git-meta refresh trails the complete metadata burst', () => {
  const watches = [];
  const gitMetaEvents = [];
  const timers = new Map();
  let timerId = 0;
  const watcher = createWorkspaceIdeWatcher({
    getRoot: () => 'C:\\workspace',
    emitChange: () => {},
    emitGitMeta: () => gitMetaEvents.push(Date.now()),
    watchImpl: (_root, _options, listener) => {
      const native = {
        emit: (eventType, filename) => listener(eventType, filename),
        on() { return native; },
        close() {},
      };
      watches.push(native);
      return native;
    },
    setTimeoutImpl: (callback) => {
      const handle = { id: ++timerId, unref() {} };
      timers.set(handle, callback);
      return handle;
    },
    clearTimeoutImpl: (handle) => timers.delete(handle),
  });
  watcher.start();

  watches[0].emit('change', '.git\\index');
  const [firstTimer] = timers.keys();
  watches[0].emit('change', '.git\\refs\\heads\\main');

  assert.equal(timers.has(firstTimer), false, 'a later metadata event replaces the earlier timer');
  assert.equal(timers.size, 1, 'the burst retains one trailing refresh');
  const [activeTimer] = timers.keys();
  const emit = timers.get(activeTimer);
  timers.delete(activeTimer);
  emit();
  assert.equal(gitMetaEvents.length, 1);
  watcher.stop();
});

test('wide-028: a branch change inside a real linked worktree fires an SCM refresh signal', async () => {
  const repo = await createGitRepo();
  const wtRoot = path.join(createTrackedTempDir('jenny-ide-wt-'), 'wt');
  await git(repo, ['worktree', 'add', wtRoot, '-b', 'wt-branch']);
  const { watcher, gitMetaEvents } = startRealWatcher(wtRoot);
  try {
    // Give the async aux arm a moment to attach to the EXTERNAL gitDir.
    await waitFor(() => false, { timeoutMs: 150 });
    // The branch switch rewrites HEAD in <main>/.git/worktrees/wt - entirely
    // outside the watched root; only the aux watch can see it.
    await git(wtRoot, ['checkout', '-b', 'wt-second']);
    assert.equal(
      await waitFor(() => gitMetaEvents.length >= 1),
      true,
      'the external-worktree HEAD move produced a git-meta refresh signal'
    );
  } finally {
    watcher.stop();
  }
});
