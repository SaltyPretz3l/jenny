'use strict';
// WorkspaceGitService.checkIgnored (row 82 X1, services/workspace-git-ignore-reads.js):
// kept out of workspace-git-service-reads.test.js at its 600-line ratchet, with its
// own copy of the tiny repo/service fixtures (same reason as that file's header).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { WorkspaceGitService } = require('../services/workspace-git-service');
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

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('WorkspaceGitService.checkIgnored (Row 82 X1)', () => {
  // repoExec's handler only sees argv; this one also records the stdin input.
  function ignoreExec(repo, result) {
    const calls = [];
    const exec = async (cwd, args, opts = {}) => {
      if (args.includes('--is-inside-work-tree')) return { success: true, stdout: `true\n${repo}\n` };
      if (args.includes('--show-toplevel')) return { success: true, stdout: `${repo}\n` };
      calls.push({ cwd, args, input: opts.input });
      return result;
    };
    return { exec, calls };
  }
  // The runners do not expose exit codes; exit 1 surfaces as an empty-output git_failed.
  const NO_MATCH = {
    success: false, reason: 'git_failed', stdout: '', stderr: '', message: 'Command failed: git check-ignore --stdin -z',
  };

  test('returns the ignored subset via check-ignore --stdin -z', async () => {
    const repo = await createGitRepo();
    const { exec, calls } = ignoreExec(repo, { success: true, stdout: 'dist/a.js\0', stderr: '' });
    const res = await createService(repo, { exec }).checkIgnored({ paths: ['dist/a.js', 'src/b.js'] });
    assert.equal(res.ok, true);
    assert.equal(res.op, 'checkIgnored');
    assert.deepEqual(res.ignored, ['dist/a.js']);
    assert.equal(res.truncated, undefined);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['check-ignore', '--stdin', '-z']);
    assert.equal(calls[0].cwd, repo);
    assert.equal(calls[0].input, 'dist/a.js\0src/b.js\0');
  });

  test('exit 1 with empty output means nothing is ignored', async () => {
    const repo = await createGitRepo();
    const { exec } = ignoreExec(repo, NO_MATCH);
    const res = await createService(repo, { exec }).checkIgnored({ paths: ['src/b.js'] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.ignored, []);
  });

  test('drops invalid paths, de-duplicates, and ignores unrequested output entries', async () => {
    const repo = await createGitRepo();
    const { exec, calls } = ignoreExec(repo, { success: true, stdout: 'a.js\0stray.js\0', stderr: '' });
    const res = await createService(repo, { exec }).checkIgnored({
      paths: ['../x', '/abs', 'C:/win', 'a\0b', '', null, 'a.js', './a.js', 'a.js'],
    });
    assert.equal(calls[0].input, 'a.js\0');
    assert.deepEqual(res.ignored, ['a.js']);
  });

  test('caps the batch at 2000 paths and flags truncated', async () => {
    const repo = await createGitRepo();
    const { exec, calls } = ignoreExec(repo, NO_MATCH);
    const paths = Array.from({ length: 2001 }, (_, i) => `f${i}.js`);
    const res = await createService(repo, { exec }).checkIgnored({ paths });
    assert.equal(res.ok, true);
    assert.equal(res.truncated, true);
    assert.equal(calls[0].input.split('\0').filter(Boolean).length, 2000);
  });

  test('an empty (or all-invalid) list does not spawn git', async () => {
    const repo = await createGitRepo();
    const { exec, calls } = ignoreExec(repo, { success: true, stdout: '' });
    const res = await createService(repo, { exec }).checkIgnored({ paths: ['../x'] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.ignored, []);
    assert.equal(calls.length, 0);
  });

  test('a real git failure (exit 128) maps to the failure shape', async () => {
    const repo = await createGitRepo();
    const { exec } = ignoreExec(repo, {
      success: false, reason: 'git_failed', stdout: '', stderr: 'fatal: bad', message: 'fatal: bad',
    });
    const res = await createService(repo, { exec }).checkIgnored({ paths: ['a.js'] });
    assert.equal(res.ok, false);
    assert.equal(res.op, 'checkIgnored');
    assert.equal(res.error_code, 'CMP-GIT-0040');
  });

  test('a timeout is a failure, not an empty result', async () => {
    const repo = await createGitRepo();
    const { exec } = ignoreExec(repo, {
      success: false, reason: 'git_failed', stdout: '', stderr: '', message: 'Git command timed out.',
    });
    const res = await createService(repo, { exec }).checkIgnored({ paths: ['a.js'] });
    assert.equal(res.ok, false);
  });

  test('works against a real repo, and listNonIgnoredFiles keeps its shape', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, '.gitignore'), 'dist/\n', 'utf8');
    await fs.mkdir(path.join(repo, 'dist'));
    await fs.writeFile(path.join(repo, 'dist', 'a.js'), 'x', 'utf8');
    await fs.writeFile(path.join(repo, 'b.js'), 'x', 'utf8');
    const svc = createService(repo);
    const res = await svc.checkIgnored({ paths: ['dist/a.js', 'b.js', 'README.md'] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.ignored, ['dist/a.js']);
    const none = await svc.checkIgnored({ paths: ['b.js', 'README.md'] });
    assert.equal(none.ok, true);
    assert.deepEqual(none.ignored, []);
    const listed = await svc.listNonIgnoredFiles();
    assert.equal(listed.ok, true);
    assert.equal(listed.op, 'listNonIgnoredFiles');
    assert.deepEqual([...listed.files].sort(), ['.gitignore', 'README.md', 'b.js']);
  });
});
