const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { pipeChildLogs } = require('./backend/child-process-logging');
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
  stripLatestTag,
  waitForReadiness,
} = require('./llama-server-readiness');
// Ownership record + PID-identity guards (F2c/F2d) live in a sibling module.
// Re-exported below so existing importers keep their entry points.
const {
  PID_FILENAME,
  buildPidRecordCommand,
  clearPidFile,
  getPidFilePath,
  llamaServerIdentityConfirmed,
  readPidFile,
  reapStalePidFile,
  shutdownLlamaServerSync,
  writePidFile,
} = require('./llama-server-pidfile');

const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 3_000;
// Per-launch api-key files (see startLlamaServer). Swept on every launch so a
// main process that died mid-startup cannot leave secrets behind.
const API_KEY_FILE_PATTERN = /^llama-server-[0-9a-f]{8}\.key$/;


function forceKillAndClearConfirmedPid({
  pid,
  pidPath,
  reason,
  log,
  platform,
  spawnSyncImpl,
  isProcessAliveImpl,
}) {
  forceKillProcessTreeSync(pid, { platform, spawnSyncImpl });
  const exited = verifyProcessExitedSync(pid, { isProcessAliveImpl });
  if (exited) {
    clearPidFile(pidPath);
    return true;
  }
  log('WARN', 'llama.server.force_kill_unconfirmed', {
    pid: Number(pid) || 0,
    reason,
    retained: true,
  });
  return false;
}

function isUnsafeFilenameCharacter(character) {
  return character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character);
}

