'use strict';

// Slice 4a-4: the pool composition (T2) and its turn route's acquire (T3), on the
// real scheduler and the real loopback gateway with an injected clock. No sidecar,
// no model, no window.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');

const { createPoolComposition } = require('../../server/team/pool-composition');
const { createPoolGateway } = require('../../server/team/pool-gateway');
const { createPoolScheduler } = require('../../server/team/scheduler');
const { composePool: compose, createClock, createLoggerSpy, model, poolTurn } = require('./helpers/team-pool-fixture');

const MEMBER = 'member_alice';
const OTHER = 'member_bob';

const allow = () => true;

function addNode(scheduler, { deviceId = 'device_one', memberId = OTHER, slots = 1, models = [model('alpha')] } = {}) {
  const result = scheduler.registerNode({ deviceId, memberId, slots, models });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.node_id;
}

function request(port, { path = '/v1/models', method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

const portOf = (endpoint) => Number(new URL(endpoint.apiUrl).port);
const turn = poolTurn;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// ---------------------------------------------------------------------------
// T2: the composition.

test('the boot key is 43 base64url characters and differs between two compositions', async (t) => {
  const a = compose(t).pool;
  const b = compose(t).pool;
  assert.match(a.modelCredential(), /^[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(a.modelCredential(), b.modelCredential());
});

test('start answers an IP-literal endpoint under /v1 and the gateway needs the key', async (t) => {
  const { pool } = compose(t);
  const { modelEndpoint } = await pool.start();
  assert.equal(modelEndpoint.engine, 'openai-compatible');
  assert.equal(modelEndpoint.model, 'team-pool');
  assert.match(modelEndpoint.apiUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
  const port = portOf(modelEndpoint);
  const ok = await request(port, { headers: { authorization: `Bearer ${pool.modelCredential()}` } });
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).data[0].id, 'team-pool');
  assert.equal((await request(port)).status, 401);
  assert.equal((await request(port, { headers: { authorization: 'Bearer wrong-key-wrong-key-wrong-key-wrong' } })).status, 401);
});

test('the sweep runs on its own: a queued lease times out by the injected clock', async (t) => {
  const { pool, clock, scheduler } = compose(t, { limits: { sweepIntervalMs: 20 } });
  await pool.start();
  addNode(scheduler);
  const first = scheduler.requestLease({ conversationKey: 'conv:-:s1', memberId: MEMBER, model: 'alpha', wantsVision: false });
  const second = scheduler.requestLease({ conversationKey: 'conv:-:s2', memberId: MEMBER, model: 'alpha', wantsVision: false });
  assert.equal(first.lease.state, 'active');
  assert.equal(second.lease.state, 'queued');
  clock.advance(10 * 60_000);
  await sleep(120);
  const lease = scheduler.getLease(second.lease.lease_id);
  assert.equal(lease.state, 'failed');
  assert.equal(lease.reason, 'queue_timeout');
});

test('a sweep that throws is logged by name and the timer keeps running', async (t) => {
  let sweeps = 0;
  const createScheduler = (input) => {
    const real = createPoolScheduler(input);
    return Object.freeze({ ...real, sweep: () => { sweeps += 1; throw new Error('secret detail'); } });
  };
  const { pool, logger } = compose(t, { createScheduler, limits: { sweepIntervalMs: 20 } });
  await pool.start();
  await sleep(150);
  assert.ok(sweeps >= 2, `sweeps ${sweeps}`);
  assert.ok(logger.calls.some(([, event]) => event === 'team.pool.sweep_failed'));
  assert.equal(logger.text().includes('secret detail'), false);
});

test('a sweep interval may be lowered, never raised or malformed', () => {
  for (const sweepIntervalMs of [0, 1_001, 1.5, '20', null]) {
    assert.throws(() => createPoolComposition({ contextLength: 32768, mayUsePool: allow, limits: { sweepIntervalMs } }),
      RangeError,
      String(sweepIntervalMs));
  }
});

test('stop leaves nothing, forgets the key and is safe to call twice', async (t) => {
  const { pool, scheduler } = compose(t);
  const { modelEndpoint } = await pool.start();
  addNode(scheduler);
  const active = await pool.turnRoute.acquire(turn());
  const queued = pool.turnRoute.acquire(turn({ sessionId: 'session_2' }));
  await sleep(10);
  assert.equal(pool.resources().waiters, 1);
  await pool.stop();
  await assert.rejects(queued, (error) => error.reason === 'cancelled');
  assert.deepEqual(pool.resources(), { listening: false, sockets: 0, timers: 0, waiters: 0, leases: 0 });
  assert.equal(pool.modelCredential(), null);
  assert.equal(scheduler.listLeases().every((lease) => lease.state !== 'queued' && lease.state !== 'active'), true);
  active.release({ ok: true });
  await pool.stop();
  assert.deepEqual(pool.resources(), { listening: false, sockets: 0, timers: 0, waiters: 0, leases: 0 });
  await assert.rejects(request(portOf(modelEndpoint)), (error) => error.code === 'ECONNREFUSED');
});

test('a gateway that cannot start leaves nothing listening and no timer', async (t) => {
  const createGateway = (input) => {
    const real = createPoolGateway(input);
    return Object.freeze({ ...real, start: async () => { await real.start(); await real.stop(); throw new Error('listen failed'); } });
  };
  const { pool } = compose(t, { createGateway });
  await assert.rejects(pool.start(), (error) => error.reason === 'team_pool_unavailable');
  assert.deepEqual(pool.resources(), { listening: false, sockets: 0, timers: 0, waiters: 0, leases: 0 });
  assert.equal(pool.modelCredential(), null);
  await assert.rejects(pool.turnRoute.acquire(turn()), (error) => error.reason === 'team_pool_unavailable');
});

test('the key, a token and the port never reach a log record', async (t) => {
  const { pool, logger, scheduler } = compose(t);
  const { modelEndpoint } = await pool.start();
  addNode(scheduler);
  const handle = await pool.turnRoute.acquire(turn());
  await request(portOf(modelEndpoint), { headers: { authorization: `Bearer ${pool.modelCredential()}` } });
  handle.release({ ok: true });
  const key = pool.modelCredential();
  await pool.stop();
  const text = logger.text();
  for (const secret of [key, handle.token, String(portOf(modelEndpoint))]) assert.equal(text.includes(secret), false);
});

// ---------------------------------------------------------------------------
// T3: acquire.

test('every refusal of acquire carries its reason and none takes a lease', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  // Row 172: a conversation's own model that no online PC offers is refused with its own reason before the scheduler.
  await assert.rejects(pool.turnRoute.acquire(turn()), (error) => error.reason === 'conversation_model_offline');
  await assert.rejects(pool.turnRoute.acquire(turn({ model: '' })), (error) => error.reason === 'model_not_in_pool');
  const nodeA = addNode(scheduler, { deviceId: 'device_a', models: [model('alpha')] });
  await assert.rejects(pool.turnRoute.acquire(turn({ model: 'beta' })), (error) => error.reason === 'conversation_model_offline'
    && error.code === 'CMP-HOST-0007' && error.kind === 'limit');
  await assert.rejects(pool.turnRoute.acquire(turn({ wantsVision: true })), (error) => error.reason === 'model_lacks_vision');
  scheduler.setNodePaused(nodeA, { on: true });
  await assert.rejects(pool.turnRoute.acquire(turn()), (error) => error.reason === 'no_eligible_node');
  scheduler.setNodePaused(nodeA, { on: false });
  scheduler.setNodePaused(addNode(scheduler, { deviceId: 'device_b', models: [model('beta')] }), { on: true });
  scheduler.setNodePaused(nodeA, { on: true });
  await assert.rejects(pool.turnRoute.acquire(turn({ model: 'team-pool' })), (error) => error.reason === 'model_not_in_pool',
    'two models online, all paused (Automatic answers none) and no model named');
  assert.equal(scheduler.listLeases().length, 0);
});

test('a missing, empty, malformed or owner-looking but absent member id is refused and takes no lease', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  addNode(scheduler);
  for (const memberId of [undefined, null, '', 'owner', 'member_', 'member bob', 'device_alice', 42, { id: MEMBER }]) {
    await assert.rejects(pool.turnRoute.acquire(turn({ memberId })), (error) => error.reason === 'member_author_required',
      String(memberId));
  }
  const { memberId: _dropped, ...noMember } = turn();
  await assert.rejects(pool.turnRoute.acquire(noMember), (error) => error.reason === 'member_author_required');
  assert.equal(scheduler.listLeases().length, 0);
});

test('a lease that is active at once resolves with a 43-character token; the alias takes the only model', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  addNode(scheduler, { slots: 2 });
  const named = await pool.turnRoute.acquire(turn());
  const aliased = await pool.turnRoute.acquire(turn({ sessionId: 'session_2', model: 'team-pool' }));
  for (const handle of [named, aliased]) assert.match(handle.token, /^[A-Za-z0-9_-]{43}$/u);
  const leases = scheduler.listLeases();
  assert.deepEqual(leases.map((lease) => lease.model), ['alpha', 'alpha']);
  assert.deepEqual(leases.map((lease) => lease.conversation_key), ['conv:project_a:session_1', 'conv:project_a:session_2']);
});

