'use strict';

// F29 (1.2.0 gate): after a Plan Mode decision ("Keep planning" with feedback,
// or "Build it"), the live timeline showed "Reasoning · N steps" twice or
// nested and repeated Step rows until the next full render. shell.log carried
// the fingerprint: streaming_article_rebuild with turnId = the NEW segment id
// and outcome legacy_article_innerhtml. The segment's first structural render
// resolved its "turn article" to the segment's thread-compat row, which sits
// outside every .chat-entry, and patchVisibleStreamingArticle wrote the whole
// legacy message markup (every reasoning phase the stream had accumulated)
// into that row. The next write landed inside the Step header button it had
// just created. The upstream trigger that puts the segment's compat anchor in
// the DOM before its rows is not reproduced here; the test places that anchor
// exactly as the thread renderer emits it and pins the write-target contract:
// a live segment is only ever patched inside a .chat-entry.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { buildFeatureFlagDefaults } = require('../services/feature-flags');

const SESSION_ID = 'sess_plan_decision_live';
const STREAM_ID = 'stream_plan_decision_live';
const TURN_ID = 'turn_plan_decision_live';
const NEXT_SEGMENT_ID = `assistant_${STREAM_ID}_seg3`;
const PLAN_INPUT = {
  title: "Add the word 'kiwi' to README.md",
  summary: "Adds a single line mentioning 'kiwi' to the Notes section of README.md.",
  steps: ['Open README.md', 'Insert one bullet', 'Save README.md'],
  verification: "Re-read README.md and grep for 'kiwi'.",
};

function reasoningPhase(iteration) {
  return {
    phase_id: `phase_reasoning_${STREAM_ID}_iter${iteration}_1`,
    phase_kind: 'reasoning',
    thinking_id: `think_${STREAM_ID}_iter${iteration}`,
    iteration,
  };
}

function reasoningStart(iteration) {
  const phase = reasoningPhase(iteration);
  return { type: 'phase_started', phaseId: phase.phase_id, phaseKind: 'reasoning', thinkingId: phase.thinking_id, iteration, phase };
}

function reasoningDelta(iteration, text) {
  const phase = reasoningPhase(iteration);
  return {
    type: 'delta',
    content: '',
    thinkingId: phase.thinking_id,
    phase,
    reasoning: { source: 'provider', entriesDelta: [{ id: `reasoning_${iteration}`, text, thinkingId: phase.thinking_id }] },
  };
}

function reasoningEnd(iteration) {
  return { ...reasoningStart(iteration), type: 'phase_completed' };
}

function textLeg(iteration, text) {
  const phase = { phase_id: `phase_text_${STREAM_ID}_iter${iteration}_2`, phase_kind: 'text', iteration };
  return [
    { type: 'phase_started', phaseId: phase.phase_id, phaseKind: 'text', iteration, phase },
    { type: 'delta', content: text, phase },
  ];
}

// The real wire for an inspection round: 'pending' on request, then per call a
// tool_use phase, 'running' naming the next segment, and the result.
function toolCalls(calls, nextSegment) {
  const out = calls.map(([callId, toolName, input]) => ({ type: 'tool_use', callId, toolName, summary: toolName, input, status: 'pending' }));
  for (const [callId, toolName, input, output] of calls) {
    const usePhase = { type: 'phase_started', phaseId: `phase_tool_use_${STREAM_ID}_${callId}`, phaseKind: 'tool_use', toolCallId: callId, toolName };
    out.push(usePhase);
    out.push({ type: 'tool_use', callId, toolName, summary: toolName, input, status: 'running',
      next_assistant_message_id: `assistant_${STREAM_ID}_seg${nextSegment}` });
    out.push({ ...usePhase, type: 'phase_completed' });
    const resultPhase = { type: 'phase_started', phaseId: `phase_tool_result_${STREAM_ID}_${callId}`, phaseKind: 'tool_result', toolCallId: callId, toolName };
    out.push(resultPhase);
    out.push({ type: 'tool_result', callId, toolName, status: 'success', content: output, isError: false });
    out.push({ ...resultPhase, type: 'phase_completed' });
  }
  return out;
}

