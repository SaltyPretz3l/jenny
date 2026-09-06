const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { killProcessTree, waitForPortToClose } = require('../../services/backend/process-utils');

const trackedCloseables = new Set();
const trackedProcesses = new Set();
const trackedPorts = new Set();
const trackedDirectories = new Set();
let cleanupPromise = null;
let processCleanupHooksInstalled = false;

async function _cleanupAndExit(exitCode) {
  await cleanupTrackedResources().catch(() => null);
  process.exit(exitCode);
}

function installProcessCleanupHooks() {
  if (processCleanupHooksInstalled) {
    return;
  }
  processCleanupHooksInstalled = true;

  const handleSignal = (exitCode) => {
    void _cleanupAndExit(exitCode);
  };

  process.once('SIGINT', () => handleSignal(130));
  process.once('SIGTERM', () => handleSignal(143));
  if (process.platform === 'win32') {
    process.once('SIGBREAK', () => handleSignal(149));
  }
  process.once('uncaughtException', (error) => {
    console.error('[resource-cleanup] uncaughtException', error?.stack || error);
    void _cleanupAndExit(1);
  });
  process.once('unhandledRejection', (reason) => {
    console.error('[resource-cleanup] unhandledRejection', reason?.stack || reason);
    void _cleanupAndExit(1);
  });
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readOwnedPid(filePath, { requireAppOwned = false } = {}) {
  const payload = readJsonFile(filePath);
  const pid = Number(payload && payload.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return 0;
  }
  if (requireAppOwned && payload.app_owned !== true) {
    return 0;
  }
  return pid;
}

// Reads the pids an app run recorded under ONE directory: the managed sidecar
// writes backend-sidecar/sidecar-state.json, and ollama-process.json is only
// ours to kill when the app actually spawned it (app_owned).
function getOwnedPidsForDirectory(dirPath) {
  const ownedPids = new Set();
  const normalizedDir = String(dirPath || '').trim();
  if (!normalizedDir) {
    return ownedPids;
  }

  const sidecarStatePath = path.join(normalizedDir, 'backend-sidecar', 'sidecar-state.json');
  const ollamaStatePath = path.join(normalizedDir, 'ollama-process.json');

  const sidecarPid = readOwnedPid(sidecarStatePath);
  const ollamaPid = readOwnedPid(ollamaStatePath, { requireAppOwned: true });

  if (sidecarPid) {
    ownedPids.add(sidecarPid);
  }
  if (ollamaPid) {
    ownedPids.add(ollamaPid);
  }
  return ownedPids;
}

function getOwnedProcessPidsFromTrackedDirectories() {
  const ownedPids = new Set();
  for (const dirPath of trackedDirectories) {
    for (const pid of getOwnedPidsForDirectory(dirPath)) {
      ownedPids.add(pid);
    }
  }
  return ownedPids;
}

function expandProcessTreePids(rootPids, processRows) {
  const expanded = new Set();
  const childrenByParent = new Map();

  for (const row of processRows || []) {
    const pid = Number(row && row.pid);
    const ppid = Number(row && row.ppid);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid <= 0) {
      continue;
    }
    if (!childrenByParent.has(ppid)) {
      childrenByParent.set(ppid, []);
    }
    childrenByParent.get(ppid).push(pid);
  }

  const queue = [];
  for (const rootPid of rootPids || []) {
    const pid = Number(rootPid);
    if (!Number.isInteger(pid) || pid <= 0 || expanded.has(pid)) {
      continue;
    }
    expanded.add(pid);
    queue.push(pid);
  }

  while (queue.length > 0) {
    const parentPid = queue.shift();
    for (const childPid of childrenByParent.get(parentPid) || []) {
      if (expanded.has(childPid)) {
        continue;
      }
      expanded.add(childPid);
      queue.push(childPid);
    }
  }

  return expanded;
}

// Bounded: under a loaded full-suite run dozens of children fire this cleanup
// concurrently and Windows WMI serializes Get-CimInstance system-wide, so an
// unbounded query can wedge for minutes and push the whole test file past its
// per-file watchdog (backend-service-inject hung exactly this way once the
// sequential lane started overlapping the parallel pool, 2026-07-20). On
// timeout the child is killed and we resolve '' -- expandOwnedProcessPids then
// degrades to killing just the root pids instead of the full tree.
const PROCESS_LIST_TIMEOUT_MS = 15_000;

function execFileText(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve('');
          return;
        }
        resolve(String(stdout || ''));
      }
    );
  });
}

function parsePosixProcessRows(output) {
  const rows = [];
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]) });
  }
  return rows;
}

function parseWindowsProcessRows(output) {
  try {
    const payload = JSON.parse(String(output || '').trim() || '[]');
    const items = Array.isArray(payload) ? payload : [payload];
    return items.map((item) => ({
      pid: Number(item && item.ProcessId),
      ppid: Number(item && item.ParentProcessId),
    }));
  } catch (_error) {
    return [];
  }
}

