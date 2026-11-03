'use strict';
// Row 100: the broker-side work-lease adapter, against real WorkLeaseStores in temp directories.
// Two adapters with distinct pids stand in for two processes sharing one lease root.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { removeTreeSync } = require('../../services/fs-remove-no-follow');
const { createWorkLeaseAdapter } = require('../../services/session-runtime/work-lease-adapter');
const { WorkLeaseInfraError, WorkLeaseStore, normalizePathForKey } = require('../../services/work-leases');

const HOST = Object.freeze({ name: 'testhost', boot: 1000 });
const PLATFORM = process.platform;

function tempDir(t, prefix = 'work-lease-adapter-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => removeTreeSync(dir));
  return dir;
}

const waitFor = async (condition, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ticketFiles = (leaseRoot) => {
  try { return fs.readdirSync(path.join(leaseRoot, 'tickets')).filter((n) => n.endsWith('.json')); } catch { return []; }
};
const readTicket = (leaseRoot) => {
  const [name] = ticketFiles(leaseRoot);
  return JSON.parse(fs.readFileSync(path.join(leaseRoot, 'tickets', name), 'utf8'));
};

function fakeProbe(alive) {
  const pids = new Set(alive);
  return { available: true, alive: (pid) => pids.has(pid), startTime: () => null, pids };
}

// Classifier and scope fakes: every command is a test run in its cwd; one shared lease root.
function fakes(leaseRoot) {
  const classify = (command, options) => ({ label: command, takes: [
    { kind: 'tests', scope: 'tree', dir: options.cwd, units: 'all', capacity: 1, rule: 'x' },
    { kind: 'deps', scope: 'tree', dir: options.cwd, units: 1, capacity: null, rule: 'x' },
  ] });
  const resolveScope = (dir) => ({ leaseRoot, treeRoot: dir, gitCommonDir: null, isRepo: true });
  return { classify, resolveScope };
}

function makeAdapter(t, { leaseRoot, pid, probe, userDataPath = 'profile-one', logs = [], ...more }) {
  const adapter = createWorkLeaseAdapter({
    userDataPath,
    log: (level, event, details) => logs.push({ level, event, details }),
    createStore: (root) => new WorkLeaseStore({ leaseRoot: root, me: HOST, probe, ownPid: pid, ownStart: null }),
    ...fakes(leaseRoot),
    ...more,
  });
  t.after(() => adapter.close());
  return adapter;
}

function setup(t, adapterOptions = {}) {
  const leaseRoot = path.join(tempDir(t), 'leases');
  const workspace = tempDir(t, 'work-lease-ws-');
  const probe = fakeProbe([101, 102, 103]);
  const resources = { argumentsValue: { command: 'npm test' }, workspacePath: workspace };
  const open = (pid, more = {}) => makeAdapter(t, { leaseRoot, pid, probe, ...adapterOptions, ...more });
  return { leaseRoot, workspace, probe, resources, open };
}

test('two processes contend for one tree: the second waits, leaves no ticket, and wakes on release', async (t) => {
  const h = setup(t);
  const a = h.open(101);
  const b = h.open(102);
  const wanted = a.resourcesFor(h.resources);
  assert.equal(wanted.length, 2);
  assert.equal(a.wouldBlock(wanted), false);
  const held = a.hold({ ownerId: 'o-a', sessionId: 's-a', resources: wanted });
  assert.equal(held.status, 'granted');
  assert.ok(held.handle && held.handle.id);
  assert.equal(ticketFiles(h.leaseRoot).length, 1);

  assert.equal(b.wouldBlock(wanted), true);
  assert.deepEqual(b.hold({ ownerId: 'o-b', sessionId: 's-b', resources: wanted }), { status: 'waiting' });
  assert.equal(ticketFiles(h.leaseRoot).length, 1, 'a parked chat keeps no ticket');

  let fired = 0;
  const unsubscribe = b.onChange(() => { fired += 1; });
  a.release(held.handle);
  a.release(held.handle); // idempotent
  await waitFor(() => fired > 0);
  assert.equal(ticketFiles(h.leaseRoot).length, 0);
  assert.equal(b.wouldBlock(wanted), false);
  const second = b.hold({ ownerId: 'o-b', sessionId: 's-b', resources: wanted });
  assert.equal(second.status, 'granted');
  b.release(second.handle);
  unsubscribe();
  await sleep(100);
  fired = 0;
  await sleep(150);
  assert.equal(fired, 0, 'unsubscribed listeners are not called');
});

test('a parked chat re-checks on a timer while a block is recent, so a crashed holder is noticed', async (t) => {
  const h = setup(t);
  const a = h.open(101);
  const b = h.open(102, { blockedPollMs: 20 });
  const wanted = a.resourcesFor(h.resources);
  a.hold({ ownerId: 'o', sessionId: 's-a', resources: wanted });
  let fired = 0;
  b.onChange(() => { fired += 1; });
  assert.equal(b.wouldBlock(wanted), true);
  await waitFor(() => fired >= 2); // no file changed: the poll alone fired
  h.probe.pids.delete(101); // the holder crashed and deleted nothing
  assert.equal(b.wouldBlock(wanted), false);
  assert.equal(b.hold({ ownerId: 'o', sessionId: 's-b', resources: wanted }).status, 'granted');
});

test('the re-check slows down after a minute and stops ten minutes after the last block', async (t) => {
  const h = setup(t);
  const clock = { t: 1_000_000 };
  const a = h.open(101);
  const b = h.open(102, { blockedPollMs: 20, now: () => clock.t });
  const wanted = a.resourcesFor(h.resources);
  a.hold({ sessionId: 's-a', resources: wanted });
  let fired = 0;
  b.onChange(() => { fired += 1; });
  assert.equal(b.wouldBlock(wanted), true);
  await waitFor(() => fired >= 2);
  clock.t += 61_000; // still blocked, but past the first minute: every 100 ms now
  await sleep(60);
  fired = 0;
  await sleep(300);
  assert.ok(fired >= 1 && fired <= 5, `slow re-check fired ${fired} times in 300 ms`);
  clock.t += 10 * 60_000;
  await sleep(150);
  fired = 0;
  await sleep(250);
  assert.equal(fired, 0, 'no re-checks once the block is old');
});

test('an idle lease root holding nothing gives back its store after 5 minutes', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = setup(t);
  const clock = { t: 1_000_000 };
  const closed = [];
  const a = h.open(101, {
    now: () => clock.t,
    createStore: (root) => {
      const store = new WorkLeaseStore({ leaseRoot: root, me: HOST, probe: h.probe, ownPid: 101, ownStart: null });
      const close = store.close.bind(store);
      store.close = () => { closed.push(root); close(); };
      return store;
    },
  });
  const wanted = a.resourcesFor(h.resources);
  const held = a.hold({ sessionId: 's-a', resources: wanted });
  clock.t += 6 * 60_000;
  t.mock.timers.tick(60_000);
  assert.deepEqual(closed, [], 'a root holding a ticket stays open');
  a.release(held.handle);
  t.mock.timers.tick(60_000);
  assert.deepEqual(closed, [h.leaseRoot]);
  assert.equal(a.wouldBlock(wanted), false, 'the next check opens the root again');
  assert.equal(a.hold({ sessionId: 's-a', resources: wanted }).status, 'granted');
});

