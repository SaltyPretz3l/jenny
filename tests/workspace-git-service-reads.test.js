'use strict';
// Sibling of tests/workspace-git-service.test.js — split out purely for the
// 1015-raw-line file-size ceiling (the parent file grew past it once the
// UIUX-032 discard-classification tests landed there). This file owns every
// READ-method case (getStatus/getDiff/getCommitDiff/getLog/getChangedFiles-
// ByCommit/getBranches/listNonIgnoredFiles/blameRange); the parent keeps the
// write/checkpoint/guard/security describe blocks. No behavior change — this
// is the same "WorkspaceGitService — read methods (real repo)" describe block,
// moved verbatim with its own copy of the shared git/createGitRepo/createService
// helpers (duplicated rather than shared, since these are tiny fixtures and a
// cross-file require would recouple the two files' line budgets).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { WorkspaceGitService, parseBlamePorcelain } = require('../services/workspace-git-service');
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

function createService(root, { flag = true, exec, rootContextProvider = null } = {}) {
  return new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_git: flag }),
    ...(exec ? { exec } : {}),
    rootContextProvider,
    logger() {},
  });
}

function repoExec(root, handler) {
  return async (_cwd, args) => {
    if (args.includes('--is-inside-work-tree')) return { success: true, stdout: 'true\n' };
    if (args.includes('--show-toplevel')) return { success: true, stdout: `${root}\n` };
    return handler(args);
  };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('WorkspaceGitService — read methods (real repo)', () => {
  test('getStatus on a clean repo reports the branch and no files', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    const res = await svc.getStatus();
    assert.equal(res.ok, true);
    assert.equal(res.isRepo, true);
    assert.equal(res.branch, 'main');
    assert.equal(res.detached, false);
    assert.equal(res.unborn, false);
    assert.equal(res.ahead, 0);
    assert.equal(res.behind, 0);
    assert.deepEqual(res.files, []);
  });

  test('getStatus classifies staged, modified, untracked and renamed entries', async () => {
    const repo = await createGitRepo();
    // commit a file we will then rename (the rename must be staged at status time)
    await fs.writeFile(path.join(repo, 'orig.txt'), 'body\n', 'utf8');
    await git(repo, ['add', 'orig.txt']);
    await git(repo, ['commit', '-m', 'add orig']);
    await git(repo, ['mv', 'orig.txt', 'renamed.txt']);
    // staged new file (kept staged — no commit follows)
    await fs.writeFile(path.join(repo, 'staged.txt'), 'hi\n', 'utf8');
    await git(repo, ['add', 'staged.txt']);
    // working-tree modification of a tracked file
    await fs.writeFile(path.join(repo, 'README.md'), 'line1\nCHANGED\nline3\n', 'utf8');
    // untracked file
    await fs.writeFile(path.join(repo, 'untracked.txt'), 'new\n', 'utf8');

    const svc = createService(repo);
    const res = await svc.getStatus();
    const byPath = new Map(res.files.map((f) => [f.path, f]));

    assert.ok(byPath.get('staged.txt'));
    assert.equal(byPath.get('staged.txt').staged, true);
    assert.equal(byPath.get('staged.txt').state, 'added');

    assert.ok(byPath.get('README.md'));
    assert.equal(byPath.get('README.md').worktree, 'M');
    assert.equal(byPath.get('README.md').state, 'modified');

    assert.ok(byPath.get('untracked.txt'));
    assert.equal(byPath.get('untracked.txt').state, 'untracked');
    assert.equal(byPath.get('untracked.txt').index, '?');

    assert.ok(byPath.get('renamed.txt'), 'rename target present');
    assert.equal(byPath.get('renamed.txt').state, 'renamed');
    assert.equal(byPath.get('renamed.txt').origPath, 'orig.txt');

    assert.ok(res.summary.untracked_count >= 1);
    assert.ok(res.summary.staged_count >= 1);
  });

  test('getStatus preserves paths containing spaces (-z parsing)', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'a b.txt'), 'x\n', 'utf8');
    const svc = createService(repo);
    const res = await svc.getStatus();
    assert.ok(res.files.some((f) => f.path === 'a b.txt'));
  });

  test('getStatus on a detached HEAD reports detached', async () => {
    const repo = await createGitRepo();
    const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    await git(repo, ['checkout', '--detach', head]);
    const svc = createService(repo);
    const res = await svc.getStatus();
    assert.equal(res.detached, true);
    assert.equal(res.branch, '(detached)');
  });

  test('getDiff returns a working-tree diff vs HEAD', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'line1\nDIFFED\nline3\n', 'utf8');
    const svc = createService(repo);
    const res = await svc.getDiff();
    assert.equal(res.ok, true);
    assert.match(res.diff, /-line2/);
    assert.match(res.diff, /\+DIFFED/);
    assert.equal(res.truncated, false);
    assert.equal(res.containsBinary, false);
  });

  test('getDiff({ staged: true }) returns only the staged (index-vs-HEAD) diff', async () => {
    const repo = await createGitRepo();
    // A working-tree-only edit (NOT staged) must be excluded from the staged diff.
    await fs.writeFile(path.join(repo, 'README.md'), 'line1\nWORKTREE\nline3\n', 'utf8');
    // A staged new file.
    await fs.writeFile(path.join(repo, 'feature.js'), 'export const x = 1;\n', 'utf8');
    await git(repo, ['add', 'feature.js']);
    const svc = createService(repo);

    const stagedRes = await svc.getDiff({ staged: true });
    assert.equal(stagedRes.ok, true);
    assert.match(stagedRes.diff, /feature\.js/, 'staged file present in the staged diff');
    assert.match(stagedRes.diff, /\+export const x = 1;/);
    assert.doesNotMatch(stagedRes.diff, /WORKTREE/, 'unstaged working-tree edit excluded from staged diff');

    // The default (working-tree) diff still surfaces the unstaged edit.
    const defaultRes = await svc.getDiff();
    assert.match(defaultRes.diff, /WORKTREE/, 'working-tree edit present in the default diff');
  });

  test('getDiff({ staged: true }) on a repo with no HEAD shows staged additions', async () => {
    const repoRoot = createTrackedTempDir('jenny-workspace-git-nohead-');
    await git(repoRoot, ['init']);
    await git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await git(repoRoot, ['config', 'user.email', 'jenny@example.invalid']);
    await git(repoRoot, ['config', 'user.name', 'Jenny Tests']);
    await git(repoRoot, ['config', 'core.autocrlf', 'false']);
    await fs.writeFile(path.join(repoRoot, 'first.js'), 'const a = 1;\n', 'utf8');
    await git(repoRoot, ['add', 'first.js']);
    const svc = createService(repoRoot);
    const res = await svc.getDiff({ staged: true });
    assert.equal(res.ok, true);
    assert.match(res.diff, /first\.js/, 'staged addition shown even with no HEAD commit');
  });

  test('getDiff truncates very large diffs', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'big.txt'), '', 'utf8');
    await git(repo, ['add', 'big.txt']);
    await git(repo, ['commit', '-m', 'empty big']);
    await fs.writeFile(path.join(repo, 'big.txt'), `${'a'.repeat(60)}\n`.repeat(5000), 'utf8');
    const svc = createService(repo);
    const res = await svc.getDiff({ path: 'big.txt' });
    assert.equal(res.truncated, true);
    assert.ok(res.diff.length <= 200000);
  });

  test('getDiff flags binary content', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
    await git(repo, ['add', 'blob.bin']);
    const svc = createService(repo);
    const res = await svc.getDiff();
    assert.equal(res.containsBinary, true);
  });

  test('getCommitDiff returns the diff a specific commit introduced', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'feature.js'), 'export const x = 1;\n', 'utf8');
    await git(repo, ['add', 'feature.js']);
    await git(repo, ['commit', '-m', 'add feature']);
    const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    const svc = createService(repo);

    const res = await svc.getCommitDiff({ hash: head });
    assert.equal(res.ok, true);
    assert.equal(res.isRepo, true);
    assert.equal(res.op, 'getCommitDiff');
    assert.equal(res.hash, head);
    assert.match(res.diff, /feature\.js/, 'the changed file appears in the commit diff');
    assert.match(res.diff, /\+export const x = 1;/);
    assert.match(res.diff, /add feature/, 'the commit message header is included');
    assert.equal(res.truncated, false);

    // An abbreviated (short) hash resolves too.
    const shortRes = await svc.getCommitDiff({ hash: head.slice(0, 7) });
    assert.equal(shortRes.ok, true);
    assert.match(shortRes.diff, /\+export const x = 1;/);
  });

  test('getCommitDiff shows the root commit as all-additions', async () => {
    const repo = await createGitRepo();
    const root = (await git(repo, ['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim();
    const svc = createService(repo);
    const res = await svc.getCommitDiff({ hash: root });
    assert.equal(res.ok, true);
    assert.match(res.diff, /README\.md/);
    assert.match(res.diff, /\+line1/, 'root commit renders the initial content as additions');
  });

  test('getCommitDiff rejects a non-hex hash before touching git (injection guard)', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    await assert.rejects(
      () => svc.getCommitDiff({ hash: '--output=/tmp/pwn' }),
      (error) => error && error.code === 'CMP-GIT-0010'
    );
    await assert.rejects(
      () => svc.getCommitDiff({ hash: 'HEAD; rm -rf .' }),
      (error) => error && error.code === 'CMP-GIT-0010'
    );
    await assert.rejects(
      () => svc.getCommitDiff({ hash: '' }),
      (error) => error && error.code === 'CMP-GIT-0010'
    );
  });

  test('getCommitDiff accepts and forwards a 64-character SHA-256 hash', async () => {
    const repo = await createGitRepo();
    const hash = 'a'.repeat(64);
    let showArgs = null;
    const exec = repoExec(repo, async (args) => {
      showArgs = args;
      return { success: true, stdout: 'sha256 diff', stderr: '' };
    });
    const res = await createService(repo, { exec }).getCommitDiff({ hash });
    assert.equal(res.ok, true);
    assert.equal(res.hash, hash);
    assert.deepEqual(showArgs, ['show', '--no-color', '--format=medium', hash, '--']);
  });

  test('getCommitDiff truncates a very large commit diff', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'big.txt'), `${'a'.repeat(60)}\n`.repeat(5000), 'utf8');
    await git(repo, ['add', 'big.txt']);
    await git(repo, ['commit', '-m', 'add big']);
    const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    const svc = createService(repo);
    const res = await svc.getCommitDiff({ hash: head });
    assert.equal(res.truncated, true);
    assert.ok(res.diff.length <= 200000);
  });

  test('getFileAtHead returns committed content, and found:false for a missing path', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    const found = await svc.getFileAtHead({ path: 'README.md' });
    assert.equal(found.found, true);
    assert.equal(found.content, 'line1\nline2\nline3\n');
    const missing = await svc.getFileAtHead({ path: 'nope.txt' });
    assert.equal(missing.found, false);
    assert.equal(missing.reason, 'not_in_head');
  });

  test('getFileAtHead returns an execution failure for a timed-out git show', async () => {
    const repo = await createGitRepo();
    const exec = repoExec(repo, async () => ({
      success: false, reason: 'timed_out', stdout: '', stderr: '', message: 'git timed out',
    }));
    const res = await createService(repo, { exec }).getFileAtHead({ path: 'README.md' });
    assert.equal(res.ok, false);
    assert.equal(res.error_code, 'CMP-GIT-0040');
    assert.equal(res.reason, 'timed_out');
  });

  test('getLog returns structured commits with parents and merge detection', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n', 'utf8');
    await git(repo, ['add', 'b.txt']);
    await git(repo, ['commit', '-m', 'second']);
    // a merge commit
    await git(repo, ['checkout', '-b', 'feature']);
    await fs.writeFile(path.join(repo, 'c.txt'), 'c\n', 'utf8');
    await git(repo, ['add', 'c.txt']);
    await git(repo, ['commit', '-m', 'feature work']);
    await git(repo, ['checkout', 'main']);
    await git(repo, ['merge', '--no-ff', 'feature', '-m', 'merge feature']);

    const svc = createService(repo);
    const res = await svc.getLog({ limit: 10 });
    assert.ok(res.commits.length >= 4);
    const merge = res.commits.find((c) => c.subject === 'merge feature');
    assert.ok(merge);
    assert.equal(merge.isMerge, true);
    assert.equal(merge.parentShas.length, 2);
    const second = res.commits.find((c) => c.subject === 'second');
    assert.equal(second.parentShas.length, 1);
    assert.match(second.dateISO, /\d{4}-\d{2}-\d{2}T/);
  });

  test('getChangedFilesByCommit parses multi-commit history including a zero-file merge', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n', 'utf8');
    await git(repo, ['add', 'b.txt']);
    await git(repo, ['commit', '-m', 'second']);
    // A merge commit with NO file changes of its own (fast content resolves
    // trivially) is the real double-NUL edge case documented on
    // parseChangedFilesByCommit; --no-ff forces a real merge commit to exist.
    await git(repo, ['checkout', '-b', 'feature']);
    await fs.writeFile(path.join(repo, 'c.txt'), 'c\n', 'utf8');
    await git(repo, ['add', 'c.txt']);
    await git(repo, ['commit', '-m', 'feature work']);
    await git(repo, ['checkout', 'main']);
    await git(repo, ['merge', '--no-ff', 'feature', '-m', 'merge feature']);

    const svc = createService(repo);
    const res = await svc.getChangedFilesByCommit({ limit: 10 });
    assert.equal(res.ok, true);
    assert.equal(res.isRepo, true);
    assert.equal(res.op, 'getChangedFilesByCommit');
    assert.ok(res.commits.length >= 4);

    // Match commits back up by hash via `git log` so we can assert on the
    // RIGHT commit regardless of history order.
    const shaOf = async (ref) => (await git(repo, ['rev-parse', ref])).stdout.trim();
    const initialSha = (await git(repo, ['rev-list', '--max-parents=0', 'HEAD'])).stdout.trim();
    const secondSha = await (async () => {
      const log = await git(repo, ['log', '--format=%H %s']);
      const line = log.stdout.split('\n').find((l) => l.endsWith(' second'));
      return line.split(' ')[0];
    })();
    const mergeSha = await shaOf('HEAD');

    const byHash = new Map(res.commits.map((c) => [c.hash, c.files]));
    assert.deepEqual(byHash.get(initialSha), ['README.md']);
    assert.deepEqual(byHash.get(secondSha), ['b.txt']);
    // The merge commit itself introduces no file changes relative to either
    // parent individually under --name-only's default (non-combined) diff.
    assert.deepEqual(byHash.get(mergeSha), []);
  });

  test('getChangedFilesByCommit clamps limit and returns an empty list on an unborn repo', async () => {
    const repo = createTrackedTempDir('jenny-workspace-git-changedfiles-unborn-');
    await git(repo, ['init']);
    await git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    const svc = createService(repo);
    const res = await svc.getChangedFilesByCommit();
    assert.equal(res.ok, true);
    assert.equal(res.isRepo, true);
    assert.deepEqual(res.commits, []);
  });

  test('getChangedFilesByCommit on a non-git workspace fails soft (isRepo:false)', async () => {
    const plainDir = createTrackedTempDir('jenny-workspace-git-changedfiles-norepo-');
    await fs.writeFile(path.join(plainDir, 'a.txt'), 'a\n', 'utf8');
    const svc = createService(plainDir);
    const res = await svc.getChangedFilesByCommit();
    assert.equal(res.ok, false);
    assert.equal(res.available, true);
    assert.equal(res.isRepo, false);
  });

  test('getChangedFilesByCommit with no configured root returns available:false', async () => {
    const svc = createService('');
    const res = await svc.getChangedFilesByCommit();
    assert.equal(res.available, false);
    assert.equal(res.reason, 'no_root');
  });

  test('getBranches lists local branches and the current one', async () => {
    const repo = await createGitRepo();
    await git(repo, ['branch', 'topic']);
    const svc = createService(repo);
    const res = await svc.getBranches();
    assert.ok(res.branches.includes('main'));
    assert.ok(res.branches.includes('topic'));
    assert.equal(res.current, 'main');
    assert.equal(res.detached, false);
    assert.equal(res.unborn, false);
  });

  test('listNonIgnoredFiles excludes gitignored files; includes tracked and untracked-non-ignored files', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, '.gitignore'), 'ignored.txt\ndist/\n', 'utf8');
    await git(repo, ['add', '.gitignore']);
    await git(repo, ['commit', '-m', 'add gitignore']);
    await fs.mkdir(path.join(repo, 'dist'), { recursive: true });
    await fs.writeFile(path.join(repo, 'dist', 'bundle.js'), 'x\n', 'utf8');
    await fs.writeFile(path.join(repo, 'ignored.txt'), 'secret\n', 'utf8');
    await fs.writeFile(path.join(repo, 'untracked.js'), 'const x = 1;\n', 'utf8');

    const svc = createService(repo);
    const res = await svc.listNonIgnoredFiles();
    assert.equal(res.ok, true);
    assert.equal(res.isRepo, true);
    assert.equal(res.op, 'listNonIgnoredFiles');
    assert.ok(Array.isArray(res.files));

    assert.ok(res.files.includes('README.md'), 'tracked file included');
    assert.ok(res.files.includes('.gitignore'), 'the tracked gitignore file itself is included');
    assert.ok(res.files.includes('untracked.js'), 'untracked non-ignored file included');
    assert.ok(!res.files.includes('ignored.txt'), 'gitignored file excluded');
    assert.ok(!res.files.some((f) => f.startsWith('dist/')), 'gitignored directory excluded');
  });

  test('blameRange returns per-line attribution', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    const res = await svc.blameRange({ path: 'README.md', startLine: 1, endLine: 2 });
    assert.equal(res.found, true);
    assert.equal(res.lines.length, 2);
    assert.equal(res.lines[0].line, 1);
    assert.equal(res.lines[0].author, 'Jenny Tests');
    assert.match(res.lines[0].sha, /^[0-9a-f]{40}$/);
    assert.equal(res.lines[0].summary, 'initial');
  });

  test('parseBlamePorcelain accepts SHA-256 object IDs', () => {
    const sha = 'a'.repeat(64);
    const input = `${sha} 1 1 1\nauthor A\nauthor-time 1\nsummary S\n\tline\n`;
    const rows = parseBlamePorcelain(input);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sha, sha);
    assert.equal(rows[0].line, 1);
  });

  test('blameRange accepts exactly 2000 lines and rejects 2001 inclusive lines', async () => {
    const repo = await createGitRepo();
    const blameCalls = [];
    const exec = repoExec(repo, async (args) => {
      blameCalls.push(args);
      return { success: true, stdout: '', stderr: '' };
    });
    const svc = createService(repo, { exec });

    const boundary = await svc.blameRange({ path: 'README.md', startLine: 1, endLine: 2000 });
    assert.equal(boundary.ok, true);
    assert.equal(boundary.found, true);
    await assert.rejects(
      () => svc.blameRange({ path: 'README.md', startLine: 1, endLine: 2001 }),
      /Invalid line range/
    );
    assert.equal(blameCalls.length, 1);
    assert.deepEqual(blameCalls[0].slice(0, 3), ['blame', '-L', '1,2000']);
  });

  test('blameRange returns an execution failure for a timed-out git blame', async () => {
    const repo = await createGitRepo();
    const exec = repoExec(repo, async () => ({
      success: false, reason: 'timed_out', stdout: '', stderr: '', message: 'git timed out',
    }));
    const res = await createService(repo, { exec })
      .blameRange({ path: 'README.md', startLine: 1, endLine: 1 });
    assert.equal(res.ok, false);
    assert.equal(res.error_code, 'CMP-GIT-0040');
    assert.equal(res.reason, 'timed_out');
  });

  test('blameRange rejects an invalid line range', async () => {
    const repo = await createGitRepo();
    const svc = createService(repo);
    await assert.rejects(
      () => svc.blameRange({ path: 'README.md', startLine: 0, endLine: 2 }),
      /Invalid line range/
    );
    await assert.rejects(
      () => svc.blameRange({ path: 'README.md', startLine: 5, endLine: 2 }),
      /Invalid line range/
    );
  });
});