test('a queued lease becomes active when a slot frees', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  addNode(scheduler);
  const first = await pool.turnRoute.acquire(turn());
  const second = pool.turnRoute.acquire(turn({ sessionId: 'session_2', projectId: null }));
  await sleep(10);
  assert.equal(scheduler.listLeases()[1].state, 'queued');
  assert.equal(scheduler.listLeases()[1].conversation_key, 'conv:-:session_2');
  first.release({ ok: true });
  const handle = await second;
  assert.match(handle.token, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(scheduler.listLeases()[1].state, 'active');
  assert.equal(pool.resources().waiters, 0);
});

test('an abort while queued cancels the lease and rejects', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  addNode(scheduler);
  await pool.turnRoute.acquire(turn());
  const controller = new AbortController();
  const waiting = pool.turnRoute.acquire(turn({ sessionId: 'session_2', signal: controller.signal }));
  await sleep(10);
  controller.abort();
  await assert.rejects(waiting, (error) => error.reason === 'cancelled');
  const lease = scheduler.listLeases()[1];
  assert.equal(lease.state, 'failed');
  assert.equal(lease.reason, 'cancelled');
  assert.equal(pool.resources().waiters, 0);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(pool.turnRoute.acquire(turn({ sessionId: 'session_3', signal: aborted.signal })),
    (error) => error.reason === 'cancelled');
  assert.equal(scheduler.listLeases().length, 2, 'an already aborted signal takes no lease');
});

