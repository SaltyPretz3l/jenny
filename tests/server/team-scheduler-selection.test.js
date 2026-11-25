'use strict';

// Team slice 4a-1: eligibility and node choice ("Choosing a node"), the wait
// order, the affinity map and the retry exclusion.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createAffinityMap, createExclusions } = require('../../server/team/scheduler/affinity');
const { orderWaiting } = require('../../server/team/scheduler/queue');
const { isEligible, chooseNode } = require('../../server/team/scheduler/selection');
const {
  activeLease, createClock, createScheduler, model, registerNode, requestLease,
} = require('./helpers/team-pool-fixture');

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// ---------------------------------------------------------------------------
// The pure pieces.

function node(id, overrides = {}) {
  return {
    node_id: id, member_id: `member_${id}`, online: true, paused: false, slots: 1, busy_slots: 0,
    last_served_at: 0, order: 0, models: [model('alpha'), model('seer', { vision: true })], ...overrides,
  };
}

test('eligibility: online, not paused, a free slot, the model advertised, not excluded', () => {
  const want = { model: 'alpha', wantsVision: false };
  assert.equal(isEligible(node('a'), want, {}), true);
  assert.equal(isEligible(node('a', { online: false }), want, {}), false);
  assert.equal(isEligible(node('a', { paused: true }), want, {}), false);
  assert.equal(isEligible(node('a', { busy_slots: 1 }), want, {}), false);
  assert.equal(isEligible(node('a', { busy_slots: 1 }), want, { ignoreSlots: true }), true);
  assert.equal(isEligible(node('a', { models: [model('beta')] }), want, {}), false);
  assert.equal(isEligible(node('a'), want, { excludedNodeIds: ['a'] }), false);
  assert.equal(isEligible(node('a'), { model: 'alpha', wantsVision: true }, {}), false, 'vision needs a vision model');
  assert.equal(isEligible(node('a'), { model: 'seer', wantsVision: true }, {}), true);
  assert.equal(isEligible(node('a', { models: [model('alpha', { contextLength: 4096 })] }), want, {}), true,
    'a context length never decides eligibility (slice 4f: each turn is sized for its own model)');
});

test('choice: the affinity node when eligible and free, else the oldest last_served_at', () => {
  const want = { model: 'alpha', wantsVision: false };
  const nodes = [node('a', { last_served_at: 30 }), node('b', { last_served_at: 10, order: 1 }),
    node('c', { last_served_at: 20, order: 2 })];
  assert.equal(chooseNode(nodes, want, { affinityNodeId: 'c' }).node_id, 'c');
  assert.equal(chooseNode(nodes, want, {}).node_id, 'b');
  nodes[2].busy_slots = 1;
  assert.equal(chooseNode(nodes, want, { affinityNodeId: 'c' }).node_id, 'b', 'a busy affinity node is ignored');
  assert.equal(chooseNode(nodes, want, { affinityNodeId: 'b', excludedNodeIds: ['b'] }).node_id, 'a');
  assert.equal(chooseNode([node('a', { busy_slots: 1 })], want, {}), null);
});

test('the wait order: continuations first, then the node owner\'s own turns, then arrival', () => {
  const items = [
    { id: 'new-1', continuation: false, member_id: 'member_x', seq: 1 },
    { id: 'own', continuation: false, member_id: 'member_owner', seq: 2 },
    { id: 'cont', continuation: true, member_id: 'member_y', seq: 3 },
    { id: 'new-0', continuation: false, member_id: 'member_z', seq: 0 },
  ];
  assert.deepEqual(orderWaiting(items, { member_id: 'member_owner' }).map((i) => i.id), ['cont', 'own', 'new-0', 'new-1']);
  assert.deepEqual(orderWaiting(items, null).map((i) => i.id), ['cont', 'new-0', 'new-1', 'own']);
  assert.deepEqual(orderWaiting(items, { member_id: 'member_owner' }, true).map((i) => i.id),
    ['cont', 'new-0', 'new-1', 'own'], 'E52: an owner who just went ahead waits behind the others');
  assert.deepEqual(items.map((i) => i.id), ['new-1', 'own', 'cont', 'new-0'], 'the input is not reordered');
});

