'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setupFixture } = require('./helpers/setup-fixture');
const { configure, chooseSettings, doctor, run } = require('../../server/setup');
const { readSetup, saveSetup } = require('../../services/host/setup-config');
const { AuthStore } = require('../../server/auth-store');
const { AuthService } = require('../../server/auth-service');
const path = require('node:path');

function prompts(access = '1', confirmAccessChange = true) {
  const output = [];
  return { output, say: (value) => output.push(value),
    ask: async (label, fallback) => label.startsWith('Browser access') ? access
      : label.startsWith('Private HTTPS') ? 'https://jenny.test' : fallback,
    yes: async (label, fallback = false) => label.startsWith('Changing browser access') ? confirmAccessChange : fallback,
    secret: async () => 'correct horse battery staple' };
}

test('guided init uses canonical owner initialization and reruns without replacing settings or password', async (t) => {
  const fixture = setupFixture(t);
  const ui = prompts();
  const locks = [];
  const options = { configPath: fixture.configPath, template: fixture.source, prompts: ui,
    acquireProfileImpl: () => { locks.push('lock'); return { release() { locks.push('release'); } }; },
    probeModelsImpl: async () => ({ ok: true, models: ['installed-model'] }) };
  assert.deepEqual(await configure('init', options), { ok: true });
  const auth = new AuthStore({ filePath: path.join(fixture.source.user_data_path, 'auth.json') }).snapshot();
  assert.ok(auth.password);
  const storedConfig = fs.readFileSync(fixture.configPath, 'utf8');
  ui.ask = ui.secret = async () => { throw new Error('rerun must not ask for new settings or password'); };
  await configure('init', options);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), storedConfig);
  assert.deepEqual(new AuthStore({ filePath: path.join(fixture.source.user_data_path, 'auth.json') }).snapshot().password, auth.password);
  assert.deepEqual(locks, ['lock', 'release', 'lock', 'release']);
  assert.equal(ui.output.some((value) => value.includes('correct horse')), false);
  const stored = JSON.parse(storedConfig);
  assert.equal(stored.schema_version, 2);
  assert.equal(stored.browser_access_mode, 'localhost_http');
  assert.equal(stored.execution, null);
});

test('init preserves an existing schema-two execution configuration', async (t) => {
  const fixture = setupFixture(t);
  fixture.source.workspace_root = '/workspaces/default';
  fixture.source.execution = { mode: 'offline-copy' };
  fixture.source.host_execution_policy_version = 2;
  saveSetup(fixture.configPath, fixture.source, null);
  const before = fs.readFileSync(fixture.configPath, 'utf8');
  const ui = prompts();
  await configure('init', { configPath: fixture.configPath, template: fixture.source, prompts: ui,
    acquireProfileImpl: () => ({ release() {} }), probeModelsImpl: async () => {
      throw new Error('init should preserve existing settings');
    } });
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  assert.deepEqual(JSON.parse(before).execution, { mode: 'offline-copy' });
});

test('schema-one profiles migrate to private HTTPS during configure', async (t) => {
  const fixture = setupFixture(t);
  const legacy = { ...fixture.source, schema_version: 1, host_execution_policy_version: 1,
    canonical_origin: 'https://jenny.test' };
  delete legacy.browser_access_mode;
  delete legacy.execution;
  saveSetup(fixture.configPath, legacy, null);
  const ui = prompts('2', true);
  await configure('configure', { configPath: fixture.configPath, template: fixture.source, prompts: ui,
    acquireProfileImpl: () => ({ release() {} }), probeModelsImpl: async () => ({ ok: true, models: ['installed-model'] }) });
  const migrated = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
  assert.equal(migrated.schema_version, 2);
  assert.equal(migrated.browser_access_mode, 'private_https');
  assert.equal(migrated.canonical_origin, 'https://jenny.test');
  assert.equal(migrated.execution, null);
});

test('profile conflict stops setup before asking questions or changing files', async (t) => {
  const fixture = setupFixture(t);
  const ui = prompts('2');
  ui.ask = async () => { throw new Error('must not prompt'); };
  await assert.rejects(() => configure('init', { configPath: fixture.configPath, template: fixture.source,
    prompts: ui, acquireProfileImpl: () => { throw new Error('profile_locked'); } }), /profile_locked/);
  assert.equal(fs.existsSync(fixture.configPath), false);
});

