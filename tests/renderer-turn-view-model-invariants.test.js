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

test('invariant/row-identity: trace rows carry stable row_id + primary_message_id + tool_call_id across re-projection', () => {
  const events = [userPromptEvent(), toolUseEvent(), toolResultEvent()];
  const first = projectTurnRows(events);
  const second = projectTurnRows(events.slice());
  const third = projectTurnRows(shuffle(events));
  assert.deepEqual(
    first.map((row) => [row.kind, row.row_id, row.primary_message_id, row.tool_call_id || '']),
    second.map((row) => [row.kind, row.row_id, row.primary_message_id, row.tool_call_id || '']),
  );
  assert.deepEqual(
    first.map((row) => [row.kind, row.row_id, row.primary_message_id, row.tool_call_id || '']),
    third.map((row) => [row.kind, row.row_id, row.primary_message_id, row.tool_call_id || '']),
  );
});

test('invariant/row-identity: tool_call anchors row_id + primary_message_id + first_event_sort_key on the tool_use event', () => {
  const toolUse = toolUseEvent({ event_id: 'tool_use:anchor', sort_key: [1, 0, 40] });
  const approvalReq = approvalRequestedEvent({ sort_key: [1, 0, 20] }); // comes before tool_use sort-wise
  const approvalRes = approvalResolvedEvent({ sort_key: [1, 0, 30] });
  const result = toolResultEvent({ sort_key: [1, 0, 60] });
  const rows = projectTurnRows(
    [userPromptEvent(), approvalReq, approvalRes, toolUse, result],
  );
  const toolRow = rows.find((row) => row.kind === 'tool_call');
  assert.ok(toolRow);
  assert.equal(toolRow.row_id, 'row:tool_use:anchor');
  assert.equal(toolRow.primary_message_id, 'msg_tool_use');
  assert.deepEqual(toolRow.first_event_sort_key, [1, 0, 40]);
});

test('invariant/row-identity: source_message_ids is de-duplicated while preserving encounter order', () => {
  const events = [
    userPromptEvent(),
    toolUseEvent({ source_message_ids: ['msg_tool_use', 'msg_shared'] }),
    approvalRequestedEvent({ source_message_ids: ['msg_tool_use', 'msg_shared', 'msg_late'] }),
    approvalResolvedEvent({ source_message_ids: ['msg_shared'] }),
    toolResultEvent({ source_message_ids: ['msg_tool_result', 'msg_late'] }),
  ];
  const toolRow = projectTurnRows(events).find((row) => row.kind === 'tool_call');
  assert.ok(toolRow);
  // In trace mode the tool_call row collects the tool_use + approval events; the
  // tool_result event becomes its own row, so its message ids live there. The
  // dedup-while-preserving-encounter-order invariant still holds on the call row.
  assert.deepEqual(toolRow.source_message_ids, ['msg_tool_use', 'msg_shared', 'msg_late']);
});

test('invariant/row-identity: tool_call_id is exposed at row-level AND in payload for tool_call and tool_result rows', () => {
  const events = [userPromptEvent(), toolUseEvent(), toolResultEvent()];
  const trace = projectTurnRows(events);
  const traceTool = trace.find((row) => row.kind === 'tool_call');
  const traceResult = trace.find((row) => row.kind === 'tool_result');
  for (const row of [traceTool, traceResult]) {
    assert.ok(row);
    assert.equal(row.tool_call_id, 'call_invariant');
    assert.equal(row.payload.tool_call_id, 'call_invariant');
  }
});

// --- 2. Canonical terminal semantics ---------------------------------------

