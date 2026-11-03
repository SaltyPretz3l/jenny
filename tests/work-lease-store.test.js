'use strict';
// WorkLeaseStore: guard, sequence, publish/grant/release, reclaim, prune, synthetic holders,
// heartbeat, watch and waiting, against real temp directories with an injected pid probe.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { removeTreeSync } = require('../services/fs-remove-no-follow');
const {
  WorkLeaseInfraError, WorkLeaseStore, computeGrants, createDefaultProbe, createDeferredStartProbe, createResumeDetector,
  findRepository, normalizePathForKey, readStartTimeAsync, resolveLeaseScope, serializeTicket, waitForGrant,
} = require('../services/work-leases');

const HOST = Object.freeze({ name: 'testhost', boot: 1000 });
const TESTS_KEY = 'tests@tree:g:/repo';
const EXCLUSIVE = Object.freeze([{ key: TESTS_KEY, units: 'all', capacity: 1 }]);

function tempDir(t, prefix = 'work-lease-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTreeSync(dir));
  return dir;
}

function fakeProbe(alive = []) {
  const pids = new Set(alive);
  return { available: true, alive: (pid) => pids.has(pid), startTime: () => null, pids };
}

function harness(t, { pids = [101, 102, 103], root, extra = {} } = {}) {
  const leaseRoot = root || path.join(tempDir(t), 'leases');
  const probe = fakeProbe(pids);
  const clock = { t: 5000 };
  const stores = [];
  const open = (pid, more = {}) => {
    const store = new WorkLeaseStore({
      leaseRoot, me: HOST, probe, ownPid: pid, ownStart: null, now: () => clock.t, ...extra, ...more,
    });
    stores.push(store);
    return store;
  };
  t.after(() => stores.forEach((s) => s.close()));
  return { leaseRoot, probe, clock, open, ticketsDir: path.join(leaseRoot, 'tickets') };
}

const publish = (store, resources = EXCLUSIVE, app = 'test') => store.publish({ resources, owner: { app, label: 'npm test' } });
const ticketFiles = (dir) => fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();

function writeRawTicket(ticketsDir, { seq, id, pid = 101, state = 'held', resources = EXCLUSIVE, heartbeat = 5000 }) {
  fs.mkdirSync(ticketsDir, { recursive: true });
  const ticket = {
    ticket: id, seq, state, enforcement: 'blocking', resources,
    owner: { app: 'raw', pid, pid_start: null, host: HOST, profile: null, session: null, label: null },
    purpose: null, created_at: heartbeat, granted_at: null, heartbeat_at: heartbeat,
  };
  const file = path.join(ticketsDir, `${String(seq).padStart(12, '0')}-${id}.json`);
  fs.writeFileSync(file, serializeTicket(ticket));
  return file;
}

const hexId = (n) => n.toString(16).padStart(16, '0');
const age = (file, seconds) => {
  const when = new Date(Date.now() - seconds * 1000);
  fs.utimesSync(file, when, when);
};

test('publish grants a free resource, release deletes the file and is idempotent', (t) => {
  const h = harness(t);
  const a = h.open(101);
  const { ticket, granted } = publish(a);
  assert.equal(granted, true);
  assert.equal(ticket.state, 'held');
  assert.equal(ticket.seq, 1);
  assert.equal(ticket.owner.label, 'npm test');
  assert.equal(ticketFiles(h.ticketsDir).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.ticketsDir, ticketFiles(h.ticketsDir)[0]), 'utf8')).state, 'held');
  assert.equal(a.attempt(ticket.ticket), true);
  a.release(ticket.ticket);
  assert.equal(ticketFiles(h.ticketsDir).length, 0);
  a.release(ticket.ticket); // missing file is not an error
  assert.equal(fs.readFileSync(path.join(h.leaseRoot, 'seq'), 'utf8'), '1\n');
});

test('publish rejects malformed requests and one store cannot release another store tickets', (t) => {
  const h = harness(t);
  const a = h.open(101);
  const b = h.open(102);
  assert.throws(() => a.publish({ resources: [] }), TypeError);
  assert.throws(() => a.publish({ resources: [{ key: 'no-scope', units: 'all' }] }), TypeError);
  assert.throws(() => a.publish({ resources: [{ key: TESTS_KEY, units: 0 }] }), TypeError);
  const { ticket } = publish(a);
  b.release(ticket.ticket);
  assert.equal(ticketFiles(h.ticketsDir).length, 1);
});

