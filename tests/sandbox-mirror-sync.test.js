'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { stageMirrorSync, verifyMirrorSync, readMirrorIndex, commitMirrorIndex, invalidateMirrorIndex,
  mirrorIdFor, SYNCED_LIMITS } = require('../services/execution/sandbox-mirror-sync');
const { removeSnapshot } = require('../services/execution/desktop-workspace-snapshot');

async function write(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text);
}
async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-mirror-sync-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace ü');
  await write(path.join(root, 'a.txt'), 'alpha');
  await write(path.join(root, 'src', 'b.js'), 'beta');
  await write(path.join(root, '.git', 'config'), '[core]\n\thooksPath = tools/hooks\n');
  await write(path.join(root, '.venv', 'x.py'), 'venv');
  await write(path.join(root, '.jenny', 'state.json'), '{}');
  await write(path.join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
  await write(path.join(root, 'tools', 'hooks', 'pre-commit'), '#!/bin/sh\n');
  await write(path.join(root, 'sub', '.git'), 'gitdir: ../.bare\n');
  await write(path.join(root, '.bare', 'config'), '[core]\n');
  await fs.mkdir(path.join(root, 'empty'));
  return { base, root, stagingRoot: path.join(base, 'staging'), indexFile: path.join(base, 'mirrors', 'index.json') };
}
async function readSync(stage) {
  return JSON.parse(await fs.readFile(path.join(stage.directory, 'sync.json'), 'utf8'));
}
async function staged(stage) {
  const sync = await readSync(stage);
  const result = {};
  for (const [relative, file] of sync.files) result[relative] = await fs.readFile(path.join(stage.directory, 'files', file), 'utf8');
  return result;
}
function commitClean(setup, stage) {
  return commitMirrorIndex(setup.indexFile, stage, { index: stage.index, resync: new Set(), trees: new Set(), full: false });
}

test('first sync is full, skips git, venv and jenny folders and in-root gitdirs, and keeps node_modules', async (t) => {
  const setup = await fixture(t);
  const stage = await stageMirrorSync(setup);
  const sync = await readSync(stage);
  assert.equal(sync.full, true);
  assert.deepEqual(Object.keys(await staged(stage)).sort(),
    ['a.txt', 'node_modules/pkg/index.js', 'src/b.js', 'tools/hooks/pre-commit']);
  assert.ok(sync.directories.includes('empty'));
  assert.deepEqual(stage.policy.hooks, ['tools/hooks']);
  assert.deepEqual(stage.policy.gitDirs, ['.bare']);
  assert.equal(stage.index.has('.bare/config'), false);
  assert.equal(stage.index.has('sub/.git'), false);
  assert.match(stage.digest, /^[a-f0-9]{64}$/u);
  assert.equal(stage.mirrorId, mirrorIdFor(stage.rootIdentity));
  assert.match(stage.mirrorId, /^[a-f0-9]{16}$/u);
  assert.ok(sync.protected.names.includes('node_modules'));
  assert.ok(sync.protected.paths.includes('tools/hooks'));
});

test('later syncs stage only changed and new files, list deletions and keep the state digest content-based', async (t) => {
  const setup = await fixture(t);
  const first = await stageMirrorSync(setup);
  await commitClean(setup, first);
  await removeSnapshot({ directory: first.directory, stagingRoot: setup.stagingRoot });
  const unchanged = await stageMirrorSync(setup);
  assert.equal(unchanged.digest, first.digest);
  assert.deepEqual((await readSync(unchanged)).files, []);
  await removeSnapshot({ directory: unchanged.directory, stagingRoot: setup.stagingRoot });

  await write(path.join(setup.root, 'a.txt'), 'alpha two');
  await write(path.join(setup.root, 'src', 'new.js'), 'new');
  await fs.rm(path.join(setup.root, 'src', 'b.js'));
  await fs.rm(path.join(setup.root, 'empty'), { recursive: true });
  const second = await stageMirrorSync(setup);
  const sync = await readSync(second);
  assert.equal(sync.full, false);
  assert.deepEqual(await staged(second), { 'a.txt': 'alpha two', 'src/new.js': 'new' });
  assert.deepEqual(sync.deletes.sort(), ['empty', 'src/b.js']);
  assert.notEqual(second.digest, first.digest);
});

