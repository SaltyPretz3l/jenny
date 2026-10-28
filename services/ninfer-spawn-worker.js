'use strict';

// Spawns NInfer from a worker thread. On Windows uv_spawn runs CreateProcessW
// synchronously, and a Defender cloud lookup on the exe can hold it for 10+ s;
// on the Electron main thread that freezes every window. The worker takes the
// stall and relays the child to a ChildProcess-like facade.
//
// Worker -> main: spawned{pid}, stdout|stderr{chunk}, stdout_end|stderr_end,
// error{...}, exit{code,signal}, close{code,signal} (then the worker exits).
// Main -> worker: kill{signal}.

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const WORKER_MARKER = 'ninferSpawnWorker';
const STDIO = Object.freeze(['ignore', 'pipe', 'pipe']);

function plainSpawnOptions(options) {
  const source = options && typeof options === 'object' ? options : {};
  const out = { stdio: [...STDIO] };
  if (typeof source.cwd === 'string') out.cwd = source.cwd;
  if (source.env && typeof source.env === 'object') {
    out.env = {};
    for (const [key, value] of Object.entries(source.env)) {
      if (value !== undefined && value !== null) out.env[key] = String(value);
    }
  }
  if (typeof source.windowsHide === 'boolean') out.windowsHide = source.windowsHide;
  if (typeof source.detached === 'boolean') out.detached = source.detached;
  return out;
}

function runWorker({ command, args, options }) {
  let child;
  try {
    child = spawn(command, args, options);
  } catch (_error) {
    // The main side retries synchronously and gets the real throw.
    parentPort.postMessage({ type: 'spawn_failed' });
    parentPort.close();
    return;
  }
  const post = (message) => parentPort.postMessage(message);
  post({ type: 'spawned', pid: child.pid });
  for (const name of ['stdout', 'stderr']) {
    const stream = child[name];
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      post({ type: `${name}_end` });
    };
    stream.on('data', (chunk) => post({ type: name, chunk }));
    stream.on('end', end);
    stream.on('close', end);
  }
  child.on('error', (error) => post({
    type: 'error',
    error: {
      message: String(error && error.message || 'spawn failed'),
      code: error && error.code, errno: error && error.errno, syscall: error && error.syscall, path: error && error.path,
    },
  }));
  child.on('exit', (code, signal) => post({ type: 'exit', code, signal }));
  child.on('close', (code, signal) => {
    post({ type: 'close', code, signal });
    parentPort.close();
  });
  parentPort.on('message', (message) => {
    if (message && message.type === 'kill') {
      try { child.kill(message.signal); } catch (_error) { /* already gone */ }
    }
  });
}

if (!isMainThread && workerData && workerData[WORKER_MARKER] === true) {
  runWorker(workerData);
}

function rebuildError(details) {
  const error = new Error(details.message);
  for (const key of ['code', 'errno', 'syscall', 'path']) {
    if (details[key] !== undefined) error[key] = details[key];
  }
  return error;
}

class WorkerChildProcess extends EventEmitter {
  constructor(worker, pid) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;
    this._worker = worker;
    this._closed = false;
  }

  kill(signal) {
    if (this._closed || !this._worker || this.pid === undefined || this.exitCode !== null || this.signalCode !== null) {
      return false;
    }
    try {
      this._worker.postMessage({ type: 'kill', signal: typeof signal === 'string' || typeof signal === 'number' ? signal : undefined });
    } catch (_error) {
      return false;
    }
    this.killed = true;
    return true;
  }

  _handle(message) {
    switch (message && message.type) {
      case 'stdout': case 'stderr':
        this[message.type].write(Buffer.from(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength));
        break;
      case 'stdout_end': this.stdout.end(); break;
      case 'stderr_end': this.stderr.end(); break;
      case 'error':
        if (this.listenerCount('error') > 0) this.emit('error', rebuildError(message.error));
        break;
      case 'exit':
        this.exitCode = message.code;
        this.signalCode = message.signal;
        this.emit('exit', message.code, message.signal);
        break;
      case 'close':
        this._finish();
        this.emit('close', message.code, message.signal);
        break;
      default: break;
    }
  }

  // The child is done or the worker is gone: end the streams so readers settle.
  // A worker lost mid-run reports no exit (the child may still live; the
  // lifecycle's PID-based stop and taskkill fallback still own it).
  _finish() {
    if (this._closed) return;
    this._closed = true;
    this._worker = null;
    if (!this.stdout.writableEnded) this.stdout.end();
    if (!this.stderr.writableEnded) this.stderr.end();
  }
}

async function spawnOffMainThread(command, args, options, deps = {}) {
  const WorkerImpl = deps.WorkerImpl || Worker;
  const spawnImpl = deps.spawnImpl || spawn;
  const plain = plainSpawnOptions(options);
  const argv = Array.isArray(args) ? args.map(String) : [];
  const fallback = () => spawnImpl(command, argv, plain);
  let worker;
  try {
    worker = new WorkerImpl(path.join(__dirname, 'ninfer-spawn-worker.js'), {
      workerData: { [WORKER_MARKER]: true, command, args: argv, options: plain },
    });
    if (typeof worker.unref === 'function') worker.unref();
  } catch (_error) {
    return fallback();
  }
  return new Promise((resolve, reject) => {
    let child = null;
    let released = false;
    const queued = [];
    const deliver = (message) => {
      if (released) child._handle(message);
      else queued.push(message);
    };
    const onLost = () => {
      if (!child) {
        child = false;
        try { resolve(fallback()); } catch (error) { reject(error); }
        return;
      }
      if (child === false) return;
      // Flush anything already received before ending the streams.
      if (!released) { released = true; for (const message of queued.splice(0)) child._handle(message); }
      child._finish();
    };
    worker.on('message', (message) => {
      if (child === false) return;
      if (child === null) {
        if (!message || message.type !== 'spawned') { onLost(); return; }
        child = new WorkerChildProcess(worker, message.pid);
        resolve(child);
        // The caller attaches listeners right after its await; hold events
        // until then so an early exit/error is never emitted into the void.
        setImmediate(() => {
          released = true;
          for (const queuedMessage of queued.splice(0)) child._handle(queuedMessage);
        });
        return;
      }
      deliver(message);
    });
    worker.on('error', onLost);
    worker.on('exit', onLost);
  });
}

module.exports = { spawnOffMainThread };
