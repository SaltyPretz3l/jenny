'use strict';

// Next-turn inclusion of queued addressed session messages (row 59 checkpoint 4, slice S3).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { createSessionMailStore } = require('../services/backend/session-mail-store');
const {
  ADMISSION_LIMITS, ESTIMATOR_ID, SESSION_MESSAGE_PREAMBLE, admitSessionMailForTurn, estimateSessionMessageTokens,
  reconcileAdmissionSnapshots, releaseAdmission, renderSessionMessageContent, selectAndPublishSessionMail,
} = require('../services/backend/session-mail-admission');
const { buildPreparedMessages } = require('../services/backend/chat-stream-reasoning');
const F = require('./helpers/session-mail-fixtures');

function setup(t, { inbox = [], status = 32768 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-mail-admission-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {} });
  t.after(() => {
    store.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const session = store.createSession({ title: 'Destination' });
  store.appendMessage(session.id, { id: 'a0', role: 'assistant', content: 'earlier answer', turn_id: 'turn_0' });
  store.appendMessage(session.id, { id: 'u1', role: 'user', content: 'the prompt', turn_id: 'turn_1' });
  const mailStore = createSessionMailStore(store);
  const logs = [];
  const notified = [];
  const service = {
    sessionStore: store,
    currentStatus: { effective_context_length: status },
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    chatMessages: { notify: (id) => notified.push(id) },
  };
  const seed = (records) => mailStore.mutate(session.id, ({ mail }) => ({
    mail: {
      ...mail,
      inbox: [...mail.inbox, ...records],
      next_receive_sequence: Math.max(mail.next_receive_sequence, ...records.map((r) => r.receive_sequence + 1)),
    },
  }));
  if (inbox.length) assert.equal(seed(inbox).ok, true);
  const admit = (overrides = {}) => selectAndPublishSessionMail({
    service, sessionId: session.id, turnId: 'turn_1', userMessageId: 'u1', effectiveBudget: 100000, remainingBudget: 100000,
    now: F.iso(5000), supportsMail: () => true, ...overrides,
  });
  const mail = () => mailStore.read(session.id).mail;
  const ids = () => store.getSession(session.id).messages.map((m) => m.id);
  return { store, mailStore, id: session.id, service, logs, notified, seed, admit, mail, ids };
}

const states = (mail) => mail.inbox.map((r) => r.context.state);

test('queued mail is frozen FIFO, published before the anchor, then marked included', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1), F.makeInbox(2)] });
  const result = env.admit();
  assert.equal(result.published, true);
  assert.deepEqual(result.rows.map((r) => r.id), [`ctx_${F.uuid(1)}`, `ctx_${F.uuid(2)}`]);
  assert.deepEqual(env.ids(), ['a0', `ctx_${F.uuid(1)}`, `ctx_${F.uuid(2)}`, 'u1']);
  const messages = env.store.getSession(env.id).messages;
  assert.equal(messages[1].role, 'context');
  assert.equal(messages[1].turn_id, 'turn_1');
  assert.equal(messages[1].content, 'hello 1');
  assert.equal(messages[3].content, 'the prompt');

  const mail = env.mail();
  assert.deepEqual(states(mail), ['included', 'included']);
  assert.equal(mail.inbox[0].context.canonical_message_id, `ctx_${F.uuid(1)}`);
  assert.equal(mail.inbox[0].context.turn_id, 'turn_1');
  assert.equal(mail.inbox[0].context.included_at, F.iso(5000));
  assert.equal(mail.admission_snapshots.length, 1);
  const snapshot = mail.admission_snapshots[0];
  assert.equal(snapshot.state, 'published');
  assert.equal(snapshot.estimator_id, ESTIMATOR_ID);
  assert.equal(ESTIMATOR_ID, 'js_chars4_msg4_session_message_v1');
  assert.equal(snapshot.turn_id, 'turn_1');
  assert.equal(snapshot.cutoff_receive_sequence, 2);
  assert.equal(snapshot.deferred_count, 0);
  assert.equal(snapshot.deferred_reason, null);
  assert.deepEqual(snapshot.entries.map((e) => e.message_id), [F.uuid(1), F.uuid(2)]);
  assert.equal(snapshot.entries[0].body_sha256, mail.inbox[0].envelope.body_sha256);
  assert.deepEqual(result.snapshot, snapshot);
  assert.equal(env.notified.length, 2, 'one refresh after the reserve write and one after the include write');
  assert.ok(env.notified.every((id) => id === env.id));
  assert.equal(env.logs.length, 0);
});

