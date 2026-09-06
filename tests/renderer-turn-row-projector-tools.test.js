const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectTurnRows,
} = require('./helpers/renderer-turn-row-projector-helpers');

test('projectTurnRows clones tool input payloads so row projection stays pure', () => {
  const sourceInput = { path: 'notes.md' };
  const rows = projectTurnRows([
    {
      event_id: 'turn_clone:user_prompt:0',
      turn_id: 'turn_clone',
      kind: 'user_prompt',
      primary_message_id: 'user_clone',
      source_message_ids: ['user_clone'],
      sort_key: [0, 0, 10],
      payload: { content: 'Read the notes', attachments: [] },
    },
    {
      event_id: 'turn_clone:tool_use:0',
      turn_id: 'turn_clone',
      kind: 'tool_use',
      primary_message_id: 'tool_use_clone',
      source_message_ids: ['tool_use_clone'],
      sort_key: [1, 0, 40],
      tool_call_id: 'call_clone',
      status: 'requested',
      payload: {
        tool_name: 'Read',
        input: sourceInput,
        input_json: '{"path":"notes.md"}',
        summary: 'read notes.md',
      },
    },
  ]);

  const toolRow = rows.find((row) => row.kind === 'tool_call');
  assert.ok(toolRow);
  assert.notEqual(toolRow.payload.input, sourceInput);

  toolRow.payload.input.path = 'mutated.md';
  assert.equal(sourceInput.path, 'notes.md');
});

test('projectTurnRows never buckets independent blank-id tool events together', () => {
  const events = [
    ['tool_use', 0, 'tool-use-a', { tool_name: 'Read', input: { path: 'a.txt' } }],
    ['tool_result', 1, 'tool-result-a', { tool_name: 'Read', output_text: 'A', is_error: false }],
    ['tool_use', 2, 'tool-use-b', { tool_name: 'Read', input: { path: 'b.txt' } }],
    ['tool_result', 3, 'tool-result-b', { tool_name: 'Read', output_text: 'B', is_error: false }],
  ].map(([kind, index, messageId, payload]) => ({
    event_id: `turn_blank:${kind}:${index}`,
    turn_id: 'turn_blank',
    kind,
    primary_message_id: messageId,
    source_message_ids: [messageId],
    sort_key: [index, 0, kind === 'tool_use' ? 40 : 50],
    tool_call_id: '',
    status: kind === 'tool_use' ? 'requested' : 'completed',
    payload,
  }));

  const rows = projectTurnRows(events);
  const toolRows = rows.filter((row) => row.kind === 'tool_call' || row.kind === 'tool_result');
  assert.equal(toolRows.length, 4);
  assert.deepEqual(toolRows.map((row) => row.source_events.length), [1, 1, 1, 1]);
  assert.deepEqual(toolRows.map((row) => row.primary_message_id), [
    'tool-use-a', 'tool-result-a', 'tool-use-b', 'tool-result-b',
  ]);
});

test('projectTurnRows preserves policy-owned approval context for rehydrated cards', () => {
  const initialReason = 'Tool-use approval reason';
  const laterReason = 'Later approval-event reason';
  const events = [
    {
      event_id: 'turn_policy:tool_use:0',
      turn_id: 'turn_policy',
      kind: 'tool_use',
      primary_message_id: 'tool_use_policy',
      source_message_ids: ['tool_use_policy'],
      sort_key: [0, 0, 40],
      tool_call_id: 'call_policy',
      status: 'pending_approval',
      payload: {
        tool_name: 'write_file',
        input: { path: 'notes.md' },
        input_json: '{"path":"notes.md"}',
        policy_scope: 'Workspace files',
        policy_consequence: 'May change data in this scope.',
        reason: initialReason,
      },
    },
    {
      event_id: 'turn_policy:approval_requested:0',
      turn_id: 'turn_policy',
      kind: 'approval_requested',
      primary_message_id: 'tool_use_policy',
      source_message_ids: ['tool_use_policy'],
      sort_key: [0, 1, 45],
      tool_call_id: 'call_policy',
      status: 'pending_approval',
      payload: {
        approval_state: 'pending',
        policy_scope: 'Workspace files',
        policy_consequence: 'May change data in this scope.',
        reason: laterReason,
      },
    },
  ];
  const rows = projectTurnRows(events);

  const gapRow = rows.find((row) => row.kind === 'approval_gap');
  assert.ok(gapRow);
  assert.equal(gapRow.payload.policy_scope, 'Workspace files');
  assert.equal(gapRow.payload.policy_consequence, 'May change data in this scope.');
  assert.equal(gapRow.payload.reason, laterReason);
  // The card previews the full input object; input_json is only the capped fallback.
  assert.deepEqual(gapRow.payload.input, { path: 'notes.md' });
  assert.notEqual(gapRow.payload.input, events[0].payload.input, 'the gap row owns its copy');
  assert.equal(gapRow.payload.input_json, '{"path":"notes.md"}');

  const initialRows = projectTurnRows(events.map((event) => (
    event.kind === 'approval_requested'
      ? { ...event, payload: { ...event.payload, reason: '' } }
      : event
  )));
  assert.equal(initialRows.find((row) => row.kind === 'approval_gap').payload.reason, initialReason);
});

