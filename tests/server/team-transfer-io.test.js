'use strict';

// Slice 6-1: the checked file IO moved out of the transfer core
// (server/team/transfer-io.js). The core's own suite covers it through the
// core; these cases pin the module's contract directly.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  APPEND_FLAGS, CREATE_FLAGS, HASH_CHUNK_BYTES, READ_FLAGS, StagingChanged, checkedStat, createTransferIo,
} = require('../../server/team/transfer-io');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-transfer-io-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function counted() {
  const state = { open: 0, peak: 0, deltas: [] };
  const io = createTransferIo({
    onHandle: (delta) => {
      state.deltas.push(delta);
      state.open += delta;
      state.peak = Math.max(state.peak, state.open);
    },
  });
  return { io, state };
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const isStagingChanged = (error) => error instanceof StagingChanged && error.code === 'staging_changed'
  && error.message === 'staging_changed';

test('the constants and the error are the ones the core used', () => {
  assert.equal(HASH_CHUNK_BYTES, 1024 * 1024);
  assert.equal(CREATE_FLAGS, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
  assert.equal(APPEND_FLAGS, fs.constants.O_WRONLY);
  assert.equal(READ_FLAGS, fs.constants.O_RDONLY);
  assert.throws(() => createTransferIo({ onHandle: 1 }), TypeError);
  assert.equal(typeof createTransferIo().writeAt, 'function');
});

test('a write at offset 0 creates the file exclusively, then appends at its length', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, '0.part');
  const { io, state } = counted();
  await io.writeAt(file, 0, Buffer.from('abc'));
  await io.writeAt(file, 3, Buffer.from('def'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef');
  // A second offset-0 write meets an existing file: the exclusive create refuses it.
  await assert.rejects(io.writeAt(file, 0, Buffer.from('x')));
  assert.equal(fs.readFileSync(file, 'utf8'), 'abcdef');
  assert.equal(state.open, 0);
  assert.equal(state.peak, 1);
});

test('an append at the wrong size is StagingChanged and writes nothing', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, '0.part');
  const { io, state } = counted();
  await io.writeAt(file, 0, Buffer.from('abc'));
  await assert.rejects(io.writeAt(file, 2, Buffer.from('zz')), isStagingChanged);
  await assert.rejects(io.writeAt(file, 4, Buffer.from('zz')), isStagingChanged);
  assert.equal(fs.readFileSync(file, 'utf8'), 'abc');
  assert.equal(state.open, 0);
  assert.deepEqual(state.deltas, [1, -1, 1, -1, 1, -1]);
});

test('an append to a file with a second link is StagingChanged', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, '0.part');
  const { io, state } = counted();
  await io.writeAt(file, 0, Buffer.from('abc'));
  fs.linkSync(file, path.join(dir, 'other'));
  // POSIX opens it and the fstat check refuses it; on Windows openNoFollow's own check refuses it first.
  const refused = (error) => isStagingChanged(error) || (process.platform === 'win32' && error.code === 'file_changed');
  await assert.rejects(io.writeAt(file, 3, Buffer.from('d')), refused);
  await assert.rejects(io.hashFile(file, 3), refused);
  assert.equal(fs.readFileSync(file, 'utf8'), 'abc');
  assert.equal(state.open, 0);
});

test('a link in place of the staging file is refused', async (t) => {
  const dir = tempDir(t);
  const target = path.join(dir, 'target');
  fs.writeFileSync(target, 'abc');
  const file = path.join(dir, '0.part');
  try {
    fs.symlinkSync(target, file, 'file');
  } catch (error) {
    t.skip(`symbolic links need a privilege here (${error.code})`);
    return;
  }
  const { io, state } = counted();
  await assert.rejects(io.writeAt(file, 3, Buffer.from('d')));
  await assert.rejects(io.writeAt(file, 0, Buffer.from('d')));
  await assert.rejects(io.hashFile(file, 3));
  assert.equal(fs.readFileSync(target, 'utf8'), 'abc');
  assert.equal(state.open, 0);
});

