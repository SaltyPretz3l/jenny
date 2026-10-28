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
  normalizedServerConfig,
  pendingTrust,
  validateDocument,
  projectServerConfig,
  approvedPrompts,
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
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).mcp_config_schema_version,
    MCP_CONFIG_SCHEMA_VERSION);
});

for (const [name, payload, reason] of [
  ['future', { mcp_config_schema_version: 3, mcp_sse_enabled: false, mcp_servers: [] }, 'future_schema'],
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

// The digest of a row without the v2 extension keys is pinned: v2 injects no
// defaults, so every approved v1 row keeps its exact trust digest.
const V1_DOCS_ROW = { name: 'docs', transport: 'stdio', command: 'node', args: ['server.js'] };
const V1_DOCS_DIGEST = '4a45964c58332cfab35fd811c74257970bd77e17fcd03fb274befb17d851e654';

test('rows without extension keys keep their v1 configuration digest', () => {
  assert.equal(configurationDigest(V1_DOCS_ROW), V1_DOCS_DIGEST);
  assert.deepEqual(normalizedServerConfig(V1_DOCS_ROW).value, V1_DOCS_ROW);
});

test('row extensions normalize with sorted env keys and are digest-covered', () => {
  const row = { ...V1_DOCS_ROW, env: { REA_LOG_LEVEL: 'debug', REA_ANALYSIS_PROVIDER: 'none' },
    memory_limit_mb: 2048, max_processes: 16, inspect_timeout_seconds: 90,
    request_timeout_seconds: 900 };
  const normalized = normalizedServerConfig(row);
  assert.equal(normalized.ok, true);
  assert.deepEqual(Object.keys(normalized.value.env), ['REA_ANALYSIS_PROVIDER', 'REA_LOG_LEVEL']);
  assert.equal(normalized.value.memory_limit_mb, 2048);
  assert.equal(normalized.value.max_processes, 16);
  assert.equal(normalized.value.inspect_timeout_seconds, 90);
  assert.equal(normalized.value.request_timeout_seconds, 900);
  assert.notEqual(configurationDigest(row), V1_DOCS_DIGEST);
  assert.notEqual(configurationDigest(row),
    configurationDigest({ ...row, env: { REA_LOG_LEVEL: 'info', REA_ANALYSIS_PROVIDER: 'none' } }));
  const sse = normalizedServerConfig({ name: 'remote', transport: 'sse',
    url: 'https://mcp.example.test/sse', inspect_timeout_seconds: 60 });
  assert.equal(sse.ok, true);
  assert.equal(sse.value.inspect_timeout_seconds, 60);
});

const SSE_ROW = { name: 'remote', transport: 'sse', url: 'https://mcp.example.test/sse' };
const MANY_ENV = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`REA_KEY_${index}`, 'x']));
for (const [label, row, reason] of [
  ['secret-like env key', { ...V1_DOCS_ROW, env: { MY_TOKEN: 'x' } }, 'plaintext_secret'],
  ['secret env key', { ...V1_DOCS_ROW, env: { REA_CLIENT_SECRET: 'x' } }, 'plaintext_secret'],
  ['password env key', { ...V1_DOCS_ROW, env: { DB_PASSWORD: 'x' } }, 'plaintext_secret'],
  ['api key env key', { ...V1_DOCS_ROW, env: { OPENAI_API_KEY: 'x' } }, 'plaintext_secret'],
  ['private env key', { ...V1_DOCS_ROW, env: { PRIVATE_KEY_FILE: 'x' } }, 'plaintext_secret'],
  ['PATH env key', { ...V1_DOCS_ROW, env: { PATH: 'x' } }, 'reserved_env_key'],
  ['PATH-bearing env key', { ...V1_DOCS_ROW, env: { REA_PLUGIN_PATH: 'x' } }, 'reserved_env_key'],
  ['NODE_OPTIONS env key', { ...V1_DOCS_ROW, env: { NODE_OPTIONS: '--inspect' } }, 'reserved_env_key'],
  ['NODE_PATH env key', { ...V1_DOCS_ROW, env: { NODE_PATH: 'x' } }, 'reserved_env_key'],
  ['Windows machine-fact env key', { ...V1_DOCS_ROW, env: { PROGRAMDATA: 'x' } }, 'reserved_env_key'],
  ['npm alias of NODE_OPTIONS', { ...V1_DOCS_ROW, env: { NPM_CONFIG_NODE_OPTIONS: '--require=x' } }, 'reserved_env_key'],
  ['NODE_ family env key', { ...V1_DOCS_ROW, env: { NODE_ENV: 'production' } }, 'reserved_env_key'],
  ['JVM options env key', { ...V1_DOCS_ROW, env: { JAVA_TOOL_OPTIONS: '-javaagent:x' } }, 'reserved_env_key'],
  ['OPTS-bearing env key', { ...V1_DOCS_ROW, env: { REA_OPTS: '--x' } }, 'reserved_env_key'],
  ['ELECTRON_ family env key', { ...V1_DOCS_ROW, env: { ELECTRON_RUN_AS_NODE: '1' } }, 'reserved_env_key'],
  ['Jenny env key', { ...V1_DOCS_ROW, env: { JENNY_OPERATION_LEDGER_ROOT: 'x' } }, 'reserved_env_key'],
  ['XDG env key', { ...V1_DOCS_ROW, env: { XDG_CONFIG_HOME: 'x' } }, 'reserved_env_key'],
  ['Python env key', { ...V1_DOCS_ROW, env: { PYTHONSTARTUP: 'x' } }, 'reserved_env_key'],
  ['loader env key', { ...V1_DOCS_ROW, env: { LD_PRELOAD: 'x' } }, 'reserved_env_key'],
  ['dyld env key', { ...V1_DOCS_ROW, env: { DYLD_INSERT_LIBRARIES: 'x' } }, 'reserved_env_key'],
  ['passthrough env key', { ...V1_DOCS_ROW, env: { USERPROFILE: 'x' } }, 'reserved_env_key'],
  ['containment env key', { ...V1_DOCS_ROW, env: { OPENBLAS_NUM_THREADS: '8' } }, 'reserved_env_key'],
  ['windir env key', { ...V1_DOCS_ROW, env: { WINDIR: 'x' } }, 'reserved_env_key'],
  ['authorization env key', { ...V1_DOCS_ROW, env: { AUTHORIZATION: 'x' } }, 'reserved_env_key'],
  ['lower-case env key', { ...V1_DOCS_ROW, env: { rea_log_level: 'x' } }, 'env_invalid'],
  ['env array', { ...V1_DOCS_ROW, env: ['REA_LOG_LEVEL=debug'] }, 'env_invalid'],
  ['too many env entries', { ...V1_DOCS_ROW, env: MANY_ENV }, 'env_invalid'],
  ['control character env value', { ...V1_DOCS_ROW, env: { REA_LOG_LEVEL: 'a\nb' } }, 'env_invalid'],
  ['oversized env value', { ...V1_DOCS_ROW, env: { REA_LOG_LEVEL: 'x'.repeat(1025) } }, 'env_invalid'],
  ['non-string env value', { ...V1_DOCS_ROW, env: { REA_LOG_LEVEL: 3 } }, 'env_invalid'],
  ['memory below bound', { ...V1_DOCS_ROW, memory_limit_mb: 255 }, 'limits_invalid'],
  ['memory above bound', { ...V1_DOCS_ROW, memory_limit_mb: 8193 }, 'limits_invalid'],
  ['fractional memory', { ...V1_DOCS_ROW, memory_limit_mb: 1024.5 }, 'limits_invalid'],
  ['processes below bound', { ...V1_DOCS_ROW, max_processes: 0 }, 'limits_invalid'],
  ['processes above bound', { ...V1_DOCS_ROW, max_processes: 33 }, 'limits_invalid'],
  ['inspect timeout above bound', { ...V1_DOCS_ROW, inspect_timeout_seconds: 181 }, 'timeout_invalid'],
  ['inspect timeout below bound', { ...SSE_ROW, inspect_timeout_seconds: 0 }, 'timeout_invalid'],
  ['request timeout above bound', { ...V1_DOCS_ROW, request_timeout_seconds: 1801 }, 'timeout_invalid'],
  ['request timeout below bound', { ...V1_DOCS_ROW, request_timeout_seconds: 0 }, 'timeout_invalid'],
  ['env on an SSE row', { ...SSE_ROW, env: { REA_LOG_LEVEL: 'debug' } }, 'unknown_server_fields'],
  ['memory on an SSE row', { ...SSE_ROW, memory_limit_mb: 2048 }, 'unknown_server_fields'],
  ['request timeout on an SSE row', { ...SSE_ROW, request_timeout_seconds: 60 }, 'unknown_server_fields'],
]) {
  test(`row extension validation rejects ${label}`, () => {
    assert.deepEqual(normalizedServerConfig(row), { ok: false, reason });
    assert.equal(configurationDigest(row), '');
  });
}

