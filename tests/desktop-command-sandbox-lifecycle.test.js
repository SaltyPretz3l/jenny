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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function fixture(t, { enabled = false, root = null, getBackend = () => null } = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-desktop-sandbox-lifecycle-'));
  const workspace = root || path.join(base, 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  const config = Object.assign(new EventEmitter(), {
    state: { toolsWorkspaceRoot: workspace, commandSandbox: { enabled } },
    getState() { return this.state; },
    updateCommandSandbox(patch) {
      this.state = { ...this.state, commandSandbox: { enabled: patch.enabled } };
      this.emit('changed');
    },
    setWorkspaceRoot(value) {
      this.state = { ...this.state, toolsWorkspaceRoot: value };
      this.emit('changed');
    },
  });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, workspace, config, getBackend };
}

function fakeLauncher({ detectError = null, cleanupError = null } = {}) {
  const calls = [];
  const launcher = {
    endpoint: 'unix:///var/run/docker.sock',
    calls,
    async detect() {
      calls.push(['detect']);
      if (detectError) throw detectError;
      return { engine: 'linux', architecture: 'amd64' };
    },
    async listOwned() { calls.push(['listOwned']); return []; },
    async build() { calls.push(['build']); return 'sha256:' + 'a'.repeat(64); },
    async ensureVolume() { calls.push(['ensureVolume']); },
    async create() { calls.push(['create']); return 'c'.repeat(64); },
    async stopAndRemove(id) {
      calls.push(['stopAndRemove', id]);
      if (cleanupError) throw cleanupError;
      return { cleanupConfirmed: true };
    },
  };
  return launcher;
}

function stagedSnapshot(base) {
  return async ({ stagingRoot }) => {
    await fs.mkdir(stagingRoot, { recursive: true });
    const id = randomUUID();
    const directory = path.join(stagingRoot, id);
    await fs.mkdir(directory);
    return { id, directory, digest: digest([]), root: base };
  };
}

async function readyService(t, options = {}) {
  const setup = await fixture(t, options);
  const launcher = options.launcher || fakeLauncher();
  const service = new DesktopSandboxService({
    userDataPath: setup.base,
    sourceRoot: setup.base,
    configService: setup.config,
    getBackend: setup.getBackend,
    launcherFactory: () => launcher,
    snapshot: options.snapshot || stagedSnapshot(setup.workspace),
    buildContext: async () => ({ directory: setup.base, digest: 'b'.repeat(64) }),
    platform: 'win32',
  });
  service.enabled = true;
  service.state = 'ready';
  service.launcher = launcher;
  service.receipts = new ExecutionReceipts(service.directory);
  service.imageId = 'sha256:' + 'a'.repeat(64);
  t.after(() => service.close().catch(() => {}));
  return { ...setup, launcher, service };
}

function attachFakeWorker(service, { executeGate = null, validateError = null, result = null } = {}) {
  const workers = [];
  service._worker = async (_snapshot, binding) => {
    const transport = {
      admissionCheck: null,
      async request(operation) {
        assert.equal(operation, 'status');
        return { incarnation: '11111111-1111-4111-8111-111111111111' };
      },
      dispose() { this.disposed = true; },
    };
    Object.assign(binding, { container_id: 'c'.repeat(64), image_id: service.imageId });
    const worker = {
      containerId: binding.container_id,
      transport,
      broker: {
        async execute() {
          await transport.admissionCheck?.();
          if (validateError) throw validateError;
          if (executeGate) await executeGate.promise;
          return result || { status: 'completed', exit_code: 0, stdout: 'ok', stderr: '', output_truncated: false };
        },
      },
    };
    workers.push(worker);
    return worker;
  };
  return workers;
}

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

test('admission is bound to session, workspace, snapshot, policy, container, and worker incarnation', async (t) => {
  const setup = await readyService(t);
  const workers = attachFakeWorker(setup.service);
  let binding = null;
  const input = { command: 'printf hello', cwd: 'src', timeoutSeconds: 4, expectedExitCodes: [0] };
  const result = await setup.service.execute(input, {
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
    sessionId: 'session', streamId: 'stream', callId: 'stale-workspace', isLive: () => true,
  }, async () => ({ approved: true, digest: 'approval', validate() {} }));
  await new Promise((resolve) => setImmediate(resolve));
  const changedRoot = path.join(setup.base, 'new-workspace');
  await fs.mkdir(changedRoot);
  setup.config.setWorkspaceRoot(changedRoot);
  const snapshotId = randomUUID();
  const snapshotDirectory = path.join(setup.service.stagingRoot, snapshotId);
  await fs.mkdir(snapshotDirectory, { recursive: true });
  snapshotGate.resolve({ id: snapshotId, directory: snapshotDirectory, digest: digest('stale') });
  await assert.rejects(first, (error) => error.reason === 'sandbox_stale_authority');
  assert.equal(workers.length, 0);

  const approval = await readyService(t);
  const approvalWorkers = attachFakeWorker(approval.service, { validateError: sandboxError('sandbox_stale_authority') });
  await assert.rejects(approval.service.execute({ command: 'echo approval' }, {
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
  const first = setup.service.execute(input, { sessionId: 's', streamId: 'stream', callId: 'call', isLive: () => true }, async () => ({ approved: true, digest: 'a', validate() {} }));
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(setup.service.execute(input, { sessionId: 's', streamId: 'stream', callId: 'other', isLive: () => true }, async () => ({ approved: true })),
    (error) => error.reason === 'sandbox_unavailable');
  gate.resolve();
  await first;
  await assert.rejects(setup.service.execute(input, { sessionId: 's', streamId: 'stream', callId: 'call', isLive: () => true }, async () => ({ approved: true })),
    (error) => error.reason === 'sandbox_duplicate_request');
});

test('cancellation drains the active stream and restart reconciles an admitted job', async (t) => {
  const gate = deferred();
  const setup = await readyService(t);
  attachFakeWorker(setup.service, { executeGate: gate });
  const signal = new AbortController();
  const run = setup.service.execute({ command: 'echo cancel' }, {
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
