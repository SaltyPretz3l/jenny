'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const {
  WorkspaceGitService,
  assertWriteVerb,
} = require('../services/workspace-git-service');
const { runWorkspaceGit } = require('../services/workspace-git-executor');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

const execFileAsync = promisify(execFile);

function git(cwd, args) {
  return execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
}

async function createGitRepo(prefix = 'jenny-workspace-git-') {
  const repoRoot = createTrackedTempDir(prefix);
  await git(repoRoot, ['init']);
  // Deterministic default branch name without relying on `git init -b` support.
  await git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(repoRoot, ['config', 'user.email', 'jenny@example.invalid']);
  await git(repoRoot, ['config', 'user.name', 'Jenny Tests']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  // Deterministic LF round-trips regardless of the host's global autocrlf.
  await git(repoRoot, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'line1\nline2\nline3\n', 'utf8');
  await git(repoRoot, ['add', 'README.md']);
  await git(repoRoot, ['commit', '-m', 'initial']);
  return repoRoot;
}

function createService(root, { flag = true, exec, rootContextProvider = null, trashItemImpl = null } = {}) {
  return new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_git: flag }),
    ...(exec ? { exec } : {}),
    rootContextProvider,
    trashItemImpl,
    logger() {},
  });
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// (The "read methods (real repo)" describe block that used to live here now
// lives in the sibling tests/workspace-git-service-reads.test.js — split for
// the 1015-raw-line file-size ceiling; no behavior change.)

