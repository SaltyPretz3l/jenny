'use strict';

// Row 100 work leases, broker side: turns a `run_command` call into cross-process work resources
// (tests per tree, git writes per repository), holds them through per-lease-root WorkLeaseStores and
// hands a started background job's tickets to the job. Cooperative and fail-open: any infrastructure
// problem lets the command run uncoordinated; only a definite "busy" answer delays it.
// Protocol: docs/architecture/WORK_LEASES_PROTOCOL.md.

const crypto = require('node:crypto');
const path = require('node:path');
const { computeGrants } = require('../work-leases/grant');
const { createDefaultProbe, createDeferredStartProbe, readStartTimeAsync } = require('../work-leases/liveness');
const { resourceKey, resolveLeaseScope } = require('../work-leases/paths');
const { WorkLeaseStore } = require('../work-leases/store');

const NOTIFY_DEBOUNCE_MS = 50;
const BLOCKED_POLL_WINDOW_MS = 10 * 60 * 1000;
const BLOCKED_FAST_POLL_MS = 60 * 1000; // re-check every blockedPollMs for a minute, then 5x slower
const STORE_IDLE_MS = 5 * 60 * 1000;
const BROKEN_ROOT_MS = 30 * 1000;
const MAX_SESSION_CHARS = 128;
const MAX_EARLY_STARTS = 64;
const OWNER_APP = 'jenny-desktop';
const WAITING = Object.freeze({ status: 'waiting' });
const NOT_COORDINATED = Object.freeze({ status: 'granted', handle: null });
const NO_RESOURCES = Object.freeze([]);

// 'all' beats numbers, otherwise the larger take wins; the smaller declared capacity wins.
function mergeTake(a, b) {
  const units = a.units === 'all' || b.units === 'all' ? 'all' : Math.max(a.units, b.units);
  const capacities = [a.capacity, b.capacity].filter((value) => value !== null && value !== undefined);
  return { ...a, units, capacity: capacities.length ? Math.min(...capacities) : null };
}

