const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTraceEvent,
  projectRows,
  projectTurn,
  projectTurnRows,
} = require('./helpers/renderer-turn-row-projector-helpers');

test('projectTurnRows emits approval_gap only for unresolved approval waits', () => {
  const turnEvents = [
    createTraceEvent({
      event_id: 'event-tool-use',
      event_seq: 1,
      kind: 'tool_use',
      status: 'pending_approval',
      payload: {
        tool_name: 'Read',
        input: 'README.md',
        input_summary: 'Read README.md',
      },
    }),
    createTraceEvent({
      event_id: 'event-approval-requested',
      event_seq: 2,
      kind: 'approval_requested',
      status: 'pending_approval',
      payload: {
        prompt: 'Approve file read?',
      },
    }),
  ];

  const traceRows = projectTurnRows(turnEvents);
  assert.deepEqual(traceRows.map((row) => row.kind), ['tool_call', 'approval_gap']);
  assert.equal(traceRows[0].payload.tool_call_id, 'call_trace');
  assert.equal(traceRows[0].payload.input_summary, 'Read README.md');
  assert.equal(traceRows[1].payload.tool_call_id, 'call_trace');
  assert.equal(traceRows[1].payload.prompt, 'Approve file read?');
});

test('projectTurnRows suppresses approval_gap after approval resolves and surfaces normalized tool_result payloads', () => {
  const turnEvents = [
    createTraceEvent({
      event_id: 'event-tool-use',
      event_seq: 1,
      kind: 'tool_use',
      status: 'running',
      payload: {
        tool_name: 'Write',
        input_json: { path: 'notes.txt' },
      },
    }),
    createTraceEvent({
      event_id: 'event-approval-requested',
      event_seq: 2,
      kind: 'approval_requested',
      status: 'pending_approval',
      payload: {
        prompt: 'Approve write?',
      },
    }),
    createTraceEvent({
      event_id: 'event-approval-resolved',
      event_seq: 3,
      kind: 'approval_resolved',
      status: 'approved',
      payload: {
        approval_state: 'approved',
      },
    }),
    createTraceEvent({
      event_id: 'event-tool-result',
      event_seq: 4,
      kind: 'tool_result',
      status: 'completed',
      payload: {
        tool_call_id: 'call_trace',
        tool_name: 'Write',
        output_text: 'done',
        summary: 'Wrote notes.txt',
        duration_ms: 2150,
        is_error: false,
        generated_artifacts: [{
          artifactId: 'artifact_trace',
          fileName: 'notes.txt',
        }],
      },
    }),
  ];

  const rows = projectTurnRows(turnEvents);
  assert.deepEqual(rows.map((row) => row.kind), ['tool_call', 'tool_result']);
  assert.equal(rows[1].payload.duration_ms, 2150);
  assert.equal(rows[1].payload.is_error, false);
  assert.equal(rows[1].payload.result_summary, 'Wrote notes.txt');
  assert.equal(rows[1].payload.generated_artifacts[0].artifact_id, 'artifact_trace');
});

