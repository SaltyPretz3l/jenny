'use strict';

// Spawns and supervises ONE managed Strata server (row 200 S2 step 4). The
// manager (services/main/strata-manager.js) owns the state machine; this module
// launches the owner's own Strata Terminal Python on loopback and hands back a
// handle, the way services/ninfer-lifecycle.js does for NInfer.
//
// Security boundary, fixed here and tested in tests/strata-lifecycle.test.js:
// - The server binds 127.0.0.1 only, with `--offline`. Never `--lazy`,
//   `--idle-unload`, `--access`, `--no-api-key` or another host.
// - The engine config Jenny writes (services/strata-config.js) holds no key.
//   Each launch gets a fresh key, passed LAST on the argv as `--api-key KEY`;
//   the PID record is the argv without it, the argv is never logged, and every
//   logged server line has the key and the owner's folders replaced.
// - The child environment drops every STRATA_* and PYTHON* variable (plan F26)
//   and sets only PYTHONUTF8 and PYTHONNOUSERSITE.
// - Ready only when Strata's ready file (under userData, fresh per launch,
//   never a link) names the child's PID and `/health` says `loaded: true`.
//   A stale ready file makes the server exit 2 (F21), so old ones are removed
//   before each start, and this launch's is removed when the child exits.
// - A busy port is refused, never adopted.
// - Stop: a best-effort `POST /unload?wait=1`, then kill, then a tree kill of
//   the owned PID, then a check that the engine process (found under the
//   server at readiness) is gone too. The record clears only when both are.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const { pipeChildLogs } = require('./backend/child-process-logging');
const { spawnOffMainThread } = require('./ninfer-spawn-worker');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');
const { forceKillProcessTreeSync, verifyProcessExitedSync } = require('./backend/sidecar-shutdown');
const {
  getProcessCommandLineSync, isPortOpen, isProcessAlive, processCommandMatchesStored, wait, waitForPortToClose,
} = require('./backend/process-utils');
const { writeJsonAtomicAsync } = require('./backend/session-storage-fs-utils');
const { ENGINE_ACTIVITY_THROTTLE_MS } = require('./backend/engine-activity-lines');
const { requestWithTimeout } = require('./http-fetch-util');
const {
  buildPidRecordCommand, clearOwnedPidFile, getPidFilePath, reapStalePidFile, writePidFile,
} = require('./llama-server-pidfile');
const { normalizeLogger } = require('./llama-server-readiness');

const STRATA_PID_FILENAME = 'strata-serve.pid';
const STRATA_HOST = '127.0.0.1';
const DEFAULT_STRATA_PORT = 8035;
const { STRATA_SLOTS } = require('./strata-settings');
// Upstream's first load can take minutes (S0b: 15-23 s warm); shown as loading.
const DEFAULT_READINESS_TIMEOUT_MS = 600_000;
const DEFAULT_READINESS_POLL_INTERVAL_MS = 500;
const DEFAULT_GRACEFUL_STOP_TIMEOUT_MS = 5_000;
const DEFAULT_PORT_RELEASE_TIMEOUT_MS = 5_000;
const UNLOAD_TIMEOUT_MS = 5_000;
const EARLY_EXIT_SETTLE_MS = 250;
const MAX_READY_FILE_BYTES = 64 * 1024;
const API_KEY_PATTERN = /^[0-9a-f]{32}$/;
const READY_FILE_PATTERN = /^ready-[0-9a-f]{16}\.json$/;
const FORBIDDEN_ARGS = Object.freeze(['--lazy', '--idle-unload', '--access', '--no-api-key', '0.0.0.0', '--open']);
// The server's own progress lines (S0b recordings): loading, prefill, decode.
const ACTIVITY_LINE = /^\[strata\] (reading the prompt|thinking|answering|starting the engine|loading the model|the engine is running)/;
const WINDOWS_BLOCKED = /Windows blocked the Strata engine/i;

function lifecycleError(reason, extra = {}) {
  return Object.assign(new Error(reason), { reason, ...extra });
}

function runDir(userDataPath) {
  return path.join(userDataPath, 'strata', 'run');
}

