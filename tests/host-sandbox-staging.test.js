'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');

const UUID = /^[a-f0-9-]{36}$/u;

function binding(rootPath) {
  const authority = Object.freeze({ project_id: 'project_test', root_path: rootPath,
    root_id: 'root_test', root_revision: 1, device_id: null, inode: null });
  return new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => authority, requireCurrent: () => authority },
    permissionStore: { getSnapshot: () => ({ version: 3, legacy_policies: { run_command: 'auto' }, rules: [] }) },
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  }).captureSession('session-1', { requestId: 'stream-1' });
}

function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-staging-'));
  const workspace = path.join(base, 'workspace');
  const project = path.join(workspace, 'alpha');
  const sibling = path.join(workspace, 'beta');
  const staging = path.join(base, 'staging');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(project, 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'beta');
  return { base, workspace, project, staging,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function service(broker, fx, { staging = fx.staging } = {}) {
  return {
    hostMode: 'server',
    options: { hostExecutionPolicyVersion: 2, hostExecutionBroker: broker,
      ...(staging ? { hostExecutionStagingRoot: staging } : {}),
      userDataPath: path.join(fx.base, 'profile') },
    configService: { getToolsWorkspaceRoot: () => fx.workspace },
    toolExecutor: { async executePreApproved() { throw new Error('must not use sidecar'); } },
  };
}

function run(svc, fx) {
  return executeElectronToolRequest(svc, {
    params: { tool_name: 'run_command', plan_mode: false, read_only: false,
      arguments: { command: 'ls' }, request_id: 'stream-1' },
    sessionId: 'session-1', streamId: 'stream-1', executionAuthority: binding(fx.project),
  });
}

const OK = { status: 'completed', exit_code: 0, stdout: 'ok', stderr: '', success: true, cleanup_confirmed: true };

test('worker input root is the staged snapshot, never the project path in the workspace', async () => {
  const fx = fixture();
  try {
    let seen = null;
    const broker = { status: () => ({ available: true }), async execute(input, context) {
      await context.beforeAdmission();
      const staged = path.join(fx.staging, input.inputRoot);
      seen = { inputRoot: input.inputRoot, files: fs.readdirSync(staged), exists: fs.existsSync(staged) };
      return OK;
    } };
    const result = await run(service(broker, fx), fx);
    assert.equal(result.success, true);
    assert.match(seen.inputRoot, UUID);
    assert.notEqual(seen.inputRoot, 'alpha');
    assert.equal(seen.exists, true);
    assert.deepEqual(seen.files, ['a.txt']);
    assert.deepEqual(fs.readdirSync(fx.staging), []);
  } finally { fx.cleanup(); }
});

test('staging failure fails closed and never submits a command', async () => {
  const fx = fixture();
  try {
    // Like the real broker: staging runs in beforeAdmission, submit only after it.
    let submitted = false;
    const broker = { status: () => ({ available: true }), async execute(_input, context) {
      await context.beforeAdmission(); submitted = true; return OK;
    } };
    // Staging root inside the project is rejected by the snapshot module.
    const inside = path.join(fx.project, 'stage');
    const bad = await run(service(broker, fx, { staging: inside }), fx);
    assert.equal(bad.success, false);
    assert.match(bad.output, /snapshot_stage_inside_workspace/);
    const missing = await run(service(broker, fx, { staging: null }), fx);
    assert.equal(missing.success, false);
    assert.match(missing.output, /execution_staging_unavailable/);
    assert.equal(submitted, false);
  } finally { fx.cleanup(); }
});

test('staged snapshot is removed after worker failure and throw', async () => {
  const fx = fixture();
  try {
    const failing = { status: () => ({ available: true }), async execute(_input, context) {
      await context.beforeAdmission();
      return { ...OK, success: false, exit_code: 1 };
    } };
    assert.equal((await run(service(failing, fx), fx)).success, false);
    assert.deepEqual(fs.readdirSync(fx.staging), []);
    const throwing = { status: () => ({ available: true }), async execute() {
      throw Object.assign(new Error('x'), { reason: 'sandbox_timeout' });
    } };
    assert.equal((await run(service(throwing, fx), fx)).success, false);
    assert.deepEqual(fs.readdirSync(fx.staging), []);
  } finally { fx.cleanup(); }
});

test('stale staging entries are purged before staging', async () => {
  const fx = fixture();
  try {
    const stale = path.join(fx.staging, '11111111-1111-1111-1111-111111111111');
    fs.mkdirSync(stale);
    fs.writeFileSync(path.join(stale, 'old.txt'), 'old');
    fs.writeFileSync(path.join(fx.staging, 'junk.txt'), 'x');
    let during = null;
    const broker = { status: () => ({ available: true }), async execute(input, context) {
      await context.beforeAdmission();
      during = fs.readdirSync(fx.staging);
      assert.equal(during.length, 1);
      assert.equal(during[0], input.inputRoot);
      return OK;
    } };
    assert.equal((await run(service(broker, fx), fx)).success, true);
    assert.deepEqual(fs.readdirSync(fx.staging), []);
  } finally { fx.cleanup(); }
});

test('a running job never sees a second job staged beside it', async () => {
  const fx = fixture();
  try {
    let releaseFirst;
    const firstRunning = new Promise((resolve) => {
      const broker = { status: () => ({ available: true }), async execute(input, context) {
        await context.beforeAdmission();
        if (!releaseFirst) {
          await new Promise((done) => { releaseFirst = done; resolve(); });
        }
        return { ...OK, stdout: fs.readdirSync(fx.staging).join(',') };
      } };
      fx.svc = service(broker, fx);
    });
    const first = run(fx.svc, fx);
    await firstRunning;
    const second = run(fx.svc, fx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.readdirSync(fx.staging).length, 1, 'second job must not stage while the first runs');
    releaseFirst();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.output.split(',').length, 1);
    assert.equal(b.output.split(',').length, 1);
    assert.deepEqual(fs.readdirSync(fx.staging), []);
  } finally { fx.cleanup(); }
});