test('projectTurnRows classifies user_questions_requested into the existing ask_user tool_call row', () => {
  const questionEvent = {
    event_id: 'turn_questions:user_questions_requested:0',
    turn_id: 'turn_questions',
    kind: 'user_questions_requested',
    primary_message_id: 'tool_use_questions',
    source_message_ids: ['tool_use_questions'],
    sort_key: [0, 1, 45],
    tool_call_id: 'call_questions',
    status: 'pending_user_input',
    payload: {
      tool_name: 'ask_user',
      question_ref: 'question-ref',
      questions: [{ id: 'choice', prompt: 'Choose', options: ['A', 'B'], multi_select: false, allow_other: false }],
    },
  };
  const rows = projectTurnRows([{
    event_id: 'turn_questions:tool_use:0', turn_id: 'turn_questions', kind: 'tool_use',
    primary_message_id: 'tool_use_questions', source_message_ids: ['tool_use_questions'],
    sort_key: [0, 0, 40], tool_call_id: 'call_questions', status: 'running',
    payload: { tool_name: 'ask_user', input: { questions: [] }, summary: 'Ask user' },
  }, questionEvent]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'tool_call');
  assert.equal(rows[0].tool_call_id, 'call_questions');
  assert.equal(rows[0].payload.state, 'pending_user_input');
  assert.equal(rows[0].payload.question_ref, 'question-ref');
  assert.deepEqual(rows[0].payload.user_questions, questionEvent.payload.questions);
  assert.notEqual(rows[0].payload.user_questions, questionEvent.payload.questions);
  assert.deepEqual(rows[0].source_events.sort(), [
    'turn_questions:tool_use:0', 'turn_questions:user_questions_requested:0',
  ]);
});

test('projectTurnRows stamps cloned ask_user result metadata onto the settled tool_call row', () => {
  const answers = [
    { id: 'single', value: 'A' },
    { id: 'multi', value: ['B', 'C'], other: 'D' },
  ];
  const rows = projectTurnRows([
    {
      event_id: 'turn_questions_settled:tool_use:0',
      turn_id: 'turn_questions_settled',
      kind: 'tool_use',
      primary_message_id: 'tool_use_questions_settled',
      source_message_ids: ['tool_use_questions_settled'],
      sort_key: [0, 0, 40],
      tool_call_id: 'call_questions_settled',
      status: 'running',
      payload: { tool_name: 'ask_user', input: { questions: [] }, summary: 'Ask user' },
    },
    {
      event_id: 'turn_questions_settled:user_questions_requested:0',
      turn_id: 'turn_questions_settled',
      kind: 'user_questions_requested',
      primary_message_id: 'tool_use_questions_settled',
      source_message_ids: ['tool_use_questions_settled'],
      sort_key: [0, 1, 45],
      tool_call_id: 'call_questions_settled',
      status: 'pending_user_input',
      payload: {
        tool_name: 'ask_user',
        question_ref: 'question-ref',
        questions: [{ id: 'single', prompt: 'Choose', options: ['A'], multi_select: false, allow_other: false }],
      },
    },
    {
      event_id: 'turn_questions_settled:tool_result:0',
      turn_id: 'turn_questions_settled',
      kind: 'tool_result',
      primary_message_id: 'tool_use_questions_settled',
      tool_result_message_id: 'tool_result_questions_settled',
      source_message_ids: ['tool_use_questions_settled', 'tool_result_questions_settled'],
      sort_key: [1, 0, 50],
      tool_call_id: 'call_questions_settled',
      status: 'completed',
      payload: {
        tool_name: 'ask_user', output_text: 'answered', is_error: false,
        metadata: { result_kind: 'user_questions_answered', answers },
      },
    },
  ]);

  const toolRow = rows.find((row) => row.kind === 'tool_call');
  assert.ok(toolRow);
  assert.equal(toolRow.payload.state, 'completed');
  assert.equal(toolRow.payload.user_questions_result_kind, 'user_questions_answered');
  assert.deepEqual(toolRow.payload.user_questions_answers, answers);
  assert.notEqual(toolRow.payload.user_questions_answers, answers);
  assert.notEqual(toolRow.payload.user_questions_answers[1], answers[1]);
  assert.notEqual(toolRow.payload.user_questions_answers[1].value, answers[1].value);
});

