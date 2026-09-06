'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MCP_CONFIG_SCHEMA_VERSION,
  McpConfigStore,
  configurationDigest,
  pendingTrust,
} = require('../services/mcp-config-store');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

function tempUserData() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mcp-config-'));
  trackDirectory(directory);
  return directory;
}

function writeConfig(userDataPath, value) {
  const file = path.join(userDataPath, 'mcp-servers.json');
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, bytes, 'utf8');
  return { file, bytes };
}

function currentServer(overrides = {}) {
  const config = { name: 'docs', transport: 'stdio', command: 'node', args: ['server.js'],
    ...overrides };
  return { ...config, enabled: false, trust: pendingTrust(config) };
}

test('missing configuration resolves to a writable versioned empty document', () => {
  const store = new McpConfigStore({ userDataPath: tempUserData() });
  assert.deepEqual(store.getState(), {
    document: { mcp_config_schema_version: MCP_CONFIG_SCHEMA_VERSION,
      mcp_sse_enabled: false, mcp_servers: [] },
    schemaVersion: MCP_CONFIG_SCHEMA_VERSION,
    readOnly: false,
    reason: '',
    migrated: false,
  });
});

test('legacy rows migrate atomically to disabled pending review and preserve secret refs', () => {
  const userDataPath = tempUserData();
  const { file } = writeConfig(userDataPath, {
    mcp_sse_enabled: true,
    mcp_servers: [{ name: 'remote', transport: 'sse', url: 'https://mcp.example.test/sse',
      auth: { kind: 'bearer', secret_ref: 'mcp:remote' } }],
  });
  const state = new McpConfigStore({ userDataPath }).getState();
  assert.equal(state.migrated, true);
  assert.equal(state.readOnly, false);
  assert.equal(state.document.mcp_servers[0].enabled, false);
  assert.equal(state.document.mcp_servers[0].trust.status, 'pending');
  assert.equal(state.document.mcp_servers[0].auth.secret_ref, 'mcp:remote');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcp_config_schema_version, 1);
});

for (const [name, payload, reason] of [
  ['future', { mcp_config_schema_version: 2, mcp_sse_enabled: false, mcp_servers: [] }, 'future_schema'],
  ['plaintext secret', { mcp_sse_enabled: true, mcp_servers: [{ name: 'remote', transport: 'sse',
    url: 'https://mcp.example.test/sse', auth: { kind: 'bearer', token: 'do-not-migrate' } }] }, 'plaintext_secret'],
  ['unknown lossy field', { mcp_sse_enabled: false, mcp_servers: [{ name: 'docs', transport: 'stdio',
    command: 'node', vendor_extension: true }] }, 'unknown_server_fields'],
  ['nested plaintext secret', { mcp_sse_enabled: true, mcp_servers: [{ name: 'remote', transport: 'sse',
    url: 'https://mcp.example.test/sse', auth: { kind: 'bearer',
      token_url: { client_secret: 'do-not-migrate' } } }] }, 'plaintext_secret'],
  ['lossy argument value', { mcp_sse_enabled: false, mcp_servers: [{ name: 'docs', transport: 'stdio',
    command: 'node', args: [{ legacy: true }] }] }, 'stdio_args_invalid'],
  ['legacy reserved built-in identity', { mcp_sse_enabled: false, mcp_servers: [{
    name: 'jenny_local_tools', transport: 'stdio', command: 'node', args: [],
  }] }, 'server_identity_invalid'],
  ['current reserved built-in identity', { mcp_config_schema_version: 1, mcp_sse_enabled: false,
    mcp_servers: [{ name: 'jenny_local_tools', transport: 'stdio', command: 'node', args: [],
      enabled: false, trust: {} }] }, 'server_identity_invalid'],
]) {
  test(`${name} configuration remains byte-identical and read-only`, () => {
    const userDataPath = tempUserData();
    const { file, bytes } = writeConfig(userDataPath, payload);
    const state = new McpConfigStore({ userDataPath }).getState();
    assert.equal(state.readOnly, true);
    assert.equal(state.reason, reason);
    assert.deepEqual(state.document.mcp_servers, []);
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  });
}