test('a holder is named by session only within the same profile', (t) => {
  const h = setup(t);
  const a = h.open(101);
  const same = h.open(102);
  const other = h.open(103, { userDataPath: 'profile-two' });
  const wanted = a.resourcesFor(h.resources);
  assert.deepEqual(a.describeHolders(wanted), []);
  a.hold({ ownerId: 'o', sessionId: 's-a', resources: wanted });
  assert.deepEqual(same.describeHolders(wanted), [{
    session_id: 's-a', status: 'active', quarantined_at: null, app: 'jenny-desktop', label: 'npm test', ours: true,
    pid: 101, seq: 1, what: 'tests', job_id: null,
  }]);
  const foreign = other.describeHolders(wanted);
  assert.equal(foreign.length, 1);
  assert.equal(foreign[0].session_id, null);
  assert.equal(foreign[0].ours, false);
  assert.equal(foreign[0].app, 'jenny-desktop');
});

test('row 100 P2: holders name their job, sort chats first and keep a legacy lock\'s kind', (t) => {
  const h = setup(t, { startTimeOf: () => null });
  const a = h.open(101);
  const b = h.open(102);
  const outside = h.open(103, { userDataPath: 'profile-two' });
  const wanted = a.resourcesFor(h.resources);
  outside.hold({ sessionId: 's-x', resources: wanted.filter((r) => r.key.startsWith('deps@')) });
  const { handle } = a.hold({ sessionId: 's-a', resources: wanted.filter((r) => r.key.startsWith('deps@')) });
  a.transferToJob(handle, { sessionId: 's-a', toolCallId: 'bg' });
  h.probe.pids.add(4242);
  a.noteJobStarted({ sessionId: 's-a', toolCallId: 'bg', jobId: 'job-7', pid: 4242 });
  const holders = a.describeHolders(wanted);
  assert.deepEqual(holders.map((x) => [x.session_id, x.job_id, x.what, x.pid]), [
    ['s-a', 'job-7', 'install', 4242], [null, null, 'install', 103]]);
  assert.equal(b.describeHolders(wanted)[0].job_id, null, 'another process sees no job id');
  a.noteJobSettled({ jobId: 'job-7' });
  outside.close();
  fs.writeFileSync(path.join(h.workspace, '.test-run.lock'), JSON.stringify({ pid: 102 }));
  assert.deepEqual(b.describeHolders(wanted).map((x) => [x.app, x.pid, x.what]), [['legacy-test-run', 102, 'tests']]);
});

