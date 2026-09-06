// The recorded spawn command protects against recycled PIDs.
// PID state is cleared only after confirmed exit.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { forceKillProcessTreeSync, verifyProcessExitedSync } = require('./backend/sidecar-shutdown');
const {
  getProcessCommandLineSync,
  isProcessAlive,
  processCommandMatchesStored,
} = require('./backend/process-utils');

const PID_FILENAME = 'llama-server.pid';

function normalizeLogger(logger) {
  return typeof logger === 'function' ? logger : () => {};
}

function getPidFilePath(userDataPath) {
  if (!userDataPath) {
    return '';
  }
  return path.join(userDataPath, PID_FILENAME);
}

// F2c: persist the spawn command line alongside the pid. Without it, a reaper
// reading this file back has no way to tell our llama-server from whatever
// unrelated process the OS later recycled that pid onto.
function buildPidRecordCommand(binaryPath, args) {
  const binary = String(binaryPath || '').trim();
  if (!binary) {
    return '';
  }
  const argv = Array.isArray(args)
    ? args.map((value) => String(value == null ? '' : value)).filter(Boolean)
    : [];
  return argv.length ? `${binary} ${argv.join(' ')}` : binary;
}

function writePidFile(pidPath, pid, { command = '' } = {}) {
  if (!pidPath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, JSON.stringify({
      pid,
      command: String(command || ''),
      startedAt: new Date().toISOString(),
    }), 'utf8');
  } catch (_error) {
    // best effort only — a missing pidfile still works, the parent-child link
    // handles most shutdowns; pidfile is the belt-and-braces reaper.
  }
}

function clearPidFile(pidPath) {
  if (!pidPath) {
    return;
  }
  try {
    fs.unlinkSync(pidPath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      // swallow — cleanup is best effort
    }
  }
}

// Returns the whole record: { pid, command, startedAt }. A legacy file written
// before F2c holds only `pid`, which yields command:'' — identity is then
// unverifiable and the kill guards below refuse to act on it.
function readPidFile(pidPath, { fsImpl = fs } = {}) {
  const empty = { pid: 0, command: '', startedAt: '' };
  if (!pidPath) {
    return empty;
  }
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(pidPath, 'utf8'));
    const pid = Number(parsed && parsed.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      return empty;
    }
    return {
      pid,
      command: String((parsed && parsed.command) || '').trim(),
      startedAt: String((parsed && parsed.startedAt) || '').trim(),
    };
  } catch (_error) {
    return empty;
  }
}

// F2c guard, mirroring services/backend/sidecar-shutdown.js: refuse to kill
// unless the live command line still matches the command we recorded at spawn.
function llamaServerIdentityConfirmed(pid, record, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  getProcessCommandLineSyncImpl = getProcessCommandLineSync,
} = {}) {
  let commandLine;
  try {
    commandLine = getProcessCommandLineSyncImpl(pid, { platform, spawnSyncImpl });
  } catch (_error) {
    commandLine = '';
  }
  return processCommandMatchesStored(commandLine, record && record.command);
}

function reapStalePidFile({
  userDataPath,
  logger,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  isProcessAliveImpl = isProcessAlive,
  getProcessCommandLineSyncImpl = getProcessCommandLineSync,
} = {}) {
  const log = normalizeLogger(logger);
  const pidPath = getPidFilePath(userDataPath);
  const record = readPidFile(pidPath);
  const pid = record.pid;
  if (!pid) {
    clearPidFile(pidPath);
    return { reaped: false, pid: 0 };
  }
  if (!isProcessAliveImpl(pid)) {
    clearPidFile(pidPath);
    log('INFO', 'llama.server.stale_pid_cleared', { pid });
    return { reaped: false, pid };
  }
  if (!llamaServerIdentityConfirmed(pid, record, {
    platform, spawnSyncImpl, getProcessCommandLineSyncImpl,
  })) {
    // F2c: that pid is alive but is not the server we recorded — most likely
    // the OS recycled it. Drop the record instead of killing a stranger.
    log('WARN', 'llama.server.force_kill_identity_unconfirmed', {
      pid,
      status: 'skipped',
      phase: 'reap',
    });
    clearPidFile(pidPath);
    return { reaped: false, pid, skipped: 'identity_unconfirmed' };
  }
  log('INFO', 'llama.server.reaping_orphan', { pid });
  forceKillProcessTreeSync(pid, { platform, spawnSyncImpl });
  const exited = verifyProcessExitedSync(pid, { isProcessAliveImpl });
  if (!exited) {
    // F2d: retain the record so the NEXT launch can retry the reap.
    log('WARN', 'llama.server.orphan_kill_unverified', { pid, retained: true });
    return { reaped: true, pid, killed: false, retained: true };
  }
  clearPidFile(pidPath);
  return { reaped: true, pid, killed: true };
}

function shutdownLlamaServerSync({
  userDataPath,
  logger,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  isProcessAliveImpl = isProcessAlive,
  getProcessCommandLineSyncImpl = getProcessCommandLineSync,
} = {}) {
  const log = normalizeLogger(logger);
  const pidPath = getPidFilePath(userDataPath);
  const record = readPidFile(pidPath);
  const pid = record.pid;
  if (!pid) {
    clearPidFile(pidPath);
    return { hadState: false, killed: false, pid: 0 };
  }
  if (!isProcessAliveImpl(pid)) {
    clearPidFile(pidPath);
    return { hadState: true, killed: false, pid };
  }
  if (!llamaServerIdentityConfirmed(pid, record, {
    platform, spawnSyncImpl, getProcessCommandLineSyncImpl,
  })) {
    log('WARN', 'llama.server.force_kill_identity_unconfirmed', {
      pid,
      status: 'skipped',
      phase: 'shutdown',
    });
    clearPidFile(pidPath);
    return { hadState: true, killed: false, pid, skipped: 'identity_unconfirmed' };
  }
  log('INFO', 'llama.server.force_kill', { pid });
  forceKillProcessTreeSync(pid, { platform, spawnSyncImpl });
  const killed = verifyProcessExitedSync(pid, { isProcessAliveImpl });
  if (!killed) {
    // F2d: kill -> verify -> clear ONLY on a confirmed exit. Retaining the
    // record lets the next launch's reapStalePidFile retry the kill.
    log('WARN', 'llama.server.force_kill_failed', { pid, retained: true });
    return { hadState: true, killed: false, pid, retained: true };
  }
  clearPidFile(pidPath);
  return { hadState: true, killed: true, pid };
}

module.exports = {
  PID_FILENAME,
  buildPidRecordCommand,
  clearPidFile,
  getPidFilePath,
  llamaServerIdentityConfirmed,
  readPidFile,
  reapStalePidFile,
  shutdownLlamaServerSync,
  writePidFile,
};