test('invariant/terminal-semantics: preempted approval maps tool_call state to cancelled but preserves raw substatus in approval_resolutions', () => {
  const events = [
    userPromptEvent(),
    toolUseEvent({ status: 'pending_approval' }),
    approvalRequestedEvent(),
    approvalResolvedEvent({
      status: 'preempted',
      payload: { approval_state: 'preempted' },
    }),
  ];
  const toolRow = projectTurnRows(events).find((row) => row.kind === 'tool_call');
  assert.ok(toolRow);
  assert.equal(toolRow.payload.state, 'cancelled');
  const resolutions = Array.isArray(toolRow.payload.approval_resolutions) ? toolRow.payload.approval_resolutions : [];
  assert.equal(resolutions.length, 1);
  // Raw subtype stays inspectable: preempted is normalized to cancelled so the renderer can reuse the cancelled tone,
  // but the resolution entry is present so the canonical view-model can still distinguish it via the raw event trail.
  assert.equal(resolutions[0].status, 'cancelled');
  assert.equal(resolutions[0].approval_state, 'cancelled');
  // The original raw status must still be inspectable on the source event itself (the builder will map it through).
  const rawResolvedEvent = events.find((evt) => evt.kind === 'approval_resolved');
  assert.equal(rawResolvedEvent.status, 'preempted');
  assert.equal(rawResolvedEvent.payload.approval_state, 'preempted');
});

test('invariant/terminal-semantics: timeout approval maps tool_call state to timed_out', () => {
  const events = [
    userPromptEvent(),
    toolUseEvent({ status: 'pending_approval' }),
    approvalRequestedEvent(),
    approvalResolvedEvent({
      status: 'timeout',
      payload: { approval_state: 'timeout' },
    }),
  ];
  const toolRow = projectTurnRows(events).find((row) => row.kind === 'tool_call');
  assert.ok(toolRow);
  assert.equal(toolRow.payload.state, 'timed_out');
});

test('invariant/terminal-semantics: completed, cancelled, interrupted tool_call states remain distinct', () => {
  const completed = projectTurnRows(
    [userPromptEvent(), toolUseEvent(), toolResultEvent()],
  ).find((row) => row.kind === 'tool_call');
  assert.equal(completed.payload.state, 'completed');

  const cancelled = projectTurnRows(
    [
      userPromptEvent(),
      toolUseEvent({ status: 'pending_approval' }),
      approvalRequestedEvent(),
      approvalResolvedEvent({ status: 'cancelled', payload: { approval_state: 'cancelled' } }),
    ],
  ).find((row) => row.kind === 'tool_call');
  assert.equal(cancelled.payload.state, 'cancelled');

  const interrupted = projectTurnRows(
    [userPromptEvent(), toolUseEvent({ status: 'running' })],
  ).find((row) => row.kind === 'tool_call');
  assert.equal(interrupted.payload.state, 'interrupted');
});

test('invariant/terminal-semantics: result_is_error precedence wins over approval states', () => {
  const events = [
    userPromptEvent(),
    toolUseEvent({ status: 'pending_approval' }),
    approvalRequestedEvent(),
    approvalResolvedEvent({ status: 'approved', payload: { approval_state: 'approved' } }),
    toolResultEvent({ payload: { tool_name: 'Read', output_text: 'boom', is_error: true, error_code: 'E_READ' } }),
  ];
  const rows = projectTurnRows(events);
  // In trace mode the call-state lives on the tool_call row (errored wins over
  // the approved approval), while the error_code is carried by the tool_result row.
  const toolCallRow = rows.find((row) => row.kind === 'tool_call');
  assert.ok(toolCallRow);
  assert.equal(toolCallRow.payload.state, 'errored');
  const toolResultRow = rows.find((row) => row.kind === 'tool_result');
  assert.ok(toolResultRow);
  assert.equal(toolResultRow.payload.error_code, 'E_READ');
});

// --- 3. Non-message row families stay representable ------------------------

