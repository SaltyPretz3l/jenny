'use strict';

// Team slice 4d (scheduler half): the pool takes turns per member. The member
// served least recently goes first among the waiting turns that are neither a
// continuation nor the node owner's own turn; a member never served goes before
// one who was; ties go by arrival; one member's turns keep their arrival order.

const assert = require('node:assert/strict');
const test = require('node:test');

const { orderWaiting } = require('../../server/team/scheduler/queue');
const { createMemberServed } = require('../../server/team/scheduler/state');
const {
  activeLease, createScheduler, model, registerNode, requestLease,
} = require('./helpers/team-pool-fixture');

// A one-node, one-slot pool held by a filler lease of a member outside the test.
function heldPool(options) {
  const fx = createScheduler(options);
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_node' });
  const filler = activeLease(fx.scheduler, { conversationKey: 'conv:p:filler', memberId: 'member_filler' }).lease;
  return { ...fx, nodeId, filler };
}

let counter = 0;
const wait = (scheduler, memberId, extra = {}) => {
  counter += 1;
  const result = requestLease(scheduler, { conversationKey: `conv:p:${memberId}:${counter}`, memberId, ...extra });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.lease;
};

// Releases the single active lease; answers the lease that takes the slot, or null.
function handOut(scheduler) {
  const active = () => scheduler.listLeases().find((lease) => lease.state === 'active');
  scheduler.releaseLease(active().lease_id);
  return active() || null;
}

test('three members, one slot: A has two turns queued first, the order served is A, B, C, A', () => {
  const { scheduler, filler } = heldPool();
  const a1 = wait(scheduler, 'member_a');
  const a2 = wait(scheduler, 'member_a');
  const b = wait(scheduler, 'member_b');
  const c = wait(scheduler, 'member_c');
  scheduler.releaseLease(filler.lease_id);
  const served = [scheduler.getLease(a1.lease_id)];
  for (let i = 0; i < 3; i += 1) served.push(handOut(scheduler));
  assert.deepEqual(served.map((lease) => lease.lease_id), [a1.lease_id, b.lease_id, c.lease_id, a2.lease_id]);
});

test('one member\'s own turns are never reordered among themselves', () => {
  const { scheduler, filler } = heldPool();
  const a1 = wait(scheduler, 'member_a');
  const b = wait(scheduler, 'member_b');
  const a2 = wait(scheduler, 'member_a');
  const a3 = wait(scheduler, 'member_a');
  scheduler.releaseLease(filler.lease_id);
  const served = [scheduler.getLease(a1.lease_id)];
  for (let i = 0; i < 3; i += 1) served.push(handOut(scheduler));
  assert.deepEqual(served.map((lease) => lease.lease_id), [a1.lease_id, b.lease_id, a2.lease_id, a3.lease_id]);
});

test('a member never served goes before a member served earlier, whatever the arrival order', () => {
  const { scheduler, filler } = heldPool();
  // A is served once while B and C wait; then A queues again ahead of a later turn from D.
  const a1 = wait(scheduler, 'member_a');
  scheduler.releaseLease(filler.lease_id);
  assert.equal(scheduler.getLease(a1.lease_id).state, 'active');
  const a2 = wait(scheduler, 'member_a');
  const d = wait(scheduler, 'member_d');
  assert.equal(handOut(scheduler).lease_id, d.lease_id, 'D never served, A was: D first despite arriving later');
  assert.equal(handOut(scheduler).lease_id, a2.lease_id);
});

test('the member served least recently goes first among those already served', () => {
  const { scheduler, filler } = heldPool();
  const a1 = wait(scheduler, 'member_a');
  const b1 = wait(scheduler, 'member_b');
  scheduler.releaseLease(filler.lease_id);
  assert.equal(handOut(scheduler).lease_id, b1.lease_id, 'A then B served: B is next served, A first served earlier');
  const b2 = wait(scheduler, 'member_b');
  const a2 = wait(scheduler, 'member_a');
  assert.equal(scheduler.getLease(a1.lease_id).state, 'released');
  // A was served before B, so A goes ahead of B although B's turn arrived first.
  assert.equal(handOut(scheduler).lease_id, a2.lease_id);
  assert.equal(handOut(scheduler).lease_id, b2.lease_id);
});

