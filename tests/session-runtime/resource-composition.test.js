'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeSessionRuntimeComposition } = require('../../services/session-runtime/composition');
const { capacityResource, filesystemResource } = require('../../services/session-runtime/resource-broker');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');

test('composed runtime keeps queued and quarantined filesystem/tool work busy even with dispatch OFF', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-resource-composition-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const service = { options: { userDataPath: profile }, featureFlags: { session_runtime: false },
    activeStreams: new Map(),
    sessionStore: { conversationStore: { resolvePendingContinuation() {} },
      getSession() {}, getActiveTurn() {} },
    sessionTurnActors: { blockCheckpointOrphan() {}, pauseRecoveredCheckpoint() {},
      settleCheckpointOrphan() {} },
    turnEventJournal: { list: () => [] },
    sessionExecutionAuthority: {}, configService: { getState: () => ({
      sessionRuntime: { resources: { tool_operations: 1, native_processes: 2, tests: 1 } },
    }) } };
  const runtime = initializeSessionRuntimeComposition(service);
  assert.equal(service.sessionRuntime, runtime);
  assert.equal(runtime.resourceBroker.snapshot().limits.sandbox_commands, 1);
  assert.equal(runtime.hasPendingOrAdmittedWork(), false);
  const first = await runtime.resourceBroker.acquire({ ownerId: 'tool_1',
    resources: [capacityResource('tool_operations')] });
  const waiting = runtime.resourceBroker.acquire({ ownerId: 'tool_2',
    resources: [capacityResource('tool_operations')] });
  assert.equal(runtime.resourceBroker.snapshot().waiter_count, 1);
  assert.equal(runtime.hasPendingOrAdmittedWork(), true);
  runtime.resourceBroker.release(first, { producerSettled: false });
  assert.equal(runtime.hasPendingOrAdmittedWork(), true);
  runtime.resourceBroker.confirmCleanup(first);
  const second = await waiting;
  assert.equal(runtime.hasPendingOrAdmittedWork(), true);
  runtime.resourceBroker.release(second, { producerSettled: true });
  assert.equal(runtime.hasPendingOrAdmittedWork(), false);
});

// Dogfood HB-034 F5: the composed runtime reports a reply that paused by
// itself behind another chat's lease on that reply's own (paused) stream.
test('composed runtime announces a tracked resource wait and names the chat in the way', async t => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-wait-notice-'));
  t.after(() => fs.rmSync(profile, { recursive: true, force: true }));
  const emitted = [];
  const service = { options: { userDataPath: profile }, featureFlags: { session_runtime: true },
    activeStreams: new Map(), emit: (channel, payload) => emitted.push([channel, payload]),
    sessionStore: { conversationStore: { resolvePendingContinuation() {} },
      getSession() {}, getActiveTurn() {} },
    sessionTurnActors: { blockCheckpointOrphan() {}, pauseRecoveredCheckpoint() {},
      settleCheckpointOrphan() {} },
    turnEventJournal: { list: () => [] },
    sessionExecutionAuthority: {}, configService: { getState: () => ({}) } };
  const runtime = initializeSessionRuntimeComposition(service);
  const folder = [filesystemResource(new PhysicalPathResolver().resolve(profile))];
  const held = runtime.resourceBroker.tryAcquire({ ownerId: 'tool-a', resources: folder, sessionId: 'sess_a' });
  assert.equal(held.status, 'granted');
  const work = { work_id: 'work_b', session_id: 'sess_b', turn_id: 'turn_b', status: 'paused', revision: 3,
    attempt: { stream_id: 'stream_b', incarnation: runtime.scheduler.incarnation } };
  const coordinator = runtime.eligibilityCoordinator;
  const tick = () => new Promise(resolve => setTimeout(resolve, 5));

  // A wait the coordinator refused (a user pause, capacity) is not announced.
  coordinator.track = () => ({ status: 'rejected', reason: 'runtime_wait_controlled' });
  runtime.scheduler.onSuspended({ work, waitResources: folder, admission: null });
  await tick();
  assert.deepEqual(emitted, []);

  coordinator.track = () => ({ status: 'tracked' });
  coordinator.isTracked = () => true;
  runtime.store.get = () => work;
  runtime.scheduler.onSuspended({ work, waitResources: folder, admission: null });
  await tick();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], 'chat-stream');
  assert.deepEqual({ type: emitted[0][1].type, streamId: emitted[0][1].streamId, sessionId: emitted[0][1].sessionId,
    workId: emitted[0][1].workId, waitState: emitted[0][1].waitState, blockingSessionId: emitted[0][1].blockingSessionId },
  { type: 'runtime_waiting', streamId: 'stream_b', sessionId: 'sess_b', workId: 'work_b',
    waitState: 'waiting', blockingSessionId: 'sess_a' });

  // The coordinator lost the wait (engine restart): the reply is paused, and says so once.
  coordinator.isTracked = () => false;
  runtime.resourceBroker.release(held.lease, { producerSettled: true });
  await tick();
  assert.deepEqual(emitted.map(([, payload]) => payload.waitState), ['waiting', 'ended']);
});
