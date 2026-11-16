'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');

function route(provider = 'ollama', resourceClass = 'local') {
  return captureRuntimeRoute({ engine_type: provider, provider_id: provider,
    configuration_revision: 'config-1', resource_class: resourceClass,
    requires_gpu: resourceClass === 'local' });
}

test('local serialization and independent cloud providers preserve per-session exclusion', () => {
  const lanes = new RuntimeLaneAdmission();
  const local = route();
  const cloud = route('chatgpt', 'cloud');
  const other = route('codex-cli', 'cloud');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'a', route: local }).status, 'granted');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'b', route: local }).reason, 'lane_capacity');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'a', route: cloud }).reason, 'session_busy');
  for (const sessionId of ['b', 'c']) {
    assert.equal(lanes.tryAcquireTurn({ sessionId, route: cloud }).status, 'granted');
  }
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'd', route: cloud }).status, 'waiting');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'd', route: other }).status, 'granted');
});

test('a priority turn takes one extra slot per lane; ordinary turns never borrow it', () => {
  const lanes = new RuntimeLaneAdmission();
  const local = route();
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'worker', route: local }).status, 'granted');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'other', route: local }).reason, 'lane_capacity');
  const primary = lanes.tryAcquireTurn({ sessionId: 'jenny', route: local, priority: true });
  assert.equal(primary.status, 'granted', 'the primary runs beside the worker');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'jenny2', route: local, priority: true }).reason, 'lane_capacity',
    'one priority slot per lane');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'other', route: local }).reason, 'lane_capacity',
    'the worker slot is still taken');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'jenny', route: local, priority: true }).reason, 'session_busy');
  assert.equal(lanes.snapshot().active_leases, 2);
  // Generation stays serialized: the inference lane has no priority slot.
  assert.equal(lanes.tryAcquireInference({ ownerId: 'w', route: local }).status, 'granted');
  assert.equal(lanes.tryAcquireInference({ ownerId: 'j', route: local }).reason, 'lane_capacity');
  // The primary alone never blocks an ordinary turn, and a priority turn cannot exceed the downstream capacity.
  assert.equal(lanes.release(primary.lease, { producerSettled: true }), true);
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'jenny', route: local, priority: true }).status, 'granted');
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'other', route: local }).reason, 'lane_capacity',
    'the worker still holds the ordinary slot');
  const tight = new RuntimeLaneAdmission({ maxRunnableTurns: 1 });
  assert.equal(tight.tryAcquireTurn({ sessionId: 'worker', route: local }).status, 'granted');
  assert.equal(tight.tryAcquireTurn({ sessionId: 'jenny', route: local, priority: true }).reason, 'downstream_capacity');
  // Two priority sessions never add up to two extra slots: the first takes the single extra slot, the
  // second an ordinary slot, and the third turn (priority or not) waits.
  const two = new RuntimeLaneAdmission();
  assert.equal(two.tryAcquireTurn({ sessionId: 'p1', route: local, priority: true }).status, 'granted');
  assert.equal(two.tryAcquireTurn({ sessionId: 'p2', route: local, priority: true }).status, 'granted');
  assert.equal(two.tryAcquireTurn({ sessionId: 'p3', route: local, priority: true }).reason, 'lane_capacity');
  assert.equal(two.tryAcquireTurn({ sessionId: 'o1', route: local }).reason, 'lane_capacity');
  assert.equal(two.snapshot().active_leases, 2);
});

test('inference limits are independent from runnable turns and bounded by downstream capacity', () => {
  const lanes = new RuntimeLaneAdmission({ maxInferenceRequests: 5 });
  const cloud = route('chatgpt', 'cloud');
  lanes.tryAcquireTurn({ sessionId: 'a', route: cloud });
  for (let index = 0; index < 4; index += 1) {
    assert.equal(lanes.tryAcquireInference({ ownerId: `request-${index}`, route: cloud }).status, 'granted');
  }
  assert.equal(lanes.tryAcquireInference({ ownerId: 'over', route: cloud }).reason, 'lane_capacity');
  assert.equal(lanes.tryAcquireInference({ ownerId: 'local', route: route() }).status, 'granted');
  assert.equal(lanes.tryAcquireInference({ ownerId: 'other', route: route('codex-cli', 'cloud') }).reason,
    'downstream_capacity');
  assert.equal(lanes.snapshot().active_leases, 6);
});

