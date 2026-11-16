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

// order-terminal #5: the terminal fold seals a still-pending approval to
// 'interrupted' and a pending plan to 'abandoned'. When the carried log lags
// the decision the live reducer already saw, the settled live state stands,
// exactly as for a tool_call; a still-pending live row takes the seal.
test('reconcileTurnRows: a settled approval or plan decision is not downgraded by the lagging seal', () => {
  const row = (rowId, kind, state, extra = {}) => ({
    row_id: rowId, turn_id: 'stream-x', kind, primary_message_id: 'tool_use_c1', tool_call_id: 'c1',
    payload: { tool_call_id: 'c1', state, ...extra },
  });
  const settled = reconcileTurnRows(
    [row('row:gap', 'approval_gap', 'approved'), row('row:plan', 'plan_document', 'approved', { transition: 'approved', transitions: ['pending', 'approved'] })],
    [row('row:gap', 'approval_gap', 'interrupted'), row('row:plan', 'plan_document', 'abandoned', { transition: 'abandoned', transitions: ['pending', 'abandoned'] })],
    { deterministicRowId: true },
  ).finalRows;
  assert.equal(settled[0].payload.state, 'approved', 'the approved receipt stays approved');
  assert.deepEqual([settled[1].payload.state, settled[1].payload.transition], ['approved', 'approved'], 'the accepted plan stays accepted');
  const pending = reconcileTurnRows(
    [row('row:gap', 'approval_gap', 'awaiting_approval'), row('row:plan', 'plan_document', 'pending')],
    [row('row:gap', 'approval_gap', 'interrupted'), row('row:plan', 'plan_document', 'abandoned')],
    { deterministicRowId: true },
  ).finalRows;
  assert.deepEqual(pending.map((entry) => entry.payload.state), ['interrupted', 'abandoned'], 'a turn that died waiting keeps the seal');
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
    status: 'requested',
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

  // Model the current sessions.getMessages contract at settlement: persisted
  // events preserve text groups on both sides of a tool result. A messages-only
  // fixture collapses those groups into one string and cannot prove row parity.
  const liveTurn = window.__rendererState.ui.chatTimelineLiveStateBySession.get(sessionId).turns_by_id[streamId];
  const turnEvents = structuredClone(liveTurn.events).map((event, eventSeq) => ({ ...event, event_seq: eventSeq }));
  shell.sessions.getMessages = async () => ({
    data: structuredClone(window.__rendererState.messagesBySession.get(sessionId)),
    turn_events: turnEvents,
    turn_event_log_version: 4,
  });
  await emit({ type: 'complete', content: '', interactiveProtocolDrift: false, interactiveProtocolDriftPreview: '' });
  await waitForUi(window, 150);

  // Defect 3 pin: the live->canonical handoff must not delete live rows.
  assert.equal(
    collectRolloutSignals(window, 'stale_row_deletion').length,
    0,
    `no stale_row_deletion signal may fire at the terminal handoff: ${JSON.stringify(collectRolloutSignals(window, 'stale_row_deletion'))}`
  );
  assert.match(timeline.textContent, /Sentence four\./, 'settled transcript retains the full streamed text');
});

/* ── D. One turn, three builds: live fold, terminal reconcile, reopen ── */

// The painted row order of a multi-segment tool turn: reasoning, preface text,
// a tool call, reasoning again, the final answer. Each row is named by its kind
// and, for text, its words, so a swap of two rows of the same kind still shows.
function paintedRowOrder(doc) {
  return [...doc.querySelectorAll('#chatTimeline .chat-row[data-row-kind]')].map((row) => {
    const kind = row.getAttribute('data-row-kind');
    if (kind !== 'assistant_text') return kind;
    return `${kind}:${(row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)}`;
  }).filter((label) => label !== 'tool_result');
}

