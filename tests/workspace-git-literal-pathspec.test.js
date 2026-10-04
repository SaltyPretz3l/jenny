'use strict';

// IDE-002: selected paths must be literal. Without the `:(literal)` prefix git
// treats each --pathspec-from-file entry (and every `-- <relPath>`) as a glob or
// magic pathspec, so selecting `a[1].txt` also hit `a1.txt`. The prefix is per
// path: the global --literal-pathspecs option reaches hooks through the
// environment and would silence the globs a repository's own hooks rely on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { WorkspaceGitService } = require('../services/workspace-git-service');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
  return stdout;
}

async function createRepo() {
  const root = createTrackedTempDir('jenny-git-literal-');
  await git(root, ['init']);
  await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(root, ['config', 'user.email', 'jenny@example.invalid']);
  await git(root, ['config', 'user.name', 'Jenny Tests']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(root, 'README.md'), 'readme\n', 'utf8');
  await git(root, ['add', 'README.md']);
  await git(root, ['commit', '-m', 'initial']);
  return root;
}

function createService(root) {
  return new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_git: true }),
    logger() {},
  });
}

async function porcelain(root) {
  const out = await git(root, ['status', '--porcelain']);
  return out.split('\n').filter(Boolean).sort();
}

test('stage and unstage address only the literal bracket-named file', async (t) => {
  t.after(cleanupTrackedResources);
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'a[1].txt'), 'bracket\n', 'utf8');
  await fs.writeFile(path.join(root, 'a1.txt'), 'plain\n', 'utf8');
  const svc = createService(root);

  const staged = await svc.stage({ paths: ['a[1].txt'] });
  assert.equal(staged.ok, true);
  assert.deepEqual(await porcelain(root), ['?? a1.txt', 'A  a[1].txt']);

  // Stage the sibling too, then unstage only the bracket file: a1.txt stays staged.
  await git(root, ['add', '--', 'a1.txt']);
  const unstaged = await svc.unstage({ paths: ['a[1].txt'] });
  assert.equal(unstaged.ok, true);
  assert.deepEqual(await porcelain(root), ['?? a[1].txt', 'A  a1.txt']);
});

test('discardFile on a bracket-named tracked file leaves the glob-matching sibling modified', async (t) => {
  t.after(cleanupTrackedResources);
  const root = await createRepo();
  await fs.writeFile(path.join(root, 'a[1].txt'), 'bracket\n', 'utf8');
  await fs.writeFile(path.join(root, 'a1.txt'), 'plain\n', 'utf8');
  await git(root, ['add', '--', 'a[1].txt', 'a1.txt']);
  await git(root, ['commit', '-m', 'add both']);
  await fs.writeFile(path.join(root, 'a[1].txt'), 'bracket edited\n', 'utf8');
  await fs.writeFile(path.join(root, 'a1.txt'), 'plain edited\n', 'utf8');
  const svc = createService(root);

  const res = await svc.discardFile({ path: 'a[1].txt' });
  assert.equal(res.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'a[1].txt'), 'utf8'), 'bracket\n');
  assert.equal(await fs.readFile(path.join(root, 'a1.txt'), 'utf8'), 'plain edited\n');
  assert.deepEqual(await porcelain(root), [' M a1.txt']);
});

test('a file literally named like a magic pathspec can be staged by itself', {
  skip: process.platform === 'win32' ? 'colon is not a legal Windows filename character' : false,
}, async (t) => {
  t.after(cleanupTrackedResources);
  const root = await createRepo();
  await fs.writeFile(path.join(root, ':(exclude)secret.txt'), 'magic\n', 'utf8');
  await fs.writeFile(path.join(root, 'other.txt'), 'other\n', 'utf8');
  const svc = createService(root);

  const staged = await svc.stage({ paths: [':(exclude)secret.txt'] });
  assert.equal(staged.ok, true);
  assert.deepEqual(await porcelain(root), ['?? other.txt', 'A  :(exclude)secret.txt']);
});

test('a repository hook started by an IDE commit still gets glob pathspecs', async (t) => {
  t.after(cleanupTrackedResources);
  const root = await createRepo();
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hook, [
    '#!/bin/sh',
    'printf "%s" "${GIT_LITERAL_PATHSPECS:-unset}" > hook-env.txt',
    "git diff --cached --name-only -- '*.js' > hook-glob.txt",
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o755 });
  await fs.writeFile(path.join(root, 'a[1].js'), 'bracket\n', 'utf8');
  const svc = createService(root);

  assert.equal((await svc.stage({ paths: ['a[1].js'] })).ok, true);
  const committed = await svc.commit({ message: 'hook probe' });
  assert.equal(committed.ok, true);
  assert.equal(await fs.readFile(path.join(root, 'hook-env.txt'), 'utf8'), 'unset');
  assert.equal((await fs.readFile(path.join(root, 'hook-glob.txt'), 'utf8')).trim(), 'a[1].js');
});
