// Live-streaming repaint regression pins (streaming-flicker RCA 2026-07-06).
//
// Three cooperating defects made a live multi-tool turn stall or flicker:
//  1. computeDerivedMessageState dropped the streaming target whenever a
//     tool_use/tool_result message trailed the live segment, so post-tool
//     deltas stopped patching until the turn completed.
//  2. Mid-stream persisted-events hydration re-projected the ACTIVE turn's
//     running tool as 'interrupted' (clock icon flash) — signal
//     interrupted_running_tool_hydration fired mid-turn.
//  3. At complete, live rows whose identity keys drifted from their hydrated
//     counterparts (reasoning thinkingId vs sidecar phase_id) were deleted and
//     re-inserted under new row ids — signal stale_row_deletion, visible blink.
//
// Conventions mirrored from tests/renderer-chat-content-visibility.test.js
// (loadRendererApp + shell.__emitChat replay) and tests/renderer-turn-reducer.test.js
// (pure reconcile fixtures).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeDerivedMessageState } = require('../renderer/chat/renderer-message-index-utils');
const { reconcileTurnRows } = require('../renderer/chat/renderer-turn-reducer');
const {
  loadRendererApp,
  waitForUi,
} = require('./helpers/renderer-shell-harness');

/* ── A. computeDerivedMessageState: streaming target survives tool plumbing ── */

function buildStreamingSegmentTranscript(trailingMessages = []) {
  return [
    { id: 'user_1', role: 'user', kind: '', status: 'complete', content: 'hi' },
    {
      id: 'assistant_stream-x',
      role: 'assistant',
      kind: '',
      status: 'complete',
      content: '',
      finalizedAt: '2026-07-06T00:00:00.000Z',
    },
    { id: 'tool_use_stream-x_c1', role: 'assistant', kind: 'tool_use', status: 'complete', content: 'Run tool' },
    {
      id: 'assistant_stream-x_seg1',
      role: 'assistant',
      kind: '',
      status: 'streaming',
      content: 'Post-tool text',
    },
    ...trailingMessages,
  ];
}

test('computeDerivedMessageState: a tool_use message trailing the live segment does not strand the streaming target', () => {
  // Regression: a second tool starting while seg1 still streams appends a
  // tool_use AFTER the segment; the old `id === latestAssistantMessageId`
  // gate then returned streamingMessage=null and delta patching stalled.
  const messages = buildStreamingSegmentTranscript([
    { id: 'tool_use_stream-x_c2', role: 'assistant', kind: 'tool_use', status: 'complete', content: 'Run tool 2' },
  ]);
  const derived = computeDerivedMessageState(messages);
  assert.equal(derived.streamingMessage?.id, 'assistant_stream-x_seg1');
});

test('computeDerivedMessageState: a tool_result message trailing the live segment does not strand the streaming target', () => {
  const messages = buildStreamingSegmentTranscript([
    { id: 'tool_result_stream-x_c1', role: 'assistant', kind: 'tool_result', status: 'complete', content: 'ok' },
  ]);
  const derived = computeDerivedMessageState(messages);
  assert.equal(derived.streamingMessage?.id, 'assistant_stream-x_seg1');
});

test('computeDerivedMessageState: a NON-tool assistant message after the segment still wins the streaming slot check (no over-reach)', () => {
  // A newer plain assistant message means the "streaming" mid-transcript
  // message is a remnant, not the live tail — it must NOT be adopted.
  const messages = buildStreamingSegmentTranscript([
    { id: 'assistant_newer', role: 'assistant', kind: '', status: 'complete', content: 'newer' },
  ]);
  const derived = computeDerivedMessageState(messages);
  assert.equal(derived.streamingMessage, null);
});

/* ── B. reconcileTurnRows: terminal handoff without delete-then-reinsert ── */

function buildReasoningRow(rowId, phaseId, extra = {}) {
  return {
    row_id: rowId,
    turn_id: 'stream-x',
    kind: 'reasoning',
    primary_message_id: 'assistant_stream-x',
    phase_id: phaseId,
    payload: { phase_id: phaseId, entries: [{ text: 'thinking' }] },
    ...extra,
  };
}

