'use strict';

const { SHUTDOWN_TIMEOUT_MS } = require('./sidecar-request-timeouts');
const { recoverPublishedRuntimeContinuations } = require('./runtime-continuation-recovery');
const { abandonLeaseAfterBackendRestart } = require('./session-turn-actor-terminal');

const RUNTIME_SHUTDOWN_TIMEOUT_MS = Math.max(SHUTDOWN_TIMEOUT_MS - 500, 1);

function unconfirmedResult(error, fallbackReason) {
  return {
    ok: false,
    reason: String(error?.message || error || fallbackReason).slice(0, 240),
  };
}

function beginSessionRuntimeShutdown(service, reason) {
  if (typeof service.sessionRuntime?.beginShutdown !== 'function') return null;
  try {
    const shutdown = service.sessionRuntime.beginShutdown({
      reason,
      timeoutMs: RUNTIME_SHUTDOWN_TIMEOUT_MS,
    });
    return Promise.resolve(shutdown?.completion);
  } catch (error) {
    return Promise.resolve(unconfirmedResult(error, 'runtime_shutdown_unconfirmed'));
  }
}

function beginBackendRuntimeShutdown(service, { runtimeReason = 'service_stop' } = {}) {
  const runtimeCompletion = beginSessionRuntimeShutdown(service, runtimeReason);
  return { runtimeCompletion };
}

async function awaitCleanup(service, completion, event, fallbackReason) {
  if (!completion) return { ok: true, skipped: true };
  let result;
  try {
    result = await completion;
  } catch (error) {
    result = unconfirmedResult(error, fallbackReason);
  }
  if (result?.reason === 'runtime_cleanup_awaits_backend_restart') {
    // Nothing failed: the work is parked for the next start's recovery and
    // reclaim, which are the only things that can settle it.
    service._emitServiceLog('INFO', 'session_runtime.shutdown_awaits_restart', {});
  } else if (result?.ok !== true) {
    service._emitServiceLog('WARN', event, {
      reason: String(result?.reason || fallbackReason).slice(0, 240),
      timedOut: result?.timedOut === true,
    });
  }
  return result;
}

async function awaitBackendRuntimeShutdown(service, shutdown) {
  const runtime = await awaitCleanup(
    service,
    shutdown?.runtimeCompletion,
    'session_runtime.shutdown_unconfirmed',
    'runtime_shutdown_unconfirmed'
  );
  return { runtime };
}

function throwReopenRefused(message, reason) {
  const error = new Error(message);
  error.code = String(reason);
  throw error;
}

// Backend-restart proof (B3D-1): the sidecar that ran any abandoned producer
// is gone, so the runtime retires those entries and their quarantined
// capacity before it is asked to reopen. Without this every later backend
// start failed closed on `runtime_cleanup_unconfirmed` until an app restart.
// The session-turn actor lease of a reclaimed turn has the same abandoned
// producer, so it is dropped too: otherwise the session refused every later
// send (lease_active) and checkpoint recovery until an app restart.
function dropAbandonedActorLeases(service, reclaimed) {
  const dropped = [];
  for (const entry of reclaimed) {
    let work;
    try { work = service.sessionRuntime.store.get(entry.work_id); } catch (_error) { continue; }
    if (!work?.attempt) continue;
    const result = abandonLeaseAfterBackendRestart(service.sessionTurnActors, {
      sessionId: work.session_id, streamId: work.attempt.stream_id, turnId: work.turn_id });
    if (result.dropped) dropped.push(entry.work_id);
  }
  return dropped;
}

