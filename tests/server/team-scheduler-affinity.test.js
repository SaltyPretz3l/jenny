'use strict';

// Team slice 4d (scheduler half): a lease request may carry the nodes it is
// allowed on (`allowedNodes`). Eligibility refuses any other node, in principle
// and when a slot frees; affinity to a node that is not allowed is ignored; an
// exclusion and a list that allows only the excluded node refuse together.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createExclusions } = require('../../server/team/scheduler/affinity');
const { chooseNode, isEligible } = require('../../server/team/scheduler/selection');
const {
  activeLease, createScheduler, model, registerNode, requestLease,
} = require('./helpers/team-pool-fixture');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// Two alpha nodes, A registered first.
function twoNodes(options) {
  const fx = createScheduler(options);
  const a = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  const b = registerNode(fx.scheduler, { deviceId: 'device_2', memberId: 'member_b' });
  return { ...fx, a, b };
}

const reason = (result) => result.error?.reason;

// ---------------------------------------------------------------------------
// The pure pieces.

function node(id, overrides = {}) {
  return {
    node_id: id, member_id: `member_${id}`, online: true, paused: false, slots: 1, busy_slots: 0,
    last_served_at: 0, order: 0, models: [model('alpha')], ...overrides,
  };
}

test('eligibility: a node outside the allowed list is refused; absent or null means any', () => {
  const want = { model: 'alpha', wantsVision: false };
  assert.equal(isEligible(node('a'), want, {}), true);
  assert.equal(isEligible(node('a'), { ...want, allowedNodes: null }, {}), true);
  assert.equal(isEligible(node('a'), { ...want, allowedNodes: ['b'] }, {}), false);
  assert.equal(isEligible(node('a'), { ...want, allowedNodes: ['b', 'a'] }, {}), true);
  assert.equal(isEligible(node('a'), { ...want, allowedNodes: ['b'] }, { ignoreSlots: true }), false,
    'refused in principle as well');
});

test('choice: affinity to a node that is not allowed is ignored', () => {
  const nodes = [node('a', { last_served_at: 1 }), node('b', { order: 1, last_served_at: 5 })];
  const want = { model: 'alpha', wantsVision: false, allowedNodes: ['b'] };
  assert.equal(chooseNode(nodes, want, { affinityNodeId: 'a' }).node_id, 'b');
  assert.equal(chooseNode(nodes, { ...want, allowedNodes: ['c'] }, { affinityNodeId: 'a' }), null);
});

// ---------------------------------------------------------------------------
// The request shape.

test('allowedNodes: absent and null are accepted and mean any node', () => {
  const { scheduler } = twoNodes();
  assert.equal(requestLease(scheduler, { conversationKey: 'conv:p:1' }).ok, true);
  assert.equal(requestLease(scheduler, { conversationKey: 'conv:p:2', allowedNodes: null }).ok, true);
  assert.equal(requestLease(scheduler, { conversationKey: 'conv:p:3', allowedNodes: undefined, memberId: 'member_c' }).ok, true);
});

test('allowedNodes: an empty array, a non-array, a duplicate, a bad id and too many are lease_request_invalid', () => {
  const { scheduler, a } = twoNodes();
  const many = Array.from({ length: scheduler.limits.maxNodes + 1 }, (_, i) => `node_${i}`);
  // The last two have holes: a hole must be refused, not stored as undefined.
  const bad = [[], 'node_x', a, { 0: a }, 7, true, [a, a], [''], ['device_1'], ['node_'], [7], [null], [`${a}!`], many,
    [, a], [a, , a]]; // eslint-disable-line no-sparse-arrays
  for (const allowedNodes of bad) {
    const result = requestLease(scheduler, { allowedNodes });
    assert.equal(reason(result), 'lease_request_invalid', JSON.stringify(allowedNodes));
  }
  assert.equal(scheduler.listLeases().length, 0, 'nothing was queued or activated');
  const exactly = Array.from({ length: scheduler.limits.maxNodes }, (_, i) => `node_${i}`);
  assert.equal(reason(requestLease(scheduler, { allowedNodes: exactly })), 'no_eligible_node',
    'maxNodes distinct ids is a valid list (none of them is a node here)');
  assert.equal(requestLease(scheduler, { allowedNodes: [a] }).ok, true);
});

