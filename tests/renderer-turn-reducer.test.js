const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
  reconcileTurnRows,
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

test('reducer stamps a stable started_at_ms anchor once at turn creation', () => {
  const state = createTurnReducerState();
  const turn = applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  assert.equal(typeof turn.started_at_ms, 'number');
  assert.ok(Number.isFinite(turn.started_at_ms) && turn.started_at_ms > 0, 'started_at_ms is a positive epoch ms');
  const stamped = turn.started_at_ms;
  /* A later event on the same turn must NOT re-stamp the anchor — it is the turn's start, not "now". */
  const again = applyPayload(state, {
    type: 'delta', streamId: 'stream-batch5', content: 'hi', aggregate: 'hi',
  }, { segmentText: 'hi', segmentIndex: 0, assistant_phase: 'commentary' });
  assert.equal(again.started_at_ms, stamped);
});

test('reducer preserves pre-tool text when tool_use arrives', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    content: 'Let me check that first.',
    aggregate: 'Let me check that first.',
  }, {
    segmentText: 'Let me check that first.',
    segmentIndex: 0,
    assistant_phase: 'commentary',
  });
  const turn = applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-read',
    toolName: 'Read',
    status: 'running',
    summary: 'Read README',
  }, {
    primary_tool_message_id: 'tool_use_call-read',
  });

  assert.deepEqual(
    turn.rows.map((row) => row.kind),
    ['assistant_text', 'tool_call']
  );
  assert.equal(turn.rows[0].payload.text, 'Let me check that first.');
  assert.equal(turn.rows[1].payload.state, 'running');
});

test('reducer preserves live tool_result diff metadata on tool rows', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-write',
    toolName: 'Write',
    status: 'running',
    summary: 'Write src/app.js',
  }, {
    primary_tool_message_id: 'tool_use_call-write',
  });
  const turn = applyPayload(state, {
    type: 'tool_result',
    streamId: 'stream-batch5',
    callId: 'call-write',
    toolName: 'Write',
    content: 'Wrote file.',
    summary: 'Write src/app.js',
    isError: false,
    approvalState: 'auto',
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
  }, {
    tool_result_message_id: 'tool_result_call-write',
  });

  const toolResultRow = turn.rows.find((row) => row.kind === 'tool_result');
  assert.ok(toolResultRow);
  assert.equal(toolResultRow.payload.metadata.diff.additions, 1);
  assert.deepEqual(toolResultRow.payload.metadata.diff.hunks[0].lines, ['-old', '+new']);
});

test('reducer places post-tool reasoning after the tool row in canonical order', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    content: 'Working on it.',
    aggregate: 'Working on it.',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-pre', text: 'Plan first.' }],
    },
  }, {
    phase_id: 'phase-pre',
    segmentText: 'Working on it.',
    segmentIndex: 0,
    assistant_phase: 'commentary',
  });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-read',
    toolName: 'Read',
    status: 'completed',
    summary: 'Read README',
  }, {
    primary_tool_message_id: 'tool_use_call-read',
  });
  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    content: 'Final answer.',
    aggregate: 'Working on it.Final answer.',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-post', text: 'Now explain the result.' }],
    },
  }, {
    primary_assistant_message_id: 'assistant_stream-batch5_seg1',
    segmentText: 'Final answer.',
    segmentIndex: 1,
    phase_id: 'phase-post',
    assistant_phase: 'final_answer',
  });

  assert.deepEqual(
    turn.rows.map((row) => [row.kind, row.primary_message_id]),
    [
      ['reasoning', 'assistant_stream-batch5'],
      ['assistant_text', 'assistant_stream-batch5'],
      ['tool_call', 'tool_use_call-read'],
      ['reasoning', 'assistant_stream-batch5_seg1'],
      ['assistant_text', 'assistant_stream-batch5_seg1'],
    ]
  );
});

