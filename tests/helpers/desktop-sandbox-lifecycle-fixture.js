'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const { DesktopSandboxService } = require('../../services/execution/desktop-sandbox-service');
const { ExecutionReceipts } = require('../../services/execution/execution-receipts');
const { digest, sandboxError } = require('../../services/execution/sandbox-errors');
const { SessionExecutionAuthority } = require('../../services/backend/session-execution-authority');
const { ResourceBroker } = require('../../services/session-runtime/resource-broker');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const { ToolResourceOperations } = require('../../services/session-runtime/resource-operations');
const { createToolResourceClaim } = require('../../services/tools/tool-resource-execution');

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
  setup.authority = Object.freeze({ project_id: 'project_test', root_path: setup.workspace,
    root_id: 'root', root_revision: 0, device_id: null, inode: null });
  setup.currentAuthority = setup.authority;
  const projectAuthority = {
    captureSession: () => setup.currentAuthority,
    requireCurrent: authority => assert.deepEqual(authority, setup.currentAuthority),
  };
  const launcher = options.launcher || fakeLauncher();
  const service = new DesktopSandboxService({
    userDataPath: setup.base,
    sourceRoot: setup.base,
    configService: setup.config,
    getBackend: () => ({ ...setup.getBackend(), projectAuthority }),
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
  return Object.assign(setup, { launcher, service });
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
        async execute(_args, options = {}) {
          await options.beforeAdmission?.();
          await transport.admissionCheck?.();
          worker.commandCount = (worker.commandCount || 0) + 1;
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

function runtimeResources(setup) {
  const owner = new SessionExecutionAuthority({ projectAuthority: setup.service.getBackend().projectAuthority,
    permissionStore: { getSnapshot: () => ({ version: 2, legacy_policies: { run_command: 'auto' }, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}) });
  const binding = owner.captureSession('session', { requestId: 'stream' });
  const broker = new ResourceBroker({ limits: { native_processes: 1 } });
  const pathResolver = new PhysicalPathResolver();
  const gateway = new ToolResourceOperations({ broker, pathResolver, executionAuthority: owner,
    binding, sandboxCommands: true });
  const resourceClaim = createToolResourceClaim({ binding, operationId: 'call',
    toolName: 'run_command', input: { command: 'true' }, required: true });
  return { broker, pathResolver, gateway, resourceClaim };
}

module.exports = { deferred, fixture, fakeLauncher, stagedSnapshot, readyService, attachFakeWorker, runtimeResources };
