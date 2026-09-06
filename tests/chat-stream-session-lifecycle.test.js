const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { SessionShadowStore } = require('../services/backend/session-shadow-store');
const {
  buildAutomaticSessionTitleCandidate,
  shouldApplyAutomaticSessionTitle,
} = require('../services/backend/interactive-session-utils');
const {
  clearActiveTurn,
  createManagedSessionLifecycleAdapter,
  createSessionLifecycleAdapter,
  persistAssistantFailure,
  startActiveTurn,
  settleAssistantCompletion,
  settleQuestionBatch,
  touchActiveTurnProgress,
} = require('../services/backend/chat-stream-session-lifecycle');
const { normalizeMessageFields } = require('../services/backend/message-normalization');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('automatic title helpers require a visible prompt and an empty placeholder session', () => {
  assert.equal(
    buildAutomaticSessionTitleCandidate('  First visible prompt  ', null),
    'First visible prompt'
  );
  assert.equal(
    buildAutomaticSessionTitleCandidate('Interactive answer chip', { disposition: 'answered' }),
    ''
  );
  assert.equal(buildAutomaticSessionTitleCandidate('   ', null), '');

  assert.equal(
    shouldApplyAutomaticSessionTitle({ title: 'New Chat', message_count: 0 }, 'First visible prompt'),
    true
  );
  assert.equal(
    shouldApplyAutomaticSessionTitle({ title: 'Existing title', message_count: 0 }, 'First visible prompt'),
    false
  );
  assert.equal(
    shouldApplyAutomaticSessionTitle({ title: 'New Chat', message_count: 1 }, 'First visible prompt'),
    false
  );
  assert.equal(shouldApplyAutomaticSessionTitle(null, 'First visible prompt'), false);
  assert.equal(shouldApplyAutomaticSessionTitle({ title: 'New Chat', message_count: 0 }, ''), false);
});

function createAdapterHarness() {
  const messages = [];
  const preferences = [];
  const titles = [];
  let activeTurn = null;
  const adapter = createSessionLifecycleAdapter({
    appendMessage(message, options = {}) {
      messages.push({
        ...message,
        _options: { ...options },
      });
      return message;
    },
    setSessionPreferences(next) {
      preferences.push({ ...next });
      return next;
    },
    getActiveTurn() {
      return activeTurn;
    },
    setActiveTurn(next) {
      activeTurn = next;
      return next;
    },
    touchActiveTurn(match, patch) {
      if (
        !activeTurn
        || (match?.request_id && activeTurn.request_id !== match.request_id)
        || (match?.stream_id && activeTurn.stream_id !== match.stream_id)
      ) {
        return null;
      }
      activeTurn = {
        ...activeTurn,
        ...patch,
      };
      return activeTurn;
    },
    clearActiveTurn(match) {
      if (
        !activeTurn
        || (match?.request_id && activeTurn.request_id !== match.request_id)
        || (match?.stream_id && activeTurn.stream_id !== match.stream_id)
      ) {
        return null;
      }
      activeTurn = null;
      return null;
    },
    async applySessionTitle(title, options = {}) {
      titles.push({
        title,
        ...options,
      });
    },
  });
  return {
    adapter,
    messages,
    preferences,
    titles,
    get activeTurn() {
      return activeTurn;
    },
  };
}

test('session lifecycle adapter validates required handlers up front', () => {
  assert.throws(
    () => createSessionLifecycleAdapter({
      appendMessage: null,
      setSessionPreferences() {},
      getActiveTurn() {},
      setActiveTurn() {},
      touchActiveTurn() {},
      clearActiveTurn() {},
    }),
    /appendMessage function/i
  );
  assert.throws(
    () => createSessionLifecycleAdapter({
      appendMessage() {},
      setSessionPreferences: null,
      getActiveTurn() {},
      setActiveTurn() {},
      touchActiveTurn() {},
      clearActiveTurn() {},
    }),
    /setSessionPreferences function/i
  );
});