test('a multi-segment tool turn paints the same row order live, at the terminal reconcile and after reopen', async (t) => {
  const sessionId = 'session-three-builds';
  const streamId = 'stream-three-builds';
  const app = await loadRendererApp({ shell: makeStartStreamShell(sessionId, streamId) });
  t.after(async () => { await app.dispose(); });
  const { window, shell } = app;
  const doc = window.document;
  doc.getElementById('chatInput').value = 'read the notes';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);
  const emit = (payload) => shell.__emitChat({ sessionId, streamId, ...payload });

  await emit({ type: 'started' });
  await emit({ type: 'delta', content: '', aggregate: '', reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: 'Find the notes first.' }] } });
  await emit({ type: 'delta', content: 'Let me look. ', aggregate: 'Let me look. ' });
  await emit({ type: 'tool_use', callId: 'c1', toolName: 'read_file', summary: 'Read notes.md', input: { path: 'notes.md' }, status: 'running' });
  await emit({ type: 'tool_result', callId: 'c1', toolName: 'read_file', summary: 'Read notes.md', content: 'three items', isError: false, durationMs: 4 });
  await emit({ type: 'delta', content: '', aggregate: 'Let me look. ', reasoning: { source: 'provider', entriesDelta: [{ id: 'r2', text: 'Now summarize them.' }] } });
  await emit({ type: 'delta', content: 'There are three items.', aggregate: 'Let me look. There are three items.' });
  await waitForUi(window, 120);
  const live = paintedRowOrder(doc);
  assert.ok(live.includes('tool_call') && live.filter((label) => label.startsWith('assistant_text')).length === 2,
    `the live turn painted its tool call and both text rows: ${live.join(' | ')}`);

  const liveTurn = window.__rendererState.ui.chatTimelineLiveStateBySession.get(sessionId).turns_by_id[streamId];
  const persisted = {
    data: structuredClone(window.__rendererState.messagesBySession.get(sessionId)).map((message) => (
      message.status === 'streaming' ? { ...message, status: 'complete' } : message)),
    // The store keeps the turn's content events; the live-only 'started' marker is not one.
    turn_events: structuredClone(liveTurn.events).filter((event) => event.kind !== 'started')
      .map((event, eventSeq) => ({ ...event, event_seq: eventSeq })),
    turn_event_log_version: 4,
  };
  shell.sessions.getMessages = async () => structuredClone(persisted);
  await emit({ type: 'complete', content: 'Let me look. There are three items.' });
  await waitForUi(window, 200);
  const terminal = paintedRowOrder(doc);
  assert.deepEqual(terminal, live, 'the terminal reconcile keeps the live order');

  const reopenedApp = await loadRendererApp({ shell: {
    sessions: [buildSession(sessionId)],
    workspaceState: { activeSessionId: sessionId, openSessionIds: [sessionId] },
    sessionMessagePayloads: { [sessionId]: structuredClone(persisted) },
  } });
  t.after(async () => { await reopenedApp.dispose(); });
  await waitForUi(reopenedApp.window, 200);
  assert.deepEqual(paintedRowOrder(reopenedApp.window.document), live, 'the reopened chat keeps the live order');
});

/* ── E. Mixed states: a chat switch away and back mid-turn ── */

// Streams the section D turn into `sessionId`; `midTurn` runs after the tool
// call starts and before its result, so a caller can switch chats there.
async function streamToolTurn(app, sessionId, streamId, midTurn = async () => {}) {
  const { window, shell } = app;
  const doc = window.document;
  doc.getElementById('chatInput').value = 'read the notes';
  doc.getElementById('chatInput').dispatchEvent(new window.Event('input', { bubbles: true }));
  doc.getElementById('sendButton').click();
  await waitForUi(window, 30);
  const emit = (payload) => shell.__emitChat({ sessionId, streamId, ...payload });
  await emit({ type: 'started' });
  await emit({ type: 'delta', content: '', aggregate: '', reasoning: { source: 'provider', entriesDelta: [{ id: 'r1', text: 'Find the notes first.' }] } });
  await emit({ type: 'delta', content: 'Let me look. ', aggregate: 'Let me look. ' });
  await emit({ type: 'tool_use', callId: 'c1', toolName: 'read_file', summary: 'Read notes.md', input: { path: 'notes.md' }, status: 'running' });
  await waitForUi(window, 60);
  await midTurn();
  await emit({ type: 'tool_result', callId: 'c1', toolName: 'read_file', summary: 'Read notes.md', content: 'three items', isError: false, durationMs: 4 });
  await emit({ type: 'delta', content: '', aggregate: 'Let me look. ', reasoning: { source: 'provider', entriesDelta: [{ id: 'r2', text: 'Now summarize them.' }] } });
  await emit({ type: 'delta', content: 'There are three items.', aggregate: 'Let me look. There are three items.' });
  await waitForUi(window, 120);
  return emit;
}

function makeTwoChatShell(sessionId, otherSessionId, streamId) {
  return {
    sessions: [buildSession(otherSessionId)],
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [buildSession(sessionId), buildSession(otherSessionId)];
        state.messagesBySession.set(sessionId, []);
        state.messagesBySession.set(otherSessionId, []);
        return { sessionId, streamId };
      },
    },
  };
}