test('reducer replaces live reasoning entry snapshots with the same id', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-live', text: 'The', thinkingId: 'think-live' }],
    },
    thinkingId: 'think-live',
  }, {
    phase_id: 'phase-live',
  });
  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-live', text: 'The user', thinkingId: 'think-live' }],
    },
    thinkingId: 'think-live',
  }, {
    phase_id: 'phase-live',
  });

  const reasoningRows = turn.rows.filter((row) => row.kind === 'reasoning');
  assert.equal(reasoningRows.length, 1);
  assert.deepEqual(
    reasoningRows[0].payload.entries.map((entry) => entry.text),
    ['The user']
  );
});

test('reducer appends live reasoning deltas without replacing the entries list', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  const initialTurn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-live-1', text: 'First chunk' }],
    },
  }, {
    phase_id: 'phase-live-list',
  });

  const reasoningRow = initialTurn.rows.find((row) => row.kind === 'reasoning');
  assert.ok(reasoningRow);
  const entries = reasoningRow.payload.entries;

  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-live-2', text: 'Second chunk' }],
    },
  }, {
    phase_id: 'phase-live-list',
  });

  const updatedRow = turn.rows.find((row) => row.kind === 'reasoning');
  assert.equal(updatedRow.payload.entries, entries);
  assert.deepEqual(
    updatedRow.payload.entries.map((entry) => entry.text),
    ['First chunk', 'Second chunk']
  );
});

test('reducer keeps id-less duplicate reasoning deltas deduped without replacing the entries list', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  const initialTurn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ text: 'Repeated anonymous chunk', timestamp: '2026-05-16T00:00:00.000Z' }],
    },
  }, {
    phase_id: 'phase-live-dedupe',
  });
  const reasoningRow = initialTurn.rows.find((row) => row.kind === 'reasoning');
  assert.ok(reasoningRow);
  const entries = reasoningRow.payload.entries;

  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ text: 'Repeated anonymous chunk', timestamp: '2026-05-16T00:00:00.000Z' }],
    },
  }, {
    phase_id: 'phase-live-dedupe',
  });

  const updatedRow = turn.rows.find((row) => row.kind === 'reasoning');
  assert.equal(updatedRow.payload.entries, entries);
  assert.deepEqual(
    updatedRow.payload.entries.map((entry) => entry.text),
    ['Repeated anonymous chunk']
  );
});

test('reducer preserves V2 envelope phase metadata on reasoning and text rows', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    phase: {
      phaseId: 'phase_reasoning_v2',
      phaseKind: 'reasoning',
      iteration: 2,
      summary: 'Provider summary',
    },
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-v2', text: 'Checking intent' }],
    },
  });
  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    content: 'Hello from V2.',
    phase: {
      phaseId: 'phase_text_v2',
      phaseKind: 'text',
      iteration: 2,
    },
  }, {
    segmentText: 'Hello from V2.',
    segmentIndex: 0,
  });

  const reasoningRow = turn.rows.find((row) => row.kind === 'reasoning');
  const textRow = turn.rows.find((row) => row.kind === 'assistant_text');
  assert.ok(reasoningRow);
  assert.ok(textRow);
  assert.equal(reasoningRow.phase_id, 'phase_reasoning_v2');
  assert.deepEqual(reasoningRow.payload.phase, {
    phase_id: 'phase_reasoning_v2',
    phase_kind: 'reasoning',
    iteration: 2,
    summary: 'Provider summary',
  });
  assert.equal(textRow.payload.segments[0].phase_id, 'phase_text_v2');
  assert.deepEqual(textRow.payload.segments[0].phase, {
    phase_id: 'phase_text_v2',
    phase_kind: 'text',
    iteration: 2,
  });
});

