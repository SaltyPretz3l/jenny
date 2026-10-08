'use strict';

// The semantic catalog's embedding engine: a small managed llama-server of its
// own, beside (never instead of) the chat model's, so embedding never evicts
// the chat model. It keeps its own pid record, runs unkeyed on a free loopback
// port, and runs every start and stop on one serialized promise
// chain (the pattern of services/main/llama-server-manager.js). A crash is
// surfaced, never respawned: a later ensureRunning may relaunch after a
// backoff, and repeated failures for one spec stop until reset().

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { startLlamaServer } = require('../llama-server-lifecycle');
const { validateEmbeddingModel } = require('../embedding-model-profiles');

const MODEL_TAG = 'jenny-embedding';
const PID_FILE_NAME = 'embedding-server.pid';
const DEFAULT_CONTEXT_SIZE = 2048;
const MIN_CONTEXT_SIZE = 512;
const MAX_CONTEXT_SIZE = 8192;
const FAILURE_BACKOFF_MS = 30_000;
const MAX_CONSECUTIVE_FAILURES = 3;
// A server that crashes within this long of becoming ready keeps its failure
// count, so ready-then-crash loops still give up after three tries.
const STABLE_RUN_MS = 120_000;
// Lifecycle errors are bounded codes; anything else (a spawn error names the
// executable's path) is reported as this.
const ERROR_CODE_PATTERN = /^[a-z0-9_:.-]{1,96}$/i;

function normalizeLogger(logger) {
  return typeof logger === 'function' ? logger : () => {};
}

// Binds port 0 on loopback, reads the port the OS picked, and releases it for
// the launch (which refuses a port that was taken in between: adopt is off).
function allocateLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function normalizeDevice(value) {
  return value === 'gpu' ? 'gpu' : 'cpu';
}

function normalizeContextSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_CONTEXT_SIZE;
  return Math.min(MAX_CONTEXT_SIZE, Math.max(MIN_CONTEXT_SIZE, Math.trunc(number)));
}

