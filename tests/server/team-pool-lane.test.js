'use strict';

// Slice 4a-4, spec test 4a-T5: the pool composition feeds the runtime's `local`
// lane from the scheduler's online slots, so the lane's own admission carries the
// turn queue. Real scheduler, real RuntimeLaneAdmission, no sidecar.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { createPoolComposition } = require('../../server/team/pool-composition');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { createClock, createLoggerSpy, model } = require('./helpers/team-pool-fixture');

const LOCAL_ROUTE = captureRuntimeRoute({ engine_type: 'openai-compatible', provider_id: 'openai-compatible',
  configuration_revision: 'config_1', resource_class: 'local', requires_gpu: true });

async function setup(t, { limits } = {}) {
  const pool = createPoolComposition({ contextLength: 32768, clock: createClock(), logger: createLoggerSpy(),
    randomBytes: crypto.randomBytes, mayUsePool: () => true });
  t.after(() => pool.stop());
  await pool.start();
  const lanes = new RuntimeLaneAdmission({ limits });
  const calls = [];
  const setLimits = lanes.setLimits.bind(lanes);
  lanes.setLimits = (value) => { calls.push(JSON.parse(JSON.stringify(value))); return setLimits(value); };
  return { pool, lanes, calls, scheduler: pool.scheduler };
}

function addNode(scheduler, deviceId, slots, memberId = 'member_node') {
  const result = scheduler.registerNode({ deviceId, memberId, slots, models: [model('alpha')] });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.node_id;
}

const local = (lanes) => lanes.snapshot().configured.local;

function admitTurns(lanes, count) {
  return Array.from({ length: count }, (_, index) => lanes.tryAcquireTurn({ sessionId: `session_${index}`, route: LOCAL_ROUTE }));
}

test('with N online slots the lane admits N turns and holds turn N+1', async (t) => {
  const { pool, lanes, scheduler } = await setup(t);
  addNode(scheduler, 'device_a', 2);
  addNode(scheduler, 'device_b', 1, 'member_other');
  pool.bindRuntime({ lanes });
  assert.equal(local(lanes).runnable_turns, 3);
  assert.equal(local(lanes).inference_requests, 3);
  const results = admitTurns(lanes, 4);
  assert.deepEqual(results.map((result) => result.status), ['granted', 'granted', 'granted', 'waiting']);
  assert.equal(results[3].reason, 'lane_capacity');
});

test('registering and unregistering a node moves both limits; zero slots gives 1', async (t) => {
  const { pool, lanes, scheduler } = await setup(t);
  pool.bindRuntime({ lanes });
  assert.deepEqual([local(lanes).runnable_turns, local(lanes).inference_requests], [1, 1]);
  const nodeA = addNode(scheduler, 'device_a', 4);
  assert.deepEqual([local(lanes).runnable_turns, local(lanes).inference_requests], [4, 4]);
  const nodeB = addNode(scheduler, 'device_b', 2);
  assert.deepEqual([local(lanes).runnable_turns, local(lanes).inference_requests], [6, 6]);
  scheduler.setNodePaused(nodeB, { on: true });
  assert.equal(local(lanes).runnable_turns, 4, 'a paused node offers no slots');
  scheduler.unregisterNode(nodeA);
  scheduler.unregisterNode(nodeB);
  assert.deepEqual([local(lanes).runnable_turns, local(lanes).inference_requests], [1, 1]);
});

test('more than 16 online slots gives 16', async (t) => {
  const { pool, lanes, scheduler } = await setup(t);
  pool.bindRuntime({ lanes });
  for (let index = 0; index < 5; index += 1) addNode(scheduler, `device_${index}`, 4, `member_${index}`);
  assert.equal(scheduler.poolSummary().online_slots, 20);
  assert.deepEqual([local(lanes).runnable_turns, local(lanes).inference_requests], [16, 16]);
});

test('the other limit keys are untouched', async (t) => {
  const limits = { local: { runnable_turns: 1, inference_requests: 1, descendants: 3, descendant_depth: 1 },
    cloud: { runnable_turns: 5, inference_requests: 7, descendants: 9, descendant_depth: 2 },
    resources: { tool_operations: 3, native_processes: 4, tests: 2 } };
  const { pool, lanes, scheduler } = await setup(t, { limits });
  pool.bindRuntime({ lanes });
  addNode(scheduler, 'device_a', 3);
  const configured = lanes.snapshot().configured;
  assert.deepEqual(configured, { ...limits, local: { ...limits.local, runnable_turns: 3, inference_requests: 3 } });
});

test('no setLimits call when nothing changed', async (t) => {
  const { pool, lanes, calls, scheduler } = await setup(t);
  pool.bindRuntime({ lanes });
  assert.equal(calls.length, 0, 'the default local lane already admits one');
  const node = addNode(scheduler, 'device_a', 2);
  assert.equal(calls.length, 1);
  scheduler.touchNode(node);
  addNode(scheduler, 'device_a', 2); // the same inventory again
  assert.equal(calls.length, 1);
});

test('a missing, partial or malformed lane object refuses the pool', async (t) => {
  const { pool } = await setup(t);
  for (const lanes of [undefined, null, {}, { setLimits() {} }, { snapshot() { return {}; } }, { setLimits() {}, snapshot() { return {}; } }]) {
    assert.throws(() => pool.bindRuntime({ lanes }), (error) => error.reason === 'team_pool_unavailable');
  }
  assert.throws(() => pool.bindRuntime(), (error) => error.reason === 'team_pool_unavailable');
});
