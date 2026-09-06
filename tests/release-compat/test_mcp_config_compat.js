'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { McpConfigStore } = require('../../services/mcp-config-store');
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
});

test('legacy release configuration migrates disabled and pending', () => {
  const { store } = loadFixture('legacy');
  const state = store.getState();
  assert.equal(state.migrated, true);
  assert.equal(state.document.mcp_servers[0].enabled, false);
  assert.equal(state.document.mcp_servers[0].trust.status, 'pending');
});

for (const [name, reason] of [['malformed', 'malformed_json'],
  ['plaintext-secret', 'plaintext_secret'], ['future', 'future_schema']]) {
  test(`${name} release configuration remains untouched and forwards no server`, () => {
    const { store, target, before } = loadFixture(name);
    const state = store.getState();
    assert.equal(state.readOnly, true);
    assert.equal(state.reason, reason);
    assert.deepEqual(state.document.mcp_servers, []);
    assert.equal(fs.readFileSync(target, 'utf8'), before);
  });
}
