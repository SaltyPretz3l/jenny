'use strict';
// The lease root: guard, sequence numbers, tickets, grant attempts, heartbeat, prune, synthetic
// legacy holders and change watching (protocol: "Directory layout" through "Synthetic external holders").
// Synchronous on purpose: guard sections are a few file operations. Waiting is the async part.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { computeGrants, blockersOf } = require('./grant');
const {
  createDefaultProbe, createResumeDetector, hostIdentity, isTicketDead, legacyHolders, ownProcessStart,
} = require('./liveness');
const { deriveCommonDir, watchDirectory } = require('./paths');
const {
  MAX_TICKET_BYTES, WorkLeaseInfraError, buildTicketRecord, parseTicket, serializeTicket,
} = require('./record');

const GUARD_TIMEOUT_MS = 2_000;
const STRANDED_GUARD_MS = 10_000;
const WRITE_RETRY_MS = 2_000;
const MAX_TICKET_FILES = 256;
const CORRUPT_PRUNE_MS = 10_000;
const TEMP_PRUNE_MS = 60_000;
const FRESH_HEARTBEAT_S = 60;
const WATCH_DEBOUNCE_MS = 50;
const TICKET_FILE = /^(\d{12})-([0-9a-f]{16})\.json$/u;
const SHARING_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const buses = new Map(); // lease root -> in-process change listeners (waiters wake early on release)

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Windows sharing violations (a reader holds the file) are retried with backoff within the budget.
function retrySharing(fn, budgetMs) {
  const deadline = Date.now() + budgetMs;
  for (let delay = 5; ; delay = Math.min(delay * 2, 100)) {
    try {
      return fn();
    } catch (error) {
      if (!SHARING_ERRORS.has(error.code) || Date.now() >= deadline) throw error;
      sleepSync(delay);
    }
  }
}

const jitter = () => 5 + Math.floor(Math.random() * 21);
const isMissing = (error) => error && error.code === 'ENOENT';

class WorkLeaseStore {
  constructor(options = {}) {
    if (!options.leaseRoot) throw new TypeError('leaseRoot is required');
    this.leaseRoot = options.leaseRoot;
    this.ticketsDir = path.join(this.leaseRoot, 'tickets');
    this.guardPath = path.join(this.leaseRoot, 'guard.lock');
    this.seqPath = path.join(this.leaseRoot, 'seq');
    this.me = options.me || hostIdentity();
    this.probe = options.probe || createDefaultProbe();
    this.now = options.now || (() => Date.now() / 1000);
    this.resume = options.resume || createResumeDetector();
    this.ownPid = options.ownPid ?? process.pid;
    this.ownStart = options.ownStart !== undefined ? options.ownStart : ownProcessStart();
    this.log = options.log || (() => {});
    this.onLost = options.onLost || null;
    this.renameSync = options.renameSync || fs.renameSync;
    this.gitCommonDir = options.gitCommonDir !== undefined ? options.gitCommonDir : deriveCommonDir(this.leaseRoot);
    // A store on a UI thread passes smaller budgets: a busy root then fails open sooner.
    this.guardTimeoutMs = options.guardTimeoutMs ?? GUARD_TIMEOUT_MS;
    this.writeRetryMs = options.writeRetryMs ?? WRITE_RETRY_MS;
    this.viewCacheMs = options.viewCacheMs ?? 0; // read-only views reuse one directory read this long
    this.legacyCacheMs = options.legacyCacheMs ?? 0; // and one legacy-lock scan this long
    this._own = new Map(); // ticket id -> { file, record }: the only tickets this store rewrites
    this._unwatch = new Set();
    this._timer = null;
    this._ready = false;
    this._viewCache = null;
    this._legacyCache = null;
  }

  get ownedCount() {
    return this._own.size;
  }