describe('WorkspaceGitService — write methods (real repo)', () => {
  test('stage then unstage moves a file in and out of the index', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'work.txt'), 'w\n', 'utf8');
    const svc = createService(repo);

    const staged = await svc.stage({ paths: ['work.txt'] });
    assert.equal(staged.ok, true);
    assert.equal(staged.staged, 1);
    let status = await svc.getStatus();
    assert.equal(status.files.find((f) => f.path === 'work.txt').staged, true);

    const unstaged = await svc.unstage({ paths: ['work.txt'] });
    assert.equal(unstaged.ok, true);
    status = await svc.getStatus();
    assert.equal(status.files.find((f) => f.path === 'work.txt').staged, false);
  });

  test('commit happy path returns the new short sha', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'c.txt'), 'c\n', 'utf8');
    const svc = createService(repo);
    await svc.stage({ paths: ['c.txt'] });
    const res = await svc.commit({ message: 'add c' });
    assert.equal(res.committed, true);
    const head = (await git(repo, ['rev-parse', '--short', 'HEAD'])).stdout.trim();
    assert.ok(res.shortSha.startsWith(head) || head.startsWith(res.shortSha));
  });

  test('commit with an empty message throws COMMIT_MESSAGE_EMPTY', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    await assert.rejects(() => svc.commit({ message: '   ' }), /Commit message cannot be empty/);
  });

  test('commit with nothing staged returns a soft nothing_to_commit result', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    const res = await svc.commit({ message: 'noop' });
    assert.equal(res.ok, true);
    assert.equal(res.committed, false);
    assert.equal(res.reason, 'nothing_to_commit');
  });

  test('discardFile restores a modified file to its committed content', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'tampered\n', 'utf8');
    const svc = createService(repo);
    const res = await svc.discardFile({ path: 'README.md' });
    assert.equal(res.discarded, true);
    assert.equal(res.class, 'tracked');
    const onDisk = await fs.readFile(path.join(repo, 'README.md'), 'utf8');
    assert.equal(onDisk, 'line1\nline2\nline3\n');
  });

  // UIUX-032: `git restore --worktree` only ever operates on paths git already
  // tracks — it refuses an untracked path with "did not match any file(s) known
  // to git", which discardFile used to surface verbatim as a confusing
  // GIT_COMMAND_FAILED instead of doing the one thing "Discard" promises
  // (removing the untracked file so the workspace matches "no changes").
  // discardFile now classifies tracked vs untracked FIRST and trashes an
  // untracked path rather than routing it through `restore`.
  test('discardFile trashes an untracked file instead of failing restore --worktree', async () => {
    const repo = await createGitRepo();
    const absolute = path.join(repo, 'scratch.txt');
    await fs.writeFile(absolute, 'never added\n', 'utf8');
    const trashedPaths = [];
    const svc = createService(repo, {
      trashItemImpl: async (target) => {
        trashedPaths.push(target);
        await fs.rm(target);
      },
    });
    const res = await svc.discardFile({ path: 'scratch.txt' });
    assert.equal(res.ok, true, 'an untracked discard succeeds');
    assert.equal(res.discarded, true);
    assert.equal(res.class, 'untracked');
    assert.equal(res.deleted, true);
    assert.equal(res.trashed, true);
    assert.deepEqual(trashedPaths, [absolute]);
    await assert.rejects(() => fs.stat(absolute), /ENOENT/, 'the untracked file was removed from disk');
  });

  // `ls-files -- <dir>` lists children, never the directory, so a folder whose
  // files are tracked classifies as "untracked" - and unlike unlink, trashItem
  // would move the whole folder. Directories are refused before trash is asked.
  test('discardFile refuses a directory even when only its children are tracked', async () => {
    const repo = await createGitRepo();
    await fs.mkdir(path.join(repo, 'src'));
    await fs.writeFile(path.join(repo, 'src', 'app.js'), 'tracked\n', 'utf8');
    await git(repo, ['add', 'src/app.js']);
    await git(repo, ['commit', '-m', 'track app']);
    const trashedPaths = [];
    const svc = createService(repo, {
      trashItemImpl: async (target) => { trashedPaths.push(target); },
    });
    const res = await svc.discardFile({ path: 'src' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'directory_unsupported');
    assert.deepEqual(trashedPaths, [], 'trash was never asked to move the directory');
    await assert.doesNotReject(() => fs.stat(path.join(repo, 'src', 'app.js')));
  });

  test('discardFile refuses an untracked discard when trash is unavailable', async () => {
    const repo = await createGitRepo();
    const absolute = path.join(repo, 'scratch.txt');
    await fs.writeFile(absolute, 'never added\n', 'utf8');
    const svc = createService(repo);
    const res = await svc.discardFile({ path: 'scratch.txt' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'trash_unavailable');
    await assert.doesNotReject(() => fs.stat(absolute));
  });

  test('discardFile reports trash_failed when trashing fails and the file remains', async () => {
    const repo = await createGitRepo();
    const absolute = path.join(repo, 'scratch.txt');
    await fs.writeFile(absolute, 'never added\n', 'utf8');
    const svc = createService(repo, {
      trashItemImpl: async () => { throw new Error('trash failed'); },
    });
    const res = await svc.discardFile({ path: 'scratch.txt' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'trash_failed');
    await assert.doesNotReject(() => fs.stat(absolute));
  });

  test('discardFile tolerates a trash error when the untracked file is already gone', async () => {
    const repo = await createGitRepo();
    const absolute = path.join(repo, 'scratch.txt');
    await fs.writeFile(absolute, 'never added\n', 'utf8');
    const svc = createService(repo, {
      trashItemImpl: async (target) => {
        await fs.rm(target);
        throw new Error('trash settlement failed');
      },
    });
    const res = await svc.discardFile({ path: 'scratch.txt' });
    assert.equal(res.ok, true);
    assert.equal(res.class, 'untracked');
    assert.equal(res.trashed, true);
    await assert.rejects(() => fs.stat(absolute), /ENOENT/);
  });

  test('checkout switches branches and creates new ones; invalid refs throw', async () => {
    const repo = await createGitRepo();
    await git(repo, ['branch', 'existing']);
    const svc = createService(repo);

    const switched = await svc.checkout({ ref: 'existing' });
    assert.equal(switched.switched, true);
    assert.equal((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'existing');

    const created = await svc.checkout({ ref: 'fresh-branch', createBranch: true });
    assert.equal(created.created, true);
    assert.equal((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'fresh-branch');

    await assert.rejects(() => svc.checkout({ ref: '..bad' }), /Invalid branch or ref/);
    await assert.rejects(() => svc.checkout({ ref: '-x', createBranch: true }), /Invalid branch or ref/);
  });

  test('stash push then pop round-trips; clean tree is a soft no-op', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'dirty\n', 'utf8');
    const svc = createService(repo);

    const pushed = await svc.stash({ op: 'push', message: 'wip' });
    assert.equal(pushed.stashed, true);
    assert.equal((await fs.readFile(path.join(repo, 'README.md'), 'utf8')), 'line1\nline2\nline3\n');

    const popped = await svc.stash({ op: 'pop' });
    assert.equal(popped.stashed, true);
    assert.equal((await fs.readFile(path.join(repo, 'README.md'), 'utf8')), 'dirty\n');

    // clean tree (after discarding the dirty change) → nothing to stash
    await svc.discardFile({ path: 'README.md' });
    const noop = await svc.stash({ op: 'push' });
    assert.equal(noop.stashed, false);
    assert.equal(noop.reason, 'nothing_to_stash');
  });

  test('undoLastCommit soft-resets to the parent; single-commit repo is a soft no-op', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'd.txt'), 'd\n', 'utf8');
    await git(repo, ['add', 'd.txt']);
    await git(repo, ['commit', '-m', 'second commit']);
    const before = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    const parent = (await git(repo, ['rev-parse', 'HEAD~1'])).stdout.trim();
    const svc = createService(repo);

    const undone = await svc.undoLastCommit();
    assert.equal(undone.undone, true);
    assert.equal((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim(), parent);
    assert.notEqual(before, parent);
    // the change is preserved in the index (soft reset)
    const status = await svc.getStatus();
    assert.ok(status.files.find((f) => f.path === 'd.txt' && f.staged));
  });

  test('undoLastCommit on a single-commit repo returns no_prior_commit', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    const res = await svc.undoLastCommit();
    assert.equal(res.ok, true);
    assert.equal(res.undone, false);
    assert.equal(res.reason, 'no_prior_commit');
  });
});

