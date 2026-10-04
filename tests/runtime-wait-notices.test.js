'use strict';

// Dogfood HB-034 F5: a reply that paused by itself behind another chat's
// command emitted nothing, so the chat said "Still at it…" for a reply that
// was not running. The wait is now reported on the paused stream.

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const { ResourceBroker, capacityResource, filesystemResource } = require('../services/session-runtime/resource-broker');
const { PhysicalPathResolver } = require('../services/session-runtime/physical-paths');
const { HEARTBEAT_MS, createRuntimeWaitNotices } = require('../services/backend/runtime-wait-notices');
const { buildEnvelopeSources } = require('../services/stream-envelope-shape');

const INCARNATION = 'inc_wait_notice';
const folder = () => [capacityResource('tool_operations'),
  filesystemResource(new PhysicalPathResolver().resolve(os.tmpdir()))];

function pausedWork(overrides = {}) {
  return { work_id: 'work_b', session_id: 'sess_b', turn_id: 'turn_b', status: 'paused', revision: 7,
    attempt: { stream_id: 'stream_b', incarnation: INCARNATION }, ...overrides };
}

function harness({ work = pausedWork(), tracked = true } = {}) {
  const emitted = [];
  const timers = [];
  const state = { work, tracked, now: 1_000_000 };
  const broker = new ResourceBroker({ now: () => state.now });
  const notices = createRuntimeWaitNotices({
    emit: payload => emitted.push(payload),
    broker,
    isTracked: () => state.tracked,
    getWork: () => state.work,
    incarnation: INCARNATION,
    now: () => state.now,
    setTimer: (callback, delayMs) => { const timer = { callback, delayMs }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  });
  // Runs the timers that are due once `ms` has passed, in order.
  const advance = (ms = 0) => {
    state.now += ms;
    for (const timer of timers.filter(entry => entry.delayMs <= ms)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.callback();
    }
  };
  return { broker, emitted, timers, state, notices, advance };
}

test('a reply waiting behind another chat reports that chat on its own paused stream', () => {
  const { broker, emitted, notices, advance } = harness();
  const held = broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  assert.equal(held.status, 'granted');

  assert.equal(notices.note(pausedWork(), folder()), true);
  assert.deepEqual(emitted, [], 'reported after the coordinator has had its turn, not inline');
  advance();
  assert.deepEqual(emitted, [{
    type: 'runtime_waiting', streamId: 'stream_b', sessionId: 'sess_b', requestId: 'stream_b', turnId: 'turn_b',
    traceId: 'stream_b', trace_id: 'stream_b', workId: 'work_b',
    waitState: 'waiting', resourceClass: 'filesystem', blockingSessionId: 'sess_a',
  }]);

  // An unchanged wait is never re-announced.
  notices.refresh();
  advance();
  assert.equal(emitted.length, 1);
});

test('a wait that was resumed before it could be announced says nothing', () => {
  const { broker, emitted, state, notices, advance } = harness();
  const held = broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  notices.note(pausedWork(), folder());
  broker.release(held.lease, { producerSettled: true });
  state.work = pausedWork({ status: 'pending', revision: 8 });
  advance();
  advance(HEARTBEAT_MS);
  assert.deepEqual(emitted, [], 'a line that was never shown has nothing to correct');
  state.work = pausedWork({ status: 'running', revision: 9 });
  advance(HEARTBEAT_MS);
  assert.deepEqual(emitted, []);
  assert.equal(notices.size(), 0);
});

// The Astra pass on B14: none of these raises an event the notices subscribe to.
test('a command that times out into an unconfirmed lease turns the wait stuck with no refresh at all', () => {
  const { broker, emitted, notices, advance } = harness();
  const held = broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  notices.note(pausedWork(), folder());
  advance();
  broker.release(held.lease, { producerSettled: false });
  advance(HEARTBEAT_MS);
  advance(HEARTBEAT_MS);
  assert.deepEqual(emitted.map(event => event.waitState), ['waiting'], 'inside the grace');
  advance(HEARTBEAT_MS);
  assert.deepEqual(emitted.map(event => event.waitState), ['waiting', 'stuck']);
});

test('waits the coordinator dropped without an event end on the next slow pass', () => {
  const { broker, emitted, state, notices, advance } = harness();
  broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  notices.note(pausedWork(), folder());
  advance();
  state.tracked = false; // the runtime was switched off: no broker or work change
  advance(HEARTBEAT_MS);
  assert.deepEqual(emitted.map(event => event.waitState), ['waiting', 'ended']);
  assert.equal(notices.size(), 0);
});

test('a resumed reply still queued for the model stops naming the folder, and a pause on it ends the wait', () => {
  const { broker, emitted, state, notices, advance } = harness();
  const held = broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  notices.note(pausedWork(), folder());
  advance();
  broker.release(held.lease, { producerSettled: true });
  state.work = pausedWork({ status: 'pending', revision: 8 });
  state.tracked = false;
  advance(HEARTBEAT_MS);
  assert.equal(emitted.length, 1, 'a resume that starts within moments changes nothing');
  advance(HEARTBEAT_MS);
  assert.deepEqual({ waitState: emitted[1].waitState, resourceClass: emitted[1].resourceClass,
    blockingSessionId: emitted[1].blockingSessionId },
  { waitState: 'waiting', resourceClass: 'inference', blockingSessionId: '' });

  // Paused before its new stream ever started: no `started` will replace the line.
  state.work = pausedWork({ status: 'paused', revision: 9 });
  advance(HEARTBEAT_MS);
  assert.deepEqual(emitted.map(event => event.waitState), ['waiting', 'waiting', 'ended']);
  assert.equal(emitted[2].streamId, 'stream_b');
  assert.equal(notices.size(), 0);
});

test('nothing is left armed once no reply waits', () => {
  const { broker, state, timers, notices, advance } = harness();
  broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  notices.note(pausedWork(), folder());
  advance();
  assert.equal(timers.length, 1, 'one slow pass while a reply waits');
  state.work = pausedWork({ status: 'running', revision: 8 });
  advance(HEARTBEAT_MS);
  assert.equal(notices.size(), 0);
  assert.deepEqual(timers, []);
});

test('a free folder with the reply still tracked is left to the coordinator', () => {
  const { broker, emitted, notices, advance } = harness();
  const held = broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  notices.note(pausedWork(), folder());
  advance();
  broker.release(held.lease, { producerSettled: true });
  notices.refresh();
  advance();
  assert.equal(emitted.length, 1, 'no second notice while the resume is on its way');
  assert.equal(notices.size(), 1);
});

test('a stopped command that never confirms it ended turns the wait into stuck after the grace', () => {
  const { broker, emitted, timers, notices, advance } = harness();
  const held = broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  notices.note(pausedWork(), folder());
  advance();
  assert.equal(emitted.at(-1).waitState, 'waiting');

  // A stop quarantines the lease at once; an ordinary stop confirms within moments.
  broker.release(held.lease, { producerSettled: false });
  notices.refresh();
  advance();
  assert.equal(emitted.length, 1, 'still an ordinary wait inside the grace');
  assert.equal(timers.length, 1, 'one re-check is armed');

  advance(6000);
  assert.equal(emitted.length, 2);
  assert.deepEqual({ waitState: emitted[1].waitState, blockingSessionId: emitted[1].blockingSessionId,
    streamId: emitted[1].streamId }, { waitState: 'stuck', blockingSessionId: '', streamId: 'stream_b' });
});

test('a stop that confirms inside the grace never reads as stuck', () => {
  const { broker, emitted, state, notices, advance } = harness();
  const held = broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  notices.note(pausedWork(), folder());
  advance();
  broker.release(held.lease, { producerSettled: false });
  notices.refresh();
  advance();
  broker.confirmCleanup(held.lease);
  state.work = pausedWork({ status: 'running', revision: 9 });
  advance(6000);
  assert.deepEqual(emitted.map(event => event.waitState), ['waiting']);
});

test('a wait the coordinator dropped ends: the reply is paused, not continuing by itself', () => {
  const { broker, emitted, state, notices, advance } = harness();
  broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  notices.note(pausedWork(), folder());
  advance();
  state.tracked = false; // engine restart or shutdown cleared the live waits
  notices.refresh();
  advance();
  assert.deepEqual(emitted.map(event => event.waitState), ['waiting', 'ended']);
  assert.equal(notices.size(), 0);
});

test('only a resource wait of this process is announced, and a holder without a chat is not named', () => {
  const { broker, emitted, notices, advance } = harness();
  assert.equal(notices.note(pausedWork({ attempt: { stream_id: 'stream_b', incarnation: 'earlier_process' } }), folder()), false);
  assert.equal(notices.note(pausedWork(), [{ type: 'dependency', work_id: 'work_child' }]), false);
  assert.equal(notices.note(pausedWork(), []), false);

  // The IDE, git or a test run holds the folder: there is no chat to name.
  broker.tryAcquire({ ownerId: 'vfs:save', resources: folder() });
  assert.equal(notices.note(pausedWork(), folder()), true);
  advance();
  assert.deepEqual({ waitState: emitted[0].waitState, resourceClass: emitted[0].resourceClass,
    blockingSessionId: emitted[0].blockingSessionId },
  { waitState: 'waiting', resourceClass: 'filesystem', blockingSessionId: '' });
});

test('a capacity wait is stuck only when nothing holding the class can still finish', () => {
  const { broker, emitted, notices, advance } = harness();
  const tests = [capacityResource('tests')];
  const held = broker.tryAcquire({ ownerId: 'test:run', resources: tests, sessionId: 'sess_a' });
  notices.note(pausedWork(), tests);
  advance();
  assert.deepEqual({ waitState: emitted[0].waitState, resourceClass: emitted[0].resourceClass,
    blockingSessionId: emitted[0].blockingSessionId },
  { waitState: 'waiting', resourceClass: 'tests', blockingSessionId: '' });
  broker.release(held.lease, { producerSettled: false });
  notices.refresh();
  advance();
  advance(6000);
  assert.equal(emitted.at(-1).waitState, 'stuck');
});

test('the broker names the leases in the way without conveying one', () => {
  const broker = new ResourceBroker();
  assert.deepEqual(broker.describeWait(folder()), { resource_class: null, holders: [] });
  const held = broker.tryAcquire({ ownerId: 'tool-a', resources: folder(), sessionId: 'sess_a' });
  const wait = broker.describeWait(folder());
  assert.equal(wait.resource_class, 'filesystem');
  assert.deepEqual(wait.holders, [{ session_id: 'sess_a', status: 'active', quarantined_at: null }]);
  assert.equal(Object.isFrozen(wait) && Object.isFrozen(wait.holders), true);
  assert.equal(broker.snapshot().lease_count, 1, 'describing a wait reserves nothing');
  broker.release(held.lease, { producerSettled: true });
  assert.deepEqual(broker.describeWait(folder()).holders, []);
});

test('a waiting notice crosses the stream envelope one to one', () => {
  // 'delta' envelopes are merged per key; a state report must arrive whole.
  const sources = buildEnvelopeSources({ type: 'runtime_waiting', streamId: 'stream_b', waitState: 'waiting' }, 'runtime_waiting');
  assert.deepEqual(sources.map(source => [source.channel, source.eventKind, source.payload.waitState]),
    [['control', 'progress', 'waiting']]);
});
