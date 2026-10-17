'use strict';

// The session_handoff context row (row 59 checkpoint 5a-1, slice S3): closed shapes, the canonical
// row, how the store, the history builders and compaction treat it, and the fail-closed admission.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const H = require('../services/backend/session-handoff-context');
const E = require('../services/backend/session-message-envelope');
const { ElectronSessionStore, normalizeMessage } = require('../services/backend/electron-session-store');
const { normalizeMessageFields } = require('../services/backend/message-normalization');
const { buildPreparedContextHistory, buildPreparedMessages, selectContextHistoryMessages } = require('../services/backend/chat-stream-reasoning');
const { fingerprintCompactionPrefix, normalizeCompactionSnapshot } = require('../services/backend/session-compaction-snapshot');
const { projectCanonicalSessionMessagesForSend } = require('../services/backend/chat-send-frame-budget');
const F = require('./helpers/session-mail-fixtures');

const HEX = 'ab12'.repeat(16);
const PROPOSAL = `proposal_${HEX}`;
const ATTEMPT = '1a1a1a1a-2b2b-4c3c-8d4d-5e5e5e5e5e5e';
const BODY = 'Background: the user wants the billing export fixed. Key file: export.js';
const SESSION = { history_scope: 'session' };

const handoff = (over = {}) => H.buildSessionHandoff({
  proposalId: PROPOSAL, sourceSessionId: 'sess_src', sourceSessionIncarnation: 'inc_src', body: BODY, ...over,
});
const row = (over = {}, turn = 'turn_1') => H.buildHandoffRow(handoff(over), { turn_id: turn, timestamp: F.iso(1) });
const user = (id, content = id) => ({ id, role: 'user', content });
const assistant = (id, content = id) => ({ id, role: 'assistant', content });

function openStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-handoff-ctx-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const session = store.createSession({ title: 'Child' });
  return { store, id: session.id };
}

test('the preparation field is closed: exactly proposal_id and a lowercase uuid attempt_id', () => {
  const ok = { proposal_id: PROPOSAL, attempt_id: ATTEMPT };
  assert.deepEqual(H.normalizeHandoffPreparation(ok), ok);
  for (const bad of [null, undefined, 'x', [], {}, { ...ok, extra: 1 }, { proposal_id: PROPOSAL }, { ...ok, attempt_id: 'nope' },
    { ...ok, attempt_id: ATTEMPT.toUpperCase() }, { ...ok, proposal_id: 'proposal_abc' }, { ...ok, proposal_id: PROPOSAL.toUpperCase() }]) {
    assert.equal(H.normalizeHandoffPreparation(bad), null, JSON.stringify(bad));
  }
});

test('session_handoff is closed, self-consistent and never empty', () => {
  const valid = handoff();
  assert.deepEqual(Object.keys(valid).sort(), [...H.HANDOFF_KEYS].sort());
  assert.deepEqual(H.normalizeSessionHandoff(valid), valid);
  assert.notEqual(H.normalizeSessionHandoff(valid), valid, 'a clone, never an alias');
  assert.equal(valid.body_sha256, E.bodySha256(BODY));
  const bad = [
    { ...valid, extra: true }, { ...valid, schema_version: 2 }, { ...valid, proposal_id: 'proposal_x' },
    { ...valid, body: '' }, { ...valid, body: '   \n ' }, { ...valid, body: 'tampered' }, { ...valid, body_sha256: 'f'.repeat(64) },
    { ...valid, body: 'a\u0000b', body_sha256: E.bodySha256('a\u0000b') }, { ...valid, source_session_id: '' },
    { ...valid, source_session_incarnation: 'x'.repeat(513) }, { ...valid, body: 'lone \ud800 surrogate', body_sha256: E.bodySha256('lone \ud800 surrogate') },
    null, [], 'text',
  ];
  for (const value of bad) assert.equal(H.normalizeSessionHandoff(value), null, JSON.stringify(value)?.slice(0, 80));
  assert.equal(handoff({ body: '' }), null, 'an empty Background has no row');
});

