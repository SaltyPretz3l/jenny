'use strict';

// Spawns and supervises ONE managed `ninfer-serve` process (row 54 N2). The
// manager (services/main/ninfer-manager.js) owns the state machine; this
// module knows how to launch one server on loopback and hand back a handle,
// the way services/llama-server-lifecycle.js does for llama-server.
//
// Security boundary, fixed here and tested in tests/ninfer-lifecycle.test.js:
// - The server binds 127.0.0.1 only. `--cors` and `--webui` (which downloads
//   a web UI) are never passed; no caller-supplied extra argv exists.
// - Each launch gets a fresh key. ninfer-serve accepts a key only as
//   `--api-key KEY` on its command line (no key file, no env var), so the pair
//   goes LAST on the argv, the PID record is built from the argv without it,
//   and the argv is never logged. Same-user processes can read the command
//   line for the server's lifetime; that residual is accepted in the parent
//   plan (NINFER_RTX5090_ENGINE_2026-10-12.md §5 item 5).
// - A busy port is refused, never adopted: a foreign server on 8034 is not
//   ours to trust and its key is not ours to know. A launch first waits a
//   few seconds for the port to close: on Windows a terminated server reads
//   as not alive before its listening socket is torn down, so a restart
//   right after a confirmed stop otherwise finds its own predecessor's port.
// - Host pinned memory is sized from free RAM, and a launch that dies with
//   `cudaMallocHost failed` (seen right after a force-kill on the owner's
//   32 GB machine) is retried exactly once with host pinning disabled.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const { pipeChildLogs } = require('./backend/child-process-logging');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');
const { forceKillProcessTreeSync, verifyProcessExitedSync } = require('./backend/sidecar-shutdown');
const { isPortOpen, isProcessAlive, wait, waitForPortToClose } = require('./backend/process-utils');
const { requestWithTimeout } = require('./http-fetch-util');
const {
  buildPidRecordCommand,
  clearOwnedPidFile,
  getPidFilePath,
  reapStalePidFile,
  writePidFile,
} = require('./llama-server-pidfile');
const { normalizeLogger } = require('./llama-server-readiness');

const NINFER_PID_FILENAME = 'ninfer-serve.pid';
const NINFER_HOST = '127.0.0.1';
const DEFAULT_NINFER_PORT = 8034;
const DEFAULT_CONTEXT_SIZE = 65536;
// MTP draft length and the runtime's cheaper draft LM head (the upstream
// launcher passes it). The LM head adds 8-17% decode on Jenny-like turns; 4
// drafts win at 64k but lose 7-11% to 3 past 100k of fill
// (maintainer tuning runs, 2026-10-15). Verification by the full
// model keeps the output distribution unchanged.
const DEFAULT_DRAFT_TOKENS = 3;
const DEFAULT_LM_HEAD_DRAFT = true;
const DEFAULT_READINESS_TIMEOUT_MS = 120_000;
const DEFAULT_READINESS_POLL_INTERVAL_MS = 300;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 3_000;
// How long a launch waits for a just-stopped server's port to close.
const DEFAULT_PORT_RELEASE_TIMEOUT_MS = 5_000;
// ninfer-serve pins host KV at 8 GiB by default. Keep 12 GiB for the OS and
// Jenny, cap at the server's own default: min(8192, max(0, free - 12288)).
const HOST_KV_CAP_MIB = 8192;
const HOST_RESERVE_MIB = 12288;
// Default host-state slots (1.15 GiB measured) that the retry also disables.
const HOST_STATE_GIB_ESTIMATE = 1.15;
const PINNED_MEMORY_FAILURE = /cudaMallocHost failed/;
const MAX_INSPECTED_STDERR_LINES = 2_000;
const STDERR_SETTLE_TIMEOUT_MS = 250;
const API_KEY_PATTERN = /^[0-9a-f]{32}$/;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FORBIDDEN_ARGS = Object.freeze(['--cors', '--webui', '--webui-dir', '0.0.0.0']);
// '' keeps the runtime's bf16 KV cache; 'fp8' halves it (the 262k window).
const KV_DTYPES = Object.freeze(['', 'fp8']);

function lifecycleError(reason, extra = {}) {
  return Object.assign(new Error(reason), { reason, ...extra });
}

