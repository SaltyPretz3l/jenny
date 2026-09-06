// Phase 2A invariant guard for the canonical turn view-model.
//
// This suite pins the row-shape and projection invariants that the forthcoming
// renderer/chat/renderer-turn-view-model.js builder, plus the projector/projection-context/live
// reconciliation consumers, must preserve as Phase 2 lands. It deliberately
// exercises the already-shipped projectTurnRows API because the view-model is a
// distillation of the same semantics; when the builder is introduced in 2B the
// assertions that name row-level invariants should continue to hold.

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { buildTurnViewModel } = require('../renderer/chat/renderer-turn-view-model');
const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { normalizeChatMessages } = require('../renderer/chat/chat-message-utils');

function buildViewModelFromMessages(messages) {
  const tree = projectTurnTree({ messages: normalizeChatMessages(messages) });
  const turn = tree.turns[0];
  const messageById = new Map();
  const toolMessageIdsByCallId = new Map();
  for (const message of normalizeChatMessages(messages)) {
    const messageId = String(message && message.id || '').trim();
    if (!messageId) continue;
    messageById.set(messageId, message);
    const kind = String(message.kind || '').trim();
    let callId = '';
    if (kind === 'tool_use') callId = String(message.tool_call?.call_id || '').trim();
    else if (kind === 'tool_result') callId = String(message.tool_result?.call_id || '').trim();
    if (!callId) continue;
    const ids = toolMessageIdsByCallId.get(callId) || [];
    if (!ids.includes(messageId)) ids.push(messageId);
    toolMessageIdsByCallId.set(callId, ids);
  }
  return buildTurnViewModel(turn, { messageById, toolMessageIdsByCallId });
}

function event(overrides) {
  return {
    event_id: 'evt',
    event_seq: 0,
    turn_id: 'turn_invariant',
    kind: 'tool_use',
    primary_message_id: 'msg_assistant',
    source_message_ids: ['msg_assistant'],
    tool_call_id: 'call_invariant',
    status: 'completed',
    sort_key: [0, 0, 0],
    payload: {},
    ...overrides,
  };
}

function userPromptEvent(overrides) {
  return event({
    event_id: 'user_prompt:0',
    kind: 'user_prompt',
    primary_message_id: 'msg_user',
    source_message_ids: ['msg_user'],
    tool_call_id: '',
    status: 'completed',
    sort_key: [0, 0, 10],
    payload: { content: 'Hello', attachments: [] },
    ...overrides,
  });
}

function toolUseEvent(overrides) {
  return event({
    event_id: 'tool_use:0',
    kind: 'tool_use',
    primary_message_id: 'msg_tool_use',
    source_message_ids: ['msg_tool_use'],
    tool_call_id: 'call_invariant',
    status: 'completed',
    sort_key: [1, 0, 40],
    payload: { tool_name: 'Read', input: { path: 'README.md' }, input_json: '{"path":"README.md"}' },
    ...overrides,
  });
}

function toolResultEvent(overrides) {
  return event({
    event_id: 'tool_result:0',
    kind: 'tool_result',
    primary_message_id: 'msg_tool_result',
    source_message_ids: ['msg_tool_result'],
    tool_call_id: 'call_invariant',
    status: 'completed',
    sort_key: [1, 2, 60],
    payload: { tool_name: 'Read', output_text: 'contents', is_error: false },
    ...overrides,
  });
}

function approvalRequestedEvent(overrides) {
  return event({
    event_id: 'approval_requested:0',
    kind: 'approval_requested',
    primary_message_id: 'msg_tool_use',
    source_message_ids: ['msg_tool_use'],
    tool_call_id: 'call_invariant',
    status: 'pending_approval',
    sort_key: [1, 1, 45],
    payload: { prompt: 'Approve?', approval_state: 'pending' },
    ...overrides,
  });
}

