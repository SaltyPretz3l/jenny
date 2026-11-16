'use strict';

// Slice 4c host: the team.node.* commands (node protocol spec N6, N11, N17) through
// the real command router, over a real member store and a real pool scheduler. The
// node is always the caller's device. No sidecar, no model, no engine, no window.

const assert = require('node:assert/strict');
const nodeTest = require('node:test');

const { createNodeRates } = require('../../server/team/node-commands');
const { MARKER, closeHook, createNodeCommandsFixture, model, registerParams, until } = require('./helpers/team-node-fixture');

// A hang fails its own test instead of the whole file.
const test = (name, fn) => nodeTest(name, { timeout: 20_000 }, fn);
const reason = (answer) => (answer.ok ? 'ok' : answer.error.reason);
const waitingClaim = (seq, ms = 25_000) => ({ claim_seq: seq, wait_ms: ms });

// ------------------------------------------------------------------ register

test('a register answers a node id and the scheduler timings; a second one keeps the id and updates the inventory', async (t) => {
  const f = await createNodeCommandsFixture(t);
  const first = await f.send(f.seats.alice, 'team.node.register', registerParams());
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.match(first.node_id, /^node_[A-Za-z0-9_-]+$/u);
  assert.equal(first.expires_ms, f.scheduler.limits.nodeContactMs);
  assert.ok(first.heartbeat_ms > 0 && first.heartbeat_ms < first.expires_ms);
  const again = await f.send(f.seats.alice, 'team.node.register',
    registerParams({ slots: 2, models: [model('alpha'), model('beta', { vision: true })] }));
  assert.equal(again.node_id, first.node_id);
  const [node] = f.scheduler.listNodes();
  assert.equal(f.scheduler.listNodes().length, 1);
  assert.equal(node.slots, 2);
  assert.deepEqual(node.models.map((entry) => entry.id), ['alpha', 'beta']);
  assert.equal(node.member_id, f.seats.alice.member_id);
  assert.equal(node.device_id, f.seats.alice.device_id, 'the node is the caller\'s device');
});

test('a wrong protocol version registers nothing', async (t) => {
  const f = await createNodeCommandsFixture(t);
  for (const version of [0, 2, 99]) {
    const answer = await f.send(f.seats.alice, 'team.node.register', registerParams({ protocol_version: version }));
    assert.deepEqual([answer.ok, answer.error.code, reason(answer)], [false, 'CMP-HOST-0004', 'node_version_mismatch']);
  }
  assert.deepEqual(f.scheduler.listNodes(), []);
});

test('slots 0 and 5, 65 models, a malformed model, duplicate names and an unknown field are refused', async (t) => {
  const f = await createNodeCommandsFixture(t);
  const many = Array.from({ length: 65 }, (_, i) => model(`m${i}`));
  const { vision: _vision, ...noVision } = model('alpha');
  for (const params of [
    registerParams({ slots: 0 }), registerParams({ slots: 5 }), registerParams({ models: many }),
    registerParams({ models: [noVision] }), registerParams({ models: [model('alpha'), model('alpha')] }),
    registerParams({ models: [model('al pha\u0001')] }), { ...registerParams(), node_id: 'node_x' },
    registerParams({ engine: { kind: 'x', version: 'y', extra: 1 } }),
  ]) {
    const answer = await f.send(f.seats.alice, 'team.node.register', params);
    assert.equal(answer.ok, false, JSON.stringify(params).slice(0, 80));
  }
  assert.deepEqual(f.scheduler.listNodes(), []);
});

test('a read-only, a pending and a revoked member cannot share; nothing is registered', async (t) => {
  const f = await createNodeCommandsFixture(t);
  const gone = await f.join('Gus');
  assert.equal((await f.store.revokeMember({ actorMemberId: f.seats.owner.member_id, memberId: gone.member_id })).ok, true);
  for (const seat of [f.seats.rae, f.seats.pat, gone]) {
    const answer = await f.send(seat, 'team.node.register', registerParams());
    assert.equal(answer.ok, false);
    assert.equal(answer.error.code, 'CMP-HOST-0003', reason(answer));
  }
  assert.deepEqual(f.scheduler.listNodes(), []);
});

