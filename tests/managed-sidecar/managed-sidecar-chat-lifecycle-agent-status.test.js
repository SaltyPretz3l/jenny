const test = require('node:test');
const assert = require('node:assert/strict');

const { startManagedSidecarChatStream } = require('../../services/backend/managed-sidecar-chat');
const { createManagedChatServiceStub } = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

test('managed sidecar normalizes agent.progress into agent_status events and mirrors lifecycle into active_turn', async () => {
  const service = createManagedChatServiceStub({
    featureFlags: { agent_executor: true },
  });
  let resolveChatSend;
  let chatSendParams = null;
  let chatSendOptions = null;
  service.sidecarClient = {
    chatSend: async (params, options = {}) => {
      chatSendParams = params;
      chatSendOptions = options;
      options.onNotification({
        method: 'agent.progress',
        params: {
          request_id: params.request_id,
          session_id: params.session_id,
          task_id: 'local_agent_test',
          task_type: 'local_agent',
          source: 'local_agent',
          status: 'running',
          stage: 'planning',
          percent: 20,
          summary: 'Planning multi-step execution strategy.',
          terminal_subcode: 'user_cancel',
          terminal: false,
          success: false,
        },
      });
      return new Promise((resolve) => {
        resolveChatSend = resolve;
      });
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_agent_status',
    prompt: 'Show task progress',
    visiblePrompt: 'Show task progress',
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

  const lifecycleEvent = service.emittedEvents.find(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'agent_status'
  );
  assert.ok(lifecycleEvent);
  assert.equal(lifecycleEvent.payload.streamId, stream.streamId);
  assert.equal(lifecycleEvent.payload.requestId, stream.streamId);
  assert.equal(lifecycleEvent.payload.taskId, 'local_agent_test');
  assert.equal(lifecycleEvent.payload.taskType, 'local_agent');
  assert.equal(lifecycleEvent.payload.stage, 'planning');
  assert.equal(lifecycleEvent.payload.percent, 20);
  assert.equal(lifecycleEvent.payload.summary, 'Planning multi-step execution strategy.');
  assert.equal(lifecycleEvent.payload.terminalSubcode, 'user_cancel');

  const activeTurn = service.sessionStore.getActiveTurn('session_agent_status');
  assert.match(activeTurn.session_incarnation, /^incarnation_/);
  assert.deepEqual(activeTurn, {
    request_id: stream.streamId,
    turn_id: stream.streamId,
    stream_id: stream.streamId,
    trace_id: stream.streamId,
    user_message_id: `user_${stream.streamId}`,
    session_incarnation: activeTurn.session_incarnation,
    generation: stream.identity.generation,
    started_at: activeTurn.started_at,
    last_event_at: activeTurn.last_event_at,
    status: 'streaming',
    task_id: 'local_agent_test',
    task_type: 'local_agent',
    agent_stage: 'planning',
    agent_summary: 'Planning multi-step execution strategy.',
    agent_percent: 20,
  });

  chatSendOptions.onNotification({
    method: 'chat.token',
    params: { delta: 'Done' },
  });
  chatSendOptions.onNotification({
    method: 'chat.done',
    params: {},
  });
  resolveChatSend({ status: 'completed' });
  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(service.sessionStore.getActiveTurn('session_agent_status'), null);
  assert.equal(chatSendParams.request_id, stream.streamId);
  assert.equal(chatSendParams.generation, stream.identity.generation);
  assert.match(chatSendParams.session_incarnation, /^incarnation_[A-Za-z0-9-]+$/);
});

test('managed sidecar ignores agent.progress notifications when agent executor rollout is disabled', async () => {
  const service = createManagedChatServiceStub();
  let resolveChatSend;
  let chatSendOptions = null;
  service.sidecarClient = {
    chatSend: async (params, options = {}) => {
      chatSendOptions = options;
      options.onNotification({
        method: 'agent.progress',
        params: {
          request_id: params.request_id,
          session_id: params.session_id,
          task_id: 'local_agent_hidden',
          task_type: 'local_agent',
          source: 'local_agent',
          status: 'running',
          stage: 'planning',
          percent: 20,
          summary: 'This should stay behind the rollout flag.',
          terminal: false,
          success: false,
        },
      });
      return new Promise((resolve) => {
        resolveChatSend = resolve;
      });
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_agent_status_flagged_off',
    prompt: 'Keep hidden lifecycle disabled',
    visiblePrompt: 'Keep hidden lifecycle disabled',
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

  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'agent_status'
    ),
    false
  );
  const activeTurn = service.sessionStore.getActiveTurn('session_agent_status_flagged_off');
  assert.ok(activeTurn);
  assert.equal(activeTurn.task_id, undefined);
  assert.equal(activeTurn.agent_stage, undefined);

  chatSendOptions.onNotification({
    method: 'chat.token',
    params: { delta: 'Still fine.' },
  });
  chatSendOptions.onNotification({
    method: 'chat.done',
    params: {},
  });
  resolveChatSend({ status: 'completed' });
  await service.activeStreams.get(stream.streamId)._pendingPromise;
});