test('the rendered rows reach the provider history as context rows only when negotiated', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  env.admit();
  const history = env.store.getSession(env.id).messages.filter((m) => m.id !== 'u1');
  const wire = buildPreparedMessages(history, 'the prompt', { contextPreferences: { history_scope: 'session' }, sessionMessages: true });
  assert.deepEqual(wire.map((m) => m.role), ['assistant', 'context', 'user']);
  assert.equal(wire[1].session_message.message_id, F.uuid(1));
  const dropped = buildPreparedMessages(history, 'the prompt', { contextPreferences: { history_scope: 'session' }, sessionMessages: false });
  assert.deepEqual(dropped.map((m) => m.role), ['assistant', 'user']);
});

test('no negotiated capability: nothing is admitted, nothing is written', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  const before = env.mail();
  const result = env.admit({ supportsMail: () => false });
  assert.deepEqual({ ...result }, { published: false, rows: [], snapshot: null });
  assert.deepEqual(env.mail(), before);
  assert.deepEqual(env.ids(), ['a0', 'u1']);
  // The default reads the managed client's negotiated state; an unnegotiated client admits nothing either.
  const viaClient = selectAndPublishSessionMail({
    service: { ...env.service, sidecarClient: { process: { pid: 1 } } }, sessionId: env.id, turnId: 'turn_1', userMessageId: 'u1',
    effectiveBudget: 100000, remainingBudget: 100000,
  });
  assert.equal(viaClient.published, false);
  assert.deepEqual(states(env.mail()), ['queued']);
  assert.equal(env.notified.length, 0);
});

test('nothing queued writes no snapshot and no revision', (t) => {
  const env = setup(t);
  const revision = env.mailStore.read(env.id).coordination_revision;
  assert.equal(env.admit().published, false);
  assert.equal(env.mailStore.read(env.id).coordination_revision, revision);
  assert.deepEqual(env.mail().admission_snapshots, []);
  env.seed([F.makeInbox(1, { context: { state: 'excluded_by_user', changed_at: F.iso() } })]);
  const afterSeed = env.mailStore.read(env.id).coordination_revision;
  assert.equal(env.admit().published, false, 'excluded records are never selected');
  assert.equal(env.mailStore.read(env.id).coordination_revision, afterSeed);
  assert.deepEqual(env.ids(), ['a0', 'u1']);
});

test('at most 16 messages per turn; the rest wait without a deferral reason', (t) => {
  const records = Array.from({ length: 20 }, (_, i) => F.makeInbox(i + 1));
  const env = setup(t, { inbox: records });
  const result = env.admit();
  assert.equal(ADMISSION_LIMITS.max_messages, 16);
  assert.equal(result.rows.length, 16);
  const mail = env.mail();
  assert.equal(mail.inbox.filter((r) => r.context.state === 'included').length, 16);
  assert.deepEqual(mail.inbox.slice(16).map((r) => r.context.state), ['queued', 'queued', 'queued', 'queued']);
  assert.equal(mail.admission_snapshots[0].deferred_count, 4);
  assert.equal(mail.admission_snapshots[0].deferred_reason, null);
});

test('serialized envelopes are capped at 32 KiB per turn', (t) => {
  const big = 'x'.repeat(15000);
  const env = setup(t, { inbox: [1, 2, 3].map((n) => F.makeInbox(n, {}, { body: `${big}${n}` })) });
  const result = env.admit();
  assert.equal(ADMISSION_LIMITS.max_envelope_bytes, 32768);
  assert.equal(result.rows.length, 2, 'two envelopes fit under 32 KiB, the third waits');
  assert.deepEqual(states(env.mail()), ['included', 'included', 'queued']);
  assert.equal(env.mail().admission_snapshots[0].deferred_count, 1);
});

