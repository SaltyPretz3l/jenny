'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createSessionMailStore } = require('../services/backend/session-mail-store');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const F = require('./helpers/session-mail-fixtures');

function tempProfile(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mail-store-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function openStore(root) {
  return new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
}

// A store double with the dedicated record writer; `failFlush` models a disk error.
function createFakeStore(initial, { failFlush = false, failWrite = false, newerSchema = false, sessions } = {}) {
  const records = new Map(Object.entries(sessions || { sess_a: initial }));
  const calls = [];
  for (const [key, value] of records) records.set(key, structuredClone(value));
  return {
    calls,
    records,
    peekSession: (id) => records.get(id) || null,
    hasNewerSchema: () => newerSchema,
    _updateSessionRecord(id, patch, options) {
      calls.push({ op: 'update', id, patch: structuredClone(patch), options });
      if (failWrite || !records.has(id)) return null;
      records.set(id, { ...records.get(id), ...structuredClone(patch) });
      return { id };
    },
    flushSession(id) {
      calls.push({ op: 'flush', id });
      return !failFlush;
    },
  };
}

const base = (extra = {}) => ({
  session_incarnation: 'inc_a',
  project_id: 'proj_1',
  coordination_revision: 4,
  session_mail: F.emptyMail(),
  ...extra,
});

test('read reports a missing session and the empty default', () => {
  const store = createSessionMailStore(createFakeStore(base()));
  assert.deepEqual(store.read('sess_missing'), { ok: false, reason: 'not_found' });
  assert.deepEqual(store.read(''), { ok: false, reason: 'not_found' });
  assert.deepEqual(store.read('sess_a'), {
    ok: true, session_incarnation: 'inc_a', project_id: 'proj_1', archived: false, coordination_revision: 4,
    mail: F.emptyMail(), coordination_receipts: [], frozen: false,
  });
  const legacy = createSessionMailStore(createFakeStore({ session_incarnation: 'i', archived_at: '2026-01-01T00:00:00.000Z' })).read('sess_a');
  assert.equal(legacy.archived, true);
  assert.equal(legacy.project_id, null);
  assert.deepEqual(legacy.mail, F.emptyMail());
});

test('mutate writes the container and coordination_revision+1 in ONE update, then flushes', () => {
  const fake = createFakeStore(base());
  const store = createSessionMailStore(fake);
  const inbox = F.makeInbox(1);
  const result = store.mutate('sess_a', ({ mail, session, coordination_revision: revision }) => {
    assert.deepEqual(mail, F.emptyMail());
    assert.deepEqual(session, { id: 'sess_a', session_incarnation: 'inc_a', project_id: 'proj_1', archived: false });
    assert.equal(revision, 4);
    return { mail: { ...mail, inbox: [inbox], next_receive_sequence: 2 } };
  });
  assert.equal(result.ok, true);
  assert.equal(result.revision, 5);
  assert.equal(result.coordination_revision, 5);
  assert.deepEqual(result.mail.inbox, [inbox]);
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.calls[0].op, 'update');
  assert.deepEqual(fake.calls[0].options, { bumpUpdatedAt: false });
  assert.deepEqual(Object.keys(fake.calls[0].patch).sort(), ['coordination_revision', 'session_mail']);
  assert.equal(fake.calls[0].patch.coordination_revision, 5);
  assert.deepEqual(fake.calls[0].patch.session_mail, { ...F.emptyMail(), inbox: [inbox], next_receive_sequence: 2 });
  assert.deepEqual(fake.calls[1], { op: 'flush', id: 'sess_a' });
  const read = store.read('sess_a');
  assert.deepEqual(read.mail.inbox, [inbox]);
  assert.equal(read.coordination_revision, 5);
});

