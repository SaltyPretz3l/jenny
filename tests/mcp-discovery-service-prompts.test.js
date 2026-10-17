'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { McpDiscoveryService } = require('../services/mcp-discovery-service');
const { configurationDigest, pendingTrust } = require('../services/mcp-config-store');
const { API_VERSION } = require('../services/backend/sidecar-client');
const { MCP_ERROR_CODES } = require('../services/backend/error-codes');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { userData, writeConfig, approvedServer } = require('./helpers/mcp-discovery-fixtures');

test.afterEach(cleanupTrackedResources);

const CONFIG = { name: 'docs', transport: 'stdio', command: 'node', args: ['server.js'],
  request_timeout_seconds: 120 };
const PROMPTS = [{ name: 'review', description: 'Review code', arguments: [
  { name: 'target', description: '', required: true },
  { name: 'focus', description: '', required: true },
  { name: 'style', description: '', required: false },
] }];
const PROMPTS_DIGEST = 'b'.repeat(64);

function approved(config = CONFIG) {
  const row = approvedServer(config);
  return { ...row, prompts: PROMPTS,
    trust: { ...row.trust, advertised_prompts_digest: PROMPTS_DIGEST } };
}

function harness(rows = [approved()], response = { ok: true, text: 'Rendered', chars: 8 }) {
  const directory = userData();
  writeConfig(directory, rows, { mcp_config_schema_version: 2 });
  const requests = [], logs = [];
  const backendService = { currentStatus: {}, sidecarClient: { connected: true,
    async request(...args) {
      requests.push(args);
      if (response instanceof Error) throw response;
      return response;
    } } };
  const service = new McpDiscoveryService({ userDataPath: directory, backendService,
    log: (...entry) => logs.push(entry) });
  return { service, backendService, requests, logs };
}

test('Test and approve persist bounded prompt metadata and expose it only after approval', async () => {
  const inspection = { ok: true, tools_digest: 'a'.repeat(64), prompts: PROMPTS,
    prompts_digest: PROMPTS_DIGEST, prompt_count: 1, malformed_prompt_count: 0 };
  const { service, requests } = harness([{ ...CONFIG, enabled: false, trust: pendingTrust(CONFIG) }], inspection);
  assert.equal(await service.testServer({ name: 'docs', confirmed: true }), inspection);
  assert.deepEqual(service.lastInspections.get('docs'), { configurationDigest: configurationDigest(CONFIG),
    toolsDigest: inspection.tools_digest, promptsDigest: PROMPTS_DIGEST, prompts: PROMPTS });
  assert.deepEqual(service.getState().servers.find((row) => row.name === 'docs').prompts, []);
  assert.equal((await service.approveServer({ name: 'docs' })).ok, true);
  const [stored] = service.configStore.getState().document.mcp_servers;
  assert.deepEqual(stored.prompts, PROMPTS);
  assert.equal(stored.trust.advertised_prompts_digest, PROMPTS_DIGEST);
  const row = service.getState().servers.find((entry) => entry.name === 'docs');
  assert.deepEqual(row.prompts, PROMPTS);
  assert.equal(row.promptsCount, 1);
  const builtin = service.getState().servers.find((entry) => entry.builtin);
  assert.deepEqual(builtin.prompts, []);
  assert.equal(builtin.promptsCount, 0);
  await service.setServerEnabled({ name: 'docs', enabled: true });
  assert.equal('prompts' in service.getSidecarConfig().mcp_servers[0], false);
  assert.equal('advertised_prompts_digest' in service.getSidecarConfig().mcp_servers[0], false);
  assert.equal('prompts' in requests[0][1].server, false);
  await service.updateServer({ name: 'docs', server: { ...CONFIG, args: ['changed.js'] } });
  const [edited] = service.configStore.getState().document.mcp_servers;
  assert.equal(edited.trust.status, 'pending');
  assert.equal('prompts' in edited, false);
  assert.deepEqual(service.getState().servers.find((entry) => entry.name === 'docs').prompts, []);
});

