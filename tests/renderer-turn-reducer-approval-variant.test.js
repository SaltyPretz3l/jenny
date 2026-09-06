'use strict';

// Live-path coverage for the plan-variant approval gap row (2026-08-30):
// extracted from renderer-turn-reducer.test.js to respect the file-size
// ceiling. Lockstep with renderer-turn-row-projector's plan-variant stamp —
// the live reducer must render the same buttonless plan variant, or the full
// Allow/Deny card flashes until the canonical projection replaces it.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
} = require('../renderer/chat/renderer-turn-reducer');

function applyPayload(state, payload, context = {}) {
  state.__testOrdinal = Number(state.__testOrdinal || 0);
  const events = buildTurnEventFromStreamPayload(payload, {
    turn_id: 'stream-batch5',
    primary_user_message_id: 'user_batch5',
    primary_assistant_message_id: 'assistant_stream-batch5',
    ordinal: state.__testOrdinal,
    ...context,
  });
  state.__testOrdinal += 1;
  applyTurnStreamEvent(state, events);
  return state.turns_by_id['stream-batch5'];
}

test('live gap row carries initial and later approval reasons', () => {
  const state = createTurnReducerState();
  const context = { primary_tool_message_id: 'tool_use_call-reason' };

  applyPayload(state, { type: 'started', streamId: 'stream-reason' });
  let turn = applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-reason',
    callId: 'call-reason',
    toolName: 'run_command',
    status: 'pending_approval',
    reason: 'Initial tool-use reason',
  }, context);
  let gapRow = turn.rows.find((row) => row.kind === 'approval_gap');
  assert.equal(gapRow.payload.reason, 'Initial tool-use reason');

  turn = applyPayload(state, {
    type: 'tool_approval_needed',
    streamId: 'stream-reason',
    callId: 'call-reason',
    toolName: 'run_command',
    reason: 'Later approval-event reason',
  }, context);
  gapRow = turn.rows.find((row) => row.kind === 'approval_gap');
  assert.equal(gapRow.payload.reason, 'Later approval-event reason');
});

test('live gap row carries the plan variant when the approval brings a plan document', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-plan-variant' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-plan-variant',
    callId: 'call-plan',
    toolName: 'exit_plan_mode',
    status: 'pending_approval',
    summary: 'Review plan',
  }, {
    primary_tool_message_id: 'tool_use_call-plan',
  });
  const turn = applyPayload(state, {
    type: 'tool_approval_needed',
    streamId: 'stream-plan-variant',
    callId: 'call-plan',
    toolName: 'exit_plan_mode',
    planDocument: { title: 'Plan', steps: ['one'], state: 'pending' },
  }, {
    primary_tool_message_id: 'tool_use_call-plan',
  });

  const gapRow = turn.rows.find(
    (row) => row.kind === 'approval_gap' && row.tool_call_id === 'call-plan'
  );
  assert.ok(gapRow, 'a live approval gap row exists');
  assert.equal(gapRow.payload.approval_variant, 'plan');

  // An ordinary tool approval must not pick up the variant.
  applyPayload(state, { type: 'started', streamId: 'stream-plain-variant' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-plain-variant',
    callId: 'call-plain',
    toolName: 'Write',
    status: 'pending_approval',
    summary: 'Write file',
  }, {
    primary_tool_message_id: 'tool_use_call-plain',
  });
  const plainTurn = applyPayload(state, {
    type: 'tool_approval_needed',
    streamId: 'stream-plain-variant',
    callId: 'call-plain',
    toolName: 'Write',
  }, {
    primary_tool_message_id: 'tool_use_call-plain',
  });
  const plainGapRow = plainTurn.rows.find(
    (row) => row.kind === 'approval_gap' && row.tool_call_id === 'call-plain'
  );
  assert.ok(plainGapRow, 'a live approval gap row exists for the plain tool');
  assert.equal(plainGapRow.payload.approval_variant, undefined);
});

