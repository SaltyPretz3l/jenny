'use strict';

// Row 34 S5: scripted calls (run_command, run_temp_script, python_execute)
// keep their changes in the ledger even when the call failed, and every call
// with a scripted_change_review leaves a notice for History.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildJennyChangeLedgerFromTurnViewModels,
  normalizeJennyChangesFromToolCall,
} = require('../renderer/chat/renderer-jenny-change-ledger');

function review(overrides = {}) {
  return {
    schema_version: 1,
    state: 'observed',
    certainty: 'observed_during_call',
    call_outcome: 'succeeded',
    changed_paths: ['src/app.py'],
    changed_path_count: 1,
    diff_count: 1,
    summary_only_count: 0,
    omitted_count: 0,
    coverage: 'git_status_paths',
    ...overrides,
  };
}

function scriptedDiff(overrides = {}) {
  return {
    diff_id: 'scripted:call_py:0',
    operation_index: 0,
    path: 'src/app.py',
    status: 'modified',
    review_state: 'full',
    body_kind: 'inline_hunks',
    additions: 1,
    deletions: 1,
    truncated: false,
    truncation_reason: null,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a = 1', '+a = 2'] }],
    ...overrides,
  };
}

function scriptedCall(overrides = {}) {
  return {
    toolCallId: 'call_py',
    toolName: 'python_execute',
    state: 'errored',
    resultIsError: true,
    sourceMessageIds: ['use_py', 'result_py'],
    input: { code: 'open("src/app.py", "w").write("a = 2")\nraise SystemExit(1)' },
    resultMetadata: {
      workspace_id: 'workspace_a',
      diffs: [scriptedDiff()],
      scripted_change_review: review({ call_outcome: 'failed' }),
    },
    ...overrides,
  };
}

function ledgerFor(toolCalls) {
  return buildJennyChangeLedgerFromTurnViewModels(
    [{ turnId: 'turn_1', rootMessageIds: { assistant: 'assistant_1' }, toolCalls }],
    { sessionId: 'session_1', workspaceId: 'workspace_a' }
  );
}

test('a failed python_execute that changed one file appears with its diff', () => {
  const ledger = ledgerFor([scriptedCall()]);
  assert.deepEqual(ledger.skipped, []);
  assert.equal(ledger.changes.length, 1);
  const [change] = ledger.changes;
  assert.equal(change.changeId, 'scripted:call_py:0');
  assert.equal(change.path, 'src/app.py');
  assert.equal(change.toolName, 'python_execute');
  assert.equal(change.callOutcome, 'failed');
  assert.equal(change.scripted, true);
  assert.equal(change.sensitive, false);
  assert.equal(change.reviewable, true);
  assert.deepEqual(change.hunks[0].lines, ['-a = 1', '+a = 2']);
});

test('cancelled and timed-out calls with diffs are kept; the outcome is derived without a review', () => {
  const cancelled = scriptedCall({
    toolCallId: 'call_cancelled', toolName: 'run_command', state: 'cancelled',
    resultMetadata: { diffs: [scriptedDiff({ diff_id: 'diff_cancelled' })] },
  });
  const timedOut = scriptedCall({
    toolCallId: 'call_timeout', toolName: 'run_temp_script', state: 'timed_out',
    resultMetadata: { timed_out: true, diffs: [scriptedDiff({ diff_id: 'diff_timeout' })] },
  });
  const ledger = ledgerFor([cancelled, timedOut]);
  assert.deepEqual(ledger.changes.map((change) => change.changeId), ['diff_cancelled', 'diff_timeout']);
  assert.deepEqual(ledger.changes.map((change) => change.callOutcome), ['cancelled', 'timed_out']);
  assert.deepEqual(ledger.changes.map((change) => change.scripted), [true, true]);
  assert.deepEqual(ledger.notices, []);
});

test('the review outcome wins over the derived one, and a completed call reads succeeded', () => {
  const withReview = normalizeJennyChangesFromToolCall(scriptedCall({
    state: 'errored',
    resultMetadata: { diffs: [scriptedDiff()], scripted_change_review: review({ call_outcome: 'timed_out' }) },
  }), { turnId: 'turn_1' });
  assert.equal(withReview.changes[0].callOutcome, 'timed_out');

  const completed = normalizeJennyChangesFromToolCall(scriptedCall({
    toolName: 'Write', state: 'completed', resultIsError: false,
    resultMetadata: { diff: scriptedDiff({ diff_id: 'diff_write' }) },
  }), { turnId: 'turn_1' });
  assert.equal(completed.changes[0].callOutcome, 'succeeded');
  assert.equal(completed.changes[0].scripted, false);
});

test('a failed call with no diffs and no review is still skipped as unsuccessful', () => {
  const ledger = ledgerFor([scriptedCall({ resultMetadata: { stderr: 'boom' } })]);
  assert.deepEqual(ledger.changes, []);
  assert.deepEqual(ledger.skipped.map((item) => item.reason), ['tool_not_successful']);
  assert.deepEqual(ledger.notices, []);
});