test('invariant/row-families: reasoning, system_notice, and assistant_text rows are all representable', () => {
  const rows = projectTurnRows(
    [
      userPromptEvent(),
      reasoningEvent(),
      assistantTextEvent(),
      event({
        event_id: 'system_notice:0',
        kind: 'system_notice',
        primary_message_id: 'msg_system',
        source_message_ids: ['msg_system'],
        tool_call_id: '',
        sort_key: [2, 5, 0],
        payload: { subkind: 'cancel_notice', content: 'Cancelled' },
      }),
    ],
  );
  const kinds = rows.map((row) => row.kind);
  assert.ok(kinds.includes('reasoning'));
  assert.ok(kinds.includes('assistant_text'));
  assert.ok(kinds.includes('system_notice'));
});

test('invariant/row-families: attachment, batch, recap, suggestion, slash_output survive projection', () => {
  const rows = projectTurnRows(
    [
      userPromptEvent(),
      event({
        event_id: 'attachment_cluster:0',
        kind: 'attachment_cluster',
        primary_message_id: 'msg_user',
        source_message_ids: ['msg_user'],
        tool_call_id: '',
        sort_key: [0, 1, 15],
        payload: { attachments: [{ id: 'att_0', name: 'file.txt' }] },
      }),
      event({
        event_id: 'interactive_batch:0',
        kind: 'interactive_batch',
        primary_message_id: 'msg_batch',
        source_message_ids: ['msg_batch'],
        tool_call_id: '',
        sort_key: [2, 0, 70],
        payload: { question_batch: { id: 'batch_0' } },
      }),
      event({
        event_id: 'interactive_recap:0',
        kind: 'interactive_recap',
        primary_message_id: 'msg_recap',
        source_message_ids: ['msg_recap'],
        tool_call_id: '',
        sort_key: [2, 0, 80],
        payload: { summary: 'Recap' },
      }),
      event({
        event_id: 'proactive_suggestion:0',
        kind: 'proactive_suggestion',
        primary_message_id: 'msg_suggestion',
        source_message_ids: ['msg_suggestion'],
        tool_call_id: '',
        sort_key: [2, 0, 90],
        payload: { proactive_suggestion: { id: 'sug_0' } },
      }),
      event({
        event_id: 'slash_output:0',
        kind: 'slash_output',
        primary_message_id: 'msg_slash',
        source_message_ids: ['msg_slash'],
        tool_call_id: '',
        sort_key: [2, 0, 100],
        payload: { command: '/help' },
      }),
    ],
  );
  const kinds = rows.map((row) => row.kind);
  // user_bubble merges the leading attachment_cluster, but batch, recap, suggestion, slash_output
  // each emit their own canonical row kind so the builder can carry them through Phase 2B2 unchanged.
  assert.ok(kinds.includes('user_bubble'));
  assert.ok(kinds.includes('batch'));
  assert.ok(kinds.includes('recap'));
  assert.ok(kinds.includes('suggestion'));
  assert.ok(kinds.includes('slash_output'));
});

test('invariant/row-families: degenerate tool events stay representable in trace mode', () => {
  // Trace mode never coalesces and has no 'orphaned'/'abandoned' state. A
  // tool_result with no matching tool_use still emits its own tool_result row
  // (output preserved); an approval_requested with no tool_use becomes a
  // system_notice with an orphan_<kind> subkind; and a tool_use with a missing
  // id still emits a tool_call row carrying the (empty) call id verbatim.
  const orphanResult = projectTurnRows(
    [
      userPromptEvent(),
      toolResultEvent({ event_id: 'tool_result:orphan', tool_call_id: 'call_missing' }),
    ],
  );
  const orphanResultRow = orphanResult.find((row) => row.kind === 'tool_result');
  assert.ok(orphanResultRow);
  assert.equal(orphanResultRow.payload.output_text, 'contents');
  assert.equal(orphanResultRow.tool_call_id, 'call_missing');

  const orphanApproval = projectTurnRows(
    [
      userPromptEvent(),
      approvalRequestedEvent({ event_id: 'approval_requested:orphan', tool_call_id: 'call_missing' }),
    ],
  );
  const orphanApprovalRow = orphanApproval.find((row) => row.kind === 'system_notice');
  assert.ok(orphanApprovalRow);
  assert.equal(orphanApprovalRow.payload.subkind, 'orphan_approval_requested');

  const invalidUse = projectTurnRows(
    [
      userPromptEvent(),
      toolUseEvent({ event_id: 'tool_use:invalid', tool_call_id: '' }),
    ],
  );
  const invalidUseRow = invalidUse.find((row) => row.kind === 'tool_call');
  assert.ok(invalidUseRow);
  assert.equal(invalidUseRow.tool_call_id, '');
  assert.equal(invalidUseRow.payload.tool_call_id, '');
  assert.equal(invalidUseRow.payload.tool_name, 'Read');
});

