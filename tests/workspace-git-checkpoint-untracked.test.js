'use strict';

// Row 34 A1: checkpoints capture untracked files as a stash -u-shaped third
// parent without touching the real index or the working tree, and restore
// writes them back without deleting anything. Real-repo tests cover the
// round-trip, byte-identical index/status, caps, symlink/junction escape,
// forced mid-way failure, old checkpoints and path conflicts; unit tests cover
// the pure helpers.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { WorkspaceGitService } = require('../services/workspace-git-service');
const { createWorkspaceGitCheckpointApi } = require('../services/workspace-git-checkpoint');
const {
  DEFAULT_UNTRACKED_LIMITS,
  cQuotePath,
  directoriesByDepth,
  planUntrackedCapture,
  treePathIsSafe,
} = require('../services/workspace-git-checkpoint-untracked');
const { probeHeadState } = require('../services/workspace-git-root-guard');
const { runWorkspaceGit } = require('../services/workspace-git-executor');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

const execFileAsync = promisify(execFile);
// The test's own status reads must not refresh the index they compare.
const READ_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
const INDEX_VERBS = new Set(['update-index', 'read-tree', 'write-tree', 'checkout-index', 'add', 'reset', 'rm', 'mv']);

function git(cwd, args) {
  return execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8', env: READ_ENV });
}

async function createGitRepo() {
  const repoRoot = createTrackedTempDir('jenny-git-untracked-');
  await git(repoRoot, ['init']);
  await git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(repoRoot, ['config', 'user.email', 'jenny@example.invalid']);
  await git(repoRoot, ['config', 'user.name', 'Jenny Tests']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  await git(repoRoot, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'line1\nline2\n', 'utf8');
  await git(repoRoot, ['add', 'README.md']);
  await git(repoRoot, ['commit', '-m', 'initial']);
  return repoRoot;
}

function createService(root) {
  return new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_git: true }),
    logger() {},
  });
}

function directApi(root, { exec = runWorkspaceGit, untrackedLimits } = {}) {
  return createWorkspaceGitCheckpointApi({
    runTransaction: async (op, handler) => handler({
      root,
      signal: null,
      isCurrent: () => true,
      stale: () => ({ ok: false, available: false, isRepo: false, op, reason: 'root_changed' }),
    }),
    exec: (cwd, args, options) => exec(cwd, args, options),
    execFailure: (op, result) => ({
      ok: false, available: true, isRepo: true, op,
      reason: result?.reason || 'git_failed',
      message: result?.message || '',
    }),
    probeHeadState,
    ...(untrackedLimits ? { untrackedLimits } : {}),
  });
}