test('mutate hands the callback a deep copy and an abort writes nothing', () => {
  const fake = createFakeStore(base());
  const store = createSessionMailStore(fake);
  store.mutate('sess_a', ({ mail }) => ({ mail: { ...mail, inbox: [F.makeInbox(1)], next_receive_sequence: 2 } }));
  fake.calls.length = 0;
  const result = store.mutate('sess_a', ({ mail }) => {
    mail.inbox[0].envelope.body = 'tampered';
    mail.inbox.length = 0;
    return { abort: { reason: 'busy', retryable: true } };
  });
  assert.deepEqual(result, {
    retryable: true, ok: false, aborted: true, reason: 'busy', abort: { reason: 'busy', retryable: true }, current_revision: 5,
  });
  assert.equal(store.read('sess_a').mail.inbox[0].envelope.body, 'hello 1');
  assert.equal(fake.calls.length, 0, 'abort does not write');
  const bare = store.mutate('sess_a', () => ({ abort: {} }));
  assert.equal(bare.reason, 'aborted');
  assert.equal(bare.retryable, false);
});

test('an unchanged result writes nothing and keeps the revision', () => {
  const fake = createFakeStore(base());
  const store = createSessionMailStore(fake);
  store.mutate('sess_a', ({ mail }) => ({ mail: { ...mail, outbox: [F.makeOutbox(1)] } }));
  fake.calls.length = 0;
  const result = store.mutate('sess_a', ({ mail }) => ({ mail }));
  assert.equal(result.ok, true);
  assert.equal(result.noop, true);
  assert.equal(result.revision, 5);
  assert.equal(fake.calls.length, 0);
});

test('a flush failure rolls back memory with persist:false and reports io_failed at the old revision', () => {
  const fake = createFakeStore(base(), { failFlush: true });
  const store = createSessionMailStore(fake);
  const result = store.mutate('sess_a', ({ mail }) => ({ mail: { ...mail, outbox: [F.makeOutbox(1)] } }));
  assert.deepEqual(result, { ok: false, reason: 'io_failed', retryable: true, current_revision: 4 });
  assert.equal(fake.calls.length, 3);
  assert.deepEqual(fake.calls[2].options, { bumpUpdatedAt: false, persist: false });
  assert.equal(fake.calls[2].patch.coordination_revision, 4);
  assert.deepEqual(fake.calls[2].patch.session_mail, F.emptyMail());
  const read = store.read('sess_a');
  assert.equal(read.coordination_revision, 4);
  assert.deepEqual(read.mail.outbox, []);
});

test('a refused write reports io_failed, or unavailable on a newer-schema store, without a rollback write', () => {
  const add = ({ mail }) => ({ mail: { ...mail, outbox: [F.makeOutbox(1)] } });
  const failing = createFakeStore(base(), { failWrite: true });
  assert.deepEqual(createSessionMailStore(failing).mutate('sess_a', add),
    { ok: false, reason: 'io_failed', retryable: true, current_revision: 4 });
  assert.equal(failing.calls.length, 1);
  const newer = createFakeStore(base(), { newerSchema: true });
  assert.deepEqual(createSessionMailStore(newer).mutate('sess_a', add),
    { ok: false, reason: 'unavailable', retryable: false, current_revision: 4 });
  assert.equal(newer.calls.length, 0);
  const throwing = createFakeStore(base());
  throwing.flushSession = () => { throw new Error('disk'); };
  assert.equal(createSessionMailStore(throwing).mutate('sess_a', add).reason, 'io_failed');
});

test('a frozen future-schema container is readable as empty, never written', () => {
  const future = { schema_version: 2, inbox: [{ anything: true }], extra: 1 };
  const fake = createFakeStore(base({ session_mail: future }));
  const store = createSessionMailStore(fake);
  const read = store.read('sess_a');
  assert.equal(read.frozen, true);
  assert.deepEqual(read.mail, F.emptyMail());
  let called = false;
  const result = store.mutate('sess_a', ({ mail }) => { called = true; return { mail }; });
  assert.deepEqual(result, { ok: false, reason: 'unavailable', retryable: false, current_revision: 4 });
  assert.equal(called, false);
  assert.equal(fake.calls.length, 0);
  assert.deepEqual(fake.records.get('sess_a').session_mail, future);
});