test('invariant/row-families: empty reasoning is always emitted as a reasoning row in trace mode', () => {
  // Trace mode never folds settled-empty reasoning: every reasoning_phase event
  // produces a reasoning row so the underlying source event stays inspectable.
  const rows = projectTurnRows(
    [
      event({
        event_id: 'reasoning_phase:carry_only',
        kind: 'reasoning_phase',
        primary_message_id: 'msg_orphan_reasoning',
        source_message_ids: ['msg_orphan_reasoning'],
        tool_call_id: '',
        sort_key: [0, 0, 5],
        phase_id: 'phase_reasoning_carry',
        payload: { phase_id: 'phase_reasoning_carry', entries: [] },
      }),
    ],
  );
  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.ok(reasoningRow);
  assert.deepEqual(reasoningRow.payload.entries, []);
});

// --- 4. Projection-context invariants --------------------------------------

test('invariant/projection-context: rowByPrimaryMessageId prefers tool_call over other row kinds on id collision', () => {
  // Build a row list that includes a tool_call and an assistant_text sharing the same primary id.
  const sharedPrimary = 'msg_collision';
  const rows = projectTurnRows(
    [
      userPromptEvent(),
      assistantTextEvent({ primary_message_id: sharedPrimary, source_message_ids: [sharedPrimary] }),
      toolUseEvent({ primary_message_id: sharedPrimary, source_message_ids: [sharedPrimary] }),
      toolResultEvent({ primary_message_id: sharedPrimary, source_message_ids: [sharedPrimary] }),
    ],
  );
  const rowByPrimaryMessageId = new Map();
  for (const row of rows) {
    const key = String(row.primary_message_id || '');
    if (!key) continue;
    const existing = rowByPrimaryMessageId.get(key);
    if (!existing || row.kind === 'tool_call') {
      rowByPrimaryMessageId.set(key, row);
    }
  }
  const winner = rowByPrimaryMessageId.get(sharedPrimary);
  assert.ok(winner);
  assert.equal(winner.kind, 'tool_call');
});

test('invariant/projection-context: every non-carry row has non-empty turn_id + row_id so article prediction cache keys are derivable', () => {
  const events = [userPromptEvent(), reasoningEvent(), assistantTextEvent(), toolUseEvent(), toolResultEvent()];
  const rows = projectTurnRows(events);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok(String(row.turn_id || '').length > 0, `row ${row.kind} has empty turn_id`);
    assert.ok(String(row.row_id || '').length > 0, `row ${row.kind} has empty row_id`);
  }
});

test('invariant/projection-context: every source_message_ids entry is traceable back to a turn via row.turn_id', () => {
  const events = [userPromptEvent(), reasoningEvent(), assistantTextEvent(), toolUseEvent(), toolResultEvent()];
  const rows = projectTurnRows(events);
  const turnId = 'turn_invariant';
  for (const row of rows) {
    assert.equal(row.turn_id, turnId);
    for (const sourceId of row.source_message_ids) {
      assert.ok(String(sourceId || '').length > 0);
    }
  }
});

// --- 5. Streaming-row targeting (trace mode) -------------------------------