test('malformed inspection metadata is discarded without changing the returned inspection', async () => {
  for (const [prompts, digest, expected] of [
    [PROMPTS, 'invalid', []], [PROMPTS, '', PROMPTS],
    [[{ name: 'Bad' }], PROMPTS_DIGEST, []],
    [Array.from({ length: 33 }, (_, i) => ({ name: `p${i}` })), PROMPTS_DIGEST, []],
  ]) {
    const inspection = { ok: true, tools_digest: 'a'.repeat(64), prompts, prompts_digest: digest };
    const { service, requests } = harness([approved()], inspection);
    assert.equal(await service.testServer({ name: 'docs', confirmed: true }), inspection);
    // Re-testing an approved row with stored prompts still keeps them off the wire.
    assert.equal('prompts' in requests[0][1].server, false);
    const recorded = service.lastInspections.get('docs');
    assert.deepEqual(recorded.prompts, expected);
    assert.equal(recorded.promptsDigest, digest === 'invalid' ? '' : digest);
    await service.approveServer({ name: 'docs' });
    assert.equal('prompts' in service.configStore.getState().document.mcp_servers[0], expected.length > 0);
  }
});

test('tool drift and credential backfill drop prompts with pending trust', async () => {
  const drift = harness();
  drift.backendService.currentStatus.mcp_servers_failed = [
    { name: 'docs', code: MCP_ERROR_CODES.TOOL_SURFACE_CHANGED },
  ];
  drift.service.getState();
  const [row] = drift.service.configStore.getState().document.mcp_servers;
  assert.equal(row.trust.status, 'pending');
  assert.equal('prompts' in row, false);
  const remote = { name: 'remote', transport: 'sse', url: 'https://mcp.example.test/sse', auth: { kind: 'bearer' } };
  const auth = harness([approved(remote)]);
  auth.backendService.secureStore = {
    setMcpAuthToken() {}, hasMcpAuthToken: () => true, getStatus: () => ({ status: 'ready' }),
  };
  assert.equal((await auth.service.setMcpAuthToken({ serverName: 'remote', value: 'secret-value' })).ok, true);
  const [backfilled] = auth.service.configStore.getState().document.mcp_servers;
  assert.equal(backfilled.trust.status, 'pending');
  assert.equal('prompts' in backfilled, false);
});

test('getPrompt fails closed in order without requests or argument values in results or logs', async () => {
  const { service, backendService, requests, logs } = harness();
  const payload = { name: 'docs', prompt: 'review', arguments: { target: 'secret-value' } };
  async function rejects(input, code, argument) {
    const result = await service.getPrompt(input);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.equal(result.error.argument, argument);
    assert.equal(JSON.stringify({ result, logs }).includes('secret-value'), false);
    assert.equal(requests.length, 0);
  }
  backendService.sidecarClient.connected = false;
  await rejects({ ...payload, name: 'missing' }, 'sidecar_unavailable');
  backendService.sidecarClient.connected = true;
  await rejects({ ...payload, name: 'missing' }, 'server_not_found');
  await rejects({ ...payload, name: 'jenny_local_tools' }, 'server_disabled');
  service.configStore.update((doc) => ({ ...doc, mcp_servers: [{ ...approved(), enabled: false }] }));
  await rejects({ ...payload, prompt: 'unknown' }, 'server_disabled');
  service.configStore.update((doc) => ({ ...doc, mcp_servers: [{ ...CONFIG, enabled: false, trust: pendingTrust(CONFIG) }] }));
  await rejects({ ...payload, prompt: 'unknown' }, 'server_disabled');
  service.configStore.update((doc) => ({ ...doc, mcp_servers: [{ ...CONFIG, enabled: true, trust: pendingTrust(CONFIG) }] }));
  await rejects({ ...payload, prompt: 'unknown' }, 'not_approved');
  service.configStore.update((doc) => ({ ...doc, mcp_servers: [approved()] }));
  const getState = service.configStore.getState.bind(service.configStore);
  service.configStore.getState = () => {
    const state = getState();
    state.document.mcp_servers[0].trust.configuration_digest = 'c'.repeat(64);
    return state;
  };
  await rejects({ ...payload, prompt: 'unknown' }, 'not_approved');
  service.configStore.getState = getState;
  await rejects({ ...payload, prompt: 'unknown' }, 'prompt_unknown');
  for (const args of [null, [], 'secret-value', new Date(), Object.create({ target: 'secret-value' })]) {
    await rejects({ ...payload, arguments: args }, 'argument_invalid');
  }
  await rejects({ ...payload, arguments: { unknown: 'secret-value' } }, 'argument_invalid', 'unknown');
  await rejects({ ...payload, arguments: { ['u'.repeat(100)]: 'secret-value' } }, 'argument_invalid', 'u'.repeat(64));
  await rejects({ ...payload, arguments: { target: 42 } }, 'argument_invalid', 'target');
  await rejects({ ...payload, arguments: { target: 'secret-value'.repeat(400) } }, 'argument_invalid', 'target');
  await rejects({ ...payload, arguments: {} }, 'argument_missing', 'target');
  await rejects({ ...payload, arguments: { target: '  ', focus: '' } }, 'argument_missing', 'target');
  await rejects(payload, 'argument_missing', 'focus');
  assert.deepEqual(logs, []);
});