function blockingBroker(fx, { onSecond } = {}) {
  const state = { available: true, calls: 0, release: null, running: null };
  state.running = new Promise((resolve) => {
    state.broker = { status: () => ({ available: state.available }), async execute(input, context) {
      state.calls += 1;
      await context.beforeAdmission();
      if (state.calls === 1) await new Promise((done) => { state.release = done; resolve(); });
      else onSecond?.();
      return OK;
    } };
  });
  return state;
}

test('a job queued behind a worker that became unavailable never stages', async () => {
  const fx = fixture();
  try {
    const state = blockingBroker(fx);
    const svc = service(state.broker, fx);
    const first = run(svc, fx);
    await state.running;
    const second = run(svc, fx);
    state.available = false;
    state.release();
    const [, b] = await Promise.all([first, second]);
    assert.equal(b.success, false);
    assert.match(b.output || b.error || JSON.stringify(b), /sandbox_unavailable/);
    assert.equal(state.calls, 1);
    assert.deepEqual(fs.readdirSync(fx.staging), []);
  } finally { fx.cleanup(); }
});

test('an aborted job stops waiting for the staging lock', async () => {
  const fx = fixture();
  try {
    const state = blockingBroker(fx);
    const svc = service(state.broker, fx);
    const first = run(svc, fx);
    await state.running;
    const controller = new AbortController();
    const second = executeElectronToolRequest(svc, {
      params: { tool_name: 'run_command', plan_mode: false, read_only: false,
        arguments: { command: 'ls' }, request_id: 'stream-1' },
      sessionId: 'session-1', streamId: 'stream-1', executionAuthority: binding(fx.project),
      abortSignal: controller.signal,
    });
    controller.abort();
    const b = await second;
    assert.equal(b.success, false);
    assert.match(b.output || b.error || JSON.stringify(b), /sandbox_cancelled/);
    assert.equal(fs.readdirSync(fx.staging).length, 1, 'first job keeps its staged copy');
    state.release();
    assert.equal((await first).success, true);
    assert.deepEqual(fs.readdirSync(fx.staging), []);
  } finally { fx.cleanup(); }
});

test('hosted staging keeps POSIX-legal names that desktop rejects', { skip: process.platform === 'win32' }, async () => {
  const fx = fixture();
  try {
    fs.writeFileSync(path.join(fx.project, 'log:2026.txt'), 'x');
    fs.writeFileSync(path.join(fx.project, 'back\\slash.txt'), 'y');
    let files = null;
    const broker = { status: () => ({ available: true }), async execute(input, context) {
      await context.beforeAdmission();
      files = fs.readdirSync(path.join(fx.staging, input.inputRoot)).sort();
      return OK;
    } };
    const result = await run(service(broker, fx), fx);
    assert.equal(result.success, true);
    assert.deepEqual(files, ['a.txt', 'back\\slash.txt', 'log:2026.txt']);
  } finally { fx.cleanup(); }
});

test('staging happens only after resource admission and the authority check', async () => {
  const fx = fixture();
  try {
    const order = [];
    const broker = { status: () => ({ available: true }), async execute(input, context) {
      order.push(fs.existsSync(path.join(fx.staging, input.inputRoot)) ? 'staged-early' : 'not-staged');
      await context.beforeAdmission();
      order.push(fs.existsSync(path.join(fx.staging, input.inputRoot)) ? 'staged' : 'missing');
      return OK;
    } };
    const result = await run(service(broker, fx), fx);
    assert.equal(result.success, true);
    assert.deepEqual(order, ['not-staged', 'staged']);
  } finally { fx.cleanup(); }
});