test('live plan approval folds its plan document into one pending row', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-plan-document' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-plan-document',
    callId: 'call-plan-dom',
    toolName: 'exit_plan_mode',
    status: 'pending_approval',
    summary: 'Review implementation plan',
  }, {
    primary_tool_message_id: 'tool_use_call-plan-dom',
  });
  const turn = applyPayload(state, {
    type: 'tool_approval_needed',
    streamId: 'stream-plan-document',
    callId: 'call-plan-dom',
    approvalId: 'approval-plan-dom',
    toolName: 'exit_plan_mode',
    planDocument: {
      plan_id: 'plan-dom-1',
      tool_call_id: 'call-plan-dom',
      approval_id: 'approval-plan-dom',
      state: 'pending',
      title: 'Ship the fix',
      steps: ['Read', 'Write', 'Test'],
      files_read: ['a.js'],
      parent_stream_id: 'stream-plan-document',
    },
  }, {
    primary_tool_message_id: 'tool_use_call-plan-dom',
  });

  const planRows = turn.rows.filter((row) => row.kind === 'plan_document');
  assert.equal(planRows.length, 1);
  assert.equal(planRows[0].payload.plan_id, 'plan-dom-1');
  assert.equal(planRows[0].payload.state, 'pending');
  assert.deepEqual(planRows[0].payload.transitions, ['pending']);
  assert.equal(planRows[0].primary_message_id, 'plan_document_plan-dom-1');

  // The live cancel path: a cancelled tool_result carries the
  // plan_mode_transition metadata with NO plan_decision — the translator's
  // 'abandoned' fallback must settle the same row, not orphan it pending.
  const settledTurn = applyPayload(state, {
    type: 'tool_result',
    streamId: 'stream-plan-document',
    callId: 'call-plan-dom',
    toolName: 'exit_plan_mode',
    isError: true,
    approvalState: 'cancelled',
    metadata: { result_kind: 'plan_mode_transition', plan_feedback: '' },
  }, {
    primary_tool_message_id: 'tool_use_call-plan-dom',
  });
  const settledPlanRows = settledTurn.rows.filter((row) => row.kind === 'plan_document');
  assert.equal(settledPlanRows.length, 1);
  assert.equal(settledPlanRows[0].payload.state, 'abandoned');
  assert.deepEqual(settledPlanRows[0].payload.transitions, ['pending', 'abandoned']);
  assert.equal(settledPlanRows[0].payload.title, 'Ship the fix');
});

test('live gap row quotes the input whichever of tool_use / approval arrives first', () => {
  const state = createTurnReducerState();
  const context = { primary_tool_message_id: 'tool_use_call-race' };

  // Approval first (the race the DOM test reproduces): the approval event
  // carries the input, so the card can quote the command immediately.
  applyPayload(state, { type: 'started', streamId: 'stream-race' });
  let turn = applyPayload(state, {
    type: 'tool_approval_needed',
    streamId: 'stream-race',
    callId: 'call-race',
    toolName: 'run_command',
    input: { command: 'npm test', purpose: 'Run the tests' },
  }, context);
  let gapRow = turn.rows.find((row) => row.kind === 'approval_gap' && row.tool_call_id === 'call-race');
  assert.ok(gapRow, 'gap row exists before the tool_use event');
  assert.equal(gapRow.payload.tool_name, 'run_command', 'the card must name the tool, not "this tool"');
  assert.deepEqual(gapRow.payload.input, { command: 'npm test', purpose: 'Run the tests' });
  assert.equal(gapRow.payload.input_json, JSON.stringify({ command: 'npm test', purpose: 'Run the tests' }));

  turn = applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-race',
    callId: 'call-race',
    toolName: 'run_command',
    status: 'pending_approval',
    input: { command: 'npm test', purpose: 'Run the tests' },
  }, context);
  gapRow = turn.rows.find((row) => row.kind === 'approval_gap' && row.tool_call_id === 'call-race');
  assert.deepEqual(gapRow.payload.input, { command: 'npm test', purpose: 'Run the tests' });

  // tool_use first, then an approval event without input: the gap row is
  // backfilled from the tool row on sync instead of staying prompt-only.
  const laterContext = { primary_tool_message_id: 'tool_use_call-later' };
  applyPayload(state, { type: 'started', streamId: 'stream-later' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-later',
    callId: 'call-later',
    toolName: 'delete_file',
    status: 'pending_approval',
    input: { path: 'build', recursive: true },
  }, laterContext);
  const laterTurn = applyPayload(state, {
    type: 'tool_approval_needed',
    streamId: 'stream-later',
    callId: 'call-later',
    toolName: 'delete_file',
  }, laterContext);
  const laterGap = laterTurn.rows.find((row) => row.kind === 'approval_gap' && row.tool_call_id === 'call-later');
  assert.deepEqual(laterGap.payload.input, { path: 'build', recursive: true });
  assert.equal(laterGap.payload.input_json, JSON.stringify({ path: 'build', recursive: true }));
});
