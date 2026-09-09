'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createWorkspaceSnapshot, removeSnapshot } = require('../services/execution/desktop-workspace-snapshot');
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-sandbox-snapshot-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace with spaces ü');
  await fs.mkdir(root);
  return { base, root, stagingRoot: path.join(base, 'staging') };
}
test('snapshot copies Unicode files without modifying the canonical workspace', async (t) => {
  const setup = await fixture(t);
  await fs.writeFile(path.join(setup.root, 'hello ü.txt'), 'original');
  const result = await createWorkspaceSnapshot(setup);
  assert.equal(await fs.readFile(path.join(result.directory, 'hello ü.txt'), 'utf8'), 'original');
  assert.match(result.digest, /^[a-f0-9]{64}$/u);
  await fs.writeFile(path.join(setup.root, 'hello ü.txt'), 'changed later');
  assert.equal(await fs.readFile(path.join(result.directory, 'hello ü.txt'), 'utf8'), 'original');
  await removeSnapshot({ ...result, stagingRoot: setup.stagingRoot });
});
test('snapshot rejects quotas and removes partial stages', async (t) => {
  const setup = await fixture(t);
  await fs.writeFile(path.join(setup.root, 'large'), '1234');
  await assert.rejects(createWorkspaceSnapshot({ ...setup, limits: { entries: 2, bytes: 3, depth: 32, pathBytes: 4096 } }), /snapshot_limit/u);
  assert.deepEqual(await fs.readdir(setup.stagingRoot), []);
});
test('snapshot refuses junction escape and hard links', async (t) => {
  const setup = await fixture(t);
  const outside = path.join(setup.base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret'), 'secret');
  await fs.symlink(outside, path.join(setup.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createWorkspaceSnapshot(setup), /snapshot_link_rejected/u);
  await fs.unlink(path.join(setup.root, 'escape'));
  await fs.link(path.join(outside, 'secret'), path.join(setup.root, 'hard'));
  await assert.rejects(createWorkspaceSnapshot(setup), /snapshot_special_file_rejected/u);
});
test('snapshot rejects profile overlap and pre-cancelled admission', async (t) => {
  const setup = await fixture(t);
  await assert.rejects(createWorkspaceSnapshot({ ...setup, forbiddenRoots: [setup.root] }), /snapshot_profile_overlap/u);
  await assert.rejects(createWorkspaceSnapshot({ ...setup, signal: AbortSignal.abort() }), /sandbox_cancelled/u);
});
test('staging content changes invalidate the approval snapshot digest', async t => {
 const fs = require('node:fs/promises'); const path = require('node:path');
 const { createWorkspaceSnapshot, verifyWorkspaceSnapshot } = require('../services/execution/desktop-workspace-snapshot');
 const base = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'jenny-snapshot-digest-'));
 t.after(() => fs.rm(base, { recursive: true, force: true }));
 const root = path.join(base, 'workspace'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'file'), 'before');
 const snapshot = await createWorkspaceSnapshot({ root, stagingRoot: path.join(base, 'staging') });
 await verifyWorkspaceSnapshot(snapshot);
 const file = path.join(snapshot.directory, 'file'); await fs.chmod(file, 0o600); await fs.writeFile(file, 'after');
 await assert.rejects(verifyWorkspaceSnapshot(snapshot), /snapshot_changed/);
});

test('replacing the workspace root invalidates pending snapshot identity', async t => {
 const fs = require('node:fs/promises'); const path = require('node:path');
 const { createWorkspaceSnapshot, verifyWorkspaceSnapshot } = require('../services/execution/desktop-workspace-snapshot');
 const base = await fs.mkdtemp(path.join(require('node:os').tmpdir(), 'jenny-snapshot-root-'));
 t.after(() => fs.rm(base, { recursive: true, force: true }));
 const root = path.join(base, 'workspace'); await fs.mkdir(root);
 const snapshot = await createWorkspaceSnapshot({ root, stagingRoot: path.join(base, 'staging') });
 await fs.rename(root, path.join(base, 'previous-workspace')); await fs.mkdir(root);
 await assert.rejects(verifyWorkspaceSnapshot(snapshot), /snapshot_changed/);
});
