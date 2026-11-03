'use strict';
// Row 100 integration seams, against a FAKE work-lease adapter: the broker's `work` resource type,
// ToolResourceOperations' admit/settle hand-off, the 'work' continuation class and the wait notice.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SessionExecutionAuthority,
  getTrustedExecutionBinding,
} = require('../../services/backend/session-execution-authority');
const { createRuntimeWaitNotices } = require('../../services/backend/runtime-wait-notices');
const { normalizeContinuation, encodeContinuation, decodeContinuation, ContinuationContractError } = require('../../services/session-runtime/continuation-contracts');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const { ResourceBroker, capacityResource } = require('../../services/session-runtime/resource-broker');
const { ToolResourceOperations } = require('../../services/session-runtime/resource-operations');

const WORK = Object.freeze({ type: 'work', leaseRoot: '/repo/.git/jenny/leases/v1',
  key: 'tests@tree:g:/repo', units: 'all', capacity: 1, label: 'npm test' });

function fakeAdapter({ blocked = false, hold = 'granted', handle = 'handle-1', resources = [WORK],
  holders = [{ session_id: 'sess_a', status: 'active', quarantined_at: null, app: 'jenny-desktop', label: 'npm test' }] } = {}) {
  const calls = [];
  const listeners = new Set();
  const state = { blocked, hold, handle, resources, holders };
  const adapter = {
    calls, listeners, state,
    resourcesFor(args) { calls.push(['resourcesFor', args]); return Object.freeze([...state.resources]); },
    wouldBlock(resources) { calls.push(['wouldBlock', resources]); return state.blocked; },
    hold(args) {
      calls.push(['hold', args]);
      return state.hold === 'granted' ? { status: 'granted', handle: state.handle } : { status: 'waiting' };
    },
    release(h) { calls.push(['release', h]); },
    transferToJob(h, context) { calls.push(['transferToJob', h, context]); },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    describeHolders(resources) { calls.push(['describeHolders', resources]); return state.holders; },
    emit() { for (const listener of [...listeners]) listener(); },
    named: (name) => calls.filter(([call]) => call === name),
  };
  return adapter;
}

const broker = (workLeases, extra = {}) => {
  let id = 0;
  return new ResourceBroker({ workLeases, createId: () => `lease-${++id}`, ...extra });
};

test('a broker rejects an adapter that lacks a required method', () => {
  const adapter = fakeAdapter();
  for (const name of ['resourcesFor', 'wouldBlock', 'hold', 'release', 'transferToJob', 'onChange', 'describeHolders']) {
    const broken = { ...adapter, [name]: undefined };
    assert.throws(() => new ResourceBroker({ workLeases: broken }), { name: 'TypeError', message: 'work_leases_adapter_invalid' });
  }
  assert.throws(() => new ResourceBroker({ workLeases: {} }), TypeError);
  assert.equal(new ResourceBroker({ workLeases: null }).workLeases, null);
});

test('tryAcquire holds work resources last and releasing the lease releases the handle', () => {
  const adapter = fakeAdapter();
  const b = broker(adapter);
  let validated = 0;
  const result = b.tryAcquire({ ownerId: 'owner-1', sessionId: 'sess_b', validate: () => { validated += 1; return true; },
    resources: [capacityResource('tool_operations'), WORK] });
  assert.equal(result.status, 'granted');
  assert.equal(validated, 1);
  const [hold] = adapter.named('hold');
  assert.equal(hold[1].sessionId, 'sess_b');
  assert.deepEqual(hold[1].resources.map((r) => r.type), ['work']);
  assert.equal(hold[1].resources[0].key, WORK.key);
  assert.ok(adapter.named('wouldBlock').length >= 1, 'asked before validate');
  assert.equal(adapter.named('release').length, 0);
  assert.equal(b.release(result.lease, { producerSettled: true }), true);
  assert.deepEqual(adapter.named('release').map((c) => c[1]), ['handle-1']);
  assert.equal(b.snapshot().lease_count, 0);
});

