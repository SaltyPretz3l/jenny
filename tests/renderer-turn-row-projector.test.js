const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectRows,
  projectTurnRows,
} = require('./helpers/renderer-turn-row-projector-helpers');

test('projectTurnRows labels assistant text as commentary, intermediate, and final_answer around tools', () => {
  const { rows } = projectRows([
    { id: 'user_stream_phasey', role: 'user', content: 'Walk me through it' },
    {
      id: 'assistant_stream_phasey',
      role: 'assistant',
      streamId: 'stream_phasey',
      phases: [
        {
          phase_id: 'phase_reasoning_pre',
          phase_kind: 'reasoning',
          thinking_id: 'think_pre',
          entries: [{ id: 'reason_pre', text: 'Planning' }],
        },
        { phase_id: 'phase_text_pre', phase_kind: 'text' },
      ],
      visible_segments: [
        { segment_id: 'seg_pre', phase_id: 'phase_text_pre', text: 'Let me inspect that first. ' },
      ],
    },
    {
      id: 'tool_use_call_one',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_one',
        tool_name: 'Read',
        parent_stream_id: 'stream_phasey',
        status: 'completed',
      },
    },
    {
      id: 'assistant_stream_phasey_seg1',
      role: 'assistant',
      streamId: 'stream_phasey',
      phases: [
        { phase_id: 'phase_text_mid', phase_kind: 'text' },
      ],
      visible_segments: [
        { segment_id: 'seg_mid', phase_id: 'phase_text_mid', text: 'One more check before I finish. ' },
      ],
    },
    {
      id: 'tool_use_call_two',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_two',
        tool_name: 'Search',
        parent_stream_id: 'stream_phasey',
        status: 'completed',
      },
    },
    {
      id: 'assistant_stream_phasey_seg2',
      role: 'assistant',
      streamId: 'stream_phasey',
      phases: [
        { phase_id: 'phase_text_final', phase_kind: 'text' },
      ],
      visible_segments: [
        { segment_id: 'seg_final', phase_id: 'phase_text_final', text: 'Final answer.' },
      ],
    },
  ]);

  const assistantRows = rows.filter((row) => row.kind === 'assistant_text');
  assert.deepEqual(
    assistantRows.map((row) => [row.payload.text, row.payload.assistant_phase]),
    [
      ['Let me inspect that first. ', 'commentary'],
      ['One more check before I finish. ', 'intermediate'],
      ['Final answer.', 'final_answer'],
    ]
  );
});

test('projectTurnRows emits separate tool_call and tool_result rows for a tool use, approval, and result', () => {
  const { rows } = projectRows([
    { id: 'user_stream_tool', role: 'user', content: 'Inspect' },
    {
      id: 'tool_use_stream_tool',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_tool',
        tool_name: 'Read',
        parent_stream_id: 'stream_tool',
        status: 'pending_approval',
        approval_state: 'pending',
      },
    },
    {
      id: 'tool_result_stream_tool',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_tool',
        tool_name: 'Read',
        output_text: 'done',
        parent_stream_id: 'stream_tool',
      },
    },
  ]);

  const callRow = rows.find((row) => row.kind === 'tool_call');
  const resultRow = rows.find((row) => row.kind === 'tool_result');
  assert.ok(callRow);
  assert.ok(resultRow);
  assert.equal(callRow.tool_call_id, 'call_tool');
  assert.equal(resultRow.tool_call_id, 'call_tool');
  // The tool_call row flips to completed once the result arrives; the
  // tool_result row carries the output and its own settled state.
  assert.equal(callRow.payload.state, 'completed');
  assert.equal(resultRow.payload.state, 'completed');
  assert.equal(resultRow.payload.output_text, 'done');
  // Trace never coalesces: the call row owns the tool_use (and approval)
  // source message, the result row owns the tool_result source message.
  assert.deepEqual(callRow.source_message_ids, ['tool_use_stream_tool']);
  assert.deepEqual(resultRow.source_message_ids, ['tool_result_stream_tool']);
});

