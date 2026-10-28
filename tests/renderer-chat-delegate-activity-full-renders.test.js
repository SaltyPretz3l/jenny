'use strict';

// A running delegate streams agent_status frames (start, per-child running
// frames carrying live childActivity, settled) through the tool gap before the
// next segment has any text. Each frame lands on the next segment's empty
// shell, which became derived.streamingMessage while projecting no row, so the
// renderer's signature-hold branch found no article and repainted the whole
// timeline once per frame: a 2026-10-19 live turn with one 49 s delegate call
// recorded 80 missing_streaming_article full renders over 7 segments (a turn
// without a delegate charges one per segment). Contract: the frames take the
// active-turn-root patch, a segment's birth keeps its one full render, the
// delegate row still repaints live, and no article keeps a predicted
// min-height once the frames settle.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');

const SESSION_ID = 'sess_delegate_activity_renders';
const CALL = 'call_delegate_activity';
const SEGMENTS = 2;

function reasoningPhase(streamId, iteration) {
  return {
    phase_id: `phase_reasoning_${streamId}_iter${iteration}_1`, phase_kind: 'reasoning',
    thinking_id: `think_${streamId}_iter${iteration}`, iteration, summary: 'Reasoning through the turn',
  };
}

function reasoningPhaseEvent(streamId, type, iteration) {
  const phase = reasoningPhase(streamId, iteration);
  return { type, phaseId: phase.phase_id, phaseKind: 'reasoning', thinkingId: phase.thinking_id, iteration, summary: phase.summary, phase };
}

function reasoningDelta(streamId, iteration, text) {
  const phase = reasoningPhase(streamId, iteration);
  return {
    type: 'delta', content: '', channel: 'reasoning', thinkingId: phase.thinking_id, phase,
    reasoning: { source: 'provider', entriesDelta: [{ id: `reasoning_${iteration}`, text }] },
  };
}

// Frame shapes mirror sidecar/ai/routing/delegate.py after Electron's camelCase
// normalization (see renderer-subagent-live-delegate-row.test.js).
function delegateFrames(streamId) {
  const base = { type: 'agent_status', taskType: 'sub_agent', source: 'delegate', taskId: `delegate:request:${CALL}`, toolCallId: CALL, parentAgentId: `main@${streamId}` };
  const child = {
    ...base, childTaskId: `delegate:request:${CALL}:task:1`, childAgentId: `research@${streamId}:${CALL}:1`,
    childOrdinal: 1, childCount: 1, childLabel: 'Task 1',
  };
  const usePhase = { type: 'phase_started', phaseId: `phase_tool_use_${streamId}_${CALL}`, phaseKind: 'tool_use', toolCallId: CALL, toolName: 'delegate' };
  const resultPhase = { type: 'phase_started', phaseId: `phase_tool_result_${streamId}_${CALL}`, phaseKind: 'tool_result', toolCallId: CALL, toolName: 'delegate' };
  const input = { tasks: ['Survey the repo'] };
  return {
    toolUse: [
      { type: 'tool_use', callId: CALL, toolName: 'delegate', summary: 'delegate', input, status: 'pending' },
      usePhase,
      { type: 'tool_use', callId: CALL, toolName: 'delegate', summary: 'delegate', input, status: 'running',
        next_assistant_message_id: `assistant_${streamId}_seg1` },
      { ...usePhase, type: 'phase_completed' },
    ],
    start: { ...base, status: 'running', stage: 'start', percent: 5, summary: 'Starting read-only delegation with 1 task(s).' },
    running: { ...child, status: 'running', stage: 'task_1_running', percent: 0, summary: 'Task 1/1 running.' },
    activity: (sequence) => ({
      ...child, status: 'running', stage: 'task_1_running', percent: 0, summary: 'Task 1/1 running.',
      usage: { input_tokens: 100 * sequence, output_tokens: 10 * sequence, total_tokens: 110 * sequence },
      childActivity: { sequence, steps: [{ tool: 'read_file', display: 'Read', status: 'running' }], step_count: sequence,
        text: `Checking file ${sequence}.`, visible_output_tokens_estimate: sequence },
    }),
    settled: { ...child, status: 'completed', stage: 'task_1_completed', percent: 100, summary: 'Task 1/1 completed.',
      childTerminal: true, childSuccess: true, terminalReason: 'completed' },
    toolResult: [
      resultPhase,
      { type: 'tool_result', callId: CALL, toolName: 'delegate', status: 'success', content: '{"status":"completed"}', isError: false },
      { ...resultPhase, type: 'phase_completed' },
    ],
  };
}