test('the wait limit cancels the lease and rejects with queue_timeout; a limit above 120 s is refused', async (t) => {
  assert.throws(() => createPoolComposition({ contextLength: 32768, mayUsePool: allow, limits: { queueWaitMs: 120_001 } }),
    RangeError);
  const { pool, scheduler } = compose(t, { limits: { queueWaitMs: 50 } });
  await pool.start();
  addNode(scheduler);
  await pool.turnRoute.acquire(turn());
  await assert.rejects(pool.turnRoute.acquire(turn({ sessionId: 'session_2' })), (error) => error.reason === 'queue_timeout');
  const lease = scheduler.listLeases()[1];
  assert.equal(lease.state, 'failed');
  assert.equal(lease.reason, 'cancelled');
  assert.equal(pool.resources().waiters, 0);
});

test('a lease that fails while queued rejects with its recorded reason', async (t) => {
  const { pool, scheduler, clock } = compose(t);
  await pool.start();
  addNode(scheduler);
  await pool.turnRoute.acquire(turn());
  const waiting = pool.turnRoute.acquire(turn({ sessionId: 'session_2' }));
  await sleep(10);
  clock.advance(10 * 60_000);
  scheduler.sweep(clock());
  await assert.rejects(waiting, (error) => error.reason === 'queue_timeout');
  assert.equal(pool.resources().waiters, 0);
});

test('release runs once: ok true releases, ok false cancels, a second call and an expired lease are left alone', async (t) => {
  const { pool, scheduler, clock } = compose(t);
  await pool.start();
  addNode(scheduler, { slots: 3 });
  const good = await pool.turnRoute.acquire(turn());
  const bad = await pool.turnRoute.acquire(turn({ sessionId: 'session_2' }));
  const late = await pool.turnRoute.acquire(turn({ sessionId: 'session_3' }));
  good.release({ ok: true });
  good.release({ ok: false });
  bad.release({ ok: false });
  bad.release({ ok: true });
  const [a, b] = scheduler.listLeases();
  assert.deepEqual([a.state, a.reason], ['released', 'settled']);
  assert.deepEqual([b.state, b.reason], ['failed', 'cancelled']);
  clock.advance(31_000);
  scheduler.sweep(clock());
  assert.equal(scheduler.listLeases()[2].state, 'expired');
  assert.doesNotThrow(() => late.release({ ok: true }));
  assert.equal(scheduler.listLeases()[2].state, 'expired');
  assert.doesNotThrow(() => late.release());
});