test('the module refuses a pending, a revoked, a read-only and a missing device itself, before it reads the pool', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const gone = await f.join('Gus');
  assert.equal((await f.store.revokeMember({ actorMemberId: f.seats.owner.member_id, memberId: gone.member_id })).ok, true);
  const before = f.scheduler.listNodes();
  const reads = f.holder.reads;
  for (const context of [{ deviceId: f.seats.pat.device_id }, { deviceId: gone.device_id }, { deviceId: f.seats.rae.device_id },
    {}, { deviceId: 'device_nobody' }]) {
    for (const [operation, params] of [['team.node.register', registerParams()], ['team.node.claim', waitingClaim(1, 0)],
      ['team.node.unregister', {}]]) {
      const answer = await f.direct(operation, params, context);
      assert.deepEqual([answer.ok, answer.error.code], [false, 'CMP-HOST-0003'], `${operation} ${JSON.stringify(context)}`);
    }
  }
  assert.equal(f.holder.reads, reads, 'the pool was never read');
  assert.deepEqual(f.scheduler.listNodes(), before);
});

test('a second device of the same member cannot fail, pause or unregister the first device\'s node', async (t) => {
  const f = await createNodeCommandsFixture(t);
  const nodeId = await f.register(f.seats.alice);
  const { job } = f.queueJob();
  await f.send(f.seats.alice, 'team.node.claim', waitingClaim(1, 0));
  const phone = await f.spareDevice(f.seats.alice);
  const context = { deviceId: phone.device_id };
  for (const [operation, params] of [['team.node.fail', { job_id: job.job_id, reason: 'engine_error' }],
    ['team.node.pause', { on: true }], ['team.node.unregister', {}]]) {
    assert.equal(reason(await f.direct(operation, params, context)), 'node_not_found', operation);
  }
  assert.equal(f.scheduler.getJob(job.job_id).state, 'claimed');
  assert.deepEqual(f.scheduler.listNodes().map((view) => [view.node_id, view.paused]), [[nodeId, false]]);
});

test('with no pool every node operation answers what the engine routes answer with no pool', async (t) => {
  const f = await createNodeCommandsFixture(t, { withPool: false });
  for (const [operation, params] of [['team.node.register', registerParams()], ['team.node.claim', { claim_seq: 1, wait_ms: 0 }],
    ['team.node.fail', { job_id: 'job_x', reason: 'engine_error' }], ['team.node.pause', { on: true }],
    ['team.node.unregister', {}], ['team.node.list', {}]]) {
    const answer = await f.send(f.seats.alice, operation, params);
    assert.deepEqual([answer.ok, answer.error.code, reason(answer)], [false, 'CMP-HOST-0005', 'team_pool_unavailable'],
      operation);
  }
});

// ------------------------------------------------------------------ claim

test('a claim answers the queued job, the same claim_seq answers it again, and none with wait 0 answers null', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const empty = await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 0 });
  assert.deepEqual([empty.ok, empty.job], [true, null]);
  const { job, lease } = f.queueJob();
  const claimed = await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 2, wait_ms: 0 });
  assert.deepEqual(Object.keys(claimed.job).sort(),
    ['first_byte_ms', 'job_id', 'lease_id', 'model', 'request_bytes', 'stall_ms', 'total_ms']);
  assert.deepEqual([claimed.job.job_id, claimed.job.lease_id, claimed.job.model], [job.job_id, lease.lease_id, 'alpha']);
  const replay = await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 2, wait_ms: 0 });
  assert.deepEqual(replay.job, claimed.job, 'a lost answer loses nothing');
  assert.equal(f.scheduler.getJob(job.job_id).state, 'claimed');
});