test('FIFO across two stores with different owner pids', (t) => {
  const h = harness(t);
  const a = h.open(101);
  const b = h.open(102);
  const c = h.open(103);
  const first = publish(a);
  const second = publish(b);
  const third = publish(c);
  assert.deepEqual([first.granted, second.granted, third.granted], [true, false, false]);
  assert.deepEqual([first.ticket.seq, second.ticket.seq, third.ticket.seq], [1, 2, 3]);
  assert.equal(c.attempt(third.ticket.ticket), false);
  a.release(first.ticket.ticket);
  assert.equal(c.attempt(third.ticket.ticket), false, 'the older waiter goes first');
  assert.equal(b.attempt(second.ticket.ticket), true);
  assert.equal(c.attempt(third.ticket.ticket), false);
  b.release(second.ticket.ticket);
  assert.equal(c.attempt(third.ticket.ticket), true);
});

test('a ticket whose owner is dead is reclaimed', (t) => {
  const h = harness(t);
  const a = h.open(101);
  const b = h.open(102);
  publish(a);
  const waiting = publish(b);
  assert.equal(waiting.granted, false);
  h.probe.pids.delete(101);
  assert.equal(b.attempt(waiting.ticket.ticket), true);
  assert.equal(ticketFiles(h.ticketsDir).length, 1);
});

test('corrupt files are pruned after 10 s and temp files after 60 s; unknown files stay', (t) => {
  const h = harness(t);
  const a = h.open(101);
  fs.mkdirSync(h.ticketsDir, { recursive: true });
  const freshCorrupt = path.join(h.ticketsDir, `000000000050-${hexId(1)}.json`);
  const oldCorrupt = path.join(h.ticketsDir, `000000000051-${hexId(2)}.json`);
  fs.writeFileSync(freshCorrupt, '{"v":1,');
  fs.writeFileSync(oldCorrupt, '{"v":1,');
  age(oldCorrupt, 11);
  const oldTemp = path.join(h.ticketsDir, `.000000000049-${hexId(3)}.json.tmp-1-abc`);
  const youngTemp = path.join(h.ticketsDir, `.000000000049-${hexId(4)}.json.tmp-1-abc`);
  fs.writeFileSync(oldTemp, 'x');
  fs.writeFileSync(youngTemp, 'x');
  age(oldTemp, 61);
  age(youngTemp, 30);
  const foreign = path.join(h.ticketsDir, 'notes.txt');
  fs.writeFileSync(foreign, 'keep');
  assert.equal(publish(a).granted, true, 'corrupt files never block');
  assert.equal(fs.existsSync(freshCorrupt), true);
  assert.equal(fs.existsSync(oldCorrupt), false);
  assert.equal(fs.existsSync(oldTemp), false);
  assert.equal(fs.existsSync(youngTemp), true);
  assert.equal(fs.existsSync(foreign), true);
});

test('a stranded guard is reclaimed; a fresh guard times out as an infrastructure failure', (t) => {
  const h = harness(t);
  const a = h.open(101);
  fs.mkdirSync(path.join(h.leaseRoot, 'guard.lock'), { recursive: true });
  age(path.join(h.leaseRoot, 'guard.lock'), 11);
  assert.equal(publish(a).granted, true);
  assert.equal(fs.existsSync(path.join(h.leaseRoot, 'guard.lock')), false);

  fs.mkdirSync(path.join(h.leaseRoot, 'guard.lock'));
  const started = Date.now();
  assert.throws(() => publish(a), (error) => error instanceof WorkLeaseInfraError && error.reason === 'guard_timeout');
  assert.ok(Date.now() - started >= 1900, 'waits about 2 s before giving up');
  fs.rmdirSync(path.join(h.leaseRoot, 'guard.lock'));
});

test('256 ticket files refuse a publish with a capacity failure', (t) => {
  const h = harness(t);
  const a = h.open(101);
  for (let seq = 1; seq <= 256; seq += 1) {
    writeRawTicket(h.ticketsDir, { seq, id: hexId(seq), resources: [{ key: `deps@tree:g:/r${seq}`, units: 1, capacity: null }] });
  }
  assert.throws(() => publish(a), (error) => error instanceof WorkLeaseInfraError && error.reason === 'capacity');
  fs.unlinkSync(path.join(h.ticketsDir, ticketFiles(h.ticketsDir)[0]));
  assert.equal(publish(a).granted, true);
});