test('the lease view does not grow a field for the list', () => {
  const { scheduler, a } = twoNodes();
  const lease = requestLease(scheduler, { allowedNodes: [a] }).lease;
  assert.equal(Object.keys(lease).some((key) => /allowed/iu.test(key)), false);
  assert.equal(Object.keys(scheduler.getLease(lease.lease_id)).some((key) => /allowed/iu.test(key)), false);
});

test('the list is copied: changing the caller\'s array afterwards changes nothing', () => {
  const { scheduler, b } = twoNodes();
  const filler = activeLease(scheduler, { conversationKey: 'conv:p:filler', allowedNodes: [b] }).lease;
  const list = [b];
  const waiting = requestLease(scheduler, { conversationKey: 'conv:p:1', allowedNodes: list }).lease;
  list.length = 0;
  list.push('node_other');
  assert.equal(scheduler.getLease(waiting.lease_id).state, 'queued', 'A is free but not allowed');
  scheduler.releaseLease(filler.lease_id);
  assert.equal(scheduler.getLease(waiting.lease_id).node_id, b);
});

// ---------------------------------------------------------------------------
// Through the facade.

test('a lease allowed only on B waits for B while A is free, and is served when B frees', () => {
  const { scheduler, a, b } = twoNodes();
  const filler = activeLease(scheduler, { conversationKey: 'conv:p:filler', allowedNodes: [b] }).lease;
  assert.equal(filler.node_id, b, 'A was free and older served, yet only B is allowed');
  const waiting = requestLease(scheduler, { conversationKey: 'conv:p:1', memberId: 'member_c', allowedNodes: [b] }).lease;
  assert.equal(waiting.state, 'queued', 'A is free but not allowed');
  const anywhere = requestLease(scheduler, { conversationKey: 'conv:p:2', memberId: 'member_d' }).lease;
  assert.equal(anywhere.node_id, a, 'a lease with no list takes the free node');
  scheduler.releaseLease(filler.lease_id);
  const served = scheduler.getLease(waiting.lease_id);
  assert.deepEqual([served.state, served.node_id], ['active', b]);
});

test('a waiting lease that is not allowed on the free node does not hold up the others', () => {
  const { scheduler, a, b } = twoNodes();
  const filler = activeLease(scheduler, { conversationKey: 'conv:p:filler', allowedNodes: [b] }).lease;
  const stuck = requestLease(scheduler, { conversationKey: 'conv:p:1', memberId: 'member_c', allowedNodes: [b] }).lease;
  const free = activeLease(scheduler, { conversationKey: 'conv:p:2', memberId: 'member_d' }).lease;
  assert.equal(free.node_id, a);
  scheduler.releaseLease(free.lease_id);
  assert.equal(scheduler.getLease(stuck.lease_id).state, 'queued');
  scheduler.releaseLease(filler.lease_id);
  assert.equal(scheduler.getLease(stuck.lease_id).state, 'active');
});

test('affinity to A with A not allowed: an allowed node serves the lease', () => {
  const { scheduler, a, b } = twoNodes();
  const first = activeLease(scheduler, { conversationKey: 'conv:p:1' }).lease;
  assert.equal(first.node_id, a);
  scheduler.releaseLease(first.lease_id);
  const again = requestLease(scheduler, { conversationKey: 'conv:p:1', allowedNodes: [b] }).lease;
  assert.equal(again.node_id, b, 'affinity to A is ignored');
  scheduler.releaseLease(again.lease_id);
  const unrestricted = requestLease(scheduler, { conversationKey: 'conv:p:1' }).lease;
  assert.equal(unrestricted.node_id, b, 'the affinity now follows the conversation to B');
});

test('no allowed node eligible in principle: no_eligible_node and nothing queued', () => {
  const { scheduler, a, b } = twoNodes();
  scheduler.setNodePaused(b, { on: true });
  assert.equal(reason(requestLease(scheduler, { allowedNodes: [b] })), 'no_eligible_node', 'paused');
  assert.equal(reason(requestLease(scheduler, { allowedNodes: ['node_unknown'] })), 'no_eligible_node', 'not a node');
  assert.equal(reason(requestLease(scheduler, { allowedNodes: [b, 'node_unknown'] })), 'no_eligible_node');
  const beta = registerNode(scheduler, { deviceId: 'device_3', memberId: 'member_c', models: [model('beta')] });
  assert.equal(reason(requestLease(scheduler, { allowedNodes: [beta] })), 'no_eligible_node', 'the model is not on it');
  assert.equal(scheduler.listLeases().length, 0, 'nothing was queued');
  assert.equal(requestLease(scheduler, { allowedNodes: [b, a] }).lease.node_id, a, 'one allowed node is enough');
});

