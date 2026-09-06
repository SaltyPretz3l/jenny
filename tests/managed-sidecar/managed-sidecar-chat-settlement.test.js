const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  createManagedChatServiceStub,
  waitForDiagnosticDump,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

test('managed sidecar diagnostic dump includes streamed tool event phases', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-diagnostic-tools-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = createManagedChatServiceStub();
  service.options = { userDataPath };
  service.sidecarClient = {
    async harnessTurnDiagnostic() {
      return null;
    },
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'tool.executing',
        params: {
          tool_call_id: 'call_diagnostic_tool',
          tool_name: 'inspect_harness',
          tool_input: { sections: ['tools'] },
        },
      });
      options.onNotification({
        method: 'tool.result',
        params: {
          tool_call_id: 'call_diagnostic_tool',
          tool_name: 'inspect_harness',
          success: true,
          content: '{"tools":{"items":[]}}',
        },
      });
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Done.' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {},
      });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_diagnostic_tools',
    prompt: 'Inspect tools',
    visiblePrompt: 'Inspect tools',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;
  const diagnosticPath = await waitForDiagnosticDump(service, stream.streamId);
  const diagnostic = JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'));

  assert.deepEqual(
    diagnostic.tool_events.map((entry) => ({
      call_id: entry.call_id,
      name: entry.name,
      phase: entry.phase,
    })),
    [
      {
        call_id: 'call_diagnostic_tool',
        name: 'inspect_harness',
        phase: 'executing',
      },
      {
        call_id: 'call_diagnostic_tool',
        name: 'inspect_harness',
        phase: 'result',
      },
    ]
  );
});

test('managed sidecar stream_reset removes stale assistant text before final completion', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'chat.token',
        params: { delta: "I've checked my harness already. " },
      });
      options.onNotification({
        method: 'tool.executing',
        params: {
          tool_call_id: 'call_harness_reset',
          tool_name: 'inspect_harness',
          tool_input: {},
        },
      });
      options.onNotification({
        method: 'tool.result',
        params: {
          tool_call_id: 'call_harness_reset',
          tool_name: 'inspect_harness',
          output: '{"tools":{"items":[]}}',
          success: true,
          metadata: { result_kind: 'harness_snapshot' },
        },
      });
      options.onNotification({
        method: 'chat.stream_reset',
        params: {},
      });
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Functional tools currently available:\n- Inspect Harness (`inspect_harness`)' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {},
      });
      return { terminal_status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_harness_reset',
    prompt: 'Inspect the harness and list functional tools',
    visiblePrompt: 'Inspect the harness and list functional tools',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const assistantMessages = service.sessionMessages.filter((message) => message.role === 'assistant');
  assert.equal(
    assistantMessages.some((message) => String(message.content || '').includes("I've checked")),
    false
  );
  assert.equal(
    assistantMessages.some((message) => String(message.content || '').includes('Functional tools currently available')),
    true
  );
  assert.equal(
    assistantMessages.some((message) => message.kind === 'tool_use' && message.tool_call?.call_id === 'call_harness_reset'),
    true
  );
});

test('chat.done deterministic fallback replaces text only after an explicit replacement reset', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'Stale preamble.' } });
      options.onNotification({
        method: 'chat.stream_reset',
        params: { reason: 'deterministic_replacement' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {
          stop_reason: 'end_turn',
          response_text: 'Authoritative fallback.',
          completion_source: 'deterministic_tool_fallback',
        },
      });
      return {
        status: 'completed',
        response_text: 'Different RPC text.',
        completion_source: 'model_winddown',
      };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_terminal_text_authority',
    prompt: 'Finish visibly',
    visiblePrompt: 'Finish visibly',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const assistantMessages = service.sessionMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].content, 'Authoritative fallback.');
  assert.equal(
    service.serviceLogs.filter((entry) => entry.event === 'chat.terminal_response_text_mismatch').length,
    0
  );
});