test('a waiting claim answers a job queued for its node during the wait, and null at the timeout', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const nodes = f.nodes();
  const waiting = f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 25_000 });
  await until(() => nodes.resources().waiters === 1, 'the claim waits');
  const { job } = f.queueJob();
  assert.equal((await waiting).job.job_id, job.job_id);
  assert.deepEqual(nodes.resources(), { waiters: 0, timers: 0, listeners: 0 });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timing = f.send(f.seats.alice, 'team.node.claim', { claim_seq: 2, wait_ms: 25_000 });
  await until(() => nodes.resources().waiters === 1, 'the second claim waits');
  t.mock.timers.tick(24_999);
  assert.equal(nodes.resources().waiters, 1, 'still waiting one millisecond before the end');
  t.mock.timers.tick(1);
  assert.equal((await timing).job, null);
  assert.deepEqual(nodes.resources(), { waiters: 0, timers: 0, listeners: 0 });
});

test('a job queued for another node does not wake the claim', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  await f.register(f.seats.owner, { models: [model('other')] });
  const nodes = f.nodes();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const waiting = f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 5_000 });
  await until(() => nodes.resources().waiters === 1, 'the claim waits');
  const lease = f.scheduler.requestLease({ conversationKey: 'conv:-:o', memberId: f.seats.owner.member_id, model: 'other',
    wantsVision: false });
  f.scheduler.createJob(lease.lease.lease_id, { requestBytes: Buffer.from('{}'), stream: true });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(nodes.resources().waiters, 1);
  t.mock.timers.tick(5_000);
  assert.equal((await waiting).job, null);
});

test('a waiting claim whose request closed leaves at once, claims nothing and frees its place', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const nodes = f.nodes();
  const hook = closeHook();
  const stale = f.direct('team.node.claim', waitingClaim(1), { deviceId: f.seats.alice.device_id, onClose: hook.onClose });
  await until(() => nodes.resources().waiters === 1, 'the claim waits');
  assert.equal(hook.count(), 1, 'the waiter listens for the close');
  hook.close();
  const gone = await stale;
  assert.deepEqual([gone.ok, gone.job], [true, null]);
  assert.deepEqual([nodes.resources(), hook.count()], [{ waiters: 0, timers: 0, listeners: 0 }, 0]);
  const { job } = f.queueJob();
  assert.equal(f.scheduler.getJob(job.job_id).state, 'queued', 'the closed request claimed nothing');
  assert.equal((await f.send(f.seats.alice, 'team.node.claim', waitingClaim(2))).job.job_id, job.job_id);
  const next = f.send(f.seats.alice, 'team.node.claim', waitingClaim(3));
  await until(() => nodes.resources().waiters === 1, 'a new claim waits: the closed one holds no place');
  nodes.dispose();
  assert.equal((await next).job, null);
});

test('the close listener is removed when the claim is answered, times out or is disposed', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const nodes = f.nodes();
  const context = (hook) => ({ deviceId: f.seats.alice.device_id, onClose: hook.onClose });
  const answered = closeHook();
  const one = f.direct('team.node.claim', waitingClaim(1), context(answered));
  await until(() => answered.count() === 1, 'listening');
  f.queueJob();
  assert.ok((await one).job);
  assert.equal(answered.count(), 0, 'answered');

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timed = closeHook();
  const two = f.direct('team.node.claim', waitingClaim(2, 5_000), context(timed));
  await until(() => timed.count() === 1, 'listening');
  t.mock.timers.tick(5_000);
  assert.equal((await two).job, null);
  assert.equal(timed.count(), 0, 'timed out');

  const disposed = closeHook();
  const three = f.direct('team.node.claim', waitingClaim(3), context(disposed));
  await until(() => disposed.count() === 1, 'listening');
  nodes.dispose();
  assert.equal((await three).job, null);
  assert.equal(disposed.count(), 0, 'disposed');
});

test('the waiter bounds: at most slots waiting claims a node and the module total; over either answers null at once', async (t) => {
  const f = await createNodeCommandsFixture(t, { maxWaiting: 2 });
  await f.register(f.seats.alice);
  const nodes = f.nodes();
  const first = f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 25_000 });
  await until(() => nodes.resources().waiters === 1, 'one waits');
  const over = await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 2, wait_ms: 25_000 });
  assert.deepEqual([over.ok, over.job], [true, null], 'one slot, one waiting claim');
  await f.register(f.seats.owner, { slots: 4 });
  const second = f.send(f.seats.owner, 'team.node.claim', { claim_seq: 1, wait_ms: 25_000 });
  await until(() => nodes.resources().waiters === 2, 'two wait');
  const total = await f.send(f.seats.owner, 'team.node.claim', { claim_seq: 2, wait_ms: 25_000 });
  assert.deepEqual([total.ok, total.job], [true, null], 'the module total');
  assert.equal(nodes.resources().waiters, 2);
  nodes.dispose();
  assert.deepEqual([(await first).job, (await second).job], [null, null]);
});