describe('WorkspaceGitService — createCheckpoint', () => {
  test('captures uncommitted tracked changes without touching the working tree', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'line1\nCHECKPOINT\nline3\n', 'utf8');
    const svc = createService(repo);

    const before = (await git(repo, ['status', '--porcelain'])).stdout;
    const res = await svc.createCheckpoint({ session: 'sess_1' });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.ref, 'refs/jenny/checkpoints/sess_1/1');
    assert.match(res.sha, /^[0-9a-f]{40}$/);

    // The ref actually exists and resolves to the captured sha.
    const rev = await git(repo, ['rev-parse', '--verify', 'refs/jenny/checkpoints/sess_1/1']);
    assert.equal(rev.stdout.trim(), res.sha);

    // `stash create` is non-destructive (contrast the stash push/pop test
    // above, which DOES remove the change): the working tree is unchanged.
    const after = (await git(repo, ['status', '--porcelain'])).stdout;
    assert.equal(after, before);
    assert.equal((await fs.readFile(path.join(repo, 'README.md'), 'utf8')), 'line1\nCHECKPOINT\nline3\n');
  });

  test('a second checkpoint in the same session increments the sequence', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'line1\nFIRST\nline3\n', 'utf8');
    const svc = createService(repo);

    const first = await svc.createCheckpoint({ session: 'sess_1' });
    assert.equal(first.sequence, 1);

    await fs.writeFile(path.join(repo, 'README.md'), 'line1\nSECOND\nline3\n', 'utf8');
    const second = await svc.createCheckpoint({ session: 'sess_1' });
    assert.equal(second.created, true);
    assert.equal(second.sequence, 2);
    assert.equal(second.ref, 'refs/jenny/checkpoints/sess_1/2');
  });

  test('a clean repo has nothing to checkpoint', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    const res = await svc.createCheckpoint({ session: 'sess_1' });
    assert.equal(res.ok, true);
    assert.equal(res.created, false);
    assert.equal(res.reason, 'nothing_to_checkpoint');
  });

  test('feature flag off degrades to available:false (no git spawned)', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'line1\nDIRTY\nline3\n', 'utf8');
    let execCalls = 0;
    const spyExec = async () => { execCalls += 1; return { success: true, stdout: '', stderr: '', message: '', reason: '' }; };
    const svc = createService(repo, { flag: false, exec: spyExec });
    const res = await svc.createCheckpoint({ session: 'sess_1' });
    assert.equal(res.available, false);
    assert.equal(res.reason, 'feature_disabled');
    assert.equal(execCalls, 0);
  });

  test('a path-traversal-shaped session id sanitizes to a safe ref and still checkpoints', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'line1\nEVIL\nline3\n', 'utf8');
    const svc = createService(repo);
    const res = await svc.createCheckpoint({ session: '../evil' });
    assert.equal(res.created, true);
    assert.equal(res.ref.includes('..'), false, 'sanitized ref contains no ".." segment');
    assert.match(res.ref, /^refs\/jenny\/checkpoints\/[^/]+\/1$/);
    const rev = await git(repo, ['rev-parse', '--verify', res.ref]);
    assert.equal(rev.stdout.trim(), res.sha);
  });
});