test('cancellation and uncertain cleanup keep capacity until actual producer settlement', () => {
  const lanes = new RuntimeLaneAdmission();
  const local = route();
  const controller = new AbortController();
  const { lease } = lanes.tryAcquireTurn({ sessionId: 'a', route: local, signal: controller.signal });
  controller.abort();
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'b', route: local }).status, 'waiting');
  assert.equal(lanes.release(lease), false);
  assert.equal(lanes.snapshot().quarantined, 1);
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'a', route: route('chatgpt', 'cloud') }).reason, 'session_busy');
  assert.equal(lanes.confirmCleanup({ ...lease }), false);
  assert.equal(lanes.confirmCleanup(lease), true);
  assert.equal(lanes.confirmCleanup(lease), false);
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'b', route: local }).status, 'granted');
  assert.deepEqual(lanes.tryAcquireTurn({ sessionId: 'c', route: local, signal: controller.signal }),
    { status: 'rejected', reason: 'cancelled' });
});

test('waiting refusals identify the leases that consume each capacity boundary', () => {
  const local = route();
  const cloud = route('chatgpt', 'cloud');
  const otherCloud = route('codex-cli', 'cloud');
  const sessionLanes = new RuntimeLaneAdmission({ limits: { local: { runnable_turns: 2 } } });
  sessionLanes.tryAcquireTurn({ sessionId: 'shared', route: local });
  const sessionBusy = sessionLanes.tryAcquireTurn({ sessionId: 'shared', route: cloud });
  assert.deepEqual(sessionBusy, { status: 'waiting', reason: 'session_busy',
    blockers: [{ session_id: 'shared', quarantined_at: null }] });
  assert.equal(Object.isFrozen(sessionBusy.blockers), true);
  assert.equal(Object.isFrozen(sessionBusy.blockers[0]), true);

  const downstreamLanes = new RuntimeLaneAdmission({ maxRunnableTurns: 2,
    limits: { local: { runnable_turns: 2 }, cloud: { runnable_turns: 2 } } });
  downstreamLanes.tryAcquireTurn({ sessionId: 'local', route: local });
  downstreamLanes.tryAcquireTurn({ sessionId: 'cloud', route: cloud });
  assert.deepEqual(downstreamLanes.tryAcquireTurn({ sessionId: 'other', route: otherCloud }).blockers,
    [{ session_id: 'local', quarantined_at: null },
      { session_id: 'cloud', quarantined_at: null }]);

  const laneLanes = new RuntimeLaneAdmission();
  laneLanes.tryAcquireTurn({ sessionId: 'local', route: local });
  assert.deepEqual(laneLanes.tryAcquireTurn({ sessionId: 'other', route: local }), {
    status: 'waiting', reason: 'lane_capacity',
    blockers: [{ session_id: 'local', quarantined_at: null }],
  });
});

test('a quarantined lease is timestamped once and exposes that timestamp to blockers', () => {
  let now = 100;
  const lanes = new RuntimeLaneAdmission({ now: () => now });
  const local = route();
  const { lease } = lanes.tryAcquireTurn({ sessionId: 'shared', route: local });
  assert.equal(lanes.release(lease, { producerSettled: false }), false);
  now = 200;
  assert.equal(lanes.release(lease, { producerSettled: false }), false);
  assert.deepEqual(lanes.tryAcquireTurn({ sessionId: 'shared', route: route('chatgpt', 'cloud') }), {
    status: 'waiting', reason: 'session_busy',
    blockers: [{ session_id: 'shared', quarantined_at: 100 }],
  });
});

