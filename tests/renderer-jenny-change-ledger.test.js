'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildJennyChangeLedgerFromTurnViewModels,
  normalizeJennyChangeFromToolCall,
  normalizeJennyChangesFromToolCall,
} = require('../renderer/chat/renderer-jenny-change-ledger');

function turn(turnId, toolCalls) {
  return {
    turnId,
    rootMessageIds: { assistant: `assistant_${turnId}` },
    toolCalls,
  };
}

function diff(overrides = {}) {
  return {
    diff_id: 'diff_1',
    operation_index: 0,
    status: 'modified',
    review_state: 'full',
    body_kind: 'inline_hunks',
    additions: 2,
    deletions: 1,
    truncated: false,
    truncation_reason: null,
    before_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    after_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hash_kind: 'diff_input_text',
    hunks: [{
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 2,
      lines: ['-old', '+new', '+line'],
    }],
    ...overrides,
  };
}

function completedTool(overrides = {}) {
  return {
    toolCallId: 'call_1',
    toolName: 'Write',
    state: 'completed',
    resultIsError: false,
    sourceMessageIds: ['tool_use_1', 'tool_result_1'],
    input: { path: 'src/app.js' },
    resultMetadata: {
      workspace_id: 'workspace_a',
      path: 'src/app.js',
      changed: true,
      diff: diff(),
    },
    ...overrides,
  };
}

test('buildJennyChangeLedgerFromTurnViewModels extracts bounded diff metadata from canonical tool calls', () => {
  const sourceTool = completedTool();
  const ledger = buildJennyChangeLedgerFromTurnViewModels(
    [turn('turn_1', [sourceTool])],
    { sessionId: 'session_1', workspaceId: 'workspace_a' }
  );

  assert.equal(ledger.sessionId, 'session_1');
  assert.equal(ledger.workspaceId, 'workspace_a');
  assert.deepEqual(ledger.skipped, []);
  assert.equal(ledger.changes.length, 1);
  const change = ledger.changes[0];
  assert.equal(change.changeId, 'diff_1');
  assert.equal(change.diffId, 'diff_1');
  assert.equal(change.operationIndex, 0);
  assert.equal(change.workspaceId, 'workspace_a');
  assert.equal(change.fileKey, 'workspace_a:src/app.js');
  assert.equal(change.path, 'src/app.js');
  assert.equal(change.oldPath, null);
  assert.equal(change.turnId, 'turn_1');
  assert.equal(change.sourceMessageId, 'tool_result_1');
  assert.equal(change.toolCallId, 'call_1');
  assert.equal(change.toolName, 'Write');
  assert.equal(change.status, 'modified');
  assert.equal(change.reviewState, 'full');
  assert.equal(change.reviewable, true);
  assert.equal(change.bodyKind, 'inline_hunks');
  assert.equal(change.additions, 2);
  assert.equal(change.deletions, 1);
  assert.equal(change.truncated, false);
  assert.equal(change.truncationReason, null);
  assert.equal(change.hashKind, 'diff_input_text');
  assert.deepEqual(change.hunks[0].lines, ['-old', '+new', '+line']);

  sourceTool.resultMetadata.diff.hunks[0].lines.push('+mutated');
  assert.deepEqual(change.hunks[0].lines, ['-old', '+new', '+line']);
});

test('recorded workspace provenance wins and legacy rows fail closed to unknown', () => {
  const recorded = buildJennyChangeLedgerFromTurnViewModels(
    [turn('turn_recorded', [completedTool()])],
    { workspaceId: 'workspace_current' }
  );
  assert.equal(recorded.changes[0].workspaceId, 'workspace_a');

  const legacyTool = completedTool({
    resultMetadata: { path: 'src/app.js', changed: true, diff: diff() },
  });
  const legacy = buildJennyChangeLedgerFromTurnViewModels(
    [turn('turn_legacy', [legacyTool])],
    { workspaceId: 'workspace_current' }
  );
  assert.equal(legacy.changes[0].workspaceId, 'unknown');
});

