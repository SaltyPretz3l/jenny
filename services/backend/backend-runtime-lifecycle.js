'use strict';

const { SHUTDOWN_TIMEOUT_MS } = require('./sidecar-request-timeouts');

const RUNTIME_SHUTDOWN_TIMEOUT_MS = Math.max(SHUTDOWN_TIMEOUT_MS - 500, 1);

function unconfirmedResult(error, fallbackReason) {
  return {
    ok: false,
    reason: String(error?.message || error || fallbackReason).slice(0, 240),
  };
}

function beginStage8Shutdown(service, reason) {
  const begin = service._pluginStage8Lifecycle?.beginBackendShutdown;
  if (typeof begin !== 'function') return null;
  try {
    return Promise.resolve(begin.call(service._pluginStage8Lifecycle, { reason }));
  } catch (error) {
    return Promise.resolve(unconfirmedResult(error, 'stage8_shutdown_unconfirmed'));
  }
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

function beginBackendRuntimeShutdown(service, {
  runtimeReason = 'service_stop',
  stage8Reason = 'backend_stop',
} = {}) {
  const stage8Completion = beginStage8Shutdown(service, stage8Reason);
  const runtimeCompletion = beginSessionRuntimeShutdown(service, runtimeReason);
  return { stage8Completion, runtimeCompletion };
}

async function awaitCleanup(service, completion, event, fallbackReason) {
  if (!completion) return { ok: true, skipped: true };
  let result;
  try {
    result = await completion;
  } catch (error) {
    result = unconfirmedResult(error, fallbackReason);
  }
  if (result?.ok !== true) {
    service._emitServiceLog('WARN', event, {
      reason: String(result?.reason || fallbackReason).slice(0, 240),
      timedOut: result?.timedOut === true,
    });
  }
  return result;
}

async function awaitBackendRuntimeShutdown(service, shutdown) {
  const stage8 = await awaitCleanup(
    service,
    shutdown?.stage8Completion,
    'plugin_stage8.shutdown_unconfirmed',
    'stage8_shutdown_unconfirmed'
  );
  const runtime = await awaitCleanup(
    service,
    shutdown?.runtimeCompletion,
    'session_runtime.shutdown_unconfirmed',
    'runtime_shutdown_unconfirmed'
  );
  return { stage8, runtime };
}

function throwReopenRefused(message, reason) {
  const error = new Error(message);
  error.code = String(reason);
  throw error;
}

function relatchAfterStage8Refusal(service) {
  const shutdown = beginBackendRuntimeShutdown(service, {
    runtimeReason: 'stage8_reopen_refused',
    stage8Reason: 'stage8_reopen_refused',
  });
  void awaitBackendRuntimeShutdown(service, shutdown);
}

// Backend-restart proof (B3D-1): the sidecar that ran any abandoned producer
// is gone, so the runtime retires those entries and their quarantined
// capacity before it is asked to reopen. Without this every later backend
// start failed closed on `runtime_cleanup_unconfirmed` until an app restart.
function reclaimAbandonedRuntimeWork(service) {
  const reclaim = service.sessionRuntime?.reclaimAbandonedAfterBackendRestart;
  if (typeof reclaim !== 'function') return;
  const report = reclaim.call(service.sessionRuntime, { reason: 'backend_restart' });
  const reclaimed = Array.isArray(report?.reclaimed) ? report.reclaimed : [];
  const retained = Array.isArray(report?.retained) ? report.retained : [];
  const resourcesConfirmed = Number(report?.resources_confirmed || 0);
  if (!reclaimed.length && !retained.length && !resourcesConfirmed) return;
  // Confirming quarantined leases alone is the restart proof doing its job;
  // only abandoned or still-retained work is worth a warning.
  const level = reclaimed.length || retained.length ? 'WARN' : 'INFO';
  service._emitServiceLog(level, 'session_runtime.abandoned_work_reclaimed', {
    reason: 'backend_restart',
    reclaimed: reclaimed.map(entry => entry.work_id),
    retained: retained.map(entry => entry.work_id),
    resourcesConfirmed,
  });
}

function reopenBackendRuntimeAfterStart(service) {
  const reopenStage8 = service._pluginStage8Lifecycle?.reopenAfterBackendStart;
  const reopenRuntime = service.sessionRuntime?.reopenAfterShutdown;
  if (typeof reopenRuntime !== 'function') {
    if (typeof reopenStage8 !== 'function') return;
    relatchAfterStage8Refusal(service);
    throwReopenRefused(
      'Session runtime cannot prove it is ready to reopen.',
      'runtime_reopen_unavailable'
    );
  }
  reclaimAbandonedRuntimeWork(service);
  const runtimeResult = reopenRuntime.call(service.sessionRuntime);
  if (runtimeResult?.ok !== true) {
    throwReopenRefused(
      'Session runtime could not reopen after backend reconciliation.',
      runtimeResult?.reason || 'runtime_reopen_refused'
    );
  }
  if (typeof reopenStage8 !== 'function') return;
  let result;
  try {
    result = reopenStage8.call(service._pluginStage8Lifecycle);
  } catch (error) {
    relatchAfterStage8Refusal(service);
    throw error;
  }
  if (result?.ok !== true) {
    relatchAfterStage8Refusal(service);
    throwReopenRefused(
      'Stage 8 plugin runtime could not reopen after backend reconciliation.',
      result?.reason || 'stage8_cleanup_unconfirmed'
    );
  }
}

module.exports = {
  RUNTIME_SHUTDOWN_TIMEOUT_MS,
  awaitBackendRuntimeShutdown,
  beginBackendRuntimeShutdown,
  reopenBackendRuntimeAfterStart,
};
