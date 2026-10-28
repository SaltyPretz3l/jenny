'use strict';

/* Report back to the starter: a chat woken by another chat's own turn reports its final reply to that sender
 * (services/chat-messaging-wake.js reserves after submit; session-report-records.js / -admission.js settle it).
 * Real session store, mail stores and messaging service through the desktop wiring; the settle is driven at the
 * same prepareTerminalReport / finishTerminalReport seam the managed stream uses. The last test pins that the
 * turn id the runtime answers a submit with is the id the settle looks the reservation up by. */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createSessionMailStore } = require('../services/backend/session-mail-store');
const { normalizeReportReservation } = require('../services/backend/session-mail-records');
const { finishTerminalReport, prepareTerminalReport } = require('../services/backend/session-report-admission');
const { findReservation, reportMessageId, reserveReportBack } = require('../services/backend/session-report-records');
const { REPORT_WAKE_PROMPT, AGENT_MESSAGE_WAKE_PROMPT } = require('../services/chat-messaging-wake');
const { RuntimeStore } = require('../services/session-runtime/store');
const { SessionRuntimeScheduler } = require('../services/session-runtime/scheduler');
const { SessionRuntimeService } = require('../services/session-runtime/service');
const { retainManagedRuntimeController } = require('../services/backend/chat-lifecycle-contracts');
const { createAdapterHarness, waitFor } = require('./helpers/session-runtime-chat-adapter-harness');
const { createFixture } = require('./helpers/chat-messaging-service-fixture');
const F = require('./helpers/session-mail-fixtures');

const ONCE = { kind: 'once', consent_event_id: 'approval_1' };
const settleTick = () => new Promise((resolve) => setTimeout(resolve, 20));

// A sender and a destination; the sender's turn_1 messages the destination, which wakes (turn_wake_1).
async function startWork(t, { body = 'Please review the plan.' } = {}) {
  const f = createFixture(t);
  const src = f.sessionId('Primary');
  const dst = f.sessionId('Worker');
  const inc = (id) => f.store.getSession(id).session_incarnation;
  const prepared = await f.service.agentPrepare({
    sourceSessionId: src, sourceIncarnation: inc(src), turnId: 'turn_1', destinationSessionId: dst, body, toolCallId: 'call_1',
  });
  const sent = await f.service.agentSend({ sourceSessionId: src, operationId: prepared.operation_id, authorization: ONCE });
  assert.equal(sent.ok, true);
  await settleTick(); // the wake submit answers asynchronously, then the slot is reserved
  return { f, src, dst, inc, mail: createSessionMailStore(f.store) };
}

// The terminal settle of `turnId` in `dst`: prepare (marker) then the post-durable conversion.
async function settle(f, dst, turnId, text = 'Reviewed: the plan holds up.', kind = 'complete') {
  const ctx = {
    service: { sessionStore: f.store, chatMessages: f.service, _emitServiceLog() {} },
    turnLease: { identity: { sessionId: dst, turnId, userMessageId: `user_${turnId}` } },
    assistantText: text,
    completion: {},
  };
  const report = prepareTerminalReport(ctx, { kind, mutation: { messages: [{ role: 'assistant' }] }, rendererPayload: {} });
  finishTerminalReport(ctx, report, { handled: true, result: { durableTerminal: true } });
  await settleTick();
  return report;
}

test("a wake from the sender's turn reserves the report slot for the woken turn with the sender as parent", async (t) => {
  const { f, src, dst, inc } = await startWork(t);
  assert.equal(f.wakes.length, 1);
  assert.equal(f.wakes[0].request.prompt, AGENT_MESSAGE_WAKE_PROMPT);
  const reservations = f.mail(dst).report_reservations;
  assert.equal(reservations.length, 1);
  const [reservation] = reservations;
  assert.equal(reservation.turn_id, 'turn_wake_1');
  assert.equal(reservation.parent_session_id, src);
  assert.equal(reservation.parent_session_incarnation, inc(src));
  assert.ok(normalizeReportReservation(reservation), 'the stored value passes the mail normalizer');
  assert.ok(f.logs.some(([, event]) => event === 'chat_messaging.report_back_reserved'));
});

