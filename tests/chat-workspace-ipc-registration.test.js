'use strict';

/* chatWorkspace.* IPC registration and desktop composition (row 59 checkpoint 2):
 * the trusted-sender gate, raw-payload forwarding to the service-owned closed
 * schema, the failure envelope when the service is absent or throws, and the
 * live wiring of the service against a backend-shaped object. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { registerChatWorkspaceIpc } = require('../services/main/chat-workspace-ipc-registration');
const { createChatWorkspaceService, resolveExecutionEnvironment } = require('../services/chat-workspace-wiring');
const { JENNY_SHELL_BRIDGE_DESCRIPTORS } = require('../services/ipc-contract');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { CHATWS_ERROR_CODES } = require('../services/backend/error-codes');

const CHANNELS = {
  getSummary: 'chat-workspace:get-summary',
  setView: 'chat-workspace:set-view',
  listChanges: 'chat-workspace:list-changes',
  getChangeDiff: 'chat-workspace:get-change-diff',
};

function register({ allow = true, service } = {}) {
  const handlers = new Map();
  const backendService = { chatWorkspace: service };
  registerChatWorkspaceIpc({ handle: (channel, fn) => handlers.set(channel, fn) }, {
    backendService,
    authorization: { authorize: () => allow },
  });
  return { handlers, backendService, invoke: (channel, payload) => handlers.get(channel)({ sender: {} }, payload) };
}

test('exactly the four descriptor-backed invoke channels are registered, and onChanged is a subscription', () => {
  const { handlers } = register({ service: {} });
  assert.deepEqual([...handlers.keys()].sort(), Object.values(CHANNELS).sort());
  for (const [method, channel] of Object.entries(CHANNELS)) {
    assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS[`chatWorkspace.${method}`], { kind: 'invoke', channel });
  }
  assert.deepEqual(JENNY_SHELL_BRIDGE_DESCRIPTORS['chatWorkspace.onChanged'], { kind: 'subscribe', channel: 'chat-workspace:changed' });
});

test('an untrusted sender reaches no service method', async () => {
  const calls = [];
  const service = new Proxy({}, { get: (_t, name) => (...args) => { calls.push([name, args]); return { ok: true }; } });
  const denied = register({ allow: false, service });
  for (const channel of Object.values(CHANNELS)) {
    const result = await denied.invoke(channel, { schema_version: 1, session_id: 's' });
    assert.equal(result.ok, false);
    assert.notEqual(result.schema_version, 1);
  }
  assert.equal(calls.length, 0);
});

test('payloads reach the service raw and its envelope returns unchanged', async () => {
  const calls = [];
  const service = {
    async getSummary(raw) { calls.push(['getSummary', raw]); return { schema_version: 1, ok: true, summary: {} }; },
    async setView(raw) { calls.push(['setView', raw]); return { schema_version: 1, ok: true }; },
    async listChanges(raw) { calls.push(['listChanges', raw]); return { schema_version: 1, ok: true }; },
    async getChangeDiff(raw) { calls.push(['getChangeDiff', raw]); return { schema_version: 1, ok: true }; },
  };
  const { invoke } = register({ service });
  const hostile = { schema_version: 1, session_id: 's', path: '../../x', extra: { deep: [1, 2] } };
  assert.deepEqual(await invoke(CHANNELS.getSummary, hostile), { schema_version: 1, ok: true, summary: {} });
  await invoke(CHANNELS.getChangeDiff, hostile);
  await invoke(CHANNELS.setView, undefined);
  assert.deepEqual(calls.map(([name]) => name), ['getSummary', 'getChangeDiff', 'setView']);
  assert.equal(calls[0][1], hostile, 'no coercion or copying before the service validates');
  assert.equal(calls[2][1], undefined);
});

test('a missing service and a throwing service answer the common failure envelope without exception text', async () => {
  const expected = {
    schema_version: 1, ok: false, error_code: CHATWS_ERROR_CODES.UNAVAILABLE, reason: 'unavailable', retryable: false, current_revision: null,
  };
  assert.deepEqual(await register({ service: undefined }).invoke(CHANNELS.getSummary, {}), expected);
  const throwing = { getSummary: async () => { throw new Error('secret path C:\\Users\\x'); } };
  const result = await register({ service: throwing }).invoke(CHANNELS.getSummary, {});
  assert.deepEqual(result, expected);
  assert.doesNotMatch(JSON.stringify(result), /secret|Users/u);
});

test('execution environment resolves hosted, sandbox or local from the backend', () => {
  assert.equal(resolveExecutionEnvironment({ hostMode: 'server' }), 'hosted');
  assert.equal(resolveExecutionEnvironment({ commandSandbox: { enabled: true } }), 'sandbox');
  assert.equal(resolveExecutionEnvironment({ configService: { getState: () => ({ commandSandbox: { enabled: true } }) } }), 'sandbox');
  assert.equal(resolveExecutionEnvironment({ commandSandbox: { enabled: false } }), 'local');
});

test('the service composes against a backend-shaped object and rides its chat-stream bus', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-chatws-wiring-'));
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'));
  try {
    const backend = new EventEmitter();
    const root = path.join(dir, 'ws');
    fs.mkdirSync(root);
    const sessionId = store.createSession({ title: 'wired' }).id;
    const resolved = [];
    Object.assign(backend, {
      sessionStore: store,
      hostMode: 'desktop',
      commandSandbox: { enabled: false },
      featureFlags: { activity_monitor: false },
      projectService: { get: (id) => ({ id, name: 'Wired project' }) },
      worktreeService: { _registryService: { listAll: () => [{ id: 'wt_9', worktree_path: root }] } },
      projectAuthority: {
        captureSession: (id) => {
          if (id !== sessionId) {
            const error = new Error('missing');
            error.reason = 'session_not_found';
            throw error;
          }
          return { project_id: 'p1', root_id: 'root_w', root_path: root, root_revision: 3 };
        },
      },
      resolveProjectWorkspaceServices: (authority, options) => {
        resolved.push([authority.root_id, options.sessionId]);
        return { workspaceGitService: { getStatus: async () => ({ ok: false, available: true, isRepo: false }) } };
      },
    });
    const bridge = [];
    const service = createChatWorkspaceService({
      backendService: backend, emit: (event) => bridge.push(event),
    });
    backend.chatWorkspace = service;
    const { handlers } = register({ service });
    const call = (channel, payload) => handlers.get(channel)({ sender: {} }, payload);

    const summary = await call(CHANNELS.getSummary, { schema_version: 1, session_id: sessionId });
    assert.equal(summary.ok, true);
    assert.equal(summary.summary.environment.data.project_name, 'Wired project');
    assert.equal(summary.summary.environment.data.worktree_id, 'wt_9');
    assert.equal(summary.summary.environment.data.execution_environment, 'local');
    assert.deepEqual([summary.summary.changes.state, summary.summary.changes.reason], ['not_applicable', 'not_a_git_repository']);
    assert.equal(summary.summary.background_tasks.data.counts.active, null);
    assert.deepEqual(resolved, [['root_w', sessionId]]);

    const missing = await call(CHANNELS.getSummary, { schema_version: 1, session_id: 'sess_nope' });
    assert.deepEqual([missing.ok, missing.reason], [false, 'not_found']);

    const written = await call(CHANNELS.setView, {
      schema_version: 1, session_id: sessionId, expected_revision: 0, patch: { children_expanded: true },
    });
    assert.equal(written.ok, true);
    assert.deepEqual(bridge, [{ schema_version: 1, session_id: sessionId, revision: 1 }]);

    await new Promise((resolve) => setTimeout(resolve, 300)); // let the per-session interval pass
    backend.emit('chat-stream', { type: 'delta', sessionId });
    assert.equal(bridge.length, 1);
    backend.emit('chat-stream', { type: 'complete', sessionId });
    assert.equal(bridge.length, 2);
    service.dispose();
  } finally {
    store.dispose?.();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
