'use strict';

/* services/chat-messaging-delivery.js - the durable delivery transaction of an
 * addressed session message (row 59 checkpoint 4), cancel, retry resume and
 * restart reconciliation.
 *
 * Phases (spec 928-950), each ONE synchronous mailStore.mutate (read, decide,
 * write, flush; no await anywhere, which is the serialization lock on the
 * Electron main thread):
 *   2. destination: idempotent inbox record under the envelope's message id;
 *   3. source: the outbox record becomes `delivered` with the receipt id;
 *   4. destination: `source_receipt_confirmed_at` (or `source_absent`).
 * A flush failure in any phase leaves the operation `pending` and answers
 * persistence_failure; Retry or restart repeats the phases with the same
 * identity and never sends anything new. An explicit failure (archived, deleted,
 * full or changed recipient) marks the operation `failed` with a last_error.
 * Recovery always looks for the destination receipt first, so a completed
 * delivery is never repeated and never blocked by later eligibility changes.
 * Only when no receipt exists is an agent operation's authorization re-checked
 * (revoked, expired, identity or project changed): it then fails
 * `authorization_revoked`, which only a fresh approval of the same operation clears.
 */

const { envelopeSha256 } = require('./backend/session-message-envelope');
const { authorizationBlocked, inboxCapacity, pruneMail } = require('./backend/session-mail-records');
const { lastError } = require('./chat-messaging-contract');

const TRANSIENT_REASONS = new Set(['io_failed']);

