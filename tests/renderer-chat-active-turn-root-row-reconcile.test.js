'use strict';

// timeline-perf (2026-10-04): between a live turn's stream segments (tool
// gaps: tool_use pending/running, tool_result) there is no streaming message,
// so every structural event repaints through the active-turn-root lane
// (tryPatchActiveTurnRoot -> patchActiveTurnRoot). That lane re-morphed every
// node of every settled row of the turn on each event: quadratic in turn
// length (74 s of the 146 s long-turn test). It now reconciles the turn row
// list per row, so a settled row whose markup is unchanged is not visited.
// Observable contract: a gap event still repaints through the active-root
// lane and paints the new row, while a settled row is the same node and is
// not re-written (a mark placed on it survives; a re-morph strips it).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');

const SESSION_ID = 'sess_active_root_reconcile';
const STREAM_ID = 'stream_active_root_reconcile';

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

function pendingToolUse(callId) {
  return { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: callId }, status: 'pending' };
}

function activeRootRebuilds(window) {
  const meta = window.__rendererState.ui.chatTimelineRowModelMetaBySession?.get(SESSION_ID);
  return Number(meta?.telemetry_counters?.active_turn_root_rebuild || 0);
}

test('timeline-perf: a tool-gap repaint of the active turn root leaves settled rows unvisited', async (t) => {
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: { ...buildFeatureFlagDefaults(), chat_timeline_render_telemetry: true } } },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: SESSION_ID, title: 'active root reconcile', conversation_mode: 'chat', preferred_model: 'gpt-test',
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
  for (let iteration = 1; iteration <= 3; iteration += 1) {
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

  // A tool gap: the first pending call repaints the turn root (and leaves every
  // row it wrote reconciled), the second is the write under test.
  await emit(pendingToolUse('call_4_a'), 40);
  const settledTool = document.querySelector('.chat-row[data-row-kind="tool_call"]');
  const settledReasoning = document.querySelector('.chat-row[data-row-kind="reasoning"]');
  assert.ok(settledTool && settledReasoning, 'the earlier iterations rendered as rows');
  const toolRowsBefore = document.querySelectorAll('.chat-row[data-row-kind="tool_call"]').length;
  settledTool.setAttribute('data-test-mark', 'kept');
  settledReasoning.setAttribute('data-test-mark', 'kept');
  const rebuildsBefore = activeRootRebuilds(window);

  await emit(pendingToolUse('call_4_b'), 60);
  await waitForUi(window, 60);

  assert.ok(activeRootRebuilds(window) > rebuildsBefore, 'the gap event repaints through the active-turn-root lane');
  assert.equal(document.querySelectorAll('.chat-row[data-row-kind="tool_call"]').length, toolRowsBefore + 1, 'the new tool row is painted');
  assert.match(document.querySelector('[data-turn-row-list="true"][data-turn-live="true"]')?.textContent || '', /call_4_b/,
    'the new call is in the live turn row list');
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="tool_call"]'), settledTool, 'a settled tool row keeps its node');
  assert.strictEqual(document.querySelector('.chat-row[data-row-kind="reasoning"]'), settledReasoning, 'a settled reasoning row keeps its node');
  assert.equal(settledTool.getAttribute('data-test-mark'), 'kept', 'an unchanged settled tool row is not re-morphed');
  assert.equal(settledReasoning.getAttribute('data-test-mark'), 'kept', 'an unchanged settled reasoning row is not re-morphed');

  await emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' }, 80);
});
