'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { McpDiscoveryService } = require('../services/mcp-discovery-service');
const { configurationDigest, pendingTrust } = require('../services/mcp-config-store');
const { cleanupTrackedResources } = require('./helpers/resource-cleanup');
const { userData, writeConfig, approvedServer, REA_ROW } = require('./helpers/mcp-discovery-fixtures');

test.afterEach(cleanupTrackedResources);

function fakeSecureStore(initial = {}) {
  const secrets = new Map(Object.entries(initial));
  return {
    getStatus: () => ({ status: 'ready', recoveryTitle: '', recoveryHint: '' }),
    hasMcpAuthToken: (ref) => secrets.has(ref),
    getMcpAuthToken: (ref) => secrets.get(ref) || '',
    setMcpAuthToken: (ref, value) => secrets.set(ref, value),
    deleteMcpAuthToken: (ref) => secrets.delete(ref),
  };
}

test('state merges configured and runtime rows without exposing paths or credentials', () => {
  const directory = userData();
  const pending = { name: 'docs', transport: 'stdio', command: 'node', args: ['server.js'] };
  writeConfig(directory, [{ ...pending, enabled: false, trust: pendingTrust(pending) }]);
  const service = new McpDiscoveryService({ userDataPath: directory, backendService: {
    currentStatus: { mcp_servers: [{ name: 'runtime_only', transport: 'stdio' }],
      mcp_servers_connected: ['runtime_only'],
      tools_status: { mcp__runtime_only__search: { source_kind: 'mcp', server_name: 'runtime_only' } } },
  } });
  const state = service.getState();
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.readOnly, false);
  assert.deepEqual(state.servers.find((row) => row.name === 'docs').args, ['server.js']);
  assert.equal(state.servers.find((row) => row.name === 'docs').trust.status, 'pending');
  assert.equal(state.servers.find((row) => row.name === 'runtime_only').status, 'running');
  assert.equal(state.servers.find((row) => row.name === 'runtime_only').toolsCount, 1);
  assert.equal('configPath' in state, false);
  assert.equal(JSON.stringify(state).includes(directory), false);
});

test('sidecar config forwards only enabled approved rows with approved tool digests', () => {
  const directory = userData();
  const stdio = { name: 'stdio_ok', transport: 'stdio', command: 'node', args: ['server.js'] };
  const pending = { name: 'pending', transport: 'stdio', command: 'python', args: [] };
  const remote = { name: 'remote', transport: 'sse', url: 'https://mcp.example.test/sse',
    auth: { kind: 'bearer', secret_ref: 'mcp:remote' } };
  writeConfig(directory, [approvedServer(stdio), { ...pending, enabled: true, trust: pendingTrust(pending) },
    approvedServer(remote)], { mcp_sse_enabled: true });
  const service = new McpDiscoveryService({ userDataPath: directory });
  const enabled = service.getSidecarConfig();
  assert.equal(enabled.mcp_sse_enabled, true);
  assert.deepEqual(enabled.mcp_servers.map((row) => row.name), ['stdio_ok', 'remote']);
  assert.equal(enabled.mcp_servers[1].approved_tools_digest, 'a'.repeat(64));
  assert.equal('token' in enabled.mcp_servers[1].auth, false);

  const gateOffDirectory = userData();
  writeConfig(gateOffDirectory, [approvedServer(stdio), approvedServer(remote)], { mcp_sse_enabled: false });
  assert.deepEqual(new McpDiscoveryService({ userDataPath: gateOffDirectory }).getSidecarConfig(),
    { mcp_servers: [{ ...stdio, approved_tools_digest: 'a'.repeat(64) }], mcp_sse_enabled: false });
});

