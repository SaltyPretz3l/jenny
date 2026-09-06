'use strict';

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

test('default run mode persists through the scalar setter and existing chat UI bridge state', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-run-mode-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });

  assert.equal(service.getChatUiState().defaultRunMode, 'ask');
  service.updateDefaultRunMode(' AUTO ');
  assert.equal(service.getChatUiState().defaultRunMode, 'auto');
  assert.equal(new ShellConfigService({ userDataPath, env: {} }).getState().defaultRunMode, 'auto');

  const snapshot = service.updateChatUiSettings({ defaultRunMode: 'plan' });
  assert.equal(snapshot.defaultRunMode, 'plan');
  assert.equal(service.getState().defaultRunMode, 'plan');
});
