'use strict';

// Row 34 S5 step 4: file-by-file checkpoint preflight and restore (worktree
// only, index untouched) with a pinned rollback ref that doubles as Redo.
// Real temp repos behind the real WorkspaceGitService and the IPC handlers.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const { checkpointRefIsSafe } = require('../services/workspace-git-checkpoint');
const { normalizeDiffInputText, sha256Text } = require('../services/tools/structured-diff');
const { sha256Bytes } = require('../services/workspace-recovery-safety-copies');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { createGitRepo, createRecoveryHarness, createTrash, git } = require('./helpers/workspace-recovery-harness');

const SCRIPT_TEXT = 'script\r\nwrote this\r\n';

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// Committed: README.md, tracked.txt, same.txt. Untracked: notes.txt, and a
// staged edit to staged.txt so an index change is visible if anything touches it.
async function seedRepoWithCheckpoint(rig, repo) {
  await fs.writeFile(path.join(repo, 'README.md'), 'readme\n');
  await fs.writeFile(path.join(repo, 'tracked.txt'), 'tracked before\n');
  await fs.writeFile(path.join(repo, 'same.txt'), 'unchanged\n');
  await fs.writeFile(path.join(repo, 'staged.txt'), 'base\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  await fs.writeFile(path.join(repo, 'staged.txt'), 'staged edit\n');
  await git(repo, ['add', 'staged.txt']);
  await fs.writeFile(path.join(repo, 'notes.txt'), 'notes before\n');
  const created = await rig.gitService.createCheckpoint({ session: 'sess_files' });
  assert.equal(created.created, true);
  // The "script" turn.
  await fs.writeFile(path.join(repo, 'tracked.txt'), SCRIPT_TEXT);
  await fs.writeFile(path.join(repo, 'README.md'), 'sibling change\n');
  await fs.writeFile(path.join(repo, 'notes.txt'), 'notes by script\n');
  await fs.writeFile(path.join(repo, 'made.txt'), 'made by script\n');
  return created.ref;
}

async function indexSnapshot(repo) {
  return (await git(repo, ['ls-files', '-s'])).stdout;
}

describe('preflightCheckpointFiles (real repo)', () => {
  test('classifies tracked/untracked/absent and compares blob ids and after-hashes', async () => {
    const repo = await createGitRepo();
    const rig = createRecoveryHarness(repo);
    const ref = await seedRepoWithCheckpoint(rig, repo);
    await fs.writeFile(path.join(repo, 'binary.bin'), Buffer.from([0x41, 0x00, 0x42]));
    await fs.writeFile(path.join(repo, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
    const textHash = sha256Text(normalizeDiffInputText(SCRIPT_TEXT));
    const result = await rig.invoke('workspaceRecovery.preflightCheckpointFiles', {
      ref,
      files: [
        { path: 'tracked.txt', afterHash: textHash, hashKind: 'diff_input_text' },
        { path: 'same.txt', afterHash: sha256Bytes(Buffer.from('other')), hashKind: 'raw_bytes' },
        { path: 'notes.txt', afterHash: sha256Bytes(Buffer.from('notes by script\n')), hashKind: 'raw_bytes' },
        { path: 'made.txt' },
        { path: 'gone.txt' },
        { path: 'binary.bin', afterHash: textHash, hashKind: 'diff_input_text' },
        { path: 'large.txt', afterHash: textHash, hashKind: 'raw_bytes' },
      ],
    });
    assert.equal(result.ok, true);
    const byPath = Object.fromEntries(result.files.map((item) => [item.path, item]));
    assert.deepEqual(
      Object.values(byPath).map((item) => [item.path, item.inCheckpoint, item.exists, item.kind, item.matchesCheckpoint, item.matchesAfter]),
      [
        ['tracked.txt', 'tracked', true, 'file', false, true],
        ['same.txt', 'tracked', true, 'file', true, false],
        ['notes.txt', 'untracked', true, 'file', false, true],
        ['made.txt', 'absent', true, 'file', false, null],
        ['gone.txt', 'absent', false, 'missing', null, null],
        ['binary.bin', 'absent', true, 'file', false, null],
        ['large.txt', 'absent', true, 'file', false, null],
      ],
    );
    assert.equal(byPath['tracked.txt'].size, Buffer.byteLength(SCRIPT_TEXT));
    assert.equal(typeof byPath['tracked.txt'].mtimeMs, 'number');
    assert.ok(!JSON.stringify(result).includes(repo), 'no absolute path reaches the renderer');
  });

  test('an unknown checkpoint is reported, not thrown', async () => {
    const repo = await createGitRepo();
    const rig = createRecoveryHarness(repo);
    await seedRepoWithCheckpoint(rig, repo);
    const result = await rig.invoke('workspaceRecovery.preflightCheckpointFiles', {
      ref: 'refs/jenny/checkpoints/sess_files/99', files: [{ path: 'tracked.txt' }],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'checkpoint_not_found');
  });
});

describe('restoreCheckpointFiles (real repo)', () => {
  test('restores only the named files, leaves the index alone, trashes removePaths, and Redo comes back', async () => {
    const repo = await createGitRepo();
    const rig = createRecoveryHarness(repo);
    const ref = await seedRepoWithCheckpoint(rig, repo);
    const indexBefore = await indexSnapshot(repo);

    const undone = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', {
      ref, paths: ['tracked.txt', 'notes.txt', 'never.txt'], removePaths: ['made.txt'],
    });
    assert.equal(undone.ok, true);
    assert.deepEqual(undone.restored, ['tracked.txt', 'notes.txt']);
    assert.deepEqual(undone.removed, ['made.txt']);
    assert.deepEqual(undone.failed, [{ path: 'never.txt', reason: 'not_in_checkpoint' }]);
    assert.ok(checkpointRefIsSafe(undone.rollbackRef), 'rollback-* refs pass the ref validation');
    assert.match(undone.rollbackRef, /^refs\/jenny\/checkpoints\/rollback-sess_files\/\d+$/);
    assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), 'tracked before\n');
    assert.equal(await fs.readFile(path.join(repo, 'notes.txt'), 'utf8'), 'notes before\n');
    assert.equal(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), 'sibling change\n', 'a sibling change survives');
    assert.equal(await indexSnapshot(repo), indexBefore, 'the index is untouched');
    await assert.rejects(fs.stat(path.join(repo, 'made.txt')), { code: 'ENOENT' });
    assert.equal(rig.trash.items.length, 1);
    assert.equal(path.basename(rig.trash.items[0].from), 'made.txt');

    const redo = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', {
      ref: undone.rollbackRef, paths: ['tracked.txt', 'notes.txt', 'made.txt'],
    });
    assert.equal(redo.ok, true);
    assert.deepEqual(redo.restored, ['tracked.txt', 'notes.txt', 'made.txt']);
    assert.ok(checkpointRefIsSafe(redo.rollbackRef));
    assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), SCRIPT_TEXT, "Jenny's bytes come back exactly");
    assert.equal(await fs.readFile(path.join(repo, 'notes.txt'), 'utf8'), 'notes by script\n');
    assert.equal(await fs.readFile(path.join(repo, 'made.txt'), 'utf8'), 'made by script\n');
    assert.equal(await indexSnapshot(repo), indexBefore);
  });

  test('removePaths present in the checkpoint or absent on disk are refused per path', async () => {
    const repo = await createGitRepo();
    const rig = createRecoveryHarness(repo);
    const ref = await seedRepoWithCheckpoint(rig, repo);
    const result = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', {
      ref, paths: [], removePaths: ['same.txt', 'nothing-here.txt'],
    });
    assert.deepEqual(result.failed, [
      { path: 'same.txt', reason: 'in_checkpoint' },
      { path: 'nothing-here.txt', reason: 'not_found' },
    ]);
    assert.deepEqual(result.removed, []);
    assert.equal(result.rollbackRef, null, 'nothing actionable pins no rollback');
    assert.equal(await fs.readFile(path.join(repo, 'same.txt'), 'utf8'), 'unchanged\n');
  });

  test('removePaths without a recycle bin refuse the whole request before anything changes', async () => {
    const repo = await createGitRepo();
    const rig = createRecoveryHarness(repo, { trash: createTrash({ available: false }) });
    const ref = await seedRepoWithCheckpoint(rig, repo);
    const refsBefore = (await git(repo, ['for-each-ref', 'refs/jenny'])).stdout;
    const result = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', {
      ref, paths: ['tracked.txt'], removePaths: ['made.txt'],
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'trash_unavailable');
    assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), SCRIPT_TEXT);
    assert.equal((await git(repo, ['for-each-ref', 'refs/jenny'])).stdout, refsBefore, 'no rollback ref was pinned');
  });

  test('a directory now sitting at a checkpoint path is skipped as a conflict, never replaced', async () => {
    const repo = await createGitRepo();
    const rig = createRecoveryHarness(repo);
    const ref = await seedRepoWithCheckpoint(rig, repo);
    await fs.rm(path.join(repo, 'notes.txt'));
    await fs.mkdir(path.join(repo, 'notes.txt'));
    await fs.writeFile(path.join(repo, 'notes.txt', 'keep.txt'), 'keep\n');
    const result = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', { ref, paths: ['notes.txt', 'tracked.txt'] });
    assert.deepEqual(result.restored, ['tracked.txt']);
    assert.deepEqual(result.failed, [{ path: 'notes.txt', reason: 'path_conflict' }]);
    assert.equal(await fs.readFile(path.join(repo, 'notes.txt', 'keep.txt'), 'utf8'), 'keep\n');
  });
});

