'use strict';

// Slice 6-1: model file hashing in a worker thread (services/team/model-hash.js).
// Real workers for the digests, progress, the changed-file refusal, abort,
// the terminate fallback and dispose (held mid-hash by a shared-memory gate,
// so an abort lands mid-hash by construction); a fake Worker for the queue,
// failure paths and the cache.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Worker } = require('node:worker_threads');

const {
  CACHE_ENTRIES, MAX_QUEUED, MODEL_HASH_ERRORS, PROGRESS_INTERVAL_MS, SEGMENT_BYTES, TERMINATE_AFTER_MS,
  createModelHasher, hashInThread,
} = require('../services/team/model-hash');
// Imported here, not in services/: the hasher's cache size is pinned to the shared limit by this test.
const { MODEL_TRANSFER_LIMITS } = require('../server/team/model-manifest');

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const FAKE_HASH = 'c'.repeat(64);
const tick = () => new Promise(setImmediate);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-hash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeFile(dir, name, bytes) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function expectedDigests(bytes, segmentBytes) {
  const segments = [];
  for (let start = 0; start < bytes.length; start += segmentBytes) {
    segments.push(sha256(bytes.subarray(start, start + segmentBytes)));
  }
  return { size: bytes.length, sha256: sha256(bytes), segments };
}

function identityOfFile(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  return { dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs) };
}

// A real Worker that records the order of constructions and exits, and its terminate calls.
function recordingWorker() {
  const made = [];
  const events = [];
  class RecordingWorker extends Worker {
    constructor(...args) {
      super(...args);
      this.index = made.length;
      this.terminations = 0;
      events.push(`start${this.index}`);
      this.exited = new Promise((resolve) => this.once('exit', () => {
        events.push(`exit${this.index}`);
        resolve();
      }));
      made.push(this);
    }

    terminate() {
      this.terminations += 1;
      return super.terminate();
    }
  }
  return { RecordingWorker, made, events };
}

// A gate that holds a real worker after each chunk until released.
function createGate() {
  const gate = new Int32Array(new SharedArrayBuffer(8));
  return {
    hooks: { gate },
    chunks: () => Atomics.load(gate, 1),
    release: () => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0); },
    async reached(count = 1) {
      while (Atomics.load(gate, 1) < count) await tick();
    },
  };
}

// Timers the hasher arms, counted while live.
function countedTimers() {
  const live = new Map();
  let next = 0;
  return {
    live,
    setTimeoutImpl: (callback, ms) => { next += 1; live.set(next, { callback, ms }); return next; },
    clearTimeoutImpl: (id) => { live.delete(id); },
    fire(id) { const entry = live.get(id); live.delete(id); entry.callback(); },
  };
}

// A fake Worker: answers a valid result (then exits) on the next turn unless `hold` is set.
function fakeWorkers({ hold = false, throwOnConstruct = () => false } = {}) {
  const made = [];
  class FakeWorker extends EventEmitter {
    constructor(_file, { workerData }) {
      if (throwOnConstruct(made.length)) {
        made.push(null);
        throw new Error('no worker');
      }
      super();
      this.data = workerData;
      this.terminations = 0;
      made.push(this);
      if (!hold) setImmediate(() => this.answer());
    }

    finish(message) {
      if (message) this.emit('message', message);
      setImmediate(() => this.emit('exit', 0));
    }

    answer() {
      const size = Number(this.data.expected.size);
      const segments = Array(Math.ceil(size / this.data.segmentBytes)).fill(FAKE_HASH);
      this.finish({ type: 'done', result: { size, sha256: FAKE_HASH, segments } });
    }

    terminate() {
      this.terminations += 1;
      setImmediate(() => this.emit('exit', 1));
      return Promise.resolve(1);
    }
  }
  return { FakeWorker, made };
}

function fakeStat({ ino = 1n, dev = 7n, size = 100n, mtimeNs = 1n, symlink = false } = {}) {
  return { isFile: () => !symlink, isSymbolicLink: () => symlink, dev, ino, size, mtimeNs };
}