test('the affinity map holds 1,024 entries, evicts the oldest and expires after 30 idle minutes', () => {
  const map = createAffinityMap({ max: 1024, idleMs: 30 * MINUTE });
  for (let i = 0; i < 1024; i += 1) map.set(`k${i}`, 'node_a', 1000 + i);
  map.set('k0', 'node_b', 5000);
  map.set('k1024', 'node_c', 5001);
  assert.equal(map.get('k1', 5001), null, 'the least recently used entry was evicted');
  for (let i = 2; i <= 1024; i += 1) assert.notEqual(map.get(`k${i}`, 5001), null, `k${i} kept: 1,024 entries`);
  assert.equal(map.get('k0', 5001), 'node_b', 'a refreshed entry survives');
  assert.equal(map.get('k0', 5000 + 30 * MINUTE - 1), 'node_b');
  assert.equal(map.get('k1024', 5001 + 30 * MINUTE), null, 'expired at 30 minutes idle');
  map.sweep(10_000_000);
  assert.equal(map.get('k0', 10_000_000), null);
});

test('the exclusion lasts 10 minutes and is cleared explicitly', () => {
  const ex = createExclusions({ max: 1024, ttlMs: 10 * MINUTE });
  ex.exclude('conv:p:1', 'node_a', 0);
  assert.deepEqual(ex.getAll('conv:p:1', 10 * MINUTE - 1), ['node_a']);
  assert.deepEqual(ex.getAll('conv:p:1', 10 * MINUTE), []);
  ex.exclude('conv:p:1', 'node_a', 0);
  ex.clear('conv:p:1');
  assert.deepEqual(ex.getAll('conv:p:1', 1), []);
  for (let i = 0; i < 1100; i += 1) ex.exclude(`c${i}`, 'n', 1);
  assert.deepEqual(ex.getAll('c75', 2), [], 'the oldest entries were evicted');
  for (let i = 76; i < 1100; i += 1) assert.deepEqual(ex.getAll(`c${i}`, 2), ['n'], `c${i} kept: 1,024 entries`);
});

// ---------------------------------------------------------------------------
// Through the facade.

test('refusals before any queue: model_not_in_pool, model_lacks_vision, no_eligible_node', () => {
  const { scheduler } = createScheduler();
  assert.equal(requestLease(scheduler).error.reason, 'model_not_in_pool', 'an empty pool');
  const nodeId = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n',
    models: [model('alpha'), model('seer', { vision: true })] });
  assert.equal(requestLease(scheduler, { model: 'gamma' }).error.reason, 'model_not_in_pool');
  assert.equal(requestLease(scheduler, { wantsVision: true }).error.reason, 'model_lacks_vision');
  assert.equal(requestLease(scheduler, { model: 'seer', wantsVision: true }).lease.state, 'active');
  scheduler.setNodePaused(nodeId, { on: true, stopRunning: false });
  assert.equal(requestLease(scheduler, { conversationKey: 'conv:p:2' }).error.reason, 'no_eligible_node');
  assert.equal(scheduler.listLeases().filter((l) => l.state === 'queued').length, 0, 'nothing was queued');
  for (const failure of [requestLease(scheduler, { model: 'gamma' })]) {
    assert.equal(failure.error.code, 'CMP-HOST-0007');
  }
});

test('a model only an offline node advertises is not in the pool', () => {
  const fx = createScheduler();
  registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  fx.scheduler.sweep(fx.clock() + 30 * SECOND);
  assert.equal(requestLease(fx.scheduler).error.reason, 'model_not_in_pool');
});

test('a lease goes to the node that advertises its model', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a', models: [model('alpha')] });
  const beta = registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_b', models: [model('beta')] });
  assert.equal(requestLease(scheduler, { model: 'beta' }).lease.node_id, beta);
});