// Porcelain status (all untracked files) plus the raw index bytes.
async function repoState(repo) {
  const status = (await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout;
  const index = await fs.readFile(path.join(repo, '.git', 'index'));
  return { status, index };
}

async function parentCount(repo, sha) {
  const out = (await git(repo, ['rev-list', '--parents', '-n', '1', sha])).stdout.trim();
  return out.split(/\s+/).length - 1;
}

async function untrackedTreePaths(repo, sha) {
  const out = (await git(repo, ['ls-tree', '-r', '-z', '--name-only', `${sha}^3`])).stdout;
  return out.split('\0').filter(Boolean).sort();
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('untracked checkpoint capture (real repo)', () => {
  test('an untracked file is captured, the index and status stay byte-identical, and restore brings it back', async () => {
    const repo = await createGitRepo();
    const notes = Buffer.from('print("hi")\r\nmixed\nendings\0binary\xff', 'latin1');
    await fs.writeFile(path.join(repo, 'notes.py'), notes);
    await fs.mkdir(path.join(repo, 'src', 'lib'), { recursive: true });
    await fs.writeFile(path.join(repo, 'src', 'lib', 'util.py'), 'x = 1\n', 'utf8');
    await git(repo, ['status']);
    const before = await repoState(repo);

    const svc = createService(repo);
    const created = await svc.createCheckpoint({ session: 'sess_untracked' });
    assert.equal(created.created, true, JSON.stringify(created));
    assert.deepEqual(
      { captured: created.untracked.captured, skipped: created.untracked.skipped, reason: created.untracked.reason },
      { captured: 2, skipped: 0, reason: '' }
    );
    const after = await repoState(repo);
    assert.equal(after.status, before.status, 'git status output is identical');
    assert.ok(after.index.equals(before.index), 'the real index file is byte-identical');
    assert.equal(await parentCount(repo, created.sha), 3, 'stash -u shape: HEAD, index, untracked');
    assert.deepEqual(await untrackedTreePaths(repo, created.sha), ['notes.py', 'src/lib/util.py']);

    await fs.rm(path.join(repo, 'notes.py'));
    await fs.rm(path.join(repo, 'src'), { recursive: true });
    await fs.writeFile(path.join(repo, 'later.txt'), 'created after the checkpoint\n', 'utf8');

    const restored = await svc.restoreCheckpoint({ ref: created.ref });
    assert.equal(restored.restored, true, JSON.stringify(restored));
    assert.equal(restored.untracked.restored, 2);
    assert.equal(restored.untracked.filesCreatedAfterCheckpointKept, true);
    assert.ok((await fs.readFile(path.join(repo, 'notes.py'))).equals(notes), 'notes.py is back byte-for-byte');
    assert.equal(await fs.readFile(path.join(repo, 'src', 'lib', 'util.py'), 'utf8'), 'x = 1\n');
    assert.equal(await fs.readFile(path.join(repo, 'later.txt'), 'utf8'), 'created after the checkpoint\n',
      'a file created after the checkpoint is never deleted');
    const rollbackPaths = await untrackedTreePaths(repo, restored.rollbackRef);
    assert.deepEqual(rollbackPaths, ['later.txt'], 'the rollback snapshot captured the newer untracked file');
  });

  test('tracked changes plus untracked files keep the stash index parent and round-trip', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'staged\n', 'utf8');
    await git(repo, ['add', 'README.md']);
    await fs.writeFile(path.join(repo, 'README.md'), 'unstaged\n', 'utf8');
    await fs.writeFile(path.join(repo, 'notes.py'), 'n\n', 'utf8');
    const cachedBefore = (await git(repo, ['diff', '--cached'])).stdout;
    const svc = createService(repo);
    const created = await svc.createCheckpoint({ session: 'sess_mixed' });
    assert.equal(created.created, true);
    await git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
    await fs.rm(path.join(repo, 'notes.py'));

    const restored = await svc.restoreCheckpoint({ ref: created.ref });
    assert.equal(restored.restored, true);
    assert.equal((await git(repo, ['diff', '--cached'])).stdout, cachedBefore, 'index restored from ^2');
    assert.equal(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), 'unstaged\n');
    assert.equal(await fs.readFile(path.join(repo, 'notes.py'), 'utf8'), 'n\n');
  });

  test('over the file-count or total cap only the untracked part is skipped', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'tracked edit\n', 'utf8');
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await fs.writeFile(path.join(repo, name), `${name}\n`, 'utf8');
    }
    const countCapped = await directApi(repo, { untrackedLimits: { maxFiles: 2 } }).createCheckpoint({ session: 'cap' });
    assert.equal(countCapped.created, true, 'the tracked part is still checkpointed');
    assert.deepEqual(
      { captured: countCapped.untracked.captured, skipped: countCapped.untracked.skipped, reason: countCapped.untracked.reason },
      { captured: 0, skipped: 3, reason: 'too_many_files' }
    );
    assert.equal(await parentCount(repo, countCapped.sha), 2, 'no untracked parent');
    assert.equal((await git(repo, ['show', `${countCapped.sha}:README.md`])).stdout, 'tracked edit\n');

    const totalCapped = await directApi(repo, { untrackedLimits: { maxTotalBytes: 8 } }).createCheckpoint({ session: 'cap' });
    assert.equal(totalCapped.created, true);
    assert.equal(totalCapped.untracked.reason, 'total_size_limit');
    assert.equal(await parentCount(repo, totalCapped.sha), 2);

    await fs.writeFile(path.join(repo, 'big.bin'), Buffer.alloc(64, 1));
    const fileCapped = await directApi(repo, { untrackedLimits: { maxFileBytes: 32 } }).createCheckpoint({ session: 'cap' });
    assert.equal(fileCapped.untracked.captured, 3);
    assert.equal(fileCapped.untracked.skippedByReason.file_too_large, 1);
    assert.equal(fileCapped.untracked.reason, 'some_files_skipped');
    assert.deepEqual(await untrackedTreePaths(repo, fileCapped.sha), ['a.txt', 'b.txt', 'c.txt']);
  });

  test('symlink and junction escapes are never captured; .jenny metadata is excluded', async () => {
    const repo = await createGitRepo();
    const outside = createTrackedTempDir('jenny-git-untracked-outside-');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside secret\n', 'utf8');
    await fs.writeFile(path.join(repo, 'notes.py'), 'inside\n', 'utf8');
    await fs.mkdir(path.join(repo, '.jenny'), { recursive: true });
    await fs.writeFile(path.join(repo, '.jenny', 'state.json'), '{}', 'utf8');
    fsSync.symlinkSync(outside, path.join(repo, 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir');
    let fileLink = false;
    try {
      fsSync.symlinkSync(path.join(outside, 'secret.txt'), path.join(repo, 'leak.txt'), 'file');
      fileLink = true;
    } catch (error) {
      if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
      // Windows without symlink privilege: the junction case still runs.
    }
    const created = await createService(repo).createCheckpoint({ session: 'escape' });
    assert.equal(created.created, true);
    assert.deepEqual(await untrackedTreePaths(repo, created.sha), ['notes.py'],
      'only the in-root file is captured');
    assert.ok(created.untracked.skippedByReason.outside_root >= 1, JSON.stringify(created.untracked));
    if (!fileLink) assert.ok(true, 'file symlink case skipped: the OS refused symlink creation');
  });

  test('a forced mid-way failure keeps the tracked checkpoint and leaves the index untouched', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'tracked edit\n', 'utf8');
    await fs.mkdir(path.join(repo, 'deep'), { recursive: true });
    await fs.writeFile(path.join(repo, 'deep', 'notes.py'), 'n\n', 'utf8');
    await git(repo, ['status']);
    const before = await repoState(repo);
    const gitDirBefore = (await fs.readdir(path.join(repo, '.git'))).sort();
    const calls = [];
    const exec = async (cwd, args, options) => {
      calls.push(args);
      if (args.includes('mktree')) {
        return { success: false, reason: 'git_failed', stdout: '', stderr: 'fatal: forced', message: 'fatal: forced' };
      }
      return runWorkspaceGit(cwd, args, options);
    };
    const created = await directApi(repo, { exec }).createCheckpoint({ session: 'fail' });
    assert.equal(created.created, true, JSON.stringify(created));
    assert.equal(created.untracked.reason, 'capture_failed');
    assert.equal(created.untracked.captured, 0);
    assert.equal(await parentCount(repo, created.sha), 2, 'the plain tracked stash commit is pinned');
    const after = await repoState(repo);
    assert.equal(after.status, before.status);
    assert.ok(after.index.equals(before.index), 'the real index file is byte-identical');
    assert.deepEqual((await fs.readdir(path.join(repo, '.git'))).sort(), gitDirBefore,
      'no temporary file is left in the git dir');
    assert.ok(calls.some((args) => args[0] === 'hash-object'), 'the failure happened mid-way');
  });

  test('capture and restore never run an index-writing git verb', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'notes.py'), 'n\n', 'utf8');
    const calls = [];
    const exec = async (cwd, args, options) => {
      calls.push(args);
      return runWorkspaceGit(cwd, args, options);
    };
    const api = directApi(repo, { exec });
    const created = await api.createCheckpoint({ session: 'verbs' });
    await fs.rm(path.join(repo, 'notes.py'));
    const restored = await api.restoreCheckpoint({ ref: created.ref });
    assert.equal(restored.restored, true);
    const verbs = calls.map((args) => args.find((arg) => !arg.startsWith('-') && !arg.includes('=')));
    assert.deepEqual(verbs.filter((verb) => INDEX_VERBS.has(verb)), []);
    const untrackedRestores = calls.filter((args) => args[0] === 'restore' && args.includes('--pathspec-from-file=-'));
    assert.equal(untrackedRestores.length, 1);
    assert.ok(!untrackedRestores[0].includes('.') && !untrackedRestores[0].includes('--staged'),
      'the untracked restore writes the worktree only, from literal paths, never the whole tree');
  });

  test('an old-style checkpoint without a third parent restores exactly as before', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'old checkpoint\n', 'utf8');
    const stashSha = (await git(repo, ['stash', 'create'])).stdout.trim();
    await git(repo, ['update-ref', 'refs/jenny/checkpoints/old/1', stashSha]);
    await git(repo, ['restore', '--source=HEAD', '--worktree', '--', '.']);
    await fs.writeFile(path.join(repo, 'new.txt'), 'new\n', 'utf8');

    const restored = await createService(repo).restoreCheckpoint({ ref: 'refs/jenny/checkpoints/old/1' });
    assert.equal(restored.restored, true, JSON.stringify(restored));
    assert.ok(!('untracked' in restored), 'no untracked section for an old checkpoint');
    assert.equal(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), 'old checkpoint\n');
    assert.equal(await fs.readFile(path.join(repo, 'new.txt'), 'utf8'), 'new\n');
  });

  test('restore skips paths whose shape changed and deletes nothing', async () => {
    const repo = await createGitRepo();
    await fs.mkdir(path.join(repo, 'data'), { recursive: true });
    await fs.writeFile(path.join(repo, 'data', 'x.txt'), 'x\n', 'utf8');
    await fs.writeFile(path.join(repo, 'out'), 'out file\n', 'utf8');
    await fs.writeFile(path.join(repo, 'keep.txt'), 'keep\n', 'utf8');
    const svc = createService(repo);
    const created = await svc.createCheckpoint({ session: 'shape' });
    assert.equal(created.untracked.captured, 3);

    await fs.rm(path.join(repo, 'data'), { recursive: true });
    await fs.writeFile(path.join(repo, 'data'), 'now a file\n', 'utf8');
    await fs.rm(path.join(repo, 'out'));
    await fs.mkdir(path.join(repo, 'out'));
    await fs.writeFile(path.join(repo, 'out', 'new.txt'), 'new\n', 'utf8');
    await fs.rm(path.join(repo, 'keep.txt'));

    const restored = await svc.restoreCheckpoint({ ref: created.ref });
    assert.equal(restored.restored, true, JSON.stringify(restored));
    assert.equal(restored.untracked.restored, 1);
    assert.equal(restored.untracked.skippedByReason.path_conflict, 2);
    assert.equal(await fs.readFile(path.join(repo, 'keep.txt'), 'utf8'), 'keep\n');
    assert.equal(await fs.readFile(path.join(repo, 'data'), 'utf8'), 'now a file\n');
    assert.equal(await fs.readFile(path.join(repo, 'out', 'new.txt'), 'utf8'), 'new\n');
  });
});