const refusedWith = (code) => (error) => error.code === code && error.message === code;

test('the constants match the spec, and the cache size is the shared limit', () => {
  assert.equal(SEGMENT_BYTES, 1024 ** 3);
  assert.equal(MAX_QUEUED, 8);
  assert.equal(CACHE_ENTRIES, 64);
  assert.equal(CACHE_ENTRIES, MODEL_TRANSFER_LIMITS.hashCacheEntries);
  assert.equal(SEGMENT_BYTES, MODEL_TRANSFER_LIMITS.segmentBytes);
  assert.equal(PROGRESS_INTERVAL_MS, 250);
  assert.equal(TERMINATE_AFTER_MS, 5000);
  assert.ok(Object.isFrozen(MODEL_HASH_ERRORS));
});

test('a multi-segment file in a real worker gives the digests a straight crypto pass gives', async (t) => {
  const dir = tempDir(t);
  const bytes = crypto.randomBytes(1000);
  const file = writeFile(dir, 'model.gguf', bytes);
  const hasher = createModelHasher({ segmentBytes: 128, chunkBytes: 50 });
  t.after(() => hasher.dispose());
  const result = await hasher.hash(file);
  assert.deepEqual(result, expectedDigests(bytes, 128));
  assert.equal(result.segments.length, 8);
  // A size that is an exact multiple of the segment has no empty last segment.
  const exact = writeFile(dir, 'exact.gguf', bytes.subarray(0, 512));
  assert.deepEqual(await hasher.hash(exact), expectedDigests(bytes.subarray(0, 512), 128));
  assert.deepEqual(hasher.resources(), { running: 0, queued: 0, cached: 2, worker: false });
});

test('a zero-length file, a missing file and a directory are refused', async (t) => {
  const dir = tempDir(t);
  const empty = writeFile(dir, 'empty.gguf', '');
  const { FakeWorker, made } = fakeWorkers();
  const hasher = createModelHasher({ WorkerImpl: FakeWorker });
  t.after(() => hasher.dispose());
  await assert.rejects(hasher.hash(empty), refusedWith('model_hash_empty'));
  await assert.rejects(hasher.hash(path.join(dir, 'missing.gguf')), refusedWith('model_hash_not_file'));
  await assert.rejects(hasher.hash(dir), refusedWith('model_hash_not_file'));
  await assert.rejects(hasher.hash(''), refusedWith('model_hash_not_file'));
  assert.equal(made.length, 0);
});

test('a symbolic link is refused by lstat before any worker starts', async (t) => {
  const { FakeWorker, made } = fakeWorkers();
  const injected = createModelHasher({ WorkerImpl: FakeWorker, lstat: async () => fakeStat({ symlink: true }) });
  t.after(() => injected.dispose());
  await assert.rejects(injected.hash('/models/x.gguf'), refusedWith('model_hash_not_file'));
  assert.equal(made.length, 0);
  const dir = tempDir(t);
  const target = writeFile(dir, 'target.gguf', 'abc');
  const link = path.join(dir, 'link.gguf');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    t.diagnostic(`real symbolic link not created (${error.code}); the injected lstat case covers the rule`);
    return;
  }
  const real = createModelHasher({ WorkerImpl: FakeWorker });
  t.after(() => real.dispose());
  await assert.rejects(real.hash(link), refusedWith('model_hash_not_file'));
  assert.equal(made.length, 0);
});