test('session lifecycle active-turn helpers write, touch, and compare-clear reconnect state', () => {
  const harness = createAdapterHarness();

  startActiveTurn(harness.adapter, {
    requestId: 'req_1',
    streamId: 'stream_1',
    userMessageId: 'user_1',
    timestamp: '2026-04-09T10:00:00.000Z',
  });
  assert.deepEqual(harness.activeTurn, {
    request_id: 'req_1',
    stream_id: 'stream_1',
    trace_id: '',
    user_message_id: 'user_1',
    started_at: '2026-04-09T10:00:00.000Z',
    last_event_at: '2026-04-09T10:00:00.000Z',
    status: 'awaiting_assistant',
  });

  touchActiveTurnProgress(harness.adapter, {
    requestId: 'req_1',
    streamId: 'stream_1',
    timestamp: '2026-04-09T10:00:00.200Z',
  });
  assert.equal(harness.activeTurn.status, 'streaming');
  assert.equal(harness.activeTurn.last_event_at, '2026-04-09T10:00:00.200Z');

  touchActiveTurnProgress(harness.adapter, {
    requestId: 'req_1',
    streamId: 'stream_1',
    timestamp: '2026-04-09T10:00:00.500Z',
  });
  assert.equal(harness.activeTurn.last_event_at, '2026-04-09T10:00:00.200Z');

  touchActiveTurnProgress(harness.adapter, {
    requestId: 'req_1',
    streamId: 'stream_1',
    timestamp: '2026-04-09T10:00:01.500Z',
    taskId: 'local_agent_1',
    taskType: 'local_agent',
    agentStage: 'planning',
    agentSummary: 'Planning multi-step execution strategy.',
    agentPercent: 20,
  });
  assert.equal(harness.activeTurn.last_event_at, '2026-04-09T10:00:01.500Z');
  assert.equal(harness.activeTurn.task_id, 'local_agent_1');
  assert.equal(harness.activeTurn.task_type, 'local_agent');
  assert.equal(harness.activeTurn.agent_stage, 'planning');
  assert.equal(harness.activeTurn.agent_summary, 'Planning multi-step execution strategy.');
  assert.equal(harness.activeTurn.agent_percent, 20);

  clearActiveTurn(harness.adapter, {
    requestId: 'req_other',
    streamId: 'stream_1',
  });
  assert.ok(harness.activeTurn);

  clearActiveTurn(harness.adapter, {
    requestId: 'req_1',
    streamId: 'stream_1',
  });
  assert.equal(harness.activeTurn, null);
});

test('session lifecycle progress throttle suppresses store reads when cached active turn has not advanced', () => {
  let activeTurn = null;
  let getActiveTurnCalls = 0;
  let touchActiveTurnCalls = 0;
  const adapter = createSessionLifecycleAdapter({
    appendMessage() {},
    setSessionPreferences() {},
    getActiveTurn() {
      getActiveTurnCalls += 1;
      return activeTurn;
    },
    setActiveTurn(next) {
      activeTurn = next;
      return activeTurn;
    },
    touchActiveTurn(_match, patch) {
      touchActiveTurnCalls += 1;
      activeTurn = {
        ...activeTurn,
        ...patch,
      };
      return activeTurn;
    },
    clearActiveTurn() {
      activeTurn = null;
      return null;
    },
  });

  startActiveTurn(adapter, {
    requestId: 'req_cached',
    streamId: 'stream_cached',
    userMessageId: 'user_cached',
    timestamp: '2026-04-09T10:00:00.000Z',
  });
  touchActiveTurnProgress(adapter, {
    requestId: 'req_cached',
    streamId: 'stream_cached',
    timestamp: '2026-04-09T10:00:00.200Z',
  });
  assert.equal(touchActiveTurnCalls, 1);

  getActiveTurnCalls = 0;
  touchActiveTurnCalls = 0;
  const suppressed = touchActiveTurnProgress(adapter, {
    requestId: 'req_cached',
    streamId: 'stream_cached',
    timestamp: '2026-04-09T10:00:00.500Z',
  });

  assert.equal(getActiveTurnCalls, 0);
  assert.equal(touchActiveTurnCalls, 0);
  assert.equal(suppressed.last_event_at, '2026-04-09T10:00:00.200Z');
});

