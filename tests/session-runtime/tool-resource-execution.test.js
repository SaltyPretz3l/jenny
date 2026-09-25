'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { SessionExecutionAuthority } = require('../../services/backend/session-execution-authority');
const { ResourceBroker, capacityResource } = require('../../services/session-runtime/resource-broker');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const { RuntimeLaneAdmission, captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { RuntimeOperations } = require('../../services/session-runtime/operations');
const { createToolResourceClaim, projectToolResourceWait } = require('../../services/tools/tool-resource-execution');
const { executeResolvedTool } = require('../../services/tools/tool-execution-dispatch');
const { ToolExecutor } = require('../../services/tools/tool-executor');
const { TOOL_ERROR_CODES } = require('../../services/backend/error-codes');

function fixture() {
  let decision = 'auto';
  const authority = Object.freeze({ project_id: 'project_test', root_path: os.tmpdir(),
    root_id: 'root_test', root_revision: 1, device_id: null, inode: null });
  const permissionStore = { getSnapshot: () => ({ version: 3,
    legacy_policies: { jenny_status: decision, run_command: decision }, rules: [] }) };
  const executionAuthority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => authority, requireCurrent: () => authority },
    permissionStore,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const binding = executionAuthority.captureSession('session_test', { requestId: 'request_test' });
  const context = executionAuthority.toExecutionContext(binding);
  const broker = new ResourceBroker({ limits: { tool_operations: 1 } });
  const lanes = new RuntimeLaneAdmission();
  const route = captureRuntimeRoute({ engine_type: 'mock', provider_id: 'mock',
    configuration_revision: 'config:1', resource_class: 'local', requires_gpu: false });
  const gateway = new RuntimeOperations({
    inference: { lanes, route, requestId: 'request_test', sessionId: 'session_test',
      authorityRevision: context.authority_revision, assertCurrent: () => executionAuthority.requireCurrent(binding) },
    tools: { broker, pathResolver: new PhysicalPathResolver(), executionAuthority, binding },
  });
  const claim = (operationId = 'operation:1') => createToolResourceClaim({ binding,
    operationId, toolName: 'jenny_status', input: {}, required: true });
  return { broker, lanes, gateway, binding, executionAuthority, permissionStore, claim,
    setDecision(value) { decision = value; } };
}

test('Node resource claims fail closed and waiting allocates no retained worker or lease', async () => {
  assert.throws(() => createToolResourceClaim({ binding: {}, required: true }),
    error => error.code === 'CMP-RUNTIME-0002');
  const setup = fixture();
  const held = await setup.broker.acquire({ ownerId: 'other', resources: [capacityResource('tool_operations')] });
  await assert.rejects(setup.claim().admit(), error => error.retryable && error.code === 'CMP-RUNTIME-0001');
  assert.equal(setup.broker.snapshot().lease_count, 1);
  assert.equal(setup.broker.snapshot().waiter_count, 0);
  setup.broker.release(held, { producerSettled: true });
  setup.gateway.close({ producerSettled: true });
});

test('a captured Node settlement survives revocation without granting new work', async () => {
  const setup = fixture();
  const claim = setup.claim();
  await claim.admit();
  setup.gateway.close({ producerSettled: false });
  setup.executionAuthority.close(setup.binding);
  assert.equal(setup.gateway.snapshot().quarantined, 1);
  await claim.settle({ status: 'cancelled', cleanup: 'confirmed' });
  assert.equal(setup.gateway.snapshot().quarantined, 0);
  assert.equal(setup.broker.snapshot().lease_count, 0);
  assert.throws(() => setup.claim('operation:2'));
});