test('a file changed while it is hashed is refused, not hashed', async (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'model.gguf', crypto.randomBytes(300));
  // Grown mid-read: the trailing read and the second fstat see it.
  assert.throws(() => hashInThread({
    filePath: file, expected: identityOfFile(file), segmentBytes: 64, chunkBytes: 32,
    afterChunk: (done) => { if (done === 64) fs.appendFileSync(file, 'x'); },
  }), refusedWith('model_hash_changed'));
  // Rewritten in place with the same size: the modified time differs at the second check.
  fs.writeFileSync(file, crypto.randomBytes(300));
  fs.utimesSync(file, new Date(2020, 0, 1), new Date(2020, 0, 1));
  assert.throws(() => hashInThread({
    filePath: file, expected: identityOfFile(file), segmentBytes: 64, chunkBytes: 32,
    afterChunk: (done) => { if (done === 64) fs.utimesSync(file, new Date(), new Date()); },
  }), refusedWith('model_hash_changed'));
  // Changed between the owner's lstat and the worker's open, through the real worker.
  const { RecordingWorker, made } = recordingWorker();
  class ChangingWorker extends RecordingWorker {
    constructor(...args) {
      fs.appendFileSync(file, 'more');
      super(...args);
    }
  }
  const hasher = createModelHasher({ WorkerImpl: ChangingWorker });
  t.after(() => hasher.dispose());
  await assert.rejects(hasher.hash(file), refusedWith('model_hash_changed'));
  await made[0].exited;
  assert.equal(hasher.resources().cached, 0);
});