test('a corrupt or missing seq file recovers from the largest readable ticket', (t) => {
  const h = harness(t);
  const a = h.open(101);
  writeRawTicket(h.ticketsDir, { seq: 7, id: hexId(7), resources: [{ key: 'deps@tree:g:/other', units: 1, capacity: null }] });
  fs.writeFileSync(path.join(h.leaseRoot, 'seq'), 'garbage');
  assert.equal(publish(a).ticket.seq, 8);
  assert.equal(fs.readFileSync(path.join(h.leaseRoot, 'seq'), 'utf8'), '8\n');
  fs.unlinkSync(path.join(h.leaseRoot, 'seq'));
  assert.equal(publish(a, [{ key: 'deps@tree:g:/o2', units: 1, capacity: null }]).ticket.seq, 9);
  fs.writeFileSync(path.join(h.leaseRoot, 'seq'), '3\n');
  assert.equal(publish(a, [{ key: 'deps@tree:g:/o3', units: 1, capacity: null }]).ticket.seq, 10, 'a seq file behind the tickets never reuses a number');

  const empty = harness(t);
  assert.equal(publish(empty.open(101)).ticket.seq, 1);
});

test('rename is retried on EPERM, then gives up as an io_error', (t) => {
  let failures = 2;
  const flaky = (from, to) => {
    if (failures > 0) { failures -= 1; throw Object.assign(new Error('busy'), { code: 'EPERM' }); }
    return fs.renameSync(from, to);
  };
  const h = harness(t, { extra: { renameSync: flaky } });
  assert.equal(publish(h.open(101)).granted, true);
  assert.equal(failures, 0);

  const hard = harness(t, { extra: { renameSync: () => { throw Object.assign(new Error('denied'), { code: 'EXDEV' }); } } });
  assert.throws(() => publish(hard.open(101)), (error) => error instanceof WorkLeaseInfraError && error.reason === 'io_error');
  assert.deepEqual(fs.readdirSync(hard.ticketsDir), [], 'no temp file is left behind');
});

test('a live .test-run.lock blocks a tests take; a dead or missing one does not', (t) => {
  const tree = tempDir(t, 'work-lease-tree-');
  const key = `tests@tree:${normalizePathForKey(fs.realpathSync(tree), process.platform)}`;
  const h = harness(t, { pids: [101, process.pid] });
  const a = h.open(101);
  const lock = path.join(tree, '.test-run.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const { ticket, granted } = publish(a, [{ key, units: 'all', capacity: 1 }]);
  assert.equal(granted, false);
  assert.ok(a.snapshot().tickets.some((x) => x.synthetic && x.resources[0].key === key));
  assert.deepEqual(a.blockersFor(ticket.ticket).map((x) => x.synthetic), [true]);
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999 }));
  assert.equal(a.attempt(ticket.ticket), true);
  a.release(ticket.ticket);
  fs.unlinkSync(lock);
  const again = publish(a, [{ key, units: 'all', capacity: 1 }]);
  assert.equal(again.granted, true);
  a.release(again.ticket.ticket);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  age(lock, 61 * 60);
  assert.equal(publish(a, [{ key, units: 'all', capacity: 1 }]).granted, true, 'a lock older than an hour is stale even with a live pid');
});

test('a fresh index.lock blocks git-write; one older than 30 s is ignored', (t) => {
  const common = path.join(tempDir(t), 'repo.git');
  const root = path.join(common, 'jenny', 'leases', 'v1');
  const h = harness(t, { root });
  const a = h.open(101);
  fs.mkdirSync(common, { recursive: true });
  const index = path.join(common, 'index.lock');
  fs.writeFileSync(index, '');
  const git = [{ key: 'git-write@repo', units: 'all', capacity: 1 }];
  const first = publish(a, git);
  assert.equal(first.granted, false);
  age(index, 31);
  assert.equal(a.attempt(first.ticket.ticket), true);
  a.release(first.ticket.ticket);

  const worktreeLock = path.join(common, 'worktrees', 'wt1', 'index.lock');
  fs.mkdirSync(path.dirname(worktreeLock), { recursive: true });
  fs.writeFileSync(worktreeLock, '');
  assert.equal(publish(a, git).granted, false, 'a linked worktree index.lock counts too');
});

