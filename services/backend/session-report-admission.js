'use strict';

// The turn side of a terminal report: a linked child's, or a woken chat's report back (row 59 checkpoint 5b-1, slice B2).
//   admitReportReservation  pre-inference: reserves the report's outbox slot inside the turn guard.
//   prepareTerminalReport   at settle: finds the reservation, computes the outcome/body and stamps the
//                           deterministic marker on the terminal patch's assistant row.
//   finishTerminalReport    after a durable settle: anchors the marker when no row carried it, then hands
//                           the conversion to the messaging service outside the terminal critical path.
// An unlinked chat (or one with reporting off) never reaches a mail write. Logs carry ids and reason
// tokens only, never titles, bodies or task text.

const { createChatProposalStore } = require('./chat-proposal-store');
const { normalizeTerminalKind } = require('./chat-lifecycle-contracts');
const { createCancellationError, CANCEL_REASON_SESSION_DELETE } = require('./chat-stream-terminal-utils');
const { MESSAGE_ERROR_CODES } = require('./error-codes');
const { normalizeSpawnedFrom } = require('./session-coordination-records');
const { createSessionMailStore } = require('./session-mail-store');
const { ERROR_CODE_RE } = require('./session-message-envelope');
const {
  buildReportBody, findReservation, reportMessageId, reportOutcome, reserveReport,
} = require('./session-report-records');

function logWarn(service, event, details) {
  try { service?._emitServiceLog?.('WARN', event, details); } catch { /* diagnostics never change the turn */ }
}

function reportError(code, reason, message, retryable) {
  return Object.assign(new Error(message), { code, reason, retryable, user_visible: true });
}

// The child's linked-chat provenance when this turn may reserve a report, else null.
function reportingSpawnedFrom(sessionStore, sessionId) {
  const session = typeof sessionStore?.peekSession === 'function' ? sessionStore.peekSession(sessionId) : null;
  const spawnedFrom = normalizeSpawnedFrom(session?.spawned_from);
  return spawnedFrom?.schema_version === 1 ? spawnedFrom : null;
}

// True when the chat's raw mail already holds a report slot: a report-back reservation (made after a wake
// submit) lives on a chat that was never linked. A cheap structural peek, no mail normalization.
function hasReportReservation(sessionStore, sessionId) {
  const session = typeof sessionStore?.peekSession === 'function' ? sessionStore.peekSession(sessionId) : null;
  const list = session?.session_mail?.report_reservations;
  return Array.isArray(list) && list.length > 0;
}

// Reserves the turn's report slot. Called from the pre-inference seam of a brand-new model turn
// (a new send, edit or failure retry); a checkpoint resume / paused continuation (`resumed`) reuses
// its turn id and a handoff preparation turn never reports. Throws a coded error to refuse the turn
// (`report_backpressure`, or a persistence failure) and a cancellation when the turn was dropped.
function admitReportReservation(service, {
  sessionId, turnId, lease = null, handoffPreparation = null, resumed = false, now = () => new Date(),
} = {}) {
  if (handoffPreparation || resumed || !sessionId || !turnId) return;
  // No messaging service (hosted) means no way to convert or deliver: never leave a slot reserved.
  if (typeof service?.chatMessages?.convertReport !== 'function') return;
  const sessionStore = service.sessionStore;
  const spawnedFrom = reportingSpawnedFrom(sessionStore, sessionId);
  if (!spawnedFrom) return;
  const mailStore = createSessionMailStore(sessionStore);
  const current = mailStore.read(sessionId);
  if (!current.ok || current.frozen || current.mail.reporting_enabled !== true) return;
  const run = () => {
    const parent = mailStore.read(spawnedFrom.parent_session_id);
    const parentExists = parent.ok || parent.reason !== 'not_found';
    return mailStore.mutate(sessionId, ({ mail }) => {
      const reserved = reserveReport(mail, { spawnedFrom, reportingEnabled: mail.reporting_enabled, parentExists, turnId, now: now() });
      return reserved.refused ? { abort: { reason: reserved.refused } } : { mail: reserved.mail };
    });
  };
  const actors = service.sessionTurnActors;
  const result = lease && typeof actors?.guard === 'function' ? actors.guard(lease, 'managed.session_report_reservation', run) : run();
  if (result === null) throw createCancellationError(CANCEL_REASON_SESSION_DELETE, 'The turn was dropped before its report could be reserved.');
  if (result.ok) {
    if (!result.noop) service.chatMessages?.notify?.(sessionId);
    return;
  }
  if (result.reason === 'report_backpressure') {
    throw reportError(MESSAGE_ERROR_CODES.SENDER_BACKPRESSURE, 'report_backpressure',
      'This chat has too many unsent messages and reports to start another turn. Discard or retry one, then try again.', false);
  }
  if (result.reason === 'io_failed') {
    throw reportError(MESSAGE_ERROR_CODES.PERSISTENCE_FAILURE, 'persistence_failure',
      'The turn report could not be saved, so the turn did not start. Try again.', true);
  }
  // not_found / unavailable (a frozen future-schema container) / invalid_record: reporting cannot work here,
  // and the turn must not be held hostage by it.
  logWarn(service, 'chat.session_report_reservation_skipped', { sessionId, turnId, reason: String(result.reason || 'unavailable') });
}

