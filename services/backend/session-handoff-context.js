'use strict';

// The first-turn handoff context row of a linked chat (row 59 checkpoint 5a-1, slice S3).
// The Background the source chat prepared becomes ONE canonical `role:'context'` row,
// kind `session_handoff`, inserted just before the child's first user anchor (decision D6).
// Pure builders/validators first, then the fail-closed admission: unlike session mail, which is
// best-effort, a first turn that was handed a Background never runs without it. Nothing here
// logs the Background text; errors carry ids and reason codes only.

const {
  bodySha256, contextRowsEquivalent, isId, isPlainObject, validateBody, validateContextRow,
} = require('./session-message-envelope');

const HANDOFF_ROW_KIND = 'session_handoff';
const HANDOFF_ROW_PREFIX = 'ctxh_';
const MAX_HANDOFF_BODY_BYTES = 32 * 1024;
const PROPOSAL_ID_RE = /^proposal_[0-9a-f]{64}$/;
const ATTEMPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDOFF_KEYS = Object.freeze([
  'schema_version', 'proposal_id', 'source_session_id', 'source_session_incarnation', 'body', 'body_sha256',
]);
const PREPARATION_KEYS = Object.freeze(['proposal_id', 'attempt_id']);
// `application_turn` on the preparation turn's persisted user message. Only the New session card
// can run that turn again: a plain Retry or Edit would replay its label as an ordinary prompt,
// without the trusted preparation field, so complete_session_handoff could never be called.
const APPLICATION_TURN_HANDOFF_PREPARATION = 'handoff_preparation';
// Stable reason codes of a failed admission (the turn fails visibly; none is a user-facing sentence).
const HANDOFF_ERROR_CODES = Object.freeze({
  INVALID: 'session_handoff_invalid',
  NOT_NEGOTIATED: 'session_handoff_not_negotiated',
  INSERT_FAILED: 'session_handoff_insert_failed',
  MISSING: 'session_handoff_missing',
  UNFLUSHED: 'session_handoff_unflushed',
});

const hasExactKeys = (value, keys) => Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));

// {proposal_id, attempt_id} for the trusted handoff-only preparation turn, else null.
function normalizeHandoffPreparation(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, PREPARATION_KEYS)) return null;
  const { proposal_id: proposalId, attempt_id: attemptId } = value;
  if (typeof proposalId !== 'string' || !PROPOSAL_ID_RE.test(proposalId)
    || typeof attemptId !== 'string' || !ATTEMPT_ID_RE.test(attemptId)) return null;
  return { proposal_id: proposalId, attempt_id: attemptId };
}

// The canonical clone of a closed, self-consistent `session_handoff` object (spec 1.12), else null.
// The body may not be empty: an empty Background sends no row at all.
function normalizeSessionHandoff(value) {
  if (!isPlainObject(value) || value.schema_version !== 1 || !hasExactKeys(value, HANDOFF_KEYS)) return null;
  if (typeof value.proposal_id !== 'string' || !PROPOSAL_ID_RE.test(value.proposal_id)) return null;
  if (!isId(value.source_session_id) || !isId(value.source_session_incarnation)) return null;
  if (!validateBody(value.body, { maxBytes: MAX_HANDOFF_BODY_BYTES }).ok) return null;
  if (value.body_sha256 !== bodySha256(value.body)) return null;
  return structuredClone(value);
}

// The request-side object built from the accepted Background (the app owns the digest).
function buildSessionHandoff({ proposalId, sourceSessionId, sourceSessionIncarnation, body } = {}) {
  return normalizeSessionHandoff({
    schema_version: 1,
    proposal_id: proposalId,
    source_session_id: sourceSessionId,
    source_session_incarnation: sourceSessionIncarnation,
    body,
    body_sha256: typeof body === 'string' ? bodySha256(body) : undefined,
  });
}

const handoffRowId = (proposalId) => `${HANDOFF_ROW_PREFIX}${String(proposalId).slice('proposal_'.length)}`;

// The canonical child-transcript row; null for an invalid handoff or turn id.
function buildHandoffRow(handoff, { turn_id: turnId, timestamp } = {}) {
  const valid = normalizeSessionHandoff(handoff);
  if (!valid || !isId(turnId)) return null;
  return {
    id: handoffRowId(valid.proposal_id),
    role: 'context',
    kind: HANDOFF_ROW_KIND,
    content: valid.body,
    session_handoff: valid,
    turn_id: turnId,
    timestamp: timestamp instanceof Date ? timestamp.toISOString() : (timestamp ?? new Date().toISOString()),
  };
}

// The row itself when it is a valid canonical handoff row, else null. Normalized store rows
// carry extra default fields; only the contract fields are checked.
function validateHandoffRow(row) {
  if (!isPlainObject(row) || row.role !== 'context' || row.kind !== HANDOFF_ROW_KIND) return null;
  const handoff = normalizeSessionHandoff(row.session_handoff);
  if (!handoff || row.content !== handoff.body || row.id !== handoffRowId(handoff.proposal_id)) return null;
  if (!isId(row.turn_id) || typeof row.timestamp !== 'string' || row.timestamp.length === 0) return null;
  if (row.disposition !== undefined && row.disposition !== '') return null;
  return row;
}

