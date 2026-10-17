'use strict';

/* services/chat-messaging-grants.js - authorizations of addressed session messages (row 59
 * checkpoint 5b-2): the AuthorizationRecord builders for a user send and an agent one-off, the
 * directional-grant projections (`consent_event_id` is never projected) and the real
 * `chatMessages.createGrant` / `revokeGrant`.
 *
 * A directional grant means "allow messages in this direction for seven days": at most 32 live
 * ones per source, 100 sends each, a human purpose of 1-512 UTF-8 bytes. createGrant is
 * idempotent by its gesture id through a coordination receipt written in the same flushed
 * mutation as the record. Every state change is one synchronous mail mutation with no await
 * inside. Diagnostics carry ids and reason tokens only, never purposes or message bodies.
 */

const { MAIL_LIMITS, isLiveGrant, liveGrantCount, pruneMail } = require('./backend/session-mail-records');
const { appendReceipt, buildReceipt, replayVerdict } = require('./backend/coordination-receipts');
const contract = require('./chat-messaging-contract');

const { fail, succeed } = contract;
const CREATE_GRANT_METHOD = 'chatMessages.createGrant';

function baseAuthorization(envelope, authorizationId, kind, consentEventId, at) {
  return {
    schema_version: 1,
    authorization_id: authorizationId,
    kind,
    source_session_id: envelope.source_session_id,
    source_session_incarnation: envelope.source_session_incarnation,
    source_project_id: envelope.source_project_id,
    destination_session_id: envelope.destination_session_id,
    destination_session_incarnation: envelope.destination_session_incarnation,
    destination_project_id: envelope.destination_project_id,
    operation_id: null,
    body_sha256: null,
    purpose: null,
    consent_event_id: consentEventId,
    created_at: at.toISOString(),
    expires_at: null,
    remaining_sends: 0,
    revoked_at: null,
  };
}

// The exact-body authorization a user Send consumes (created with the pending transition).
function userSendAuthorization(op, authorizationId, at) {
  return {
    ...baseAuthorization(op.envelope, authorizationId, 'user_send', `send:${op.operation_id}`, at),
    operation_id: op.operation_id,
    body_sha256: op.envelope.body_sha256,
  };
}

// The one-off per-send approval of an agent message (`consentEventId` = the scoped approval id).
function agentOnceAuthorization(op, authorizationId, consentEventId, at) {
  return {
    ...baseAuthorization(op.envelope, authorizationId, 'agent_once', consentEventId, at),
    operation_id: op.operation_id,
    body_sha256: op.envelope.body_sha256,
  };
}

// A grant for the trusted UI: the full control record minus the consent id.
function projectGrant(auth) {
  const { consent_event_id: consentEventId, ...grant } = auth;
  return grant;
}

const grantSummary = (auth) => (auth ? {
  grant_id: auth.authorization_id, purpose: auth.purpose, expires_at: auth.expires_at, remaining_sends: auth.remaining_sends,
} : null);

// What the model may see of a grant: id, expiry and remaining count only.
const modelGrant = (auth) => (auth ? { grant_id: auth.authorization_id, expires_at: auth.expires_at, remaining_sends: auth.remaining_sends } : null);

// The live grant covering exactly this direction (identities and projects on both ends), latest expiry first.
// source / destination = {id, incarnation, project_id}.
function bestLiveGrant(mail, { source, destination, now }) {
  const covering = (mail?.authorizations || []).filter((auth) => isLiveGrant(auth, now)
    && auth.source_session_id === source.id && auth.source_session_incarnation === source.incarnation
    && auth.source_project_id === (source.project_id ?? null) && auth.destination_session_id === destination.id
    && auth.destination_session_incarnation === destination.incarnation
    && auth.destination_project_id === (destination.project_id ?? null));
  covering.sort((a, b) => (a.expires_at === b.expires_at ? (a.created_at < b.created_at ? 1 : -1) : (a.expires_at < b.expires_at ? 1 : -1)));
  return covering[0] || null;
}

// listRecipients' per-chat lookup for the calling source: its live grant to that chat, as the trusted UI sees it.
function recipientGrantLookup(sourceRead, sourceSessionId, now) {
  if (!sourceRead?.ok || sourceRead.frozen) return () => null;
  const source = { id: sourceSessionId, incarnation: sourceRead.session_incarnation, project_id: sourceRead.project_id };
  return (summary) => grantSummary(bestLiveGrant(sourceRead.mail, {
    source, destination: { id: summary.id, incarnation: summary.session_incarnation, project_id: summary.project_id || null }, now,
  }));
}

