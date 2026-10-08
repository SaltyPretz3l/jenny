const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const { killProcessTree, waitForPortToClose } = require('../../services/backend/process-utils');

const trackedCloseables = new Set();
// pid -> { pid, createdNotAfterMs, handle, exitedAtMs }; see selectOwnedKillTargets.
const trackedProcesses = new Map();
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

// The recorded process existed when its pid file was written, so the file's
// mtime bounds its creation time: a later process holding the same pid is a
// stranger that reused it.
function readOwnedRoot(filePath, { requireAppOwned = false } = {}) {
  const payload = readJsonFile(filePath);
  const pid = Number(payload && payload.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  if (requireAppOwned && payload.app_owned !== true) {
    return null;
  }
  let createdNotAfterMs;
  try {
    createdNotAfterMs = fs.statSync(filePath).mtimeMs;
  } catch (_error) {
    return null;
  }
  return { pid, createdNotAfterMs, handle: null, exitedAtMs: null };
}

// Reads the pids an app run recorded under ONE directory: the managed sidecar
// writes backend-sidecar/sidecar-state.json, and ollama-process.json is only
// ours to kill when the app actually spawned it (app_owned).
function getOwnedRootsForDirectory(dirPath) {
  const roots = [];
  const normalizedDir = String(dirPath || '').trim();
  if (!normalizedDir) {
    return roots;
  }

  const sidecarStatePath = path.join(normalizedDir, 'backend-sidecar', 'sidecar-state.json');
  const ollamaStatePath = path.join(normalizedDir, 'ollama-process.json');

  const sidecarRoot = readOwnedRoot(sidecarStatePath);
  const ollamaRoot = readOwnedRoot(ollamaStatePath, { requireAppOwned: true });

  if (sidecarRoot) {
    roots.push(sidecarRoot);
  }
  if (ollamaRoot) {
    roots.push(ollamaRoot);
  }
  return roots;
}

function getOwnedRootsFromTrackedDirectories() {
  const roots = [];
  for (const dirPath of trackedDirectories) {
    roots.push(...getOwnedRootsForDirectory(dirPath));
  }
  return roots;
}

function hasExited(root) {
  const handle = root && root.handle;
  return Boolean(handle) && (handle.exitCode != null || handle.signalCode != null);
}

function normalizeProcessRows(processRows) {
  const byPid = new Map();
  const childrenByParent = new Map();
  for (const row of processRows || []) {
    const pid = Number(row && row.pid);
    const ppid = Number(row && row.ppid);
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || ppid <= 0) {
      continue;
    }
    const createdMs = Number.isFinite(row.createdMs) ? row.createdMs : null;
    const normalized = { pid, ppid, createdMs };
    byPid.set(pid, normalized);
    if (!childrenByParent.has(ppid)) {
      childrenByParent.set(ppid, []);
    }
    childrenByParent.get(ppid).push(normalized);
  }
  return { byPid, childrenByParent };
}

// Picks the pids cleanup may force-kill. Windows reuses a freed pid within
// seconds under a loaded full-suite run, so a dead root's pid can already name
// a sibling test's process (a reused pid killed renderer-proactive's child
// mid-boot: exit 1, no output). A root is killed only while it is provably the
// recorded process: an un-exited handle (its pid cannot be reused yet), or a
// process-table row created no later than the record was made. Descendants are
// created after their parent. A dead root's orphans keep their stale ppid link
// on Windows, so they are reaped only when created before the root exited and
// before any process that reused its pid; without creation times (POSIX, where
// orphans reparent to init) a dead root contributes nothing.
function selectOwnedKillTargets(roots, processRows) {
  const { byPid, childrenByParent } = normalizeProcessRows(processRows);
  const targets = new Set();
  const enumerated = byPid.size > 0;

  const addTree = (pid, createdMs) => {
    if (targets.has(pid)) {
      return;
    }
    targets.add(pid);
    for (const child of childrenByParent.get(pid) || []) {
      if (createdMs != null && child.createdMs != null && child.createdMs < createdMs) {
        continue;
      }
      addTree(child.pid, child.createdMs);
    }
  };

  for (const root of roots || []) {
    const pid = Number(root && root.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      continue;
    }
    const exited = hasExited(root);
    const row = byPid.get(pid) || null;
    if (!exited && !enumerated) {
      // The process table could not be read: degrade to the bare root.
      targets.add(pid);
      continue;
    }
    const notAfter = Number.isFinite(root.createdNotAfterMs) ? root.createdNotAfterMs : null;
    const liveHandle = Boolean(root.handle) && !exited;
    const sameProcess = row && (liveHandle || row.createdMs == null || notAfter == null
      || row.createdMs <= notAfter);
    if (!exited && sameProcess) {
      addTree(pid, row.createdMs);
      continue;
    }
    if (row && row.createdMs == null) {
      continue;
    }
    let orphanCutoff = Infinity;
    if (exited) {
      orphanCutoff = Number.isFinite(root.exitedAtMs) ? root.exitedAtMs : (notAfter ?? -Infinity);
    }
    if (row) {
      orphanCutoff = Math.min(orphanCutoff, row.createdMs);
    }
    for (const orphan of childrenByParent.get(pid) || []) {
      if (orphan.createdMs != null && orphan.createdMs < orphanCutoff) {
        addTree(orphan.pid, orphan.createdMs);
      }
    }
  }

  return targets;
}

