'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { DesktopSandboxService } = require('../services/execution/desktop-sandbox-service');
const { ExecutionBroker } = require('../services/execution/execution-broker');
const { ExecutionReceipts } = require('../services/execution/execution-receipts');
const { digest, sandboxError } = require('../services/execution/sandbox-errors');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { ResourceBroker, filesystemResource, capacityResource } = require('../services/session-runtime/resource-broker');
const { PhysicalPathResolver } = require('../services/session-runtime/physical-paths');
const { ToolResourceOperations } = require('../services/session-runtime/resource-operations');
const { createToolResourceClaim, projectToolResourceWait } = require('../services/tools/tool-resource-execution');

const { deferred, fixture, fakeLauncher, stagedSnapshot, readyService, attachFakeWorker, runtimeResources } = require('./helpers/desktop-sandbox-lifecycle-fixture');

test('sandbox preparation refuses a locked root before snapshot or worker production', async t => {
  const setup = await readyService(t);
  const resources = runtimeResources(setup);
  let copies = 0;
  setup.service.snapshot = async () => { copies += 1; throw new Error('must not copy'); };
  const workers = attachFakeWorker(setup.service);
  const held = resources.broker.tryAcquire({ ownerId: 'writer', resources: [
    filesystemResource(resources.pathResolver.resolve(setup.workspace)),
  ] });
  await assert.rejects(setup.service.execute({ command: 'true' }, { sessionId: 'session', streamId: 'stream',
    callId: 'call', projectAuthority: setup.authority, resourceClaim: resources.resourceClaim },
  async () => { throw new Error('must not request approval'); }), error => error.code === 'CMP-RUNTIME-0001');
  assert.equal(copies, 0);
  assert.equal(workers.length, 0);
  assert.equal(resources.broker.snapshot().lease_count, 1);
  assert.equal(setup.service.pendingRuntimeCleanup, null);
  resources.broker.confirmCleanup(held.lease);
});

test('denied exact approval releases the prepared worker without admitting a command', async t => {
  const setup = await readyService(t);
  const resources = runtimeResources(setup);
  attachFakeWorker(setup.service);
  await assert.rejects(setup.service.execute({ command: 'true' }, { sessionId: 'session', streamId: 'stream',
    callId: 'call', projectAuthority: setup.authority, resourceClaim: resources.resourceClaim },
  async binding => {
    assert.ok(binding.snapshot_digest && binding.container_id && binding.incarnation);
    assert.equal(resources.broker.snapshot().capacity.native_processes, 1);
    assert.equal(resources.broker.snapshot().capacity.sandbox_commands, 1);
    assert.equal(resources.broker.snapshot().capacity.tool_operations, 0);
    const writer = resources.broker.tryAcquire({ ownerId: 'writer', resources: [
      filesystemResource(resources.pathResolver.resolve(setup.workspace)),
    ] });
    assert.equal(writer.status, 'granted');
    resources.broker.confirmCleanup(writer.lease);
    return { approved: false };
  }), /sandbox_approval_denied/);
  assert.equal(resources.broker.snapshot().lease_count, 0);
  assert.equal(setup.service.pendingRuntimeCleanup, null);
});

test('cancellation just after staging still removes the completed snapshot', async t => {
  const setup = await readyService(t);
  const resources = runtimeResources(setup);
  const controller = new AbortController();
  const stage = setup.service.snapshot;
  setup.service.snapshot = async options => {
    const result = await stage(options);
    controller.abort();
    return result;
  };
  const workers = attachFakeWorker(setup.service);
  await assert.rejects(setup.service.execute({ command: 'true' }, { sessionId: 'session', streamId: 'stream',
    callId: 'call', projectAuthority: setup.authority, resourceClaim: resources.resourceClaim,
    signal: controller.signal }, async () => { throw new Error('must not request approval'); }), /sandbox_stale_authority/);
  assert.equal(workers.length, 0);
  assert.deepEqual(await fs.readdir(setup.service.stagingRoot), []);
  assert.equal(resources.broker.snapshot().lease_count, 0);
});

test('readiness retry shares native capacity before any Docker preparation', async t => {
  const setup = await readyService(t);
  const resources = runtimeResources(setup);
  setup.getBackend = () => ({ sessionRuntime: { resourceBroker: resources.broker } });
  const held = resources.broker.tryAcquire({ ownerId: 'test-runner', resources: [
    { type: 'capacity', key: 'native_processes' },
  ] });
  const unavailable = await setup.service.retry();
  assert.equal(unavailable.reason, 'sandbox_resource_busy');
  assert.deepEqual(setup.launcher.calls, []);
  resources.broker.confirmCleanup(held.lease);
  setup.service._worker = async () => {
    assert.equal(resources.broker.snapshot().capacity.native_processes, 1);
    assert.equal(resources.broker.snapshot().capacity.sandbox_commands, 1);
    return { containerId: 'c'.repeat(64), transport: { dispose() {} } };
  };
  assert.equal((await setup.service.retry()).state, 'ready');
  assert.equal(resources.broker.snapshot().lease_count, 0);
});

