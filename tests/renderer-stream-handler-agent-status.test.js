const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamHandler } = require('../renderer/chat/renderer-stream-handler');
const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');
const {
  mergeReasoningEntries,
  normalizeChatMessage,
  normalizeChatMessages,
} = require('../renderer/chat/chat-message-utils');
const { createSessionManager } = require('../renderer/shell/renderer-session-utils');

function createQueuedFrameController() {
  let nextHandle = 1;
  const callbacks = new Map();
  return {
    requestAnimationFrame(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle) {
      callbacks.delete(handle);
    },
    async drainNextFrame() {
      const frameCallbacks = [...callbacks.entries()];
      callbacks.clear();
      frameCallbacks.forEach(([, callback]) => callback(Date.now()));
      await flushMicrotasks(25);
      return frameCallbacks.length;
    },
    pendingCount() {
      return callbacks.size;
    },
  };
}

async function flushMicrotasks(count = 1) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function createRealNormalizedMessage() {
  const state = {
    messagesBySession: new Map(),
    pendingToolApprovals: new Map(),
    ui: {},
  };
  return createSessionManager({
    state,
    constants: {
      INTERACTIVE_SEQUENCE_IDLE: 'idle',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      MAX_INTERACTIVE_ROUNDS: 3,
      MAX_INTERACTIVE_QUESTIONS: 3,
    },
    callbacks: {
      normalizeChatMessage,
      normalizeChatMessages,
      isInteractiveOtherTrigger: () => false,
      getActiveSession: () => null,
      patchSessionSummary() {},
      rekeyDismissedMemorySession() {},
      rekeySessionArtifacts() {},
    },
  }).createNormalizedMessage;
}