test('projectTurnRows exposes hydrated tool_result diff metadata on tool rows', () => {
  const rows = projectTurnRows([
    {
      event_id: 'stream_tool_diff:tool_use:0',
      turn_id: 'stream_tool_diff',
      kind: 'tool_use',
      primary_message_id: 'tool_use_stream_tool_diff',
      source_message_ids: ['tool_use_stream_tool_diff'],
      tool_call_id: 'call_tool_diff',
      status: 'completed',
      sort_key: [0, 0, 40],
      payload: {
        tool_name: 'Write',
        input: { path: 'src/app.js' },
      },
    },
    {
      event_id: 'stream_tool_diff:tool_result:0',
      turn_id: 'stream_tool_diff',
      kind: 'tool_result',
      primary_message_id: 'tool_result_stream_tool_diff',
      source_message_ids: ['tool_result_stream_tool_diff'],
      tool_call_id: 'call_tool_diff',
      status: 'completed',
      sort_key: [0, 1, 50],
      payload: {
        tool_name: 'Write',
        output_text: 'Wrote file.',
        is_error: false,
        metadata: {
          diff: {
            additions: 1,
            deletions: 1,
            truncated: false,
            hunks: [{
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-old', '+new'],
            }],
          },
        },
      },
    },
  ]);

  const toolRow = rows.find((row) => row.kind === 'tool_result');
  assert.ok(toolRow);
  assert.equal(toolRow.payload.metadata.diff.additions, 1);
  assert.deepEqual(toolRow.payload.metadata.diff.hunks[0].lines, ['-old', '+new']);
});

test('projectTurnRows replaces reasoning entry snapshots with the same id', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_reasoning:reasoning:0',
      turn_id: 'turn_reasoning',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_turn_reasoning',
      source_message_ids: ['assistant_turn_reasoning'],
      phase_id: 'phase_reasoning',
      status: 'open',
      sort_key: [1, 0, 20],
      payload: {
        phase_id: 'phase_reasoning',
        phase_kind: 'reasoning',
        thinking_id: 'think_reasoning',
        entries: [{ id: 'reason_live', text: 'The', thinkingId: 'think_reasoning' }],
      },
    },
    {
      event_id: 'turn_reasoning:reasoning:1',
      turn_id: 'turn_reasoning',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_turn_reasoning',
      source_message_ids: ['assistant_turn_reasoning'],
      phase_id: 'phase_reasoning',
      status: 'open',
      sort_key: [1, 1, 20],
      payload: {
        phase_id: 'phase_reasoning',
        phase_kind: 'reasoning',
        thinking_id: 'think_reasoning',
        entries: [{ id: 'reason_live', text: 'The user', thinkingId: 'think_reasoning' }],
      },
    },
  ]);

  const reasoningRows = rows.filter((row) => row.kind === 'reasoning');
  assert.equal(reasoningRows.length, 1);
  assert.deepEqual(
    reasoningRows[0].payload.entries.map((entry) => entry.text),
    ['The user']
  );
});

test('projectTurnRows marks completed reasoning rows for timeline presentation', () => {
  const rows = projectTurnRows([{
    event_id: 'turn_reasoning_complete:reasoning_phase:0',
    turn_id: 'turn_reasoning_complete',
    kind: 'reasoning_phase',
    primary_message_id: 'assistant_reasoning_complete',
    source_message_ids: ['assistant_reasoning_complete'],
    phase_id: 'phase_reasoning_complete',
    status: 'completed',
    sort_key: [1, 0, 20],
    payload: {
      phase_id: 'phase_reasoning_complete',
      phase_kind: 'tool_result',
      summary: 'Read the tool result',
      entries: [{ id: 'reason_complete', text: 'The result is ready.' }],
    },
  }]);

  const reasoningRows = rows.filter((row) => row.kind === 'reasoning');
  assert.equal(reasoningRows.length, 1);
  assert.equal(reasoningRows[0].payload.completed, true);
});

test('projectTurnRows projects reasoning timing onto the row payload when present', () => {
  const rows = projectTurnRows([{
    event_id: 'turn_reasoning_timed:reasoning_phase:0',
    turn_id: 'turn_reasoning_timed',
    kind: 'reasoning_phase',
    primary_message_id: 'assistant_reasoning_timed',
    source_message_ids: ['assistant_reasoning_timed'],
    phase_id: 'phase_reasoning_timed',
    status: 'completed',
    started_at: '2026-06-22T10:00:00.000Z',
    completed_at: '2026-06-22T10:00:03.400Z',
    sort_key: [1, 0, 20],
    payload: {
      phase_id: 'phase_reasoning_timed',
      phase_kind: 'reasoning',
      entries: [{ id: 'reason_timed', text: 'Thinking it through.' }],
    },
  }]);

  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.equal(reasoningRow.payload.started_at, '2026-06-22T10:00:00.000Z');
  assert.equal(reasoningRow.payload.completed_at, '2026-06-22T10:00:03.400Z');
});

