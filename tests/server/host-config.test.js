'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_RUNTIME_HOME,
  DEFAULT_RESOURCE_LIMITS,
  loadHostConfig,
} = require('../../server/config');
const { hostedSidecarEnvironment } = require('../../services/host/sidecar-environment');

test.beforeEach((t) => {
  // CI checks out under the real home; isolate the home-containment fixture too.
  t.mock.method(os, 'homedir', () => path.join(process.cwd(), 'tmp-host-config-home'));
});

function createFixture() {
  const root = fs.mkdtempSync(path.join(process.cwd(), 'tmp-host-config-'));
  const configPath = path.join(root, 'host.json');
  const source = {
    schema_version: 1,
    host_mode: 'server',
    host_execution_policy_version: 1,
    canonical_origin: 'https://jenny.tailnet.ts.net',
    listen_host: '0.0.0.0',
    port: 8080,
    user_data_path: path.join(root, 'profile'),
    workspace_root: path.join(root, 'workspace'),
    secrets_dir: path.join(root, 'secrets'),
    model_endpoint: {
      engine: 'ollama',
      model: 'qwen3.5:9b',
      api_url: 'http://ollama:11434',
    },
  };
  const write = (changes = {}) => {
    fs.writeFileSync(configPath, JSON.stringify({ ...source, ...changes }), { mode: 0o600 });
  };
  write();
  return { root, configPath, source, write };
}

function withFixture(callback) {
  const fixture = createFixture();
  try { return callback(fixture); } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
}

test('loads closed version-one config into hosted backend options', () => withFixture(({ configPath }) => {
  const config = loadHostConfig(configPath);
  assert.equal(config.hostMode, 'server');
  assert.equal(config.hostExecutionPolicyVersion, 1);
  assert.equal(config.canonicalOrigin, 'https://jenny.tailnet.ts.net');
  assert.equal(config.listenHost, '0.0.0.0');
  assert.equal(config.port, 8080);
  assert.equal(config.runtimeHome, path.resolve(DEFAULT_RUNTIME_HOME));
  assert.ok(path.isAbsolute(config.userDataPath));
  assert.equal(config.modelEndpoint.engine, 'ollama');
  assert.equal(config.modelEndpoint.apiUrl, 'http://ollama:11434');
  assert.deepEqual(config.resourceLimits, DEFAULT_RESOURCE_LIMITS);
}));

test('maps schema one to private HTTPS and rejects schema-two fields', () => withFixture(({ configPath, write }) => {
  const legacy = loadHostConfig(configPath);
  assert.equal(legacy.schemaVersion, 1);
  assert.equal(legacy.browserAccessMode, 'private_https');
  assert.equal(legacy.execution, null);
  write({ canonical_origin: 'http://127.0.0.1:8080' });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'canonical_origin_invalid');
  write({ browser_access_mode: 'private_https' });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'config_unknown_field');
  write({ execution: null });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'config_unknown_field');
}));

test('accepts only the exact configured loopback HTTP origin in schema two', () => withFixture(({ configPath, source, write }) => {
  write({ schema_version: 2, browser_access_mode: 'localhost_http', canonical_origin: 'http://127.0.0.1:8080',
    listen_host: '127.0.0.1', workspace_root: null });
  const config = loadHostConfig(configPath);
  assert.equal(config.schemaVersion, 2);
  assert.equal(config.browserAccessMode, 'localhost_http');
  assert.equal(config.canonicalOrigin, 'http://127.0.0.1:8080');
  assert.equal(config.hostExecutionPolicyVersion, 1);
  assert.equal(config.execution, null);
  for (const canonicalOrigin of ['http://localhost:8080', 'http://127.0.0.2:8080',
    'http://127.0.0.1:08080', 'http://127.0.0.1:8080/', 'http://127.0.0.1:8080?x=1',
    'http://user:pass@127.0.0.1:8080']) {
    write({ schema_version: 2, browser_access_mode: 'localhost_http', canonical_origin: canonicalOrigin,
      listen_host: '127.0.0.1', workspace_root: null });
    assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'canonical_origin_invalid', canonicalOrigin);
  }
  write({ schema_version: 2, browser_access_mode: 'localhost_http', canonical_origin: 'http://127.0.0.1:8080',
    listen_host: '0.0.0.0', workspace_root: null });
  assert.equal(loadHostConfig(configPath).listenHost, '0.0.0.0');
}));

test('requires the closed offline-copy execution contract and policy version two', () => withFixture(({ configPath, write }) => {
  const base = { schema_version: 2, browser_access_mode: 'private_https', host_execution_policy_version: 1,
    workspace_root: null };
  write(base);
  assert.equal(loadHostConfig(configPath).execution, null);
  write({ ...base, execution: { mode: 'offline-copy' } });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'execution_workspace_required');
  write({ ...base, host_execution_policy_version: 2, execution: { mode: 'offline-copy' }, workspace_root: '/tmp/jenny-other' });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'execution_workspace_root_fixed');
  write({ ...base, host_execution_policy_version: 2, execution: { mode: 'offline-copy' }, workspace_root: '/workspaces/default' });
  const enabled = loadHostConfig(configPath);
  assert.deepEqual(enabled.execution, { mode: 'offline-copy' });
  assert.equal(Object.isFrozen(enabled.execution), true);
  assert.equal(enabled.hostExecutionPolicyVersion, 2);
  write({ ...base, execution: { mode: 'offline-copy', control_path: '/tmp/operator.sock' }, workspace_root: '/workspaces/default' });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'execution_invalid');
  write({ ...base, host_execution_policy_version: 2, execution: null });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'host_execution_policy_unsupported');
}));

