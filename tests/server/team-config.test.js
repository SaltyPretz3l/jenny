'use strict';

// Team slice 1c-1a: the host config's schema 3 `team` block, the Ed25519 key
// helper that moved to ids.js, and the host key's secret file name.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadHostConfig } = require('../../server/config');
const { FileSecretStore, TEAM_HOST_SECRET_FILES } = require('../../server/file-secret-store');
const { keyPairFromSeed } = require('../../server/team/ids');

test.beforeEach((t) => {
  // CI checks out under the real home; isolate the home-containment fixture too.
  t.mock.method(os, 'homedir', () => path.join(process.cwd(), 'tmp-team-config-home'));
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp-team-config-'));
  const configPath = path.join(root, 'host.json');
  const source = {
    schema_version: 2,
    host_mode: 'server',
    host_execution_policy_version: 1,
    browser_access_mode: 'localhost_http',
    execution: null,
    canonical_origin: 'http://127.0.0.1:8080',
    listen_host: '127.0.0.1',
    port: 8080,
    user_data_path: path.join(root, 'profile'),
    workspace_root: null,
    secrets_dir: path.join(root, 'secrets'),
    model_endpoint: { engine: 'ollama', model: 'qwen3.5:9b', api_url: 'http://ollama:11434' },
  };
  const teamSource = () => {
    const { canonical_origin: _origin, browser_access_mode: _mode, ...rest } = source;
    return {
      ...rest,
      schema_version: 3,
      port: 0,
      team: { name: 'Core team', key_source: 'secret_file', direct_port: null },
    };
  };
  const write = (document) => {
    fs.writeFileSync(configPath, JSON.stringify(document), { mode: 0o600 });
  };
  write(source);
  return { root, configPath, source, teamSource, write };
}

function withFixture(callback) {
  const fixture = createFixture();
  try { return callback(fixture); } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
}

function reasonOf(configPath) {
  try {
    loadHostConfig(configPath);
  } catch (error) {
    assert.equal(error.code, 'CMP-HOST-0001');
    return error.reason;
  }
  return null;
}

const SCHEMA_TWO_KEYS = [
  'browserAccessMode', 'canonicalOrigin', 'execution', 'hostExecutionPolicyVersion', 'hostMode',
  'listenHost', 'logPath', 'memoryPath', 'modelEndpoint', 'port', 'resourceLimits', 'runtimeHome',
  'schemaVersion', 'secretsDir', 'userDataPath', 'workspaceRoot',
];

test('a schema 2 file loads to the same object as before, with no team key', () => withFixture(({ configPath }) => {
  const config = loadHostConfig(configPath);
  assert.deepEqual(Object.keys(config).sort(), SCHEMA_TWO_KEYS);
  assert.equal('team' in config, false);
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.browserAccessMode, 'localhost_http');
  assert.equal(config.canonicalOrigin, 'http://127.0.0.1:8080');
  assert.equal(config.resourceLimits.maxConcurrentRequests, 32);
  assert.equal(config.port, 8080);
}));

test('a schema 3 file without a team block loads like schema 2', () => withFixture(({ configPath, source, write }) => {
  const two = loadHostConfig(configPath);
  write({ ...source, schema_version: 3 });
  const three = loadHostConfig(configPath);
  assert.equal(three.schemaVersion, 3);
  assert.deepEqual({ ...three, schemaVersion: 2 }, two);
  assert.deepEqual(Object.keys(three).sort(), SCHEMA_TWO_KEYS);
  write({ ...source, schema_version: 3, port: 0 });
  assert.equal(reasonOf(configPath), 'invalid_host_limit');
}));

test('schema 4 is a future schema and a team block needs schema 3', () => withFixture(({ configPath, source, teamSource, write }) => {
  write({ ...source, schema_version: 4 });
  assert.equal(reasonOf(configPath), 'config_schema_future');
  write({ ...teamSource(), schema_version: 4 });
  assert.equal(reasonOf(configPath), 'config_schema_future');
  for (const schemaVersion of [1, 2]) {
    write({ ...teamSource(), schema_version: schemaVersion });
    assert.equal(reasonOf(configPath), 'config_unknown_field', `schema ${schemaVersion}`);
  }
}));

