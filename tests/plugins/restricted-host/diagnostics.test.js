'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAX_EVENTS_PER_CONTRIBUTION,
  RestrictedHostDiagnostics,
  sanitizeFields,
} = require('../../../services/plugins/restricted-host/diagnostics');

const CANARY = 'CANARY_SECRET_PLACEHOLDER_do-not-retain';

test('restricted diagnostics redact sensitive keys, secret-looking values, URLs, and local paths', () => {
  const fields = sanitizeFields({
    reason_code: 'restricted_host_startup_rejected',
    token: CANARY,
    message: CANARY,
    detail: 'C:\\Users\\owner\\private.txt',
    endpoint: 'https://user:password@example.test',
    count: 2,
  });
  assert.deepEqual(fields, {
    reason_code: 'restricted_host_startup_rejected',
    count: 2,
  });
  assert.equal(JSON.stringify(fields).includes(CANARY), false);
});

test('restricted diagnostic retention evicts oldest contribution events at the frozen cap', () => {
  const diagnostics = new RestrictedHostDiagnostics({
    now: () => '2026-08-05T00:00:00Z',
  });
  for (let index = 0; index <= MAX_EVENTS_PER_CONTRIBUTION; index += 1) {
    diagnostics.record('INFO', 'bounded_event', {
      publisher_id: 'acme-labs', plugin_id: 'widgets', contribution_id: 'compute',
    }, { sequence: index });
  }
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.events.length, MAX_EVENTS_PER_CONTRIBUTION);
  assert.equal(snapshot.events[0].sequence, 1);
  assert.equal(snapshot.eviction_count, 1);
});
