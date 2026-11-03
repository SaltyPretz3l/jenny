'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const tool = require('../services/tools/builtin/settings-get-tool');
const { createDefaultRegistry, ToolExecutor } = require('../services/tools');
const { PRIMARY_SETTINGS_KEYS } = require('../services/primary-settings-contract');
const { DEFAULT_TOOL_DEFAULTS } = require('../services/tools/tool-policy-evaluator');

const ANSWER = { ok: true, settings: [
  { key: 'time_format_24h', label: 'Use a 24-hour clock', kind: 'boolean', value: false },
  { key: 'default_run_mode', label: 'Default run mode', kind: 'enum', value: 'ask', allowed: [{ value: 'ask', label: 'Ask' }] },
], unavailable: ['palette'] };

function harness({ port, featureFlags } = {}) {
  const calls = [];
  const fake = port === undefined ? { async describe(args) { calls.push(args); return ANSWER; } } : port;
  return { calls, context: { sessionId: 'caller', primarySettingsService: fake,
    backendService: featureFlags ? { featureFlags } : {} } };
}

const output = result => JSON.parse(result.content);

test('no keys reads every setting and the port answer passes through unchanged', async () => {
  const { context, calls } = harness();
  const result = await tool.execute({}, context);
  assert.deepEqual(calls, [{ session_id: 'caller' }]);
  assert.deepEqual(output(result), ANSWER);
  assert.deepEqual(result.metadata, { result_kind: 'settings_get', status: 'ok' });
  assert.equal(result.isError, false);
  assert.equal(tool.summarize({}), 'Settings: read');
  assert.equal(tool.readOnly, true);
  assert.equal(tool.sideEffecting, false);
});

test('named keys are validated against the contract list before the port is called', async () => {
  const { context, calls } = harness();
  await tool.execute({ keys: ['time_format_24h', 'ui_language'] }, context);
  assert.deepEqual(calls, [{ keys: ['time_format_24h', 'ui_language'], session_id: 'caller' }]);
  await tool.execute({ keys: [...PRIMARY_SETTINGS_KEYS] }, context);
  assert.equal(calls.length, 2);
  const bad = [{ keys: [] }, { keys: 'palette' }, { keys: ['palette', 'palette'] }, { keys: ['api_key'] },
    { keys: [7] }, { keys: ['palette', 'api_key'] }, { keys: [...PRIMARY_SETTINGS_KEYS, 'palette'] },
    { keys: ['palette'], extra: true }, { key: 'palette' }, [], null];
  for (const input of bad) {
    assert.deepEqual(output(await tool.execute(input, context)), { ok: false, reason: 'invalid_input' }, JSON.stringify(input));
  }
  assert.equal(calls.length, 2);
});

test('a missing port, a throwing port or a non-object answer reads unavailable with no exception text', async () => {
  assert.deepEqual(output(await tool.execute({}, harness({ port: null }).context)), { ok: false, reason: 'unavailable' });
  const thrown = await tool.execute({}, harness({ port: { describe: async () => { throw new Error('private path'); } } }).context);
  assert.deepEqual(output(thrown), { ok: false, reason: 'unavailable' });
  assert.equal(thrown.content.includes('private'), false);
  assert.deepEqual(output(await tool.execute({}, harness({ port: { describe: async () => null } }).context)),
    { ok: false, reason: 'unavailable' });
});

test('the kill switch answers disabled without calling the port', async () => {
  const { context, calls } = harness({ featureFlags: { primary_settings_writes: false } });
  assert.deepEqual(output(await tool.execute({}, context)), { ok: false, reason: 'disabled' });
  assert.deepEqual(calls, []);
});

test('settings_get is read-only, policy auto, allowed in read-only and Plan requests, and the manifest matches the contract', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'services', 'tools', 'tool-manifest.json'), 'utf8'));
  const entry = manifest.tools.find(item => item.name === 'settings_get');
  assert.equal(entry.read_only, true);
  assert.equal(entry.side_effecting, false);
  assert.equal(entry.parameters.additionalProperties, false);
  assert.equal(entry.parameters.properties.keys.maxItems, PRIMARY_SETTINGS_KEYS.length);
  assert.equal(entry.parameters.properties.keys.uniqueItems, true);
  assert.equal(DEFAULT_TOOL_DEFAULTS.settings_get, 'auto');

  assert.equal(createDefaultRegistry({}).getTool('settings_get'), undefined);
  const tools = new ToolExecutor({ registry: createDefaultRegistry({ toolsPrimarySettingsEnabled: true }),
    permissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) }, pathPolicy: {}, logger: () => {} });
  const registered = tools.registry.getTool('settings_get');
  assert.ok(registered);
  assert.equal(tools._evaluateToolPolicy(registered, {}, { mode: 'auto' }).decision, 'auto');
  const preflight = tools._preflightTool({ toolName: 'settings_get', callId: 'call', input: {} },
    { readOnly: true, planMode: true }, { preApproved: true });
  assert.ok(preflight.tool, 'a read-only request keeps settings_get');
  const result = await tool.execute({}, { ...harness().context, readOnly: true, planMode: true });
  assert.equal(output(result).ok, true);
});