test('deterministic terminal fallback cannot overwrite a nonblank streamed model answer', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Complete model answer.' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {
          stop_reason: 'end_turn',
          response_text: 'I got stuck repeating tool activity, so I stopped.',
          completion_source: 'deterministic_tool_fallback',
        },
      });
      return {
        status: 'completed',
        response_text: 'A different deterministic stop message.',
        completion_source: 'deterministic_tool_fallback',
      };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_terminal_fallback_guard',
    prompt: 'Keep the completed answer',
    visiblePrompt: 'Keep the completed answer',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const assistantMessages = service.sessionMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].content, 'Complete model answer.');
  assert.equal(
    service.serviceLogs.filter((entry) => entry.event === 'chat.terminal_response_text_mismatch').length,
    1
  );
});

test('matching streamed and terminal response text remains a single completion', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'First ' } });
      options.onNotification({
        method: 'chat.thinking',
        params: { kind: 'reasoning', delta: 'Checking.', thinking_id: 'reasoning-middle' },
      });
      options.onNotification({ method: 'chat.token', params: { delta: 'second' } });
      options.onNotification({
        method: 'chat.done',
        params: {
          stop_reason: 'end_turn',
          response_text: 'First second',
          completion_source: 'model',
        },
      });
      return {
        status: 'completed',
        response_text: 'First second',
        completion_source: 'model',
      };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_matching_terminal_text',
    prompt: 'Finish once',
    visiblePrompt: 'Finish once',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const assistantMessages = service.sessionMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].content, 'First second');
  assert.deepEqual(
    assistantMessages[0].visible_segments.map((segment) => segment.text),
    ['First ', 'second']
  );
  assert.equal(
    service.serviceLogs.filter((entry) => entry.event === 'chat.terminal_response_text_mismatch').length,
    0
  );
});

test('authoritative text replacement keeps visible segments and text phases aligned', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'First ' } });
      options.onNotification({
        method: 'chat.thinking',
        params: { kind: 'reasoning', delta: 'Checking.', thinking_id: 'reasoning-middle' },
      });
      options.onNotification({ method: 'chat.token', params: { delta: 'stale tail' } });
      options.onNotification({
        method: 'chat.done',
        params: {
          stop_reason: 'end_turn',
          response_text: 'First corrected answer',
          completion_source: 'model',
        },
      });
      return {
        status: 'completed',
        response_text: 'First corrected answer',
        completion_source: 'model',
      };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_terminal_text_phase_alignment',
    prompt: 'Correct the terminal text',
    visiblePrompt: 'Correct the terminal text',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const assistantMessages = service.sessionMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  const [assistant] = assistantMessages;
  assert.equal(assistant.content, 'First corrected answer');
  assert.deepEqual(
    assistant.visible_segments.map((segment) => segment.text),
    ['First ', 'corrected answer']
  );
  const visiblePhaseIds = new Set(
    assistant.visible_segments.map((segment) => segment.phase_id)
  );
  const textPhases = assistant.phases.filter((phase) => phase.phase_kind === 'text');
  assert.equal(textPhases.length, assistant.visible_segments.length);
  assert.equal(
    textPhases.every((phase) => visiblePhaseIds.has(phase.phase_id)),
    true
  );
  assert.equal(
    assistant.phases.some((phase) => phase.phase_kind === 'reasoning'),
    true
  );
});

test('RPC terminal response text recovers completion when chat.done omits it', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'end_turn' } });
      return {
        status: 'completed',
        response_text: 'Recovered from the RPC result.',
        completion_source: 'deterministic_tool_fallback',
      };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_rpc_terminal_text_recovery',
    prompt: 'Finish visibly',
    visiblePrompt: 'Finish visibly',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const assistantMessages = service.sessionMessages.filter((message) => message.role === 'assistant');
  assert.equal(assistantMessages.length, 1);
  assert.equal(assistantMessages[0].content, 'Recovered from the RPC result.');
});