async function runDelegateTurn(t, streamId, activityFrames) {
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: { ...buildFeatureFlagDefaults() } } },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: SESSION_ID, title: 'delegate activity', conversation_mode: 'chat', preferred_model: 'gpt-test',
          updated_at: new Date().toISOString(), linked_session_ids: [],
          context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
        state.messagesBySession.set(SESSION_ID, []);
        return { sessionId: SESSION_ID, streamId };
      },
    },
  } });
  t.after(() => app.dispose());
  const { window, shell } = app;
  const document = window.document;
  const timeline = document.getElementById('chatTimeline');
  const metrics = window.rendererStreamClientMetricsModule.getShared();
  const emit = async (payload, settleMs = 10) => {
    await shell.__emitChat({ sessionId: SESSION_ID, streamId, requestId: streamId, ...payload });
    await waitForUi(window, settleMs);
  };
  const liveMeta = () => timeline.querySelector('[data-subagent-open][data-subagent-source="live"] .subagent-summary-meta')?.textContent || '';
  // Stream writes paint on batched frames, which a loaded machine can push past
  // any fixed settle; wait for the state itself (bounded) before reading it.
  const waitFor = async (done, budgetMs) => {
    const deadline = Date.now() + budgetMs;
    while (!done() && Date.now() < deadline) await waitForUi(window, 10);
  };
  const minHeightArticles = () => [...timeline.querySelectorAll('.chat-entry')]
    .filter((article) => article.style.minHeight)
    .map((article) => article.getAttribute('data-message-id'));

  const input = document.getElementById('chatInput');
  input.value = 'survey with a subagent';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('sendButton').click();
  await waitForUi(window, 30);
  const frames = delegateFrames(streamId);
  await emit({ type: 'started' });
  await emit(reasoningPhaseEvent(streamId, 'phase_started', 0));
  await emit(reasoningDelta(streamId, 0, 'Planning the delegation.'));
  await emit(reasoningPhaseEvent(streamId, 'phase_completed', 0));
  for (const payload of frames.toolUse) await emit(payload);
  const turnArticleSelector = `.chat-entry[data-message-id="assistant_${streamId}"]`;
  await waitFor(() => timeline.querySelector(turnArticleSelector), 2000);
  const turnArticle = timeline.querySelector(`.chat-entry[data-message-id="assistant_${streamId}"]`);
  assert.ok(turnArticle, 'precondition: the turn article is on screen before the delegate runs');

  await emit(frames.start, 20);
  await emit(frames.running, 20);
  for (let sequence = 1; sequence <= activityFrames; sequence += 1) {
    await emit(frames.activity(sequence), 20);
  }
  await waitFor(() => liveMeta(), 2000);
  const runningMeta = liveMeta();
  await emit(frames.settled, 20);
  await waitFor(() => liveMeta() && liveMeta() !== runningMeta, 2000);
  const settledMeta = liveMeta();
  // The pretext predicted-height test's budget for the cleanup rAF/backstop.
  await waitFor(() => !minHeightArticles().length, 1200);
  const leftoverMinHeight = minHeightArticles();

  for (const payload of frames.toolResult) await emit(payload);
  await waitForUi(window, 30);
  await emit(reasoningPhaseEvent(streamId, 'phase_started', 1));
  await emit(reasoningDelta(streamId, 1, 'Reading the report.'));
  await emit(reasoningPhaseEvent(streamId, 'phase_completed', 1));
  await emit({ type: 'delta', content: 'The survey is done.', aggregate: 'The survey is done.' }, 0);
  await waitFor(() => timeline.textContent.includes('The survey is done.'), 5000);
  const answerPainted = timeline.textContent.includes('The survey is done.');
  const turn = metrics.take(streamId) || {};
  await emit({ type: 'complete', content: 'The survey is done.', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' }, 80);
  return {
    reasons: turn.full_render_reasons || {},
    runningMeta,
    settledMeta,
    minHeightArticles: leftoverMinHeight,
    answerPainted,
    turnArticleKept: timeline.querySelector(`.chat-entry[data-message-id="assistant_${streamId}"]`) === turnArticle,
  };
}

test('timeline-perf: a running delegate\'s live frames patch the turn root instead of charging a full render each', async (t) => {
  const control = await runDelegateTurn(t, 'stream_delegate_activity_off', 0);
  const live = await runDelegateTurn(t, 'stream_delegate_activity_on', 12);

  for (const [label, run] of [['control', control], ['live activity', live]]) {
    const missing = run.reasons.missing_streaming_article || 0;
    assert.ok(missing <= SEGMENTS, `${label}: at most one missing_streaming_article per segment (${JSON.stringify(run.reasons)})`);
    const fullRenders = Object.values(run.reasons).reduce((sum, count) => sum + (Number(count) || 0), 0);
    assert.ok(fullRenders <= SEGMENTS, `${label}: the frames fall to no other full-render reason either (${JSON.stringify(run.reasons)})`);
    assert.deepEqual(run.minHeightArticles, [], `${label}: no article keeps a predicted min-height after the frames settle`);
    assert.ok(run.answerPainted, `${label}: the next segment's answer paints`);
    assert.ok(run.turnArticleKept, `${label}: the turn article keeps its node through the delegate`);
  }
  assert.ok(live.runningMeta, 'the delegate row shows its live summary while the child runs');
  assert.notEqual(live.settledMeta, live.runningMeta, 'the delegate row repaints when the child settles');
});