function createMessageDelivery({
  mailStore, getSessionSummary = () => null, isContinuable = () => true, now = () => new Date(),
  createId, changed = () => {}, log = () => {},
}) {
  const stamp = () => now().toISOString();
  const findOp = (mail, operationId) => mail.outbox.find((record) => record.operation_id === operationId) || null;
  const continuable = (summary) => {
    try { return summary && isContinuable(summary) !== false; } catch { return false; }
  };
  const sameMessage = (envelope) => (record) => (record.envelope?.message_id || record.message_id) === envelope.message_id;

  function readOp(sourceId, operationId) {
    const read = mailStore.read(sourceId);
    return read.ok ? findOp(read.mail, operationId) : null;
  }

  // The durable destination proof for this exact envelope.
  // -> {state:'found', receipt_id} | {state:'none', deleted?} | {state:'conflict'} | {state:'unknown'}
  function destinationReceipt(envelope) {
    const read = mailStore.read(envelope.destination_session_id);
    if (!read.ok) return read.reason === 'not_found' ? { state: 'none', deleted: true } : { state: 'unknown' };
    if (read.frozen) return { state: 'unknown' };
    const sha = envelopeSha256(envelope);
    const inbox = read.mail.inbox.find(sameMessage(envelope));
    if (inbox) return envelopeSha256(inbox.envelope) === sha ? { state: 'found', receipt_id: inbox.receipt_id } : { state: 'conflict' };
    const discarded = read.mail.discarded.find(sameMessage(envelope));
    if (discarded) return discarded.envelope_sha256 === sha ? { state: 'found', receipt_id: discarded.receipt_id } : { state: 'conflict' };
    return { state: 'none' };
  }

  // True when an agent operation's directional / one-off authorization no longer holds. Called only for an
  // operation that is about to be delivered: a destination receipt (or an unreadable destination) never blocks here.
  function authorizationFailed(read, op) {
    const { envelope } = op;
    const auth = op.authorization_id ? read.mail.authorizations.find((entry) => entry.authorization_id === op.authorization_id) : null;
    const checked = auth ? ['agent_directional', 'agent_once'].includes(auth.kind) : envelope.kind === 'agent_message';
    if (!checked || destinationReceipt(envelope).state !== 'none') return false;
    if (!auth) return true; // an agent operation with no authorization record fails closed
    const destination = mailStore.read(envelope.destination_session_id);
    return authorizationBlocked(auth, envelope, {
      source: { session_incarnation: read.session_incarnation, project_id: read.project_id },
      destination: destination.ok ? { session_incarnation: destination.session_incarnation, project_id: destination.project_id } : null,
    }, now());
  }

  // ---- phase 2 ---------------------------------------------------------------

  function writeDestination(op) {
    const envelope = op.envelope;
    const sha = envelopeSha256(envelope);
    const receiptId = createId();
    const at = stamp();
    const result = mailStore.mutate(envelope.destination_session_id, ({ mail, session }) => {
      const duplicate = mail.inbox.find(sameMessage(envelope)) || mail.discarded.find(sameMessage(envelope));
      if (duplicate) {
        const duplicateSha = duplicate.envelope ? envelopeSha256(duplicate.envelope) : duplicate.envelope_sha256;
        return { abort: duplicateSha === sha ? { reason: 'exists', receipt_id: duplicate.receipt_id } : { reason: 'idempotency_conflict' } };
      }
      if (session.session_incarnation !== envelope.destination_session_incarnation
        || session.project_id !== envelope.destination_project_id) return { abort: { reason: 'stale_operation' } };
      if (session.archived) return { abort: { reason: 'recipient_archived' } };
      if (!continuable(getSessionSummary(session.id))) return { abort: { reason: 'recipient_ineligible' } };
      const next = pruneMail(mail, { now: now() });
      if (inboxCapacity(next, envelope).full) return { abort: { reason: 'recipient_backpressure' } };
      next.inbox.push({
        envelope: structuredClone(envelope),
        receipt_id: receiptId,
        receive_sequence: mail.next_receive_sequence,
        delivered_at: at,
        read_at: null,
        source_receipt_confirmed_at: null,
        source_absent: false,
        context: { state: 'queued' },
      });
      next.next_receive_sequence = mail.next_receive_sequence + 1;
      return { mail: next };
    });
    if (result.ok) {
      changed(envelope.destination_session_id);
      return { kind: 'written', receipt_id: receiptId };
    }
    if (result.aborted && result.reason === 'exists') return { kind: 'written', receipt_id: result.receipt_id };
    if (result.reason === 'not_found') return { kind: 'failed', reason: 'recipient_deleted' };
    if (result.reason === 'io_failed') return { kind: 'transient', reason: 'persistence_failure' };
    if (result.reason === 'invalid_record') return { kind: 'failed', reason: 'unavailable' };
    return { kind: 'failed', reason: result.reason };
  }

  // ---- phases 3 and 4 --------------------------------------------------------

  // Source: delivered receipt. Idempotent: an already-delivered record is success.
  function finalizeSource(sourceId, operationId, receiptId) {
    const at = stamp();
    const result = mailStore.mutate(sourceId, ({ mail }) => {
      const index = mail.outbox.findIndex((record) => record.operation_id === operationId);
      if (index < 0) return { abort: { reason: 'not_found' } };
      const current = mail.outbox[index];
      if (current.state === 'delivered') return { abort: { reason: 'already_delivered' } };
      const outbox = mail.outbox.slice();
      outbox[index] = {
        ...current,
        state: 'delivered',
        delivered_at: at,
        destination_receipt_id: receiptId,
        send_requested_at: current.send_requested_at || at,
        last_error: null,
      };
      return { mail: { ...mail, outbox } };
    });
    if (result.ok) changed(sourceId);
    return result;
  }

  // Destination: the source acknowledgment (or the source's absence). Failure here is
  // non-fatal; reconciliation repeats it.
  function confirmDestination(envelope, { sourceAbsent = false } = {}) {
    const at = stamp();
    const result = mailStore.mutate(envelope.destination_session_id, ({ mail }) => {
      const mark = (record) => (record.source_receipt_confirmed_at !== null || record.source_absent ? record
        : { ...record, source_receipt_confirmed_at: sourceAbsent ? null : at, source_absent: sourceAbsent });
      const touched = mail.inbox.some(sameMessage(envelope)) || mail.discarded.some(sameMessage(envelope));
      if (!touched) return { abort: { reason: 'noop' } };
      return {
        mail: {
          ...mail,
          inbox: mail.inbox.map((record) => (sameMessage(envelope)(record) ? mark(record) : record)),
          discarded: mail.discarded.map((record) => (sameMessage(envelope)(record) ? mark(record) : record)),
        },
      };
    });
    if (result.ok && !result.noop) changed(envelope.destination_session_id);
    if (!result.ok && !result.aborted) log('WARN', 'chat_messaging.confirm_not_persisted', { reason: result.reason });
    return result;
  }

  // The receipt exists: record it at the source (or note the source is gone) and acknowledge.
  function finalizeDelivered(sourceId, op, receiptId) {
    const finalized = finalizeSource(sourceId, op.operation_id, receiptId);
    if (!finalized.ok && !(finalized.aborted && finalized.reason === 'already_delivered')) {
      if (finalized.reason === 'not_found') {
        confirmDestination(op.envelope, { sourceAbsent: true });
        return { ok: true, absent: true };
      }
      return { ok: false, reason: TRANSIENT_REASONS.has(finalized.reason) || finalized.reason === 'invalid_record'
        ? 'persistence_failure' : finalized.reason };
    }
    confirmDestination(op.envelope);
    return { ok: true };
  }

  function markFailed(sourceId, operationId, reason) {
    const error = lastError(reason);
    const result = mailStore.mutate(sourceId, ({ mail }) => {
      const index = mail.outbox.findIndex((record) => record.operation_id === operationId);
      if (index < 0) return { abort: { reason: 'not_found' } };
      const current = mail.outbox[index];
      if (!['pending', 'failed'].includes(current.state)) return { abort: { reason: 'not_pending' } };
      const outbox = mail.outbox.slice();
      outbox[index] = { ...current, state: 'failed', last_error: error };
      return { mail: { ...mail, outbox } };
    });
    if (result.ok) changed(sourceId);
    return result;
  }

  // ---- deliver ---------------------------------------------------------------

  // Runs the phases for a `pending` (or `delivered`, to finish acknowledgment) operation.
  // -> {ok:true, operation} (delivered or failed) | {ok:false, reason, operation} (still pending)
  function deliver(sourceId, operationId) {
    const read = mailStore.read(sourceId);
    if (!read.ok) return { ok: false, reason: read.reason === 'not_found' ? 'stale_operation' : 'unavailable', operation: null };
    const op = findOp(read.mail, operationId);
    if (!op) return { ok: false, reason: 'stale_operation', operation: null };
    if (op.state === 'delivered') {
      finalizeDelivered(sourceId, op, op.destination_receipt_id);
      return { ok: true, operation: readOp(sourceId, operationId) || op };
    }
    if (op.state !== 'pending') return { ok: false, reason: 'stale_operation', operation: op };
    if (authorizationFailed(read, op)) {
      if (!markFailed(sourceId, operationId, 'authorization_revoked').ok) return { ok: false, reason: 'persistence_failure', operation: op };
      log('WARN', 'chat_messaging.delivery_failed', { operation_id: operationId, reason: 'authorization_revoked' });
      return { ok: true, operation: readOp(sourceId, operationId) };
    }

    const written = writeDestination(op);
    if (written.kind === 'transient') return { ok: false, reason: written.reason, operation: op };
    if (written.kind === 'failed') {
      const marked = markFailed(sourceId, operationId, written.reason);
      if (!marked.ok) return { ok: false, reason: 'persistence_failure', operation: op };
      log('WARN', 'chat_messaging.delivery_failed', { operation_id: operationId, reason: written.reason });
      return { ok: true, operation: readOp(sourceId, operationId) };
    }
    const finalized = finalizeDelivered(sourceId, op, written.receipt_id);
    if (!finalized.ok) return { ok: false, reason: finalized.reason, operation: op };
    return { ok: true, operation: readOp(sourceId, operationId) || op };
  }

  // Failed -> pending with the same identity and consumed authorization. Only a retryable failure resumes.
  function resume(sourceId, operationId) {
    const result = mailStore.mutate(sourceId, ({ mail }) => {
      const index = mail.outbox.findIndex((record) => record.operation_id === operationId);
      if (index < 0) return { abort: { reason: 'stale_operation' } };
      const current = mail.outbox[index];
      if (current.state !== 'failed') return { abort: { reason: 'not_failed', state: current.state } };
      if (current.last_error?.retryable !== true) return { abort: { reason: current.last_error?.reason || 'stale_operation' } };
      const outbox = mail.outbox.slice();
      outbox[index] = { ...current, state: 'pending', last_error: null };
      return { mail: { ...mail, outbox } };
    });
    if (result.ok) changed(sourceId);
    return result;
  }

  // ---- cancel ----------------------------------------------------------------

  // A destination receipt wins: it finalizes delivery (created:false). Otherwise a
  // prepared / pending / failed operation becomes cancelled.
  function cancel(sourceId, operationId) {
    const read = mailStore.read(sourceId);
    if (!read.ok) return { ok: false, reason: read.reason === 'not_found' ? 'stale_operation' : 'unavailable' };
    const op = findOp(read.mail, operationId);
    if (!op) return { ok: false, reason: 'stale_operation' };
    if (op.state === 'cancelled') return { ok: true, created: false, operation: op };
    if (op.state === 'delivered') {
      finalizeDelivered(sourceId, op, op.destination_receipt_id);
      return { ok: true, created: false, operation: readOp(sourceId, operationId) || op };
    }
    const receipt = destinationReceipt(op.envelope);
    if (receipt.state === 'unknown') return { ok: false, reason: 'unavailable' };
    if (receipt.state === 'found') {
      const finalized = finalizeDelivered(sourceId, op, receipt.receipt_id);
      if (!finalized.ok) return { ok: false, reason: finalized.reason };
      return { ok: true, created: false, operation: readOp(sourceId, operationId) || op };
    }
    const result = mailStore.mutate(sourceId, ({ mail }) => {
      const index = mail.outbox.findIndex((record) => record.operation_id === operationId);
      if (index < 0) return { abort: { reason: 'stale_operation' } };
      const current = mail.outbox[index];
      if (!['prepared', 'pending', 'failed'].includes(current.state)) return { abort: { reason: 'stale_operation' } };
      const outbox = mail.outbox.slice();
      outbox[index] = { ...current, state: 'cancelled', last_error: null };
      return { mail: { ...mail, outbox } };
    });
    if (!result.ok) return { ok: false, reason: result.reason === 'io_failed' ? 'persistence_failure' : result.reason };
    changed(sourceId);
    return { ok: true, created: true, operation: readOp(sourceId, operationId) };
  }

  // ---- reconciliation --------------------------------------------------------

  // Prunes expired / retired entries, repeats every pending delivery and finishes
  // missing acknowledgments. -> number of operations it advanced. Never throws.
  function reconcileSession(sessionId, receiptCache = new Map()) {
    let advanced = 0;
    const pruned = mailStore.mutate(sessionId, ({ mail }) => ({ mail: pruneMail(mail, { now: now() }) }));
    if (pruned.ok && !pruned.noop) changed(sessionId);
    const read = mailStore.read(sessionId);
    if (!read.ok || read.frozen) return advanced;
    for (const op of read.mail.outbox) {
      if (op.state === 'pending') {
        const outcome = deliver(sessionId, op.operation_id);
        if (outcome.ok) advanced += 1;
        else log('WARN', 'chat_messaging.reconcile_pending_failed', { operation_id: op.operation_id, reason: outcome.reason });
      } else if (op.state === 'delivered' && needsAcknowledgment(op.envelope, receiptCache)) {
        finalizeDelivered(sessionId, op, op.destination_receipt_id);
        receiptCache.delete(op.envelope.destination_session_id);
        advanced += 1;
      }
    }
    return advanced;
  }

  // A source deleted before it acknowledged leaves its destination records unconfirmed, and
  // reconciliation only walks live outboxes: mark them source_absent so they can retire.
  function markAbsentSources(sessionId, liveIds) {
    const orphan = (record) => record.source_receipt_confirmed_at === null && !record.source_absent
      && !liveIds.has(record.envelope.source_session_id);
    const result = mailStore.mutate(sessionId, ({ mail }) => (mail.inbox.some(orphan)
      ? { mail: { ...mail, inbox: mail.inbox.map((record) => (orphan(record) ? { ...record, source_absent: true } : record)) } }
      : { mail }));
    if (result.ok && !result.noop) changed(sessionId);
    return result;
  }

  function needsAcknowledgment(envelope, cache) {
    const destinationId = envelope.destination_session_id;
    if (!cache.has(destinationId)) cache.set(destinationId, mailStore.read(destinationId));
    const read = cache.get(destinationId);
    if (!read.ok || read.frozen) return false; // a deleted or unreadable destination cannot be acknowledged now
    const record = read.mail.inbox.find(sameMessage(envelope)) || read.mail.discarded.find(sameMessage(envelope));
    return Boolean(record) && record.source_receipt_confirmed_at === null && !record.source_absent;
  }

  return {
    cancel, deliver, destinationReceipt, findOp, markAbsentSources, readOp, reconcileSession, resume,
  };
}

module.exports = { createMessageDelivery };