test('the settled turn converts into ONE terminal_report in the sender inbox and wakes the sender once', async (t) => {
  const { f, src, dst } = await startWork(t);
  const report = await settle(f, dst, 'turn_wake_1');
  const id = reportMessageId(dst, f.store.getSession(dst).session_incarnation, 'turn_wake_1');
  assert.equal(report.messageId, id);
  assert.equal(f.mail(dst).report_reservations.length, 0, 'the reservation is consumed');
  assert.equal(f.mail(dst).outbox.filter((record) => record.envelope.kind === 'terminal_report').length, 1);
  const reports = f.mail(src).inbox.filter((record) => record.envelope.kind === 'terminal_report');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].envelope.message_id, id);
  assert.equal(reports[0].envelope.body, 'Reviewed: the plan holds up.');
  assert.equal(reports[0].envelope.source_turn_id, 'turn_wake_1');
  assert.equal(f.wakes.length, 2);
  assert.equal(f.wakes[1].request.sessionId, src);
  assert.equal(f.wakes[1].request.prompt, REPORT_WAKE_PROMPT);
  assert.match(f.wakes[1].request.visiblePrompt, /^Woken by a report from Worker$/);
  assert.equal(f.mail(src).report_reservations.length, 0, 'the sender\'s report-woken turn never reports again');
  assert.ok(!JSON.stringify(f.logs).includes('plan holds up'), 'bodies are never logged');
});

test('a second settle or a replayed conversion writes nothing more and wakes nothing more', async (t) => {
  const { f, src, dst } = await startWork(t);
  await settle(f, dst, 'turn_wake_1');
  const revision = f.store.getSession(dst).coordination_revision;
  assert.equal(await settle(f, dst, 'turn_wake_1'), null, 'no reservation left to settle');
  const again = await f.service.convertReport({
    sessionId: dst, turnId: 'turn_wake_1', outcome: 'completed', body: 'x', clipped: false, errorCode: null,
  });
  assert.equal(again.converted, false);
  assert.equal(f.store.getSession(dst).coordination_revision, revision);
  assert.equal(f.mail(src).inbox.filter((record) => record.envelope.kind === 'terminal_report').length, 1);
  assert.equal(f.wakes.length, 2);
});

test('a failed woken turn reports failed to the sender; a dialog message reserves nothing', async (t) => {
  const { f, src, dst } = await startWork(t);
  await settle(f, dst, 'turn_wake_1', '', 'error');
  const [record] = f.mail(src).inbox.filter((entry) => entry.envelope.kind === 'terminal_report');
  assert.equal(record.envelope.report.outcome, 'failed');
  const dialog = createFixture(t);
  const a = dialog.sessionId('A');
  const b = dialog.sessionId('B');
  await dialog.sendNew(a, b, 'hello from a person');
  await settleTick();
  assert.equal(dialog.wakes.length, 1);
  assert.equal(dialog.mail(b).report_reservations.length, 0);
});

test('startup repair settles a report-back reservation quietly: it converts from evidence or releases a turn that never began', async (t) => {
  const evidence = await startWork(t);
  const id = reportMessageId(evidence.dst, evidence.inc(evidence.dst), 'turn_wake_1');
  evidence.f.store.appendMessage(evidence.dst, {
    id: 'assistant_wake_1', role: 'assistant', content: 'Finished before the restart.', terminal_report_message_id: id,
  });
  evidence.f.service.reconcileOnStartup();
  assert.equal(evidence.f.mail(evidence.dst).report_reservations.length, 0);
  const [record] = evidence.f.mail(evidence.src).inbox.filter((entry) => entry.envelope.kind === 'terminal_report');
  assert.equal(record.envelope.body, 'Finished before the restart.');
  assert.equal(evidence.f.wakes.length, 1, 'startup repair wakes nobody');

  const never = await startWork(t);
  never.f.service.reconcileOnStartup();
  assert.equal(never.f.mail(never.dst).report_reservations.length, 0);
  assert.equal(never.f.mail(never.src).inbox.filter((entry) => entry.envelope.kind === 'terminal_report').length, 0);
  assert.equal(never.f.wakes.length, 1);
});

test('a full outbox skips the reservation without changing the wake', async (t) => {
  const f = createFixture(t);
  const src = f.sessionId('Primary');
  const dst = f.sessionId('Worker');
  const mail = createSessionMailStore(f.store);
  const filler = Array.from({ length: 128 }, (_, i) => F.makeOutbox(i + 1));
  assert.ok(mail.mutate(dst, ({ mail: current }) => ({ mail: { ...current, outbox: filler } })).ok);
  const prepared = await f.service.agentPrepare({
    sourceSessionId: src, sourceIncarnation: f.store.getSession(src).session_incarnation, turnId: 'turn_1',
    destinationSessionId: dst, body: 'Go.', toolCallId: 'call_1',
  });
  await f.service.agentSend({ sourceSessionId: src, operationId: prepared.operation_id, authorization: ONCE });
  await settleTick();
  assert.equal(f.wakes.length, 1);
  assert.equal(f.mail(dst).report_reservations.length, 0);
  assert.ok(f.logs.some(([, event, details]) => event === 'chat_messaging.report_back_skipped' && details.reason === 'report_backpressure'));
});