function createHarness(options = {}) {
  const {
    requestAnimationFrameImpl = null,
    cancelAnimationFrameImpl = null,
    callbackOverrides = {},
    stateOverrides = {},
  } = options;
  const previousWindow = global.window;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const previousCancelAnimationFrame = global.cancelAnimationFrame;
  global.requestAnimationFrame = requestAnimationFrameImpl || ((callback) => {
    callback();
    return 1;
  });
  global.cancelAnimationFrame = cancelAnimationFrameImpl || (() => {});
  global.window = stateOverrides.window || {
    jennyShell: {
      sessions: {
        async getMessages() {
          return { data: [] };
        },
      },
    },
  };
  const defaultMessagesBySession = new Map([['session-1', []], ['session-2', []], ['session-3', []], ['session-4', []]]);
  const state = {
    currentSessionId: 'session-1',
    ui: { activeView: 'chat', chatSendLifecycleBySession: new Map() },
    messagesBySession: stateOverrides.messagesBySession || defaultMessagesBySession,
    interactiveDraftsBySession: new Map(),
    sessions: [{ id: 'session-1' }, { id: 'session-2' }, { id: 'session-3' }, { id: 'session-4' }],
    pendingStreams: new Map(),
    streamThinkingStatusByStream: new Map(),
    toolCallsByStream: new Map(),
    pendingToolApprovals: new Map(),
    bufferedStreamEventsByStream: new Map(),
    sendPreflight: null,
    ...stateOverrides,
  };
  state.ui = {
    activeView: 'chat',
    chatSendLifecycleBySession: new Map(),
    ...(stateOverrides.ui || {}),
  };
  const calls = {
    renderMessages: 0,
    renderSessions: 0,
    renderWorkspaceChrome: 0,
    setSessionMessages: [],
    toasts: [],
    indicator: [],
    presence: [],
    rolloutSignals: [],
  };
  const multiStreamController = createMultiStreamController({
    getState: () => state,
    appendClientLog() {},
  });
  const thinkingIndicator = {
    startIndicator(mode) { calls.indicator.push(['start', mode]); },
    updateIndicator(mode) { calls.indicator.push(['update', mode]); },
    completeIndicator() { calls.indicator.push(['complete']); },
    resetIndicator() { calls.indicator.push(['reset']); },
    getDisplayState() {
      const lastCall = calls.indicator[calls.indicator.length - 1] || null;
      if (!lastCall) {
        return { mode: 'idle' };
      }
      if (lastCall[0] === 'start' || lastCall[0] === 'update') {
        return { mode: lastCall[1] || 'thinking' };
      }
      return { mode: 'idle' };
    },
  };
  let streamListener = null;
  const handler = createStreamHandler({
    state,
    thinkingIndicator,
    dom: { chatInput: { focus() {} } },
    multiStreamController,
    constants: {
      MESSAGE_STATUS: { STREAMING: 'streaming', COMPLETE: 'complete', ERROR: 'error' },
      MAX_INTERACTIVE_QUESTIONS: 3,
      MAX_INTERACTIVE_ROUNDS: 3,
      INTERACTIVE_SEQUENCE_FALLBACK_REQUESTED: 'fallback_requested',
      INTERACTIVE_SEQUENCE_STRUCTURED_ACTIVE: 'structured_active',
      TOAST_SOURCE: { chatStream: 'chat.stream' },
    },
    callbacks: {
      renderAll() {},
      renderHeader() {},
      renderMessages() { calls.renderMessages += 1; },
      renderSessions() { calls.renderSessions += 1; },
      renderSettings() {},
      renderComposerState() {},
      renderComposerStatusNotice() {},
      renderWorkspaceChrome() { calls.renderWorkspaceChrome += 1; },
      getSessionMessages(sessionId) { return state.messagesBySession.get(sessionId) || []; },
      setSessionMessages(sessionId, messages) {
        calls.setSessionMessages.push({ sessionId, messages });
        state.messagesBySession.set(sessionId, messages);
      },
      createNormalizedMessage(role, content, extra = {}) {
        return { id: extra.id || `${role}_${Date.now()}`, role, content, ...extra };
      },
      setComposerStatusNotice() {},
      clearComposerStatusNotice() {},
      normalizePendingQuestionBatch(batch) { return batch || null; },
      getInteractiveSequenceState() { return 'idle'; },
      clearInteractiveDraft() {},
      ensureInteractiveDraft() {},
      patchSessionSummary() {},
      buildInteractiveQuestionBatchVisibleText() { return ''; },
      refreshSessionSummaries: async () => ({}),
      refreshSnapshots: async () => {},
      showToastMessage(message, options) { calls.toasts.push({ message, options }); },
      dismissStreamErrors() {},
      maybeSuggestMemoryCapture: async () => {},
      appendClientLog() {},
      handlePresenceStreamEvent(payload) { calls.presence.push(payload); },
      getInteractiveComposerStatusNotice() { return ''; },
      persistInteractiveFallbackRequest: async () => {},
      requestInteractiveGuardrailAnswer: async () => {},
      requestInteractiveProtocolDriftAnswer: async () => {},
      queueInteractiveComposerFocus() {},
      mergeMessageReasoning(message, reasoning) {
        if (!reasoning || !Array.isArray(reasoning.entriesDelta) || !reasoning.entriesDelta.length) {
          return message.reasoning || { source: 'none', entries: [] };
        }
        const existingEntries = Array.isArray(message?.reasoning?.entries) ? message.reasoning.entries : [];
        return {
          source: String(reasoning.source || 'provider'),
          entries: mergeReasoningEntries(existingEntries, reasoning.entriesDelta, {
            timestamp: '2026-04-10T00:00:00.000Z',
          }),
        };
      },
      getQueuedSend() { return null; },
      restoreQueuedSendDraft() {},
      dispatchQueuedSendForSession: async () => null,
      setChatSendLifecycle(sessionId, lifecycle) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
          return 'idle';
        }
        state.ui.chatSendLifecycleBySession.set(normalizedSessionId, lifecycle);
        return lifecycle;
      },
      clearChatSendLifecycle(sessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
          return false;
        }
        return state.ui.chatSendLifecycleBySession.delete(normalizedSessionId);
      },
      getChatSendLifecycle(sessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
          return 'idle';
        }
        return state.ui.chatSendLifecycleBySession.get(normalizedSessionId) || 'idle';
      },
      getChatTimelineRowModelEnabled(sessionId) {
        const normalizedSessionId = String(sessionId || '').trim();
        if (!normalizedSessionId) {
          return false;
        }
        return state.ui.chatTimelineRowModelBySession?.get(normalizedSessionId) === true;
      },
      recordChatTimelineRolloutSignal(sessionId, signal, details) {
        calls.rolloutSignals.push({ sessionId, signal, details });
        return { logged: true, count: calls.rolloutSignals.length };
      },
      ...callbackOverrides,
    },
  });
  handler.registerStreamHandler({
    chat: {
      onStream(listener) {
        streamListener = listener;
        return () => {
          streamListener = null;
        };
      },
    },
  });
  return {
    state,
    calls,
    handler,
    multiStreamController,
    async emit(payload) {
      await streamListener(payload);
    },
    restore() {
      global.window = previousWindow;
      global.requestAnimationFrame = previousRequestAnimationFrame;
      global.cancelAnimationFrame = previousCancelAnimationFrame;
    },
  };
}

