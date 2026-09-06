const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  startManagedSidecarChatStream,
  validateImageAttachmentsForManagedSend,
} = require('../../services/backend/managed-sidecar-chat');
const {
  createCancellationError,
} = require('../../services/backend/chat-stream-terminal-utils');
const {
  STREAM_ERROR_CODES,
} = require('../../services/backend/error-codes');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

test('managed image validation rejects unmanaged paths before filesystem stat', () => {
  const service = {
    attachmentAssetStore: {
      resolveManagedAssetRealPath() {
        return '';
      },
    },
  };

  assert.throws(
    () => validateImageAttachmentsForManagedSend(
      service,
      [{ kind: 'image', assetPath: path.join(os.tmpdir(), 'not-managed.png') }]
    ),
    /app-managed local asset store/
  );
});

test('managed image validation forwards resolved managed real path', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-image-'));
  const realImagePath = path.join(tempDir, 'capture.png');
  fs.writeFileSync(realImagePath, Buffer.from('image'));
  const attachments = [{ kind: 'image', assetPath: path.join(tempDir, 'logical.png') }];
  const service = {
    attachmentAssetStore: {
      resolveManagedAssetRealPath() {
        return realImagePath;
      },
    },
  };

  try {
    validateImageAttachmentsForManagedSend(service, attachments);
    assert.equal(attachments[0].assetPath, realImagePath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('managed sidecar answers exact transcript questions without model or sidecar calls', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_transcript_exact_recall';
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Transcript recall',
    preferences: {
      preferred_model: 'mock-v1',
      session_start_date: '2026-04-29',
    },
  });
  service.sessionMessages.push({
    id: 'assistant_intro',
    role: 'assistant',
    kind: 'question_batch',
    content: 'Question batch shell text that should not win.',
    interactive_batch: {
      intro_text: 'First visible Jenny sentence. Which tool should I show?',
      questions: [],
    },
  });

  let modelResolved = false;
  let sidecarCalled = false;
  service._resolveModel = async () => {
    modelResolved = true;
    return 'mock-v1';
  };
  service.sidecarClient = {
    async chatSend() {
      sidecarCalled = true;
      throw new Error('sidecar should not be called for deterministic transcript recall');
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId,
    prompt: 'What was the first sentence you sent me this session?',
    visiblePrompt: 'What was the first sentence you sent me this session?',
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
  await controller._pendingPromise;

  assert.equal(modelResolved, false);
  assert.equal(sidecarCalled, false);
  assert.equal(service.activeStreams.has(stream.streamId), false);
  assert.equal(
    service.emittedEvents.some(
      (entry) =>
        entry.eventName === 'chat-stream'
        && entry.payload?.type === 'started'
        && entry.payload?.deterministic === true
    ),
    true
  );
  const completeEvent = service.emittedEvents.find(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
  );
  assert.ok(completeEvent);
  assert.equal(
    completeEvent.payload.content,
    'The first sentence I sent to you this session was: "First visible Jenny sentence."'
  );
  assert.equal(
    service.serviceLogs.some(
      (entry) => entry.event === 'chat.deterministic_transcript_answer_completed'
    ),
    true
  );
});

test('managed sidecar timeout waits for chatSend rejection before restart', async () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  let timeoutCallback = null;
  const sequence = [];
  const service = createManagedChatServiceStub();

  global.setTimeout = (fn) => {
    timeoutCallback = fn;
    return { unref() {} };
  };
  global.clearTimeout = () => {};
  service._restartManagedSidecar = async () => {
    sequence.push('restart');
  };
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      sequence.push('chatSend');
      return new Promise((_, reject) => {
        const rejectOnAbort = () => {
          sequence.push('rejected');
          reject(options.signal?.reason || new Error('aborted'));
        };
        options.signal.addEventListener('abort', rejectOnAbort, { once: true });
        timeoutCallback();
      });
    },
  };

  try {
    const stream = await startManagedSidecarChatStream(service, {
      sessionId: 'session_timeout',
      prompt: 'Timeout please',
      visiblePrompt: 'Timeout please',
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

    assert.deepEqual(sequence, ['chatSend', 'rejected', 'restart']);
    assert.equal(service.activeStreams.has(stream.streamId), false);
    assert.equal(
      service.serviceLogs.some((entry) => entry.event === 'chat.stream_timeout'),
      true
    );
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('managed sidecar emits normalized error payload fields from classified chatSend failures', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async () => {
      const error = new Error('transport temporarily unavailable');
      error.error_code = 'CMP-SIDECAR-0004';
      error.category = 'transport';
      error.retryable = true;
      throw error;
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_error_payload',
    prompt: 'Fail with payload',
    visiblePrompt: 'Fail with payload',
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

  const errorEvent = service.emittedEvents.find(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
  );
  assert.ok(errorEvent);
  assert.equal(errorEvent.payload.error_code, 'CMP-SIDECAR-0004');
  assert.equal(errorEvent.payload.category, 'transport');
  assert.equal(errorEvent.payload.retryable, true);
});

test('managed sidecar preserves abort cancel reason in stream errors', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) =>
      new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => {
          reject(options.signal.reason || new Error('aborted'));
        }, { once: true });
      }),
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_abort_reason',
    prompt: 'Cancel with a reason',
    visiblePrompt: 'Cancel with a reason',
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
  controller.abort(createCancellationError('session_delete', 'Session deleted during stream.'));
  await controller._pendingPromise;

  const errorEvent = service.emittedEvents.find(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
  );
  assert.ok(errorEvent);
  assert.equal(errorEvent.payload.message, 'Session deleted during stream.');
  assert.equal(errorEvent.payload.category, 'cancelled');
  assert.equal(errorEvent.payload.status, 'cancelled');
  assert.equal(errorEvent.payload.terminal_subcode, 'session_delete');
  assert.equal(errorEvent.payload.cancel_reason, 'session_delete');
});