async function listProcessRows() {
  if (process.platform === 'win32') {
    const output = await execFileText('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
    ]);
    return parseWindowsProcessRows(output);
  }

  const output = await execFileText('ps', ['-eo', 'pid=,ppid=']);
  return parsePosixProcessRows(output);
}

async function expandOwnedProcessPids(rootPids) {
  const rows = await listProcessRows().catch(() => []);
  return expandProcessTreePids(rootPids, rows);
}

// Best-effort kills the process tree recorded under ONE directory's pid files.
// The returned rootsAttempted counter reports pid-file roots read, not verified kills.
// Deliberately does NOT touch the tracked* sets, does not remove the directory,
// and does not latch, so it is safe to call repeatedly and alongside cleanupTrackedResources.
// Exists for acquisition-side teardown: a spawn that already happened but whose
// launch never handed back a process handle to trackProcess (see launchJenny in
// tests/gui-smoke/gui-smoke-harness.js).
async function killOwnedProcessesForDirectory(dirPath) {
  const rootPids = getOwnedPidsForDirectory(dirPath);
  if (rootPids.size === 0) {
    // Nothing recorded a pid under this directory, so nothing spawned: return
    // without enumerating the host process table (see the WMI-cost note in
    // cleanupTrackedResources -- that query serializes system-wide on Windows).
    return { rootsAttempted: 0 };
  }

  const processTreePids = await expandOwnedProcessPids(rootPids);
  for (const pid of [...processTreePids].sort((left, right) => right - left)) {
    // A stale pid file can name a since-reused pid; never let that reuse
    // point the force-kill at this test process itself.
    if (pid === process.pid) {
      continue;
    }
    await killProcessTree(pid, { force: true }).catch(() => null);
  }
  return { rootsAttempted: rootPids.size };
}

function trackProcess(processHandle) {
  installProcessCleanupHooks();
  if (processHandle && processHandle.pid) {
    trackedProcesses.add(Number(processHandle.pid));
  }
}

function createTrackedTempDir(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(directory);
  return directory;
}

function trackPort(port) {
  installProcessCleanupHooks();
  if (port) {
    trackedPorts.add(Number(port));
  }
}

function trackDirectory(dirPath) {
  installProcessCleanupHooks();
  if (dirPath) {
    trackedDirectories.add(dirPath);
  }
}

function trackCloseable(closeable) {
  installProcessCleanupHooks();
  if (!closeable) {
    return closeable;
  }
  trackedCloseables.add(closeable);
  return closeable;
}

async function closeTrackedCloseable(closeable) {
  if (typeof closeable === 'function') {
    await closeable();
    return;
  }
  if (typeof closeable.stop === 'function') {
    await closeable.stop();
    return;
  }
  if (typeof closeable.close === 'function') {
    await closeable.close();
    return;
  }
  if (typeof closeable.dispose === 'function') {
    await closeable.dispose();
  }
}

async function cleanupTrackedResources() {
  if (cleanupPromise) {
    return cleanupPromise;
  }

  cleanupPromise = (async () => {
    const ownedPids = getOwnedProcessPidsFromTrackedDirectories();
    for (const pid of trackedProcesses) {
      ownedPids.add(pid);
    }
    // Only enumerate the host process table when at least one owned PID is
    // still ALIVE. Most test files track no processes (closeables/dirs only),
    // and stale pid files (a companion-mode service's state file, a long-dead
    // sidecar) would otherwise spawn powershell Get-CimInstance (+ a conhost
    // window) on EVERY afterEach -- hundreds of WMI queries per full run,
    // which serialize system-wide and stall cleanups under load. When any root
    // is alive we still enumerate with every owned pid so orphans of a dead
    // sibling root are found via their stale ppid links.
    // Additionally, if THIS file explicitly tracked a spawn, enumerate even
    // when every root is already dead: a dead root's surviving children are
    // only discoverable via their stale ppid links in the process table. The
    // skip stays in place for the common case (closeables/dirs only, or stale
    // pid FILES left by processes this file never spawned).
    const anyOwnedPidAlive = [...ownedPids].some(isPidAlive);
    const processTreePids = anyOwnedPidAlive || trackedProcesses.size > 0
      ? await expandOwnedProcessPids(ownedPids)
      : new Set();

    const closeables = [...trackedCloseables];
    trackedCloseables.clear();
    for (const closeable of closeables) {
      await closeTrackedCloseable(closeable).catch(() => null);
    }

    for (const pid of [...processTreePids].sort((left, right) => right - left)) {
      if (pid === process.pid) {
        continue;
      }
      await killProcessTree(pid, { force: true }).catch(() => null);
    }
    trackedProcesses.clear();

    for (const port of trackedPorts) {
      await waitForPortToClose(port, '127.0.0.1', 5000).catch(() => null);
    }
    trackedPorts.clear();

    for (const dirPath of trackedDirectories) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
    trackedDirectories.clear();
  })().finally(() => {
    cleanupPromise = null;
  });

  return cleanupPromise;
}

module.exports = {
  cleanupTrackedResources,
  createTrackedTempDir,
  expandProcessTreePids,
  killOwnedProcessesForDirectory,
  trackCloseable,
  trackDirectory,
  trackPort,
  trackProcess,
};