test('buildJennyChangeLedgerFromTurnViewModels expands plural diff metadata', () => {
  const sourceTool = completedTool({
    toolCallId: 'call_apply_patch',
    toolName: 'apply_patch',
    input: { patch: '*** Begin Patch\n*** End Patch\n' },
    resultMetadata: {
      workspace_id: 'workspace_apply',
      diffs: [
        diff({
          diff_id: 'diff_apply_0',
          operation_index: 0,
          path: 'src/one.js',
          additions: 1,
          deletions: 0,
        }),
        diff({
          diff_id: 'diff_apply_1',
          operation_index: 1,
          path: 'src/two.js',
          additions: 1,
          deletions: 1,
        }),
      ],
    },
  });

  const ledger = buildJennyChangeLedgerFromTurnViewModels(
    [turn('turn_apply', [sourceTool])],
    { workspaceId: 'workspace_apply' }
  );

  assert.deepEqual(ledger.skipped, []);
  assert.equal(ledger.changes.length, 2);
  assert.deepEqual(ledger.changes.map((change) => change.changeId), [
    'diff_apply_0',
    'diff_apply_1',
  ]);
  assert.deepEqual(ledger.changes.map((change) => change.path), [
    'src/one.js',
    'src/two.js',
  ]);
  assert.deepEqual(ledger.changes.map((change) => change.operationIndex), [0, 1]);
  assert.deepEqual(ledger.changes.map((change) => change.fileKey), [
    'workspace_apply:src/one.js',
    'workspace_apply:src/two.js',
  ]);
});

test('normalizeJennyChangesFromToolCall isolates malformed plural diff entries', () => {
  const result = normalizeJennyChangesFromToolCall(
    completedTool({
      toolCallId: 'call_mixed_diffs',
      resultMetadata: {
        diffs: [
          { ...diff({ diff_id: 'diff_valid_plural', path: 'src/valid.js' }) },
          { ...diff({ diff_id: 'diff_invalid_plural', path: '..\\escape.js' }) },
        ],
      },
    }),
    { turnId: 'turn_mixed', workspaceId: 'default' }
  );

  assert.deepEqual(result.changes.map((change) => change.changeId), ['diff_valid_plural']);
  assert.deepEqual(result.skipped.map((item) => item.reason), ['invalid_path']);
});

test('normalizeJennyChangeFromToolCall uses path precedence and isolates unsafe paths', () => {
  const fromDiff = normalizeJennyChangeFromToolCall(
    completedTool({
      toolCallId: 'call_from_diff',
      input: { path: 'src/from-input.js' },
      resultMetadata: {
        path: 'src/from-meta.js',
        diff: {
          ...diff(),
          diff_id: 'diff_from_diff',
          path: 'src/from-diff.js',
        },
      },
    }),
    { turnId: 'turn_1', workspaceId: 'workspace_a' }
  );
  assert.equal(fromDiff.change.path, 'src/from-diff.js');

  const fromMetadata = normalizeJennyChangeFromToolCall(
    completedTool({
      toolCallId: 'call_from_meta',
      input: { path: 'src/from-input.js' },
      resultMetadata: {
        file_path: 'src/from-meta.js',
        diff: diff({ diff_id: 'diff_from_meta' }),
      },
    }),
    { turnId: 'turn_1', workspaceId: 'workspace_a' }
  );
  assert.equal(fromMetadata.change.path, 'src/from-meta.js');

  const fromInput = normalizeJennyChangeFromToolCall(
    completedTool({
      toolCallId: 'call_from_input',
      input: { targetPath: 'src/from-input.js' },
      resultMetadata: {
        diff: diff({ diff_id: 'diff_from_input' }),
      },
    }),
    { turnId: 'turn_1', workspaceId: 'workspace_a' }
  );
  assert.equal(fromInput.change.path, 'src/from-input.js');

  const absolute = normalizeJennyChangeFromToolCall(
    completedTool({
      toolCallId: 'call_absolute',
      resultMetadata: {
        path: 'C:\\Users\\example\\secret.js',
        diff: diff({ diff_id: 'diff_absolute' }),
      },
    }),
    { turnId: 'turn_1', workspaceId: 'workspace_a' }
  );
  assert.equal(absolute.change, null);
  assert.equal(absolute.skip.reason, 'invalid_path');

  const escaping = normalizeJennyChangeFromToolCall(
    completedTool({
      toolCallId: 'call_escape',
      resultMetadata: {
        path: '../secret.js',
        diff: diff({ diff_id: 'diff_escape' }),
      },
    }),
    { turnId: 'turn_1', workspaceId: 'workspace_a' }
  );
  assert.equal(escaping.change, null);
  assert.equal(escaping.skip.reason, 'invalid_path');

  const driveRelative = normalizeJennyChangeFromToolCall(
    completedTool({
      toolCallId: 'call_drive_relative',
      resultMetadata: {
        path: 'C:secret.js',
        diff: diff({ diff_id: 'diff_drive_relative' }),
      },
    }),
    { turnId: 'turn_1', workspaceId: 'workspace_a' }
  );
  assert.equal(driveRelative.change, null);
  assert.equal(driveRelative.skip.reason, 'invalid_path');

  const fileUrlLike = normalizeJennyChangeFromToolCall(
    completedTool({
      toolCallId: 'call_file_url_like',
      resultMetadata: {
        path: 'file:C:/Users/example/secret.js',
        diff: diff({ diff_id: 'diff_file_url_like' }),
      },
    }),
    { turnId: 'turn_1', workspaceId: 'workspace_a' }
  );
  assert.equal(fileUrlLike.change, null);
  assert.equal(fileUrlLike.skip.reason, 'invalid_path');
});