test('projectTurnRows omits reasoning timing keys when the source has none (corpus-safe)', () => {
  const rows = projectTurnRows([{
    event_id: 'turn_reasoning_untimed:reasoning_phase:0',
    turn_id: 'turn_reasoning_untimed',
    kind: 'reasoning_phase',
    primary_message_id: 'assistant_reasoning_untimed',
    source_message_ids: ['assistant_reasoning_untimed'],
    phase_id: 'phase_reasoning_untimed',
    status: 'completed',
    sort_key: [1, 0, 20],
    payload: {
      phase_id: 'phase_reasoning_untimed',
      phase_kind: 'reasoning',
      started_at: '',
      completed_at: '',
      entries: [{ id: 'reason_untimed', text: 'Thinking it through.' }],
    },
  }]);

  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.ok(!('started_at' in reasoningRow.payload));
  assert.ok(!('completed_at' in reasoningRow.payload));
});

test('projectTurnRows orders harness tool row before grounded final answer after reset cleanup', () => {
  const { rows } = projectRows([
    { id: 'user_stream_harness_order', role: 'user', content: 'Inspect harness tools' },
    {
      id: 'tool_use_harness_order',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_harness_order',
        tool_name: 'inspect_harness',
        parent_stream_id: 'stream_harness_order',
        status: 'completed',
        summary: 'Inspect Harness',
      },
    },
    {
      id: 'tool_result_harness_order',
      role: 'tool',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_harness_order',
        tool_name: 'inspect_harness',
        parent_stream_id: 'stream_harness_order',
        output_text: '{"tools":{"items":[]}}',
        summary: 'Inspect Harness',
        is_error: false,
      },
    },
    {
      id: 'assistant_stream_harness_order',
      role: 'assistant',
      streamId: 'stream_harness_order',
      phases: [
        { phase_id: 'phase_text_final', phase_kind: 'text' },
      ],
      visible_segments: [
        {
          segment_id: 'seg_final',
          phase_id: 'phase_text_final',
          text: 'Functional tools currently available:\n- Inspect Harness (`inspect_harness`)',
        },
      ],
    },
  ]);

  assert.deepEqual(
    rows.map((row) => row.kind),
    ['user_bubble', 'tool_call', 'tool_result', 'assistant_text']
  );
  assert.equal(rows[1].payload.summary, 'Inspect Harness');
  assert.match(rows[3].payload.text, /Functional tools currently available/);
});

