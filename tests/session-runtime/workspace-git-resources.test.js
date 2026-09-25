'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createContainedGitRunner } = require('../../services/contained-git-runner');
const { PhysicalPathResolver } = require('../../services/session-runtime/physical-paths');
const {
  ResourceBroker,
  capacityResource,
} = require('../../services/session-runtime/resource-broker');
const { WorkspaceGitService } = require('../../services/workspace-git-service');
const { createWorkspaceGitResources } = require('../../services/workspace-git-resources');

function deferred() {
  let resolve;
  const promise = new Promise(value => { resolve = value; });
  return { promise, resolve };
}

async function roots(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'jenny-git-resources-'));
  const first = path.join(base, 'first');
  const second = path.join(base, 'second');
  await fs.mkdir(first);
  await fs.mkdir(second);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { first, second };
}

function runtime(limits = {}) {
  const broker = new ResourceBroker({
    limits: { tool_operations: 2, native_processes: 1, tests: 1, sandbox_commands: 1, ...limits },
  });
  const pathResolver = new PhysicalPathResolver();
  return { broker, pathResolver, provider: () => ({ broker, pathResolver }) };
}

test('resource-admitted Workspace Git rejects an uncontained executor before use', async t => {
  const { first } = await roots(t);
  const admission = runtime();
  assert.throws(() => new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => first },
    featureFlagProvider: () => ({ workspace_git: true }),
    exec: async () => ({ success: true }),
    resourceAdmissionProvider: admission.provider,
  }), /contained Git runner/i);
});

test('Workspace Git atomically holds native and physical-root resources across every child', async t => {
  const { first, second } = await roots(t);
  const admission = runtime();
  const resources = createWorkspaceGitResources({ resourceAdmissionProvider: admission.provider });
  const started = deferred();
  const finish = deferred();
  const exec = resources.wrapExecutor(async () => {
    started.resolve();
    await finish.promise;
    return { success: true, cleanupConfirmed: true };
  });
  const firstRun = resources.run({ root: first, validate: () => true }, () => exec());
  await started.promise;
  assert.deepEqual(admission.broker.snapshot().capacity, {
    tool_operations: 0, native_processes: 1, tests: 0, sandbox_commands: 0,
  });

  let secondStarted = false;
  const controller = new AbortController();
  const secondRun = resources.run({ root: second, signal: controller.signal, validate: () => true }, async () => {
    secondStarted = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(admission.broker.snapshot().waiter_count, 1);
  controller.abort();
  await assert.rejects(secondRun, error => error.reason === 'cancelled');
  assert.equal(secondStarted, false);

  finish.resolve();
  await firstRun;
  assert.equal(admission.broker.snapshot().lease_count, 0);
});

test('Workspace Git revalidates authority after a resource wait and before spawning', async t => {
  const { first } = await roots(t);
  const admission = runtime();
  const held = await admission.broker.acquire({ ownerId: 'holder', resources: [
    capacityResource('native_processes'),
  ] });
  let current = true;
  let spawned = false;
  const resources = createWorkspaceGitResources({ resourceAdmissionProvider: admission.provider });
  const exec = resources.wrapExecutor(async () => {
    spawned = true;
    return { cleanupConfirmed: true };
  });
  const pending = resources.run({ root: first, validate: () => current }, () => exec());
  await new Promise(resolve => setImmediate(resolve));
  current = false;
  admission.broker.release(held, { producerSettled: true });
  await assert.rejects(pending, error => error.reason === 'root_changed');
  assert.equal(spawned, false);
  assert.equal(admission.broker.snapshot().lease_count, 0);
});

test('Workspace Git quarantines an operation when contained cleanup remains unconfirmed', async t => {
  const { first } = await roots(t);
  const admission = runtime();
  const resources = createWorkspaceGitResources({ resourceAdmissionProvider: admission.provider });
  let retries = 0;
  const exec = resources.wrapExecutor(async () => ({
    cleanupConfirmed: false,
    retryCleanup: async () => { retries += 1; return { confirmed: false }; },
  }));
  await resources.run({ root: first, validate: () => true }, () => exec());
  assert.equal(retries, 1);
  assert.equal(admission.broker.snapshot().quarantined_count, 1);
});

test('WorkspaceGitService holds one lease across repo detection and the requested Git command', async t => {
  const { first } = await roots(t);
  const admission = runtime({ native_processes: 2 });
  const observed = [];
  const contained = createContainedGitRunner({
    containedProcessRunner: {
      async runGit({ args }) {
        observed.push({ args, capacity: admission.broker.snapshot().capacity.native_processes });
        const stdout = args.includes('--is-inside-work-tree') ? 'true\n'
          : args.includes('--show-toplevel') ? `${first}\n` : '## main\0';
        return { status: 'passed', returnCode: 0, stdout, stderr: '', cleanupConfirmed: true };
      },
    },
  });
  const service = new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => first },
    featureFlagProvider: () => ({ workspace_git: true }),
    exec: contained,
    resourceAdmissionProvider: admission.provider,
  });
  const result = await service.getStatus();
  assert.equal(result.ok, true);
  assert.equal(observed.length, 3);
  assert.deepEqual(observed.map(item => item.capacity), [1, 1, 1]);
  assert.equal(admission.broker.snapshot().lease_count, 0);
});

test('contained Git preserves exact bounded output and rejects overflow without truncating it', async () => {
  const calls = [];
  const contained = createContainedGitRunner({
    containedProcessRunner: {
      async runGit(options) {
        calls.push(options);
        return {
          status: 'passed', returnCode: 0, stdout: '12345', stderr: '',
          cleanupConfirmed: true,
        };
      },
    },
  });
  const result = await contained('C:\\repo', ['status'], {
    input: Buffer.from('input'), maxBuffer: 4,
  });
  assert.equal(result.success, false);
  assert.equal(result.stdout, '12345');
  assert.match(result.message, /output exceeded/i);
  assert.deepEqual(calls[0].args, ['status']);
  assert.equal(calls[0].scrubEnv, true);
  assert.equal(calls[0].maxBuffer, 4);
});