test('managed sidecar stream_reset falls back to patching stale segments when message list is unavailable', async () => {
  const service = createManagedChatServiceStub();
  const originalGetSessionMessages = service.sessionStore.getSessionMessages.bind(service.sessionStore);
  const originalReplaceMessages = service.sessionStore.replaceMessages.bind(service.sessionStore);
  const replaceCalls = [];
  let returnUnavailableMessages = false;
  service.sessionStore.getSessionMessages = (...args) =>
    returnUnavailableMessages ? null : originalGetSessionMessages(...args);
  service.sessionStore.replaceMessages = (...args) => {
    replaceCalls.push(args);
    return originalReplaceMessages(...args);
  };
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Stale assistant text. ' },
      });
      options.onNotification({
        method: 'tool.executing',
        params: {
          tool_call_id: 'call_before_reset',
          tool_name: 'inspect_harness',
          tool_input: {},
        },
      });
      options.onNotification({
        method: 'tool.result',
        params: {
          tool_call_id: 'call_before_reset',
          tool_name: 'inspect_harness',
          output: '{"tools":{"items":[]}}',
          success: true,
          metadata: { result_kind: 'harness_snapshot' },
        },
      });
      returnUnavailableMessages = true;
      options.onNotification({
        method: 'chat.stream_reset',
        params: {},
      });
      returnUnavailableMessages = false;
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Fresh pre-tool text. ' },
      });
      options.onNotification({
        method: 'tool.executing',
        params: {
          tool_call_id: 'call_after_reset',
          tool_name: 'read_file',
          tool_input: { path: 'notes.txt' },
        },
      });
      options.onNotification({
        method: 'tool.result',
        params: {
          tool_call_id: 'call_after_reset',
          tool_name: 'read_file',
          output: 'notes',
          success: true,
        },
      });
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Final grounded answer.' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {},
      });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_harness_reset_patch_fallback',
    prompt: 'Inspect the harness and list functional tools',
    visiblePrompt: 'Inspect the harness and list functional tools',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const assistantMessages = service.sessionMessages.filter((message) => message.role === 'assistant');
  const assistantIds = assistantMessages.map((message) => String(message.id || '').trim());
  assert.equal(
    assistantMessages.some((message) => String(message.content || '').includes('Stale assistant text')),
    false
  );
  assert.equal(
    assistantMessages.some((message) => String(message.content || '').includes('Fresh pre-tool text')),
    true
  );
  assert.equal(
    assistantMessages.some((message) => String(message.content || '').includes('Final grounded answer')),
    true
  );
  assert.equal(new Set(assistantIds).size, assistantIds.length);
  assert.equal(replaceCalls.length, 0);
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.stream_reset_messages_unavailable'),
    true
  );
});

test('managed sidecar chat.done completes the stream before delayed chatSend settlement', async () => {
  const service = createManagedChatServiceStub();
  let resolveChatSend;
  let resolveComplete;
  const completePromise = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const originalEmit = service.emit.bind(service);
  service.emit = (eventName, payload) => {
    originalEmit(eventName, payload);
    if (eventName === 'chat-stream' && payload?.type === 'complete') {
      resolveComplete(payload);
    }
  };
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Hello ' },
      });
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'world' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {
          usage: {
            input_tokens: 8,
            output_tokens: 2,
            total_tokens: 10,
            cost_usd: 0,
            cost_source: 'local_zero',
            model: 'mock-v1',
            provider: 'mock',
          },
        },
      });
      return new Promise((resolve) => {
        resolveChatSend = resolve;
      });
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_delayed_result',
    prompt: 'Close on done',
    visiblePrompt: 'Close on done',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  const controller = service.activeStreams.get(stream.streamId);
  assert.ok(controller);

  const completed = await completePromise;
  assert.equal(completed.streamId, stream.streamId);
  assert.equal(completed.content, 'Hello world');
  assert.equal(service.activeStreams.has(stream.streamId), true);
  assert.equal(
    service.emittedEvents.filter(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
    ).length,
    1
  );

  resolveChatSend({ status: 'completed' });
  await controller._pendingPromise;
  assert.equal(service.activeStreams.has(stream.streamId), false);

  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
    ),
    false
  );
  assert.equal(
    service.emittedEvents.filter(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
    ).length,
    1
  );
});