test('reducer tracks approval state transitions on the tool_call row', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-approval',
    toolName: 'Write',
    status: 'pending_approval',
    summary: 'Write file',
  }, {
    primary_tool_message_id: 'tool_use_call-approval',
  });
  applyPayload(state, {
    type: 'tool_approval_needed',
    streamId: 'stream-batch5',
    callId: 'call-approval',
    toolName: 'Write',
  }, {
    primary_tool_message_id: 'tool_use_call-approval',
  });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-approval',
    toolName: 'Write',
    status: 'running',
    summary: 'Write file',
  }, {
    primary_tool_message_id: 'tool_use_call-approval',
  });
  const turn = applyPayload(state, {
    type: 'tool_result',
    streamId: 'stream-batch5',
    callId: 'call-approval',
    toolName: 'Write',
    content: 'ok',
    summary: 'Wrote file',
  }, {
    primary_tool_message_id: 'tool_use_call-approval',
    tool_result_message_id: 'tool_result_call-approval',
  });

  assert.deepEqual(
    turn.rows.map((row) => row.kind),
    ['tool_call', 'tool_result']
  );
  const toolCallRow = turn.rows.find((row) => row.kind === 'tool_call');
  assert.equal(toolCallRow.payload.state, 'completed');
  // Two entries: the pending_approval tool_use and the tool_approval_needed
  // event each append one approval-request record. Pinned exactly so a future
  // change that drops or double-counts a transition is caught.
  assert.equal(toolCallRow.payload.approval_requests.length, 2, 'both approval-signaling events are recorded, with no extra duplication');
  const toolResultRow = turn.rows.find((row) => row.kind === 'tool_result');
  assert.equal(toolResultRow.payload.state, 'completed');
});

// Live plan-variant gap-row coverage: tests/renderer-turn-reducer-approval-variant.test.js.
test('reducer stamps approval_requested_at_ms once when a tool enters awaiting_approval', () => {
  /* Strictly-increasing fake clock: if the stamp were NOT guarded, the second approval-signaling
     event would re-call Date.now and the value would change — so this catches a broken guard. */
  const realNow = Date.now;
  let fakeClock = 1000000;
  Date.now = () => { fakeClock += 1000; return fakeClock; };
  try {
    const state = createTurnReducerState();
    applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
    const turn = applyPayload(state, {
      type: 'tool_use',
      streamId: 'stream-batch5',
      callId: 'call-approval-stamp',
      toolName: 'run_shell',
      status: 'pending_approval',
      summary: 'git push origin main',
    }, {
      primary_tool_message_id: 'tool_use_call-approval-stamp',
    });
    const row = turn.rows.find((r) => r.kind === 'tool_call');
    assert.equal(row.payload.state, 'awaiting_approval');
    const stamped = row.payload.approval_requested_at_ms;
    assert.ok(Number.isFinite(stamped) && stamped > 0, 'a real requested-at timestamp is stamped on first awaiting_approval');

    /* A second approval-signaling event for the same call must NOT re-stamp — it marks WHEN the
       approval was first requested, not "now". */
    const again = applyPayload(state, {
      type: 'tool_approval_needed',
      streamId: 'stream-batch5',
      callId: 'call-approval-stamp',
      toolName: 'run_shell',
    }, {
      primary_tool_message_id: 'tool_use_call-approval-stamp',
    });
    const sameRow = again.rows.find((r) => r.kind === 'tool_call');
    assert.equal(sameRow.payload.approval_requested_at_ms, stamped, 'the requested-at anchor is set once and never resets');
  } finally {
    Date.now = realNow;
  }
});