test('projectTurnRows emits separate tool_call and tool_result rows when a tool result appears before tool_use', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_edge:user_prompt:0',
      turn_id: 'turn_edge',
      kind: 'user_prompt',
      primary_message_id: 'user_edge',
      source_message_ids: ['user_edge'],
      sort_key: [0, 0, 10],
      payload: { content: 'Check edge ordering', attachments: [] },
    },
    {
      event_id: 'turn_edge:tool_result:0',
      turn_id: 'turn_edge',
      kind: 'tool_result',
      primary_message_id: 'tool_result_edge',
      source_message_ids: ['tool_result_edge'],
      sort_key: [1, 0, 50],
      tool_call_id: 'call_edge',
      payload: { tool_name: 'Read', output_text: 'done', summary: 'ok', is_error: false },
    },
    {
      event_id: 'turn_edge:tool_use:0',
      turn_id: 'turn_edge',
      kind: 'tool_use',
      primary_message_id: 'tool_use_edge',
      source_message_ids: ['tool_use_edge'],
      sort_key: [2, 0, 40],
      tool_call_id: 'call_edge',
      status: 'requested',
      payload: { tool_name: 'Read', input: { path: 'edge.txt' }, input_json: '{"path":"edge.txt"}', summary: 'read edge.txt' },
    },
  ]);

  const callRow = rows.find((row) => row.kind === 'tool_call');
  assert.ok(callRow);
  assert.equal(callRow.tool_call_id, 'call_edge');
  assert.equal(callRow.primary_message_id, 'tool_use_edge');
  assert.equal(callRow.row_id, 'row:turn_edge:tool_use:0');
  assert.deepEqual(callRow.first_event_sort_key, [2, 0, 40]);
  assert.deepEqual(callRow.source_events, ['turn_edge:tool_use:0']);
  assert.deepEqual(callRow.source_message_ids, ['tool_use_edge']);

  const resultRow = rows.find((row) => row.kind === 'tool_result');
  assert.ok(resultRow);
  assert.equal(resultRow.tool_call_id, 'call_edge');
  assert.equal(resultRow.row_id, 'row:turn_edge:tool_result:0');
  assert.equal(resultRow.payload.state, 'completed');
  assert.equal(resultRow.payload.output_text, 'done');
});