// The title of the child's proposal (for an awaiting_decision report), else ''.
function proposalTitleFor(sessionStore, sessionId, proposalId) {
  if (!proposalId) return '';
  try {
    const read = createChatProposalStore(sessionStore).read(sessionId);
    const record = read.ok ? read.records.find((entry) => entry.proposal_id === proposalId) : null;
    const input = record?.normalized_input || {};
    return String(input.title || input.summary || input.purpose || '');
  } catch {
    return '';
  }
}

// Settle time. -> null (no reservation / nothing to report / deferred to the startup repair) or the
// report descriptor `finishTerminalReport` consumes. Stamps the marker on the terminal patch's last
// assistant row when one is written; `anchor` says the user anchor row must carry it instead.
function prepareTerminalReport(ctx, { kind, mutation, rendererPayload } = {}) {
  try {
    const service = ctx?.service;
    const identity = ctx?.turnLease?.identity;
    if (!identity || typeof service?.chatMessages?.convertReport !== 'function') return null;
    // Only a linked child or a chat holding a report-back slot can have a reservation: every other chat skips the mail read.
    if (!reportingSpawnedFrom(service.sessionStore, identity.sessionId) && !hasReportReservation(service.sessionStore, identity.sessionId)) return null;
    const read = createSessionMailStore(service.sessionStore).read(identity.sessionId);
    if (!read.ok || read.frozen || !findReservation(read.mail, identity.turnId)) return null;
    // The same alias table the coordinator applies ('runtime_error' -> 'error', 'canceled' -> 'cancelled', ...).
    const outcome = reportOutcome(normalizeTerminalKind(kind) || 'error', {
      completionReason: ctx.completion?.reason, cancelReason: rendererPayload?.cancel_reason,
    });
    if (!outcome || outcome === 'defer') return null;
    const proposalTitle = outcome === 'awaiting_decision'
      ? proposalTitleFor(service.sessionStore, identity.sessionId, ctx.completion?.proposalId) : '';
    const { body, clipped } = buildReportBody({ outcome, visibleText: ctx.assistantText, proposalTitle });
    const errorCode = ERROR_CODE_RE.test(String(rendererPayload?.error_code || '')) ? rendererPayload.error_code : null;
    const messageId = reportMessageId(identity.sessionId, read.session_incarnation, identity.turnId);
    const carrier = [...(mutation?.messages || [])].reverse().find((message) => message?.role === 'assistant');
    if (carrier) carrier.terminal_report_message_id = messageId;
    return {
      sessionId: identity.sessionId, turnId: identity.turnId, userMessageId: identity.userMessageId,
      messageId, anchor: !carrier, outcome, body, clipped, errorCode,
    };
  } catch (error) {
    logWarn(ctx?.service, 'chat.terminal_report_prepare_failed', { sessionId: ctx?.turnLease?.identity?.sessionId, reason: String(error?.code || 'exception') });
    return null;
  }
}

const CONVERT_RETRY_MS = 5000;

// Converts outside the terminal critical path; one bounded retry after a persistence failure, after which the
// startup repair still owns the reservation.
function convertLater(service, request, attempt = 0) {
  const { sessionId, turnId } = request;
  const warn = (reason) => logWarn(service, 'chat.terminal_report_convert_failed', { sessionId, turnId, reason });
  const timer = setTimeout(() => {
    Promise.resolve()
      .then(() => service.chatMessages.convertReport(request))
      .then((result) => {
        if (result?.ok !== false) return;
        warn(String(result.reason || 'unavailable'));
        if (result.reason === 'persistence_failure' && attempt === 0) convertLater(service, request, 1);
      })
      .catch((error) => warn(String(error?.code || 'exception')));
  }, attempt === 0 ? 0 : CONVERT_RETRY_MS);
  timer?.unref?.();
}

// After a settle. Only a durable terminal converts; the conversion never blocks or fails the settle.
function finishTerminalReport(ctx, report, settled) {
  if (!report || settled?.handled !== true || settled.result?.durableTerminal !== true) return;
  const service = ctx.service;
  const { sessionId, turnId, outcome, body, clipped, errorCode } = report;
  try {
    // An anchor marker also carries the outcome: no assistant row exists for the startup repair to read it from.
    if (report.anchor) {
      service.sessionStore.updateMessage?.(sessionId, report.userMessageId, {
        terminal_report_message_id: report.messageId, terminal_report_outcome: outcome, terminal_report_error_code: errorCode,
      });
    }
    convertLater(service, { sessionId, turnId, outcome, body, clipped, errorCode });
  } catch (error) {
    logWarn(service, 'chat.terminal_report_convert_failed', { sessionId, turnId, reason: String(error?.code || 'exception') });
  }
}

module.exports = {
  admitReportReservation,
  finishTerminalReport,
  prepareTerminalReport,
  proposalTitleFor,
};