test('new endpoint never receives the prior endpoint key and invalid origin cannot trigger a request', async (t) => {
  const fixture = setupFixture(t);
  const previous = { source: fixture.source, apiKey: 'old-private-key', pending: false };
  previous.source.model_endpoint.engine = 'openai-compatible';
  const ui = prompts();
  ui.ask = async (label, fallback) => label.startsWith('Browser access') ? '2'
    : label.startsWith('Private HTTPS') ? 'https://jenny.test'
    : label.startsWith('Model server URL') ? 'http://other-model:8000/v1' : fallback;
  let queried = false;
  await chooseSettings(previous, ui, { template: fixture.source, probeModelsImpl: async (_endpoint, options) => {
    queried = true;
    assert.equal(options.apiKey, '');
    return { ok: true, models: ['installed'] };
  } });
  assert.equal(queried, true);
  ui.ask = async (label, fallback) => label.startsWith('Browser access') ? '2'
    : label.startsWith('Private HTTPS') ? 'http://insecure.test' : fallback;
  await assert.rejects(() => chooseSettings(previous, ui, { template: fixture.source,
    probeModelsImpl: async () => { throw new Error('must not query'); } }),
  (error) => error.reason === 'canonical_origin_invalid');
});

test('doctor is read-only and does not equate a model listing with generation or HTTPS success', async (t) => {
  const fixture = setupFixture(t);
  saveSetup(fixture.configPath, fixture.source, null);
  const before = fs.readFileSync(fixture.configPath, 'utf8');
  const output = [];
  const result = await doctor({ configPath: fixture.configPath, say: (value) => output.push(value),
    probeModelsImpl: async () => ({ ok: true, models: [fixture.source.model_endpoint.model] }),
    probeLocalHostImpl: async () => false });
  assert.equal(result.ok, false);
  assert.match(output.join('\n'), /generation has not been tested/);
  assert.match(output.join('\n'), /Owner login: missing/);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
});

test('CLI rejects ambiguous arguments and custom profiles are never written under the wrong lock', async (t) => {
  await assert.rejects(() => run(['init', '--password=secret']), /Usage:/);
  const fixture = setupFixture(t);
  saveSetup(fixture.configPath, fixture.source, null);
  const options = { configPath: fixture.configPath, template: { ...fixture.source, user_data_path: fixture.root },
    acquireProfileImpl: () => ({ release() {} }), prompts: prompts() };
  await assert.rejects(() => configure('init', options), /guided_volume_mismatch/);
  assert.equal(readSetup(fixture.configPath).source.user_data_path, fixture.source.user_data_path);
});


test('switching from OpenAI-compatible to Ollama offers the Ollama URL and drops the old key', async (t) => {
  const fixture = setupFixture(t);
  fixture.source.model_endpoint = { engine: 'openai-compatible', api_url: 'http://old:1234/v1', model: 'old' };
  const ui = prompts();
  ui.ask = async (label, fallback) => label.startsWith('Model server:') ? '1' : fallback;
  const result = await chooseSettings({ source: fixture.source, apiKey: 'old-key', pending: false }, ui, {
    template: fixture.source, probeModelsImpl: async (endpoint, { apiKey }) => {
      assert.equal(endpoint.engine, 'ollama');
      assert.equal(endpoint.apiUrl, 'http://host.docker.internal:11434');
      assert.equal(apiKey, '');
      return { ok: true, models: ['installed'] };
    },
  });
  assert.equal(result.apiKey, null);
});

test('doctor reports corrupt owner and secret state independently and preserves both files', async (t) => {
  const fixture = setupFixture(t);
  fixture.source.model_endpoint.engine = 'openai-compatible';
  saveSetup(fixture.configPath, fixture.source, 'key');
  const ownerFile = path.join(fixture.source.user_data_path, 'auth.json');
  fs.writeFileSync(ownerFile, 'invalid-owner-data', { mode: 0o600 });
  const output = [];
  let modelCalls = 0;
  let httpsCalls = 0;
  const options = { configPath: fixture.configPath, say: (value) => output.push(value),
    probeModelsImpl: async () => { modelCalls += 1; return { ok: true, models: [fixture.source.model_endpoint.model] }; },
    probeLocalHostImpl: async () => { httpsCalls += 1; return true; } };
  assert.equal((await doctor(options)).ok, false);
  assert.equal(modelCalls, 1);
  assert.equal(httpsCalls, 1);
  assert.match(output.join(' '), /Owner login: unavailable or invalid/);
  const keyFile = path.join(fixture.source.secrets_dir, 'model-api-key');
  fs.writeFileSync(keyFile, 'invalid\nprivate-key');
  output.length = 0;
  assert.equal((await doctor(options)).ok, false);
  assert.equal(modelCalls, 1, 'invalid key must not become an unauthenticated model request');
  assert.equal(httpsCalls, 2);
  assert.match(output.join(' '), /Model credentials: unavailable or invalid/);
  assert.doesNotMatch(output.join(' '), /private-key|invalid-owner-data/);
  assert.equal(fs.readFileSync(ownerFile, 'utf8'), 'invalid-owner-data');
  assert.equal(fs.readFileSync(keyFile, 'utf8'), 'invalid\nprivate-key');
});