test('projectTurnRows assigns visible render owners to reasoning rows around tools', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_render_owner:user_prompt:0',
      turn_id: 'turn_render_owner',
      kind: 'user_prompt',
      primary_message_id: 'user_render_owner',
      source_message_ids: ['user_render_owner'],
      sort_key: [0, 0, 10],
      payload: { content: 'Use the harness' },
    },
    {
      event_id: 'turn_render_owner:reasoning_phase:0',
      turn_id: 'turn_render_owner',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_render_owner',
      source_message_ids: ['assistant_render_owner'],
      phase_id: 'phase_pre_tool',
      sort_key: [1, 0, 20],
      payload: {
        phase_id: 'phase_pre_tool',
        thinking_id: 'think_pre_tool',
        entries: [{ id: 'reason_pre', text: 'Need a tool.' }],
      },
    },
    {
      event_id: 'turn_render_owner:tool_use:0',
      turn_id: 'turn_render_owner',
      kind: 'tool_use',
      primary_message_id: 'tool_use_render_owner',
      source_message_ids: ['tool_use_render_owner'],
      tool_call_id: 'call_render_owner',
      status: 'running',
      sort_key: [2, 0, 40],
      payload: { tool_name: 'inspect_harness' },
    },
    {
      event_id: 'turn_render_owner:tool_result:0',
      turn_id: 'turn_render_owner',
      kind: 'tool_result',
      primary_message_id: 'tool_result_render_owner',
      source_message_ids: ['tool_result_render_owner'],
      tool_call_id: 'call_render_owner',
      status: 'completed',
      sort_key: [3, 0, 50],
      payload: { tool_name: 'inspect_harness', output_text: '{}', is_error: false },
    },
    {
      event_id: 'turn_render_owner:reasoning_phase:1',
      turn_id: 'turn_render_owner',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_render_owner',
      source_message_ids: ['assistant_render_owner'],
      phase_id: 'phase_post_tool',
      sort_key: [4, 0, 20],
      payload: {
        phase_id: 'phase_post_tool',
        thinking_id: 'think_post_tool',
        entries: [{ id: 'reason_post', text: 'Use the result.' }],
      },
    },
    {
      event_id: 'turn_render_owner:assistant_text_segment:0',
      turn_id: 'turn_render_owner',
      kind: 'assistant_text_segment',
      primary_message_id: 'assistant_render_owner',
      source_message_ids: ['assistant_render_owner'],
      sort_key: [5, 0, 30],
      payload: { text: 'Done.' },
    },
  ]);

  assert.deepEqual(
    rows.map((row) => [row.kind, row.render_message_id]),
    [
      ['user_bubble', 'user_render_owner'],
      ['reasoning', 'tool_use_render_owner'],
      ['tool_call', 'tool_use_render_owner'],
      ['tool_result', 'tool_result_render_owner'],
      ['reasoning', 'assistant_render_owner'],
      ['assistant_text', 'assistant_render_owner'],
    ]
  );
});

test('projectTurnRows emits a settled empty reasoning row and never folds it into a carry notice', () => {
  const { rows } = projectRows([
    { id: 'user_empty_reasoning', role: 'user', content: 'Trace it' },
    {
      id: 'assistant_empty_reasoning',
      role: 'assistant',
      streamId: 'stream_empty_reasoning',
      phases: [
        {
          phase_id: 'phase_empty_reasoning',
          phase_kind: 'reasoning',
          thinking_id: 'think_empty',
          completed_at: '2026-05-12T10:00:00.000Z',
          entries: [],
        },
        { phase_id: 'phase_text_final', phase_kind: 'text' },
      ],
      visible_segments: [
        { segment_id: 'seg_final', phase_id: 'phase_text_final', text: 'Done.' },
      ],
    },
  ]);

  // Trace never folds settled-empty reasoning: the reasoning row is always
  // emitted (with empty entries) and is never collapsed into an orphan_carry
  // system_notice the way the retired compact projector did.
  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.ok(reasoningRow);
  assert.deepEqual(reasoningRow.payload.entries, []);
  assert.equal(rows.some((row) => row.kind === 'system_notice' && row.payload?.subkind === 'orphan_carry'), false);
  assert.equal(rows.some((row) => row.kind === 'assistant_text'), true);
});

test('projectTurnRows normalizes generated artifacts onto the tool_result payload', () => {
  const { rows } = projectRows([
    { id: 'user_stream_artifact', role: 'user', content: 'Make an artifact' },
    {
      id: 'tool_use_stream_artifact',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_artifact',
        tool_name: 'CreateArtifact',
        parent_stream_id: 'stream_artifact',
        status: 'completed',
      },
    },
    {
      id: 'tool_result_stream_artifact',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_artifact',
        tool_name: 'CreateArtifact',
        output_text: 'created',
        parent_stream_id: 'stream_artifact',
        generated_artifacts: [{
          artifactId: 'artifact_plan',
          fileName: 'plan.md',
          displayPath: '.jenny/artifacts/session-1/plan.md',
          absolutePath: 'C:/workspace/.jenny/artifacts/session-1/plan.md',
          language: 'markdown',
          sessionId: 'session-1',
        }],
      },
    },
  ]);

  const toolRow = rows.find((row) => row.kind === 'tool_result');
  assert.ok(toolRow);
  assert.deepEqual(toolRow.payload.generated_artifacts, [{
    artifact_id: 'artifact_plan',
    session_id: 'session-1',
    artifact_kind: 'document',
    title: 'plan.md',
    file_name: 'plan.md',
    display_path: '.jenny/artifacts/session-1/plan.md',
    absolute_path: '[redacted:path]',
    language: 'markdown',
    mime_type: '',
    width: 0,
    height: 0,
    source_kind: '',
    editable: true,
    status: 'available',
  }]);
});

