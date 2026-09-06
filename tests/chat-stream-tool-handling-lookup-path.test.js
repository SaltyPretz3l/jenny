// Sibling of chat-stream-tool-handling.test.js (that file is at the 1015-line
// cap). Covers the perf finding #5 lookup fast path: the per-tool-call
// tool_use/tool_result id lookups must go through the session store's
// read-only peekSessionMessages, which skips the message re-normalization and
// turn_events normalize+sort that getSessionMessages pays via getSession().
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');

const {
  handleToolNotification,
} = require('../services/backend/chat-stream-tool-handling');

// Perf finding #5: the per-tool-call id lookups must go through the store's
// read-only peekSessionMessages, which skips the message re-normalization and
// turn_events normalize+sort that getSessionMessages pays. Every other store
// double in this file implements only getSessionMessages, so without this test
// the fast path could be dead in production and the suite would stay green.
test('tool.executing and tool.result look messages up through peekSessionMessages', () => {
  const messagesBySession = new Map([['session-peek', []]]);
  const calls = { peek: 0, get: 0 };
  const sessionStore = {
    peekSessionMessages(sessionId) {
      calls.peek += 1;
      return [...(messagesBySession.get(sessionId) || [])];
    },
    getSessionMessages(sessionId) {
      calls.get += 1;
      return [...(messagesBySession.get(sessionId) || [])];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(sessionId, messages);
    },
  };
  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: 'session-peek',
    streamId: 'stream-peek',
    eventBase: { sessionId: 'session-peek', streamId: 'stream-peek', model: 'mock-model' },
  };

  handleToolNotification(service, context, {
    method: 'tool.executing',
    params: { tool_call_id: 'call-peek-1', tool_name: 'read_file', tool_input: { path: 'README.md' } },
  });
  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-peek-1',
      tool_name: 'read_file',
      success: true,
      output: 'contents',
      tool_input: { path: 'README.md' },
    },
  });

  assert.ok(calls.peek >= 2, `expected both lookup sites to peek, saw ${calls.peek}`);
  assert.equal(calls.get, 0, 'the hot lookup path must not re-normalize via getSessionMessages');

  // The upsert behaviour itself must be unchanged by the swap.
  const messages = messagesBySession.get('session-peek');
  const toolUses = messages.filter((message) => String(message.kind || '') === 'tool_use');
  const toolResults = messages.filter((message) => String(message.kind || '') === 'tool_result');
  assert.equal(toolUses.length, 1, 'tool_use must be upserted, not duplicated');
  assert.equal(toolResults.length, 1, 'tool_result must be upserted, not duplicated');
  assert.equal(toolUses[0].tool_call.call_id, 'call-peek-1');
  assert.equal(toolResults[0].tool_result.output_text, 'contents');
});

test('tool lookups fall back to getSessionMessages when the store predates peekSessionMessages', () => {
  const messagesBySession = new Map([['session-fallback', []]]);
  let getCalls = 0;
  const sessionStore = {
    getSessionMessages(sessionId) {
      getCalls += 1;
      return [...(messagesBySession.get(sessionId) || [])];
    },
    appendMessage(sessionId, message) {
      const messages = messagesBySession.get(sessionId) || [];
      messages.push(message);
      messagesBySession.set(sessionId, messages);
    },
    updateMessage(sessionId, messageId, patch) {
      const messages = messagesBySession.get(sessionId) || [];
      const index = messages.findIndex((message) => String(message.id || '') === String(messageId || ''));
      if (index === -1) return;
      messages[index] = { ...messages[index], ...patch };
      messagesBySession.set(sessionId, messages);
    },
  };
  const service = {
    sessionStore,
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'mock-model',
    options: { userDataPath: os.tmpdir() },
  };
  const context = {
    seenToolCalls: new Set(),
    toolSummaries: new Map(),
    model: 'mock-model',
    resolvedSessionId: 'session-fallback',
    streamId: 'stream-fallback',
    eventBase: { sessionId: 'session-fallback', streamId: 'stream-fallback', model: 'mock-model' },
  };

  handleToolNotification(service, context, {
    method: 'tool.result',
    params: {
      tool_call_id: 'call-fallback-1',
      tool_name: 'read_file',
      success: true,
      output: 'fallback output',
      tool_input: { path: 'README.md' },
    },
  });

  assert.ok(getCalls >= 1, 'a store without peekSessionMessages must still be read');
  const toolResults = (messagesBySession.get('session-fallback') || [])
    .filter((message) => String(message.kind || '') === 'tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].tool_result.output_text, 'fallback output');
});
