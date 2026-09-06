const { normalizeString: normalizeToken } = require('../shared/normalize');

const MAX_PENDING_APPROVAL_SUMMARY_CHARS = 500;

function hasActiveStreamRegistry(service) {
  return Boolean(service?.activeStreams && typeof service.activeStreams.has === 'function');
}

function hasRegisteredActiveStream(service, streamId) {
  const normalizedStreamId = normalizeToken(streamId);
  if (!normalizedStreamId || !hasActiveStreamRegistry(service)) {
    return false;
  }
  return service.activeStreams.has(normalizedStreamId);
}

function findPendingApproval(service, sessionId, streamId) {
  if (!(service?.pendingToolApprovals instanceof Map)) {
    return null;
  }
  for (const pending of service.pendingToolApprovals.values()) {
    if (
      normalizeToken(pending?.sessionId) !== sessionId
      || normalizeToken(pending?.streamId) !== streamId
    ) {
      continue;
    }
    const callId = normalizeToken(pending?.callId);
    const toolName = normalizeToken(pending?.toolName);
    if (!callId || !toolName) {
      continue;
    }
    return {
      approvalId: normalizeToken(pending?.approvalId),
      callId,
      toolName,
      policyScope: normalizeToken(pending?.policyScope),
      policyConsequence: normalizeToken(pending?.policyConsequence),
      reason: normalizeToken(pending?.reason),
      summary: normalizeToken(pending?.summary),
    };
  }
  return null;
}

function readPendingApprovalSummary(service, sessionId, callId) {
  if (typeof service?.sessionStore?.getSessionMessages !== 'function') {
    return '';
  }
  try {
    const messages = service.sessionStore.getSessionMessages(sessionId);
    const message = (Array.isArray(messages) ? messages : []).find((candidate) =>
      normalizeToken(candidate?.kind) === 'tool_use'
      && normalizeToken(candidate?.tool_call?.call_id) === callId
      && normalizeToken(candidate?.tool_call?.status) === 'pending_approval'
    );
    return normalizeToken(message?.tool_call?.summary || message?.content)
      .slice(0, MAX_PENDING_APPROVAL_SUMMARY_CHARS);
  } catch (error) {
    service._emitServiceLog?.('WARN', 'backend.active_turn_pending_summary_read_failed', {
      sessionId,
      callId,
      message: normalizeToken(error?.message || error).slice(0, 300),
    });
    return '';
  }
}

function getManagedActiveTurnState(service, sessionId) {
  const normalizedSessionId = normalizeToken(sessionId);
  if (
    !normalizedSessionId
    || typeof service?.sessionStore?.getActiveTurn !== 'function'
    || !hasActiveStreamRegistry(service)
  ) {
    return null;
  }

  let activeTurn;
  try {
    activeTurn = service.sessionStore.getActiveTurn(normalizedSessionId);
  } catch (error) {
    service._emitServiceLog?.('WARN', 'backend.active_turn_state_read_failed', {
      sessionId: normalizedSessionId,
      message: normalizeToken(error?.message || error).slice(0, 300),
    });
    return null;
  }
  if (!activeTurn || typeof activeTurn !== 'object' || Array.isArray(activeTurn)) {
    return null;
  }

  const requestId = normalizeToken(activeTurn.request_id);
  const streamId = normalizeToken(activeTurn.stream_id || requestId);
  if (!requestId || !streamId || !hasRegisteredActiveStream(service, streamId)) {
    return null;
  }

  const pending = findPendingApproval(service, normalizedSessionId, streamId);
  const pendingApproval = pending
    ? {
        ...(pending.approvalId ? { approval_id: pending.approvalId } : {}),
        call_id: pending.callId,
        tool_name: pending.toolName,
        ...(pending.policyScope ? { policy_scope: pending.policyScope } : {}),
        ...(pending.policyConsequence ? { policy_consequence: pending.policyConsequence } : {}),
        ...(pending.reason ? { reason: pending.reason } : {}),
        summary: (pending.summary || readPendingApprovalSummary(
          service,
          normalizedSessionId,
          pending.callId
        )).slice(0, MAX_PENDING_APPROVAL_SUMMARY_CHARS),
      }
    : null;
  const status = normalizeToken(activeTurn.status);
  return {
    ...activeTurn,
    request_id: requestId,
    stream_id: streamId,
    session_id: normalizedSessionId,
    state: pendingApproval ? 'pending_approval' : status,
    phase: pendingApproval
      ? 'approval_wait'
      : normalizeToken(activeTurn.agent_stage) || null,
    terminal_reason: null,
    terminal_subcode: null,
    ...(pendingApproval ? { pending_approval: pendingApproval } : {}),
  };
}

module.exports = {
  getManagedActiveTurnState,
  hasActiveStreamRegistry,
  hasRegisteredActiveStream,
};
