'use strict';

// Row 101 Phase 2 live box, found in the real app (2026-11-02): a reasoning
// phase that settles while its turn is still in flight stays open, and the
// gap until the next phase repaints through the active-turn-root lane
// (no streaming message). That lane rebuilt the reasoning body without the
// box marker and never re-synced the follow module, so a long phase un-capped
// for the whole gap and grew the timeline by its full height in one frame.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');

const SESSION_ID = 'sess_live_box_turn_gap';
const STREAM_ID = 'stream_live_box_turn_gap';

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
    type: 'delta', content: '', aggregate: '', channel: 'reasoning', thinkingId: phase.thinking_id, phase,
    reasoning: { source: 'provider', entriesDelta: [{ id: `reasoning_${iteration}_${text.length}`, text, timestamp: '2026-11-02T00:00:00Z' }] },
  };
}

function pendingToolUse(callId) {
  return { type: 'tool_use', callId, toolName: 'read_file', summary: 'read_file', input: { path: callId }, status: 'pending' };
}

function activeRootRebuilds(window) {
  const meta = window.__rendererState.ui.chatTimelineRowModelMetaBySession?.get(SESSION_ID);
  return Number(meta?.telemetry_counters?.active_turn_root_rebuild || 0);
}

async function waitFor(window, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await waitForUi(window, 20);
  return predicate();
}

function describeBodies(document) {
  return Array.from(document.querySelectorAll('.reasoning-row-panel-body')).map((body) => ({
    status: body.closest('.reasoning-row-block')?.getAttribute('data-reasoning-status'),
    panel: body.closest('.reasoning-row-panel')?.className,
    hidden: body.closest('.reasoning-row-panel')?.hidden,
    marker: body.getAttribute('data-live-box'),
    article: body.closest('.chat-entry')?.className,
  }));
}

test('live box: a settled open phase stays marked through an active-turn-root repaint while the turn is in flight', async (t) => {
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: { ...buildFeatureFlagDefaults(), reasoning_live_box: true } } },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: SESSION_ID, title: 'live box turn gap', conversation_mode: 'chat', preferred_model: 'gpt-test',
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
  input.value = 'think, then read';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('sendButton').click();
  await waitForUi(window, 30);
  await emit({ type: 'started' });
  await emit(reasoningPhaseEvent('phase_started', 1));
  await emit(reasoningDelta(1, 'Planning the first step in some detail.'), 30);
  await emit(reasoningDelta(1, 'Then weighing the second step.'), 30);
  const marked = () => document.querySelector('.reasoning-row-panel-body')?.getAttribute('data-live-box') === 'true';
  assert.ok(await waitFor(window, marked), `streaming body is a live box: ${JSON.stringify(describeBodies(document))}`);

  await emit(reasoningPhaseEvent('phase_completed', 1), 30);
  const rebuildsBefore = activeRootRebuilds(window);
  await emit(pendingToolUse('call_gap_a'), 40);
  await emit(pendingToolUse('call_gap_b'), 60);
  await waitFor(window, () => activeRootRebuilds(window) > rebuildsBefore);
  await waitForUi(window, 60);

  const state = describeBodies(document);
  assert.ok(activeRootRebuilds(window) > rebuildsBefore, `the gap repaints through the active-turn-root lane: ${JSON.stringify(state)}`);
  const openSettled = Array.from(document.querySelectorAll('.reasoning-row-panel-body')).filter((body) => {
    const panel = body.closest('.reasoning-row-panel');
    return panel?.classList.contains('expanded') && !panel.hidden
      && body.closest('.reasoning-row-block')?.getAttribute('data-reasoning-status') !== 'streaming';
  });
  assert.ok(openSettled.length > 0, `the settled phase stays open in the gap: ${JSON.stringify(state)}`);
  const { capturePatchState } = window.rendererReasoningLiveBoxFollow;
  for (const body of openSettled) {
    assert.equal(body.getAttribute('data-live-box'), 'true', `settled open phase keeps the cap: ${JSON.stringify(state)}`);
    // Held, not a marker cloned off the old node that nothing would ever clear.
    assert.notEqual(capturePatchState(body), null, 'the rebuilt settled body is held by the follow module');
  }

  await emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' }, 80);
  await waitFor(window, () => !document.querySelector('.chat-entry.pending'));
  await waitForUi(window, 60);
  assert.equal(document.querySelectorAll('[data-live-box="true"]').length, 0, `a finished turn holds no live box: ${JSON.stringify(describeBodies(document))}`);
});
