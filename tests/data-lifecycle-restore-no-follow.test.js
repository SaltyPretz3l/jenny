'use strict';

// Restore removes rollback and staging trees that sit beside the profile or inside the user's workspace,
// and those trees can hold a junction (a moved profile folder, an `npm link`, a planted link). Node's rm
// follows a junction into its target after one transient EPERM, so every removal here must go through
// the no-follow remover: the junction is unlinked and whatever it points at is never touched.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { finalizeRestoredBoot } = require('../services/data-lifecycle/restore-service');
const { rollbackPromotion } = require('../services/data-lifecycle/restore-runtime-backup');
const { removeWorkspaceRestoreStage } = require('../services/data-lifecycle/workspace-restore-durability');

const realRmSync = fs.rmSync;
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-restore-no-follow-'));
  t.after(() => realRmSync(root, { recursive: true, force: true }));
  return root;
}

function plantJunction(root, linkPath) {
  const outside = fs.mkdtempSync(path.join(root, 'outside-'));
  fs.writeFileSync(path.join(outside, 'keep'), 'untouched');
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(outside, linkPath, LINK_TYPE);
  return outside;
}

function isLink(file) {
  try { return fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

// Node's rm is forbidden outright, and the first unlink of every link answers EPERM the way a transient
// lock does on Windows. Returns the set of links whose unlink was refused once.
function injectTransientLinkLocks(t) {
  const failed = new Set();
  const forbidden = () => { throw new Error('Node rm follows junctions after EPERM'); };
  t.mock.method(fs, 'rmSync', forbidden);
  t.mock.method(fs.promises, 'rm', async () => forbidden());
  const refuseOnce = (file) => {
    if (!isLink(file) || failed.has(path.resolve(file))) return false;
    failed.add(path.resolve(file));
    return true;
  };
  const lock = () => Object.assign(new Error('transient lock'), { code: 'EPERM' });
  const unlinkSync = fs.unlinkSync;
  const unlink = fs.promises.unlink;
  t.mock.method(fs, 'unlinkSync', (file) => {
    if (refuseOnce(file)) throw lock();
    return unlinkSync(file);
  });
  t.mock.method(fs.promises, 'unlink', async (file) => {
    if (refuseOnce(file)) throw lock();
    return unlink(file);
  });
  return failed;
}

test('finalizing a restored boot never enters a junction in the profile rollback tree', async (t) => {
  const root = tempRoot(t);
  const userDataPath = path.join(root, 'profile');
  const operationId = crypto.randomUUID();
  const rollbackRoot = path.join(root, `profile.jenny-restore-rollback-${operationId}`);
  const stagePath = path.join(root, `profile.jenny-restore-${operationId}.staging`);
  const markerPath = path.join(userDataPath, 'data-lifecycle', 'restore-active.json');
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, JSON.stringify({
    schema_version: 1, operation_id: operationId, rollback_path: rollbackRoot, stage_path: stagePath, status: 'promoted',
  }));
  const nestedLink = path.join(rollbackRoot, 'user', 'personality', 'default-workspace', 'linked-project');
  const outside = plantJunction(root, nestedLink);
  fs.writeFileSync(path.join(rollbackRoot, 'user', 'sessions.json'), '{}');
  const stageLink = path.join(stagePath, 'data', 'linked');
  plantJunction(root, stageLink);
  const failed = injectTransientLinkLocks(t);

  assert.equal(await finalizeRestoredBoot(userDataPath), true);

  assert.deepEqual([...failed].sort(), [nestedLink, stageLink].sort());
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
  assert.equal(fs.existsSync(rollbackRoot), false);
  assert.equal(fs.existsSync(stagePath), false);
  assert.equal(fs.existsSync(markerPath), false);
});

test('promotion rollback never enters a junction in a restored target or the rollback root', (t) => {
  const root = tempRoot(t);
  const userDataPath = path.join(root, 'profile');
  const targetPath = path.join(userDataPath, 'attachments');
  const rollbackRoot = path.join(root, 'profile.jenny-restore-rollback-test');
  const targetLink = path.join(targetPath, 'linked');
  const rollbackLink = path.join(rollbackRoot, 'user', 'linked');
  const outside = plantJunction(root, targetLink);
  const rollbackOutside = plantJunction(root, rollbackLink);
  fs.writeFileSync(path.join(targetPath, 'asset.bin'), 'restored');
  const failed = injectTransientLinkLocks(t);

  rollbackPromotion([{ targetPath, ownerRoot: userDataPath, ownerKey: 'user' }], rollbackRoot,
    (_ownerRoot, target) => path.resolve(target), true);

  assert.deepEqual([...failed].sort(), [targetLink, rollbackLink].sort());
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
  assert.deepEqual(fs.readdirSync(rollbackOutside), ['keep']);
  assert.equal(fs.existsSync(targetPath), false);
  assert.equal(fs.existsSync(rollbackRoot), false);
});

test('removing a workspace restore stage never enters a junction inside the user workspace', async (t) => {
  const root = tempRoot(t);
  const stagingRoot = path.join(root, 'workspace', '.jenny', '.restore-staging');
  const stagePath = path.join(stagingRoot, 'stage-abc123');
  const stageLink = path.join(stagePath, 'rollback', 'workspace', 'node_modules', 'linked-package');
  const outside = plantJunction(root, stageLink);
  fs.writeFileSync(path.join(stagePath, 'workspace-restore-journal.json'), '{}');
  const failed = injectTransientLinkLocks(t);

  await removeWorkspaceRestoreStage(stagePath, stagingRoot);

  assert.deepEqual([...failed], [stageLink]);
  assert.deepEqual(fs.readdirSync(outside), ['keep']);
  assert.equal(fs.existsSync(stagingRoot), false);
});
