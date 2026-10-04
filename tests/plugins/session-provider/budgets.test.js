'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_LIMITS,
  PLUGIN_SESSION_LIMITS,
  validLimits,
} = require('../../../services/plugin-session-budgets');

test('session-provider budget authority is exact, positive, and internally ordered', () => {
  assert.equal(validLimits(PLUGIN_SESSION_LIMITS), true);
  assert.deepEqual(Object.keys(PLUGIN_SESSION_LIMITS).sort(), [...REQUIRED_LIMITS].sort());
  assert.equal(validLimits({ ...PLUGIN_SESSION_LIMITS, state_bytes: 0 }), false);
  assert.equal(validLimits({ ...PLUGIN_SESSION_LIMITS, state_bytes: '16384' }), false);
  assert.equal(validLimits({ ...PLUGIN_SESSION_LIMITS, unexpected: 1 }), false);
  assert.equal(validLimits({
    ...PLUGIN_SESSION_LIMITS,
    message_operation_metadata_bytes: PLUGIN_SESSION_LIMITS.session_operation_metadata_bytes + 1,
  }), false);
});