// Same canonical row under the same id, ignoring timestamp and event_seq (idempotent re-insert).
function handoffRowsEquivalent(existing, incoming) {
  if (!validateHandoffRow(existing) || !validateHandoffRow(incoming)) return false;
  return existing.id === incoming.id && existing.content === incoming.content && existing.turn_id === incoming.turn_id
    && existing.session_handoff.body_sha256 === incoming.session_handoff.body_sha256
    && existing.session_handoff.source_session_id === incoming.session_handoff.source_session_id
    && existing.session_handoff.source_session_incarnation === incoming.session_handoff.source_session_incarnation;
}

// The two context-row families share one dispatch so the store's insert plan and message
// normalization accept either: session mail (`session_message`, receipts) and the handoff row.
function validateAnyContextRow(row) {
  if (row && row.kind === HANDOFF_ROW_KIND) return validateHandoffRow(row);
  return validateContextRow(row);
}

function anyContextRowsEquivalent(existing, incoming) {
  if (existing?.kind === HANDOFF_ROW_KIND || incoming?.kind === HANDOFF_ROW_KIND) return handoffRowsEquivalent(existing, incoming);
  return contextRowsEquivalent(existing, incoming);
}

// ---------- fail-closed admission ----------

function handoffError(code) {
  return Object.assign(new Error('The session handoff context could not be prepared for this turn.'), {
    code, reason: code, retryable: false, user_visible: true,
  });
}

function logWarn(service, event, details) {
  try { service?._emitServiceLog?.('WARN', event, details); } catch { /* diagnostics never change the turn */ }
}

function flushed(sessionStore, sessionId) {
  try { return sessionStore.flushSession(sessionId) === true; } catch { return false; }
}

// Places the row for this turn and returns it; THROWS a coded error on any failure (never best-effort).
//   brandNew  true: insert before the user anchor (idempotent by id) and flush before dispatch.
//   brandNew false (checkpoint resume, edit/failure retry): the first attempt's row (any turn id) must already be there.
// Test seam: `supportsHandoff` (function) replaces the negotiated-capability read of service.sidecarClient.
function admitSessionHandoffForTurn({
  service, sessionId, turnId, userMessageId, handoff, brandNew = true, lease = null, supportsHandoff,
} = {}) {
  const run = () => {
    const sessionStore = service?.sessionStore;
    const valid = normalizeSessionHandoff(handoff);
    if (!valid || !sessionStore || !sessionId || !turnId || !userMessageId) throw handoffError(HANDOFF_ERROR_CODES.INVALID);
    // Required lazily: message normalization loads this module and must stay free of the runtime protocol.
    const supported = typeof supportsHandoff === 'function' ? supportsHandoff()
      : require('../session-runtime/inference-protocol').supportsSessionHandoffContext(service?.sidecarClient);
    if (!supported) throw handoffError(HANDOFF_ERROR_CODES.NOT_NEGOTIATED);
    const row = buildHandoffRow(valid, { turn_id: turnId });
    if (!row) throw handoffError(HANDOFF_ERROR_CODES.INVALID);
    if (!brandNew) {
      // The earlier attempt placed the row under its own turn id; the retry only has to find that same row.
      const present = (sessionStore.getSession(sessionId)?.messages || []).find((message) => message?.id === row.id);
      if (!present || !handoffRowsEquivalent(present, { ...row, turn_id: present.turn_id })) throw handoffError(HANDOFF_ERROR_CODES.MISSING);
      return present;
    }
    let inserted;
    try { inserted = sessionStore.insertMessagesBefore(sessionId, userMessageId, [row]); } catch { inserted = null; }
    if (!inserted) {
      logWarn(service, 'chat.session_handoff_insert_refused', { sessionId, turnId });
      throw handoffError(HANDOFF_ERROR_CODES.INSERT_FAILED);
    }
    // Durable before dispatch: an unflushed row could vanish across a crash and let the retry run without it.
    if (!flushed(sessionStore, sessionId)) {
      logWarn(service, 'chat.session_handoff_unflushed', { sessionId, turnId });
      const kept = (sessionStore.getSession(sessionId)?.messages || []).filter((message) => message?.id !== row.id);
      try { sessionStore.updateSession(sessionId, { messages: kept, message_count: kept.length }); } catch { /* the turn fails anyway */ }
      throw handoffError(HANDOFF_ERROR_CODES.UNFLUSHED);
    }
    return row;
  };
  const actors = service?.sessionTurnActors;
  return lease && typeof actors?.guard === 'function' ? actors.guard(lease, 'managed.session_handoff_admission', run) : run();
}

module.exports = {
  APPLICATION_TURN_HANDOFF_PREPARATION,
  HANDOFF_ERROR_CODES,
  HANDOFF_KEYS,
  HANDOFF_ROW_KIND,
  HANDOFF_ROW_PREFIX,
  MAX_HANDOFF_BODY_BYTES,
  PROPOSAL_ID_RE,
  admitSessionHandoffForTurn,
  anyContextRowsEquivalent,
  buildHandoffRow,
  buildSessionHandoff,
  handoffRowId,
  handoffRowsEquivalent,
  normalizeHandoffPreparation,
  normalizeSessionHandoff,
  validateAnyContextRow,
  validateHandoffRow,
};
