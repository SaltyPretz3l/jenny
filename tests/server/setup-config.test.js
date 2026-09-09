'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setupFixture } = require('./helpers/setup-fixture');
const { readSetup, saveSetup } = require('../../services/host/setup-config');
const { writeJson } = require('../../services/host/durable-json');
const { loadHostConfig, SETUP_PENDING_FILE } = require('../../server/config');

test('setup saves a readable canonical config with a separate private raw key', (t) => {
  const fixture = setupFixture(t);
  fixture.source.model_endpoint.engine = 'openai-compatible';
  saveSetup(fixture.configPath, fixture.source, 'private-test-key');
  assert.equal(loadHostConfig(fixture.configPath).hostMode, 'server');
  assert.equal(readSetup(fixture.configPath).apiKey, 'private-test-key');
  assert.doesNotMatch(fs.readFileSync(fixture.configPath, 'utf8'), /private-test-key/);
  assert.equal(fs.existsSync(path.join(path.dirname(fixture.configPath), SETUP_PENDING_FILE)), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(fixture.source.secrets_dir, 'model-api-key')).mode & 0o777, 0o600);
  }
});

test('partial endpoint/key change blocks normal startup and will not reuse an ambiguous key', (t) => {
  const { source, configPath } = setupFixture(t);
  source.model_endpoint.engine = 'openai-compatible';
  saveSetup(configPath, source, 'old-key');
  assert.throws(() => saveSetup(configPath, source, 'new-key', {
    writeJsonImpl(file, value) {
      if (file === configPath) throw new Error('disk-full');
      writeJson(file, value);
    },
  }), /disk-full/);
  assert.throws(() => loadHostConfig(configPath), (error) => error.reason === 'setup_incomplete');
  assert.equal(readSetup(configPath).pending, true);
  assert.equal(readSetup(configPath).apiKey, null);
  saveSetup(configPath, source, 'revalidated-key');
  assert.equal(readSetup(configPath).pending, false);
  assert.equal(readSetup(configPath).apiKey, 'revalidated-key');
});

test('malformed/future setup or config state and invalid keys are never silently replaced', (t) => {
  const { source, configPath } = setupFixture(t);
  const marker = path.join(path.dirname(configPath), SETUP_PENDING_FILE);
  writeJson(marker, { schema_version: 2, state: 'pending' });
  assert.throws(() => readSetup(configPath), /unsupported_setup_marker/);
  fs.unlinkSync(marker);
  writeJson(configPath, { ...source, schema_version: 3 });
  assert.throws(() => readSetup(configPath), (error) => error.reason === 'config_schema_future');
  assert.equal(JSON.parse(fs.readFileSync(configPath)).schema_version, 3);
  assert.throws(() => saveSetup(configPath, source, 'bad\nkey'), /invalid_model_key/);
  assert.equal(fs.existsSync(marker), false);
});

test('removing an unneeded key is explicit and durable with the new config', (t) => {
  const { source, configPath } = setupFixture(t);
  saveSetup(configPath, source, 'old-key');
  saveSetup(configPath, source, null);
  assert.equal(readSetup(configPath).apiKey, null);
  assert.equal(loadHostConfig(configPath).modelEndpoint.engine, 'ollama');
});


test('startup reloads a committed endpoint/key pair under the profile lock', (t) => {
  const { acquireConfiguredProfile } = require('../../server/main');
  const { source, configPath } = setupFixture(t);
  source.model_endpoint.engine = 'openai-compatible';
  source.model_endpoint.api_url = 'http://old:1234/v1';
  saveSetup(configPath, source, 'old-key');
  let released = false;
  const result = acquireConfiguredProfile(configPath, { acquireProfileImpl() {
    // A competing setup transaction finishes before this startup owns the lock.
    source.model_endpoint.api_url = 'http://new:1234/v1';
    saveSetup(configPath, source, 'new-key');
    return { release() { released = true; } };
  } });
  assert.equal(result.config.modelEndpoint.apiUrl, 'http://new:1234/v1');
  assert.equal(readSetup(configPath).apiKey, 'new-key');
  assert.equal(released, false);
  result.lock.release();
  assert.equal(released, true);
});

test('startup rejects profile retargeting or unfinished setup after lock acquisition', (t) => {
  const { acquireConfiguredProfile } = require('../../server/main');
  const { source, configPath, root } = setupFixture(t);
  saveSetup(configPath, source, null);
  let releases = 0;
  assert.throws(() => acquireConfiguredProfile(configPath, { acquireProfileImpl() {
    writeJson(configPath, { ...source, user_data_path: path.join(root, 'new-profile') });
    return { release() { releases += 1; } };
  } }), /host_profile_changed_during_start/);
  writeJson(configPath, source);
  assert.throws(() => acquireConfiguredProfile(configPath, { acquireProfileImpl() {
    writeJson(path.join(path.dirname(configPath), SETUP_PENDING_FILE), { schema_version: 1, state: 'pending' });
    return { release() { releases += 1; } };
  } }), (error) => error.reason === 'setup_incomplete');
  assert.equal(releases, 2);
});
