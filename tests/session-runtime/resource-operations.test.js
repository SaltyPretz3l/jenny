'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  SessionExecutionAuthority,
  getTrustedExecutionBinding,
} = require('../../services/backend/session-execution-authority');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const {
  ResourceBroker,
  capacityResource,
  filesystemResource,
} = require('../../services/session-runtime/resource-broker');
const {
  ToolResourceOperations,
  getHeldToolResourceLease,
  getToolResourceOperations,
} = require('../../services/session-runtime/resource-operations');

const DYNAMIC_TOOL = 'plugin:acme-labs:widgets:compute';
const DYNAMIC_AUTHORITY = Object.freeze({ mode: 'plugin', registry_revision: 1,
  dependency_graph_hash: 'a'.repeat(64), commit_epoch: 1,
  active_generation_id: 'generation-1' });
const DYNAMIC_CAPTURE = Object.freeze({ authority: DYNAMIC_AUTHORITY,
  descriptor_digest: 'b'.repeat(64), descriptors: Object.freeze([Object.freeze({
    name: DYNAMIC_TOOL, side_effecting: true, read_only: false,
    tool_family: 'other', source_kind: 'restricted', server_name: 'electron_tool_bridge',
    plan_mode_only: false, workspace_required: false,
    capability_identity: Object.freeze({ component_digest: 'c'.repeat(64) }),
  })]) });