  publish({ resources, owner = {}, purpose = null } = {}) {
    const record = buildTicketRecord({
      resources, owner, purpose, pid: this.ownPid, pidStart: this.ownStart, host: this.me,
    });
    try {
      serializeTicket(record);
    } catch (error) {
      throw new TypeError(error.message, { cause: error });
    }
    return this._infra(() => this._withGuard(() => {
      const entries = this._readEntries();
      const { live, remaining } = this._prune(entries);
      if (remaining >= MAX_TICKET_FILES) {
        throw new WorkLeaseInfraError('capacity', `lease root has ${remaining} ticket files`);
      }
      const maxSeq = Math.max(0, ...entries.filter((e) => e.ticket).map((e) => e.ticket.seq));
      record.seq = this._readSeq(maxSeq) + 1;
      record.created_at = record.heartbeat_at = this.now();
      this._atomicWrite(this.seqPath, `${record.seq}\n`);
      const file = path.join(this.ticketsDir, `${String(record.seq).padStart(12, '0')}-${record.ticket}.json`);
      this._atomicWrite(file, serializeTicket(record));
      this._own.set(record.ticket, { file, record });
      const waiting = parseTicket(record).ticket;
      const granted = this._grantLocked(record.ticket, live.concat(waiting));
      this._notify();
      return { ticket: granted ? parseTicket(this._own.get(record.ticket).record).ticket : waiting, granted };
    }));
  }

  attempt(ticketId) {
    const own = this._own.get(ticketId);
    if (!own) throw new WorkLeaseInfraError('io_error', `ticket ${ticketId} is not owned by this store`);
    if (own.record.state === 'held') return true;
    return this._infra(() => this._withGuard(() => {
      if (!fs.existsSync(own.file)) {
        this._own.delete(ticketId);
        throw new WorkLeaseInfraError('io_error', `waiting ticket ${ticketId} was removed`);
      }
      return this._grantLocked(ticketId, this._prune(this._readEntries()).live);
    }));
  }

  release(ticketId) {
    const own = this._own.get(ticketId);
    if (!own) return; // never delete a ticket this store does not own
    this._own.delete(ticketId);
    try {
      this._withGuard(() => this._unlink(own.file));
    } catch (error) {
      this.log(`release without the guard: ${error.message}`);
      try { this._unlink(own.file); } catch (inner) { this.log(`release failed: ${inner.message}`); }
    }
    this._notify();
  }

  heartbeat() {
    if (this._own.size === 0) return { refreshed: 0, lost: [] };
    const result = this._infra(() => this._withGuard(() => {
      const heartbeatAt = this.now();
      const lost = [];
      let refreshed = 0;
      for (const [id, own] of [...this._own]) {
        if (!fs.existsSync(own.file)) {
          lost.push(id); // a process keeps running when its lease is lost
          this._own.delete(id);
          this.log(`work lease ${id} was removed while still owned`);
          continue;
        }
        own.record = { ...own.record, heartbeat_at: heartbeatAt };
        this._atomicWrite(own.file, serializeTicket(own.record));
        refreshed += 1;
      }
      return { refreshed, lost };
    }));
    if (result.lost.length && this.onLost) this.onLost(result.lost);
    return result;
  }

  reown(ticketId, { pid, pidStart } = {}) { // a background job's pid now decides this held ticket's liveness
    const own = this._own.get(ticketId);
    if (!own || own.record.state !== 'held' || !Number.isSafeInteger(pid) || pid < 1) return false;
    return this._infra(() => this._withGuard(() => {
      if (!fs.existsSync(own.file)) return false;
      own.record = { ...own.record, owner: { ...own.record.owner, pid, pid_start: pidStart ?? null } };
      this._atomicWrite(own.file, serializeTicket(own.record));
      return true;
    }));
  }

  startHeartbeat(intervalMs = 10_000) {
    if (this._timer) return;
    this._timer = setInterval(() => {
      try { this.heartbeat(); } catch (error) { this.log(`heartbeat failed: ${error.message}`); }
    }, intervalMs);
    this._timer.unref();
  }

  stopHeartbeat() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  snapshot() {
    const { all } = this._view();
    return Object.freeze({
      tickets: Object.freeze(all.slice().sort((a, b) => a.seq - b.seq)),
      grants: Object.freeze(computeGrants(all)),
    });
  }

