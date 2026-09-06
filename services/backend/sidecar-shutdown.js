const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { buildSandboxLayout } = require('./path-utils');
const {
  getProcessCommandLineSync,
  isProcessAlive,
  processCommandMatchesStored,
} = require('./process-utils');

function normalizeLogger(logger) {
  return typeof logger === 'function' ? logger : () => {};
}

function getManagedSidecarStatePath(userDataPath) {
  if (!userDataPath) {
    return '';
  }
  return buildSandboxLayout(path.join(userDataPath, 'backend-sidecar')).stateFilePath;
}

function readManagedSidecarState(userDataPath) {
  const statePath = getManagedSidecarStatePath(userDataPath);
  if (!statePath) {
    return null;
  }
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function clearManagedSidecarState(userDataPath) {
  const statePath = getManagedSidecarStatePath(userDataPath);
  if (!statePath) {
    return;
  }
  try {
    fs.unlinkSync(statePath);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function forceKillProcessTreeSync(pid, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { status: 0 };
  }
  if (platform === 'win32') {
    return spawnSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 2000,
    });
  }
  process.kill(pid, 'SIGKILL');
  return { status: 0 };
}

function syncSleepMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function verifyProcessExitedSync(pid, {
  isProcessAliveImpl = isProcessAlive,
  maxRetries = 3,
  retryDelayMs = 100,
} = {}) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (!isProcessAliveImpl(pid)) {
      return true;
    }
    if (attempt < maxRetries) {
      syncSleepMs(retryDelayMs);
    }
  }
  return !isProcessAliveImpl(pid);
}

function shutdownManagedSidecarSync({
  userDataPath,
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  logger,
  isProcessAliveImpl = isProcessAlive,
  getProcessCommandLineSyncImpl = getProcessCommandLineSync,
  nowImpl = Date.now,
} = {}) {
  const log = normalizeLogger(logger);
  const startedAt = nowImpl();
  const state = readManagedSidecarState(userDataPath);
  const pid = Number(state && state.pid);
  let killResult = null;
  let killError = null;

  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      clearManagedSidecarState(userDataPath);
    } catch (error) {
      log('WARN', 'sidecar.state_clear_failed', {
        message: String(error && error.message || error),
      });
    }
    return { hadState: false, killed: false, pid: 0 };
  }

  if (!isProcessAliveImpl(pid)) {
    try {
      clearManagedSidecarState(userDataPath);
    } catch (error) {
      log('WARN', 'sidecar.state_clear_failed', {
        pid,
        message: String(error && error.message || error),
      });
    }
    log('INFO', 'sidecar.stale_state_cleared', { pid });
    return { hadState: true, killed: false, pid };
  }

  let liveCommandLine = '';
  try {
    liveCommandLine = getProcessCommandLineSyncImpl(pid, { platform });
  } catch (_error) { /* identity remains unconfirmed */ }
  if (!processCommandMatchesStored(liveCommandLine, state?.command)) {
    log('WARN', 'sidecar.force_kill_identity_unconfirmed', {
      pid,
      status: 'skipped',
    });
    return {
      hadState: true,
      killed: false,
      pid,
      skipped: 'identity_unconfirmed',
    };
  }

  log('INFO', 'sidecar.force_kill', { pid });
  try {
    killResult = forceKillProcessTreeSync(pid, {
      platform,
      spawnSyncImpl,
    });
    if (killResult && killResult.error) {
      throw killResult.error;
    }
  } catch (error) {
    killError = error;
  }

  const killed = verifyProcessExitedSync(pid, {
    isProcessAliveImpl,
  });
  if (killed) {
    try {
      clearManagedSidecarState(userDataPath);
    } catch (error) {
      log('WARN', 'sidecar.state_clear_failed', {
        pid,
        message: String(error && error.message || error),
      });
    }
  }
  if (!killed) {
    log('WARN', 'sidecar.force_kill_failed', {
      pid,
      status: typeof killResult?.status === 'number' ? killResult.status : null,
      message: String(killError && killError.message || '').trim(),
    });
  }
  log(killed ? 'INFO' : 'WARN', 'sidecar.force_kill_complete', {
    pid,
    status: killed ? 'ok' : 'unconfirmed',
    durationMs: Math.max(nowImpl() - startedAt, 0),
    forced: true,
    confirmed: killed,
  });

  return { hadState: true, killed, pid };
}

module.exports = {
  forceKillProcessTreeSync,
  getManagedSidecarStatePath,
  shutdownManagedSidecarSync,
  verifyProcessExitedSync,
};
