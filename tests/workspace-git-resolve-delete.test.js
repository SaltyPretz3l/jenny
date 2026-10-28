'use strict';

// Row 75: resolveDelete resolves a conflict by moving the file to the recycle
// bin and staging the deletion. It only acts on paths that are unmerged right
// now, so it can never act as a general file delete, and it never needs `git
// rm` (the write-verb guard keeps rm forbidden).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { WorkspaceGitService, assertWriteVerb } = require('../services/workspace-git-service');
const { parseUnmergedPaths } = require('../services/workspace-git-parsers');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');

const execFileAsync = promisify(execFile);

function git(cwd, args) {
  return execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
}

async function gitMaybe(cwd, args) {
  try {
    return await git(cwd, args);
  } catch (error) {
    return error;
  }
}

async function createRepo() {
  const root = createTrackedTempDir('jenny-git-resolve-delete-');
  await git(root, ['init']);
  await git(root, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(root, ['config', 'user.email', 'jenny@example.invalid']);
  await git(root, ['config', 'user.name', 'Jenny Tests']);
  await git(root, ['config', 'commit.gpgsign', 'false']);
  await git(root, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(root, 'README.md'), 'readme\n', 'utf8');
  await fs.writeFile(path.join(root, 'notes.md'), 'one\n', 'utf8');
  await git(root, ['add', 'README.md', 'notes.md']);
  await git(root, ['commit', '-m', 'initial']);
  return root;
}

// main edits notes.md while `other` deletes it, then main merges other:
// a modify/delete conflict, porcelain "UD" (deleted by them).
async function createModifyDeleteConflict() {
  const root = await createRepo();
  await git(root, ['checkout', '-b', 'other']);
  await git(root, ['rm', '-q', 'notes.md']);
  await git(root, ['commit', '-m', 'delete notes']);
  await git(root, ['checkout', 'main']);
  await fs.writeFile(path.join(root, 'notes.md'), 'one\ntwo\n', 'utf8');
  await git(root, ['commit', '-am', 'edit notes']);
  await gitMaybe(root, ['merge', 'other']);
  return root;
}

// The fake recycle bin records the call and removes the file, like the real one.
function createService(root, { trash = true } = {}) {
  const trashed = [];
  const service = new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_git: true }),
    trashItemImpl: trash
      ? async (absolute) => { trashed.push(absolute); await fs.rm(absolute); }
      : null,
    logger() {},
  });
  return { service, trashed };
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('rm stays outside the write-verb allowlist', () => {
  assert.throws(() => assertWriteVerb('rm'), /unexpected git verb/);
});

test('parseUnmergedPaths returns each unmerged path once from ls-files -u -z output', () => {
  const sha = 'a'.repeat(40);
  const out = `100644 ${sha} 1\tnotes.md\x00100644 ${sha} 2\tnotes.md\x00100644 ${sha} 3\tsrc/a b.js\x00`;
  assert.deepEqual([...parseUnmergedPaths(out)].sort(), ['notes.md', 'src/a b.js']);
  assert.equal(parseUnmergedPaths('').size, 0);
});

test('resolveDelete trashes an unmerged file and clears its conflict', async () => {
  const root = await createModifyDeleteConflict();
  const { service, trashed } = createService(root);
  const before = await service.getStatus();
  assert.equal(before.files.find((file) => file.path === 'notes.md')?.state, 'conflicted', 'the fixture produced a conflict');

  const result = await service.resolveDelete({ paths: ['notes.md'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.op, 'resolveDelete');
  assert.deepEqual(result.paths, ['notes.md']);
  assert.deepEqual(trashed, [path.join(root, 'notes.md')], 'the file went to the recycle bin');
  await assert.rejects(fs.access(path.join(root, 'notes.md')));
  assert.equal((await git(root, ['ls-files', '-u'])).stdout.trim(), '', 'no unmerged entries remain');
  const status = await service.getStatus();
  assert.equal(status.files.some((file) => file.state === 'conflicted'), false);
});

test('resolveDelete resolves an already-missing unmerged file without the recycle bin', async () => {
  const root = await createModifyDeleteConflict();
  await fs.rm(path.join(root, 'notes.md'));
  const { service, trashed } = createService(root, { trash: false });
  const result = await service.resolveDelete({ paths: ['notes.md'] });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(trashed, []);
  assert.equal((await git(root, ['ls-files', '-u'])).stdout.trim(), '');
});

test('resolveDelete fails closed when the recycle bin is unreachable and the file exists', async () => {
  const root = await createModifyDeleteConflict();
  const { service } = createService(root, { trash: false });
  const result = await service.resolveDelete({ paths: ['notes.md'] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'trash_unavailable');
  assert.ok(String(result.message).length > 0, 'a user-facing message names the cause');
  await fs.access(path.join(root, 'notes.md'));
  assert.notEqual((await git(root, ['ls-files', '-u'])).stdout.trim(), '', 'still conflicted');
});

test('resolveDelete refuses a directory at an unmerged path and trashes nothing', async () => {
  const root = await createModifyDeleteConflict();
  await fs.rm(path.join(root, 'notes.md'));
  await fs.mkdir(path.join(root, 'notes.md'));
  await fs.writeFile(path.join(root, 'notes.md', 'precious.txt'), 'keep me\n', 'utf8');
  const { service, trashed } = createService(root);
  const result = await service.resolveDelete({ paths: ['notes.md'] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'directory_unsupported');
  assert.deepEqual(trashed, []);
  assert.equal(await fs.readFile(path.join(root, 'notes.md', 'precious.txt'), 'utf8'), 'keep me\n');
});

test('resolveDelete refuses a path that is not unmerged and leaves it untouched', async () => {
  const root = await createModifyDeleteConflict();
  const { service, trashed } = createService(root);
  const result = await service.resolveDelete({ paths: ['README.md'] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_conflicted');
  assert.deepEqual(trashed, []);
  assert.equal(await fs.readFile(path.join(root, 'README.md'), 'utf8'), 'readme\n');
  assert.equal((await git(root, ['ls-files', 'README.md'])).stdout.trim(), 'README.md');
});

test('resolveDelete with no paths is a clean no-op', async () => {
  const root = await createRepo();
  const result = await createService(root).service.resolveDelete({ paths: [] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.paths, []);
});