test('reconcileTurnRows: identity-drifted reasoning rows pair by kind and adopt the provisional row_id (no stale deletion)', () => {
  // Live reasoning rows are keyed by the delta's thinkingId while the
  // hydrated counterpart carries the sidecar phase_id — the old exact-key
  // reconcile deleted the live row and inserted a new-identity hydrated row
  // (a visible blink at complete).
  const provisionalRows = [
    buildReasoningRow('row:live-reasoning-1', 'thinking-r1'),
    buildReasoningRow('row:live-reasoning-2', 'thinking-r2'),
  ];
  const hydratedRows = [
    buildReasoningRow('row:hydrated-reasoning-1', 'phase-a'),
    buildReasoningRow('row:hydrated-reasoning-2', 'phase-b'),
  ];
  const result = reconcileTurnRows(provisionalRows, hydratedRows);
  assert.deepEqual(result.staleRows, [], 'no live row may be deleted when a same-kind hydrated row exists');
  assert.equal(result.finalRows.length, 2);
  assert.equal(result.finalRows[0].row_id, 'row:live-reasoning-1');
  assert.equal(result.finalRows[1].row_id, 'row:live-reasoning-2');
  // Hydrated payloads still win for matched rows.
  assert.equal(result.finalRows[0].phase_id, 'phase-a');
});

test('reconcileTurnRows: kind-order pairing never crosses tool_call_id boundaries', () => {
  const provisionalRows = [
    {
      row_id: 'row:live-tool-b',
      turn_id: 'stream-x',
      kind: 'tool_call',
      primary_message_id: 'tool_use_b',
      tool_call_id: 'call-b',
      payload: { tool_call_id: 'call-b', state: 'running' },
    },
  ];
  const hydratedRows = [
    {
      row_id: 'row:hydrated-tool-a',
      turn_id: 'stream-x',
      kind: 'tool_call',
      primary_message_id: 'tool_use_a',
      tool_call_id: 'call-a',
      payload: { tool_call_id: 'call-a', state: 'completed' },
    },
  ];
  const result = reconcileTurnRows(provisionalRows, hydratedRows);
  assert.equal(result.finalRows[0].row_id, 'row:hydrated-tool-a', 'different call ids must not pair');
  assert.equal(result.staleRows.length, 1);
});

test('reconcileTurnRows: a SETTLED provisional tool state is not downgraded by a lagging hydrated "interrupted"', () => {
  const provisionalRows = [
    {
      row_id: 'row:live-tool',
      turn_id: 'stream-x',
      kind: 'tool_call',
      primary_message_id: 'tool_use_c1',
      tool_call_id: 'c1',
      payload: { tool_call_id: 'c1', state: 'completed', summary: 'Done' },
    },
  ];
  const hydratedRows = [
    {
      row_id: 'row:hydrated-tool',
      turn_id: 'stream-x',
      kind: 'tool_call',
      primary_message_id: 'tool_use_c1',
      tool_call_id: 'c1',
      payload: { tool_call_id: 'c1', state: 'interrupted', summary: 'Done' },
    },
  ];
  const result = reconcileTurnRows(provisionalRows, hydratedRows);
  assert.equal(result.finalRows[0].row_id, 'row:live-tool');
  assert.equal(
    result.finalRows[0].payload.state,
    'completed',
    'the live reducer saw the tool_result; a lagging event log must not paint the clock icon'
  );
});

test('reconcileTurnRows: a TRANSIENT provisional tool state still settles to hydrated "interrupted" (turn died mid-run)', () => {
  const provisionalRows = [
    {
      row_id: 'row:live-tool',
      turn_id: 'stream-x',
      kind: 'tool_call',
      primary_message_id: 'tool_use_c1',
      tool_call_id: 'c1',
      payload: { tool_call_id: 'c1', state: 'running' },
    },
  ];
  const hydratedRows = [
    {
      row_id: 'row:hydrated-tool',
      turn_id: 'stream-x',
      kind: 'tool_call',
      primary_message_id: 'tool_use_c1',
      tool_call_id: 'c1',
      payload: { tool_call_id: 'c1', state: 'interrupted' },
    },
  ];
  const result = reconcileTurnRows(provisionalRows, hydratedRows);
  assert.equal(result.finalRows[0].payload.state, 'interrupted');
});

