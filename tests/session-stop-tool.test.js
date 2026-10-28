'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const tool = require('../services/tools/builtin/session-stop-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };

function harness({ directory = null } = {}) {
  const project = { project_id: 'project_a', root_path: os.tmpdir(), root_id: 'root', root_revision: 1,
    device_id: 'device', inode: 'inode' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: captured => captured,
      _sessionStore: { getSessionSummary: () => ({ id: 'caller', run_mode: 'auto', plan_mode: false }) } },
    permissionStore: PERMISSIONS,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession('caller', { requestId: 'stream', mode: 'assist', approvalMode: 'auto' });
  const calls = [];
  const fake = directory || { async stop(args) {
    calls.push(args);
    return { ok: true, session_id: args.sessionId, stopped: { stream: true, queued_work: 1 }, cleanup: 'confirmed' };
  } };
  const backendService = { sessionExecutionAuthority: authority,
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call', backendService, executionAuthority, sessionDirectoryService: fake, mode: 'auto',
    abortSignal: new AbortController().signal };
  return { context, calls };
}

const output = result => JSON.parse(result.content);

function executor() {
  return new ToolExecutor({ registry: createDefaultRegistry({ toolsSessionDirectoryEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
}

test('session_stop needs one session id and refuses unknown keys before any directory work', async () => {
  const { context, calls } = harness();
  for (const input of [{}, { session_id: '' }, { session_id: 'a', reason: 'user asked' }, { session_id: 'a', force: true },
    { session_id: ['a'] }, { session_id: 'a', purpose: 7 }, { session_id: 'a', purpose: 'x'.repeat(1025) }]) {
    const result = await tool.execute(input, context);
    assert.deepEqual(output(result), { ok: false, reason: 'invalid_request' });
  }
  assert.deepEqual(calls, []);
});

test('the caller comes from the live binding and the stop result passes through', async () => {
  const { context, calls } = harness();
  const result = await tool.execute({ session_id: 'target', purpose: 'Stop the build chat.' }, context);
  assert.deepEqual(output(result), { ok: true, session_id: 'target', stopped: { stream: true, queued_work: 1 },
    cleanup: 'confirmed' });
  assert.deepEqual(calls, [{ callerSessionId: 'caller', sessionId: 'target' }]);
  assert.deepEqual(result.metadata, { result_kind: 'session_stop', status: 'ok', cleanup: 'confirmed' });
  assert.equal(tool.summarize({}), 'Session stop');
  const self = harness({ directory: { stop: async () => ({ ok: false, reason: 'self' }) } });
  assert.deepEqual(output(await tool.execute({ session_id: 'caller' }, self.context)), { ok: false, reason: 'self' });
});

test('Plan mode and read-only chats refuse the stop before any directory work', async () => {
  for (const flags of [{ planMode: true }, { readOnly: true }]) {
    const { context, calls } = harness();
    assert.deepEqual(output(await tool.execute({ session_id: 'target' }, { ...context, ...flags })),
      { ok: false, reason: 'mode_refused' });
    assert.deepEqual(calls, []);
  }
  const { context } = harness();
  assert.equal(executor()._preflightTool({ toolName: 'session_stop', callId: 'call', input: { session_id: 'a' } },
    { ...context, readOnly: true, planMode: true }, { preApproved: true }).tool, undefined);
});

test('session_stop defaults to ask, and unbound or failing calls stay normal results', async () => {
  const { context } = harness();
  const tools = executor();
  assert.equal(tools._evaluateToolPolicy(tools.registry.getTool('session_stop'), { session_id: 'a' }, context).decision, 'ask');
  const unbound = harness();
  unbound.context.logicalTurnId = '';
  assert.deepEqual(output(await tool.execute({ session_id: 'a' }, unbound.context)), { ok: false, reason: 'stale_operation' });
  assert.deepEqual(unbound.calls, []);
  const throwing = harness({ directory: { stop: async () => { throw new Error('private'); } } });
  assert.deepEqual(output(await tool.execute({ session_id: 'a' }, throwing.context)), { ok: false, reason: 'unavailable' });
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'session_stop' } });
  assert.equal(hosted.success, false);
});