function approvalResolvedEvent(overrides) {
  return event({
    event_id: 'approval_resolved:0',
    kind: 'approval_resolved',
    primary_message_id: 'msg_tool_use',
    source_message_ids: ['msg_tool_use'],
    tool_call_id: 'call_invariant',
    status: 'approved',
    sort_key: [1, 1, 46],
    payload: { approval_state: 'approved' },
    ...overrides,
  });
}

function assistantTextEvent(overrides) {
  return event({
    event_id: 'assistant_text_segment:0',
    kind: 'assistant_text_segment',
    primary_message_id: 'msg_assistant_text',
    source_message_ids: ['msg_assistant_text'],
    tool_call_id: '',
    status: 'completed',
    assistant_phase: 'final_answer',
    sort_key: [2, 0, 10],
    payload: {
      segment_id: 'seg_0',
      phase_id: 'phase_text_final',
      text: 'Answer',
      message_index: 0,
      segment_index: 0,
    },
    ...overrides,
  });
}

function reasoningEvent(overrides) {
  return event({
    event_id: 'reasoning_phase:0',
    kind: 'reasoning_phase',
    primary_message_id: 'msg_assistant_text',
    source_message_ids: ['msg_assistant_text'],
    tool_call_id: '',
    status: 'completed',
    phase_id: 'phase_reasoning_pre',
    sort_key: [0, 5, 10],
    payload: {
      phase_id: 'phase_reasoning_pre',
      thinking_id: 'think_0',
      entries: [{ id: 'reason_0', text: 'Plan' }],
    },
    ...overrides,
  });
}

function shuffle(list) {
  const copy = list.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = (i * 7 + 3) % (i + 1);
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

function rowSignature(row) {
  const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
  return [
    String(row.kind || ''),
    String(row.primary_message_id || ''),
    String(row.tool_call_id || ''),
    String(row.phase_id || ''),
    String(row.assistant_phase || ''),
    String(row.segment_group_index ?? ''),
    String(payload.state || ''),
    String(payload.text || payload.content || ''),
    String(payload.summary || ''),
    String(payload.output_text || ''),
    String(payload.result_summary || ''),
    String(payload.error_code || ''),
    Array.isArray(payload.entries) ? payload.entries.map((entry) => String(entry && entry.text || '')).join('^') : '',
  ].join('|');
}

// --- 1. Row identity stability ---------------------------------------------

test('buildTurnViewModel/shape: exposes the full canonical shape including 2B2 placeholders', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_msg_shape', role: 'user', content: 'Hi' },
  ]);
  assert.equal(typeof viewModel.turnId, 'string');
  assert.ok(viewModel.rootMessageIds);
  assert.ok('user' in viewModel.rootMessageIds);
  assert.ok('assistant' in viewModel.rootMessageIds);
  assert.ok('user' in viewModel);
  assert.ok('assistant' in viewModel);
  assert.ok(Array.isArray(viewModel.toolCalls));
  assert.ok(Array.isArray(viewModel.reasoning));
  assert.ok(Array.isArray(viewModel.notices));
  assert.ok(Array.isArray(viewModel.attachments));
  assert.ok(viewModel.interactive && Array.isArray(viewModel.interactive.batches));
  assert.ok(viewModel.interactive && Array.isArray(viewModel.interactive.recaps));
  assert.ok(Array.isArray(viewModel.suggestions));
  assert.ok(Array.isArray(viewModel.slashOutput));
  assert.ok(Array.isArray(viewModel.artifacts));
  assert.equal(typeof viewModel.phaseHint, 'string');
});

test('buildTurnViewModel/user: captures user bubble content and messageId', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_msg_0', role: 'user', content: 'Walk me through it' },
    { id: 'asst_msg_0', role: 'assistant', content: 'Sure' },
  ]);
  assert.ok(viewModel.user);
  assert.equal(viewModel.user.messageId, 'user_msg_0');
  assert.equal(viewModel.user.content, 'Walk me through it');
  assert.equal(viewModel.rootMessageIds.user, 'user_msg_0');
});

