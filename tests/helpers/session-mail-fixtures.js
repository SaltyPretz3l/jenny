'use strict';

// Valid addressed-message records for the session_mail tests (row 59 checkpoint 4).

const E = require('../../services/backend/session-message-envelope');

const NOW = new Date('2026-10-15T10:00:00.000Z');
const SRC = { session_id: 'sess_src', session_incarnation: 'inc_src', project_id: null };
const DST = { session_id: 'sess_dst', session_incarnation: 'inc_dst', project_id: 'proj_1' };
const uuid = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (offsetMs = 0) => new Date(NOW.getTime() + offsetMs).toISOString();

function makeEnvelope(n = 1, { body = `hello ${n}`, source = {}, destination = {}, created_at: createdAt } = {}) {
  const envelope = E.buildUserEnvelope({
    message_id: uuid(n),
    source: { session_id: 'sess_src', session_incarnation: 'inc_src', project_id: null, ...source },
    destination: { session_id: 'sess_dst', session_incarnation: 'inc_dst', project_id: 'proj_1', ...destination },
    body,
    created_at: createdAt || iso(),
  });
  if (!envelope) throw new Error('fixture envelope invalid');
  return envelope;
}

function makeOutbox(n = 1, overrides = {}, envelopeOptions = {}) {
  return {
    envelope: makeEnvelope(n, envelopeOptions),
    operation_id: uuid(1000 + n),
    gesture_id: uuid(2000 + n),
    tool_call_id: null,
    authorization_id: null,
    state: 'prepared',
    prepared_at: iso(),
    expires_at: iso(24 * 60 * 60 * 1000),
    send_requested_at: null,
    delivered_at: null,
    destination_receipt_id: null,
    last_error: null,
    restore_requires_confirmation: false,
    ...overrides,
  };
}

function makeInbox(n = 1, overrides = {}, envelopeOptions = {}) {
  return {
    envelope: makeEnvelope(n, envelopeOptions),
    receipt_id: uuid(3000 + n),
    receive_sequence: n,
    delivered_at: iso(),
    read_at: null,
    source_receipt_confirmed_at: null,
    source_absent: false,
    context: { state: 'queued' },
    ...overrides,
  };
}

function makeDiscard(n = 1, overrides = {}) {
  const envelope = makeEnvelope(n);
  return {
    schema_version: 1,
    message_id: envelope.message_id,
    envelope_sha256: E.envelopeSha256(envelope),
    receipt_id: uuid(4000 + n),
    receive_sequence: n,
    discarded_at: iso(),
    source_receipt_confirmed_at: null,
    source_absent: false,
    canonical_message_id: `ctxr_${envelope.message_id}`,
    ...overrides,
  };
}

