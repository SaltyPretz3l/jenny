'use strict';

// The bounded audit export path (lifecycle/audit-export.js): filtering,
// truncation reporting, sequence-violation surfacing, and the independent
// write-out redaction re-check that refuses to ever emit a leak, mirroring
// the "fail closed, never a warning" posture the rest of this subtree uses.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { AUDIT_FILE, buildAuditEvent, appendAuditEvent } = require('../../../services/plugins/lifecycle/audit-log');
const { exportAuditLog } = require('../../../services/plugins/lifecycle/audit-export');

const BASE_DIR = 'plugins';

function eventInput(overrides = {}) {
  return {
    eventId: overrides.eventId || 'audit-op-1',
    sequence: overrides.sequence === undefined ? 0 : overrides.sequence,
    recordedAt: overrides.recordedAt || '2026-07-31T00:00:00Z',
    actor: overrides.actor || { kind: 'user' },
    action: overrides.action || 'enable',
    outcome: overrides.outcome || 'committed',
    commitEpoch: overrides.commitEpoch === undefined ? 0 : overrides.commitEpoch,
    lifecycleEpoch: overrides.lifecycleEpoch === undefined ? 1 : overrides.lifecycleEpoch,
    operationId: overrides.operationId,
    subject: overrides.subject,
    detail: overrides.detail,
  };
}

async function seed(facade, inputs) {
  for (const input of inputs) {
    const built = buildAuditEvent(eventInput(input));
    assert.equal(built.ok, true, `fixture event must itself validate: ${JSON.stringify(built)}`);
    const appended = await appendAuditEvent(facade, BASE_DIR, built.event, { maxEntries: 10000 });
    assert.equal(appended.ok, true);
  }
}

