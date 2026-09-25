'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createArchive } = require('../services/data-lifecycle/archive-service');
const restore = require('../services/data-lifecycle/restore-service');
const startup = require('../services/main/data-lifecycle-startup');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-restore-volumes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const userDataPath = path.join(root, 'profile');
  const home = path.join(root, 'home');
  const runtimePath = path.join(home, '.companion');
  fs.mkdirSync(userDataPath);
  fs.mkdirSync(runtimePath, { recursive: true });
  const target = path.join(runtimePath, 'memory.db');
  fs.writeFileSync(target, 'original');
  const archive = await createArchive({ destinationRoot: path.join(root, 'archives'), encrypted: false,
    entries: [{ logicalPath: 'memory/legacy-memory.db', category: 'memory', data: Buffer.from('replacement') }] });
  await restore.stageRestore({ archivePath: archive.archivePath, userDataPath, runtimePath });
  const pointerPath = restore.restorePointerPath(userDataPath);
  const pointer = JSON.parse(fs.readFileSync(pointerPath));
  const journalPath = path.join(pointer.stage_path, 'restore-journal.json');
  const rename = fs.renameSync;
  t.mock.method(os, 'homedir', () => home);
  // Model the volume boundary for all renames, including recovery. Copying the
  // archive's verified bytes is allowed; moving original data across it is not.
  const renameImpl = (source, destination) => {
    const inRuntime = (value) => path.resolve(value).startsWith(runtimePath + path.sep);
    if (inRuntime(source) !== inRuntime(destination)) throw Object.assign(new Error('cross volume'), { code: 'EXDEV' });
    return rename(source, destination);
  };
  t.mock.method(fs, 'renameSync', renameImpl);
  return { renameImpl, root, userDataPath, runtimePath, target, pointerPath, journalPath,
    app: { getPath: () => userDataPath } };
}

test('startup promotes and finalizes with rollback on the runtime volume', async (t) => {
  const f = await fixture(t);
  assert.equal((await startup.promotePendingRestore(f.app)).status, 'promoted');
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'replacement');
  const journal = JSON.parse(fs.readFileSync(f.journalPath));
  const backup = path.join(f.runtimePath, `.jenny-restore-rollback-${journal.operation_id}`);
  assert.equal(fs.readFileSync(path.join(backup, 'runtime', 'memory.db'), 'utf8'), 'original');
  assert.equal(await startup.finalizeSuccessfulRestoredBoot(f.app), true);
  assert.equal(fs.existsSync(backup), false);
  assert.equal((await startup.promotePendingRestore(f.app)).status, 'none');
});

test('failed copying restores original bytes and startup retry succeeds', async (t) => {
  const f = await fixture(t);
  const copy = fs.copyFileSync;
  let fail = true;
  t.mock.method(fs, 'copyFileSync', (source, destination, flags) => {
    if (destination === f.target && fail) {
      fail = false;
      throw Object.assign(new Error('injected copy refusal'), { code: 'EACCES' });
    }
    return copy(source, destination, flags);
  });
  assert.equal((await startup.promotePendingRestore(f.app)).ok, false);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'original');
  assert.equal(fs.existsSync(f.pointerPath), true);
  assert.equal(JSON.parse(fs.readFileSync(f.journalPath)).status, 'staged');
  assert.equal((await startup.promotePendingRestore(f.app)).ok, true);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'replacement');
});

test('interrupted promotion recovers on restart and refuses a changed runtime owner', async (t) => {
  const f = await fixture(t);
  const copy = fs.copyFileSync;
  const rename = f.renameImpl;
  const copyMock = t.mock.method(fs, 'copyFileSync', () => { throw new Error('interrupted copy'); });
  fs.renameSync.mock.mockImplementation( (source, destination) => {
    if (destination === f.target) throw new Error('interrupted rollback');
    return rename(source, destination);
  });
  assert.equal((await startup.promotePendingRestore(f.app)).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(f.journalPath)).status, 'copying');
  const wrongRuntime = path.join(f.root, 'other');
  fs.mkdirSync(wrongRuntime);
  fs.writeFileSync(path.join(wrongRuntime, 'memory.db'), 'unrelated');
  assert.equal((await restore.attemptPendingRestore({ userDataPath: f.userDataPath, runtimePath: wrongRuntime })).ok, false);
  assert.equal(fs.readFileSync(path.join(wrongRuntime, 'memory.db'), 'utf8'), 'unrelated');
  copyMock.mock.mockImplementation(copy);
  fs.renameSync.mock.mockImplementation(rename);
  assert.equal((await startup.promotePendingRestore(f.app)).ok, true);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'replacement');
  assert.equal(await startup.finalizeSuccessfulRestoredBoot(f.app), true);
});

test('rollback replay preserves originals after interruption following their restore', async (t) => {
  const f = await fixture(t);
  const copy = fs.copyFileSync;
  const rm = fs.rmSync;
  let interrupted = false;
  const copyMock = t.mock.method(fs, 'copyFileSync', (source, destination, flags) => {
    if (destination === f.target) throw new Error('copy refused');
    return copy(source, destination, flags);
  });
  t.mock.method(fs, 'rmSync', (target, options) => {
    if (!interrupted && String(target).includes('profile.jenny-restore-rollback-')) {
      interrupted = true;
      throw new Error('interrupted after original restoration');
    }
    return rm(target, options);
  });
  assert.equal((await startup.promotePendingRestore(f.app)).ok, false);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'original');
  assert.equal(JSON.parse(fs.readFileSync(f.journalPath)).status, 'copying');
  assert.equal((await startup.promotePendingRestore(f.app)).ok, false);
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'original');
  assert.equal(JSON.parse(fs.readFileSync(f.journalPath)).status, 'staged');
  copyMock.mock.mockImplementation(copy);
  const retried = await restore.promotePendingRestore({ userDataPath: f.userDataPath, runtimePath: f.runtimePath });
  assert.equal(retried.ok, true, JSON.stringify(retried));
  assert.equal(fs.readFileSync(f.target, 'utf8'), 'replacement');
  assert.equal(await startup.finalizeSuccessfulRestoredBoot(f.app), true);
});

test('replaced runtime owner is refused with its originals and journal retained', async (t) => {
  const f = await fixture(t);
  const copy = fs.copyFileSync;
  t.mock.method(fs, 'copyFileSync', (source, destination, flags) => {
    if (destination === f.target) throw new Error('copy refused');
    return copy(source, destination, flags);
  });
  assert.equal((await startup.promotePendingRestore(f.app)).ok, false);
  const moved = f.runtimePath + '-original';
  fs.renameSync(f.runtimePath, moved);
  fs.symlinkSync(moved, f.runtimePath, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await startup.promotePendingRestore(f.app)).ok, false);
  assert.equal(fs.readFileSync(path.join(moved, 'memory.db'), 'utf8'), 'original');
  assert.equal(fs.existsSync(f.pointerPath), true);
});