test('projectTurnRows anchors the tool_call on the visible tool_use even when approval and execution events sort ahead of it', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_edge2:user_prompt:0',
      turn_id: 'turn_edge2',
      kind: 'user_prompt',
      primary_message_id: 'user_edge2',
      source_message_ids: ['user_edge2'],
      sort_key: [0, 0, 10],
      payload: { content: 'Run it', attachments: [] },
    },
    {
      event_id: 'turn_edge2:approval_requested:0',
      turn_id: 'turn_edge2',
      kind: 'approval_requested',
      primary_message_id: 'tool_use_edge2',
      source_message_ids: ['tool_use_edge2'],
      sort_key: [1, 0, 45],
      tool_call_id: 'call_edge2',
      status: 'pending_approval',
      payload: { approval_state: 'pending' },
    },
    {
      event_id: 'turn_edge2:tool_executing:0',
      turn_id: 'turn_edge2',
      kind: 'tool_executing',
      primary_message_id: 'tool_use_edge2',
      source_message_ids: ['tool_use_edge2'],
      sort_key: [2, 0, 47],
      tool_call_id: 'call_edge2',
      status: 'running',
      payload: { tool_name: 'Write' },
    },
    {
      event_id: 'turn_edge2:tool_use:0',
      turn_id: 'turn_edge2',
      kind: 'tool_use',
      primary_message_id: 'tool_use_edge2',
      source_message_ids: ['tool_use_edge2'],
      sort_key: [3, 0, 40],
      tool_call_id: 'call_edge2',
      status: 'running',
      payload: { tool_name: 'Write', input: { path: 'out.txt' }, input_json: '{"path":"out.txt"}', summary: 'write out.txt' },
    },
  ]);

  // TRACE never coalesces: tool-related events that sort ahead of the
  // tool_use are already emitted as standalone (orphan) system_notice rows by
  // the time the tool_use bucket scan runs, so the tool_call row anchors purely
  // on the visible tool_use event. The running tool_use status still drives the
  // interrupted state.
  const toolRow = rows.find((row) => row.kind === 'tool_call');
  assert.ok(toolRow);
  assert.equal(toolRow.primary_message_id, 'tool_use_edge2');
  assert.equal(toolRow.row_id, 'row:turn_edge2:tool_use:0');
  assert.deepEqual(toolRow.first_event_sort_key, [3, 0, 40]);
  assert.deepEqual(toolRow.source_events, ['turn_edge2:tool_use:0']);
  assert.equal(toolRow.payload.state, 'interrupted');

  const noticeSubkinds = rows
    .filter((row) => row.kind === 'system_notice')
    .map((row) => row.payload.subkind);
  assert.deepEqual(noticeSubkinds, ['orphan_approval_requested', 'orphan_tool_executing']);
});

test('projectTurnRows keeps tool row sort anchoring on the visible tool_use even when reasoning precedes it', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_carry:user_prompt:0',
      turn_id: 'turn_carry',
      kind: 'user_prompt',
      primary_message_id: 'user_carry',
      source_message_ids: ['user_carry'],
      sort_key: [0, 0, 10],
      payload: { content: 'Carry before tool', attachments: [] },
    },
    {
      event_id: 'turn_carry:reasoning_phase:0',
      turn_id: 'turn_carry',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_carry',
      source_message_ids: ['assistant_carry'],
      sort_key: [1, 0, 20],
      phase_id: 'phase_empty',
      status: 'completed',
      completed_at: '2026-05-12T10:00:00.000Z',
      payload: {
        phase_id: 'phase_empty',
        thinking_id: 'think_empty',
        completed_at: '2026-05-12T10:00:00.000Z',
        entries: [],
      },
    },
    {
      event_id: 'turn_carry:tool_use:0',
      turn_id: 'turn_carry',
      kind: 'tool_use',
      primary_message_id: 'tool_use_carry',
      source_message_ids: ['tool_use_carry'],
      sort_key: [2, 0, 40],
      tool_call_id: 'call_carry',
      status: 'requested',
      payload: { tool_name: 'Read', input: { path: 'carry.txt' }, input_json: '{"path":"carry.txt"}', summary: 'read carry.txt' },
    },
    {
      event_id: 'turn_carry:tool_result:0',
      turn_id: 'turn_carry',
      kind: 'tool_result',
      primary_message_id: 'tool_result_carry',
      source_message_ids: ['tool_result_carry'],
      sort_key: [3, 0, 50],
      tool_call_id: 'call_carry',
      payload: { tool_name: 'Read', output_text: 'done', summary: 'ok', is_error: false },
    },
  ]);

  // TRACE always emits the reasoning phase as its own row (no settled-empty
  // folding) and never carries it into the tool cluster, so the tool_call row
  // anchors purely on the visible tool_use event.
  const toolRow = rows.find((row) => row.kind === 'tool_call');
  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.ok(reasoningRow);
  assert.equal(reasoningRow.row_id, 'row:turn_carry:reasoning_phase:0');
  assert.ok(toolRow);
  assert.equal(toolRow.row_id, 'row:turn_carry:tool_use:0');
  assert.equal(toolRow.primary_message_id, 'tool_use_carry');
  assert.deepEqual(toolRow.first_event_sort_key, [2, 0, 40]);
  assert.deepEqual(toolRow.source_events, ['turn_carry:tool_use:0']);

  // The matching result is emitted as its own trace row rather than folded in.
  const resultRow = rows.find((row) => row.kind === 'tool_result');
  assert.ok(resultRow);
  assert.equal(resultRow.row_id, 'row:turn_carry:tool_result:0');
  assert.equal(resultRow.tool_call_id, 'call_carry');
});