test('runtime command resources wait for approval and remain owned through container removal', async (t) => {
  const setup = await readyService(t);
  const removal = deferred();
  const removing = deferred();
  setup.launcher.stopAndRemove = async () => { removing.resolve(); await removal.promise; };
  attachFakeWorker(setup.service, { result: { status: 'completed', success: true,
    cleanup_confirmed: true, stdout: '', stderr: '' } });
  const approval = deferred();
  const approving = deferred();
  const calls = [];
  const resourceClaim = {
    async admit() { calls.push('admit'); },
    async settle(verdict) { calls.push(verdict); },
  };
  const running = setup.service.execute({ command: 'true' }, {
    sessionId: 'session', streamId: 'stream', callId: 'call',
    projectAuthority: setup.authority, resourceClaim,
  }, async () => { approving.resolve(); await approval.promise; return { approved: true, digest: 'approved' }; });
  await approving.promise;
  assert.deepEqual(calls, []);
  approval.resolve();
  await removing.promise;
  assert.deepEqual(calls, ['admit']);
  removal.resolve();
  await running;
  assert.deepEqual(calls, ['admit', { status: 'succeeded', cleanup: 'confirmed' }]);
});

test('runtime command resources retain uncertain container cleanup', async (t) => {
  const setup = await readyService(t);
  attachFakeWorker(setup.service, { result: { status: 'completed', success: true,
    cleanup_confirmed: true, stdout: '', stderr: '' } });
  setup.launcher.stopAndRemove = async () => { throw sandboxError('sandbox_cleanup_unconfirmed'); };
  const settlements = [];
  await assert.rejects(setup.service.execute({ command: 'true' }, {
    sessionId: 'session', streamId: 'stream', callId: 'call', projectAuthority: setup.authority,
    resourceClaim: { async admit() {}, async settle(value) { settlements.push(value); } },
  }, async () => ({ approved: true, digest: 'approved' })), /sandbox_cleanup_unconfirmed/);
  assert.deepEqual(settlements, [{ status: 'failed', cleanup: 'uncertain' }]);
  assert.ok(setup.service.pendingRuntimeCleanup);
  await setup.service.retry();
  assert.equal(settlements.length, 1);
  assert.ok(setup.service.pendingRuntimeCleanup);
  const removed = [];
  setup.launcher.stopAndRemove = async id => { removed.push(id); };
  // The runtime claim's exact container must be checked even if discovery no
  // longer lists it. Preparation is unrelated to recovery evidence in this test.
  setup.service._prepare = async () => setup.service._publish('ready');
  const recovered = await setup.service.retry();
  assert.equal(recovered.state, 'ready');
  assert.ok(removed.includes('c'.repeat(64)));
  assert.deepEqual(settlements, [{ status: 'failed', cleanup: 'uncertain' },
    { status: 'failed', cleanup: 'confirmed' }]);
  assert.equal(setup.service.pendingRuntimeCleanup, null);
  await setup.service.retry();
  assert.equal(settlements.length, 2);
});

test('settings changes require quiescence across active work, transitions, and backend streams', async (t) => {
  const active = await readyService(t);
  active.service.active = { controller: new AbortController() };
  await assert.rejects(active.service.setEnabled({ enabled: false }), (error) => error.reason === 'sandbox_wait_for_active_chats');

  const transition = await readyService(t);
  transition.service.transition = new Promise(() => {});
  await assert.rejects(transition.service.setEnabled({ enabled: false }), (error) => error.reason === 'sandbox_wait_for_active_chats');
  transition.service.transition = null;

  const backend = await readyService(t, { getBackend: () => ({ activeStreams: new Map([['stream', {}]]) }) });
  await assert.rejects(backend.service.setEnabled({ enabled: false }), (error) => error.reason === 'sandbox_wait_for_active_chats');
});