test('the hash of a known file, across chunk boundaries, and of an empty file', async (t) => {
  const dir = tempDir(t);
  const { io, state } = counted();
  const bytes = crypto.randomBytes(HASH_CHUNK_BYTES * 2 + 17);
  const file = path.join(dir, 'big');
  fs.writeFileSync(file, bytes);
  assert.equal(await io.hashFile(file, bytes.length), sha256(bytes));
  const small = path.join(dir, 'small');
  fs.writeFileSync(small, 'hello');
  assert.equal(await io.hashFile(small, 5), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  // Size 0 creates the file exclusively and answers the empty digest.
  const empty = path.join(dir, 'empty');
  assert.equal(await io.hashFile(empty, 0), sha256(Buffer.alloc(0)));
  assert.equal(fs.statSync(empty).size, 0);
  await assert.rejects(io.hashFile(empty, 0));
  // A declared size the file does not have is refused before any read.
  await assert.rejects(io.hashFile(small, 4), isStagingChanged);
  assert.equal(state.open, 0);
});

test('a file swapped between the two stats is refused', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'f');
  fs.writeFileSync(file, 'abcdef');
  const { io, state } = counted();
  // The read loop grows the file under the handle after the first stat: the size the read sees no longer
  // matches, so the file is refused, not hashed.
  const realOpen = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await realOpen(...args);
    const realRead = handle.read.bind(handle);
    let grown = false;
    handle.read = async (...readArgs) => {
      if (!grown) {
        grown = true;
        fs.appendFileSync(file, 'g');
      }
      return realRead(...readArgs);
    };
    return handle;
  });
  await assert.rejects(io.hashFile(file, 6), isStagingChanged);
  t.mock.restoreAll();
  // A second stat that disagrees with the first (the file replaced in place after the read) is refused too.
  fs.writeFileSync(file, 'abcdef');
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await realOpen(...args);
    const realStat = handle.stat.bind(handle);
    let calls = 0;
    handle.stat = async (...statArgs) => {
      calls += 1;
      const stat = await realStat(...statArgs);
      return calls === 1 ? stat : Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: 2 });
    };
    return handle;
  });
  await assert.rejects(io.hashFile(file, 6), isStagingChanged);
  t.mock.restoreAll();
  assert.equal(state.open, 0);
});

test('the handle count returns to zero on every path, a throwing task and a failed close included', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'f');
  fs.writeFileSync(file, 'abc');
  const { io, state } = counted();
  await assert.rejects(io.withHandle(file, READ_FLAGS, async () => { throw new Error('task'); }), /task/u);
  assert.equal(state.open, 0);
  // A failed open never counts.
  await assert.rejects(io.withHandle(path.join(dir, 'missing'), READ_FLAGS, async () => 1));
  assert.equal(state.open, 0);
  assert.deepEqual(state.deltas, [1, -1]);
  // A write that cannot progress is StagingChanged and still closes.
  const realOpen = fs.promises.open;
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await realOpen(...args);
    handle.write = async () => ({ bytesWritten: 0 });
    return handle;
  });
  await assert.rejects(io.writeAt(file, 3, Buffer.from('d')), isStagingChanged);
  t.mock.restoreAll();
  assert.equal(state.open, 0);
  assert.equal(await io.withHandle(file, READ_FLAGS, async (handle) => {
    assert.equal(state.open, 1);
    await checkedStat(handle, 3);
    return 'done';
  }), 'done');
  assert.equal(state.open, 0);
  // A close that throws: the count was already given back before the close, so it is still zero.
  t.mock.method(fs.promises, 'open', async (...args) => {
    const handle = await realOpen(...args);
    const realClose = handle.close.bind(handle);
    handle.close = async () => {
      await realClose();
      throw Object.assign(new Error('close failed'), { code: 'EIO' });
    };
    return handle;
  });
  await assert.rejects(io.withHandle(file, READ_FLAGS, async () => 'work'), (error) => error.code === 'EIO');
  await assert.rejects(io.hashFile(file, 3), (error) => error.code === 'EIO');
  t.mock.restoreAll();
  assert.equal(state.open, 0);
  assert.equal(state.deltas.filter((delta) => delta === 1).length, state.deltas.filter((delta) => delta === -1).length);
});