test('projectTurnRows surfaces a tool_result whose tool_use never arrived as a standalone tool_result row', () => {
  const { rows } = projectRows([
    { id: 'user_stream_orphan', role: 'user', content: 'What happened?' },
    {
      id: 'tool_result_stream_orphan',
      role: 'assistant',
      kind: 'tool_result',
      tool_result: {
        call_id: 'call_orphan',
        tool_name: 'Read',
        output_text: 'oops',
        parent_stream_id: 'stream_orphan',
      },
    },
  ]);

  // Trace has no 'orphaned'/'abandoned' state and never coalesces: a tool_result
  // with no preceding tool_use still emits its own tool_result row carrying the
  // call id and output, settled to completed.
  assert.equal(rows[1].kind, 'tool_result');
  assert.equal(rows[1].payload.state, 'completed');
  assert.equal(rows[1].tool_call_id, 'call_orphan');
  assert.equal(rows[1].payload.output_text, 'oops');
});

test('projectTurnRows preserves every source event exactly once across the produced rows', () => {
  const { turn, rows } = projectRows([
    { id: 'user_stream_cover', role: 'user', content: 'Cover everything' },
    {
      id: 'assistant_stream_cover',
      role: 'assistant',
      streamId: 'stream_cover',
      phases: [
        {
          phase_id: 'phase_reasoning_cover',
          phase_kind: 'reasoning',
          thinking_id: 'think_cover',
          entries: [{ id: 'reason_cover', text: 'Thinking' }],
        },
        { phase_id: 'phase_text_cover', phase_kind: 'text' },
      ],
      visible_segments: [
        { segment_id: 'seg_cover', phase_id: 'phase_text_cover', text: 'Answer' },
      ],
    },
  ]);

  const flattened = rows.flatMap((row) => row.source_events);
  assert.deepEqual(flattened, turn.events.map((event) => event.event_id));
});

test('projectTurnRows keeps running tools interrupted even when approval already resolved to approved', () => {
  const { rows } = projectRows([
    { id: 'user_stream_running', role: 'user', content: 'Keep going' },
    {
      id: 'tool_use_stream_running',
      role: 'assistant',
      kind: 'tool_use',
      tool_call: {
        call_id: 'call_running',
        tool_name: 'Read',
        parent_stream_id: 'stream_running',
        status: 'running',
        approval_state: 'approved',
      },
    },
  ]);

  const toolRow = rows.find((row) => row.kind === 'tool_call');
  assert.ok(toolRow);
  assert.equal(toolRow.payload.state, 'interrupted');
});

test('projectTurnRows keeps a settled empty reasoning as its own row ahead of the visible answer', () => {
  const { rows } = projectRows([
    { id: 'user_stream_empty_carry', role: 'user', content: 'Explain it' },
    {
      id: 'assistant_stream_empty_carry',
      role: 'assistant',
      streamId: 'stream_empty_carry',
      phases: [
        {
          phase_id: 'phase_reasoning_empty',
          phase_kind: 'reasoning',
          thinking_id: 'think_empty',
          completed_at: '2026-05-12T10:00:00.000Z',
          entries: [],
        },
        { phase_id: 'phase_text_after_empty', phase_kind: 'text' },
      ],
      visible_segments: [
        { segment_id: 'seg_after_empty', phase_id: 'phase_text_after_empty', text: 'Visible answer.' },
      ],
    },
  ]);

  // Trace never carries the empty reasoning event into the downstream visible
  // row: the reasoning event owns its own row, and the assistant_text row's
  // identity stays anchored to its own segment event alone.
  const assistantRow = rows.find((row) => row.kind === 'assistant_text');
  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.ok(reasoningRow);
  assert.deepEqual(reasoningRow.source_events, ['stream_empty_carry:reasoning_phase:0']);
  assert.ok(assistantRow);
  assert.equal(assistantRow.row_id, 'row:stream_empty_carry:assistant_text_segment:0');
  assert.deepEqual(assistantRow.source_events, [
    'stream_empty_carry:assistant_text_segment:0',
  ]);
});