test('ledger infers legacy diff defaults and derives reviewability from review state', () => {
  const legacyFull = completedTool({
    toolCallId: 'call_legacy_full',
    resultMetadata: {
      path: 'src/legacy-full.js',
      changed: true,
      diff: {
        additions: 1,
        deletions: 1,
        hunks: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-old', '+new'],
        }],
      },
    },
  });
  const legacyReviewableFalseWithHunks = completedTool({
    toolCallId: 'call_legacy_false_with_hunks',
    resultMetadata: {
      path: 'src/legacy-hunks.js',
      diff: {
        additions: 1,
        deletions: 1,
        reviewable: false,
        hunks: [{
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ['-old', '+new'],
        }],
      },
    },
  });
  const summaryOnly = completedTool({
    toolCallId: 'call_summary',
    resultMetadata: {
      path: 'src/summary.js',
      diff: {
        additions: 5,
        deletions: 0,
        reviewable: false,
      },
    },
  });
  const failed = completedTool({
    toolCallId: 'call_failed',
    resultMetadata: {
      path: 'src/failed.js',
      diff: {
        additions: 0,
        deletions: 0,
        truncated: true,
        truncation_reason: 'diff_generation_failed',
      },
    },
  });

  const ledger = buildJennyChangeLedgerFromTurnViewModels(
    [turn('turn_legacy', [legacyFull, legacyReviewableFalseWithHunks, summaryOnly, failed])],
    { workspaceId: 'default' }
  );

  const [fullChange, falseWithHunksChange, summaryChange, failedChange] = ledger.changes;
  assert.equal(fullChange.operationIndex, 0);
  assert.equal(fullChange.reviewState, 'full');
  assert.equal(fullChange.reviewable, true);
  assert.equal(fullChange.bodyKind, 'inline_hunks');
  assert.equal(fullChange.status, 'modified');
  assert.equal(fullChange.diffId, fullChange.changeId);

  assert.equal(falseWithHunksChange.reviewState, 'full');
  assert.equal(falseWithHunksChange.reviewable, true);
  assert.equal(falseWithHunksChange.bodyKind, 'inline_hunks');

  assert.equal(summaryChange.reviewState, 'summary_only');
  assert.equal(summaryChange.reviewable, false);
  assert.equal(summaryChange.bodyKind, 'summary_only');

  assert.equal(failedChange.reviewState, 'failed');
  assert.equal(failedChange.reviewable, false);
  assert.equal(failedChange.bodyKind, 'summary_only');
  assert.equal(failedChange.truncationReason, 'diff_generation_failed');
});

test('ledger keeps repeated edits append-only and isolates malformed items', () => {
  const first = completedTool({
    toolCallId: 'call_first',
    resultMetadata: {
      workspace_id: 'default',
      path: 'src/repeated.js',
      diff: diff({ diff_id: 'diff_first', additions: 1, deletions: 0 }),
    },
  });
  const malformed = completedTool({
    toolCallId: 'call_malformed',
    resultMetadata: { path: 'src/bad.js', diff: 'not an object' },
  });
  const second = completedTool({
    toolCallId: 'call_second',
    resultMetadata: {
      workspace_id: 'default',
      path: 'src/repeated.js',
      diff: diff({ diff_id: 'diff_second', additions: 3, deletions: 1 }),
    },
  });
  const errored = completedTool({
    toolCallId: 'call_errored',
    resultIsError: true,
    resultMetadata: {
      path: 'src/error.js',
      diff: diff({ diff_id: 'diff_error' }),
    },
  });

  const ledger = buildJennyChangeLedgerFromTurnViewModels(
    [turn('turn_a', [first, malformed]), turn('turn_b', [second, errored])],
    { sessionId: 'session_a', workspaceId: 'default' }
  );

  assert.deepEqual(ledger.changes.map((change) => change.changeId), ['diff_first', 'diff_second']);
  assert.deepEqual(ledger.changes.map((change) => change.turnId), ['turn_a', 'turn_b']);
  assert.deepEqual(ledger.changes.map((change) => change.fileKey), [
    'default:src/repeated.js',
    'default:src/repeated.js',
  ]);
  assert.deepEqual(ledger.skipped.map((item) => item.reason), ['missing_diff', 'tool_not_successful']);
});