function createEmbeddingServerManager({
  userDataPath,
  resourcesPath,
  repoRoot,
  logger,
  startServer = startLlamaServer,
  allocatePort = allocateLoopbackPort,
  now = Date.now,
  validateModel = validateEmbeddingModel,
  onStateChange = null,
  fsImpl = fs,
  platform = process.platform,
  // () => { binaryPath, source, error }: the executable a launch runs, resolved
  // as the chat server resolves its own (semantic-catalog-wiring.js). An empty
  // binaryPath lets the lifecycle find the bundled build.
  resolveRuntime = () => ({ binaryPath: '', source: '', error: '' }),
} = {}) {
  const log = normalizeLogger(logger);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  let chain = Promise.resolve();
  let handle = null;
  let currentSpecKey = '';
  let status = 'stopped';
  let baseUrl = '';
  let apiKey = '';
  let device = '';
  let modelKey = '';
  let lastError = '';
  let stopping = false;
  // The launch whose crash counts: 0 while nothing ready is running, so an
  // exit during a launch (the launch rejects instead) or after a requested
  // stop is never reported as a crash.
  let generation = 0;
  let readyGeneration = 0;
  let readyAt = 0;
  // Set by stopSync (the quit path): no launch starts or survives after it,
  // including one queued behind a stop that was still awaiting its exit.
  let disposed = false;
  let failures = { specKey: '', count: 0, lastAt: 0 };

  function getState() {
    return { status, baseUrl, device, modelKey, lastError };
  }

  function notify() {
    if (typeof onStateChange !== 'function') return;
    try {
      onStateChange(getState());
    } catch (_error) { /* an observer must never break the manager */ }
  }

  function setStatus(next, error = '') {
    status = next;
    lastError = error;
    notify();
  }

  function recordFailure(specKey) {
    failures = {
      specKey,
      count: failures.specKey === specKey ? failures.count + 1 : 1,
      lastAt: now(),
    };
  }

  // Stops serving; the process handle is released separately, only once its
  // exit is confirmed.
  function clearConnection() {
    readyAt = 0;
    baseUrl = '';
    apiKey = '';
    readyGeneration = 0;
  }

  function computeModelKey(modelPath) {
    const stat = fsImpl.statSync(modelPath);
    let normalized = pathApi.normalize(modelPath);
    if (platform === 'win32') normalized = normalized.toLowerCase();
    return crypto.createHash('sha256')
      .update(`${normalized}|${stat.size}|${stat.mtimeMs}`)
      .digest('hex')
      .slice(0, 16);
  }

  function enqueue(operation) {
    const run = chain.then(operation, operation);
    chain = run.catch(() => {});
    return run;
  }

  function forgetFailuresIfStable(specKey) {
    if (readyAt && now() - readyAt >= STABLE_RUN_MS && failures.specKey === specKey) {
      failures = { specKey, count: 0, lastAt: 0 };
    }
  }

  function handleExit(launchGeneration, info) {
    if (stopping || launchGeneration !== readyGeneration) return;
    const specKey = currentSpecKey;
    forgetFailuresIfStable(specKey);
    clearConnection();
    handle = null;
    recordFailure(specKey);
    log('WARN', 'embedding.server.exited', {
      code: info && info.code,
      signal: String(info && info.signal || ''),
    });
    setStatus('failed', 'embedder_exited');
  }

  async function stopHandle() {
    if (!handle) {
      clearConnection();
      return { confirmed: true };
    }
    const stoppingHandle = handle;
    stopping = true;
    // A deliberate stop of a server that became ready is a healthy run.
    if (readyAt && failures.specKey === currentSpecKey) failures = { specKey: currentSpecKey, count: 0, lastAt: 0 };
    readyGeneration = 0;
    let confirmed;
    try {
      const result = await stoppingHandle.stop();
      confirmed = !result || result.confirmed !== false;
    } catch (_error) {
      confirmed = false;
    } finally {
      stopping = false;
      clearConnection();
      // An unconfirmed stop keeps the handle, so the quit path and the next
      // launch can still try to end that process.
      if (confirmed) handle = null;
    }
    log(confirmed ? 'INFO' : 'WARN', 'embedding.server.stopped', { confirmed });
    return { confirmed };
  }

  function abandonIfDisposed() {
    if (!disposed) return;
    clearConnection();
    setStatus('stopped');
    throw new Error('embedder_stopped');
  }

  async function launch({ modelPath, device: nextDevice, contextSize, specKey }) {
    abandonIfDisposed();
    if (failures.specKey === specKey && failures.count >= MAX_CONSECUTIVE_FAILURES) {
      throw new Error('embedder_failed');
    }
    if (failures.specKey === specKey && failures.count > 0
        && now() - failures.lastAt < FAILURE_BACKOFF_MS) {
      throw new Error('embedder_backoff');
    }
    if (handle) {
      const stopped = await stopHandle();
      if (!stopped.confirmed) {
        setStatus('failed', 'embedder_stop_unconfirmed');
        throw new Error('embedder_stop_unconfirmed');
      }
      abandonIfDisposed();
    }
    const verdict = await validateModel(modelPath);
    if (!verdict || verdict.ok !== true) {
      const reason = verdict && typeof verdict.reason === 'string' ? verdict.reason : 'unreadable';
      setStatus('failed', `embedding_model_refused:${reason}`);
      throw new Error(`embedding_model_refused:${reason}`);
    }
    let nextModelKey;
    try {
      nextModelKey = computeModelKey(modelPath);
    } catch (_error) {
      setStatus('failed', 'embedding_model_refused:unreadable');
      // eslint-disable-next-line preserve-caught-error -- a stat error's message names the model path.
      throw new Error('embedding_model_refused:unreadable');
    }

    generation += 1;
    const launchGeneration = generation;
    const model = pathApi.basename(modelPath);
    currentSpecKey = specKey;
    device = nextDevice;
    modelKey = nextModelKey;
    setStatus('starting');
    let started;
    try {
      const runtime = (await resolveRuntime()) || {};
      abandonIfDisposed();
      if (runtime.error) throw new Error(String(runtime.error));
      const port = await allocatePort();
      abandonIfDisposed();
      log('INFO', 'embedding.server.start', { model, device: nextDevice, contextSize, port });
      started = await startServer({
        modelTag: MODEL_TAG,
        binaryPath: String(runtime.binaryPath || ''),
        runtimeSource: String(runtime.source || ''),
        modelPath,
        userDataPath,
        resourcesPath,
        repoRoot,
        host: '127.0.0.1',
        port,
        contextSize,
        adopt: false,
        pidFileName: PID_FILE_NAME,
        // Unkeyed: the builtin-tools subprocess embeds queries and never holds
        // secrets. The server stays on loopback, on a port nothing else owns.
        authenticate: false,
        extraArgs: [
          '--embedding',
          '-b', String(contextSize),
          '-ub', String(contextSize),
          '-ngl', nextDevice === 'gpu' ? '99' : '0',
        ],
        onExit: (info) => handleExit(launchGeneration, info),
        logger,
      });
    } catch (error) {
      const message = String(error && error.message || '');
      if (message === 'embedder_stopped') throw error;
      const code = ERROR_CODE_PATTERN.test(message) ? message : 'embedder_start_failed';
      recordFailure(specKey);
      clearConnection();
      log('WARN', 'embedding.server.failed', { model, reason: code });
      setStatus('failed', code);
      // eslint-disable-next-line preserve-caught-error -- a spawn error's message names the executable path.
      throw new Error(code);
    }
    if (disposed) {
      // The quit path ran while this launch was in flight.
      try {
        started.stopSync();
      } catch (_error) { /* best effort on the quit path */ }
      clearConnection();
      setStatus('stopped');
      throw new Error('embedder_stopped');
    }
    handle = started;
    baseUrl = started.baseUrl;
    apiKey = started.apiKey;
    readyGeneration = launchGeneration;
    readyAt = now();
    log('INFO', 'embedding.server.ready', { model, device: nextDevice, baseUrl });
    setStatus('ready');
    return { baseUrl, apiKey, modelKey };
  }

  function ensureRunning({ modelPath, device: requestedDevice = 'cpu', contextSize = DEFAULT_CONTEXT_SIZE } = {}) {
    const spec = {
      modelPath: typeof modelPath === 'string' ? modelPath.trim() : '',
      device: normalizeDevice(requestedDevice),
      contextSize: normalizeContextSize(contextSize),
    };
    const pathKey = platform === 'win32' ? pathApi.normalize(spec.modelPath).toLowerCase() : spec.modelPath;
    spec.specKey = `${pathKey}|${spec.device}|${spec.contextSize}`;
    return enqueue(async () => {
      if (status === 'ready' && handle && currentSpecKey === spec.specKey) {
        return { baseUrl, apiKey, modelKey };
      }
      return launch(spec);
    });
  }

  function stop() {
    return enqueue(async () => {
      const result = await stopHandle();
      if (!result.confirmed) setStatus('failed', 'embedder_stop_unconfirmed');
      else if (status !== 'stopped' || lastError) setStatus('stopped');
      return result;
    });
  }

  function stopSync() {
    disposed = true;
    if (!handle) {
      if (status === 'ready') setStatus('stopped');
      return;
    }
    const stoppingHandle = handle;
    stopping = true;
    clearConnection();
    handle = null;
    try {
      stoppingHandle.stopSync();
    } catch (_error) { /* best effort on the quit path */ }
    stopping = false;
    log('INFO', 'embedding.server.stopped', { sync: true });
    setStatus('stopped');
  }

  function reset() {
    failures = { specKey: '', count: 0, lastAt: 0 };
    if (status === 'failed' && !handle) setStatus('stopped');
  }

  return {
    ensureRunning,
    stop,
    stopSync,
    reset,
    getState,
    getApiKey: () => apiKey,
    getBaseUrl: () => baseUrl,
  };
}

module.exports = {
  allocateLoopbackPort,
  createEmbeddingServerManager,
};
