'use strict';
// Ticket liveness (protocol: "Liveness"): pure rules plus the impure pid/start-time/host probes.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawnSync } = require('node:child_process');

const BOOT_TOLERANCE_S = 120;
const START_TOLERANCE_S = 2;
const PROBE_CACHE_MS = 60_000;
const START_PROBE_TIMEOUT_MS = 3_000;
const RESUME_JUMP_MS = 30_000;
const RESUME_WINDOW_MS = 60_000;
const INDEX_LOCK_FRESH_MS = 30_000;
const TEST_LOCK_STALE_MS = 60 * 60_000; // run-node-tests-safe.js LOCK_STALE_MS: age covers a reused pid
const MAX_WORKTREE_LOCK_SCAN = 64;
const MAX_DEFERRED_PIDS = 256;

const isNum = (value) => typeof value === 'number' && Number.isFinite(value);

// probe = { available, alive(pid) => boolean, startTime(pid) => epoch seconds | null }.
function isTicketDead(ticket, options) {
  const {
    me, probe, now, observerResumedRecently = false, staleAfterS = 60, unknownStartHorizonS = 600,
  } = options;
  const owner = ticket.owner;
  const heartbeatAge = isNum(ticket.heartbeat_at) ? now - ticket.heartbeat_at : Infinity;
  const sameHost = String(owner.host.name).toLowerCase() === String(me.name).toLowerCase();
  if (!sameHost) return heartbeatAge > staleAfterS;

  if (isNum(me.boot) && isNum(owner.host.boot) && Math.abs(me.boot - owner.host.boot) > BOOT_TOLERANCE_S) {
    return true; // previous boot
  }
  if (!probe || !probe.available) return heartbeatAge > staleAfterS;
  if (!probe.alive(owner.pid)) return true;

  const observed = probe.startTime(owner.pid);
  if (isNum(owner.pid_start) && isNum(observed)) {
    // Both known: a live pid with a matching start is live however old its heartbeat is (resume from sleep).
    return Math.abs(observed - owner.pid_start) > START_TOLERANCE_S;
  }
  // A start time is unknown: only a very old heartbeat (a reused pid) kills it, never right after our own resume.
  return heartbeatAge > unknownStartHorizonS && !observerResumedRecently;
}

function hostIdentity() {
  return { name: os.hostname(), boot: Date.now() / 1000 - os.uptime() };
}

function readProcStat(pid, fsImpl, bootSeconds) {
  const stat = fsImpl.readFileSync(`/proc/${pid}/stat`, 'utf8');
  // The command name is parenthesized and may contain spaces: fields restart after the last ')'.
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  const ticks = Number(fields[19]); // field 22 (starttime), fields[0] is field 3
  return Number.isFinite(ticks) ? ticks / 100 + bootSeconds() : null;
}

function readLinuxBoot(fsImpl) {
  try {
    const match = /^btime\s+(\d+)/mu.exec(fsImpl.readFileSync('/proc/stat', 'utf8'));
    if (match) return Number(match[1]);
  } catch {
    // fall through to the uptime-derived boot time
  }
  return hostIdentity().boot;
}

function spawnText(spawn, command, args, env) {
  const result = spawn(command, args, {
    encoding: 'utf8', timeout: START_PROBE_TIMEOUT_MS, windowsHide: true, env, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result && result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

const windowsStartArgs = (pid) => ['-NoProfile', '-NonInteractive', '-Command',
  `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`];

function readWindowsStart(pid, spawn) {
  const ms = Date.parse(spawnText(spawn, 'powershell', windowsStartArgs(pid)));
  return Number.isFinite(ms) ? ms / 1000 : null;
}

// The Windows start time without blocking the caller (a PowerShell helper takes a few hundred ms).
// Resolves epoch seconds or null; never rejects.
function readStartTimeAsync(pid, options = {}) {
  const platform = options.platform || process.platform;
  const run = options.execFile || execFile;
  if (platform !== 'win32' || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      run('powershell', windowsStartArgs(pid), { encoding: 'utf8', timeout: START_PROBE_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          const ms = error ? NaN : Date.parse(String(stdout || '').trim());
          resolve(Number.isFinite(ms) ? ms / 1000 : null);
        });
    } catch {
      resolve(null);
    }
  });
}

// A probe for a thread that must not block: startTime() answers from a cache and reads a missing
// pid in the background, answering null ("unknown") meanwhile. Unknown keeps a live pid's ticket
// alive under rule 1.4, and the background read lands long before that rule's 600 s horizon, so a
// reused pid is still caught within seconds.
function createDeferredStartProbe(base, readAsync, options = {}) {
  const clock = options.nowMs || Date.now;
  const cacheMs = options.cacheMs ?? PROBE_CACHE_MS;
  const cache = new Map(); // pid -> { at, value, pending }
  return {
    available: base.available,
    alive: (pid) => base.alive(pid),
    startTime(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      const hit = cache.get(pid);
      if (hit && (hit.pending || clock() - hit.at < cacheMs)) return hit.value;
      const entry = { at: clock(), value: hit ? hit.value : null, pending: true };
      cache.delete(pid);
      cache.set(pid, entry);
      while (cache.size > MAX_DEFERRED_PIDS) cache.delete(cache.keys().next().value);
      Promise.resolve().then(() => readAsync(pid)).then((value) => { entry.value = value ?? null; }, () => {})
        .finally(() => { entry.pending = false; entry.at = clock(); });
      return entry.value;
    },
  };
}

function readMacStart(pid, spawn) {
  const text = spawnText(spawn, 'ps', ['-o', 'lstart=', '-p', String(pid)], { ...process.env, LC_ALL: 'C' });
  const ms = Date.parse(text); // "Sat Nov  1 10:00:00 2026", local time
  return Number.isFinite(ms) ? ms / 1000 : null;
}

// Start times are expensive on Windows (a helper process), so they are read lazily by the caller
// and cached per pid here; null on any failure.
function createDefaultProbe(options = {}) {
  const platform = options.platform || process.platform;
  const spawn = options.spawnSync || spawnSync;
  const fsImpl = options.fs || fs;
  const clock = options.nowMs || Date.now;
  const cache = new Map();
  return {
    available: true,
    alive(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return error.code === 'EPERM'; // exists, owned by someone else
      }
    },
    startTime(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      const hit = cache.get(pid);
      if (hit && clock() - hit.at < PROBE_CACHE_MS) return hit.value;
      let value = null;
      try {
        if (platform === 'linux') value = readProcStat(pid, fsImpl, () => readLinuxBoot(fsImpl));
        else if (platform === 'darwin') value = readMacStart(pid, spawn);
        else if (platform === 'win32') value = readWindowsStart(pid, spawn);
      } catch {
        value = null;
      }
      cache.set(pid, { at: clock(), value });
      return value;
    },
  };
}

