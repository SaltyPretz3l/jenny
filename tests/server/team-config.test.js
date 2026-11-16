'use strict';

// Team slice 1c-1a: the host config's schema 3 `team` block, the Ed25519 key
// helper that moved to ids.js, and the host key's secret file name.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadHostConfig, normalizeHostConfig } = require('../../server/config');
const { FileSecretStore, TEAM_HOST_SECRET_FILES } = require('../../server/file-secret-store');
const { keyPairFromSeed } = require('../../server/team/ids');
const { linkDirectory } = require('../helpers/platform-skips');

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

test('a team block refuses the browser fields the way it refuses execution', () => withFixture(({ configPath, teamSource, write }) => {
  write({ ...teamSource(), browser_access_mode: 'localhost_http' });
  assert.equal(reasonOf(configPath), 'browser_access_mode_invalid');
  write({ ...teamSource(), canonical_origin: 'http://127.0.0.1:8080' });
  assert.equal(reasonOf(configPath), 'canonical_origin_invalid');
  write({ ...teamSource(), canonical_origin: null, browser_access_mode: null });
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

// Review sweeps, second run (X5b-F02). Fault: "The team server uses local engines and member nodes only" had no host
// check: a hand-written team config could name a model Ollama sends to its hosted service. The node side's own rule
// (isCloudModelName) refuses it at load, on either engine (an OpenAI-compatible URL may be Ollama's own /v1).
test('a team config naming an Ollama cloud model is refused at load; a single-owner host is unchanged', () => withFixture(({ configPath, source, teamSource, write }) => {
  for (const engine of ['ollama', 'openai-compatible']) {
    for (const model of ['gpt-oss:120b-cloud', 'qwen3-coder:480b-cloud', 'deepseek-v3.1:671b-CLOUD', 'kimi-k2:cloud']) {
      write({ ...teamSource(), model_endpoint: { engine, model, api_url: 'http://127.0.0.1:11434' } });
      assert.equal(reasonOf(configPath), 'team_model_not_local', `${engine} ${model}`);
    }
  }
  write({ ...teamSource(), model_endpoint: { engine: 'ollama', model: 'cloudy-llama:8b', api_url: 'http://127.0.0.1:11434' } });
  assert.equal(loadHostConfig(configPath).modelEndpoint.model, 'cloudy-llama:8b', 'a local name that only mentions cloud loads');
  write({ ...source, model_endpoint: { engine: 'ollama', model: 'gpt-oss:120b-cloud', api_url: 'http://127.0.0.1:11434' } });
  assert.equal(loadHostConfig(configPath).modelEndpoint.model, 'gpt-oss:120b-cloud', 'not a team host: not this rule');
}));

// Slice 4a-4: the optional `team.pool` block. Absent means no pool; present, a closed record with
// one required field. A pool host names no model endpoint: the pool gateway is its endpoint.
function poolSource(teamSource, pool) {
  const { model_endpoint: _dropped, ...noModel } = teamSource();
  return { ...noModel, team: { ...noModel.team, ...(pool === undefined ? {} : { pool }) } };
}

test('4a-4: a team block without pool loads with no pool key', () => withFixture(({ configPath, teamSource, write }) => {
  write(poolSource(teamSource));
  const config = loadHostConfig(configPath);
  assert.equal(Object.hasOwn(config.team, 'pool'), false);
  assert.equal(config.modelEndpoint, null);
}));

test('4a-4: a valid pool loads as a frozen { contextLength } and the endpoint stays null', () => withFixture(({ configPath, teamSource, write }) => {
  for (const contextLength of [2048, 32768, 1048576]) {
    write(poolSource(teamSource, { context_length: contextLength }));
    const config = loadHostConfig(configPath);
    assert.deepEqual({ ...config.team.pool }, { contextLength });
    assert.equal(Object.isFrozen(config.team.pool), true);
    assert.equal(config.modelEndpoint, null);
  }
}));

test('4a-4: every invalid pool shape is team_pool_invalid', () => withFixture(({ configPath, teamSource, write }) => {
  const shapes = [
    null, [], 'pool', 32768, {}, { context_length: 32768, extra: 1 }, { contextLength: 32768 },
    { context_length: 32768.5 }, { context_length: '32768' }, { context_length: null }, { context_length: 2047 },
    { context_length: 1048577 }, { context_length: -1 }, { context_length: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const pool of shapes) {
    write(poolSource(teamSource, pool));
    assert.equal(reasonOf(configPath), 'team_pool_invalid', JSON.stringify(pool));
  }
}));

test('4a-4: a pool with a model_endpoint is team_pool_endpoint_conflict', () => withFixture(({ configPath, teamSource, write }) => {
  const base = teamSource();
  write({ ...base, team: { ...base.team, pool: { context_length: 32768 } } });
  assert.equal(reasonOf(configPath), 'team_pool_endpoint_conflict');
  write({ ...base, model_endpoint: null, team: { ...base.team, pool: { context_length: 32768 } } });
  assert.equal(reasonOf(configPath), 'team_pool_endpoint_conflict', 'a null endpoint is still present');
}));

// Slice 5-5b: the optional `team.internet` record. Absent means off; present, exactly three fields,
// a direct port, and the invite and relay validators. Any other shape is team_internet_invalid.
const INTERNET_ON = Object.freeze({ map_port: true, public_address: 'team.example.org', relay_url: 'https://relay.example.org' });

function internetSource(teamSource, internet, directPort = 45123) {
  const base = teamSource();
  return { ...base, team: { ...base.team, direct_port: directPort, ...(internet === undefined ? {} : { internet }) } };
}

test('5-5b: a valid internet record loads frozen; without one the team record has no internet key', () => withFixture(({ configPath, teamSource, write }) => {
  write(internetSource(teamSource));
  assert.equal(Object.hasOwn(loadHostConfig(configPath).team, 'internet'), false);
  for (const internet of [INTERNET_ON, { map_port: false, public_address: null, relay_url: null },
    { map_port: true, public_address: '[2001:db8::1]:5000', relay_url: null },
    { map_port: false, public_address: '203.0.113.9', relay_url: 'https://relay.example.org:8443' }]) {
    write(internetSource(teamSource, internet));
    const loaded = loadHostConfig(configPath).team.internet;
    assert.deepEqual({ ...loaded }, { mapPort: internet.map_port, publicAddress: internet.public_address,
      relayUrl: internet.relay_url }, JSON.stringify(internet));
    assert.equal(Object.isFrozen(loaded), true);
  }
}));

test('5-5b: every wrong internet shape, an unknown key and internet with no direct port are team_internet_invalid', () => withFixture(({ configPath, teamSource, write }) => {
  const shapes = [null, [], 'on', true, {}, { ...INTERNET_ON, relay_token: 'abc' }, { ...INTERNET_ON, extra: 1 },
    { map_port: true, public_address: null }, { mapPort: true, public_address: null, relay_url: null },
    { ...INTERNET_ON, map_port: 'yes' }, { ...INTERNET_ON, map_port: null }, { ...INTERNET_ON, public_address: '' },
    { ...INTERNET_ON, public_address: 'not an address' }, { ...INTERNET_ON, public_address: '127.0.0.1' },
    { ...INTERNET_ON, public_address: 7 }, { ...INTERNET_ON, relay_url: 'https://Relay.example.org' },
    { ...INTERNET_ON, relay_url: 'http://relay.example.org' }, { ...INTERNET_ON, relay_url: 'https://relay.example.org/' },
    { ...INTERNET_ON, relay_url: '' }, { ...INTERNET_ON, relay_url: 'https://user:secret@relay.example.org' },
    { ...INTERNET_ON, relay_url: 'https://user@relay.example.org' }];
  for (const internet of shapes) {
    write(internetSource(teamSource, internet));
    assert.equal(reasonOf(configPath), 'team_internet_invalid', JSON.stringify(internet));
  }
  write(internetSource(teamSource, { map_port: false, public_address: null, relay_url: null }, null));
  assert.equal(reasonOf(configPath), 'team_internet_invalid', 'internet needs a direct port');
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

// The optional `team.projects_root`: where a team host keeps its project folders. The home directory
// is the mocked one above (`os.homedir` through `t.mock.method`), so nothing here touches the real home.
function rootSource(fixture, projectsRoot, team = {}) {
  const base = fixture.teamSource();
  return { ...base, team: { ...base.team, ...team, ...(projectsRoot === undefined ? {} : { projects_root: projectsRoot }) } };
}

test('a team block without projects_root loads with no projectsRoot; a good one carries its real path', () => withFixture((fixture) => {
  fixture.write(rootSource(fixture));
  assert.equal(Object.hasOwn(loadHostConfig(fixture.configPath).team, 'projectsRoot'), false);
  const absent = path.join(fixture.root, 'projects');
  fixture.write(rootSource(fixture, absent));
  const config = loadHostConfig(fixture.configPath);
  assert.equal(config.team.projectsRoot, absent, 'an absent directory is accepted');
  assert.equal(Object.isFrozen(config.team), true);
  fs.mkdirSync(absent);
  fs.mkdirSync(path.join(fixture.root, 'real'));
  linkDirectory(path.join(fixture.root, 'real'), path.join(fixture.root, 'via'));
  fixture.write(rootSource(fixture, path.join(fixture.root, 'via', 'projects')));
  assert.equal(loadHostConfig(fixture.configPath).team.projectsRoot, path.join(fs.realpathSync.native(fixture.root), 'real', 'projects'),
    'a link in a parent is resolved');
  fixture.write(rootSource(fixture, path.join(os.homedir(), 'team-projects')));
  assert.equal(loadHostConfig(fixture.configPath).team.projectsRoot, path.join(os.homedir(), 'team-projects'),
    'inside the home directory is allowed');
}));

test('every projects_root refusal answers its reason word', () => withFixture((fixture) => {
  const { root } = fixture;
  const file = path.join(root, 'a-file');
  fs.writeFileSync(file, 'x');
  fs.mkdirSync(path.join(root, 'target'));
  const link = path.join(root, 'link');
  linkDirectory(path.join(root, 'target'), link);
  const runtime = path.join(root, 'runtime');
  const cases = [
    [7, 'team_projects_root_invalid'],
    [null, 'team_projects_root_invalid'],
    ['', 'team_projects_root_invalid'],
    [`/${'a'.repeat(2048)}`, 'team_projects_root_invalid'],
    ['relative/projects', 'team_projects_root_must_be_absolute'],
    [link, 'team_projects_root_symlink_invalid'],
    [file, 'team_projects_root_not_directory'],
    [os.homedir(), 'team_projects_root_home_overlap'],
    [path.dirname(os.homedir()), 'team_projects_root_home_overlap'],
    [path.join(root, 'profile', 'projects'), 'team_projects_root_profile_overlap'],
    [path.join(root, 'secrets', 'projects'), 'team_projects_root_profile_overlap'],
    [path.join(runtime, 'projects'), 'team_projects_root_profile_overlap'],
  ];
  for (const [value, reason] of cases) {
    fixture.write({ ...rootSource(fixture, value), runtime_home: runtime });
    assert.equal(reasonOf(fixture.configPath), reason, JSON.stringify(value)?.slice(0, 80));
  }
  // Containing the profile, the secrets or the runtime home: the folder that holds all three.
  const holder = path.join(root, 'holder');
  for (const field of ['user_data_path', 'secrets_dir', 'runtime_home']) {
    const source = { ...rootSource(fixture, holder), runtime_home: runtime, [field]: path.join(holder, field) };
    fixture.write(source);
    assert.equal(reasonOf(fixture.configPath), 'team_projects_root_profile_overlap', field);
  }
}));

test('projects_root outside a team block is an unknown key', () => withFixture((fixture) => {
  fixture.write({ ...fixture.source, projects_root: path.join(fixture.root, 'projects') });
  assert.equal(reasonOf(fixture.configPath), 'config_unknown_field');
  fixture.write({ ...fixture.teamSource(), projects_root: path.join(fixture.root, 'projects') });
  assert.equal(reasonOf(fixture.configPath), 'config_unknown_field');
}));

test('the desktop rule: a parent_channel host keeps its projects beside its config, a secret_file host anywhere', () => withFixture((fixture) => {
  const desktop = { key_source: 'parent_channel' };
  fixture.write(rootSource(fixture, path.join(fixture.root, 'projects'), desktop));
  assert.equal(loadHostConfig(fixture.configPath).team.projectsRoot, path.join(fixture.root, 'projects'));
  for (const other of [path.join(fixture.root, 'elsewhere'), path.join(fixture.root, 'projects', 'inner'), path.join(os.homedir(), 'projects')]) {
    fixture.write(rootSource(fixture, other, desktop));
    assert.equal(reasonOf(fixture.configPath), 'team_projects_root_layout_invalid', other);
  }
  const elsewhere = path.join(fixture.root, 'elsewhere');
  fixture.write(rootSource(fixture, elsewhere));
  assert.equal(loadHostConfig(fixture.configPath).team.projectsRoot, elsewhere, 'a secret_file host');
  // A link standing at `<config dir>/projects` is refused, though its target would compare equal.
  fs.mkdirSync(path.join(fixture.root, 'target'));
  linkDirectory(path.join(fixture.root, 'target'), path.join(fixture.root, 'projects'));
  fixture.write(rootSource(fixture, path.join(fixture.root, 'target'), desktop));
  assert.equal(reasonOf(fixture.configPath), 'team_projects_root_symlink_invalid');
  // normalizeHostConfig alone has no file, so it has no layout to hold a desktop host to.
  assert.equal(normalizeHostConfig(rootSource(fixture, elsewhere, desktop)).team.projectsRoot, elsewhere);
}));

test('3-13/3-14: the two setup mounts in the config are optional, absolute and apart from the team volumes', async (t) => {
  const { createMaintenanceFixture } = require('./helpers/team-maintenance-fixture');
  const fx = createMaintenanceFixture(t);
  const config = loadHostConfig(fx.configPath);
  assert.equal(config.team.importDir, fx.importDir);
  assert.equal(config.team.exchangeDir, fx.exchangeDir);
  const reasonFor = (team) => {
    fx.writeConfig({ team: { projects_root: fx.projects, ...team } });
    try { loadHostConfig(fx.configPath); return 'loaded'; } catch (error) { return error.reason; }
  };
  assert.equal(reasonFor({}), 'loaded', 'both are optional');
  assert.equal(reasonFor({ import_dir: 'relative/import' }), 'team_import_dir_must_be_absolute');
  assert.equal(reasonFor({ exchange_dir: fx.profile }), 'team_mount_overlap');
  assert.equal(reasonFor({ exchange_dir: path.join(fx.secrets, 'x') }), 'team_mount_overlap');
  assert.equal(reasonFor({ import_dir: path.join(fx.data, 'import') }), 'team_mount_overlap');
  assert.equal(reasonFor({ import_dir: fx.importDir, exchange_dir: path.join(fx.importDir, 'x') }), 'team_mount_overlap');
  assert.equal(reasonFor({ import_dir: path.join(fx.root, 'not-made-yet') }), 'loaded', 'never existence-checked');
});