test('lowering limits does not release active work and stale tokens cannot release new leases', () => {
  let nextId = 0;
  const lanes = new RuntimeLaneAdmission({ createId: () => String(++nextId), limits: { local: { runnable_turns: 2 } } });
  const local = route();
  const first = lanes.tryAcquireTurn({ sessionId: 'a', route: local }).lease;
  const second = lanes.tryAcquireTurn({ sessionId: 'b', route: local }).lease;
  lanes.setLimits({ local: { runnable_turns: 1 } });
  assert.equal(lanes.snapshot().active_leases, 2);
  lanes.release(first, { producerSettled: true });
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'c', route: local }).status, 'waiting');
  lanes.release(second, { producerSettled: true });
  nextId = 0;
  const replacement = lanes.tryAcquireTurn({ sessionId: 'c', route: local }).lease;
  assert.equal(replacement.id, first.id);
  assert.equal(lanes.release(first, { producerSettled: true }), false);
  assert.equal(lanes.snapshot().active_leases, 1);
});

test('routes require trusted capture and cloud metadata cannot request the local GPU', () => {
  const lanes = new RuntimeLaneAdmission();
  const trusted = route();
  assert.throws(() => lanes.tryAcquireTurn({ sessionId: 'a', route: { ...trusted } }), /untrusted/);
  assert.throws(() => captureRuntimeRoute({ ...trusted, resource_class: 'cloud' }), /invalid/);
  assert.throws(() => captureRuntimeRoute({ ...trusted, endpoint_hostname: 'localhost' }), /invalid/);
  const snapshot = lanes.snapshot();
  snapshot.configured.local.runnable_turns = 16;
  assert.equal(lanes.snapshot().configured.local.runnable_turns, 1);
});

test('an inference waiter names the chat whose generation holds the lane', () => {
  const lanes = new RuntimeLaneAdmission();
  const local = route();
  assert.equal(lanes.tryAcquireInference({ ownerId: 'work_beta', sessionId: 'sess_beta', route: local }).status, 'granted');
  const waiting = lanes.tryAcquireInference({ ownerId: 'work_jenny', sessionId: 'sess_jenny', route: local });
  assert.equal(waiting.reason, 'lane_capacity');
  assert.deepEqual(waiting.blockers.map(blocker => blocker.session_id), ['sess_beta']);
  // An auxiliary owner without a chat, or a malformed id, still blocks but names nobody.
  const aux = new RuntimeLaneAdmission();
  aux.tryAcquireInference({ ownerId: 'aux_compaction', sessionId: 'bad id!', route: local });
  assert.deepEqual(aux.tryAcquireInference({ ownerId: 'w', route: local }).blockers.map(b => b.session_id), [null]);
  // The session id never turns an inference lease into a turn: the same chat's turn is not session_busy.
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'sess_beta', route: local }).status, 'granted');
});

test('queued inference re-admits are granted oldest first; stale waiters expire', () => {
  let now = 1_000;
  const lanes = new RuntimeLaneAdmission({ now: () => now });
  const local = route();
  const held = lanes.tryAcquireInference({ ownerId: 'woken', route: local, queue: true });
  assert.equal(held.status, 'granted');
  // The primary polls while the woken chat generates.
  assert.equal(lanes.tryAcquireInference({ ownerId: 'primary', route: local, queue: true }).reason, 'lane_capacity');
  lanes.release(held.lease, { producerSettled: true });
  // The woken chat's tool finished in milliseconds: it must not cut in front of the waiting primary.
  const cutIn = lanes.tryAcquireInference({ ownerId: 'woken', route: local, queue: true });
  assert.equal(cutIn.status, 'waiting');
  assert.equal(cutIn.queued, true, 'held back by the queue, not by a holder');
  now += 500;
  const primary = lanes.tryAcquireInference({ ownerId: 'primary', route: local, queue: true });
  assert.equal(primary.status, 'granted');
  lanes.release(primary.lease, { producerSettled: true });
  assert.equal(lanes.tryAcquireInference({ ownerId: 'woken', route: local, queue: true }).status, 'granted');
});

