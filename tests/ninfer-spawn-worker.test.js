'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const { spawnOffMainThread } = require('../services/ninfer-spawn-worker');
const { pipeChildLogs } = require('../services/backend/child-process-logging');

const STDIO = { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
const BOUND_MS = 15_000;

// Every wait is bounded (and the ref'd timer keeps the loop alive while the
// unref'd worker runs), so a regression fails instead of hanging the lane.
function bounded(promise, label, ms = BOUND_MS) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...values) => resolve(values)));
}

function collect(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
  return once(stream, 'end').then(() => Buffer.concat(chunks).toString('utf8'));
}

test('stdout and stderr arrive, the streams end, and exit carries the code', async () => {
  const child = await bounded(spawnOffMainThread(process.execPath, [
    '-e', "process.stdout.write('out-1\\nout-2\\n'); process.stderr.write('err-1\\n'); process.exitCode = 3;",
  ], STDIO), 'spawn');
  assert.equal(typeof child.pid, 'number');
  const exited = once(child, 'exit');
  const [stdout, stderr, [code, signal]] = await bounded(
    Promise.all([collect(child.stdout), collect(child.stderr), exited]), 'exit and stream end',
  );
  assert.equal(stdout, 'out-1\nout-2\n');
  assert.equal(stderr, 'err-1\n');
  assert.equal(code, 3);
  assert.equal(signal, null);
});

test('an exit that lands immediately after resolution is not lost', async () => {
  const child = await bounded(spawnOffMainThread(process.execPath, ['-e', ''], STDIO), 'spawn');
  const [code] = await bounded(once(child, 'exit'), 'exit');
  assert.equal(code, 0);
});

test('kill() ends a long-running child and exit fires', async () => {
  const child = await bounded(spawnOffMainThread(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], STDIO), 'spawn');
  assert.equal(typeof child.pid, 'number');
  const streamsClosed = Promise.all([once(child.stdout, 'close'), once(child.stderr, 'close')]);
  child.stdout.resume();
  child.stderr.resume();
  const exited = once(child, 'exit');
  assert.equal(child.kill(), true);
  const [code, signal] = await bounded(exited, 'exit after kill');
  assert.ok(code !== 0 || signal, `expected a non-clean exit, got ${code}/${signal}`);
  await bounded(streamsClosed, 'streams end after kill');
  assert.equal(child.kill(), false);
});

test('a missing command yields no pid and an ENOENT error without hanging', async () => {
  const child = await bounded(spawnOffMainThread('G:/jenny-test/definitely-missing/ninfer-serve.exe', [], STDIO), 'spawn');
  assert.equal(child.pid, undefined);
  const [error] = await bounded(once(child, 'error'), 'error');
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'ENOENT');
  await bounded(once(child, 'close'), 'close after error');
});

test('the facade feeds pipeChildLogs like a real child', async () => {
  const logs = [];
  const child = await bounded(spawnOffMainThread(process.execPath, [
    '-e', "process.stdout.write('ready on 8034\\n'); process.stderr.write('warming up\\nno newline tail');",
  ], STDIO), 'spawn');
  pipeChildLogs(child, { logger: (level, event, details) => logs.push([level, event, details.line]), prefix: 'ninfer.server' });
  await bounded(once(child, 'close'), 'close');
  assert.deepEqual(logs.sort(), [
    ['DEBUG', 'ninfer.server.output', 'ready on 8034'],
    ['WARN', 'ninfer.server.output', 'no newline tail'],
    ['WARN', 'ninfer.server.output', 'warming up'],
  ]);
});

test('a Worker that cannot be constructed falls back to the synchronous spawn', async () => {
  const calls = [];
  const child = await bounded(spawnOffMainThread(process.execPath, ['-e', 'process.exitCode = 4'], STDIO, {
    WorkerImpl: function BrokenWorker() { throw new Error('no worker threads here'); },
    spawnImpl: (...call) => { calls.push(call); return spawn(...call); },
  }), 'fallback spawn');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], ['-e', 'process.exitCode = 4']);
  assert.deepEqual(calls[0][2].stdio, ['ignore', 'pipe', 'pipe']);
  const [code] = await bounded(once(child, 'exit'), 'exit');
  assert.equal(code, 4);
});

test('a Worker that dies before reporting the spawn falls back to the synchronous spawn', async () => {
  for (const failure of ['error', 'exit']) {
    const calls = [];
    class DyingWorker extends EventEmitter {
      constructor() {
        super();
        setImmediate(() => (failure === 'error' ? this.emit('error', new Error('worker crashed')) : this.emit('exit', 1)));
      }
      unref() {}
      terminate() { return Promise.resolve(); }
    }
    const child = await bounded(spawnOffMainThread(process.execPath, ['-e', ''], STDIO, {
      WorkerImpl: DyingWorker,
      spawnImpl: (...call) => { calls.push(call); return spawn(...call); },
    }), `fallback after worker ${failure}`);
    assert.equal(calls.length, 1, failure);
    const [code] = await bounded(once(child, 'exit'), 'exit');
    assert.equal(code, 0);
  }
});

test('only the plain spawn options cross the worker boundary', async () => {
  let seen = null;
  class CapturingWorker extends EventEmitter {
    constructor(_file, { workerData }) {
      super();
      seen = workerData;
      setImmediate(() => this.emit('exit', 1));
    }
    unref() {}
    terminate() { return Promise.resolve(); }
  }
  const child = await bounded(spawnOffMainThread(process.execPath, ['-e', ''], {
    cwd: process.cwd(), env: { PATH: process.env.PATH || '' }, windowsHide: true, detached: false,
    stdio: ['ignore', 'pipe', 'pipe'], shell: true, onSomething: () => {},
  }, { WorkerImpl: CapturingWorker, spawnImpl: (...call) => spawn(...call) }), 'spawn');
  assert.deepEqual(Object.keys(seen.options).sort(), ['cwd', 'detached', 'env', 'stdio', 'windowsHide']);
  await bounded(once(child, 'exit'), 'exit');
});
