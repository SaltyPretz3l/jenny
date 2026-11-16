'use strict';

// Model file hashing off the main thread (team model sharing slice 6-1,
// TEAM_MODEL_SHARING_SPEC MS2 and MS3). One read of a file gives its whole
// SHA-256 and the SHA-256 of each 1 GiB segment. The read runs in a worker
// thread in the shape of `services/workspace-file-map-worker.js`: this one
// file is both the owner and the worker, and the Worker constructor is
// injected for tests.
//
// - The caller has already checked the path. This module refuses a link or a
//   non-file by `lstat`, opens only that file (no-follow where the platform
//   has it), and compares the opened file's id, size and modified time with
//   the `lstat` before reading and again after: a file that changed while it
//   was hashed is a refusal, not a hash. An edit in place that keeps both the
//   size and the modified time is not seen (accepted).
// - The worker ends itself. Abort and dispose raise a shared flag that the
//   worker reads before every chunk; it then closes its descriptor and exits.
//   A request settles, and the next one starts, only after its worker's
//   `exit`. `terminate()` is the fallback when no exit comes within
//   TERMINATE_AFTER_MS of the flag (a terminated worker may leave its
//   descriptor open until the process exits).
// - One hash runs at a time; up to 8 more wait, and a further request is
//   refused. Progress is bytes done, at most 4 reports a second (the worker's
//   interval). There is no watchdog: a caller passes an abort signal.
// - Results are cached in memory only (64 entries, the least recently used
//   out first), keyed on path, size, modified time and file id (device and
//   inode). Nothing is written to disk.
// - Errors carry a closed code and say nothing else; no log line holds a
//   path, a name or a hash.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const GIB = 1024 ** 3;
const SEGMENT_BYTES = GIB;
const CHUNK_BYTES = 4 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const MAX_QUEUED = 8;
const CACHE_ENTRIES = 64;
// A worker reads one chunk (4 MiB) between flag checks; 5 s is far above that on any disk Jenny supports.
const TERMINATE_AFTER_MS = 5000;
const WORKER_KIND = 'jenny-model-hash';
const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

const MODEL_HASH_ERRORS = Object.freeze([
  'model_hash_disposed', 'model_hash_busy', 'model_hash_aborted', 'model_hash_not_file', 'model_hash_empty',
  'model_hash_changed', 'model_hash_failed',
]);

function hashError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// The identity a file is compared and cached by. Bigint stats keep ids and
// nanosecond times exact; they cross to the worker as strings.
function identityOf(stat) {
  return {
    dev: String(stat.dev), ino: String(stat.ino), size: String(stat.size), mtimeNs: String(stat.mtimeNs),
  };
}

const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino
  && left.size === right.size && left.mtimeNs === right.mtimeNs;

// Test seam: `gate` (an Int32Array on shared memory) holds the worker after
// each chunk until gate[0] is not 0, counting chunks in gate[1]; `delayMs`
// sleeps after each chunk. Waits are short so terminate() can always land.
function testPause(hooks) {
  if (!hooks) return;
  if (hooks.gate) {
    Atomics.add(hooks.gate, 1, 1);
    while (Atomics.load(hooks.gate, 0) === 0) Atomics.wait(hooks.gate, 0, 0, 20);
  }
  if (hooks.delayMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hooks.delayMs);
}

/**
 * The hashing loop, run in the worker (exported for direct tests). Opens
 * `filePath`, checks it against `expected` before and after, stops when
 * `abortFlag[0]` is set, and answers `{ size, sha256, segments }` or throws an
 * error with a closed code. The descriptor is closed on every path.
 */