test('managed sidecar ignores late chatSend failure after chat.done visible completion', async () => {
  const service = createManagedChatServiceStub();
  const sequence = [];
  let rejectChatSend;
  let resolveComplete;
  const completePromise = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const originalEmit = service.emit.bind(service);
  service.emit = (eventName, payload) => {
    originalEmit(eventName, payload);
    if (eventName === 'chat-stream' && payload?.type === 'complete') {
      resolveComplete(payload);
    }
  };
  service._restartManagedSidecar = async () => {
    sequence.push('restart');
  };
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Settled ' },
      });
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'visibly' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {
          usage: {
            input_tokens: 9,
            output_tokens: 2,
            total_tokens: 11,
            cost_usd: 0,
            cost_source: 'local_zero',
            model: 'mock-v1',
            provider: 'mock',
          },
        },
      });
      return new Promise((_resolve, reject) => {
        rejectChatSend = reject;
      });
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_late_failure',
    prompt: 'Visible completion should win',
    visiblePrompt: 'Visible completion should win',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  const controller = service.activeStreams.get(stream.streamId);
  assert.ok(controller);

  await completePromise;
  rejectChatSend(new Error('post-response extraction was slow'));
  await controller._pendingPromise;

  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
    ),
    false
  );
  assert.deepEqual(sequence, []);
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.stream_late_settlement_failed'),
    true
  );
});