test('unreadable entries are dropped from reads but preserved verbatim on every write', () => {
  const valid = F.makeInbox(1);
  const futureEntry = { envelope: { ...F.makeEnvelope(2), schema_version: 2 }, receipt_id: 'future', keep: { me: true } };
  const duplicate = F.makeInbox(1, { receive_sequence: 9 });
  const junkOutbox = { operation_id: 'not-a-uuid', secret: 1 };
  const junkDiscard = 'string entry';
  const fake = createFakeStore(base({
    session_mail: F.emptyMail({
      inbox: [futureEntry, valid, duplicate],
      outbox: [junkOutbox],
      discarded: [junkDiscard],
      authorizations: [{ schema_version: 9 }],
      admission_snapshots: [null],
      next_receive_sequence: 3,
    }),
  }));
  const store = createSessionMailStore(fake);
  assert.deepEqual(store.read('sess_a').mail.inbox, [valid]);
  assert.deepEqual(store.read('sess_a').mail.outbox, []);
  const result = store.mutate('sess_a', ({ mail }) => ({
    mail: { ...mail, inbox: [...mail.inbox, F.makeInbox(3, { receive_sequence: 3 })], next_receive_sequence: 4 },
  }));
  assert.equal(result.ok, true);
  const stored = fake.records.get('sess_a').session_mail;
  assert.equal(stored.inbox.length, 4);
  assert.deepEqual(stored.inbox.slice(2), [futureEntry, duplicate], 'opaque inbox entries are kept as stored');
  assert.deepEqual(stored.outbox, [junkOutbox]);
  assert.deepEqual(stored.discarded, [junkDiscard]);
  assert.deepEqual(stored.authorizations, [{ schema_version: 9 }]);
  assert.deepEqual(stored.admission_snapshots, [null]);
  assert.equal(stored.next_receive_sequence, 4);
  assert.deepEqual(store.read('sess_a').mail.inbox.map((r) => r.receive_sequence), [1, 3]);
});

test('valid report reservations and the reporting flag round-trip through an unrelated write', () => {
  const reservation = F.makeReservation(1);
  const fake = createFakeStore(base({ session_mail: F.emptyMail({ report_reservations: [reservation], reporting_enabled: true }) }));
  const store = createSessionMailStore(fake);
  assert.deepEqual(store.read('sess_a').mail.report_reservations, [reservation]);
  store.mutate('sess_a', ({ mail }) => ({ mail: { ...mail, outbox: [F.makeOutbox(1)] } }));
  const stored = fake.records.get('sess_a').session_mail;
  assert.deepEqual(stored.report_reservations, [reservation]);
  assert.equal(stored.reporting_enabled, true);
});