function createGrantOps({
  mail, getSessionSummary = () => null, isContinuable = () => true, now = () => new Date(), createId, notify = () => {},
  storeFailure, settlePending = () => {},
}) {
  const continuable = (sessionId) => {
    const summary = getSessionSummary(sessionId);
    try { return Boolean(summary) && isContinuable(summary) !== false; } catch { return false; }
  };

  function replayResult(read, args, req) {
    const verdict = replayVerdict(read.coordination_receipts, req.gesture_id, CREATE_GRANT_METHOD, args);
    if (verdict.state === 'none') return null;
    if (verdict.state === 'conflict') return fail('idempotency_conflict', { currentRevision: read.coordination_revision });
    const auth = read.mail.authorizations.find((entry) => entry.authorization_id === verdict.receipt.resource_id);
    return auth ? succeed({ grant: projectGrant(auth) }) : fail('stale_operation', { currentRevision: read.coordination_revision });
  }

  // Source / destination must be addressable and eligible. -> {ok:true, source, destination} | a failure envelope.
  function eligibleEnds(req, source) {
    if (source.archived || !continuable(req.source_session_id)) return fail('source_ineligible', { currentRevision: source.coordination_revision });
    const destination = mail.read(req.destination_session_id);
    if (!destination.ok) return fail(destination.reason === 'not_found' ? 'recipient_deleted' : 'unavailable');
    if (destination.frozen) return fail('unavailable');
    if (destination.archived) return fail('recipient_archived');
    if (!continuable(req.destination_session_id)) return fail('recipient_ineligible');
    // An empty incarnation cannot be bound into a grant: the chat is not addressable yet.
    if (!source.session_incarnation || !destination.session_incarnation) return fail('unavailable');
    return { ok: true, destination };
  }

  async function createGrant(raw) {
    const checked = contract.validateCreateGrantRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const req = checked.value;
    if (req.source_session_id === req.destination_session_id) return fail('self_send');
    const source = mail.read(req.source_session_id);
    if (!source.ok) return fail(source.reason === 'not_found' ? 'not_found' : 'unavailable');
    if (source.frozen) return fail('unavailable', { currentRevision: source.coordination_revision });
    const args = { source_session_id: req.source_session_id, destination_session_id: req.destination_session_id, purpose: req.purpose };
    const replay = replayResult(source, args, req);
    if (replay) return replay;
    const ends = eligibleEnds(req, source);
    if (!ends.ok) return ends;
    const at = now();
    const auth = {
      ...baseAuthorization({
        source_session_id: req.source_session_id,
        source_session_incarnation: source.session_incarnation,
        source_project_id: source.project_id,
        destination_session_id: req.destination_session_id,
        destination_session_incarnation: ends.destination.session_incarnation,
        destination_project_id: ends.destination.project_id,
      }, createId(), 'agent_directional', `grant:${req.gesture_id}`, at),
      purpose: req.purpose,
      expires_at: new Date(at.getTime() + MAIL_LIMITS.grant_ttl_ms).toISOString(),
      remaining_sends: MAIL_LIMITS.remaining_sends_max,
    };
    const result = mail.mutate(req.source_session_id, ({ mail: current, coordination_revision: revision, coordination_receipts: receipts }) => {
      if (replayVerdict(receipts, req.gesture_id, CREATE_GRANT_METHOD, args).state !== 'none') return { abort: { reason: 'exists' } };
      const next = pruneMail(current, { now: at });
      if (liveGrantCount(next, at) >= MAIL_LIMITS.live_grants_per_source) return { abort: { reason: 'capacity' } };
      next.authorizations.push(auth);
      const receipt = buildReceipt({
        mutationId: req.gesture_id, method: CREATE_GRANT_METHOD, args, resourceKind: 'authorization',
        resourceId: auth.authorization_id, acceptedRevision: revision + 1, now: at,
      });
      return { mail: next, coordination_receipts: appendReceipt(receipts, receipt, { now: at }) };
    });
    if (!result.ok) {
      if (result.aborted && result.reason === 'exists') return createGrant(raw);
      return storeFailure(result);
    }
    notify(req.source_session_id);
    return succeed({ grant: projectGrant(auth) });
  }

  // Idempotent: an already revoked grant answers with its record. Undelivered operations that rode the grant
  // fail `authorization_revoked` at their delivery check (a destination receipt still wins there).
  async function revokeGrant(raw) {
    const checked = contract.validateRevokeGrantRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const { source_session_id: sourceId, grant_id: grantId } = checked.value;
    const at = now();
    const result = mail.mutate(sourceId, ({ mail: current }) => {
      const index = current.authorizations.findIndex((auth) => auth.authorization_id === grantId && auth.kind === 'agent_directional');
      if (index < 0) return { abort: { reason: 'not_found' } };
      if (current.authorizations[index].revoked_at !== null) return { mail: current };
      const authorizations = current.authorizations.slice();
      authorizations[index] = { ...authorizations[index], revoked_at: at.toISOString() };
      return { mail: { ...current, authorizations } };
    });
    if (!result.ok) return storeFailure(result);
    if (!result.noop) notify(sourceId);
    for (const op of result.mail.outbox) {
      if (op.state === 'pending' && op.authorization_id === grantId) settlePending(sourceId, op.operation_id);
    }
    return succeed({ grant: projectGrant(result.mail.authorizations.find((auth) => auth.authorization_id === grantId)) });
  }

  return { createGrant, revokeGrant };
}

module.exports = {
  agentOnceAuthorization, bestLiveGrant, createGrantOps, grantSummary, modelGrant, projectGrant, recipientGrantLookup,
  userSendAuthorization,
};