test('projectTurn splits tool_call/tool_result rows and resolves tool_call terminal states (raw and enriched agree)', () => {
  const cases = [
    { suffix: 'completed', resultPayload: { is_error: false }, expectedState: 'completed' },
    { suffix: 'errored', resultPayload: { is_error: true }, expectedState: 'errored' },
    { suffix: 'denied', resultPayload: { approval_state: 'denied', is_error: false }, expectedState: 'denied' },
    { suffix: 'timed-out', resultPayload: { approval_state: 'timeout', is_error: false }, expectedState: 'timed_out' },
    { suffix: 'cancelled', resultPayload: { approval_state: 'preempted', is_error: false }, expectedState: 'cancelled' },
  ];

  for (const testCase of cases) {
    const turnEvents = [
      createTraceEvent({
        event_id: `event-tool-use-${testCase.suffix}`,
        event_seq: 1,
        kind: 'tool_use',
        status: 'running',
        payload: {
          tool_name: 'Read',
          input: { path: 'README.md' },
          summary: 'Read README.md',
        },
      }),
      createTraceEvent({
        event_id: `event-tool-result-${testCase.suffix}`,
        event_seq: 2,
        kind: 'tool_result',
        status: 'completed',
        primary_message_id: `tool_result_trace_${testCase.suffix}`,
        source_message_ids: [`tool_result_trace_${testCase.suffix}`],
        payload: {
          tool_name: 'Read',
          output_text: 'done',
          summary: 'Read complete',
          ...testCase.resultPayload,
        },
      }),
    ];

    // The raw trace projector now reconciles the tool_call row to a terminal
    // state on its own (it consumes the matching tool_result for state without
    // dropping the separate result row), so it no longer depends on canonical
    // enrichment to avoid a stuck 'running'.
    const rawRows = projectTurnRows(turnEvents);
    assert.deepEqual(
      rawRows.map((row) => [row.kind, row.payload.state]),
      [
        ['tool_call', testCase.expectedState],
        ['tool_result', 'completed'],
      ],
      testCase.suffix
    );

    const projection = projectTurn({ turn_id: 'turn_trace', events: turnEvents });
    assert.deepEqual(
      projection.rows.map((row) => [row.kind, row.payload.state]),
      [
        ['tool_call', testCase.expectedState],
        ['tool_result', 'completed'],
      ],
      testCase.suffix
    );
    assert.equal(projection.viewModel.toolCalls[0].state, testCase.expectedState, testCase.suffix);
  }
});

test('projectTurnRows fails closed instead of pairing independent missing-id tool events', () => {
  // Missing ids carry no safe correlation identity. The call settles as
  // interrupted, execution becomes an orphan notice, and the result remains
  // standalone instead of being guessed onto the call row.
  const settledEvents = [
    createTraceEvent({ event_id: 'event-tool-use-noid', event_seq: 1, kind: 'tool_use', status: 'running', tool_call_id: '', payload: { tool_name: 'worktree_create', summary: 'Invoke card' } }),
    createTraceEvent({ event_id: 'event-tool-executing-noid', event_seq: 2, kind: 'tool_executing', status: 'running', tool_call_id: '', payload: { tool_name: 'worktree_create' } }),
    createTraceEvent({ event_id: 'event-tool-result-noid', event_seq: 3, kind: 'tool_result', status: 'completed', tool_call_id: '', primary_message_id: 'tool_result_noid', source_message_ids: ['tool_result_noid'], payload: { tool_name: 'worktree_create', output_text: 'ok', is_error: false } }),
  ];
  const settledRaw = projectTurnRows(settledEvents);
  assert.deepEqual(
    settledRaw.map((row) => [row.kind, row.payload.state]),
    [['tool_call', 'interrupted'], ['system_notice', undefined], ['tool_result', 'completed']]
  );
  // projectTurn cannot canonicalize a call with no id (buildToolCallSections
  // skips it), so the raw row's correctness is what guarantees the fix.
  const settledProjection = projectTurn({ turn_id: 'turn_trace', events: settledEvents });
  assert.equal(settledProjection.rows[0].payload.state, 'interrupted');

  // No result on a settled turn is an interrupted call, never 'running'.
  const interruptedEvents = [
    createTraceEvent({ event_id: 'event-tool-use-noid-int', event_seq: 1, kind: 'tool_use', status: 'running', tool_call_id: '', payload: { tool_name: 'worktree_create' } }),
    createTraceEvent({ event_id: 'event-tool-executing-noid-int', event_seq: 2, kind: 'tool_executing', status: 'running', tool_call_id: '', payload: { tool_name: 'worktree_create' } }),
  ];
  const interruptedRaw = projectTurnRows(interruptedEvents);
  assert.deepEqual(
    interruptedRaw.map((row) => [row.kind, row.payload.state]),
    [['tool_call', 'interrupted'], ['system_notice', undefined]]
  );
});