test('the body limit is 32 KiB of UTF-8', () => {
  assert.equal(H.MAX_HANDOFF_BODY_BYTES, 32768);
  assert.ok(handoff({ body: 'a'.repeat(32768) }));
  assert.equal(handoff({ body: 'a'.repeat(32769) }), null);
  assert.ok(handoff({ body: 'é'.repeat(16384) }), '2-byte characters are counted as bytes');
  assert.equal(handoff({ body: 'é'.repeat(16385) }), null);
});

test('the canonical row: ctxh_ + the 64 hex of the proposal id, content equals the body, turn id required', () => {
  const built = row();
  assert.equal(built.id, `ctxh_${HEX}`);
  assert.equal(H.handoffRowId(PROPOSAL), built.id);
  assert.equal(built.role, 'context');
  assert.equal(built.kind, 'session_handoff');
  assert.equal(built.content, BODY);
  assert.equal(built.turn_id, 'turn_1');
  assert.deepEqual(built.session_handoff, handoff());
  assert.equal(H.validateHandoffRow(built), built);
  assert.equal(H.buildHandoffRow(handoff(), { turn_id: '' }), null);
  assert.equal(H.buildHandoffRow({ ...handoff(), body: 'forged' }, { turn_id: 'turn_1' }), null);
  assert.equal(H.buildHandoffRow(null, { turn_id: 'turn_1' }), null);
});

test('validateHandoffRow accepts normalized extras and rejects every malformation', () => {
  const built = row();
  assert.ok(H.validateHandoffRow({ ...built, event_seq: 4, status: '', phases: [] }), 'normalized extras are tolerated');
  const bad = [
    { ...built, id: 'ctxh_other' }, { ...built, id: `ctx_${HEX}` }, { ...built, content: 'not the body' }, { ...built, role: 'user' },
    { ...built, kind: 'session_message' }, { ...built, turn_id: undefined }, { ...built, timestamp: '' },
    { ...built, disposition: 'discarded' }, { ...built, session_handoff: { ...built.session_handoff, extra: 1 } },
    { ...built, session_handoff: undefined }, null, 'row',
  ];
  for (const value of bad) assert.equal(H.validateHandoffRow(value), null, JSON.stringify(value)?.slice(0, 80));
});

test('handoffRowsEquivalent ignores timestamp and event_seq only', () => {
  const a = row();
  assert.equal(H.handoffRowsEquivalent({ ...a, timestamp: F.iso(99), event_seq: 3 }, a), true);
  assert.equal(H.handoffRowsEquivalent(a, row({}, 'turn_2')), false, 'another turn is another placement');
  assert.equal(H.handoffRowsEquivalent(a, row({ sourceSessionId: 'sess_other' })), false);
  assert.equal(H.handoffRowsEquivalent(a, { id: 'x' }), false);
});

test('the shared dispatch validates mail rows and handoff rows alike', () => {
  const mail = E.buildIncludedRow(F.makeEnvelope(1), { turn_id: 'turn_1', timestamp: F.iso(1) });
  const receipt = E.buildDiscardReceiptRow(F.makeEnvelope(2), { timestamp: F.iso(2) });
  assert.equal(H.validateAnyContextRow(mail), mail);
  assert.equal(H.validateAnyContextRow(receipt), receipt);
  assert.equal(H.validateAnyContextRow(row()) !== null, true);
  assert.equal(H.validateAnyContextRow({ ...row(), content: 'x' }), null);
  assert.equal(H.anyContextRowsEquivalent(mail, { ...mail, event_seq: 2 }), true);
  assert.equal(H.anyContextRowsEquivalent(mail, row()), false);
  assert.equal(H.anyContextRowsEquivalent(row(), { ...row(), timestamp: F.iso(5) }), true);
});