test('an exclusion and a list that allows only the excluded node: no_eligible_node until it ends or retry anyway', () => {
  const fx = twoNodes();
  const start = fx.clock();
  const { scheduler, a, b } = fx;
  const { lease } = activeLease(scheduler, { conversationKey: 'conv:p:1' });
  assert.equal(lease.node_id, a);
  const job = scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
  scheduler.claim(a, 1);
  scheduler.failJob(job.job_id, a, 'engine_error');
  assert.equal(reason(requestLease(scheduler, { conversationKey: 'conv:p:1', allowedNodes: [a] })), 'no_eligible_node');
  assert.equal(requestLease(scheduler, { conversationKey: 'conv:p:1', allowedNodes: [a, b] }).lease.node_id, b,
    'a list that also allows another node still works');
  assert.equal(scheduler.listLeases().filter((l) => l.state === 'queued').length, 0, 'the refusal queued nothing');
  const retry = requestLease(scheduler, { conversationKey: 'conv:p:1', allowedNodes: [a], retryAnyway: true });
  assert.equal(retry.lease.node_id, a, 'retry anyway clears the exclusion');
  scheduler.releaseLease(retry.lease.lease_id);

  // The exclusion also ends by itself after 10 minutes.
  const second = activeLease(scheduler, { conversationKey: 'conv:p:2', memberId: 'member_c', allowedNodes: [a] }).lease;
  const job2 = scheduler.createJob(second.lease_id, { requestBytes: Buffer.from('{}') }).job;
  scheduler.claim(a, 2);
  scheduler.failJob(job2.job_id, a, 'engine_error');
  const failedAt = fx.clock();
  for (let t = failedAt - start + 20 * SECOND; t < failedAt - start + 10 * MINUTE; t += 20 * SECOND) {
    fx.clock.set(start + t);
    scheduler.touchNode(a);
    scheduler.touchNode(b);
  }
  fx.clock.set(failedAt + 10 * MINUTE - 1);
  assert.equal(reason(requestLease(scheduler, { conversationKey: 'conv:p:2', allowedNodes: [a] })), 'no_eligible_node');
  fx.clock.set(failedAt + 10 * MINUTE);
  assert.equal(requestLease(scheduler, { conversationKey: 'conv:p:2', allowedNodes: [a] }).lease.node_id, a);
});

test('an allowed node that goes offline while the lease waits: it keeps waiting and is served when the node returns', () => {
  const fx = twoNodes();
  const { scheduler, a, b } = fx;
  const start = fx.clock();
  const filler = activeLease(scheduler, { conversationKey: 'conv:p:filler', allowedNodes: [b] }).lease;
  const waiting = requestLease(scheduler, { conversationKey: 'conv:p:1', memberId: 'member_c', allowedNodes: [b] }).lease;
  for (let t = 20 * SECOND; t <= 5 * MINUTE; t += 20 * SECOND) {
    fx.clock.set(start + t);
    scheduler.touchNode(a);
    if (t < 30 * SECOND) scheduler.touchNode(b);
    scheduler.sweep(start + t);
  }
  assert.equal(scheduler.listNodes().find((n) => n.node_id === b).online, false, 'B went silent');
  assert.equal(scheduler.getLease(filler.lease_id).state, 'expired');
  assert.equal(scheduler.getLease(waiting.lease_id).state, 'queued', 'A is online and free, but not allowed');
  scheduler.touchNode(b);
  assert.deepEqual([scheduler.getLease(waiting.lease_id).state, scheduler.getLease(waiting.lease_id).node_id], ['active', b]);
});

