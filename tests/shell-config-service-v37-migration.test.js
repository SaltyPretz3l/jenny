const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CONFIG_VERSION,
  ShellConfigService,
} = require('../services/shell-config-service');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('shell config service migrates workspaceIde to v37 and backfills showGenerated to its safe default', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-ide-v37-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 36,
    workspaceIde: { preferences: { fontSize: 17 }, roots: {}, rootLru: [] },
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });
  assert.equal(service.getState().version, CONFIG_VERSION);
  assert.equal(service.getWorkspaceIdeState().showGenerated, false);
  // The rest of the preferences ride through the migration untouched.
  assert.equal(service.getWorkspaceIdeState().fontSize, 17);

  const reloaded = new ShellConfigService({ userDataPath });
  assert.equal(reloaded.getState().version, CONFIG_VERSION);
  assert.equal(reloaded.getWorkspaceIdeState().showGenerated, false);
});

test('shell config service preserves an explicit showGenerated opt-in across the v37 migration', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-ide-v37-optin-'));
  trackDirectory(userDataPath);
  const configPath = path.join(userDataPath, 'shell-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 36,
    workspaceIde: { preferences: { showGenerated: true }, roots: {}, rootLru: [] },
  }, null, 2));

  const service = new ShellConfigService({ userDataPath });
  assert.equal(service.getState().version, CONFIG_VERSION);
  assert.equal(service.getWorkspaceIdeState().showGenerated, true);
});