test('projectTurnRows keeps assistant_text_segments split by an empty reasoning_phase as separate rows around the reasoning row', () => {
  // The retired compact projector (686a987) made empty reasoning_phase events
  // transparent inside the assistant_text_segment grouping loop, merging the
  // two segments into one row and dropping the empty phase. Trace never
  // coalesces and always emits the reasoning row, so the two segments stay
  // separate with the (settled, empty) reasoning row between them.
  const rows = projectTurnRows([
    {
      event_id: 'turn_empty_split:user_prompt:0',
      turn_id: 'turn_empty_split',
      kind: 'user_prompt',
      primary_message_id: 'user_empty_split',
      source_message_ids: ['user_empty_split'],
      sort_key: [0, 0, 10],
      payload: { content: 'Tell me about it' },
    },
    {
      event_id: 'turn_empty_split:assistant_text_segment:0',
      turn_id: 'turn_empty_split',
      kind: 'assistant_text_segment',
      primary_message_id: 'assistant_empty_split',
      source_message_ids: ['assistant_empty_split'],
      assistant_phase: 'final_answer',
      sort_key: [1, 0, 30],
      payload: {
        text: 'Hello ',
        assistant_phase: 'final_answer',
        segment_id: 'seg_first',
        phase_id: 'phase_text_final',
      },
    },
    {
      event_id: 'turn_empty_split:reasoning_phase:0',
      turn_id: 'turn_empty_split',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_empty_split',
      source_message_ids: ['assistant_empty_split'],
      phase_id: 'phase_empty_thinking_disabled',
      status: 'completed',
      completed_at: '2026-05-12T10:00:00.000Z',
      sort_key: [1, 1, 20],
      payload: {
        phase_id: 'phase_empty_thinking_disabled',
        phase_kind: 'reasoning',
        thinking_id: 'think_empty',
        completed_at: '2026-05-12T10:00:00.000Z',
        entries: [],
      },
    },
    {
      event_id: 'turn_empty_split:assistant_text_segment:1',
      turn_id: 'turn_empty_split',
      kind: 'assistant_text_segment',
      primary_message_id: 'assistant_empty_split',
      source_message_ids: ['assistant_empty_split'],
      assistant_phase: 'final_answer',
      sort_key: [1, 2, 30],
      payload: {
        text: 'world.',
        assistant_phase: 'final_answer',
        segment_id: 'seg_second',
        phase_id: 'phase_text_final',
      },
    },
  ]);

  const assistantRows = rows.filter((row) => row.kind === 'assistant_text');
  const reasoningRows = rows.filter((row) => row.kind === 'reasoning');
  assert.equal(reasoningRows.length, 1, 'trace always emits the reasoning row');
  assert.equal(reasoningRows[0].payload.completed, true);
  assert.deepEqual(reasoningRows[0].payload.entries, []);
  assert.equal(assistantRows.length, 2, 'segments split by reasoning stay as two rows');
  assert.deepEqual(
    assistantRows.map((row) => row.payload.text),
    ['Hello ', 'world.']
  );
  assert.deepEqual(
    assistantRows.map((row) => row.payload.segments[0].segment_id),
    ['seg_first', 'seg_second']
  );
});

test('projectTurnRows emits an empty reasoning row for an in-flight reasoning_phase', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_open_reasoning:user_prompt:0',
      turn_id: 'turn_open_reasoning',
      kind: 'user_prompt',
      primary_message_id: 'user_open_reasoning',
      source_message_ids: ['user_open_reasoning'],
      sort_key: [0, 0, 10],
      payload: { content: 'Think out loud' },
    },
    {
      event_id: 'turn_open_reasoning:reasoning_phase:0',
      turn_id: 'turn_open_reasoning',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_open_reasoning',
      source_message_ids: ['assistant_open_reasoning'],
      phase_id: 'phase_open_reasoning',
      status: 'open',
      sort_key: [1, 0, 20],
      payload: {
        phase_id: 'phase_open_reasoning',
        phase_kind: 'reasoning',
        thinking_id: 'think_open',
        entries: [],
      },
    },
  ]);

  assert.deepEqual(rows.map((row) => row.kind), ['user_bubble', 'reasoning']);
  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.ok(reasoningRow);
  assert.deepEqual(reasoningRow.payload.entries, []);
  assert.equal(reasoningRow.payload.chunk_count, 0);
});

