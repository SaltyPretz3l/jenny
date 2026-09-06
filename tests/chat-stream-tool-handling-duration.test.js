'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleToolNotification,
} = require('../services/backend/chat-stream-tool-handling');

test('tool result duration is preserved in persistence, the turn event, and renderer output', () => {
  const messages = [];
  const emitted = [];
  const turnEvents = [];
  const service = {
    sessionStore: {
      getSessionMessages() {
        return messages;
      },
      appendMessage(_sessionId, message) {
        messages.push(message);
        return message;
      },
      updateMessage(_sessionId, messageId, patch) {
        const index = messages.findIndex((message) => message.id === messageId);
        if (index >= 0) messages[index] = { ...messages[index], ...patch };
      },
    },
    emit(_name, payload) {
      emitted.push(payload);
    },
    options: { userDataPath: '' },
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'test-model',
    resolvedSessionId: 'session-1',
    streamId: 'stream-1',
    eventBase: { sessionId: 'session-1', streamId: 'stream-1' },
    turnEventCollector: {
      noteEvent(event) {
        turnEvents.push(event);
      },
    },
  };

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-1',
      tool_name: 'read_file',
      success: true,
      duration_ms: 123,
      output: 'ok',
    },
  });

  const persisted = messages.find((message) => message.kind === 'tool_result');
  const turnEvent = turnEvents.find((event) => event.kind === 'tool_result');
  const rendererEvent = emitted.find((event) => event.type === 'tool_result');
  assert.equal(persisted.tool_result.duration_ms, 123);
  assert.equal(turnEvent.payload.duration_ms, 123);
  assert.equal(rendererEvent.durationMs, 123);
});
