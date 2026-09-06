'use strict';

const { settlePendingApprovalsForStream } = require('./chat-stream-tool-handling');
const { drainPendingApprovalWaiters } = require('./chat-terminal-tool-repair-planner');
const { acknowledgeFinalizedTurnPersistence } = require('./managed-sidecar-chat-turn-seams');

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
      actorRegistry.release(lease, {
        status: terminalStatus,
        preserveActiveTurn: runtime.shouldPreserveActiveTurnOnRelease(),
      });
    }
    if (!coordinated && deferredQuestionBatchEvent) {
      runtime.emitQuestionBatchEvent(deferredQuestionBatchEvent);
    }
  }
  return { coordinated };
}

module.exports = { finalizeManagedTerminalCleanup };