test('buildTurnViewModel/assistant: groups text segments by primary_message_id + assistant_phase with stable groupIndex and totalText', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_mixed', role: 'user', content: 'Start' },
    {
      id: 'asst_mixed',
      role: 'assistant',
      streamId: 'stream_mixed',
      phases: [
        { phase_id: 'phase_text_pre', phase_kind: 'text' },
      ],
      visible_segments: [
        { segment_id: 'seg_a', phase_id: 'phase_text_pre', text: 'Let me check. ' },
      ],
    },
    {
      id: 'tool_use_mixed',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_mixed',
        tool_name: 'Read',
        parent_stream_id: 'stream_mixed',
        status: 'completed',
      },
    },
    {
      id: 'asst_mixed_final',
      role: 'assistant',
      streamId: 'stream_mixed',
      phases: [
        { phase_id: 'phase_text_final', phase_kind: 'text' },
      ],
      visible_segments: [
        { segment_id: 'seg_b', phase_id: 'phase_text_final', text: 'Done.' },
      ],
    },
  ]);
  assert.ok(viewModel.assistant);
  assert.equal(viewModel.assistant.segments.length, 2);
  assert.equal(viewModel.assistant.segments[0].groupIndex, 0);
  assert.equal(viewModel.assistant.segments[1].groupIndex, 1);
  assert.equal(viewModel.assistant.segments[0].assistantPhase, 'commentary');
  assert.equal(viewModel.assistant.segments[1].assistantPhase, 'final_answer');
  assert.equal(viewModel.assistant.totalText, 'Let me check. Done.');
  assert.equal(viewModel.assistant.finalAnswerText, 'Done.');
  assert.equal(viewModel.assistant.hasFinalAnswer, true);
});

test('buildTurnViewModel/reasoning: emits reasoning groups with phase_id, thinking_id, and entry text', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_think', role: 'user', content: 'Think' },
    {
      id: 'asst_think',
      role: 'assistant',
      streamId: 'stream_think',
      phases: [
        {
          phase_id: 'phase_r',
          phase_kind: 'reasoning',
          thinking_id: 'think_r',
          entries: [{ id: 'e0', text: 'Consider option A.' }, { id: 'e1', text: 'Consider option B.' }],
        },
        { phase_id: 'phase_text', phase_kind: 'text' },
      ],
      visible_segments: [
        { segment_id: 'seg', phase_id: 'phase_text', text: 'Let us go with A.' },
      ],
    },
  ]);
  assert.equal(viewModel.reasoning.length, 1);
  const group = viewModel.reasoning[0];
  assert.equal(group.phaseId, 'phase_r');
  assert.equal(group.thinkingId, 'think_r');
  assert.equal(group.entries.length, 2);
  assert.equal(group.entries[0].text, 'Consider option A.');
});

test('buildTurnViewModel/phaseHint: errored tool dominates the hint', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_ph_err', role: 'user', content: 'Read' },
    {
      id: 'tool_use_ph_err',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: { call_id: 'call_ph_err', tool_name: 'Read', parent_stream_id: 'ph_err', status: 'completed' },
    },
    {
      id: 'tool_result_ph_err',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: { call_id: 'call_ph_err', tool_name: 'Read', output_text: 'e', is_error: true, parent_stream_id: 'ph_err' },
    },
  ]);
  assert.equal(viewModel.phaseHint, 'errored');
});

test('buildTurnViewModel/phaseHint: awaiting_approval when a tool is pending', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_ph_wait', role: 'user', content: 'Write' },
    {
      id: 'tool_use_ph_wait',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_ph_wait',
        tool_name: 'Write',
        parent_stream_id: 'ph_wait',
        status: 'pending_approval',
      },
    },
  ]);
  assert.equal(viewModel.phaseHint, 'awaiting_approval');
});

test('buildTurnViewModel/phaseHint: final_answer when assistant has a final_answer-labelled segment and no active tool', () => {
  const viewModel = buildViewModelFromMessages([
    { id: 'user_ph_final', role: 'user', content: 'Hi' },
    {
      id: 'asst_ph_final',
      role: 'assistant',
      streamId: 'ph_final',
      phases: [{ phase_id: 'phase_text_final', phase_kind: 'text' }],
      visible_segments: [{ segment_id: 'seg', phase_id: 'phase_text_final', text: 'Done.' }],
    },
  ]);
  assert.equal(viewModel.phaseHint, 'final_answer');
});