function normalizeModelTagForFilename(modelTag) {
  return Array.from(stripLatestTag(modelTag))
    .map((character) => (isUnsafeFilenameCharacter(character) ? '_' : character))
    .join('')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// MTP drafters (mtp-*.gguf) and vision projectors (mmproj*.gguf) are
// documented to live next to the main model — never serve one AS the main
// model. Sorted so every consumer picks the same first main candidate.
function splitGgufFiles(names) {
  const ggufs = (Array.isArray(names) ? names : [])
    .filter((name) => /\.gguf$/i.test(String(name)))
    .map(String)
    .sort();
  return {
    main: ggufs.filter((name) => !/^(mtp-|mmproj)/i.test(name)),
    drafters: ggufs.filter((name) => /^mtp-/i.test(name)),
    projectors: ggufs.filter((name) => /^mmproj/i.test(name)),
  };
}

function resolveGgufPath({
  modelTag,
  userDataPath = '',
  repoRoot = process.cwd(),
  fsImpl = fs,
} = {}) {
  const alias = stripLatestTag(modelTag);
  const filenameTag = normalizeModelTagForFilename(modelTag);
  if (!filenameTag) {
    return { path: '', projectorPath: '', reason: 'model_tag_empty' };
  }

  const candidateDirs = [];
  if (userDataPath) {
    candidateDirs.push(path.join(userDataPath, 'models', filenameTag));
  }
  candidateDirs.push(path.join(repoRoot, '.jenny', 'models', filenameTag));

  for (const dir of candidateDirs) {
    try {
      // A directory holding only auxiliaries (e.g. a partial download) means
      // the main model is genuinely absent: keep scanning and let the
      // standard not_found path report it.
      const split = splitGgufFiles(fsImpl.readdirSync(dir));
      if (split.main.length > 0) {
        return {
          path: path.join(dir, split.main[0]),
          projectorPath: pairProjector(dir, split.main[0], split),
          reason: 'resolved',
        };
      }
    } catch (error) {
      if (error && error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        return { path: '', projectorPath: '', reason: `read_dir_failed:${error.code || 'unknown'}` };
      }
    }
  }

  if (alias.toLowerCase().startsWith('gemma4-e4b-it-')) {
    const legacyPath = path.join(repoRoot, 'gemma-4-E4B-it-UD-Q5_K_XL.gguf');
    try {
      if (fsImpl.statSync(legacyPath).isFile()) {
        return { path: legacyPath, projectorPath: '', reason: 'resolved_legacy' };
      }
    } catch (_error) {
      /* fall through to not_found */
    }
  }

  return { path: '', projectorPath: '', reason: 'not_found' };
}

// Shared pairing rule: a lone main model owns the directory's projector; otherwise the stems must match.
function pairProjector(dir, modelFile, { main, projectors }) {
  if (projectors.length === 0) return '';
  if (main.length === 1) return path.join(dir, projectors[0]);
  const stem = (filename) => path.basename(filename, path.extname(filename))
    .replace(/^mmproj[-_]/i, '').toLowerCase();
  const modelStem = stem(modelFile);
  const paired = projectors.find((projector) => {
    const projectorStem = stem(projector);
    return Boolean(modelStem && projectorStem)
      && (modelStem.includes(projectorStem) || projectorStem.includes(modelStem));
  });
  return paired ? path.join(dir, paired) : '';
}

function resolveProjectorPath({ modelPath, fsImpl = fs } = {}) {
  try {
    if (!String(modelPath || '').trim()) {
      return '';
    }
    const dir = path.dirname(modelPath);
    return pairProjector(dir, modelPath, splitGgufFiles(fsImpl.readdirSync(dir)));
  } catch (_error) {
    return '';
  }
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

async function probeVisionSupport(baseUrl, {
  timeoutMs = 2_000,
  apiKey = '',
  fetchImpl = globalThis.fetch,
} = {}) {
  try {
    const response = await requestWithTimeout(new URL('/props', baseUrl).toString(), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      timeoutMs,
      fetchImpl,
    });
    if (!response || response.ok !== true) return false;
    const payload = await response.json();
    return payload?.modalities?.vision === true;
  } catch (_error) {
    return false;
  }
}

async function startLlamaServer({
  modelTag,
  binaryPath = '',
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
    binary: resolvedBinary,
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
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
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
  pipeChildLogs(child, { logger: log, prefix: 'llama.server' });

  const childExitedRef = { exited: false };
  let exitInfo = null;
  child.on('exit', (code, signal) => {
    childExitedRef.exited = true;
    exitInfo = { code, signal };
    clearPidFile(pidPath);
    log(code === 0 ? 'INFO' : 'WARN', 'llama.server.exited', {
      pid: child.pid || 0,
      code,
      signal: String(signal || ''),
    });
    if (typeof onExit === 'function') {
      try {
        onExit({ pid: child.pid || 0, code, signal: String(signal || '') });
      } catch (_error) { /* an observer must never break the exit path */ }
    }
  });
  child.on('error', (error) => {
    childExitedRef.exited = true;
    log('ERROR', 'llama.server.spawn_error', {
      message: String(error && error.message || error),
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
    });
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
    });
    removeApiKeyFile();
    throw new Error('llama_server_readiness_timeout');
  }

  removeApiKeyFile();
  log('INFO', 'llama.server.ready', { pid: child.pid || 0, baseUrl });

  const stopHandleState = { stopped: false };

  // Resolves { confirmed } — false when even the force kill could not be
  // verified, so the owner (the manager) never records a clean stop for a
  // child that may still be alive.
  async function stop({ timeoutMs = DEFAULT_GRACEFUL_STOP_TIMEOUT_MS } = {}) {
    if (stopHandleState.stopped) {
      return { confirmed: true };
    }
    stopHandleState.stopped = true;
    if (childExitedRef.exited || !child.pid) {
      clearPidFile(pidPath);
      return { confirmed: true };
    }
    const pid = child.pid;
    try {
      child.kill();
    } catch (_error) { /* already exited */ }
    const deadline = Date.now() + Math.max(Number(timeoutMs) || DEFAULT_GRACEFUL_STOP_TIMEOUT_MS, 500);
    while (Date.now() < deadline) {
      if (childExitedRef.exited || !isProcessAliveImpl(pid)) {
        clearPidFile(pidPath);
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
      clearPidFile(pidPath);
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