describe('restoreCheckpointFiles rollback coverage (real repo)', () => {
  test('a file the rollback could not capture (over the untracked cap) is refused, never overwritten', async () => {
    const repo = await createGitRepo();
    const rig = createRecoveryHarness(repo);
    const ref = await seedRepoWithCheckpoint(rig, repo);
    const grown = Buffer.alloc(10 * 1024 * 1024 + 1, 0x62);
    await fs.writeFile(path.join(repo, 'notes.txt'), grown);
    const result = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', { ref, paths: ['notes.txt', 'tracked.txt'] });
    assert.deepEqual(result.restored, ['tracked.txt']);
    assert.deepEqual(result.failed, [{ path: 'notes.txt', reason: 'rollback_incomplete' }]);
    assert.ok((await fs.readFile(path.join(repo, 'notes.txt'))).equals(grown), 'the uncaptured file is untouched');
  });
});

describe('checkpoint file path containment', () => {
  test('a symlink or junction escape is refused before any restore', async () => {
    const repo = await createGitRepo();
    const rig = createRecoveryHarness(repo);
    const ref = await seedRepoWithCheckpoint(rig, repo);
    const outside = createTrackedTempDir('jenny-recovery-outside-');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'secret\n');
    fsSync.symlinkSync(outside, path.join(repo, 'linkdir'), process.platform === 'win32' ? 'junction' : 'dir');
    const refsBefore = (await git(repo, ['for-each-ref', 'refs/jenny'])).stdout;
    const preflight = await rig.invoke('workspaceRecovery.preflightCheckpointFiles', { ref, files: [{ path: 'linkdir/secret.txt' }] });
    const restore = await rig.invoke('workspaceRecovery.restoreCheckpointFiles', {
      ref, paths: ['tracked.txt'], removePaths: ['linkdir/secret.txt'],
    });
    assert.equal(preflight.reason, 'path_outside_root');
    assert.equal(restore.reason, 'path_outside_root');
    assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'secret\n');
    assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), SCRIPT_TEXT);
    assert.equal((await git(repo, ['for-each-ref', 'refs/jenny'])).stdout, refsBefore);
  });

  test('the git service refuses dot-dot and absolute paths with a clean result', async () => {
    const repo = await createGitRepo();
    const rig = createRecoveryHarness(repo);
    const ref = await seedRepoWithCheckpoint(rig, repo);
    for (const bad of ['../escape.txt', path.join(repo, 'tracked.txt'), 'C:/x.txt']) {
      const result = await rig.gitService.restoreCheckpointFiles({ ref, paths: [bad] });
      assert.equal(result.ok, false, bad);
      assert.equal(result.reason, 'path_invalid', bad);
    }
    assert.equal(await fs.readFile(path.join(repo, 'tracked.txt'), 'utf8'), SCRIPT_TEXT);
  });
});