test('the affinity node wins when free and is passed over when busy', () => {
  const { scheduler, clock } = createScheduler();
  const a = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  const b = registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_b' });
  const first = activeLease(scheduler, { conversationKey: 'conv:p:1' }).lease;
  assert.equal(first.node_id, a, 'both never served: registration order');
  scheduler.releaseLease(first.lease_id);
  clock.advance(SECOND);
  const second = activeLease(scheduler, { conversationKey: 'conv:p:2' }).lease;
  assert.equal(second.node_id, b, 'the oldest last_served_at');
  scheduler.releaseLease(second.lease_id);
  clock.advance(SECOND);
  // a was served first, so the oldest-served rule alone would pick a.
  const again = activeLease(scheduler, { conversationKey: 'conv:p:2' }).lease;
  assert.equal(again.node_id, b, 'affinity beats the oldest served');
  const busy = requestLease(scheduler, { conversationKey: 'conv:p:2', memberId: 'member_c' });
  assert.equal(busy.lease.node_id, a, 'the affinity node b is busy, so the free node takes it');
});

test('a failed job excludes its node for that conversation only, for 10 minutes', () => {
  const fx = createScheduler();
  const start = fx.clock();
  const a = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  const b = registerNode(fx.scheduler, { deviceId: 'device_2', memberId: 'member_b' });
  const { lease } = activeLease(fx.scheduler, { conversationKey: 'conv:p:1' });
  assert.equal(lease.node_id, a);
  const job = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
  fx.scheduler.claim(a, 1);
  fx.scheduler.failJob(job.job_id, a, 'engine_error');
  const retry = activeLease(fx.scheduler, { conversationKey: 'conv:p:1' }).lease;
  assert.equal(retry.node_id, b, 'the retry goes to another node');
  fx.scheduler.releaseLease(retry.lease_id);
  const unrelated = activeLease(fx.scheduler, { conversationKey: 'conv:p:2' }).lease;
  assert.equal(unrelated.node_id, a, 'another conversation may use the node');
  fx.scheduler.releaseLease(unrelated.lease_id);
  // With b gone, conv:p:1 has no eligible node until the exclusion ends or retry-anyway.
  fx.scheduler.unregisterNode(b);
  assert.equal(requestLease(fx.scheduler, { conversationKey: 'conv:p:1' }).error.reason, 'no_eligible_node');
  for (let t = 20 * SECOND; t <= 10 * MINUTE; t += 20 * SECOND) { fx.clock.set(start + t); fx.scheduler.touchNode(a); }
  fx.clock.set(start + 10 * MINUTE - 1);
  assert.equal(requestLease(fx.scheduler, { conversationKey: 'conv:p:1' }).error.reason, 'no_eligible_node');
  fx.clock.set(start + 10 * MINUTE);
  assert.equal(requestLease(fx.scheduler, { conversationKey: 'conv:p:1' }).lease.node_id, a);
});

test('retry anyway clears the exclusion', () => {
  const { scheduler } = createScheduler();
  const a = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  const { lease } = activeLease(scheduler);
  const job = scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
  scheduler.claim(a, 1);
  scheduler.failJob(job.job_id, a, 'engine_timeout');
  assert.equal(requestLease(scheduler).error.reason, 'no_eligible_node');
  assert.equal(requestLease(scheduler, { retryAnyway: true }).lease.node_id, a);
});

test('a cancel does not exclude the node', () => {
  const { scheduler } = createScheduler();
  const a = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  const { lease } = activeLease(scheduler);
  scheduler.cancelLease(lease.lease_id);
  assert.equal(requestLease(scheduler).lease.node_id, a);
});

test('R16-F02: a busy node (paused) fails its unclaimed job at once, excludes nothing, and a pause is contact', () => {
  const fx = createScheduler();
  const start = fx.clock();
  const a = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  const { lease } = activeLease(fx.scheduler);
  const job = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
  fx.clock.set(start + 20 * SECOND);
  assert.equal(fx.scheduler.setNodePaused(a, { on: true }).ok, true);
  const ended = fx.scheduler.getLease(lease.lease_id);
  assert.deepEqual([fx.scheduler.getJob(job.job_id).state, ended.state, ended.reason], ['failed', 'failed', 'node_busy']);
  fx.clock.set(start + 45 * SECOND);
  fx.scheduler.sweep(fx.clock());
  assert.equal(fx.scheduler.listNodes()[0].online, true, 'the pause counted as contact');
  assert.equal(requestLease(fx.scheduler).error.reason, 'no_eligible_node', 'no turn goes to a busy node');
  fx.scheduler.setNodePaused(a, { on: false });
  assert.equal(requestLease(fx.scheduler).lease.node_id, a, 'the conversation is not locked out');
});