test('projectTurnRows keeps in-flight empty reasoning as a text segment boundary', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_open_split:assistant_text_segment:0',
      turn_id: 'turn_open_split',
      kind: 'assistant_text_segment',
      primary_message_id: 'assistant_open_split',
      source_message_ids: ['assistant_open_split'],
      assistant_phase: 'final_answer',
      sort_key: [0, 0, 30],
      payload: {
        text: 'Before ',
        assistant_phase: 'final_answer',
        segment_id: 'seg_before',
        phase_id: 'phase_text_final',
      },
    },
    {
      event_id: 'turn_open_split:reasoning_phase:0',
      turn_id: 'turn_open_split',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_open_split',
      source_message_ids: ['assistant_open_split'],
      phase_id: 'phase_open_between_text',
      status: 'open',
      sort_key: [0, 1, 20],
      payload: {
        phase_id: 'phase_open_between_text',
        phase_kind: 'reasoning',
        thinking_id: 'think_between_text',
        entries: [],
      },
    },
    {
      event_id: 'turn_open_split:assistant_text_segment:1',
      turn_id: 'turn_open_split',
      kind: 'assistant_text_segment',
      primary_message_id: 'assistant_open_split',
      source_message_ids: ['assistant_open_split'],
      assistant_phase: 'final_answer',
      sort_key: [0, 2, 30],
      payload: {
        text: 'after.',
        assistant_phase: 'final_answer',
        segment_id: 'seg_after',
        phase_id: 'phase_text_final',
      },
    },
  ]);

  const assistantRows = rows.filter((row) => row.kind === 'assistant_text');
  const reasoningRows = rows.filter((row) => row.kind === 'reasoning');
  assert.equal(reasoningRows.length, 1);
  assert.deepEqual(assistantRows.map((row) => row.payload.text), ['Before ', 'after.']);
});

test('projectTurnRows emits an empty reasoning_phase row settled by completed_at', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_completed_at_empty:user_prompt:0',
      turn_id: 'turn_completed_at_empty',
      kind: 'user_prompt',
      primary_message_id: 'user_completed_at_empty',
      source_message_ids: ['user_completed_at_empty'],
      sort_key: [0, 0, 10],
      payload: { content: 'No thinking' },
    },
    {
      event_id: 'turn_completed_at_empty:reasoning_phase:0',
      turn_id: 'turn_completed_at_empty',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_completed_at_empty',
      source_message_ids: ['assistant_completed_at_empty'],
      phase_id: 'phase_completed_at_empty',
      status: 'open',
      completed_at: '2026-05-12T10:00:00.000Z',
      sort_key: [1, 0, 20],
      payload: {
        phase_id: 'phase_completed_at_empty',
        phase_kind: 'reasoning',
        thinking_id: 'think_completed_at',
        completed_at: '2026-05-12T10:00:00.000Z',
        entries: [],
      },
    },
  ]);

  // Trace never folds settled-empty reasoning the way the retired compact
  // projector did: the reasoning row is always emitted, even when it is
  // settled by completed_at with no entries.
  assert.deepEqual(rows.map((row) => row.kind), ['user_bubble', 'reasoning']);
  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.deepEqual(reasoningRow.payload.entries, []);
});

test('projectTurnRows emits an empty reasoning_phase row settled by complete status', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_complete_empty:user_prompt:0',
      turn_id: 'turn_complete_empty',
      kind: 'user_prompt',
      primary_message_id: 'user_complete_empty',
      source_message_ids: ['user_complete_empty'],
      sort_key: [0, 0, 10],
      payload: { content: 'No thinking' },
    },
    {
      event_id: 'turn_complete_empty:reasoning_phase:0',
      turn_id: 'turn_complete_empty',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_complete_empty',
      source_message_ids: ['assistant_complete_empty'],
      phase_id: 'phase_complete_empty',
      status: 'complete',
      sort_key: [1, 0, 20],
      payload: {
        phase_id: 'phase_complete_empty',
        phase_kind: 'reasoning',
        thinking_id: 'think_complete',
        entries: [],
      },
    },
  ]);

  // Trace never folds settled-empty reasoning: the reasoning row is always
  // emitted, even when it is settled by a complete status with no entries.
  assert.deepEqual(rows.map((row) => row.kind), ['user_bubble', 'reasoning']);
  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.deepEqual(reasoningRow.payload.entries, []);
});

