'use strict';

// PluginAuditEventV1 (audit-log.js): redaction happens at WRITE time, so
// nothing unredacted is ever durable, plus the bounded-retention and
// tolerant-read properties the Stage 9 export path depends on.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const {
  AUDIT_FILE,
  buildAuditEvent,
  appendAuditEvent,
  readAuditLog,
  findSequenceViolation,
} = require('../../../services/plugins/lifecycle/audit-log');

const BASE_DIR = 'plugins';
const NOW = '2026-07-31T00:00:00Z';

function auditEventInput(overrides = {}) {
  return {
    eventId: overrides.eventId || 'audit-op-1',
    sequence: overrides.sequence === undefined ? 0 : overrides.sequence,
    recordedAt: overrides.recordedAt || NOW,
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

// The only free-text leaf PluginAuditEventV1 has is detail.reason (bounded
// printable-ASCII prose); every other string field -- event_id, subject's
// publisher_id/plugin_id/contribution_id, detail.code -- is constrained to
// the nfc_identifier pattern and so cannot itself carry a path or secret
// shape (a colon or backslash fails the identifier regex before redaction
// ever runs). These tests exercise the leaf-walk through that one vector,
// nested two levels deep, which is exactly what proves findUnredactedLeaf
// recurses into nested objects rather than only checking top-level fields.

test('buildAuditEvent rejects a path-shaped string nested in detail.reason', () => {
  const result = buildAuditEvent(auditEventInput({
    detail: { code: 'lease-recovered', reason: 'Recovered from C:\\Users\\alice\\plugins\\lease.json' },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'audit_event_not_redacted');
  assert.equal(result.detail.path, 'detail.reason');
  assert.equal(result.detail.reason, 'guidance_contains_path');
});

test('buildAuditEvent rejects a secret-shaped string nested in detail.reason', () => {
  const result = buildAuditEvent(auditEventInput({
    detail: { code: 'grant-denied', reason: 'blocked because api_key=abc123 was present' },
  }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'audit_event_not_redacted');
  assert.equal(result.detail.path, 'detail.reason');
  assert.equal(result.detail.reason, 'guidance_contains_secret');
});

test('appendAuditEvent independently refuses the same unredacted event -- redaction happens at write time, not just at build time', async () => {
  const facade = createMemoryFsFacade();
  // A caller could in principle hand appendAuditEvent an object it built by
  // hand rather than through buildAuditEvent; the write path must fail
  // closed on its own rather than trusting the caller already redacted it.
  const candidate = {
    audit_schema_version: 1,
    event_id: 'audit-leak',
    sequence: 0,
    recorded_at: NOW,
    actor: { kind: 'user' },
    action: 'enable',
    outcome: 'committed',
    commit_epoch: 0,
    lifecycle_epoch: 1,
    detail: { code: 'leak', reason: 'token: abc123' },
  };
  const appended = await appendAuditEvent(facade, BASE_DIR, candidate);
  assert.equal(appended.ok, false);
  assert.equal(appended.reason, 'audit_event_not_redacted');

  const { events } = await readAuditLog(facade, BASE_DIR);
  assert.deepEqual(events, [], 'a rejected event must never reach disk');
});

test('appendAuditEvent + readAuditLog round-trip over the memory fs facade', async () => {
  const facade = createMemoryFsFacade();
  const built = buildAuditEvent(auditEventInput({ eventId: 'audit-op-1', sequence: 0 }));
  assert.equal(built.ok, true);

  const appended = await appendAuditEvent(facade, BASE_DIR, built.event);
  assert.equal(appended.ok, true);
  assert.equal(appended.entryCount, 1);

  const { events, corruptCount, invalidCount } = await readAuditLog(facade, BASE_DIR);
  assert.equal(corruptCount, 0);
  assert.equal(invalidCount, 0);
  assert.deepEqual(events, [built.event]);
});

test('bounded retention: exceeding maxEntries drops the oldest entries first (ring buffer)', async () => {
  const facade = createMemoryFsFacade();
  for (let sequence = 0; sequence < 5; sequence += 1) {
    const built = buildAuditEvent(auditEventInput({ eventId: `audit-${sequence}`, sequence }));
    assert.equal(built.ok, true);
    const appended = await appendAuditEvent(facade, BASE_DIR, built.event, { maxEntries: 3 });
    assert.equal(appended.ok, true);
  }
  const { events } = await readAuditLog(facade, BASE_DIR);
  assert.deepEqual(events.map((event) => event.sequence), [2, 3, 4]);
});

test('readAuditLog tolerates a torn trailing line (corruptCount) and separately counts a parseable-but-invalid entry (invalidCount)', async () => {
  const facade = createMemoryFsFacade();
  const goodEvent = buildAuditEvent(auditEventInput({ eventId: 'audit-good', sequence: 0 })).event;
  // Valid JSON, but 'action' is not a member of the audit action enum -- this
  // parses fine and must be counted separately from a torn/corrupt line.
  const parseableButInvalid = {
    audit_schema_version: 1,
    event_id: 'audit-bad',
    sequence: 1,
    recorded_at: NOW,
    actor: { kind: 'user' },
    action: 'not-a-real-action',
    outcome: 'committed',
    commit_epoch: 0,
    lifecycle_epoch: 1,
  };
  const raw = `${JSON.stringify(goodEvent)}\n${JSON.stringify(parseableButInvalid)}\n{not valid json`;
  await facade.mkdir(BASE_DIR);
  await facade.writeFile(`${BASE_DIR}/${AUDIT_FILE}`, raw);

  const { events, corruptCount, invalidCount } = await readAuditLog(facade, BASE_DIR);
  assert.equal(events.length, 1);
  assert.equal(events[0].event_id, 'audit-good');
  assert.equal(corruptCount, 1, 'the torn trailing line must be counted as corrupt');
  assert.equal(invalidCount, 1, 'the schema-invalid-but-parseable line must be counted separately as invalid');
});

test('findSequenceViolation accepts retention gaps but rejects a repeat or a regression', () => {
  const stub = (sequence) => ({ sequence });

  assert.deepEqual(findSequenceViolation([stub(0), stub(1), stub(5)]), { ok: true }, 'a gap from retention is legal');

  const repeat = findSequenceViolation([stub(0), stub(1), stub(1)]);
  assert.equal(repeat.ok, false);
  assert.equal(repeat.reason, 'audit_sequence_not_monotonic');

  const regression = findSequenceViolation([stub(0), stub(3), stub(2)]);
  assert.equal(regression.ok, false);
  assert.equal(regression.reason, 'audit_sequence_not_monotonic');
});