test('the head that does not fit stops selection: no skipping, truncating or reordering', (t) => {
  const small = (n) => F.makeInbox(n, {}, { body: `small ${n}` });
  const huge = F.makeInbox(2, {}, { body: 'y'.repeat(6000) });
  const env = setup(t, { inbox: [small(1), huge, small(3)] });
  const cost = (record) => estimateSessionMessageTokens(record.envelope);
  const remaining = cost(small(1)) + cost(small(3)) + 5; // room for both small ones, not the huge head
  const result = env.admit({ remainingBudget: remaining });
  assert.deepEqual(result.rows.map((r) => r.id), [`ctx_${F.uuid(1)}`], 'only the head before the oversized message');
  assert.deepEqual(states(env.mail()), ['included', 'queued', 'queued']);
  const snapshot = env.mail().admission_snapshots[0];
  assert.equal(snapshot.deferred_reason, 'context_budget');
  assert.equal(snapshot.deferred_count, 2);
});

test('the token cap is min(8192, 10% of the effective budget, remaining)', (t) => {
  const records = [1, 2, 3].map((n) => F.makeInbox(n));
  const cost = estimateSessionMessageTokens(records[0].envelope);
  assert.equal(cost, 150);
  // 10% of 4000 = 400 tokens: two messages (300) fit, a third (450) does not.
  const env = setup(t, { inbox: records });
  const result = env.admit({ effectiveBudget: 4000, remainingBudget: 100000 });
  assert.equal(result.rows.length, 2);
  assert.equal(env.mail().admission_snapshots[0].deferred_reason, 'context_budget');
  // The 8192 cap binds on a huge window: 60 messages could not all fit but the cap is not the count.
  const wide = setup(t, { inbox: Array.from({ length: 16 }, (_, i) => F.makeInbox(i + 1, {}, { body: 'z'.repeat(1500) })) });
  const big = wide.admit({ effectiveBudget: 10_000_000, remainingBudget: 10_000_000 });
  const perMessage = estimateSessionMessageTokens(wide.mail().inbox[0].envelope);
  assert.equal(big.rows.length, Math.min(16, Math.floor(8192 / perMessage)));
});

test('remaining budget zero admits nothing and records the deferral', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  const result = env.admit({ remainingBudget: 0 });
  assert.equal(result.published, false);
  assert.equal(result.snapshot.state, 'published');
  assert.deepEqual(result.snapshot.entries, []);
  assert.equal(result.snapshot.deferred_reason, 'context_budget');
  assert.equal(result.snapshot.deferred_count, 1);
  assert.deepEqual(states(env.mail()), ['queued']);
  assert.deepEqual(env.ids(), ['a0', 'u1']);
});

test('unknown capacity admits no mail and records budget_unknown', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  const result = env.admit({ effectiveBudget: null, remainingBudget: undefined });
  assert.equal(result.published, false);
  assert.equal(result.snapshot.deferred_reason, 'budget_unknown');
  assert.deepEqual(result.snapshot.entries, []);
  assert.deepEqual(states(env.mail()), ['queued']);
  // The hook derives the budget from the live engine status; an unknown window is the same outcome.
  const hooked = setup(t, { inbox: [F.makeInbox(1)], status: 0 });
  const viaHook = admitSessionMailForTurn({
    service: hooked.service, sessionId: hooked.id, turnId: 'turn_1', userMessageId: 'u1', preparedMessages: [], supportsMail: () => true,
  });
  assert.equal(viaHook.snapshot.deferred_reason, 'budget_unknown');
});

test('the hook derives the remaining budget from the mandatory prompt and the engine window', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)], status: 32768 });
  const result = admitSessionMailForTurn({
    service: env.service, sessionId: env.id, turnId: 'turn_1', userMessageId: 'u1',
    preparedMessages: [{ role: 'user', content: 'short prompt' }], supportsMail: () => true, now: F.iso(),
  });
  assert.equal(result.published, true);
  const crowded = setup(t, { inbox: [F.makeInbox(1)], status: 32768 });
  const refused = admitSessionMailForTurn({
    service: crowded.service, sessionId: crowded.id, turnId: 'turn_1', userMessageId: 'u1',
    preparedMessages: [{ role: 'user', content: 'x'.repeat(4 * 30000) }], supportsMail: () => true,
  });
  assert.equal(refused.published, false, 'the mandatory prompt is never evicted to make room');
  assert.equal(refused.snapshot.deferred_reason, 'context_budget');
});