test('managed sidecar persists a failure row instead of promoting provider reasoning into assistant text', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'chat.thinking',
        params: {
          delta: '## Analyze\n\n- keep reasoning separate',
          kind: 'reasoning',
          persist: true,
        },
      });
      options.onNotification({
        method: 'chat.done',
        params: {},
      });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_reasoning_only_failure',
    prompt: 'Explain without an answer',
    visiblePrompt: 'Explain without an answer',
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

  const assistantFailure = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.ok(assistantFailure);
  assert.equal(assistantFailure.content, '');
  assert.equal(assistantFailure.status, 'runtime_error');
  assert.equal(assistantFailure.error_code, STREAM_ERROR_CODES.REASONING_ONLY);
  assert.equal(assistantFailure.retryable, false);
  assert.equal(
    assistantFailure.stream_error,
    'Model returned no visible assistant text. The model may have only produced reasoning without a response.'
  );
  assert.deepEqual(assistantFailure.reasoning, {
    source: 'provider',
    entries: [
      {
        id: assistantFailure.reasoning.entries[0].id,
        text: '## Analyze\n\n- keep reasoning separate',
        timestamp: assistantFailure.reasoning.entries[0].timestamp,
      },
    ],
  });
  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
    ),
    false
  );
  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
    ),
    true
  );
});

test('managed sidecar keeps a new session durable when the first turn fails before streaming starts', async () => {
  const service = createManagedChatServiceStub();
  service._resolveModel = async () => {
    throw new Error('model unavailable');
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: '',
    prompt: 'Keep this first prompt',
    visiblePrompt: 'Keep this first prompt',
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

  assert.equal(service.createdSessionIds.length, 1);
  assert.deepEqual(service.deletedSessionIds, []);
  assert.equal(service.sessionMessages[0]?.role, 'user');
  assert.equal(service.sessionMessages[0]?.content, 'Keep this first prompt');
  assert.equal(service.sessionMessages[1]?.role, 'assistant');
  assert.equal(service.sessionMessages[1]?.status, 'runtime_error');
  assert.equal(service.sessionMessages[1]?.stream_error, 'model unavailable');
});

test('managed sidecar persists separate tool_use and tool_result turn events for finalized turns', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'tool.executing',
        params: {
          tool_call_id: 'call_turn_events',
          tool_name: 'read_file',
          tool_input: { path: 'notes.txt' },
        },
      });
      options.onNotification({
        method: 'tool.result',
        params: {
          tool_call_id: 'call_turn_events',
          tool_name: 'read_file',
          output: 'done',
          success: true,
          generated_artifacts: [{
            artifact_id: 'artifact_turn_events',
            artifact_kind: 'document',
            title: 'Plan',
            file_name: 'plan.md',
            display_path: '.jenny/artifacts/plan.md',
            absolute_path: 'C:/workspace/.jenny/artifacts/plan.md',
          }],
        },
      });
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'All set.' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {},
      });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_turn_events',
    prompt: 'Run a tool',
    visiblePrompt: 'Run a tool',
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

  const turnEvents = service.sessionStore.getSessionTurnEvents('session_turn_events');
  assert.equal(turnEvents.some((event) => event.kind === 'tool_use' && event.tool_call_id === 'call_turn_events'), true);
  assert.equal(turnEvents.some((event) => event.kind === 'tool_result' && event.tool_call_id === 'call_turn_events'), true);
  const toolResultEvent = turnEvents.find((event) => event.kind === 'tool_result');
  assert.equal(toolResultEvent.payload.generated_artifacts[0].tool_call_id, 'call_turn_events');
});