test('row 100 P2: an overlap on deps alone reads as the holder\'s own work', (t) => {
  const h = setup(t);
  const a = h.open(101);
  const b = h.open(102);
  const wanted = a.resourcesFor(h.resources);
  a.hold({ sessionId: 's-a', resources: wanted });
  const depsOnly = wanted.filter((r) => r.key.startsWith('deps@')).map((r) => ({ ...r, units: 'all' }));
  assert.deepEqual(b.describeHolders(depsOnly).map((x) => x.what), ['tests'], 'a test run sharing deps, not an install');
});

test('resourcesFor derives frozen work resources, merges duplicates, skips repo takes outside a repo and caps', (t) => {
  const root = path.join(tempDir(t), 'leases');
  const rootTwo = path.join(tempDir(t), 'leases-two');
  const ws = tempDir(t, 'work-lease-ws-');
  const sub = path.join(ws, 'sub');
  const classify = () => ({ label: 'multi', takes: [
    { kind: 'tests', scope: 'tree', dir: ws, units: 1, capacity: 1, rule: 'a' },
    { kind: 'tests', scope: 'tree', dir: ws, units: 'all', capacity: 1, rule: 'b' },
    { kind: 'deps', scope: 'tree', dir: ws, units: 1, capacity: null, rule: 'c' },
    { kind: 'deps', scope: 'tree', dir: ws, units: 3, capacity: null, rule: 'd' },
    { kind: 'git-write', scope: 'repo', dir: sub, units: 'all', capacity: 1, rule: 'e' },
    { kind: 'git-write', scope: 'repo', dir: ws, units: 'all', capacity: 1, rule: 'f' },
  ] });
  const resolveScope = (dir) => (dir === sub
    ? { leaseRoot: rootTwo, treeRoot: sub, isRepo: false }
    : { leaseRoot: root, treeRoot: ws, isRepo: true });
  const make = (more = {}) => createWorkLeaseAdapter({ userDataPath: 'p', classify, resolveScope, ...more });
  const adapter = make();
  t.after(() => adapter.close());
  const list = adapter.resourcesFor({ argumentsValue: { command: 'x' }, workspacePath: ws });
  assert.ok(Object.isFrozen(list));
  assert.ok(list.every(Object.isFrozen));
  assert.deepEqual(list.map((r) => [r.type, r.leaseRoot, r.key, r.units, r.capacity, r.label]), [
    ['work', root, `tests@tree:${normalizePathForKey(ws, PLATFORM)}`, 'all', 1, 'multi'],
    ['work', root, `deps@tree:${normalizePathForKey(ws, PLATFORM)}`, 3, null, 'multi'],
    ['work', root, 'git-write@repo', 'all', 1, 'multi'],
  ]);
  const capped = make({ maxResources: 2 });
  t.after(() => capped.close());
  assert.equal(capped.resourcesFor({ argumentsValue: { command: 'x' }, workspacePath: ws }).length, 2);
});