test('missing Docker is unavailable and never falls back to a host launcher', async (t) => {
  const launcher = fakeLauncher({ detectError: sandboxError('docker_missing') });
  const setup = await fixture(t, { enabled: true });
  const service = new DesktopSandboxService({
    userDataPath: setup.base,
    sourceRoot: setup.base,
    configService: setup.config,
    launcherFactory: () => launcher,
    buildContext: async () => { throw new Error('must not build without Docker'); },
  });
  t.after(() => service.close().catch(() => {}));
  const state = await service.retry();
  assert.equal(state.state, 'unavailable');
  assert.equal(state.reason, 'docker_missing');
  assert.deepEqual(launcher.calls, [['detect']]);
});

// F22 (1.2.0 gate C3 attempt 3): switching the sandbox on while Docker is not
// running launched nothing, so its maintenance lease must not stay quarantined
// and leave the runtime reading busy (it also refused switching back off).
test('switching on without Docker leaves no held lease and can switch back off', async (t) => {
  const broker = new ResourceBroker({ limits: { native_processes: 1, sandbox_commands: 1 } });
  const sessionRuntime = { resourceBroker: broker,
    hasPendingOrAdmittedWork: () => broker.snapshot().lease_count > 0 };
  const setup = await fixture(t, { getBackend: () => ({ sessionRuntime }) });
  const service = new DesktopSandboxService({
    userDataPath: setup.base, sourceRoot: setup.base, configService: setup.config,
    getBackend: setup.getBackend, launcherFactory: () => fakeLauncher({ detectError: sandboxError('docker_operation_failed') }),
  });
  t.after(() => service.close().catch(() => {}));
  await assert.rejects(service.setEnabled({ enabled: true }), (error) => error.reason === 'docker_operation_failed');
  assert.equal(service.getState().state, 'unavailable');
  assert.equal(broker.snapshot().lease_count, 0);
  assert.equal((await service.setEnabled({ enabled: false })).state, 'disabled');
});

// Astra review of F22: a worker whose removal failed stays unconfirmed even when
// Docker is gone by the time the user switches off (after a backend restart freed the
// quarantined lease); only a later confirmed reconcile clears it.
test('an unconfirmed worker keeps the lease when Docker disappears before switching off', async (t) => {
  const broker = new ResourceBroker({ limits: { native_processes: 1, sandbox_commands: 1 } });
  const sessionRuntime = { resourceBroker: broker, hasPendingOrAdmittedWork: () => false };
  const launcher = fakeLauncher({ cleanupError: sandboxError('sandbox_cleanup_unconfirmed') });
  const setup = await fixture(t, { enabled: true, getBackend: () => ({ sessionRuntime }) });
  const service = new DesktopSandboxService({
    userDataPath: setup.base, sourceRoot: setup.base, configService: setup.config, getBackend: setup.getBackend,
    launcherFactory: () => launcher, buildContext: async () => ({ directory: setup.base, digest: 'b'.repeat(64) }),
  });
  service._worker = async () => ({ containerId: 'c'.repeat(64), transport: { dispose() {} } });
  t.after(() => service.close().catch(() => {}));
  assert.equal((await service.retry()).state, 'recovery-required');
  broker.confirmCleanup(service.maintenanceResources.lease); // what a backend restart does
  launcher.detect = async () => { throw sandboxError('docker_operation_failed'); };
  await assert.rejects(service.setEnabled({ enabled: false }));
  assert.equal(broker.snapshot().lease_count, 1, 'the maintenance lease stays held');
  assert.notEqual(service.getState().state, 'disabled');
});

test('admission is bound to session, workspace, snapshot, policy, container, and worker incarnation', async (t) => {
  const setup = await readyService(t);
  const workers = attachFakeWorker(setup.service);
  let binding = null;
  const input = { command: 'printf hello', cwd: 'src', timeoutSeconds: 4, expectedExitCodes: [0] };
  const result = await setup.service.execute(input, {
    projectAuthority: setup.authority,
    sessionId: 'session-1', streamId: 'stream-1', callId: 'call-1',
    isLive: () => true,
  }, async (candidate, live) => {
    binding = { ...candidate };
    live();
    return { approved: true, digest: 'approval-digest', validate() {} };
  });
  assert.equal(result.status, 'completed');
  assert.equal(binding.session_id, 'session-1');
  assert.equal(binding.stream_id, 'stream-1');
  assert.equal(binding.tool_call_id, 'call-1');
  assert.equal(binding.command_digest, digest({ command: 'printf hello', cwd: 'src', timeoutSeconds: 4, expectedExitCodes: [0] }));
  assert.equal(binding.policy_generation, 0);
  assert.equal(binding.workspace_generation, 0);
  assert.equal(binding.workspace_id, digest(path.resolve(setup.workspace)));
  assert.equal(binding.snapshot_id.length, 36);
  assert.match(binding.snapshot_digest, /^[a-f0-9]{64}$/u);
  assert.equal(binding.container_id, 'c'.repeat(64));
  assert.equal(binding.image_id, setup.service.imageId);
  assert.match(binding.job_id, /^[0-9a-f-]{36}$/u);
  assert.equal(binding.incarnation, '11111111-1111-4111-8111-111111111111');
  assert.equal(workers[0].transport.disposed, true);
});

