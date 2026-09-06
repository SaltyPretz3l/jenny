// Thinking-budget checkpoint reasoning-row regression pin (RCA 2026-09-02).
//
// Symptom: when a checkpoint continuation opened a second reasoning phase in
// the same assistant message, the first row kept its streaming shimmer and
// "Thinking" label. Two live tails then fought scroll-follow and flickered.
//
// The phase handler recorded only completed: true, but message normalization
// derives completion from completedAt. Because the legacy transcript path also
// backfills startedAt, the normalized first phase remained incomplete until
// visible answer text arrived. This replay pins settlement before any answer.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function buildSession(sessionId) {
  return {
    id: sessionId,
    title: `Session ${sessionId}`,
    session_type: 'chat',
    conversation_mode: 'chat',
    preferred_model: 'gpt-test',
    reasoning_effort: 'default',
    plan_mode: false,
    pinned: false,
    archived_at: null,
    context_preferences: {
      history_scope: 'session',
      include_personality: true,
      include_memory: true,
    },
    linked_session_ids: [],
    interactive_round_count: 0,
    interactive_sequence_state: 'idle',
    pending_question_batch: null,
    updated_at: new Date().toISOString(),
  };
}

function makeStartStreamShell(sessionId, streamId) {
  return {
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [buildSession(sessionId)];
        state.messagesBySession.set(sessionId, []);
        return { sessionId, streamId };
      },
    },
  };
}

test('a checkpoint continuation settles the prior reasoning row before opening another live tail', async (t) => {
  const sessionId = 'session-checkpoint-reasoning-settle';
  const streamId = 'stream-checkpoint-reasoning-settle';
  const app = await loadRendererApp({ shell: makeStartStreamShell(sessionId, streamId) });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const doc = window.document;

  doc.getElementById('chatInput').value = 'checkpoint reasoning settle probe';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);

  const emit = (payload) => shell.__emitChat({ sessionId, streamId, ...payload });
  const phase1 = {
    phaseId: `phase_reasoning_${streamId}_iter1_1`, thinkingId: `think_${streamId}_iter1`,
    iteration: 1, summary: 'Reasoning through the turn',
  };
  const phase2 = {
    phaseId: `phase_reasoning_${streamId}_iter2_1`, thinkingId: `think_${streamId}_iter2`,
    iteration: 2, summary: 'Continuing after thinking-budget checkpoint 1',
  };
  const phaseEvent = (type, meta) => ({
    type, phaseId: meta.phaseId, phaseKind: 'reasoning', iteration: meta.iteration,
    thinkingId: meta.thinkingId, summary: meta.summary, channel: 'phase',
    phase: {
      phase_id: meta.phaseId, phase_kind: 'reasoning', thinking_id: meta.thinkingId,
      summary: meta.summary, iteration: meta.iteration,
    },
  });
  async function emitReasoningDeltas(meta, id) {
    let text = '';
    for (let index = 1; index <= 12; index += 1) {
      text += `Reasoning step ${index}. `;
      await emit({
        type: 'delta', content: '', aggregate: '', channel: 'reasoning',
        phase: {
          phase_id: meta.phaseId, phase_kind: 'reasoning',
          thinking_id: meta.thinkingId, summary: meta.summary, iteration: meta.iteration,
        },
        reasoning: {
          source: 'provider',
          entriesDelta: [{ id, text, thinking_id: meta.thinkingId, created_at: new Date().toISOString() }],
        },
      });
      await waitForUi(window, 15);
    }
  }

  await emit({ type: 'started' });
  await emit(phaseEvent('phase_started', phase1));
  await waitForUi(window, 60);
  await emitReasoningDeltas(phase1, 'r1');
  await emit(phaseEvent('phase_completed', phase1));
  await waitForUi(window, 60);

  const blocksA = doc.querySelectorAll('[data-reasoning-status]');
  assert.equal(blocksA.length, 1, 'phase 1 must be the only reasoning row before phase 2 opens');
  const firstA = blocksA[0];
  assert.equal(firstA.getAttribute('data-thinking-id'), phase1.thinkingId, 'the sole row must belong to phase 1');
  assert.equal(firstA.getAttribute('data-reasoning-status'), 'complete', 'phase 1 must settle to complete when its phase_completed lands, even with no visible text yet');
  assert.equal(firstA.hasAttribute('data-reasoning-live-tail'), false, 'phase 1 must stop being the live tail when its phase_completed lands');
  const headerA = firstA.querySelector('.reasoning-row-header').textContent;
  assert.equal(headerA.includes('Thought'), true, 'the settled phase 1 header must say Thought');
  assert.equal(headerA.includes('Thinking'), false, 'the settled phase 1 header must no longer say Thinking');
  assert.equal(doc.querySelectorAll('[data-reasoning-live-tail="true"]').length, 0, 'no reasoning row may remain live between checkpoint phases');

  await emit(phaseEvent('phase_started', phase2));
  await waitForUi(window, 60);
  await emitReasoningDeltas(phase2, 'r2');

  const blocksB = doc.querySelectorAll('[data-reasoning-status]');
  assert.equal(blocksB.length, 2, 'checkpoint continuation must render both reasoning phases');
  const firstB = Array.from(blocksB).find((block) => block.getAttribute('data-thinking-id') === phase1.thinkingId);
  const secondB = Array.from(blocksB).find((block) => block.getAttribute('data-thinking-id') === phase2.thinkingId);
  assert.equal(firstB?.getAttribute('data-reasoning-status'), 'complete', 'phase 1 must stay complete while phase 2 streams');
  assert.equal(firstB?.hasAttribute('data-reasoning-live-tail'), false, 'phase 1 must not regain the live tail while phase 2 streams');
  assert.equal(secondB?.getAttribute('data-reasoning-status'), 'streaming', 'phase 2 must own the streaming reasoning status');
  assert.equal(secondB?.getAttribute('data-reasoning-live-tail'), 'true', 'phase 2 must own the live-tail marker');
  const liveTails = doc.querySelectorAll('[data-reasoning-live-tail="true"]');
  assert.equal(liveTails.length, 1, 'a checkpoint continuation must never leave two reasoning live tails');
  assert.equal(liveTails[0].getAttribute('data-thinking-id'), phase2.thinkingId, 'the single live tail must belong to phase 2');

  await emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' });
  await waitForUi(window, 120);
});
