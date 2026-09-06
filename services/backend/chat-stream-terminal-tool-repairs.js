'use strict';

const { LOOP_PROTOCOL_ERROR_CODES } = require('./error-codes');
const { buildToolResultMessageId } = require('./tool-message-id');
const { normalizeId } = require('../shared/normalize');

const TOOL_INTERRUPTED_OUTPUT = 'System error: tool execution interrupted. Retry if needed.';
const TERMINAL_TOOL_STATUSES = new Set([
  'cancelled', 'complete', 'denied', 'error', 'interrupted',
]);

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeToolStatus(value) {
  const normalized = normalizeId(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s.-]+/g, '_')
    .toLowerCase();
  if (normalized === 'completed') return 'complete';
  if (normalized === 'failed') return 'error';
  return normalized;
}

function repairToolCall(repair) {
  const source = repair?.patch?.tool_call || repair?.patch?.toolCall || {};
  return isRecord(source) ? source : {};
}

function repairCallId(repair) {
  const toolCall = repairToolCall(repair);
  const explicit = normalizeId(repair?.callId);
  const patched = normalizeId(toolCall.call_id || toolCall.callId);
  if (explicit && patched && explicit !== patched) return '';
  return explicit || patched;
}

function repairStatus(repair) {
  return normalizeToolStatus(
    repair?.patch?.tool_call?.status
    || repair?.patch?.toolCall?.status
    || repair?.patch?.status
    || repair?.status
  );
}

function buildInterruptedToolResult(repair, identity, timestamp) {
  const toolCall = repairToolCall(repair);
  const callId = repairCallId(repair);
  if (!callId) return null;
  const toolName = normalizeId(toolCall.tool_name || toolCall.toolName);
  const summary = normalizeId(toolCall.summary);
  const status = repairStatus(repair);
  return {
    id: buildToolResultMessageId(identity.streamId, callId),
    role: 'tool',
    kind: 'tool_result',
    content: TOOL_INTERRUPTED_OUTPUT,
    timestamp,
    finalizedAt: timestamp,
    model_used: normalizeId(repair?.model || repair?.patch?.model_used),
    tool_result: {
      call_id: callId,
      tool_name: toolName,
      output_text: TOOL_INTERRUPTED_OUTPUT,
      summary,
      is_error: true,
      error_code: LOOP_PROTOCOL_ERROR_CODES.TOOL_INTERRUPTED,
      exit_code: null,
      duration_ms: 0,
      parent_stream_id: identity.streamId,
      generated_artifacts: [],
      metadata: {
        recovery: 'orphaned_tool_call',
        terminal_state: status,
      },
    },
  };
}

function buildToolResultTurnEvent(resultMessage, identity, timestamp) {
  const toolResult = isRecord(resultMessage?.tool_result) ? resultMessage.tool_result : {};
  const callId = normalizeId(toolResult.call_id || toolResult.callId);
  const messageId = normalizeId(resultMessage?.id);
  if (!callId || !messageId) return null;
  const isError = toolResult.is_error === true;
  return {
    event_id: `terminal_repair:${identity.turnId}:${callId}:tool_result`,
    turn_id: identity.turnId,
    kind: 'tool_result',
    status: isError ? 'error' : 'complete',
    primary_message_id: messageId,
    source_message_ids: [messageId],
    tool_call_id: callId,
    completed_at: normalizeId(resultMessage.finalizedAt || resultMessage.timestamp) || timestamp,
    payload: {
      tool_name: normalizeId(toolResult.tool_name || toolResult.toolName),
      output_text: String(toolResult.output_text ?? resultMessage.content ?? ''),
      summary: normalizeId(toolResult.summary),
      is_error: isError,
      error_code: normalizeId(toolResult.error_code) || null,
      approval_state: normalizeId(toolResult.metadata?.terminal_state) || null,
      parent_stream_id: normalizeId(toolResult.parent_stream_id) || identity.streamId,
      generated_artifacts: Array.isArray(toolResult.generated_artifacts)
        ? toolResult.generated_artifacts.map((artifact) => ({ ...artifact }))
        : [],
    },
  };
}

function buildInterruptedToolRepairPlan(repair, identity, timestamp) {
  const resultMessage = buildInterruptedToolResult(repair, identity, timestamp);
  if (!resultMessage) return null;
  const toolResult = resultMessage.tool_result;
  const callId = toolResult.call_id;
  return {
    repair: {
      messageId: normalizeId(repair.messageId),
      callId,
      patch: { ...repair.patch },
    },
    resultMessage,
    turnEvent: {
      event_id: `terminal_repair:${identity.turnId}:${callId}:tool_result`,
      turn_id: identity.turnId,
      kind: 'tool_result',
      status: 'error',
      primary_message_id: resultMessage.id,
      source_message_ids: [resultMessage.id],
      tool_call_id: callId,
      completed_at: timestamp,
      payload: {
        tool_name: toolResult.tool_name,
        output_text: toolResult.output_text,
        summary: toolResult.summary,
        is_error: true,
        error_code: toolResult.error_code,
        approval_state: toolResult.metadata.terminal_state,
        parent_stream_id: identity.streamId,
        generated_artifacts: [],
      },
    },
  };
}

function normalizeTerminalMutations(messages, toolRepairs, identity, timestamp) {
  if (!Array.isArray(messages) || !Array.isArray(toolRepairs)) {
    return { ok: false, reason: 'invalid_terminal_mutation_lists' };
  }
  const normalizedMessages = [];
  const messageIds = new Set();
  for (const message of messages) {
    const messageId = normalizeId(message?.id);
    if (!isRecord(message) || !messageId) {
      return { ok: false, reason: 'invalid_terminal_message' };
    }
    if (messageIds.has(messageId)) {
      return { ok: false, reason: 'duplicate_terminal_message_id' };
    }
    messageIds.add(messageId);
    normalizedMessages.push({ ...message, id: messageId });
  }

  const normalizedRepairs = [];
  const repairTurnEvents = [];
  for (const repair of toolRepairs) {
    const messageId = normalizeId(repair?.messageId);
    const status = repairStatus(repair);
    const plan = buildInterruptedToolRepairPlan(repair, identity, timestamp);
    if (
      !messageId
      || !isRecord(repair?.patch)
      || !TERMINAL_TOOL_STATUSES.has(status)
      || !plan
    ) {
      return { ok: false, reason: 'invalid_tool_repair' };
    }
    normalizedRepairs.push(plan.repair);
    if (repair.synthesizeResult === false) continue;
    const resultMessage = isRecord(repair.resultMessage)
      ? { ...repair.resultMessage, id: normalizeId(repair.resultMessage.id) }
      : plan.resultMessage;
    const turnEvent = buildToolResultTurnEvent(resultMessage, identity, timestamp);
    if (
      !resultMessage?.id
      || !turnEvent
      || turnEvent.tool_call_id !== plan.repair.callId
    ) {
      return { ok: false, reason: 'tool_repair_result_identity_mismatch' };
    }
    if (!messageIds.has(resultMessage.id)) {
      messageIds.add(resultMessage.id);
      normalizedMessages.push(resultMessage);
    }
    repairTurnEvents.push(turnEvent);
  }
  return {
    ok: true,
    messages: normalizedMessages,
    toolRepairs: normalizedRepairs,
    repairTurnEvents,
  };
}

module.exports = {
  TERMINAL_TOOL_STATUSES,
  buildInterruptedToolRepairPlan,
  normalizeTerminalMutations,
};
