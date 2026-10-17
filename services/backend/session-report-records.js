'use strict';

// Pure terminal-report helpers for linked children (row 59 checkpoint 5b-1, slice B1).
// No IO, no Electron: ids, the outcome table, the sanitized/clipped report body, and
// the reservation lifecycle over a normalized `session_mail` value. Callers (the
// managed turn seam and the messaging service) own the durable mutation; every
// function here returns a new mail value and never mutates its input.

const { derivedUuid } = require('./chat-proposal-session-records');
const { REPORT_SLOT_BYTES, normalizeReportReservation, outboxCapacity } = require('./session-mail-records');
const { MAX_REPORT_BODY_BYTES, isId, validateEnvelope } = require('./session-message-envelope');

const LIFECYCLE_CANCEL_REASONS = Object.freeze(['app_shutdown', 'dispose', 'service_stop']);
const FAILED_KINDS = Object.freeze(['error', 'timeout', 'denied', 'preempted', 'interrupted']);
// Model-facing report text: English constants built in Electron services, not renderer copy.
const LINES = Object.freeze({
  failed: 'The turn failed before it produced an answer.',
  cancelled: 'The turn was cancelled before it produced an answer.',
  interrupted: 'The turn was interrupted before it could finish.',
  completed: 'The turn finished without a visible answer.',
  decision: 'Waiting for a decision.',
  decisionTitle: 'Waiting for a decision: ',
});
// C0 controls except TAB/LF and DEL, built from code points so no control character is literal.
const CONTROL_RE = new RegExp(`[${[[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x7f]]
  .map(([lo, hi]) => `\\u${lo.toString(16).padStart(4, '0')}-\\u${hi.toString(16).padStart(4, '0')}`).join('')}]`, 'g');
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

// ---------- ids and outcome ----------

const reportMessageId = (childSessionId, childIncarnation, turnId) => derivedUuid('terminal_report', childSessionId, childIncarnation, turnId);
const reportOperationId = (messageId) => derivedUuid('terminal_report_operation', messageId);

// Only a stop the user (or an unattributed sidecar cancel) caused reads as "cancelled"; a deadline or a
// transport abort is a failure the parent should see as one.
const FAILED_CANCEL_REASONS = Object.freeze(['timeout', 'transport_abort']);

function cancelledOutcome(cancelReason) {
  if (cancelReason === 'session_delete') return null; // the child record is gone: nothing to report
  if (LIFECYCLE_CANCEL_REASONS.includes(cancelReason)) return 'defer';
  return FAILED_CANCEL_REASONS.includes(cancelReason) ? 'failed' : 'cancelled';
}

// 'completed' | 'failed' | 'cancelled' | 'awaiting_decision' | 'defer' (leave the reservation
// for the startup repair) | null (no report) for a coordinator terminal kind.
function reportOutcome(kind, { completionReason, cancelReason } = {}) {
  if (kind === 'complete') return completionReason === 'awaiting_proposal' ? 'awaiting_decision' : 'completed';
  if (kind === 'question_batch') return 'awaiting_decision';
  if (FAILED_KINDS.includes(kind)) return 'failed';
  return kind === 'cancelled' ? cancelledOutcome(cancelReason) : null;
}

// ---------- body ----------

function sanitizeReportText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(LONE_SURROGATE_RE, '�').replace(/\r\n?/g, '\n').replace(CONTROL_RE, ' ').trim();
}

// `text` cut to at most `maxBytes` UTF-8 bytes on a code point boundary: {text, clipped}.
function clipUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, clipped: false };
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1; // never inside a continuation run
  return { text: buffer.subarray(0, end).toString('utf8').trimEnd(), clipped: true };
}

function fallbackLine(outcome, interrupted) {
  if (outcome === 'completed') return LINES.completed;
  if (outcome === 'cancelled') return LINES.cancelled;
  return interrupted ? LINES.interrupted : LINES.failed;
}

function decisionText(proposalTitle) {
  const title = sanitizeReportText(proposalTitle);
  return title ? `${LINES.decisionTitle}${title}` : LINES.decision;
}