test('CRUD requires exact inspection before approval and invalidates trust after edits', async () => {
  const directory = userData();
  const requests = [];
  const refreshes = [];
  const backendService = { currentStatus: {}, sidecarClient: { connected: true,
    async request(method, params, options) {
      requests.push({ method, params, options });
      return { ok: true, identity: { name: 'docs' }, transport: 'stdio', tools: [],
        tools_digest: 'b'.repeat(64), tool_count: 0, latency_ms: 1 };
    } }, async refreshManagedConfig(reason) { refreshes.push(reason); } };
  const service = new McpDiscoveryService({ userDataPath: directory, backendService,
    now: () => '2026-08-17T12:00:00.000Z' });
  assert.equal((await service.createServer({ name: 'docs', transport: 'stdio', command: 'node',
    args: ['server.js'] })).ok, true);
  assert.equal((await service.createServer({ name: 'docs', transport: 'stdio', command: 'node' }))
    .error.code, 'duplicate_server_identity');
  assert.deepEqual(await service.testServer({ name: 'docs' }), {
    ok: false, confirmation_required: true, command: 'node', args: ['server.js'] });
  assert.equal((await service.testServer({ name: 'docs', confirmed: true })).ok, true);
  assert.equal(requests[0].method, 'mcp.inspect');
  assert.equal(requests[0].params.confirmed_stdio, true);
  assert.equal(requests[0].options.signal instanceof AbortSignal, true);
  assert.equal((await service.approveServer({ name: 'docs' })).ok, true);
  assert.equal((await service.setServerEnabled({ name: 'docs', enabled: true })).ok, true);
  assert.equal(service.getSidecarConfig().mcp_servers[0].approved_tools_digest, 'b'.repeat(64));
  assert.equal((await service.updateServer({ name: 'docs', server: { name: 'docs', transport: 'stdio',
    command: 'node', args: ['other.js'] } })).ok, true);
  const edited = service.getState().servers.find((row) => row.name === 'docs');
  assert.equal(edited.enabled, false);
  assert.equal(edited.trust.status, 'pending');
  assert.equal((await service.setServerEnabled({ name: 'docs', enabled: true })).error.code,
    'trust_review_required');
  assert.equal((await service.removeServer({ name: 'docs' })).ok, true);
  assert.deepEqual(refreshes, ['mcp_server_created', 'mcp_server_approved', 'mcp_server_enabled',
    'mcp_server_updated', 'mcp_server_removed']);
});

test('CRUD rejects the reserved built-in tool namespace identity', async () => {
  const service = new McpDiscoveryService({ userDataPath: userData() });
  const reserved = { name: 'jenny_local_tools', transport: 'stdio', command: 'node', args: [] };

  assert.equal((await service.createServer(reserved)).error.code, 'server_identity_invalid');
  assert.equal((await service.createServer({
    name: 'docs', transport: 'stdio', command: 'node', args: [],
  })).ok, true);
  assert.equal((await service.updateServer({ name: 'docs', server: reserved })).error.code,
    'server_identity_invalid');
  assert.deepEqual(service.configStore.getState().document.mcp_servers.map((row) => row.name), ['docs']);
});

test('stdio arguments remain verbatim through inspection and sidecar config forwarding', async () => {
  const directory = userData();
  const args = ['--label', '', '  ', 'value with spaces'];
  const config = { name: 'docs', transport: 'stdio', command: 'node', args };
  writeConfig(directory, [approvedServer(config)]);
  let inspected;
  const service = new McpDiscoveryService({ userDataPath: directory, backendService: {
    currentStatus: {}, sidecarClient: { connected: true, async request(_method, params) {
      inspected = params.server;
      return { ok: true, tools_digest: 'a'.repeat(64) };
    } },
  } });

  assert.deepEqual((await service.testServer({ name: 'docs' })).args, args);
  assert.equal((await service.testServer({ name: 'docs', confirmed: true })).ok, true);
  assert.deepEqual(inspected.args, args);
  assert.deepEqual(service.getSidecarConfig().mcp_servers[0].args, args);
});