test('R16-F02: a job asked of a busy node is refused node_busy; its lease ends at once and excludes nothing', () => {
  const { scheduler } = createScheduler();
  const a = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  const { lease } = activeLease(scheduler);
  scheduler.setNodePaused(a, { on: true });
  assert.equal(scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).error.reason, 'node_busy');
  assert.equal(scheduler.getLease(lease.lease_id).state, 'failed');
  assert.equal(scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).error.reason, 'lease_not_active',
    'a retried job finds no lease');
  scheduler.setNodePaused(a, { on: false });
  assert.equal(requestLease(scheduler).lease.node_id, a);
});

test('R16-F02: a job a node gives back node_busy excludes it like any fail; a job never claimed excludes nothing', () => {
  const fx = createScheduler();
  const start = fx.clock();
  const a = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  const { lease } = activeLease(fx.scheduler);
  const job = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
  fx.scheduler.claim(a, 1);
  assert.equal(fx.scheduler.failJob(job.job_id, a, 'node_busy').ok, true);
  assert.equal(fx.scheduler.getLease(lease.lease_id).reason, 'node_busy');
  const again = requestLease(fx.scheduler);
  assert.equal(again.lease?.state === 'active' && again.lease.node_id === a, false,
    'a node cannot fail turn after turn for free: its own give-back excludes it for the conversation');
  const second = activeLease(fx.scheduler, { conversationKey: 'conv:p:9' }).lease;
  assert.equal(second.node_id, a, 'another conversation still reaches it');
  fx.scheduler.createJob(second.lease_id, { requestBytes: Buffer.from('{}') });
  fx.scheduler.sweep(start + 30 * SECOND);
  assert.deepEqual([fx.scheduler.getLease(second.lease_id).state, fx.scheduler.getLease(second.lease_id).reason],
    ['expired', 'node_contact_timeout']);
  fx.scheduler.touchNode(a);
  assert.equal(requestLease(fx.scheduler, { conversationKey: 'conv:p:9' }).lease.node_id, a,
    'a job the node never claimed excludes nothing');
});

test('the owner\'s own turn on their node goes ahead of an earlier turn from someone else', () => {
  const { scheduler, changes } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_owner' });
  const running = activeLease(scheduler, { conversationKey: 'conv:p:0', memberId: 'member_x' }).lease;
  const other = requestLease(scheduler, { conversationKey: 'conv:p:1', memberId: 'member_x' }).lease;
  const own = requestLease(scheduler, { conversationKey: 'conv:p:2', memberId: 'member_owner' }).lease;
  const queue = changes.filter((c) => c.type === 'queue').at(-1);
  assert.deepEqual(queue.positions.map((p) => [p.lease_id, p.position]), [[own.lease_id, 1], [other.lease_id, 2]],
    'positions are reported through onChange in the order they are served (slice 4d: the owner never served goes first)');
  scheduler.releaseLease(running.lease_id);
  assert.equal(scheduler.getLease(own.lease_id).state, 'active');
  assert.equal(scheduler.getLease(other.lease_id).state, 'queued');
  assert.equal(scheduler.getLease(other.lease_id).position, 1);
});

// E52 (owner, 2026-11-11; refines N8 and E7): a node's owner goes next on their own
// node, never twice in a row while someone else is waiting there.

// A queued lease for `memberId` on the model `modelId` (one node per model in these tests).
function waitFor52(scheduler, memberId, i, modelId = 'alpha') {
  return requestLease(scheduler, { conversationKey: `conv:p:${memberId}:${modelId}:${i}`, memberId, model: modelId }).lease;
}

// Releases the model's active lease; answers the member whose lease takes the slot, or null.
function handOut(scheduler, modelId = 'alpha') {
  const activeOn = () => scheduler.listLeases().find((lease) => lease.state === 'active' && lease.model === modelId);
  scheduler.releaseLease(activeOn().lease_id);
  return activeOn()?.member_id ?? null;
}