function createWorkLeaseAdapter({
  userDataPath,
  log = () => {},
  classify = (command, options) => require('../work-leases/rules').classifyCommand(command, options),
  resolveScope = resolveLeaseScope,
  createStore = null,
  platform = process.platform,
  now = Date.now,
  transferWindowMs = 15_000,
  heartbeatMs = 10_000,
  blockedPollMs = 2_000,
  maxResources = 8,
  startTimeOf = null,
  // Reading a start time spawns PowerShell on Windows; the main process reads it in the background.
  startTimeOfAsync = platform === 'win32' ? (pid) => readStartTimeAsync(pid, { platform }) : null,
} = {}) {
  const profile = crypto.createHash('sha256').update(String(userDataPath ?? '')).digest('hex').slice(0, 16);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let defaultProbe = null;
  const probeFor = () => {
    if (!defaultProbe) {
      const base = createDefaultProbe({ platform });
      defaultProbe = startTimeOfAsync ? createDeferredStartProbe(base, startTimeOfAsync) : base;
    }
    return defaultProbe;
  };
  const makeStore = createStore || ((leaseRoot) => new WorkLeaseStore({
    leaseRoot,
    probe: probeFor(),
    guardTimeoutMs: 250,
    writeRetryMs: 250,
    viewCacheMs: 300,
    legacyCacheMs: 1_000,
    log: (message) => log('DEBUG', 'work_leases.store', { message }),
    onLost: (tickets) => log('WARN', 'work_leases.ticket_lost', { tickets }),
  }));
  const stores = new Map(); // lease root -> { store, unwatch, usedAt }
  const handles = new Map(); // handle id -> { handle, jobId, transferKey, timer }
  const brokenUntil = new Map(); // lease root -> time until which it is skipped after a failure
  const pending = new Map(); // `${sessionId}\n${toolCallId}` -> handle id awaiting its job start
  const earlyStarts = new Map(); // same key -> { jobId, pid, at }: a job start seen before its transfer
  const jobs = new Map(); // jobId -> handle id
  const listeners = new Set();
  let notifyTimer = null;
  let pollTimer = null;
  let sweepTimer = null;
  let blockedSince = -Infinity;
  let lastBlockedAt = -Infinity;
  let closed = false;

  const warn = (event, details) => { try { log('WARN', event, details); } catch { /* logging must not break work */ } };

  function notifyListeners() {
    for (const listener of [...listeners]) {
      try { listener(); } catch (error) { warn('work_leases.listener_failed', { reason: error.message }); }
    }
  }

  function scheduleNotify() {
    if (closed || notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; if (!closed) notifyListeners(); }, NOTIFY_DEBOUNCE_MS);
    notifyTimer.unref();
  }

  // A crashed holder deletes no file, so a parked chat re-checks on a timer while a block is recent.
  function schedulePoll() {
    const delay = now() - blockedSince < BLOCKED_FAST_POLL_MS ? blockedPollMs : blockedPollMs * 5;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (closed || now() - lastBlockedAt >= BLOCKED_POLL_WINDOW_MS) return;
      notifyListeners();
      if (!closed && !pollTimer) schedulePoll();
    }, delay);
    pollTimer.unref();
  }

  function markBlocked() {
    lastBlockedAt = now();
    if (pollTimer || closed) return;
    blockedSince = lastBlockedAt;
    schedulePoll();
  }

  function closeEntry(entry) {
    try { if (entry.unwatch) entry.unwatch(); entry.store.close(); } catch { /* already closed */ }
  }

  // A root no chat has touched for 5 minutes, holding nothing, gives back its watcher and timer.
  function sweepIdle() {
    for (const [leaseRoot, entry] of stores) {
      if (now() - entry.usedAt >= STORE_IDLE_MS && !(entry.store.ownedCount > 0)) {
        stores.delete(leaseRoot);
        closeEntry(entry);
      }
    }
    if (!stores.size) { clearInterval(sweepTimer); sweepTimer = null; }
  }

  function storeFor(leaseRoot) {
    let entry = stores.get(leaseRoot);
    if (!entry) {
      const store = makeStore(leaseRoot);
      entry = { store, unwatch: null, usedAt: now() };
      stores.set(leaseRoot, entry);
      store.startHeartbeat(heartbeatMs);
      try { entry.unwatch = store.watch(scheduleNotify); } catch (error) { warn('work_leases.watch_failed', { reason: error.message }); }
      if (!sweepTimer) { sweepTimer = setInterval(sweepIdle, 60_000); sweepTimer.unref(); }
    }
    entry.usedAt = now();
    return entry.store;
  }

  // A root that just failed (unwritable, on a vanished volume) is left uncoordinated for 30 s
  // instead of costing every command another guard attempt.
  function markBroken(leaseRoot, error) {
    brokenUntil.set(leaseRoot, now() + BROKEN_ROOT_MS);
    warn('work_leases.root_failed', { reason: error.message, infra: error.reason || null });
  }

  function usable(leaseRoot) {
    const until = brokenUntil.get(leaseRoot);
    if (until === undefined) return true;
    if (now() < until) return false;
    brokenUntil.delete(leaseRoot);
    return true;
  }

  // A session's held work covers its own later commands: a turn never parks behind its own
  // background job, which the paused model could not stop.
  function coveredBySession(resource) {
    if (!resource.sessionId) return false;
    for (const { handle } of handles.values()) {
      if (handle.sessionId !== resource.sessionId) continue;
      if (handle.takes.some((take) => take.leaseRoot === resource.leaseRoot && take.key === resource.key
        && (take.units === 'all' || (resource.units !== 'all' && take.units >= resource.units)))) return true;
    }
    return false;
  }

  function groupByRoot(resources) {
    const groups = new Map();
    for (const resource of resources || []) {
      if (resource?.type !== 'work' || !usable(resource.leaseRoot) || coveredBySession(resource)) continue;
      const entries = groups.get(resource.leaseRoot) || new Map();
      // resourcesFor already merged duplicate keys; a duplicate here makes publish fail open.
      entries.set(resource.key, { key: resource.key, units: resource.units, capacity: resource.capacity ?? null });
      groups.set(resource.leaseRoot, entries);
    }
    return new Map([...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([root, entries]) => [root, [...entries.values()]]));
  }

  function releaseTickets(tickets) {
    for (const { leaseRoot, ticket } of tickets) {
      try { stores.get(leaseRoot)?.store.release(ticket); } catch (error) { warn('work_leases.release_failed', { reason: error.message }); }
    }
  }

  function releaseEntry(id) {
    const entry = handles.get(id);
    if (!entry) return;
    handles.delete(id);
    clearTimeout(entry.timer);
    if (entry.transferKey && pending.get(entry.transferKey) === id) pending.delete(entry.transferKey);
    if (entry.jobId && jobs.get(entry.jobId) === id) jobs.delete(entry.jobId);
    releaseTickets(entry.handle.tickets);
  }

  function bind(entry, { jobId, pid }) {
    clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.transferKey) pending.delete(entry.transferKey);
    entry.jobId = jobId;
    jobs.set(jobId, entry.handle.id);
    if (!Number.isSafeInteger(pid) || pid < 1) return;
    const reown = (pidStart) => {
      for (const { leaseRoot, ticket } of entry.handle.tickets) {
        try { stores.get(leaseRoot)?.store.reown(ticket, { pid, pidStart }); } catch (error) { warn('work_leases.reown_failed', { reason: error.message }); }
      }
    };
    let pidStart = null;
    try {
      if (startTimeOf) pidStart = startTimeOf(pid);
      else if (!startTimeOfAsync) pidStart = probeFor().startTime(pid);
    } catch { pidStart = null; }
    reown(pidStart);
    // The job's start time arrives later; until then its ticket is alive while its pid is.
    if (pidStart === null && !startTimeOf && startTimeOfAsync) {
      Promise.resolve().then(() => startTimeOfAsync(pid)).then((start) => {
        if (Number.isFinite(start) && !closed && handles.get(entry.handle.id) === entry && entry.jobId === jobId) reown(start);
      }, () => {});
    }
  }

  function resourcesFor({ argumentsValue, workspacePath, sessionId } = {}) {
    try {
      const command = argumentsValue?.command;
      if (typeof command !== 'string' || !command.trim()) return NO_RESOURCES;
      const base = typeof workspacePath === 'string' ? workspacePath : '';
      const cwdArg = typeof argumentsValue.cwd === 'string' && argumentsValue.cwd ? argumentsValue.cwd : '.';
      if (!base && !pathApi.isAbsolute(cwdArg)) return NO_RESOURCES;
      const cwd = base ? pathApi.resolve(base, cwdArg) : pathApi.resolve(cwdArg);
      const classification = classify(command, { cwd, platform });
      const label = typeof classification.label === 'string' ? classification.label : '';
      const session = typeof sessionId === 'string' && sessionId ? sessionId.slice(0, MAX_SESSION_CHARS) : null;
      const scopes = new Map();
      const merged = new Map();
      for (const take of classification.takes || []) {
        if (!scopes.has(take.dir)) scopes.set(take.dir, resolveScope(take.dir, { platform }));
        const scope = scopes.get(take.dir);
        if (take.scope === 'repo' && !scope.isRepo) continue;
        const key = resourceKey(take.kind, take.scope, scope.treeRoot, platform);
        const id = `${scope.leaseRoot}\n${key}`;
        const resource = { type: 'work', leaseRoot: scope.leaseRoot, key, units: take.units,
          capacity: take.capacity ?? null, label, sessionId: session };
        merged.set(id, merged.has(id) ? mergeTake(merged.get(id), resource) : resource);
      }
      return Object.freeze([...merged.values()].slice(0, maxResources).map((resource) => Object.freeze(resource)));
    } catch (error) {
      warn('work_leases.classify_failed', { reason: error.message });
      return NO_RESOURCES;
    }
  }

  function wouldBlock(resources) {
    if (closed) return false;
    let leaseRoot = null;
    try {
      for (const [root, entries] of groupByRoot(resources)) {
        leaseRoot = root;
        const { seq, all } = storeFor(root).hypothetical(entries);
        if (!computeGrants(all).includes(seq)) { markBlocked(); return true; }
      }
      return false;
    } catch (error) {
      if (leaseRoot) markBroken(leaseRoot, error);
      return false;
    }
  }

  function hold({ sessionId, resources } = {}) {
    const published = [];
    let leaseRoot = null;
    try {
      if (closed) return NOT_COORDINATED;
      const groups = groupByRoot(resources);
      const label = (resources || []).find((resource) => resource?.label)?.label || null;
      const session = sessionId || (resources || []).find((resource) => resource?.sessionId)?.sessionId || null;
      for (const [root, entries] of groups) {
        leaseRoot = root;
        const result = storeFor(root).publish({
          resources: entries,
          owner: { app: OWNER_APP, profile, session, label },
          purpose: 'run_command',
        });
        published.push({ leaseRoot: root, ticket: result.ticket.ticket });
        if (!result.granted) {
          // A parked turn keeps no queue place: the chat asks again when something changes.
          releaseTickets(published);
          markBlocked();
          return WAITING;
        }
      }
      if (!published.length) return NOT_COORDINATED;
      const takes = [...groups].flatMap(([root, entries]) => entries.map((entry) => Object.freeze({
        leaseRoot: root, key: entry.key, units: entry.units })));
      const handle = Object.freeze({ id: crypto.randomBytes(8).toString('hex'),
        tickets: Object.freeze(published.map((ticket) => Object.freeze(ticket))), sessionId: session,
        takes: Object.freeze(takes) });
      handles.set(handle.id, { handle, jobId: null, transferKey: null, timer: null });
      return Object.freeze({ status: 'granted', handle });
    } catch (error) {
      releaseTickets(published);
      if (leaseRoot && !(error instanceof TypeError)) markBroken(leaseRoot, error);
      else warn('work_leases.hold_failed', { reason: error.message });
      return NOT_COORDINATED;
    }
  }

  function release(handle) {
    if (handle?.id) releaseEntry(handle.id);
  }

  function transferToJob(handle, { sessionId, toolCallId } = {}) {
    const entry = handle?.id ? handles.get(handle.id) : null;
    if (!entry) return;
    const key = `${sessionId}\n${toolCallId}`;
    entry.transferKey = key;
    const early = earlyStarts.get(key);
    earlyStarts.delete(key);
    if (early && now() - early.at <= transferWindowMs) { bind(entry, early); return; }
    pending.set(key, handle.id);
    entry.timer = setTimeout(() => releaseEntry(handle.id), transferWindowMs); // the job never started
    entry.timer.unref();
  }

  function noteJobStarted({ sessionId, toolCallId, jobId, pid } = {}) {
    if (!jobId) return;
    const key = `${sessionId}\n${toolCallId}`;
    const entry = handles.get(pending.get(key));
    if (entry) { bind(entry, { jobId, pid }); return; }
    earlyStarts.delete(key);
    earlyStarts.set(key, { jobId, pid, at: now() });
    while (earlyStarts.size > MAX_EARLY_STARTS) earlyStarts.delete(earlyStarts.keys().next().value);
  }

  function noteJobSettled({ jobId } = {}) {
    const id = jobs.get(jobId);
    if (id) releaseEntry(id);
  }

  // Row 100 P2: who holds the work, for the waiting line, the rail and the session directory. Chats come
  // first (they can be named and opened), then queue order; one command holding tickets in two lease roots
  // counts once. `what` is the overlapping work, except that an overlap on `deps` alone reads as the
  // holder's own work, so a test run sharing `deps` reads as tests, not as an install.
  function describeHolders(resources) {
    try {
      const holders = [];
      const seen = new Set();
      const owners = new Set();
      const jobOf = new Map();
      for (const { handle, jobId } of handles.values()) {
        if (jobId) for (const { leaseRoot, ticket } of handle.tickets) jobOf.set(`${leaseRoot}\n${ticket}`, jobId);
      }
      for (const [leaseRoot, entries] of groupByRoot(resources)) {
        const keys = new Set(entries.map((entry) => entry.key));
        const { all } = storeFor(leaseRoot).hypothetical(entries);
        for (const ticket of all) {
          const id = `${leaseRoot}\n${ticket.ticket}`;
          if (ticket.state !== 'held' || ticket.enforcement !== 'blocking' || seen.has(id)
            || !ticket.resources.some((resource) => keys.has(resource.key))) continue;
          seen.add(id);
          const owner = ticket.owner || {};
          const who = ticket.synthetic ? id : [owner.app, owner.profile, owner.session, owner.pid, owner.host?.name].join('\n');
          if (owners.has(who)) continue;
          owners.add(who);
          const ours = owner.app === OWNER_APP && owner.profile === profile;
          const kindsOf = (list) => new Set(list.map((resource) => String(resource.key).split('@')[0]));
          const overlap = kindsOf(ticket.resources.filter((resource) => keys.has(resource.key)));
          const kinds = overlap.has('tests') || overlap.has('git-write') ? overlap : kindsOf(ticket.resources);
          holders.push(Object.freeze({ session_id: ours ? owner.session || null : null, status: 'active',
            quarantined_at: null, app: owner.app || null, label: owner.label ?? null, ours,
            pid: Number.isSafeInteger(owner.pid) && owner.pid > 0 ? owner.pid : null, seq: ticket.seq,
            what: kinds.has('tests') ? 'tests' : kinds.has('git-write') ? 'git_change' : kinds.has('deps') ? 'install' : null,
            job_id: ours ? jobOf.get(id) || null : null }));
        }
      }
      return holders.sort((a, b) => Number(!a.session_id) - Number(!b.session_id) || a.seq - b.seq);
    } catch (error) {
      warn('work_leases.describe_failed', { reason: error.message });
      return [];
    }
  }

  function onChange(listener) {
    if (typeof listener !== 'function') throw new TypeError('work_leases_listener_invalid');
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function close() {
    closed = true;
    clearTimeout(notifyTimer);
    clearTimeout(pollTimer);
    clearInterval(sweepTimer);
    notifyTimer = null;
    pollTimer = null;
    sweepTimer = null;
    // A running job's tickets stay: its pid, not this app, decides them from here on.
    for (const [id, entry] of [...handles]) if (!entry.jobId) releaseEntry(id); else clearTimeout(entry.timer);
    for (const entry of stores.values()) closeEntry(entry);
    handles.clear();
    brokenUntil.clear();
    stores.clear();
    pending.clear();
    earlyStarts.clear();
    jobs.clear();
    listeners.clear();
  }

  return Object.freeze({ resourcesFor, wouldBlock, hold, release, transferToJob, noteJobStarted,
    noteJobSettled, describeHolders, onChange, close });
}

module.exports = { createWorkLeaseAdapter };
