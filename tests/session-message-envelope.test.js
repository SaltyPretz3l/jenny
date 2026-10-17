'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const E = require('../services/backend/session-message-envelope');
const { canonicalJson } = require('../services/backend/chat-proposal-records');
const { iso, makeEnvelope, uuid } = require('./helpers/session-mail-fixtures');

test('constants match the contract', () => {
  assert.equal(E.MAX_BODY_BYTES, 16384);
  assert.equal(E.INCLUDED_ROW_PREFIX, 'ctx_');
  assert.equal(E.RECEIPT_ROW_PREFIX, 'ctxr_');
});

test('validateBody accepts 1..16384 UTF-8 bytes and refuses everything else', () => {
  assert.deepEqual(E.validateBody('hi'), { ok: true });
  assert.deepEqual(E.validateBody('a\tb\nc\rd'), { ok: true });
  assert.deepEqual(E.validateBody('a'.repeat(16384)), { ok: true });
  assert.deepEqual(E.validateBody('é'.repeat(8192)), { ok: true });
  const invalid = { ok: false, reason: 'invalid_request', field: 'body' };
  const bad = ['', '   \n\t', 'a'.repeat(16385), 'é'.repeat(8193), 'x\u0000y', 'x\u0007y', 'x\u001by', 'x\u007fy',
    '\ud800', 'a\udc00b', 7, null, undefined, {}];
  for (const value of bad) assert.deepEqual(E.validateBody(value), invalid, String(value));
});

test('bodySha256 and envelopeSha256 are lowercase hex over UTF-8 / canonical JSON', () => {
  assert.equal(E.bodySha256('héllo'), crypto.createHash('sha256').update(Buffer.from('héllo', 'utf8')).digest('hex'));
  const envelope = makeEnvelope(1);
  assert.equal(E.envelopeSha256(envelope), crypto.createHash('sha256').update(canonicalJson(envelope), 'utf8').digest('hex'));
  const reordered = Object.fromEntries(Object.entries(envelope).reverse());
  assert.equal(E.envelopeSha256(reordered), E.envelopeSha256(envelope), 'key order does not matter');
});

test('buildUserEnvelope builds the closed user_message shape', () => {
  const envelope = makeEnvelope(1, { body: 'Please review' });
  assert.deepEqual(Object.keys(envelope).sort(), [...E.ENVELOPE_KEYS].sort());
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.kind, 'user_message');
  assert.equal(envelope.source_turn_id, null);
  assert.equal(envelope.report, null);
  assert.equal(envelope.source_session_id, 'sess_src');
  assert.equal(envelope.destination_project_id, 'proj_1');
  assert.equal(envelope.body_sha256, E.bodySha256('Please review'));
  assert.deepEqual(E.validateEnvelope(envelope), envelope);
});

test('buildUserEnvelope returns null for any invalid input', () => {
  const ok = {
    message_id: uuid(1),
    source: { session_id: 's', session_incarnation: 'i', project_id: null },
    destination: { session_id: 'd', session_incarnation: 'j', project_id: null },
    body: 'x',
    created_at: iso(),
  };
  assert.ok(E.buildUserEnvelope(ok));
  assert.ok(E.buildUserEnvelope({ ...ok, created_at: new Date(iso()) }));
  assert.ok(E.buildUserEnvelope({ ...ok, created_at: undefined }), 'defaults to now');
  assert.equal(E.buildUserEnvelope({ ...ok, message_id: 'nope' }), null);
  assert.equal(E.buildUserEnvelope({ ...ok, body: '  ' }), null);
  assert.equal(E.buildUserEnvelope({ ...ok, body: 5 }), null);
  assert.equal(E.buildUserEnvelope({ ...ok, source: { ...ok.source, session_id: '' } }), null);
  assert.equal(E.buildUserEnvelope({ ...ok, created_at: 'yesterday' }), null);
  assert.equal(E.buildUserEnvelope(), null);
});

