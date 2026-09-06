'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { McpDiscoveryService } = require('../services/mcp-discovery-service');
const { configurationDigest, pendingTrust } = require('../services/mcp-config-store');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

function userData() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mcp-discovery-'));
  trackDirectory(directory);
  return directory;
}

function writeConfig(directory, servers, extra = {}) {
  fs.writeFileSync(path.join(directory, 'mcp-servers.json'), `${JSON.stringify({
    mcp_config_schema_version: 1, mcp_sse_enabled: false, mcp_servers: servers, ...extra,
  }, null, 2)}\n`, 'utf8');
}

function approvedServer(config, { enabled = true, toolsDigest = 'a'.repeat(64) } = {}) {
  return { ...config, enabled, trust: { status: 'approved',
    configuration_digest: configurationDigest(config), advertised_tools_digest: toolsDigest,
    reviewed_at: '2026-08-17T00:00:00.000Z' } };
}

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
  assert.deepEqual(service.getSidecarConfig(), { mcp_servers: [{ ...stdio,
    approved_tools_digest: 'a'.repeat(64) }], mcp_sse_enabled: false });
  const enabled = service.getSidecarConfig({ httpTransportEnabled: true });
  assert.equal(enabled.mcp_sse_enabled, true);
  assert.deepEqual(enabled.mcp_servers.map((row) => row.name), ['stdio_ok', 'remote']);
  assert.equal(enabled.mcp_servers[1].approved_tools_digest, 'a'.repeat(64));
  assert.equal('token' in enabled.mcp_servers[1].auth, false);
});

test('CRUD requires exact inspection before approval and invalidates trust after edits', async () => {
  const directory = userData();
  const requests = [];
  const refreshes = [];
  const backendService = { currentStatus: {}, sidecarClient: { connected: true,
    async request(method, params, options) {
      requests.push({ method, params, options });
      return { ok: true, identity: { name: 'docs' }, transport: 'stdio', tools: [],
        tools_digest: 'b'.repeat(64), tool_count: 0, malformed_tool_count: 0, latency_ms: 1 };
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
  const bytes = '{"mcp_config_schema_version":2,"mcp_sse_enabled":false,"mcp_servers":[]}\n';
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
  service._loadConfig = () => ({ mcp_servers: [server] });
  assert.equal((await service.testServer({ name: 'remote' })).ok, true);
  assert.deepEqual(inspected.auth, { kind: 'oauth_client_credentials',
    token_url: 'https://auth.example.test/token', client_id: 'client', scope: 'read' });
});