test('E52: with others waiting, the owner and the others take turns on the owner\'s node', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_owner' });
  activeLease(scheduler, { conversationKey: 'conv:p:filler', memberId: 'member_x' });
  waitFor52(scheduler, 'member_a', 1);
  waitFor52(scheduler, 'member_b', 1);
  for (let i = 1; i <= 3; i += 1) waitFor52(scheduler, 'member_owner', i);
  const order = [1, 2, 3, 4, 5].map(() => handOut(scheduler));
  assert.deepEqual(order, ['member_owner', 'member_a', 'member_owner', 'member_b', 'member_owner']);
});

test('E52: with nobody else waiting the owner goes twice in a row and is never held back', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_owner' });
  activeLease(scheduler, { conversationKey: 'conv:p:filler', memberId: 'member_x' });
  for (let i = 1; i <= 2; i += 1) waitFor52(scheduler, 'member_owner', i);
  assert.deepEqual([handOut(scheduler), handOut(scheduler)], ['member_owner', 'member_owner']);
  // The owner went ahead of a waiting member, who then gives up: the owner alone is not held back.
  const other = waitFor52(scheduler, 'member_a', 1);
  for (let i = 3; i <= 4; i += 1) waitFor52(scheduler, 'member_owner', i);
  assert.equal(handOut(scheduler), 'member_owner');
  scheduler.cancelLease(other.lease_id);
  assert.equal(handOut(scheduler), 'member_owner');
});

test('E52: the memory goes with the node: a node registered again lets its owner go first', () => {
  const { scheduler } = createScheduler();
  const nodeId = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_owner' });
  activeLease(scheduler, { conversationKey: 'conv:p:filler', memberId: 'member_x' });
  waitFor52(scheduler, 'member_a', 1);
  for (let i = 1; i <= 2; i += 1) waitFor52(scheduler, 'member_owner', i);
  assert.equal(handOut(scheduler), 'member_owner', 'the owner went ahead of member_a');
  assert.equal(scheduler.unregisterNode(nodeId).ok, true);
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_owner' });
  const active = scheduler.listLeases().filter((lease) => lease.state === 'active');
  assert.deepEqual(active.map((lease) => lease.member_id), ['member_owner'], 'a new node remembers nothing');
});

test('E52: one node\'s memory does not change the order on another node', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_owner', models: [model('alpha')] });
  registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_p', models: [model('beta')] });
  activeLease(scheduler, { conversationKey: 'conv:p:filler-a', memberId: 'member_x', model: 'alpha' });
  activeLease(scheduler, { conversationKey: 'conv:p:filler-b', memberId: 'member_x', model: 'beta' });
  waitFor52(scheduler, 'member_a', 1);
  for (let i = 1; i <= 2; i += 1) waitFor52(scheduler, 'member_owner', i);
  waitFor52(scheduler, 'member_a', 2, 'beta');
  waitFor52(scheduler, 'member_p', 1, 'beta');
  assert.equal(handOut(scheduler), 'member_owner', 'the first node\'s owner went ahead');
  assert.equal(handOut(scheduler, 'beta'), 'member_p', 'the second node\'s owner still goes first there');
  assert.equal(handOut(scheduler), 'member_a', 'the first node now serves the waiting member');
});

test('a continuation job is claimed before a newer first job on the same node', () => {
  const { scheduler } = createScheduler();
  const nodeId = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n', slots: 2 });
  const first = activeLease(scheduler, { conversationKey: 'conv:p:1' }).lease;
  const second = activeLease(scheduler, { conversationKey: 'conv:p:2' }).lease;
  const opening = scheduler.createJob(first.lease_id, { requestBytes: Buffer.from('{}') }).job;
  scheduler.claim(nodeId, 1);
  scheduler.acceptChunk(opening.job_id, nodeId, 0, Buffer.from('data: [DONE]\n\n'), true);
  const fresh = scheduler.createJob(second.lease_id, { requestBytes: Buffer.from('{}') }).job;
  const continuation = scheduler.createJob(first.lease_id, { requestBytes: Buffer.from('{}') }).job;
  assert.equal(scheduler.claim(nodeId, 2).job.job_id, continuation.job_id);
  assert.equal(scheduler.claim(nodeId, 3).job.job_id, fresh.job_id);
});

