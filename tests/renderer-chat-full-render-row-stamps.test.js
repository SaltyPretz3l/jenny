'use strict';

// timeline-perf (2026-10-04): the first reasoning delta of every new segment
// of a managed turn charges a whole-timeline render (missing_streaming_article),
// and that morph used to strip every row's reconcile stamp. The next
// structural write of the live turn (a tool gap, a phase completing) then
// re-morphed every settled row of the turn: on a 36-iteration turn that was
// 2,757 rows re-morphed. The full render now reconciles the active turn's row
// list per row, so the rows it wrote stay stamped and the next write is warm.
// Observable contract: after a full render, a settled row is not re-written by
// the next active-turn write (a mark placed on it survives; a re-morph strips
// it), while the new rows still paint.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');

const SESSION_ID = 'sess_full_render_row_stamps';
const STREAM_ID = 'stream_full_render_row_stamps';

function reasoningPhase(iteration) {
  return {
    phase_id: `phase_reasoning_${STREAM_ID}_iter${iteration}_1`,
    phase_kind: 'reasoning',
    thinking_id: `think_${STREAM_ID}_iter${iteration}`,
    iteration,
    summary: 'Reasoning through the turn',
  };
}

function reasoningPhaseEvent(type, iteration) {
  const phase = reasoningPhase(iteration);
  return { type, phaseId: phase.phase_id, phaseKind: 'reasoning', thinkingId: phase.thinking_id, iteration, summary: phase.summary, phase };
}

function reasoningDelta(iteration, text) {
  const phase = reasoningPhase(iteration);
  return {
    type: 'delta', content: '', channel: 'reasoning', thinkingId: phase.thinking_id, phase,
    reasoning: { source: 'provider', entriesDelta: [{ id: `reasoning_${iteration}`, text }] },
  };
}

function pendingToolUse(callId) {
  return { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: callId }, status: 'pending' };
}

function toolCallEvents(iteration, callId) {
  const usePhase = { type: 'phase_started', phaseId: `phase_tool_use_${STREAM_ID}_${callId}`, phaseKind: 'tool_use', toolCallId: callId, toolName: 'read_file' };
  const resultPhase = { type: 'phase_started', phaseId: `phase_tool_result_${STREAM_ID}_${callId}`, phaseKind: 'tool_result', toolCallId: callId, toolName: 'read_file' };
  return [
    usePhase,
    { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: callId }, status: 'running',
      next_assistant_message_id: `assistant_${STREAM_ID}_seg${iteration}` },
    { ...usePhase, type: 'phase_completed' },
    resultPhase,
    { type: 'tool_result', callId, toolName: 'read_file', status: 'success', content: `contents of ${callId}`, isError: false },
    { ...resultPhase, type: 'phase_completed' },
  ];
}

test('timeline-perf: a full render leaves the active turn rows stamped, so the next write keeps settled rows', async (t) => {
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: { ...buildFeatureFlagDefaults(), chat_timeline_render_telemetry: true } } },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: SESSION_ID, title: 'full render row stamps', conversation_mode: 'chat', preferred_model: 'gpt-test',
          updated_at: new Date().toISOString(), linked_session_ids: [],
          context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
        state.messagesBySession.set(SESSION_ID, []);
        return { sessionId: SESSION_ID, streamId: STREAM_ID };
      },
    },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const document = window.document;
  const metrics = window.rendererStreamClientMetricsModule.getShared();
  const emit = async (payload, settleMs = 10) => {
    await shell.__emitChat({ sessionId: SESSION_ID, streamId: STREAM_ID, ...payload });
    await waitForUi(window, settleMs);
  };

  const input = document.getElementById('chatInput');
  input.value = 'read the sources';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('sendButton').click();
  await waitForUi(window, 30);
  await emit({ type: 'started' });
  for (let iteration = 1; iteration <= 2; iteration += 1) {
    await emit(reasoningPhaseEvent('phase_started', iteration));
    await emit(reasoningDelta(iteration, `Planning step ${iteration}.`));
    await emit(reasoningPhaseEvent('phase_completed', iteration));
    const calls = [`call_${iteration}_a`, `call_${iteration}_b`];
    for (const callId of calls) await emit(pendingToolUse(callId));
    for (const callId of calls) {
      for (const payload of toolCallEvents(iteration, callId)) await emit(payload);
    }
    await waitForUi(window, 30);
  }

  // The new segment's first delta renders the whole timeline.
  await emit(reasoningPhaseEvent('phase_started', 3));
  metrics.take(STREAM_ID);
  await emit(reasoningDelta(3, 'Planning step 3.'), 40);
  const fullRender = metrics.take(STREAM_ID) || {};
  assert.ok((fullRender.full_renders || 0) >= 1, `precondition: the segment's first delta is a full render (${JSON.stringify(fullRender.full_render_reasons)})`);

  const settledTool = document.querySelector('.chat-row[data-row-kind="tool_call"]');
  const settledReasoning = document.querySelector('.chat-row[data-row-kind="reasoning"]');
  assert.ok(settledTool && settledReasoning, 'the earlier iterations rendered as rows');
  settledTool.setAttribute('data-test-mark', 'kept');
  settledReasoning.setAttribute('data-test-mark', 'kept');
  const toolRowsBefore = document.querySelectorAll('.chat-row[data-row-kind="tool_call"]').length;

  await emit(reasoningPhaseEvent('phase_completed', 3), 40);
  await emit(pendingToolUse('call_3_a'), 60);
  await waitForUi(window, 60);
  const after = metrics.take(STREAM_ID) || {};

  assert.equal(after.full_renders || 0, 0, `the writes after the full render are narrow: ${JSON.stringify(after.full_render_reasons)}`);
  assert.equal(document.querySelectorAll('.chat-row[data-row-kind="tool_call"]').length, toolRowsBefore + 1, 'the new tool row is painted');
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="tool_call"]'), settledTool, 'a settled tool row keeps its node');
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="reasoning"]'), settledReasoning, 'a settled reasoning row keeps its node');
  assert.equal(settledTool.getAttribute('data-test-mark'), 'kept', 'a settled tool row is not re-morphed after the full render');
  assert.equal(settledReasoning.getAttribute('data-test-mark'), 'kept', 'a settled reasoning row is not re-morphed after the full render');

  await emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' }, 80);
});