function createHarness(t, { limits, sandboxCommands = false, onSettled = null } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-resource-operations-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  let revision = 1;
  let decision = 'auto';
  let uuid = 0;
  let lease = 0;
  let policyChecks = 0;
  const currentAuthority = () => Object.freeze({ project_id: 'project_alpha', root_path: workspace,
    root_id: 'root-alpha', root_revision: revision, device_id: '7', inode: '11' });
  const authorityService = new SessionExecutionAuthority({
    projectAuthority: {
      captureSession: () => currentAuthority(),
      requireCurrent: authority => {
        if (authority.root_revision !== revision) throw new Error('Project authority is stale.');
        return authority;
      },
    },
    permissionStore: { getSnapshot: () => {
      policyChecks += 1;
      return { version: 3, legacy_policies: {
        read_file: decision, write_file: decision, verify: decision,
        run_command: decision, run_temp_script: decision, workspace_manifest_read: decision,
        git_diff: decision, worktree_create: decision, monitor: decision,
        check_background_job: decision, stop_background_job: decision,
        check_monitor: decision, jenny_status: decision,
        [DYNAMIC_TOOL]: decision,
      }, rules: [] };
    } },
    knowledgeService: { getSidecarConfig: () => ({ tools_knowledge_enabled: false,
      knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
    resolvePluginToolAuthority: () => DYNAMIC_CAPTURE,
    randomUUID: () => `authority-${++uuid}`,
  });
  const broker = new ResourceBroker({ limits, createId: () => `resource-${++lease}` });
  const pathResolver = new PhysicalPathResolver();
  function createGateway(requestId = `request-${uuid + 1}`, options = {}) {
    const binding = authorityService.captureSession('session-alpha', { requestId });
    const gateway = new ToolResourceOperations({ broker, pathResolver, executionAuthority: authorityService,
      binding, sandboxCommands, onSettled, ...options });
    return { binding, gateway, trusted: getTrustedExecutionBinding(binding) };
  }
  return { authorityService, broker, createGateway, pathResolver, workspace,
    policyChecks: () => policyChecks,
    revoke() { revision += 1; },
    setDecision(value) { decision = value; } };
}

function admit(trusted, overrides = {}) {
  return {
    api_version: '2026-08-17', schema_version: 1, kind: 'tool', phase: 'admit',
    request_id: trusted.requestId, session_id: trusted.sessionId,
    authority_revision: trusted.authorityRevision, operation_id: 'operation-1',
    tool_name: 'read_file', arguments: { path: 'README.md' }, ...overrides,
  };
}

function settle(trusted, overrides = {}) {
  return {
    api_version: '2026-08-17', schema_version: 1, kind: 'tool', phase: 'settle',
    request_id: trusted.requestId, session_id: trusted.sessionId,
    authority_revision: trusted.authorityRevision, operation_id: 'operation-1',
    status: 'succeeded', cleanup: 'confirmed', ...overrides,
  };
}

function capacityKeys(view) {
  return view.resources.filter(resource => resource.type === 'capacity').map(resource => resource.key);
}

test('continuations can be enabled only before tool admission and under current authority', t => {
  const h = createHarness(t);
  const first = h.createGateway();
  assert.equal(first.gateway.continuationEnabled, false);
  assert.equal(first.gateway.enableContinuation(), true);
  first.gateway.handle(admit(first.trusted));
  assert.throws(() => first.gateway.enableContinuation(), /already_started/u);
  first.gateway.close({ producerSettled: true });
  const second = h.createGateway();
  h.revoke();
  assert.throws(() => second.gateway.enableContinuation(), /authority changed/u);
  assert.equal(second.gateway.continuationEnabled, false);
  second.gateway.close({ producerSettled: true });
});

test('gateway derives closed resource sets from trusted manifest and sandbox classification', t => {
  const harness = createHarness(t, { sandboxCommands: true });
  const { binding, gateway, trusted } = harness.createGateway();
  assert.equal(getToolResourceOperations(binding), gateway);
  assert.equal(getToolResourceOperations({}), null);

  assert.deepEqual(gateway.handle(admit(trusted)), {
    schema_version: 1, operation_id: 'operation-1', status: 'granted',
  });
  const filesystem = getHeldToolResourceLease(binding, 'operation-1');
  assert.deepEqual(capacityKeys(filesystem), ['tool_operations']);
  assert.equal(filesystem.resources.at(-1).type, 'filesystem');
  assert.equal(Object.hasOwn(filesystem, 'authority_revision'), false);
  gateway.handle(settle(trusted));

  assert.equal(gateway.handle(admit(trusted, {
    operation_id: 'operation-write', tool_name: 'write_file',
    arguments: { path: 'nested/new.txt', content: 'hello' },
  })).status, 'granted');
  const write = gateway.getHeldOperationLease('operation-write');
  assert.deepEqual(capacityKeys(write), ['tool_operations']);
  assert.equal(write.resources.at(-1).identity.comparison_path,
    filesystem.resources.at(-1).identity.comparison_path);
  gateway.handle(settle(trusted, { operation_id: 'operation-write' }));

  assert.equal(gateway.handle(admit(trusted, {
    operation_id: 'operation-verify', tool_name: 'verify', arguments: { action: 'run' },
  })).status, 'granted');
  assert.deepEqual(capacityKeys(gateway.getHeldOperationLease('operation-verify')),
    ['tool_operations', 'native_processes', 'tests']);
  gateway.handle(settle(trusted, { operation_id: 'operation-verify' }));

  assert.equal(gateway.handle(admit(trusted, {
    operation_id: 'operation-command', tool_name: 'run_command', arguments: { command: 'status' },
  })).status, 'granted');
  assert.deepEqual(capacityKeys(gateway.getHeldOperationLease('operation-command')),
    ['tool_operations', 'native_processes', 'sandbox_commands']);
  gateway.handle(settle(trusted, { operation_id: 'operation-command' }));

  for (const [operationId, toolName] of [
    ['operation-script', 'run_temp_script'],
    ['operation-monitor', 'monitor'],
    ['operation-git', 'git_diff'],
    ['operation-worktree', 'worktree_create'],
    ['operation-manifest', 'workspace_manifest_read'],
  ]) {
    assert.equal(gateway.handle(admit(trusted, {
      operation_id: operationId, tool_name: toolName, arguments: {},
    })).status, 'granted');
    assert.deepEqual(capacityKeys(gateway.getHeldOperationLease(operationId)),
      ['tool_operations', 'native_processes']);
    gateway.handle(settle(trusted, { operation_id: operationId }));
  }
  assert.equal(harness.policyChecks(), 19);
});

test('native command classification does not claim the sandbox slot without trusted sandbox mode', t => {
  const harness = createHarness(t);
  const { gateway, trusted } = harness.createGateway();
  assert.equal(gateway.handle(admit(trusted, {
    tool_name: 'run_command', arguments: { command: 'status' },
  })).status, 'granted');
  assert.deepEqual(capacityKeys(gateway.getHeldOperationLease('operation-1')),
    ['tool_operations', 'native_processes']);
});

test('a trusted dynamic tool claims per-call tool capacity without native process capacity', t => {
  const harness = createHarness(t, { limits: { tool_operations: 1, native_processes: 1 } });
  const { binding, gateway, trusted } = harness.createGateway('request-dynamic');
  harness.authorityService.bindPluginTools(binding, DYNAMIC_AUTHORITY);

  assert.equal(gateway.handle(admit(trusted, {
    tool_name: DYNAMIC_TOOL,
    arguments: { value: 21 },
  })).status, 'granted');
  assert.deepEqual(capacityKeys(gateway.getHeldOperationLease('operation-1')),
    ['tool_operations']);
  assert.equal(harness.broker.snapshot().capacity.native_processes, 0);
});

test('continuation waits expose only broker-owned blocking metadata after application opt-in', t => {
  const harness = createHarness(t, { limits: { native_processes: 1 } });
  const held = harness.broker.tryAcquire({ ownerId: 'holder', resources: [capacityResource('native_processes')] });
  const current = harness.createGateway('request-continuation', { continuationEnabled: true });
  const result = current.gateway.handle(admit(current.trusted, {
    tool_name: 'run_temp_script', arguments: { script: 'echo ok' },
  }));
  assert.deepEqual(result, { schema_version: 1, operation_id: 'operation-1', status: 'waiting',
    reason: 'resource_capacity', resource_class: 'native_processes', dependency_id: null });
  assert.deepEqual(current.gateway.getResourceWait('operation-1'), {
    resource_class: 'native_processes', dependency_id: null,
  });
  assert.equal(harness.broker.snapshot().capacity.tool_operations, 0);
  assert.equal(harness.broker.snapshot().waiter_count, 0);
  assert.equal(current.gateway.getResourceWait('unknown'), null);
  const legacy = harness.createGateway('request-legacy');
  assert.deepEqual(legacy.gateway.handle(admit(legacy.trusted, {
    tool_name: 'run_temp_script', arguments: { script: 'echo ok' },
  })), { schema_version: 1, operation_id: 'operation-1', status: 'waiting', reason: 'resource_capacity' });
  assert.equal(legacy.gateway.getResourceWait('operation-1'), null);
  assert.equal(legacy.gateway.handle(admit(legacy.trusted, {
    operation_id: 'spoof', continuationEnabled: true,
  })).status, 'rejected');
  current.gateway.close({ producerSettled: true });
  assert.equal(current.gateway.getResourceWait('operation-1'), null);
  harness.broker.release(held.lease, { producerSettled: true });
});

test('trusted process-backed builtins contend on native capacity and the captured workspace root', t => {
  const nativeHarness = createHarness(t, { limits: { native_processes: 1 } });
  const native = nativeHarness.createGateway('request-native');
  const nativeBlocker = nativeHarness.broker.tryAcquire({ ownerId: 'native-blocker',
    resources: [capacityResource('native_processes')] });
  assert.equal(nativeBlocker.status, 'granted');
  assert.deepEqual(native.gateway.handle(admit(native.trusted, {
    tool_name: 'run_temp_script', arguments: { script: 'echo ok' },
  })), {
    schema_version: 1, operation_id: 'operation-1', status: 'waiting',
    reason: 'resource_capacity',
  });
  nativeHarness.broker.release(nativeBlocker.lease, { producerSettled: true });

  const rootHarness = createHarness(t);
  const root = rootHarness.createGateway('request-root');
  const rootBlocker = rootHarness.broker.tryAcquire({ ownerId: 'root-blocker', resources: [
    filesystemResource(rootHarness.pathResolver.resolve(rootHarness.workspace)),
  ] });
  assert.equal(rootBlocker.status, 'granted');
  assert.equal(root.gateway.handle(admit(root.trusted, {
    tool_name: 'workspace_manifest_read', arguments: {},
  })).status, 'waiting');
  rootHarness.broker.release(rootBlocker.lease, { producerSettled: true });

  const disjointHarness = createHarness(t, { limits: { native_processes: 2 } });
  const disjoint = disjointHarness.createGateway('request-disjoint');
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-resource-other-'));
  t.after(() => fs.rmSync(otherRoot, { recursive: true, force: true }));
  const disjointBlocker = disjointHarness.broker.tryAcquire({ ownerId: 'disjoint-root', resources: [
    filesystemResource(disjointHarness.pathResolver.resolve(otherRoot)),
  ] });
  assert.equal(disjointBlocker.status, 'granted');
  assert.equal(disjoint.gateway.handle(admit(disjoint.trusted, {
    tool_name: 'git_diff', arguments: {},
  })).status, 'granted');
  assert.equal(disjointHarness.broker.snapshot().capacity.native_processes, 1);
});

test('background inspection and cancellation controls remain admitted while the producer holds every slot', t => {
  const harness = createHarness(t, { sandboxCommands: true,
    limits: { tool_operations: 1, native_processes: 1, sandbox_commands: 1 } });
  const { binding, gateway, trusted } = harness.createGateway('request-background');
  assert.equal(gateway.handle(admit(trusted, {
    operation_id: 'operation-producer', tool_name: 'run_command',
    arguments: { command: 'long-running', run_in_background: true },
  })).status, 'granted');
  const producer = getHeldToolResourceLease(binding, 'operation-producer');
  assert.deepEqual(capacityKeys(producer),
    ['tool_operations', 'native_processes', 'sandbox_commands']);
  assert.equal(harness.broker.snapshot().lease_count, 1);

  for (const [operationId, toolName] of [
    ['operation-check-job', 'check_background_job'],
    ['operation-stop-job', 'stop_background_job'],
    ['operation-check-monitor', 'check_monitor'],
  ]) {
    assert.equal(gateway.handle(admit(trusted, {
      operation_id: operationId, tool_name: toolName, arguments: {},
    })).status, 'granted');
    assert.equal(gateway.getHeldOperationLease(operationId), null);
    assert.equal(harness.broker.snapshot().lease_count, 1);
    assert.equal(gateway.handle(settle(trusted, { operation_id: operationId })).status, 'settled');
    assert.equal(harness.broker.snapshot().lease_count, 1);
  }

  assert.deepEqual(getHeldToolResourceLease(binding, 'operation-producer'), producer);
  gateway.handle(settle(trusted, { operation_id: 'operation-producer' }));
  assert.equal(harness.broker.snapshot().lease_count, 0);
});

test('capacity waiting retains no broker waiter or partial lease and operation ids cannot retry', t => {
  const harness = createHarness(t, { limits: { tool_operations: 1 } });
  const first = harness.createGateway('request-first');
  const second = harness.createGateway('request-second');
  assert.equal(first.gateway.handle(admit(first.trusted)).status, 'granted');
  assert.deepEqual(second.gateway.handle(admit(second.trusted)), {
    schema_version: 1, operation_id: 'operation-1', status: 'waiting', reason: 'resource_capacity',
  });
  assert.equal(harness.broker.snapshot().waiter_count, 0);
  assert.equal(harness.broker.snapshot().lease_count, 1);
  assert.equal(second.gateway.handle(admit(second.trusted)).reason,
    'tool_resource_operation_duplicate');
  first.gateway.handle(settle(first.trusted));
  assert.equal(second.gateway.handle(admit(second.trusted, { operation_id: 'operation-2' })).status,
    'granted');
});

test('gateway rejects spoofed fields and rechecks live policy after resource resolution', t => {
  const harness = createHarness(t);
  const binding = harness.authorityService.captureSession('session-alpha', { requestId: 'request-stale' });
  const trusted = getTrustedExecutionBinding(binding);
  const pathResolver = { resolve(value) {
    const identity = harness.pathResolver.resolve(value);
    harness.revoke();
    return identity;
  } };
  const gateway = new ToolResourceOperations({ broker: harness.broker, pathResolver,
    executionAuthority: harness.authorityService, binding });

  assert.equal(gateway.handle(admit(trusted, { route: 'forged' })).reason,
    'tool_resource_operation_invalid');
  assert.equal(gateway.handle(admit(trusted, {
    operation_id: 'cross-request', request_id: 'request-other',
  })).reason, 'tool_resource_authority_mismatch');
  const stale = gateway.handle(admit(trusted));
  assert.equal(stale.status, 'rejected');
  assert.equal(stale.reason, 'project_authority_stale');
  assert.equal(harness.broker.snapshot().lease_count, 0);
  assert.equal(gateway.handle(admit(trusted)).reason, 'tool_resource_operation_duplicate');
});

test('a close during final policy validation cannot publish a granted resource', t => {
  const harness = createHarness(t);
  const binding = harness.authorityService.captureSession('session-alpha', { requestId: 'request-close' });
  const trusted = getTrustedExecutionBinding(binding);
  let checks = 0;
  let gateway;
  const authority = {
    checkRuntimeOperation(bound, params) {
      const result = harness.authorityService.checkRuntimeOperation(bound, params);
      checks += 1;
      if (checks === 2) gateway.close({ producerSettled: false });
      return result;
    },
    requireCurrent: bound => harness.authorityService.requireCurrent(bound),
  };
  gateway = new ToolResourceOperations({ broker: harness.broker, pathResolver: harness.pathResolver,
    executionAuthority: authority, binding });

  const result = gateway.handle(admit(trusted));
  assert.deepEqual(result, { schema_version: 1, operation_id: 'operation-1',
    status: 'rejected', reason: 'tool_resource_request_closed' });
  assert.equal(harness.broker.snapshot().lease_count, 0);
  assert.equal(gateway.getHeldOperationLease('operation-1'), null);
});

test('exact settlement survives binding cancellation and releases once after physical proof', t => {
  const notifications = [];
  const harness = createHarness(t, { onSettled: event => notifications.push(event) });
  const { binding, gateway, trusted } = harness.createGateway();
  assert.equal(gateway.handle(admit(trusted)).status, 'granted');
  gateway.close({ producerSettled: false });
  harness.authorityService.close(binding);
  assert.equal(harness.broker.snapshot().quarantined_count, 1);
  assert.equal(getToolResourceOperations(binding), gateway);
  assert.equal(getHeldToolResourceLease(binding, 'operation-1').status, 'quarantined');

  const stale = gateway.handle(settle(trusted, { authority_revision: 'forged' }));
  assert.equal(stale.status, 'rejected');
  assert.equal(harness.broker.snapshot().quarantined_count, 1);
  assert.equal(notifications.length, 0);
  assert.equal(gateway.handle(settle(trusted)).status, 'settled');
  assert.equal(harness.broker.snapshot().lease_count, 0);
  assert.equal(getToolResourceOperations(binding), null);
  assert.equal(notifications.length, 1);

  assert.equal(gateway.handle(settle(trusted)).status, 'settled');
  assert.equal(harness.broker.snapshot().lease_count, 0);
  assert.equal(notifications.length, 2);
  assert.equal(gateway.handle(settle(trusted, { cleanup: 'uncertain' })).reason,
    'tool_resource_settlement_conflict');
  assert.equal(notifications.length, 2);
});

test('checkpoint wait evidence binds the admitted tool input and current authority without holding capacity', t => {
  const harness = createHarness(t, { limits: { tool_operations: 1 } });
  const occupied = harness.createGateway('occupied');
  assert.equal(occupied.gateway.handle(admit(occupied.trusted)).status, 'granted');
  const pending = harness.createGateway('pending', { continuationEnabled: true });
  const request = admit(pending.trusted);
  assert.equal(pending.gateway.handle(request).status, 'waiting');
  const expected = { resource_class: 'tool_operations', dependency_id: null };
  const descriptors = pending.gateway.getWaitResources(request.operation_id);
  assert.ok(Object.isFrozen(descriptors));
  assert.equal(harness.broker.canAcquire(descriptors), false);
  assert.equal(pending.gateway.getWaitResources('unknown'), null);
  assert.deepEqual(pending.gateway.validateResourceWait(request.operation_id, request.tool_name, request.arguments), expected);
  assert.equal(pending.gateway.validateResourceWait(request.operation_id, 'write_file', request.arguments), null);
  assert.equal(pending.gateway.validateResourceWait(request.operation_id, request.tool_name, { path: 'other' }), null);
  request.arguments.path = 'changed_after_admit';
  assert.equal(pending.gateway.validateResourceWait(request.operation_id, request.tool_name, request.arguments), null);
  assert.equal(harness.broker.snapshot().lease_count, 1);
  harness.revoke();
  assert.equal(pending.gateway.getWaitResources(request.operation_id), null);
  assert.equal(pending.gateway.validateResourceWait(request.operation_id, 'read_file', { path: 'README.md' }), null);
});

test('closing a waiting gateway invalidates its private eligibility descriptors', t => {
  const harness = createHarness(t, { limits: { tool_operations: 1 } });
  const occupied = harness.createGateway('occupied');
  occupied.gateway.handle(admit(occupied.trusted));
  const pending = harness.createGateway('pending', { continuationEnabled: true });
  const request = admit(pending.trusted);
  pending.gateway.handle(request);
  assert.ok(pending.gateway.getWaitResources(request.operation_id));
  pending.gateway.close({ producerSettled: true });
  assert.equal(pending.gateway.getWaitResources(request.operation_id), null);
  assert.equal(harness.broker.snapshot().lease_count, 1);
});

test('uncertain settlement remains quarantined until trusted producer cleanup confirms it', t => {
  const notifications = [];
  const harness = createHarness(t, { limits: { tool_operations: 1 },
    onSettled: event => notifications.push(event) });
  const { gateway, trusted } = harness.createGateway();
  assert.equal(gateway.handle(admit(trusted)).status, 'granted');
  assert.equal(gateway.handle(settle(trusted, { cleanup: 'uncertain' })).status, 'settled');
  assert.equal(harness.broker.snapshot().quarantined_count, 1);
  assert.equal(gateway.handle(settle(trusted, { cleanup: 'uncertain' })).status, 'settled');
  assert.equal(notifications.length, 2);
  assert.equal(gateway.handle(settle(trusted)).status, 'settled');
  assert.equal(harness.broker.snapshot().quarantined_count, 0);
  assert.equal(harness.broker.snapshot().lease_count, 0);

  const closed = gateway.close({ producerSettled: true });
  assert.equal(closed.quarantined, 0);
  assert.equal(closed.settled, 1);
  assert.equal(harness.broker.snapshot().lease_count, 0);
});

test('quarantined tool leases block later operations only until their late settlements confirm', t => {
  // Dynamic tools claim only per-call tool capacity, so two quarantined leases exhaust the
  // default tool_operations limit without contending on the workspace root.
  const harness = createHarness(t, { limits: { tool_operations: 2 } });
  const gateways = ['request-first', 'request-second', 'request-third'].map(requestId => {
    const created = harness.createGateway(requestId);
    harness.authorityService.bindPluginTools(created.binding, DYNAMIC_AUTHORITY);
    return created;
  });
  const [first, second, third] = gateways;
  const dynamicAdmit = (trusted, overrides = {}) => admit(trusted, { tool_name: DYNAMIC_TOOL, arguments: { value: 1 }, ...overrides });
  assert.equal(first.gateway.handle(dynamicAdmit(first.trusted)).status, 'granted');
  assert.equal(second.gateway.handle(dynamicAdmit(second.trusted)).status, 'granted');
  assert.equal(harness.broker.snapshot().oldest_quarantined_at, null);
  first.gateway.close({ producerSettled: false });
  second.gateway.close({ producerSettled: false });
  assert.equal(harness.broker.snapshot().quarantined_count, 2);
  assert.notEqual(harness.broker.snapshot().oldest_quarantined_at, null);
  assert.equal(getToolResourceOperations(first.binding), first.gateway, 'quarantined gateways stay registered for late settlement');

  assert.equal(third.gateway.handle(dynamicAdmit(third.trusted)).reason, 'resource_capacity');
  assert.equal(first.gateway.handle(settle(first.trusted, { cleanup: 'uncertain' })).status, 'settled');
  assert.equal(harness.broker.snapshot().quarantined_count, 2, 'uncertain cleanup keeps the lease charged');
  assert.equal(first.gateway.handle(settle(first.trusted)).status, 'settled');
  assert.equal(harness.broker.snapshot().quarantined_count, 1);
  assert.equal(third.gateway.handle(dynamicAdmit(third.trusted, { operation_id: 'operation-2' })).status, 'granted');
  assert.equal(third.gateway.handle(dynamicAdmit(third.trusted, { operation_id: 'operation-3' })).reason, 'resource_capacity');
  assert.equal(second.gateway.handle(settle(second.trusted)).status, 'settled');
  assert.equal(harness.broker.snapshot().quarantined_count, 0);
  assert.equal(harness.broker.snapshot().oldest_quarantined_at, null);
  assert.equal(getToolResourceOperations(first.binding), null);
  assert.equal(third.gateway.handle(dynamicAdmit(third.trusted, { operation_id: 'operation-4' })).status, 'granted');
});

test('a continuation never waits behind its own quarantined operation', t => {
  // 2026-09-22: a timed-out read_file settled cleanup "uncertain" and kept the
  // workspace lock; the next read waited on it, the turn paused, and the pause
  // could never settle because settlePause requires nothing quarantined.
  const harness = createHarness(t);
  const current = harness.createGateway('request-self-deadlock', { continuationEnabled: true });
  assert.equal(current.gateway.handle(admit(current.trusted)).status, 'granted');
  assert.equal(current.gateway.handle(settle(current.trusted, { status: 'failed', cleanup: 'uncertain' })).status, 'settled');
  assert.equal(current.gateway.snapshot().quarantined, 1);

  const next = current.gateway.handle(admit(current.trusted, { operation_id: 'operation-2' }));
  assert.equal(next.status, 'rejected');
  assert.equal(next.reason, 'tool_resource_own_cleanup_unconfirmed');
  assert.equal(current.gateway.getResourceWait('operation-2'), null);

  // Another request still waits (and may checkpoint) behind the same lease.
  const other = harness.createGateway('request-other', { continuationEnabled: true });
  assert.equal(other.gateway.handle(admit(other.trusted)).status, 'waiting');
  current.gateway.handle(settle(current.trusted, { status: 'failed' }));
  other.gateway.close({ producerSettled: true });
  current.gateway.close({ producerSettled: true });
});