test('superseded and disposed MCP inspections abort their in-flight probes', async () => {
  const directory = userData();
  const config = { name: 'docs', transport: 'stdio', command: 'node', args: [] };
  writeConfig(directory, [{ ...config, enabled: false, trust: pendingTrust(config) }]);
  const signals = [];
  const backendService = { currentStatus: {}, sidecarClient: { connected: true,
    request(_method, _params, options) {
      signals.push(options.signal);
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    } } };
  const service = new McpDiscoveryService({ userDataPath: directory, backendService });
  const first = service.testServer({ name: 'docs', confirmed: true });
  const second = service.testServer({ name: 'docs', confirmed: true });
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true);
  service.dispose();
  assert.equal(signals[1].aborted, true);
  assert.equal((await first).error.code, 'inspect_unavailable');
  assert.equal((await second).error.code, 'inspect_unavailable');
});

test('a failed retest invalidates a previously approvable inspection', async () => {
  const directory = userData();
  const config = { name: 'docs', transport: 'stdio', command: 'node', args: [] };
  writeConfig(directory, [{ ...config, enabled: false, trust: pendingTrust(config) }]);
  let succeed = true;
  const service = new McpDiscoveryService({ userDataPath: directory, backendService: {
    currentStatus: {}, sidecarClient: { connected: true, async request() {
      if (!succeed) throw new Error('synthetic probe failure');
      return { ok: true, tools_digest: 'b'.repeat(64), tools: [], tool_count: 0 };
    } },
  } });
  assert.equal((await service.testServer({ name: 'docs', confirmed: true })).ok, true);
  succeed = false;
  assert.equal((await service.testServer({ name: 'docs', confirmed: true })).error.code,
    'inspect_unavailable');
  assert.equal((await service.approveServer({ name: 'docs' })).error.code, 'inspection_required');
});

test('inspection degrades when the sidecar is missing and cannot approve stale results', async () => {
  const service = new McpDiscoveryService({ userDataPath: userData() });
  await service.createServer({ name: 'docs', transport: 'stdio', command: 'node' });
  assert.equal((await service.testServer({ name: 'docs', confirmed: true })).error.code,
    'sidecar_unavailable');
  assert.equal((await service.approveServer({ name: 'docs' })).error.code, 'inspection_required');
});

test('tool-surface drift disables the row and returns it to pending review', () => {
  const directory = userData();
  const config = { name: 'docs', transport: 'stdio', command: 'node', args: [] };
  writeConfig(directory, [approvedServer(config)]);
  const service = new McpDiscoveryService({ userDataPath: directory, backendService: {
    currentStatus: { mcp_servers_failed: [{ name: 'docs', code: 'CMP-MCP-0009', message: 'changed' }] },
  } });
  const row = service.getState().servers.find((server) => server.name === 'docs');
  assert.equal(row.enabled, false);
  assert.equal(row.trust.status, 'pending');
  assert.deepEqual(service.getSidecarConfig(), {});
});

