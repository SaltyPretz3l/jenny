'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REQUIRED_LIMITS,
  PLUGIN_SESSION_LIMITS,
  validLimits,
} = require('../../../services/plugin-session-budgets');
const fs = require('node:fs');
const path = require('node:path');

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

test('standalone host polling and retention constants match the core budget ledger', () => {
  const source = fs.readFileSync(path.join(
    __dirname, '..', '..', '..', 'plugins', 'official', 'local-image-generation',
    'python', 'local_image_generation', 'operations.py',
  ), 'utf8');
  assert.match(source, new RegExp(`MAX_STORED_FRAMES = ${PLUGIN_SESSION_LIMITS.operation_frames.toLocaleString('en-US').replace(',', '_')}`));
  assert.match(source, new RegExp(`MAX_STATUS_FRAMES = ${PLUGIN_SESSION_LIMITS.poll_frame_batch}`));
  assert.match(source, new RegExp(`"poll_after_ms": ${PLUGIN_SESSION_LIMITS.poll_interval_ms}`));
});