describe('untracked checkpoint restore shape checks (stub exec)', () => {
  test('a silent exit 1 from stash create (racily clean tree) is nothing to snapshot, a timeout is not', async () => {
    const run = async (stashResult) => {
      const exec = async (_cwd, args) => {
        if (args[0] === 'rev-parse') return { success: true, stdout: `${'a'.repeat(40)}
` };
        if (args[0] === 'stash') return stashResult;
        return { success: true, stdout: '' };
      };
      return directApi('C:/repo', { exec }).createCheckpoint({ session: 's' });
    };
    const racy = await run({ success: false, reason: 'git_failed', stdout: '', stderr: '', message: 'Command failed: git stash create' });
    assert.equal(racy.ok, true);
    assert.equal(racy.reason, 'nothing_to_checkpoint');
    const timedOut = await run({ success: false, reason: 'git_failed', stdout: '', stderr: '', message: 'Git command timed out.' });
    assert.equal(timedOut.ok, false);
  });

  test('a third parent that has its own parents is never treated as untracked files', async () => {
    const [w, p1, p2, p3, p3parent] = ['1', '2', '3', '4', '5'].map((c) => c.repeat(40));
    const calls = [];
    const exec = async (_cwd, args) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[2] === 'HEAD') return { success: true, stdout: `${p1}\n` };
      if (args[0] === 'rev-parse' && String(args[3]).endsWith('^{commit}')) return { success: true, stdout: `${w}\n` };
      if (args[0] === 'rev-parse' && String(args[3]).endsWith('^2')) return { success: true, stdout: `${p2}\n` };
      if (args[0] === 'rev-list' && args[4] === w) return { success: true, stdout: `${w} ${p1} ${p2} ${p3}\n` };
      if (args[0] === 'rev-list' && args[4] === p3) return { success: true, stdout: `${p3} ${p3parent}\n` };
      if (args[0] === 'stash') return { success: true, stdout: `${'e'.repeat(40)}\n` };
      return { success: true, stdout: '' };
    };
    const restored = await directApi('C:/repo', { exec }).restoreCheckpoint({ ref: 'refs/jenny/checkpoints/s/1' });
    assert.equal(restored.restored, true);
    assert.ok(!calls.some((args) => args[0] === 'ls-tree'), 'an octopus merge parent is not listed as U');
    assert.equal(calls.filter((args) => args[0] === 'restore').length, 2);
  });
});

