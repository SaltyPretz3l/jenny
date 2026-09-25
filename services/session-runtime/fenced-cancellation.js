'use strict';

// A cancellation whose durable write failed keeps its in-memory fence: the
// producer is stopped, but a fence alone must never settle the record as
// cancelled (tests/session-runtime/lifecycle.test.js pins that a fence with
// no persisted intent quarantines instead). Settlement is the retry point:
// the store may be writable again, and a persisted intent lets the entry
// settle `cancelled` instead of parking in needs_attention forever.
function persistFencedCancellation(scheduler, current, attempt) {
  const fence = scheduler.cancellationFences.get(current.work_id);
  try {
    return scheduler.store.requestCancellation(current.work_id, {
      expectedRevision: current.revision, expectedAttempt: attempt,
      reason: fence?.reason || 'runtime_cancellation_retry',
    }).record;
  } catch (error) {
    scheduler._attention(current.work_id, error);
    throw new Error('runtime_cancellation_intent_unpersisted', { cause: error });
  }
}

module.exports = { persistFencedCancellation };