test('ledger isolates hostile metadata without dropping later valid changes', () => {
  const hostilePath = {
    toString() {
      throw new Error('path stringify failed');
    },
  };
  const hostile = completedTool({
    toolCallId: 'call_hostile',
    resultMetadata: {
      path: hostilePath,
      diff: diff({ diff_id: 'diff_hostile' }),
    },
  });
  const valid = completedTool({
    toolCallId: 'call_valid_after_hostile',
    resultMetadata: {
      path: 'src/valid-after-hostile.js',
      diff: diff({ diff_id: 'diff_valid_after_hostile' }),
    },
  });

  const ledger = buildJennyChangeLedgerFromTurnViewModels(
    [turn('turn_hostile', [hostile, valid])],
    { workspaceId: 'default' }
  );

  assert.deepEqual(ledger.changes.map((change) => change.changeId), ['diff_valid_after_hostile']);
  assert.deepEqual(ledger.skipped.map((item) => item.reason), ['invalid_path']);
});

test('ledger isolates hostile tool-call getters without aborting the turn', () => {
  const hostileTool = completedTool({ toolCallId: 'call_hostile_getter' });
  Object.defineProperty(hostileTool, 'resultMetadata', {
    enumerable: true,
    get() {
      throw new Error('metadata getter failed');
    },
  });
  const valid = completedTool({
    toolCallId: 'call_valid_after_getter',
    resultMetadata: {
      path: 'src/valid-after-getter.js',
      diff: diff({ diff_id: 'diff_valid_after_getter' }),
    },
  });

  const ledger = buildJennyChangeLedgerFromTurnViewModels(
    [turn('turn_getter', [hostileTool, valid])],
    { workspaceId: 'default' }
  );

  assert.deepEqual(ledger.changes.map((change) => change.changeId), ['diff_valid_after_getter']);
  assert.deepEqual(ledger.skipped.map((item) => item.reason), ['invalid_tool_call']);
});

test('ledger isolates hostile diff metadata getters without aborting the turn', () => {
  const hostileMetadata = { path: 'src/hostile-diff-field.js' };
  Object.defineProperty(hostileMetadata, 'diff', {
    enumerable: true,
    get() {
      throw new Error('diff getter failed');
    },
  });
  const hostileDiff = {
    path: 'src/hostile-diff-field.js',
    beforeHash: null,
    afterHash: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  };
  Object.defineProperty(hostileDiff, 'diff_id', {
    enumerable: true,
    get() {
      throw new Error('diff id getter failed');
    },
  });
  Object.defineProperty(hostileDiff, 'additions', {
    enumerable: true,
    get() {
      throw new Error('additions getter failed');
    },
  });
  Object.defineProperty(hostileDiff, 'hunks', {
    enumerable: true,
    get() {
      throw new Error('hunks getter failed');
    },
  });
  const inaccessibleDiff = completedTool({
    toolCallId: 'call_inaccessible_diff',
    resultMetadata: hostileMetadata,
  });
  const optionalGetterFailure = completedTool({
    toolCallId: 'call_optional_getter_failure',
    resultMetadata: {
      path: 'src/hostile-diff-field.js',
      changed: true,
      diff: hostileDiff,
    },
  });
  const valid = completedTool({
    toolCallId: 'call_valid_after_diff_getter',
    resultMetadata: {
      path: 'src/valid-after-diff-getter.js',
      diff: diff({ diff_id: 'diff_valid_after_diff_getter' }),
    },
  });

  const ledger = buildJennyChangeLedgerFromTurnViewModels(
    [turn('turn_diff_getter', [inaccessibleDiff, optionalGetterFailure, valid])],
    { workspaceId: 'default' }
  );

  assert.equal(ledger.changes.length, 2);
  assert.equal(ledger.changes[0].toolCallId, 'call_optional_getter_failure');
  assert.match(ledger.changes[0].changeId, /^change:turn_diff_getter:call_optional_getter_failure:0:/);
  assert.equal(ledger.changes[0].status, 'created');
  assert.equal(ledger.changes[0].additions, 0);
  assert.equal(ledger.changes[0].bodyKind, 'summary_only');
  assert.equal(ledger.changes[1].changeId, 'diff_valid_after_diff_getter');
  assert.deepEqual(ledger.skipped.map((item) => item.reason), ['missing_diff']);
});