// The exact argv after the interpreter; the key pair is always last so the PID
// record can be the argv without it (the identity matcher is a substring test).
function buildStrataLaunchArgs({ configPath, readyPath, port = DEFAULT_STRATA_PORT, slots = 4, apiKey = '' } = {}) {
  if (typeof configPath !== 'string' || !path.isAbsolute(configPath)) throw lifecycleError('strata_config_path_invalid');
  if (typeof readyPath !== 'string' || !path.isAbsolute(readyPath)) throw lifecycleError('strata_ready_path_invalid');
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw lifecycleError('strata_port_invalid');
  if (!STRATA_SLOTS.includes(slots)) throw lifecycleError('strata_slots_invalid');
  if (apiKey && !API_KEY_PATTERN.test(apiKey)) throw lifecycleError('strata_api_key_invalid');
  const args = [
    '-m', 'serve.server',
    '--engine', 'strata',
    '--config', configPath,
    '--host', STRATA_HOST,
    '--port', String(port),
    '--parallel', String(slots),
    '--offline',
    '--ready-file', readyPath,
  ];
  if (args.some((arg) => FORBIDDEN_ARGS.includes(String(arg).toLowerCase()))) throw lifecycleError('strata_forbidden_arg');
  if (apiKey) args.push('--api-key', apiKey);
  return args;
}

function argsWithoutApiKey(args) {
  const index = args.indexOf('--api-key');
  return index === -1 ? args.slice() : args.slice(0, index);
}