test('session lifecycle cache keeps requested active-turn shape when mutators return summaries', () => {
  let writes = 0;
  const adapter = createSessionLifecycleAdapter({
    appendMessage() {},
    setSessionPreferences() {},
    getActiveTurn() { throw new Error('the requested-shape cache should satisfy this read'); },
    setActiveTurn() { return { id: 'sess_1', title: 'summary' }; },
    touchActiveTurn() { writes += 1; return { id: 'sess_1', title: 'summary' }; },
    clearActiveTurn() { return { id: 'sess_1', title: 'summary' }; },
  });
  startActiveTurn(adapter, {
    requestId: 'turn_shape', streamId: 'stream_shape', userMessageId: 'user_shape',
    timestamp: '2026-04-09T10:00:00.000Z',
  });
  touchActiveTurnProgress(adapter, {
    requestId: 'turn_shape', streamId: 'stream_shape',
    timestamp: '2026-04-09T10:00:00.200Z',
  });
  const suppressed = touchActiveTurnProgress(adapter, {
    requestId: 'turn_shape', streamId: 'stream_shape',
    timestamp: '2026-04-09T10:00:00.500Z',
  });
  assert.equal(writes, 1);
  assert.equal(suppressed.stream_id, 'stream_shape');
  assert.equal(suppressed.last_event_at, '2026-04-09T10:00:00.200Z');
});

test('session lifecycle settles assistant completion and clears interactive pending state', async () => {
  const harness = createAdapterHarness();

  await settleAssistantCompletion(harness.adapter, {
    messageId: 'assistant_stream_1',
    content: 'All set.',
    reasoningEntries: [{ id: 'reason_1', text: 'Thought.', timestamp: '2026-04-06T10:00:00.000Z' }],
    model: 'mock-v1',
    requestId: 'req_1',
    streamId: 'stream_1',
    normalizedPreferences: {},
    normalizedInteractiveResponse: {
      batch_id: 'ib_1',
      round_index: 1,
      batch_snapshot: {
        batch_id: 'ib_1',
        round_index: 1,
        questions: [
          {
            id: 'q1',
            prompt: 'What pace feels right?',
            options: [
              { id: 'steady', label: 'Steady' },
            ],
          },
        ],
      },
      answers: [
        {
          question_id: 'q1',
          option_id: 'steady',
          text: '',
        },
      ],
    },
    exchangeTitle: 'Refined title',
    timestamp: '2026-04-06T10:05:00.000Z',
  });

  assert.equal(harness.messages[0].id, 'assistant_stream_1');
  assert.equal(harness.messages[0].content, 'All set.');
  assert.deepEqual(harness.messages[0].reasoning, {
    source: 'provider',
    entries: [{ id: 'reason_1', text: 'Thought.', timestamp: '2026-04-06T10:00:00.000Z' }],
  });
  assert.equal(harness.messages[1].kind, 'interactive_round_recap');
  assert.equal(harness.messages[1].interactive_round_recap.answer_count, 1);
  assert.equal(harness.activeTurn, null);
  assert.deepEqual(harness.preferences, [{
    pending_question_batch: null,
    pending_plan_proposal: null,
    interactive_sequence_state: 'idle',
    interactive_round_count: 0,
  }]);
  assert.deepEqual(harness.titles, [{
    title: 'Refined title',
    reason: 'complete',
  }]);
});