test('validateEnvelope is closed, exact-keyed and hash-checked', () => {
  const envelope = makeEnvelope(1);
  assert.notEqual(E.validateEnvelope(envelope), envelope, 'returns a clone');
  assert.equal(E.validateEnvelope({ ...envelope, extra: 1 }), null);
  const { report: _drop, ...missing } = envelope;
  assert.equal(E.validateEnvelope(missing), null);
  assert.equal(E.validateEnvelope({ ...envelope, schema_version: 2 }), null);
  assert.equal(E.validateEnvelope({ ...envelope, body: 'tampered' }), null, 'sha mismatch');
  assert.equal(E.validateEnvelope({ ...envelope, body_sha256: 'A'.repeat(64) }), null);
  assert.equal(E.validateEnvelope({ ...envelope, kind: 'broadcast' }), null);
  assert.equal(E.validateEnvelope({ ...envelope, message_id: '0000000A-0000-4000-8000-00000000000A' }), null);
  assert.equal(E.validateEnvelope({ ...envelope, created_at: '2026-10-15T10:00:00Z' }), null);
  assert.equal(E.validateEnvelope({ ...envelope, source_project_id: '' }), null);
  assert.equal(E.validateEnvelope({ ...envelope, source_turn_id: 5 }), null);
  assert.equal(E.validateEnvelope(null), null);
  assert.equal(E.validateEnvelope([envelope]), null);
  assert.equal(E.validateEnvelope('x'), null);
});

test('validateEnvelope enforces the kind/report relation across the full union', () => {
  const base = makeEnvelope(1);
  const agent = { ...base, kind: 'agent_message', source_turn_id: 'turn_1' };
  assert.ok(E.validateEnvelope(agent));
  assert.equal(E.validateEnvelope({ ...agent, report: { outcome: 'completed', clipped: false, error_code: null } }), null);
  const report = { outcome: 'failed', clipped: true, error_code: 'CMP-MESSAGE-0011' };
  const terminal = { ...base, kind: 'terminal_report', report };
  assert.ok(E.validateEnvelope(terminal));
  assert.equal(E.validateEnvelope({ ...terminal, report: null }), null, 'terminal_report needs a report');
  const badReports = [{ ...report, outcome: 'ok' }, { ...report, clipped: 'yes' }, { ...report, error_code: 5 },
    { ...report, extra: 1 }, { outcome: 'failed', clipped: true }];
  for (const bad of badReports) assert.equal(E.validateEnvelope({ ...terminal, report: bad }), null, JSON.stringify(bad));
  for (const outcome of ['completed', 'failed', 'cancelled', 'awaiting_decision']) {
    assert.ok(E.validateEnvelope({ ...terminal, report: { outcome, clipped: false, error_code: null } }), outcome);
  }
  const big = 'a'.repeat(8193);
  assert.equal(E.validateEnvelope({ ...terminal, body: big, body_sha256: E.bodySha256(big) }), null, 'reports cap at 8 KiB');
});

