'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { initializeSessionRuntimeComposition } = require('../../services/session-runtime/composition');
const { capacityResource } = require('../../services/session-runtime/resource-broker');

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