test('projectTurnRows preserves canonical timed_out and cancelled tool states; an unresolved tool stays requested', () => {
  const timedOutRows = projectTurnRows([
    {
      event_id: 'turn_timeout:user_prompt:0',
      turn_id: 'turn_timeout',
      kind: 'user_prompt',
      primary_message_id: 'user_timeout',
      source_message_ids: ['user_timeout'],
      sort_key: [0, 0, 10],
      payload: { content: 'Handle timeout', attachments: [] },
    },
    {
      event_id: 'turn_timeout:tool_use:0',
      turn_id: 'turn_timeout',
      kind: 'tool_use',
      primary_message_id: 'tool_use_timeout',
      source_message_ids: ['tool_use_timeout'],
      sort_key: [1, 0, 40],
      tool_call_id: 'call_timeout',
      status: 'pending_approval',
      payload: { tool_name: 'Read', input: { path: 'timeout.txt' }, input_json: '{"path":"timeout.txt"}', summary: 'read timeout.txt' },
    },
    {
      event_id: 'turn_timeout:approval_resolved:0',
      turn_id: 'turn_timeout',
      kind: 'approval_resolved',
      primary_message_id: 'tool_use_timeout',
      source_message_ids: ['tool_use_timeout'],
      sort_key: [1, 1, 46],
      tool_call_id: 'call_timeout',
      status: 'timed_out',
      payload: { approval_state: 'timed_out' },
    },
  ]);
  const timedOutRow = timedOutRows.find((row) => row.kind === 'tool_call');
  assert.ok(timedOutRow);
  assert.equal(timedOutRow.payload.state, 'timed_out');

  const cancelledRows = projectTurnRows([
    {
      event_id: 'turn_cancel:user_prompt:0',
      turn_id: 'turn_cancel',
      kind: 'user_prompt',
      primary_message_id: 'user_cancel',
      source_message_ids: ['user_cancel'],
      sort_key: [0, 0, 10],
      payload: { content: 'Handle cancel', attachments: [] },
    },
    {
      event_id: 'turn_cancel:tool_use:0',
      turn_id: 'turn_cancel',
      kind: 'tool_use',
      primary_message_id: 'tool_use_cancel',
      source_message_ids: ['tool_use_cancel'],
      sort_key: [1, 0, 40],
      tool_call_id: 'call_cancel',
      status: 'pending_approval',
      payload: { tool_name: 'Read', input: { path: 'cancel.txt' }, input_json: '{"path":"cancel.txt"}', summary: 'read cancel.txt' },
    },
    {
      event_id: 'turn_cancel:approval_resolved:0',
      turn_id: 'turn_cancel',
      kind: 'approval_resolved',
      primary_message_id: 'tool_use_cancel',
      source_message_ids: ['tool_use_cancel'],
      sort_key: [1, 1, 46],
      tool_call_id: 'call_cancel',
      status: 'cancelled',
      payload: { approval_state: 'cancelled' },
    },
  ]);
  const cancelledRow = cancelledRows.find((row) => row.kind === 'tool_call');
  assert.ok(cancelledRow);
  assert.equal(cancelledRow.payload.state, 'cancelled');

  // TRACE has no 'abandoned' state and never coalesces, so a requested tool
  // that never produced a result simply stays 'requested'.
  const unresolvedRows = projectTurnRows([
    {
      event_id: 'turn_abandoned:user_prompt:0',
      turn_id: 'turn_abandoned',
      kind: 'user_prompt',
      primary_message_id: 'user_abandoned',
      source_message_ids: ['user_abandoned'],
      sort_key: [0, 0, 10],
      payload: { content: 'Handle abandonment', attachments: [] },
    },
    {
      event_id: 'turn_abandoned:tool_use:0',
      turn_id: 'turn_abandoned',
      kind: 'tool_use',
      primary_message_id: 'tool_use_abandoned',
      source_message_ids: ['tool_use_abandoned'],
      sort_key: [1, 0, 40],
      tool_call_id: 'call_abandoned',
      status: 'requested',
      payload: { tool_name: 'Read', input: { path: 'abandoned.txt' }, input_json: '{"path":"abandoned.txt"}', summary: 'read abandoned.txt' },
    },
  ]);
  const unresolvedRow = unresolvedRows.find((row) => row.kind === 'tool_call');
  assert.ok(unresolvedRow);
  assert.equal(unresolvedRow.payload.state, 'requested');
  // No result event means no tool_result row is emitted for this call.
  assert.equal(unresolvedRows.find((row) => row.kind === 'tool_result'), undefined);
});