test('the worker reports progress at its own interval of 250 ms', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-model-hash-'));
  try {
    const file = writeFile(dir, 'model.gguf', crypto.randomBytes(1000));
    // A clock that never moves reports nothing.
    const still = [];
    hashInThread({ filePath: file, expected: identityOfFile(file), chunkBytes: 10, now: () => 0,
      onProgress: (bytes) => still.push(bytes) });
    assert.deepEqual(still, []);
    // 100 ms a chunk over 100 chunks: a report every third chunk, 33 in all (a 100 ms interval would give 99).
    let clock = 0;
    const moving = [];
    hashInThread({
      filePath: file, expected: identityOfFile(file), chunkBytes: 10, now: () => clock,
      afterChunk: () => { clock += 100; }, onProgress: (bytes) => moving.push(bytes),
    });
    assert.equal(moving.length, 33);
    assert.deepEqual(moving.slice(0, 3), [30, 60, 90]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a real worker delivers progress, never more than 4 reports in any second', async (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'model.gguf', crypto.randomBytes(48 * 1024));
  const hasher = createModelHasher({ chunkBytes: 1024, workerTestHooks: { delayMs: 30 } });
  t.after(() => hasher.dispose());
  const seen = [];
  const result = await hasher.hash(file, { onProgress: (bytes) => seen.push({ bytes, at: performance.now() }) });
  assert.equal(result.size, 48 * 1024);
  assert.ok(seen.length >= 1, 'no progress arrived from the worker');
  assert.ok(seen.every((entry, index) => index === 0 || entry.bytes > seen[index - 1].bytes));
  for (const [index, entry] of seen.entries()) {
    const inSecond = seen.slice(index).filter((later) => later.at - entry.at < 1000).length;
    assert.ok(inSecond <= 4, `${inSecond} reports within one second`);
  }
});

test('the owner forwards progress until a request is stopped, and never after', async (t) => {
  const { FakeWorker, made } = fakeWorkers({ hold: true });
  const hasher = createModelHasher({ WorkerImpl: FakeWorker, lstat: async () => fakeStat() });
  t.after(() => hasher.dispose());
  const seen = [];
  const controller = new AbortController();
  const pending = hasher.hash('/models/a.gguf', { signal: controller.signal, onProgress: (bytes) => seen.push(bytes) });
  while (made.length === 0) await tick();
  made[0].emit('message', { type: 'progress', bytes: 1 });
  made[0].emit('message', { type: 'progress', bytes: 2 });
  made[0].emit('message', { type: 'progress', bytes: 'x' });
  controller.abort();
  assert.equal(Atomics.load(made[0].data.abortFlag, 0), 1);
  made[0].emit('message', { type: 'progress', bytes: 3 });
  made[0].finish({ type: 'error', code: 'model_hash_aborted' });
  await assert.rejects(pending, refusedWith('model_hash_aborted'));
  made[0].emit('message', { type: 'progress', bytes: 4 });
  assert.deepEqual(seen, [1, 2]);
});

test('abort mid-hash: the worker closes its file and exits before the caller hears or the next hash starts',
  async (t) => {
    const dir = tempDir(t);
    const file = writeFile(dir, 'model.gguf', crypto.randomBytes(8 * 1024));
    const other = writeFile(dir, 'other.gguf', crypto.randomBytes(100));
    const gate = createGate();
    const { RecordingWorker, made, events } = recordingWorker();
    const timers = countedTimers();
    const hasher = createModelHasher({
      WorkerImpl: RecordingWorker, chunkBytes: 1024, workerTestHooks: gate.hooks, ...timers,
    });
    t.after(() => { gate.release(); hasher.dispose(); });
    const controller = new AbortController();
    let rejections = 0;
    const first = hasher.hash(file, { signal: controller.signal }).catch((error) => { rejections += 1; throw error; });
    const second = hasher.hash(other);
    await gate.reached(1);
    controller.abort();
    controller.abort();
    assert.equal(timers.live.size, 1);
    assert.equal([...timers.live.values()][0].ms, TERMINATE_AFTER_MS);
    assert.deepEqual(events, ['start0']);
    gate.release();
    await assert.rejects(first, refusedWith('model_hash_aborted'));
    // The descriptor is closed: on Windows a held handle would refuse the rename and the delete.
    fs.renameSync(file, `${file}.moved`);
    fs.unlinkSync(`${file}.moved`);
    assert.equal(rejections, 1);
    assert.equal(made[0].terminations, 0);
    assert.equal(timers.live.size, 0);
    assert.equal((await second).size, 100);
    assert.deepEqual(events.slice(0, 3), ['start0', 'exit0', 'start1']);
  });

test('a queued request aborts at once without a worker; an aborted signal is refused', async (t) => {
  const { FakeWorker, made } = fakeWorkers({ hold: true });
  const hasher = createModelHasher({ WorkerImpl: FakeWorker, lstat: async () => fakeStat() });
  t.after(() => hasher.dispose());
  const running = hasher.hash('/m/a.gguf');
  const controller = new AbortController();
  const queued = hasher.hash('/m/b.gguf', { signal: controller.signal });
  controller.abort();
  await assert.rejects(queued, refusedWith('model_hash_aborted'));
  assert.equal(hasher.resources().queued, 0);
  const already = new AbortController();
  already.abort();
  await assert.rejects(hasher.hash('/m/c.gguf', { signal: already.signal }), refusedWith('model_hash_aborted'));
  while (made.length === 0) await tick();
  made[0].answer();
  await running;
  assert.equal(made.length, 1);
});

test('a worker that does not exit within the bound is terminated', async (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'model.gguf', crypto.randomBytes(8 * 1024));
  const gate = createGate();
  const { RecordingWorker, made } = recordingWorker();
  const timers = countedTimers();
  const hasher = createModelHasher({ WorkerImpl: RecordingWorker, chunkBytes: 1024, workerTestHooks: gate.hooks, ...timers });
  t.after(() => { gate.release(); hasher.dispose(); });
  const controller = new AbortController();
  const pending = hasher.hash(file, { signal: controller.signal });
  await gate.reached(1);
  controller.abort();
  // The gate is never released, so the worker cannot see the flag: the bound fires.
  const [id] = timers.live.keys();
  timers.fire(id);
  await assert.rejects(pending, refusedWith('model_hash_aborted'));
  await made[0].exited;
  assert.equal(made[0].terminations, 1);
  assert.equal(timers.live.size, 0);
  assert.deepEqual(hasher.resources(), { running: 0, queued: 0, cached: 0, worker: false });
});