test('stream handler tracks reasoning phases on the pending assistant message and clears them on stream reset', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-phase-1' });
  await harness.emit({
    type: 'thinking_status',
    sessionId: 'session-1',
    streamId: 'stream-phase-1',
    text: 'Stale status before reset',
    thinkingId: 'think_stream-phase-1_iter1',
  });
  await harness.emit({
    type: 'phase_started',
    sessionId: 'session-1',
    streamId: 'stream-phase-1',
    phaseId: 'phase_reasoning_1',
    phaseKind: 'reasoning',
    iteration: 1,
    thinkingId: 'think_stream-phase-1_iter1',
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-phase-1',
    content: '',
    aggregate: '',
    reasoning: {
      source: 'provider',
      entriesDelta: [
        { id: 'reason-phase-1', text: 'Phase reasoning', thinkingId: 'think_stream-phase-1_iter1' },
      ],
    },
  });
  await harness.emit({
    type: 'phase_completed',
    sessionId: 'session-1',
    streamId: 'stream-phase-1',
    phaseId: 'phase_reasoning_1',
    phaseKind: 'reasoning',
    iteration: 1,
    thinkingId: 'think_stream-phase-1_iter1',
  });

  const pendingBeforeReset = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(pendingBeforeReset.reasoning_phases.length, 1);
  // The wall-clock stamps are split out rather than dropped: the message
  // normaliser derives `completed` from completedAt, not from the boolean, so
  // both must be present -- and completedAt must not precede startedAt, which
  // is what a repeated phase_started clobbering startedAt would produce.
  const { startedAt, completedAt, ...phaseBeforeReset } = pendingBeforeReset.reasoning_phases[0];
  assert.deepEqual(phaseBeforeReset, {
    phaseId: 'phase_reasoning_1',
    phaseKind: 'reasoning',
    iteration: 1,
    thinkingId: 'think_stream-phase-1_iter1',
    toolCallId: '',
    toolName: '',
    completed: true,
  });
  assert.ok(startedAt && completedAt, 'a completed phase must stamp both timestamps');
  assert.ok(Date.parse(completedAt) >= Date.parse(startedAt), 'completedAt must not precede startedAt');

  await harness.emit({
    type: 'stream_reset',
    sessionId: 'session-1',
    streamId: 'stream-phase-1',
  });

  const pendingAfterReset = harness.state.messagesBySession.get('session-1')[0];
  assert.deepEqual(pendingAfterReset.reasoning, { source: 'none', entries: [] });
  assert.deepEqual(pendingAfterReset.reasoning_phases, []);
  assert.equal(pendingAfterReset.content, '');
  assert.equal(harness.state.streamThinkingStatusByStream.has('stream-phase-1'), false);
});

test('stream terminals settle unfinished reasoning phases without clearing partial reasoning', async (t) => {
  const harness = createHarness({
    callbackOverrides: { createNormalizedMessage: createRealNormalizedMessage() },
  });
  t.after(() => harness.restore());

  for (const terminal of [
    { type: 'complete', content: 'Done' },
    { type: 'error', message: 'Provider stopped', status: 'error' },
  ]) {
    const suffix = terminal.type;
    const streamId = `stream-phase-terminal-${suffix}`;
    const phaseId = `phase-reasoning-${suffix}`;
    const thinkingId = `thinking-${suffix}`;
    await harness.emit({ type: 'started', sessionId: 'session-1', streamId });
    await harness.emit({
      type: 'phase_started',
      sessionId: 'session-1',
      streamId,
      phaseId,
      phaseKind: 'reasoning',
      iteration: 1,
      thinkingId,
      summary: 'The user asked',
    });
    await harness.emit({
      type: 'delta',
      sessionId: 'session-1',
      streamId,
      content: '',
      aggregate: '',
      reasoning: {
        source: 'provider',
        entriesDelta: [{ id: `reason-${suffix}`, text: 'Partial thought', thinkingId }],
      },
    });

    await harness.emit({ ...terminal, sessionId: 'session-1', streamId });

    const message = harness.state.messagesBySession.get('session-1')
      .find((entry) => entry.streamId === streamId);
    assert.ok(message, `${terminal.type} terminal keeps its assistant message`);
    assert.equal(message.reasoning_phases[0].completed, true);
    assert.equal(
      Number.isNaN(Date.parse(message.reasoning_phases[0].completedAt)),
      false,
      `${terminal.type} completion timestamp survives the real createNormalizedMessage`,
    );
    assert.equal(message.reasoning_phases[0].summary, 'The user asked');
    assert.equal(message.reasoning.entries[0].text, 'Partial thought');
  }
});

test('stream handler patches a transient agent_status widget onto the pending assistant message and clears it on completion', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-agent-1' });
  await harness.emit({
    type: 'agent_status',
    sessionId: 'session-1',
    streamId: 'stream-agent-1',
    requestId: 'stream-agent-1',
    taskId: 'local_agent_1',
    taskType: 'local_agent',
    source: 'local_agent',
    status: 'running',
    stage: 'planning',
    percent: 20,
    summary: 'Planning multi-step execution strategy.',
    terminal: false,
    success: false,
  });

  const pendingMessage = harness.state.messagesBySession.get('session-1')[0];
  assert.ok(pendingMessage.agent_status);
  assert.equal(pendingMessage.agent_status.taskId, 'local_agent_1');
  assert.equal(pendingMessage.agent_status.stage, 'planning');
  assert.equal(pendingMessage.agent_status.summary, 'Planning multi-step execution strategy.');

  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-agent-1',
    content: 'Done',
  });

  const completedMessage = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(completedMessage.agent_status, null);
});