test('the inference queue ignores unqueued callers, expired waiters and forgotten owners', () => {
  let now = 1_000;
  const lanes = new RuntimeLaneAdmission({ now: () => now });
  const local = route();
  const acquire = (ownerId, queue = true) => lanes.tryAcquireInference({ ownerId, route: local, queue });
  const held = acquire('a', false);
  assert.equal(acquire('b').status, 'waiting');
  lanes.release(held.lease, { producerSettled: true });
  // A turn start (unqueued) is not held behind the poller.
  const start = acquire('c', false);
  assert.equal(start.status, 'granted');
  lanes.release(start.lease, { producerSettled: true });
  // 'b' stopped polling (its turn was cancelled): after the TTL it no longer holds the queue.
  now += 3_001;
  const next = acquire('d');
  assert.equal(next.status, 'granted');
  lanes.release(next.lease, { producerSettled: true });
  // A closed gateway forgets its waiter at once.
  const held2 = acquire('x', false);
  assert.equal(acquire('f').status, 'waiting');
  lanes.release(held2.lease, { producerSettled: true });
  assert.equal(acquire('g').status, 'waiting', "'f' is still ahead");
  lanes.forgetInferenceWaiter('f');
  assert.equal(acquire('g').status, 'granted');
});

// Row 136 "Finish this first": one chat's task is put first on its lane.
function firstFixture(options = {}) {
  const clock = { now: 1_000 };
  const lanes = new RuntimeLaneAdmission({ now: () => clock.now, ...options });
  const local = route();
  const infer = (sessionId, ownerId = `req_${sessionId}`, queue = true) => (
    lanes.tryAcquireInference({ ownerId, sessionId, route: local, queue }));
  const done = (admission) => lanes.release(admission.lease, { producerSettled: true });
  return { clock, lanes, local, infer, done };
}

test('a first chat keeps the model through its tool gaps and others name it as the blocker', () => {
  const { clock, lanes, local, infer, done } = firstFixture();
  assert.deepEqual(lanes.setFirstSession('first'), { status: 'rejected', reason: 'session_not_running' });
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'first', route: local }).status, 'granted');
  const set = lanes.setFirstSession('first');
  assert.equal(set.status, 'set');
  assert.deepEqual(lanes.firstSession(), { session_id: 'first', set_by: 'user', set_at: 1_000 });
  assert.equal(lanes.snapshot().first.session_id, 'first');
  const running = infer('first');
  assert.equal(running.status, 'granted');
  done(running);
  // The first chat is running a quick tool: the lane is free, but the other chat is held.
  clock.now += 5_000;
  const held = infer('other');
  assert.equal(held.status, 'waiting');
  assert.equal(held.reason, 'lane_capacity');
  assert.equal(held.held_for_first, true);
  assert.deepEqual(held.blockers, [{ session_id: 'first', quarantined_at: null }]);
  // A request with no chat (a title, a suggestion) waits too.
  assert.equal(lanes.tryAcquireInference({ ownerId: 'aux', route: local }).held_for_first, true);
  const next = infer('first', 'req_first_2');
  assert.equal(next.status, 'granted', 'the first chat is not queued behind the waiter');
  done(next);
});

test('the hold lapses when the first chat stays away, and it still goes next when it returns', () => {
  const { clock, lanes, local, infer, done } = firstFixture();
  lanes.tryAcquireTurn({ sessionId: 'first', route: local });
  lanes.setFirstSession('first', { setBy: 'primary' });
  assert.equal(lanes.firstSession().set_by, 'primary');
  done(infer('first'));
  // A long command or an approval: past the grace the other chat may use the model.
  clock.now += 60_001;
  const other = infer('other');
  assert.equal(other.status, 'granted');
  // A third chat queues, then the first chat asks again: it is ahead of the older waiter.
  assert.equal(infer('third').status, 'waiting');
  clock.now += 500;
  assert.equal(infer('first', 'req_first_2').status, 'waiting', 'a running request is never cut off');
  done(other);
  assert.equal(infer('third').held_for_first, true);
  const back = infer('first', 'req_first_2');
  assert.equal(back.status, 'granted');
  // While its own request runs past the grace, a second local slot is still not handed out.
  lanes.setLimits({ local: { inference_requests: 2 } });
  clock.now += 120_000;
  assert.equal(infer('third').held_for_first, true);
  done(back);
});