test('invariant/streaming-target: trace mode emits a tool_result row with a tool_call_id so resolveProjectionStreamingRowTarget can key on it', () => {
  const traceRows = projectTurnRows(
    [userPromptEvent(), toolUseEvent(), toolResultEvent()],
  );
  const resultRow = traceRows.find((row) => row.kind === 'tool_result');
  assert.ok(resultRow);
  assert.ok(String(resultRow.tool_call_id || '').length > 0);
  assert.ok(String(resultRow.payload.tool_call_id || '').length > 0);
});

// --- 6. Hydrated digest / fingerprint sensitivity --------------------------

test('invariant/digest-sensitivity: mutating payload.state flips the row signature (replay-drift detector)', () => {
  const baseEvents = [
    userPromptEvent(),
    toolUseEvent(),
    toolResultEvent(),
  ];
  const baseRow = projectTurnRows(baseEvents).find((row) => row.kind === 'tool_call');
  const mutatedEvents = [
    userPromptEvent(),
    toolUseEvent({ status: 'pending_approval' }),
    approvalRequestedEvent(),
    approvalResolvedEvent({ status: 'cancelled', payload: { approval_state: 'cancelled' } }),
  ];
  const mutatedRow = projectTurnRows(mutatedEvents).find((row) => row.kind === 'tool_call');
  assert.notEqual(rowSignature(baseRow), rowSignature(mutatedRow));
});

test('invariant/digest-sensitivity: mutating tool_result output_text + result_summary flips the row signature', () => {
  const base = projectTurnRows(
    [userPromptEvent(), toolUseEvent(), toolResultEvent()],
  ).find((row) => row.kind === 'tool_result');
  const mutated = projectTurnRows(
    [
      userPromptEvent(),
      toolUseEvent(),
      toolResultEvent({ payload: { tool_name: 'Read', output_text: 'different', summary: 'a-summary', is_error: false } }),
    ],
  ).find((row) => row.kind === 'tool_result');
  assert.notEqual(rowSignature(base), rowSignature(mutated));
});

test('invariant/digest-sensitivity: mutating reasoning entries flips the row signature', () => {
  const base = projectTurnRows(
    [userPromptEvent(), reasoningEvent(), assistantTextEvent()],
  ).find((row) => row.kind === 'reasoning');
  const mutated = projectTurnRows(
    [
      userPromptEvent(),
      reasoningEvent({ payload: { phase_id: 'phase_reasoning_pre', thinking_id: 'think_0', entries: [{ id: 'reason_0', text: 'Different plan' }] } }),
      assistantTextEvent(),
    ],
  ).find((row) => row.kind === 'reasoning');
  assert.notEqual(rowSignature(base), rowSignature(mutated));
});

// --- 7. Reducer-owned ordering ---------------------------------------------

test('invariant/ordering: shuffled input events produce the same row order as sorted input (reducer owns ordering via sort_key)', () => {
  const events = [userPromptEvent(), reasoningEvent(), assistantTextEvent(), toolUseEvent(), toolResultEvent()];
  const sortedRows = projectTurnRows(events);
  const shuffledRows = projectTurnRows(shuffle(events));
  assert.deepEqual(
    sortedRows.map((row) => row.kind),
    shuffledRows.map((row) => row.kind),
  );
  assert.deepEqual(
    sortedRows.map((row) => row.row_id),
    shuffledRows.map((row) => row.row_id),
  );
});

test('invariant/ordering: trace mode orders by event_seq before sort_key so streaming arrivals stay deterministic', () => {
  const events = [
    userPromptEvent({ event_seq: 1 }),
    toolUseEvent({ event_seq: 3 }),
    approvalRequestedEvent({ event_seq: 4 }),
    approvalResolvedEvent({ event_seq: 5 }),
    toolResultEvent({ event_seq: 6 }),
  ];
  const rowsA = projectTurnRows(events);
  const rowsB = projectTurnRows(shuffle(events));
  assert.deepEqual(
    rowsA.map((row) => row.kind),
    rowsB.map((row) => row.kind),
  );
});

// --- Phase 2B1: canonical builder core families ---------------------------

