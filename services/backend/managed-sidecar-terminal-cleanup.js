'use strict';

const { settlePendingApprovalsForStream } = require('./chat-stream-tool-handling');
const { drainPendingApprovalWaiters } = require('./chat-terminal-tool-repair-planner');
const { acknowledgeFinalizedTurnPersistence, dumpFailedTurnDiagnostic } = require('./managed-sidecar-chat-turn-seams');
const { recordServicePhasePercentile } = require('./phase-percentiles-aggregator');
const { RUNTIME_ERROR_CODES } = require('./error-codes');

function noteRuntimeInferenceSettlement(params, result, onSettled) {
  if (['inference', 'tool'].includes(params?.kind) && params?.phase === 'settle'
    && result?.status === 'settled' && typeof onSettled === 'function') {
    onSettled();
  }
  return result;
}

function reportManagedContinuationAttention(service, runtime, error, diagnostic = null) {
  const identity = runtime.getEventBase();
  const reason = String(error?.reason || error?.message || error);
  service._emitServiceLog('ERROR', 'session_runtime.attention_required', {
    session_id: identity.sessionId, stream_id: identity.streamId, reason,
  });
  // This path returns before the failed-turn machinery, which left no turn
  // diagnostic on disk and let the renderer's client timing expire waiting
  // for one (2026-09-22). Diagnostics never change the attention outcome.
  if (diagnostic) {
    try {
      dumpFailedTurnDiagnostic({ ...diagnostic, service, runtime,
        sessionId: identity.sessionId, streamId: identity.streamId, terminal: { status: 'unknown' },
        normalizedErrorPayload: { error_code: RUNTIME_ERROR_CODES.ADMISSION_REJECTED, message: reason,
          retryable: false, category: 'runtime' },
        sidecarErrorType: 'runtime_attention_required', sidecarErrorMessage: reason });
    } catch (_error) { /* best effort */ }
  }
  // End only the live presentation. Canonical history, actor and quarantined
  // resources stay owned until recovery proves settlement.
  service.emit('chat-stream', { ...identity, type: 'error', terminal_status: 'unknown',
    error_code: RUNTIME_ERROR_CODES.ADMISSION_REJECTED, category: 'runtime', retryable: false,
    message: 'Session runtime needs attention. Settlement could not be confirmed. Open Runtime & orchestration in Settings.',
  });
}

async function finalizeManagedTerminalCleanup({
  service,
  runtime,
  actorRegistry,
  lease,
  turnEventCollector,
  sessionId,
  streamId,
  terminalStatus,
  deferredQuestionBatchEvent,
  beforeRelease,
} = {}) {
  const coordinated = runtime?.isTerminalCoordinatorHandled?.() === true;
  let legacyReleaseResult = null;
  try {
    if (coordinated) {
      drainPendingApprovalWaiters(service, streamId, terminalStatus);
    } else {
      settlePendingApprovalsForStream(service, sessionId, streamId, terminalStatus);
      acknowledgeFinalizedTurnPersistence(service, turnEventCollector, sessionId, streamId);
    }
    await beforeRelease?.();
  } finally {
    if (!coordinated && !lease.released) {
      legacyReleaseResult = actorRegistry.release(lease, {
        status: terminalStatus,
        preserveActiveTurn: runtime.shouldPreserveActiveTurnOnRelease(),
      });
    }
    if (!coordinated && deferredQuestionBatchEvent) {
      runtime.emitQuestionBatchEvent(deferredQuestionBatchEvent);
    }
  }
  const releaseResult = lease?.terminalFinalizeResult || legacyReleaseResult || {};
  return {
    coordinated,
    canonicalSettled: lease?.released === true && !releaseResult.recoveryBlocked,
  };
}

async function finishManagedRuntimeCompletion({ service, runtimeOperationGateway, terminalSettledAt,
  managedSidecarRestartReason, requestTraceId, ...cleanupOptions }) {
  const { sessionId, streamId, terminalStatus } = cleanupOptions;
  const cleanup = await finalizeManagedTerminalCleanup({ service, ...cleanupOptions,
    beforeRelease: async () => {
      if (typeof terminalSettledAt === 'number') {
        recordServicePhasePercentile(service, 'completion_to_terminal_persist',
          Math.max(Date.now() - terminalSettledAt, 0));
      }
      if (managedSidecarRestartReason) {
        if (typeof service._restartManagedSidecar === 'function') {
          await service._restartManagedSidecar(managedSidecarRestartReason);
        } else {
          service._emitServiceLog('WARN', 'chat.sidecar_restart_unavailable', {
            sessionId, streamId, traceId: requestTraceId, reason: managedSidecarRestartReason,
          });
        }
      }
    },
  });
  const inference = runtimeOperationGateway?.snapshot?.();
  return { status: terminalStatus,
    producerSettled: !runtimeOperationGateway || (inference.active === 0 && inference.quarantined === 0),
    canonicalSettled: cleanup.canonicalSettled === true };
}

module.exports = { finalizeManagedTerminalCleanup, finishManagedRuntimeCompletion, noteRuntimeInferenceSettlement,
  reportManagedContinuationAttention };