test('release with ok true on a busy lease cancels it', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  const nodeId = addNode(scheduler);
  const handle = await pool.turnRoute.acquire(turn());
  const leaseId = scheduler.listLeases()[0].lease_id;
  const created = scheduler.createJob(leaseId, { requestBytes: Buffer.from('{}') });
  assert.equal(created.ok, true);
  assert.equal(scheduler.claim(nodeId, 1).ok, true);
  handle.release({ ok: true });
  const lease = scheduler.getLease(leaseId);
  assert.deepEqual([lease.state, lease.reason], ['failed', 'cancelled']);
});

test('a route token the scheduler refuses cancels the lease and rejects with its reason', async (t) => {
  let refusals = 0;
  const createScheduler = (input) => {
    const real = createPoolScheduler(input);
    return Object.freeze({ ...real, takeRouteToken: (leaseId) => {
      if (refusals > 0) return real.takeRouteToken(leaseId);
      refusals += 1;
      return { ok: false, error: { code: 'CMP-HOST-0004', reason: 'route_token_taken', retryable: false } };
    } });
  };
  const { pool, scheduler } = compose(t, { createScheduler });
  await pool.start();
  addNode(scheduler);
  await assert.rejects(pool.turnRoute.acquire(turn()), (error) => error.reason === 'route_token_taken');
  const [lease] = scheduler.listLeases();
  assert.deepEqual([lease.state, lease.reason], ['failed', 'cancelled']);
  const handle = await pool.turnRoute.acquire(turn({ sessionId: 'session_2' }));
  assert.match(handle.token, /^[A-Za-z0-9_-]{43}$/u, 'the cancelled lease freed the only slot');
});

test('twenty concurrent acquires use one scheduler listener', async (t) => {
  let listeners = 0;
  const createScheduler = (input) => {
    const real = createPoolScheduler(input);
    return Object.freeze({ ...real, onChange: (fn) => { listeners += 1; return real.onChange(fn); } });
  };
  const { pool, scheduler } = compose(t, { createScheduler });
  await pool.start();
  addNode(scheduler);
  const pending = Array.from({ length: 20 }, (_, index) => pool.turnRoute.acquire(turn({ sessionId: `session_${index}` })));
  await sleep(10);
  assert.equal(pool.resources().waiters, 19);
  for (const promise of pending) (await promise).release({ ok: true });
  assert.equal(listeners, 1);
  assert.equal(scheduler.listLeases().filter((lease) => lease.state === 'released').length, 20);
});

// ---------------------------------------------------------------------------
// Slice 4b: the engine route's acquire (a lease with no conversation).

const ENGINE_KEY = 'A'.repeat(43);
const engine = (overrides = {}) => ({ memberId: MEMBER, engineKey: ENGINE_KEY, model: 'alpha', wantsVision: false,
  ...overrides });
const bucketOf = (key) => (crypto.createHash('sha256').update(key, 'utf8').digest()[0] % 16).toString(16);

test('engine acquire keys the lease by member and engine key, or "-" without one, and returns the lease', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  const nodeId = addNode(scheduler, { slots: 2 });
  const keyed = await pool.engineRoute.acquire(engine());
  const bare = await pool.engineRoute.acquire(engine({ engineKey: undefined, model: 'team-pool' }));
  assert.deepEqual(scheduler.listLeases().map((lease) => lease.conversation_key),
    [`engine:${MEMBER}:${bucketOf(ENGINE_KEY)}`, `engine:${MEMBER}:-`]);
  for (const handle of [keyed, bare]) {
    assert.equal(handle.lease.state, 'active');
    assert.equal(handle.lease.node_id, nodeId);
    assert.equal(handle.lease.model, 'alpha');
    assert.equal(Object.hasOwn(handle, 'token'), false, 'the engine lease hands out no route token');
  }
});