test('watch fires when another instance publishes, and falls back to polling when fs.watch throws', async (t) => {
  const h = harness(t);
  const a = h.open(101);
  const b = h.open(102);
  const changed = new Promise((resolve) => { b.watch(resolve); });
  publish(a);
  await Promise.race([changed, new Promise((_, reject) => setTimeout(() => reject(new Error('no watch event')), 3000))]);

  t.mock.method(fs, 'watch', () => { throw new Error('watch unavailable'); });
  const polled = new Promise((resolve) => { b.watch(resolve); });
  // A raw write bypasses the in-process notifier, so only the 3 s poll can see it.
  writeRawTicket(h.ticketsDir, { seq: 50, id: hexId(50), resources: [{ key: 'deps@tree:g:/x', units: 1, capacity: null }] });
  await Promise.race([polled, new Promise((_, reject) => setTimeout(() => reject(new Error('no poll event')), 6000))]);
});

test('heartbeat refreshes own tickets and reports a deleted one as lost', (t) => {
  const lost = [];
  const h = harness(t, { extra: { onLost: (ids) => lost.push(...ids) } });
  const a = h.open(101);
  const { ticket } = publish(a);
  const file = path.join(h.ticketsDir, ticketFiles(h.ticketsDir)[0]);
  h.clock.t = 5010;
  assert.deepEqual(a.heartbeat(), { refreshed: 1, lost: [] });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).heartbeat_at, 5010);
  fs.unlinkSync(file);
  assert.deepEqual(a.heartbeat(), { refreshed: 0, lost: [ticket.ticket] });
  assert.deepEqual(lost, [ticket.ticket]);
  assert.deepEqual(a.heartbeat(), { refreshed: 0, lost: [] });
  a.startHeartbeat(50);
  a.close();
});

test('blockersFor names holders and earlier waiters; snapshot lists tickets and grants', (t) => {
  const h = harness(t);
  const a = h.open(101);
  const b = h.open(102);
  const c = h.open(103);
  const holder = publish(a);
  const second = publish(b);
  const third = publish(c);
  assert.deepEqual(a.blockersFor(holder.ticket.ticket), []);
  assert.deepEqual(b.blockersFor(second.ticket.ticket).map((x) => x.ticket), [holder.ticket.ticket]);
  assert.deepEqual(c.blockersFor(third.ticket.ticket).map((x) => x.ticket).sort(),
    [holder.ticket.ticket, second.ticket.ticket].sort());
  assert.deepEqual(a.blockersFor('ffffffffffffffff'), []);
  const snapshot = a.snapshot();
  assert.deepEqual(snapshot.tickets.map((x) => x.seq), [1, 2, 3]);
  assert.deepEqual(snapshot.grants, []);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.tickets));
});

test('attempt on a waiting ticket that was deleted fails open', (t) => {
  const h = harness(t);
  const a = h.open(101);
  const b = h.open(102);
  publish(a);
  const waiting = publish(b);
  fs.unlinkSync(path.join(h.ticketsDir, ticketFiles(h.ticketsDir)[1]));
  assert.throws(() => b.attempt(waiting.ticket.ticket), (error) => error instanceof WorkLeaseInfraError);
  assert.throws(() => b.attempt(waiting.ticket.ticket), (error) => error instanceof WorkLeaseInfraError,
    'a forgotten ticket keeps failing, so a waiter rejects instead of polling forever');
});

test('an unreachable lease root fails at once instead of retrying the guard', (t) => {
  const base = tempDir(t);
  const blocker = path.join(base, 'file');
  fs.writeFileSync(blocker, 'not a directory');
  const store = new WorkLeaseStore({ leaseRoot: path.join(blocker, 'leases'), me: HOST, probe: fakeProbe([101]), ownPid: 101, ownStart: null });
  const started = Date.now();
  assert.throws(() => publish(store), (error) => error instanceof WorkLeaseInfraError && error.reason === 'io_error');
  assert.ok(Date.now() - started < 1000, 'no guard retries on an unusable root');
  t.after(() => store.close());
});

test('a removed lease root is recreated within the guard budget', (t) => {
  const h = harness(t);
  const a = h.open(101);
  const first = publish(a).ticket;
  a.release(first.ticket);
  removeTreeSync(h.leaseRoot);
  assert.equal(publish(a).granted, true);
});