test('assistant completion scopes resumable_stop to the completed message', async () => {
  const resumableHarness = createAdapterHarness();
  await settleAssistantCompletion(resumableHarness.adapter, {
    messageId: 'assistant_resumable',
    content: 'Pause here.',
    reasoningEntries: [],
    model: 'mock-v1',
    normalizedPreferences: {},
    normalizedInteractiveResponse: {
      batch_id: 'ib_resumable',
      round_index: 1,
      batch_snapshot: {
        batch_id: 'ib_resumable',
        round_index: 1,
        questions: [{
          id: 'q1',
          prompt: 'Continue?',
          options: [{ id: 'yes', label: 'Yes' }],
        }],
      },
      answers: [{ question_id: 'q1', option_id: 'yes', text: '' }],
    },
    resumableStop: 'tool_cap',
    timestamp: '2026-09-04T10:00:00.000Z',
  });

  assert.equal(resumableHarness.messages[0].resumable_stop, 'tool_cap');
  assert.equal(resumableHarness.messages[1].kind, 'interactive_round_recap');
  assert.equal(Object.hasOwn(resumableHarness.messages[1], 'resumable_stop'), false);
  assert.equal(
    normalizeMessageFields(resumableHarness.messages[0]).resumable_stop,
    'tool_cap'
  );

  const ordinaryHarness = createAdapterHarness();
  await settleAssistantCompletion(ordinaryHarness.adapter, {
    messageId: 'assistant_ordinary',
    content: 'Finished.',
    reasoningEntries: [],
    model: 'mock-v1',
    normalizedPreferences: {},
    normalizedInteractiveResponse: null,
    timestamp: '2026-09-04T10:01:00.000Z',
  });

  assert.equal(Object.hasOwn(ordinaryHarness.messages[0], 'resumable_stop'), false);
});

test('session lifecycle persists additive Batch 6 transcript fields on assistant completion', async () => {
  const harness = createAdapterHarness();

  await settleAssistantCompletion(harness.adapter, {
    messageId: 'assistant_batch6',
    content: 'Answer with persisted phases.',
    reasoningEntries: [],
    parentStreamId: 'stream_batch6',
    phases: [
      {
        phase_id: 'phase_reasoning_pre',
        phase_kind: 'reasoning',
        iteration: 1,
        thinking_id: 'think_pre',
        render_collapsed: false,
        entries: [
          {
            id: 'reason_pre',
            text: 'Reason before answer.',
            timestamp: '2026-04-13T10:00:00.000Z',
          },
        ],
      },
      {
        phase_id: 'phase_text_main',
        phase_kind: 'text',
        iteration: 1,
      },
    ],
    visibleSegments: [
      {
        segment_id: 'segment_main',
        phase_id: 'phase_text_main',
        text: 'Answer with persisted phases.',
      },
    ],
    toolSteps: [
      {
        call_id: 'call_read_1',
        tool_name: 'read_file',
        tool_use_message_id: 'tool_use_call_read_1',
        tool_result_message_id: 'tool_result_call_read_1',
        status: 'completed',
      },
    ],
    model: 'mock-v1',
    requestId: 'req_batch6',
    streamId: 'stream_batch6',
    normalizedPreferences: {},
    normalizedInteractiveResponse: null,
    exchangeTitle: '',
    timestamp: '2026-04-13T10:00:01.000Z',
  });

  assert.equal(harness.messages[0].parent_stream_id, 'stream_batch6');
  assert.equal(harness.messages[0].phases[0].phase_id, 'phase_reasoning_pre');
  assert.equal(harness.messages[0].visible_segments[0].segment_id, 'segment_main');
  assert.equal(harness.messages[0].tool_steps[0].call_id, 'call_read_1');
  assert.equal(harness.messages[0].reasoning.entries[0].id, 'reason_pre');
});

test('managed session lifecycle adapter keeps title updates best-effort on rename failure', async () => {
  const serviceLogs = [];
  const service = {
    sessionStore: {
      appendMessage() {},
      setSessionPreferences() {},
      getActiveTurn() {
        return null;
      },
      setActiveTurn() {},
      touchActiveTurn() {},
      clearActiveTurn() {},
    },
    async renameSession() {
      throw new Error('rename unavailable');
    },
    _emitServiceLog(level, event, details) {
      serviceLogs.push({ level, event, details });
    },
  };
  const adapter = createManagedSessionLifecycleAdapter(service, 'session_1');

  await assert.doesNotReject(
    adapter.applySessionTitle('Stable title', { reason: 'complete' })
  );
  assert.equal(serviceLogs.some((entry) => entry.event === 'chat.session_title_update_failed'), true);
});

