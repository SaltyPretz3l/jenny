'use strict';

const { normalizeId } = require('../shared/normalize');

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function matchingIndexes(messages, messageId) {
  const target = normalizeId(messageId);
  const indexes = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (normalizeId(messages[index]?.id) === target) indexes.push(index);
  }
  return indexes;
}

function mergeRepair(message, repair) {
  const patch = repair.patch;
  const merged = {
    ...message,
    ...patch,
    id: message.id,
    timestamp: message.timestamp,
    ...(patch.tool_call
      ? { tool_call: { ...(message.tool_call || {}), ...patch.tool_call } }
      : {}),
    ...(patch.tool_result
      ? { tool_result: { ...(message.tool_result || {}), ...patch.tool_result } }
      : {}),
  };
  const callId = normalizeId(repair.callId);
  const observed = normalizeId(merged.tool_call?.call_id || merged.tool_result?.call_id);
  return callId && observed !== callId ? null : merged;
}

function buildTerminalTranscriptPreview(currentMessages, {
  messages: proposedMessages = [],
  toolRepairs = [],
} = {}) {
  if (
    !Array.isArray(currentMessages)
    || !Array.isArray(proposedMessages)
    || !Array.isArray(toolRepairs)
  ) return { ok: false, reason: 'invalid_terminal_preview_input', messages: [] };
  const messages = currentMessages.map((message) => ({
    ...message,
    ...(isRecord(message?.tool_call) ? { tool_call: { ...message.tool_call } } : {}),
    ...(isRecord(message?.tool_result) ? { tool_result: { ...message.tool_result } } : {}),
  }));
  const proposedIds = new Set();
  for (const proposed of proposedMessages) {
    const messageId = normalizeId(proposed?.id);
    if (!isRecord(proposed) || !messageId || proposedIds.has(messageId)) {
      return { ok: false, reason: 'invalid_terminal_preview_message', messages: [] };
    }
    proposedIds.add(messageId);
    const matches = matchingIndexes(messages, messageId);
    if (matches.length > 1) {
      return { ok: false, reason: 'ambiguous_terminal_preview_message', messages: [] };
    }
    if (matches.length === 1) {
      const current = messages[matches[0]];
      messages[matches[0]] = {
        ...proposed,
        id: current.id,
        timestamp: proposed.timestamp || current.timestamp,
        ...(Number.isInteger(current.event_seq) ? { event_seq: current.event_seq } : {}),
      };
    } else {
      messages.push({ ...proposed, id: messageId });
    }
  }
  const repairedIds = new Set();
  for (const repair of toolRepairs) {
    const messageId = normalizeId(repair?.messageId);
    if (!messageId || !isRecord(repair?.patch) || repairedIds.has(messageId)) {
      return { ok: false, reason: 'invalid_terminal_preview_repair', messages: [] };
    }
    const matches = matchingIndexes(messages, messageId);
    if (matches.length !== 1) {
      return { ok: false, reason: 'terminal_preview_repair_not_exact', messages: [] };
    }
    const repaired = mergeRepair(messages[matches[0]], repair);
    if (!repaired) return { ok: false, reason: 'terminal_preview_call_mismatch', messages: [] };
    messages[matches[0]] = repaired;
    repairedIds.add(messageId);
  }
  return { ok: true, reason: null, messages };
}

module.exports = { buildTerminalTranscriptPreview };
