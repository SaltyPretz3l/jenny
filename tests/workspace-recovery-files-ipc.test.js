'use strict';

// Row 34 S5 step 4: the new workspaceRecovery file methods at the Electron
// edge - registration, strict payloads, null-safe service wiring, and the
// guarantee that undoChangeSet without the new flag sends the sidecar exactly
// what it sent before.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const { registerWorkspaceRecoveryIpcHandlers } = require('../services/workspace-recovery-ipc-handlers');
const { getBridgeChannel } = require('../services/ipc-contract');
const { API_VERSION } = require('../services/backend/sidecar-client');
const { cleanupTrackedResources, createTrackedTempDir } = require('./helpers/resource-cleanup');
const { createRecoveryHarness } = require('./helpers/workspace-recovery-harness');

const CHANGE_SET_ID = '01990f9a-8c51-7ad2-a8be-41190e0e2525';
const NEW_METHODS = [
  'workspaceRecovery.preflightCheckpointFiles',
  'workspaceRecovery.restoreCheckpointFiles',
  'workspaceRecovery.preflightSafetyCopy',
  'workspaceRecovery.restoreSafetyCopy',
];

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function outsideUndoSet() {
  return { shell_mutations: '', explorer_rename: '', known_unjournaled_events: [], warning: '' };
}

function preflight(plan = []) {
  return {
    change_set_id: CHANGE_SET_ID, status: 'preflight', conflicts: [], inverse_plan: plan,
    staging_entries: [], outside_undo_set: outsideUndoSet(),
  };
}

function receipt() {
  return {
    change_set_id: CHANGE_SET_ID, status: 'committed', restored: [], skipped: [], renamed_to: [],
    protected: [], outside_undo_set: outsideUndoSet(),
  };
}

function register({ request, gitService = null, ideService = null } = {}) {
  const handlers = new Map();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike: { handle: (channel, handler) => handlers.set(channel, handler) },
    backendService: { sidecarClient: { request } },
    ipcAuthorization: {},
    gitService,
    ideService,
  });
  return (methodPath, payload) => handlers.get(getBridgeChannel(methodPath, 'invoke'))({}, payload);
}

test('registers the four new workspaceRecovery channels under the existing family', () => {
  const handlers = new Map();
  registerWorkspaceRecoveryIpcHandlers({
    ipcMainLike: { handle: (channel, handler) => handlers.set(channel, handler) },
    backendService: {},
  });
  for (const methodPath of NEW_METHODS) {
    const channel = getBridgeChannel(methodPath, 'invoke');
    assert.match(channel, /^workspace-recovery:/);
    assert.ok(handlers.has(channel), methodPath);
  }
});