// Our own creation time as other observers will read it. Linux reads /proc; elsewhere the process
// clock is within a fraction of a second of the OS-reported creation time (tolerance is 2 s).
function ownProcessStart(options = {}) {
  const platform = options.platform || process.platform;
  const fsImpl = options.fs || fs;
  if (platform === 'linux') {
    try {
      const value = readProcStat('self', fsImpl, () => readLinuxBoot(fsImpl));
      if (isNum(value)) return value;
    } catch {
      // fall back to the process clock
    }
  }
  return Date.now() / 1000 - process.uptime();
}

// Detects a suspend/resume: the wall clock advances far more than the monotonic clock. The
// monotonic clock stops while the machine sleeps on Linux and macOS.
function createResumeDetector(options = {}) {
  const wallMs = options.wallMs || Date.now;
  const monoMs = options.monoMs || (() => Number(process.hrtime.bigint() / 1_000_000n));
  let lastWall = wallMs();
  let lastMono = monoMs();
  let resumedAt = -Infinity;
  const sample = () => {
    const wall = wallMs();
    const mono = monoMs();
    if (wall - lastWall - (mono - lastMono) > RESUME_JUMP_MS) resumedAt = wall;
    lastWall = wall;
    lastMono = mono;
    return wall;
  };
  let timer = null;
  return {
    sample,
    resumedRecently() {
      return sample() - resumedAt < RESUME_WINDOW_MS;
    },
    start(intervalMs = 5_000) {
      if (!timer) {
        timer = setInterval(sample, intervalMs);
        if (timer.unref) timer.unref();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

function indexLockFresh(common) {
  const candidates = [path.join(common, 'index.lock')];
  try {
    for (const name of fs.readdirSync(path.join(common, 'worktrees')).slice(0, MAX_WORKTREE_LOCK_SCAN)) {
      candidates.push(path.join(common, 'worktrees', name, 'index.lock'));
    }
  } catch { /* no linked worktrees */ }
  return candidates.some((file) => {
    try { return Date.now() - fs.statSync(file).mtimeMs < INDEX_LOCK_FRESH_MS; } catch { return false; }
  });
}

// Legacy locks read as held tickets with seq 0 that are never written to disk.
function legacyHolders(live, { host, probe, gitCommonDir }) {
  const keys = new Set();
  for (const t of live) {
    if (t.state === 'waiting' && t.enforcement === 'blocking') for (const r of t.resources) keys.add(r.key);
  }
  const holders = [];
  const add = (key, app, pid) => holders.push(Object.freeze({
    seq: 0, ticket: `legacy-${holders.length}`, state: 'held', enforcement: 'blocking', synthetic: true,
    resources: Object.freeze([Object.freeze({ key, units: 'all', capacity: null })]),
    owner: Object.freeze({ app, pid, pid_start: null, host, label: null, session: null, profile: null }),
  }));
  for (const key of keys) {
    const tree = /^tests@tree:(.+)$/u.exec(key);
    if (tree) {
      try {
        const lock = path.join(tree[1], '.test-run.lock');
        const pid = JSON.parse(fs.readFileSync(lock, 'utf8')).pid;
        const fresh = Date.now() - fs.statSync(lock).mtimeMs <= TEST_LOCK_STALE_MS;
        if (fresh && probe.available && probe.alive(pid)) add(key, 'legacy-test-run', pid);
      } catch { /* no lock, or one that is mid-write: not a holder */ }
    } else if (key === 'git-write@repo' && gitCommonDir && indexLockFresh(gitCommonDir)) {
      add(key, 'git', null);
    }
  }
  return holders;
}

module.exports = {
  legacyHolders, isTicketDead, hostIdentity, ownProcessStart, createDefaultProbe, createDeferredStartProbe,
  createResumeDetector, readStartTimeAsync,
};
