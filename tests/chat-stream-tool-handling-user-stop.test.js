'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { settleUnfinishedToolsForStream } = require('../services/backend/chat-stream-tool-handling');

// Sibling of chat-stream-tool-handling.test.js, which is at the file-size cap.

test('settleUnfinishedToolsForStream settles a user Stop as cancelled, not a system error (F3)', () => {
  const { statusForToolResult } = require('../renderer/chat/tool-call-utils');
  function settle(terminalState) {
    const sessionMessages = [{
      id: 'tool_use_call-stop',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call-stop', tool_name: 'python_execute', input: {}, summary: 'Run Python',
        status: 'running', approval_state: 'auto', parent_stream_id: 'stream-stop',
      },
    }];
    const emitted = [];
    const turnEvents = [];
    settleUnfinishedToolsForStream({
      sessionStore: {
        getSessionMessages: () => sessionMessages,
        updateMessage(_sessionId, messageId, patch) {
          const index = sessionMessages.findIndex((message) => message.id === messageId);
          sessionMessages[index] = { ...sessionMessages[index], ...patch };
        },
        appendMessage(_sessionId, message) { sessionMessages.push(message); },
      },
      emit(_eventName, payload) { emitted.push(payload); },
      _emitServiceLog() {},
      currentModel: 'test-model',
    }, {
      model: 'test-model',
      resolvedSessionId: 'session-stop',
      streamId: 'stream-stop',
      eventBase: { streamId: 'stream-stop', sessionId: 'session-stop' },
      turnEventCollector: { noteEvent(event) { turnEvents.push(event); } },
    }, terminalState);
    const result = sessionMessages.find((message) => message.kind === 'tool_result').tool_result;
    return { result, event: turnEvents[0], live: emitted.find((payload) => payload.type === 'tool_result') };
  }

  const stopped = settle('cancelled');
  assert.equal(stopped.result.output_text, 'Tool execution stopped by the user before it finished.');
  assert.equal(stopped.result.approval_state, 'cancelled');
  assert.equal(stopped.event.status, 'cancelled');
  assert.equal(stopped.live.content, stopped.result.output_text);
  // Every renderer reading (persisted message, turn event, live patch) says Cancelled.
  assert.equal(statusForToolResult(stopped.result), 'cancelled');
  assert.equal(statusForToolResult(stopped.event.payload), 'cancelled');
  assert.equal(statusForToolResult({ approval_state: stopped.live.approvalState, is_error: true }), 'cancelled');

  const interrupted = settle('interrupted');
  assert.match(interrupted.result.output_text, /^System error: tool execution interrupted/);
  assert.equal(interrupted.event.status, 'error');
  assert.equal(statusForToolResult(interrupted.result), 'interrupted');
});
