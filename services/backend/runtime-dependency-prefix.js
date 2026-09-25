'use strict';

const { stableJson } = require('../session-runtime/contracts');
const { buildPreparedContinuationPrefix, convertToolResultToProviderMessage } = require('./chat-stream-reasoning');
const { modelInputJson } = require('./runtime-decision-prefix');

function fail() { throw new Error('runtime_dependency_prefix_order_unavailable'); }
function buildDependencyPrefix(rows, events) {
  const toolEvents = events.filter(event => ['tool_use', 'tool_executing', 'tool_result'].includes(event.kind));
  for (const row of rows) {
    const call = row.tool_call || row.tool_result;
    if (!call) continue;
    const event = toolEvents.find(item => item.tool_call_id === call.call_id
      && (row.tool_call ? ['tool_use', 'tool_executing'].includes(item.kind) : item.kind === 'tool_result'));
    if (!event || !['session_spawn', 'session_wait'].includes(call.tool_name) || call.tool_name !== event.payload.tool_name) fail();
    if (row.tool_call && stableJson(call.input || {}) !== stableJson(event.payload.tool_input)) fail();
    if (row.tool_result && String(call.output_text || row.content || '') !== event.payload.tool_output_summary) fail();
  }
  const messages = [];
  let text = [];
  let calls = [];
  let outstanding = new Set();
  let emitted = false;
  const flush = () => { messages.push(...buildPreparedContinuationPrefix([], text)); text = []; };
  for (const event of events) {
    if (event.kind === 'assistant_text_segment' || event.kind === 'reasoning_phase') { text.push(event); continue; }
    if (['tool_use', 'tool_executing'].includes(event.kind)) {
      if (outstanding.has(event.tool_call_id)) continue;
      if (emitted) fail();
      calls.push({ id: event.tool_call_id, type: 'function', function: {
        name: event.payload.tool_name,
        arguments: modelInputJson(rows, event.tool_call_id) || JSON.stringify(event.payload.tool_input) } });
      outstanding.add(event.tool_call_id);
    } else if (event.kind === 'tool_result') {
      if (!outstanding.has(event.tool_call_id)) fail();
      if (!emitted) {
        flush();
        messages.push({ role: 'assistant', content: null, tool_calls: calls });
        emitted = true;
      }
      messages.push(convertToolResultToProviderMessage({ tool_result: {
        call_id: event.tool_call_id, tool_name: event.payload.tool_name,
        output_text: event.payload.tool_output_summary, metadata: event.payload.metadata || {} } }));
      outstanding.delete(event.tool_call_id);
      if (!outstanding.size) { calls = []; emitted = false; }
    } else fail();
  }
  if (outstanding.size) fail();
  flush();
  return messages;
}

module.exports = { buildDependencyPrefix };