test('a delivery after the cutoff waits for a later turn even if it would fit', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  assert.equal(env.admit().rows.length, 1);
  env.seed([F.makeInbox(2)]);
  assert.equal(env.mail().admission_snapshots[0].cutoff_receive_sequence, 1);
  assert.deepEqual(states(env.mail()), ['included', 'queued']);
  // The next turn has its own user anchor; only then is message 2 selected.
  env.store.appendMessage(env.id, { id: 'a1', role: 'assistant', content: 'answer', turn_id: 'turn_1' });
  env.store.appendMessage(env.id, { id: 'u2', role: 'user', content: 'second prompt', turn_id: 'turn_2' });
  const second = env.admit({ turnId: 'turn_2', userMessageId: 'u2' });
  assert.deepEqual(second.rows.map((r) => r.id), [`ctx_${F.uuid(2)}`]);
  assert.equal(second.rows[0].turn_id, 'turn_2');
  assert.deepEqual(env.ids().slice(-3), ['a1', `ctx_${F.uuid(2)}`, 'u2']);
});

test('a refused publish releases the reservation: the mail stays queued and no snapshot survives', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1), F.makeInbox(2)] });
  const result = env.admit({ userMessageId: 'a0' }); // not the last user anchor: the store refuses the insert
  assert.equal(result.published, false);
  assert.deepEqual(states(env.mail()), ['queued', 'queued']);
  assert.deepEqual(env.mail().admission_snapshots, []);
  assert.deepEqual(env.ids(), ['a0', 'u1']);
  assert.ok(env.logs.some((l) => l.event === 'chat.session_mail_admission_failed' && l.details.code === 'insert_refused'));
  assert.ok(env.logs.every((l) => !JSON.stringify(l.details).includes('hello')), 'bodies are never logged');
  // A retry then succeeds against the right anchor.
  assert.equal(env.admit().rows.length, 2);
});

test('a throwing insert releases the reservation and never fails the turn', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  env.store.insertMessagesBefore = () => { throw new Error('disk exploded'); };
  const result = env.admit();
  assert.equal(result.published, false);
  assert.deepEqual(states(env.mail()), ['queued']);
  assert.deepEqual(env.mail().admission_snapshots, []);
});

test('a failed reserve write leaves nothing behind', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  const realFlush = env.store.flushSession.bind(env.store);
  env.store.flushSession = () => false;
  const result = env.admit();
  assert.equal(result.published, false);
  env.store.flushSession = realFlush;
  assert.deepEqual(states(env.mail()), ['queued']);
  assert.deepEqual(env.ids(), ['a0', 'u1']);
});

test('a finalize that cannot flush leaves a reserved snapshot the next admission heals', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  const realFlush = env.store.flushSession.bind(env.store);
  let flushes = 0;
  env.store.flushSession = (id) => {
    flushes += 1;
    return flushes === 3 ? false : realFlush(id); // reserve, insert, then the finalize write fails
  };
  const result = env.admit();
  assert.equal(result.published, true, 'the rows are in the transcript, so the turn still uses them');
  assert.equal(result.rows.length, 1);
  assert.deepEqual(states(env.mail()), ['reserved']);
  assert.equal(env.mail().admission_snapshots[0].state, 'reserved');
  env.store.flushSession = realFlush;
  assert.deepEqual(reconcileAdmissionSnapshots({ sessionStore: env.store, sessionId: env.id, now: F.iso(9000) }),
    { finalized: 1, released: 0 });
  const mail = env.mail();
  assert.deepEqual(states(mail), ['included']);
  assert.equal(mail.inbox[0].context.canonical_message_id, `ctx_${F.uuid(1)}`);
  assert.equal(mail.admission_snapshots[0].state, 'published');
  assert.deepEqual(env.ids(), ['a0', `ctx_${F.uuid(1)}`, 'u1']);
});

