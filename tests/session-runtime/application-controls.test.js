'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers/session-runtime-children-fixture');
const { waitFor } = require('../helpers/session-runtime-chat-adapter-harness');
const { ShellConfigService } = require('../../services/shell-config-service');
const { capacityResource } = require('../../services/session-runtime/resource-broker');
const { registerSessionRuntimeIpcHandlers } = require('../../services/main/session-runtime-ipc-registration');
const { createJennyShellBridge } = require('../../services/ipc-contract');

test('cancel reports requested until physical subtree cleanup and returns canonical result links', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  const work = h.runtime.store.get(h.started.work_id);
  const detail = h.app.getWork({ work_id: work.work_id });
  assert.equal(detail.coordination.child_count, 1);
  assert.equal(detail.coordination.root_run_id, h.started.root_run_id);
  assert.equal(detail.coordination.children[0].work_id, child.child_work_id);
  assert.equal(detail.coordination.cleanup_confirmed, false);
  assert.equal(JSON.stringify(detail).includes('authority_fingerprint'), false);
  assert.equal(h.app.cancel({ work_id: work.work_id, expected_revision: work.revision + 1 }).error.reason, 'revision_conflict');
  const cancelled = h.app.cancel({ work_id: work.work_id, expected_revision: work.revision });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.cleanup_confirmed, false);
  assert.equal(cancelled.status, 'requested');
  await waitFor(() => h.runtime.store.get(work.work_id).status === 'cancelled', 'root cleanup');
  assert.equal(h.runtime.store.get(child.child_work_id).status, 'cancelled');
  assert.equal(h.app.getWork({ work_id: work.work_id }).coordination.cleanup_confirmed, true);
  assert.deepEqual(h.app.getResult({ work_id: work.work_id }), { ok: true, work_id: work.work_id,
    session_id: work.session_id, turn_id: work.turn_id, status: 'cancelled', available: true });
});

test('persisted limits use stale-value CAS and retain all active/quarantined leases', async t => {
  const h = await fixture(t);
  h.service.configService = new ShellConfigService({ userDataPath: h.service.options.userDataPath, env: {} });
  const initial = h.runtime.lanes.snapshot().configured;
  const changed = h.app.updateLimits({ expected_limits: initial, patch: { local: { runnable_turns: 2 } } });
  assert.equal(changed.ok, true, JSON.stringify(changed));
  assert.equal(h.app.updateLimits({ expected_limits: initial, patch: { local: { runnable_turns: 3 } } }).error.reason, 'runtime_limits_stale');
  const route = h.starts[0].request.runtimeRoute;
  const extra = h.runtime.lanes.tryAcquireTurn({ sessionId: 'another_session', route });
  assert.equal(extra.status, 'granted');
  const resources = [capacityResource('tool_operations')];
  const leases = ['resource_a', 'resource_b'].map(ownerId => h.runtime.resourceBroker.tryAcquire({ ownerId, resources }).lease);
  h.runtime.resourceBroker.release(leases[0]);
  const heldLanes = h.runtime.lanes.snapshot();
  const lowered = h.app.updateLimits({ expected_limits: heldLanes.configured,
    patch: { local: { runnable_turns: 1 }, resources: { tool_operations: 1 } } });
  assert.equal(lowered.ok, true, JSON.stringify(lowered));
  assert.equal(h.runtime.lanes.snapshot().active_leases, heldLanes.active_leases);
  assert.deepEqual(h.runtime.lanes.snapshot().lanes, heldLanes.lanes);
  assert.equal(h.runtime.resourceBroker.snapshot().lease_count, 2);
  assert.equal(h.runtime.resourceBroker.snapshot().quarantined_count, 1);
  assert.equal(h.runtime.lanes.tryAcquireTurn({ sessionId: 'third_session', route }).status, 'waiting');
  assert.equal(h.runtime.resourceBroker.tryAcquire({ ownerId: 'resource_c', resources }).status, 'waiting');
  assert.deepEqual(new ShellConfigService({ userDataPath: h.service.options.userDataPath, env: {} })
    .getState().sessionRuntime, lowered.configured_limits);
  const save = h.service.configService.updateSessionRuntime;
  h.service.configService.updateSessionRuntime = () => { throw new Error('disk fault'); };
  assert.equal(h.app.updateLimits({ expected_limits: lowered.configured_limits,
    patch: { resources: { tool_operations: 4 } } }).ok, false);
  assert.equal(h.runtime.resourceBroker.snapshot().limits.tool_operations, 1);
  h.service.configService.updateSessionRuntime = save;
  assert.equal(h.app.updateLimits({ expected_limits: lowered.configured_limits,
    patch: { resources: { sandbox_commands: 2 } } }).ok, false);
  h.runtime.resourceBroker.confirmCleanup(leases[0]);
  h.runtime.resourceBroker.confirmCleanup(leases[1]);
  h.runtime.lanes.release(extra.lease, { producerSettled: true });
});

test('new closed application controls cross only the trusted desktop bridge', async () => {
  const handlers = new Map();
  const calls = [];
  const names = ['cancel', 'updatePending', 'updateLimits', 'getResult'];
  const app = Object.fromEntries(names.map(name => [name, payload => { calls.push([name, payload]); return { ok: true }; }]));
  registerSessionRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    applicationService: {}, runtimeApplicationService: app,
    authorization: { authorize: event => event.trusted, unauthorizedResult: () => ({ ok: false }) } });
  let trusted = false;
  const bridge = createJennyShellBridge({ ipcRenderer: { send() {}, invoke: (channel, payload) => handlers.get(channel)({ trusted }, payload) } });
  for (const name of names) assert.equal((await bridge.sessionRuntime[name]({ test: name })).ok, false);
  assert.equal(calls.length, 0);
  trusted = true;
  for (const name of names) assert.equal((await bridge.sessionRuntime[name]({ test: name })).ok, true);
  assert.equal(calls.length, 4);
});


test('direct-child pages are bounded and later pages require the captured lineage revision', () => {
  const { projectWorkCoordination } = require('../../services/session-runtime/work-details');
  const work = { work_id: 'root_work', status: 'running', input: { root_run: { root_run_id: 'root_run' } } };
  const children = Array.from({ length: 51 }, (_, i) => ({ parent_work_id: 'root_work', work_id: `child_${i}`,
    session_id: `session_${i}`, turn_id: `turn_${i}`, depth: 1, authority_fingerprint: 'secret' }));
  children.push({ parent_work_id: 'child_0', work_id: 'grandchild' });
  let reads = 0;
  const runtime = { scheduler: {}, store: { get() { reads += 1; return { purpose: 'Inspect', status: 'pending' }; } },
    budgetStore: { inspect: () => ({ limits: {}, charged: {} }) },
    lineageStore: { rootIds: new Set(['root_run']), get: () => ({ revision: 7, children }) } };
  const first = projectWorkCoordination(runtime, work);
  assert.equal(first.children.length, 50); assert.equal(first.child_count, 51);
  assert.equal(first.next_child_offset, 50); assert.ok(reads <= 100);
  assert.equal(JSON.stringify(first).includes('secret'), false);
  assert.equal(projectWorkCoordination(runtime, work, { childOffset: 50 }).available, false);
  const last = projectWorkCoordination(runtime, work, { childOffset: 50, lineageRevision: 7 });
  assert.equal(last.children.length, 1); assert.equal(last.children[0].work_id, 'child_50');
  assert.equal(last.next_child_offset, null);
  assert.equal(projectWorkCoordination(runtime, work, { childOffset: 50, lineageRevision: 6 }).available, false);
});