test('a team block loads with a frozen team record and the team defaults', () => withFixture(({ configPath, teamSource, write }) => {
  write(teamSource());
  const config = loadHostConfig(configPath);
  assert.deepEqual(config.team, { name: 'Core team', keySource: 'secret_file', directPort: null });
  assert.equal(Object.isFrozen(config.team), true);
  assert.equal(Object.isFrozen(config), true);
  assert.equal(config.schemaVersion, 3);
  assert.equal(config.port, 0);
  assert.equal(config.listenHost, '127.0.0.1');
  assert.equal(config.canonicalOrigin, null);
  assert.equal(config.browserAccessMode, null);
  assert.equal(config.workspaceRoot, null);
  assert.equal(config.execution, null);
  assert.equal(config.hostExecutionPolicyVersion, 1);
  assert.equal(config.resourceLimits.maxConcurrentRequests, 64);
  assert.equal(config.resourceLimits.maxBodyBytes, 1024 * 1024);
  write({ ...teamSource(), port: 4100,
    team: { name: 'Core team', key_source: 'parent_channel', direct_port: 51820 } });
  const direct = loadHostConfig(configPath);
  assert.equal(direct.port, 4100);
  assert.deepEqual(direct.team, { name: 'Core team', keySource: 'parent_channel', directPort: 51820 });
}));

test('team concurrency defaults to 64 and an explicit value is honoured up to 64', () => withFixture(({ configPath, teamSource, write }) => {
  write({ ...teamSource(), resource_limits: { max_body_bytes: 2048 } });
  const defaults = loadHostConfig(configPath).resourceLimits;
  assert.equal(defaults.maxConcurrentRequests, 64);
  assert.equal(defaults.maxBodyBytes, 2048);
  write({ ...teamSource(), resource_limits: { max_concurrent_requests: 10 } });
  assert.equal(loadHostConfig(configPath).resourceLimits.maxConcurrentRequests, 10);
  write({ ...teamSource(), resource_limits: { max_concurrent_requests: 65 } });
  assert.equal(reasonOf(configPath), 'invalid_host_limit');
}));

test('a team block ignores the browser fields without validating them', () => withFixture(({ configPath, teamSource, write }) => {
  write({ ...teamSource(), canonical_origin: 'not a url', browser_access_mode: 'whatever' });
  const config = loadHostConfig(configPath);
  assert.equal(config.canonicalOrigin, null);
  assert.equal(config.browserAccessMode, null);
}));

test('a team block requires loopback, no execution and no workspace', () => withFixture(({ configPath, teamSource, write }) => {
  for (const listenHost of ['0.0.0.0', '::1', '127.0.0.2', 'localhost']) {
    write({ ...teamSource(), listen_host: listenHost });
    assert.equal(reasonOf(configPath), 'team_listen_host_loopback_required', listenHost);
  }
  write({ ...teamSource(), execution: { mode: 'offline-copy' } });
  assert.equal(reasonOf(configPath), 'team_execution_forbidden');
  write({ ...teamSource(), execution: { mode: 'offline-copy' }, host_execution_policy_version: 2,
    workspace_root: '/workspaces/default' });
  assert.equal(reasonOf(configPath), 'team_execution_forbidden');
  write({ ...teamSource(), execution: null });
  assert.equal(reasonOf(configPath), null);
  write({ ...teamSource(), workspace_root: path.join(process.cwd(), 'tmp-team-config-workspace') });
  assert.equal(reasonOf(configPath), 'team_workspace_forbidden');
  write({ ...teamSource(), workspace_root: '/workspaces/default' });
  assert.equal(reasonOf(configPath), 'team_workspace_forbidden');
  const { workspace_root: _workspace, ...withoutWorkspace } = teamSource();
  write(withoutWorkspace);
  assert.equal(reasonOf(configPath), 'team_workspace_forbidden');
  write({ ...teamSource(), host_execution_policy_version: 2 });
  assert.equal(reasonOf(configPath), 'host_execution_policy_unsupported');
  write({ ...teamSource(), host_execution_policy_version: 3 });
  assert.equal(reasonOf(configPath), 'host_execution_policy_future');
}));