test('resourcesFor resolves cwd against the workspace and fails open on any problem', (t) => {
  const logs = [];
  const ws = tempDir(t, 'work-lease-ws-');
  const seen = [];
  const log = (level, event, details) => logs.push({ level, event, details });
  const adapter = createWorkLeaseAdapter({
    userDataPath: 'p', log,
    classify: (command, options) => {
      seen.push(options.cwd);
      if (command === 'boom') throw new Error('rules exploded');
      return { label: '', takes: [] };
    },
    resolveScope: () => { throw new WorkLeaseInfraError('git_unavailable', 'no git'); },
  });
  t.after(() => adapter.close());
  assert.deepEqual(adapter.resourcesFor({ argumentsValue: { command: 'npm test', cwd: 'pkg' }, workspacePath: ws }), []);
  assert.equal(seen[0], path.resolve(ws, 'pkg'));
  assert.deepEqual(adapter.resourcesFor({ argumentsValue: { command: '   ' }, workspacePath: ws }), []);
  assert.deepEqual(adapter.resourcesFor({ argumentsValue: { command: 42 }, workspacePath: ws }), []);
  assert.deepEqual(adapter.resourcesFor({ argumentsValue: { command: 'npm test' }, workspacePath: '' }), []);
  assert.deepEqual(adapter.resourcesFor({ argumentsValue: { command: 'npm test', cwd: 'rel' } }), []);
  assert.deepEqual(adapter.resourcesFor({ argumentsValue: { command: 'boom' }, workspacePath: ws }), []);
  assert.deepEqual(adapter.resourcesFor(), []);
  const failures = logs.filter((l) => l.event === 'work_leases.classify_failed');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].level, 'WARN');
  assert.equal(failures[0].details.reason, 'rules exploded');

  const infra = createWorkLeaseAdapter({
    userDataPath: 'p', log,
    classify: () => ({ label: 'l', takes: [{ kind: 'tests', scope: 'tree', dir: ws, units: 'all', capacity: 1, rule: 'x' }] }),
    resolveScope: () => { throw new WorkLeaseInfraError('git_unavailable', 'no git'); },
  });
  t.after(() => infra.close());
  assert.deepEqual(infra.resourcesFor({ argumentsValue: { command: 'npm test' }, workspacePath: ws }), []);
  assert.ok(logs.some((l) => l.details.reason === 'no git'));
});