test('message normalization keeps a valid handoff row and drops a forged one, never coercing it to text', () => {
  const kept = normalizeMessageFields(row());
  assert.equal(kept.role, 'context');
  assert.equal(kept.kind, 'session_handoff');
  assert.deepEqual(kept.session_handoff, handoff());
  assert.equal(kept.turn_id, 'turn_1');
  assert.equal(normalizeMessage(row(), 'model').session_handoff.proposal_id, PROPOSAL);
  assert.equal(H.validateHandoffRow(kept) !== null, true, 'stable under re-validation');
  assert.equal(normalizeMessageFields({ ...row(), content: 'forged' }), null);
  assert.equal(normalizeMessageFields({ ...row(), session_handoff: { ...handoff(), body: 'swapped' } }), null);
  assert.equal(normalizeMessageFields({ id: 'ctxh_x', role: 'context', kind: 'session_handoff', content: 'orphan' }), null);
});

test('the store inserts the row before the anchor, idempotently, and refuses a conflicting reuse of the id', (t) => {
  const { store, id } = openStore(t);
  store.appendMessage(id, { id: 'u1', role: 'user', content: 'the first prompt', turn_id: 'turn_1' });
  assert.ok(store.insertMessagesBefore(id, 'u1', [row()]));
  assert.deepEqual(store.getSession(id).messages.map((m) => m.id), [`ctxh_${HEX}`, 'u1']);
  const stored = store.getSession(id).messages[0];
  assert.equal(stored.kind, 'session_handoff');
  assert.deepEqual(stored.session_handoff, handoff());
  assert.equal(store.getSession(id).last_message_preview, 'the first prompt');
  // Same row again (a later timestamp): idempotent, nothing duplicated.
  assert.ok(store.insertMessagesBefore(id, 'u1', [{ ...row(), timestamp: F.iso(50) }]));
  assert.equal(store.getSession(id).messages.length, 2);
  // Same id under another turn or another body is a conflict, never an overwrite.
  assert.equal(store.insertMessagesBefore(id, 'u1', [row({}, 'turn_2')]), null);
  assert.equal(store.insertMessagesBefore(id, 'u1', [row({ body: 'different background' })]), null);
  assert.equal(store.getSession(id).messages[0].content, BODY);
  // A forged row is refused by the plan.
  assert.equal(store.insertMessagesBefore(id, 'u1', [{ ...row({}), id: 'ctxh_forged' }]), null);
});

test('history builders: negotiated handoff rows ride the wire unchanged, with the same fail-closed defaults as mail', () => {
  const built = row();
  const [projected] = buildPreparedContextHistory([built], SESSION, { sessionHandoff: true });
  assert.deepEqual(projected, { role: 'context', kind: 'session_handoff', content: BODY, session_handoff: built.session_handoff });
  assert.equal(buildPreparedContextHistory([built], SESSION).length, 0, 'nothing negotiated: dropped');
  assert.equal(buildPreparedContextHistory([built], SESSION, { sessionHandoff: false }).length, 0);
  assert.equal(buildPreparedContextHistory([built], SESSION, { sessionMessages: false, sessionHandoff: false }).length, 0);
  // The two kinds are negotiated independently.
  const mail = E.buildIncludedRow(F.makeEnvelope(1), { turn_id: 'turn_1', timestamp: F.iso(1) });
  const both = buildPreparedContextHistory([mail, built], SESSION, { sessionMessages: true, sessionHandoff: false });
  assert.deepEqual(both.map((m) => m.kind), ['session_message']);
  const handoffOnly = buildPreparedContextHistory([mail, built], SESSION, { sessionMessages: false, sessionHandoff: true });
  assert.deepEqual(handoffOnly.map((m) => m.kind), ['session_handoff']);
  // A trusted checkpoint resume states only sessionMessages and keeps the handoff row; the managed send re-filters.
  assert.deepEqual(buildPreparedContextHistory([mail, built], SESSION, { sessionMessages: true }).map((m) => m.kind),
    ['session_message', 'session_handoff']);
});