// {body, clipped} per outcome: the visible answer (completed), the visible partial answer or a
// synthesized line (failed / cancelled), or the waiting-for-a-decision line. Sanitized, at most
// 8,192 UTF-8 bytes, never empty.
function buildReportBody({ outcome, visibleText, proposalTitle, interrupted = false } = {}) {
  const text = outcome === 'awaiting_decision'
    ? decisionText(proposalTitle)
    : (sanitizeReportText(visibleText) || fallbackLine(outcome, interrupted === true));
  const { text: body, clipped } = clipUtf8(text, MAX_REPORT_BODY_BYTES);
  return { body, clipped };
}

// ---------- reservations ----------

const reservations = (mail) => (Array.isArray(mail?.report_reservations) ? mail.report_reservations : []);
const findReservation = (mail, turnId) => reservations(mail).find((entry) => entry?.turn_id === turnId) || null;

function stampIso(now) {
  const date = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  if (!Number.isFinite(date.getTime())) throw new TypeError('invalid timestamp');
  return date.toISOString();
}

function buildReservation(spawnedFrom, turnId, now) {
  if (!isId(turnId) || !spawnedFrom || spawnedFrom.schema_version !== 1) return null;
  return normalizeReportReservation({
    turn_id: turnId,
    slot_bytes: REPORT_SLOT_BYTES,
    reserved_at: stampIso(now),
    parent_session_id: spawnedFrom.parent_session_id,
    parent_session_incarnation: spawnedFrom.parent_session_incarnation,
    reporting_consent_id: spawnedFrom.reporting_consent_id,
  });
}

// Reserves one outbox slot for the turn's report. Results:
//   {mail}                        reserved, or unchanged (already reserved, or not an eligible turn)
//   {refused:'report_backpressure'} the undelivered outbox cannot take one more record + 8 KiB
//   {disable:true, mail}          the parent is gone: reporting_enabled=false, nothing reserved
function reserveReport(mail, { spawnedFrom, reportingEnabled, parentExists, turnId, now } = {}) {
  const reservation = reportingEnabled === true ? buildReservation(spawnedFrom, turnId, now) : null;
  if (!reservation || findReservation(mail, turnId)) return { mail };
  if (parentExists === false) return { disable: true, mail: { ...structuredClone(mail), reporting_enabled: false } };
  if (outboxCapacity(mail, REPORT_SLOT_BYTES).full) return { refused: 'report_backpressure' };
  return { mail: { ...structuredClone(mail), report_reservations: [...structuredClone(reservations(mail)), reservation] } };
}

function releaseReservation(mail, turnId) {
  return { ...structuredClone(mail), report_reservations: structuredClone(reservations(mail).filter((entry) => entry?.turn_id !== turnId)) };
}

function pendingReportRecord(envelope, now) {
  const at = stampIso(now);
  return {
    envelope,
    operation_id: reportOperationId(envelope.message_id),
    gesture_id: null,
    tool_call_id: null,
    authorization_id: null,
    state: 'pending',
    prepared_at: at,
    expires_at: null,
    send_requested_at: at,
    delivered_at: null,
    destination_receipt_id: null,
    last_error: null,
    restore_requires_confirmation: false,
  };
}

const matchesReservation = (envelope, reservation, turnId) => envelope.kind === 'terminal_report'
  && envelope.source_turn_id === turnId && envelope.destination_session_id === reservation.parent_session_id
  && envelope.destination_session_incarnation === reservation.parent_session_incarnation;

// Turns the turn's reservation into one pending outbox record for `envelope`. Returns the mail
// unchanged when there is no reservation for the turn, the envelope is not a valid terminal_report
// for that reservation's parent, or an outbox record with the envelope's message id already exists.
function convertReservation(mail, { turnId, envelope, now } = {}) {
  const reservation = findReservation(mail, turnId);
  const valid = reservation ? validateEnvelope(envelope) : null;
  if (!valid || !matchesReservation(valid, reservation, turnId)) return structuredClone(mail);
  if ((mail.outbox || []).some((record) => record.envelope?.message_id === valid.message_id)) return structuredClone(mail);
  const next = releaseReservation(mail, turnId);
  return { ...next, outbox: [...structuredClone(mail.outbox || []), pendingReportRecord(valid, now)] };
}

module.exports = {
  LINES,
  buildReportBody,
  convertReservation,
  findReservation,
  releaseReservation,
  reportMessageId,
  reportOperationId,
  reportOutcome,
  reserveReport,
  sanitizeReportText,
};