test('the engine key folds into at most 16 buckets per member and never reaches a lease', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  addNode(scheduler);
  const keys = Array.from({ length: 100 }, (_, i) => crypto.createHash('sha256').update(String(i)).digest('base64url'));
  for (const engineKey of [...keys, keys[0]]) (await pool.engineRoute.acquire(engine({ engineKey }))).release({ ok: true });
  const conversationKeys = scheduler.listLeases().map((lease) => lease.conversation_key);
  assert.equal(conversationKeys.length, 101);
  assert.equal(conversationKeys[0], conversationKeys[100], 'the same key shares a lease key');
  assert.ok(new Set(conversationKeys).size <= 16);
  for (const key of conversationKeys) assert.match(key, new RegExp(`^engine:${MEMBER}:[0-9a-f]$`, 'u'));
  const listed = JSON.stringify(scheduler.listLeases());
  assert.equal(keys.some((key) => listed.includes(key)), false);
});

test('engine acquire refuses a bad member id, a malformed engine key and a model not in the pool', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  addNode(scheduler);
  for (const memberId of [undefined, '', 'owner', 'member bob']) {
    await assert.rejects(pool.engineRoute.acquire(engine({ memberId })), (error) => error.reason === 'member_author_required');
  }
  for (const engineKey of ['short', 'A'.repeat(44), `${'A'.repeat(42)}=`, 42]) {
    await assert.rejects(pool.engineRoute.acquire(engine({ engineKey })), (error) => error.reason === 'engine_key_invalid');
  }
  await assert.rejects(pool.engineRoute.acquire(engine({ model: 'gamma' })), (error) => error.reason === 'model_not_in_pool');
  assert.equal(scheduler.listLeases().length, 0);
});

test('a queued engine lease waits by the scheduler, not by the 120 s turn wait, and calls onQueued once', async (t) => {
  const { pool, scheduler, clock } = compose(t, { limits: { queueWaitMs: 50 } });
  await pool.start();
  const nodeId = addNode(scheduler);
  const first = await pool.engineRoute.acquire(engine());
  const queued = [];
  const second = pool.engineRoute.acquire(engine({ engineKey: 'B'.repeat(43),
    onQueued: (lease) => { queued.push([lease.state, lease.model, lease.node_id]); } }));
  await sleep(120);
  clock.advance(121_000);
  scheduler.touchNode(nodeId); // the node stays in contact; only the queue wait is under test
  scheduler.sweep(clock());
  assert.equal(scheduler.listLeases()[1].state, 'queued', 'still queued after the turn route wait');
  assert.deepEqual(queued, [['queued', 'alpha', null]]);
  first.release({ ok: true });
  const handle = await second;
  assert.equal(handle.lease.state, 'active');
  assert.equal(pool.resources().waiters, 0);
});

test('a queued engine lease fails with queue_timeout at the scheduler wait of 10 minutes', async (t) => {
  const { pool, scheduler, clock } = compose(t);
  await pool.start();
  addNode(scheduler);
  await pool.engineRoute.acquire(engine());
  const waiting = pool.engineRoute.acquire(engine({ engineKey: undefined }));
  await sleep(10);
  clock.advance(10 * 60_000);
  scheduler.sweep(clock());
  await assert.rejects(waiting, (error) => error.reason === 'queue_timeout');
  assert.equal(pool.resources().waiters, 0);
});

test('engine release is idempotent and an abort while queued cancels the lease', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  addNode(scheduler);
  const held = await pool.engineRoute.acquire(engine());
  const controller = new AbortController();
  const waiting = pool.engineRoute.acquire(engine({ engineKey: undefined, signal: controller.signal }));
  await sleep(10);
  controller.abort();
  await assert.rejects(waiting, (error) => error.reason === 'cancelled');
  assert.deepEqual([scheduler.listLeases()[1].state, scheduler.listLeases()[1].reason], ['failed', 'cancelled']);
  held.release({ ok: true });
  held.release({ ok: false });
  assert.deepEqual([scheduler.listLeases()[0].state, scheduler.listLeases()[0].reason], ['released', 'settled']);
});