async function openPlanTurn() {
  const app = await loadRendererApp({ shell: {
    features: { state: { featureFlags: buildFeatureFlagDefaults() } },
    chat: {
      async startStream(_payload, { state }) {
        state.sessions = [{ id: SESSION_ID, title: 'Plan', conversation_mode: 'chat', preferred_model: 'gpt-test',
          plan_mode: true, updated_at: new Date().toISOString(), linked_session_ids: [],
          context_preferences: { history_scope: 'session', include_personality: true, include_memory: true } }];
        state.messagesBySession.set(SESSION_ID, []);
        return { sessionId: SESSION_ID, streamId: STREAM_ID, turnId: TURN_ID };
      },
    },
    tools: { async approve() { return true; } },
  } });
  const { window, shell } = app;
  let aggregate = '';
  const emit = async (payload) => {
    const full = { sessionId: SESSION_ID, streamId: STREAM_ID, turnId: TURN_ID, ...payload };
    if (payload.type === 'delta') {
      aggregate += payload.content || '';
      full.aggregate = aggregate;
    }
    await shell.__emitChat(full);
    await waitForUi(window, 30);
  };
  const input = window.document.getElementById('chatInput');
  input.value = "Inspect the files and plan to add the word 'kiwi' to the readme";
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.document.getElementById('sendButton').click();
  await waitForUi(window, 30);

  await emit({ type: 'started' });
  for (const [iteration, text, calls] of [
    [1, 'Let me start by inspecting the workspace files.',
      [['call_list', 'list_dir', { path: '.' }, 'README.md'], ['call_read', 'read_file', { path: 'README.md' }, '# Readme']]],
    [2, 'Let me review the situation. I am in Plan Mode.', [['call_read2', 'read_file', { path: 'a.txt' }, 'a']]],
  ]) {
    await emit(reasoningStart(iteration));
    await emit(reasoningDelta(iteration, text));
    await emit(reasoningEnd(iteration));
    for (const payload of toolCalls(calls, iteration)) await emit(payload);
  }
  await emit(reasoningStart(3));
  await emit(reasoningDelta(3, 'Let me understand the situation before the plan.'));
  await emit(reasoningEnd(3));
  for (const payload of textLeg(3, "I've inspected all the workspace files. Here's the plan.")) await emit(payload);
  const planCall = { callId: 'call_plan_1', toolName: 'exit_plan_mode', summary: 'exit_plan_mode', input: PLAN_INPUT };
  await emit({ type: 'tool_use', ...planCall, status: 'pending' });
  await emit({ type: 'tool_use', ...planCall, status: 'pending_approval', approvalId: 'approval_plan_1' });
  await emit({ type: 'phase_started', phaseId: `phase_approval_wait_${STREAM_ID}_call_plan_1`, phaseKind: 'approval_wait',
    toolCallId: 'call_plan_1', toolName: 'exit_plan_mode', summary: 'Waiting for approval' });
  await emit({ type: 'tool_approval_needed', callId: 'call_plan_1', approvalId: 'approval_plan_1',
    toolName: 'exit_plan_mode', input: PLAN_INPUT,
    planDocument: { plan_id: 'plan_1', tool_call_id: 'call_plan_1', approval_id: 'approval_plan_1', state: 'pending',
      ...PLAN_INPUT, files_read: ['README.md'], parent_stream_id: STREAM_ID } });
  await waitForUi(window, 80);
  return { app, window, emit, planCall };
}

// The thread renderer's envelope-sibling anchor for a segment: a nested
// .chat-thread-node holding a compat row outside every .chat-entry.
function placeSegmentCompatAnchor(document, messageId) {
  const timeline = document.getElementById('chatTimeline');
  const planAnchor = timeline.querySelector('.chat-row-thread-compat[data-source-message-ids~="plan_document_plan_1"]');
  assert.ok(planAnchor, 'the plan document renders as an envelope sibling anchor');
  const node = planAnchor.closest('.chat-thread-node').cloneNode(true);
  const row = node.querySelector('.chat-row-thread-compat');
  row.setAttribute('data-source-message-ids', messageId);
  row.querySelector('.thread-compat-anchor').setAttribute('data-message-id', messageId);
  planAnchor.closest('.chat-thread-node').after(node);
}