test('managed adapter exchange title defers to a title set while the turn streamed', async () => {
  const renames = [];
  const sessionTitles = { session_1: 'Renamed mid-stream' };
  const service = {
    sessionStore: {
      getSession(sessionId) {
        return { id: sessionId, title: sessionTitles[sessionId] || 'New Chat' };
      },
    },
    async renameSession(sessionId, title) {
      renames.push({ sessionId, title });
      return { id: sessionId, title };
    },
  };
  const adapter = createManagedSessionLifecycleAdapter(service, 'session_1');

  // The exchange title was captured at send time; a renderer auto-title or a
  // manual rename that landed mid-stream must win at completion.
  assert.equal(await adapter.applySessionTitle('Exchange title', { reason: 'complete' }), null);
  assert.deepEqual(renames, [], 'a non-default title is never clobbered');

  sessionTitles.session_1 = 'New Chat';
  await adapter.applySessionTitle('Exchange title', { reason: 'complete' });
  assert.deepEqual(renames, [{ sessionId: 'session_1', title: 'Exchange title' }]);
});

test('shadow session store upgrades legacy payloads and round-trips additive Batch 6 transcript fields', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shadow-batch6-'));
  trackDirectory(userDataPath);
  const storePath = path.join(userDataPath, 'shadow-sessions.json');
  fs.writeFileSync(storePath, JSON.stringify({
    schema_version: 2,
    sessions: {
      session_shadow_batch6: {
        id: 'session_shadow_batch6',
        title: 'Shadow Batch 6',
        created_at: '2026-04-13T12:00:00.000Z',
        updated_at: '2026-04-13T12:00:00.000Z',
        messages: [
          {
            id: 'assistant_shadow_batch6',
            role: 'assistant',
            content: 'Shadow answer.',
            timestamp: '2026-04-13T12:00:01.000Z',
            parent_stream_id: 'stream_shadow_batch6',
            phases: [
              {
                phase_id: 'phase_reasoning_shadow',
                phase_kind: 'reasoning',
                iteration: 1,
                thinking_id: 'think_shadow',
                render_collapsed: true,
                entries: [
                  {
                    id: 'reason_shadow',
                    text: 'Shadow reasoning.',
                    timestamp: '2026-04-13T12:00:00.500Z',
                  },
                ],
              },
            ],
            visible_segments: [
              {
                segment_id: 'segment_shadow',
                phase_id: 'phase_text_shadow',
                text: 'Shadow answer.',
              },
            ],
            tool_steps: [
              {
                call_id: 'call_shadow',
                tool_name: 'read_file',
                tool_use_message_id: 'tool_use_call_shadow',
                tool_result_message_id: 'tool_result_call_shadow',
                status: 'completed',
              },
            ],
          },
        ],
      },
    },
  }, null, 2));

  const store = new SessionShadowStore(storePath);
  // The legacy monolithic file migrates into shadow-sessions/_index.json plus
  // a per-session record; the index carries the current v8 schema marker.
  const indexPath = path.join(
    userDataPath,
    path.basename(storePath, path.extname(storePath)),
    '_index.json'
  );
  const payload = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const [message] = store.getMessages('session_shadow_batch6');

  assert.equal(payload.schema_version, 8);
  assert.equal(message.parent_stream_id, 'stream_shadow_batch6');
  assert.equal(message.reasoning.source, 'provider');
  assert.equal(message.reasoning.entries[0].id, 'reason_shadow');
  assert.equal(message.phases[0].phase_id, 'phase_reasoning_shadow');
  assert.equal(message.visible_segments[0].segment_id, 'segment_shadow');
  assert.equal(message.tool_steps[0].call_id, 'call_shadow');
});