test('dispose stops a running worker the same way and leaves no worker and no timer', async (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'model.gguf', crypto.randomBytes(8 * 1024));
  const gate = createGate();
  const { RecordingWorker, made } = recordingWorker();
  const timers = countedTimers();
  const hasher = createModelHasher({ WorkerImpl: RecordingWorker, chunkBytes: 1024, workerTestHooks: gate.hooks, ...timers });
  t.after(() => gate.release());
  const running = hasher.hash(file);
  const waiting = hasher.hash(file);
  await gate.reached(1);
  hasher.dispose();
  hasher.dispose();
  await assert.rejects(waiting, refusedWith('model_hash_disposed'));
  assert.equal(timers.live.size, 1);
  gate.release();
  await assert.rejects(running, refusedWith('model_hash_disposed'));
  await made[0].exited;
  assert.equal(made[0].terminations, 0);
  assert.equal(made.length, 1);
  assert.equal(timers.live.size, 0);
  assert.deepEqual(hasher.resources(), { running: 0, queued: 0, cached: 0, worker: false });
  fs.unlinkSync(file);
  await assert.rejects(hasher.hash(file), refusedWith('model_hash_disposed'));
});

test('a worker failure frees the slot and the next request runs', async (t) => {
  const failures = [
    ['exits with no message', (worker) => worker.finish(null)],
    ['emits an error', (worker) => { worker.emit('error', new Error('boom')); worker.finish(null); }],
    ['answers an invalid result', (worker) => worker.finish({ type: 'done', result: { size: 100, sha256: 'x', segments: [] } })],
    ['answers an unknown code', (worker) => worker.finish({ type: 'error', code: 'something_else' })],
  ];
  for (const [label, fail] of failures) {
    const { FakeWorker, made } = fakeWorkers({ hold: true });
    const hasher = createModelHasher({ WorkerImpl: FakeWorker, lstat: async (file) => fakeStat({ ino: BigInt(file.length) }) });
    t.after(() => hasher.dispose());
    const first = hasher.hash('/m/a.gguf');
    const next = hasher.hash('/m/bb.gguf');
    while (made.length === 0) await tick();
    fail(made[0]);
    await assert.rejects(first, refusedWith('model_hash_failed'), label);
    while (made.length < 2) await tick();
    made[1].answer();
    assert.equal((await next).sha256, FAKE_HASH, label);
    assert.deepEqual(hasher.resources(), { running: 0, queued: 0, cached: 1, worker: false }, label);
  }
  const { FakeWorker, made } = fakeWorkers({ throwOnConstruct: (index) => index === 0 });
  const hasher = createModelHasher({ WorkerImpl: FakeWorker, lstat: async (file) => fakeStat({ ino: BigInt(file.length) }) });
  t.after(() => hasher.dispose());
  const first = hasher.hash('/m/a.gguf');
  const next = hasher.hash('/m/bb.gguf');
  await assert.rejects(first, refusedWith('model_hash_failed'));
  assert.equal((await next).sha256, FAKE_HASH);
  assert.equal(made.length, 2);
});

test('the cache key: each of path, size, modified time, inode and device alone makes a miss', async (t) => {
  const base = { ino: 5n, dev: 7n, size: 100n, mtimeNs: 1n };
  let identity = { ...base };
  const { FakeWorker, made } = fakeWorkers();
  const hasher = createModelHasher({ WorkerImpl: FakeWorker, lstat: async () => fakeStat(identity) });
  t.after(() => hasher.dispose());
  await hasher.hash('/m/a.gguf');
  await hasher.hash('/m/a.gguf');
  assert.equal(made.length, 1);
  const cases = [
    ['path', '/m/b.gguf', {}],
    ['size', '/m/a.gguf', { size: 101n }],
    ['modified time', '/m/a.gguf', { mtimeNs: 2n }],
    ['inode', '/m/a.gguf', { ino: 6n }],
    ['device', '/m/a.gguf', { dev: 8n }],
  ];
  for (const [label, file, change] of cases) {
    identity = { ...base, ...change };
    const before = made.length;
    await hasher.hash(file);
    assert.equal(made.length, before + 1, `${label} change was a hit`);
  }
  identity = { ...base };
  const before = made.length;
  await hasher.hash('/m/a.gguf');
  assert.equal(made.length, before, 'the unchanged identity missed');
});

