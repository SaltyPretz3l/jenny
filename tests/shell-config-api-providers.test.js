'use strict';

/* shell-config `apiProviders` block write path (row 78): kept out of
 * shell-config-service.test.js, which sits at the file-size ceiling. */

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG_VERSION, ShellConfigService } = require('../services/shell-config-service');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => { await cleanupTrackedResources(); });

test('updateApiProviders normalizes, persists across a restart, skips unchanged writes and keeps the version (row 78)', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-api-providers-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  assert.deepEqual(service.getState().apiProviders, { instances: [], lastSelected: null });
  const saved = service.updateApiProviders({
    instances: [{ id: 'groq', presetId: 'groq', label: 'Groq', models: [{ id: 'openai/gpt-oss-120b', enabled: true }, { id: '' }] }],
    junk: 'dropped',
  });
  assert.equal(saved.instances.length, 1);
  assert.equal(saved.instances[0].models.length, 1);
  assert.equal('junk' in saved, false);

  const disk = JSON.parse(fs.readFileSync(path.join(userDataPath, 'shell-config.json'), 'utf8'));
  assert.equal(disk.version, CONFIG_VERSION);
  assert.equal(disk.apiProviders.instances[0].id, 'groq');

  const reopened = new ShellConfigService({ userDataPath, env: {} });
  assert.deepEqual(reopened.getState().apiProviders, saved);

  const before = fs.statSync(path.join(userDataPath, 'shell-config.json')).mtimeMs;
  reopened.updateApiProviders(saved);
  assert.equal(fs.statSync(path.join(userDataPath, 'shell-config.json')).mtimeMs, before);
  assert.deepEqual(reopened.updateApiProviders(null), { instances: [], lastSelected: null });
});
