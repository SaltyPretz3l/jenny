'use strict';

/* services/chat-messaging-agent.js - the agent-authored half of addressed session messaging (row 59
 * checkpoint 5b-2): what the `session_message` model tool calls.
 *   listAgentTargets  destinations covered by a live directional grant, plus the immediate parent a linked
 *                     chat reports to (reporting-only unless a grant also covers it);
 *   agentPrepare      an immutable `prepared` agent_message operation, idempotent by (incarnation, turn,
 *                     tool call), at most 8 new sends per source turn, 16 KiB body;
 *   agentSend         ONE mutation that re-reads the source and the authorization, spends a grant or
 *                     records a one-off approval, moves the operation to `pending` with a coordination
 *                     receipt, then delivers through the existing delivery transaction;
 *   agentCancel       cancels a still-prepared operation (the deny / timeout path);
 *   agentRead         an included inbox message of this chat (never queued, excluded or reserved mail).
 * Every state change is one synchronous mail mutation with no await inside. Diagnostics carry ids and
 * reason tokens only, never message bodies, titles or purposes.
 */

const E = require('./backend/session-message-envelope');
const {
  MAIL_LIMITS, authorizationBlocked, countAgentSendsForTurn, findAgentOperation, isLiveGrant, outboxCapacity, pruneMail,
} = require('./backend/session-mail-records');
const { appendReceipt, buildReceipt } = require('./backend/coordination-receipts');
const contract = require('./chat-messaging-contract');
const { agentOnceAuthorization, bestLiveGrant, modelGrant } = require('./chat-messaging-grants');
const { projectSessionRef } = require('./chat-messaging-recipients');

const { fail, succeed } = contract;
const SEND_METHOD = 'session_message.send';
const hasKeys = (value, keys) => contract.isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function validAuthorization(value) {
  if (hasKeys(value, ['kind', 'grant_id'])) return value.kind === 'grant' && contract.validUuid(value.grant_id);
  return hasKeys(value, ['kind', 'consent_event_id']) && value.kind === 'once' && E.isId(value.consent_event_id);
}

