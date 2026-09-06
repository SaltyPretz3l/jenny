const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { CONFIG_VERSION, ShellConfigService } = require('../services/shell-config-service');

test('saveSetupEndpoint persists preferred engine and matching settings atomically', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-endpoint-'));
  t.after(() => fs.rmSync(userDataPath, { force: true, recursive: true }));
  const service = new ShellConfigService({ userDataPath });
  const reasons = [];
  service.on('changed', (_state, context) => reasons.push(context.reason));

  const result = service.saveSetupEndpoint({
    engineType: 'openai-compatible',
    port: 9033,
    apiUrl: 'http://10.0.0.8:9033/v1',
  });

  assert.equal(result.saved, true);
  assert.equal(result.state.preferredEngineType, 'openai-compatible');
  assert.deepEqual(result.state.localEngines.openaiCompatible, {
    port: 9033,
    apiUrl: 'http://10.0.0.8:9033/v1',
    // Read-time normalized defaults (no CONFIG_VERSION bump for either key).
    acceleration: { mode: 'off', draftNMax: 0 },
    managed: {
      enabled: false,
      profileId: '',
      lastUsedTag: '',
      lastPickDir: '',
      libraryRoots: [],
      perModel: {},
    },
  });
  assert.deepEqual(reasons, ['setup_endpoint_saved']);
});

test('saveSetupEndpoint reports a future-schema write as unsaved when the engine already matches', (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-config-endpoint-future-'));
  t.after(() => fs.rmSync(userDataPath, { force: true, recursive: true }));
  fs.writeFileSync(path.join(userDataPath, 'shell-config.json'), JSON.stringify({
    version: CONFIG_VERSION + 1,
    preferredEngineType: 'openai-compatible',
    localEngines: {
      openaiCompatible: { port: 8033, apiUrl: '' },
    },
  }));
  const service = new ShellConfigService({ userDataPath });

  const result = service.saveSetupEndpoint({
    engineType: 'openai-compatible',
    port: 9033,
    apiUrl: 'http://127.0.0.1:9033/v1',
  });

  assert.equal(result.saved, false);
  assert.equal(result.state.localEngines.openaiCompatible.port, 8033);
});
