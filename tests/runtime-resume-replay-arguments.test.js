'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDecisionPrefix } = require('../services/backend/runtime-decision-prefix');
const { buildDependencyPrefix } = require('../services/backend/runtime-dependency-prefix');

const redactedInput = { path: '[redacted:path]\\src\\a.js' };
const modelInputJson = '{"path":"src\\\\a.js"}';

function decisionEvent() {
  return { event_id: 'stream:canonical:1', turn_id: 'turn', kind: 'tool_result', tool_call_id: 'call_1',
    payload: { canonical_seq: 1, tool_name: 'read_file', tool_input: redactedInput,
      tool_output_summary: 'file contents', success: true, metadata: {} } };
}

test('decision prefix replays workspace-relative model tool arguments', () => {
  const messages = buildDecisionPrefix([decisionEvent()], [{ call_id: 'call_1' }], [
    { role: 'assistant', tool_call: { call_id: 'call_1', tool_name: 'read_file',
      input: redactedInput, model_input_json: modelInputJson } },
  ]);

  const argumentsJson = messages[0].tool_calls[0].function.arguments;
  assert.equal(argumentsJson, modelInputJson);
  assert.equal(argumentsJson.includes('[redacted:path]'), false);
});

test('decision prefix preserves canonical event input fallback for old or unmatched rows', () => {
  const expected = JSON.stringify(redactedInput);
  for (const rows of [[], [
    { role: 'assistant', tool_call: { call_id: 'call_1', tool_name: 'read_file', input: redactedInput } },
  ], [
    { role: 'assistant', tool_call: { call_id: 'other_call', tool_name: 'read_file',
      input: redactedInput, model_input_json: modelInputJson } },
  ]]) {
    const messages = buildDecisionPrefix([decisionEvent()], [{ call_id: 'call_1' }], rows);
    assert.equal(messages[0].tool_calls[0].function.arguments, expected);
  }
});

test('dependency prefix replays workspace-relative model tool arguments', () => {
  const toolInput = { task: 'Inspect [redacted:path]\\src\\a.js' };
  const relativeModelInputJson = '{"task":"Inspect src\\\\a.js"}';
  const output = '{"child_work_id":"child_1"}';
  const events = ['tool_use', 'tool_executing', 'tool_result'].map((kind, index) => ({
    event_id: `stream:canonical:${index + 1}`,
    turn_id: 'turn',
    kind,
    tool_call_id: 'spawn_1',
    payload: {
      canonical_seq: index + 1,
      canonical_event_type: ['tool_call_requested', 'tool_execution_started', 'tool_execution_completed'][index],
      tool_name: 'session_spawn',
      tool_input: toolInput,
      ...(kind === 'tool_result' ? { success: true, tool_output_summary: output } : {}),
    },
  }));
  const rows = [
    { role: 'assistant', tool_call: { call_id: 'spawn_1', tool_name: 'session_spawn',
      input: toolInput, model_input_json: relativeModelInputJson } },
    { role: 'tool', tool_result: { call_id: 'spawn_1', tool_name: 'session_spawn', output_text: output } },
  ];

  const messages = buildDependencyPrefix(rows, events);
  assert.equal(messages[0].tool_calls[0].function.arguments, relativeModelInputJson);
  assert.equal(messages[0].tool_calls[0].function.arguments.includes('[redacted:path]'), false);

  const oldSessionRows = structuredClone(rows);
  delete oldSessionRows[0].tool_call.model_input_json;
  const fallbackMessages = buildDependencyPrefix(oldSessionRows, events);
  assert.equal(fallbackMessages[0].tool_calls[0].function.arguments, JSON.stringify(toolInput));
});