async function openChat(window, sessionId) {
  const open = window.document.querySelector(`.conversation-item[data-session-id="${sessionId}"] [data-session-open]`);
  assert.ok(open, `chat ${sessionId} has an open control in the list`);
  open.click();
  await waitForUi(window, 150);
}

test('a live turn keeps its rows and their order through a chat switch away and back', async (t) => {
  const control = await loadRendererApp({ shell: makeStartStreamShell('session-control', 'stream-control') });
  t.after(async () => { await control.dispose(); });
  await streamToolTurn(control, 'session-control', 'stream-control');
  // thread_compat rows are invisible message-id anchors; mid-turn the store
  // lacks the segment still streaming, so their count may differ by one.
  const visibleRows = (doc) => paintedRowOrder(doc).filter((label) => label !== 'thread_compat');
  const expected = visibleRows(control.window.document);

  const sessionId = 'session-switch-live';
  const otherSessionId = 'session-switch-other';
  const streamId = 'stream-switch-live';
  const app = await loadRendererApp({ shell: makeTwoChatShell(sessionId, otherSessionId, streamId) });
  t.after(async () => { await app.dispose(); });
  const { window, shell } = app;
  // Mid-turn the store holds the prompt, the segments closed at a tool boundary
  // and the tool messages, not the segment still streaming
  // (chat-stream-managed-runtime-segments.js), and names the turn in flight.
  shell.sessions.getMessages = async (id) => (id === sessionId ? {
    data: structuredClone(window.__rendererState.messagesBySession.get(sessionId) || [])
      .filter((message) => message.status !== 'streaming'),
    turn_events: [],
    turn_event_log_version: 4,
    active_turn: { turn_id: streamId, stream_id: streamId },
  } : { data: [] });
  const emit = await streamToolTurn(app, sessionId, streamId, async () => {
    await openChat(window, otherSessionId);
    assert.equal(window.__rendererState.currentSessionId, otherSessionId);
  });
  await openChat(window, sessionId);
  assert.deepEqual(visibleRows(window.document), expected, 'switching back paints the rows that streamed while away, in order');
  await emit({ type: 'delta', content: ' Done.', aggregate: 'Let me look. There are three items. Done.' });
  await waitForUi(window, 120);
  assert.match(window.document.getElementById('chatTimeline').textContent, /three items\. Done\./, 'a delta after switching back still paints');

  const liveTurn = window.__rendererState.ui.chatTimelineLiveStateBySession.get(sessionId).turns_by_id[streamId];
  const persisted = {
    data: structuredClone(window.__rendererState.messagesBySession.get(sessionId)).map((message) => (
      message.status === 'streaming' ? { ...message, status: 'complete' } : message)),
    turn_events: structuredClone(liveTurn.events).filter((event) => event.kind !== 'started')
      .map((event, eventSeq) => ({ ...event, event_seq: eventSeq })),
    turn_event_log_version: 4,
  };
  shell.sessions.getMessages = async (id) => (id === sessionId ? structuredClone(persisted) : { data: [] });
  await emit({ type: 'complete', content: 'Let me look. There are three items. Done.' });
  await waitForUi(window, 200);
  assert.deepEqual(visibleRows(window.document).map((label) => label.replace(/ D[one.]*$/, '')), expected,
    'the terminal after the switch keeps the same order');
});

// order-terminal #7: when terminal hydration fails, the complete event's
// cumulative text (every segment of the turn) must not land in the last
// bubble on top of the earlier segment already painted above the tool card.
test('a failed terminal hydration does not repeat an earlier segment in the final bubble', async (t) => {
  const app = await loadRendererApp({ shell: makeStartStreamShell('session-hydrate-fail', 'stream-hydrate-fail') });
  t.after(async () => { await app.dispose(); });
  const emit = await streamToolTurn(app, 'session-hydrate-fail', 'stream-hydrate-fail');
  app.shell.sessions.getMessages = async () => { throw new Error('store offline'); };
  await emit({ type: 'complete', content: 'Let me look. There are three items.' });
  await waitForUi(app.window, 250);
  const text = app.window.document.getElementById('chatTimeline').textContent;
  assert.equal(text.split('Let me look.').length - 1, 1, `the preface shows once: ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
  assert.equal(text.split('There are three items.').length - 1, 1, 'the answer shows once');
});