test('stop rejects a queued engine acquire and leaves no waiter', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  addNode(scheduler);
  await pool.engineRoute.acquire(engine());
  const waiting = pool.engineRoute.acquire(engine({ engineKey: undefined }));
  await sleep(10);
  await pool.stop();
  await assert.rejects(waiting, (error) => error.reason === 'cancelled');
  assert.equal(pool.resources().waiters, 0);
  await assert.rejects(pool.engineRoute.acquire(engine()), (error) => error.reason === 'team_pool_unavailable');
});

// ---------------------------------------------------------------------------
// Who may use the pool, and the monotonic clock.

const isForbidden = (error) => error.kind === 'forbidden' && error.reason === 'role_forbidden';
const liveOf = (scheduler, memberId) => scheduler.listLeases()
  .filter((lease) => lease.member_id === memberId && (lease.state === 'queued' || lease.state === 'active'));

test('a composition without a pool access function throws at construction', () => {
  for (const mayUsePool of [undefined, null, true, 'yes']) {
    assert.throws(() => createPoolComposition({ contextLength: 32768, mayUsePool }), TypeError, String(mayUsePool));
  }
});

test('the access function hears the conversation; a refusal, a throw or a non-true answer takes no lease', async (t) => {
  const calls = [];
  let answer = () => true;
  const { pool, scheduler } = compose(t, { mayUsePool: (...args) => { calls.push(args); return answer(); } });
  await pool.start();
  addNode(scheduler, { slots: 2 });
  (await pool.turnRoute.acquire(turn())).release({ ok: true });
  (await pool.engineRoute.acquire(engine())).release({ ok: true });
  assert.deepEqual(calls, [[MEMBER, 'session_1'], [MEMBER, null]]);
  for (const refusal of [() => false, () => 1, () => 'true', () => { throw new Error('directory broke'); }]) {
    answer = refusal;
    await assert.rejects(pool.turnRoute.acquire(turn()), isForbidden);
    await assert.rejects(pool.engineRoute.acquire(engine()), isForbidden);
  }
  assert.deepEqual(liveOf(scheduler, MEMBER), []);
});

for (const route of ['turnRoute', 'engineRoute']) {
  test(`a member refused while queued gets no lease when the slot frees (${route})`, async (t) => {
    const refused = new Set();
    const { pool, scheduler } = compose(t, { mayUsePool: (memberId) => !refused.has(memberId) });
    await pool.start();
    addNode(scheduler);
    const first = await pool.turnRoute.acquire(turn({ memberId: OTHER }));
    const waiting = pool[route].acquire(route === 'turnRoute' ? turn({ sessionId: 'session_2' }) : engine());
    await sleep(10);
    assert.equal(liveOf(scheduler, MEMBER)[0].state, 'queued');
    refused.add(MEMBER);
    first.release({ ok: true });
    await assert.rejects(waiting, isForbidden);
    assert.deepEqual(liveOf(scheduler, MEMBER), []);
    assert.equal(pool.resources().waiters, 0);
  });
}

test('recheckLeases asks every live lease with its own session and ends only the refused ones', async (t) => {
  const refused = new Set();
  const { pool, scheduler, logger } = compose(t, { mayUsePool: (memberId, sessionId) => !refused.has(`${memberId}|${sessionId}`) });
  await pool.start();
  const nodeId = addNode(scheduler);
  const active = await pool.engineRoute.acquire(engine());
  const { job } = scheduler.createJob(active.lease.lease_id, { requestBytes: Buffer.from('{}') });
  assert.equal(scheduler.claim(nodeId, 1).job.job_id, job.job_id);
  const queued = pool.turnRoute.acquire(turn({ sessionId: 'session_2' }));
  const kept = pool.turnRoute.acquire(turn({ sessionId: 'session_4' }));
  const other = pool.turnRoute.acquire(turn({ memberId: OTHER, sessionId: 'session_2' }));
  await sleep(10);
  assert.equal(pool.resources().leases, 4);
  assert.equal(pool.recheckLeases(), 0, 'every lease still allowed');
  refused.add(`${MEMBER}|null`).add(`${MEMBER}|session_2`);
  assert.equal(pool.recheckLeases(), 2);
  await assert.rejects(queued, isForbidden);
  assert.equal(scheduler.getJob(job.job_id).state, 'cancelled');
  assert.equal(liveOf(scheduler, MEMBER).length, 1, 'the same member\'s other conversation keeps its lease');
  const winner = await Promise.race([kept, other]);
  assert.match(winner.token, /^[A-Za-z0-9_-]{43}$/u, 'the freed slot goes to a lease still allowed');
  assert.equal(liveOf(scheduler, OTHER).length, 1);
  assert.deepEqual(logger.calls.filter(([, event]) => event === 'team.pool.leases_rechecked').map(([, , fields]) => fields),
    [{ ended: 2 }]);
  await pool.stop();
  assert.equal(pool.resources().leases, 0);
});

