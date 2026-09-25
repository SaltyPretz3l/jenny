'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { ResourceBroker, capacityResource, filesystemResource } = require('../../services/session-runtime/resource-broker');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const { ToolResourceOperations } = require('../../services/session-runtime/resource-operations');
const { SessionExecutionAuthority } = require('../../services/backend/session-execution-authority');
const { createToolResourceClaim } = require('../../services/tools/tool-resource-execution');

function fixture() {
  const authority = { project_id: 'project_test', root_path: os.tmpdir(), root_id: 'root_test',
    root_revision: 1, device_id: null, inode: null };
  const owner = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => authority, requireCurrent: () => authority },
    permissionStore: { getSnapshot: () => ({ version: 2,
      legacy_policies: { run_command: 'auto' }, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const signal = new AbortController();
  const binding = owner.captureSession('session_test', { requestId: 'request_test', signal: signal.signal });
  const broker = new ResourceBroker({ limits: { native_processes: 1, sandbox_commands: 1, tool_operations: 1 } });
  const pathResolver = new PhysicalPathResolver();
  const gateway = new ToolResourceOperations({ broker, pathResolver, executionAuthority: owner,
    binding, sandboxCommands: true });
  const claim = createToolResourceClaim({ binding, operationId: 'call_test',
    toolName: 'run_command', input: { command: 'true' }, required: true });
  const preparation = claim.createSandboxPreparation({ signal: signal.signal, assertLive() {} });
  const workerBinding = Object.fromEntries(['request_id', 'session_id', 'stream_id', 'tool_call_id',
    'command_digest', 'snapshot_id', 'snapshot_digest', 'container_id', 'image_id',
    'job_id', 'incarnation'].map(key => [key, key + '_test']));
  return { broker, pathResolver, gateway, claim, preparation, workerBinding, signal,
    context: owner.toExecutionContext(binding) };
}

test('preparation holds only the resources belonging to each actual producer phase', async () => {
  const setup = fixture();
  await setup.preparation.withSnapshot(async () => {
    assert.equal(setup.broker.snapshot().lease_count, 1);
    assert.deepEqual(setup.broker.snapshot().capacity, {
      native_processes: 0, sandbox_commands: 0, tool_operations: 0, tests: 0,
    });
    const competing = setup.broker.tryAcquire({ ownerId: 'writer', resources: [
      filesystemResource(setup.pathResolver.resolve(os.tmpdir())),
    ] });
    assert.equal(competing.status, 'waiting');
  });
  assert.equal(setup.broker.snapshot().lease_count, 0);
  setup.preparation.acquireWorker();
  setup.preparation.bindWorker(setup.workerBinding);
  // During approval the live workspace is unused, but the worker still exists.
  const writer = setup.broker.tryAcquire({ ownerId: 'writer', resources: [
    filesystemResource(setup.pathResolver.resolve(os.tmpdir())),
  ] });
  assert.equal(writer.status, 'granted');
  assert.equal(setup.broker.snapshot().capacity.tool_operations, 0);
  setup.broker.confirmCleanup(writer.lease);
  await setup.claim.admit({ preparation: setup.preparation, workerBinding: setup.workerBinding });
  assert.equal(setup.broker.snapshot().capacity.native_processes, 1);
  assert.equal(setup.broker.snapshot().capacity.sandbox_commands, 1);
  assert.equal(setup.broker.snapshot().capacity.tool_operations, 1);
  await setup.claim.settle({ status: 'succeeded', cleanup: 'confirmed' });
  assert.equal(setup.broker.snapshot().capacity.native_processes, 1);
  setup.preparation.settle({ cleanup: 'confirmed' });
  assert.equal(setup.broker.snapshot().lease_count, 0);
});

test('busy preparation does not start copying or allocate a partial worker lease', async () => {
  const setup = fixture();
  const root = setup.broker.tryAcquire({ ownerId: 'writer', resources: [
    filesystemResource(setup.pathResolver.resolve(os.tmpdir())),
  ] });
  let copies = 0;
  await assert.rejects(setup.preparation.withSnapshot(async () => { copies += 1; }),
    error => error.code === 'CMP-RUNTIME-0001');
  assert.equal(copies, 0);
  assert.equal(setup.broker.snapshot().waiter_count, 0);
  assert.equal(setup.broker.snapshot().lease_count, 1);
  setup.broker.confirmCleanup(root.lease);

  const other = fixture();
  await other.preparation.withSnapshot(async () => {});
  const native = other.broker.tryAcquire({ ownerId: 'native', resources: [capacityResource('native_processes')] });
  assert.throws(() => other.preparation.acquireWorker(), error => error.code === 'CMP-RUNTIME-0001');
  assert.equal(other.broker.snapshot().capacity.sandbox_commands, 0);
  other.broker.confirmCleanup(native.lease);
});

test('only the exact branded live worker may supply the prepared capacity', async () => {
  const setup = fixture();
  await setup.preparation.withSnapshot(async () => {});
  setup.preparation.acquireWorker();
  setup.preparation.bindWorker(setup.workerBinding);
  await assert.rejects(setup.claim.admit({ preparation: {}, workerBinding: setup.workerBinding }));
  await assert.rejects(setup.claim.admit({ preparation: setup.preparation,
    workerBinding: { ...setup.workerBinding, incarnation: 'other' } }));
  assert.equal(setup.broker.snapshot().capacity.tool_operations, 0);
  setup.preparation.settle({ cleanup: 'confirmed' });
  await assert.rejects(setup.claim.admit({ preparation: setup.preparation, workerBinding: setup.workerBinding }));
});

test('busy final admission leaves no partial command claim and cleanup remains independent', async () => {
  const setup = fixture();
  await setup.preparation.withSnapshot(async () => {});
  setup.preparation.acquireWorker();
  setup.preparation.bindWorker(setup.workerBinding);
  const tool = setup.broker.tryAcquire({ ownerId: 'tool', resources: [capacityResource('tool_operations')] });
  await assert.rejects(setup.claim.admit({ preparation: setup.preparation, workerBinding: setup.workerBinding }),
    error => error.code === 'CMP-RUNTIME-0001');
  assert.equal(setup.broker.snapshot().waiter_count, 0);
  assert.equal(setup.broker.snapshot().lease_count, 2);
  assert.equal(await setup.claim.settle({ status: 'failed', cleanup: 'confirmed' }), false);
  setup.preparation.settle({ cleanup: 'uncertain' });
  assert.equal(setup.gateway.snapshot().quarantined, 1);
  setup.preparation.settle({ cleanup: 'confirmed' });
  setup.broker.confirmCleanup(tool.lease);
  assert.equal(setup.broker.snapshot().lease_count, 0);
});

test('request closure cannot certify an external worker but exact cleanup survives cancellation', async () => {
  const setup = fixture();
  await setup.preparation.withSnapshot(async () => {});
  setup.preparation.acquireWorker();
  setup.preparation.bindWorker(setup.workerBinding);
  await setup.claim.admit({ preparation: setup.preparation, workerBinding: setup.workerBinding });
  setup.signal.abort();
  setup.gateway.close({ producerSettled: true });
  assert.equal(setup.gateway.snapshot().quarantined, 2);
  assert.equal(setup.broker.snapshot().lease_count, 2);
  await assert.rejects(setup.claim.admit({ preparation: setup.preparation, workerBinding: setup.workerBinding }));
  setup.preparation.settle({ cleanup: 'confirmed' });
  assert.equal(setup.broker.snapshot().capacity.tool_operations, 1);
  await setup.claim.settle({ status: 'cancelled', cleanup: 'confirmed' });
  assert.equal(setup.broker.snapshot().lease_count, 0);
});

test('snapshot refusal releases only with the snapshot owner close verdict', async () => {
  for (const cleanupConfirmed of [true, false]) {
    const setup = fixture();
    await assert.rejects(setup.preparation.withSnapshot(async onSettled => {
      onSettled({ cleanupConfirmed });
      throw new Error('snapshot refused');
    }), /snapshot refused/);
    setup.preparation.settle({ cleanup: 'confirmed' });
    assert.equal(setup.broker.snapshot().lease_count, cleanupConfirmed ? 0 : 1);
    assert.equal(setup.gateway.snapshot().quarantined, cleanupConfirmed ? 0 : 1);
  }
});

test('sidecar settlement cannot release a command owned by the Node execution service', async () => {
  const setup = fixture();
  await setup.preparation.withSnapshot(async () => {});
  setup.preparation.acquireWorker();
  setup.preparation.bindWorker(setup.workerBinding);
  await setup.claim.admit({ preparation: setup.preparation, workerBinding: setup.workerBinding });
  const forged = setup.gateway.handle({ api_version: '2026-08-17', schema_version: 1, kind: 'tool',
    request_id: 'request_test', session_id: 'session_test',
    authority_revision: setup.context.authority_revision, operation_id: 'call_test',
    phase: 'settle', status: 'succeeded', cleanup: 'confirmed' });
  assert.equal(forged.status, 'rejected');
  assert.equal(forged.reason, 'tool_resource_settlement_owner_mismatch');
  assert.equal(setup.broker.snapshot().capacity.tool_operations, 1);
  setup.preparation.settle({ cleanup: 'confirmed' });
  await setup.claim.settle({ status: 'succeeded', cleanup: 'confirmed' });
  assert.equal(setup.broker.snapshot().lease_count, 0);
});