test('the node owner still goes first on their node, and E52 still holds them back once', () => {
  const { scheduler, filler } = heldPool();
  const other = wait(scheduler, 'member_a');
  const own1 = wait(scheduler, 'member_node');
  const own2 = wait(scheduler, 'member_node');
  scheduler.releaseLease(filler.lease_id);
  assert.equal(scheduler.getLease(own1.lease_id).state, 'active', 'the owner goes ahead of a waiting member');
  assert.equal(handOut(scheduler).lease_id, other.lease_id, 'but not twice in a row while someone waits');
  assert.equal(handOut(scheduler).lease_id, own2.lease_id);
});

test('orderWaiting: continuations and the owner keep their tiers; round-robin applies only to the rest', () => {
  const rank = (ranks) => (memberId) => ranks[memberId] ?? 0;
  const items = [
    { id: 'a1', member_id: 'member_a', seq: 0 }, { id: 'a2', member_id: 'member_a', seq: 1 },
    { id: 'b1', member_id: 'member_b', seq: 2 }, { id: 'own', member_id: 'member_o', seq: 3 },
    { id: 'c1', member_id: 'member_c', seq: 4 }, { id: 'cont', member_id: 'member_a', seq: 5, continuation: true },
  ];
  const ids = (list) => list.map((i) => i.id);
  assert.deepEqual(ids(orderWaiting(items, { member_id: 'member_o' }, undefined, rank({}))),
    ['cont', 'own', 'a1', 'b1', 'c1', 'a2']);
  assert.deepEqual(ids(orderWaiting(items, { member_id: 'member_o' }, true, rank({}))),
    ['cont', 'a1', 'b1', 'c1', 'a2', 'own'], 'E52 hold-back is the last tier');
  assert.deepEqual(ids(orderWaiting(items, null, undefined, rank({ member_a: 5, member_b: 2 }))),
    ['cont', 'own', 'c1', 'b1', 'a1', 'a2'], 'pool-wide: never served first, then least recent, then the second round');
  assert.deepEqual(ids(orderWaiting(items, null)), ['cont', 'a1', 'a2', 'b1', 'own', 'c1'],
    'without a rank: today\'s arrival order');
});

test('the queue position a waiting lease reports is the order it is served in', () => {
  const { scheduler, filler } = heldPool();
  const a1 = wait(scheduler, 'member_a');
  const a2 = wait(scheduler, 'member_a');
  const b = wait(scheduler, 'member_b');
  const c = wait(scheduler, 'member_c');
  const positions = [a1, a2, b, c].map((lease) => [lease.lease_id, scheduler.getLease(lease.lease_id).position]);
  assert.deepEqual(positions.map(([, position]) => position), [1, 4, 2, 3],
    'A1 first, B and C next, then A\'s second turn');
  const byPosition = positions.sort((x, y) => x[1] - y[1]).map(([id]) => id);
  scheduler.releaseLease(filler.lease_id);
  const served = [byPosition[0]];
  for (let i = 0; i < 3; i += 1) served.push(handOut(scheduler).lease_id);
  assert.deepEqual(served, byPosition, 'served in exactly the reported order');
});

test('onChange reports the same positions the leases are served in', () => {
  const { scheduler, changes } = heldPool();
  const a1 = wait(scheduler, 'member_a');
  const a2 = wait(scheduler, 'member_a');
  const b = wait(scheduler, 'member_b');
  const queue = changes.filter((change) => change.type === 'queue').at(-1);
  assert.deepEqual(queue.positions.map((p) => p.lease_id), [a1.lease_id, b.lease_id, a2.lease_id]);
});

test('two places free in one batch: no member is served twice while another waits', () => {
  const { scheduler, filler } = heldPool();
  const a1 = wait(scheduler, 'member_a');
  const a2 = wait(scheduler, 'member_a');
  const b = wait(scheduler, 'member_b');
  // Registering the same device again with three slots frees two places in one dispatch.
  const again = scheduler.registerNode({ deviceId: 'device_1', memberId: 'member_node', slots: 3, models: [model('alpha')] });
  assert.equal(again.ok, true);
  const state = (lease) => scheduler.getLease(lease.lease_id).state;
  assert.deepEqual([state(filler), state(a1), state(b), state(a2)], ['active', 'active', 'active', 'queued'],
    'A and B are served, not A twice');
});

