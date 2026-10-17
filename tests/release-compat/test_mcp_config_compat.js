'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  McpConfigStore, configurationDigest, projectServerConfig,
} = require('../../services/mcp-config-store');
const { cleanupTrackedResources, trackDirectory } = require('../helpers/resource-cleanup');

const FIXTURES = path.join(__dirname, 'fixtures', 'mcp-config');
test.afterEach(cleanupTrackedResources);

function loadFixture(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mcp-compat-'));
  trackDirectory(directory);
  const target = path.join(directory, 'mcp-servers.json');
  if (name) fs.copyFileSync(path.join(FIXTURES, `${name}.json`), target);
  const before = name ? fs.readFileSync(target, 'utf8') : '';
  return { store: new McpConfigStore({ userDataPath: directory }), target, before };
}

test('missing and current release configurations load normally', () => {
  assert.equal(loadFixture(null).store.getState().readOnly, false);
  const current = loadFixture('current').store.getState();
  assert.equal(current.readOnly, false);
  assert.equal(current.document.mcp_servers[0].enabled, true);
  assert.equal(current.document.mcp_servers[0].trust.status, 'approved');
  assert.deepEqual(projectServerConfig(current.document.mcp_servers[0]).env, { REA_LOG_LEVEL: 'debug' });
});

test('v2 approved prompts load in place without migration or a schema bump', () => {
  const { target } = loadFixture('current');
  const document = JSON.parse(fs.readFileSync(target, 'utf8'));
  const row = document.mcp_servers[0];
  row.prompts = [{ name: 'review', description: 'Review code', arguments: [
    { name: 'target', description: '', required: true },
  ] }];
  row.trust.advertised_prompts_digest = 'b'.repeat(64);
  const bytes = JSON.stringify(document);
  fs.writeFileSync(target, bytes, 'utf8');
  const state = new McpConfigStore({ userDataPath: path.dirname(target) }).getState();
  assert.equal(state.readOnly, false);
  assert.equal(state.migrated, false);
  assert.equal(state.schemaVersion, 2);
  assert.deepEqual(state.document.mcp_servers[0].prompts, row.prompts);
  assert.equal(state.document.mcp_servers[0].trust.advertised_prompts_digest, 'b'.repeat(64));
  assert.equal(configurationDigest(row), row.trust.configuration_digest);
  assert.equal(fs.readFileSync(target, 'utf8'), bytes);
});

test('a v1 release configuration keeps approvals, enabled state and its pinned digest', () => {
  const { store, target, before } = loadFixture('legacy-v1-approved');
  const state = store.getState();
  const [row] = state.document.mcp_servers;
  assert.equal(state.readOnly, false);
  assert.equal(state.migrated, true);
  assert.equal(row.enabled, true);
  assert.equal(row.trust.status, 'approved');
  assert.equal(configurationDigest(row),
    '4a45964c58332cfab35fd811c74257970bd77e17fcd03fb274befb17d851e654');
  assert.equal(row.trust.configuration_digest, configurationDigest(row));
  assert.equal(fs.readFileSync(target, 'utf8'), before);
});

test('legacy release configuration migrates disabled and pending', () => {
  const { store } = loadFixture('legacy');
  const state = store.getState();
  assert.equal(state.migrated, true);
  assert.equal(state.document.mcp_servers[0].enabled, false);
  assert.equal(state.document.mcp_servers[0].trust.status, 'pending');
});

for (const [name, reason] of [['malformed', 'malformed_json'],
  ['plaintext-secret', 'plaintext_secret'], ['plaintext-secret-env', 'plaintext_secret'],
  ['reserved-env', 'reserved_env_key'], ['future', 'future_schema']]) {
  test(`${name} release configuration remains untouched and forwards no server`, () => {
    const { store, target, before } = loadFixture(name);
    const state = store.getState();
    assert.equal(state.readOnly, true);
    assert.equal(state.reason, reason);
    assert.deepEqual(state.document.mcp_servers, []);
    assert.equal(fs.readFileSync(target, 'utf8'), before);
  });
}