describe('untracked checkpoint helpers', () => {
  test('cQuotePath quotes every path so hash-object reads names verbatim', () => {
    assert.equal(cQuotePath('a b.py'), '"a b.py"');
    assert.equal(cQuotePath('we"ird\\name'), '"we\\"ird\\\\name"');
    assert.equal(cQuotePath('line\nbreak\ttab\u0001'), '"line\\nbreak\\ttab\\001"');
    assert.equal(cQuotePath('ünïcode.txt'), '"ünïcode.txt"');
  });

  test('treePathIsSafe rejects traversal, absolute, .git and Jenny metadata paths', () => {
    for (const ok of ['notes.py', 'src/lib/util.py', '.github/workflow.yml', '.jennyfile']) {
      assert.equal(treePathIsSafe(ok), true, ok);
    }
    for (const bad of ['', '../x', 'a/../b', '/abs', 'C:/x', 'a\\b', 'a//b', './a', '.git/config', 'sub/.GIT/hooks/x', '.jenny/state.json', '.jenny']) {
      assert.equal(treePathIsSafe(bad), false, bad);
    }
  });

  test('planUntrackedCapture skips the whole untracked part over the default count cap without inspecting', async () => {
    const listed = Array.from({ length: DEFAULT_UNTRACKED_LIMITS.maxFiles + 1 }, (_v, i) => `f${i}.txt`);
    let inspected = 0;
    const plan = await planUntrackedCapture(listed, DEFAULT_UNTRACKED_LIMITS, async () => {
      inspected += 1;
      return { size: 1 };
    });
    assert.equal(plan.entries.length, 0);
    assert.equal(plan.summary.reason, 'too_many_files');
    assert.equal(plan.summary.skipped, listed.length);
    assert.equal(inspected, 0, 'no file is even lstat-ed once the count cap is exceeded');
  });

  test('planUntrackedCapture drops .jenny paths and applies per-file and symlink caps', async () => {
    const entries = {
      '.jenny/state.json': { relPath: '.jenny/state.json', size: 1 },
      'a.txt': { relPath: 'a.txt', size: 5 },
      'huge.bin': { relPath: 'huge.bin', size: 50 },
      'l1': { relPath: 'l1', symlink: true, size: 0 },
      'l2': { relPath: 'l2', symlink: true, size: 0 },
      'dir': { skip: 'not_regular_file' },
    };
    const plan = await planUntrackedCapture(Object.keys(entries),
      { maxFiles: 10, maxFileBytes: 10, maxTotalBytes: 100, maxSymlinks: 1 },
      async (relPath) => entries[relPath]);
    assert.deepEqual(plan.entries.map((entry) => entry.relPath), ['a.txt', 'l1']);
    assert.deepEqual(plan.summary.skippedByReason, { file_too_large: 1, symlink_limit: 1, not_regular_file: 1 });
    assert.equal(plan.summary.reason, 'some_files_skipped');
  });

  test('directoriesByDepth lists the deepest directories first and the root last', () => {
    const { dirs, levels } = directoriesByDepth([
      { relPath: 'a/b/c.txt', sha: 'c'.repeat(40), mode: '100644' },
      { relPath: 'a/d.txt', sha: 'd'.repeat(40), mode: '100644' },
      { relPath: 'e.txt', sha: 'e'.repeat(40), mode: '100644' },
    ]);
    assert.deepEqual(levels, [['a/b'], ['a'], ['']]);
    assert.deepEqual(dirs.get('a/b').map((entry) => entry.name), ['c.txt']);
    assert.deepEqual(dirs.get('').map((entry) => entry.name), ['e.txt']);
  });
});
