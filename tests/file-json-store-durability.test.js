'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { FileJsonStore } = require('../services/backend/file-json-store');

const FAKE_DIR_FD = 987654;

function makeDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-fjs-durable-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setPlatform(t, platform) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  t.after(() => Object.defineProperty(process, 'platform', original));
}

function isTemp(target) {
  return String(target).endsWith('.tmp');
}

// Records the order of flush/rename calls the store makes against `dir`. The
// directory itself is faked (it cannot be opened on Windows); temp-file calls
// reach the real fs, so the writes stay real. `failTempSync` makes the flush of
// a temp file fail with EIO, `failDirOpen` makes the directory open fail.
function spyOnFs(t, dir, { failTempSync = false, failDirOpen = false } = {}) {
  const events = [];
  const fdPaths = new Map();
  const real = {
    openSync: fs.openSync,
    fsyncSync: fs.fsyncSync,
    closeSync: fs.closeSync,
    renameSync: fs.renameSync,
    open: fs.promises.open,
    rename: fs.promises.rename,
  };
  const eio = () => Object.assign(new Error('simulated EIO'), { code: 'EIO' });
  const isDir = (target) => path.resolve(String(target)) === path.resolve(dir);

  fs.openSync = (target, ...args) => {
    if (isDir(target)) {
      if (failDirOpen) throw eio();
      events.push('dir:open');
      return FAKE_DIR_FD;
    }
    const fd = real.openSync.call(fs, target, ...args);
    if (isTemp(target)) fdPaths.set(fd, String(target));
    return fd;
  };
  fs.fsyncSync = (fd) => {
    if (fd === FAKE_DIR_FD) {
      events.push('dir:fsync');
      return undefined;
    }
    if (fdPaths.has(fd)) {
      events.push('temp:fsync');
      if (failTempSync) throw eio();
    }
    return real.fsyncSync.call(fs, fd);
  };
  fs.closeSync = (fd) => {
    if (fd === FAKE_DIR_FD) return undefined;
    fdPaths.delete(fd);
    return real.closeSync.call(fs, fd);
  };
  fs.renameSync = (from, to) => {
    if (isTemp(from)) events.push('rename');
    return real.renameSync.call(fs, from, to);
  };
  fs.promises.open = async (target, ...args) => {
    if (isDir(target)) {
      if (failDirOpen) throw eio();
      events.push('dir:open');
      return {
        sync: async () => { events.push('dir:fsync'); },
        close: async () => {},
      };
    }
    const handle = await real.open.call(fs.promises, target, ...args);
    if (!isTemp(target)) return handle;
    const realSync = handle.sync.bind(handle);
    handle.sync = async () => {
      events.push('temp:fsync');
      if (failTempSync) throw eio();
      return realSync();
    };
    return handle;
  };
  fs.promises.rename = async (from, to) => {
    if (isTemp(from)) events.push('rename');
    return real.rename.call(fs.promises, from, to);
  };
  t.after(() => {
    fs.openSync = real.openSync;
    fs.fsyncSync = real.fsyncSync;
    fs.closeSync = real.closeSync;
    fs.renameSync = real.renameSync;
    fs.promises.open = real.open;
    fs.promises.rename = real.rename;
  });
  return events;
}

function tempFilesIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

function silenceConsoleError(t) {
  const real = console.error;
  console.error = () => {};
  t.after(() => { console.error = real; });
}

test('writeImmediate flushes the temp file before the rename, then the directory', (t) => {
  const dir = makeDir(t);
  setPlatform(t, 'linux');
  const store = new FileJsonStore(path.join(dir, 'data.json'));
  const events = spyOnFs(t, dir);

  const result = store.writeImmediate({ value: 1 });

  assert.deepEqual(events, ['temp:fsync', 'rename', 'dir:open', 'dir:fsync']);
  assert.equal(result.durable, true);
  assert.equal(store.getWriteState().durableGeneration, result.generation);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')), { value: 1 });
});

test('a non-debounced write flushes the temp file before the rename', (t) => {
  const dir = makeDir(t);
  setPlatform(t, 'linux');
  const store = new FileJsonStore(path.join(dir, 'data.json'));
  const events = spyOnFs(t, dir);

  const result = store.write({ value: 2 });

  assert.deepEqual(events, ['temp:fsync', 'rename', 'dir:open', 'dir:fsync']);
  assert.equal(store.getWriteState().durableGeneration, result.generation);
});

test('a debounced write drained by flushAsync flushes before the rename', async (t) => {
  const dir = makeDir(t);
  setPlatform(t, 'linux');
  const store = new FileJsonStore(path.join(dir, 'data.json'), { writeDebounceMs: 30_000 });
  const events = spyOnFs(t, dir);

  const result = store.write({ value: 3 });
  assert.equal(store.getWriteState().durableGeneration, 0);
  await store.flushAsync();

  assert.deepEqual(events, ['temp:fsync', 'rename', 'dir:open', 'dir:fsync']);
  assert.equal(store.getWriteState().durableGeneration, result.generation);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')), { value: 3 });
});