test('future schemas are read-only and mutations preserve the original bytes', async () => {
  const directory = userData();
  const file = path.join(directory, 'mcp-servers.json');
  const bytes = '{"mcp_config_schema_version":3,"mcp_sse_enabled":false,"mcp_servers":[]}\n';
  fs.writeFileSync(file, bytes, 'utf8');
  const service = new McpDiscoveryService({ userDataPath: directory });
  assert.equal(service.getState().readOnly, true);
  assert.equal((await service.createServer({ name: 'docs', transport: 'stdio', command: 'node' }))
    .error.code, 'future_schema');
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('auth ref backfill invalidates trust and keeps safeStorage values off disk', async () => {
  const directory = userData();
  const remote = { name: 'remote', transport: 'sse', url: 'https://mcp.example.test/sse',
    auth: { kind: 'bearer' } };
  writeConfig(directory, [{ ...remote, enabled: false, trust: pendingTrust(remote) }],
    { mcp_sse_enabled: true });
  const secureStore = fakeSecureStore();
  const service = new McpDiscoveryService({ userDataPath: directory,
    backendService: { currentStatus: {}, secureStore, async refreshManagedConfig() {} } });
  assert.equal((await service.setMcpAuthToken({ serverName: 'remote', value: 'super-secret' })).ok, true);
  const bytes = fs.readFileSync(path.join(directory, 'mcp-servers.json'), 'utf8');
  assert.equal(bytes.includes('super-secret'), false);
  assert.equal(JSON.parse(bytes).mcp_servers[0].auth.secret_ref, 'mcp:remote');
  assert.equal(secureStore.hasMcpAuthToken('mcp:remote'), true);
});

test('inspection normalization drops plaintext credential fields from downstream shapes', async () => {
  const server = { name: 'remote', transport: 'sse',
    url: 'https://mcp.example.test/sse', auth: { kind: 'oauth_client_credentials',
      token_url: 'https://auth.example.test/token', client_id: 'client', scope: 'read',
      token: 'secret', client_secret: 'secret' } };
  let inspected;
  const service = new McpDiscoveryService({ userDataPath: userData(), backendService: {
    currentStatus: {}, sidecarClient: { connected: true, async request(_method, params) {
      inspected = params.server;
      return { ok: true, tools_digest: 'a'.repeat(64) };
    } },
  } });
  service._loadConfig = () => ({ mcp_sse_enabled: true, mcp_servers: [server] });
  assert.equal((await service.testServer({ name: 'remote' })).ok, true);
  assert.deepEqual(inspected.auth, { kind: 'oauth_client_credentials',
    token_url: 'https://auth.example.test/token', client_id: 'client', scope: 'read' });
});

for (const documentGate of [false, true]) {
  test(`SSE inspection does not depend on the document gate (${documentGate})`, async () => {
    const directory = userData();
    const server = { name: 'remote', transport: 'sse', url: 'https://example.test/sse',
      auth: { kind: 'bearer', secret_ref: 'mcp:remote' } };
    writeConfig(directory, [approvedServer(server)], { mcp_sse_enabled: documentGate });
    let requests = 0;
    let secretReads = 0;
    let params;
    const service = new McpDiscoveryService({ userDataPath: directory, backendService: {
      secureStore: { getMcpAuthToken() { secretReads += 1; return 'secret'; } },
      sidecarClient: { connected: true, async request(_method, value) {
        requests += 1; params = value;
        return { ok: true, tools_digest: 'b'.repeat(64) };
      } },
    } });
    const result = await service.testServer({ name: 'remote' });
    assert.equal(result.ok, true);
    assert.equal(params.mcp_sse_enabled, true);
    assert.equal(requests, 1);
    assert.equal(secretReads, 1);
  });
}

for (const operation of ['disable', 'remove']) {
  test(`runtime refresh failure reports pending application after ${operation}`, async () => {
    const directory = userData();
    const server = { name: 'docs', transport: 'stdio', command: 'node', args: [] };
    writeConfig(directory, [approvedServer(server)]);
    const service = new McpDiscoveryService({ userDataPath: directory, backendService: {
      currentStatus: { mcp_servers_connected: ['docs'] },
      async refreshManagedConfig() { throw new Error('initialize failed'); },
    } });
    const result = operation === 'remove' ? await service.removeServer({ name: 'docs' })
      : await service.setServerEnabled({ name: 'docs', enabled: false });
    assert.equal(result.ok, false);
    assert.equal(result.saved, true);
    assert.equal(result.runtimeApplied, false);
    assert.equal(result.error.code, 'CMP-MCP-0004');
    assert.match(result.error.message, /previous runtime configuration may still be active/);
    const document = JSON.parse(fs.readFileSync(path.join(directory, 'mcp-servers.json'), 'utf8'));
    assert.equal(operation === 'remove' ? document.mcp_servers.length : document.mcp_servers[0].enabled,
      operation === 'remove' ? 0 : false);
  });
}

test('enabling an approved SSE server turns on the document gate atomically', async () => {
  const directory = userData();
  const server = { name: 'remote', transport: 'sse', url: 'https://example.test/sse' };
  writeConfig(directory, [approvedServer(server, { enabled: false })]);
  const service = new McpDiscoveryService({ userDataPath: directory });
  assert.equal((await service.setServerEnabled({ name: 'remote', enabled: true })).ok, true);
  const document = JSON.parse(fs.readFileSync(path.join(directory, 'mcp-servers.json'), 'utf8'));
  assert.equal(document.mcp_sse_enabled, true);
  assert.equal(document.mcp_servers[0].enabled, true);
  assert.equal(service.getSidecarConfig().mcp_servers.length, 1);
});

test('server edits preserve omitted credentials and initialization timeout', async () => {
  const directory = userData();
  const server = { name: 'remote', transport: 'sse', url: 'https://example.test/sse',
    init_timeout_seconds: 45, auth: { kind: 'bearer', secret_ref: 'mcp:remote' } };
  writeConfig(directory, [approvedServer(server)]);
  const service = new McpDiscoveryService({ userDataPath: directory });
  assert.equal((await service.updateServer({ name: 'remote', server: {
    name: 'remote', transport: 'sse', url: server.url, auth: { kind: 'bearer' },
  } })).ok, true);
  let row = service.configStore.getState().document.mcp_servers[0];
  assert.equal(row.auth.secret_ref, 'mcp:remote');
  assert.equal(row.init_timeout_seconds, 45);
  assert.equal((await service.updateServer({ name: 'remote', server: {
    name: 'remote', transport: 'sse', url: server.url,
  } })).ok, true);
  row = service.configStore.getState().document.mcp_servers[0];
  assert.equal(row.auth.secret_ref, 'mcp:remote');
  assert.equal((await service.updateServer({ name: 'remote', server: {
    name: 'remote', transport: 'sse', url: server.url, auth: null,
  } })).ok, true);
  assert.equal(service.configStore.getState().document.mcp_servers[0].auth, undefined);
});

test('a stored credential does not follow a new auth kind or destination', async () => {
  const server = { name: 'remote', transport: 'sse', url: 'https://example.test/sse',
    auth: { kind: 'bearer', secret_ref: 'mcp:remote' } };
  const edits = [
    { url: 'https://other.test/sse' },
    { url: server.url, auth: { kind: 'oauth_client_credentials', secret_ref: 'mcp:remote',
      token_url: 'https://auth.example.test/token', client_id: 'client' } },
  ];
  for (const edit of edits) {
    const directory = userData();
    writeConfig(directory, [approvedServer(server)]);
    const service = new McpDiscoveryService({ userDataPath: directory });
    assert.equal((await service.updateServer({ name: 'remote', server: {
      name: 'remote', transport: 'sse', ...edit } })).ok, true);
    const row = service.configStore.getState().document.mcp_servers[0];
    assert.equal(row.auth?.secret_ref, undefined, JSON.stringify(edit));
  }
});

test('builtin discovery row is identified as built-in', () => {
  const service = new McpDiscoveryService({ userDataPath: userData() });
  const row = service.getState().servers.find((server) => server.name === 'jenny_local_tools');
  assert.equal(row.builtin, true);
  assert.equal(row.enabled, true);
});

test('confirmed stdio arguments survive the real Python parsing boundary', async () => {
  const { spawnSync } = require('node:child_process');
  const directory = userData();
  const args = ['--label', '', '  ', '--mode', 'safe'];
  const server = { name: 'docs', transport: 'stdio', command: 'node', args };
  writeConfig(directory, [approvedServer(server)]);
  let inspected;
  const service = new McpDiscoveryService({ userDataPath: directory, backendService: {
    sidecarClient: { connected: true, async request(_method, params) {
      inspected = params.server;
      return { ok: true, tools_digest: 'a'.repeat(64) };
    } },
  } });
  assert.deepEqual((await service.testServer({ name: 'docs' })).args, args);
  assert.equal((await service.testServer({ name: 'docs', confirmed: true })).ok, true);
  const python = process.platform === 'win32'
    ? path.join(__dirname, '..', '.venv', 'Scripts', 'python.exe') : 'python3';
  const result = spawnSync(python, ['-c',
    'import json,sys; from sidecar.ai.config_parsing import _parse_mcp_servers; '
      + 'print(json.dumps(list(_parse_mcp_servers([json.load(sys.stdin)], sse_enabled=False)[0].args)))'],
  { cwd: path.join(__dirname, '..'), input: JSON.stringify(inspected), encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test('creating, approving, or disabling an SSE server does not enable its transport gate', async () => {
  const directory = userData();
  const service = new McpDiscoveryService({ userDataPath: directory });
  const server = { name: 'remote', transport: 'sse', url: 'https://example.test/sse' };
  assert.equal((await service.createServer(server)).ok, true);
  assert.equal(service.configStore.getState().document.mcp_sse_enabled, false);
  service.lastInspections.set('remote', {
    configurationDigest: configurationDigest(server), toolsDigest: 'a'.repeat(64),
    promptsDigest: '', prompts: [],
  });
  assert.equal((await service.approveServer({ name: 'remote' })).ok, true);
  assert.equal(service.configStore.getState().document.mcp_sse_enabled, false);
  assert.equal((await service.setServerEnabled({ name: 'remote', enabled: false })).ok, true);
  assert.equal(service.configStore.getState().document.mcp_sse_enabled, false);
});

test('explicit credential replacement is kept by server edits', async () => {
  const directory = userData();
  const server = { name: 'remote', transport: 'sse', url: 'https://example.test/sse',
    auth: { kind: 'bearer', secret_ref: 'mcp:old' } };
  writeConfig(directory, [approvedServer(server)]);
  const service = new McpDiscoveryService({ userDataPath: directory });
  assert.equal((await service.updateServer({ name: 'remote', server: {
    ...server, auth: { kind: 'bearer', secret_ref: 'mcp:new' },
  } })).ok, true);
  assert.equal(service.configStore.getState().document.mcp_servers[0].auth.secret_ref, 'mcp:new');
});

test('server updates still reject an empty editable definition', async () => {
  const directory = userData();
  const server = { name: 'docs', transport: 'stdio', command: 'node', args: [] };
  writeConfig(directory, [approvedServer(server)]);
  const service = new McpDiscoveryService({ userDataPath: directory });
  assert.equal((await service.updateServer({ name: 'docs', server: {} })).ok, false);
  assert.equal(service.configStore.getState().document.mcp_servers[0].enabled, true);
});

test('inspection waits for the row inspect timeout and forwards the row to the sidecar', async () => {
  const directory = userData();
  writeConfig(directory, [
    { ...REA_ROW, enabled: false, trust: pendingTrust(REA_ROW) },
    { name: 'docs', transport: 'stdio', command: 'node', args: [], enabled: false,
      trust: pendingTrust({ name: 'docs', transport: 'stdio', command: 'node', args: [] }) },
  ]);
  const requests = [];
  const backendService = { currentStatus: {}, sidecarClient: { connected: true,
    async request(method, params, options) {
      requests.push({ params, options });
      return { ok: false };
    } } };
  const service = new McpDiscoveryService({ userDataPath: directory, backendService });
  await service.testServer({ name: 'rea', confirmed: true });
  await service.testServer({ name: 'docs', confirmed: true });
  assert.equal(requests[0].options.timeoutMs, 95_000);
  assert.equal(requests[0].params.server.inspect_timeout_seconds, 90);
  assert.deepEqual(requests[0].params.server.env, { REA_LOG_LEVEL: 'debug' });
  assert.equal(requests[1].options.timeoutMs, 20_000);
  assert.equal('inspect_timeout_seconds' in requests[1].params.server, false);
});

test('approved rows forward env, limits and timeouts to the sidecar', () => {
  const directory = userData();
  writeConfig(directory, [approvedServer(REA_ROW)]);
  const service = new McpDiscoveryService({ userDataPath: directory });
  const [row] = service.getSidecarConfig().mcp_servers;
  assert.deepEqual(row.env, { REA_LOG_LEVEL: 'debug' });
  assert.equal(row.memory_limit_mb, 2048);
  assert.equal(row.max_processes, 16);
  assert.equal(row.inspect_timeout_seconds, 90);
  assert.equal(row.request_timeout_seconds, 900);
});

test('an edit that omits the row extensions keeps them for the same transport', async () => {
  const directory = userData();
  writeConfig(directory, [approvedServer(REA_ROW)]);
  const service = new McpDiscoveryService({ userDataPath: directory });
  assert.equal((await service.updateServer({ name: 'rea', server: { name: 'rea', transport: 'stdio',
    command: 'npx', args: ['-y', 'rea-agents@6.4.1', 'mcp'] } })).ok, true);
  const [row] = service.configStore.getState().document.mcp_servers;
  assert.deepEqual(row.env, { REA_LOG_LEVEL: 'debug' });
  assert.equal(row.memory_limit_mb, 2048);
  assert.equal(row.request_timeout_seconds, 900);
  assert.equal(row.trust.status, 'pending');
  assert.equal((await service.updateServer({ name: 'rea', server: { name: 'rea', transport: 'sse',
    url: 'https://mcp.example.test/sse' } })).ok, true);
  const [remote] = service.configStore.getState().document.mcp_servers;
  assert.equal('env' in remote, false);
  assert.equal(remote.inspect_timeout_seconds, 90);
});


test('runtime-only discovery preserves empty auth and non-secret summaries', () => {
  const { buildDiscoveryState } = require('../services/mcp-discovery-service');
  const state = buildDiscoveryState({ backendStatus: { mcp_servers: [
    { name: 'empty', transport: 'sse', auth: {} },
    { name: 'secrets', transport: 'sse', auth: { token: 'hidden', client_secret: 'hidden' } },
    { name: 'blank', transport: 'sse', auth: { kind: ' ', secret_ref: ' ' } },
    { name: 'remote', transport: 'sse', auth: { kind: ' BEARER ', secret_ref: ' mcp:remote ', token: 'hidden' } },
  ] } });
  for (const name of ['empty', 'secrets', 'blank']) {
    assert.equal(state.servers.find((row) => row.name === name).auth, null);
  }
  assert.deepEqual(state.servers.find((row) => row.name === 'remote').auth,
    { kind: 'bearer', secretRef: 'mcp:remote', token_url: '', client_id: '', scope: '' });
  assert.equal(JSON.stringify(state).includes('hidden'), false);
});

test('read_only_auto_allow is forwarded and kept across an editor update on either transport', async () => {
  const directory = userData();
  writeConfig(directory, [approvedServer({ ...REA_ROW, read_only_auto_allow: true })]);
  const service = new McpDiscoveryService({ userDataPath: directory });
  assert.equal(service.getSidecarConfig().mcp_servers[0].read_only_auto_allow, true);
  assert.equal((await service.updateServer({ name: 'rea', server: { name: 'rea', transport: 'stdio',
    command: 'npx', args: ['-y', 'rea-agents@6.4.1', 'mcp'] } })).ok, true);
  const [row] = service.configStore.getState().document.mcp_servers;
  assert.equal(row.read_only_auto_allow, true);
  assert.equal(row.trust.status, 'pending');
  assert.equal((await service.updateServer({ name: 'rea', server: { name: 'rea', transport: 'sse',
    url: 'https://mcp.example.test/sse' } })).ok, true);
  assert.equal(service.configStore.getState().document.mcp_servers[0].read_only_auto_allow, true);
  assert.equal((await service.updateServer({ name: 'rea', server: { name: 'rea', transport: 'sse',
    url: 'https://mcp.example.test/sse', read_only_auto_allow: false } })).ok, true);
  assert.equal(service.configStore.getState().document.mcp_servers[0].read_only_auto_allow, false);
});

test('discovery rows expose the read-only auto-allow switch state', () => {
  const directory = userData();
  writeConfig(directory, [approvedServer({ ...REA_ROW, read_only_auto_allow: true }),
    approvedServer({ name: 'docs', transport: 'stdio', command: 'node', args: ['server.js'] })]);
  const rows = new McpDiscoveryService({ userDataPath: directory }).getState().servers;
  const flag = (name) => rows.find((row) => row.name === name).readOnlyAutoAllow;
  assert.equal(flag('rea'), true);
  assert.equal(flag('docs'), false);
  assert.equal(flag('jenny_local_tools'), false);
});
