const {
  convertToolResultToProviderMessage,
  convertToolUseToProviderMessage,
} = require('./chat-stream-reasoning');

function buildCompactPayloadMessage(message) {
  const compactMessage = {
    role: String(message?.role || ''),
    content: String(message?.content || ''),
  };
  const kind = String(message?.kind || '');
  const semanticMessage = kind === 'tool_use' && compactMessage.role === 'assistant'
    ? convertToolUseToProviderMessage(message)
    : kind === 'tool_result' && compactMessage.role === 'tool'
      ? convertToolResultToProviderMessage(message)
      : null;
  if (semanticMessage?.tool_calls) compactMessage.tool_calls = semanticMessage.tool_calls;
  for (const field of ['tool_call_id', 'name', 'error_code']) {
    if (field in (semanticMessage || {})) compactMessage[field] = semanticMessage[field];
  }
  if (semanticMessage?.is_error === true) compactMessage.is_error = true;
  return compactMessage;
}

function buildCompactPayloadMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(buildCompactPayloadMessage);
}

module.exports = { buildCompactPayloadMessages };
