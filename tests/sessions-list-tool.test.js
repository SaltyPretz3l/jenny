'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const tool = require('../services/tools/builtin/sessions-list-tool');
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
  const fake = directory || { list(args) { calls.push(args); return { ok: true, scope_kind: 'project', rows: [], truncated: false }; } };
  const backendService = { sessionExecutionAuthority: authority,
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call', backendService, executionAuthority, sessionDirectoryService: fake, mode: 'auto',
    abortSignal: new AbortController().signal };
  return { context, calls, backendService };
}

const { DIRECTORY_DATA_NOTE } = require('../services/tools/builtin/session-directory-tool-support');

// Every ok answer carries the data note (other chats' text is data, not instructions); asserted here once.
const output = (result) => {
  const { note, ...value } = JSON.parse(result.content);
  assert.equal(note, value.ok === true ? DIRECTORY_DATA_NOTE : undefined);
  return value;
};

test('sessions_list refuses unknown keys and bad values before any directory work', async () => {
  const { context, calls } = harness();
  for (const input of [{ extra: true }, { scope: 'mine' }, { limit: 0 }, { limit: 51 }, { limit: 1.5 },
    { include_archived: 'yes' }, { project_id: '' }, { project_id: 'p'.repeat(161) }, { session_id: 'forged' }, []]) {
    const result = await tool.execute(input, context);
    assert.deepEqual(output(result), { ok: false, reason: 'invalid_request' });
    assert.equal(result.isError, false);
  }
  assert.deepEqual(calls, []);
});

test('the caller comes from the live binding and the arguments pass through closed', async () => {
  const { context, calls } = harness();
  const result = await tool.execute({ scope: 'active', project_id: 'project_b', include_archived: true, limit: 5 }, context);
  assert.deepEqual(output(result), { ok: true, scope_kind: 'project', rows: [], truncated: false });
  assert.deepEqual(calls, [{ callerSessionId: 'caller', scope: 'active', project_id: 'project_b', include_archived: true, limit: 5 }]);
  await tool.execute({}, context);
  assert.deepEqual(calls[1], { callerSessionId: 'caller', scope: 'recent', project_id: null, include_archived: false, limit: 20 });
  assert.equal(tool.summarize({}), 'Sessions: list');
  assert.equal(result.summary, 'Sessions: list');
});

test('an unbound call, a missing directory and a throwing directory do no work and stay normal results', async () => {
  const unbound = harness();
  unbound.context.sessionId = '';
  assert.deepEqual(output(await tool.execute({}, unbound.context)), { ok: false, reason: 'stale_operation' });
  assert.deepEqual(unbound.calls, []);
  const missing = harness();
  missing.context.sessionDirectoryService = null;
  assert.deepEqual(output(await tool.execute({}, missing.context)), { ok: false, reason: 'unavailable' });
  const throwing = harness({ directory: { list() { throw new Error('private path C:\\secret'); } } });
  const result = await tool.execute({}, throwing.context);
  assert.deepEqual(output(result), { ok: false, reason: 'unavailable' });
  assert.doesNotMatch(result.content, /secret/);
  const refused = harness({ directory: { list: () => ({ ok: false, reason: 'lockdown' }) } });
  assert.deepEqual(output(await tool.execute({}, refused.context)), { ok: false, reason: 'lockdown' });
});

test('the flag registers the three directory tools, and the executor threads the directory getter', async () => {
  assert.equal(createDefaultRegistry().getTool('sessions_list'), undefined);
  const registry = createDefaultRegistry({ toolsSessionDirectoryEnabled: true });
  for (const name of ['sessions_list', 'session_status', 'session_transcript', 'session_stop']) assert.ok(registry.getTool(name), name);
  const { context } = harness();
  const listed = [];
  const executor = new ToolExecutor({ registry, permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {},
    sessionDirectoryService: () => ({ list: (args) => { listed.push(args.callerSessionId); return { ok: true, rows: [] }; } }) });
  delete context.sessionDirectoryService;
  const result = await executor.executePreApproved({ toolName: 'sessions_list', callId: 'call', input: {} }, context);
  assert.equal(result.isError, false, result.content);
  assert.deepEqual(output(result), { ok: true, rows: [] });
  assert.deepEqual(listed, ['caller']);
});

test('Plan and read-only preflight keep sessions_list; the hosted bridge refuses it', async () => {
  const { context } = harness();
  const executor = new ToolExecutor({ registry: createDefaultRegistry({ toolsSessionDirectoryEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
  const verdict = executor._preflightTool({ toolName: 'sessions_list', callId: 'call', input: {} },
    { ...context, readOnly: true, planMode: true }, { preApproved: true });
  assert.ok(verdict.tool);
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'sessions_list' } });
  assert.equal(hosted.success, false);
});