test('projectTurnRows splits tool_call and tool_result rows with stable ids ordered by event_seq', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_trace:user_prompt:0',
      turn_id: 'turn_trace',
      kind: 'user_prompt',
      event_seq: 0,
      primary_message_id: 'user_trace',
      source_message_ids: ['user_trace'],
      sort_key: [0, 0, 10],
      payload: { content: 'trace', attachments: [] },
    },
    {
      event_id: 'turn_trace:tool_use:0',
      turn_id: 'turn_trace',
      kind: 'tool_use',
      event_seq: 1,
      primary_message_id: 'tool_use_trace',
      source_message_ids: ['tool_use_trace'],
      sort_key: [1, 0, 40],
      tool_call_id: 'call_trace',
      status: 'running',
      payload: { tool_name: 'Read', input: { path: 'trace.txt' }, summary: 'read trace.txt' },
    },
    {
      event_id: 'turn_trace:approval_requested:0',
      turn_id: 'turn_trace',
      kind: 'approval_requested',
      event_seq: 2,
      primary_message_id: 'tool_use_trace',
      source_message_ids: ['tool_use_trace'],
      sort_key: [2, 0, 45],
      tool_call_id: 'call_trace',
      status: 'pending_approval',
      payload: { approval_state: 'pending' },
    },
    {
      event_id: 'turn_trace:tool_result:0',
      turn_id: 'turn_trace',
      kind: 'tool_result',
      event_seq: 3,
      primary_message_id: 'tool_result_trace',
      source_message_ids: ['tool_result_trace'],
      sort_key: [3, 0, 50],
      tool_call_id: 'call_trace',
      status: 'completed',
      payload: { tool_name: 'Read', output_text: 'done', summary: 'done', is_error: false },
    },
  ]);

  assert.deepEqual(
    rows.map((row) => [row.kind, row.row_id]),
    [
      ['user_bubble', 'row:turn_trace:user_prompt:0'],
      ['tool_call', 'row:turn_trace:tool_use:0'],
      ['tool_result', 'row:turn_trace:tool_result:0'],
    ]
  );
  assert.equal(rows[1].tool_call_id, 'call_trace');
  assert.equal(rows[2].tool_call_id, 'call_trace');
});

test('projectTurnRows emits a compatibility row for a persisted plan_object payload', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_plan:user_prompt:0',
      event_seq: 0,
      turn_id: 'turn_plan',
      kind: 'user_prompt',
      primary_message_id: 'user_plan',
      source_message_ids: ['user_plan'],
      sort_key: [0, 0, 10],
      payload: { content: 'plan and verify' },
    },
    {
      event_id: 'turn_plan:plan_object:plan_abc123',
      event_seq: 1,
      turn_id: 'turn_plan',
      kind: 'plan_object',
      primary_message_id: '',
      source_message_ids: [],
      sort_key: [1, 0, 28],
      payload: {
        plan_id: 'plan_abc123',
        agent_id: 'main@req_plan',
        parent_agent_id: '',
        status: 'completed',
        summary: 'Plan summary line.',
        steps: [
          { index: 0, summary: 'Investigate workspace', status: 'pending' },
        ],
        verification: {
          verdict: 'PASS',
          raw_line: 'VERDICT: PASS',
          agent_id: 'verification@req_plan',
        },
        finalized_at: '2026-05-08T10:00:00Z',
      },
    },
  ]);

  const planRows = rows.filter((row) => row.kind === 'plan_object');
  assert.equal(planRows.length, 1);
  assert.equal(planRows[0].payload.plan_id, 'plan_abc123');
  assert.equal(planRows[0].payload.summary, 'Plan summary line.');
  assert.equal(planRows[0].payload.verification.verdict, 'PASS');
});
