'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SessionExecutionAuthority } = require('../../services/backend/session-execution-authority');
const { createWorkspaceTestRunnerWiring } = require('../../services/main/workspace-test-runner-wiring');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const { ResourceBroker, capacityResource } = require('../../services/session-runtime/resource-broker');
const { ToolExecutor } = require('../../services/tools/tool-executor');
const { ToolRegistry } = require('../../services/tools/tool-registry');
const { createVerifyTool } = require('../../services/tools/builtin/verify-tool');
const {
  createToolTestRunnerService,
  requireToolTestRunnerExecutionPort,
} = require('../../services/tools/tool-test-runner-authority');
const { cleanupTrackedResources, createTrackedTempDir } = require('../helpers/resource-cleanup');

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test.afterEach(async () => cleanupTrackedResources());

function fixture() {
  const authority = Object.freeze({ project_id: 'project_test', root_path: os.tmpdir(),
    root_id: 'root_test', root_revision: 1, device_id: null, inode: null });
  let decision = 'auto';
  const policy = () => ({ version: 3, legacy_policies: { verify: decision }, rules: [] });
  const executionAuthority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => authority, requireCurrent: () => authority },
    permissionStore: { getSnapshot: policy },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const controller = new AbortController();
  const binding = executionAuthority.captureSession('session_test', {
    requestId: 'request_test', signal: controller.signal,
  });
  let receivedPort = null;
  const service = {
    listConfigs: () => ({ configs: [] }),
    run: async (_payload, port) => { receivedPort = port; return { status: 'passed' }; },
  };
  const facade = createToolTestRunnerService({ service, executionAuthority, binding,
    callId: 'call_verify', input: { action: 'run', config_id: 'unit' },
    abortSignal: controller.signal });
  return { controller, facade, getPort: () => receivedPort,
    revoke: () => { decision = 'deny'; } };
}

test('the verify facade passes only a branded request authority port', async () => {
  const setup = fixture();
  assert.deepEqual(await setup.facade.run({ configId: 'unit' }), { status: 'passed' });
  const port = requireToolTestRunnerExecutionPort(setup.getPort());
  assert.equal(port.abortSignal, setup.controller.signal);
  assert.equal(port.assertCurrent(), true);
  assert.throws(() => requireToolTestRunnerExecutionPort({}), /internal execution port is invalid/);
});

test('the captured verify identity observes policy revocation and cancellation', async () => {
  const revoked = fixture();
  revoked.revoke();
  assert.throws(() => revoked.facade.run({ configId: 'unit' }), /does not authorize/);

  const cancelled = fixture();
  cancelled.controller.abort(new Error('cancelled by model'));
  assert.throws(() => cancelled.facade.run({ configId: 'unit' }), /cancelled|authority/i);
});

function integratedFixture({ runTestCommand, continuation = false } = {}) {
  const base = createTrackedTempDir('jenny-tool-test-runner-');
  const root = path.join(base, 'workspace');
  fs.mkdirSync(root);
  const broker = new ResourceBroker();
  const pathResolver = new PhysicalPathResolver();
  let decision = 'auto';
  const policyStore = { getSnapshot: () => ({ version: 3,
    legacy_policies: { verify: decision }, rules: [] }) };
  const authority = Object.freeze({ project_id: 'project_test', root_path: root,
    root_id: 'root_test', root_revision: 1, device_id: null, inode: null });
  const owner = { requireCurrent(value) {
    if (value !== authority && value.project_id !== authority.project_id) throw new Error('stale project');
  } };
  const calls = [];
  const wiring = createWorkspaceTestRunnerWiring({
    userDataDir: path.join(base, 'profile'),
    shellConfigService: { getToolsWorkspaceRoot: () => root },
    featureFlagProvider: () => ({ workspace_test_runner: true }),
    resourceAdmissionProvider: () => ({ broker, pathResolver }),
    runner: { runTestCommand: async (options) => {
      calls.push(options);
      return runTestCommand ? runTestCommand(options) : {
        status: 'passed', exitCode: 0, durationMs: 1, startedAt: 'S', finishedAt: 'F',
        stdoutTail: '', stderrTail: '', terminationConfirmed: true,
      };
    } },
  });
  wiring.saveConfigs([{ id: 'unit', label: 'Unit', command: 'npm test', cwd: '.' }]);
  const scoped = wiring.forProjectAuthority(authority, owner);
  const executionAuthority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => authority, requireCurrent: owner.requireCurrent },
    permissionStore: policyStore,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({ workspaceTestRunnerService: scoped }),
  });
  const controller = new AbortController();
  const binding = executionAuthority.captureSession('session_test', {
    requestId: 'request_test', signal: controller.signal,
  });
  const registry = new ToolRegistry();
  registry.registerTool(createVerifyTool());
  const executor = new ToolExecutor({ registry, permissionStore: policyStore,
    pathPolicy: {}, logger() {} });
  const gateway = continuation ? new (require('../../services/session-runtime/resource-operations').ToolResourceOperations)({
    broker, pathResolver, executionAuthority, binding, continuationEnabled: true,
  }) : null;
  const execute = (beforeProducer = null) => executor.executePreApproved({ callId: 'call_verify', toolName: 'verify',
    input: { action: 'run', config_id: 'unit' } }, {
    executionAuthority: binding,
    beforeProducer,
    backendService: { sessionExecutionAuthority: executionAuthority },
    abortSignal: controller.signal,
    sessionId: 'session_test', streamId: 'stream_test',
  });
  return { gateway, broker, calls, controller, execute, revoke: () => { decision = 'deny'; }, wiring };
}

