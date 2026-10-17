'use strict';

/* services/chat-messaging-reports.js - the terminal-report half of addressed session messaging
 * (row 59 checkpoint 5b-1): a linked child reports each turn's outcome to the chat that started it.
 *   convertReport  turns a turn's reservation into ONE pending outbox record (deterministic message id) and
 *                  delivers it through the existing delivery transaction;
 *   setReporting   flips a linked child's `reporting_enabled` (never deletes an owed report);
 *   repairSession  the startup safety net (E8): converts or releases reservations a restart orphaned.
 * Every state change is one synchronous mail mutation with no await inside. Diagnostics carry ids, states and
 * reason tokens only, never report bodies, titles or task text.
 */

const { messageMatchesStream, hasTerminalMessageEvidence } = require('./backend/active-turn-terminal-evidence');
const { normalizeTerminalKind } = require('./backend/chat-lifecycle-contracts');
const E = require('./backend/session-message-envelope');
const {
  buildReportBody, convertReservation, findReservation, releaseReservation, reportMessageId, reportOutcome,
} = require('./backend/session-report-records');
const contract = require('./chat-messaging-contract');

const { fail, succeed } = contract;
const { ERROR_CODE_RE } = E;
// Restart reconciliation subcodes: the turn did not fail on its own, the app went away under it.
const INTERRUPTED_SUBCODE_RE = /^(?:app_restart|sidecar_crash)/;

const text = (value) => (typeof value === 'string' ? value : '');
const sameTurn = (active, turnId) => Boolean(active) && [active.turn_id, active.request_id, active.stream_id].includes(turnId);

// The report outcome/body inputs of a terminal assistant row (the repair has no live turn context). The same
// outcome table as the live settle; a lifecycle cancel (deferred live) and a restart row read as interrupted.
function describeTerminalRow(row) {
  const status = text(row.terminal_status || row.status).trim();
  const subcode = text(row.terminal_subcode).trim().toLowerCase();
  let kind = status ? normalizeTerminalKind(status) || 'error' : 'complete';
  if (text(row.id).startsWith('question_batch_')) kind = 'question_batch';
  if (status.toLowerCase() === 'interrupted') kind = 'interrupted';
  const live = reportOutcome(kind, { completionReason: row.completion_reason, cancelReason: subcode });
  const interrupted = live === 'defer' || kind === 'interrupted' || INTERRUPTED_SUBCODE_RE.test(subcode);
  return {
    outcome: live && live !== 'defer' ? live : 'failed',
    interrupted,
    visibleText: interrupted ? '' : text(row.content),
    proposalId: text(row.completion_proposal_id),
    errorCode: ERROR_CODE_RE.test(text(row.error_code)) ? row.error_code : null,
  };
}

// An anchor marker's own outcome (no assistant row was written for that turn), else null.
function describeAnchorMarker(row) {
  if (!E.REPORT_OUTCOMES.includes(row?.terminal_report_outcome)) return null;
  const errorCode = text(row.terminal_report_error_code);
  return { outcome: row.terminal_report_outcome, interrupted: false, visibleText: '', proposalId: '',
    errorCode: ERROR_CODE_RE.test(errorCode) ? errorCode : null };
}