test('projectTurnRows keeps settled chunk-count-only reasoning visible', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_chunk_only:user_prompt:0',
      turn_id: 'turn_chunk_only',
      kind: 'user_prompt',
      primary_message_id: 'user_chunk_only',
      source_message_ids: ['user_chunk_only'],
      sort_key: [0, 0, 10],
      payload: { content: 'Count-only reasoning' },
    },
    {
      event_id: 'turn_chunk_only:reasoning_phase:0',
      turn_id: 'turn_chunk_only',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_chunk_only',
      source_message_ids: ['assistant_chunk_only'],
      phase_id: 'phase_chunk_only',
      status: 'completed',
      sort_key: [1, 0, 20],
      payload: {
        phase_id: 'phase_chunk_only',
        phase_kind: 'reasoning',
        thinking_id: 'think_chunk_only',
        chunk_count: 2,
        entries: [],
      },
    },
  ]);

  assert.deepEqual(rows.map((row) => row.kind), ['user_bubble', 'reasoning']);
  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.ok(reasoningRow);
  assert.deepEqual(reasoningRow.payload.entries, []);
  assert.equal(reasoningRow.payload.chunk_count, 2);
});

test('projectTurnRows keeps settled summary-only reasoning visible', () => {
  const rows = projectTurnRows([
    {
      event_id: 'turn_summary_only:user_prompt:0',
      turn_id: 'turn_summary_only',
      kind: 'user_prompt',
      primary_message_id: 'user_summary_only',
      source_message_ids: ['user_summary_only'],
      sort_key: [0, 0, 10],
      payload: { content: 'Summarize reasoning' },
    },
    {
      event_id: 'turn_summary_only:reasoning_phase:0',
      turn_id: 'turn_summary_only',
      kind: 'reasoning_phase',
      primary_message_id: 'assistant_summary_only',
      source_message_ids: ['assistant_summary_only'],
      phase_id: 'phase_summary_only',
      status: 'completed',
      sort_key: [1, 0, 20],
      payload: {
        phase_id: 'phase_summary_only',
        phase_kind: 'reasoning',
        thinking_id: 'think_summary_only',
        summary: 'Checked the constraints before answering.',
        entries: [],
      },
    },
  ]);

  assert.deepEqual(rows.map((row) => row.kind), ['user_bubble', 'reasoning']);
  const reasoningRow = rows.find((row) => row.kind === 'reasoning');
  assert.ok(reasoningRow);
  assert.deepEqual(reasoningRow.payload.entries, []);
  assert.equal(reasoningRow.payload.chunk_count, 0);
  assert.equal(reasoningRow.payload.summary, 'Checked the constraints before answering.');
});

test('projectTurnRows preserves projected assistant metadata notices as ordered system_notice rows', () => {
  const { rows } = projectRows([
    { id: 'user_stream_notice_rows', role: 'user', content: 'Status update' },
    {
      id: 'assistant_stream_notice_rows',
      role: 'assistant',
      streamId: 'stream_notice_rows',
      content: 'The task is underway.',
      context_compacted: {
        strategy: 'micro',
        tokensBefore: 1200,
        tokensAfter: 400,
      },
      agent_status: {
        taskId: 'task_notice_rows',
        status: 'running',
        summary: 'Gathering evidence',
      },
      status: 'error',
      stream_error: 'The stream failed after the visible reply.',
    },
  ]);

  assert.deepEqual(
    rows.map((row) => [row.kind, row.payload?.subkind || row.payload?.text || row.payload?.content || row.payload?.stream_error || '']),
    [
      ['user_bubble', 'Status update'],
      ['system_notice', 'context_compacted'],
      ['system_notice', 'agent_status'],
      ['assistant_text', 'The task is underway.'],
      ['system_notice', 'assistant_error'],
    ]
  );
  assert.deepEqual(
    rows
      .filter((row) => row.kind === 'system_notice')
      .map((row) => row.primary_message_id),
    [
      'assistant_stream_notice_rows',
      'assistant_stream_notice_rows',
      'assistant_stream_notice_rows',
    ]
  );
});