test('a background job keeps the tickets, follows the job pid, and releases when the job settles', (t) => {
  const h = setup(t, { startTimeOf: () => 1234.5 });
  const a = h.open(101);
  const b = h.open(102);
  const wanted = a.resourcesFor(h.resources);
  const { handle } = a.hold({ ownerId: 'o', sessionId: 's-a', resources: wanted });
  a.transferToJob(handle, { sessionId: 's-a', toolCallId: 'call-1' });
  assert.equal(readTicket(h.leaseRoot).owner.pid, 101);
  h.probe.pids.add(4242);
  a.noteJobStarted({ sessionId: 's-a', toolCallId: 'call-1', jobId: 'job-1', pid: 4242 });
  const ticket = readTicket(h.leaseRoot);
  assert.equal(ticket.owner.pid, 4242);
  assert.equal(ticket.owner.pid_start, 1234.5);
  assert.equal(ticket.owner.session, 's-a');
  h.probe.pids.delete(101); // the job pid, not the app process, decides liveness now
  assert.equal(b.wouldBlock(wanted), true);
  a.noteJobSettled({ jobId: 'job-1' });
  assert.equal(ticketFiles(h.leaseRoot).length, 0);
  assert.equal(b.wouldBlock(wanted), false);

  const second = a.hold({ ownerId: 'o', sessionId: 's-a', resources: wanted });
  a.transferToJob(second.handle, { sessionId: 's-a', toolCallId: 'call-2' });
  a.noteJobStarted({ sessionId: 's-a', toolCallId: 'call-2', jobId: 'job-2', pid: 4242 });
  a.noteJobSettled({ jobId: 'unknown' });
  assert.equal(ticketFiles(h.leaseRoot).length, 1);
  a.release(second.handle); // an explicit release also frees a bound handle
  assert.equal(ticketFiles(h.leaseRoot).length, 0);
  a.noteJobSettled({ jobId: 'job-2' }); // already released: a no-op
});

test('a job start time read in the background is written once it arrives', async (t) => {
  let resolveStart;
  const h = setup(t, { startTimeOfAsync: (pid) => new Promise((resolve) => { resolveStart = () => resolve(pid === 4242 ? 99.5 : null); }) });
  const a = h.open(101);
  const { handle } = a.hold({ sessionId: 's', resources: a.resourcesFor(h.resources) });
  a.transferToJob(handle, { sessionId: 's', toolCallId: 'call-1' });
  a.noteJobStarted({ sessionId: 's', toolCallId: 'call-1', jobId: 'job-1', pid: 4242 });
  assert.equal(readTicket(h.leaseRoot).owner.pid, 4242);
  assert.equal(readTicket(h.leaseRoot).owner.pid_start, null, 'unknown until the probe answers');
  await waitFor(() => typeof resolveStart === 'function');
  resolveStart();
  await waitFor(() => readTicket(h.leaseRoot).owner.pid_start === 99.5);
  a.noteJobSettled({ jobId: 'job-1' });
  assert.equal(ticketFiles(h.leaseRoot).length, 0);
});

test('a session never waits on its own held work; another session does', (t) => {
  const h = setup(t);
  const a = h.open(101);
  const mine = a.resourcesFor({ ...h.resources, sessionId: 's-a' });
  assert.ok(mine.every((resource) => resource.sessionId === 's-a'));
  const { handle } = a.hold({ sessionId: 's-a', resources: mine });
  a.transferToJob(handle, { sessionId: 's-a', toolCallId: 'bg' });
  assert.equal(a.wouldBlock(mine), false, 'covered by its own background run');
  assert.deepEqual(a.hold({ sessionId: 's-a', resources: mine }), { status: 'granted', handle: null });
  assert.equal(ticketFiles(h.leaseRoot).length, 1, 'no second ticket for covered work');
  const theirs = a.resourcesFor({ ...h.resources, sessionId: 's-b' });
  assert.equal(a.wouldBlock(theirs), true);
  assert.deepEqual(a.hold({ sessionId: 's-b', resources: theirs }), { status: 'waiting' });
  a.release(handle);
  assert.equal(a.wouldBlock(theirs), false);
});