test('rows that do not flush are removed and the reservation released: the turn runs without mail', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  const realFlush = env.store.flushSession.bind(env.store);
  let flushes = 0;
  env.store.flushSession = (id) => {
    flushes += 1;
    return flushes === 2 ? false : realFlush(id);
  };
  const result = env.admit();
  assert.equal(result.published, false);
  assert.deepEqual(result.rows, []);
  assert.deepEqual(states(env.mail()), ['queued']);
  assert.deepEqual(env.ids(), ['a0', 'u1'], 'the unflushed rows are gone from the transcript');
  assert.ok(env.logs.some((l) => l.event === 'chat.session_mail_publish_unflushed'));
});

test('an established chat whose history exceeds the window still admits mail (history is trimmed, not mandatory)', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  const history = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(5000) }));
  const result = env.admit({ preparedMessages: [...history, { role: 'user', content: 'next' }], effectiveBudget: 24576, remainingBudget: undefined });
  assert.equal(result.published, true);
  assert.deepEqual(states(env.mail()), ['included']);
});

test('restart reconcile: a crash after the reserve write (rows absent) releases to queued and drops the snapshot', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1), F.makeInbox(2)] });
  const snapshotId = F.uuid(6001);
  env.mailStore.mutate(env.id, ({ mail }) => ({
    mail: {
      ...mail,
      inbox: mail.inbox.map((r) => (r.receive_sequence === 1
        ? { ...r, context: { state: 'reserved', turn_id: 'turn_1', snapshot_id: snapshotId } } : r)),
      admission_snapshots: [F.makeSnapshot(1, {
        snapshot_id: snapshotId, turn_id: 'turn_1', state: 'reserved', entries: [{ message_id: F.uuid(1), body_sha256: mail.inbox[0].envelope.body_sha256 }],
      })],
    },
  }));
  assert.deepEqual(reconcileAdmissionSnapshots({ sessionStore: env.store, sessionId: env.id }), { finalized: 0, released: 1 });
  assert.deepEqual(states(env.mail()), ['queued', 'queued']);
  assert.deepEqual(env.mail().admission_snapshots, []);
  assert.deepEqual(env.ids(), ['a0', 'u1']);
  assert.deepEqual(reconcileAdmissionSnapshots({ sessionStore: env.store, sessionId: env.id }), { finalized: 0, released: 0 }, 'idempotent');
});

test('restart reconcile: a crash after the insert (rows present) finalizes included with the canonical ids', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  const snapshotId = F.uuid(6001);
  const envelope = env.mail().inbox[0].envelope;
  env.mailStore.mutate(env.id, ({ mail }) => ({
    mail: {
      ...mail,
      inbox: mail.inbox.map((r) => ({ ...r, context: { state: 'reserved', turn_id: 'turn_1', snapshot_id: snapshotId } })),
      admission_snapshots: [F.makeSnapshot(1, {
        snapshot_id: snapshotId, turn_id: 'turn_1', state: 'reserved', entries: [{ message_id: envelope.message_id, body_sha256: envelope.body_sha256 }],
      })],
    },
  }));
  const { buildIncludedRow } = require('../services/backend/session-message-envelope');
  assert.ok(env.store.insertMessagesBefore(env.id, 'u1', [buildIncludedRow(envelope, { turn_id: 'turn_1', timestamp: F.iso(123) })]));
  assert.deepEqual(reconcileAdmissionSnapshots({ sessionStore: env.store, sessionId: env.id, now: F.iso(9999) }), { finalized: 1, released: 0 });
  const record = env.mail().inbox[0];
  assert.equal(record.context.state, 'included');
  assert.equal(record.context.included_at, F.iso(123), 'the row timestamp is the inclusion time');
  assert.equal(env.mail().admission_snapshots[0].state, 'published');
});

