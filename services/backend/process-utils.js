const net = require('net');
const { spawn, spawnSync } = require('child_process');

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
    socket.connect(port, host);
  });
}

async function waitForPortToClose(port, host = '127.0.0.1', timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await isPortOpen(port, host);
    if (!open) {
      return true;
    }
    await wait(120);
  }
  return false;
}

function isProcessAlive(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return false;
  }

  try {
    process.kill(normalizedPid, 0);
    return true;
  } catch (error) {
    if (error && (error.code === 'ESRCH' || error.code === 'EINVAL')) {
      return false;
    }
    if (error && error.code === 'EPERM') {
      return true;
    }
    return false;
  }
}

// Best-effort command-line lookup for a live pid. Returns '' when the
// process is gone or the query fails — callers treat '' as "identity
// unknown" and must NOT kill on it.
async function getProcessCommandLine(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return '';
  }
  const run = (command, args) => new Promise((resolve) => {
    let output = '';
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
    });
    child.on('error', () => resolve(''));
    child.on('exit', () => resolve(output.trim()));
  });
  if (process.platform === 'win32') {
    return run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${normalizedPid}").CommandLine`,
    ]);
  }
  return run('ps', ['-p', String(normalizedPid), '-o', 'command=']);
}

function getProcessCommandLineSync(pid, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  timeoutMs = 500,
} = {}) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return '';
  }
  const command = platform === 'win32' ? 'powershell.exe' : 'ps';
  const args = platform === 'win32'
    ? [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${normalizedPid}").CommandLine`,
    ]
    : ['-p', String(normalizedPid), '-o', 'command='];
  try {
    const result = spawnSyncImpl(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: Math.min(Math.max(Number(timeoutMs) || 0, 1), 1000),
    });
    if (result?.error || (typeof result?.status === 'number' && result.status !== 0)) {
      return '';
    }
    return String(result?.stdout || '').trim();
  } catch (_error) {
    return '';
  }
}

function normalizeProcessCommandLine(value) {
  return String(value || '')
    .replace(/"/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function processCommandMatchesStored(commandLine, storedCommand) {
  const normalizedStored = normalizeProcessCommandLine(storedCommand);
  return Boolean(normalizedStored)
    && normalizeProcessCommandLine(commandLine).includes(normalizedStored);
}

function resolveProcessTreeTarget(pid, { platform = process.platform, processGroup = false } = {}) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) return 0;
  return platform !== 'win32' && processGroup ? -normalizedPid : normalizedPid;
}

function waitForChildExitBounded(child, timeoutMs = 4000, {
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (!child || typeof child.once !== 'function') return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeoutImpl(timer);
      child.removeListener?.('error', onError);
      child.removeListener?.('exit', onExit);
      if (!exited) {
        try { child.kill?.(); } catch (_error) { /* best effort helper cleanup */ }
      }
      resolve(exited);
    };
    const onError = () => finish(false);
    const onExit = () => finish(true);
    child.once('error', onError);
    child.once('exit', onExit);
    timer = setTimeoutImpl(() => finish(false), Math.max(1, Number(timeoutMs) || 1));
    timer?.unref?.();
  });
}

function waitForResultBounded(promise, timeoutMs, {
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeoutImpl(timer);
      resolve(result);
    };
    Promise.resolve(promise).then(
      (value) => finish({ completed: true, value }),
      () => finish({ completed: true, value: false })
    );
    timer = setTimeoutImpl(() => finish({ completed: false, value: false }), Math.max(1, Number(timeoutMs) || 1));
    timer?.unref?.();
  });
}

async function killProcessTree(pid, {
  force = true,
  processGroup = false,
  confirmExit = false,
  timeoutMs = 4000,
  platform = process.platform,
  spawnImpl = spawn,
  waitForProcessExitImpl = waitForProcessExit,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  nowImpl = Date.now,
} = {}) {
  const normalizedPid = Number(pid);
  if (!Number.isInteger(normalizedPid) || normalizedPid <= 0) {
    return;
  }

  if (platform === 'win32') {
    const deadline = nowImpl() + Math.max(1, Number(timeoutMs) || 1);
    const args = ['/PID', String(normalizedPid), '/T'];
    if (force) args.push('/F');
    let child;
    try {
      child = spawnImpl('taskkill', args, {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (_error) {
      return { terminated: false };
    }
    const helperExited = await waitForChildExitBounded(child, deadline - nowImpl(), {
      setTimeoutImpl,
      clearTimeoutImpl,
    });
    if (!helperExited) return { terminated: false };
    if (!confirmExit) return { terminated: true };
    const remainingMs = deadline - nowImpl();
    if (remainingMs <= 0) return { terminated: false };
    const confirmation = await waitForResultBounded(
      waitForProcessExitImpl(normalizedPid, remainingMs),
      remainingMs,
      { setTimeoutImpl, clearTimeoutImpl }
    );
    return { terminated: confirmation.completed && confirmation.value === true };
  }

  const target = resolveProcessTreeTarget(normalizedPid, { platform, processGroup });
  try {
    process.kill(target, force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    if (!error || error.code !== 'ESRCH') {
      throw error;
    }
    return { terminated: true };
  }
  const terminated = confirmExit ? await waitForProcessExitImpl(normalizedPid, timeoutMs) : true;
  return { terminated };
}

async function waitForProcessExit(pid, timeoutMs = 4000) {
  const normalizedPid = Number(pid);
  if (!normalizedPid) {
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(normalizedPid)) {
      return true;
    }
    await wait(120);
  }
  return !isProcessAlive(normalizedPid);
}

module.exports = {
  getFreePort,
  getProcessCommandLine,
  getProcessCommandLineSync,
  isPortOpen,
  isProcessAlive,
  killProcessTree,
  processCommandMatchesStored,
  resolveProcessTreeTarget,
  wait,
  waitForChildExitBounded,
  waitForProcessExit,
  waitForPortToClose,
};