test('managed sidecar clears the timeout as soon as chat.done visibly completes the stream', async () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  let timeoutArmed = false;
  let resolveChatSend;
  let resolveComplete;
  const service = createManagedChatServiceStub();
  const sequence = [];
  const completePromise = new Promise((resolve) => {
    resolveComplete = resolve;
  });
  const originalEmit = service.emit.bind(service);
  service.emit = (eventName, payload) => {
    originalEmit(eventName, payload);
    if (eventName === 'chat-stream' && payload?.type === 'complete') {
      resolveComplete(payload);
    }
  };

  global.setTimeout = () => {
    timeoutArmed = true;
    return { unref() {} };
  };
  global.clearTimeout = () => {
    timeoutArmed = false;
  };
  service._restartManagedSidecar = async () => {
    sequence.push('restart');
  };
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Done ' },
      });
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'early' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {
          usage: {
            input_tokens: 7,
            output_tokens: 2,
            total_tokens: 9,
            cost_usd: 0,
            cost_source: 'local_zero',
            model: 'mock-v1',
            provider: 'mock',
          },
        },
      });
      return new Promise((resolve) => {
        resolveChatSend = resolve;
      });
    },
  };

  try {
    const stream = await startManagedSidecarChatStream(service, {
      sessionId: 'session_timeout_suppressed',
      prompt: 'Timeout should clear on done',
      visiblePrompt: 'Timeout should clear on done',
      attachments: [],
      runtimePreferredModel: 'mock-v1',
      normalizedInteractiveResponse: null,
      normalizedPreferences: {
        preferred_model: 'mock-v1',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        pending_question_batch: null,
        interactive_sequence_state: 'idle',
        interactive_round_count: 0,
        plan_mode: false,
      },
    });

    const controller = service.activeStreams.get(stream.streamId);
    assert.ok(controller);

    await completePromise;
    assert.equal(timeoutArmed, false);
    assert.equal(service.activeStreams.has(stream.streamId), true);

    resolveChatSend({ status: 'completed' });
    await controller._pendingPromise;
    assert.equal(service.activeStreams.has(stream.streamId), false);

    assert.deepEqual(sequence, []);
    assert.equal(
      service.serviceLogs.some((entry) => entry.event === 'chat.stream_timeout'),
      false
    );
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

// Superseded 2026-07-04 by the B1 admission gate (chat-stream-admission.js):
// this test used to document the pre-fix bug it is named after — a second
// concurrent send on the same session silently clobbered the first turn's
// active_turn instead of being rejected. That is now a `session_busy` error.
// This rewritten version asserts the corrected contract: the second send
// while the first is still live is REJECTED, and only after the first
// stream's active_turn is cleared (its late failure settles) does a genuinely
// new send succeed.
test('managed sidecar rejects a second concurrent send while the first is live; a later send succeeds once the first settles', async () => {
  const service = createManagedChatServiceStub();
  let firstReject;
  let secondResolve;
  let secondOptions = null;
  let firstStreamId = '';
  let secondStreamId = '';
  let callCount = 0;

  service.sidecarClient = {
    chatSend: async (params, options = {}) => {
      callCount += 1;
      if (callCount === 1) {
        firstStreamId = params.request_id;
        return new Promise((_resolve, reject) => {
          firstReject = () => reject(new Error('first stream failed late'));
        });
      }
      secondStreamId = params.request_id;
      secondOptions = options;
      return new Promise((resolve) => {
        secondResolve = resolve;
      });
    },
  };

  const first = await startManagedSidecarChatStream(service, {
    sessionId: 'session_overlap',
    prompt: 'First turn',
    visiblePrompt: 'First turn',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const firstActiveTurn = service.sessionStore.getActiveTurn('session_overlap');
  assert.match(firstActiveTurn.session_incarnation, /^incarnation_/);
  assert.deepEqual(firstActiveTurn, {
    request_id: firstStreamId,
    turn_id: firstStreamId,
    stream_id: firstStreamId,
    trace_id: firstStreamId,
    user_message_id: `user_${first.streamId}`,
    session_incarnation: firstActiveTurn.session_incarnation,
    generation: first.identity.generation,
    started_at: firstActiveTurn.started_at,
    last_event_at: firstActiveTurn.last_event_at,
    status: 'awaiting_assistant',
  });

  // A second send while the first is still live must be rejected outright,
  // not silently clobber the first turn's active_turn.
  await assert.rejects(
    startManagedSidecarChatStream(service, {
      sessionId: 'session_overlap',
      prompt: 'Second turn (rejected)',
      visiblePrompt: 'Second turn (rejected)',
      attachments: [],
      runtimePreferredModel: 'mock-v1',
      normalizedInteractiveResponse: null,
      normalizedPreferences: {
        preferred_model: 'mock-v1',
        reasoning_effort: 'default',
        conversation_mode: 'chat',
        pending_question_batch: null,
        interactive_sequence_state: 'idle',
        interactive_round_count: 0,
        plan_mode: false,
      },
    }),
    (error) => {
      assert.equal(error.code, 'session_busy');
      return true;
    }
  );
  assert.equal(callCount, 1, 'the rejected second send must never reach chatSend');
  const activeWhileFirstLive = service.sessionStore.getActiveTurn('session_overlap');
  assert.equal(activeWhileFirstLive.request_id, firstStreamId, 'the first turn must be unaffected by the rejection');

  // The first stream fails late; its own catch/finally clears active_turn.
  firstReject();
  await service.activeStreams.get(first.streamId)._pendingPromise;
  assert.equal(service.sessionStore.getActiveTurn('session_overlap'), null);

  // Now a genuinely new send succeeds (nothing in flight to reject against).
  const second = await startManagedSidecarChatStream(service, {
    sessionId: 'session_overlap',
    prompt: 'Second turn (after first settles)',
    visiblePrompt: 'Second turn (after first settles)',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  const activeDuringSecond = service.sessionStore.getActiveTurn('session_overlap');
  assert.equal(activeDuringSecond.request_id, secondStreamId);
  assert.equal(activeDuringSecond.stream_id, secondStreamId);
  assert.equal(activeDuringSecond.user_message_id, `user_${second.streamId}`);

  secondOptions.onNotification({
    method: 'chat.token',
    params: { delta: 'Fresh response' },
  });
  secondOptions.onNotification({
    method: 'chat.done',
    params: {},
  });
  secondResolve({ status: 'completed' });
  await service.activeStreams.get(second.streamId)._pendingPromise;
  assert.equal(service.sessionStore.getActiveTurn('session_overlap'), null);
});
