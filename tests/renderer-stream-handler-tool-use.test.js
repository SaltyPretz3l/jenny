'use strict';

// Stream tool_use handling: the segment slice roll and the ranAt stamp the sprite
// uses to show sub-frame tools.
const assert = require('node:assert/strict');
const test = require('node:test');

const { createToolHandlerHarness } = require('./helpers/stream-tool-handler-harness');

test('tool_use rolls the segment slice base so the next segment excludes the preamble (W3.6)', async () => {
  const segState = { segmentIndex: 0, aggregateOffset: 19, _lastAggregateLength: 19, segmentBaseOffset: 0 };
  const pendingStreams = new Map([['stream-1', 'assistant_stream-1']]);
  const harness = createToolHandlerHarness({
    streamSegmentState: new Map([['stream-1', segState]]),
    pendingStreams,
  });
  harness.messagesBySession.get('session-1').push({
    id: 'assistant_stream-1',
    role: 'assistant',
    content: 'Let me check that. ',
    status: 'streaming',
    streamId: 'stream-1',
  });

  await harness.handlers.handleToolUse({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-1',
    callId: 'call-2',
    toolName: 'Read',
    summary: 'Reading a.txt',
    status: 'running',
    input: { path: 'a.txt' },
  });

  assert.equal(segState.segmentIndex, 1);
  assert.equal(segState.aggregateOffset, 19);
  assert.equal(segState.segmentBaseOffset, 19);
  assert.equal(pendingStreams.has('stream-1'), false);
  const preamble = harness.messagesBySession.get('session-1').find((message) => message.id === 'assistant_stream-1');
  assert.equal(preamble.content, 'Let me check that. ');
  assert.equal(preamble.status, 'complete');
});

test('tool_use stamps when a tool first ran and the result keeps the stamp (the sprite shows sub-frame tools)', async () => {
  const harness = createToolHandlerHarness();
  await harness.handlers.handleToolUse({
    type: 'tool_use', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-2',
    toolName: 'write_file', status: 'requested', input: { path: 'a.txt' },
  });
  const entry = () => harness.state.toolCallsByStream.get('stream-1').find((tool) => tool.callId === 'call-2');
  assert.equal(entry().ranAt, 0, 'a requested tool has not run');
  const before = Date.now();
  await harness.handlers.handleToolUse({
    type: 'tool_use', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-2',
    toolName: 'write_file', status: 'running', input: { path: 'a.txt' },
  });
  const ranAt = entry().ranAt;
  assert.ok(ranAt >= before && ranAt <= Date.now());
  await harness.handlers.handleToolUse({
    type: 'tool_use', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-2',
    toolName: 'write_file', status: 'running', input: { path: 'a.txt' },
  });
  assert.equal(entry().ranAt, ranAt, 'a repeated running event keeps the first stamp');
  await harness.handlers.handleToolResult({
    type: 'tool_result', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-2',
    toolName: 'write_file', outputText: 'ok', isError: false,
  });
  assert.equal(entry().status, 'completed');
  assert.equal(entry().ranAt, ranAt);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await harness.handlers.handleToolUse({
    type: 'tool_use', sessionId: 'session-1', streamId: 'stream-1', callId: 'call-2',
    toolName: 'write_file', status: 'running', input: { path: 'a.txt' },
  });
  assert.ok(entry().ranAt > ranAt, 'a reused call id that runs again gets a fresh stamp');
});