test('slot changes are reported through onChange for the lane limits', () => {
  const { scheduler, changes } = createScheduler();
  const a = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a', slots: 3 });
  registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_b', slots: 2 });
  assert.equal(changes.filter((c) => c.type === 'nodes').at(-1).online_slots, 5);
  scheduler.unregisterNode(a);
  assert.equal(changes.filter((c) => c.type === 'nodes').at(-1).online_slots, 2);
});

test('a throwing listener does not break the scheduler', () => {
  const clock = createClock();
  const fx = createScheduler({ clock });
  fx.scheduler.onChange(() => { throw new Error('listener'); });
  registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  assert.equal(requestLease(fx.scheduler).lease.state, 'active');
});

test('the pool summary: union of online models, smallest length per model, the largest across them', () => {
  const { scheduler } = createScheduler();
  assert.deepEqual(scheduler.poolSummary(), { models: [], largest_context_length: null, vision: false, thinking: false,
    online_slots: 0 });
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a',
    models: [model('alpha', { contextLength: 16384 }), model('seer', { contextLength: 65536, vision: true })] });
  registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_b', slots: 2,
    models: [model('alpha', { contextLength: 32768, thinking: true })] });
  const summary = scheduler.poolSummary();
  assert.deepEqual(summary.models.map((m) => m.id), ['alpha', 'seer']);
  assert.deepEqual(summary.models.map((m) => m.context_length), [16384, 65536], 'alpha: the smaller of its two nodes');
  assert.equal(summary.largest_context_length, 65536);
  assert.equal(summary.vision, true);
  assert.equal(summary.thinking, true);
  assert.equal(summary.online_slots, 3);
});

test('H13: a paused node takes no part in the pool summary: no model, no slots, no context length', () => {
  const { scheduler } = createScheduler();
  const small = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a',
    models: [model('alpha', { contextLength: 4096 }), model('only-paused', { contextLength: 4096 })] });
  registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_b', models: [model('alpha', { contextLength: 32768 })] });
  assert.equal(scheduler.poolSummary().models.find((m) => m.id === 'alpha').context_length, 4096);
  scheduler.setNodePaused(small, { on: true });
  const summary = scheduler.poolSummary();
  assert.deepEqual(summary.models.map((m) => m.id), ['alpha'], 'a model only a paused node has is not offered');
  assert.equal(summary.models[0].context_length, 32768, 'the paused node no longer lowers the minimum');
  assert.equal(summary.online_slots, 1);
  scheduler.setNodePaused(small, { on: false });
  assert.equal(scheduler.poolSummary().models.length, 2);
});

test('H13: a context length is held to 2,048 to 1,048,576: a larger one is clamped, a smaller one drops the model', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a', models: [
    model('huge', { contextLength: Number.MAX_SAFE_INTEGER }), model('tiny', { contextLength: 1 }),
    model('edge-low', { contextLength: 2048 }), model('edge-high', { contextLength: 1_048_576 }),
    model('unknown', { contextLength: null }), model('just-under', { contextLength: 2047 })] });
  const lengths = Object.fromEntries(scheduler.poolSummary().models.map((m) => [m.id, m.context_length]));
  assert.deepEqual(lengths, { huge: 1_048_576, 'edge-low': 2048, 'edge-high': 1_048_576, unknown: null });
  assert.equal(scheduler.poolSummary().largest_context_length, 1_048_576);
  assert.equal(scheduler.registerNode({ deviceId: 'device_2', memberId: 'member_b', slots: 1,
    models: [{ id: 'bad', context_length: 1.5, vision: false, thinking: false }] }).ok, false, 'not an integer is still refused');
});

test('the leased model capabilities come from the serving node\'s entry', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a',
    models: [model('alpha', { contextLength: 8192, thinking: true })] });
  const { lease } = activeLease(scheduler);
  assert.deepEqual(lease.model_info, { id: 'alpha', context_length: 8192, vision: false, thinking: true });
});