test('a row stamped with a different turn is not proof of inclusion', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  const snapshotId = F.uuid(6001);
  const envelope = env.mail().inbox[0].envelope;
  env.mailStore.mutate(env.id, ({ mail }) => ({
    mail: {
      ...mail,
      inbox: mail.inbox.map((r) => ({ ...r, context: { state: 'reserved', turn_id: 'turn_9', snapshot_id: snapshotId } })),
      admission_snapshots: [F.makeSnapshot(1, { snapshot_id: snapshotId, turn_id: 'turn_9', state: 'reserved', entries: [{ message_id: envelope.message_id, body_sha256: envelope.body_sha256 }] })],
    },
  }));
  const { buildIncludedRow } = require('../services/backend/session-message-envelope');
  env.store.insertMessagesBefore(env.id, 'u1', [buildIncludedRow(envelope, { turn_id: 'turn_1' })]);
  assert.deepEqual(reconcileAdmissionSnapshots({ sessionStore: env.store, sessionId: env.id }), { finalized: 0, released: 1 });
});

test('releaseAdmission only touches a reserved snapshot', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  env.admit();
  const published = env.mail().admission_snapshots[0];
  assert.deepEqual(releaseAdmission({ sessionStore: env.store, sessionId: env.id, snapshotId: published.snapshot_id }), { ok: false, released: 0 });
  assert.deepEqual(states(env.mail()), ['included']);
  assert.deepEqual(releaseAdmission({ sessionStore: env.store, sessionId: env.id, snapshotId: F.uuid(7777) }), { ok: false, released: 0 });
  assert.deepEqual(releaseAdmission({}), { ok: false, released: 0 });
});

test('reconcile with nothing reserved or an unknown session is a no-op', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  assert.deepEqual(reconcileAdmissionSnapshots({ sessionStore: env.store, sessionId: env.id }), { finalized: 0, released: 0 });
  assert.deepEqual(reconcileAdmissionSnapshots({ sessionStore: env.store, sessionId: 'sess_missing' }), { finalized: 0, released: 0 });
  assert.deepEqual(reconcileAdmissionSnapshots({}), { finalized: 0, released: 0 });
});

test('published snapshots are retained at most 64', (t) => {
  const env = setup(t);
  env.mailStore.mutate(env.id, ({ mail }) => ({
    mail: { ...mail, admission_snapshots: Array.from({ length: 64 }, (_, i) => F.makeSnapshot(i + 1, { created_at: F.iso(-1000 - i) })) },
  }));
  env.seed([F.makeInbox(1)]);
  env.admit();
  const snapshots = env.mail().admission_snapshots;
  assert.equal(snapshots.length, 64);
  assert.ok(snapshots.some((s) => s.turn_id === 'turn_1' && s.created_at === F.iso(5000)), 'the newest snapshot is kept');
});

test('the retry/edit and resume paths re-use rows instead of re-admitting (rows already before the anchor)', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  env.admit();
  const after = env.ids();
  // Failure-retry re-anchors the same user row: the rows before it survive and no new mail is selected.
  env.store.truncateAfterMessage(env.id, 'u1', { replaceMessageContent: 'the prompt', replaceMessageTurnId: 'turn_1b', preserveActiveTurn: true });
  assert.deepEqual(env.ids(), after);
  assert.deepEqual(states(env.mail()), ['included']);
});

// 2026-10-27: a failure retry keeps its failed attempt after the anchor, so its mail goes after that
// superseded tail at fresh seqs; once the retried turn has rows of its own, nothing is placed.
test('a failure retry places mail after the superseded attempt, in seq order, and never inside its own turn', (t) => {
  const env = setup(t, { inbox: [F.makeInbox(1)] });
  env.store.appendMessage(env.id, { id: 'a1', role: 'assistant', content: '', turn_id: 'turn_1', error_code: 'CMP-AI-0002' });
  env.store.truncateAfterMessage(env.id, 'u1', {
    replaceMessageContent: 'the prompt', replaceMessageTurnId: 'turn_1b', preserveActiveTurn: true, preserveSupersededTurn: true,
  });
  assert.equal(env.admit({ turnId: 'turn_1b' }).published, true);
  const messages = env.store.getSession(env.id).messages;
  assert.deepEqual(messages.map((m) => m.id), ['a0', 'u1', 'a1', `ctx_${F.uuid(1)}`]);
  assert.equal(messages.at(-1).turn_id, 'turn_1b');
  const seqs = messages.map((m) => m.event_seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'array order and seq order agree');
  assert.deepEqual(states(env.mail()), ['included']);

  env.store.appendMessage(env.id, { id: 'a1b', role: 'assistant', content: 'retry answer', turn_id: 'turn_1b' });
  env.seed([F.makeInbox(2)]);
  assert.equal(env.admit({ turnId: 'turn_1b' }).published, false);
  assert.deepEqual(states(env.mail()), ['included', 'queued'], 'the retried turn already answered: the mail waits');
  assert.ok(env.logs.some((l) => l.event === 'chat.session_mail_admission_failed' && l.details.code === 'insert_refused'));
});

