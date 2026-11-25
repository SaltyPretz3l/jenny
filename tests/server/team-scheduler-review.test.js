'use strict';

// new-test-file: team-scheduler-states.test.js sits at its 600-line ceiling; these are the adversarial-review
// fixes to the pool scheduler (C6, H13, and the dispatch loop guard), through the facade.

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRandomBytes, createClock, createScheduler, model, registerNode, requestLease } = require('./helpers/team-pool-fixture');

const SECOND = 1000;

const reason = (result) => result.error?.reason;
const nodeOf = (scheduler, nodeId) => scheduler.listNodes().find((node) => node.node_id === nodeId);

// ---------------------------------------------------------------------------
// C6: a registration is a fresh start for the pause flags.

test('C6: registering a node again clears paused and owner_busy', () => {
  const { scheduler } = createScheduler();
  const nodeId = registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  assert.equal(scheduler.setNodePaused(nodeId, { on: true, ownerBusy: true }).ok, true);
  assert.deepEqual([nodeOf(scheduler, nodeId).paused, nodeOf(scheduler, nodeId).owner_busy], [true, true]);
  assert.equal(reason(requestLease(scheduler)), 'no_eligible_node');
  assert.equal(registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a' }), nodeId, 'the same device, the same node');
  assert.deepEqual([nodeOf(scheduler, nodeId).paused, nodeOf(scheduler, nodeId).owner_busy], [false, false]);
  assert.equal(requestLease(scheduler).lease.state, 'active', 'the node takes work again');
});

test('C6: a node that quit while paused and registers within the keep window is not still paused', () => {
  const fx = createScheduler();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  fx.scheduler.setNodePaused(nodeId, { on: true });
  fx.clock.advance(31 * SECOND);
  fx.scheduler.sweep(fx.clock());
  assert.equal(nodeOf(fx.scheduler, nodeId).online, false);
  registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  assert.deepEqual([nodeOf(fx.scheduler, nodeId).online, nodeOf(fx.scheduler, nodeId).paused], [true, false]);
});

// ---------------------------------------------------------------------------
// H13.

test('H13: a full queue does not refuse a request an idle node can serve at once', () => {
  const { scheduler } = createScheduler({ limits: { maxQueued: 1 } });
  registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a', models: [model('alpha')] });
  registerNode(scheduler, { deviceId: 'device_2', memberId: 'member_b', models: [model('beta')] });
  assert.equal(requestLease(scheduler, { conversationKey: 'conv:p:1' }).lease.state, 'active', 'alpha is busy now');
  assert.equal(requestLease(scheduler, { conversationKey: 'conv:p:2', memberId: 'member_b' }).lease.state, 'queued');
  assert.equal(reason(requestLease(scheduler, { conversationKey: 'conv:p:3', memberId: 'member_c' })), 'pool_queue_full',
    'a request nothing can serve now still meets the cap');
  const beta = requestLease(scheduler, { conversationKey: 'conv:p:4', memberId: 'member_c', model: 'beta' });
  assert.equal(beta.ok, true, JSON.stringify(beta));
  assert.equal(beta.lease.state, 'active', 'the idle beta node takes it');
});

test('H13: a queued lease whose last node for the model leaves fails at once, not at its queue timeout', () => {
  const fx = createScheduler();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  const keep = registerNode(fx.scheduler, { deviceId: 'device_2', memberId: 'member_b', models: [model('beta')] });
  assert.equal(requestLease(fx.scheduler, { conversationKey: 'conv:p:1' }).lease.state, 'active');
  const waiting = requestLease(fx.scheduler, { conversationKey: 'conv:p:2', memberId: 'member_c' }).lease;
  const beta = requestLease(fx.scheduler, { conversationKey: 'conv:p:3', memberId: 'member_c', model: 'beta' }).lease;
  assert.equal(waiting.state, 'queued');
  assert.equal(fx.scheduler.unregisterNode(nodeId).ok, true);
  fx.clock.advance(29 * SECOND);
  fx.scheduler.sweep(fx.clock());
  assert.equal(fx.scheduler.getLease(waiting.lease_id).state, 'queued', 'a node that restarts within its contact window keeps the queue');
  fx.clock.advance(1 * SECOND);
  fx.scheduler.sweep(fx.clock());
  const ended = fx.scheduler.getLease(waiting.lease_id);
  assert.deepEqual([ended.state, ended.reason], ['failed', 'no_eligible_node'], 'then it fails, long before its 10 minutes');
  assert.equal(fx.scheduler.getLease(beta.lease_id).node_id, keep, 'a lease another node can serve is untouched');
});

test('H13: a node that registers again inside the window serves the queued lease', () => {
  const fx = createScheduler();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  requestLease(fx.scheduler, { conversationKey: 'conv:p:1' });
  const waiting = requestLease(fx.scheduler, { conversationKey: 'conv:p:2', memberId: 'member_c' }).lease;
  fx.scheduler.unregisterNode(nodeId);
  fx.clock.advance(20 * SECOND);
  fx.scheduler.sweep(fx.clock());
  registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  fx.clock.advance(20 * SECOND);
  fx.scheduler.sweep(fx.clock());
  assert.deepEqual([fx.scheduler.getLease(waiting.lease_id).state, fx.scheduler.getLease(waiting.lease_id).node_id], ['active', nodeId]);
});

test('H13: a lease on a node that went silent expires in the sweep that finds the node offline', () => {
  const fx = createScheduler();
  const nodeId = registerNode(fx.scheduler, { deviceId: 'device_1', memberId: 'member_a' });
  fx.clock.advance(29 * SECOND);
  const lease = requestLease(fx.scheduler).lease; // the node's last contact was 29 s ago
  assert.equal(lease.state, 'active');
  fx.clock.advance(1 * SECOND);
  fx.scheduler.sweep(fx.clock());
  assert.equal(nodeOf(fx.scheduler, nodeId).online, false);
  const after = fx.scheduler.getLease(lease.lease_id);
  assert.deepEqual([after.state, after.reason], ['expired', 'node_contact_timeout'], 'no 30 more seconds on a dead node');
});

// ---------------------------------------------------------------------------
// The dispatch loop cannot spin.

test('dispatch gives up on a lease whose activation is refused instead of looping', () => {
  const statePath = require.resolve('../../server/team/scheduler/state');
  const indexPath = require.resolve('../../server/team/scheduler');
  const state = require(statePath);
  const original = state.createLeaseTable;
  let refusals = 0;
  state.createLeaseTable = (options) => {
    const table = original(options);
    const transition = table.transition;
    return { ...table, transition(record, from, to, ...rest) {
      if (from === 'queued' && to === 'active') {
        refusals += 1;
        if (refusals > 50) throw new Error('dispatch spun on a refused activation');
        return { ok: false, reason: 'lease_transition_refused' };
      }
      return transition(record, from, to, ...rest);
    } };
  };
  delete require.cache[indexPath];
  try {
    const { createPoolScheduler } = require(indexPath);
    const scheduler = createPoolScheduler({ clock: createClock(), randomBytes: createRandomBytes() });
    registerNode(scheduler, { deviceId: 'device_1', memberId: 'member_a' });
    const result = requestLease(scheduler);
    assert.equal(result.ok, true);
    assert.equal(result.lease.state, 'queued', 'the refused lease stays queued');
    assert.ok(refusals <= 3, `one refusal per dispatch pass, saw ${refusals}`);
  } finally {
    state.createLeaseTable = original;
    delete require.cache[indexPath];
  }
});

// ---------------------------------------------------------------------------
// The lease request shape (lease-request.js, split out of the facade).

test('readLeaseRequest normalizes a request and refuses a malformed one', () => {
  const { readLeaseRequest } = require('../../server/team/scheduler/lease-request');
  const { DEFAULT_LIMITS } = require('../../server/team/scheduler/limits');
  const good = { conversationKey: 'conv:p:1', memberId: 'member_a', model: 'alpha', wantsVision: false };
  assert.deepEqual(readLeaseRequest(good, DEFAULT_LIMITS), { ...good, retryAnyway: false, allowedNodes: null });
  for (const bad of [null, 'x', { ...good, memberId: 'a' }, { ...good, wantsVision: 'no' }, { ...good, model: '' },
    { ...good, retryAnyway: 1 }, { ...good, allowedNodes: [] }, { ...good, conversationKey: 'x'.repeat(257) }]) {
    assert.equal(readLeaseRequest(bad, DEFAULT_LIMITS), null, JSON.stringify(bad));
  }
});