test('a job start seen before its transfer binds immediately; a job that never starts releases after the window', async (t) => {
  const h = setup(t, { startTimeOf: () => null, transferWindowMs: 40 });
  const a = h.open(101);
  const wanted = a.resourcesFor(h.resources);
  const first = a.hold({ ownerId: 'o', sessionId: 's', resources: wanted });
  h.probe.pids.add(777);
  a.noteJobStarted({ sessionId: 's', toolCallId: 'early', jobId: 'job-e', pid: 777 });
  a.transferToJob(first.handle, { sessionId: 's', toolCallId: 'early' });
  assert.equal(readTicket(h.leaseRoot).owner.pid, 777);
  await sleep(120);
  assert.equal(ticketFiles(h.leaseRoot).length, 1, 'a bound transfer has no expiry');
  a.noteJobSettled({ jobId: 'job-e' });
  assert.equal(ticketFiles(h.leaseRoot).length, 0);

  const second = a.hold({ ownerId: 'o', sessionId: 's', resources: wanted });
  a.transferToJob(second.handle, { sessionId: 's', toolCallId: 'never' });
  assert.equal(ticketFiles(h.leaseRoot).length, 1);
  await waitFor(() => ticketFiles(h.leaseRoot).length === 0);
  a.noteJobStarted({ sessionId: 's', toolCallId: 'never', jobId: 'late', pid: 778 }); // nothing left to bind
  a.noteJobSettled({ jobId: 'late' });
});

test('a stale early start memo is not bound to a later transfer', async (t) => {
  const h = setup(t, { transferWindowMs: 30 });
  const a = h.open(101);
  const wanted = a.resourcesFor(h.resources);
  a.noteJobStarted({ sessionId: 's', toolCallId: 'old', jobId: 'job-old', pid: 9999 });
  await sleep(80);
  const { handle } = a.hold({ ownerId: 'o', sessionId: 's', resources: wanted });
  a.transferToJob(handle, { sessionId: 's', toolCallId: 'old' });
  assert.equal(readTicket(h.leaseRoot).owner.pid, 101);
  await waitFor(() => ticketFiles(h.leaseRoot).length === 0);
});

test('an infrastructure failure while publishing proceeds uncoordinated and leaves nothing behind', (t) => {
  const base = tempDir(t);
  const rootA = path.join(base, 'a-root');
  const rootB = path.join(base, 'b-root');
  const logs = [];
  const probe = fakeProbe([101]);
  const adapter = createWorkLeaseAdapter({
    userDataPath: 'p', log: (level, event, details) => logs.push({ level, event, details }),
    createStore: (root) => {
      const store = new WorkLeaseStore({ leaseRoot: root, me: HOST, probe, ownPid: 101, ownStart: null });
      if (root === rootB) store.publish = () => { throw new WorkLeaseInfraError('guard_timeout', 'guard busy'); };
      return store;
    },
  });
  t.after(() => adapter.close());
  const work = (leaseRoot, key) => ({ type: 'work', leaseRoot, key, units: 'all', capacity: 1, label: 'npm test' });
  const result = adapter.hold({ ownerId: 'o', sessionId: 's',
    resources: [work(rootB, 'tests@tree:g:/b'), work(rootA, 'tests@tree:g:/a')] });
  assert.deepEqual(result, { status: 'granted', handle: null });
  assert.equal(ticketFiles(rootA).length, 0, 'the ticket published before the failure was released');
  assert.ok(logs.some((l) => l.level === 'WARN' && l.event === 'work_leases.root_failed'
    && l.details.infra === 'guard_timeout'));
  adapter.release(null);
  adapter.release(result.handle);
  const again = adapter.hold({ sessionId: 's', resources: [work(rootB, 'tests@tree:g:/b')] });
  assert.deepEqual(again, { status: 'granted', handle: null }, 'the failed root is skipped for 30 s');
  assert.equal(logs.filter((l) => l.event === 'work_leases.root_failed').length, 1, 'no second guard attempt');
});

test('a multi-root hold that is partly busy releases every ticket it published', (t) => {
  const base = tempDir(t);
  const rootA = path.join(base, 'a-root');
  const rootB = path.join(base, 'b-root');
  const probe = fakeProbe([101, 102]);
  const open = (pid) => createWorkLeaseAdapter({ userDataPath: 'p',
    createStore: (root) => new WorkLeaseStore({ leaseRoot: root, me: HOST, probe, ownPid: pid, ownStart: null }) });
  const a = open(101);
  const b = open(102);
  t.after(() => { a.close(); b.close(); });
  const work = (leaseRoot, key) => ({ type: 'work', leaseRoot, key, units: 'all', capacity: 1, label: '' });
  const held = a.hold({ ownerId: 'o', sessionId: 's', resources: [work(rootB, 'tests@tree:g:/b')] });
  assert.equal(held.status, 'granted');
  const both = [work(rootA, 'tests@tree:g:/a'), work(rootB, 'tests@tree:g:/b')];
  assert.equal(b.wouldBlock(both), true);
  assert.deepEqual(b.hold({ ownerId: 'o', sessionId: 's', resources: both }), { status: 'waiting' });
  assert.equal(ticketFiles(rootA).length, 0);
  assert.equal(ticketFiles(rootB).length, 1);
});