test('admission never throws for a hostile service or session', () => {
  const service = { _emitServiceLog() { throw new Error('logger down'); } };
  assert.doesNotThrow(() => selectAndPublishSessionMail({ service, sessionId: 's', turnId: 't', userMessageId: 'u', supportsMail: () => { throw new Error('boom'); } }));
  assert.equal(selectAndPublishSessionMail({ service, sessionId: 's', turnId: 't', userMessageId: 'u', supportsMail: () => { throw new Error('boom'); } }).published, false);
  assert.equal(admitSessionMailForTurn({ service: null }).published, false);
  assert.equal(admitSessionMailForTurn({
    service: { sessionTurnActors: { guard: () => null } }, lease: {}, sessionId: 's', turnId: 't', userMessageId: 'u', supportsMail: () => true,
  }).published, false, 'a lease that is no longer current drops the admission');
});

test('estimator parity: the rendered length twin matches the sidecar rendering', () => {
  // Lengths of render_session_message_content() for these fixtures (computed with the Python module).
  const cases = [
    ['hi', 579, 149],
    ['h\u00e9llo', 582, 150],
    ['face \u{1F600} ok', 586, 151],
    ['\u65e5\u672c\u8a9e', 580, 149],
    ['a"b\\c\nd\te\rf', 593, 153],
    ['x\u2028y', 585, 151], // a line separator stays escaped (6 characters)
  ];
  cases.forEach(([body, length, tokens], index) => {
    const envelope = F.makeEnvelope(index + 1, { body });
    const rendered = renderSessionMessageContent(envelope);
    assert.equal([...rendered].length, length, JSON.stringify(body)); // Python str length: code points
    assert.equal(estimateSessionMessageTokens(envelope), tokens, JSON.stringify(body));
    assert.equal(tokens, Math.ceil(length / 4) + 4);
    assert.ok(rendered.startsWith(`${SESSION_MESSAGE_PREAMBLE}\n{"session_message":{"body":`), 'sorted keys, body first');
  });
  // Bidi and zero-width characters stay escaped; an emoji is one code point, rendered as itself.
  const mixed = renderSessionMessageContent(F.makeEnvelope(1, { body: '\u{1F600}\u202ex\u200b' }));
  assert.ok(mixed.includes('\u{1F600}\\u202ex\\u200b'));
  const projection = JSON.parse(renderSessionMessageContent(F.makeEnvelope(1)).split('\n')[1]).session_message;
  assert.deepEqual(Object.keys(projection), ['body', 'created_at', 'kind', 'message_id', 'report', 'schema_version',
    'source_project_id', 'source_session_id']);
});

test('the JS preamble is byte-identical to the sidecar constant', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'ai', 'context', 'session_messages.py'), 'utf8');
  const match = /^SESSION_MESSAGE_PREAMBLE = "((?:[^"\\\n]|\\.)*)"/m.exec(source);
  assert.ok(match, 'the Python constant is a single-line string literal');
  assert.ok(!match[1].includes('\\'), 'no escapes to interpret: the literal is plain ASCII');
  assert.equal(match[1], SESSION_MESSAGE_PREAMBLE);
  assert.ok(/^[\x20-\x7e]+$/.test(SESSION_MESSAGE_PREAMBLE));
});