test('two nodes: each takes the least recently served member among the turns it is the choice for', () => {
  const fx = createScheduler();
  const alpha = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n1', models: [model('alpha')] });
  const beta = registerNode(fx.scheduler, { deviceId: 'device_2', memberId: 'member_n2', models: [model('beta')] });
  const fa = activeLease(fx.scheduler, { conversationKey: 'conv:p:fa', memberId: 'member_filler', model: 'alpha' }).lease;
  const fb = activeLease(fx.scheduler, { conversationKey: 'conv:p:fb', memberId: 'member_filler', model: 'beta' }).lease;
  const a1 = wait(fx.scheduler, 'member_a', { model: 'alpha' });
  const a2 = wait(fx.scheduler, 'member_a', { model: 'beta' });
  const b1 = wait(fx.scheduler, 'member_b', { model: 'beta' });
  fx.scheduler.releaseLease(fa.lease_id);
  assert.equal(fx.scheduler.getLease(a1.lease_id).node_id, alpha);
  fx.scheduler.releaseLease(fb.lease_id);
  const beta1 = fx.scheduler.getLease(b1.lease_id);
  assert.equal(beta1.state, 'active', 'A was just served on alpha: B takes the beta slot');
  assert.equal(beta1.node_id, beta);
  assert.equal(fx.scheduler.getLease(a2.lease_id).state, 'queued');
});

test('the served-member record never holds more entries than the member limit', () => {
  const record = createMemberServed({ max: 3 });
  for (let i = 0; i < 20; i += 1) record.mark(`member_${i}`);
  assert.equal(record.size(), 3);
  assert.equal(record.rank('member_19') > record.rank('member_18'), true, 'the latest served ranks highest');
  assert.equal(record.rank('member_0'), 0, 'an evicted member reads as never served');

});

test('the scheduler gives the record the member limit: a member forgotten at the limit reads as never served', () => {
  const { scheduler, filler } = heldPool({ limits: { maxMembers: 2 } });
  wait(scheduler, 'member_a');
  wait(scheduler, 'member_b');
  wait(scheduler, 'member_c');
  scheduler.releaseLease(filler.lease_id); // A is served, then B, then C: A is forgotten
  handOut(scheduler);
  handOut(scheduler);
  assert.equal(scheduler.listLeases().find((lease) => lease.state === 'active').member_id, 'member_c');
  // A arrives before N, and N was never served; A was forgotten, so they tie and arrival decides.
  const a = wait(scheduler, 'member_a');
  const n = wait(scheduler, 'member_n');
  assert.equal(handOut(scheduler).lease_id, a.lease_id);
  assert.equal(scheduler.getLease(n.lease_id).state, 'queued');
});

// A node with the given slots owned by member_o, with one other waiting member M; a lease of `memberId` takes a slot.
function ownerPool(slots) {
  const fx = createScheduler();
  fx.nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_o', slots });
  return fx;
}
const positionsOf = (scheduler) => scheduler.listLeases().filter((l) => l.state === 'queued')
  .sort((x, y) => x.position - y.position).map((l) => l.lease_id);

test('one node: the positions put its owner first even when rank alone would not, and the owner is served first', () => {
  const { scheduler } = ownerPool(1);
  const filler = activeLease(scheduler, { conversationKey: 'conv:p:filler', memberId: 'member_o' }).lease; // the owner is served
  const m = wait(scheduler, 'member_m'); // M never served: rank alone puts M first
  const own = wait(scheduler, 'member_o');
  assert.deepEqual(positionsOf(scheduler), [own.lease_id, m.lease_id]);
  scheduler.releaseLease(filler.lease_id);
  assert.equal(scheduler.getLease(own.lease_id).state, 'active', 'served in the order shown');
});