async function waitForWaiter(broker) {
  for (let attempt = 0; attempt < 10 && broker.snapshot().waiter_count === 0; attempt += 1) {
    await nextTurn();
  }
  assert.equal(broker.snapshot().waiter_count, 1);
}

test('executor cancellation and policy revocation while queued never dispatch or write history', async () => {
  for (const reason of ['cancel', 'revoke']) {
    const setup = integratedFixture();
    const holder = await setup.broker.acquire({ ownerId: `holder-${reason}`,
      resources: [capacityResource('tests')] });
    const pending = setup.execute();
    await waitForWaiter(setup.broker);
    if (reason === 'cancel') setup.controller.abort(new Error('model cancelled'));
    else setup.revoke();
    setup.broker.release(holder, { producerSettled: true });
    const result = await pending;
    assert.equal(result.isError, false);
    assert.equal(setup.calls.length, 0);
    assert.deepEqual(setup.wiring.getState().history.byConfig, {});
    assert.equal(setup.broker.snapshot().lease_count, 0);
    await setup.wiring.dispose();
  }
});

test('cancellation after producer dispatch drains the test resource lease', async () => {
  const setup = integratedFixture({ runTestCommand: (options) => new Promise((resolve) => {
    options.abortSignal.addEventListener('abort', () => resolve({
      status: 'aborted', exitCode: null, durationMs: 1, startedAt: 'S', finishedAt: 'F',
      stdoutTail: '', stderrTail: '', terminationConfirmed: true,
    }), { once: true });
  }) });
  const pending = setup.execute();
  for (let attempt = 0; attempt < 10 && setup.calls.length === 0; attempt += 1) await nextTurn();
  assert.equal(setup.calls.length, 1);
  setup.controller.abort(new Error('late cancel'));
  await pending;
  assert.equal(setup.broker.snapshot().lease_count, 0);
  assert.equal(setup.wiring.getState().activeRun, null);
  await setup.wiring.dispose();
});

const { createElectronStartGate } = require('../../services/backend/runtime-electron-start-gate');
const { projectToolResourceWait } = require('../../services/tools/tool-resource-execution');
function verificationGate(setup) {
  return createElectronStartGate({ enabled: () => true, signal: setup.controller.signal,
    execute: (_params, beforeProducer) => setup.execute(beforeProducer) });
}
const verificationPrepare = { tool_call_id: 'call_verify',
  runtime_resource_gate: { schema_version: 1, phase: 'prepare' } };
test('managed verify defers at its owner before history or process creation, without a queued worker', async () => {
  const setup = integratedFixture({ continuation: true });
  const holder = await setup.broker.acquire({ ownerId: 'held-tests', resources: [capacityResource('tests')] });
  await assert.rejects(verificationGate(setup)(verificationPrepare), error => {
    assert.equal(projectToolResourceWait(error)?.resource_class, 'tests'); return true;
  });
  assert.equal(setup.calls.length, 0); assert.equal(setup.broker.snapshot().waiter_count, 0);
  assert.deepEqual(setup.wiring.getState().history.byConfig, {});
  assert.equal(setup.wiring.getState().activeRun, null);
  setup.broker.release(holder, { producerSettled: true });
  setup.gateway.close({ producerSettled: true }); await setup.wiring.dispose();
});
test('managed verify holds one full resource lease until acknowledgement and rechecks policy before spawning', async () => {
  for (const revoke of [false, true]) {
    const setup = integratedFixture({ continuation: true }); const gate = verificationGate(setup);
    const ready = (await gate(verificationPrepare)).runtime_resource_ready;
    assert.equal(setup.broker.snapshot().lease_count, 1);
    assert.equal(setup.calls.length, 0); assert.deepEqual(setup.wiring.getState().history.byConfig, {});
    if (revoke) setup.revoke();
    await gate({ tool_call_id: 'call_verify', runtime_resource_gate: { schema_version: 1, phase: 'start', token: ready.token } });
    assert.equal(setup.calls.length, revoke ? 0 : 1);
    assert.equal(setup.broker.snapshot().lease_count, 0);
    if (revoke) assert.deepEqual(setup.wiring.getState().history.byConfig, {});
    setup.gateway.close({ producerSettled: true }); await setup.wiring.dispose();
  }
});