test('a job failed by a size bound frees its slot for the next waiting lease at once', () => {
  const fx = createScheduler({ limits: { maxLineBytes: 10 } });
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const { lease } = activeLease(fx.scheduler, { conversationKey: 'conv:p:1' });
  const waiting = requestLease(fx.scheduler, { conversationKey: 'conv:p:2' }).lease;
  const job = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
  fx.scheduler.claim(nodeId, 1);
  assert.equal(fx.scheduler.acceptChunk(job.job_id, nodeId, 0, Buffer.alloc(11, 0x61), false).cancel, true);
  assert.equal(fx.scheduler.getLease(lease.lease_id).reason, 'frame_too_large');
  assert.equal(fx.scheduler.getLease(waiting.lease_id).state, 'active');
});

test('limits may only be lowered; an unknown limit or a raise is refused at construction', () => {
  const { createPoolScheduler } = require('../../server/team/scheduler');
  const base = { clock: () => 0, randomBytes: (n) => Buffer.alloc(n, 1) };
  assert.throws(() => createPoolScheduler({ ...base, limits: { maxQueued: 33 } }), /limit/u);
  assert.throws(() => createPoolScheduler({ ...base, limits: { bogus: 1 } }), /limit/u);
  assert.throws(() => createPoolScheduler({ ...base, limits: { maxQueued: 0 } }), /limit/u);
  assert.throws(() => createPoolScheduler({ randomBytes: base.randomBytes }), /clock/u);
  const lowered = createPoolScheduler({ ...base, limits: { maxQueued: 2 } });
  assert.equal(typeof lowered.sweep, 'function');
});

// ---------------------------------------------------------------------------
// Review round: faults A1 to A7.

test('A1: a non-stream job ends done on its final chunk with no [DONE] and no line bound', () => {
  const fx = createScheduler({ limits: { maxLineBytes: 16 } });
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const { lease } = activeLease(fx.scheduler);
  const job = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{"stream":false}'), stream: false }).job;
  fx.scheduler.claim(nodeId, 1);
  const body = Buffer.from(`{"choices":[{"message":{"content":"${'x'.repeat(40)}"}}]}`);
  assert.deepEqual(fx.scheduler.acceptChunk(job.job_id, nodeId, 0, body, false), { ok: true, next_seq: 1, cancel: false });
  assert.equal(fx.scheduler.acceptChunk(job.job_id, nodeId, 1, Buffer.alloc(0), true).ok, true);
  assert.equal(fx.scheduler.getJob(job.job_id).state, 'done');
  assert.equal(fx.scheduler.getLease(lease.lease_id).state, 'active');
  const streamJob = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}'), stream: true }).job;
  fx.scheduler.claim(nodeId, 2);
  fx.scheduler.acceptChunk(streamJob.job_id, nodeId, 0, Buffer.from('data: 1\n\n'), true);
  assert.equal(fx.scheduler.getJob(streamJob.job_id).reason, 'stream_incomplete', 'a stream job still needs [DONE]');
});

test('A2: a client closing after [DONE] ends the job done and keeps the lease', () => {
  const fx = createScheduler();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const { lease } = activeLease(fx.scheduler);
  const job = fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).job;
  fx.scheduler.claim(nodeId, 1);
  fx.scheduler.acceptChunk(job.job_id, nodeId, 0, Buffer.from('data: {"a":1}\n\ndata: [DONE]\n\n'), false);
  assert.equal(fx.scheduler.cancelJob(job.job_id).ok, true);
  assert.equal(fx.scheduler.getJob(job.job_id).state, 'done');
  assert.equal(fx.scheduler.getLease(lease.lease_id).state, 'active');
  // H14: the node's own final chunk is acknowledged (it is not a lost job); more output is told to stop.
  assert.deepEqual(fx.scheduler.acceptChunk(job.job_id, nodeId, 1, Buffer.alloc(0), true), { ok: true, next_seq: 1, cancel: false });
  assert.deepEqual(fx.scheduler.acceptChunk(job.job_id, nodeId, 1, Buffer.from('late'), false), { ok: true, next_seq: 1, cancel: true });
  assert.deepEqual(fx.scheduler.acceptChunk(job.job_id, 'node_other', 1, Buffer.alloc(0), true), { ok: false }, 'another node is refused');
  assert.equal(fx.scheduler.createJob(lease.lease_id, { requestBytes: Buffer.from('{}') }).ok, true);
});