function makeAuthorization(n = 1, overrides = {}) {
  const envelope = makeEnvelope(n);
  return {
    schema_version: 1,
    authorization_id: uuid(5000 + n),
    kind: 'user_send',
    source_session_id: envelope.source_session_id,
    source_session_incarnation: envelope.source_session_incarnation,
    source_project_id: envelope.source_project_id,
    destination_session_id: envelope.destination_session_id,
    destination_session_incarnation: envelope.destination_session_incarnation,
    destination_project_id: envelope.destination_project_id,
    operation_id: uuid(1000 + n),
    body_sha256: envelope.body_sha256,
    purpose: null,
    consent_event_id: `send:${uuid(1000 + n)}`,
    created_at: iso(),
    expires_at: null,
    remaining_sends: 0,
    revoked_at: null,
    ...overrides,
  };
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// A valid directional grant (`sess_src` -> `sess_dst`): created now, seven days, 100 sends.
function makeGrant(n = 1, overrides = {}) {
  const envelope = makeEnvelope(n);
  return {
    schema_version: 1,
    authorization_id: uuid(8000 + n),
    kind: 'agent_directional',
    source_session_id: envelope.source_session_id,
    source_session_incarnation: envelope.source_session_incarnation,
    source_project_id: envelope.source_project_id,
    destination_session_id: envelope.destination_session_id,
    destination_session_incarnation: envelope.destination_session_incarnation,
    destination_project_id: envelope.destination_project_id,
    operation_id: null,
    body_sha256: null,
    purpose: 'hand over review notes',
    consent_event_id: `grant:${uuid(8100 + n)}`,
    created_at: iso(),
    expires_at: iso(WEEK_MS),
    remaining_sends: 100,
    revoked_at: null,
    ...overrides,
  };
}

// A valid agent_message envelope written by `turn_1` of `sess_src`.
function makeAgentEnvelope(n = 1, { body = `agent ${n}`, turnId = 'turn_1', source = {}, destination = {} } = {}) {
  const envelope = E.buildAgentEnvelope({
    message_id: uuid(n),
    source: { ...SRC, ...source },
    destination: { ...DST, ...destination },
    turnId,
    body,
    created_at: iso(),
  });
  if (!envelope) throw new Error('fixture agent envelope invalid');
  return envelope;
}

// A prepared agent operation for tool call `call_<n>` (override state / authorization_id as needed).
function makeAgentOutbox(n = 1, overrides = {}, envelopeOptions = {}) {
  return {
    ...makeOutbox(n, { gesture_id: null, tool_call_id: `call_${n}`, ...overrides }),
    envelope: makeAgentEnvelope(n, envelopeOptions),
  };
}

function makeSnapshot(n = 1, overrides = {}) {
  return {
    schema_version: 1,
    snapshot_id: uuid(6000 + n),
    turn_id: `turn_${n}`,
    cutoff_receive_sequence: 1,
    entries: [{ message_id: uuid(1), body_sha256: makeEnvelope(1).body_sha256 }],
    deferred_count: 0,
    deferred_reason: null,
    estimator_id: 'js_chars4_msg4_session_message_v1',
    state: 'published',
    created_at: iso(n * 1000),
    ...overrides,
  };
}


// A valid strict `spawned_from` for a child whose parent is `sess_dst`.
function makeSpawnedFrom(overrides = {}) {
  return {
    schema_version: 1,
    parent_session_id: DST.session_id,
    parent_session_incarnation: DST.session_incarnation,
    proposal_id: `proposal_${'a'.repeat(64)}`,
    created_at: iso(),
    child_creation_hash: 'b'.repeat(64),
    reporting_consent_id: uuid(7001),
    ...overrides,
  };
}

// A valid ReportReservation for the child `sess_src` reporting to `sess_dst`.
function makeReservation(n = 1, overrides = {}) {
  return {
    turn_id: `turn_${n}`,
    slot_bytes: 8192,
    reserved_at: iso(),
    parent_session_id: DST.session_id,
    parent_session_incarnation: DST.session_incarnation,
    reporting_consent_id: uuid(7001),
    ...overrides,
  };
}

// A valid terminal_report envelope from `sess_src` to `sess_dst` for turn `turn_<n>`.
function makeReportEnvelope(n = 1, {
  body = `report ${n}`, outcome = 'completed', clipped = false, errorCode = null, turnId = `turn_${n}`,
} = {}) {
  const envelope = E.buildReportEnvelope({
    child: SRC, parent: DST, turnId, outcome, body, clipped, errorCode, messageId: uuid(n), createdAt: iso(),
  });
  if (!envelope) throw new Error('fixture report envelope invalid');
  return envelope;
}

function emptyMail(extra = {}) {
  return {
    schema_version: 1,
    next_receive_sequence: 1,
    inbox: [],
    discarded: [],
    outbox: [],
    authorizations: [],
    report_reservations: [],
    admission_snapshots: [],
    reporting_enabled: false,
    ...extra,
  };
}

module.exports = {
  DST, NOW, SRC, WEEK_MS, emptyMail, iso, makeAgentEnvelope, makeAgentOutbox, makeAuthorization, makeDiscard, makeEnvelope,
  makeGrant, makeInbox, makeOutbox, makeReportEnvelope, makeReservation, makeSnapshot, makeSpawnedFrom, uuid,
};