test('stale workspace and stale approval cannot submit a command', async (t) => {
  const snapshotGate = deferred();
  const setup = await readyService(t, { snapshot: async () => snapshotGate.promise });
  const workers = attachFakeWorker(setup.service);
  const first = setup.service.execute({ command: 'echo stale' }, {
    projectAuthority: setup.authority,
    sessionId: 'session', streamId: 'stream', callId: 'stale-workspace', isLive: () => true,
  }, async () => ({ approved: true, digest: 'approval', validate() {} }));
  await new Promise((resolve) => setImmediate(resolve));
  const changedRoot = path.join(setup.base, 'new-workspace');
  await fs.mkdir(changedRoot);
  setup.currentAuthority = { ...setup.authority, root_path: changedRoot, root_revision: 1 };
  const snapshotId = randomUUID();
  const snapshotDirectory = path.join(setup.service.stagingRoot, snapshotId);
  await fs.mkdir(snapshotDirectory, { recursive: true });
  snapshotGate.resolve({ id: snapshotId, directory: snapshotDirectory, digest: digest('stale') });
  await assert.rejects(first, (error) => error.reason === 'sandbox_stale_authority');
  assert.equal(workers.length, 0);

  const approval = await readyService(t);
  const approvalWorkers = attachFakeWorker(approval.service, { validateError: sandboxError('sandbox_stale_authority') });
  await assert.rejects(approval.service.execute({ command: 'echo approval' }, {
    projectAuthority: approval.authority,
    sessionId: 'session', streamId: 'stream', callId: 'stale-approval', isLive: () => true,
  }, async () => ({ approved: true, digest: 'approval', validate() { throw sandboxError('sandbox_stale_authority'); } })),
  (error) => error.reason === 'sandbox_stale_authority');
  assert.equal(approvalWorkers.length, 1);
  assert.equal(approvalWorkers[0].transport.disposed, true);
});