test('a v1 document loads migrated with approvals intact and is written as v2 on the next write', () => {
  const userDataPath = tempUserData();
  // A genuine v1 row has no prompts digest; the v2 write adds the empty one.
  const approved = { ...V1_DOCS_ROW, enabled: true, trust: { status: 'approved',
    configuration_digest: V1_DOCS_DIGEST, advertised_tools_digest: 'a'.repeat(64),
    reviewed_at: '2026-08-17T00:00:00Z' } };
  const migrated = { ...approved, trust: { ...approved.trust, advertised_prompts_digest: '' } };
  const { file, bytes } = writeConfig(userDataPath, { mcp_config_schema_version: 1,
    mcp_sse_enabled: false, mcp_servers: [approved] });
  const store = new McpConfigStore({ userDataPath });
  const state = store.getState();
  assert.equal(state.readOnly, false);
  assert.equal(state.migrated, true);
  assert.deepEqual(state.document.mcp_servers, [migrated]);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  assert.equal(store.update((document) => document).ok, true);
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(written.mcp_config_schema_version, 2);
  assert.deepEqual(written.mcp_servers, [migrated]);
  assert.equal(store.getState().schemaVersion, 2);
});

test('read_only_auto_allow is an optional digest-covered boolean on both transports', () => {
  const { projectServerConfig } = require('../services/mcp-config-store');
  for (const base of [V1_DOCS_ROW, SSE_ROW]) {
    for (const value of [true, false]) {
      const normalized = normalizedServerConfig({ ...base, read_only_auto_allow: value });
      assert.equal(normalized.ok, true);
      assert.equal(normalized.value.read_only_auto_allow, value);
      assert.equal(projectServerConfig({ ...normalized.value, enabled: true }).read_only_auto_allow, value);
    }
    assert.equal('read_only_auto_allow' in normalizedServerConfig(base).value, false);
    assert.notEqual(configurationDigest({ ...base, read_only_auto_allow: true }), configurationDigest(base));
    assert.notEqual(configurationDigest({ ...base, read_only_auto_allow: true }),
      configurationDigest({ ...base, read_only_auto_allow: false }));
  }
  assert.equal(configurationDigest(V1_DOCS_ROW), V1_DOCS_DIGEST);
  for (const value of ['true', 1, null, {}]) {
    assert.deepEqual(normalizedServerConfig({ ...V1_DOCS_ROW, read_only_auto_allow: value }),
      { ok: false, reason: 'read_only_auto_allow_invalid' });
    assert.deepEqual(normalizedServerConfig({ ...SSE_ROW, read_only_auto_allow: value }),
      { ok: false, reason: 'read_only_auto_allow_invalid' });
  }
});

