'use strict';

const { normalizeId } = require('../shared/normalize');

const TERMINAL_TOOL_STATUSES = new Set([
  'cancelled', 'complete', 'completed', 'denied', 'error', 'failed', 'interrupted',
]);

function normalizeStatus(value) {
  const status = normalizeId(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
  if (status === 'completed') return 'complete';
  if (status === 'failed') return 'error';
  return status;
}

function completedToolCallIds(messages, streamId) {
  const completed = new Set();
  for (const message of messages) {
    if (normalizeId(message?.kind) !== 'tool_result') continue;
    const result = message?.tool_result || {};
    if (normalizeId(result.parent_stream_id) !== streamId) continue;
    const callId = normalizeId(result.call_id);
    if (callId) completed.add(callId);
  }
  return completed;
}

function planTerminalToolRepairs(messages, streamId, {
  model = '',
  terminalState = 'interrupted',
} = {}) {
  if (!Array.isArray(messages) || !normalizeId(streamId)) {
    return { ok: false, reason: 'invalid_tool_repair_input', repairs: [] };
  }
  const normalizedStreamId = normalizeId(streamId);
  const normalizedTerminalState = normalizeStatus(terminalState);
  const repairState = TERMINAL_TOOL_STATUSES.has(normalizedTerminalState)
    ? normalizedTerminalState
    : 'interrupted';
  const completed = completedToolCallIds(messages, normalizedStreamId);
  const seenCallIds = new Set();
  const seenMessageIds = new Set();
  const repairs = [];
  for (const message of messages) {
    if (normalizeId(message?.kind) !== 'tool_use') continue;
    const toolCall = message?.tool_call || {};
    if (normalizeId(toolCall.parent_stream_id) !== normalizedStreamId) continue;
    const status = normalizeStatus(toolCall.status);
    const approvalState = normalizeStatus(toolCall.approval_state);
    if (
      TERMINAL_TOOL_STATUSES.has(status)
      || (status !== 'running' && status !== 'pending_approval' && approvalState !== 'pending')
    ) {
      continue;
    }
    const messageId = normalizeId(message.id);
    const callId = normalizeId(toolCall.call_id);
    if (!messageId || !callId) {
      return { ok: false, reason: 'malformed_nonterminal_tool_row', repairs: [] };
    }
    if (seenMessageIds.has(messageId) || seenCallIds.has(callId)) {
      return { ok: false, reason: 'ambiguous_nonterminal_tool_row', repairs: [] };
    }
    seenMessageIds.add(messageId);
    seenCallIds.add(callId);
    repairs.push({
      messageId,
      callId,
      model: normalizeId(model),
      ...(completed.has(callId) ? { synthesizeResult: false } : {}),
      patch: {
        tool_call: {
          ...toolCall,
          call_id: callId,
          status: repairState,
          ...(status === 'pending_approval' || approvalState === 'pending'
            ? { approval_state: repairState }
            : {}),
        },
      },
    });
  }
  return { ok: true, reason: null, repairs };
}

function drainPendingApprovalWaiters(service, streamId, terminalState = 'cancelled') {
  const pending = service?.pendingToolApprovals;
  const normalizedStreamId = normalizeId(streamId);
  if (!(pending instanceof Map) || !normalizedStreamId) return 0;
  let drained = 0;
  for (const [callId, waiter] of [...pending.entries()]) {
    if (normalizeId(waiter?.streamId) !== normalizedStreamId) continue;
    try {
      waiter.resolve?.(false, normalizeId(terminalState) || 'cancelled');
    } catch (error) {
      service?._emitServiceLog?.('WARN', 'lifecycle.approval_waiter_drain_failed', {
        streamId: normalizedStreamId,
        callId: normalizeId(callId),
        error: String(error?.message || error || 'unknown_error'),
      });
    } finally {
      pending.delete(callId);
      drained += 1;
    }
  }
  return drained;
}

module.exports = {
  drainPendingApprovalWaiters,
  planTerminalToolRepairs,
};