test('undoChangeSet without the flag (or with false) sends a byte-identical sidecar payload', async () => {
  const calls = [];
  const invoke = register({
    request: async (method, params) => {
      calls.push({ method, json: JSON.stringify(params) });
      return method === 'workspace.preflight_undo' ? preflight() : receipt();
    },
  });
  const expected = JSON.stringify({
    accept_version: API_VERSION, change_set_id: CHANGE_SET_ID, decisions: { '1.1': 'skip' },
  });
  await invoke('workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID, decisions: { '1.1': 'skip' } });
  await invoke('workspaceRecovery.undoChangeSet', {
    changeSetId: CHANGE_SET_ID, decisions: { '1.1': 'skip' }, captureSafetyCopy: false,
  });
  assert.deepEqual(calls, [
    { method: 'workspace.undo_change_set', json: expected },
    { method: 'workspace.undo_change_set', json: expected },
  ]);
});

test('undoChangeSet with the flag runs the preflight, then the same undo payload', async () => {
  const root = createTrackedTempDir('jenny-recovery-files-ipc-');
  const rig = createRecoveryHarness(root, {
    withGit: false,
    sidecar: async (method) => (method === 'workspace.preflight_undo' ? preflight() : receipt()),
  });
  const result = await rig.invoke('workspaceRecovery.undoChangeSet', {
    changeSetId: CHANGE_SET_ID, decisions: { '1.1': 'skip' }, captureSafetyCopy: true,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.safety_copy, { token: null, paths: [], unavailable: [] });
  assert.deepEqual(rig.calls.map((call) => call.method), ['workspace.preflight_undo', 'workspace.undo_change_set']);
  assert.equal(JSON.stringify(rig.calls[1].params), JSON.stringify({
    accept_version: API_VERSION, change_set_id: CHANGE_SET_ID, decisions: { '1.1': 'skip' },
  }));
});

test('a non-boolean flag is refused, and a missing IDE service fails closed before any undo', async () => {
  const calls = [];
  const invoke = register({ request: async (method) => { calls.push(method); return receipt(); } });
  const bad = await invoke('workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID, captureSafetyCopy: 'yes' });
  const unavailable = await invoke('workspaceRecovery.undoChangeSet', { changeSetId: CHANGE_SET_ID, captureSafetyCopy: true });
  assert.equal(bad.reason, 'payload_invalid');
  assert.equal(unavailable.reason, 'recovery_unavailable');
  assert.deepEqual(calls, []);
});

test('the checkpoint and safety-copy methods fail closed when their services are missing', async () => {
  const invoke = register({ request: async () => ({}) });
  const ref = 'refs/jenny/checkpoints/sess/1';
  const results = await Promise.all([
    invoke('workspaceRecovery.preflightCheckpointFiles', { ref, files: [{ path: 'a.txt' }] }),
    invoke('workspaceRecovery.restoreCheckpointFiles', { ref, paths: ['a.txt'] }),
    invoke('workspaceRecovery.preflightSafetyCopy', { token: '00000000-0000-4000-8000-000000000001' }),
    invoke('workspaceRecovery.restoreSafetyCopy', { token: '00000000-0000-4000-8000-000000000001', paths: ['a.txt'] }),
  ]);
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'recovery_unavailable');
  }
});

test('checkpoint payloads are validated before git is reached', async () => {
  const gitCalls = [];
  const gitService = {
    preflightCheckpointFiles: async (options) => { gitCalls.push(options); return { ok: true }; },
    restoreCheckpointFiles: async (options) => { gitCalls.push(options); return { ok: true }; },
  };
  const invoke = register({ request: async () => ({}), gitService });
  const ref = 'refs/jenny/checkpoints/sess/1';
  const hash = `sha256:${'a'.repeat(64)}`;
  const cases = [
    ['workspaceRecovery.preflightCheckpointFiles', { ref: 'refs/heads/main', files: [{ path: 'a' }] }, 'ref_invalid'],
    ['workspaceRecovery.preflightCheckpointFiles', { ref, files: [] }, 'files_invalid'],
    ['workspaceRecovery.preflightCheckpointFiles', { ref, files: [{ path: 'a', hashKind: 'raw_bytes' }] }, 'files_invalid'],
    ['workspaceRecovery.preflightCheckpointFiles', { ref, files: [{ path: 'a', afterHash: 'md5:x' }] }, 'files_invalid'],
    ['workspaceRecovery.preflightCheckpointFiles', { ref, files: [{ path: 'a', afterHash: hash, hashKind: 'zip' }] }, 'files_invalid'],
    ['workspaceRecovery.preflightCheckpointFiles', { ref, files: [{ path: '../a' }] }, 'files_invalid'],
    ['workspaceRecovery.restoreCheckpointFiles', { ref, paths: [] }, 'paths_invalid'],
    ['workspaceRecovery.restoreCheckpointFiles', { ref, paths: ['/etc/passwd'] }, 'paths_invalid'],
    ['workspaceRecovery.restoreCheckpointFiles', { ref, paths: ['a'], removePaths: ['a'] }, 'paths_invalid'],
    ['workspaceRecovery.restoreCheckpointFiles', { ref, paths: ['a\u0000b'] }, 'paths_invalid'],
    ['workspaceRecovery.restoreCheckpointFiles', { ref, paths: ['a'], force: true }, 'payload_invalid'],
    ['workspaceRecovery.restoreCheckpointFiles', {
      ref, paths: Array.from({ length: 300 }, (_v, i) => `p${i}`), removePaths: Array.from({ length: 201 }, (_v, i) => `r${i}`),
    }, 'paths_invalid'],
  ];
  for (const [method, payload, reason] of cases) {
    const result = await invoke(method, payload);
    assert.equal(result.ok, false, `${method} ${JSON.stringify(payload).slice(0, 60)}`);
    assert.equal(result.reason, reason, `${method} ${JSON.stringify(payload).slice(0, 60)}`);
  }
  assert.deepEqual(gitCalls, []);
});

test('git results are reduced to relative paths and fixed messages', async () => {
  const root = createTrackedTempDir('jenny-recovery-files-ipc-');
  await fs.writeFile(path.join(root, 'a.txt'), 'x');
  const gitService = {
    restoreCheckpointFiles: async () => ({
      ok: false, available: true, isRepo: true, op: 'restoreCheckpointFiles', reason: 'git_failed',
      message: `error: unable to write ${root}\\a.txt`, rollbackRef: 'refs/jenny/checkpoints/rollback-sess/1',
      restored: [], removed: [], failed: [{ path: 'a.txt', reason: 'path_conflict', extra: root }],
    }),
  };
  const invoke = register({ request: async () => ({}), gitService });
  const result = await invoke('workspaceRecovery.restoreCheckpointFiles', { ref: 'refs/jenny/checkpoints/sess/1', paths: ['a.txt'] });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'git_failed');
  assert.equal(result.rollbackRef, 'refs/jenny/checkpoints/rollback-sess/1');
  assert.deepEqual(result.failed, [{ path: 'a.txt', reason: 'path_conflict' }]);
  assert.ok(!JSON.stringify(result).includes(root));
});