test('exportAuditLog on an empty log returns a well-formed empty document', async () => {
  const facade = createMemoryFsFacade();
  const result = await exportAuditLog(facade, BASE_DIR, { now: '2026-07-31T00:00:00Z' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.document.entries, []);
  assert.equal(result.document.integrity, 'ok');
  assert.equal(result.document.truncated, false);
  assert.equal(result.document.truncated_count, 0);
});

test('exportAuditLog round-trips every entry when unfiltered', async () => {
  const facade = createMemoryFsFacade();
  await seed(facade, [{ sequence: 0, eventId: 'audit-0' }, { sequence: 1, eventId: 'audit-1' }, { sequence: 2, eventId: 'audit-2' }]);

  const result = await exportAuditLog(facade, BASE_DIR, {});
  assert.equal(result.ok, true);
  assert.equal(result.document.entry_count, 3);
  assert.equal(result.document.matched_count, 3);
  assert.equal(result.document.integrity, 'ok');
  assert.deepEqual(result.document.entries.map((e) => e.event_id), ['audit-0', 'audit-1', 'audit-2']);
});

test('exportAuditLog filters by action', async () => {
  const facade = createMemoryFsFacade();
  await seed(facade, [
    { sequence: 0, eventId: 'audit-enable', action: 'enable' },
    { sequence: 1, eventId: 'audit-disable', action: 'disable' },
  ]);

  const result = await exportAuditLog(facade, BASE_DIR, { filter: { action: 'disable' } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.document.entries.map((e) => e.event_id), ['audit-disable']);
});

test('exportAuditLog filters by authority (subject)', async () => {
  const facade = createMemoryFsFacade();
  await seed(facade, [
    {
      sequence: 0,
      eventId: 'audit-acme',
      subject: { publisher_id: 'acme', plugin_id: 'widgets' },
    },
    {
      sequence: 1,
      eventId: 'audit-other',
      subject: { publisher_id: 'other', plugin_id: 'gadgets' },
    },
    { sequence: 2, eventId: 'audit-no-subject' },
  ]);

  const result = await exportAuditLog(facade, BASE_DIR, {
    filter: { authority: { publisherId: 'acme', pluginId: 'widgets' } },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.document.entries.map((e) => e.event_id), ['audit-acme']);
});

test('exportAuditLog filters by a since/until time range', async () => {
  const facade = createMemoryFsFacade();
  await seed(facade, [
    { sequence: 0, eventId: 'audit-early', recordedAt: '2026-01-01T00:00:00Z' },
    { sequence: 1, eventId: 'audit-mid', recordedAt: '2026-06-01T00:00:00Z' },
    { sequence: 2, eventId: 'audit-late', recordedAt: '2026-12-01T00:00:00Z' },
  ]);

  const result = await exportAuditLog(facade, BASE_DIR, {
    filter: { since: '2026-02-01T00:00:00Z', until: '2026-07-01T00:00:00Z' },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.document.entries.map((e) => e.event_id), ['audit-mid']);
});

test('exportAuditLog rejects a filter with an unknown key rather than ignoring it', async () => {
  const facade = createMemoryFsFacade();
  const result = await exportAuditLog(facade, BASE_DIR, { filter: { publisherId: 'acme' } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'filter_unknown_key');
});

test('exportAuditLog rejects a malformed authority filter', async () => {
  const facade = createMemoryFsFacade();
  const result = await exportAuditLog(facade, BASE_DIR, {
    filter: { authority: { publisherId: 'ACME', pluginId: 'widgets' } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'filter_authority_invalid');
});

test('exportAuditLog rejects an unknown nested authority key rather than broadening the export', async () => {
  const facade = createMemoryFsFacade();
  const result = await exportAuditLog(facade, BASE_DIR, {
    filter: { authority: { publisherId: 'acme', pluginId: 'widgets', ignoredScope: 'other' } },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'filter_authority_unknown_key');
  assert.deepEqual(result.detail, { key: 'ignoredScope' });
});

test('exportAuditLog caps entries and reports truncation with an exact dropped count, keeping the newest', async () => {
  const facade = createMemoryFsFacade();
  await seed(facade, [
    { sequence: 0, eventId: 'audit-0' },
    { sequence: 1, eventId: 'audit-1' },
    { sequence: 2, eventId: 'audit-2' },
    { sequence: 3, eventId: 'audit-3' },
  ]);

  const result = await exportAuditLog(facade, BASE_DIR, { maxEntries: 2 });
  assert.equal(result.ok, true);
  assert.equal(result.document.truncated, true);
  assert.equal(result.document.truncated_count, 2);
  assert.deepEqual(result.document.entries.map((e) => e.event_id), ['audit-2', 'audit-3']);
});

test('exportAuditLog reports a sequence violation with its index rather than a clean-looking document', async () => {
  const facade = createMemoryFsFacade();
  const goodOne = buildAuditEvent(eventInput({ sequence: 0, eventId: 'audit-0' })).event;
  const goodTwo = buildAuditEvent(eventInput({ sequence: 1, eventId: 'audit-1' })).event;
  // A repeated sequence number simulates two writers racing without the
  // mutation lease -- exactly what findSequenceViolation exists to catch.
  const repeat = buildAuditEvent(eventInput({ sequence: 1, eventId: 'audit-1-repeat' })).event;
  const raw = [goodOne, goodTwo, repeat].map((e) => JSON.stringify(e)).join('\n') + '\n';
  await facade.mkdir(BASE_DIR);
  await facade.writeFile(`${BASE_DIR}/${AUDIT_FILE}`, raw);

  const result = await exportAuditLog(facade, BASE_DIR, {});
  assert.equal(result.ok, true);
  assert.equal(result.document.integrity, 'sequence_violation');
  assert.equal(result.document.sequence_violation.index, 2);
});

test('exportAuditLog refuses to emit when an unredacted leaf slipped past write-time redaction', async () => {
  const facade = createMemoryFsFacade();
  const clean = buildAuditEvent(eventInput({ sequence: 0, eventId: 'audit-clean' })).event;
  // This event could only reach disk by bypassing appendAuditEvent's own
  // write-time check (e.g. a future contract change loosening `detail.reason`'s
  // pattern) -- export must catch it independently rather than trust the log.
  const leaking = {
    ...buildAuditEvent(eventInput({ sequence: 1, eventId: 'audit-leak' })).event,
    detail: { code: 'leak', reason: 'token: abc123' },
  };
  const raw = [clean, leaking].map((e) => JSON.stringify(e)).join('\n') + '\n';
  await facade.mkdir(BASE_DIR);
  await facade.writeFile(`${BASE_DIR}/${AUDIT_FILE}`, raw);

  const result = await exportAuditLog(facade, BASE_DIR, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unredacted_leaf_present');
  assert.equal(result.detail.path, 'detail.reason');
  // The offending path/reason are reported, but never the raw secret value.
  assert.ok(!JSON.stringify(result.detail).includes('abc123'));
});

test('exportAuditLog accepts an injected redact function in place of the default', async () => {
  const facade = createMemoryFsFacade();
  await seed(facade, [{ sequence: 0, eventId: 'audit-0' }]);

  const alwaysLeaks = () => ({ path: 'custom.path', reason: 'custom_reason' });
  const result = await exportAuditLog(facade, BASE_DIR, { redact: alwaysLeaks });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unredacted_leaf_present');
  assert.equal(result.detail.path, 'custom.path');
});

test('export carries one bounded pathless managed-policy revision and clamps caller expansion', async () => {
  const facade = createMemoryFsFacade();
  await seed(facade, Array.from({ length: 4 }, (_, sequence) => ({
    sequence, eventId: `audit-managed-${sequence}`,
  })));
  const managedPolicy = {
    status: 'active', reason: 'managed_policy_privileged_denied', revision: 9,
    source_revision: 12, policy_digest: 'a'.repeat(64), source_kind: 'windows_machine_policy',
    source_fingerprint: 'b'.repeat(64), privileged_execution: 'deny', update_ring: 'stable',
  };
  const result = await exportAuditLog(facade, BASE_DIR, {
    maxEntries: 9999, policyMaxEntries: 2, managedPolicy,
  });
  assert.equal(result.ok, true);
  assert.equal(result.document.entry_count, 2);
  assert.deepEqual(result.document.managed_policy, managedPolicy);
  assert.equal(JSON.stringify(result.document).includes('C:\\'), false);
  assert.equal(JSON.stringify(result.document).includes('/Library/'), false);
});
