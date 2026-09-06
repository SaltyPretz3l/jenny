function normalizeMessageIdPart(value) {
  return String(value || '').trim();
}

function buildToolUseMessageId(streamId, callId) {
  const normalizedStreamId = normalizeMessageIdPart(streamId);
  const normalizedCallId = normalizeMessageIdPart(callId);
  return normalizedStreamId
    ? `tool_use_${normalizedStreamId}_${normalizedCallId}`
    : `tool_use_${normalizedCallId}`;
}

function buildStreamToolUseMessageId(streamId, callId) {
  return `tool_use_${normalizeMessageIdPart(streamId)}_${normalizeMessageIdPart(callId)}`;
}

function buildToolResultMessageId(streamId, callId) {
  const normalizedStreamId = normalizeMessageIdPart(streamId);
  const normalizedCallId = normalizeMessageIdPart(callId);
  return normalizedStreamId
    ? `tool_result_${normalizedStreamId}_${normalizedCallId}`
    : `tool_result_${normalizedCallId}`;
}

function buildStreamToolResultMessageId(streamId, callId) {
  return `tool_result_${normalizeMessageIdPart(streamId)}_${normalizeMessageIdPart(callId)}`;
}

module.exports = {
  buildStreamToolResultMessageId,
  buildStreamToolUseMessageId,
  buildToolResultMessageId,
  buildToolUseMessageId,
};