test('reducer emits a single standalone approval_gap row while a tool awaits approval', () => {
  // Regression for the "Awaiting approval" soft-lock: the live streaming reducer
  // must surface the standalone approval_gap row (the Allow/Deny block), not just
  // flip the tool_call row's status — otherwise the buttons never render live.
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-approval',
    toolName: 'edit_file',
    status: 'pending_approval',
    approvalId: 'appr-1',
    summary: 'Edit test.py',
  }, {
    primary_tool_message_id: 'tool_use_call-approval',
  });

  let turn = state.turns_by_id['stream-batch5'];
  assert.deepEqual(
    turn.rows.map((row) => row.kind),
    ['tool_call', 'approval_gap'],
    'a standalone approval_gap row is emitted right after the tool_call row'
  );
  const gapRow = turn.rows.find((row) => row.kind === 'approval_gap');
  assert.equal(gapRow.tool_call_id, 'call-approval');
  assert.equal(gapRow.payload.state, 'awaiting_approval');
  // status mirrors the hydrated projector (normalize(event.status)) so live and
  // hydrated gap rows agree rather than drifting to 'pending' vs 'pending_approval'.
  assert.equal(gapRow.payload.status, 'pending_approval');
  assert.equal(gapRow.payload.tool_name, 'edit_file');
  assert.equal(gapRow.payload.approval_id, 'appr-1', 'the gap row carries approval_id so Allow/Deny target the right approval');
  assert.equal(gapRow.payload.prompt, 'Edit test.py', 'live prompt mirrors the hydrated row (sourced from summary)');
  // The gap row shares the tool_call row's anchor so it buckets into the same
  // rendered article (live rows have no render_message_id).
  const toolCallRow = turn.rows.find((row) => row.kind === 'tool_call');
  assert.equal(gapRow.primary_message_id, toolCallRow.primary_message_id);

  // A second approval-signaling event for the same call must NOT add a duplicate.
  turn = applyPayload(state, {
    type: 'tool_approval_needed',
    streamId: 'stream-batch5',
    callId: 'call-approval',
    toolName: 'edit_file',
  }, {
    primary_tool_message_id: 'tool_use_call-approval',
  });
  assert.equal(
    turn.rows.filter((row) => row.kind === 'approval_gap').length,
    1,
    'idempotent: the gap row is not duplicated by repeated approval signals'
  );
});

test('reducer removes the approval_gap row when the approval resolves, with intact index repair', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  // Call A enters awaiting_approval → tool_call(A) + approval_gap(A).
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-A',
    toolName: 'edit_file',
    status: 'pending_approval',
    approvalId: 'appr-A',
    summary: 'Edit file A',
  }, { primary_tool_message_id: 'tool_use_call-A' });
  // A second, unrelated tool starts running AFTER the gap row, so call-B's
  // row-index sits past the gap and must be repaired when the gap is spliced.
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-B',
    toolName: 'Read',
    status: 'running',
    summary: 'Read file B',
  }, { primary_tool_message_id: 'tool_use_call-B' });

  let turn = state.turns_by_id['stream-batch5'];
  assert.deepEqual(
    turn.rows.map((row) => row.kind),
    ['tool_call', 'approval_gap', 'tool_call'],
    'gap row sits between the two tool_call rows before resolution'
  );

  // Resolve call A (approved → running): the gap row is spliced out.
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-A',
    toolName: 'edit_file',
    status: 'running',
    summary: 'Edit file A',
  }, { primary_tool_message_id: 'tool_use_call-A' });

  turn = state.turns_by_id['stream-batch5'];
  assert.equal(turn.rows.filter((row) => row.kind === 'approval_gap').length, 0, 'gap row removed once the call leaves awaiting_approval');
  assert.deepEqual(turn.rows.map((row) => row.kind), ['tool_call', 'tool_call']);

  // Index repair check: call-B's tool_result must still reconcile to its existing
  // row (not create a duplicate) after the gap splice shifted indices.
  turn = applyPayload(state, {
    type: 'tool_result',
    streamId: 'stream-batch5',
    callId: 'call-B',
    toolName: 'Read',
    content: 'file B contents',
    summary: 'Read file B',
  }, {
    primary_tool_message_id: 'tool_use_call-B',
    tool_result_message_id: 'tool_result_call-B',
  });
  assert.equal(turn.rows.filter((row) => row.kind === 'tool_call').length, 2, 'no duplicate tool_call row for B after the splice');
  const callBRow = turn.rows.find((row) => row.kind === 'tool_call' && row.tool_call_id === 'call-B');
  assert.equal(callBRow.payload.state, 'completed', 'call-B reconciled to completed via the repaired index');
});