test('close releases every handle but a running job, stops listeners and later calls fail open', async (t) => {
  const h = setup(t, { startTimeOf: () => null });
  const jobRoot = path.join(tempDir(t), 'job-leases');
  const a = h.open(101);
  const wanted = a.resourcesFor(h.resources);
  const { handle } = a.hold({ ownerId: 'o', sessionId: 's', resources: wanted });
  const jobWork = [{ type: 'work', leaseRoot: jobRoot, key: 'tests@tree:g:/job', units: 'all', capacity: 1, label: 'npm test' }];
  const job = a.hold({ sessionId: 's', resources: jobWork });
  a.transferToJob(job.handle, { sessionId: 's', toolCallId: 'bg' });
  h.probe.pids.add(4242);
  a.noteJobStarted({ sessionId: 's', toolCallId: 'bg', jobId: 'job-bg', pid: 4242 });
  let fired = 0;
  a.onChange(() => { fired += 1; });
  assert.equal(ticketFiles(h.leaseRoot).length, 1);
  a.close();
  assert.equal(ticketFiles(h.leaseRoot).length, 0);
  assert.equal(ticketFiles(jobRoot).length, 1, 'the running job keeps its ticket; its pid decides it');
  assert.equal(readTicket(jobRoot).owner.pid, 4242);
  a.release(handle);
  assert.equal(a.wouldBlock(wanted), false);
  assert.deepEqual(a.hold({ ownerId: 'o', sessionId: 's', resources: wanted }), { status: 'granted', handle: null });
  await sleep(100);
  assert.equal(fired, 0);
  assert.throws(() => a.onChange('nope'), TypeError);
});

test('a real git repository resolves to the common-dir lease root and round-trips a hold', (t) => {
  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (git.status !== 0) { t.skip('git is not available'); return; }
  const repo = tempDir(t, 'work-lease-repo-');
  const init = spawnSync('git', ['init', '-q', repo], { encoding: 'utf8', windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  const adapter = createWorkLeaseAdapter({
    userDataPath: 'p',
    classify: (command, options) => ({ label: command, takes: [
      { kind: 'tests', scope: 'tree', dir: options.cwd, units: 'all', capacity: 1, rule: 'x' },
      { kind: 'git-write', scope: 'repo', dir: options.cwd, units: 'all', capacity: 1, rule: 'x' },
    ] }),
  });
  const wanted = adapter.resourcesFor({ argumentsValue: { command: 'npm test' }, workspacePath: repo });
  try {
    assert.equal(wanted.length, 2);
    const { leaseRoot } = wanted[0];
    assert.equal(path.basename(path.dirname(path.dirname(path.dirname(leaseRoot)))).toLowerCase(), '.git');
    assert.deepEqual(wanted.map((r) => r.key).sort(), [
      'git-write@repo', `tests@tree:${normalizePathForKey(fs.realpathSync.native(repo), PLATFORM)}`,
    ].sort());
    assert.equal(adapter.wouldBlock(wanted), false);
    const held = adapter.hold({ ownerId: 'o', sessionId: 's', resources: wanted });
    assert.equal(held.status, 'granted');
    assert.equal(ticketFiles(leaseRoot).length, 1);
    assert.equal(adapter.wouldBlock(wanted), true, 'the same process collides with its own earlier hold');
    adapter.release(held.handle);
    assert.equal(ticketFiles(leaseRoot).length, 0);
  } finally {
    adapter.close();
  }
});
