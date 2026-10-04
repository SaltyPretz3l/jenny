const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ShellConfigService } = require('../services/shell-config-service');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('updateSetupState applies snake_case step patches over stored camelCase steps', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-step-patch-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  // The renderer and the setup bridge send snake_case step keys.
  service.updateSetupState({ steps: { workspace_root: 'skipped', local_model: 'skipped' } });
  assert.equal(service.getSetupState().steps.workspaceRoot, 'skipped');
  assert.equal(service.getSetupState().steps.localModel, 'skipped');
  service.updateSetupState({ steps: { workspace_root: 'done' } });
  assert.equal(service.getSetupState().steps.workspaceRoot, 'done');
  const reloaded = new ShellConfigService({ userDataPath, env: {} });
  assert.equal(reloaded.getSetupState().steps.workspaceRoot, 'done');
  assert.equal(reloaded.getSetupState().steps.localModel, 'skipped');
});