test('resync paths and trees are restaged or removed on the next run', async (t) => {
  const setup = await fixture(t);
  const first = await stageMirrorSync(setup);
  await commitMirrorIndex(setup.indexFile, first, { index: first.index,
    resync: new Set(['a.txt', 'gone.txt']), trees: new Set(['node_modules', '.GIT']), full: false });
  await removeSnapshot({ directory: first.directory, stagingRoot: setup.stagingRoot });
  const second = await stageMirrorSync(setup);
  const sync = await readSync(second);
  assert.deepEqual(Object.keys(await staged(second)).sort(), ['a.txt', 'node_modules/pkg/index.js']);
  assert.deepEqual(sync.trees.sort(), ['.GIT', 'node_modules']);
  assert.ok(sync.deletes.includes('gone.txt'));
  assert.ok(sync.directories.includes('node_modules/pkg'));
});

test('links and junctions are skipped and never followed; hard-linked files sync by content', async (t) => {
  const setup = await fixture(t);
  const outside = path.join(setup.base, 'outside');
  await write(path.join(outside, 'secret.txt'), 'secret');
  await fs.symlink(outside, path.join(setup.root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.link(path.join(setup.root, 'a.txt'), path.join(setup.root, 'hard.txt'));
  const stage = await stageMirrorSync(setup);
  const files = await staged(stage);
  assert.equal(Object.keys(files).some((name) => name.startsWith('escape')), false);
  assert.equal(files['hard.txt'], 'alpha');
  assert.deepEqual(stage.skipped, [{ path: 'escape', reason: 'link' }]);
});

test('admission re-walk refuses drift, a replaced root and a tampered stage', async (t) => {
  const setup = await fixture(t);
  const stage = await stageMirrorSync(setup);
  await verifyMirrorSync(stage);
  await write(path.join(setup.root, 'late.txt'), 'late');
  await assert.rejects(verifyMirrorSync(stage), /snapshot_changed/u);
  await fs.rm(path.join(setup.root, 'late.txt'));
  await verifyMirrorSync(stage);
  await write(path.join(setup.root, 'a.txt'), 'edited');
  await assert.rejects(verifyMirrorSync(stage), /snapshot_changed/u);

  const again = await stageMirrorSync(setup);
  const file = path.join(again.directory, 'files', (await readSync(again)).files[0][1]);
  await fs.chmod(file, 0o600);
  await fs.writeFile(file, 'tampered');
  await assert.rejects(verifyMirrorSync(again), /snapshot_changed/u);
});

test('limits, profile overlap and cancellation refuse the run and remove the partial stage', async (t) => {
  const setup = await fixture(t);
  await assert.rejects(stageMirrorSync({ ...setup, limits: { ...SYNCED_LIMITS, entries: 3 } }), /snapshot_limit/u);
  await assert.rejects(stageMirrorSync({ ...setup, limits: { ...SYNCED_LIMITS, bytes: 4 } }), /snapshot_limit/u);
  await assert.rejects(stageMirrorSync({ ...setup, forbiddenRoots: [setup.root] }), /snapshot_profile_overlap/u);
  await assert.rejects(stageMirrorSync({ ...setup, signal: AbortSignal.abort() }), /sandbox_cancelled/u);
  assert.deepEqual(await fs.readdir(setup.stagingRoot).catch(() => []), []);
});

test('a missing, corrupt, foreign or invalidated index means a full sync', async (t) => {
  const setup = await fixture(t);
  const first = await stageMirrorSync(setup);
  await commitClean(setup, first);
  await removeSnapshot({ directory: first.directory, stagingRoot: setup.stagingRoot });
  assert.equal((await readMirrorIndex(setup.indexFile, first)).full, false);
  assert.equal((await readMirrorIndex(setup.indexFile, { ...first, rootIdentity: 'f'.repeat(64) })).full, true);
  await fs.writeFile(setup.indexFile, '{not json');
  assert.equal((await readMirrorIndex(setup.indexFile, first)).full, true);
  await commitClean(setup, first);
  await invalidateMirrorIndex(setup.indexFile);
  const stage = await stageMirrorSync(setup);
  assert.equal((await readSync(stage)).full, true);
});
