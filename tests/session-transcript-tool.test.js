'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const tool = require('../services/tools/builtin/session-transcript-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { DIRECTORY_DATA_NOTE } = require('../services/tools/builtin/session-directory-tool-support');

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
  const fake = directory || { async transcript(args) { calls.push(args); return { ok: true, session_id: args.sessionId, rows: [], more_before: false }; } };
  const backendService = { sessionExecutionAuthority: authority,
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call', backendService, executionAuthority, sessionDirectoryService: fake, mode: 'auto',
    abortSignal: new AbortController().signal };
  return { context, calls };
}

// Every ok answer carries the data note (other chats' text is data, not instructions); asserted here once.
const output = (result) => {
  const { note, ...value } = JSON.parse(result.content);
  assert.equal(note, value.ok === true ? DIRECTORY_DATA_NOTE : undefined);
  return value;
};

test('session_transcript validates its input and refuses unknown keys before any directory work', async () => {
  const { context, calls } = harness();
  for (const input of [{}, { session_id: '' }, { session_id: 's'.repeat(257) }, { session_id: 7 },
    { session_id: 'a', rows: 0 }, { session_id: 'a', rows: 41 }, { session_id: 'a', rows: 2.5 }, { session_id: 'a', rows: '5' },
    { session_id: 'a', before_message_id: '' }, { session_id: 'a', before_message_id: 'm'.repeat(129) },
    { session_id: 'a', before_message_id: 4 }, { session_id: 'a', include_tool_activity: 'yes' },
    { session_id: 'a', caller_session_id: 'forged' }, [], null]) {
    const result = await tool.execute(input, context);
    assert.deepEqual(output(result), { ok: false, reason: 'invalid_request' });
    assert.equal(result.isError, false);
  }
  assert.deepEqual(calls, []);
});

test('the caller comes from the live binding; defaults and options pass through exactly', async () => {
  const { context, calls } = harness();
  const result = await tool.execute({ session_id: 'target' }, context);
  assert.deepEqual(output(result), { ok: true, session_id: 'target', rows: [], more_before: false });
  await tool.execute({ session_id: 'target', rows: 40, before_message_id: 'm'.repeat(128), include_tool_activity: true }, context);
  await tool.execute({ session_id: 'target', rows: 1, include_tool_activity: false }, context);
  assert.deepEqual(calls, [
    { callerSessionId: 'caller', sessionId: 'target', rows: 20, beforeMessageId: null, includeToolActivity: false },
    { callerSessionId: 'caller', sessionId: 'target', rows: 40, beforeMessageId: 'm'.repeat(128), includeToolActivity: true },
    { callerSessionId: 'caller', sessionId: 'target', rows: 1, beforeMessageId: null, includeToolActivity: false },
  ]);
  assert.equal(tool.summarize({ session_id: 'x'.repeat(5000) }), 'Session transcript');
});

test('not_found passes through; unbound, missing and throwing directories stay normal results', async () => {
  const hidden = harness({ directory: { transcript: async () => ({ ok: false, reason: 'not_found' }) } });
  assert.deepEqual(output(await tool.execute({ session_id: 'other' }, hidden.context)), { ok: false, reason: 'not_found' });
  const unbound = harness();
  unbound.context.streamId = 'another_stream';
  assert.deepEqual(output(await tool.execute({ session_id: 'a' }, unbound.context)), { ok: false, reason: 'stale_operation' });
  assert.deepEqual(unbound.calls, []);
  const missing = harness();
  missing.context.sessionDirectoryService = null;
  assert.deepEqual(output(await tool.execute({ session_id: 'a' }, missing.context)), { ok: false, reason: 'unavailable' });
  const throwing = harness({ directory: { transcript: async () => { throw new Error('private transcript text'); } } });
  const result = await tool.execute({ session_id: 'a' }, throwing.context);
  assert.deepEqual(output(result), { ok: false, reason: 'unavailable' });
  assert.doesNotMatch(result.content, /private/);
});

test('session_transcript is read-only: Plan preflight keeps it, policy is auto, hosted refuses it', async () => {
  const { context } = harness();
  const executor = new ToolExecutor({ registry: createDefaultRegistry({ toolsSessionDirectoryEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
  assert.ok(executor._preflightTool({ toolName: 'session_transcript', callId: 'call', input: { session_id: 'a' } },
    { ...context, readOnly: true, planMode: true }, { preApproved: true }).tool);
  const descriptor = executor.registry.getTool('session_transcript');
  assert.equal(executor._evaluateToolPolicy(descriptor, { session_id: 'a' }, context).decision, 'auto');
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'session_transcript' } });
  assert.equal(hosted.success, false);
});