// Bounded: under a loaded full-suite run dozens of children fire this cleanup
// concurrently and Windows WMI serializes Get-CimInstance system-wide, so an
// unbounded query can wedge for minutes and push the whole test file past its
// per-file watchdog (backend-service-inject hung exactly this way once the
// sequential lane started overlapping the parallel pool, 2026-07-20). On
// timeout the child is killed and we resolve '' -- selectOwnedKillTargets then
// degrades to killing just the un-exited root pids instead of the full tree.
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
      createdMs: item && item.CreatedMs != null ? Number(item.CreatedMs) : null,
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
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,'
        + "@{n='CreatedMs';e={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }}}"
        + ' | ConvertTo-Json -Compress',
    ]);
    return parseWindowsProcessRows(output);
  }

  const output = await execFileText('ps', ['-eo', 'pid=,ppid=']);
  return parsePosixProcessRows(output);
}

async function selectOwnedKillTargetsFromHost(roots) {
  const rows = await listProcessRows().catch(() => []);
  return selectOwnedKillTargets(roots, rows);
}

// Best-effort kills the process tree recorded under ONE directory's pid files.
// The returned rootsAttempted counter reports pid-file roots read, not verified kills.
// Deliberately does NOT touch the tracked* sets, does not remove the directory,
// and does not latch, so it is safe to call repeatedly and alongside cleanupTrackedResources.
// Exists for acquisition-side teardown: a spawn that already happened but whose
// launch never handed back a process handle to trackProcess (see launchJenny in
// tests/gui-smoke/gui-smoke-harness.js).
async function killOwnedProcessesForDirectory(dirPath) {
  const roots = getOwnedRootsForDirectory(dirPath);
  if (roots.length === 0) {
    // Nothing recorded a pid under this directory, so nothing spawned: return
    // without enumerating the host process table (see the WMI-cost note in
    // cleanupTrackedResources -- that query serializes system-wide on Windows).
    return { rootsAttempted: 0 };
  }

  const processTreePids = await selectOwnedKillTargetsFromHost(roots);
  for (const pid of [...processTreePids].sort((left, right) => right - left)) {
    // A stale pid file can name a since-reused pid; never let that reuse
    // point the force-kill at this test process itself.
    if (pid === process.pid) {
      continue;
    }
    await killProcessTree(pid, { force: true }).catch(() => null);
  }
  return { rootsAttempted: roots.length };
}

// Accepts a ChildProcess or a bare { pid }. The process was created before
// this call, which bounds its creation time for the pid-reuse check.
function trackProcess(processHandle) {
  installProcessCleanupHooks();
  const pid = Number(processHandle && processHandle.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  const trackedAtMs = Date.now();
  const isChildProcess = typeof processHandle.once === 'function' && 'exitCode' in processHandle;
  const root = {
    pid,
    createdNotAfterMs: trackedAtMs,
    handle: isChildProcess ? processHandle : null,
    exitedAtMs: null,
  };
  if (isChildProcess) {
    if (hasExited(root)) {
      root.exitedAtMs = trackedAtMs;
    } else {
      processHandle.once('exit', () => {
        root.exitedAtMs = Date.now();
      });
    }
  }
  trackedProcesses.set(pid, root);
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
    const ownedRoots = getOwnedRootsFromTrackedDirectories();
    ownedRoots.push(...trackedProcesses.values());
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
    const anyOwnedPidAlive = ownedRoots.some((root) => isPidAlive(root.pid));
    const processTreePids = anyOwnedPidAlive || trackedProcesses.size > 0
      ? await selectOwnedKillTargetsFromHost(ownedRoots)
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
  killOwnedProcessesForDirectory,
  selectOwnedKillTargets,
  trackCloseable,
  trackDirectory,
  trackPort,
  trackProcess,
};