function hashInThread({
  filePath, expected, segmentBytes = SEGMENT_BYTES, chunkBytes = CHUNK_BYTES, onProgress = () => {},
  afterChunk = () => {}, now = Date.now, progressIntervalMs = PROGRESS_INTERVAL_MS, abortFlag = null,
  testHooks = null,
}) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const check = () => {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !sameIdentity(identityOf(opened), expected)) throw hashError('model_hash_changed');
    };
    check();
    const size = Number(expected.size);
    const whole = crypto.createHash('sha256');
    const segments = [];
    const buffer = Buffer.allocUnsafe(Math.max(1, Math.min(chunkBytes, segmentBytes, size)));
    let segment = crypto.createHash('sha256');
    let segmentDone = 0;
    let total = 0;
    let lastReport = now();
    while (total < size) {
      if (abortFlag && Atomics.load(abortFlag, 0) !== 0) throw hashError('model_hash_aborted');
      const want = Math.min(buffer.length, segmentBytes - segmentDone, size - total);
      const read = fs.readSync(fd, buffer, 0, want, total);
      if (read === 0) throw hashError('model_hash_changed');
      const bytes = buffer.subarray(0, read);
      whole.update(bytes);
      segment.update(bytes);
      total += read;
      segmentDone += read;
      if (segmentDone === segmentBytes || total === size) {
        segments.push(segment.digest('hex'));
        segment = crypto.createHash('sha256');
        segmentDone = 0;
      }
      afterChunk(total);
      if (now() - lastReport >= progressIntervalMs) {
        lastReport = now();
        onProgress(total);
      }
      testPause(testHooks);
    }
    // A byte past the declared size means the file grew.
    if (fs.readSync(fd, buffer, 0, 1, total) !== 0) throw hashError('model_hash_changed');
    check();
    return { size, sha256: whole.digest('hex'), segments };
  } finally {
    fs.closeSync(fd);
  }
}

if (!isMainThread && workerData?.kind === WORKER_KIND) {
  try {
    const result = hashInThread({
      ...workerData,
      onProgress: (bytes) => parentPort.postMessage({ type: 'progress', bytes }),
    });
    parentPort.postMessage({ type: 'done', result });
  } catch (error) {
    const code = MODEL_HASH_ERRORS.includes(error?.code) ? error.code : 'model_hash_failed';
    parentPort.postMessage({ type: 'error', code });
  }
}

const cacheKey = (filePath, identity) => JSON.stringify([filePath, identity.size, identity.mtimeNs,
  identity.dev, identity.ino]);

// The cache answers a fresh copy, so a caller can never change a cached entry.
const copyResult = (result) => ({ size: result.size, sha256: result.sha256, segments: [...result.segments] });

const HEX64 = /^[0-9a-f]{64}$/u;

function validResult(result, expected, segmentBytes) {
  return Boolean(result) && result.size === Number(expected.size) && HEX64.test(result.sha256)
    && Array.isArray(result.segments) && result.segments.length === Math.ceil(result.size / segmentBytes)
    && result.segments.every((digest) => HEX64.test(digest));
}

/**
 * Create the hasher. `hash(filePath, { signal, onProgress })` answers
 * `{ size, sha256, segments }`; `dispose()` rejects every waiting request
 * and stops a running one (it settles once its worker has exited).
 */