test('managed sidecar promotes successful chat result observations into existing tool result events', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (params, options = {}) => {
      options.onNotification({
        method: 'tool.executing',
        params: {
          tool_call_id: 'call_promoted_result',
          tool_name: 'read_file',
          tool_input: { path: 'notes.txt' },
        },
      });
      options.onNotification({
        method: 'tool.result',
        params: {
          tool_call_id: 'call_promoted_result',
          tool_name: 'read_file',
          output: 'System error: tool execution interrupted.',
          success: false,
          error_code: 'CMP-LOOP-0013',
        },
      });
      options.onNotification({
        method: 'chat.done',
        params: {},
      });
      return {
        status: 'completed',
        tool_observations: [{
          kind: 'tool_execution_failed',
          request_id: params.request_id,
          tool_call_id: 'call_promoted_result',
          tool_name: 'read_file',
          summary: 'tool interrupted after notification stream',
          error_code: 'CMP-LOOP-0013',
          sequence: 3,
        }],
      };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_tool_observation_promotion',
    prompt: 'Run an interrupted tool',
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const turnEvents = service.sessionStore.getSessionTurnEvents('session_tool_observation_promotion');
  assert.equal(turnEvents.some((event) => event.kind === 'tool.cancelled'), false);
  const toolResultEvent = turnEvents.find(
    (event) => event.kind === 'tool_result' && event.tool_call_id === 'call_promoted_result'
  );
  assert.ok(toolResultEvent);
  assert.equal(
    toolResultEvent.payload.promoted_observations[0].event_type,
    'tool.cancelled'
  );
  assert.equal(
    toolResultEvent.payload.promoted_observations[0].observation_id,
    `${stream.streamId}:tool_observation:3`
  );
});

test('managed sidecar promotes tool observations from rpc error data into assistant error turn events', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    connected: true,
    chatSend: async (params) => {
      const error = new Error('semantic stuck loop');
      error.error_code = 'CMP-LOOP-0018';
      error.category = 'runtime';
      error.retryable = false;
      error.rpc = {
        data: {
          code: 'CMP-LOOP-0018',
          tool_observations: [{
            kind: 'turn_failed',
            request_id: params.request_id,
            summary: 'semantic stuck loop pattern=repeated_observations',
            error_code: 'CMP-LOOP-0018',
            sequence: 12,
          }],
        },
      };
      throw error;
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_stuck_loop_promotion',
    prompt: 'Trigger stuck-loop promotion',
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const turnEvents = service.sessionStore.getSessionTurnEvents('session_stuck_loop_promotion');
  assert.equal(turnEvents.some((event) => event.kind === 'agent.stopped_due_to_loop'), false);
  const assistantErrorEvent = turnEvents.find((event) => event.kind === 'assistant_error');
  assert.ok(assistantErrorEvent);
  assert.equal(assistantErrorEvent.payload.error_code, 'CMP-LOOP-0018');
  assert.equal(
    assistantErrorEvent.payload.promoted_observations[0].event_type,
    'agent.stopped_due_to_loop'
  );
  assert.equal(
    assistantErrorEvent.payload.promoted_observations[0].observation_id,
    `${stream.streamId}:tool_observation:12`
  );
});

test('managed sidecar preserves streamed reasoning chronology around tool events', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'chat.thinking',
        params: {
          delta: 'I need to inspect the harness before answering.',
          kind: 'reasoning',
          thinking_id: 'think_pre_tool',
          persist: true,
        },
      });
      options.onNotification({
        method: 'tool.executing',
        params: {
          tool_call_id: 'call_reasoning_order',
          tool_name: 'inspect_harness',
          tool_input: { sections: ['tools'] },
        },
      });
      options.onNotification({
        method: 'tool.result',
        params: {
          tool_call_id: 'call_reasoning_order',
          tool_name: 'inspect_harness',
          output: '{"tools":{"items":[]}}',
          success: true,
        },
      });
      options.onNotification({
        method: 'chat.thinking',
        params: {
          delta: 'Now I can ground the answer in the tool result.',
          kind: 'reasoning',
          thinking_id: 'think_post_tool',
          persist: true,
        },
      });
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'The harness snapshot is empty.' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {},
      });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_reasoning_tool_order',
    prompt: 'Inspect the harness',
    visiblePrompt: 'Inspect the harness',
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

  const turnEvents = service.sessionStore.getSessionTurnEvents('session_reasoning_tool_order');
  assert.deepEqual(
    turnEvents.map((event) => event.kind),
    [
      'user_prompt',
      'reasoning_phase',
      'tool_use',
      'tool_executing',
      'tool_result',
      'reasoning_phase',
      'assistant_text_segment',
    ]
  );
  assert.deepEqual(
    turnEvents
      .filter((event) => event.kind === 'reasoning_phase')
      .map((event) => event.payload.entries[0].text),
    [
      'I need to inspect the harness before answering.',
      'Now I can ground the answer in the tool result.',
    ]
  );
});

