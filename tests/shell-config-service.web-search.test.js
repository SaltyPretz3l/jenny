const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ShellConfigService,
} = require('../services/shell-config-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('shell config service updateFeatureSettings merges and normalizes webSearch settings in memory and emits the update reason', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-web-search-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  assert.deepEqual(service.getState().webSearch, { provider: 'duckduckgo', searxngUrl: '' });

  const reasons = [];
  service.on('changed', (_snapshot, meta) => { reasons.push(meta?.reason); });

  const nextState = service.updateFeatureSettings({
    webSearch: { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8080' },
  });

  assert.deepEqual(nextState.webSearch, { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8080' });
  assert.deepEqual(service.getState().webSearch, { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8080' });
  assert.ok(reasons.includes('web_search_settings_updated'));
});

test('shell config service persists webSearch settings across a reload', () => {
  // Regression: serializeState() originally omitted the webSearch key, so the
  // provider selection silently reverted to defaults on restart.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-web-search-reload-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.updateFeatureSettings({
    webSearch: { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8080' },
  });

  const reloaded = new ShellConfigService({ userDataPath });
  assert.deepEqual(reloaded.getState().webSearch, {
    provider: 'searxng',
    searxngUrl: 'http://127.0.0.1:8080',
  });
});

test('shell config service updateFeatureSettings webSearch patch merges partial fields against current state', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-web-search-merge-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  service.updateFeatureSettings({
    webSearch: { provider: 'searxng', searxngUrl: 'http://127.0.0.1:8080' },
  });

  // Patching only the provider must not clear the previously saved searxng url.
  const nextState = service.updateFeatureSettings({
    webSearch: { provider: 'brave' },
  });

  assert.deepEqual(nextState.webSearch, { provider: 'brave', searxngUrl: 'http://127.0.0.1:8080' });
});

test('shell config service updateFeatureSettings is a no-op when nothing actually changes', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-feature-noop-'));
  trackDirectory(userDataPath);

  const service = new ShellConfigService({ userDataPath });
  const before = service.getState();

  const reasons = [];
  service.on('changed', (_snapshot, meta) => { reasons.push(meta?.reason); });

  // Re-asserting the already-current defaults must not persist or emit 'changed'.
  const after = service.updateFeatureSettings({
    tools: {},
    featureOverrides: {},
    webSearch: { provider: 'duckduckgo', searxngUrl: '' },
  });

  assert.deepEqual(after, before);
  assert.equal(reasons.length, 0);
});