function createAgentOps({
  mail, getSessionSummary = () => null, getProjectName = () => null, isContinuable = () => true, now = () => new Date(),
  createId, notify = () => {}, storeFailure, runDelivery, projectOperation, track = () => {},
}) {
  const continuable = (sessionId) => {
    const summary = getSessionSummary(sessionId);
    try { return Boolean(summary) && isContinuable(summary) !== false; } catch { return false; }
  };
  const destinationView = (sessionId) => {
    const ref = projectSessionRef(sessionId, getSessionSummary(sessionId), getProjectName);
    return { session_id: sessionId, title: ref.title ?? '', project_label: ref.project_name };
  };
  const endpoint = (read, sessionId) => ({ id: sessionId, incarnation: read.session_incarnation, project_id: read.project_id });

  // The bound source: a readable, unfrozen chat whose incarnation is the one the tool call carries.
  function readSource(sourceSessionId, sourceIncarnation) {
    if (!contract.validSessionId(sourceSessionId) || !E.isId(sourceIncarnation)) return fail('invalid_request');
    const read = mail.read(sourceSessionId);
    if (!read.ok) return fail(read.reason === 'not_found' ? 'not_found' : 'unavailable');
    if (read.frozen) return fail('unavailable', { currentRevision: read.coordination_revision });
    if (read.session_incarnation !== sourceIncarnation) return fail('stale_operation', { currentRevision: read.coordination_revision });
    return { ok: true, read };
  }

  // The recipient must exist, be unarchived, continuable and addressable. -> {ok:true, read} | failure envelope.
  function readDestination(destinationSessionId) {
    const read = mail.read(destinationSessionId);
    if (!read.ok) return fail(read.reason === 'not_found' ? 'recipient_deleted' : 'unavailable');
    if (read.frozen || !read.session_incarnation) return fail('unavailable');
    if (read.archived) return fail('recipient_archived');
    if (!continuable(destinationSessionId)) return fail('recipient_ineligible');
    return { ok: true, read };
  }

  // ---- list_targets -----------------------------------------------------------------

  // A grant still names the destination chat as it is now (same incarnation and project).
  function grantTarget(auth, sessionId) {
    const summary = getSessionSummary(sessionId);
    if (!summary || summary.archived_at || !continuable(sessionId)) return null;
    const matches = summary.session_incarnation === auth.destination_session_incarnation
      && (summary.project_id || null) === auth.destination_project_id;
    return matches ? auth : null;
  }

  async function listAgentTargets({ sourceSessionId, sourceIncarnation } = {}) {
    const bound = readSource(sourceSessionId, sourceIncarnation);
    if (!bound.ok) return bound;
    const { read } = bound;
    const at = now();
    const entries = new Map(); // destination id -> grant | null
    const live = read.mail.authorizations.filter((auth) => isLiveGrant(auth, at) && auth.source_session_id === sourceSessionId
      && auth.source_session_incarnation === read.session_incarnation && auth.source_project_id === read.project_id);
    for (const auth of live) {
      const id = auth.destination_session_id;
      const best = bestLiveGrant(read.mail, {
        source: endpoint(read, sourceSessionId),
        destination: { id, incarnation: auth.destination_session_incarnation, project_id: auth.destination_project_id },
        now: at,
      });
      if (grantTarget(best, id)) entries.set(id, best);
    }
    const parentId = getSessionSummary(sourceSessionId)?.spawned_from?.parent_session_id;
    if (parentId && read.mail.reporting_enabled === true && !entries.has(parentId)) {
      const summary = getSessionSummary(parentId);
      if (summary && !summary.archived_at && continuable(parentId)) entries.set(parentId, null);
    }
    const targets = [...entries].map(([id, grant]) => ({
      ...destinationView(id), free_form_allowed: grant !== null, grant: modelGrant(grant),
    })).sort((a, b) => (a.title === b.title ? (a.session_id < b.session_id ? -1 : 1) : (a.title < b.title ? -1 : 1)));
    return succeed({ targets });
  }

  // ---- prepare ----------------------------------------------------------------------

  function prepareResult(record, read, created, at) {
    const { envelope } = record;
    const grant = bestLiveGrant(read.mail, {
      source: endpoint(read, envelope.source_session_id),
      destination: { id: envelope.destination_session_id, incarnation: envelope.destination_session_incarnation, project_id: envelope.destination_project_id },
      now: at,
    });
    return succeed({
      operation_id: record.operation_id,
      envelope_sha256: E.envelopeSha256(envelope),
      created,
      state: record.state,
      grant: modelGrant(grant),
      destination: destinationView(envelope.destination_session_id),
    });
  }

  function validPrepare(args) {
    return contract.validSessionId(args.destinationSessionId) && E.isId(args.turnId) && E.isId(args.toolCallId)
      && E.validateBody(args.body).ok;
  }

  async function agentPrepare(args = {}) {
    if (!validPrepare(args)) return fail('invalid_request');
    const { sourceSessionId, sourceIncarnation, turnId, toolCallId, destinationSessionId, body } = args;
    const bound = readSource(sourceSessionId, sourceIncarnation);
    if (!bound.ok) return bound;
    const { read } = bound;
    const identity = { incarnation: sourceIncarnation, turnId, toolCallId };
    const at = now();
    const existing = findAgentOperation(read.mail, identity);
    if (existing) {
      const same = existing.envelope.destination_session_id === destinationSessionId && existing.envelope.body === body;
      return same ? prepareResult(existing, read, false, at) : fail('idempotency_conflict', { currentRevision: read.coordination_revision });
    }
    if (sourceSessionId === destinationSessionId) return fail('self_send');
    if (read.archived || !continuable(sourceSessionId)) return fail('source_ineligible', { currentRevision: read.coordination_revision });
    const destination = readDestination(destinationSessionId);
    if (!destination.ok) return destination;
    const envelope = E.buildAgentEnvelope({
      message_id: createId(),
      source: { session_id: sourceSessionId, session_incarnation: read.session_incarnation, project_id: read.project_id },
      destination: { session_id: destinationSessionId, session_incarnation: destination.read.session_incarnation, project_id: destination.read.project_id },
      turnId,
      body,
      created_at: at,
    });
    if (!envelope) return fail('unavailable');
    const record = {
      envelope,
      operation_id: createId(),
      gesture_id: null,
      tool_call_id: toolCallId,
      authorization_id: null,
      state: 'prepared',
      prepared_at: at.toISOString(),
      expires_at: new Date(at.getTime() + MAIL_LIMITS.prepared_expiry_ms).toISOString(),
      send_requested_at: null,
      delivered_at: null,
      destination_receipt_id: null,
      last_error: null,
      restore_requires_confirmation: false,
    };
    const result = mail.mutate(sourceSessionId, ({ mail: current, session }) => {
      if (findAgentOperation(current, identity)) return { abort: { reason: 'exists' } };
      if (session.archived || session.session_incarnation !== sourceIncarnation || session.project_id !== read.project_id) {
        return { abort: { reason: 'stale_operation' } };
      }
      const next = pruneMail(current, { now: at });
      if (countAgentSendsForTurn(next, identity) >= MAIL_LIMITS.agent_sends_per_turn) return { abort: { reason: 'turn_send_limit' } };
      if (outboxCapacity(next, envelope).full) return { abort: { reason: 'sender_backpressure' } };
      next.outbox.push(record);
      return { mail: next };
    });
    if (!result.ok) {
      if (result.aborted && result.reason === 'exists') return agentPrepare(args);
      return storeFailure(result);
    }
    track(record.operation_id, sourceSessionId);
    notify(sourceSessionId);
    return prepareResult(record, { ...read, mail: result.mail }, true, at);
  }

  // ---- send -------------------------------------------------------------------------

  // Spends the named grant: -> {authorizations, authorizationId} | {reason}.
  function spendGrant(current, grantId, envelope, session, at) {
    const index = current.authorizations.findIndex((auth) => auth.authorization_id === grantId && auth.kind === 'agent_directional');
    if (index < 0) return { reason: 'authorization_required' };
    const auth = current.authorizations[index];
    const ends = {
      source: { session_incarnation: session.session_incarnation, project_id: session.project_id },
      destination: { session_incarnation: envelope.destination_session_incarnation, project_id: envelope.destination_project_id },
    };
    if (authorizationBlocked(auth, envelope, ends, at)) {
      const ended = auth.revoked_at !== null || Date.parse(auth.expires_at) <= at.getTime();
      return { reason: ended ? 'authorization_revoked' : 'authorization_required' };
    }
    if (auth.remaining_sends < 1) return { reason: 'authorization_required' };
    const authorizations = current.authorizations.slice();
    authorizations[index] = { ...auth, remaining_sends: auth.remaining_sends - 1 };
    return { authorizations, authorizationId: grantId };
  }

  // The state a send may start from: a prepared operation, or one that failed `authorization_revoked`
  // (a fresh approval re-pends the SAME operation and body, never a replacement message).
  function sendableState(op, at) {
    if (op.state === 'prepared') return op.expires_at !== null && Date.parse(op.expires_at) <= at.getTime() ? 'expired' : null;
    return op.state === 'failed' && op.last_error?.reason === 'authorization_revoked' ? null : 'stale_operation';
  }

  function acceptSend({ mail: current, session, coordination_revision: revision, coordination_receipts: receipts },
    { operationId, authorization, at }) {
    const index = current.outbox.findIndex((record) => record.operation_id === operationId);
    const op = index < 0 ? null : current.outbox[index];
    if (!op || op.envelope.kind !== 'agent_message') return { abort: { reason: 'stale_operation' } };
    if (['pending', 'delivered'].includes(op.state)) return { abort: { reason: 'replay' } };
    const unsendable = sendableState(op, at);
    if (unsendable) return { abort: { reason: unsendable } };
    const { envelope } = op;
    if (session.session_incarnation !== envelope.source_session_incarnation || session.project_id !== envelope.source_project_id) {
      return { abort: { reason: 'stale_operation' } };
    }
    if (session.archived) return { abort: { reason: 'source_ineligible' } };
    let { authorizations } = current;
    let authorizationId = createId();
    if (authorization.kind === 'grant') {
      const spent = spendGrant(current, authorization.grant_id, envelope, session, at);
      if (spent.reason) return { abort: { reason: spent.reason } };
      ({ authorizations, authorizationId } = spent);
    } else {
      authorizations = [...authorizations, agentOnceAuthorization(op, authorizationId, authorization.consent_event_id, at)];
    }
    const outbox = current.outbox.slice();
    outbox[index] = { ...op, state: 'pending', authorization_id: authorizationId, send_requested_at: at.toISOString(), last_error: null };
    const receipt = buildReceipt({
      mutationId: createId(),
      method: SEND_METHOD,
      args: { operation_id: operationId, authorization_kind: authorization.kind, authorization_id: authorizationId },
      resourceKind: 'outbox_operation',
      resourceId: operationId,
      acceptedRevision: revision + 1,
      now: at,
    });
    return { mail: { ...current, outbox, authorizations }, coordination_receipts: appendReceipt(receipts, receipt, { now: at }) };
  }

  async function agentSend({ sourceSessionId, operationId, authorization } = {}) {
    if (!contract.validSessionId(sourceSessionId) || !contract.validUuid(operationId) || !validAuthorization(authorization)) {
      return fail('invalid_request');
    }
    const at = now();
    const result = mail.mutate(sourceSessionId, (context) => acceptSend(context, { operationId, authorization, at }));
    if (!result.ok && !(result.aborted && result.reason === 'replay')) return storeFailure(result);
    if (result.ok) notify(sourceSessionId);
    track(operationId, sourceSessionId);
    return runDelivery(sourceSessionId, operationId, result.ok);
  }

  // ---- cancel -----------------------------------------------------------------------

  // Only a still-prepared operation cancels here (deny / timeout): once approved it follows the delivery rules.
  async function agentCancel({ sourceSessionId, operationId } = {}) {
    if (!contract.validSessionId(sourceSessionId) || !contract.validUuid(operationId)) return fail('invalid_request');
    const result = mail.mutate(sourceSessionId, ({ mail: current }) => {
      const index = current.outbox.findIndex((record) => record.operation_id === operationId);
      const op = index < 0 ? null : current.outbox[index];
      if (!op || op.envelope.kind !== 'agent_message' || !['prepared', 'cancelled'].includes(op.state)) return { abort: { reason: 'stale_operation' } };
      if (op.state === 'cancelled') return { mail: current };
      const outbox = current.outbox.slice();
      outbox[index] = { ...op, state: 'cancelled', last_error: null };
      return { mail: { ...current, outbox } };
    });
    if (!result.ok) return storeFailure(result);
    if (!result.noop) notify(sourceSessionId);
    const operation = result.mail.outbox.find((record) => record.operation_id === operationId);
    return succeed({ created: !result.noop, operation: projectOperation(operation) });
  }

  // ---- read -------------------------------------------------------------------------

  // An inbox message already included in an admitted turn of this chat. Queued, excluded and reserved
  // mail, another chat's inbox and unknown ids all read as not_found.
  async function agentRead({ sourceSessionId, sourceIncarnation, messageId } = {}) {
    if (!contract.validUuid(messageId)) return fail('invalid_request');
    const bound = readSource(sourceSessionId, sourceIncarnation);
    if (!bound.ok) return bound;
    const record = bound.read.mail.inbox.find((entry) => entry.envelope.message_id === messageId);
    return record && record.context.state === 'included' ? succeed({ envelope: record.envelope }) : fail('not_found');
  }

  return { agentCancel, agentPrepare, agentRead, agentSend, listAgentTargets };
}

module.exports = { createAgentOps };
