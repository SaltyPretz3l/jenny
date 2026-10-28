'use strict';

// An approved tool_use row keeps its consent through the executing and result
// rewrites instead of being relabelled `auto` (tool review, 2026-10-19).

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleToolNotification } = require('../services/backend/chat-stream-tool-handling');
const { buildToolUseMessageId } = require('../services/backend/tool-message-id');
const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');

function makeStore(seed) {
  const messages = [...seed];
  return {
    messages,
    getSessionMessages() { return messages; },
    appendMessage(_sessionId, message) { messages.push(message); },
    updateMessage(_sessionId, messageId, patch) {
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index !== -1) messages[index] = { ...messages[index], ...patch };
    },
  };
}

function approvedRow(streamId, callId) {
  return {
    id: buildToolUseMessageId(streamId, callId),
    kind: 'tool_use',
    role: 'assistant',
    tool_call: {
      call_id: callId,
      approval_id: 'apr-1',
      reason: 'Writes notes.md',
      policy_scope: 'Workspace files',
      policy_consequence: 'Writes files',
      tool_name: 'write_file',
      status: 'approved',
      approval_state: 'approved',
      parent_stream_id: streamId,
    },
  };
}

test('executing and result rewrites carry an approved row\'s consent forward', () => {
  const streamId = 'stream-carry';
  const callId = 'call-carry';
  const sessionStore = makeStore([approvedRow(streamId, callId)]);
  const service = { sessionStore, emit() {}, pendingToolApprovals: new Map(), currentModel: 'm' };
  const collector = new CanonicalTurnEventCollector({ sessionId: 'session-carry', streamId, turnId: streamId });
  const context = {
    seenToolCalls: new Set(), toolSummaries: new Map(), model: 'm',
    resolvedSessionId: 'session-carry', streamId,
    eventBase: { sessionId: 'session-carry', streamId, model: 'm' },
    turnEventCollector: collector,
  };
  const params = { request_id: streamId, tool_call_id: callId, tool_name: 'write_file', tool_input: { path: 'notes.md' } };

  handleToolNotification(service, context, { method: 'tool.executing', params });
  let [row] = sessionStore.messages.filter((message) => message.kind === 'tool_use');
  assert.equal(row.tool_call.status, 'running');
  assert.equal(row.tool_call.approval_state, 'approved');
  assert.equal(row.tool_call.approval_id, 'apr-1');
  assert.equal(row.tool_call.policy_scope, 'Workspace files');
  assert.equal(row.tool_call.reason, 'Writes notes.md');

  handleToolNotification(service, context, {
    method: 'tool.result', params: { ...params, success: true, output: 'written', duration_ms: 5 },
  });
  [row] = sessionStore.messages.filter((message) => message.kind === 'tool_use');
  assert.equal(row.tool_call.status, 'completed');
  assert.equal(row.tool_call.approval_state, 'approved');
  assert.equal(row.tool_call.approval_id, 'apr-1');
  const resultEvent = collector.capturedEvents.find((event) => event.kind === 'tool_result');
  assert.equal(resultEvent.payload.approval_state, 'approved');
});

test('an auto row stays auto through the same rewrites', () => {
  const streamId = 'stream-auto';
  const callId = 'call-auto';
  const sessionStore = makeStore([]);
  const service = { sessionStore, emit() {}, pendingToolApprovals: new Map(), currentModel: 'm' };
  const context = {
    seenToolCalls: new Set(), toolSummaries: new Map(), model: 'm',
    resolvedSessionId: 'session-auto', streamId,
    eventBase: { sessionId: 'session-auto', streamId, model: 'm' },
  };
  const params = { request_id: streamId, tool_call_id: callId, tool_name: 'read_file', tool_input: { path: 'a.md' } };
  handleToolNotification(service, context, { method: 'tool.executing', params });
  handleToolNotification(service, context, { method: 'tool.result', params: { ...params, success: true, output: 'x' } });
  const [row] = sessionStore.messages.filter((message) => message.kind === 'tool_use');
  assert.equal(row.tool_call.approval_state, 'auto');
  assert.equal(Object.hasOwn(row.tool_call, 'approval_id'), false);
});