test('managed sidecar settles running tool rows before accepting completed terminal state', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({
        method: 'tool.executing',
        params: {
          tool_call_id: 'call_orphaned_completed',
          tool_name: 'inspect_harness',
          tool_input: { sections: ['tools'] },
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
    sessionId: 'session_orphaned_completed',
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

  const toolUse = service.sessionMessages.find(
    (message) => String(message.kind || '') === 'tool_use'
  );
  const toolResult = service.sessionMessages.find(
    (message) => String(message.kind || '') === 'tool_result'
  );
  assert.ok(toolUse);
  assert.equal(toolUse.tool_call.status, 'interrupted');
  assert.ok(toolResult);
  assert.equal(toolResult.tool_result.call_id, 'call_orphaned_completed');
  assert.equal(toolResult.tool_result.is_error, true);
  assert.equal(toolResult.tool_result.error_code, 'CMP-LOOP-0013');
});

// CTL-001 anchor reuse: an edit-and-resend send carries editedMessageId so the
// turn re-anchors the EDITED durable user message instead of appending a
// second copy of the prompt. Without this, the transcript holds two user
// messages with identical text after every edit (the truncate-kept edited
// message plus the resend's fresh user_<streamId> row).
test('edit-resend with editedMessageId reuses the edited user message as the turn anchor', async (t) => {
  const service = createManagedChatServiceStub({
    featureFlags: { canonical_bridge: true, canonical_turn_events: true },
  });
  const sessionId = 'session_edit_anchor_reuse';
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Edit anchor',
    preferences: { preferred_model: 'mock-v1', session_start_date: '2026-07-09' },
  });
  service.sessionMessages.push({
    id: 'msg_user_edit',
    role: 'user',
    content: 'edited prompt',
    timestamp: '2026-07-09T10:00:00.000Z',
  });
  service.sessionMessages.push({
    id: 'assistant_failed_attempt',
    role: 'assistant',
    content: '',
    status: 'error',
    stream_error: 'prior attempt failed',
    timestamp: '2026-07-09T10:00:01.000Z',
  });
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      options.onNotification({ method: 'chat.token', params: { delta: 'fresh answer' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'edited prompt',
    editedMessageId: 'msg_user_edit',
  }));
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;

  const userMessages = service.sessionMessages.filter((message) => message.role === 'user');
  assert.equal(userMessages.length, 1, 'no second user message may be appended for an edit-resend');
  assert.equal(userMessages[0].id, 'msg_user_edit');
  assert.equal(userMessages[0].content, 'edited prompt');
  assert.equal(
    service.sessionMessages.some((message) => String(message.id || '') === `user_${stream.streamId}`),
    false,
    'the default user_<streamId> row must not exist for an anchored resend',
  );
  assert.equal(
    service.sessionMessages.some((message) => String(message.id || '') === 'assistant_failed_attempt'),
    false,
    'the superseded error suffix is removed by the anchored retry transaction',
  );
  const assistant = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.ok(assistant);
  assert.equal(assistant.content, 'fresh answer');
  const persistedMessages = service.sessionStore.getSessionMessages(sessionId);
  assert.deepEqual(
    persistedMessages.map((message) => message.id),
    ['msg_user_edit', assistant.id],
    'rehydration reads the same deduplicated recovered transcript from Electron persistence',
  );
  assert.equal(persistedMessages[1].model_used, 'mock-v1');
});

test('edit-resend rejects a non-user anchor before provider work', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_edit_anchor_invalid';
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Edit anchor invalid',
    preferences: { preferred_model: 'mock-v1', session_start_date: '2026-07-09' },
  });
  service.sessionMessages.push({
    id: 'assistant_existing',
    role: 'assistant',
    content: 'a prior answer',
    timestamp: '2026-07-09T10:00:00.000Z',
  });
  let providerCalls = 0;
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      providerCalls += 1;
      options.onNotification({ method: 'chat.token', params: { delta: 'answer' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  await assert.rejects(
    startManagedSidecarChatStream(service, buildManagedChatRequest({
      sessionId,
      prompt: 'a new prompt',
      editedMessageId: 'assistant_existing',
    })),
    (error) => error.code === 'invalid_edit_target'
  );

  const priorAssistant = service.sessionMessages.find(
    (message) => String(message.id || '') === 'assistant_existing'
  );
  assert.equal(priorAssistant.content, 'a prior answer', 'a non-user anchor must never be overwritten');
  assert.equal(priorAssistant.role, 'assistant');
  assert.equal(service.sessionMessages.some((message) => message.role === 'user'), false);
  assert.equal(providerCalls, 0);
  assert.equal(service.activeStreams.size, 0);
});