function createModelHasher({
  WorkerImpl = Worker, workerPath = __filename, segmentBytes = SEGMENT_BYTES, chunkBytes = CHUNK_BYTES,
  lstat = (file) => fs.promises.lstat(file, { bigint: true }), logger = null, maxQueued = MAX_QUEUED,
  cacheEntries = CACHE_ENTRIES, setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout,
  terminateAfterMs = TERMINATE_AFTER_MS, workerTestHooks = null,
} = {}) {
  const queue = [];
  const cache = new Map();
  let running = null;
  let disposed = false;

  const log = (level, event, fields) => {
    try {
      if (typeof logger === 'function') logger(level, event, fields);
    } catch (_error) { /* a logger never breaks a hash */ }
  };

  function remember(key, result) {
    if (disposed) return;
    cache.delete(key);
    cache.set(key, copyResult(result));
    while (cache.size > cacheEntries) cache.delete(cache.keys().next().value);
  }

  function finish(request, error, result) {
    if (request.settled) return;
    request.settled = true;
    request.signal?.removeEventListener?.('abort', request.onAbort);
    if (error) {
      log('WARN', 'team_model_hash.refused', { code: error.code });
      request.reject(error);
    } else {
      request.resolve(result);
    }
  }

  function pump() {
    if (running || disposed || queue.length === 0) return;
    running = queue.shift();
    const request = running;
    // Settles only after the request's worker (if any) has exited, so the next worker never overlaps it.
    const done = (error, result) => {
      if (running === request) running = null;
      finish(request, request.stopCode ? hashError(request.stopCode) : error, result);
      pump();
    };
    run(request).then((result) => done(null, result), (error) => done(error));
  }

  async function run(request) {
    let stat;
    try {
      stat = await lstat(request.filePath);
    } catch (_error) {
      throw hashError('model_hash_not_file');
    }
    if (request.stopCode) throw hashError(request.stopCode);
    if (!stat.isFile() || stat.isSymbolicLink()) throw hashError('model_hash_not_file');
    if (Number(stat.size) <= 0) throw hashError('model_hash_empty');
    const identity = identityOf(stat);
    const key = cacheKey(request.filePath, identity);
    const cached = cache.get(key);
    if (cached) {
      remember(key, cached);
      return copyResult(cached);
    }
    const result = await inWorker(request, identity);
    remember(key, result);
    log('INFO', 'team_model_hash.done', { bytes: result.size, segments: result.segments.length });
    return copyResult(result);
  }

  // Answers when the worker has exited: its result, or the code it reported.
  function inWorker(request, expected) {
    return new Promise((resolve, reject) => {
      let outcome = null;
      request.abortFlag = new Int32Array(new SharedArrayBuffer(4));
      let worker;
      try {
        worker = new WorkerImpl(workerPath, {
          workerData: {
            kind: WORKER_KIND, filePath: request.filePath, expected, segmentBytes, chunkBytes,
            progressIntervalMs: PROGRESS_INTERVAL_MS, abortFlag: request.abortFlag, testHooks: workerTestHooks,
          },
        });
      } catch (_error) {
        reject(hashError('model_hash_failed'));
        return;
      }
      request.worker = worker;
      worker.on('message', (message) => {
        if (message?.type === 'progress') {
          if (request.settled || request.stopCode || !Number.isSafeInteger(message.bytes)) return;
          try {
            request.onProgress?.(message.bytes);
          } catch (_error) { /* a progress listener never breaks a hash */ }
        } else if (outcome === null) {
          outcome = message;
        }
      });
      worker.once('error', () => {
        if (outcome === null) outcome = { type: 'error', code: 'model_hash_failed' };
      });
      worker.once('exit', () => {
        request.worker = null;
        if (request.fallback) clearTimeoutImpl(request.fallback);
        request.fallback = null;
        if (outcome?.type === 'done' && validResult(outcome.result, expected, segmentBytes)) {
          resolve(outcome.result);
        } else if (outcome?.type === 'error' && MODEL_HASH_ERRORS.includes(outcome.code)) {
          reject(hashError(outcome.code));
        } else {
          reject(hashError('model_hash_failed'));
        }
      });
      if (request.stopCode) stopWorker(request);
    });
  }

  // Ask the worker to stop; terminate it only if it has not exited within the bound.
  function stopWorker(request) {
    const worker = request.worker;
    if (!worker || request.fallback) return;
    Atomics.store(request.abortFlag, 0, 1);
    request.fallback = setTimeoutImpl(() => {
      request.fallback = null;
      log('WARN', 'team_model_hash.terminated', { code: 'model_hash_aborted' });
      try {
        worker.terminate()?.catch?.(() => {});
      } catch (_error) { /* best-effort fallback */ }
    }, terminateAfterMs);
    request.fallback?.unref?.();
  }

  function stop(request, code) {
    if (request.settled || request.stopCode) return;
    const index = queue.indexOf(request);
    if (index >= 0) {
      queue.splice(index, 1);
      finish(request, hashError(code));
      return;
    }
    request.stopCode = code;
    stopWorker(request);
  }

  function hash(filePath, { signal, onProgress } = {}) {
    if (disposed) return Promise.reject(hashError('model_hash_disposed'));
    if (typeof filePath !== 'string' || filePath.length === 0) return Promise.reject(hashError('model_hash_not_file'));
    if (signal?.aborted) return Promise.reject(hashError('model_hash_aborted'));
    if (running && queue.length >= maxQueued) return Promise.reject(hashError('model_hash_busy'));
    return new Promise((resolve, reject) => {
      const request = {
        filePath, onProgress, signal, resolve, reject, settled: false, stopCode: '', worker: null,
        abortFlag: null, fallback: null, onAbort: null,
      };
      request.onAbort = () => stop(request, 'model_hash_aborted');
      signal?.addEventListener?.('abort', request.onAbort, { once: true });
      queue.push(request);
      pump();
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const request of [...queue]) stop(request, 'model_hash_disposed');
    if (running) stop(running, 'model_hash_disposed');
    cache.clear();
  }

  function resources() {
    return { running: running ? 1 : 0, queued: queue.length, cached: cache.size, worker: Boolean(running?.worker) };
  }

  return Object.freeze({ hash, dispose, resources });
}

module.exports = {
  CACHE_ENTRIES, MAX_QUEUED, MODEL_HASH_ERRORS, PROGRESS_INTERVAL_MS, SEGMENT_BYTES, TERMINATE_AFTER_MS,
  createModelHasher, hashInThread,
};
