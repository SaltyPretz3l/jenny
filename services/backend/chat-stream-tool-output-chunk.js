'use strict';

// `tool.output_chunk` notifications are forward-only and ephemeral: they are
// not persisted or journaled, while the paired tool.result remains durable.

const MAX_CHUNK_LINES = 50;
const MAX_CHUNK_LINE_CHARS = 4000;

function normalizeChunkLines(rawLines) {
  return (Array.isArray(rawLines) ? rawLines : [])
    .slice(0, MAX_CHUNK_LINES)
    .map((line) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) return null;
      const text = String(line.text || '').slice(0, MAX_CHUNK_LINE_CHARS);
      if (!text) return null;
      return {
        stream: line.stream === 'stderr' ? 'stderr' : 'stdout',
        text,
      };
    })
    .filter(Boolean);
}

/**
 * Handle a `tool.output_chunk` notification: re-bound the payload at this
 * trust boundary and forward it to the renderer as a `tool_output_chunk`
 * chat-stream event. Returns true when the notification was claimed.
 */
function handleToolOutputChunkNotification(service, context, notification) {
  if (!notification || notification.method !== 'tool.output_chunk') {
    return false;
  }
  const { eventBase } = context;
  const params = notification.params && typeof notification.params === 'object'
    ? notification.params
    : {};
  const callId = String(params.tool_call_id || '').trim();
  if (!callId) {
    return true;
  }
  const lines = normalizeChunkLines(params.lines);
  // Snapshot of the current unterminated line (prompts, \r progress bars);
  // a batch may carry ONLY a partial and still be worth forwarding.
  const partial = String(params.partial || '').slice(0, MAX_CHUNK_LINE_CHARS);
  if (!lines.length && !partial) {
    return true;
  }
  service.emit('chat-stream', {
    type: 'tool_output_chunk',
    ...eventBase,
    callId,
    toolName: String(params.tool_name || '').trim(),
    sequence: Number(params.sequence) || 0,
    lines,
    partial,
    emittedLines: Number(params.emitted_lines) || 0,
    droppedLines: Number(params.dropped_lines) || 0,
    elapsedMs: Number(params.elapsed_ms) || 0,
  });
  return true;
}

module.exports = {
  MAX_CHUNK_LINES,
  MAX_CHUNK_LINE_CHARS,
  handleToolOutputChunkNotification,
};
