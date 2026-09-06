'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  OFFICIAL_CURRENT_KEY_ID,
  evaluateStage7Eligibility,
} = require('../../../services/plugins/runtime/stage7-eligibility');

const eligibility = (reason, kinds) => ({ activation_reason_code: reason, kinds });

function evaluate(overrides = {}) {
  return evaluateStage7Eligibility({
    pluginEntry: { publisher_id: 'jenny-official', publisher_key_id: OFFICIAL_CURRENT_KEY_ID,
      effective_state: 'installed_disabled' },
    verdict: { publisher_id: 'jenny-official', publisher_key_id: OFFICIAL_CURRENT_KEY_ID,
      manifest: { requested_permissions: ['ui.view', 'network.fetch', 'secret.brokered_use'] } },
    kinds: ['provider_descriptor', 'setup_scene'], eligibility,
    ...overrides,
  });
}

test('only current-key official provider descriptors are activation eligible', () => {
  assert.equal(evaluate().activation_reason_code, 'eligible');
  assert.equal(evaluate({ pluginEntry: { publisher_id: 'jenny-official', publisher_key_id: 'b'.repeat(64),
    effective_state: 'installed_disabled' } }).activation_reason_code, 'publisher_key_not_current');
});

test('unknown permissions and mixed later-stage kinds fail closed', () => {
  assert.equal(evaluate({ verdict: { publisher_id: 'jenny-official', publisher_key_id: OFFICIAL_CURRENT_KEY_ID,
    manifest: { requested_permissions: ['process.spawn'] } } }).activation_reason_code, 'permissions_requested');
  assert.equal(evaluate({ kinds: ['provider_descriptor', 'native_provider'] }).activation_reason_code,
    'mixed_or_unsupported_contributions');
});