test('a sensitive summary-only entry is marked sensitive', () => {
  const ledger = ledgerFor([scriptedCall({
    state: 'completed', resultIsError: false,
    resultMetadata: {
      diffs: [scriptedDiff({
        diff_id: 'diff_env', path: '.env', review_state: 'summary_only', body_kind: 'summary_only',
        additions: 0, deletions: 0, truncated: true, truncation_reason: 'sensitive_path', hunks: [],
      })],
      scripted_change_review: review({ state: 'partial', summary_only_count: 1 }),
    },
  })]);
  assert.equal(ledger.changes[0].sensitive, true);
  assert.equal(ledger.changes[0].callOutcome, 'succeeded');
});

test('every call with a review leaves one notice for History', () => {
  const ledger = ledgerFor([
    scriptedCall({
      toolCallId: 'call_unavailable', toolName: 'run_command', state: 'completed', resultIsError: false,
      resultMetadata: { scripted_change_review: review({
        state: 'unavailable', reason: 'probe_failed', changed_paths: [], changed_path_count: 0, diff_count: 0,
      }) },
    }),
    scriptedCall({
      toolCallId: 'call_unsupported', toolName: 'run_temp_script', state: 'errored', resultIsError: true,
      resultMetadata: { scripted_change_review: review({
        state: 'unsupported', reason: 'not_git', call_outcome: 'failed', changed_paths: [], changed_path_count: 0,
      }) },
    }),
    scriptedCall({
      toolCallId: 'call_background', toolName: 'run_command', state: 'completed', resultIsError: false,
      resultMetadata: { scripted_change_review: review({
        state: 'unavailable', reason: 'background', changed_paths: [], changed_path_count: 0,
      }) },
    }),
    scriptedCall({
      toolCallId: 'call_over_cap', toolName: 'python_execute', state: 'completed', resultIsError: false,
      resultMetadata: {
        diffs: [scriptedDiff({ diff_id: 'diff_over_cap' })],
        scripted_change_review: review({
          state: 'partial', certainty: 'background_window', changed_path_count: 75, omitted_count: 55,
        }),
      },
    }),
  ]);
  assert.deepEqual(ledger.notices, [
    {
      turnId: 'turn_1', toolCallId: 'call_unavailable', toolName: 'run_command', state: 'unavailable',
      reason: 'probe_failed', certainty: 'observed_during_call', callOutcome: 'succeeded',
      changedPathCount: 0, omittedCount: 0, restorePoint: null,
    },
    {
      turnId: 'turn_1', toolCallId: 'call_unsupported', toolName: 'run_temp_script', state: 'unsupported',
      reason: 'not_git', certainty: 'observed_during_call', callOutcome: 'failed',
      changedPathCount: 0, omittedCount: 0, restorePoint: null,
    },
    {
      turnId: 'turn_1', toolCallId: 'call_background', toolName: 'run_command', state: 'unavailable',
      reason: 'background', certainty: 'observed_during_call', callOutcome: 'succeeded',
      changedPathCount: 0, omittedCount: 0, restorePoint: null,
    },
    {
      turnId: 'turn_1', toolCallId: 'call_over_cap', toolName: 'python_execute', state: 'partial',
      reason: null, certainty: 'background_window', callOutcome: 'succeeded',
      changedPathCount: 75, omittedCount: 55, restorePoint: null,
    },
  ]);
  assert.deepEqual(ledger.changes.map((change) => change.changeId), ['diff_over_cap']);
  // The failed call with only a review is kept for its notice, not skipped as unsuccessful.
  assert.equal(ledger.skipped.some((item) => item.reason === 'tool_not_successful'), false);
});

test('notices are bounded to 100', () => {
  const calls = Array.from({ length: 105 }, (_, index) => scriptedCall({
    toolCallId: `call_${index}`, state: 'completed', resultIsError: false,
    resultMetadata: { scripted_change_review: review({ changed_paths: [], changed_path_count: 0 }) },
  }));
  const ledger = ledgerFor(calls);
  assert.equal(ledger.notices.length, 100);
  assert.equal(ledger.notices[99].toolCallId, 'call_99');
});

test('a review that does not validate is no evidence for keeping a failed call', () => {
  const ledger = ledgerFor([scriptedCall({ resultMetadata: { scripted_change_review: { state: 'observed' } } })]);
  assert.deepEqual(ledger.skipped.map((item) => item.reason), ['tool_not_successful']);
  assert.deepEqual(ledger.notices, []);
});

test('changes and notices carry the review restore point', () => {
  const point = { kind: 'git_checkpoint', ref: 'refs/jenny/checkpoints/s1/3', created_at: '2026-10-05T12:00:00.000Z' };
  const ledger = ledgerFor([scriptedCall({
    resultMetadata: {
      workspace_id: 'workspace_a',
      diffs: [scriptedDiff()],
      scripted_change_review: review({ call_outcome: 'failed', restore_point: point }),
    },
  })]);
  const expected = { kind: 'git_checkpoint', ref: point.ref, createdAt: point.created_at };
  assert.deepEqual(ledger.changes[0].restorePoint, expected);
  assert.deepEqual(ledger.notices[0].restorePoint, expected);
  const none = ledgerFor([scriptedCall()]);
  assert.equal(none.changes[0].restorePoint, null);
});