test('malformed or duplicate reservations stay opaque: hidden from reads, kept verbatim on writes', () => {
  const valid = F.makeReservation(1);
  const legacyShape = { turn_id: 't', slot_bytes: 8192 };
  const future = { ...F.makeReservation(2), schema_version: 2, keep: { me: true } };
  const duplicate = F.makeReservation(1, { reserved_at: F.iso(9000) });
  const fake = createFakeStore(base({
    session_mail: F.emptyMail({ report_reservations: [legacyShape, valid, future, duplicate, 'junk'], reporting_enabled: true }),
  }));
  const store = createSessionMailStore(fake);
  assert.deepEqual(store.read('sess_a').mail.report_reservations, [valid]);
  const result = store.mutate('sess_a', ({ mail }) => ({
    mail: { ...mail, report_reservations: [...mail.report_reservations, F.makeReservation(3)] },
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.mail.report_reservations, [valid, F.makeReservation(3)]);
  assert.deepEqual(fake.records.get('sess_a').session_mail.report_reservations,
    [valid, F.makeReservation(3), legacyShape, future, duplicate, 'junk']);
  // An unrelated write keeps the opaque entries and the valid ones.
  store.mutate('sess_a', ({ mail }) => ({ mail: { ...mail, outbox: [F.makeOutbox(1)] } }));
  assert.equal(fake.records.get('sess_a').session_mail.report_reservations.length, 6);
});

test('mutate rejects malformed or duplicate reservations from a callback; omitting the list keeps it', () => {
  const reservation = F.makeReservation(1);
  const fake = createFakeStore(base({ session_mail: F.emptyMail({ report_reservations: [reservation] }) }));
  const store = createSessionMailStore(fake);
  const withList = (list) => store.mutate('sess_a', ({ mail }) => ({ mail: { ...mail, report_reservations: list } }));
  assert.equal(withList([{ turn_id: 't', slot_bytes: 8192 }]).reason, 'invalid_record');
  assert.equal(withList([reservation, reservation]).reason, 'invalid_record');
  assert.equal(withList('nope').reason, 'invalid_record');
  const omitted = store.mutate('sess_a', ({ mail }) => {
    const { report_reservations: _omit, ...rest } = mail;
    return { mail: { ...rest, outbox: [F.makeOutbox(1)] } };
  });
  assert.equal(omitted.ok, true);
  assert.deepEqual(fake.records.get('sess_a').session_mail.report_reservations, [reservation]);
  const released = withList([]);
  assert.equal(released.ok, true);
  assert.deepEqual(fake.records.get('sess_a').session_mail.report_reservations, []);
});

test('mutate rejects invalid callback results without writing', () => {
  const fake = createFakeStore(base());
  const store = createSessionMailStore(fake);
  assert.equal(store.mutate('sess_missing', () => ({ mail: F.emptyMail() })).reason, 'not_found');
  assert.equal(store.mutate('sess_a', () => undefined).reason, 'invalid_record');
  assert.equal(store.mutate('sess_a', () => ({ mail: 'x' })).reason, 'invalid_record');
  assert.equal(store.mutate('sess_a', () => ({ mail: { inbox: [] } })).reason, 'invalid_record', 'every list is required');
  const bad = { ...F.makeInbox(1), receive_sequence: 0 };
  assert.equal(store.mutate('sess_a', ({ mail }) => ({ mail: { ...mail, inbox: [bad] } })).reason, 'invalid_record');
  const a = F.makeInbox(1);
  assert.equal(store.mutate('sess_a', ({ mail }) => ({ mail: { ...mail, inbox: [a, a] } })).reason, 'invalid_record', 'duplicate ids refused');
  assert.equal(fake.calls.length, 0);
});

test('next_receive_sequence only moves forward and stays above newly issued sequences', () => {
  const fake = createFakeStore(base({ session_mail: F.emptyMail({ next_receive_sequence: 5 }) }));
  const store = createSessionMailStore(fake);
  const add = (n, sequence) => ({ mail }) => ({ mail: { ...mail, inbox: [...mail.inbox, F.makeInbox(n, { receive_sequence: n })], next_receive_sequence: sequence } });
  assert.equal(store.mutate('sess_a', ({ mail }) => ({ mail: { ...mail, next_receive_sequence: 4 } })).reason, 'invalid_record', 'cannot rewind');
  assert.equal(store.mutate('sess_a', add(5, 5)).reason, 'invalid_record', 'issued 5 requires next >= 6');
  assert.equal(store.mutate('sess_a', add(5, 'x')).reason, 'invalid_record');
  assert.equal(store.mutate('sess_a', add(5, 6)).ok, true);
  assert.equal(store.read('sess_a').mail.next_receive_sequence, 6);
  assert.equal(store.mutate('sess_a', ({ mail }) => ({ mail: { ...mail } })).noop, true, 'omitting the sequence keeps it');
});

test('a revision at the safe-integer ceiling is unavailable', () => {
  const fake = createFakeStore(base({ coordination_revision: Number.MAX_SAFE_INTEGER }));
  const result = createSessionMailStore(fake).mutate('sess_a', ({ mail }) => ({ mail: { ...mail, outbox: [F.makeOutbox(1)] } }));
  assert.equal(result.reason, 'unavailable');
});

test('mutations are synchronous: the callback result is the whole story, no promises accepted', () => {
  const fake = createFakeStore(base());
  const result = createSessionMailStore(fake).mutate('sess_a', () => Promise.resolve({ mail: F.emptyMail() }));
  assert.equal(result.reason, 'invalid_record');
  assert.equal(fake.calls.length, 0);
});

test('real ElectronSessionStore: write is durable, flushed, does not bump recency and survives a reopen', (t) => {
  const root = tempProfile(t);
  const sessions = openStore(root);
  t.after(() => sessions.dispose());
  const created = sessions.createSession({ title: 'Mail' });
  const updatedBefore = sessions.getSession(created.id).updated_at;
  const flushed = [];
  const realFlush = sessions.flushSession.bind(sessions);
  sessions.flushSession = (id) => { flushed.push(id); return realFlush(id); };
  const store = createSessionMailStore(sessions);

  const read = store.read(created.id);
  assert.equal(read.ok, true);
  assert.match(read.session_incarnation, /^inc_/);
  assert.equal(read.coordination_revision, 0);

  const outbox = F.makeOutbox(1);
  const written = store.mutate(created.id, ({ mail }) => ({ mail: { ...mail, outbox: [outbox] } }));
  assert.equal(written.revision, 1);
  const delivered = store.mutate(created.id, ({ mail }) => ({
    mail: {
      ...mail,
      outbox: [{ ...mail.outbox[0], state: 'pending', send_requested_at: F.iso() }],
      inbox: [F.makeInbox(1)],
      next_receive_sequence: 2,
    },
  }));
  assert.equal(delivered.revision, 2);
  assert.deepEqual(flushed, [created.id, created.id]);
  assert.equal(sessions.getSession(created.id).updated_at, updatedBefore);
  assert.equal(sessions.listSessions().find((s) => s.id === created.id).unread_message_count, 1);

  const reopened = openStore(root);
  t.after(() => reopened.dispose());
  const persisted = createSessionMailStore(reopened).read(created.id);
  assert.equal(persisted.coordination_revision, 2);
  assert.equal(persisted.mail.outbox[0].state, 'pending');
  assert.equal(persisted.mail.next_receive_sequence, 2);
  assert.deepEqual(persisted.mail.inbox, [F.makeInbox(1)]);
});

test('real ElectronSessionStore: a failed flush leaves the in-memory record at the old revision', (t) => {
  const sessions = openStore(tempProfile(t));
  t.after(() => sessions.dispose());
  const created = sessions.createSession({ title: 'Rollback' });
  sessions.flushSession = () => false;
  const store = createSessionMailStore(sessions);
  const result = store.mutate(created.id, ({ mail }) => ({ mail: { ...mail, outbox: [F.makeOutbox(1)] } }));
  assert.deepEqual(result, { ok: false, reason: 'io_failed', retryable: true, current_revision: 0 });
  const read = store.read(created.id);
  assert.equal(read.coordination_revision, 0);
  assert.deepEqual(read.mail.outbox, []);
  assert.equal(sessions.getSession(created.id).session_mail.outbox.length, 0);
});

test('real ElectronSessionStore: generic session patches cannot reach session_mail', (t) => {
  const sessions = openStore(tempProfile(t));
  t.after(() => sessions.dispose());
  const created = sessions.createSession({ title: 'Guard' });
  const store = createSessionMailStore(sessions);
  store.mutate(created.id, ({ mail }) => ({ mail: { ...mail, outbox: [F.makeOutbox(1)] } }));
  sessions.updateSession(created.id, { session_mail: F.emptyMail(), coordination_revision: 99 });
  const read = store.read(created.id);
  assert.equal(read.mail.outbox.length, 1);
  assert.equal(read.coordination_revision, 1);
});