test('getPrompt forwards the version, approved names, arguments and row timeout', async () => {
  const { service, requests } = harness();
  const args = { target: 'secret-value', focus: 'security', style: '' };
  assert.deepEqual(await service.getPrompt({ name: 'docs', prompt: 'review', arguments: args }),
    { ok: true, server: 'docs', prompt: 'review', text: 'Rendered', chars: 8 });
  assert.deepEqual(requests, [['mcp.prompt_get', { accept_version: API_VERSION,
    server: 'docs', name: 'review', arguments: args }, { timeoutMs: 125000 }]]);
});

test('getPrompt bounds text, coerces result fields and defaults the request timeout', async () => {
  const { request_timeout_seconds: _timeout, ...config } = CONFIG;
  const { service, requests } = harness([approved(config)], { ok: true, text: 'x'.repeat(16001), chars: -5 });
  const args = { target: 'x'.repeat(4096), focus: 'y' };
  const result = await service.getPrompt({ name: 'docs', prompt: 'review', arguments: args });
  assert.equal(result.text.length, 16000);
  assert.equal(result.chars, 16000);
  assert.deepEqual(requests[0][2], { timeoutMs: 65000 });
  for (const reply of [{ ok: true }, { ok: true, text: 42, chars: 2 }, { ok: true, text: null }]) {
    const malformed = harness([approved()], reply);
    const refused = await malformed.service.getPrompt({ name: 'docs', prompt: 'review', arguments: args });
    assert.deepEqual(refused, { ok: false, error: { code: 'prompt_unavailable',
      message: 'The prompt could not be fetched.', reason: 'prompt_result_invalid' } });
  }
});

test('getPrompt redacts sidecar and thrown failures and emits one bounded warning', async () => {
  for (const reason of ['params_invalid', 'mcp_unavailable', 'prompt_failed', 'prompt_cancelled',
    'prompt_content_unsupported', 'prompt_result_invalid', 'too_many_prompts', 'SomeException', 'secret-value']) {
    const { service, requests, logs } = harness([approved()], { ok: false,
      failure: { reason, detail: 'secret-value' } });
    const safeReason = ['SomeException', 'secret-value'].includes(reason) ? 'failed' : reason;
    const result = await service.getPrompt({ name: 'docs', prompt: 'review',
      arguments: { target: 'secret-value', focus: 'x' } });
    assert.deepEqual(result, { ok: false, error: { code: 'prompt_unavailable',
      message: 'The prompt could not be fetched.', reason: safeReason } });
    assert.deepEqual(logs, [['WARN', 'mcp.prompt.failed', { server_name: 'docs', prompt: 'review', reason: safeReason }]]);
    assert.equal(JSON.stringify({ result, logs }).includes('secret-value'), false);
    assert.equal(requests.length, 1);
  }
  const { service, requests, logs } = harness([approved()], new Error('secret-value'));
  const result = await service.getPrompt({ name: 'docs', prompt: 'review', arguments: { target: 'secret-value', focus: 'x' } });
  assert.equal(result.error.reason, 'request_failed');
  assert.equal(requests.length, 1);
  assert.deepEqual(logs, [['WARN', 'mcp.prompt.failed', { server_name: 'docs', prompt: 'review', reason: 'request_failed' }]]);
  assert.equal(JSON.stringify({ result, logs }).includes('secret-value'), false);
});

test('getPrompt IPC handler delegates the payload and retains the unavailable fallback', async () => {
  for (const available of [false, true]) {
    const handlers = new Map();
    const payload = { name: 'docs', prompt: 'review', arguments: { target: 'x', focus: 'y' } };
    const calls = [];
    registerAuxiliaryIpcHandlers({
      ipcMainLike: { handle: (channel, handler) => handlers.set(channel, handler) },
      mcpDiscoveryService: available ? { getPrompt: (input) => { calls.push(input); return { ok: true }; } } : null,
    });
    assert.deepEqual(await handlers.get('mcp-discovery:get-prompt')({}, payload),
      available ? { ok: true } : { ok: false, error: { code: 'unavailable' } });
    assert.deepEqual(calls, available ? [payload] : []);
  }
});
