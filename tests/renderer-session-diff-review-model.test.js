'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSessionDiffReviewModel,
  resolveReviewScope,
} = require('../renderer/chat/renderer-session-diff-review-model');

function change(overrides = {}) {
  return {
    changeId: 'change_1',
    diffId: 'change_1',
    operationIndex: 0,
    workspaceId: 'default',
    fileKey: 'default:src/app.js',
    path: 'src/app.js',
    oldPath: null,
    turnId: 'turn_1',
    sourceMessageId: 'tool_result_1',
    toolCallId: 'call_1',
    toolName: 'Write',
    status: 'modified',
    reviewState: 'full',
    reviewable: true,
    bodyKind: 'inline_hunks',
    additions: 1,
    deletions: 0,
    truncated: false,
    truncationReason: null,
    beforeHash: null,
    afterHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hashKind: 'diff_input_text',
    hunks: [],
    ...overrides,
  };
}

test('buildSessionDiffReviewModel keeps changes append-only and aggregates files, turns, and totals', () => {
  const changes = [
    change({
      changeId: 'change_a1',
      fileKey: 'default:src/a.js',
      path: 'src/a.js',
      turnId: 'turn_1',
      additions: 2,
      deletions: 1,
    }),
    change({
      changeId: 'change_a2',
      fileKey: 'default:src/a.js',
      path: 'src/a.js',
      turnId: 'turn_2',
      additions: 3,
      deletions: 2,
      truncated: true,
      truncationReason: 'line_limit',
    }),
    change({
      changeId: 'change_b1',
      fileKey: 'default:src/b.js',
      path: 'src/b.js',
      turnId: 'turn_2',
      additions: 1,
      deletions: 0,
    }),
  ];

  const model = buildSessionDiffReviewModel({ sessionId: 'session_1', changes });

  assert.equal(model.sessionId, 'session_1');
  assert.deepEqual(model.changes.map((item) => item.changeId), ['change_a1', 'change_a2', 'change_b1']);
  assert.equal(model.files.length, 2);
  assert.deepEqual(model.files[0], {
    fileKey: 'default:src/a.js',
    workspaceId: 'default',
    path: 'src/a.js',
    latestChangeId: 'change_a2',
    changeIds: ['change_a1', 'change_a2'],
    changeCount: 2,
    additions: 5,
    deletions: 3,
    truncated: true,
  });
  assert.deepEqual(model.files[1], {
    fileKey: 'default:src/b.js',
    workspaceId: 'default',
    path: 'src/b.js',
    latestChangeId: 'change_b1',
    changeIds: ['change_b1'],
    changeCount: 1,
    additions: 1,
    deletions: 0,
    truncated: false,
  });
  assert.deepEqual(model.turns, [
    {
      turnId: 'turn_1',
      changeIds: ['change_a1'],
      fileKeys: ['default:src/a.js'],
      additions: 2,
      deletions: 1,
      truncated: false,
    },
    {
      turnId: 'turn_2',
      changeIds: ['change_a2', 'change_b1'],
      fileKeys: ['default:src/a.js', 'default:src/b.js'],
      additions: 4,
      deletions: 2,
      truncated: true,
    },
  ]);
  assert.deepEqual(model.totals, {
    files: 2,
    changes: 3,
    additions: 6,
    deletions: 3,
    truncatedFiles: 1,
  });

  changes[0].path = 'mutated.js';
  assert.equal(model.changes[0].path, 'src/a.js');
});

test('resolveReviewScope resolves change, turn, file, and session scopes without collapsing history', () => {
  const model = buildSessionDiffReviewModel([
    change({ changeId: 'change_a1', fileKey: 'default:src/a.js', path: 'src/a.js', turnId: 'turn_1' }),
    change({ changeId: 'change_a2', fileKey: 'default:src/a.js', path: 'src/a.js', turnId: 'turn_2' }),
    change({ changeId: 'change_b1', fileKey: 'default:src/b.js', path: 'src/b.js', turnId: 'turn_2' }),
  ], { sessionId: 'session_2' });

  const changeScope = resolveReviewScope(model, { type: 'change', changeId: 'change_a2' });
  assert.equal(changeScope.found, true);
  assert.equal(changeScope.reason, '');
  assert.deepEqual(changeScope.changes.map((item) => item.changeId), ['change_a2']);
  assert.deepEqual(changeScope.files.map((item) => item.fileKey), ['default:src/a.js']);
  assert.deepEqual(changeScope.turns.map((item) => item.turnId), ['turn_2']);

  const turnScope = resolveReviewScope(model, { type: 'turn', turnId: 'turn_2' });
  assert.deepEqual(turnScope.changes.map((item) => item.changeId), ['change_a2', 'change_b1']);
  assert.deepEqual(turnScope.files.map((item) => item.fileKey), ['default:src/a.js', 'default:src/b.js']);

  const fileScope = resolveReviewScope(model, { type: 'file', fileKey: 'default:src/a.js' });
  assert.deepEqual(fileScope.changes.map((item) => item.changeId), ['change_a1', 'change_a2']);
  assert.deepEqual(fileScope.turns.map((item) => item.turnId), ['turn_1', 'turn_2']);

  const sessionScope = resolveReviewScope(model, { type: 'session' });
  assert.deepEqual(sessionScope.changes.map((item) => item.changeId), ['change_a1', 'change_a2', 'change_b1']);
  assert.deepEqual(sessionScope.totals, model.totals);
});