test('the combined terminal barrier keeps tool resources after unused inference is released', async () => {
  const setup = fixture();
  assert.equal(setup.gateway.reserveInitial().status, 'granted');
  const claim = setup.claim();
  await claim.admit();
  setup.gateway.close({ producerSettled: false });
  assert.equal(setup.lanes.snapshot().active_leases, 0);
  assert.equal(setup.gateway.snapshot().closed, true);
  assert.equal(setup.gateway.snapshot().quarantined, 1);
  await claim.settle({ status: 'failed', cleanup: 'uncertain' });
  assert.equal(setup.broker.snapshot().lease_count, 1);
  await claim.settle({ status: 'failed', cleanup: 'confirmed' });
  assert.equal(setup.gateway.snapshot().quarantined, 0);
});

test('Electron execution brackets the actual producer and quarantines an unproven exception', async () => {
  for (const throws of [false, true]) {
    const setup = fixture();
    const executor = { _logger() {}, _mergePolicyDecisionMetadata: value => value,
      _evaluateToolPolicy: () => ({ decision: 'auto' }) };
    const result = await executeResolvedTool(executor,
      { callId: 'operation:1', toolName: 'jenny_status', input: {} },
      { executionAuthority: setup.binding, backendService: { sessionRuntime: {} } },
      { startTime: Date.now(), approvalState: 'auto', tool: {
        summarize: () => 'status', async execute() {
          assert.equal(setup.broker.snapshot().capacity.tool_operations, 1);
          if (throws) throw new Error('producer did not report cleanup');
          return { content: 'ready', isError: false };
        },
      } });
    assert.equal(result.isError, throws);
    assert.equal(setup.broker.snapshot().lease_count, throws ? 1 : 0);
    setup.gateway.close({ producerSettled: false });
  }
});

test('producer start rechecks a policy that changes to deny during the handshake', async () => {
  const setup = fixture();
  let releaseProducer;
  let notifyWaiting;
  const waiting = new Promise(resolve => { notifyWaiting = resolve; });
  const producerGate = new Promise(resolve => { releaseProducer = resolve; });
  let executions = 0;
  const tool = {
    name: 'jenny_status', category: 'builtin', workspaceRequired: false,
    readOnly: true, sideEffecting: false, summarize: () => 'status',
    async execute() { executions += 1; return { content: 'ready', isError: false }; },
  };
  const executor = new ToolExecutor({
    registry: { getTool: () => tool },
    permissionStore: setup.permissionStore,
    pathPolicy: {},
    logger() {},
  });
  const resultPromise = executor.executePreApproved({
    callId: 'policy-drift', toolName: 'jenny_status', input: {},
  }, {
    executionAuthority: setup.binding,
    beforeProducer: async () => { notifyWaiting(); await producerGate; },
  });
  await waiting;
  setup.setDecision('deny');
  releaseProducer();

  const result = await resultPromise;
  assert.equal(executions, 0);
  assert.equal(result.isError, true);
  assert.equal(result.approvalState, 'denied');
  assert.equal(result.errorCode, TOOL_ERROR_CODES.POLICY_DENIED);
});