test('first status follows helper chats, ends with the task and is replaced by a newer pick', () => {
  const sameTask = (firstId, sessionId) => firstId === 'first' && sessionId === 'helper';
  let lookups = 0;
  const counted = (firstId, sessionId) => { lookups += 1; return sameTask(firstId, sessionId); };
  const { clock, lanes, local, infer, done } = firstFixture({ sameTask: counted,
    limits: { local: { runnable_turns: 3 } } });
  const turn = lanes.tryAcquireTurn({ sessionId: 'first', route: local });
  lanes.setFirstSession('first');
  const helper = infer('helper');
  assert.equal(helper.status, 'granted', 'a helper of the first chat is part of its task');
  assert.equal(infer('other').held_for_first, true);
  done(helper);
  // The first chat suspends behind its helper: the helper's turn keeps the task alive.
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'helper', route: local }).status, 'granted');
  lanes.release(turn.lease, { producerSettled: true });
  clock.now += 30_000;
  done(infer('helper', 'req_helper_2'));
  assert.equal(infer('other').held_for_first, true);
  assert.equal(lanes.firstSession().session_id, 'first');
  assert.equal(lookups, 2, 'one lookup per chat for the life of the pick: helper and other');
  // Another chat is picked instead: the newer pick wins.
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'other', route: local }).status, 'granted');
  assert.equal(lanes.setFirstSession('other').status, 'set');
  assert.equal(infer('helper', 'req_helper_3').held_for_first, true);
  assert.equal(lanes.clearFirstSession('first'), false, 'a stale clear does not drop the newer pick');
  assert.equal(lanes.clearFirstSession('other'), true);
  assert.equal(lanes.firstSession(), null);
});

test('first status ends once the chat has had nothing running for the idle window', () => {
  const { clock, lanes, local, infer, done } = firstFixture();
  const turn = lanes.tryAcquireTurn({ sessionId: 'first', route: local });
  lanes.setFirstSession('first');
  done(infer('first'));
  lanes.release(turn.lease, { producerSettled: true });
  // The task is over: nothing is held for it, though a quick follow-up would still be first.
  assert.equal(infer('other', 'req_other', false).status, 'granted');
  assert.equal(lanes.firstSession().session_id, 'first');
  clock.now += 60_001;
  assert.equal(lanes.firstSession(), null);
  // The window starts when the last reply ends, not when somebody next looks.
  const quiet = firstFixture();
  const quietTurn = quiet.lanes.tryAcquireTurn({ sessionId: 'first', route: quiet.local });
  quiet.lanes.setFirstSession('first');
  quiet.lanes.release(quietTurn.lease, { producerSettled: true });
  quiet.clock.now += 60_001;
  assert.equal(quiet.lanes.firstSession(), null);
});

test('the person\'s pick stands against Jenny\'s, and bad input never becomes a pick', () => {
  const { lanes, local } = firstFixture({ limits: { local: { runnable_turns: 2 } } });
  lanes.tryAcquireTurn({ sessionId: 'mine', route: local });
  lanes.tryAcquireTurn({ sessionId: 'other', route: local });
  assert.equal(lanes.setFirstSession('other', { setBy: 'primary' }).status, 'set');
  assert.equal(lanes.setFirstSession('mine').status, 'set', 'the person replaces Jenny\'s pick');
  assert.deepEqual(lanes.setFirstSession('other', { setBy: 'primary' }), { status: 'rejected', reason: 'user_pick_active' });
  assert.equal(lanes.firstSession().session_id, 'mine');
  assert.throws(() => lanes.setFirstSession('bad id!'), /runtime_session_identity_invalid/);
  // A sameTask predicate that throws never grants membership.
  const broken = firstFixture({ sameTask: () => { throw new Error('store unavailable'); } });
  broken.lanes.tryAcquireTurn({ sessionId: 'first', route: broken.local });
  broken.lanes.setFirstSession('first');
  assert.equal(broken.infer('helper').held_for_first, true);
});

