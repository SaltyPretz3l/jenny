'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const tool = require('../services/tools/builtin/settings-change-tool');
const { SessionExecutionAuthority } = require('../services/backend/session-execution-authority');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { executeElectronToolRequest } = require('../services/backend/electron-tool-bridge');
const {
  PRIMARY_SETTINGS_KEYS, PRIMARY_SETTINGS_LIMITS, PRIMARY_SETTINGS_RUN_MODES,
} = require('../services/primary-settings-contract');
const { NEVER_PERSIST_ALWAYS_ALLOW } = require('../services/tools/tool-permission-migrations');

const PERMISSIONS = { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) };
const GOOD = { changes: [{ key: 'time_format_24h', value: true }], purpose: 'Switch the clock to 24 hours.' };
const CHANGE_ID = `sc_${'a'.repeat(32)}`;

function harness({ port, featureFlags } = {}) {
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
  const fake = port === undefined ? { async change(args) {
    calls.push(args);
    return { ok: true, applied: args.changes.map(({ key, value }) => ({ key, before: null, after: value })), change_id: CHANGE_ID };
  } } : port;
  const backendService = { sessionExecutionAuthority: authority, ...(featureFlags ? { featureFlags } : {}),
    sessionStore: { getActiveTurn: () => ({ stream_id: 'stream', turn_id: 'turn', session_incarnation: 'incarnation' }) } };
  const context = { sessionId: 'caller', streamId: 'stream', logicalTurnId: 'turn', sessionIncarnation: 'incarnation',
    callId: 'call-1', backendService, executionAuthority, primarySettingsService: fake, mode: 'auto',
    abortSignal: new AbortController().signal };
  return { context, calls };
}

const { parseToolOutput } = require('./helpers/refusal-output');
const output = parseToolOutput;

function executor() {
  return new ToolExecutor({ registry: createDefaultRegistry({ toolsPrimarySettingsEnabled: true }),
    permissionStore: PERMISSIONS, pathPolicy: {}, logger: () => {} });
}

