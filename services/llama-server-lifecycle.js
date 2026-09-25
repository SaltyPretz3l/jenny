const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { pipeChildLogs } = require('./backend/child-process-logging');
const { resolveLlamaServerOutputLevel } = require('./backend/llama-server-stderr-level');
const { createEngineActivityForwarder } = require('./backend/engine-activity-lines');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');
const { forceKillProcessTreeSync, verifyProcessExitedSync } = require('./backend/sidecar-shutdown');
const { isProcessAlive, wait } = require('./backend/process-utils');
const { requestWithTimeout } = require('./http-fetch-util');
const {
  DEFAULT_EXISTING_PROBE_TIMEOUT_MS,
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  normalizeLogger,
  probeExistingServer,
  probeHealth,
  probeVisionSupport,
  stripLatestTag,
  waitForReadiness,
} = require('./llama-server-readiness');
// Ownership record + PID-identity guards (F2c/F2d) live in a sibling module.
// Re-exported below so existing importers keep their entry points.
const {
  PID_FILENAME,
  buildPidRecordCommand,
  clearOwnedPidFile,
  clearPidFile,
  getPidFilePath,
  llamaServerIdentityConfirmed,
  readPidFile,
  reapStalePidFile,
  shutdownLlamaServerSync,
  writePidFile,
} = require('./llama-server-pidfile');
// GGUF discovery (main / drafter / projector classification and pairing) lives
// in a sibling module; re-exported below for the same reason.
const {
  normalizeModelTagForFilename,
  pairProjector,
  resolveGgufPath,
  resolveProjectorPath,
  splitGgufFiles,
} = require('./llama-server-gguf-files');

const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 3_000;
// Per-launch api-key files (see startLlamaServer). Swept on every launch so a
// main process that died mid-startup cannot leave secrets behind.
const API_KEY_FILE_PATTERN = /^llama-server-[0-9a-f]{8}\.key$/;
// A build that cannot read the model file exits during load and says why only
// on stderr: a quant type newer than the build ("invalid ggml type 142") or an
// architecture it predates. Load errors come first, so a bounded prefix of
// stderr is enough to classify the exit. Each pattern starts at the loader
// function that prints it, after llama.cpp's optional log prefix (a
// --log-timestamps stamp, the level letter), so a path or a metadata value
// that merely contains the phrase never matches.
const UNSUPPORTED_MODEL_PATTERNS = [
  /^(?:\d+(?:\.\d+){3} )?(?:[IWED] )?gguf_\w+: tensor '[^']*' has invalid ggml type \d+/,
  /^(?:\d+(?:\.\d+){3} )?(?:[IWED] )?llama_model_load: error loading model: (?:error loading model architecture: )?unknown model architecture: '/,
];
// eslint-disable-next-line no-control-regex -- llama.cpp's --log-colors codes.
const LOG_COLOR_CODES = /\u001b\[[\d;]*m/g;
const MAX_LOAD_FAILURE_LINES = 2_000;
// The build's folder as it appears in the build's own output ("loaded CUDA
// backend from <folder>\ggml-cuda.dll"): a folder the user named, often under
// their user name, so logged lines carry this token instead.
const RUNTIME_FOLDER_TOKEN = '[llama-server folder]';
// Lines still in the pipe when the exit is noticed arrive after it; a closed
// stderr means none are left. Bounded because a stream may never report it.
const STDERR_SETTLE_TIMEOUT_MS = 250;

// Replaces the build's folder in a logged line, in any case on win32 and with
// either separator. A drive or filesystem root is left alone: replacing it
// would rewrite every path in every line (a network share's root names the
// share, so it is replaced). A folder that starts with a separator matches
// only from the start of a separator run, so a long run costs linear time.
function runtimeFolderRedactor(binaryPath, platform) {
  const folder = path.dirname(String(binaryPath || ''));
  const parts = folder.replace(/[\\/]+$/, '').split(/[\\/]+/);
  if (!path.isAbsolute(folder) || !parts.some((part) => part && !/^[A-Za-z]:$/.test(part))) {
    return (line) => line;
  }
  const pattern = new RegExp(
    (parts[0] === '' ? '(?<![\\\\/])' : '')
      + parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+'),
    platform === 'win32' ? 'gi' : 'g'
  );
  return (line) => line.replace(pattern, RUNTIME_FOLDER_TOKEN);
}

function stderrSettled(child, timeoutMs) {
  const stream = child && child.stderr;
  if (!stream || stream.readableEnded || stream.destroyed || typeof stream.once !== 'function') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      stream.removeListener('end', done);
      stream.removeListener('close', done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    stream.once('end', done);
    stream.once('close', done);
  });
}