test('a held request that does not poll is announced again when the grace can have ended', () => {
  const timers = [];
  let changes = 0;
  const { clock, lanes, local, infer, done } = firstFixture({ onChange: () => { changes += 1; },
    setTimer: (callback, delay) => { timers.push({ callback, delay }); return { unref() {} }; } });
  lanes.tryAcquireTurn({ sessionId: 'first', route: local });
  lanes.setFirstSession('first');
  const running = infer('first');
  // While the first chat's request runs, its release is the announcement: no timer.
  assert.equal(infer('other', 'start_other', false).held_for_first, true);
  assert.equal(timers.length, 0);
  done(running);
  clock.now += 10_000;
  // In the grace a reply's first request (unqueued) is held; one wake is set for the grace's end.
  assert.equal(infer('other', 'start_other', false).held_for_first, true);
  assert.equal(infer('third', 'start_third', false).held_for_first, true);
  assert.deepEqual(timers.map((timer) => timer.delay), [50_001]);
  // A polling request needs no wake.
  assert.equal(infer('fourth').held_for_first, true);
  assert.equal(timers.length, 1);
  clock.now += 50_001;
  const before = changes;
  timers[0].callback();
  assert.equal(changes, before + 1);
  assert.equal(infer('other', 'start_other', false).status, 'granted');
});

test('the chat.firstSession command sets, reads and lifts the pick of the person over the lanes (row 136)', () => {
  const { chatMethods } = require('../../services/backend/backend-service-chat-methods');
  const { lanes, local } = firstFixture();
  const call = (request) => chatMethods.firstChatSession.call({ sessionRuntime: { lanes } }, request);
  assert.deepEqual(chatMethods.firstChatSession.call({}, { action: 'set', sessionId: 'chat_a' }),
    { status: 'unavailable', first: null });
  assert.deepEqual(call({ action: 'get' }), { status: 'ok', first: null });
  assert.deepEqual(call({ action: 'set', sessionId: 'chat_a' }),
    { status: 'rejected', reason: 'session_not_running', first: null });
  assert.deepEqual(call({ action: 'set', sessionId: '' }), { status: 'rejected', reason: 'session_invalid', first: null });
  assert.equal(lanes.tryAcquireTurn({ sessionId: 'chat_a', route: local }).status, 'granted');
  assert.deepEqual(call({ action: 'set', sessionId: 'chat_a' }),
    { status: 'set', first: { sessionId: 'chat_a', setBy: 'user' } });
  // A clear for another chat leaves the pick; the picked chat's own clear lifts it.
  assert.equal(call({ action: 'clear', sessionId: 'chat_b' }).first.sessionId, 'chat_a');
  assert.deepEqual(call({ action: 'clear', sessionId: 'chat_a' }), { status: 'ok', first: null });
});

test('a pick made before the chat starts waits for that chat\'s own turn and starts with it (row 136 slice 3)', () => {
  const options = { limits: { local: { runnable_turns: 4 } }, sameTask: (first, id) => first === 'first' && id === 'helper' };
  const { clock, lanes, local, infer, done } = firstFixture(options);
  // A helper chat of the idle chat is still running: it does not start the pick.
  const helper = lanes.tryAcquireTurn({ sessionId: 'helper', route: local });
  assert.deepEqual(lanes.setFirstSession('first', { setBy: 'primary', picker: 'jenny', whenStarted: true }),
    { status: 'set', session_id: 'first', set_by: 'primary', set_at: 1_000, started: false });
  done(infer('other'));
  lanes.release(helper.lease, { producerSettled: true });
  clock.now += 5 * 60_000;
  assert.equal(lanes.firstSession().session_id, 'first', 'still inside the start window');
  // Its own turn starts the pick at once, before any model request of that turn.
  const turn = lanes.tryAcquireTurn({ sessionId: 'first', route: local });
  assert.equal(infer('other').held_for_first, true);
  assert.equal(lanes.tryAcquireInference({ ownerId: 'aux', route: local }).held_for_first, true, 'a request with no chat is not the picker');
  assert.equal(infer('jenny').status, 'granted');
  // A started pick ends 60 s after its last turn, like any other.
  const short = firstFixture();
  short.lanes.setFirstSession('first', { setBy: 'primary', whenStarted: true });
  const brief = short.lanes.tryAcquireTurn({ sessionId: 'first', route: short.local });
  short.lanes.release(brief.lease, { producerSettled: true });
  short.clock.now += 60_001;
  assert.equal(short.lanes.firstSession(), null, 'a turn that made no model request still started the pick');
  // A pick on a running chat reports that it started, and the person's button path is unchanged.
  assert.equal(lanes.setFirstSession('first').started, true);
  lanes.release(turn.lease, { producerSettled: true });
});
