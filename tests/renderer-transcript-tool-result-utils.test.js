const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildSyntheticToolResultMeta,
  collectProjectedToolMessages,
  findToolResultForCallId,
  isToolResultError,
  normalizeToolRenderStatus,
  readToolResultDurationMs,
  readToolResultGeneratedArtifacts,
  readToolResultOutputText,
} = require('../renderer/chat/renderer-transcript-tool-result-utils');

test('result lookup prefers the exact owner object when message ids repeat across turns', () => {
  const owner = { id: 'shared', role: 'assistant', kind: 'tool_use' };
  const oldResult = { id: 'old', kind: 'tool_result', tool_result: { call_id: 'call_1' } };
  const currentResult = { id: 'current', kind: 'tool_result', tool_result: { call_id: 'call_1' } };
  const messages = [
    { id: 'shared', role: 'assistant' }, oldResult,
    { id: 'next-user', role: 'user' }, owner, currentResult,
  ];

  assert.equal(findToolResultForCallId(messages, 'call_1', { ownerMessage: owner }), currentResult);
});

test('tool result helpers normalize status and result compatibility fields', () => {
  assert.equal(normalizeToolRenderStatus(''), 'requested');
  assert.equal(normalizeToolRenderStatus('pending_approval'), 'awaiting_approval');
  assert.equal(normalizeToolRenderStatus('ERROR'), 'errored');
  assert.equal(normalizeToolRenderStatus('timeout'), 'timed_out');
  assert.equal(normalizeToolRenderStatus('preempted'), 'cancelled');

  const resultMeta = {
    outputText: 'done',
    isError: true,
    durationMs: 0,
    generatedArtifacts: [{ artifactId: 'artifact-1' }],
  };
  assert.equal(isToolResultError(resultMeta), true);
  assert.equal(readToolResultOutputText(resultMeta), 'done');
  assert.deepEqual(readToolResultGeneratedArtifacts(resultMeta), [{ artifactId: 'artifact-1' }]);
  assert.equal(readToolResultDurationMs(resultMeta, 1250), 1250);
});

test('projected tool messages resolve source ids through the provided index and include fallback messages', () => {
  const toolUse = { id: 'tool_use_call_1', kind: 'tool_use' };
  const toolResult = { id: 'tool_result_call_1', kind: 'tool_result' };
  const fallback = { id: 'fallback_message', kind: 'tool_use' };
  const messageById = new Map([
    ['tool_use_call_1', toolUse],
    ['tool_result_call_1', toolResult],
  ]);

  const messages = collectProjectedToolMessages(
    {
      source_message_ids: [
        'tool_use_call_1',
        'missing',
        'tool_result_call_1',
      ],
    },
    [],
    messageById,
    fallback
  );

  assert.deepEqual(messages, [toolUse, toolResult, fallback]);
});

test('synthetic tool result metadata is cloned from projected row payloads only when result fields exist', () => {
  assert.equal(buildSyntheticToolResultMeta({ payload: { tool_call_id: 'empty' } }), null);

  const artifact = { artifactId: 'artifact-synthetic', title: 'Preview' };
  const metadata = { diff: { file_path: 'src/app.js' } };
  const resultMeta = buildSyntheticToolResultMeta({
    tool_call_id: 'call-synthetic',
    payload: {
      tool_name: 'Write',
      output_text: 'wrote file',
      result_summary: 'done',
      result_is_error: false,
      generated_artifacts: [artifact],
      metadata,
    },
  });

  assert.equal(resultMeta.call_id, 'call-synthetic');
  assert.equal(resultMeta.tool_name, 'Write');
  assert.equal(resultMeta.output_text, 'wrote file');
  assert.deepEqual(resultMeta.generated_artifacts, [artifact]);
  assert.notEqual(resultMeta.generated_artifacts[0], artifact);
  assert.deepEqual(resultMeta.metadata, metadata);
  assert.notEqual(resultMeta.metadata, metadata);
});
