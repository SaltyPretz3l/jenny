'use strict';

// The turn side of a linked child's terminal report (row 59 checkpoint 5b-1, slice B2):
// the pre-inference reservation inside the turn guard, and the settle-time marker/conversion
// hand-off. Real session store and mail store, fake service; the end-to-end flow is in
// linked-child-reporting-integration.test.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { createSessionMailStore } = require('../services/backend/session-mail-store');
const { createChatProposalStore } = require('../services/backend/chat-proposal-store');
const { MESSAGE_ERROR_CODES } = require('../services/backend/error-codes');
const { reportMessageId } = require('../services/backend/session-report-records');
const {
  admitReportReservation, finishTerminalReport, prepareTerminalReport, proposalTitleFor,
} = require('../services/backend/session-report-admission');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');
const F = require('./helpers/session-mail-fixtures');
const { makeGit } = require('./helpers/chat-proposal-records-fixture');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const CHILD = 'sess_child';
const PARENT = 'sess_parent';

function setup(t, { reporting = true, linked = true, parent = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-report-admission-'));
  trackDirectory(dir);
  const store = new ElectronSessionStore(path.join(dir, 'sessions.json'));
  t.after(() => store.dispose());
  store.createSessionWithId(PARENT, { title: 'Parent' });
  const parentIncarnation = store.getSession(PARENT).session_incarnation;
  store.createSessionWithId(CHILD, {
    title: 'Child',
    ...(linked ? { spawnedFrom: F.makeSpawnedFrom({ parent_session_id: PARENT, parent_session_incarnation: parentIncarnation }) } : {}),
  });
  const mail = createSessionMailStore(store);
  assert.ok(mail.mutate(CHILD, ({ mail: current }) => ({ mail: { ...current, reporting_enabled: reporting } })).ok);
  if (!parent) store.deleteSession(PARENT);
  const logs = [];
  const notified = [];
  const service = {
    sessionStore: store,
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    chatMessages: { notify: (id) => notified.push(id), convertReport: async () => ({ ok: true }) },
  };
  return { store, mail, service, logs, notified, parentIncarnation, read: () => mail.read(CHILD).mail };
}

// ---------- admitReportReservation ----------

test('reserves one slot for a new turn of a linked child, publishes the change, and is idempotent by turn id', (t) => {
  const env = setup(t);
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  const [reservation] = env.read().report_reservations;
  assert.equal(reservation.turn_id, 'turn_1');
  assert.equal(reservation.slot_bytes, 8192);
  assert.equal(reservation.parent_session_id, PARENT);
  assert.equal(reservation.parent_session_incarnation, env.parentIncarnation);
  assert.equal(reservation.reporting_consent_id, F.makeSpawnedFrom().reporting_consent_id);
  assert.deepEqual(env.notified, [CHILD]);
  const revision = env.store.getSession(CHILD).coordination_revision;
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  assert.equal(env.read().report_reservations.length, 1);
  assert.equal(env.store.getSession(CHILD).coordination_revision, revision, 'the replay writes nothing');
  assert.deepEqual(env.notified, [CHILD], 'and publishes nothing');
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_2' });
  assert.equal(env.read().report_reservations.length, 2);
});

test('writes nothing for an unlinked chat, reporting off, a handoff preparation turn or a checkpoint resume', (t) => {
  const cases = [
    ['unlinked', { linked: false }, {}],
    ['reporting off', { reporting: false }, {}],
    ['handoff preparation', {}, { handoffPreparation: { proposal_id: 'p', attempt_id: 'a' } }],
    ['checkpoint resume', {}, { resumed: true }],
  ];
  for (const [name, options, extra] of cases) {
    const env = setup(t, options);
    const before = JSON.stringify(env.store.getSession(CHILD).session_mail);
    const revision = env.store.getSession(CHILD).coordination_revision;
    admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1', ...extra });
    assert.equal(JSON.stringify(env.store.getSession(CHILD).session_mail), before, name);
    assert.equal(env.store.getSession(CHILD).coordination_revision, revision, name);
    assert.deepEqual(env.notified, [], name);
  }
});

test('a service with no messaging service (hosted) reserves nothing', (t) => {
  const env = setup(t);
  const hosted = { sessionStore: env.store, _emitServiceLog() {} };
  assert.equal(admitReportReservation(hosted, { sessionId: CHILD, turnId: 'turn_1' }), undefined);
  assert.equal(env.read().report_reservations.length, 0);
});

test('a service with no usable session store, or a chat the store does not know, is a no-op', () => {
  assert.equal(admitReportReservation({}, { sessionId: CHILD, turnId: 't' }), undefined);
  assert.equal(admitReportReservation({ sessionStore: { getSession: () => null } }, { sessionId: CHILD, turnId: 't' }), undefined);
  assert.equal(admitReportReservation(undefined, { sessionId: CHILD, turnId: 't' }), undefined);
});

test('a full outbox refuses the turn with the coded, non-retryable, user-visible report_backpressure error', (t) => {
  const env = setup(t);
  const filler = Array.from({ length: 128 }, (_, i) => F.makeOutbox(i + 1));
  assert.ok(env.mail.mutate(CHILD, ({ mail }) => ({ mail: { ...mail, outbox: filler } })).ok);
  assert.throws(() => admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' }), (error) => {
    assert.equal(error.code, MESSAGE_ERROR_CODES.SENDER_BACKPRESSURE);
    assert.equal(error.reason, 'report_backpressure');
    assert.equal(error.retryable, false);
    assert.equal(error.user_visible, true);
    return true;
  });
  assert.equal(env.read().report_reservations.length, 0);
});

