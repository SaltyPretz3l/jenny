'use strict';

/* services/chat-messaging-projection.js - ordering and renderer projections of the
 * mail lists (row 59 checkpoint 4): inbox items (inbox records plus discard
 * receipts, ascending receive sequence) and outbox operations (newest first).
 * Pure over injected readers. Titles and project names come from the live
 * metadata at projection time, never from a snapshot; a deleted chat projects as
 * `{available:false}`. Bodies appear only for the owning chat's own mail.
 */

const E = require('./backend/session-message-envelope');
const { projectSessionRef } = require('./chat-messaging-recipients');

function sortedInbox(mail) {
  return [...mail.inbox, ...mail.discarded]
    .map((record) => ({ record, key: [record.receive_sequence] }))
    .sort((a, b) => a.key[0] - b.key[0])
    .map((entry) => ({ ...entry, after: (key) => entry.key[0] > key[0] }));
}

// Newest first by prepared time. Drafts that never became a send are not listed: prepared
// operations past their expiry, and cancelled ones that were never requested (a cancelled
// draft or an expired one swept to cancelled).
function sortedOutbox(mail, nowMs) {
  const live = mail.outbox.filter((op) => !(op.state === 'prepared' && op.expires_at !== null && Date.parse(op.expires_at) <= nowMs)
    && !(op.state === 'cancelled' && op.send_requested_at === null));
  return live
    .map((record) => ({ record, key: [record.prepared_at, record.operation_id] }))
    .sort((a, b) => (a.key[0] === b.key[0] ? (a.key[1] < b.key[1] ? 1 : -1) : (a.key[0] < b.key[0] ? 1 : -1)))
    .map((entry) => ({
      ...entry,
      after: (key) => entry.key[0] < key[0] || (entry.key[0] === key[0] && entry.key[1] < key[1]),
    }));
}

function createProjector({ getSessionSummary, getProjectName, getSessionMessages }) {
  const ref = (sessionId) => projectSessionRef(sessionId, getSessionSummary(sessionId), getProjectName);

  function projectOperation(op) {
    const { envelope } = op;
    return {
      operation_id: op.operation_id,
      message_id: envelope.message_id,
      state: op.state,
      envelope,
      envelope_sha256: E.envelopeSha256(envelope),
      source: ref(envelope.source_session_id),
      destination: ref(envelope.destination_session_id),
      prepared_at: op.prepared_at,
      expires_at: op.expires_at,
      send_requested_at: op.send_requested_at,
      delivered_at: op.delivered_at,
      destination_receipt_id: op.destination_receipt_id,
      last_error: op.last_error,
      restore_requires_confirmation: op.restore_requires_confirmation === true,
    };
  }

  function projectInboxRecord(record) {
    return {
      message_id: record.envelope.message_id,
      receipt_id: record.receipt_id,
      receive_sequence: record.receive_sequence,
      delivered_at: record.delivered_at,
      read_at: record.read_at,
      source_receipt_confirmed_at: record.source_receipt_confirmed_at,
      source_absent: record.source_absent,
      envelope: record.envelope,
      context: record.context,
      source: ref(record.envelope.source_session_id),
    };
  }

  // A discard receipt keeps no body of its own; the canonical receipt row carries the envelope.
  function projectDiscardReceipt(record, rows) {
    const row = E.validateContextRow(rows.get(record.canonical_message_id));
    const envelope = row ? row.session_message : null;
    return {
      message_id: record.message_id,
      receipt_id: record.receipt_id,
      receive_sequence: record.receive_sequence,
      delivered_at: null,
      read_at: null,
      source_receipt_confirmed_at: record.source_receipt_confirmed_at,
      source_absent: record.source_absent,
      envelope,
      context: { state: 'discarded', discarded_at: record.discarded_at },
      source: envelope ? ref(envelope.source_session_id) : null,
    };
  }

  function projectInboxPage(sessionId, records) {
    let rows = new Map();
    if (records.some((record) => record.canonical_message_id)) {
      try { rows = new Map((getSessionMessages(sessionId) || []).map((row) => [row?.id, row])); } catch { rows = new Map(); }
    }
    return records.map((record) => (record.canonical_message_id ? projectDiscardReceipt(record, rows) : projectInboxRecord(record)));
  }

  return { projectInboxPage, projectOperation };
}

module.exports = { createProjector, sortedInbox, sortedOutbox };