test('a waiting hold keeps no lease and reports the work class only when asked', () => {
  const adapter = fakeAdapter({ hold: 'waiting' });
  const b = broker(adapter);
  const resources = [capacityResource('tool_operations'), WORK];
  assert.deepEqual(b.tryAcquire({ ownerId: 'owner-1', resources, includeWaitingResource: true }), {
    status: 'waiting', reason: 'resource_capacity', resource_class: 'work', dependency_id: null,
  });
  assert.deepEqual(b.tryAcquire({ ownerId: 'owner-1', resources }), { status: 'waiting', reason: 'resource_capacity' });
  assert.equal(b.snapshot().lease_count, 0);
  assert.equal(adapter.named('release').length, 0);
});

test('a would-block answer parks the call before validation runs or a ticket is published', () => {
  const adapter = fakeAdapter({ blocked: true });
  const b = broker(adapter);
  let validated = 0;
  const result = b.tryAcquire({ ownerId: 'owner-1', includeWaitingResource: true, resources: [WORK],
    validate: () => { validated += 1; return true; } });
  assert.deepEqual(result, { status: 'waiting', reason: 'resource_capacity', resource_class: 'work', dependency_id: null });
  assert.equal(validated, 0);
  assert.equal(adapter.named('hold').length, 0);
  assert.equal(b.canAcquire([WORK]), false);
  adapter.state.blocked = false;
  assert.equal(b.canAcquire([WORK]), true);
});

test('an in-process capacity wait wins over work and never touches the adapter', () => {
  const adapter = fakeAdapter();
  const b = broker(adapter, { limits: { tool_operations: 1 } });
  assert.equal(b.tryAcquire({ ownerId: 'a', resources: [capacityResource('tool_operations')] }).status, 'granted');
  const result = b.tryAcquire({ ownerId: 'b', includeWaitingResource: true,
    resources: [capacityResource('tool_operations'), WORK] });
  assert.equal(result.resource_class, 'tool_operations');
  assert.equal(adapter.named('hold').length, 0);
});

test('a fail-open hold (granted without a handle) leases normally and releases nothing', () => {
  const adapter = fakeAdapter({ handle: null });
  const b = broker(adapter);
  const result = b.tryAcquire({ ownerId: 'owner-1', resources: [WORK] });
  assert.equal(result.status, 'granted');
  assert.equal(b.release(result.lease, { producerSettled: true }), true);
  assert.equal(adapter.named('release').length, 0);
  const bare = new ResourceBroker({});
  assert.equal(bare.tryAcquire({ ownerId: 'owner-1', resources: [WORK] }).status, 'granted', 'no adapter: work is ignored');
});

test('acquire rejects work resources: queued waiters cannot mint a cross-process hold', async () => {
  const adapter = fakeAdapter();
  const b = broker(adapter);
  await assert.rejects(b.acquire({ ownerId: 'owner-1', resources: [WORK] }), /Work resources require tryAcquire/u);
  assert.equal(b.snapshot().waiter_count, 0);
});

test('an invalid work resource is rejected by normalization', () => {
  const b = broker(fakeAdapter());
  for (const bad of [{ ...WORK, leaseRoot: '' }, { ...WORK, key: '' }, { ...WORK, units: 0 }, { ...WORK, units: 'some' },
    { ...WORK, capacity: 0 }]) {
    assert.throws(() => b.tryAcquire({ ownerId: 'o', resources: [bad] }), /Work resource is invalid/u);
  }
  assert.equal(b.tryAcquire({ ownerId: 'o', resources: [{ ...WORK, capacity: undefined, units: 2 }] }).status, 'granted');
});

test('detachWork hands the handle to the caller and a later release does not free it', () => {
  const adapter = fakeAdapter();
  const b = broker(adapter);
  const { lease } = b.tryAcquire({ ownerId: 'owner-1', resources: [capacityResource('tool_operations'), WORK] });
  assert.equal(b.detachWork(lease), 'handle-1');
  assert.equal(b.detachWork(lease), null);
  assert.equal(b.release(lease, { producerSettled: true }), true);
  assert.equal(adapter.named('release').length, 0);
  assert.equal(b.detachWork({ id: 'unknown' }), null);
});

test('describeWait names work holders through the adapter and conveys no authority', () => {
  const adapter = fakeAdapter({ blocked: true });
  const b = broker(adapter);
  const wait = b.describeWait([capacityResource('tool_operations'), WORK]);
  assert.equal(wait.resource_class, 'work');
  assert.deepEqual(wait.holders, adapter.state.holders);
  assert.ok(Object.isFrozen(wait.holders));
  const [call] = adapter.named('describeHolders');
  assert.deepEqual(call[1].map((r) => r.type), ['work']);
  adapter.state.blocked = false;
  assert.equal(b.describeWait([WORK]).resource_class, null);
});