test('reducer removes the approval_gap row when an approval is denied', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-deny',
    toolName: 'edit_file',
    status: 'pending_approval',
    approvalId: 'appr-deny',
    summary: 'Edit file',
  }, { primary_tool_message_id: 'tool_use_call-deny' });

  let turn = state.turns_by_id['stream-batch5'];
  assert.equal(turn.rows.filter((row) => row.kind === 'approval_gap').length, 1);

  turn = applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-deny',
    toolName: 'edit_file',
    status: 'denied',
    approvalState: 'denied',
    summary: 'Edit file',
  }, { primary_tool_message_id: 'tool_use_call-deny' });

  assert.equal(turn.rows.filter((row) => row.kind === 'approval_gap').length, 0, 'denied resolution retracts the gap row');
  const toolCallRow = turn.rows.find((row) => row.kind === 'tool_call');
  assert.equal(toolCallRow.payload.state, 'denied');
});

test('reducer removeApprovalGapRow tolerates a stale index pointing at a non-gap row', () => {
  // Defensive-branch contract: if the tracked gap-row index ever points at a row
  // that is no longer an approval_gap (a "shouldn't happen" corruption), removal
  // must drop the stale key without throwing and without splicing the wrong row.
  const state = createTurnReducerState();
  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-stale',
    toolName: 'edit_file',
    status: 'pending_approval',
    approvalId: 'appr-stale',
    summary: 'Edit file',
  }, { primary_tool_message_id: 'tool_use_call-stale' });

  const turn = state.turns_by_id['stream-batch5'];
  // Corrupt the tracked index to point at the tool_call row (index 0, not a gap row).
  turn.approval_gap_row_index_by_call_id['call-stale'] = 0;

  assert.doesNotThrow(() => applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-stale',
    toolName: 'edit_file',
    status: 'running',
    summary: 'Edit file',
  }, { primary_tool_message_id: 'tool_use_call-stale' }));

  assert.equal(turn.approval_gap_row_index_by_call_id['call-stale'], undefined, 'the stale index key is dropped');
  assert.ok(turn.rows.some((row) => row.kind === 'tool_call'), 'the tool_call row is not erroneously spliced');
});

test('reducer abandons approved tool rows when later assistant text proves execution moved on without a result', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-approved-gap',
    toolName: 'Write',
    status: 'approved',
    approvalState: 'approved',
    summary: 'Write todo-list.md',
    input: { path: 'todo-list.md' },
  }, {
    primary_tool_message_id: 'tool_use_call-approved-gap',
  });
  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    content: 'That path did not finish, so I am continuing another way.',
    aggregate: 'That path did not finish, so I am continuing another way.',
  }, {
    primary_assistant_message_id: 'assistant_stream-batch5_seg1',
    segmentText: 'That path did not finish, so I am continuing another way.',
    segmentIndex: 1,
    assistant_phase: 'intermediate',
  });

  assert.deepEqual(
    turn.rows.map((row) => row.kind),
    ['tool_call', 'assistant_text']
  );
  assert.equal(turn.rows[0].payload.state, 'abandoned');
  assert.equal(turn.rows[1].payload.text, 'That path did not finish, so I am continuing another way.');
});

test('reducer keeps approved tool rows queued when phase lifecycle events add no reasoning entries', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-approved-phase-gap',
    toolName: 'Write',
    status: 'approved',
    approvalState: 'approved',
    summary: 'Write todo-list.md',
    input: { path: 'todo-list.md' },
  }, {
    primary_tool_message_id: 'tool_use_call-approved-phase-gap',
  });
  const turn = applyPayload(state, {
    type: 'phase_started',
    streamId: 'stream-batch5',
    phaseId: 'phase-empty',
    phaseKind: 'reasoning',
  }, {
    primary_assistant_message_id: 'assistant_stream-batch5_seg1',
  });

  assert.deepEqual(
    turn.rows.map((row) => row.kind),
    ['tool_call']
  );
  assert.equal(turn.rows[0].payload.state, 'approved');
});

