'use strict';

const { execFile } = require('child_process');
const { isProcessAlive, killProcessTree } = require('./process-utils');
const { sanitizeSpawnEnv } = require('./sanitize-spawn-env');

// Creation times and Date.now() share the system clock; a measured spawn sits
// within 1-3 ms of its CIM CreationDate. Rows this close to a boundary are
// treated as unprovable rather than as ours.
const CLOCK_SLACK_MS = 25;

const WINDOWS_PROCESS_QUERY = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,'
  + "@{n='CreatedMs';e={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }}}"
  + ' | ConvertTo-Json -Compress';

// Rows are { pid, ppid, createdMs } with createdMs null where the platform does
// not report it (ps). Any malformed row fails the whole listing.
async function listProcessRows({
  platform = process.platform, execFileImpl = execFile, timeoutMs = 5000,
} = {}) {
  const failed = { ok: false, rows: [] };
  try {
    const windows = platform === 'win32';
    const output = await new Promise((resolve, reject) => {
      execFileImpl(windows ? 'powershell' : 'ps', windows
        ? ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_QUERY]
        : ['-eo', 'pid=,ppid='], {
        windowsHide: true, env: sanitizeSpawnEnv(process.env),
        timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
      }, (error, stdout) => error ? reject(error) : resolve(String(stdout || '')));
    });
    let rows;
    if (windows) {
      const parsed = JSON.parse(output);
      rows = (Array.isArray(parsed) ? parsed : [parsed]).map((row) => ({
        pid: row.ProcessId, ppid: row.ParentProcessId,
        createdMs: Number.isFinite(row.CreatedMs) ? row.CreatedMs : null,
      }));
    } else {
      rows = output.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) throw new Error('invalid_process_row');
        return { pid: Number(match[1]), ppid: Number(match[2]), createdMs: null };
      });
    }
    for (const row of rows) {
      if (!Number.isSafeInteger(row.pid) || row.pid < 0 || !Number.isSafeInteger(row.ppid) || row.ppid < 0) return failed;
    }
    // Windows lists the System Idle Process as pid 0; it parents nothing we can kill.
    return { ok: true, rows: rows.filter((row) => row.pid !== 0) };
  } catch (_error) {
    return failed;
  }
}

function indexRows(rows) {
  const byPid = new Map();
  const children = new Map();
  for (const row of rows) {
    byPid.set(row.pid, row);
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  return { byPid, children };
}

// Windows keeps a dead parent's pid in its children's ParentProcessId, so a
// child older than the process now holding that pid is a stale link, not a child.
function isStaleLink(parent, child) {
  return parent?.createdMs != null && child.createdMs != null && child.createdMs < parent.createdMs;
}

// Breadth-first from each seed (seeds excluded unless reached from another one).
function collectDescendants(index, seeds, { maxPids = 64, exclude = new Set() } = {}) {
  const seen = new Set([...seeds, ...exclude]);
  const queue = [...seeds];
  const pids = [];
  for (let position = 0; position < queue.length; position += 1) {
    const parent = index.byPid.get(queue[position]);
    for (const child of index.children.get(queue[position]) || []) {
      if (seen.has(child.pid) || isStaleLink(parent, child)) continue;
      if (pids.length === maxPids) return { ok: false, pids };
      seen.add(child.pid);
      pids.push(child.pid);
      queue.push(child.pid);
    }
  }
  return { ok: true, pids };
}

// The pid must still belong to the process whose children are wanted (a live
// child whose exit Node has not yet observed keeps its pid reserved).
async function enumerateDescendants(pid, {
  platform = process.platform, execFileImpl = execFile, timeoutMs = 5000, maxPids = 64,
} = {}) {
  const failed = { ok: false, pids: [], processes: [], rootCreatedMs: null };
  if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(maxPids) || maxPids < 0) return failed;
  const table = await listProcessRows({ platform, execFileImpl, timeoutMs });
  if (!table.ok) return failed;
  const index = indexRows(table.rows);
  const { ok, pids } = collectDescendants(index, [pid], { maxPids });
  return { ok, pids, processes: pids.map((child) => ({ pid: child, createdMs: index.byPid.get(child).createdMs })),
    rootCreatedMs: index.byPid.get(pid)?.createdMs ?? null };
}