function computeHostKvMib(freeMemoryMib) {
  const free = Number.isFinite(freeMemoryMib) ? Math.floor(freeMemoryMib) : 0;
  return Math.min(HOST_KV_CAP_MIB, Math.max(0, free - HOST_RESERVE_MIB));
}

// The exact argv; the key pair is always last so the PID record can be the
// argv without it (the identity matcher is a substring test).
function buildNinferLaunchArgs({
  artifactPath,
  host = NINFER_HOST,
  port = DEFAULT_NINFER_PORT,
  modelId,
  contextSize = DEFAULT_CONTEXT_SIZE,
  hostKvMib,
  hostStateSlots = null,
  mtp = true,
  vision = true,
  draftTokens = DEFAULT_DRAFT_TOKENS,
  lmHeadDraft = DEFAULT_LM_HEAD_DRAFT,
  kvDtype = '',
  apiKey = '',
} = {}) {
  if (host !== NINFER_HOST) throw lifecycleError('ninfer_host_not_loopback');
  if (typeof artifactPath !== 'string' || !artifactPath.trim()) throw lifecycleError('ninfer_artifact_path_required');
  if (!MODEL_ID_PATTERN.test(String(modelId || ''))) throw lifecycleError('ninfer_model_id_invalid');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw lifecycleError('ninfer_port_invalid');
  if (!Number.isInteger(contextSize) || contextSize <= 0) throw lifecycleError('ninfer_context_size_invalid');
  if (!Number.isInteger(hostKvMib) || hostKvMib < 0) throw lifecycleError('ninfer_host_kv_invalid');
  if (typeof vision !== 'boolean') throw lifecycleError('ninfer_vision_invalid');
  if (!KV_DTYPES.includes(kvDtype)) throw lifecycleError('ninfer_kv_dtype_invalid');
  const args = [
    artifactPath,
    '--host', host,
    '--port', String(port),
    '--model-id', modelId,
    '--max-context', String(contextSize),
    '--max-concurrency', '1',
    '--host-kv-mib', String(hostKvMib),
    '--log-level', 'info',
  ];
  if (vision) args.push('--vision');
  if (hostStateSlots !== null && hostStateSlots !== undefined) {
    if (!Number.isInteger(hostStateSlots) || hostStateSlots < 0) throw lifecycleError('ninfer_host_state_slots_invalid');
    args.push('--host-state-slots', String(hostStateSlots));
  }
  if (kvDtype) args.push('--kv-dtype', kvDtype);
  if (mtp) {
    args.push('--spec', 'mtp', '--draft-tokens', String(draftTokens));
    if (lmHeadDraft) args.push('--lm-head-draft');
  }
  if (args.some((arg) => FORBIDDEN_ARGS.includes(String(arg).toLowerCase()))) {
    throw lifecycleError('ninfer_forbidden_arg');
  }
  if (apiKey) {
    args.push('--api-key', apiKey);
  }
  return args;
}

function argsWithoutApiKey(args) {
  const index = args.indexOf('--api-key');
  return index === -1 ? args.slice() : args.slice(0, index);
}

// Logged lines carry folder tokens instead of the runtime and model folders
// (both often sit under the user's name). Case-insensitive on win32, either
// separator; a drive root is left alone.
function folderRedactor(folders, platform) {
  const patterns = [];
  for (const [folder, token] of folders) {
    const parts = String(folder || '').replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
    if (!parts.some((part) => !/^[A-Za-z]:$/.test(part))) continue;
    const source = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+');
    patterns.push([new RegExp(source, platform === 'win32' ? 'gi' : 'g'), token]);
  }
  return (line) => patterns.reduce((text, [pattern, token]) => text.replace(pattern, token), line);
}