// --- Phase 2B2: extended builder families ---------------------------------

function fabricateTurn(turnId, eventList) {
  const events = eventList.map((evt) => ({
    turn_id: turnId,
    ...evt,
  }));
  return {
    turn_id: turnId,
    branch_id: '',
    events,
    primary_user_message_id: normalizeId(events.find((evt) => evt.kind === 'user_prompt')?.primary_message_id || ''),
    primary_assistant_message_id: '',
    source_message_ids: Array.from(new Set(
      events.flatMap((evt) => Array.isArray(evt.source_message_ids) ? evt.source_message_ids : []).filter(Boolean)
    )),
  };
}

function normalizeId(value) { return String(value || '').trim(); }

test('buildTurnViewModel/notices: system_notice and assistant_error events become notice entries', () => {
  const turn = fabricateTurn('turn_notices', [
    { event_id: 'u', kind: 'user_prompt', primary_message_id: 'u', source_message_ids: ['u'], sort_key: [0, 0, 10], payload: { content: 'hi' } },
    { event_id: 's', kind: 'system_notice', primary_message_id: 'sys', source_message_ids: ['sys'], sort_key: [2, 0, 5], payload: { subkind: 'cancel_notice', content: 'Cancelled' } },
    { event_id: 'e', kind: 'assistant_error', primary_message_id: 'err', source_message_ids: ['err'], sort_key: [2, 0, 15], payload: { subkind: 'failure', message: 'Boom' } },
  ]);
  const viewModel = buildTurnViewModel(turn, {});
  assert.equal(viewModel.notices.length, 2);
  assert.equal(viewModel.notices[0].subkind, 'cancel_notice');
  assert.equal(viewModel.notices[1].subkind, 'failure');
});

test('buildTurnViewModel/notices: orphan tool_result, orphan approval_requested, and invalid_tool_use each become notices with the right subkind', () => {
  const turn = fabricateTurn('turn_orphans', [
    { event_id: 'u', kind: 'user_prompt', primary_message_id: 'u', source_message_ids: ['u'], sort_key: [0, 0, 10], payload: { content: 'hi' } },
    { event_id: 'r', kind: 'tool_result', tool_call_id: 'missing_call', primary_message_id: 'r', source_message_ids: ['r'], sort_key: [1, 0, 40], payload: { tool_name: 'X', output_text: 'y' } },
    { event_id: 'a', kind: 'approval_requested', tool_call_id: 'missing_call_2', primary_message_id: 'a', source_message_ids: ['a'], sort_key: [1, 0, 50], payload: { prompt: '?' } },
    { event_id: 'tu', kind: 'tool_use', tool_call_id: '', primary_message_id: 'tu', source_message_ids: ['tu'], sort_key: [1, 0, 60], payload: { tool_name: 'Y' } },
  ]);
  const viewModel = buildTurnViewModel(turn, {});
  const subkinds = viewModel.notices.map((n) => n.subkind);
  assert.ok(subkinds.includes('orphan_tool_result'));
  assert.ok(subkinds.includes('orphan_approval_requested'));
  assert.ok(subkinds.includes('invalid_tool_use'));
});

test('buildTurnViewModel/attachments: surfaces attachments and preserves their primary_message_id', () => {
  const turn = fabricateTurn('turn_attachments', [
    { event_id: 'u', kind: 'user_prompt', primary_message_id: 'u', source_message_ids: ['u'], sort_key: [0, 0, 10], payload: { content: 'hi' } },
    { event_id: 'att', kind: 'attachment_cluster', primary_message_id: 'u', source_message_ids: ['u'], sort_key: [0, 1, 15], payload: { attachments: [{ id: 'att_0', name: 'a.txt' }, { id: 'att_1', name: 'b.txt' }] } },
  ]);
  const viewModel = buildTurnViewModel(turn, {});
  assert.equal(viewModel.attachments.length, 2);
  assert.equal(viewModel.attachments[0].primaryMessageId, 'u');
  assert.equal(viewModel.attachments[1].name, 'b.txt');
});

