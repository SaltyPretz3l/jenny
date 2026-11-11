'use strict';

// Row 94 P1: `chat_organize` is a closed schema over the port, never a write path of its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const tool = require('../services/tools/builtin/chat-organize-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };
const GOOD = { session_id: 'other', action: 'rename', value: 'Budget notes', purpose: 'Give the chat a clearer title.' };
const CHANGE_ID = `sc_${'a'.repeat(32)}`;

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
  const fake = port === undefined ? { async organize(args) {
    calls.push(args);
    return { ok: true, change_id: CHANGE_ID, session_id: args.target_session_id, action: args.action, before: 'Old', after: 'New' };
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

test('chat_organize is a closed schema: bad shapes and actions refuse before the port', async () => {
  const { context, calls } = harness();
  const bad = [
    undefined, null, [], {}, { ...GOOD, extra: 1 },
    { ...GOOD, session_id: '' }, { ...GOOD, session_id: 7 }, { ...GOOD, session_id: 'x'.repeat(257) },
    { ...GOOD, action: 'delete' }, { ...GOOD, action: 'set_model' }, { ...GOOD, action: 7 }, { ...GOOD, action: undefined },
    { ...GOOD, value: 7 }, { ...GOOD, value: ['a'] }, { ...GOOD, value: 'x'.repeat(201) },
    { ...GOOD, purpose: '' }, { ...GOOD, purpose: 7 }, { ...GOOD, purpose: undefined }, { ...GOOD, purpose: 'x'.repeat(201) },
  ];
  for (const input of bad) {
    assert.deepEqual(output(await tool.execute(input, context)), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
});

test('every organize action reaches the port with the live caller, and the answer passes through', async () => {
  for (const action of ['rename', 'pin', 'unpin', 'archive', 'unarchive']) {
    const { context, calls } = harness();
    const input = { session_id: 'other', action, ...(action === 'rename' ? { value: 'v' } : {}), purpose: 'Tidy up.' };
    const result = await tool.execute(input, context);
    // The purpose is the card's headline, never the port's.
    assert.deepEqual(calls, [{ target_session_id: 'other', action, ...(input.value ? { value: 'v' } : {}),
      caller_session_id: 'caller' }], action);
    assert.deepEqual(output(result), { ok: true, change_id: CHANGE_ID, session_id: 'other', action, before: 'Old', after: 'New' });
    assert.deepEqual(result.metadata, { result_kind: 'chat_organize', status: 'ok', change_id: CHANGE_ID });
    assert.equal(result.isError, false);
  }
  assert.equal(tool.summarize({}), 'Chat: organize');
  const busy = harness({ port: { organize: async () => ({ ok: false, reason: 'busy' }) } });
  const refused = await tool.execute(GOOD, busy.context);
  assert.deepEqual(output(refused), { ok: false, reason: 'busy' });
  assert.deepEqual(refused.metadata, { result_kind: 'chat_organize', status: 'refused', reason: 'busy' });
});

test('a missing port, a throwing port or a stale call reads unavailable and leaks no exception text', async () => {
  assert.deepEqual(output(await tool.execute(GOOD, harness({ port: null }).context)), { ok: false, reason: 'unavailable' });
  const thrown = await tool.execute(GOOD, harness({ port: { organize: async () => { throw new Error('private path C:\\Users\\x'); } } }).context);
  assert.deepEqual(output(thrown), { ok: false, reason: 'unavailable' });
  assert.equal(thrown.content.includes('private'), false);
  assert.deepEqual(output(await tool.execute(GOOD, harness({ port: { organize: async () => 'done' } }).context)), { ok: false, reason: 'unavailable' });
  const stale = harness();
  stale.context.logicalTurnId = '';
  assert.deepEqual(output(await tool.execute(GOOD, stale.context)), { ok: false, reason: 'unavailable' });
  assert.deepEqual(stale.calls, []);
});

test('the kill switch answers disabled first; Plan mode and read-only chats refuse before the port', async () => {
  const off = harness({ featureFlags: { primary_chat_manage: false } });
  assert.deepEqual(output(await tool.execute(GOOD, off.context)), { ok: false, reason: 'disabled' });
  assert.deepEqual(output(await tool.execute({}, off.context)), { ok: false, reason: 'disabled' });
  assert.deepEqual(off.calls, []);
  assert.equal(output(await tool.execute(GOOD, harness({ featureFlags: { primary_chat_manage: true } }).context)).ok, true);
  for (const flags of [{ planMode: true }, { readOnly: true }]) {
    const { context, calls } = harness();
    assert.deepEqual(output(await tool.execute(GOOD, { ...context, ...flags })), { ok: false, reason: 'mode_refused' });
    assert.deepEqual(calls, []);
  }
});

test('the manifest and policy pin the tool as side-effecting and ask, behind its own registry flag', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'tools', 'tool-manifest.json'), 'utf8'));
  const entry = manifest.tools.find(item => item.name === 'chat_organize');
  assert.equal(entry.side_effecting, true);
  assert.equal(entry.read_only, false);
  assert.equal(entry.owner, 'electron');
  assert.equal(entry.availability.config_flag, 'tools_primary_chat_manage_enabled');
  assert.equal(entry.parameters.additionalProperties, false);
  assert.deepEqual(entry.parameters.required, ['session_id', 'action', 'purpose']);
  assert.deepEqual(entry.parameters.properties.action.enum, ['rename', 'pin', 'unpin', 'archive', 'unarchive']);
  assert.equal(entry.parameters.properties.purpose.maxLength, 200);
  assert.equal(tool.sideEffecting, true);
  assert.equal(tool.readOnly, false);

  assert.equal(createDefaultRegistry({}).getTool('chat_organize'), undefined);
  assert.equal(createDefaultRegistry({ toolsPrimaryChatManageEnabled: false }).getTool('chat_organize'), undefined);
  const tools = new ToolExecutor({ registry: createDefaultRegistry({ toolsPrimaryChatManageEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
  const registered = tools.registry.getTool('chat_organize');
  assert.ok(registered);
  assert.equal(tools._evaluateToolPolicy(registered, GOOD, harness().context).decision, 'ask');
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'chat_organize' } });
  assert.equal(hosted.success, false);
});