const { createElectronStartGate } = require('../../services/backend/runtime-electron-start-gate');
function gatedExecutor(setup, signal, count, timeoutMs) {
  return createElectronStartGate({ enabled: () => true, signal, timeoutMs,
    execute: (params, beforeProducer) => executeResolvedTool(
      { _logger() {}, _mergePolicyDecisionMetadata: value => value,
        _evaluateToolPolicy: () => ({ decision: 'auto' }) },
      { callId: params.tool_call_id, toolName: 'jenny_status', input: params.arguments },
      { beforeProducer, executionAuthority: setup.binding, backendService: { sessionRuntime: {} } },
      { startTime: Date.now(), approvalState: 'auto', tool: {
        summarize: () => 'status', async execute() { count.value++; return { content: 'ready', isError: false }; },
      } }) });
}
const gateInput = { tool_call_id: 'operation:1', arguments: {} };
const prepareInput = { ...gateInput, runtime_resource_gate: { schema_version: 1, phase: 'prepare' } };
test('Electron waits publish only confirmed unstarted operations, with no producer or retained lease', async () => {
  const setup = fixture(); setup.gateway.enableContinuation();
  const count = { value: 0 }; const gate = gatedExecutor(setup, null, count);
  const held = await setup.broker.acquire({ ownerId: 'other', resources: [capacityResource('tool_operations')] });
  await assert.rejects(gate(prepareInput), error => {
    assert.deepEqual(projectToolResourceWait(error), { schema_version: 1, operation_id: 'operation:1',
      resource_class: 'tool_operations', dependency_id: null, status: 'waiting' });
    return true;
  });
  assert.equal(count.value, 0); assert.equal(setup.broker.snapshot().waiter_count, 0);
  assert.equal(setup.broker.snapshot().lease_count, 1);
  assert.deepEqual(setup.gateway.tools.validateResourceWait('operation:1', 'jenny_status', {}),
    { resource_class: 'tool_operations', dependency_id: null });
  await assert.rejects(gate(prepareInput), /runtime_electron_start_invalid/);
  setup.broker.release(held, { producerSettled: true }); setup.gateway.close({ producerSettled: true });
});
test('Electron acknowledgement is exact, one-use and precedes the producer', async () => {
  const setup = fixture(); const count = { value: 0 }; const gate = gatedExecutor(setup, null, count);
  const ready = (await gate(prepareInput)).runtime_resource_ready;
  assert.equal(count.value, 0); assert.equal(setup.broker.snapshot().lease_count, 1);
  const start = { ...gateInput, runtime_resource_gate: { schema_version: 1, phase: 'start', token: ready.token } };
  await assert.rejects(gate({ ...start, arguments: { changed: true } }), /runtime_electron_start_invalid/);
  await assert.rejects(gate({ ...start, runtime_resource_gate: { ...start.runtime_resource_gate, token: 'wrong' } }), /runtime_electron_start_invalid/);
  assert.equal(count.value, 0); assert.equal((await gate(start)).isError, false);
  assert.equal(count.value, 1); assert.equal(setup.broker.snapshot().lease_count, 0);
  await assert.rejects(gate(start), /runtime_electron_start_invalid/);
  setup.gateway.close({ producerSettled: true });
});
test('Electron cancellation or stale authority while ready never starts and releases resources', async () => {
  for (const revoke of [false, true]) {
    const setup = fixture(); const controller = new AbortController(); const count = { value: 0 };
    const gate = gatedExecutor(setup, controller.signal, count);
    const ready = (await gate(prepareInput)).runtime_resource_ready;
    if (revoke) setup.executionAuthority.close(setup.binding); else controller.abort();
    const start = { ...gateInput, runtime_resource_gate: { schema_version: 1, phase: 'start', token: ready.token } };
    if (revoke) assert.equal((await gate(start)).isError, true);
    else { await assert.rejects(gate(start)); await new Promise(resolve => setImmediate(resolve)); }
    assert.equal(count.value, 0); assert.equal(setup.broker.snapshot().lease_count, 0);
    setup.gateway.close({ producerSettled: true });
  }
});

test('hosted command refuses authority revoked during the start handshake before broker submission', async () => {
  const setup = fixture(); let submitted = 0; let acknowledged = false;
  const { executeHostedRunCommand } = require('../../services/backend/hosted-command-bridge');
  const result = await executeHostedRunCommand({ sessionRuntime: {}, hostExecutionPolicyVersion: 2,
    hostExecutionBroker: { status: () => ({ available: true }), execute: async (_input, options) => {
      await options.beforeAdmission(); submitted++;
      return { success: true, cleanup_confirmed: true };
    } },
  }, { input: { command: 'echo test' }, sessionId: 'session_test', streamId: 'request_test',
    executionAuthority: setup.binding, callId: 'operation:1',
    beforeProducer: async () => { acknowledged = true; setup.executionAuthority.close(setup.binding); },
  }, { bridgeFailure: (_name, output) => ({ success: false, output }),
    sanitizeBridgeMetadata: value => value, maxOutputChars: 1000 });
  assert.equal(acknowledged, true); assert.equal(submitted, 0); assert.equal(result.success, false);
  assert.equal(setup.broker.snapshot().lease_count, 0); setup.gateway.close({ producerSettled: true });
});
