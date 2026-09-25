"use strict";

// Retry persisted paused cancellation only after the current sidecar has
// initialized. Each request still proves actor cleanup and the exact owner pin.
function recoverPausedCancellations(runtime) {
  if (runtime.pausedCancellationRecovery) return runtime.pausedCancellationRecovery;
  const works = runtime._listSummaries().filter(work => ['pending', 'paused'].includes(work.status))
    .map(work => runtime.store.get(work.work_id)).filter(work => work?.control_request?.kind === 'cancel');
  let next = 0;
  const result = { requested: 0, completed: 0, blocked: 0 };
  const worker = async () => {
    while (next < works.length) {
      const work = works[next++];
      result.requested++;
      try {
        const requested = runtime.scheduler.requestCancellation(work.work_id, {
          expectedRevision: work.revision, reason: work.control_request.reason });
        const settled = requested.settlement ? await requested.settlement : requested;
        if (settled.cleanup_confirmed === true) result.completed++;
        else result.blocked++;
      } catch (_error) { result.blocked++; }
    }
  };
  const promise = Promise.all(Array.from({ length: Math.min(4, works.length) }, worker))
    .then(() => Object.freeze(result)).finally(() => { runtime.pausedCancellationRecovery = null; });
  runtime.pausedCancellationRecovery = promise;
  return promise;
}
function finishPausedCancellation(scheduler, saved, reason, proven) {
  const id = saved.work_id;
  try {
    const current = scheduler.store.get(id);
    if (proven !== true || scheduler.active.has(id) || current?.revision !== saved.revision
      || current.control_request?.kind !== 'cancel' || !current.attempt || !saved.attempt
      || !['attempt_id', 'stream_id', 'incarnation', 'authority_revision'].every(key => current.attempt?.[key] === saved.attempt?.[key])) {
      throw new Error('runtime_paused_cleanup_unconfirmed');
    }
    const cancelled = scheduler.store.transition(id, { expectedRevision: saved.revision,
      expectedAttempt: saved.attempt, to: 'cancelled', reason }).record;
    scheduler.cancellationFences.delete(id);
    scheduler.onWorkChange?.(cancelled);
    return Object.freeze({ status: cancelled.status, work_id: id, cleanup_confirmed: true, persisted: true });
  } catch (error) {
    scheduler._attention(id, error);
    return Object.freeze({ status: 'requested', work_id: id, cleanup_confirmed: false });
  }
}

function settlePausedCancellation(scheduler, saved, reason, deletionHandle) {
  const id = saved.work_id;
  let proof = false;
  try { proof = scheduler.provePausedCleanup(saved, { deletionHandle }); }
  catch (error) { scheduler._attention(id, error); }
  if (proof && typeof proof.then === 'function') {
    const promise = Promise.resolve(proof).then(confirmed =>
      finishPausedCancellation(scheduler, saved, reason, confirmed), error => {
      scheduler._attention(id, error);
      return Object.freeze({ status: 'requested', work_id: id, cleanup_confirmed: false });
    }).finally(() => scheduler.pausedCancellationSettlements.delete(id));
    scheduler.pausedCancellationSettlements.set(id, { promise, session_id: saved.session_id });
    return Object.freeze({ status: 'requested', work_id: id,
      cleanup_confirmed: false, persisted: true, settlement: promise });
  }
  if (proof === true) return finishPausedCancellation(scheduler, saved, reason, proof);
  return Object.freeze({ status: 'requested', work_id: id, cleanup_confirmed: false, persisted: true });
}
module.exports = { recoverPausedCancellations, settlePausedCancellation };