test('waitForGrant resolves on release (woken early) and on abort', async (t) => {
  const h = harness(t);
  const a = h.open(101);
  const b = h.open(102);
  const holder = publish(a);
  const waiting = publish(b);
  const started = Date.now();
  const wait = waitForGrant(b, waiting.ticket.ticket, { pollMs: 5000, maxPollMs: 5000 });
  setTimeout(() => a.release(holder.ticket.ticket), 100);
  assert.equal(await wait, true);
  assert.ok(Date.now() - started < 3000, 'woken by the change, not the 5 s poll');

  const c = h.open(103);
  const blocked = publish(c);
  const controller = new AbortController();
  const aborted = waitForGrant(c, blocked.ticket.ticket, { signal: controller.signal, pollMs: 20 });
  setTimeout(() => controller.abort(), 60);
  assert.equal(await aborted, false);
  assert.equal(await waitForGrant(c, blocked.ticket.ticket, { signal: AbortSignal.abort() }), false);
});

test('close stops watchers and the timer but leaves tickets in place', (t) => {
  const h = harness(t);
  const a = h.open(101);
  publish(a);
  a.startHeartbeat(20);
  let fired = 0;
  a.watch(() => { fired += 1; });
  a.close();
  assert.equal(ticketFiles(h.ticketsDir).length, 1);
  return new Promise((resolve) => setTimeout(() => { assert.equal(fired, 0); resolve(); }, 150));
});