  blockersFor(ticketId) {
    const { all } = this._view();
    const target = all.find((t) => t.ticket === ticketId);
    if (!target || target.state !== 'waiting') return [];
    return blockersOf(all, target.seq);
  }

  // Read-only "would a ticket for `takes` be granted now?": the live tickets, a waiting ticket for
  // `takes` after them, and the legacy holders that waiting ticket would see. Writes nothing.
  hypothetical(takes) {
    const { live } = this._view();
    const seq = Math.max(0, ...live.map((t) => t.seq)) + 1;
    const mine = Object.freeze({ ticket: 'hypothetical', seq, state: 'waiting', enforcement: 'blocking', resources: takes });
    const all = live.concat(mine);
    return { seq, all: this._legacyCached(all).concat(all) };
  }

  // onChange is debounced. File-system events fire it only when the set of ticket files changed:
  // heartbeats rewrite files in place, and only a new or removed ticket can change a grant.
  watch(onChange) {
    this._ensureDirs();
    let active = true;
    let debounce = null;
    const fire = () => {
      this._viewCache = null;
      if (!active || debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        if (!active) return;
        try { onChange(); } catch (error) { this.log(`watch callback failed: ${error.message}`); }
      }, WATCH_DEBOUNCE_MS);
      debounce.unref();
    };
    let names = this._ticketNames();
    const stopFs = watchDirectory(this.ticketsDir, () => {
      const next = this._ticketNames();
      if (next !== names) { names = next; fire(); }
    });
    if (!buses.has(this.leaseRoot)) buses.set(this.leaseRoot, new Set());
    buses.get(this.leaseRoot).add(fire);
    const unsubscribe = () => {
      if (!active) return;
      active = false;
      clearTimeout(debounce);
      stopFs();
      const bus = buses.get(this.leaseRoot);
      if (bus) { bus.delete(fire); if (!bus.size) buses.delete(this.leaseRoot); }
      this._unwatch.delete(unsubscribe);
    };
    this._unwatch.add(unsubscribe);
    return unsubscribe;
  }

  // Stops watchers and the heartbeat timer. Does not release tickets: the owner's process end does.
  close() {
    this.stopHeartbeat();
    for (const unsubscribe of [...this._unwatch]) unsubscribe();
  }

  _infra(fn) {
    try {
      return fn();
    } catch (error) {
      if (error instanceof WorkLeaseInfraError || error instanceof TypeError) throw error;
      throw new WorkLeaseInfraError('io_error', error.message, error);
    }
  }

  _notify() {
    this._viewCache = null;
    for (const fire of [...(buses.get(this.leaseRoot) || [])]) fire();
  }

  _ticketNames() {
    try {
      return fs.readdirSync(this.ticketsDir).filter((name) => TICKET_FILE.test(name)).sort().join('|');
    } catch {
      return '';
    }
  }

  _ensureDirs() {
    if (this._ready) return;
    fs.mkdirSync(this.ticketsDir, { recursive: true });
    if (process.platform !== 'win32') {
      for (let dir = this.leaseRoot, i = 0; i < 4; i += 1, dir = path.dirname(dir)) {
        if (path.basename(dir).toLowerCase() === 'jenny') {
          try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
          break;
        }
      }
    }
    this._ready = true;
  }

  _touchGuard() {
    const date = new Date();
    try { fs.utimesSync(this.guardPath, date, date); } catch { /* guard already gone */ }
  }

  // A guard older than 10 s was stranded by a killed writer. Rename is atomic, so only one waiter
  // claims it; if a fresh guard replaced it in between, hand it back.
  _removeStrandedGuard() {
    const claimed = `${this.guardPath}.stale-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    try {
      if (Date.now() - fs.statSync(this.guardPath).mtimeMs <= STRANDED_GUARD_MS) return;
      fs.renameSync(this.guardPath, claimed);
      if (Date.now() - fs.statSync(claimed).mtimeMs <= STRANDED_GUARD_MS) {
        try { fs.renameSync(claimed, this.guardPath); } catch { fs.rmdirSync(claimed); }
        return;
      }
      fs.rmdirSync(claimed);
      this.log('removed a stranded work-lease guard');
    } catch { /* another waiter won, or the guard vanished */ }
  }

  _withGuard(fn) {
    const deadline = Date.now() + this.guardTimeoutMs;
    for (;;) {
      this._ensureDirs(); // an unreachable or unwritable root throws here, without retrying
      try {
        fs.mkdirSync(this.guardPath);
        break;
      } catch (error) {
        if (isMissing(error)) this._ready = false; // the root was removed: recreate it
        else if (error.code === 'EEXIST') this._removeStrandedGuard();
        // EPERM/EACCES: Windows reports a delete-pending guard directory this way.
        else if (!SHARING_ERRORS.has(error.code)) throw error;
        if (Date.now() >= deadline) {
          throw new WorkLeaseInfraError('guard_timeout', `work-lease guard busy for ${this.guardTimeoutMs} ms`);
        }
        sleepSync(jitter());
      }
    }
    try {
      return fn();
    } finally {
      this._viewCache = null;
      try { retrySharing(() => fs.rmdirSync(this.guardPath), this.writeRetryMs); } catch { /* a stranded guard is reclaimed after 10 s */ }
    }
  }

  _atomicWrite(file, text) {
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    try {
      retrySharing(() => this.renameSync(tmp, file), this.writeRetryMs);
    } catch (error) {
      try { fs.unlinkSync(tmp); } catch { /* best effort */ }
      throw error;
    }
  }

  _unlink(file) {
    try {
      retrySharing(() => fs.unlinkSync(file), this.writeRetryMs);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  _readSeq(maxReadableSeq) {
    try {
      const match = /^\s*(\d+)\s*$/u.exec(fs.readFileSync(this.seqPath, 'utf8'));
      const value = match ? Number(match[1]) : NaN;
      if (Number.isSafeInteger(value)) return Math.max(value, maxReadableSeq);
    } catch (error) {
      if (!isMissing(error)) this.log(`seq unreadable: ${error.message}`);
    }
    return maxReadableSeq; // missing or corrupt: the largest readable ticket seq, or 0
  }

  // Ticket files only: { name, file, ticket } for valid ones, { corrupt, mtimeMs } for unreadable
  // ones, { temp } for in-flight writes. Unknown files in the directory are left alone.
  _readEntries(tolerant = false) {
    let names;
    try {
      names = fs.readdirSync(this.ticketsDir);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    const entries = [];
    for (const name of names) {
      const file = path.join(this.ticketsDir, name);
      if (name.startsWith('.') && name.includes('.tmp-')) { entries.push({ name, file, temp: true }); continue; }
      if (!TICKET_FILE.test(name)) continue;
      try {
        const stat = fs.statSync(file);
        const parsed = stat.size > MAX_TICKET_BYTES ? { ok: false } : parseTicket(fs.readFileSync(file, 'utf8'));
        entries.push(parsed.ok ? { name, file, ticket: parsed.ticket } : { name, file, corrupt: true, mtimeMs: stat.mtimeMs });
      } catch (error) {
        if (isMissing(error) || tolerant) continue;
        throw error;
      }
    }
    return entries;
  }

  _isDead(ticket, resumed) {
    const now = this.now();
    const fresh = Number.isFinite(ticket.heartbeat_at) && now - ticket.heartbeat_at <= FRESH_HEARTBEAT_S;
    // Start times can cost a helper process: read them only for stale heartbeats (own pid: known).
    const probe = {
      available: this.probe.available,
      alive: (pid) => this.probe.alive(pid),
      startTime: (pid) => (pid === this.ownPid ? this.ownStart : fresh ? null : this.probe.startTime(pid)),
    };
    return isTicketDead(ticket, { me: this.me, probe, now, observerResumedRecently: resumed });
  }

  // Deletes dead tickets, corrupt files older than 10 s and temp files older than 60 s.
  _prune(entries, remove = true) {
    const wall = Date.now();
    const resumed = this.resume.resumedRecently();
    const live = [];
    let remaining = 0;
    const drop = (file, why) => {
      if (!remove) return;
      try { this._unlink(file); this.log(`pruned ${why}: ${path.basename(file)}`); } catch (error) { this.log(`prune failed: ${error.message}`); }
    };
    for (const entry of entries) {
      let age;
      if (entry.temp) {
        try { age = wall - fs.statSync(entry.file).mtimeMs; } catch { continue; }
        if (age > TEMP_PRUNE_MS) drop(entry.file, 'temp file');
      } else if (entry.corrupt) {
        if (wall - entry.mtimeMs > CORRUPT_PRUNE_MS) drop(entry.file, 'corrupt ticket');
        else remaining += 1;
      } else {
        if (remove) this._touchGuard();
        if (this._isDead(entry.ticket, resumed)) {
          this._own.delete(entry.ticket.ticket);
          drop(entry.file, 'dead ticket');
        } else {
          live.push(entry.ticket);
          remaining += 1;
        }
      }
    }
    return { live, remaining };
  }

  _legacy(live) {
    return legacyHolders(live, { host: this.me, probe: this.probe, gitCommonDir: this.gitCommonDir });
  }

  // Inside the guard: grant this store's waiting ticket if the computation says so.
  _grantLocked(ticketId, live) {
    const own = this._own.get(ticketId);
    const mine = live.find((t) => t.ticket === ticketId);
    if (!own || !mine) return false;
    if (!computeGrants(this._legacy(live).concat(live)).includes(mine.seq)) return false;
    const grantedAt = this.now();
    own.record = { ...own.record, state: 'held', granted_at: grantedAt, heartbeat_at: grantedAt };
    this._atomicWrite(own.file, serializeTicket(own.record));
    return true;
  }

  // Grant decisions under the guard always rescan; read-only views may reuse a recent scan.
  _legacyCached(all) {
    const keys = all.filter((t) => t.state === 'waiting' && t.enforcement === 'blocking')
      .flatMap((t) => t.resources.map((r) => r.key)).sort().join('\n');
    const hit = this._legacyCache;
    if (hit && hit.keys === keys && Date.now() - hit.at < this.legacyCacheMs) return hit.holders;
    const holders = this._legacy(all);
    if (this.legacyCacheMs > 0) this._legacyCache = { keys, at: Date.now(), holders };
    return holders;
  }

  _view() {
    const hit = this._viewCache;
    if (hit && Date.now() - hit.at < this.viewCacheMs) return hit.value;
    const { live } = this._prune(this._readEntries(true), false);
    const value = { live, all: Object.freeze(this._legacyCached(live).concat(live)) };
    if (this.viewCacheMs > 0) this._viewCache = { at: Date.now(), value };
    return value;
  }
}

// Resolves true when the ticket is granted, false when the signal aborts. Polls 250 ms backing
// off to 1 s, and wakes early on store changes. Rejects on an infrastructure failure.
function waitForGrant(store, ticketId, { signal, pollMs = 250, maxPollMs = 1_000 } = {}) {
  return new Promise((resolve, reject) => {
    let delay = pollMs;
    let timer = null;
    let unwatch = null;
    let settled = false;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (unwatch) unwatch();
      if (signal) signal.removeEventListener('abort', onAbort);
      settle(value);
    };
    const onAbort = () => finish(resolve, false);
    const tick = () => {
      if (settled) return;
      clearTimeout(timer);
      try {
        if (store.attempt(ticketId)) return finish(resolve, true);
      } catch (error) {
        return finish(reject, error);
      }
      timer = setTimeout(tick, delay);
      delay = Math.min(delay * 2, maxPollMs);
      return undefined;
    };
    if (signal) {
      if (signal.aborted) return finish(resolve, false);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    unwatch = store.watch(() => { delay = pollMs; tick(); });
    return tick();
  });
}

module.exports = { WorkLeaseStore, WorkLeaseInfraError, waitForGrant };