test('A3: an idle lease expiry does not exclude the node', () => {
  const fx = createScheduler();
  const start = fx.clock();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  activeLease(fx.scheduler);
  for (let t = 20 * SECOND; t <= 30 * MINUTE; t += 20 * SECOND) { fx.clock.set(start + t); fx.scheduler.touchNode(nodeId); }
  assert.deepEqual(fx.scheduler.sweep(start + 30 * MINUTE).map((t) => t.trigger), ['idle_timeout']);
  assert.equal(requestLease(fx.scheduler).lease.node_id, nodeId);
});

test('A4: a member registers at most two nodes', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_n' });
  const third = scheduler.registerNode({ deviceId: 'device_3', memberId: 'member_n', slots: 1, models: [model('a')] });
  assert.equal(third.error.reason, 'node_limit_reached');
  assert.equal(scheduler.registerNode({ deviceId: 'device_1', memberId: 'member_n', slots: 2, models: [model('a')] }).ok,
    true, 'a known device may re-register');
});

test('A4: an offline node with no active lease is removed after 10 minutes and registers again as the same node', () => {
  const fx = createScheduler();
  const start = fx.clock();
  const first = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  fx.scheduler.sweep(start + 30 * SECOND);
  assert.equal(fx.scheduler.listNodes()[0].online, false);
  fx.scheduler.sweep(start + 30 * SECOND + 10 * MINUTE - 1);
  assert.equal(fx.scheduler.listNodes().length, 1);
  fx.scheduler.sweep(start + 30 * SECOND + 10 * MINUTE);
  assert.equal(fx.scheduler.listNodes().length, 0);
  fx.clock.set(start + 30 * SECOND + 10 * MINUTE);
  const again = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  assert.equal(again, first, 'the node id is a fixed function of the device');
  assert.equal(fx.scheduler.listNodes().length, 1);
});

test('A5: a listener that calls back into the scheduler sees events in causal order', () => {
  const { scheduler } = createScheduler();
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  const a = activeLease(scheduler, { conversationKey: 'conv:p:a' }).lease;
  const b = requestLease(scheduler, { conversationKey: 'conv:p:b' }).lease;
  const c = requestLease(scheduler, { conversationKey: 'conv:p:c' }).lease;
  const names = { [a.lease_id]: 'a', [b.lease_id]: 'b', [c.lease_id]: 'c' };
  const seen = [];
  scheduler.onChange((event) => {
    if (event.type === 'lease') seen.push(`${names[event.lease_id]}:${event.to}`);
    if (event.type === 'queue') seen.push(`queue:${event.positions.map((p) => names[p.lease_id]).join('')}`);
    if (event.type === 'lease' && event.lease_id === b.lease_id && event.to === 'active') scheduler.releaseLease(b.lease_id);
  });
  scheduler.releaseLease(a.lease_id);
  assert.deepEqual(seen, ['a:released', 'b:active', 'queue:c', 'b:released', 'c:active', 'queue:']);
  assert.equal(scheduler.getLease(c.lease_id).state, 'active');
});

test('A7: a token mint that throws leaves the queued lease untouched', () => {
  const { createPoolScheduler } = require('../../server/team/scheduler');
  const { createRandomBytes } = require('./helpers/team-pool-fixture');
  const bytes = createRandomBytes();
  let failMint = false;
  const scheduler = createPoolScheduler({ clock: createClock(), randomBytes: (n) => {
    if (failMint && n === 32) throw new Error('entropy');
    return bytes(n);
  } });
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_n' });
  failMint = true;
  assert.throws(() => requestLease(scheduler), /entropy/u);
  const [lease] = scheduler.listLeases();
  assert.deepEqual([lease.state, lease.node_id, lease.model_info], ['queued', null, null]);
});