test('reducer preserves optional phase summaries on reasoning phase events', () => {
  const event = buildTurnEventFromStreamPayload({
    type: 'phase_started',
    streamId: 'stream-batch5',
    phaseId: 'phase-v2-reasoning',
    phaseKind: 'reasoning',
    thinkingId: 'think-v2',
    summary: 'Inspecting the workspace map',
  }, {
    turn_id: 'stream-batch5',
    primary_assistant_message_id: 'assistant_stream-batch5',
    ordinal: 0,
  });

  assert.equal(event.kind, 'reasoning_phase');
  assert.equal(event.payload.summary, 'Inspecting the workspace map');
});

test('reducer updates existing phase summaries without clearing on empty completion payloads', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    summary: 'Initial summary',
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-summary', text: 'Checking state.' }],
    },
  }, {
    phase_id: 'phase-summary-update',
  });
  applyPayload(state, {
    type: 'phase_completed',
    streamId: 'stream-batch5',
    phaseId: 'phase-summary-update',
    phaseKind: 'reasoning',
    summary: 'Completed summary',
  });
  const turn = applyPayload(state, {
    type: 'phase_completed',
    streamId: 'stream-batch5',
    phaseId: 'phase-summary-update',
    phaseKind: 'reasoning',
  });

  const reasoningRow = turn.rows.find((row) => row.kind === 'reasoning');
  assert.equal(reasoningRow.payload.summary, 'Completed summary');
  assert.equal(reasoningRow.payload.completed, true);
});

test('reducer caps phase summaries before storing live row payloads', () => {
  const state = createTurnReducerState();
  const longSummary = ` ${'phase summary '.repeat(40)} `;

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    summary: longSummary,
    reasoning: {
      source: 'provider',
      entriesDelta: [{ id: 'reason-long-summary', text: 'Checking state.' }],
    },
  }, {
    phase_id: 'phase-long-summary',
  });

  const reasoningRow = turn.rows.find((row) => row.kind === 'reasoning');
  assert.equal(reasoningRow.payload.summary.length <= 240, true);
  assert.equal(reasoningRow.payload.summary.endsWith('...'), true);
  assert.doesNotMatch(reasoningRow.payload.summary, /\s{2,}/);
});

test('reducer normalizes generated artifacts onto live tool rows', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-artifact',
    toolName: 'CreateArtifact',
    status: 'running',
    summary: 'Create plan',
  }, {
    primary_tool_message_id: 'tool_use_call-artifact',
  });
  const turn = applyPayload(state, {
    type: 'tool_result',
    streamId: 'stream-batch5',
    callId: 'call-artifact',
    toolName: 'CreateArtifact',
    content: 'created',
    summary: 'Create plan',
    generatedArtifacts: [{
      artifactId: 'artifact_plan',
      fileName: 'plan.md',
      displayPath: '.jenny/artifacts/session-1/plan.md',
      absolutePath: 'C:/workspace/.jenny/artifacts/session-1/plan.md',
      language: 'markdown',
      sessionId: 'session-1',
    }],
  }, {
    primary_tool_message_id: 'tool_use_call-artifact',
    tool_result_message_id: 'tool_result_call-artifact',
  });

  assert.deepEqual(turn.rows[0].payload.generated_artifacts, [{
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

test('reducer marks stream-reset rows truncated and restarts segment numbering on a discarding reset', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    content: 'Before reset.',
    aggregate: 'Before reset.',
  }, {
    segmentText: 'Before reset.',
    segmentIndex: 0,
  });
  applyPayload(state, {
    type: 'stream_reset',
    streamId: 'stream-batch5',
  }, {
    primary_assistant_message_id: 'assistant_stream-batch5',
    next_assistant_message_id: 'assistant_stream-batch5_seg1',
  });
  const turn = applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    content: 'After reset.',
    aggregate: 'After reset.',
  }, {
    primary_assistant_message_id: 'assistant_stream-batch5_seg1',
    segmentText: 'After reset.',
    segmentIndex: 1,
  });

  assert.equal(turn.rows[0].payload.truncated, true);
  assert.equal(turn.rows[1].primary_message_id, 'assistant_stream-batch5_seg1');
  assert.equal(turn.rows[1].segment_group_index, 0);
  assert.equal(turn.rows[1].payload.segment_group_index, 0);
  assert.equal(turn.rows[1].payload.text, 'After reset.');
});

