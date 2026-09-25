"use strict";

const { buildPreparedContinuationPrefix, convertToolResultToProviderMessage } = require('./chat-stream-reasoning');

// Event payloads carry path-redacted tool_input; the turn's tool_use row keeps
// the workspace-relative arguments the model should see as its own.
function modelInputJson(rows, callId) {
  return rows.find(row => row.tool_call?.call_id === callId
    && typeof row.tool_call.model_input_json === 'string'
    && row.tool_call.model_input_json.length > 0)?.tool_call.model_input_json;
}

// Only canonical completed results are replayed. Pending announcements and old
// approval projections remain durable evidence, never fresh provider actions.
function buildDecisionPrefix(events, completedRefs, rows = []) {
  const completed = new Set(completedRefs.map(ref => ref.call_id));
  const messages = [];
  let text = [];
  const flush = () => { messages.push(...buildPreparedContinuationPrefix([], text)); text = []; };
  for (const event of events) {
    if (['assistant_text_segment', 'reasoning_phase'].includes(event.kind)) { text.push(event); continue; }
    if (event.kind !== 'tool_result' || !completed.has(event.tool_call_id)) continue;
    flush();
    const payload = event.payload;
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: event.tool_call_id,
      type: 'function', function: { name: payload.tool_name,
        arguments: modelInputJson(rows, event.tool_call_id) || JSON.stringify(payload.tool_input || {}) } }] });
    const message = convertToolResultToProviderMessage({ tool_result: { call_id: event.tool_call_id,
      tool_name: payload.tool_name, output_text: payload.tool_output_summary,
      is_error: payload.success === false, error_code: payload.error_code, metadata: payload.metadata || {} } });
    // Current-turn output is already canonical; avoid historical summarization.
    message.content = payload.tool_output_summary;
    messages.push(message);
  }
  flush();
  return messages;
}
module.exports = { buildDecisionPrefix, modelInputJson };