for (const [label, change] of [
  ['revoked', (f) => f.store.revokeMember({ actorMemberId: f.seats.owner.member_id, memberId: f.seats.alice.member_id })],
  ['set to read-only', (f) => f.store.setRole({ actorMemberId: f.seats.owner.member_id, memberId: f.seats.alice.member_id,
    role: 'read_only' })],
]) {
  test(`a member ${label} during the wait is refused and the job stays unclaimed`, async (t) => {
    const f = await createNodeCommandsFixture(t);
    await f.register(f.seats.alice);
    const nodes = f.nodes();
    const waiting = f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 25_000 });
    await until(() => nodes.resources().waiters === 1, 'the claim waits');
    assert.equal((await change(f)).ok, true);
    const { job } = f.queueJob();
    const answer = await waiting;
    assert.equal(answer.ok, false);
    assert.equal(answer.error.code, 'CMP-HOST-0003');
    assert.equal(f.scheduler.getJob(job.job_id).state, 'queued');
  });
}

test('recheck unregisters the node of a device that may no longer share and ends its waiting claim refused', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const kept = await f.register(f.seats.owner);
  const nodes = f.nodes();
  const waiting = f.send(f.seats.alice, 'team.node.claim', waitingClaim(1));
  await until(() => nodes.resources().waiters === 1, 'the claim waits');
  assert.equal((await f.store.setRole({ actorMemberId: f.seats.owner.member_id, memberId: f.seats.alice.member_id,
    role: 'read_only' })).ok, true);
  nodes.recheck();
  assert.deepEqual(f.scheduler.listNodes().map((view) => view.node_id), [kept]);
  const answer = await waiting;
  assert.deepEqual([answer.ok, answer.error.code], [false, 'CMP-HOST-0003']);
  assert.deepEqual(nodes.resources(), { waiters: 0, timers: 0, listeners: 0 });
});

test('a thrown handler answers team_pool_unavailable and logs one warning without the error text', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  f.holder.pool = { scheduler: { ...f.scheduler, claim: () => { throw new Error(`${MARKER} boom`); } } };
  const answer = await f.send(f.seats.alice, 'team.node.claim', waitingClaim(1, 0));
  assert.equal(reason(answer), 'team_pool_unavailable');
  const warned = f.fx.logs.filter((entry) => entry.event === 'team.node.failed');
  assert.deepEqual(warned.map((entry) => [entry.level, entry.fields?.operation]), [['WARN', 'team.node.claim']]);
  assert.equal(f.logText().includes(MARKER), false);
});

test('an unregister while a claim waits ends the wait with node_not_found', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const nodes = f.nodes();
  const waiting = f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 25_000 });
  await until(() => nodes.resources().waiters === 1, 'the claim waits');
  assert.equal((await f.send(f.seats.alice, 'team.node.unregister', {})).ok, true);
  assert.equal(reason(await waiting), 'node_not_found');
  assert.deepEqual(nodes.resources(), { waiters: 0, timers: 0, listeners: 0 });
});

test('dispose ends every waiter and leaves no timer or listener', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice, { slots: 2 });
  await f.register(f.seats.owner);
  const nodes = f.nodes();
  const waits = [f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 25_000 }),
    f.send(f.seats.alice, 'team.node.claim', { claim_seq: 2, wait_ms: 25_000 }),
    f.send(f.seats.owner, 'team.node.claim', { claim_seq: 1, wait_ms: 25_000 })];
  await until(() => nodes.resources().waiters === 3, 'three wait');
  assert.deepEqual(nodes.resources(), { waiters: 3, timers: 3, listeners: 1 });
  nodes.dispose();
  // Queued while the woken claims are still settling: none of them may take it.
  const { job } = f.queueJob();
  for (const answer of await Promise.all(waits)) assert.deepEqual([answer.ok, answer.job], [true, null]);
  assert.deepEqual(nodes.resources(), { waiters: 0, timers: 0, listeners: 0 });
  assert.equal(f.scheduler.getJob(job.job_id).state, 'queued', 'nothing claimed by a disposed waiter');
});

