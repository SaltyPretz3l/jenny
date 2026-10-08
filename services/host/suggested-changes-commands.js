'use strict';

// Hosted suggested changes (row 35 Plan Plus): the browser API's view of the
// Propose-mode suggestion service (services/backend/suggested-changes-service.js).
// Reads need the session; decisions, comments and accept are leased session
// mutations with durable receipts, like sessions.rename. Accept consents to one
// revision and applies through the sidecar's journaled write, exactly as on
// desktop. The digest Send returns is sent by the client as its next chat.send.

const { hostFailure } = require('../../server/api-contract');

const SUGGESTED_MUTATIONS = new Set([
  'suggestedChanges.decide', 'suggestedChanges.comment', 'suggestedChanges.sendComments',
  'suggestedChanges.discardPending', 'suggestedChanges.accept',
]);
const SUGGESTED_OPERATIONS = new Set(['suggestedChanges.list', ...SUGGESTED_MUTATIONS]);

// Service error -> host failure kind. Anything unlisted is `unavailable`.
const FAILURE_KINDS = Object.freeze({
  not_found: 'conflict',
  invalid_transition: 'conflict',
  revision_changed: 'conflict',
  dependency_pending: 'conflict',
  needs_confirmation: 'conflict',
  busy: 'conflict',
  nothing_to_send: 'conflict',
  empty: 'invalid',
  invalid_decision: 'invalid',
  revision_required: 'invalid',
  write_failed: 'persistence',
});

function serviceFailure(result, requestId) {
  const reason = typeof result?.error === 'string' && /^[a-z][a-z_]{0,60}$/.test(result.error)
    ? result.error : 'suggested_changes_failed';
  const kind = FAILURE_KINDS[reason] || 'unavailable';
  return hostFailure(kind, `suggestion_${reason}`.slice(0, 80), requestId, kind === 'unavailable' || reason === 'busy');
}

// A C4 apply outcome is a completed command even when the sidecar refused the
// write (moved, out of date): the client shows the outcome and re-reads.
function acceptResult(result) {
  const out = {
    ok: true,
    applied: result.ok === true && result.status !== 'accepted',
    status: String(result.status || 'refused'),
    outcome: String(result.outcome || 'refused'),
    reason: String(result.reason || '').slice(0, 120),
  };
  if (typeof result.suggestion_id === 'string') out.suggestion_id = result.suggestion_id;
  if (Array.isArray(result.applied_ids)) out.applied_ids = result.applied_ids.slice(0, 20);
  if (Number.isSafeInteger(result.waiting)) out.waiting = result.waiting;
  if (typeof result.receipt_saved === 'boolean') out.receipt_saved = result.receipt_saved;
  return out;
}

async function execute(service, command) {
  const sessionId = command.session_id;
  const params = command.params;
  switch (command.operation) {
    case 'suggestedChanges.decide':
      return service.decide({ sessionId, id: params.id, decision: params.decision, reason: params.reason || '' });
    case 'suggestedChanges.comment':
      return service.comment({ sessionId, id: params.id, text: params.text });
    case 'suggestedChanges.sendComments':
      return service.sendComments({ sessionId, undo: params.undo || null });
    case 'suggestedChanges.discardPending':
      return service.discardPending({ sessionId });
    case 'suggestedChanges.accept':
      return service.accept({ sessionId, id: params.id, revision: params.revision, force: params.force === true });
    default:
      return { ok: false, error: 'unsupported' };
  }
}

function createSuggestedChangesCommandDispatcher({
  getService,
  authorization = {},
  transaction = {},
  result = {},
} = {}) {
  const { identity, mutationGuard, assertMutationAuthority, assertPostAwaitAuthority } = authorization;
  const { runReceipt } = transaction;
  const { bumpRevision, publish } = result;

  async function dispatch(command, context) {
    const authFailure = identity(command, context);
    if (authFailure) return authFailure;
    const service = typeof getService === 'function' ? getService() : null;
    if (!service) return hostFailure('unavailable', 'suggested_changes_unavailable', command.request_id, true);
    if (command.operation === 'suggestedChanges.list') {
      // A read holds no lease, so it never saves (the revising recovery included).
      const view = service.list(command.session_id, { persist: false });
      return view ? { ok: true, suggested_changes: view } : hostFailure('conflict', 'session_not_found', command.request_id);
    }
    const failure = mutationGuard(command, context); if (failure) return failure;
    return runReceipt(command, context, async () => {
      assertMutationAuthority(command, context);
      if (typeof service.releaseFinishedRevisions === 'function') service.releaseFinishedRevisions(command.session_id);
      const value = await execute(service, command);
      assertPostAwaitAuthority(command, context);
      const isAccept = command.operation === 'suggestedChanges.accept';
      // An apply outcome has a status; a refusal before the sidecar has only an error.
      if (!value || (!value.ok && !(isAccept && value.status))) return serviceFailure(value, command.request_id);
      const revision = bumpRevision(command.session_id);
      publish('session_changed', { session_id: command.session_id, revision, reason: 'suggested_changes' });
      if (isAccept) return { ...acceptResult(value), revision };
      const out = { ok: true, revision };
      if (value.entry) out.entry = value.entry;
      if (Array.isArray(value.ids)) out.ids = value.ids;
      if (typeof value.message === 'string') out.message = value.message;
      if (typeof value.sent_at === 'string') out.sent_at = value.sent_at;
      if (Number.isSafeInteger(value.discarded)) out.discarded = value.discarded;
      return out;
    });
  }

  return Object.freeze({ dispatch });
}

module.exports = {
  SUGGESTED_MUTATIONS,
  SUGGESTED_OPERATIONS,
  createSuggestedChangesCommandDispatcher,
};