describe('WorkspaceGitService — unborn repo', () => {
  test('read methods degrade cleanly when HEAD does not exist', async () => {
    const repo = createTrackedTempDir('jenny-workspace-git-unborn-');
    await git(repo, ['init']);
    await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await fs.writeFile(path.join(repo, 'fresh.txt'), 'x\n', 'utf8');
    const svc = createService(repo);

    const status = await svc.getStatus();
    assert.equal(status.unborn, true);
    assert.equal(status.branch, 'main');

    const log = await svc.getLog();
    assert.deepEqual(log.commits, []);

    const branches = await svc.getBranches();
    assert.equal(branches.unborn, true);

    const fileAtHead = await svc.getFileAtHead({ path: 'fresh.txt' });
    assert.equal(fileAtHead.found, false);
    assert.equal(fileAtHead.reason, 'no_head');

    const diff = await svc.getDiff();
    assert.equal(diff.ok, true);
    assert.equal(diff.note, 'no_head');
  });
});

describe('WorkspaceGitService — graceful degradation & security', () => {
  test('a non-git workspace returns clean isRepo:false for every method (never throws)', async () => {
    const plainDir = createTrackedTempDir('jenny-workspace-git-norepo-');
    await fs.writeFile(path.join(plainDir, 'a.txt'), 'a\n', 'utf8');
    const svc = createService(plainDir);

    const calls = [
      () => svc.getStatus(),
      () => svc.getDiff(),
      () => svc.getCommitDiff({ hash: 'a'.repeat(40) }),
      () => svc.getLog(),
      () => svc.getBranches(),
      () => svc.getFileAtHead({ path: 'a.txt' }),
      () => svc.blameRange({ path: 'a.txt', startLine: 1, endLine: 1 }),
      () => svc.listNonIgnoredFiles(),
      () => svc.stage({ paths: ['a.txt'] }),
      () => svc.unstage({ paths: ['a.txt'] }),
      () => svc.commit({ message: 'valid message' }),
      () => svc.discardFile({ path: 'a.txt' }),
      () => svc.checkout({ ref: 'main' }),
      () => svc.stash({ op: 'push' }),
      () => svc.undoLastCommit(),
    ];
    for (const call of calls) {
      const res = await call();
      assert.equal(res.ok, false, `${res.op} ok:false`);
      assert.equal(res.isRepo, false, `${res.op} isRepo:false`);
      assert.equal(res.available, true, `${res.op} available:true (valid root, not a repo)`);
    }
  });

  test('no configured root returns available:false for every method', async () => {
    const svc = createService('');
    const status = await svc.getStatus();
    assert.equal(status.available, false);
    assert.equal(status.reason, 'no_root');
    const stage = await svc.stage({ paths: ['x'] });
    assert.equal(stage.available, false);
    assert.equal(stage.reason, 'no_root');
    const listNonIgnored = await svc.listNonIgnoredFiles();
    assert.equal(listNonIgnored.available, false);
    assert.equal(listNonIgnored.reason, 'no_root');
  });

  test('path arguments that escape the root are rejected', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    await assert.rejects(() => svc.getFileAtHead({ path: '../escape.txt' }), /workspace-relative|inside the workspace/);
    await assert.rejects(() => svc.getFileAtHead({ path: 'C:/Windows/system32/x' }), /workspace-relative/);
    await assert.rejects(() => svc.stage({ paths: ['..\\escape'] }), /workspace-relative|inside the workspace/);
    await assert.rejects(() => svc.discardFile({ path: '/etc/passwd' }), /workspace-relative/);
    await assert.rejects(() => svc.blameRange({ path: '-rf', startLine: 1, endLine: 1 }), /must not start with a dash/);
  });

  test('a realpath escape via a symlink/junction is rejected', async (t) => {
    const repo = await createGitRepo();
    const outside = createTrackedTempDir('jenny-workspace-git-outside-');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n', 'utf8');
    const linkPath = path.join(repo, 'link');
    try {
      await fs.symlink(outside, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlink/junction unavailable in this environment: ${error.message}`);
      return;
    }
    const svc = createService(repo);
    await assert.rejects(
      () => svc.getFileAtHead({ path: 'link/secret.txt' }),
      /outside the workspace root/
    );
  });

  test('every method degrades to available:false when the feature flag is off (no git spawned)', async () => {
    const repo = await createGitRepo();
    let execCalls = 0;
    const spyExec = async () => { execCalls += 1; return { success: true, stdout: '', stderr: '', message: '', reason: '' }; };
    const svc = createService(repo, { flag: false, exec: spyExec });

    const calls = [
      svc.getStatus(), svc.getDiff(), svc.getCommitDiff({ hash: 'a'.repeat(40) }),
      svc.getLog(), svc.getBranches(),
      svc.getFileAtHead({ path: 'README.md' }),
      svc.blameRange({ path: 'README.md', startLine: 1, endLine: 1 }),
      svc.stage({ paths: ['README.md'] }), svc.unstage({ paths: ['README.md'] }),
      svc.commit({ message: 'x' }), svc.discardFile({ path: 'README.md' }),
      svc.checkout({ ref: 'main' }), svc.stash({ op: 'push' }), svc.undoLastCommit(),
    ];
    const results = await Promise.all(calls);
    for (const res of results) {
      assert.equal(res.available, false, `${res.op} available:false`);
      assert.equal(res.reason, 'feature_disabled', `${res.op} feature_disabled`);
    }
    assert.equal(execCalls, 0, 'no git subprocess spawned while disabled');
  });

  test('a bad message/ref degrades cleanly (never throws) when the workspace is unusable', async () => {
    // Feature off: a bad arg must still degrade rather than throw a validation error.
    const repo = await createGitRepo();
    const disabled = createService(repo, { flag: false });
    assert.equal((await disabled.commit({ message: '   ' })).reason, 'feature_disabled');
    assert.equal((await disabled.checkout({ ref: '..bad' })).reason, 'feature_disabled');
    // Non-repo: same — degrade to isRepo:false, not a thrown COMMIT_MESSAGE_EMPTY/REF_INVALID.
    const plain = createTrackedTempDir('jenny-workspace-git-badarg-norepo-');
    const svc = createService(plain);
    assert.equal((await svc.commit({ message: '' })).isRepo, false);
    assert.equal((await svc.checkout({ ref: '-x', createBranch: true })).isRepo, false);
    // But in a real, enabled repo the validation still throws.
    const live = createService(repo);
    await assert.rejects(() => live.commit({ message: '' }), /Commit message cannot be empty/);
    await assert.rejects(() => live.checkout({ ref: '..bad' }), /Invalid branch or ref/);
  });
});

describe('WorkspaceGitService — destructive guard', () => {
  test('assertWriteVerb only accepts the write allowlist', () => {
    for (const verb of ['add', 'restore', 'commit', 'checkout', 'stash', 'reset', 'update-ref']) {
      assert.doesNotThrow(() => assertWriteVerb(verb));
    }
    for (const verb of ['rm', 'push', 'clean', 'fetch', 'config', '']) {
      assert.throws(() => assertWriteVerb(verb), /unexpected git verb/);
    }
  });

  test('write methods only ever invoke an allowlisted verb through the executor', async () => {
    const repo = await createGitRepo();
    const seenVerbs = [];
    const spyExec = async (cwd, args) => {
      seenVerbs.push(args[0]);
      // satisfy the repo-detection probe, the toplevel guard, and HEAD
      // checks, then writes
      if (args[0] === 'rev-parse') {
        if (args.includes('--is-inside-work-tree')) {
          return { success: true, stdout: 'true', stderr: '', message: '', reason: '' };
        }
        if (args.includes('--show-toplevel')) {
          return { success: true, stdout: repo, stderr: '', message: '', reason: '' };
        }
        return { success: true, stdout: 'deadbeef', stderr: '', message: '', reason: '' };
      }
      // UIUX-032: discardFile's tracked/untracked classification probe. Echo
      // the queried path back as tracked - this fixture repo genuinely tracks
      // README.md, so the spy exercises the same `restore` branch real git
      // would (an empty stdout here would misclassify it untracked and route
      // through fs.unlink on the real fixture file).
      if (args[0] === 'ls-files') {
        const relPath = args[args.length - 1];
        return { success: true, stdout: `${relPath}\0`, stderr: '', message: '', reason: '' };
      }
      return { success: true, stdout: '', stderr: '', message: '', reason: '' };
    };
    const svc = createService(repo, { exec: spyExec });
    await svc.stage({ paths: ['README.md'] });
    await svc.unstage({ paths: ['README.md'] });
    await svc.commit({ message: 'm' });
    await svc.discardFile({ path: 'README.md' });
    await svc.checkout({ ref: 'main' });
    await svc.stash({ op: 'push' });
    await svc.undoLastCommit();

    // ls-files is a read-only classification probe (like rev-parse above), not
    // a write verb — it never reaches assertWriteVerb, only the verb ACTUALLY
    // spawned as a write does.
    const writeVerbs = seenVerbs.filter((v) => v !== 'rev-parse' && v !== 'ls-files');
    const allowed = new Set(['add', 'restore', 'commit', 'checkout', 'stash', 'reset', 'update-ref']);
    for (const verb of writeVerbs) {
      assert.ok(allowed.has(verb), `verb ${verb} is in the write allowlist`);
    }
  });
});

describe('WorkspaceGitService — git toplevel guard (WIDE-008 stopgap)', () => {
  const DESTRUCTIVE_CASES = [
    { verb: 'commit', call: (svc) => svc.commit({ message: 'blocked' }) },
    { verb: 'stage', call: (svc) => svc.stage({ paths: ['README.md'] }) },
    { verb: 'discardFile', call: (svc) => svc.discardFile({ path: 'README.md' }) },
    { verb: 'stash', call: (svc) => svc.stash({ op: 'push' }) },
    { verb: 'checkout', call: (svc) => svc.checkout({ ref: 'main' }) },
    { verb: 'undoLastCommit', call: (svc) => svc.undoLastCommit() },
  ];

  test('every destructive verb refuses with GIT_NOT_TOPLEVEL when the root is a repo SUBDIRECTORY', async () => {
    const repo = await createGitRepo();
    const subdir = path.join(repo, 'subdir');
    await fs.mkdir(subdir);
    await fs.writeFile(path.join(subdir, 'inner.txt'), 'x\n', 'utf8');

    const svc = createService(subdir);
    for (const { verb, call } of DESTRUCTIVE_CASES) {
      const res = await call(svc);
      assert.equal(res.ok, false, `${verb} ok:false`);
      assert.equal(res.available, true, `${verb} available:true`);
      assert.equal(res.isRepo, true, `${verb} isRepo:true`);
      assert.equal(res.error_code, 'CMP-GIT-0004', `${verb} error_code`);
      assert.equal(res.reason, 'not_repo_toplevel', `${verb} reason`);
    }
  });

  test('wide-008: SCM status explicitly refuses a selected repository subdirectory', async () => {
    const repo = await createGitRepo();
    const subdir = path.join(repo, 'subdir');
    await fs.mkdir(subdir);
    const res = await createService(subdir).getStatus();
    assert.equal(res.ok, false);
    assert.equal(res.isRepo, true);
    assert.equal(res.reason, 'not_repo_toplevel');
    assert.equal(res.error_code, 'CMP-GIT-0004');
  });

  test('repo state is unchanged after refusal: staged-outside file stays staged, working tree untouched', async () => {
    const repo = await createGitRepo();
    const subdir = path.join(repo, 'subdir');
    await fs.mkdir(subdir);

    // Stage a change OUTSIDE the selected subdir root — this is exactly the
    // repo-wide scope a subdir-rooted commit/stash would otherwise reach.
    await fs.writeFile(path.join(repo, 'README.md'), 'line1\nTAMPERED\nline3\n', 'utf8');
    await git(repo, ['add', 'README.md']);
    const statusBefore = (await git(repo, ['status', '--porcelain'])).stdout;

    const svc = createService(subdir);
    await svc.commit({ message: 'should be refused' });
    await svc.stash({ op: 'push' });

    const statusAfter = (await git(repo, ['status', '--porcelain'])).stdout;
    assert.equal(statusAfter, statusBefore, 'working tree + index unchanged after refused writes');
    assert.match(statusAfter, /^M\s+README\.md$/m, 'README.md is still staged modified');
  });

  test('toplevel-selected root still allows writes (existing behavior preserved)', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'top.txt'), 't\n', 'utf8');
    const svc = createService(repo);
    const staged = await svc.stage({ paths: ['top.txt'] });
    assert.equal(staged.ok, true);
    const committed = await svc.commit({ message: 'toplevel write' });
    assert.equal(committed.committed, true);
  });

  test('a linked worktree root is its own toplevel and destructive writes succeed', async () => {
    const repo = await createGitRepo();
    const worktreeParent = createTrackedTempDir('jenny-workspace-git-worktree-');
    const worktreeDir = path.join(worktreeParent, 'wt');
    await git(repo, ['worktree', 'add', worktreeDir, '-b', 'wt-branch']);

    const svc = createService(worktreeDir);
    await fs.writeFile(path.join(worktreeDir, 'wt.txt'), 'w\n', 'utf8');
    const staged = await svc.stage({ paths: ['wt.txt'] });
    assert.equal(staged.ok, true, 'stage succeeds in a linked worktree root');
    const committed = await svc.commit({ message: 'from worktree' });
    assert.equal(committed.committed, true, 'commit succeeds in a linked worktree root');
  });
});

describe('WorkspaceGitService - immutable root operation context', () => {
  test('a delayed repository probe is dropped after root generation changes', async () => {
    let current = { rootPath: 'G:/root-a', rootId: 'a', generation: 1, phase: 'ready' };
    let resolveEntered;
    const entered = new Promise((resolve) => { resolveEntered = resolve; });
    let resolveGate;
    const gate = new Promise((resolve) => { resolveGate = resolve; });
    const abort = new AbortController();
    const calls = [];
    const coordinator = {
      acquireOperation: () => ({
        acquired: true,
        context: { ...current },
        signal: abort.signal,
        isCurrent: () => current.rootId === 'a' && current.generation === 1,
        release() {},
      }),
    };
    const svc = createService('G:/root-a', {
      rootContextProvider: () => coordinator,
      exec: async (root, args) => {
        calls.push([root, args]);
        resolveEntered();
        await gate;
        return { success: true, stdout: 'true\n', stderr: '', message: '' };
      },
    });

    const pending = svc.getStatus();
    await entered;
    current = { rootPath: 'G:/root-b', rootId: 'b', generation: 2, phase: 'ready' };
    abort.abort('workspace_root_transition');
    resolveGate();
    const result = await pending;

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'root_changed');
    assert.deepEqual(calls, [['G:/root-a', ['rev-parse', '--is-inside-work-tree']]]);
  });

  test('write verbs serialize per repository before validation and spawn', async () => {
    const root = createTrackedTempDir('jenny-workspace-git-serialized-');
    await fs.writeFile(path.join(root, 'one.txt'), 'one\n', 'utf8');
    await fs.writeFile(path.join(root, 'two.txt'), 'two\n', 'utf8');
    let resolveFirstAdd;
    const firstAddEntered = new Promise((resolve) => { resolveFirstAdd = resolve; });
    let releaseFirstAdd;
    const firstAddGate = new Promise((resolve) => { releaseFirstAdd = resolve; });
    const calls = [];
    let addCalls = 0;
    const coordinator = {
      acquireOperation: () => ({
        acquired: true,
        context: { rootPath: root, rootId: 'repo', generation: 1, phase: 'ready' },
        signal: new AbortController().signal,
        isCurrent: () => true,
        release() {},
      }),
    };
    const svc = createService(root, {
      rootContextProvider: () => coordinator,
      exec: async (cwd, args) => {
        calls.push([cwd, [...args]]);
        if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') {
          return { success: true, stdout: 'true\n', stderr: '', message: '' };
        }
        if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
          return { success: true, stdout: `${root}\n`, stderr: '', message: '' };
        }
        if (args[0] === 'add') {
          addCalls += 1;
          if (addCalls === 1) {
            resolveFirstAdd();
            await firstAddGate;
          }
          return { success: true, stdout: '', stderr: '', message: '' };
        }
        throw new Error(`unexpected git command: ${args.join(' ')}`);
      },
    });

    const first = svc.stage({ paths: ['one.txt'] });
    await firstAddEntered;
    const callsAtFirstAdd = calls.length;
    const second = svc.stage({ paths: ['two.txt'] });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls.length, callsAtFirstAdd, 'second write waits before repo validation');
    releaseFirstAdd();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.ok, true);
    assert.equal(two.ok, true);
    assert.equal(addCalls, 2);
  });
});

describe('runWorkspaceGit — executor', () => {
  test('masks token-shaped substrings out of the surfaced message', async () => {
    const fakeExec = (file, args, options, callback) => {
      callback(
        Object.assign(new Error('fail'), { code: 128 }),
        '',
        'fatal: could not read Username for https://ghp_ABCDEFGHIJKLMNOPQRST@github.com'
      );
    };
    const res = await runWorkspaceGit('/tmp', ['fetch'], { execFileImpl: fakeExec });
    assert.equal(res.success, false);
    assert.equal(/ghp_ABCDEFGHIJKLMNOPQRST/.test(res.message), false, 'token masked out');
  });

  test('runs real git end-to-end', async () => {
    const repo = await createGitRepo();
    const res = await runWorkspaceGit(repo, ['rev-parse', '--is-inside-work-tree']);
    assert.equal(res.success, true);
    assert.equal(res.stdout.trim(), 'true');
  });
});
