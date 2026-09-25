const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  createManagedChatServiceStub,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

// The sidecar restarts `token_index` (sent as `chat.token.sequence`) at 1 for
// every generation. The in-band tool round follows its tools with a
// `chat.stream_reset` (reason `tool_continuation`) that resets the managed
// runtime's sequence gate, but the approval-resume path
// (`resume_before_tool_dispatch`) continues into the next generation without
// one. The gate must therefore be closed by the tool-boundary segment persist
// itself, or the continuation's restarted sequences are dropped as replays:
// nothing streams to the renderer and chat.done's authoritative text has to
// repair the transcript (seen live 2026-09-15 after an approved exit_plan_mode).
async function runTurn({ withStreamReset }) {
  const service = createManagedChatServiceStub({
    featureFlags: {
      canonical_bridge: true,
      canonical_turn_events: true,
      response_loop_display_v2: true,
    },
  });
  service.sidecarClient = {
    chatSend: async (_params, options = {}) => {
      const notify = (method, params) => options.onNotification({ method, params });
      notify('chat.token', { delta: 'Plan text one. ', sequence: 1 });
      notify('chat.token', { delta: 'Plan text two.', sequence: 2 });
      notify('tool.executing', {
        tool_call_id: 'call_exit_plan',
        tool_name: 'exit_plan_mode',
        arguments: {},
      });
      notify('tool.result', {
        tool_call_id: 'call_exit_plan',
        tool_name: 'exit_plan_mode',
        success: true,
        content: 'Plan approved.',
      });
      if (withStreamReset) {
        notify('chat.stream_reset', { reason: 'tool_continuation' });
      }
      notify('chat.token', { delta: 'Final answer one. ', sequence: 1 });
      notify('chat.token', { delta: 'Final answer two.', sequence: 2 });
      notify('chat.done', {
        stop_reason: 'end_turn',
        response_text: 'Final answer one. Final answer two.',
        completion_source: 'model',
      });
      return {
        status: 'completed',
        response_text: 'Final answer one. Final answer two.',
        completion_source: 'model',
      };
    },
  };

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'session_tool_boundary_sequence_gate',
    prompt: 'Plan, then continue',
    visiblePrompt: 'Plan, then continue',
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

  const forwardedDeltas = service.emittedEvents
    .filter((entry) => entry?.payload?.type === 'delta')
    .map((entry) => entry.payload.content);
  const mismatchLogs = service.serviceLogs.filter(
    (entry) => entry.event === 'chat.terminal_response_text_mismatch'
  );
  const assistantContents = service.sessionMessages
    .filter((message) => message.role === 'assistant' && message.id.includes('_seg'))
    .map((message) => message.content);
  return { forwardedDeltas, mismatchLogs, assistantContents };
}

const EXPECTED_DELTAS = [
  'Plan text one. ',
  'Plan text two.',
  'Final answer one. ',
  'Final answer two.',
];
const EXPECTED_SEGMENTS = [
  'Plan text one. Plan text two.',
  'Final answer one. Final answer two.',
];

test('restarted token sequences after a tool boundary stream without a sidecar stream reset', async () => {
  const outcome = await runTurn({ withStreamReset: false });
  assert.deepEqual(outcome.forwardedDeltas, EXPECTED_DELTAS);
  assert.equal(outcome.mismatchLogs.length, 0);
  assert.deepEqual(outcome.assistantContents, EXPECTED_SEGMENTS);
});

test('the sidecar tool_continuation reset keeps streaming every delta as before', async () => {
  const outcome = await runTurn({ withStreamReset: true });
  assert.deepEqual(outcome.forwardedDeltas, EXPECTED_DELTAS);
  assert.equal(outcome.mismatchLogs.length, 0);
  assert.deepEqual(outcome.assistantContents, EXPECTED_SEGMENTS);
});