test('the directory is not flushed on win32', (t) => {
  const dir = makeDir(t);
  setPlatform(t, 'win32');
  const store = new FileJsonStore(path.join(dir, 'data.json'), { writeDebounceMs: 30_000 });
  const events = spyOnFs(t, dir);

  store.writeImmediate({ value: 1 });
  store.write({ value: 2 });
  return store.flushAsync().then(() => {
    assert.deepEqual(events, ['temp:fsync', 'rename', 'temp:fsync', 'rename']);
  });
});

test('a failed temp flush fails a synchronous write and leaves the old file intact', (t) => {
  const dir = makeDir(t);
  const filePath = path.join(dir, 'data.json');
  const store = new FileJsonStore(filePath);
  store.writeImmediate({ value: 'old' });
  const previous = store.getWriteState();
  const events = spyOnFs(t, dir, { failTempSync: true });

  assert.throws(() => store.writeImmediate({ value: 'new' }), { code: 'EIO' });

  assert.equal(events.includes('rename'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { value: 'old' });
  assert.deepEqual(tempFilesIn(dir), []);
  const state = store.getWriteState();
  assert.equal(state.failedGeneration, state.acceptedGeneration);
  assert.equal(state.durableGeneration, previous.durableGeneration);

  assert.throws(() => store.write({ value: 'newer' }), { code: 'EIO' });
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { value: 'old' });
  assert.deepEqual(tempFilesIn(dir), []);
  assert.equal(store.getWriteState().durableGeneration, previous.durableGeneration);
});

test('a failed temp flush marks an async write failed without throwing', async (t) => {
  silenceConsoleError(t);
  const dir = makeDir(t);
  const filePath = path.join(dir, 'data.json');
  const store = new FileJsonStore(filePath, { writeDebounceMs: 30_000 });
  store.write({ value: 'old' });
  await store.flushAsync();
  const previous = store.getWriteState();
  assert.equal(previous.durableGeneration, previous.acceptedGeneration);
  const events = spyOnFs(t, dir, { failTempSync: true });

  store.write({ value: 'new' });
  await assert.doesNotReject(() => store.flushAsync());

  assert.equal(events.includes('rename'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { value: 'old' });
  assert.deepEqual(tempFilesIn(dir), []);
  const state = store.getWriteState();
  assert.equal(state.failedGeneration, state.acceptedGeneration);
  assert.equal(state.durableGeneration, previous.durableGeneration);
});

test('a superseded async write still never clobbers a newer immediate write', async (t) => {
  const dir = makeDir(t);
  const filePath = path.join(dir, 'data.json');
  const store = new FileJsonStore(filePath, { writeDebounceMs: 30_000 });
  spyOnFs(t, dir);

  store.write({ value: 'stale' });
  const draining = store.flushAsync();
  store.writeImmediate({ value: 'newest' });
  await draining;

  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { value: 'newest' });
  assert.deepEqual(tempFilesIn(dir), []);
  const state = store.getWriteState();
  assert.equal(state.durableGeneration, state.acceptedGeneration);
  assert.equal(state.failedGeneration, 0);
});

test('a directory flush failure does not fail a synchronous write', (t) => {
  const dir = makeDir(t);
  setPlatform(t, 'linux');
  const store = new FileJsonStore(path.join(dir, 'data.json'));
  spyOnFs(t, dir, { failDirOpen: true });

  const result = store.writeImmediate({ value: 1 });

  assert.equal(result.durable, true);
  const state = store.getWriteState();
  assert.equal(state.durableGeneration, result.generation);
  assert.equal(state.failedGeneration, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')), { value: 1 });
});

test('a directory flush failure does not fail an async write', async (t) => {
  const dir = makeDir(t);
  setPlatform(t, 'linux');
  const store = new FileJsonStore(path.join(dir, 'data.json'), { writeDebounceMs: 30_000 });
  spyOnFs(t, dir, { failDirOpen: true });

  const { generation } = store.write({ value: 1 });
  await store.flushAsync();

  const state = store.getWriteState();
  assert.equal(state.durableGeneration, generation);
  assert.equal(state.failedGeneration, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8')), { value: 1 });
});

test('writeJsonAtomicAsync flushes the temp file before the rename', async (t) => {
  const { writeJsonAtomicAsync } = require('../services/backend/session-storage-fs-utils');
  const dir = makeDir(t);
  setPlatform(t, 'linux');
  const events = spyOnFs(t, dir);

  await writeJsonAtomicAsync(path.join(dir, 'doc.json'), { value: 1 });

  assert.deepEqual(events, ['temp:fsync', 'rename', 'dir:open', 'dir:fsync']);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'doc.json'), 'utf8')), { value: 1 });
});