function forceKillAndClearConfirmedPid({
  pid,
  pidPath,
  reason,
  log,
  platform,
  spawnSyncImpl,
  isProcessAliveImpl,
  childExitedRef,
}) {
  // An exited child was reaped (its pid may be another process's by now).
  if (childExitedRef && childExitedRef.exited) return true;
  forceKillProcessTreeSync(pid, { platform, spawnSyncImpl });
  const exited = verifyProcessExitedSync(pid, { isProcessAliveImpl });
  if (exited) {
    clearOwnedPidFile(pidPath, pid);
    return true;
  }
  log('WARN', 'llama.server.force_kill_unconfirmed', {
    pid: Number(pid) || 0,
    reason,
    retained: true,
  });
  return false;
}

function resolveBinaryPath({
  override = '',
  repoRoot = process.cwd(),
  resourcesPath = '',
  platform = process.platform,
  fsImpl = fs,
} = {}) {
  const exeName = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const candidates = [];
  if (override) {
    candidates.push(override);
  }
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'llama_server_extract', exeName));
  }
  candidates.push(path.join(repoRoot, 'llama_server_extract', exeName));

  for (const candidate of candidates) {
    try {
      if (fsImpl.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch (_error) { /* try next candidate */ }
  }
  return '';
}

// Any llama-server-*.key left in userData belongs to a launch whose main
// process died before readiness settled; the server it authenticated is gone
// or being reaped, so the files are just leaked secrets.
function sweepStaleApiKeyFiles(userDataPath, fsImpl = fs) {
  let names;
  try {
    names = fsImpl.readdirSync(userDataPath);
  } catch (_error) {
    return;
  }
  for (const name of names) {
    if (API_KEY_FILE_PATTERN.test(name)) {
      try {
        fsImpl.unlinkSync(path.join(userDataPath, name));
      } catch (_error) { /* best effort only */ }
    }
  }
}

function buildLaunchArgs({
  modelPath,
  projectorPath = '',
  host,
  port,
  contextSize,
  modelAlias,
  apiKeyPath = '',
  extraArgs = [],
}) {
  const args = [
    '-m', modelPath,
    '--host', host,
    '--port', String(port),
    '-c', String(contextSize),
  ];
  if (modelAlias) {
    args.push('-a', modelAlias);
  }
  if (apiKeyPath) {
    args.push('--api-key-file', apiKeyPath, '--no-slots');
  }
  if (Array.isArray(extraArgs)) {
    for (const arg of extraArgs) {
      const text = String(arg || '').trim();
      if (text) {
        args.push(text);
      }
    }
  }
  if (projectorPath) {
    args.push('--mmproj', projectorPath);
  }
  return args;
}

async function startLlamaServer({
  modelTag,
  binaryPath = '',
  // Which build this launch runs (the manager's resolveLaunchRuntime): a
  // bounded label for logs, and whether a load failure blames the bundled one.
  runtimeLabel = '',
  runtimeSource = '',
  modelPath = '',
  projectorPath: preResolvedProjectorPath,
  userDataPath = '',
  repoRoot = process.cwd(),
  resourcesPath = '',
  host = '127.0.0.1',
  port = 8033,
  contextSize = 32768,
  extraArgs = [],
  readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  readinessPollIntervalMs = DEFAULT_READINESS_POLL_INTERVAL_MS,
  abortSignal = null,
  // Fired once when a spawned child exits (never for a reused server); the
  // manager uses it to surface a crash. Never awaited, must not throw.
  onExit = null,
  // Throttled engine-liveness sink. llama-server prints per-slot decode
  // telemetry while the model composes a buffered tool call — the one signal
  // that separates "still generating" from "hung" for the sidecar's stream
  // inactivity watchdog (services/backend/engine-activity-lines.js).
  onEngineActivity = null,
  logger,
  platform = process.platform,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  isProcessAliveImpl = isProcessAlive,
  fsImpl = fs,
  fetchImpl = globalThis.fetch,
} = {}) {
  const log = normalizeLogger(logger);
  const baseUrl = `http://${host}:${port}/v1`;
  if (abortSignal && abortSignal.aborted) {
    throw new Error('readiness_aborted');
  }

  const modelAlias = stripLatestTag(modelTag);
  let resolvedModel = String(modelPath || '').trim();
  let resolvedModelReason = 'override';
  let projectorPath = typeof preResolvedProjectorPath === 'string'
    ? preResolvedProjectorPath
    : resolveProjectorPath({ modelPath: resolvedModel, fsImpl });
  if (!resolvedModel) {
    const resolved = resolveGgufPath({ modelTag, userDataPath, repoRoot, fsImpl });
    resolvedModel = resolved.path;
    projectorPath = typeof preResolvedProjectorPath === 'string'
      ? preResolvedProjectorPath
      : resolved.projectorPath;
    resolvedModelReason = resolved.reason;
  }
  if (!resolvedModel) {
    projectorPath = '';
  }

  let reuseExisting = await probeExistingServer({
    baseUrl,
    host,
    port,
    expectedModelId: modelAlias,
    logger: log,
  });
  let reuseRejectedNoMmproj = false;
  if (reuseExisting && projectorPath
      && !await probeVisionSupport(baseUrl, { fetchImpl })) {
    log('WARN', 'llama.server.reuse_rejected_no_mmproj', { baseUrl });
    reuseExisting = false;
    reuseRejectedNoMmproj = true;
  }
  if (reuseExisting) {
    log('INFO', 'llama.server.reuse_existing', { baseUrl });
    return {
      pid: 0,
      baseUrl,
      reused: true,
      mmproj: 'unknown',
      apiKey: '',
      stop: async () => {},
      stopSync: () => {},
    };
  }
  if (reuseRejectedNoMmproj && await probeHealth(baseUrl)) {
    log('WARN', 'llama.server.port_busy_no_mmproj', { baseUrl });
    throw new Error('llama_server_port_busy_no_mmproj');
  }
  if (!resolvedModel) {
    throw new Error(`llama_server_model_not_found:${resolvedModelReason}`);
  }

  reapStalePidFile({ userDataPath, logger: log, platform, spawnSyncImpl, isProcessAliveImpl });

  const resolvedBinary = binaryPath || resolveBinaryPath({ repoRoot, resourcesPath, platform, fsImpl });
  if (!resolvedBinary) {
    throw new Error('llama_server_binary_not_found');
  }

  if (!userDataPath) {
    // Fail closed: the api-key file has no home without userData, and an
    // unauthenticated launch must never happen silently.
    throw new Error('llama_server_user_data_path_required');
  }
  const pidPath = getPidFilePath(userDataPath);
  // Per-launch filename: a late 'exit' from a previous, force-killed child (the
  // acceleration fallback relaunches immediately) cannot unlink a fresh
  // launch's file. llama-server reads the file once while parsing its
  // arguments, before it listens, so the file is deleted the moment readiness
  // settles (ready, timed out, aborted, exited) and never sits on disk for the
  // server's lifetime. The spawn-failure path below is the only earlier exit.
  const apiKeyPath = path.join(userDataPath, `llama-server-${crypto.randomBytes(4).toString('hex')}.key`);
  const apiKey = crypto.randomBytes(16).toString('hex');
  const removeApiKeyFile = () => {
    try {
      fsImpl.unlinkSync(apiKeyPath);
    } catch (_error) { /* best effort: absent or already removed */ }
  };
  sweepStaleApiKeyFiles(userDataPath, fsImpl);

  const args = buildLaunchArgs({
    modelPath: resolvedModel,
    projectorPath,
    host,
    port,
    contextSize,
    modelAlias,
    apiKeyPath,
    extraArgs,
  });

  log('INFO', 'llama.server.spawn', {
    runtime: runtimeLabel || (binaryPath ? 'custom' : 'bundled'),
    model: resolvedModel,
    mmproj: projectorPath,
    host,
    port,
    contextSize,
    modelReason: resolvedModelReason,
  });

  let child;
  try {
    fsImpl.mkdirSync(path.dirname(apiKeyPath), { recursive: true });
    fsImpl.writeFileSync(apiKeyPath, `${apiKey}\n`, { mode: 0o600 });
    child = spawnImpl(resolvedBinary, args, {
      cwd: path.dirname(resolvedBinary),
      detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeSpawnEnv(process.env),
    });
  } catch (error) {
    removeApiKeyFile();
    throw error;
  }

  if (child.pid) {
    writePidFile(pidPath, child.pid, {
      command: buildPidRecordCommand(resolvedBinary, args),
    });
  }
  let loadFailure = '';
  let inspectedLines = 0;
  const forwardEngineActivity = createEngineActivityForwarder({ onEngineActivity });
  const redactFolder = runtimeFolderRedactor(resolvedBinary, platform);
  pipeChildLogs(child, {
    // Logged lines carry the folder token; classification reads the raw line.
    logger: (level, event, details) => log(level, event, typeof details?.line === 'string'
      ? { ...details, line: redactFolder(details.line) }
      : details),
    prefix: 'llama.server',
    resolveLevel: resolveLlamaServerOutputLevel,
    onOutput: ({ stream, line }) => {
      if (stream !== 'stderr') {
        return;
      }
      // Before the load-failure early-outs: decode telemetry arrives long
      // after the inspection budget is spent, and that is exactly when the
      // watchdog needs it.
      if (forwardEngineActivity) {
        forwardEngineActivity(line);
      }
      if (loadFailure || inspectedLines >= MAX_LOAD_FAILURE_LINES) {
        return;
      }
      inspectedLines += 1;
      const plain = line.replace(LOG_COLOR_CODES, '');
      if (UNSUPPORTED_MODEL_PATTERNS.some((pattern) => pattern.test(plain))) {
        loadFailure = 'model_unsupported';
      }
    },
  });

  const childExitedRef = { exited: false };
  // Set by stop()/stopSync(): an exit we asked for is not an anomaly.
  const stopHandleState = { stopped: false };
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    childExitedRef.exited = true;
    exitInfo = { code, signal };
    clearOwnedPidFile(pidPath, child.pid);
    log(code === 0 || stopHandleState.stopped ? 'INFO' : 'WARN', 'llama.server.exited', {
      pid: child.pid || 0,
      code,
      signal: String(signal || ''),
      requested: stopHandleState.stopped,
    });
    if (typeof onExit === 'function') {
      try {
        onExit({ pid: child.pid || 0, code, signal: String(signal || '') });
      } catch (_error) { /* an observer must never break the exit path */ }
    }
  });
  child.on('error', (error) => {
    childExitedRef.exited = true;
    // The code only: a spawn error's message carries the executable's path.
    log('ERROR', 'llama.server.spawn_error', {
      code: String(error && error.code || 'spawn_failed'),
    });
  });

  let ready;
  try {
    ready = await waitForReadiness({
      baseUrl,
      timeoutMs: readinessTimeoutMs,
      pollIntervalMs: readinessPollIntervalMs,
      abortSignal,
      childExitedRef,
      apiKey,
    });
  } catch (error) {
    removeApiKeyFile();
    const message = String(error && error.message || error);
    log('WARN', 'llama.server.readiness_failed', { message, exit: exitInfo });
    forceKillAndClearConfirmedPid({
      pid: child.pid,
      pidPath,
      reason: 'readiness_failed',
      log,
      platform,
      spawnSyncImpl,
      isProcessAliveImpl,
      childExitedRef,
    });
    if (message === 'child_exited_before_ready') {
      if (!loadFailure) {
        await stderrSettled(child, STDERR_SETTLE_TIMEOUT_MS);
      }
      if (loadFailure) {
        // Names whose build could not read the file; never the path.
        const blamed = runtimeSource === 'bundled' || (!runtimeSource && !binaryPath) ? 'bundled' : 'custom';
        log('WARN', 'llama.server.model_unsupported', { runtime: runtimeLabel || blamed });
        throw new Error(`llama_server_${loadFailure}:${blamed}`, { cause: error });
      }
    }
    throw error;
  }

  if (!ready) {
    log('WARN', 'llama.server.readiness_timeout', {
      pid: child.pid || 0,
      baseUrl,
      timeoutMs: readinessTimeoutMs,
    });
    forceKillAndClearConfirmedPid({
      pid: child.pid,
      pidPath,
      reason: 'readiness_timeout',
      log,
      platform,
      spawnSyncImpl,
      isProcessAliveImpl,
      childExitedRef,
    });
    removeApiKeyFile();
    throw new Error('llama_server_readiness_timeout');
  }

  removeApiKeyFile();
  log('INFO', 'llama.server.ready', { pid: child.pid || 0, baseUrl });

  // Resolves { confirmed } — false when even the force kill could not be
  // verified, so the owner (the manager) never records a clean stop for a
  // child that may still be alive.
  async function stop({ timeoutMs = DEFAULT_GRACEFUL_STOP_TIMEOUT_MS } = {}) {
    if (stopHandleState.stopped) {
      return { confirmed: true };
    }
    stopHandleState.stopped = true;
    if (childExitedRef.exited || !child.pid) {
      clearOwnedPidFile(pidPath, child.pid);
      return { confirmed: true };
    }
    const pid = child.pid;
    try {
      child.kill();
    } catch (_error) { /* already exited */ }
    const deadline = Date.now() + Math.max(Number(timeoutMs) || DEFAULT_GRACEFUL_STOP_TIMEOUT_MS, 500);
    while (Date.now() < deadline) {
      if (childExitedRef.exited || !isProcessAliveImpl(pid)) {
        clearOwnedPidFile(pidPath, pid);
        return { confirmed: true };
      }
      await wait(100);
    }
    const confirmed = forceKillAndClearConfirmedPid({
      pid,
      pidPath,
      reason: 'stop_timeout',
      log,
      platform,
      spawnSyncImpl,
      isProcessAliveImpl,
      childExitedRef,
    });
    return { confirmed };
  }

  function stopSync() {
    if (stopHandleState.stopped) {
      return;
    }
    stopHandleState.stopped = true;
    const pid = child.pid;
    if (!pid || childExitedRef.exited) {
      clearOwnedPidFile(pidPath, pid);
      return;
    }
    forceKillAndClearConfirmedPid({
      pid,
      pidPath,
      reason: 'stop_sync',
      log,
      platform,
      spawnSyncImpl,
      isProcessAliveImpl,
    });
  }

  return {
    pid: child.pid || 0,
    baseUrl,
    reused: false,
    mmproj: projectorPath,
    apiKey,
    stop,
    stopSync,
  };
}

module.exports = {
  DEFAULT_EXISTING_PROBE_TIMEOUT_MS,
  DEFAULT_GRACEFUL_STOP_TIMEOUT_MS,
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  PID_FILENAME,
  buildLaunchArgs,
  buildPidRecordCommand,
  clearPidFile,
  getPidFilePath,
  llamaServerIdentityConfirmed,
  normalizeModelTagForFilename,
  pairProjector,
  probeExistingServer,
  probeHealth,
  probeVisionSupport,
  pipeChildLogs,
  readPidFile,
  reapStalePidFile,
  resolveBinaryPath,
  resolveGgufPath,
  resolveProjectorPath,
  shutdownLlamaServerSync,
  splitGgufFiles,
  startLlamaServer,
  stripLatestTag,
  sweepStaleApiKeyFiles,
  waitForReadiness,
  writePidFile,
};