test('findRepository reads main and linked worktree layouts without spawning git', (t) => {
  const base = fs.realpathSync(tempDir(t));
  const main = path.join(base, 'main');
  const commonDir = path.join(main, '.git');
  fs.mkdirSync(path.join(commonDir, 'worktrees', 'wt'), { recursive: true });
  fs.mkdirSync(path.join(main, 'src', 'deep'), { recursive: true });
  assert.deepEqual(findRepository(path.join(main, 'src', 'deep')), { treeRoot: main, gitCommonDir: commonDir });

  const linked = path.join(base, 'linked');
  fs.mkdirSync(path.join(linked, 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(linked, '.git'), `gitdir: ${path.join(commonDir, 'worktrees', 'wt')}\n`);
  fs.writeFileSync(path.join(commonDir, 'worktrees', 'wt', 'commondir'), '../..\n');
  assert.deepEqual(findRepository(path.join(linked, 'pkg')), { treeRoot: linked, gitCommonDir: commonDir });

  const broken = path.join(base, 'broken');
  fs.mkdirSync(broken);
  fs.writeFileSync(path.join(broken, '.git'), 'not a gitdir line\n');
  assert.equal(findRepository(broken), null);
});

test('resolveLeaseScope caches per directory and falls back to the user cache outside a repository', (t) => {
  const dir = fs.realpathSync(tempDir(t));
  fs.mkdirSync(path.join(dir, '.git'));
  const cache = new Map();
  let walks = 0;
  const counted = (start) => { walks += 1; return findRepository(start); };
  const scope = resolveLeaseScope(dir, { findRepository: counted, cache });
  assert.equal(scope.isRepo, true);
  assert.equal(scope.leaseRoot, path.join(dir, '.git', 'jenny', 'leases', 'v1'));
  assert.equal(scope.gitCommonDir, path.join(dir, '.git'));
  assert.equal(resolveLeaseScope(dir, { findRepository: counted, cache }), scope);
  assert.equal(walks, 1, 'the second call is served from the 30 s cache');

  const none = () => null;
  const plain = resolveLeaseScope(dir, {
    findRepository: none, cache: new Map(), platform: 'linux', env: { XDG_CACHE_HOME: '/xdg' }, homedir: '/home/u',
  });
  assert.equal(plain.isRepo, false);
  assert.equal(plain.gitCommonDir, null);
  assert.match(plain.leaseRoot.replace(/\\/gu, '/'), /^\/xdg\/jenny\/leases\/v1\/[0-9a-f]{16}$/u);
  const windows = resolveLeaseScope(dir, {
    findRepository: none, cache: new Map(), platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, homedir: 'C:\\Users\\u',
  });
  assert.match(windows.leaseRoot, /^C:\\Users\\u\\AppData\\Local\\Jenny\\leases\\v1\\[0-9a-f]{16}$/u);
  const failing = resolveLeaseScope(dir, {
    findRepository: () => { throw new Error('EACCES'); }, cache: new Map(), platform: 'linux', env: {}, homedir: '/home/u',
  });
  assert.equal(failing.isRepo, false, 'a discovery failure degrades to the per-folder root');
});

test('default probe: pid liveness and Linux start-time parsing', () => {
  const probe = createDefaultProbe();
  assert.equal(probe.alive(process.pid), true);
  assert.equal(probe.alive(0), false);
  assert.equal(probe.alive(2 ** 22 + 12345), false);
  const stat = '42 (my (odd) cmd) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 1000 23 24';
  const files = { '/proc/42/stat': stat, '/proc/stat': 'cpu 1 2\nbtime 1700000000\n' };
  const linux = createDefaultProbe({ platform: 'linux', fs: { readFileSync: (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; } } });
  assert.equal(linux.startTime(42), 1700000010);
  assert.equal(linux.startTime(43), null);
  const mac = createDefaultProbe({ platform: 'darwin', spawnSync: () => ({ status: 0, stdout: 'Sat Nov  1 10:00:00 2026\n' }) });
  assert.equal(mac.startTime(5), new Date('Sat Nov  1 10:00:00 2026').getTime() / 1000);
  let spawned = 0;
  const win = createDefaultProbe({ platform: 'win32', spawnSync: () => { spawned += 1; return { status: 0, stdout: '2026-11-01T10:00:00.1234567Z\n' }; } });
  assert.equal(win.startTime(7), Date.parse('2026-11-01T10:00:00.123Z') / 1000);
  win.startTime(7);
  assert.equal(spawned, 1, 'start times are cached per pid');
  assert.equal(createDefaultProbe({ platform: 'win32', spawnSync: () => ({ status: 1, stdout: '' }) }).startTime(7), null);
});

test('the deferred start probe answers unknown at once and the background read afterwards', async () => {
  let reads = 0;
  let finish;
  const clock = { t: 0 };
  const probe = createDeferredStartProbe({ available: true, alive: (pid) => pid === 7 },
    (pid) => { reads += 1; return new Promise((resolve) => { finish = () => resolve(pid * 10); }); }, { nowMs: () => clock.t });
  assert.equal(probe.alive(7), true);
  assert.equal(probe.startTime(7), null);
  assert.equal(probe.startTime(7), null, 'one read in flight per pid');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probe.startTime(7), 70);
  clock.t = 61_000;
  assert.equal(probe.startTime(7), 70, 'a stale value is served while it is re-read');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 2);
  assert.equal(probe.startTime(0), null);
  assert.equal(await readStartTimeAsync(5, { platform: 'linux' }), null, 'only Windows needs the background read');
  const fake = (cmd, args, opts, cb) => cb(null, '2026-11-01T10:00:00.0000000Z\n');
  assert.equal(await readStartTimeAsync(5, { platform: 'win32', execFile: fake }), Date.parse('2026-11-01T10:00:00Z') / 1000);
  assert.equal(await readStartTimeAsync(5, { platform: 'win32', execFile: (c, a, o, cb) => cb(new Error('gone')) }), null);
});

test('resume detector reports a wall-clock jump the monotonic clock did not see', () => {
  const clocks = { wall: 1_000_000, mono: 5_000 };
  const detector = createResumeDetector({ wallMs: () => clocks.wall, monoMs: () => clocks.mono });
  assert.equal(detector.resumedRecently(), false);
  clocks.wall += 10_000; clocks.mono += 10_000;
  assert.equal(detector.resumedRecently(), false);
  clocks.wall += 3_600_000; clocks.mono += 1_000; // slept for an hour
  assert.equal(detector.resumedRecently(), true);
  clocks.wall += 59_000; clocks.mono += 59_000;
  assert.equal(detector.resumedRecently(), true);
  clocks.wall += 2_000; clocks.mono += 2_000;
  assert.equal(detector.resumedRecently(), false);
  detector.start(10);
  detector.stop();
});