test('60 claims a minute a slot, then node_rate_limit; the window is per node and dropped at unregister', async (t) => {
  let now = 1000;
  const rates = createNodeRates({ clock: () => now });
  const f = await createNodeCommandsFixture(t, { rates });
  await f.register(f.seats.alice);
  for (let seq = 1; seq <= 60; seq += 1) {
    assert.equal((await f.send(f.seats.alice, 'team.node.claim', { claim_seq: seq, wait_ms: 0 })).ok, true, String(seq));
  }
  const limited = await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 61, wait_ms: 0 });
  assert.deepEqual([limited.error.code, reason(limited)], ['CMP-HOST-0007', 'node_rate_limit']);
  now += 60_000;
  assert.equal((await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 62, wait_ms: 0 })).ok, true);
  assert.equal(rates.size() > 0, true);
  await f.send(f.seats.alice, 'team.node.unregister', {});
  assert.equal(rates.size(), 0);
});

// ------------------------------------------------------------------ fail, pause, unregister

test('fail ends the claimed job with the node\'s reason; a reason off the scheduler\'s list is refused', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const { job, lease } = f.queueJob();
  await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 0 });
  const bad = await f.send(f.seats.alice, 'team.node.fail', { job_id: job.job_id, reason: 'made_up' });
  assert.equal(reason(bad), 'node_fail_reason_invalid');
  assert.equal(f.scheduler.getJob(job.job_id).state, 'claimed');
  assert.equal((await f.send(f.seats.alice, 'team.node.fail', { job_id: job.job_id, reason: 'engine_error' })).ok, true);
  assert.deepEqual([f.scheduler.getJob(job.job_id).state, f.scheduler.getJob(job.job_id).reason], ['failed', 'engine_error']);
  assert.equal(f.scheduler.getLease(lease.lease_id).state, 'failed');
});

test('pause keeps a running lease, pause with stop_running ends it, and the answer is the node\'s state', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const { lease } = f.queueJob();
  await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 0 });
  const paused = await f.send(f.seats.alice, 'team.node.pause', { on: true });
  assert.deepEqual(Object.keys(paused.node).sort(), ['busy_slots', 'label', 'member_id', 'models', 'node_id', 'online', 'owner_busy', 'paused', 'slots']);
  assert.deepEqual([paused.node.paused, paused.node.busy_slots], [true, 1]);
  assert.equal(f.scheduler.getLease(lease.lease_id).state, 'active');
  const stopped = await f.send(f.seats.alice, 'team.node.pause', { on: true, stop_running: true });
  assert.equal(stopped.node.busy_slots, 0);
  assert.equal(f.scheduler.getLease(lease.lease_id).state, 'failed');
  assert.equal((await f.send(f.seats.alice, 'team.node.pause', { on: false })).node.paused, false);
});

test('unregister removes the node and ends its running lease as the scheduler ends it', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const { lease, job } = f.queueJob();
  await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 0 });
  assert.equal((await f.send(f.seats.alice, 'team.node.unregister', {})).ok, true);
  assert.deepEqual(f.scheduler.listNodes(), []);
  assert.equal(f.scheduler.getLease(lease.lease_id).state, 'failed');
  assert.equal(f.scheduler.getJob(job.job_id).state, 'failed');
  assert.equal(reason(await f.send(f.seats.alice, 'team.node.unregister', {})), 'node_not_found');
});