function promptDocument(prompts, trustOverrides = {}) {
  const row = { ...V1_DOCS_ROW, enabled: true, prompts, trust: {
    status: 'approved', configuration_digest: V1_DOCS_DIGEST, advertised_tools_digest: 'a'.repeat(64),
    reviewed_at: '2026-10-14T00:00:00Z', ...trustOverrides,
  } };
  return { mcp_config_schema_version: 2, mcp_sse_enabled: false, mcp_servers: [row] };
}

test('approved prompts normalize bounded descriptions, defaults and prompt order, preserving argument order', () => {
  const document = promptDocument([{ name: 'z', description: 'd'.repeat(2049), arguments: [
    { name: 'z', description: 'a'.repeat(2049), required: true }, { name: 'a' },
  ] }, { name: 'a' }]);
  const checked = validateDocument(document);
  assert.equal(checked.ok, true);
  const [row] = checked.value.mcp_servers;
  assert.deepEqual(row.prompts, [{ name: 'a', description: '', arguments: [] },
    { name: 'z', description: 'd'.repeat(2048), arguments: [
      { name: 'z', description: 'a'.repeat(2048), required: true },
      { name: 'a', description: '', required: false },
    ] }]);
  assert.deepEqual(approvedPrompts(row), row.prompts);
  assert.deepEqual(approvedPrompts({ ...row, trust: pendingTrust(row) }), []);
  assert.deepEqual(approvedPrompts(null), []);
  assert.deepEqual(approvedPrompts({ trust: row.trust }), []);
  const without = { ...row };
  delete without.prompts;
  assert.equal(configurationDigest(row), configurationDigest(without));
  assert.deepEqual(projectServerConfig(row), V1_DOCS_ROW);
  assert.equal('prompts' in validateDocument(promptDocument(undefined)).value.mcp_servers[0], false);
});