test('projectTurnRows keeps the approved tool_call row distinct from the later assistant continuation row', () => {
  const { rows } = projectRows([
    { id: 'user_stream_approved_gap', role: 'user', content: 'Try that again' },
    {
      id: 'tool_use_stream_approved_gap',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_approved_gap',
        tool_name: 'Write',
        parent_stream_id: 'stream_approved_gap',
        status: 'approved',
        approval_state: 'approved',
        summary: 'Write todo-list.md',
        input: {
          path: 'todo-list.md',
        },
      },
    },
    {
      id: 'assistant_stream_approved_gap_seg0',
      role: 'assistant',
      streamId: 'stream_approved_gap',
      content: 'That path did not finish, so I am continuing another way.',
    },
  ]);

  // Trace never coalesces and has no 'abandoned' state: the approved tool with
  // no recorded result stays an approved tool_call row, emitted as its own row
  // separate from the assistant continuation that follows it.
  const toolRow = rows.find((row) => row.kind === 'tool_call');
  const assistantRow = rows.find((row) => row.kind === 'assistant_text');
  assert.ok(toolRow);
  assert.ok(assistantRow);
  assert.equal(toolRow.payload.state, 'approved');
  assert.deepEqual(
    toolRow.source_events,
    [
      'stream_approved_gap:tool_use:0',
      'stream_approved_gap:approval_resolved:0',
    ]
  );
});

test('projectTurnRows keeps approved tool rows queued when later empty reasoning lifecycle events add no visible continuation', () => {
  const rows = projectTurnRows([
    {
      event_id: 'stream_approved_gap_empty:user_prompt:0',
      turn_id: 'stream_approved_gap_empty',
      kind: 'user_prompt',
      primary_message_id: 'user_stream_approved_gap_empty',
      source_message_ids: ['user_stream_approved_gap_empty'],
      sort_key: [0, 0, 10],
      payload: { content: 'Try that again', attachments: [] },
    },
    {
      event_id: 'stream_approved_gap_empty:tool_use:0',
      turn_id: 'stream_approved_gap_empty',
      kind: 'tool_use',
      primary_message_id: 'tool_use_stream_approved_gap_empty',
      source_message_ids: ['tool_use_stream_approved_gap_empty'],
      tool_call_id: 'call_approved_gap_empty',
      status: 'approved',
      sort_key: [1, 0, 40],
      payload: {
        tool_name: 'Write',
        input: { path: 'todo-list.md' },
        input_json: '{"path":"todo-list.md"}',
        approval_state: 'approved',
        summary: 'Write todo-list.md',
      },
    },
    {
      event_id: 'stream_approved_gap_empty:approval_resolved:0',
      turn_id: 'stream_approved_gap_empty',
      kind: 'approval_resolved',
      primary_message_id: 'tool_use_stream_approved_gap_empty',
      source_message_ids: ['tool_use_stream_approved_gap_empty'],
      tool_call_id: 'call_approved_gap_empty',
      status: 'approved',
      sort_key: [1, 1, 41],
      payload: { approval_state: 'approved' },
    },
    {
      event_id: 'stream_approved_gap_empty:reasoning_phase:0',
      turn_id: 'stream_approved_gap_empty',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_stream_approved_gap_empty',
      source_message_ids: ['assistant_stream_approved_gap_empty'],
      phase_id: 'phase_empty',
      status: 'open',
      sort_key: [2, 0, 20],
      payload: {
        phase_id: 'phase_empty',
        phase_kind: 'reasoning',
        thinking_id: 'think_empty',
        entries: [],
      },
    },
  ]);

  const toolRow = rows.find((row) => row.kind === 'tool_call');
  assert.ok(toolRow);
  assert.equal(toolRow.payload.state, 'approved');
});
