'use strict';

/* services/chat-proposal-support.js - helpers split out of ChatProposalService to keep it
 * small: the paged `list` of a session's proposals, the startup reconciliation of one
 * Git / "Do it here" continuation and the binding recheck before a Git Retry. Both work on a service instance (`svc`) through its own record
 * plumbing; neither logs content.
 */

const contract = require('./chat-proposal-contract');
const continuation = require('./chat-proposal-continuation');

const { fail, succeed } = contract;

async function listPage(svc, raw) {
  const checked = contract.validateListRequest(raw);
  if (!checked.ok) return fail(checked.reason);
  const { session_id: sessionId, cursor, limit } = checked.value;
  const read = svc._sweep(sessionId, svc._store.read(sessionId));
  if (!read.ok) return fail(read.reason === 'not_found' ? 'not_found' : 'unavailable');
  const revision = read.coordination_revision;
  const sorted = [...read.records].sort((a, b) => (a.created_at === b.created_at
    ? (a.proposal_id < b.proposal_id ? -1 : 1) : (a.created_at < b.created_at ? -1 : 1)));
  let start = 0;
  if (cursor !== null) {
    const decoded = contract.decodeCursor(cursor, { sessionId, revision });
    if (!decoded.ok) return fail(decoded.reason, { currentRevision: revision });
    start = sorted.findIndex((entry) => entry.created_at > decoded.createdAt
      || (entry.created_at === decoded.createdAt && entry.proposal_id > decoded.proposalId));
    if (start < 0) start = sorted.length;
  }
  const page = sorted.slice(start, start + limit);
  const last = page[page.length - 1];
  const more = start + limit < sorted.length && last;
  return succeed({
    items: page.map((record) => svc._project(record)),
    next_cursor: more ? contract.encodeCursor({
      sessionId, revision, createdAt: last.created_at, proposalId: last.proposal_id,
    }) : null,
    revision,
  });
}

// Settles one unsettled continuation (Git, or a session "Do it here") from the runtime store.
// Reads only; never resumes or resubmits.
function reconcileContinuation(svc, sessionId, record) {
  const rec = svc._records;
  const verdict = continuation.reconcileVerdict({
    runtime: svc._getRuntime(), record, completeKnown: (sid, turnId) => svc._isTurnCompleteKnown(sid, turnId),
  });
  const apply = (build) => svc._apply(sessionId, record.proposal_id, (current) => {
    const next = build(current);
    return next ? { record: next } : { abort: { reason: 'noop' } };
  });
  if (verdict.verdict === 'ack') {
    const acked = apply((current) => rec.markDispatchAcknowledged(current, { workId: verdict.work_id, turnId: verdict.turn_id }));
    if (acked.ok && acked.record) reconcileContinuation(svc, sessionId, acked.record);
  } else if (verdict.verdict === 'dispatch_lost') {
    apply((current) => rec.markDispatchRefused(current, { runtimeUnavailable: false, causeCode: 'dispatch_lost' }));
  } else if (verdict.verdict === 'succeeded' || verdict.verdict === 'cancelled') {
    apply((current) => rec.markContinuationOutcome(current, verdict.verdict));
  } else if (verdict.verdict === 'unknown') {
    apply((current) => rec.markOutcomeUnknown(current));
  } else if (record.continuation_turn_id) {
    svc._track(record.continuation_turn_id, sessionId, record.proposal_id, record.action_state);
  }
}

// Retry of a Git continuation that never reached the runtime: the repository may have moved since the
// accept, so the binding is rechecked exactly as decide() does it. Drift withdraws Retry (out of date)
// instead of running against different content; after the await the record, replay and gate are
// re-read. Returns {record} or {failure}.
async function recheckGitRetry(svc, req, record) {
  const recheck = await svc._recheck(record);
  if (!recheck.ok) return { failure: svc._bindingFailure(req, record, recheck, svc._records.markRetryStale) };
  const found = svc._find(req.session_id, req.proposal_id);
  if (!found.ok) return { failure: fail(found.reason) };
  const current = found.record;
  const replay = svc._gestureReplay('retry', req, current);
  if (replay) return { failure: replay };
  if (current.revision !== req.expected_revision) return { failure: fail('stale_revision', { currentRevision: current.revision }) };
  const gate = svc._project(current).actions.retry;
  if (!gate.available) {
    return { failure: fail(gate.reason === 'not_applicable' ? 'not_pending' : gate.reason, { currentRevision: current.revision }) };
  }
  return { record: current };
}

module.exports = { listPage, reconcileContinuation, recheckGitRetry };