test('a real file: a hit when unchanged, a miss after a modified-time change, and a fresh copy each time',
  async (t) => {
    const dir = tempDir(t);
    const file = writeFile(dir, 'model.gguf', crypto.randomBytes(500));
    fs.utimesSync(file, new Date(2024, 0, 1), new Date(2024, 0, 1));
    const { RecordingWorker, made } = recordingWorker();
    const hasher = createModelHasher({ WorkerImpl: RecordingWorker, segmentBytes: 128 });
    t.after(() => hasher.dispose());
    const first = await hasher.hash(file);
    const again = await hasher.hash(file);
    assert.equal(made.length, 1);
    assert.deepEqual(again, first);
    again.segments.push('changed');
    assert.deepEqual(await hasher.hash(file), first);
    fs.utimesSync(file, new Date(2025, 0, 1), new Date(2025, 0, 1));
    assert.deepEqual(await hasher.hash(file), first);
    assert.equal(made.length, 2);
  });

test('the cache holds 64 entries and evicts the least recently used', async (t) => {
  const { FakeWorker, made } = fakeWorkers();
  const hasher = createModelHasher({
    WorkerImpl: FakeWorker, lstat: async (file) => fakeStat({ ino: BigInt(path.basename(file, '.gguf')) }),
  });
  t.after(() => hasher.dispose());
  for (let index = 0; index < 64; index += 1) await hasher.hash(`/m/${index}.gguf`);
  assert.equal(hasher.resources().cached, 64);
  // A hit on the oldest entry saves it: the 65th entry evicts entry 1 instead.
  await hasher.hash('/m/0.gguf');
  assert.equal(made.length, 64);
  await hasher.hash('/m/64.gguf');
  assert.equal(hasher.resources().cached, 64);
  await hasher.hash('/m/0.gguf');
  assert.equal(made.length, 65);
  await hasher.hash('/m/1.gguf');
  assert.equal(made.length, 66);
});

test('one hash runs at a time; eight wait; the ninth waiting request is refused', async (t) => {
  const { FakeWorker, made } = fakeWorkers({ hold: true });
  const hasher = createModelHasher({ WorkerImpl: FakeWorker, lstat: async (file) => fakeStat({ ino: BigInt(file.length) }) });
  t.after(() => hasher.dispose());
  const pending = [];
  for (let index = 0; index < 9; index += 1) pending.push(hasher.hash(`/m/${'x'.repeat(index)}.gguf`));
  assert.deepEqual(hasher.resources(), { running: 1, queued: 8, cached: 0, worker: false });
  await assert.rejects(hasher.hash('/m/ninth-waiting.gguf'), refusedWith('model_hash_busy'));
  while (made.length === 0) await tick();
  made[0].answer();
  await pending[0];
  while (made.length < 2) await tick();
  assert.equal(made.length, 2);
  assert.equal(hasher.resources().queued, 7);
  hasher.dispose();
  const queued = await Promise.allSettled(pending.slice(2));
  assert.ok(queued.every((entry) => entry.status === 'rejected' && entry.reason.code === 'model_hash_disposed'));
  // The running one settles at its worker's exit.
  made[1].finish({ type: 'error', code: 'model_hash_aborted' });
  await assert.rejects(pending[1], refusedWith('model_hash_disposed'));
});

test('no log line holds a path, a name or a hash', async (t) => {
  const dir = tempDir(t);
  const file = writeFile(dir, 'MARKERNAME-Q4_K_M.gguf', crypto.randomBytes(300));
  const empty = writeFile(dir, 'MARKEREMPTY.gguf', '');
  const lines = [];
  const hasher = createModelHasher({ segmentBytes: 128, logger: (...args) => lines.push(JSON.stringify(args)) });
  t.after(() => hasher.dispose());
  const result = await hasher.hash(file);
  await assert.rejects(hasher.hash(empty));
  await assert.rejects(hasher.hash(path.join(dir, 'MARKERMISSING.gguf')));
  assert.ok(lines.length >= 3);
  const forbidden = [dir, 'MARKER', result.sha256, ...result.segments];
  for (const line of lines) {
    for (const value of forbidden) assert.ok(!line.includes(value), `log line leaks: ${line.slice(0, 60)}`);
  }
});