// ---------- the record function ----------

test('reserveReportBack is idempotent per turn, never overrides a linked reporter and skips an already reported turn', async (t) => {
  const { f, src, dst, inc, mail } = await startWork(t);
  const args = {
    childSessionId: dst, childIncarnation: inc(dst), parentSessionId: src, parentIncarnation: inc(src),
    messageId: 'msg_other', turnId: 'turn_wake_1', now: new Date(),
  };
  const current = mail.read(dst).mail;
  assert.deepEqual(reserveReportBack(current, args), { skip: 'already_reserved' });
  assert.equal(findReservation(current, 'turn_wake_1').parent_session_id, src);
  const fresh = reserveReportBack(current, { ...args, turnId: 'turn_wake_2' });
  assert.equal(fresh.mail.report_reservations.length, 2);
  assert.equal(fresh.mail.report_reservations[1].reporting_consent_id, reserveReportBack(current, { ...args, turnId: 'turn_wake_3' })
    .mail.report_reservations[1].reporting_consent_id, 'the consent id derives from the message id only');
  assert.deepEqual(reserveReportBack({ ...current, reporting_enabled: true }, { ...args, turnId: 'turn_wake_2' }), { skip: 'linked_reporter' });
  assert.deepEqual(reserveReportBack(current, { ...args, turnId: '' }), { skip: 'invalid' });
  await settle(f, dst, 'turn_wake_1');
  assert.deepEqual(reserveReportBack(mail.read(dst).mail, args), { skip: 'already_reported' });
});

// ---------- the id the runtime answers with is the id the settle uses ----------

test('the turn_id submitApplicationTurn answers with is the identity.turnId the settle looks the reservation up by', async (t) => {
  const h = createAdapterHarness(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-report-back-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const leases = [];
  h.service._startManagedSidecarChatStream = async (request) => {
    const lease = request.turnLease;
    leases.push(lease);
    const controller = new AbortController();
    h.service.sessionTurnActors.attachController(lease, controller);
    controller._runtimeCompletion = Promise.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
    const result = retainManagedRuntimeController({ sessionId: h.sessionId, streamId: lease.identity.streamId }, controller);
    h.service.sessionTurnActors.release(lease, { status: 'completed' });
    return result;
  };
  const store = new RuntimeStore(root);
  const a = h.adapter;
  const scheduler = new SessionRuntimeScheduler({ store, lanes: h.lanes,
    resolveRoute: (work) => a.resolveRoute(work), validateWork: (work, route) => a.validateWork(work, route),
    prepareCanonical: (work, route) => a.prepareCanonical(work, route),
    claimCanonical: (work, route) => a.claimCanonical(work, route),
    startProducer: (context) => a.startProducer(context), discardPending: (work) => a.discardPending(work) });
  h.lanes.onChange = () => scheduler.notifyLaneAvailability();
  const runtime = new SessionRuntimeService({ store, scheduler, chatAdapter: a });
  h.service.sessionRuntime = runtime;
  h.service.chatMessages = { convertReport: async () => ({ ok: true }) };
  h.service.sessionStore.createSessionWithId('sess_starter', { title: 'Starter' });
  const mail = createSessionMailStore(h.service.sessionStore);
  const result = await runtime.submitApplicationTurn({
    sessionId: h.sessionId, prompt: 'Woken', visiblePrompt: 'Woken by a message from Starter', preferredModel: 'fixture-model', planMode: false,
  }, { idempotencyKey: 'wake_report_back_1' });
  assert.equal(result.ok, true);
  const reserved = mail.mutate(h.sessionId, ({ mail: current, session }) => {
    const next = reserveReportBack(current, {
      childSessionId: h.sessionId, childIncarnation: session.session_incarnation, parentSessionId: 'sess_starter',
      parentIncarnation: h.service.sessionStore.getSession('sess_starter').session_incarnation, messageId: 'msg_1', turnId: result.turn_id, now: new Date(),
    });
    return next.mail ? { mail: next.mail } : { abort: { reason: next.skip } };
  });
  assert.equal(reserved.ok, true);
  await waitFor(() => store.get(result.work_id).status === 'completed', 'the woken turn never ran');
  assert.equal(leases[0].identity.turnId, result.turn_id);
  const report = prepareTerminalReport({
    service: h.service, turnLease: leases[0], assistantText: 'Done.', completion: {},
  }, { kind: 'complete', mutation: { messages: [] }, rendererPayload: {} });
  assert.ok(report, 'the settle finds the reservation made under the submit answer');
  assert.equal(report.turnId, result.turn_id);
  assert.equal(report.messageId, reportMessageId(h.sessionId, h.service.sessionStore.getSession(h.sessionId).session_incarnation, result.turn_id));
});