test('buildTurnViewModel/interactive: batches and recaps are captured in order', () => {
  const turn = fabricateTurn('turn_interactive', [
    { event_id: 'u', kind: 'user_prompt', primary_message_id: 'u', source_message_ids: ['u'], sort_key: [0, 0, 10], payload: { content: 'hi' } },
    { event_id: 'b', kind: 'interactive_batch', primary_message_id: 'b', source_message_ids: ['b'], sort_key: [2, 0, 70], payload: { question_batch: { id: 'batch_0' } } },
    { event_id: 'r', kind: 'interactive_recap', primary_message_id: 'r', source_message_ids: ['r'], sort_key: [2, 0, 80], payload: { summary: 'recap' } },
  ]);
  const viewModel = buildTurnViewModel(turn, {});
  assert.equal(viewModel.interactive.batches.length, 1);
  assert.equal(viewModel.interactive.recaps.length, 1);
  assert.equal(viewModel.interactive.batches[0].questionBatch.id, 'batch_0');
  assert.equal(viewModel.interactive.recaps[0].payload.summary, 'recap');
});

test('buildTurnViewModel/suggestions: proactive_suggestion events are captured with their payload', () => {
  const turn = fabricateTurn('turn_suggestions', [
    { event_id: 'u', kind: 'user_prompt', primary_message_id: 'u', source_message_ids: ['u'], sort_key: [0, 0, 10], payload: { content: 'hi' } },
    { event_id: 's', kind: 'proactive_suggestion', primary_message_id: 's', source_message_ids: ['s'], sort_key: [2, 0, 90], payload: { proactive_suggestion: { id: 'sug_0', body: 'Try Y' } } },
  ]);
  const viewModel = buildTurnViewModel(turn, {});
  assert.equal(viewModel.suggestions.length, 1);
  assert.equal(viewModel.suggestions[0].suggestion.id, 'sug_0');
});

test('buildTurnViewModel/slashOutput: slash_output events are captured in order', () => {
  const turn = fabricateTurn('turn_slash', [
    { event_id: 'u', kind: 'user_prompt', primary_message_id: 'u', source_message_ids: ['u'], sort_key: [0, 0, 10], payload: { content: '/help' } },
    { event_id: 'so', kind: 'slash_output', primary_message_id: 'so', source_message_ids: ['so'], sort_key: [2, 0, 100], payload: { command: '/help', output: 'usage...' } },
  ]);
  const viewModel = buildTurnViewModel(turn, {});
  assert.equal(viewModel.slashOutput.length, 1);
  assert.equal(viewModel.slashOutput[0].payload.command, '/help');
});

test('buildTurnViewModel/carry: empty-entries reasoning as sole event becomes an orphan_carry notice', () => {
  const turn = fabricateTurn('turn_carry_only', [
    { event_id: 'r', kind: 'reasoning_phase', primary_message_id: 'r', source_message_ids: ['r'], sort_key: [0, 0, 5], phase_id: 'phase_empty', payload: { phase_id: 'phase_empty', entries: [] } },
  ]);
  const viewModel = buildTurnViewModel(turn, {});
  const orphanCarry = viewModel.notices.find((n) => n.subkind === 'orphan_carry');
  assert.ok(orphanCarry, 'expected an orphan_carry notice when the turn has no anchor');
  // The carry summary also captures the empty-entries reasoning event.
  assert.ok(viewModel.carry.some((c) => c.kind === 'reasoning_phase'));
});