test('one node, after the owner went ahead once (E52): the positions put the member first, and the member is served', () => {
  const { scheduler } = ownerPool(2);
  const lm = activeLease(scheduler, { conversationKey: 'conv:p:lm', memberId: 'member_m' }).lease;
  const first = activeLease(scheduler, { conversationKey: 'conv:p:first', memberId: 'member_o' }).lease;
  const m = wait(scheduler, 'member_m');
  const own1 = wait(scheduler, 'member_o');
  scheduler.releaseLease(first.lease_id);
  assert.equal(scheduler.getLease(own1.lease_id).state, 'active', 'the owner went ahead of M');
  // M is served again through a job on its lease, so by rank alone the owner would come before M.
  assert.equal(scheduler.createJob(lm.lease_id, { requestBytes: Buffer.from('{}') }).ok, true);
  const own2 = wait(scheduler, 'member_o');
  assert.deepEqual(positionsOf(scheduler), [m.lease_id, own2.lease_id], 'held back behind M');
  scheduler.releaseLease(own1.lease_id);
  assert.equal(scheduler.getLease(m.lease_id).state, 'active', 'M is served, as shown');
  assert.equal(scheduler.getLease(own2.lease_id).state, 'queued');
});

test('a job on a lease counts as the member being served, and the queue positions follow', () => {
  const fx = createScheduler();
  const { scheduler, changes } = fx;
  const nodeId = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_node', slots: 3 });
  const la = activeLease(scheduler, { conversationKey: 'conv:p:la', memberId: 'member_a' }).lease;
  const opening = scheduler.createJob(la.lease_id, { requestBytes: Buffer.from('{}') }).job;
  scheduler.claim(nodeId, 1);
  scheduler.acceptChunk(opening.job_id, nodeId, 0, Buffer.from('data: [DONE]\n\n'), true);
  const lb = activeLease(scheduler, { conversationKey: 'conv:p:lb', memberId: 'member_b' }).lease;
  const lc = activeLease(scheduler, { conversationKey: 'conv:p:lc', memberId: 'member_c' }).lease;
  const a = wait(scheduler, 'member_a');
  const b = wait(scheduler, 'member_b');
  const c = wait(scheduler, 'member_c');
  assert.deepEqual(positionsOf(scheduler), [a.lease_id, b.lease_id, c.lease_id], 'A was served first');
  // A keeps its lease busy with a follow-up turn after B and C were served.
  assert.equal(scheduler.createJob(la.lease_id, { requestBytes: Buffer.from('{}') }).ok, true);
  assert.deepEqual(positionsOf(scheduler), [b.lease_id, c.lease_id, a.lease_id]);
  assert.deepEqual(changes.filter((change) => change.type === 'queue').at(-1).positions.map((p) => p.lease_id),
    [b.lease_id, c.lease_id, a.lease_id], 'the feed published the new positions');
  scheduler.releaseLease(lb.lease_id);
  scheduler.releaseLease(lc.lease_id);
  scheduler.releaseLease(la.lease_id);
  assert.deepEqual([b, c, a].map((lease) => scheduler.getLease(lease.lease_id).state), ['active', 'active', 'active']);
  assert.equal(scheduler.listLeases().filter((lease) => lease.state === 'queued').length, 0);
});

test('a job on a lease with nobody queued stays quiet: no queue event', () => {
  const { scheduler, changes } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_node' });
  const lease = activeLease(scheduler).lease;
  const before = changes.length;
  scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') });
  assert.deepEqual(changes.slice(before).map((change) => change.type), ['job']);
});

test('the claim order of a node\'s jobs ignores the member record: a continuation job goes first', () => {
  const { scheduler } = createScheduler();
  const nodeId = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_node', slots: 2 });
  const la = activeLease(scheduler, { conversationKey: 'conv:p:la', memberId: 'member_a' }).lease;
  const lb = activeLease(scheduler, { conversationKey: 'conv:p:lb', memberId: 'member_b' }).lease;
  const opening = scheduler.createJob(la.lease_id, { requestBytes: Buffer.from('{}') }).job;
  scheduler.claim(nodeId, 1);
  scheduler.acceptChunk(opening.job_id, nodeId, 0, Buffer.from('data: [DONE]\n\n'), true);
  const fresh = scheduler.createJob(lb.lease_id, { requestBytes: Buffer.from('{}') }).job;
  const continuation = scheduler.createJob(la.lease_id, { requestBytes: Buffer.from('{}') }).job;
  // B was served more recently than A until the continuation; the continuation job still goes first.
  assert.equal(scheduler.claim(nodeId, 2).job.job_id, continuation.job_id);
  assert.equal(scheduler.claim(nodeId, 3).job.job_id, fresh.job_id);
});