test('a forged, another device\'s and a finished job id answer fail byte for byte the same', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  await f.register(f.seats.owner);
  // The owner's node takes the first job (least recently used), Alice's the second.
  const theirs = f.queueJob();
  const mine = f.queueJob();
  await f.send(f.seats.owner, 'team.node.claim', { claim_seq: 1, wait_ms: 0 });
  await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 0 });
  const ownerJob = [theirs, mine].find(({ job }) => f.scheduler.getJob(job.job_id).node_id !== f.scheduler.nodeIdForDevice(
    f.seats.alice.device_id)).job;
  const aliceJob = [theirs, mine].find(({ job }) => job.job_id !== ownerJob.job_id).job;
  await f.send(f.seats.alice, 'team.node.fail', { job_id: aliceJob.job_id, reason: 'engine_error' });
  const texts = [];
  for (const jobId of ['job_AAAAAAAAAAAAAAAAAAAAAA', ownerJob.job_id, aliceJob.job_id]) {
    texts.push(JSON.stringify(await f.send(f.seats.alice, 'team.node.fail', { job_id: jobId, reason: 'engine_error' },
      'request_same')));
  }
  assert.equal(new Set(texts).size, 1, texts.join('\n'));
  assert.equal(JSON.parse(texts[0]).error.reason, 'job_not_found');
  assert.equal(f.scheduler.getJob(ownerJob.job_id).state, 'claimed', 'another device\'s job is untouched');
});

// ------------------------------------------------------------------ list, N17, logs

test('a read-only member reads the node list, which never carries a device id or a job', async (t) => {
  const f = await createNodeCommandsFixture(t);
  const nodeId = await f.register(f.seats.alice, { slots: 2 });
  f.queueJob();
  const listed = await f.send(f.seats.rae, 'team.node.list', {});
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.nodes, [{ node_id: nodeId, member_id: f.seats.alice.member_id, label: null, online: true, paused: false, owner_busy: false,
    busy_slots: 1, slots: 2, models: [{ name: 'alpha', context_length: 32768, vision: false, thinking: false }] }]);
  assert.deepEqual([listed.team_model, listed.automatic_model], [null, 'alpha'], 'slice 4e: the team model and what Automatic means now');
  const text = JSON.stringify(listed);
  for (const needle of ['device_id', f.seats.alice.device_id, 'job_', 'lease_']) assert.equal(text.includes(needle), false, needle);
  assert.equal(reason(await f.send(f.seats.pat, 'team.node.list', {})) !== 'ok', true, 'a pending member does not');
});

test('no node operation writes the receipt store or takes an admin limiter token, and no prompt text is logged', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const { job } = f.queueJob();
  await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 0 });
  await f.send(f.seats.alice, 'team.node.claim', { claim_seq: 1, wait_ms: 0 });
  await f.send(f.seats.alice, 'team.node.fail', { job_id: job.job_id, reason: 'engine_error' });
  await f.send(f.seats.alice, 'team.node.pause', { on: true, stop_running: true });
  await f.send(f.seats.alice, 'team.node.list', {});
  await f.send(f.seats.alice, 'team.node.unregister', {});
  assert.equal(f.receiptsText(), '', 'the receipt store was never written');
  assert.deepEqual(f.limiterKeys, []);
  assert.equal(f.logText().includes(MARKER), false);
  assert.ok(f.fx.logs.some((entry) => entry.event === 'team.node.answered'), 'node operations are logged');
});

test('E76: a pause that names no stop_running is the member’s own work and the list says so; a hand pause and a resume do not', async (t) => {
  const f = await createNodeCommandsFixture(t);
  await f.register(f.seats.alice);
  const own = await f.send(f.seats.alice, 'team.node.pause', { on: true });
  assert.deepEqual([own.node.paused, own.node.owner_busy], [true, true]);
  assert.equal((await f.send(f.seats.rae, 'team.node.list', {})).nodes[0].owner_busy, true, 'teammates read it');
  const hand = await f.send(f.seats.alice, 'team.node.pause', { on: true, stop_running: false });
  assert.deepEqual([hand.node.paused, hand.node.owner_busy], [true, false], 'a pause the owner set by hand is paused');
  await f.send(f.seats.alice, 'team.node.pause', { on: true });
  const resumed = await f.send(f.seats.alice, 'team.node.pause', { on: false });
  assert.deepEqual([resumed.node.paused, resumed.node.owner_busy], [false, false]);
});