test('buildTurnViewModel/carry: empty-entries reasoning alongside a user prompt does NOT emit orphan_carry (attached to an anchor)', () => {
  const turn = fabricateTurn('turn_carry_attached', [
    { event_id: 'u', kind: 'user_prompt', primary_message_id: 'u', source_message_ids: ['u'], sort_key: [0, 0, 10], payload: { content: 'hi' } },
    { event_id: 'r', kind: 'reasoning_phase', primary_message_id: 'r', source_message_ids: ['r'], sort_key: [0, 1, 5], phase_id: 'phase_empty', payload: { phase_id: 'phase_empty', entries: [] } },
  ]);
  const viewModel = buildTurnViewModel(turn, {});
  const orphanCarry = viewModel.notices.find((n) => n.subkind === 'orphan_carry');
  assert.equal(orphanCarry, undefined, 'orphan_carry should not be emitted when an anchor exists');
  assert.ok(viewModel.carry.some((c) => c.kind === 'reasoning_phase'));
});

// --- Phase 2C: composite projectTurn adoption -----------------------------

test('projectTurn/composite: returns both rows (with raw_terminal enrichment on tool rows) and view-model', () => {
  const { projectTurn } = require('../renderer/chat/renderer-turn-row-projector');
  const messages = [
    { id: 'user_comp', role: 'user', content: 'Go' },
    {
      id: 'tool_use_comp',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: { call_id: 'call_comp', tool_name: 'Write', parent_stream_id: 'comp', approval_state: 'preempted' },
    },
  ];
  const normalized = normalizeChatMessages(messages);
  const tree = projectTurnTree({ messages: normalized });
  const turn = tree.turns[0];
  const messageById = new Map();
  for (const m of normalized) messageById.set(m.id, m);
  const toolMessageIdsByCallId = new Map([['call_comp', ['tool_use_comp']]]);
  const { rows, viewModel } = projectTurn(turn, { messageById, toolMessageIdsByCallId });
  assert.ok(Array.isArray(rows));
  assert.ok(viewModel);
  assert.equal(viewModel.toolCalls.length, 1);
  // rawTerminal and canonical state come from the view-model: preempted
  // becomes visible state "cancelled" while raw substatus preempted survives.
  assert.equal(viewModel.toolCalls[0].rawTerminal, 'preempted');
  assert.equal(viewModel.toolCalls[0].state, 'cancelled');
  // Trace-only projection (B6/D1): the tool cluster emits a tool_call row (no
  // result event for this preempted Write, so no tool_result row). That row
  // gets raw_terminal enrichment AND, post-2F state convergence, payload.state
  // is overwritten with the view-model's canonical state so the projector +
  // view-model agree on one authority.
  const toolCall = rows.find((r) => r.kind === 'tool_call');
  assert.ok(toolCall);
  assert.equal(toolCall.payload.raw_terminal, 'preempted');
  assert.equal(toolCall.payload.state, 'cancelled');
});