test('reducer skips the truncation stamp for a preserved tool_continuation reset', () => {
  const state = createTurnReducerState();

  applyPayload(state, { type: 'started', streamId: 'stream-batch5b' });
  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5b',
    content: 'Genuine pre-tool commentary.',
    aggregate: 'Genuine pre-tool commentary.',
  }, {
    segmentText: 'Genuine pre-tool commentary.',
    segmentIndex: 0,
  });
  const turn = applyPayload(state, {
    type: 'stream_reset',
    streamId: 'stream-batch5b',
    reason: 'tool_continuation',
  }, {
    primary_assistant_message_id: 'assistant_stream-batch5b',
    next_assistant_message_id: 'assistant_stream-batch5b_seg1',
  });

  // The commentary was persisted at the tool boundary and survives the reset
  // backend-side — no "restarted" hairline on genuine content.
  assert.equal(turn.rows[0].payload.truncated, false);
});

test('reconcileTurnRows preserves row ids for matched rows and favors hydrated content', () => {
  const provisionalRows = [
    {
      row_id: 'row:provisional-tool',
      turn_id: 'stream-batch5',
      kind: 'tool_call',
      primary_message_id: 'tool_use_call-reconcile',
      source_message_ids: ['tool_use_call-reconcile'],
      source_events: ['tool_use'],
      tool_call_id: 'call-reconcile',
      payload: { tool_call_id: 'call-reconcile', state: 'running', summary: 'Working' },
    },
  ];
  const hydratedRows = [
    {
      row_id: 'row:hydrated-tool',
      turn_id: 'stream-batch5',
      kind: 'tool_call',
      primary_message_id: 'tool_use_call-reconcile',
      source_message_ids: ['tool_use_call-reconcile', 'tool_result_call-reconcile'],
      source_events: ['tool_use', 'tool_result'],
      tool_call_id: 'call-reconcile',
      payload: { tool_call_id: 'call-reconcile', state: 'completed', summary: 'Done' },
    },
  ];

  const result = reconcileTurnRows(provisionalRows, hydratedRows);
  assert.equal(result.finalRows.length, 1);
  assert.equal(result.finalRows[0].row_id, 'row:provisional-tool');
  assert.equal(result.finalRows[0].payload.state, 'completed');
  assert.deepEqual(result.staleRows, []);
});

test('reconcileTurnRows supports interrupted running-tool hydration', () => {
  const provisionalRows = [
    {
      row_id: 'row:running-tool',
      turn_id: 'stream-batch5',
      kind: 'tool_call',
      primary_message_id: 'tool_use_call-running',
      source_message_ids: ['tool_use_call-running'],
      source_events: ['tool_use_running'],
      tool_call_id: 'call-running',
      payload: { tool_call_id: 'call-running', state: 'running' },
    },
  ];
  const hydratedRows = [
    {
      row_id: 'row:hydrated-running-tool',
      turn_id: 'stream-batch5',
      kind: 'tool_call',
      primary_message_id: 'tool_use_call-running',
      source_message_ids: ['tool_use_call-running'],
      source_events: ['tool_use_running'],
      tool_call_id: 'call-running',
      payload: { tool_call_id: 'call-running', state: 'interrupted' },
    },
  ];

  const result = reconcileTurnRows(provisionalRows, hydratedRows);
  assert.equal(result.finalRows[0].row_id, 'row:running-tool');
  assert.equal(result.finalRows[0].payload.state, 'interrupted');
});