test('buildIncludedRow and buildDiscardReceiptRow produce the canonical rows', () => {
  const envelope = makeEnvelope(3, { body: 'line1\nline2' });
  const included = E.buildIncludedRow(envelope, { turn_id: 'turn_9', timestamp: iso(5) });
  assert.deepEqual(included, {
    id: `ctx_${uuid(3)}`,
    role: 'context',
    kind: 'session_message',
    content: 'line1\nline2',
    session_message: envelope,
    turn_id: 'turn_9',
    timestamp: iso(5),
  });
  const receipt = E.buildDiscardReceiptRow(envelope, { timestamp: iso(6) });
  assert.deepEqual(receipt, {
    id: `ctxr_${uuid(3)}`,
    role: 'context',
    kind: 'session_message_receipt',
    content: 'line1\nline2',
    session_message: envelope,
    disposition: 'discarded',
    timestamp: iso(6),
  });
  assert.equal(E.buildIncludedRow(envelope, {}), null, 'a turn id is required');
  assert.equal(E.buildIncludedRow({ ...envelope, body: 'x' }, { turn_id: 't' }), null);
  assert.equal(E.buildDiscardReceiptRow(null), null);
  assert.match(E.buildIncludedRow(envelope, { turn_id: 't' }).timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('validateContextRow accepts both canonical rows and rejects every malformation', () => {
  const envelope = makeEnvelope(1);
  const included = E.buildIncludedRow(envelope, { turn_id: 'turn_1', timestamp: iso() });
  const receipt = E.buildDiscardReceiptRow(envelope, { timestamp: iso() });
  assert.equal(E.validateContextRow(included), included);
  assert.equal(E.validateContextRow(receipt), receipt);
  assert.ok(E.validateContextRow({ ...included, event_seq: 4, status: '', phases: [] }), 'normalized extras are tolerated');
  const bad = [
    { ...included, role: 'assistant' },
    { ...included, kind: 'other' },
    { ...included, content: 'different' },
    { ...included, id: 'ctx_other' },
    { ...included, id: `ctxr_${envelope.message_id}` },
    { ...included, turn_id: undefined },
    { ...included, timestamp: '' },
    { ...included, disposition: 'discarded' },
    { ...included, session_message: { ...envelope, body: 'x' } },
    { ...included, session_message: null },
    { ...receipt, disposition: undefined },
    { ...receipt, disposition: 'kept' },
    { ...receipt, id: `ctx_${envelope.message_id}` },
    { ...receipt, content: '' },
    null,
    'row',
    [],
  ];
  for (const row of bad) assert.equal(E.validateContextRow(row), null, JSON.stringify(row));
});

test('contextRowsEquivalent ignores timestamp and event_seq only', () => {
  const envelope = makeEnvelope(1);
  const a = E.buildIncludedRow(envelope, { turn_id: 'turn_1', timestamp: iso() });
  const b = E.buildIncludedRow(envelope, { turn_id: 'turn_1', timestamp: iso(9000) });
  assert.equal(E.contextRowsEquivalent({ ...a, event_seq: 3 }, b), true);
  assert.equal(E.contextRowsEquivalent(a, E.buildIncludedRow(envelope, { turn_id: 'turn_2', timestamp: iso() })), false);
  assert.equal(E.contextRowsEquivalent(a, E.buildIncludedRow(makeEnvelope(1, { body: 'other' }), { turn_id: 'turn_1' })), false);
  assert.equal(E.contextRowsEquivalent(a, E.buildDiscardReceiptRow(envelope)), false);
  assert.equal(E.contextRowsEquivalent(a, { id: 'x' }), false);
});

test('buildReportEnvelope builds a closed terminal_report that passes validateEnvelope', () => {
  const input = {
    child: { session_id: 'sess_src', session_incarnation: 'inc_src', project_id: null },
    parent: { session_id: 'sess_dst', session_incarnation: 'inc_dst', project_id: 'proj_1' },
    turnId: 'turn_7',
    outcome: 'completed',
    body: 'All done.',
    clipped: false,
    errorCode: null,
    messageId: uuid(7),
    createdAt: iso(),
  };
  const envelope = E.buildReportEnvelope(input);
  assert.deepEqual(envelope, {
    schema_version: 1,
    message_id: uuid(7),
    source_session_id: 'sess_src',
    source_session_incarnation: 'inc_src',
    source_project_id: null,
    destination_session_id: 'sess_dst',
    destination_session_incarnation: 'inc_dst',
    destination_project_id: 'proj_1',
    source_turn_id: 'turn_7',
    kind: 'terminal_report',
    created_at: iso(),
    body: 'All done.',
    body_sha256: E.bodySha256('All done.'),
    report: { outcome: 'completed', clipped: false, error_code: null },
  });
  assert.deepEqual(E.validateEnvelope(envelope), envelope);
  assert.equal(envelope.body_sha256, crypto.createHash('sha256').update(Buffer.from('All done.', 'utf8')).digest('hex'));
  const failed = E.buildReportEnvelope({ ...input, outcome: 'failed', clipped: true, errorCode: 'CMP-MESSAGE-0011', createdAt: new Date(iso()) });
  assert.deepEqual(failed.report, { outcome: 'failed', clipped: true, error_code: 'CMP-MESSAGE-0011' });
  assert.equal(failed.created_at, iso());
  assert.equal(E.buildReportEnvelope({ ...input, errorCode: undefined }).report.error_code, null);
  for (const outcome of E.REPORT_OUTCOMES) assert.ok(E.buildReportEnvelope({ ...input, outcome }), outcome);
});

test('buildReportEnvelope caps the body at 8192 bytes and rejects every invalid input', () => {
  const ok = {
    child: { session_id: 'sess_src', session_incarnation: 'inc_src', project_id: null },
    parent: { session_id: 'sess_dst', session_incarnation: 'inc_dst', project_id: null },
    turnId: 'turn_7', outcome: 'completed', body: 'x', clipped: false, errorCode: null, messageId: uuid(7), createdAt: iso(),
  };
  assert.ok(E.buildReportEnvelope({ ...ok, body: 'a'.repeat(8192) }));
  assert.equal(E.buildReportEnvelope({ ...ok, body: 'a'.repeat(8193) }), null, 'reports are capped below the explicit-message limit');
  const bad = [
    { body: '' }, { body: '   ' }, { body: 'x\u0000' }, { body: '\ud800' }, { body: 7 }, { body: undefined },
    { outcome: 'interrupted' }, { outcome: undefined }, { messageId: 'nope' }, { messageId: undefined },
    { errorCode: 'bad' }, { errorCode: 'CMP-MESSAGE-12' }, { turnId: '' }, { turnId: undefined }, { turnId: null },
    { child: undefined }, { parent: undefined }, { child: { session_id: '', session_incarnation: 'i' } },
    { createdAt: 'yesterday' },
  ];
  for (const patch of bad) assert.equal(E.buildReportEnvelope({ ...ok, ...patch }), null, JSON.stringify(patch));
  assert.equal(E.buildReportEnvelope(), null);
});

test('buildAgentEnvelope: a closed agent_message that always names its source turn', () => {
  const source = { session_id: 'sess_a', session_incarnation: 'inc_a', project_id: null };
  const destination = { session_id: 'sess_b', session_incarnation: 'inc_b', project_id: 'proj_1' };
  const input = {
    message_id: '11111111-1111-4111-8111-111111111111', source, destination, turnId: 'turn_9', body: 'Please look at the plan.',
    created_at: '2026-10-15T10:00:00.000Z',
  };
  const envelope = E.buildAgentEnvelope(input);
  assert.equal(envelope.kind, 'agent_message');
  assert.equal(envelope.source_turn_id, 'turn_9');
  assert.equal(envelope.report, null);
  assert.equal(envelope.body_sha256, E.bodySha256('Please look at the plan.'));
  assert.deepEqual(E.validateEnvelope(envelope), envelope);
  assert.equal(E.buildAgentEnvelope({ ...input, turnId: '' }), null);
  assert.equal(E.buildAgentEnvelope({ ...input, turnId: undefined }), null);
  assert.equal(E.buildAgentEnvelope({ ...input, body: '   ' }), null);
  assert.equal(E.buildAgentEnvelope({ ...input, body: 'x'.repeat(16385) }), null);
  assert.ok(E.buildAgentEnvelope({ ...input, body: 'x'.repeat(16384) }));
  assert.equal(E.buildAgentEnvelope({ ...input, source: { ...source, session_incarnation: '' } }), null);
  assert.equal(E.validateEnvelope({ ...envelope, source_turn_id: null }), null, 'an agent_message with no source turn is invalid');
  assert.ok(E.validateEnvelope({ ...envelope, kind: 'user_message', source_turn_id: null }), 'a user message keeps a null turn');
});