test('mixed valid and malformed rows forward none and preserve the source document', () => {
  const userDataPath = tempUserData();
  const { file, bytes } = writeConfig(userDataPath, { mcp_sse_enabled: false,
    mcp_servers: [{ name: 'good', transport: 'stdio', command: 'node' },
      { name: '../bad', transport: 'stdio', command: 'node' }] });
  const state = new McpConfigStore({ userDataPath }).getState();
  assert.equal(state.readOnly, true);
  assert.deepEqual(state.document.mcp_servers, []);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('failed atomic writes preserve the previous effective configuration', () => {
  const userDataPath = tempUserData();
  const initial = { mcp_config_schema_version: 1, mcp_sse_enabled: false,
    mcp_servers: [currentServer()] };
  const { file, bytes } = writeConfig(userDataPath, initial);
  const failingFs = Object.create(fs);
  failingFs.renameSync = () => { throw new Error('synthetic rename failure'); };
  const store = new McpConfigStore({ userDataPath, fsImpl: failingFs });
  const before = store.getState().document;
  const result = store.update((document) => ({ ...document, mcp_servers: [] }));
  assert.deepEqual(result, { ok: false, reason: 'write_failed' });
  assert.deepEqual(store.getState().document, before);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(configurationDigest(before.mcp_servers[0]), before.mcp_servers[0].trust.configuration_digest);
});

test('post-write verification failure restores and verifies previous bytes', () => {
  const userDataPath = tempUserData();
  const initial = { mcp_config_schema_version: 1, mcp_sse_enabled: false,
    mcp_servers: [currentServer()] };
  const { file, bytes } = writeConfig(userDataPath, initial);
  const verifyingFs = Object.create(fs);
  let configReads = 0;
  verifyingFs.readFileSync = (target, ...args) => {
    if (path.resolve(target) === path.resolve(file)) {
      configReads += 1;
      if (configReads === 3) return '{"mcp_config_schema_version":1,"mcp_servers":';
    }
    return fs.readFileSync(target, ...args);
  };
  const store = new McpConfigStore({ userDataPath, fsImpl: verifyingFs });
  const before = store.getState().document;
  assert.deepEqual(store.update((document) => ({ ...document, mcp_servers: [] })),
    { ok: false, reason: 'write_failed' });
  assert.deepEqual(store.getState().document, before);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('failed verification of a first write removes the replacement', () => {
  const userDataPath = tempUserData();
  const file = path.join(userDataPath, 'mcp-servers.json');
  const verifyingFs = Object.create(fs);
  verifyingFs.readFileSync = (target, ...args) => {
    if (path.resolve(target) === path.resolve(file)) throw new Error('synthetic verification failure');
    return fs.readFileSync(target, ...args);
  };
  const store = new McpConfigStore({ userDataPath, fsImpl: verifyingFs });
  assert.deepEqual(store.update((document) => ({ ...document,
    mcp_servers: [currentServer()] })), { ok: false, reason: 'write_failed' });
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(store.getState().document.mcp_servers, []);
});

test('rollback failure enters an observable read-only recovery state', () => {
  const userDataPath = tempUserData();
  const initial = { mcp_config_schema_version: 1, mcp_sse_enabled: false,
    mcp_servers: [currentServer()] };
  const { file } = writeConfig(userDataPath, initial);
  const events = [];
  const failingFs = Object.create(fs);
  let configReads = 0;
  let renames = 0;
  failingFs.readFileSync = (target, ...args) => {
    if (path.resolve(target) === path.resolve(file)) {
      configReads += 1;
      if (configReads === 3) return '{"mcp_config_schema_version":1,"mcp_servers":';
    }
    return fs.readFileSync(target, ...args);
  };
  failingFs.renameSync = (...args) => {
    renames += 1;
    if (renames === 2) throw new Error('synthetic rollback failure');
    return fs.renameSync(...args);
  };
  const store = new McpConfigStore({ userDataPath, fsImpl: failingFs,
    log: (...args) => events.push(args) });
  const result = store.update((document) => ({ ...document, mcp_servers: [] }));
  assert.deepEqual(result, { ok: false, reason: 'write_recovery_failed', read_only: true,
    recovery_required: true });
  assert.equal(store.getState().readOnly, true);
  assert.equal(store.getState().reason, 'write_recovery_failed');
  assert.equal(events[0][1], 'mcp.config.write_recovery_failed');
  assert.deepEqual(store.update((document) => document), {
    ok: false, reason: 'write_recovery_failed', read_only: true,
  });
});
