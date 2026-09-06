const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createManagedChatStreamRuntime,
} = require('../../services/backend/chat-stream-managed-runtime');

test('managed chat stream runtime does not copy earlier reasoning fallback onto later text segments', async () => {
  const persistedMessages = [];
  const service = {
    featureFlags: { phase_events: true },
    emit() {},
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        persistedMessages.push(message);
        return message;
      },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-segment-reasoning',
    streamId: 'stream-segment-reasoning',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-segment-reasoning',
  });
  const context = {
    toolContext: {},
    handleToolNotification() {},
  };

  runtime.handleNotification({
    method: 'chat.phase_started',
    params: {
      phase_id: 'phase_reasoning_segment',
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think_segment',
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.thinking',
    params: {
      delta: 'Reason once.',
      thinking_id: 'think_segment',
      kind: 'reasoning',
      persist: true,
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.phase_completed',
    params: {
      phase_id: 'phase_reasoning_segment',
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think_segment',
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Done before tool.' },
  }, context);
  runtime.handleNotification({
    method: 'tool.executing',
    params: {
      tool_call_id: 'call_segment',
      tool_name: 'worktree_create',
      tool_input: {},
    },
  }, context);
  runtime.handleNotification({
    method: 'tool.result',
    params: {
      tool_call_id: 'call_segment',
      tool_name: 'worktree_create',
      success: false,
      output: 'bridge unavailable',
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Follow-up after failed tool.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const assistantSegments = persistedMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantSegments.length, 2);
  assert.equal(assistantSegments[0].content, 'Done before tool.');
  assert.deepEqual(
    assistantSegments[0].reasoning.entries.map((entry) => entry.text),
    ['Reason once.']
  );
  assert.equal(assistantSegments[1].content, 'Follow-up after failed tool.');
  assert.deepEqual(assistantSegments[1].reasoning, { source: 'none', entries: [] });
});

test('managed chat stream runtime persists pre-tool reasoning as its own segment when no text preceded the tool', async () => {
  const persistedMessages = [];
  const service = {
    featureFlags: { phase_events: true },
    emit() {},
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        persistedMessages.push(message);
        return message;
      },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-pre-tool-reasoning',
    streamId: 'stream-pre-tool-reasoning',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-pre-tool-reasoning',
  });
  const context = {
    toolContext: {},
    handleToolNotification() {},
  };

  // gemma4 pattern: gen-0 thinks, then calls the tool with NO visible text.
  runtime.handleNotification({
    method: 'chat.phase_started',
    params: {
      phase_id: 'phase_reasoning_pre_tool',
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think_pre_tool',
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.thinking',
    params: {
      delta: 'I should call the tool.',
      thinking_id: 'think_pre_tool',
      kind: 'reasoning',
      persist: true,
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.phase_completed',
    params: {
      phase_id: 'phase_reasoning_pre_tool',
      phase_kind: 'reasoning',
      iteration: 1,
      thinking_id: 'think_pre_tool',
    },
  }, context);
  runtime.handleNotification({
    method: 'tool.executing',
    params: {
      tool_call_id: 'call_pre_tool',
      tool_name: 'mermaid_generate',
      tool_input: {},
    },
  }, context);
  runtime.handleNotification({
    method: 'tool.result',
    params: {
      tool_call_id: 'call_pre_tool',
      tool_name: 'mermaid_generate',
      success: true,
      output: '{"mermaid": "graph TD"}',
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Here is the diagram.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const assistantSegments = persistedMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantSegments.length, 2);
  // The pre-tool reasoning persists as a content-less segment that PRECEDES
  // the tool messages, so the timeline projector orders it before the tool
  // rows instead of attaching it to the final post-tool answer.
  assert.equal(assistantSegments[0].content, '');
  assert.deepEqual(
    assistantSegments[0].reasoning.entries.map((entry) => entry.text),
    ['I should call the tool.']
  );
  assert.equal(assistantSegments[0].reasoning_phases.length, 1);
  assert.equal(assistantSegments[1].content, 'Here is the diagram.');
  assert.deepEqual(assistantSegments[1].reasoning, { source: 'none', entries: [] });
});

test('managed chat stream runtime keeps a bare tool boundary a no-op when nothing was collected', async () => {
  const persistedMessages = [];
  const service = {
    featureFlags: { phase_events: true },
    emit() {},
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        persistedMessages.push(message);
        return message;
      },
      setSessionPreferences() { return null; },
      getActiveTurn() { return null; },
      setActiveTurn() { return null; },
      touchActiveTurn() { return null; },
      clearActiveTurn() { return null; },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session-bare-boundary',
    streamId: 'stream-bare-boundary',
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user-stream-bare-boundary',
  });
  const context = {
    toolContext: {},
    handleToolNotification() {},
  };

  runtime.handleNotification({
    method: 'tool.executing',
    params: {
      tool_call_id: 'call_bare',
      tool_name: 'mermaid_generate',
      tool_input: {},
    },
  }, context);
  runtime.handleNotification({
    method: 'tool.result',
    params: {
      tool_call_id: 'call_bare',
      tool_name: 'mermaid_generate',
      success: true,
      output: '{"mermaid": "graph TD"}',
    },
  }, context);
  runtime.handleNotification({
    method: 'chat.token',
    params: { delta: 'Done.' },
  }, context);

  await runtime.settleTerminalResult({ status: 'completed' });

  const assistantSegments = persistedMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantSegments.length, 1);
  assert.equal(assistantSegments[0].content, 'Done.');
});
