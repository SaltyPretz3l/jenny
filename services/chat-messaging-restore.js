'use strict';

/* services/chat-messaging-restore.js - `chatMessages.confirmRestored` (row 59 checkpoint 5b-3): the
 * user's explicit confirmation of one send that a trusted archive restore parked as a failed
 * operation with `restore_requires_confirmation` (see data-lifecycle/coordination-restore-transform).
 *
 * Restore never resumes a send on its own, and neither Retry nor a prior approval counts as
 * consent. The confirmation names the immutable operation id, the full-envelope hash the user
 * previewed and a fresh gesture id. It is one synchronous mail mutation (no await inside):
 *   - a durable destination receipt already exists -> the operation becomes delivered and the
 *     flag clears; no new content moves;
 *   - otherwise the hash must equal the stored envelope's, both ends must still be the same
 *     eligible chats, and a fresh one-off `user_send` authorization bound to this operation
 *     (consent = the gesture) is recorded, the flag clears and the operation re-enters pending
 *     delivery, which then runs exactly as a normal send does.
 * No directional grant is restored and no recipient turn is started. The gesture id is made
 * idempotent by a coordination receipt written in the same flushed mutation. Diagnostics carry
 * ids and reason tokens only, never message bodies.
 */

const { envelopeSha256 } = require('./backend/session-message-envelope');
const { appendReceipt, buildReceipt, replayVerdict } = require('./backend/coordination-receipts');
const contract = require('./chat-messaging-contract');
const { userSendAuthorization } = require('./chat-messaging-grants');

const { fail, succeed } = contract;
const METHOD = 'chatMessages.confirmRestored';

function createRestoreOps({
  mail, getSessionSummary = () => null, isContinuable = () => true, now = () => new Date(), createId, notify = () => {},
  storeFailure, locate, readOp, destinationReceipt, projectOperation, runDelivery,
}) {
  const continuable = (sessionId) => {
    const summary = getSessionSummary(sessionId);
    try { return Boolean(summary) && isContinuable(summary) !== false; } catch { return false; }
  };

  // The reason a fresh send of this envelope is not possible now, else null. Uses the existing reason tokens.
  function blockedReason(envelope, source) {
    if (source.session_incarnation !== envelope.source_session_incarnation || source.project_id !== envelope.source_project_id) return 'stale_operation';
    if (source.archived || !continuable(envelope.source_session_id)) return 'source_ineligible';
    const destination = mail.read(envelope.destination_session_id);
    if (!destination.ok) return destination.reason === 'not_found' ? 'recipient_deleted' : 'unavailable';
    if (destination.frozen) return 'unavailable';
    if (destination.archived) return 'recipient_archived';
    if (!continuable(envelope.destination_session_id)) return 'recipient_ineligible';
    if (destination.session_incarnation !== envelope.destination_session_incarnation
      || destination.project_id !== envelope.destination_project_id) return 'stale_operation';
    return null;
  }

  // A repeated gesture answers with the operation's current state (delivering it again when it is still pending).
  function replay(sourceId, operationId) {
    const op = readOp(sourceId, operationId);
    if (!op) return fail('stale_operation');
    if (['pending', 'delivered'].includes(op.state)) return runDelivery(sourceId, operationId, false);
    return succeed({ created: false, operation: projectOperation(op) });
  }

  async function confirmRestored(raw) {
    const checked = contract.validateConfirmRestoredRequest(raw);
    if (!checked.ok) return fail(checked.reason);
    const req = checked.value;
    const sourceId = locate(req.operation_id);
    if (!sourceId) return fail('stale_operation');
    const source = mail.read(sourceId);
    if (!source.ok) return fail(source.reason === 'not_found' ? 'stale_operation' : 'unavailable');
    if (source.frozen) return fail('unavailable', { currentRevision: source.coordination_revision });
    const revision = source.coordination_revision;
    const args = { operation_id: req.operation_id, expected_envelope_sha256: req.expected_envelope_sha256 };
    const verdict = replayVerdict(source.coordination_receipts, req.gesture_id, METHOD, args);
    if (verdict.state === 'conflict') return fail('idempotency_conflict', { currentRevision: revision });
    if (verdict.state === 'same') return replay(sourceId, req.operation_id);

    const op = source.mail.outbox.find((record) => record.operation_id === req.operation_id);
    if (!op || op.state !== 'failed' || op.restore_requires_confirmation !== true) return fail('stale_operation', { currentRevision: revision });
    const { envelope } = op;
    const receipt = destinationReceipt(envelope);
    if (receipt.state === 'unknown') return fail('unavailable', { currentRevision: revision });
    if (receipt.state === 'conflict') return fail('idempotency_conflict', { currentRevision: revision });
    const delivered = receipt.state === 'found';
    if (!delivered) {
      if (envelopeSha256(envelope) !== req.expected_envelope_sha256) return fail('idempotency_conflict', { currentRevision: revision });
      const blocked = blockedReason(envelope, source);
      if (blocked) return fail(blocked, { currentRevision: revision });
    }

    const at = now();
    const stamp = at.toISOString();
    const authorizationId = createId();
    const result = mail.mutate(sourceId, ({
      mail: current, session, coordination_revision: base, coordination_receipts: receipts,
    }) => {
      const index = current.outbox.findIndex((record) => record.operation_id === req.operation_id);
      if (index < 0) return { abort: { reason: 'stale_operation' } };
      const held = current.outbox[index];
      if (held.state !== 'failed' || held.restore_requires_confirmation !== true) return { abort: { reason: 'stale_operation' } };
      if (replayVerdict(receipts, req.gesture_id, METHOD, args).state !== 'none') return { abort: { reason: 'exists' } };
      const cleared = { ...held, restore_requires_confirmation: false, last_error: null };
      let next;
      let authorizations = current.authorizations;
      if (delivered) {
        next = {
          ...cleared, state: 'delivered', delivered_at: stamp, destination_receipt_id: receipt.receipt_id,
          send_requested_at: held.send_requested_at || stamp,
        };
      } else {
        if (session.session_incarnation !== envelope.source_session_incarnation
          || session.project_id !== envelope.source_project_id) return { abort: { reason: 'stale_operation' } };
        if (session.archived) return { abort: { reason: 'source_ineligible' } };
        next = { ...cleared, state: 'pending', authorization_id: authorizationId, send_requested_at: held.send_requested_at || stamp };
        authorizations = [...authorizations, { ...userSendAuthorization(held, authorizationId, at), consent_event_id: `restore:${req.gesture_id}` }];
      }
      const outbox = current.outbox.slice();
      outbox[index] = next;
      const proof = buildReceipt({
        mutationId: req.gesture_id, method: METHOD, args, resourceKind: 'operation', resourceId: req.operation_id,
        acceptedRevision: base + 1, now: at,
      });
      return { mail: { ...current, outbox, authorizations }, coordination_receipts: appendReceipt(receipts, proof, { now: at }) };
    });
    if (!result.ok) {
      if (result.aborted && result.reason === 'exists') return confirmRestored(raw);
      return storeFailure(result);
    }
    notify(sourceId);
    return runDelivery(sourceId, req.operation_id, true);
  }

  return { confirmRestored };
}

module.exports = { createRestoreOps };