test('projectTurn/composite: projectTurnRows direct call is NOT mutated (no raw_terminal leakage into fixture path)', () => {
  const { projectTurn, projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
  const messages = [
    { id: 'user_noleak', role: 'user', content: 'Go' },
    {
      id: 'tool_use_noleak',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: { call_id: 'call_noleak', tool_name: 'Write', parent_stream_id: 'noleak', approval_state: 'preempted' },
    },
  ];
  const normalized = normalizeChatMessages(messages);
  const tree = projectTurnTree({ messages: normalized });
  const turn = tree.turns[0];
  const directRows = projectTurnRows(turn.events);
  const toolCall = directRows.find((r) => r.kind === 'tool_call');
  assert.ok(toolCall);
  // Direct projectTurnRows path does NOT enrich — replay fixtures stay byte-stable.
  assert.equal(toolCall.payload.raw_terminal, undefined);
});

// --- Phase 2 follow-up: live-streaming event capture ----------------------

test('live-streaming reducer: retained events[] on turn state feed the canonical view-model before reconciliation', () => {
  const { createTurnReducerState, applyTurnStreamEvent } = require('../renderer/chat/renderer-turn-reducer');
  const state = createTurnReducerState();
  const turnId = 'live_turn_1';
  const base = {
    turn_id: turnId,
    primary_user_message_id: 'user_live',
    primary_assistant_message_id: 'asst_live',
  };
  applyTurnStreamEvent(state, {
    ...base,
    event_id: 'e0',
    event_seq: 0,
    kind: 'user_prompt',
    primary_message_id: 'user_live',
    source_message_ids: ['user_live'],
    sort_key: [0, 0, 10],
    payload: { content: 'hi' },
  });
  applyTurnStreamEvent(state, {
    ...base,
    event_id: 'e1',
    event_seq: 1,
    kind: 'tool_use',
    primary_message_id: 'asst_live',
    source_message_ids: ['asst_live'],
    tool_call_id: 'call_live',
    status: 'pending_approval',
    sort_key: [1, 0, 40],
    payload: { tool_name: 'Write', approval_state: 'pending' },
  });
  const turn = state.turns_by_id[turnId];
  assert.ok(turn);
  assert.ok(Array.isArray(turn.events));
  assert.equal(turn.events.length, 2);
  const viewModel = buildTurnViewModel(
    { turn_id: turnId, events: turn.events, primary_user_message_id: turn.primary_user_message_id, primary_assistant_message_id: turn.primary_assistant_message_id },
    {}
  );
  assert.equal(viewModel.toolCalls.length, 1);
  assert.equal(viewModel.toolCalls[0].state, 'awaiting_approval');
  assert.equal(viewModel.phaseHint, 'awaiting_approval');
});

// --- Phase 2D: classic-shell adapter ---------------------------------------

test('classic-shell adapter: canonical toolCall drives status and rawTerminal on the transcript view-model', () => {
  const { createTranscriptToolCallRenderer } = require('../renderer/chat/renderer-transcript-tool-calls');
  const renderer = createTranscriptToolCallRenderer({
    escapeHtml: (s) => String(s || ''),
    toolCallUtils: {
      getToolIcon: () => 'icon',
      getStatusLabel: (status) => `label:${status}`,
      formatToolCallSummary: () => 'summary',
      getToolDisplayName: (name) => name || 'Tool',
      normalizeToolKind: (name) => name || '',
    },
  });
  const message = { id: 'tool_use_x', role: 'assistant', kind: 'tool_use', tool_call: { call_id: 'call_x', tool_name: 'Write' } };
  const projectedToolRow = {
    turn_id: 't',
    row_id: 'row:t',
    kind: 'tool_step',
    tool_call_id: 'call_x',
    source_message_ids: ['tool_use_x'],
    payload: { tool_call_id: 'call_x', tool_name: 'Write', state: 'abandoned', raw_terminal: 'preempted', output_text: '', result_summary: '' },
  };
  const canonicalToolCall = {
    toolCallId: 'call_x',
    toolName: 'Write',
    toolDisplayName: 'Write',
    state: 'cancelled',
    rawTerminal: 'preempted',
    input: {},
    inputJson: '',
    summary: '',
    durationMs: 0,
  };
  const vm = renderer.buildToolCallViewModel(message, [message], { projectedToolRow, canonicalToolCall });
  // Classic shell now consumes canonical state so preempted → visible cancelled,
  // and rawTerminal is preserved in the transcript view-model for consumers.
  assert.equal(vm.status, 'cancelled');
  assert.equal(vm.rawTerminal, 'preempted');
});

test('buildTurnViewModel/purity: calling the builder twice with the same turn yields a deep-equal view-model', () => {
  const messages = [
    { id: 'user_pure', role: 'user', content: 'Go' },
    {
      id: 'tool_use_pure',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: { call_id: 'call_pure', tool_name: 'Read', parent_stream_id: 'pure', status: 'completed' },
    },
    {
      id: 'tool_result_pure',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: { call_id: 'call_pure', tool_name: 'Read', output_text: 'ok', parent_stream_id: 'pure' },
    },
  ];
  const a = buildViewModelFromMessages(messages);
  const b = buildViewModelFromMessages(messages);
  assert.deepEqual(a, b);
});