/* ── C. Full-harness integration: live multi-tool stream replay ── */

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

function collectRolloutSignals(window, signalName) {
  const logs = (window.__rendererState && window.__rendererState.logs) || [];
  return logs.filter((entry) => {
    const eventName = String(entry?.event || entry?.message || '');
    if (!/row_model_rollout_signal/.test(eventName)) {
      return false;
    }
    const details = entry?.details || entry?.data || {};
    return String(details.signal || '') === signalName;
  });
}

test('live multi-tool stream: post-tool deltas keep painting, no mid-stream interrupted flash, no stale-row deletion at complete', async (t) => {
  const sessionId = 'session-repaint';
  const streamId = 'stream-repaint';
  const app = await loadRendererApp({
    shell: makeStartStreamShell(sessionId, streamId),
  });
  t.after(async () => {
    await app.dispose();
  });
  const { window, shell } = app;
  const doc = window.document;

  doc.getElementById('chatInput').value = 'streaming repaint probe';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);

  const emit = (payload) => shell.__emitChat({ sessionId, streamId, ...payload });
  const timeline = doc.querySelector('.chat-timeline') || doc.body;

  await emit({ type: 'started' });
  await emit({
    type: 'delta',
    content: '',
    aggregate: '',
    reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: 'planning the steps' }] },
  });
  await emit({
    type: 'tool_use',
    callId: 'c1',
    toolName: 'write_file',
    summary: 'Write a.md',
    input: { path: 'a.md' },
    status: 'pending_approval',
  });
  await emit({
    type: 'tool_use',
    callId: 'c1',
    toolName: 'write_file',
    summary: 'Write a.md',
    input: { path: 'a.md' },
    status: 'running',
    approvalState: 'auto',
  });
  // Give mid-stream renders (including the persisted-events hydration path)
  // time to run while the tool is still executing.
  await waitForUi(window, 100);

  // NOTE: the harness gotcha — `aggregate` is CUMULATIVE across tool
  // iterations (services/backend/tool-loop.js aggregate = assistantText +
  // iterationText), so every delta below carries the monotonic prefix.
  await emit({ type: 'delta', content: 'Sentence one. ', aggregate: 'Sentence one. ' });
  await emit({ type: 'delta', content: 'Sentence two. ', aggregate: 'Sentence one. Sentence two. ' });
  await emit({ type: 'tool_result', callId: 'c1', toolName: 'write_file', summary: 'Write a.md', content: 'ok', isError: false, durationMs: 5 });
  await waitForUi(window, 100);
  assert.match(
    timeline.textContent,
    /Sentence two\./,
    'pre-tool_result text must be painted once the tool result lands'
  );

  // The regression: deltas AFTER the first tool cycle stopped painting until
  // complete. Each one must now paint without needing another stream event.
  await emit({ type: 'delta', content: 'Sentence three. ', aggregate: 'Sentence one. Sentence two. Sentence three. ' });
  await waitForUi(window, 100);
  assert.match(
    timeline.textContent,
    /Sentence three\./,
    'a post-tool delta must paint without waiting for the next event or complete'
  );

  await emit({ type: 'delta', content: 'Sentence four. ', aggregate: 'Sentence one. Sentence two. Sentence three. Sentence four. ' });
  await waitForUi(window, 100);
  assert.match(
    timeline.textContent,
    /Sentence four\./,
    'the last delta of a burst must paint promptly (staged-delta flush)'
  );

  // Defect 2 pin: the ACTIVE turn's running tool must never re-render as
  // interrupted from the lagging persisted-events hydration.
  assert.equal(
    collectRolloutSignals(window, 'interrupted_running_tool_hydration').length,
    0,
    'no interrupted_running_tool_hydration signal may fire while the turn is live'
  );

  await emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' });
  await waitForUi(window, 150);

  // Defect 3 pin: the live->canonical handoff must not delete live rows.
  assert.equal(
    collectRolloutSignals(window, 'stale_row_deletion').length,
    0,
    'no stale_row_deletion signal may fire at the terminal handoff'
  );
  assert.match(timeline.textContent, /Sentence four\./, 'settled transcript retains the full streamed text');
});