test('the team record is closed and every field is checked', () => withFixture(({ configPath, teamSource, write }) => {
  const good = { name: 'Core team', key_source: 'parent_channel', direct_port: 4000 };
  const cases = [
    [{ ...good, extra: true }, 'team_block_invalid'],
    [{ name: good.name, key_source: good.key_source }, 'team_block_invalid'],
    [{ key_source: good.key_source, direct_port: null }, 'team_block_invalid'],
    [null, 'team_block_invalid'],
    [[], 'team_block_invalid'],
    ['team', 'team_block_invalid'],
    [{ ...good, name: '' }, 'team_name_invalid'],
    [{ ...good, name: ' padded ' }, 'team_name_invalid'],
    [{ ...good, name: 'two\nlines' }, 'team_name_invalid'],
    [{ ...good, name: 'a'.repeat(41) }, 'team_name_invalid'],
    [{ ...good, name: 7 }, 'team_name_invalid'],
    [{ ...good, key_source: 'env' }, 'team_key_source_invalid'],
    [{ ...good, key_source: null }, 'team_key_source_invalid'],
    [{ ...good, direct_port: 0 }, 'team_direct_port_invalid'],
    [{ ...good, direct_port: 65536 }, 'team_direct_port_invalid'],
    [{ ...good, direct_port: 1.5 }, 'team_direct_port_invalid'],
    [{ ...good, direct_port: '4000' }, 'team_direct_port_invalid'],
  ];
  for (const [team, reason] of cases) {
    write({ ...teamSource(), team });
    assert.equal(reasonOf(configPath), reason, JSON.stringify(team));
  }
  for (const directPort of [1, 65535]) {
    write({ ...teamSource(), team: { ...good, direct_port: directPort } });
    assert.equal(loadHostConfig(configPath).team.directPort, directPort);
  }
}));

test('E19: a team block may leave model_endpoint out; it loads as modelEndpoint null', () => withFixture(({ configPath, teamSource, write }) => {
  const { model_endpoint: _dropped, ...noModel } = teamSource();
  write(noModel);
  const config = loadHostConfig(configPath);
  assert.equal(config.modelEndpoint, null);
  assert.equal(config.team.name, 'Core team');
}));

test('E19: without a team block model_endpoint is still required, with the same reason', () => withFixture(({ configPath, source, write }) => {
  write({ ...source, model_endpoint: undefined });
  const before = reasonOf(configPath);
  const { model_endpoint: _dropped, ...noModel } = source;
  write(noModel);
  assert.equal(reasonOf(configPath), 'model_endpoint_invalid');
  assert.equal(before, 'model_endpoint_invalid');
  write({ ...noModel, schema_version: 3 });
  assert.equal(reasonOf(configPath), 'model_endpoint_invalid', 'a schema 3 file without a team block too');
}));

test('E19: a team block with a model_endpoint still validates it exactly', () => withFixture(({ configPath, teamSource, write }) => {
  write(teamSource());
  assert.deepEqual({ ...loadHostConfig(configPath).modelEndpoint },
    { engine: 'ollama', model: 'qwen3.5:9b', apiUrl: 'http://ollama:11434' });
  write({ ...teamSource(), model_endpoint: { engine: 'replay', model: 'm', api_url: 'http://x' } });
  assert.equal(reasonOf(configPath), 'replay_engine_forbidden');
  write({ ...teamSource(), model_endpoint: null });
  assert.equal(reasonOf(configPath), 'model_endpoint_invalid', 'present means validated; null is not absent');
}));

test('the loader never rewrites a team config file', () => withFixture(({ configPath, teamSource, write }) => {
  write(teamSource());
  const before = fs.readFileSync(configPath);
  loadHostConfig(configPath);
  assert.equal(Buffer.compare(fs.readFileSync(configPath), before), 0);
}));

test('keyPairFromSeed derives the Ed25519 public key of a PKCS#8 key built here', () => {
  const seed = Buffer.from(Array.from({ length: 32 }, (_unused, index) => index + 1));
  // RFC 8410 PKCS#8 wrapper for an Ed25519 private key, then the 32-byte seed.
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const expected = crypto.createPublicKey(
    crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }),
  ).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  const pair = keyPairFromSeed(seed);
  assert.deepEqual(pair, { secretKey: seed.toString('base64url'), publicKey: expected });
  assert.equal(pair.publicKey, 'ebVWLo_mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ');
});

test('the file secret store serves team_host_key as trimmed text and null when missing', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-team-secret-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new FileSecretStore({ directory, files: TEAM_HOST_SECRET_FILES });
  assert.equal(store.get('team_host_key'), null);
  fs.writeFileSync(path.join(directory, 'team-host-key'), '  some-host-key-text\n', { mode: 0o600 });
  assert.equal(store.get('team_host_key'), 'some-host-key-text');
  assert.equal(store.get('not_a_secret'), null);
  assert.equal(store.get('openai_compatible_api_key'), null, 'the host key store reads nothing else');
  // The store the backend gets as its credential reader cannot name the host key.
  assert.equal(new FileSecretStore({ directory }).get('team_host_key'), null);
});