function buildChildEnv(sourceEnv = process.env) {
  const env = sanitizeSpawnEnv(sourceEnv, { extraDeny: [/^STRATA_/i, /^PYTHON/i] });
  env.PYTHONUTF8 = '1';
  env.PYTHONNOUSERSITE = '1';
  return env;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Logged lines carry tokens instead of the key and the owner's folders (both
// often sit under the user's name). Case-insensitive on win32, either separator.
function lineRedactor({ apiKey, folders, platform }) {
  const patterns = [];
  for (const [folder, token] of folders) {
    const parts = String(folder || '').replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
    if (!parts.some((part) => !/^[A-Za-z]:$/.test(part))) continue;
    patterns.push([new RegExp(parts.map(escapeRegExp).join('[\\\\/]+'), platform === 'win32' ? 'gi' : 'g'), token]);
  }
  if (apiKey) patterns.unshift([new RegExp(escapeRegExp(apiKey), 'g'), '[key]']);
  return (line) => patterns.reduce((text, [pattern, token]) => text.replace(pattern, token), line);
}

function resolveOutputLevel({ line }) {
  return /\b(error|critical|failed|exception|traceback|blocked)\b/i.test(line) ? 'WARN' : 'INFO';
}

function createActivityForwarder(onEngineActivity, now = () => performance.now()) {
  if (typeof onEngineActivity !== 'function') return () => {};
  let last = 0;
  return (line) => {
    if (!ACTIVITY_LINE.test(line)) return;
    const at = now();
    if (last && at - last < ENGINE_ACTIVITY_THROTTLE_MS) return;
    last = at;
    try { onEngineActivity(); } catch (_error) { /* best-effort */ }
  };
}

// Old ready files from earlier launches (a killed server leaves its own). unlink
// never follows a link, so a planted link is removed, not its target.
async function removeStaleReadyFiles(dir, fsImpl) {
  let names;
  try { names = await fsImpl.promises.readdir(dir); } catch (_error) { return; }
  for (const name of names) {
    if (!READY_FILE_PATTERN.test(name)) continue;
    try { await fsImpl.promises.unlink(path.join(dir, name)); } catch (_error) { /* best-effort */ }
  }
}

function removeReadyFileSync(readyPath, fsImpl) {
  try { fsImpl.unlinkSync(readyPath); } catch (_error) { /* gone or never written */ }
}

// null while absent or half-written; throws when the path is a link or not a
// small regular file.
async function readReadyFile(readyPath, fsImpl) {
  let stat;
  try { stat = await fsImpl.promises.lstat(readyPath); } catch (_error) { return null; }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_READY_FILE_BYTES) {
    throw lifecycleError('strata_ready_file_refused');
  }
  try {
    const parsed = JSON.parse(await fsImpl.promises.readFile(readyPath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function listChildProcesses(pid, { platform = process.platform, execFileImpl = execFile } = {}) {
  const parent = Number(pid);
  if (platform !== 'win32' || !Number.isInteger(parent) || parent <= 0) return Promise.resolve([]);
  const script = `Get-CimInstance Win32_Process -Filter "ParentProcessId=${parent}" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`;
  return new Promise((resolve) => {
    execFileImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true, timeout: 5_000, encoding: 'utf8',
    }, (error, stdout) => {
      if (error) { resolve([]); return; }
      resolve(String(stdout || '').split(/\r?\n/).map((line) => {
        const at = line.indexOf('|');
        return at > 0 ? { pid: Number(line.slice(0, at)), commandLine: line.slice(at + 1) } : null;
      }).filter((row) => row && Number.isInteger(row.pid) && row.pid > 0));
    });
  });
}

async function findEnginePid(serverPid, engineExe, listChildren) {
  try {
    const rows = await listChildren(serverPid);
    const match = rows.find((row) => processCommandMatchesStored(row.commandLine, engineExe));
    return match ? match.pid : 0;
  } catch (_error) {
    return 0;
  }
}

// The engine is ours only while its live command line still names the engine
// binary (a recycled PID is someone else's and is left alone).
function engineGoneSync(enginePid, engineExe, deps) {
  if (!enginePid || !deps.isProcessAliveImpl(enginePid)) return true;
  const commandLine = getProcessCommandLineSync(enginePid, { platform: deps.platform, spawnSyncImpl: deps.spawnSyncImpl });
  // Unreadable: gone only if it has exited since. A different command line: a
  // recycled PID, not ours.
  if (!commandLine) return !deps.isProcessAliveImpl(enginePid);
  if (!processCommandMatchesStored(commandLine, engineExe)) return true;
  forceKillProcessTreeSync(enginePid, { platform: deps.platform, spawnSyncImpl: deps.spawnSyncImpl });
  return verifyProcessExitedSync(enginePid, { isProcessAliveImpl: deps.isProcessAliveImpl });
}

function serverGoneSync(pid, deps, childExitedRef) {
  if (childExitedRef && childExitedRef.exited) return true;
  forceKillProcessTreeSync(pid, { platform: deps.platform, spawnSyncImpl: deps.spawnSyncImpl });
  return verifyProcessExitedSync(pid, { isProcessAliveImpl: deps.isProcessAliveImpl });
}

async function unloadBestEffort({ port, apiKey, fetchImpl }) {
  if (typeof fetchImpl !== 'function') return;
  try {
    await fetchImpl(`http://${STRATA_HOST}:${port}/unload?wait=1`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(UNLOAD_TIMEOUT_MS),
    });
  } catch (_error) { /* best effort: the kill follows */ }
}

async function waitForStrataReady({ readyPath, childPid, port, apiKey, deps, childExitedRef }) {
  const { abortSignal, fetchImpl, fsImpl, readinessTimeoutMs, readinessPollIntervalMs } = deps;
  const deadline = Date.now() + readinessTimeoutMs;
  const check = () => {
    if (abortSignal && abortSignal.aborted) throw lifecycleError('readiness_aborted');
    if (childExitedRef.exited) throw lifecycleError('child_exited_before_ready');
  };
  while (Date.now() < deadline) {
    check();
    const ready = await readReadyFile(readyPath, fsImpl);
    check();
    if (ready) {
      if (ready.pid !== childPid) throw lifecycleError('strata_ready_pid_mismatch');
      if (ready.bound_port !== undefined && ready.bound_port !== port) throw lifecycleError('strata_ready_port_mismatch');
      const health = await readHealth({ port, apiKey, fetchImpl });
      check();
      if (health && health.loaded === true) return { ready, health };
    }
    await wait(readinessPollIntervalMs);
  }
  return null;
}

async function readHealth({ port, apiKey, fetchImpl }) {
  try {
    const response = await requestWithTimeout(`http://${STRATA_HOST}:${port}/health`, {
      headers: { Authorization: `Bearer ${apiKey}` }, timeoutMs: 1_500, fetchImpl,
    });
    return response && response.ok === true ? await response.json() : null;
  } catch (_error) {
    return null;
  }
}

function spawnChild({ install, args, deps }) {
  return deps.spawnImpl(install.pythonExe, args, {
    cwd: install.terminalDir,
    detached: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: buildChildEnv(deps.env),
  });
}

function watchOutput(child, { apiKey, install, userDataPath, deps, outputState }) {
  const redact = lineRedactor({
    apiKey,
    folders: [[install.terminalDir, '[strata terminal]'], [install.root, '[strata folder]'], [userDataPath, '[jenny data]']],
    platform: deps.platform,
  });
  const forwardActivity = createActivityForwarder(deps.onEngineActivity);
  pipeChildLogs(child, {
    logger: (level, event, details) => deps.log(level, event, typeof details?.line === 'string'
      ? { ...details, line: redact(details.line) }
      : details),
    prefix: 'strata.server',
    resolveLevel: resolveOutputLevel,
    onOutput: ({ line }) => {
      if (WINDOWS_BLOCKED.test(line)) outputState.blockedByWindows = true;
      forwardActivity(line);
    },
  });
}

function failureReason(error, outputState) {
  if (outputState.blockedByWindows) return 'strata_blocked_by_windows';
  if (error.reason === 'child_exited_before_ready' && outputState.exitCode !== null) {
    return `strata_exited:${outputState.exitCode}`;
  }
  return error.reason || 'strata_start_failed';
}

async function launch(spec, deps) {
  const { install, engineExe, configPath, readyPath, userDataPath, port, slots, apiKey } = spec;
  const { log, onExit } = deps;
  const pidPath = getPidFilePath(userDataPath, STRATA_PID_FILENAME);
  const args = buildStrataLaunchArgs({ configPath, readyPath, port, slots, apiKey });
  log('INFO', 'strata.server.spawn', { version: install.version || 'unknown', port, slots });
  const child = await spawnChild({ install, args, deps });
  if (child.pid) {
    writePidFile(pidPath, child.pid, { command: buildPidRecordCommand(install.pythonExe, argsWithoutApiKey(args)) });
  }
  const outputState = { blockedByWindows: false, exitCode: null };
  watchOutput(child, { apiKey, install, userDataPath, deps, outputState });
  const childExitedRef = { exited: false };
  const stopState = { stopped: false, settled: false };
  let enginePid = 0;
  child.on('exit', (code, signal) => {
    childExitedRef.exited = true;
    outputState.exitCode = Number.isInteger(code) ? code : null;
    clearOwnedPidFile(pidPath, child.pid);
    removeReadyFileSync(readyPath, deps.fsImpl);
    log(code === 0 || stopState.stopped ? 'INFO' : 'WARN', 'strata.server.exited', {
      pid: child.pid || 0, code, signal: String(signal || ''), requested: stopState.stopped,
    });
    if (typeof onExit === 'function') {
      try { onExit({ pid: child.pid || 0, code, signal: String(signal || '') }); } catch (_error) { /* observer */ }
    }
  });
  child.on('error', (error) => {
    childExitedRef.exited = true;
    log('ERROR', 'strata.server.spawn_error', { code: String(error && error.code || 'spawn_failed') });
  });

  const killAll = (reason, exitedRef = childExitedRef) => {
    const serverGone = serverGoneSync(child.pid, deps, exitedRef);
    const engineGone = engineGoneSync(enginePid, engineExe, deps);
    if (serverGone && engineGone) {
      clearOwnedPidFile(pidPath, child.pid);
      removeReadyFileSync(readyPath, deps.fsImpl);
      return true;
    }
    log('WARN', 'strata.server.force_kill_unconfirmed', { pid: child.pid || 0, engine: Boolean(enginePid), reason, retained: true });
    return false;
  };

  let result;
  try {
    result = await waitForStrataReady({ readyPath, childPid: child.pid, port, apiKey, deps, childExitedRef });
  } catch (error) {
    if (error.reason === 'child_exited_before_ready' && !outputState.blockedByWindows) await wait(EARLY_EXIT_SETTLE_MS);
    const reason = failureReason(error, outputState);
    log('WARN', 'strata.server.readiness_failed', { reason });
    const confirmed = killAll('readiness_failed');
    throw lifecycleError(reason, confirmed ? {} : { cleanupUnconfirmed: true });
  }
  if (!result) {
    log('WARN', 'strata.server.readiness_timeout', { pid: child.pid || 0, port, timeoutMs: deps.readinessTimeoutMs });
    const confirmed = killAll('readiness_timeout');
    throw lifecycleError('strata_readiness_timeout', confirmed ? {} : { cleanupUnconfirmed: true });
  }
  enginePid = await findEnginePid(child.pid, engineExe, deps.listChildrenImpl);
  log('INFO', 'strata.server.ready', { pid: child.pid || 0, port, engine: Boolean(enginePid) });

  async function stop({ timeoutMs = DEFAULT_GRACEFUL_STOP_TIMEOUT_MS } = {}) {
    if (stopState.settled) return { confirmed: true };
    stopState.stopped = true;
    if (!childExitedRef.exited && child.pid) {
      await unloadBestEffort({ port, apiKey, fetchImpl: deps.fetchImpl });
      if (!enginePid) enginePid = await findEnginePid(child.pid, engineExe, deps.listChildrenImpl);
      try { child.kill(); } catch (_error) { /* already exited */ }
      const deadline = Date.now() + Math.max(Number(timeoutMs) || DEFAULT_GRACEFUL_STOP_TIMEOUT_MS, 500);
      while (Date.now() < deadline && !childExitedRef.exited && deps.isProcessAliveImpl(child.pid)) {
        await wait(100);
      }
    }
    const exitedRef = childExitedRef.exited || !child.pid || !deps.isProcessAliveImpl(child.pid) ? { exited: true } : childExitedRef;
    const confirmed = killAll('stop', exitedRef);
    stopState.settled = confirmed;
    return { confirmed };
  }

  function stopSync() {
    if (stopState.settled) return;
    stopState.stopped = true;
    // Once the child has exited its PID may be recycled: only the engine check runs then (as NInfer's stopSync).
    stopState.settled = killAll('stop_sync', !child.pid ? { exited: true } : childExitedRef);
  }

  return {
    pid: child.pid || 0,
    baseUrl: `http://${STRATA_HOST}:${port}/v1`,
    port,
    apiKey,
    modelId: String(result.ready.model_id || result.health.model || ''),
    contextSize: Number.isInteger(result.health.max_context) ? result.health.max_context : 0,
    vision: result.health.images === true,
    slots,
    getEnginePid: () => enginePid,
    stop,
    stopSync,
  };
}

async function prepareLaunchFiles({ userDataPath, config, fsImpl }) {
  const dir = runDir(userDataPath);
  await fsImpl.promises.mkdir(dir, { recursive: true });
  await fsImpl.promises.mkdir(path.dirname(config.log), { recursive: true });
  await removeStaleReadyFiles(dir, fsImpl);
  const configPath = path.join(dir, 'strata-engine.json');
  await writeJsonAtomicAsync(configPath, config);
  const readyPath = path.join(dir, `ready-${crypto.randomBytes(8).toString('hex')}.json`);
  return { configPath, readyPath };
}

async function refuseBusyPort({ port, portReleaseTimeoutMs, log }) {
  const releaseMs = Math.max(0, Number(portReleaseTimeoutMs) || 0);
  if (await isPortOpen(port, STRATA_HOST) && !(releaseMs > 0 && await waitForPortToClose(port, STRATA_HOST, releaseMs))) {
    log('WARN', 'strata.server.port_busy', { port });
    throw lifecycleError('strata_port_busy');
  }
}

function validateStartInput({ install, config, userDataPath, retainedApiKey, abortSignal, slots, port }) {
  if (retainedApiKey && !API_KEY_PATTERN.test(String(retainedApiKey))) throw lifecycleError('strata_retained_key_invalid');
  if (abortSignal && abortSignal.aborted) throw lifecycleError('readiness_aborted');
  if (!userDataPath || !path.isAbsolute(userDataPath)) throw lifecycleError('strata_user_data_path_required');
  if (!install || !install.pythonExe || !install.terminalDir || !install.root) throw lifecycleError('strata_install_missing');
  if (!config || typeof config.exe !== 'string' || !path.isAbsolute(config.exe) || typeof config.log !== 'string') {
    throw lifecycleError('strata_config_missing');
  }
  // Shape check of the argv before touching the port, the PID record or files.
  buildStrataLaunchArgs({ configPath: path.join(userDataPath, 'c.json'), readyPath: path.join(userDataPath, 'r.json'), port, slots });
}

async function startStrataServer({
  install,
  config,
  userDataPath = '',
  port = DEFAULT_STRATA_PORT,
  slots = 4,
  readinessTimeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  readinessPollIntervalMs = DEFAULT_READINESS_POLL_INTERVAL_MS,
  portReleaseTimeoutMs = DEFAULT_PORT_RELEASE_TIMEOUT_MS,
  abortSignal = null,
  onExit = null,
  onEngineActivity = null,
  // Identity restore (chat-gpu-handoff): relaunch with the key the parked chat
  // turn still sends.
  retainedApiKey = '',
  logger,
  platform = process.platform,
  env = process.env,
  spawnImpl = spawnOffMainThread,
  spawnSyncImpl = spawnSync,
  isProcessAliveImpl = isProcessAlive,
  listChildrenImpl = (pid) => listChildProcesses(pid, { platform }),
  fetchImpl = globalThis.fetch,
  fsImpl = fs,
} = {}) {
  const log = normalizeLogger(logger);
  validateStartInput({ install, config, userDataPath, retainedApiKey, abortSignal, slots, port });
  // Our own recorded orphan (a Jenny that died while its server lived on) is
  // reaped first, identity-checked, so it cannot hold the port; anything still
  // listening after that is refused.
  const reap = reapStalePidFile({
    userDataPath, pidFileName: STRATA_PID_FILENAME, platform, spawnSyncImpl, isProcessAliveImpl,
    logger: (level, event, details) => log(level, String(event).replace(/^llama\.server\./, 'strata.server.'), details),
  });
  if (reap && reap.retained === true) {
    log('WARN', 'strata.server.orphan_cleanup_unconfirmed', { pid: reap.pid });
    throw lifecycleError('strata_orphan_cleanup_unconfirmed', { cleanupUnconfirmed: true });
  }
  await refuseBusyPort({ port, portReleaseTimeoutMs, log });
  const { configPath, readyPath } = await prepareLaunchFiles({ userDataPath, config, fsImpl });
  const apiKey = retainedApiKey || crypto.randomBytes(16).toString('hex');
  const deps = {
    log, platform, env, spawnImpl, spawnSyncImpl, isProcessAliveImpl, listChildrenImpl, fetchImpl, fsImpl,
    abortSignal, onExit, onEngineActivity, readinessTimeoutMs, readinessPollIntervalMs,
  };
  try {
    return await launch({ install, engineExe: config.exe, configPath, readyPath, userDataPath, port, slots, apiKey }, deps);
  } catch (error) {
    removeReadyFileSync(readyPath, fsImpl);
    throw error;
  }
}

// Boot-time reap (owner D8 A): a server this Jenny recorded and still owns,
// by that exact PID through the pidfile identity check, without a launch.
function reapRecordedStrataServer({ userDataPath, logger, platform = process.platform, spawnSyncImpl = spawnSync, isProcessAliveImpl = isProcessAlive } = {}) {
  if (!userDataPath) return { reaped: false };
  const log = normalizeLogger(logger);
  return reapStalePidFile({
    userDataPath, pidFileName: STRATA_PID_FILENAME, platform, spawnSyncImpl, isProcessAliveImpl,
    logger: (level, event, details) => log(level, String(event).replace(/^llama\.server\./, 'strata.server.'), details),
  }) || { reaped: false };
}

module.exports = {
  DEFAULT_GRACEFUL_STOP_TIMEOUT_MS,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_STRATA_PORT,
  STRATA_HOST,
  STRATA_PID_FILENAME,
  buildChildEnv,
  buildStrataLaunchArgs,
  listChildProcesses,
  reapRecordedStrataServer,
  startStrataServer,
};
