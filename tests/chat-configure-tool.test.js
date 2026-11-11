'use strict';

// Row 94 P1: `chat_configure` is a closed schema over the port; Auto never passes and it is never always-allow.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const tool = require('../services/tools/builtin/chat-configure-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const { NEVER_PERSIST_ALWAYS_ALLOW } = require('../services/tools/tool-permission-migrations');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };
const GOOD = { session_id: 'other', action: 'set_run_mode', value: 'plan', purpose: 'Put the research chat in Plan mode.' };
const CHANGE_ID = `sc_${'b'.repeat(32)}`;

function harness({ port, featureFlags } = {}) {
  const project = { project_id: 'project_a', root_path: os.tmpdir(), root_id: 'root', root_revision: 1,
    device_id: 'device', inode: 'inode' };
  const authority = new SessionExecutionAuthority({
    projectAuthority: { captureSession: () => project, requireCurrent: captured => captured,
      _sessionStore: { getSessionSummary: () => ({ id: 'caller', run_mode: 'ask', plan_mode: false }) } },
    permissionStore: PERMISSIONS,
    knowledgeService: { getSidecarConfig: () => ({ knowledge_roots: [] }) },
    resolveProjectWorkspaceServices: () => ({}),
  });
  const executionAuthority = authority.captureSession('caller', { requestId: 'stream', mode: 'assist', approvalMode: 'prompt' });
  const calls = [];
  const fake = port === undefined ? { async configure(args) {
    calls.push(args);
    return { ok: true, change_id: CHANGE_ID, session_id: args.target_session_id, action: args.action, before: 'ask', after: args.value };
  } } : port;
  const backendService = { sessionExecutionAuthority: authority, ...(featureFlags ? { featureFlags } : {}),
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call-1', backendService, executionAuthority, primaryChatManageService: fake, mode: 'ask',
    abortSignal: new AbortController().signal };
  return { context, calls };
}

const { parseToolOutput } = require('./helpers/refusal-output');
const output = parseToolOutput;

test('chat_configure is a closed schema: bad shapes and actions refuse before the port', async () => {
  const { context, calls } = harness();
  const bad = [
    undefined, null, [], {}, { ...GOOD, extra: 1 },
    { ...GOOD, session_id: '' }, { ...GOOD, session_id: 7 },
    { ...GOOD, action: 'rename' }, { ...GOOD, action: 'set_everything' }, { ...GOOD, action: undefined },
    { ...GOOD, value: 7 }, { ...GOOD, value: 'x'.repeat(201) },
    { ...GOOD, purpose: '' }, { ...GOOD, purpose: undefined }, { ...GOOD, purpose: 'x'.repeat(201) },
  ];
  for (const input of bad) {
    assert.deepEqual(output(await tool.execute(input, context)), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
});

test('Auto as a run mode is not_allowed before the port, whatever its case; the other modes pass', async () => {
  const { context, calls } = harness();
  for (const value of ['auto', 'Auto', ' AUTO ']) {
    const result = await tool.execute({ ...GOOD, value }, context);
    assert.deepEqual(output(result), { ok: false, reason: 'not_allowed' }, value);
    assert.deepEqual(result.metadata, { result_kind: 'chat_configure', status: 'refused', reason: 'not_allowed' });
  }
  assert.deepEqual(calls, []);
  for (const value of ['ask', 'plan', 'propose']) {
    assert.equal(output(await tool.execute({ ...GOOD, value }, context)).ok, true, value);
  }
  // Only the run mode carries the Auto rule: a model named "auto" is an ordinary value.
  assert.equal(output(await tool.execute({ ...GOOD, action: 'set_model', value: 'auto' }, context)).ok, true);
});

test('every configure action reaches the port with the live caller, and the answer passes through', async () => {
  for (const [action, value] of [['set_model', 'gpt-6-astra'], ['set_effort', 'high'], ['set_run_mode', 'propose']]) {
    const { context, calls } = harness();
    const result = await tool.execute({ session_id: 'other', action, value, purpose: 'Switch it.' }, context);
    assert.deepEqual(calls, [{ target_session_id: 'other', action, value, caller_session_id: 'caller' }], action);
    assert.deepEqual(output(result), { ok: true, change_id: CHANGE_ID, session_id: 'other', action, before: 'ask', after: value });
    assert.deepEqual(result.metadata, { result_kind: 'chat_configure', status: 'ok', change_id: CHANGE_ID });
  }
  assert.equal(tool.summarize({}), 'Chat: configure');
  for (const reason of ['busy', 'self_refused', 'not_found', 'invalid_input']) {
    const refusing = harness({ port: { configure: async () => ({ ok: false, reason }) } });
    assert.deepEqual(output(await tool.execute(GOOD, refusing.context)), { ok: false, reason });
  }
});

test('a missing port, a throwing port or a stale call reads unavailable and leaks no exception text', async () => {
  assert.deepEqual(output(await tool.execute(GOOD, harness({ port: null }).context)), { ok: false, reason: 'unavailable' });
  const thrown = await tool.execute(GOOD, harness({ port: { configure: async () => { throw new Error('private path C:\\Users\\x'); } } }).context);
  assert.deepEqual(output(thrown), { ok: false, reason: 'unavailable' });
  assert.equal(thrown.content.includes('private'), false);
  const stale = harness();
  stale.context.sessionIncarnation = '';
  assert.deepEqual(output(await tool.execute(GOOD, stale.context)), { ok: false, reason: 'unavailable' });
  assert.deepEqual(stale.calls, []);
});

test('the kill switch answers disabled first; Plan mode and read-only chats refuse before the port', async () => {
  const off = harness({ featureFlags: { primary_chat_manage: false } });
  assert.deepEqual(output(await tool.execute(GOOD, off.context)), { ok: false, reason: 'disabled' });
  assert.deepEqual(off.calls, []);
  for (const flags of [{ planMode: true }, { readOnly: true }]) {
    const { context, calls } = harness();
    assert.deepEqual(output(await tool.execute(GOOD, { ...context, ...flags })), { ok: false, reason: 'mode_refused' });
    assert.deepEqual(calls, []);
  }
});

test('the manifest, policy and always-allow list pin the tool as side-effecting, ask-only and never always-allow', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'tools', 'tool-manifest.json'), 'utf8'));
  const entry = manifest.tools.find(item => item.name === 'chat_configure');
  assert.equal(entry.side_effecting, true);
  assert.equal(entry.read_only, false);
  assert.equal(entry.owner, 'electron');
  assert.equal(entry.availability.config_flag, 'tools_primary_chat_manage_enabled');
  assert.deepEqual(entry.parameters.required, ['session_id', 'action', 'purpose']);
  assert.deepEqual(entry.parameters.properties.action.enum, ['move_to_project', 'set_model', 'set_effort', 'set_run_mode']);
  assert.equal(entry.parameters.properties.purpose.maxLength, 200);
  assert.equal(entry.description.includes("Auto is the user's choice, never yours"), true);
  assert.equal(NEVER_PERSIST_ALWAYS_ALLOW.has('chat_configure'), true);
  assert.equal(tool.sideEffecting, true);

  assert.equal(createDefaultRegistry({ toolsPrimaryChatManageEnabled: false }).getTool('chat_configure'), undefined);
  const tools = new ToolExecutor({ registry: createDefaultRegistry({ toolsPrimaryChatManageEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
  const registered = tools.registry.getTool('chat_configure');
  assert.ok(registered);
  assert.equal(tools._evaluateToolPolicy(registered, GOOD, harness().context).decision, 'ask');
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'chat_configure' } });
  assert.equal(hosted.success, false);
});