test('session lifecycle settles question batches and preserves guardrail fallback behavior', async () => {
  const harness = createAdapterHarness();
  const questionBatch = {
    batch_id: 'ib_2',
    round_index: 4,
    intro_text: 'One last thing.',
    questions: [
      {
        id: 'q1',
        prompt: 'Pick a pace.',
        options: [
          { id: 'steady', label: 'Steady' },
          { id: 'fast', label: 'Fast' },
        ],
      },
    ],
  };

  await settleQuestionBatch(harness.adapter, {
    messageId: 'question_batch_stream_1',
    content: '1 question',
    questionBatch,
    model: 'mock-v1',
    requestId: 'req_2',
    streamId: 'stream_2',
    normalizedPreferences: {},
    exchangeTitle: 'Interactive title',
    timestamp: '2026-04-06T10:06:00.000Z',
  });

  assert.equal(harness.messages[0].kind, 'question_batch');
  assert.equal(harness.messages[0].interactive_batch.batch_id, 'ib_2');
  assert.equal(
    harness.messages[0].content,
    [
      'Jenny asked follow-up questions:',
      'One last thing.',
      '',
      '1. Pick a pace.',
      'Options: Steady / Fast',
    ].join('\n')
  );
  assert.deepEqual(harness.preferences, [{
    pending_question_batch: questionBatch,
    interactive_sequence_state: 'fallback_requested',
    interactive_round_count: 4,
  }]);
  assert.equal(harness.activeTurn, null);
  // F-06: settleQuestionBatch used to silently drop exchangeTitle (the param
  // was never destructured), so the session title was never applied on this
  // path even when the caller supplied one at send time.
  assert.deepEqual(harness.titles, [{
    title: 'Interactive title',
    reason: 'complete',
  }]);
});

test('session lifecycle persists assistant failures without promoting reasoning into visible text', () => {
  const harness = createAdapterHarness();

  persistAssistantFailure(harness.adapter, {
    messageId: 'assistant_stream_2',
    errorPayload: {
      message: 'Model returned no visible assistant text.',
      error_code: 'CMP-TEST-0001',
      retryable: false,
      category: 'chat',
    },
    reasoningEntries: [{
      id: 'reason_2',
      text: '## Analyze\n\n- keep reasoning separate',
      timestamp: '2026-04-06T10:07:00.000Z',
    }],
    model: 'mock-v1',
    timestamp: '2026-04-06T10:08:00.000Z',
  });

  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].content, '');
  assert.equal(harness.messages[0].status, 'error');
  assert.equal(harness.messages[0].stream_error, 'Model returned no visible assistant text.');
  assert.equal(harness.messages[0].error_code, 'CMP-TEST-0001');
  assert.equal(harness.messages[0].retryable, false);
  assert.deepEqual(harness.messages[0].reasoning, {
    source: 'provider',
    entries: [{
      id: 'reason_2',
      text: '## Analyze\n\n- keep reasoning separate',
      timestamp: '2026-04-06T10:07:00.000Z',
    }],
  });
});

test('session lifecycle threads partial streamed text into assistant failure rows', () => {
  const harness = createAdapterHarness();

  persistAssistantFailure(harness.adapter, {
    messageId: 'assistant_stream_partial',
    content: 'The partial answer the user already saw.',
    errorPayload: {
      message: 'Sidecar process exited.',
      error_code: 'CMP-SIDECAR-0003',
      retryable: true,
      category: 'process_exit',
    },
    model: 'mock-v1',
    terminalStatus: 'runtime_error',
    terminalSubcode: 'sidecar_crash',
    timestamp: '2026-04-06T10:10:00.000Z',
  });

  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].content, 'The partial answer the user already saw.');
  assert.equal(harness.messages[0].status, 'runtime_error');
  assert.equal(harness.messages[0].stream_error, 'Sidecar process exited.');
});

test('session lifecycle stores code-driven recovery actions on assistant failures', () => {
  const harness = createAdapterHarness();

  persistAssistantFailure(harness.adapter, {
    messageId: 'assistant_stream_reconnect',
    errorPayload: {
      message: 'Sidecar process exited.',
      error_code: 'CMP-SIDECAR-0003',
      retryable: true,
      category: 'process_exit',
    },
    model: 'mock-v1',
    terminalStatus: 'runtime_error',
    terminalSubcode: 'sidecar_crash',
    timestamp: '2026-04-06T10:09:00.000Z',
  });

  assert.equal(harness.messages.length, 1);
  assert.equal(harness.messages[0].terminal_status, 'runtime_error');
  assert.equal(harness.messages[0].next_action, 'retry_turn');
  assert.equal(harness.messages[0].recovery_class, 'sidecar_transport');
  assert.deepEqual(
    harness.messages[0].recovery_actions.map((entry) => entry.id),
    ['retry_turn', 'restart_sidecar', 'open_diagnostics']
  );
});