test('reown rebinds a held ticket to a child pid so liveness follows it', (t) => {
  const h = harness(t, { pids: [101, 102, 103] });
  const a = h.open(101);
  const b = h.open(102);
  const first = publish(a).ticket;
  const waiting = publish(b).ticket;
  assert.equal(a.reown(first.ticket, { pid: 103, pidStart: 77.5 }), true);
  const record = JSON.parse(fs.readFileSync(path.join(h.ticketsDir, ticketFiles(h.ticketsDir)[0]), 'utf8'));
  assert.equal(record.owner.pid, 103);
  assert.equal(record.owner.pid_start, 77.5);
  assert.equal(record.state, 'held');
  assert.equal(record.owner.app, 'test');
  assert.equal(record.owner.label, 'npm test');
  a.heartbeat(); // later rewrites keep the new owner
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.ticketsDir, ticketFiles(h.ticketsDir)[0]), 'utf8')).owner.pid, 103);
  assert.equal(a.reown(first.ticket, { pid: 104 }), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.ticketsDir, ticketFiles(h.ticketsDir)[0]), 'utf8')).owner.pid_start, null);
  assert.equal(a.reown(first.ticket, { pid: 0 }), false);
  assert.equal(a.reown(first.ticket, {}), false);
  assert.equal(a.reown('f'.repeat(16), { pid: 103 }), false, 'a ticket this store does not own');
  assert.equal(a.reown(waiting.ticket, { pid: 103 }), false, 'a store never rewrites another store ticket');
  assert.equal(b.reown(waiting.ticket, { pid: 103 }), false, 'a waiting ticket is not reowned');
  h.probe.pids.add(104);
  h.probe.pids.delete(101);
  assert.equal(b.attempt(waiting.ticket), false, 'the child pid is alive, so the lease stands');
  h.probe.pids.delete(104); // the child exited
  assert.equal(b.attempt(waiting.ticket), true);
  assert.equal(ticketFiles(h.ticketsDir).length, 1);
});

test('heartbeat rewrites do not wake watchers; a new ticket file does', async (t) => {
  const h = harness(t);
  const a = h.open(101);
  publish(a);
  const b = h.open(102);
  let fired = 0;
  b.watch(() => { fired += 1; });
  a.heartbeat();
  a.heartbeat();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fired, 0, 'in-place rewrites keep the set of ticket files');
  writeRawTicket(h.ticketsDir, { seq: 50, id: hexId(50), resources: [{ key: 'deps@tree:g:/x', units: 1, capacity: null }] });
  for (let waited = 0; fired === 0 && waited < 5000; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fired > 0, 'a new ticket file wakes the watcher');
});

test('viewCacheMs reuses a directory read until a write or an in-process change invalidates it', (t) => {
  const h = harness(t);
  const a = h.open(101, { viewCacheMs: 60_000 });
  const b = h.open(102);
  assert.equal(a.snapshot().tickets.length, 0);
  writeRawTicket(h.ticketsDir, { seq: 40, id: hexId(40), pid: 103, resources: [{ key: 'deps@tree:g:/x', units: 1, capacity: null }] });
  assert.equal(a.snapshot().tickets.length, 0, 'served from the cache');
  publish(a);
  assert.equal(a.snapshot().tickets.length, 2, 'a guarded write drops the cache');
  a.watch(() => {});
  publish(b);
  assert.equal(a.snapshot().tickets.length, 3, 'another store in this process drops it through the notifier');
});

test('hypothetical places a waiting ticket after the live ones without writing it', (t) => {
  const h = harness(t);
  const a = h.open(101);
  const held = publish(a).ticket;
  const { seq, all } = h.open(102).hypothetical(EXCLUSIVE);
  assert.equal(seq, held.seq + 1);
  assert.equal(computeGrants(all).includes(seq), false, 'blocked behind the holder');
  assert.equal(ticketFiles(h.ticketsDir).length, 1);
  a.release(held.ticket);
  const free = h.open(103).hypothetical(EXCLUSIVE);
  assert.equal(computeGrants(free.all).includes(free.seq), true);
});

test('guardTimeoutMs bounds the wait for a busy guard', (t) => {
  const h = harness(t);
  const a = h.open(101, { guardTimeoutMs: 100 });
  fs.mkdirSync(path.join(h.leaseRoot, 'tickets'), { recursive: true });
  fs.mkdirSync(path.join(h.leaseRoot, 'guard.lock'));
  const started = Date.now();
  assert.throws(() => publish(a), (error) => error instanceof WorkLeaseInfraError && error.reason === 'guard_timeout');
  assert.ok(Date.now() - started < 1000, 'gives up after the shorter budget');
  fs.rmdirSync(path.join(h.leaseRoot, 'guard.lock'));
});