test('recheckLeases goes on past a cancel that throws and logs one count', async (t) => {
  let throws = 1;
  const createScheduler = (options) => {
    const real = createPoolScheduler(options);
    return Object.freeze({ ...real, cancelLease: (...args) => {
      if (throws > 0) { throws -= 1; throw new Error('cancel broke'); }
      return real.cancelLease(...args);
    } });
  };
  let refuse = false;
  const { pool, scheduler, logger } = compose(t, { createScheduler, mayUsePool: (memberId) => !refuse || memberId !== MEMBER });
  await pool.start();
  addNode(scheduler);
  await pool.engineRoute.acquire(engine());
  const first = pool.turnRoute.acquire(turn({ sessionId: 'session_2' }));
  const second = pool.turnRoute.acquire(turn({ sessionId: 'session_3' }));
  await sleep(10);
  refuse = true;
  let ended = null;
  assert.doesNotThrow(() => { ended = pool.recheckLeases(); });
  assert.equal(ended, 2, 'the second queued lease and the active one');
  await assert.rejects(first, isForbidden);
  await assert.rejects(second, isForbidden);
  assert.deepEqual(logger.calls.filter(([, event]) => event === 'team.pool.recheck_failed').map(([, , fields]) => fields),
    [{ failed: 1 }]);
});

test('the default clock is monotonic: wall-clock steps between node contacts change nothing; 30 s of it still expire', async (t) => {
  let mono = 1_000_000;
  let wallOffset = 0;
  const realNow = Date.now;
  t.mock.method(performance, 'now', () => mono);
  t.mock.method(Date, 'now', () => realNow() + wallOffset);
  const { pool, scheduler } = compose(t, { clock: null, limits: { sweepIntervalMs: 20 } });
  await pool.start();
  const nodeId = addNode(scheduler);
  const handle = await pool.engineRoute.acquire(engine());
  const { job } = scheduler.createJob(handle.lease.lease_id, { requestBytes: Buffer.from('{}') });
  scheduler.claim(nodeId, 1);
  const states = () => [scheduler.getLease(handle.lease.lease_id).state, scheduler.getJob(job.job_id).state,
    scheduler.listNodes()[0].online];
  for (const step of [-3_600_000, 31_000]) {
    wallOffset += step;
    await sleep(60);
    assert.deepEqual(states(), ['active', 'claimed', true], `wall clock stepped ${step} ms`);
    scheduler.touchNode(nodeId);
  }
  mono += 30_000;
  await sleep(60);
  assert.deepEqual(states(), ['failed', 'failed', false]);
  assert.equal(scheduler.getJob(job.job_id).reason, 'node_lost');
});

test('acquire with wait false refuses a busy pool at once with pool_busy and leaves no lease or waiter', async (t) => {
  const { pool, scheduler } = compose(t);
  await pool.start();
  addNode(scheduler);
  const held = await pool.turnRoute.acquire(turn());
  await assert.rejects(pool.turnRoute.acquire(turn({ sessionId: 'session_2', wait: false })),
    (error) => error.reason === 'pool_busy' && error.retryable === true);
  assert.equal(pool.resources().waiters, 0);
  assert.equal(pool.resources().leases, 1, 'only the held lease is remembered');
  assert.deepEqual(scheduler.listLeases().filter((lease) => lease.state === 'queued'), []);
  held.release({ ok: true });
  const free = await pool.turnRoute.acquire(turn({ sessionId: 'session_3', wait: false }));
  assert.match(free.token, /^[A-Za-z0-9_-]{43}$/u, 'a free slot still answers a non-waiting acquire');
});