test('adapter change notifications reach the broker availability observers', async () => {
  const adapter = fakeAdapter();
  const b = broker(adapter);
  let notified = 0;
  const stop = b.onAvailabilityChange(() => { notified += 1; });
  adapter.emit();
  await Promise.resolve();
  assert.equal(notified, 1);
  stop();
  adapter.emit();
  await Promise.resolve();
  assert.equal(notified, 1);
});

// ------------------------------------------------------------------ ToolResourceOperations

function createHarness(t, adapter, { limits } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-work-lease-ops-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let uuid = 0;
  let lease = 0;
  const authorityService = new SessionExecutionAuthority({
    projectAuthority: {
      captureSession: () => Object.freeze({ project_id: 'project_alpha', root_path: workspace,
        root_id: 'root-alpha', root_revision: 1, device_id: '7', inode: '11' }),
      requireCurrent: (authority) => authority,
    },
    permissionStore: { getSnapshot: () => ({ version: 3, legacy_policies: {
      read_file: 'auto', run_command: 'auto', verify: 'auto',
    }, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ tools_knowledge_enabled: false, knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    randomUUID: () => `authority-${++uuid}`,
  });
  const resourceBroker = new ResourceBroker({ limits, workLeases: adapter, createId: () => `resource-${++lease}` });
  const pathResolver = new PhysicalPathResolver();
  function createGateway(requestId = `request-${uuid + 1}`, options = {}) {
    const binding = authorityService.captureSession('session-alpha', { requestId });
    const gateway = new ToolResourceOperations({ broker: resourceBroker, pathResolver,
      executionAuthority: authorityService, binding, ...options });
    return { binding, gateway, trusted: getTrustedExecutionBinding(binding) };
  }
  return { broker: resourceBroker, createGateway, workspace };
}

const admit = (trusted, overrides = {}) => ({
  api_version: '2026-10-15', schema_version: 1, kind: 'tool', phase: 'admit',
  request_id: trusted.requestId, session_id: trusted.sessionId,
  authority_revision: trusted.authorityRevision, operation_id: 'operation-1',
  tool_name: 'run_command', arguments: { command: 'npm test' }, ...overrides,
});
const settle = (trusted, overrides = {}) => ({
  api_version: '2026-10-15', schema_version: 1, kind: 'tool', phase: 'settle',
  request_id: trusted.requestId, session_id: trusted.sessionId,
  authority_revision: trusted.authorityRevision, operation_id: 'operation-1',
  status: 'succeeded', cleanup: 'confirmed', ...overrides,
});

test('run_command admission appends the work resources and holds them for the call', (t) => {
  const adapter = fakeAdapter();
  const h = createHarness(t, adapter);
  const { gateway, trusted } = h.createGateway();
  assert.equal(gateway.handle(admit(trusted)).status, 'granted');
  const [asked] = adapter.named('resourcesFor');
  assert.deepEqual(asked[1].argumentsValue, { command: 'npm test' });
  assert.equal(fs.realpathSync.native(asked[1].workspacePath), fs.realpathSync.native(h.workspace));
  const held = gateway.getHeldOperationLease('operation-1');
  assert.ok(held.resources.some((r) => r.type === 'work' && r.key === WORK.key));
  assert.ok(held.resources.some((r) => r.type === 'capacity' && r.key === 'native_processes'));
  const [hold] = adapter.named('hold');
  assert.equal(hold[1].sessionId, 'session-alpha');
  assert.equal(gateway.handle(settle(trusted)).status, 'settled');
  assert.deepEqual(adapter.named('release').map((c) => c[1]), ['handle-1']);
  assert.equal(adapter.named('transferToJob').length, 0, 'a foreground command keeps nothing');
});

test('other tools never ask the adapter and an empty classification adds no resources', (t) => {
  const adapter = fakeAdapter();
  const h = createHarness(t, adapter);
  const { gateway, trusted } = h.createGateway();
  assert.equal(gateway.handle(admit(trusted, { tool_name: 'read_file', arguments: { path: 'README.md' } })).status, 'granted');
  assert.equal(adapter.named('resourcesFor').length, 0);
  gateway.handle(settle(trusted));
  adapter.state.resources = [];
  assert.equal(gateway.handle(admit(trusted, { operation_id: 'operation-2', arguments: { command: 'ls', run_in_background: true } })).status, 'granted');
  assert.equal(adapter.named('hold').length, 0);
  assert.equal(gateway.handle(settle(trusted, { operation_id: 'operation-2' })).status, 'settled');
  assert.equal(adapter.named('transferToJob').length, 0);
});

test('a succeeded background command transfers its work handle to the job instead of releasing it', (t) => {
  const adapter = fakeAdapter();
  const h = createHarness(t, adapter);
  const { gateway, trusted } = h.createGateway();
  const args = { command: 'npm test', run_in_background: true };
  assert.equal(gateway.handle(admit(trusted, { arguments: args })).status, 'granted');
  assert.equal(gateway.handle(settle(trusted)).status, 'settled');
  assert.deepEqual(adapter.named('transferToJob').map((c) => [c[1], c[2]]),
    [['handle-1', { sessionId: 'session-alpha', toolCallId: 'operation-1' }]]);
  assert.equal(adapter.named('release').length, 0);
  assert.equal(h.broker.snapshot().lease_count, 0, 'the workspace lease is still released');
  assert.equal(gateway.handle(settle(trusted)).status, 'settled', 'a repeated settle does not transfer twice');
  assert.equal(adapter.named('transferToJob').length, 1);
});

test('a failed or unconfirmed background command releases its work handle', (t) => {
  const adapter = fakeAdapter();
  const h = createHarness(t, adapter);
  const { gateway, trusted } = h.createGateway();
  const args = { command: 'npm test', run_in_background: true };
  gateway.handle(admit(trusted, { operation_id: 'operation-failed', arguments: args }));
  gateway.handle(settle(trusted, { operation_id: 'operation-failed', status: 'failed' }));
  assert.equal(adapter.named('transferToJob').length, 0);
  assert.deepEqual(adapter.named('release').map((c) => c[1]), ['handle-1']);

  gateway.handle(admit(trusted, { operation_id: 'operation-uncertain', arguments: args }));
  gateway.handle(settle(trusted, { operation_id: 'operation-uncertain', cleanup: 'uncertain' }));
  assert.equal(adapter.named('transferToJob').length, 0);
  assert.equal(adapter.named('release').length, 1, 'a quarantined lease keeps its handle');
  gateway.handle(settle(trusted, { operation_id: 'operation-uncertain' }));
  assert.equal(adapter.named('transferToJob').length, 1, 'confirmed cleanup later hands the job its tickets');
});

test('a blocked work resource parks the call as a work wait on a continuation gateway', (t) => {
  const adapter = fakeAdapter({ blocked: true });
  const h = createHarness(t, adapter);
  const parked = h.createGateway('request-parked', { continuationEnabled: true });
  assert.deepEqual(parked.gateway.handle(admit(parked.trusted)), {
    schema_version: 1, operation_id: 'operation-1', status: 'waiting', reason: 'resource_capacity',
    resource_class: 'work', dependency_id: null,
  });
  assert.deepEqual(parked.gateway.getResourceWait('operation-1'), { resource_class: 'work', dependency_id: null });
  assert.ok(parked.gateway.getWaitResources('operation-1').some((r) => r.type === 'work'));
  assert.equal(adapter.named('hold').length, 0);
  assert.equal(h.broker.snapshot().lease_count, 0);

  const legacy = h.createGateway('request-legacy');
  assert.deepEqual(legacy.gateway.handle(admit(legacy.trusted)), {
    schema_version: 1, operation_id: 'operation-1', status: 'waiting', reason: 'resource_capacity',
  });
  parked.gateway.close({ producerSettled: true });
  legacy.gateway.close({ producerSettled: true });
});

// ------------------------------------------------------------------ continuation contract

function continuationFixture(resourceClass) {
  const ref = (refId, revision = 3) => ({ ref_id: refId, revision, sha256: 'a'.repeat(64) });
  return {
    schema_version: 1,
    kind: 'before_tool_dispatch',
    identity: { checkpoint_id: 'checkpoint_1', work_id: 'work_1', turn_id: 'turn_1', request_id: 'stream_1',
      trace_id: null, session_id: 'session_1' },
    source_attempt: { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
      authority_revision: 'authority_1' },
    authority: { project_id: 'project_1', root_id: 'root_1', root_revision: 4, sha256: 'b'.repeat(64) },
    route: { route_id: 'route_1', route_revision: 'config:4', sha256: 'c'.repeat(64) },
    canonical_refs: {
      request_ref: ref('request_ref_1'), history_ref: ref('history_ref_1'), message_ref: ref('message_ref_1'),
      turn_ref: { ...ref('turn_ref_1', 8), stream_id: 'stream_1', through_seq: 12 },
      tool_batch_ref: ref('tool_batch_ref_1'),
    },
    position: { completed_iterations: 1, remaining_iterations: 7, current_iteration: 1, tool_call_limit: 20,
      tool_calls_consumed: 2, active_budget_ms_remaining: 123_456, ordered_call_ids: ['call_1', 'call_2'] },
    pending_call: { call_id: 'call_1', tool_id: 'builtin:run/tool', effective_args_sha256: 'd'.repeat(64),
      frozen_input_ref: ref('frozen_input_ref_1') },
    wait: { kind: 'resource', resource_class: resourceClass, dependency_id: null, operation_id: 'call_1' },
    eligibility: { pending_call_index: 0, prior_outcome_count: 0, emitted_tool_execution_count: 0,
      preview_count: 0, approval_pending: false, mutation_started: false },
  };
}

test('continuation checkpoints accept the work resource class and still reject unknown ones', () => {
  const value = continuationFixture('work');
  assert.equal(normalizeContinuation(value).wait.resource_class, 'work');
  const encoded = encodeContinuation(value);
  assert.deepEqual(decodeContinuation(encoded.body), value);
  assert.throws(() => normalizeContinuation(continuationFixture('workz')), ContinuationContractError);
});

// ------------------------------------------------------------------ wait notice

test('a wait on a work lease names the first other chat that holds it', () => {
  const adapter = fakeAdapter({ blocked: true });
  const state = { now: 1_000_000, work: { work_id: 'work_b', session_id: 'sess_b', turn_id: 'turn_b', status: 'paused',
    revision: 7, attempt: { stream_id: 'stream_b', incarnation: 'inc_work' } } };
  const emitted = [];
  const timers = [];
  const notices = createRuntimeWaitNotices({
    emit: (payload) => emitted.push(payload), broker: broker(adapter), isTracked: () => true,
    getWork: () => state.work, incarnation: 'inc_work', now: () => state.now,
    setTimer: (callback, delayMs) => { const timer = { callback, delayMs }; timers.push(timer); return timer; },
    clearTimer: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  });
  const run = (ms = 0) => {
    state.now += ms;
    for (const timer of timers.filter((entry) => entry.delayMs <= ms)) {
      timers.splice(timers.indexOf(timer), 1);
      timer.callback();
    }
  };
  assert.equal(notices.note(state.work, [WORK]), true);
  run();
  assert.deepEqual(emitted.map((e) => [e.waitState, e.resourceClass, e.blockingSessionId]), [['waiting', 'work', 'sess_a']]);

  // Row 100 P2 (owner pick "and 1 more"): two chats name the first and count both; an outside holder
  // with no session, or only this chat itself, name no one. Each case starts from a named blocker so a
  // new, corrected notice must be emitted.
  const holder = (session) => ({ session_id: session, status: 'active', quarantined_at: null, app: 'jenny-desktop', label: 'x' });
  for (const [holders, named, count] of [[[holder('sess_a'), holder('sess_c')], 'sess_a', 2], [[holder(null)], '', 1],
    [[holder('sess_b')], '', undefined]]) {
    adapter.state.holders = [holder('sess_a')];
    notices.refresh();
    run();
    assert.equal(emitted.at(-1).blockingSessionId, 'sess_a');
    const before = emitted.length;
    adapter.state.holders = holders;
    notices.refresh();
    run();
    assert.equal(emitted.length, before + 1);
    assert.deepEqual([emitted.at(-1).resourceClass, emitted.at(-1).blockingSessionId, emitted.at(-1).waitState,
      emitted.at(-1).holderCount], ['work', named, 'waiting', count]);
  }
  notices.dispose();
});