// Returns the ids of reclaimed work left in needs_attention for recovery.
function reclaimAbandonedRuntimeWork(service) {
  const reclaim = service.sessionRuntime?.reclaimAbandonedAfterBackendRestart;
  if (typeof reclaim !== 'function') return [];
  const report = reclaim.call(service.sessionRuntime, { reason: 'backend_restart' });
  const reclaimed = Array.isArray(report?.reclaimed) ? report.reclaimed : [];
  const retained = Array.isArray(report?.retained) ? report.retained : [];
  const recovering = reclaimed.filter(entry => entry.status === 'needs_attention').map(entry => entry.work_id);
  const actorLeasesDropped = dropAbandonedActorLeases(service, reclaimed);
  const resourcesConfirmed = Number(report?.resources_confirmed || 0);
  const leasesConfirmed = Number(report?.leases_confirmed || 0);
  if (!reclaimed.length && !retained.length && !resourcesConfirmed && !leasesConfirmed) return recovering;
  // Confirming quarantined leases alone is the restart proof doing its job;
  // only abandoned or still-retained work is worth a warning.
  const level = reclaimed.length || retained.length ? 'WARN' : 'INFO';
  service._emitServiceLog(level, 'session_runtime.abandoned_work_reclaimed', {
    reason: 'backend_restart',
    reclaimed: reclaimed.filter(entry => entry.status !== 'needs_attention').map(entry => entry.work_id),
    recovering,
    actorLeasesDropped,
    retained: retained.map(entry => entry.work_id),
    resourcesConfirmed,
    leasesConfirmed,
  });
  return recovering;
}

// A new process recovers work parked with a pause or cancel intent in three
// steps: composition attaches the checkpoint it published, sidecar initialize
// reconciles its mutation journal, then its persisted cancellation is retried.
// An in-process restart initialized the sidecar while that work was still an
// active entry, so the same steps run here for the work the reclaim released.
function attachReclaimedCheckpoints(service, workIds) {
  const runtime = service.sessionRuntime;
  const log = (level, event, details) => service._emitServiceLog(level, event, details);
  try {
    log('INFO', 'runtime_continuation.recovery_completed', recoverPublishedRuntimeContinuations({
      runtimeStore: runtime.store, checkpointStore: runtime.checkpointStore,
      conversationStore: runtime.conversationStore, sessionStore: service.sessionStore,
      journal: service.turnEventJournal, actorRegistry: service.sessionTurnActors,
      activeStreams: service.activeStreams, logger: log, workIds,
    }));
  } catch (error) {
    // The work stays needs_attention, which a new process recovers.
    log('ERROR', 'runtime_continuation.recovery_failed', { message: String(error?.message || error).slice(0, 240) });
  }
}

async function recoverReclaimedMutations(service) {
  const runtime = service.sessionRuntime;
  const recovered = await runtime.reconcileMutationPreparations?.();
  if (recovered?.interrupted || recovered?.confirmed || recovered?.blocked) {
    service._emitServiceLog('INFO', 'session_runtime.mutation_preparation_recovery', recovered);
  }
  // A pass still running from initialize would be returned as is, without this work.
  await Promise.resolve(runtime.pausedCancellationRecovery).catch(() => null);
  const result = await runtime.recoverPausedCancellations?.();
  if (result?.requested) service._emitServiceLog('INFO', 'session_runtime.paused_cancellation_recovery', result);
}

function reopenSessionRuntime(service) {
  const runtimeResult = service.sessionRuntime.reopenAfterShutdown();
  if (runtimeResult?.ok !== true) {
    throwReopenRefused(
      'Session runtime could not reopen after backend reconciliation.',
      runtimeResult?.reason || 'runtime_reopen_refused'
    );
  }
  return null;
}

// Synchronous (returns null) unless the reclaim left work for recovery. Then
// it returns a promise that reopens only after that work's reconcile and
// cancellation retry have finished, as a new process does them before ready,
// so no resume can race them. Each step is bounded by its request timeouts; a
// failure is logged and the reopen still runs, leaving the work for a later
// start. `stillCurrent` skips the reopen when a stop landed meanwhile.
function reopenBackendRuntimeAfterStart(service, { stillCurrent = () => true } = {}) {
  if (typeof service.sessionRuntime?.reopenAfterShutdown !== 'function') return null;
  const recovering = reclaimAbandonedRuntimeWork(service);
  if (!recovering.length) return reopenSessionRuntime(service);
  attachReclaimedCheckpoints(service, recovering);
  return recoverReclaimedMutations(service).catch(() =>
    service._emitServiceLog('ERROR', 'session_runtime.paused_cancellation_recovery_failed', {}))
    .then(() => (stillCurrent() ? reopenSessionRuntime(service) : null));
}

module.exports = {
  RUNTIME_SHUTDOWN_TIMEOUT_MS,
  awaitBackendRuntimeShutdown,
  beginBackendRuntimeShutdown,
  reopenBackendRuntimeAfterStart,
};