test('duplicate requests are rejected and concurrent requests are never queued', async (t) => {
  const gate = deferred();
  const setup = await readyService(t);
  attachFakeWorker(setup.service, { executeGate: gate });
  const input = { command: 'echo once' };
  const first = setup.service.execute(input, { projectAuthority: setup.authority, sessionId: 's', streamId: 'stream', callId: 'call', isLive: () => true }, async () => ({ approved: true, digest: 'a', validate() {} }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(setup.service.execute(input, { projectAuthority: setup.authority, sessionId: 's', streamId: 'stream', callId: 'other', isLive: () => true }, async () => ({ approved: true })),
    (error) => error.reason === 'sandbox_unavailable');
  gate.resolve();
  await first;
  await assert.rejects(setup.service.execute(input, { projectAuthority: setup.authority, sessionId: 's', streamId: 'stream', callId: 'call', isLive: () => true }, async () => ({ approved: true })),
    (error) => error.reason === 'sandbox_duplicate_request');
});

test('cancellation drains the active stream and restart reconciles an admitted job', async (t) => {
  const gate = deferred();
  const setup = await readyService(t);
  attachFakeWorker(setup.service, { executeGate: gate });
  const signal = new AbortController();
  const run = setup.service.execute({ command: 'echo cancel' }, {
    projectAuthority: setup.authority,
    sessionId: 'session', streamId: 'cancel-stream', callId: 'cancel', signal: signal.signal, isLive: () => true,
  }, async () => ({ approved: true, digest: 'approval', validate() {} }));
  await new Promise((resolve) => setImmediate(resolve));
  signal.abort();
  gate.resolve();
  await assert.rejects(run, (error) => error.reason === 'sandbox_stale_authority');
  await setup.service.drainStream('cancel-stream');

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-desktop-sandbox-restart-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const pending = { job_id: '22222222-2222-4222-8222-222222222222', incarnation: '33333333-3333-4333-8333-333333333333' };
  const nextIncarnation = '44444444-4444-4444-8444-444444444444';
  const calls = [];
  const broker = new ExecutionBroker({
    userDataPath: directory,
    readReceiptImpl: () => ({ schema_version: 1, pending }),
    writeReceiptImpl: (_file, receipt) => { calls.push(['write', receipt]); },
    request: async (operation, fields) => {
      calls.push([operation, fields]);
      if (operation === 'cancel') return { ok: true };
      return { incarnation: nextIncarnation, phase: 'ready', job_id: null, previous_result: {
        schema_version: 1, incarnation: pending.incarnation, job_id: pending.job_id, status: 'interrupted',
        exit_code: null, stdout: '', stderr: '', output_truncated: false, reason: 'interrupted',
      } };
    },
    wait: async () => {},
  });
  await broker.prepare();
  assert.equal(broker.status().available, true);
  assert.equal(calls[0][0], 'cancel');
  const cleared = calls.findLast((call) => call[0] === 'write');
  assert.equal(cleared[1].pending, null);
});

test('cleanup failure prevents a service from becoming ready', async (t) => {
  const launcher = fakeLauncher({ cleanupError: sandboxError('sandbox_cleanup_unconfirmed') });
  const setup = await fixture(t, { enabled: true });
  const service = new DesktopSandboxService({
    userDataPath: setup.base,
    sourceRoot: setup.base,
    configService: setup.config,
    launcherFactory: () => launcher,
    buildContext: async () => ({ directory: setup.base, digest: 'b'.repeat(64) }),
  });
  service._worker = async () => ({ containerId: 'c'.repeat(64), transport: { dispose() {} } });
  t.after(() => service.close().catch(() => {}));
  const state = await service.retry();
  assert.notEqual(state.state, 'ready');
  assert.equal(state.reason, 'sandbox_cleanup_unconfirmed');
});

test('owned cleanup failure without an admission journal still requires recovery', async t => {
 const setup = await readyService(t);
 setup.launcher.listOwned = async () => ['c'.repeat(64)];
 setup.launcher.stopAndRemove = async () => { throw sandboxError('docker_operation_failed'); };
 const state = await setup.service.retry();
 assert.equal(state.state, 'recovery-required');
 assert.equal(state.reason, 'sandbox_cleanup_unconfirmed');
 assert.equal(setup.service.receipts.pending().length, 0);
});

test('UI workspace changes neither retarget nor cancel a captured sandbox command', async t => {
 const setup = await readyService(t);
 const workers = attachFakeWorker(setup.service);
 let copiedRoot;
 setup.service.snapshot = async options => {
  copiedRoot = options.root;
  setup.config.setWorkspaceRoot(path.join(setup.base, 'unrelated-ui-folder'));
  assert.equal(options.signal.aborted, false);
  return stagedSnapshot(setup.workspace)(options);
 };
 const result = await setup.service.execute({ command: 'echo scoped' }, {
  sessionId: 'session', streamId: 'stream', callId: 'scoped', projectAuthority: setup.authority,
 }, async binding => {
  assert.equal(binding.project_id, setup.authority.project_id);
  return { approved: true, digest: 'approval' };
 });
 assert.equal(result.status, 'completed');
 assert.equal(copiedRoot, setup.workspace);
 assert.equal(workers.length, 1);
});

test('missing and null-root authority cannot allocate a snapshot or worker', async t => {
 const setup = await readyService(t);
 const workers = attachFakeWorker(setup.service);
 setup.service.snapshot = async () => assert.fail('must not snapshot');
 const context = { sessionId: 'session', streamId: 'stream', callId: 'unbound' };
 await assert.rejects(setup.service.execute({ command: 'echo fail' }, context, async () => true),
  error => error.reason === 'sandbox_authority_invalid');
 setup.currentAuthority = { ...setup.authority, root_path: null, root_id: null };
 await assert.rejects(setup.service.execute({ command: 'echo fail' }, {
  ...context, projectAuthority: setup.currentAuthority,
 }, async () => true), error => error.reason === 'sandbox_workspace_required');
 assert.equal(workers.length, 0);
 assert.equal(setup.service.active, null);
});

test('project rebinding during approval prevents dispatch and confirms worker cleanup', async t => {
 const setup = await readyService(t);
 const workers = attachFakeWorker(setup.service);
 await assert.rejects(setup.service.execute({ command: 'echo stale' }, {
  sessionId: 'session', streamId: 'stream', callId: 'rebind', projectAuthority: setup.authority,
 }, async () => {
  setup.currentAuthority = { ...setup.authority, root_revision: 1 };
  return { approved: true, digest: 'approval' };
 }), error => error.reason === 'sandbox_stale_authority');
 assert.equal(workers.length, 1);
 assert.equal(workers[0].transport.disposed, true);
 assert.equal(setup.launcher.calls.some(call => call[0] === 'stopAndRemove'), true);
 assert.equal(setup.service.state, 'ready');
});