function assertSegmentStaysInTheTurnArticle(window, label) {
  const timeline = window.document.getElementById('chatTimeline');
  const outside = [...timeline.querySelectorAll('.reasoning-row-header, .reasoning-row-group-label, .chat-bubble')]
    .filter((node) => !node.closest('.chat-entry'));
  assert.deepEqual(outside.map((node) => node.className), [], `${label}: no transcript content outside a .chat-entry`);
  assert.deepEqual(
    [...timeline.querySelectorAll('.reasoning-row-group-label')].map((node) => node.textContent.trim()),
    [],
    `${label}: no whole-message "Reasoning · N steps" group is written into the live turn`
  );
  assert.equal(timeline.querySelectorAll('.reasoning-row-header .chat-entry, .reasoning-row-header .reasoning-row-header').length, 0,
    `${label}: nothing is nested inside a Step header`);
  const compat = timeline.querySelector(`.chat-row-thread-compat[data-source-message-ids~="${NEXT_SEGMENT_ID}"]`);
  assert.ok(!compat || compat.querySelector('.thread-compat-anchor'), `${label}: the segment's compat anchor keeps its anchor span`);
  const segmentHeaders = [...timeline.querySelectorAll(`.reasoning-row-header[data-message-id="${NEXT_SEGMENT_ID}"]`)];
  assert.equal(segmentHeaders.length, 1, `${label}: the new segment's Thought row renders once`);
  assert.ok(segmentHeaders[0].closest('.chat-entry'), `${label}: that row sits in the turn article`);
  const legacyWrites = [...(window.__rendererState.logs || [])]
    .filter((entry) => entry?.data?.outcome === 'legacy_article_innerhtml');
  assert.deepEqual(legacyWrites.map((entry) => entry.data.signal), [], `${label}: no legacy whole-article write`);
}

for (const [decision, label] of [['rejected', 'Keep planning with feedback'], ['approved', 'Build it']]) {
  test(`F29: after "${label}" the next segment renders inside the turn article`, async (t) => {
    const { app, window, emit, planCall } = await openPlanTurn();
    t.after(() => app.dispose());
    const document = window.document;
    const card = document.querySelector('[data-plan-document][data-plan-state="pending"]');
    assert.ok(card, 'the pending plan card rendered');
    if (decision === 'rejected') {
      card.querySelector('[data-plan-decision="feedback"]').click();
      await waitForUi(window, 20);
      card.querySelector('[data-plan-feedback]').value = "instead of kiwi, plan to add 'strawberry'";
    }
    card.querySelector(`[data-plan-decision="${decision}"]`).click();
    await waitForUi(window, 20);

    // Main answers the approval and the tool resolves; no stream_reset follows
    // (the managed runtime emits none here), so the next segment starts cold.
    await emit({ type: 'tool_use', ...planCall, status: decision, approvalId: 'approval_plan_1' });
    await emit({ type: 'phase_completed', phaseId: `phase_approval_wait_${STREAM_ID}_call_plan_1`, phaseKind: 'approval_wait',
      toolCallId: 'call_plan_1', toolName: 'exit_plan_mode', summary: 'Approval resolved' });
    await emit({ type: 'tool_use', ...planCall, status: 'running', next_assistant_message_id: NEXT_SEGMENT_ID });
    await emit({ type: 'tool_result', callId: 'call_plan_1', toolName: 'exit_plan_mode', isError: false,
      content: decision === 'rejected' ? "instead of kiwi, plan to add 'strawberry'" : 'Plan approved.',
      metadata: { result_kind: 'plan_mode_transition', plan_decision: decision, plan_mode_cleared: decision !== 'rejected' } });
    await emit(reasoningStart(4));
    placeSegmentCompatAnchor(document, NEXT_SEGMENT_ID);

    await emit(reasoningDelta(4, 'The user wants a different word. Let me revise the plan.'));
    await waitForUi(window, 150);
    assertSegmentStaysInTheTurnArticle(window, 'first reasoning delta');
    await emit(reasoningDelta(4, ' I will update the plan title and the inserted line.'));
    await emit(reasoningEnd(4));
    const [textStart, firstText] = textLeg(4, 'Here is the revised plan. ');
    await emit(textStart);
    await emit(firstText);
    await emit({ ...firstText, content: 'It adds one line to README.md.' });
    await waitForUi(window, 150);
    assertSegmentStaysInTheTurnArticle(window, 'reply text');

    const decided = [...document.querySelectorAll('[data-plan-document]')];
    assert.equal(decided.length, 1, 'one plan card');
    assert.equal(decided[0].getAttribute('data-plan-state'), decision);
    assert.ok(decided[0].closest('.chat-entry'), 'the plan card stays in the turn article');
  });
}