test('resolveReviewScope returns stable empty reasons for missing or malformed scopes', () => {
  const model = buildSessionDiffReviewModel([
    change({ changeId: 'change_1', fileKey: 'default:src/app.js', path: 'src/app.js', turnId: 'turn_1' }),
  ]);

  assert.deepEqual(resolveReviewScope(model, { type: 'change', changeId: 'missing' }), {
    type: 'change',
    found: false,
    reason: 'change_not_found',
    scope: { type: 'change', changeId: 'missing' },
    changes: [],
    files: [],
    turns: [],
    totals: { files: 0, changes: 0, additions: 0, deletions: 0, truncatedFiles: 0 },
  });
  assert.equal(resolveReviewScope(model, { type: 'turn', turnId: 'missing' }).reason, 'turn_not_found');
  assert.equal(resolveReviewScope(model, { type: 'file', fileKey: 'missing' }).reason, 'file_not_found');
  assert.equal(resolveReviewScope(model, { type: 'surprise' }).reason, 'unsupported_scope');
  assert.equal(resolveReviewScope(model, null).reason, 'unsupported_scope');
  assert.deepEqual(resolveReviewScope({ changes: null, files: null, turns: null }, { type: 'session' }), {
    type: 'session',
    found: true,
    reason: '',
    scope: { type: 'session' },
    changes: [],
    files: [],
    turns: [],
    totals: { files: 0, changes: 0, additions: 0, deletions: 0, truncatedFiles: 0 },
  });
});

test('buildSessionDiffReviewModel isolates malformed changes while keeping valid changes', () => {
  const hostile = {};
  Object.defineProperty(hostile, 'changeId', {
    enumerable: true,
    get() {
      throw new Error('hostile change id');
    },
  });
  const model = buildSessionDiffReviewModel({
    changes: [
      null,
      hostile,
      change({ changeId: '', fileKey: 'default:src/missing-id.js', path: 'src/missing-id.js' }),
      change({ changeId: 'valid', fileKey: 'default:src/valid.js', path: 'src/valid.js' }),
      change({ changeId: 'missing_file_key', fileKey: '', path: 'src/no-key.js' }),
    ],
  });

  assert.deepEqual(model.changes.map((item) => item.changeId), ['valid']);
  assert.deepEqual(model.skipped.map((item) => item.reason), [
    'invalid_change',
    'invalid_change',
    'missing_change_id',
    'missing_file_key',
  ]);
  assert.deepEqual(model.totals, {
    files: 1,
    changes: 1,
    additions: 1,
    deletions: 0,
    truncatedFiles: 0,
  });
});

test('buildSessionDiffReviewModel treats hostile ledger containers as empty input', () => {
  const hostileLedger = { sessionId: 'session_hostile' };
  Object.defineProperty(hostileLedger, 'changes', {
    enumerable: true,
    get() {
      throw new Error('changes getter failed');
    },
  });

  const model = buildSessionDiffReviewModel(hostileLedger);

  assert.equal(model.sessionId, 'session_hostile');
  assert.deepEqual(model.changes, []);
  assert.deepEqual(model.files, []);
  assert.deepEqual(model.turns, []);
  assert.deepEqual(model.totals, {
    files: 0,
    changes: 0,
    additions: 0,
    deletions: 0,
    truncatedFiles: 0,
  });
});

test('buildSessionDiffReviewModel falls back for hostile optional numeric fields', () => {
  const hostileCounts = change({
    changeId: 'hostile_counts',
    fileKey: 'default:src/hostile-counts.js',
    path: 'src/hostile-counts.js',
  });
  Object.defineProperty(hostileCounts, 'additions', {
    enumerable: true,
    get() {
      throw new Error('additions getter failed');
    },
  });

  const model = buildSessionDiffReviewModel([hostileCounts]);

  assert.equal(model.changes.length, 1);
  assert.equal(model.changes[0].additions, 0);
  assert.deepEqual(model.skipped, []);
  assert.equal(model.totals.additions, 0);
});