function resolveOutputLevel({ line }) {
  return /\b(error|critical|failed|exception)\b/i.test(line) ? 'WARN' : 'INFO';
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

// GET /health until {"status":"ok"}; the key is sent so a keyed build that
// guards /health still answers. Resolves false on timeout.
async function waitForNinferHealth({
  healthUrl,
  apiKey = '',
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_READINESS_POLL_INTERVAL_MS,
  abortSignal = null,
  childExitedRef = { exited: false },
  fetchImpl = globalThis.fetch,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
  while (Date.now() < deadline) {
    if (abortSignal && abortSignal.aborted) throw lifecycleError('readiness_aborted');
    if (childExitedRef.exited) throw lifecycleError('child_exited_before_ready');
    try {
      const response = await requestWithTimeout(healthUrl, { headers, timeoutMs: 1_500, fetchImpl });
      if (response && response.ok === true) {
        const payload = await response.json();
        // Re-read both signals after the awaits: an abort or exit that landed
        // while the reply was in flight must not promote this launch.
        if (abortSignal && abortSignal.aborted) throw lifecycleError('readiness_aborted');
        if (childExitedRef.exited) throw lifecycleError('child_exited_before_ready');
        if (payload && payload.status === 'ok') return true;
      }
    } catch (error) {
      if (error && (error.reason === 'readiness_aborted' || error.reason === 'child_exited_before_ready')) throw error;
      /* not listening yet */
    }
    await wait(pollIntervalMs);
  }
  return false;
}

function forceKillAndClear({ pid, pidPath, reason, log, platform, spawnSyncImpl, isProcessAliveImpl, childExitedRef }) {
  if (childExitedRef && childExitedRef.exited) return true;
  forceKillProcessTreeSync(pid, { platform, spawnSyncImpl });
  const exited = verifyProcessExitedSync(pid, { isProcessAliveImpl });
  if (exited) {
    clearOwnedPidFile(pidPath, pid);
    return true;
  }
  log('WARN', 'ninfer.server.force_kill_unconfirmed', { pid: Number(pid) || 0, reason, retained: true });
  return false;
}

async function launchOnce(spec, deps) {
  const {
    binaryPath, artifactPath, userDataPath, port, modelId, contextSize, mtp, vision, draftTokens, lmHeadDraft,
    hostKvMib, hostStateSlots, kvDtype, apiKey, runtimeVersion,
  } = spec;
  const {
    log, platform, spawnImpl, spawnSyncImpl, isProcessAliveImpl, fetchImpl, abortSignal, onExit,
    readinessTimeoutMs, readinessPollIntervalMs,
  } = deps;
  const pidPath = getPidFilePath(userDataPath, NINFER_PID_FILENAME);
  const args = buildNinferLaunchArgs({
    artifactPath, port, modelId, contextSize, hostKvMib, hostStateSlots, mtp, vision, draftTokens, lmHeadDraft, kvDtype, apiKey,
  });
  log('INFO', 'ninfer.server.spawn', {
    runtime: runtimeVersion || 'unknown', port, contextSize, mtp: Boolean(mtp),
    vision, draftTokens: mtp ? draftTokens : 0, lmHeadDraft: Boolean(mtp && lmHeadDraft), kvDtype: kvDtype || 'bf16', hostKvMib,
    hostStateSlots: hostStateSlots === null ? 'default' : hostStateSlots,
  });
  const child = spawnImpl(binaryPath, args, {
    cwd: path.dirname(binaryPath),
    detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: sanitizeSpawnEnv(process.env),
  });
  if (child.pid) {
    writePidFile(pidPath, child.pid, { command: buildPidRecordCommand(binaryPath, argsWithoutApiKey(args)) });
  }
  let pinnedMemoryFailure = false;
  let inspectedLines = 0;
  const redact = folderRedactor([
    [path.dirname(binaryPath), '[ninfer folder]'],
    [path.dirname(artifactPath), '[model folder]'],
  ], platform);
  pipeChildLogs(child, {
    logger: (level, event, details) => log(level, event, typeof details?.line === 'string'
      ? { ...details, line: redact(details.line) }
      : details),
    prefix: 'ninfer.server',
    resolveLevel: resolveOutputLevel,
    onOutput: ({ stream, line }) => {
      if (stream !== 'stderr' || pinnedMemoryFailure || inspectedLines >= MAX_INSPECTED_STDERR_LINES) return;
      inspectedLines += 1;
      if (PINNED_MEMORY_FAILURE.test(line)) pinnedMemoryFailure = true;
    },
  });
  const childExitedRef = { exited: false };
  // `stopped` records the request (for exit logging); `settled` only once the
  // exit is confirmed, so an unconfirmed force-kill stays retryable.
  const stopState = { stopped: false, settled: false };
  child.on('exit', (code, signal) => {
    childExitedRef.exited = true;
    clearOwnedPidFile(pidPath, child.pid);
    log(code === 0 || stopState.stopped ? 'INFO' : 'WARN', 'ninfer.server.exited', {
      pid: child.pid || 0, code, signal: String(signal || ''), requested: stopState.stopped,
    });
    if (typeof onExit === 'function') {
      try { onExit({ pid: child.pid || 0, code, signal: String(signal || '') }); } catch (_error) { /* observer */ }
    }
  });
  child.on('error', (error) => {
    childExitedRef.exited = true;
    log('ERROR', 'ninfer.server.spawn_error', { code: String(error && error.code || 'spawn_failed') });
  });

  const healthUrl = `http://${NINFER_HOST}:${port}/health`;
  const killArgs = { pidPath, log, platform, spawnSyncImpl, isProcessAliveImpl, childExitedRef };
  let ready;
  try {
    ready = await waitForNinferHealth({
      healthUrl, apiKey, timeoutMs: readinessTimeoutMs, pollIntervalMs: readinessPollIntervalMs,
      abortSignal, childExitedRef, fetchImpl,
    });
  } catch (error) {
    log('WARN', 'ninfer.server.readiness_failed', { reason: String(error.reason || error.message) });
    const killConfirmed = forceKillAndClear({ pid: child.pid, reason: 'readiness_failed', ...killArgs });
    if (!killConfirmed) error.cleanupUnconfirmed = true;
    if (error.reason === 'child_exited_before_ready') {
      if (!pinnedMemoryFailure) await stderrSettled(child, STDERR_SETTLE_TIMEOUT_MS);
      if (pinnedMemoryFailure) error.pinnedMemory = true;
    }
    throw error;
  }
  if (!ready) {
    log('WARN', 'ninfer.server.readiness_timeout', { pid: child.pid || 0, port, timeoutMs: readinessTimeoutMs });
    const killConfirmed = forceKillAndClear({ pid: child.pid, reason: 'readiness_timeout', ...killArgs });
    throw lifecycleError('ninfer_readiness_timeout', killConfirmed ? {} : { cleanupUnconfirmed: true });
  }
  log('INFO', 'ninfer.server.ready', { pid: child.pid || 0, port });

  async function stop({ timeoutMs = DEFAULT_GRACEFUL_STOP_TIMEOUT_MS } = {}) {
    if (stopState.settled) return { confirmed: true };
    stopState.stopped = true;
    if (childExitedRef.exited || !child.pid) {
      clearOwnedPidFile(pidPath, child.pid);
      stopState.settled = true;
      return { confirmed: true };
    }
    const pid = child.pid;
    try { child.kill(); } catch (_error) { /* already exited */ }
    const deadline = Date.now() + Math.max(Number(timeoutMs) || DEFAULT_GRACEFUL_STOP_TIMEOUT_MS, 500);
    while (Date.now() < deadline) {
      if (childExitedRef.exited || !isProcessAliveImpl(pid)) {
        clearOwnedPidFile(pidPath, pid);
        stopState.settled = true;
        return { confirmed: true };
      }
      await wait(100);
    }
    const confirmed = forceKillAndClear({ pid, reason: 'stop_timeout', ...killArgs });
    stopState.settled = confirmed;
    return { confirmed };
  }

  function stopSync() {
    if (stopState.settled) return;
    stopState.stopped = true;
    if (!child.pid || childExitedRef.exited) {
      clearOwnedPidFile(pidPath, child.pid);
      stopState.settled = true;
      return;
    }
    stopState.settled = forceKillAndClear({ pid: child.pid, reason: 'stop_sync', ...killArgs, childExitedRef: null });
  }

  return {
    pid: child.pid || 0,
    baseUrl: `http://${NINFER_HOST}:${port}/v1`,
    port,
    apiKey,
    modelId,
    contextSize,
    mtp: Boolean(mtp),
    vision,
    hostKvMib,
    hostStateSlots,
    reused: false,
    stop,
    stopSync,
  };
}

async function startNinferServer({
  binaryPath,
  artifactPath,
  userDataPath = '',
  runtimeVersion = '',
  port = DEFAULT_NINFER_PORT,
  modelId,
  contextSize = DEFAULT_CONTEXT_SIZE,
  mtp = true,
  vision = true,
  draftTokens = DEFAULT_DRAFT_TOKENS,
  lmHeadDraft = DEFAULT_LM_HEAD_DRAFT,
  kvDtype = '',
  readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  readinessPollIntervalMs = DEFAULT_READINESS_POLL_INTERVAL_MS,
  portReleaseTimeoutMs = DEFAULT_PORT_RELEASE_TIMEOUT_MS,
  abortSignal = null,
  onExit = null,
  // Identity restore (chat-gpu-handoff): relaunch with the key the parked
  // chat turn still sends.
  retainedApiKey = '',
  logger,
  platform = process.platform,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
  isProcessAliveImpl = isProcessAlive,
  fetchImpl = globalThis.fetch,
  freeMemoryMib = os.freemem() / (1024 * 1024),
} = {}) {
  const log = normalizeLogger(logger);
  if (retainedApiKey && !API_KEY_PATTERN.test(String(retainedApiKey))) throw lifecycleError('ninfer_retained_key_invalid');
  if (abortSignal && abortSignal.aborted) throw lifecycleError('readiness_aborted');
  if (!userDataPath) throw lifecycleError('ninfer_user_data_path_required');
  if (typeof binaryPath !== 'string' || !binaryPath) throw lifecycleError('ninfer_binary_not_found');
  if (typeof artifactPath !== 'string' || !artifactPath) throw lifecycleError('ninfer_artifact_not_found');
  // Validate the argv shape before touching the port or the PID record.
  buildNinferLaunchArgs({ artifactPath, port, modelId, contextSize, hostKvMib: 0, mtp, vision, draftTokens, lmHeadDraft, kvDtype });

  // Our own recorded orphan (a main process that died while its server lived
  // on) is reaped first, identity-checked, so it cannot hold the port against
  // every later launch; anything still listening after that is refused.
  const reap = reapStalePidFile({
    userDataPath, pidFileName: NINFER_PID_FILENAME, platform, spawnSyncImpl, isProcessAliveImpl,
    logger: (level, event, details) => log(level, String(event).replace(/^llama\.server\./, 'ninfer.server.'), details),
  });
  if (reap && reap.retained === true) {
    log('WARN', 'ninfer.server.orphan_cleanup_unconfirmed', { pid: reap.pid });
    throw lifecycleError('ninfer_orphan_cleanup_unconfirmed', { cleanupUnconfirmed: true });
  }
  const releaseMs = Math.max(0, Number(portReleaseTimeoutMs) || 0);
  if (await isPortOpen(port, NINFER_HOST) && !(releaseMs > 0 && await waitForPortToClose(port, NINFER_HOST, releaseMs))) {
    log('WARN', 'ninfer.server.port_busy', { port });
    throw lifecycleError('ninfer_port_busy');
  }

  const apiKey = retainedApiKey || crypto.randomBytes(16).toString('hex');
  const deps = {
    log, platform, spawnImpl, spawnSyncImpl, isProcessAliveImpl, fetchImpl, abortSignal, onExit,
    readinessTimeoutMs, readinessPollIntervalMs,
  };
  const base = {
    binaryPath, artifactPath, userDataPath, port, modelId, contextSize, mtp, vision, draftTokens, lmHeadDraft, kvDtype, apiKey, runtimeVersion,
  };
  const hostKvMib = computeHostKvMib(freeMemoryMib);
  try {
    return await launchOnce({ ...base, hostKvMib, hostStateSlots: null }, deps);
  } catch (error) {
    if (error.pinnedMemory !== true) throw error;
    log('WARN', 'ninfer.server.pinned_memory_retry', { hostKvMib });
  }
  try {
    return await launchOnce({ ...base, hostKvMib: 0, hostStateSlots: 0 }, deps);
  } catch (error) {
    if (error.pinnedMemory !== true) throw error;
    // C9: "NInfer couldn't reserve {gb} GB of system memory."
    const pinnedGb = Math.round((hostKvMib / 1024 + HOST_STATE_GIB_ESTIMATE) * 10) / 10;
    throw lifecycleError('ninfer_host_memory', { pinnedGb, cause: error });
  }
}

module.exports = {
  DEFAULT_CONTEXT_SIZE,
  DEFAULT_DRAFT_TOKENS,
  DEFAULT_LM_HEAD_DRAFT,
  DEFAULT_GRACEFUL_STOP_TIMEOUT_MS,
  DEFAULT_NINFER_PORT,
  DEFAULT_PORT_RELEASE_TIMEOUT_MS,
  DEFAULT_READINESS_POLL_INTERVAL_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  HOST_KV_CAP_MIB,
  HOST_RESERVE_MIB,
  NINFER_HOST,
  NINFER_PID_FILENAME,
  buildNinferLaunchArgs,
  computeHostKvMib,
  startNinferServer,
  waitForNinferHealth,
};