test('an allowed node that is removed while the lease waits: it waits out the queue limit, then fails queue_timeout', () => {
  const fx = twoNodes();
  const { scheduler, b } = fx;
  const start = fx.clock();
  activeLease(scheduler, { conversationKey: 'conv:p:filler', allowedNodes: [b] });
  const waiting = requestLease(scheduler, { conversationKey: 'conv:p:1', memberId: 'member_c', allowedNodes: [b] }).lease;
  assert.equal(scheduler.unregisterNode(b).ok, true);
  assert.equal(scheduler.getLease(waiting.lease_id).state, 'queued');
  scheduler.sweep(start + 10 * MINUTE - 1);
  assert.equal(scheduler.getLease(waiting.lease_id).state, 'queued');
  scheduler.sweep(start + 10 * MINUTE);
  assert.deepEqual([scheduler.getLease(waiting.lease_id).state, scheduler.getLease(waiting.lease_id).reason], ['failed', 'queue_timeout']);
});

// ---------------------------------------------------------------------------
// A node's id is a fixed function of its device, so a saved list keeps matching.

test('a listed node still matches after it unregisters and registers again; the unlisted free node is never used', () => {
  const fx = twoNodes();
  const busy = activeLease(fx.scheduler, { conversationKey: 'conv:project_a:other', memberId: 'member_x', allowedNodes: [fx.b] });
  assert.equal(busy.lease.node_id, fx.b);
  const waiting = requestLease(fx.scheduler, { allowedNodes: [fx.b] });
  assert.equal(waiting.lease.state, 'queued', 'B is busy and A is not allowed: the turn waits');
  assert.equal(fx.scheduler.listNodes().find((node) => node.node_id === fx.a).busy_slots, 0);
  assert.equal(fx.scheduler.unregisterNode(fx.b).ok, true);
  assert.equal(fx.scheduler.listNodes().length, 1);
  assert.equal(registerNode(fx.scheduler, { deviceId: 'device_2', memberId: 'member_b' }), fx.b, 'the same device, the same id');
  const lease = fx.scheduler.getLease(waiting.lease.lease_id);
  assert.deepEqual([lease.state, lease.node_id], ['active', fx.b]);
});

// ---------------------------------------------------------------------------
// Medium: the retry exclusion keeps a few nodes per conversation, not one.

test('two broken nodes do not take turns while a healthy third idles', () => {
  const { scheduler, clock } = createScheduler();
  const a = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  const b = registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_b' });
  const c = registerNode(scheduler, { deviceId: 'device_3', memberId: 'member_c' });
  let claimSeq = 0;
  const failOn = (conversationKey, expected) => {
    clock.advance(SECOND);
    const lease = requestLease(scheduler, { conversationKey }).lease;
    assert.equal(lease.node_id, expected);
    const job = scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
    claimSeq += 1;
    scheduler.claim(expected, claimSeq);
    scheduler.failJob(job.job_id, expected, 'engine_error');
  };
  failOn('conv:p:1', a);
  failOn('conv:p:1', b);
  // C then serves someone else, so it is the most recently served: only the exclusions keep A and B away.
  clock.advance(SECOND);
  const other = requestLease(scheduler, { conversationKey: 'conv:p:other', memberId: 'member_c' }).lease;
  assert.equal(other.node_id, c);
  scheduler.releaseLease(other.lease_id);
  clock.advance(SECOND);
  const third = requestLease(scheduler, { conversationKey: 'conv:p:1' }).lease;
  assert.equal(third.node_id, c, 'both failed nodes stay excluded for this conversation');
});

test('the exclusion set holds the newest four nodes, drops the oldest, and ends together after 10 minutes', () => {
  const ex = createExclusions({ max: 1024, ttlMs: 10 * MINUTE });
  for (const [i, id] of ['n1', 'n2', 'n3', 'n4', 'n5'].entries()) ex.exclude('conv:p:1', id, i);
  assert.deepEqual(ex.getAll('conv:p:1', 10), ['n2', 'n3', 'n4', 'n5']);
  assert.equal(ex.getAll('conv:p:1', 10).at(-1), 'n5', 'the newest one last');
  ex.exclude('conv:p:1', 'n3', 20);
  assert.deepEqual(ex.getAll('conv:p:1', 21), ['n2', 'n4', 'n5', 'n3'], 'a repeat moves to the newest, no duplicate');
  assert.equal(ex.getAll('conv:p:1', 20 + 10 * MINUTE - 1).length, 4);
  assert.deepEqual(ex.getAll('conv:p:1', 20 + 10 * MINUTE), []);
});