test('malformed handoff rows never reach the wire and are never downgraded to text', () => {
  const tampered = { ...row(), content: 'not the body' };
  const forgedPayload = { ...row(), session_handoff: { ...row().session_handoff, body: 'swapped' } };
  const wrongId = { ...row(), id: 'ctxh_wrong' };
  const wire = buildPreparedContextHistory([tampered, forgedPayload, wrongId, row()], SESSION, { sessionHandoff: true });
  assert.deepEqual(wire.map((m) => m.content), [BODY]);
  assert.ok(wire.every((m) => m.role === 'context'));
});

test('history scope: the first turn handoff row is pinned under every scope', () => {
  const messages = [];
  for (let i = 1; i <= 8; i += 1) messages.push(user(`u${i}`, `Question ${i}`), assistant(`a${i}`, `Answer ${i}`));
  messages.push(row({}, 'turn_9'));
  for (const scope of ['session', 'recent', 'fresh']) {
    const selected = selectContextHistoryMessages(messages, { history_scope: scope });
    assert.equal(selected.at(-1).id, `ctxh_${HEX}`, scope);
  }
  const prepared = buildPreparedMessages(messages, 'next', { contextPreferences: { history_scope: 'fresh' }, sessionHandoff: true });
  assert.deepEqual(prepared.map((m) => m.role), ['context', 'user']);
  assert.equal(prepared[0].kind, 'session_handoff');
});

test('canonical_session_messages on the wire drop context rows; the compaction digest covers the handoff identity', () => {
  // Only tool-shaped entries ride; the context row and the prose collapse to the single placeholder.
  assert.deepEqual(projectCanonicalSessionMessagesForSend([row(), user('u1')]).map((m) => m.kind), ['projected_placeholder']);
  const a = fingerprintCompactionPrefix([row(), user('u1')]);
  const b = fingerprintCompactionPrefix([row({ body: 'a different background' }), user('u1')]);
  assert.notEqual(a, b, 'a changed Background changes the digest');
  assert.equal(a, fingerprintCompactionPrefix([row(), user('u1')]));
  assert.notEqual(a, fingerprintCompactionPrefix([user('u1')]), 'the row itself is part of the prefix');
});

test('a compaction snapshot keeps a valid handoff entry verbatim and refuses a forged one', () => {
  const base = {
    version: 2, origin: 'manual', created_at: F.iso(0), strategy: 'full', tokens_before: 100, tokens_after: 50,
    replacement_tokens: 10, boundary_message_id: 'u1', boundary_message_count: 2,
  };
  const entry = { role: 'context', kind: 'session_handoff', content: BODY, session_handoff: handoff() };
  const ok = normalizeCompactionSnapshot({ ...base, messages: [{ role: 'system', content: '## Compacted Conversation Summary\nx' }, entry] });
  assert.ok(ok, 'snapshot accepted');
  assert.deepEqual(ok.messages.at(-1), entry);
  assert.equal(normalizeCompactionSnapshot({ ...base, messages: [{ ...entry, content: 'forged' }] }), null);
  assert.equal(normalizeCompactionSnapshot({ ...base, messages: [{ ...entry, session_handoff: { ...handoff(), body: 'x' } }] }), null);
});

// ---------- fail-closed admission ----------

function admissionEnv(t, { supported = true } = {}) {
  const { store, id } = openStore(t);
  store.appendMessage(id, { id: 'u1', role: 'user', content: 'first prompt', turn_id: 'turn_1' });
  const logs = [];
  const service = { sessionStore: store, _emitServiceLog: (level, event, details) => logs.push({ level, event, details }) };
  const admit = (over = {}) => H.admitSessionHandoffForTurn({
    service, sessionId: id, turnId: 'turn_1', userMessageId: 'u1', handoff: handoff(), supportsHandoff: () => supported, ...over,
  });
  return { store, id, service, logs, admit };
}