// D1 integration contract (the trace-parity reflow witness): a tool turn
// streamed through the LIVE reducer (createToolCallRow + createToolResultRow)
// must reconcile against the SOLE trace projector's hydrated rows with
// staleRows EMPTY and row_ids carried forward. A hand-built reconcile (above)
// cannot catch a divergence between the reducer's emitted kinds/identity keys
// and the projector's — this drives both through the real producers.
test('D1: a live-streamed tool turn reconciles against the trace projection with no stale rows', () => {
  const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
  const state = createTurnReducerState();

  applyPayload(state, {
    type: 'delta',
    streamId: 'stream-batch5',
    content: 'Checking the file.',
  }, { segmentText: 'Checking the file.', segmentIndex: 0, assistant_phase: 'commentary' });
  applyPayload(state, {
    type: 'tool_use',
    streamId: 'stream-batch5',
    callId: 'call-d1',
    toolName: 'Read',
    status: 'running',
    summary: 'Read README',
  }, { primary_tool_message_id: 'tool_use_call-d1' });
  const turn = applyPayload(state, {
    type: 'tool_result',
    streamId: 'stream-batch5',
    callId: 'call-d1',
    toolName: 'Read',
    content: 'file body',
    isError: false,
  }, { primary_tool_message_id: 'tool_use_call-d1', tool_result_message_id: 'tool_result_call-d1' });

  // The live reducer emits trace-shaped provisional rows (not a coalesced tool_step).
  assert.deepEqual(turn.rows.map((row) => row.kind), ['assistant_text', 'tool_call', 'tool_result']);

  // Project the SAME events through the (now sole) trace projector and reconcile.
  const hydratedRows = projectTurnRows(turn.events);
  const reconciliation = reconcileTurnRows(turn.rows, hydratedRows);

  // No settled-row reflow: every provisional row matched a hydrated row by
  // identity key (kind|turnId|toolCallId), so nothing is stranded as stale.
  assert.deepEqual(reconciliation.staleRows, []);

  // DOM stability: the matched tool rows keep their provisional row_id.
  const provToolCall = turn.rows.find((row) => row.kind === 'tool_call');
  const provToolResult = turn.rows.find((row) => row.kind === 'tool_result');
  const finalToolCall = reconciliation.finalRows.find((row) => row.kind === 'tool_call');
  const finalToolResult = reconciliation.finalRows.find((row) => row.kind === 'tool_result');
  assert.equal(finalToolCall.row_id, provToolCall.row_id);
  assert.equal(finalToolResult.row_id, provToolResult.row_id);
  // ...and the settled content comes from the hydrated (canonical) projection.
  assert.equal(finalToolResult.payload.output_text, 'file body');
});

test('reducer stamps a terminal status on complete so the deck can settle', () => {
  const state = createTurnReducerState();
  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  const turn = applyPayload(state, { type: 'complete', streamId: 'stream-batch5' });
  // Without this stamp the turn stays implicitly 'streaming' and the Active Turn
  // V2 deck rests on "Thinking" after a successful turn (buildTerminal reads
  // turn.status to derive the 'Complete' headline).
  assert.equal(turn.status, 'completed');
});

test('reducer stamps an errored status on error so the deck reads Needs Recovery', () => {
  const state = createTurnReducerState();
  applyPayload(state, { type: 'started', streamId: 'stream-batch5' });
  const turn = applyPayload(state, { type: 'error', streamId: 'stream-batch5' });
  assert.equal(turn.status, 'errored');
});