test('uses explicit user-data children for memory and logs', () => withFixture(({ configPath, source, write }) => {
  source.memory_path = path.join(source.user_data_path, 'memory.db');
  source.log_path = path.join(source.user_data_path, 'logs');
  write(source);
  const config = loadHostConfig(configPath);
  assert.equal(config.memoryPath, path.resolve(source.memory_path));
  assert.equal(config.logPath, path.resolve(source.log_path));
}));

test('rejects unknown, future, null, and out-of-range config values', () => withFixture(({ configPath, write }) => {
  write({ unexpected: true });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'config_unknown_field');
  write({ schema_version: 3 });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'config_schema_future');
  write({ host_execution_policy_version: 2 });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'host_execution_policy_future');
  write({ port: null });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'invalid_host_limit');
  write({ canonical_origin: null });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'canonical_origin_invalid');
  write({ model_endpoint: null });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'model_endpoint_invalid');
  write({ resource_limits: { max_concurrent_requests: 65 } });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'invalid_host_limit');
}));

test('rejects replay, malformed origins, and unsafe model URLs', () => withFixture(({ configPath, write }) => {
  write({ model_endpoint: { engine: 'replay', model: 'replay', api_url: 'http://x' } });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'replay_engine_forbidden');
  write({ canonical_origin: 'http://jenny.tailnet.ts.net' });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'canonical_origin_invalid');
  write({ canonical_origin: 'https://user:pass@jenny.tailnet.ts.net' });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'canonical_origin_invalid');
  write({ canonical_origin: 'https://jenny.tailnet.ts.net/?query=1' });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'canonical_origin_invalid');
  write({ model_endpoint: { engine: 'ollama', model: 'm', api_url: 'http://user:pass@ollama:11434' } });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'model_api_url_invalid');
  write({ model_endpoint: { engine: 'ollama', model: 'm', api_url: 'http://ollama:11434?key=secret' } });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'model_api_url_invalid');
}));

test('rejects workspace overlap with profile, secrets, or the home directory', () => withFixture((fixture) => {
  fixture.write({ workspace_root: fixture.source.user_data_path });
  assert.throws(() => loadHostConfig(fixture.configPath), (error) => error.reason === 'workspace_root_profile_overlap');
  fixture.write({ workspace_root: fixture.source.secrets_dir });
  assert.throws(() => loadHostConfig(fixture.configPath), (error) => error.reason === 'workspace_root_profile_overlap');
  for (const workspaceRoot of [os.homedir(), path.join(os.homedir(), 'project'), path.dirname(os.homedir())]) {
    fixture.write({ workspace_root: workspaceRoot });
    assert.throws(() => loadHostConfig(fixture.configPath), (error) => error.reason === 'workspace_root_home_overlap');
  }
}));

test('permits native loopback binds and rejects non-listener addresses', () => withFixture(({ configPath, write }) => {
  write({ workspace_root: null });
  assert.equal(loadHostConfig(configPath).workspaceRoot, null);
  write({ listen_host: '127.0.0.1' });
  assert.equal(loadHostConfig(configPath).listenHost, '127.0.0.1');
  write({ listen_host: '::1' });
  assert.equal(loadHostConfig(configPath).listenHost, '::1');
  write({ listen_host: '127.0.0.2' });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'listen_host_invalid');
}));

test('keeps the disposable runtime home outside durable and secret storage', () => withFixture((fixture) => {
  const runtimeHome = path.join(fixture.root, 'runtime');
  fixture.write({ runtime_home: runtimeHome });
  assert.equal(loadHostConfig(fixture.configPath).runtimeHome, path.resolve(runtimeHome));
  fixture.write({ runtime_home: path.join(fixture.source.user_data_path, 'runtime') });
  assert.throws(() => loadHostConfig(fixture.configPath), (error) => error.reason === 'runtime_home_overlap');
  fixture.write({ runtime_home: path.join(fixture.source.secrets_dir, 'runtime') });
  assert.throws(() => loadHostConfig(fixture.configPath), (error) => error.reason === 'runtime_home_overlap');
}));

test('builds a writable isolated sidecar environment under runtime home', () => withFixture(({ root }) => {
  const runtimeHome = path.join(root, 'runtime');
  const env = hostedSidecarEnvironment({ JENNY_TOKEN: 'drop', PYTHONPATH: 'drop', PATH: 'keep' }, runtimeHome);
  assert.equal(env.HOME, runtimeHome);
  assert.equal(env.XDG_CACHE_HOME, path.join(runtimeHome, '.cache'));
  assert.equal(env.XDG_STATE_HOME, path.join(runtimeHome, '.local', 'state'));
  assert.equal(env.PATH, 'keep');
  assert.equal(env.JENNY_TOKEN, undefined);
  assert.equal(env.PYTHONPATH, undefined);
  const invalid = path.join(root, 'runtime-file');
  fs.writeFileSync(invalid, 'not a directory');
  assert.throws(() => hostedSidecarEnvironment({}, invalid), /invalid_runtime_home/);
}));


test('preserves an operator-selected virtualenv interpreter symlink', (t) => withFixture(({ root, configPath, write }) => {
  const interpreter = path.join(root, 'venv-python');
  try { fs.symlinkSync(process.execPath, interpreter, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable; real Linux image covers this path');
    throw error;
  }
  write({ python_executable: interpreter });
  assert.notEqual(fs.realpathSync(interpreter), interpreter);
  assert.equal(loadHostConfig(configPath).pythonExecutable, interpreter);
  write({ python_executable: 'relative/python' });
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'python_executable_must_be_absolute');
}));