function createReportOps({
  mail, getSessionSummary, getSessionMessages, getActiveTurn, getProposalTitle = () => '', now, notify, deliver, storeFailure, log,
}) {
  const stamp = () => now();

  function validConvertRequest(raw) {
    const ok = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.sessionId === 'string' && raw.sessionId
      && E.isId(raw.turnId) && E.REPORT_OUTCOMES.includes(raw.outcome) && typeof raw.body === 'string'
      && (raw.clipped === undefined || typeof raw.clipped === 'boolean')
      && (raw.errorCode === undefined || raw.errorCode === null || ERROR_CODE_RE.test(String(raw.errorCode)));
    return ok ? { ...raw, clipped: raw.clipped === true, errorCode: raw.errorCode ?? null } : null;
  }

  // Settles one reservation into one pending report and starts its delivery. Idempotent by message id.
  function convert({ sessionId, turnId, outcome, body, clipped, errorCode }) {
    const read = mail.read(sessionId);
    if (!read.ok) return fail(read.reason === 'not_found' ? 'not_found' : 'unavailable');
    if (read.frozen) return fail('unavailable');
    const messageId = reportMessageId(sessionId, read.session_incarnation, turnId);
    const reservation = findReservation(read.mail, turnId);
    const existing = read.mail.outbox.find((record) => record.envelope.message_id === messageId);
    if (!reservation && !existing) return succeed({ converted: false, reason: 'no_reservation' });
    let operation = existing;
    if (!existing) {
      const parent = mail.read(reservation.parent_session_id);
      const envelope = E.buildReportEnvelope({
        child: { session_id: sessionId, session_incarnation: read.session_incarnation, project_id: read.project_id },
        parent: {
          session_id: reservation.parent_session_id,
          session_incarnation: reservation.parent_session_incarnation,
          project_id: parent.ok ? parent.project_id : null,
        },
        turnId, outcome, body, clipped, errorCode, messageId, createdAt: stamp(),
      });
      if (!envelope) return fail('invalid_request');
      const result = mail.mutate(sessionId, ({ mail: current }) => ({ mail: convertReservation(current, { turnId, envelope, now: stamp() }) }));
      if (!result.ok) return storeFailure(result);
      operation = result.mail.outbox.find((record) => record.envelope.message_id === messageId);
      if (!operation) return fail('invalid_request');
      notify(sessionId);
    } else if (reservation) {
      release(sessionId, turnId); // the record is already owed: the slot is redundant
    }
    if (operation.state === 'pending') deliver(sessionId, operation.operation_id);
    return succeed({ converted: !existing, operation_id: operation.operation_id });
  }

  function release(sessionId, turnId) {
    const result = mail.mutate(sessionId, ({ mail: current }) => ({ mail: releaseReservation(current, turnId) }));
    if (result.ok && !result.noop) notify(sessionId);
    return result;
  }

  async function convertReport(raw) {
    const request = validConvertRequest(raw);
    return request ? convert(request) : fail('invalid_request');
  }

  async function setReporting(raw) {
    const checked = contract.validateSetReportingRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const { child_session_id: childId, enabled } = checked.value;
    const read = mail.read(childId);
    if (!read.ok) return fail(read.reason === 'not_found' ? 'not_found' : 'unavailable');
    if (read.frozen) return fail('unavailable', { currentRevision: read.coordination_revision });
    if (!getSessionSummary(childId)?.spawned_from) return fail('invalid_request', { currentRevision: read.coordination_revision });
    const result = mail.mutate(childId, ({ mail: current }) => ({ mail: { ...current, reporting_enabled: enabled } }));
    if (!result.ok) return storeFailure(result);
    if (!result.noop) notify(childId);
    return succeed({ enabled, revision: result.coordination_revision });
  }

  // ---- startup repair (E8) -----------------------------------------------------

  function streamCandidates(anchor, turnId) {
    const id = text(anchor?.id);
    return [...new Set([turnId, id.startsWith('user_') ? id.slice('user_'.length) : ''].filter(Boolean))];
  }

  // A row that cannot belong to this turn: another turn's id, or written before the reservation existed (a
  // failure retry and an edit keep the anchor's stream, and a retry keeps the failed attempt's rows).
  function olderThanTurn(row, turnId, reservedAt) {
    if (row.turn_id && row.turn_id !== turnId) return true;
    const written = Date.parse(text(row.timestamp));
    return Number.isFinite(written) && written < Date.parse(reservedAt);
  }

  // The turn's terminal assistant row: the marker carrier, else the row terminal evidence points at.
  function terminalRowFor(messages, reportId, anchor, reservation) {
    const marked = messages.find((row) => row?.terminal_report_message_id === reportId);
    if (marked?.role === 'assistant') return marked;
    if (marked) return null; // the anchor carried it: no assistant row was written
    for (const streamId of streamCandidates(anchor, reservation.turn_id)) {
      if (!hasTerminalMessageEvidence(messages, streamId)) continue;
      const rows = messages.filter((row) => row?.role === 'assistant' && messageMatchesStream(row, streamId)
        && !olderThanTurn(row, reservation.turn_id, reservation.reserved_at));
      if (rows.length) return rows[rows.length - 1];
    }
    return null;
  }

  function repairReservation(sessionId, read, reservation) {
    const turnId = reservation.turn_id;
    const reportId = reportMessageId(sessionId, read.session_incarnation, turnId);
    if (read.mail.outbox.some((record) => record.envelope.message_id === reportId)) return release(sessionId, turnId);
    const messages = getSessionMessages(sessionId) || [];
    const anchor = messages.find((row) => row?.role === 'user' && row.turn_id === turnId);
    const row = terminalRowFor(messages, reportId, anchor, reservation);
    const markedRow = messages.find((entry) => entry?.terminal_report_message_id === reportId);
    const marked = Boolean(markedRow);
    const described = row ? describeTerminalRow(row) : describeAnchorMarker(markedRow);
    if (described) {
      const proposalTitle = described.outcome === 'awaiting_decision' ? getProposalTitle(sessionId, described.proposalId) : '';
      const { body, clipped } = buildReportBody({ ...described, proposalTitle });
      return convert({ sessionId, turnId, outcome: described.outcome, body, clipped, errorCode: described.errorCode });
    }
    if (marked || anchor || sameTurn(getActiveTurn(sessionId), turnId)) {
      // After a restart no turn is still running: the turn never reached a terminal, so it was interrupted.
      const { body, clipped } = buildReportBody({ outcome: 'failed', interrupted: true });
      return convert({ sessionId, turnId, outcome: 'failed', body, clipped, errorCode: null });
    }
    return release(sessionId, turnId); // the turn never started
  }

  // Disables reporting for a child whose parent is gone, then settles every reservation. Never throws.
  function repairSession(sessionId, liveIds) {
    try {
      const read = mail.read(sessionId);
      if (!read.ok || read.frozen) return;
      const parentId = getSessionSummary(sessionId)?.spawned_from?.parent_session_id;
      if (parentId && read.mail.reporting_enabled === true && !liveIds.has(parentId)) {
        const result = mail.mutate(sessionId, ({ mail: current }) => ({ mail: { ...current, reporting_enabled: false } }));
        if (result.ok && !result.noop) notify(sessionId);
      }
      for (const reservation of read.mail.report_reservations) {
        try {
          repairReservation(sessionId, read, reservation);
        } catch {
          log('WARN', 'chat_messaging.report_repair_failed', { reason: 'exception' });
        }
      }
    } catch {
      log('WARN', 'chat_messaging.report_repair_failed', { reason: 'exception' });
    }
  }

  return { convertReport, repairSession, setReporting };
}

module.exports = { createReportOps };