for (const [label, prompts] of [
  ['33 prompts', Array.from({ length: 33 }, (_, i) => ({ name: `p${i}` }))],
  ['17 arguments', [{ name: 'p', arguments: Array.from({ length: 17 }, (_, i) => ({ name: `a${i}` })) }]],
  ['bad prompt name', [{ name: 'Bad' }]], ['long name', [{ name: 'a'.repeat(65) }]],
  ['bad argument name', [{ name: 'p', arguments: [{ name: 'bad.name' }] }]],
  ['duplicate prompts', [{ name: 'p' }, { name: 'p' }]],
  ['duplicate arguments', [{ name: 'p', arguments: [{ name: 'a' }, { name: 'a' }] }]],
  ['non-boolean required', [{ name: 'p', arguments: [{ name: 'a', required: 'true' }] }]],
  ['null required', [{ name: 'p', arguments: [{ name: 'a', required: null }] }]],
  ['non-array prompts', {}], ['null prompts', null], ['non-object prompt', [null]],
  ['extra prompt field', [{ name: 'p', unknown: true }]],
  ['non-string description', [{ name: 'p', description: 2 }]],
  ['null arguments', [{ name: 'p', arguments: null }]],
  ['non-string argument description', [{ name: 'p', arguments: [{ name: 'a', description: false }] }]],
]) {
  test(`prompt metadata rejects ${label}`, () => {
    assert.deepEqual(validateDocument(promptDocument(prompts)), { ok: false, reason: 'prompts_invalid' });
  });
}

test('prompt metadata accepts exact bounds and drops pending and legacy prompt records', () => {
  const prompts = Array.from({ length: 32 }, (_, i) => ({ name: `p${i}`,
    arguments: Array.from({ length: 16 }, (_, j) => ({ name: `a${j}`, required: false })) }));
  assert.equal(validateDocument(promptDocument(prompts)).ok, true);
  for (const pending of [prompts, 5, [{ name: 'Bad' }]]) {
    const checked = validateDocument(promptDocument(pending, { status: 'pending' }));
    assert.equal(checked.ok, true);
    assert.equal('prompts' in checked.value.mcp_servers[0], false);
  }
  const secret = promptDocument(5);
  secret.mcp_servers[0].env = { API_TOKEN: 'plaintext' };
  assert.deepEqual(validateDocument(secret), { ok: false, reason: 'plaintext_secret' });
  const directory = tempUserData();
  writeConfig(directory, { ...promptDocument(prompts, { advertised_prompts_digest: 'b'.repeat(64) }),
    mcp_config_schema_version: 1 });
  const state = new McpConfigStore({ userDataPath: directory }).getState();
  assert.equal(state.readOnly, false);
  assert.equal('prompts' in state.document.mcp_servers[0], false);
  assert.equal(state.document.mcp_servers[0].trust.advertised_prompts_digest, '');
  const malformed = tempUserData();
  const { file, bytes } = writeConfig(malformed, promptDocument([{ name: 'Bad' }]));
  const store = new McpConfigStore({ userDataPath: malformed });
  assert.equal(store.getState().readOnly, true);
  assert.equal(store.getState().reason, 'prompts_invalid');
  assert.deepEqual(store.update((document) => document), { ok: false, read_only: true, reason: 'prompts_invalid' });
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('advertised prompt digest defaults to empty and validates without coercion', () => {
  for (const digest of [undefined, '', 'b'.repeat(64)]) {
    const trust = digest === undefined ? {} : { advertised_prompts_digest: digest };
    const result = validateDocument(promptDocument([], trust));
    assert.equal(result.ok, true);
    assert.equal(result.value.mcp_servers[0].trust.advertised_prompts_digest, digest || '');
  }
  for (const digest of [null, 42, {}, 'invalid', 'B'.repeat(64), ` ${'b'.repeat(64)}`]) {
    assert.deepEqual(validateDocument(promptDocument([], { advertised_prompts_digest: digest })),
      { ok: false, reason: 'trust_record_invalid' });
  }
});