test('stream handler accumulates agent_status_steps across sequential stages on the pending shell', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-agent-steps' });

  const basePayload = {
    type: 'agent_status',
    sessionId: 'session-1',
    streamId: 'stream-agent-steps',
    requestId: 'stream-agent-steps',
    taskId: 'task-steps',
    taskType: 'local_agent',
    agentId: 'research@stream-agent-steps:call-1:1',
    parentAgentId: 'main@stream-agent-steps',
    source: 'local_agent',
    terminal: false,
    success: false,
  };

  await harness.emit({
    ...basePayload,
    status: 'running', stage: 'planning', percent: 20, summary: 'Planning',
  });
  await harness.emit({
    ...basePayload,
    status: 'running', stage: 'gathering_context', percent: 55, summary: 'Collecting files',
  });
  await harness.emit({
    ...basePayload,
    status: 'running', stage: 'synthesizing', percent: 90, summary: 'Writing response',
  });

  const pending = harness.state.messagesBySession.get('session-1')[0];
  assert.ok(Array.isArray(pending.agent_status_steps));
  assert.equal(pending.agent_status_steps.length, 3);
  assert.deepEqual(
    pending.agent_status_steps.map((s) => s.stage),
    ['planning', 'gathering_context', 'synthesizing']
  );
  assert.equal(pending.agent_status.stage, 'synthesizing', 'snapshot equals last stage');
  assert.equal(pending.agent_status.percent, 90);
  assert.equal(pending.agent_status.agentId, 'research@stream-agent-steps:call-1:1');
  assert.equal(pending.agent_status.parentAgentId, 'main@stream-agent-steps');
  assert.ok(pending.agent_status_steps.every(
    (step) => step.agentId === 'research@stream-agent-steps:call-1:1'
      && step.parentAgentId === 'main@stream-agent-steps'
  ));
});

test('stream handler updates existing step in place when same stage re-emits', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-a' });
  const base = {
    type: 'agent_status', sessionId: 'session-1', streamId: 'stream-a', requestId: 'stream-a',
    taskId: 'task-1', taskType: 'local_agent', source: 'local_agent',
    status: 'running', stage: 'planning', terminal: false, success: false,
  };
  await harness.emit({ ...base, percent: 10, summary: 'Starting' });
  await harness.emit({ ...base, percent: 80, summary: 'Almost done' });

  const pending = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(pending.agent_status_steps.length, 1);
  assert.equal(pending.agent_status_steps[0].percent, 80);
  assert.equal(pending.agent_status_steps[0].summary, 'Almost done');
});

test('stream handler clears agent_status_steps on stream_reset', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-reset' });
  await harness.emit({
    type: 'agent_status', sessionId: 'session-1', streamId: 'stream-reset', requestId: 'stream-reset',
    taskId: 'task-r', taskType: 'local_agent', source: 'local_agent',
    status: 'running', stage: 'planning', percent: 30, summary: 'Planning',
    terminal: false, success: false,
  });

  const before = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(before.agent_status_steps.length, 1);

  await harness.emit({ type: 'stream_reset', sessionId: 'session-1', streamId: 'stream-reset' });

  const after = harness.state.messagesBySession.get('session-1')[0];
  assert.ok(Array.isArray(after.agent_status_steps));
  assert.equal(after.agent_status_steps.length, 0);
});

test('stream handler records terminal failure in agent_status_steps', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-fail' });
  await harness.emit({
    type: 'agent_status', sessionId: 'session-1', streamId: 'stream-fail', requestId: 'stream-fail',
    taskId: 'task-f', taskType: 'local_agent', source: 'local_agent',
    status: 'running', stage: 'planning', percent: 40, summary: 'Working',
    terminal: false, success: false,
  });
  await harness.emit({
    type: 'agent_status', sessionId: 'session-1', streamId: 'stream-fail', requestId: 'stream-fail',
    taskId: 'task-f', taskType: 'local_agent', source: 'local_agent',
    status: 'failed', stage: 'planning', percent: 40, summary: 'Ran into trouble',
    terminal: true, success: false,
  });

  const pending = harness.state.messagesBySession.get('session-1')[0];
  assert.equal(pending.agent_status_steps.length, 1);
  assert.equal(pending.agent_status_steps[0].terminal, true);
  assert.equal(pending.agent_status_steps[0].success, false);
  assert.equal(pending.agent_status.status, 'failed');
});