test('counts reservations as outbox records: 127 undelivered plus one reservation is full for the next turn', (t) => {
  const env = setup(t);
  const filler = Array.from({ length: 127 }, (_, i) => F.makeOutbox(i + 1));
  assert.ok(env.mail.mutate(CHILD, ({ mail }) => ({ mail: { ...mail, outbox: filler } })).ok);
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  assert.equal(env.read().report_reservations.length, 1);
  assert.throws(() => admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_2' }), (error) => error.reason === 'report_backpressure');
});

test('a deleted parent disables reporting in the same mutation and the turn proceeds', (t) => {
  const env = setup(t, { parent: false });
  assert.equal(admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' }), undefined);
  assert.equal(env.read().reporting_enabled, false);
  assert.equal(env.read().report_reservations.length, 0);
});

test('an archived parent still reserves (delivery fails visibly later)', (t) => {
  const env = setup(t);
  env.store.setSessionMeta(PARENT, { archived_at: new Date().toISOString() });
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  assert.equal(env.read().report_reservations.length, 1);
});

test('the reservation runs inside the turn guard; a dropped turn throws a cancellation and reserves nothing', (t) => {
  const env = setup(t);
  const sites = [];
  const passing = { ...env.service, sessionTurnActors: { guard: (_lease, site, run) => { sites.push(site); return run(); } } };
  admitReportReservation(passing, { sessionId: CHILD, turnId: 'turn_1', lease: {} });
  assert.deepEqual(sites, ['managed.session_report_reservation']);
  assert.equal(env.read().report_reservations.length, 1);
  const dropping = { ...env.service, sessionTurnActors: { guard: () => null } };
  assert.throws(() => admitReportReservation(dropping, { sessionId: CHILD, turnId: 'turn_2', lease: {} }),
    (error) => error.name === 'AbortError' && error.cancel_reason === 'session_delete');
  assert.equal(env.read().report_reservations.length, 1, 'the dropped turn did not reserve');
});

test('a persistence failure refuses the turn with a retryable coded error; the reservation is not kept', (t) => {
  const env = setup(t);
  env.store.flushSession = () => false;
  assert.throws(() => admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' }), (error) => {
    assert.equal(error.code, MESSAGE_ERROR_CODES.PERSISTENCE_FAILURE);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(env.read().report_reservations.length, 0);
});

test('a frozen (future-schema) mail container never blocks the turn', (t) => {
  const env = setup(t);
  env.store._updateSessionRecord(CHILD, { session_mail: { schema_version: 2 } }, { bumpUpdatedAt: false, persist: false });
  assert.equal(admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' }), undefined);
  assert.equal(env.logs.length, 0, 'a frozen container is skipped silently: nothing to reserve into');
  assert.deepEqual(env.notified, []);
});

test('admission logs carry ids and reason tokens only', (t) => {
  const env = setup(t);
  env.store.hasNewerSchema = () => true; // the whole store is read-only: mutate answers unavailable and the turn proceeds
  assert.equal(admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' }), undefined);
  assert.equal(env.read().report_reservations.length, 0);
  assert.equal(env.logs.length, 1);
  assert.equal(env.logs[0].event, 'chat.session_report_reservation_skipped');
  for (const entry of env.logs) assert.deepEqual(Object.keys(entry.details).sort(), ['reason', 'sessionId', 'turnId']);
});

// ---------- prepareTerminalReport / finishTerminalReport ----------

function settleCtx(env, overrides = {}) {
  const messages = overrides.messages || [{ id: 'assistant_s1', role: 'assistant', content: 'Final answer.' }];
  return {
    ctx: {
      service: env.service,
      assistantText: 'Final answer.',
      completion: null,
      turnLease: { identity: { sessionId: CHILD, sessionIncarnation: 'inc', turnId: 'turn_1', streamId: 's1', userMessageId: 'user_s1' } },
      ...overrides.ctx,
    },
    mutation: { messages },
  };
}

test('prepare finds the reservation, derives the outcome/body and stamps the marker on the last assistant row', (t) => {
  const env = setup(t);
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  const { ctx, mutation } = settleCtx(env, { messages: [
    { id: 'assistant_s1_seg0', role: 'assistant', content: 'a' }, { id: 'assistant_s1_seg1', role: 'assistant', content: 'b' },
  ] });
  const report = prepareTerminalReport(ctx, { kind: 'complete', mutation, rendererPayload: {} });
  const id = reportMessageId(CHILD, env.store.getSession(CHILD).session_incarnation, 'turn_1');
  assert.equal(report.messageId, id);
  assert.equal(report.outcome, 'completed');
  assert.equal(report.body, 'Final answer.');
  assert.equal(report.anchor, false);
  assert.equal(mutation.messages[1].terminal_report_message_id, id);
  assert.equal('terminal_report_message_id' in mutation.messages[0], false);
});

test('prepare maps raw terminal statuses, completion reasons and cancel reasons', (t) => {
  const env = setup(t);
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  const outcome = (kind, ctxExtra = {}, rendererPayload = {}) => {
    const { ctx, mutation } = settleCtx(env, { ctx: ctxExtra });
    return prepareTerminalReport(ctx, { kind, mutation, rendererPayload })?.outcome ?? null;
  };
  assert.equal(outcome('complete'), 'completed');
  assert.equal(outcome('runtime_error'), 'failed', 'the raw status alias is normalized like the coordinator does');
  assert.equal(outcome('error'), 'failed');
  assert.equal(outcome('timeout'), 'failed');
  assert.equal(outcome('denied'), 'failed');
  assert.equal(outcome('question_batch'), 'awaiting_decision');
  assert.equal(outcome('complete', { completion: { reason: 'awaiting_proposal', proposalId: `proposal_${'a'.repeat(64)}` } }), 'awaiting_decision');
  assert.equal(outcome('cancelled', {}, { cancel_reason: 'user' }), 'cancelled');
  for (const reason of ['app_shutdown', 'dispose', 'service_stop', 'session_delete']) {
    assert.equal(outcome('cancelled', {}, { cancel_reason: reason }), null, `${reason}: left to the startup repair`);
  }
});

test('prepare puts a valid CMP code on the report and drops anything else', (t) => {
  const env = setup(t);
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  const code = (error) => {
    const { ctx, mutation } = settleCtx(env);
    return prepareTerminalReport(ctx, { kind: 'error', mutation, rendererPayload: { error_code: error } }).errorCode;
  };
  assert.equal(code('CMP-ENGINE-0001'), 'CMP-ENGINE-0001');
  assert.equal(code('session_busy'), null);
  assert.equal(code(undefined), null);
});

test('prepare anchors the marker when the terminal patch writes no assistant row', (t) => {
  const env = setup(t);
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  const { ctx, mutation } = settleCtx(env, { messages: [], ctx: { assistantText: '' } });
  const report = prepareTerminalReport(ctx, { kind: 'complete', mutation, rendererPayload: {} });
  assert.equal(report.anchor, true);
  assert.equal(report.body, 'The turn finished without a visible answer.');
});

test('prepare returns null with no reservation, no messaging service, or an unusable store, and never throws', (t) => {
  const env = setup(t);
  const { ctx, mutation } = settleCtx(env);
  assert.equal(prepareTerminalReport(ctx, { kind: 'complete', mutation, rendererPayload: {} }), null, 'no reservation');
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  const noMessaging = { ...ctx, service: { sessionStore: env.store } };
  assert.equal(prepareTerminalReport(noMessaging, { kind: 'complete', mutation, rendererPayload: {} }), null, 'hosted: no chatMessages');
  assert.equal(prepareTerminalReport({ service: { chatMessages: { convertReport() {} }, sessionStore: {} } }, {}), null);
  assert.equal(prepareTerminalReport({}, {}), null);
  assert.equal(prepareTerminalReport(undefined, undefined), null);
});

test('awaiting_decision reads the proposal title from the child records', (t) => {
  const env = setup(t);
  const proposal = makeGit(1, { summary: 'Commit the billing export' });
  assert.ok(createChatProposalStore(env.store).mutate(CHILD, ({ records }) => ({ records: [...records, proposal] })).ok);
  assert.equal(proposalTitleFor(env.store, CHILD, proposal.proposal_id), 'Commit the billing export');
  assert.equal(proposalTitleFor(env.store, CHILD, `proposal_${'f'.repeat(64)}`), '');
  assert.equal(proposalTitleFor(env.store, CHILD, ''), '');
  assert.equal(proposalTitleFor(null, CHILD, proposal.proposal_id), '');
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  const { ctx, mutation } = settleCtx(env, { ctx: { completion: { reason: 'awaiting_proposal', proposalId: proposal.proposal_id } } });
  assert.equal(prepareTerminalReport(ctx, { kind: 'complete', mutation, rendererPayload: {} }).body, 'Waiting for a decision: Commit the billing export');
});

test('finish converts only after a durable terminal, fire-and-forget, logging failures by id', async (t) => {
  const env = setup(t);
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  const calls = [];
  env.service.chatMessages.convertReport = async (args) => { calls.push(args); return { ok: true }; };
  const { ctx, mutation } = settleCtx(env);
  const report = prepareTerminalReport(ctx, { kind: 'complete', mutation, rendererPayload: {} });
  finishTerminalReport(ctx, report, { handled: true, result: { durableTerminal: false } });
  finishTerminalReport(ctx, report, { handled: false, result: { durableTerminal: true } });
  finishTerminalReport(ctx, null, { handled: true, result: { durableTerminal: true } });
  assert.equal(calls.length, 0, 'not durable / not handled / no report: nothing converts');
  finishTerminalReport(ctx, report, { handled: true, result: { durableTerminal: true } });
  assert.equal(calls.length, 0, 'the conversion never runs inside the settle');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [{ sessionId: CHILD, turnId: 'turn_1', outcome: 'completed', body: 'Final answer.', clipped: false, errorCode: null }]);
  // A rejecting and a throwing messaging service never surface.
  env.service.chatMessages.convertReport = async () => { throw Object.assign(new Error('boom'), { code: 'X_1' }); };
  assert.doesNotThrow(() => finishTerminalReport(ctx, report, { handled: true, result: { durableTerminal: true } }));
  env.service.chatMessages.convertReport = () => { throw new Error('sync boom'); };
  assert.doesNotThrow(() => finishTerminalReport(ctx, report, { handled: true, result: { durableTerminal: true } }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
  const warned = env.logs.filter((entry) => entry.event === 'chat.terminal_report_convert_failed');
  assert.equal(warned.length, 2);
  for (const entry of warned) assert.deepEqual(Object.keys(entry.details).sort(), ['reason', 'sessionId', 'turnId']);
});

test('finish patches the user anchor row with the marker when no assistant row carried it', async (t) => {
  const env = setup(t);
  env.store.appendMessage(CHILD, { id: 'user_s1', role: 'user', content: 'Q', turn_id: 'turn_1' });
  admitReportReservation(env.service, { sessionId: CHILD, turnId: 'turn_1' });
  const { ctx, mutation } = settleCtx(env, { messages: [], ctx: { assistantText: '' } });
  const report = prepareTerminalReport(ctx, { kind: 'error', mutation, rendererPayload: {} });
  finishTerminalReport(ctx, report, { handled: true, result: { durableTerminal: true } });
  const anchor = env.store.getSession(CHILD).messages.find((row) => row.id === 'user_s1');
  assert.equal(anchor.terminal_report_message_id, report.messageId);
});