test('admission inserts the row before the anchor, flushed, and retries reuse it', (t) => {
  const env = admissionEnv(t);
  const admitted = env.admit();
  assert.equal(admitted.id, `ctxh_${HEX}`);
  assert.deepEqual(env.store.getSession(env.id).messages.map((m) => m.id), [`ctxh_${HEX}`, 'u1']);
  let flushes = 0;
  const flush = env.store.flushSession.bind(env.store);
  env.store.flushSession = (sessionId) => { flushes += 1; return flush(sessionId); };
  const again = env.admit();
  assert.equal(again.id, admitted.id);
  assert.equal(env.store.getSession(env.id).messages.length, 2, 'idempotent by id: no duplicate row');
  assert.equal(flushes, 1);
});

test('not negotiated: the admission throws a coded error and writes nothing', (t) => {
  const env = admissionEnv(t, { supported: false });
  assert.throws(() => env.admit(), (error) => error.code === 'session_handoff_not_negotiated' && error.retryable === false);
  assert.deepEqual(env.store.getSession(env.id).messages.map((m) => m.id), ['u1']);
});

test('an invalid handoff or missing ids fail closed', (t) => {
  const env = admissionEnv(t);
  for (const over of [{ handoff: { ...handoff(), body: 'forged' } }, { handoff: null }, { turnId: '' }, { userMessageId: '' }]) {
    assert.throws(() => env.admit(over), (error) => error.code === 'session_handoff_invalid', JSON.stringify(Object.keys(over)));
  }
  assert.deepEqual(env.store.getSession(env.id).messages.map((m) => m.id), ['u1']);
});

test('an insert refusal or throw fails closed (a wrong anchor is refused by the plan)', (t) => {
  const env = admissionEnv(t);
  assert.throws(() => env.admit({ userMessageId: 'not-the-anchor' }), (error) => error.code === 'session_handoff_insert_failed');
  env.store.insertMessagesBefore = () => { throw new Error('store exploded'); };
  assert.throws(() => env.admit(), (error) => error.code === 'session_handoff_insert_failed');
  assert.ok(env.logs.some((log) => log.event === 'chat.session_handoff_insert_refused'));
  assert.deepEqual(env.store.getSession(env.id).messages.map((m) => m.id), ['u1']);
});

test('a flush failure removes the row again and fails the turn', (t) => {
  const env = admissionEnv(t);
  env.store.flushSession = () => false;
  assert.throws(() => env.admit(), (error) => error.code === 'session_handoff_unflushed');
  assert.deepEqual(env.store.getSession(env.id).messages.map((m) => m.id), ['u1']);
  env.store.flushSession = () => { throw new Error('disk gone'); };
  assert.throws(() => env.admit(), (error) => error.code === 'session_handoff_unflushed');
  assert.deepEqual(env.store.getSession(env.id).messages.map((m) => m.id), ['u1']);
});

test('not a brand-new turn (resume, edit/failure retry): the earlier attempt row must already be there', (t) => {
  const env = admissionEnv(t);
  assert.throws(() => env.admit({ brandNew: false }), (error) => error.code === 'session_handoff_missing');
  env.admit();
  assert.equal(env.admit({ brandNew: false }).id, `ctxh_${HEX}`);
  assert.throws(() => env.admit({ brandNew: false, handoff: handoff({ body: 'a different background' }) }),
    (error) => error.code === 'session_handoff_missing', 'a row with other content is not the same row');
  assert.equal(env.admit({ brandNew: false, turnId: 'turn_2' }).turn_id, 'turn_1', 'a retry finds the row its earlier attempt placed, under that attempt turn id');
});

test('the admission logs ids only, never the Background', (t) => {
  const env = admissionEnv(t);
  env.store.flushSession = () => false;
  assert.throws(() => env.admit());
  assert.ok(env.logs.length > 0);
  assert.ok(env.logs.every((log) => !JSON.stringify(log).includes(BODY)));
});