// Once Node observes a root's exit its pid is free for reuse, so a listing by
// parent pid can name an unrelated process's children. A survivor is ours only
// if it is a snapshot entry still running as the same process (same creation
// time), a child of the root created while the root still held its pid, or a
// non-stale descendant of either. Rows near a time boundary are not killed and
// leave the result unproven. Without creation times (ps) the snapshot is
// trusted as before and nothing is reaped by parent pid.
function selectRootSurvivors({
  rootPid, spawnedAtMs, spawnReturnedAtMs, rootHeldUntilMs, snapshot = {}, rows = [], maxPids = 64,
}) {
  const index = indexRows(rows);
  const timed = rows.some((row) => row.createdMs != null);
  const entries = Array.isArray(snapshot.processes) ? snapshot.processes
    : (snapshot.pids || []).map((pid) => ({ pid, createdMs: null }));
  const rootTime = snapshot.rootCreatedMs;
  const snapshotOfOurRoot = !timed || (rootTime != null
    && rootTime >= spawnedAtMs - CLOCK_SLACK_MS && rootTime <= spawnReturnedAtMs + CLOCK_SLACK_MS);
  let ok = true;
  const seeds = [];
  const doubtful = [];
  for (const entry of entries) {
    const row = index.byPid.get(entry.pid);
    // Absent: gone. Different creation time: the pid now names another process.
    if (!row || (row.createdMs != null && entry.createdMs != null && row.createdMs !== entry.createdMs)) continue;
    if (row.createdMs !== entry.createdMs) ok = false;
    else if (snapshotOfOurRoot) seeds.push(entry.pid);
    else doubtful.push(entry.pid);
  }
  if (timed) {
    const lower = snapshotOfOurRoot && rootTime != null ? rootTime : spawnedAtMs;
    for (const row of index.children.get(rootPid) || []) {
      if (row.pid === rootPid || row.createdMs == null) continue;
      if (row.createdMs >= lower && row.createdMs < rootHeldUntilMs) seeds.push(row.pid);
      else if (row.createdMs >= lower - CLOCK_SLACK_MS && row.createdMs < rootHeldUntilMs + CLOCK_SLACK_MS) ok = false;
    }
  }
  const unique = [...new Set(seeds)].filter((pid) => pid !== rootPid);
  const expanded = collectDescendants(index, unique, { maxPids: Math.max(0, maxPids - unique.length),
    exclude: new Set([rootPid]) });
  const pids = [...unique, ...expanded.pids];
  if (doubtful.some((pid) => !pids.includes(pid))) ok = false;
  return { ok: ok && expanded.ok && unique.length <= maxPids, pids };
}

// Each pid was just proven to be ours: terminate exactly it, no tree walk that
// could follow a stale parent link.
async function terminatePids(pids, { killImpl = process.kill } = {}) {
  for (const pid of pids) {
    try { killImpl(pid, 'SIGKILL'); } catch (_error) { /* Already gone; confirmation owns the verdict. */ }
  }
}

async function confirmAllGone(pids, {
  isProcessAliveImpl = isProcessAlive, timeoutMs = 4000, pollMs = 100,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + Math.max(0, timeoutMs);
  let survivors = [...new Set(pids)];
  for (;;) {
    survivors = survivors.filter((pid) => {
      try { return isProcessAliveImpl(pid); } catch (_error) { return true; }
    });
    if (!survivors.length) return { confirmed: true, survivors: [] };
    const remaining = deadline - now();
    if (remaining <= 0) return { confirmed: false, survivors };
    await sleep(Math.min(Math.max(1, pollMs), remaining));
  }
}

async function killTreeWithProof(pid, {
  platform = process.platform, enumerateImpl = enumerateDescendants,
  killImpl = killProcessTree, confirmImpl = confirmAllGone, timeoutMs = 8000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let enumeration = { ok: false, pids: [] };
  try { enumeration = await enumerateImpl(pid, { platform, timeoutMs: Math.min(5000, timeoutMs) }); }
  catch (_error) { /* An unknown tree still needs a root kill. */ }
  const pids = [...new Set([pid, ...enumeration.pids])];
  const killOptions = { force: true, confirmExit: false, platform,
    timeoutMs: Math.max(1, deadline - Date.now()) };
  try { await killImpl(pid, killOptions); } catch (_error) { /* Proof below owns the verdict. */ }
  // The shared POSIX helper kills only the root without a detached process group.
  if (platform !== 'win32') {
    for (const child of enumeration.pids.slice().reverse()) {
      try { await killImpl(child, killOptions); } catch (_error) { /* Confirm every known pid below. */ }
    }
  }
  let proof = { confirmed: false, survivors: pids };
  try { proof = await confirmImpl(pids, { timeoutMs: Math.max(0, deadline - Date.now()) }); }
  catch (_error) { /* Unavailable proof is never clean. */ }
  return { confirmed: enumeration.ok === true && proof.confirmed === true,
    enumerated: enumeration.ok === true, pids, survivors: proof.survivors };
}

module.exports = {
  CLOCK_SLACK_MS, listProcessRows, enumerateDescendants, selectRootSurvivors, terminatePids,
  confirmAllGone, killTreeWithProof,
};