test('access changes require confirmation and revoke sessions before publishing', async (t) => {
  const fixture = setupFixture(t);
  saveSetup(fixture.configPath, fixture.source, null);
  const auth = new AuthService({ filePath: path.join(fixture.source.user_data_path, 'auth.json') });
  await auth.initializePassword('correct horse battery staple');
  assert.equal((await auth.login({ password: 'correct horse battery staple' })).ok, true);
  const before = fs.readFileSync(fixture.configPath, 'utf8');
  const declined = prompts('2', false);
  await assert.rejects(() => configure('configure', { configPath: fixture.configPath, template: fixture.source,
    prompts: declined, acquireProfileImpl: () => ({ release() {} }), probeModelsImpl: async () => ({ ok: true, models: ['installed-model'] }) }),
  /setup_cancelled/);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  assert.equal(new AuthStore({ filePath: path.join(fixture.source.user_data_path, 'auth.json') }).snapshot().sessions.length, 1);

  const accepted = prompts('2', true);
  await configure('configure', { configPath: fixture.configPath, template: fixture.source,
    prompts: accepted, acquireProfileImpl: () => ({ release() {} }), probeModelsImpl: async () => ({ ok: true, models: ['installed-model'] }) });
  assert.equal(JSON.parse(fs.readFileSync(fixture.configPath, 'utf8')).browser_access_mode, 'private_https');
  assert.equal(JSON.parse(fs.readFileSync(fixture.configPath, 'utf8')).canonical_origin, 'https://jenny.test');
  assert.equal(new AuthStore({ filePath: path.join(fixture.source.user_data_path, 'auth.json') }).snapshot().sessions.length, 0);
});

test('access-change save failure leaves the old origin published after revocation', async (t) => {
  const fixture = setupFixture(t);
  saveSetup(fixture.configPath, fixture.source, null);
  const auth = new AuthService({ filePath: path.join(fixture.source.user_data_path, 'auth.json') });
  await auth.initializePassword('correct horse battery staple');
  await auth.login({ password: 'correct horse battery staple' });
  const before = fs.readFileSync(fixture.configPath, 'utf8');
  const ui = prompts('2', true);
  await assert.rejects(() => configure('configure', { configPath: fixture.configPath, template: fixture.source,
    prompts: ui, acquireProfileImpl: () => ({ release() {} }), probeModelsImpl: async () => ({ ok: true, models: ['installed-model'] }),
    saveSetupImpl: () => { throw new Error('disk-full'); } }), /disk-full/);
  assert.equal(fs.readFileSync(fixture.configPath, 'utf8'), before);
  assert.equal(new AuthStore({ filePath: path.join(fixture.source.user_data_path, 'auth.json') }).snapshot().sessions.length, 0);
});

test('doctor checks localhost health and the configured worker state', async (t) => {
  const fixture = setupFixture(t);
  fixture.source.workspace_root = '/workspaces/default';
  fixture.source.execution = { mode: 'offline-copy' };
  fixture.source.host_execution_policy_version = 2;
  saveSetup(fixture.configPath, fixture.source, null);
  const auth = new AuthService({ filePath: path.join(fixture.source.user_data_path, 'auth.json') });
  await auth.initializePassword('correct horse battery staple');
  const output = [];
  const result = await doctor({ configPath: fixture.configPath, say: (value) => output.push(value),
    probeModelsImpl: async () => ({ ok: true, models: [fixture.source.model_endpoint.model] }),
    probeLocalHostImpl: async (config) => { assert.equal(config.canonicalOrigin, 'http://127.0.0.1:8080'); return true; },
    probeWorkerImpl: async (operation) => { assert.equal(operation, 'status'); return { phase: 'ready' }; } });
  assert.equal(result.ok, true);
  assert.match(output.join(' '), /Localhost service: Jenny health response received/);
  assert.match(output.join(' '), /Command sandbox: ready/);
});
