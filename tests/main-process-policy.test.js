'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  shouldAutoStartMainProcess,
  shouldRefreshManagedConfigForShellConfigReason,
} = require('../services/main/main-process-policy');

test('managed config refresh policy recognizes only canonical refresh reasons', () => {
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('workspace_root_updated'), true);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('feature_settings_updated'), true);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason(' model_tuning_updated '), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('model_tuning_legacy_claimed'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('chunk_inactivity_seconds_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('context_length_tuning_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('compaction_tuning_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('unrelated_change'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason(null), false);
});

test('main auto-start policy honors the explicit skip before runtime detection', () => {
  assert.equal(shouldAutoStartMainProcess({
    hasElectronRuntime: true,
    isMainModule: true,
    env: { JENNY_SKIP_MAIN_AUTOSTART: 'yes' },
  }), false);
  assert.equal(shouldAutoStartMainProcess({
    hasElectronRuntime: false,
    isMainModule: false,
    env: {},
  }), false);
  assert.equal(shouldAutoStartMainProcess({
    hasElectronRuntime: true,
    isMainModule: false,
    env: {},
  }), true);
  assert.equal(shouldAutoStartMainProcess({
    hasElectronRuntime: false,
    isMainModule: true,
    env: {},
  }), true);
});