test('settings_change is a closed schema: bad shapes, duplicates and too many changes refuse before the port', async () => {
  const { context, calls } = harness();
  const many = Array.from({ length: PRIMARY_SETTINGS_LIMITS.changes_max + 1 },
    (_value, index) => ({ key: PRIMARY_SETTINGS_KEYS[index], value: true }));
  const bad = [
    undefined, null, [], {}, { changes: [] }, { purpose: 'x' }, { changes: GOOD.changes },
    { ...GOOD, extra: 1 }, { ...GOOD, purpose: '' }, { ...GOOD, purpose: 7 },
    { ...GOOD, purpose: 'x'.repeat(PRIMARY_SETTINGS_LIMITS.purpose_chars + 1) },
    { ...GOOD, changes: 'time_format_24h' }, { ...GOOD, changes: many },
    { ...GOOD, changes: [{ key: 'time_format_24h' }] },
    { ...GOOD, changes: [{ value: true }] },
    { ...GOOD, changes: [{ key: 'time_format_24h', value: true, note: 'x' }] },
    { ...GOOD, changes: [{ key: '', value: true }] },
    { ...GOOD, changes: [{ key: 7, value: true }] },
    { ...GOOD, changes: [{ key: 'time_format_24h', value: null }] },
    { ...GOOD, changes: [{ key: 'time_format_24h', value: { a: 1 } }] },
    { ...GOOD, changes: [{ key: 'time_format_24h', value: ['a'] }] },
    { ...GOOD, changes: [{ key: 'ui_language', value: 'x'.repeat(PRIMARY_SETTINGS_LIMITS.value_chars + 1) }] },
    { ...GOOD, changes: [{ key: 'editor_font_size', value: Number.NaN }] },
    { ...GOOD, changes: [{ key: 'editor_font_size', value: Infinity }] },
    { ...GOOD, changes: [{ key: 'time_format_24h', value: true }, { key: 'time_format_24h', value: false }] },
  ];
  for (const input of bad) {
    assert.deepEqual(output(await tool.execute(input, context)), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.deepEqual(calls, []);
});

test('the largest allowed batch passes the shape check', async () => {
  const { context, calls } = harness();
  const changes = Array.from({ length: PRIMARY_SETTINGS_LIMITS.changes_max },
    (_value, index) => ({ key: PRIMARY_SETTINGS_KEYS[index], value: index }));
  await tool.execute({ changes, purpose: 'x'.repeat(PRIMARY_SETTINGS_LIMITS.purpose_chars) }, context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].changes.length, PRIMARY_SETTINGS_LIMITS.changes_max);
});

test('a key off the list is not_allowed before the port is called, naming the key', async () => {
  const { context, calls } = harness();
  for (const key of ['api_key', 'safety_mode', 'tool_permissions', 'model', '__proto__', 'constructor', 'TIME_FORMAT_24H']) {
    const result = await tool.execute({ ...GOOD, changes: [{ key, value: 'x' }] }, context);
    assert.deepEqual(output(result), { ok: false, reason: 'not_allowed', key });
    assert.deepEqual(result.metadata, { result_kind: 'settings_change', status: 'refused', reason: 'not_allowed' });
  }
  const mixed = await tool.execute({ ...GOOD, changes: [{ key: 'time_format_24h', value: true }, { key: 'api_key', value: 'x' }] }, context);
  assert.deepEqual(output(mixed), { ok: false, reason: 'not_allowed', key: 'api_key' });
  assert.deepEqual(calls, []);
});

test('Auto as the default run mode is not_allowed before the port, the other run modes pass', async () => {
  const { context, calls } = harness();
  for (const value of ['auto', 'Auto', ' AUTO ']) {
    const result = await tool.execute({ ...GOOD, changes: [{ key: 'default_run_mode', value }] }, context);
    assert.deepEqual(output(result), { ok: false, reason: 'not_allowed', key: 'default_run_mode' });
  }
  assert.deepEqual(calls, []);
  for (const value of PRIMARY_SETTINGS_RUN_MODES) {
    assert.equal(output(await tool.execute({ ...GOOD, changes: [{ key: 'default_run_mode', value }] }, context)).ok, true, value);
  }
});

test('the caller and call id come from the live binding and the port answer passes through', async () => {
  const { context, calls } = harness();
  const input = { changes: [{ key: 'time_format_24h', value: true }, { key: 'editor_font_size', value: 16 }, { key: 'ui_language', value: 'de' }],
    purpose: 'Use the 24 hour clock, bigger editor text and German.' };
  const result = await tool.execute(input, context);
  // The port gets the changes and the live caller; the purpose is the card's headline, never the port's.
  assert.deepEqual(calls, [{ changes: input.changes, session_id: 'caller', tool_call_id: 'call-1' }]);
  assert.deepEqual(output(result), { ok: true, applied: [
    { key: 'time_format_24h', before: null, after: true }, { key: 'editor_font_size', before: null, after: 16 },
    { key: 'ui_language', before: null, after: 'de' }], change_id: CHANGE_ID });
  assert.deepEqual(result.metadata, { result_kind: 'settings_change', status: 'ok', change_id: CHANGE_ID });
  assert.equal(result.isError, false);
  assert.equal(tool.summarize({}), 'Settings: change');

  const denied = harness({ port: { change: async () => ({ ok: false, reason: 'denied' }) } });
  assert.deepEqual(output(await tool.execute(GOOD, denied.context)), { ok: false, reason: 'denied' });
  const keyed = harness({ port: { change: async () => ({ ok: false, reason: 'invalid_value', key: 'editor_tab_size' }) } });
  assert.deepEqual(output(await tool.execute(GOOD, keyed.context)), { ok: false, reason: 'invalid_value', key: 'editor_tab_size' });
});

test('a missing port, a throwing port or a stale call reads unavailable and leaks no exception text', async () => {
  const missing = harness({ port: null });
  assert.deepEqual(output(await tool.execute(GOOD, missing.context)), { ok: false, reason: 'unavailable' });
  const throwing = harness({ port: { change: async () => { throw new Error('private path C:\\Users\\x'); } } });
  const thrown = await tool.execute(GOOD, throwing.context);
  assert.deepEqual(output(thrown), { ok: false, reason: 'unavailable' });
  assert.equal(thrown.content.includes('private'), false);
  const nonObject = harness({ port: { change: async () => 'done' } });
  assert.deepEqual(output(await tool.execute(GOOD, nonObject.context)), { ok: false, reason: 'unavailable' });
  const stale = harness();
  stale.context.logicalTurnId = '';
  assert.deepEqual(output(await tool.execute(GOOD, stale.context)), { ok: false, reason: 'unavailable' });
  assert.deepEqual(stale.calls, []);
});

test('the kill switch answers disabled before any other work', async () => {
  const { context, calls } = harness({ featureFlags: { primary_settings_writes: false } });
  assert.deepEqual(output(await tool.execute(GOOD, context)), { ok: false, reason: 'disabled' });
  assert.deepEqual(output(await tool.execute({}, context)), { ok: false, reason: 'disabled' });
  assert.deepEqual(calls, []);
  const on = harness({ featureFlags: { primary_settings_writes: true } });
  assert.equal(output(await tool.execute(GOOD, on.context)).ok, true);
});

test('Plan mode and read-only chats refuse the change before the port', async () => {
  for (const flags of [{ planMode: true }, { readOnly: true }]) {
    const { context, calls } = harness();
    assert.deepEqual(output(await tool.execute(GOOD, { ...context, ...flags })), { ok: false, reason: 'mode_refused' });
    assert.deepEqual(calls, []);
  }
  // the executor preflight also withholds it from a read-only request before the tool runs
  const { context } = harness();
  assert.equal(executor()._preflightTool({ toolName: 'settings_change', callId: 'call-1', input: GOOD },
    { ...context, readOnly: true }, { preApproved: true }).tool, undefined);
});

test('the manifest, policy default and always-allow list pin the tool as side-effecting and ask-only', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'tools', 'tool-manifest.json'), 'utf8'));
  const entry = manifest.tools.find(item => item.name === 'settings_change');
  assert.equal(entry.side_effecting, true);
  assert.equal(entry.read_only, false);
  assert.equal(entry.owner, 'electron');
  assert.equal(entry.parameters.additionalProperties, false);
  assert.deepEqual(entry.parameters.required, ['changes', 'purpose']);
  assert.equal(entry.parameters.properties.changes.maxItems, PRIMARY_SETTINGS_LIMITS.changes_max);
  // Each item is one of two closed branches: any listed key but default_run_mode, or default_run_mode with a run mode (never auto).
  const [general, runMode] = entry.parameters.properties.changes.items.anyOf;
  assert.deepEqual(entry.parameters.properties.changes.items.anyOf.map(branch => branch.additionalProperties), [false, false]);
  assert.deepEqual(entry.parameters.properties.changes.minItems, 1);
  assert.deepEqual(general.properties.key.enum, PRIMARY_SETTINGS_KEYS.filter(key => key !== 'default_run_mode'));
  assert.deepEqual(general.properties.value.type, ['boolean', 'number', 'string']);
  assert.equal(general.properties.value.maxLength, PRIMARY_SETTINGS_LIMITS.value_chars);
  assert.deepEqual(runMode.properties.key.enum, ['default_run_mode']);
  assert.deepEqual(runMode.properties.value.enum, PRIMARY_SETTINGS_RUN_MODES);
  assert.equal(entry.description.includes('Auto can never be set as the default run mode'), true);
  assert.equal(entry.parameters.properties.purpose.maxLength, PRIMARY_SETTINGS_LIMITS.purpose_chars);
  assert.equal(NEVER_PERSIST_ALWAYS_ALLOW.has('settings_change'), true);
  assert.equal(tool.sideEffecting, true);
  assert.equal(tool.readOnly, false);
});

test('the registry offers the tool only with the flag option, policy asks, and the bridge refuses it when hosted', async () => {
  assert.equal(createDefaultRegistry({}).getTool('settings_change'), undefined);
  assert.equal(createDefaultRegistry({ toolsPrimarySettingsEnabled: false }).getTool('settings_change'), undefined);
  const tools = executor();
  const registered = tools.registry.getTool('settings_change');
  assert.ok(registered);
  const { context } = harness();
  assert.equal(tools._evaluateToolPolicy(registered, GOOD, context).decision, 'ask');
  const hosted = await executeElectronToolRequest({ hostMode: 'server' }, { params: { tool_name: 'settings_change' } });
  assert.equal(hosted.success, false);
});
