'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  baseRefIsSafe,
  branchNameIsSafe,
  canonicalRepositoryRootFromWorktreeList,
  clipText,
  dirtySummaryHasChanges,
  normalizeBaseRef,
  normalizeBranchName,
  parseGitStatusPorcelainSummary,
  parsePorcelainWorktreeList,
  slugify,
} = require('../services/worktree-service-git');
const worktreeService = require('../services/worktree-service');

test('the service re-exports the ref validators other modules import', () => {
  assert.equal(worktreeService.branchNameIsSafe, branchNameIsSafe);
  assert.equal(worktreeService.baseRefIsSafe, baseRefIsSafe);
  assert.equal(worktreeService.parseGitStatusPorcelainSummary, parseGitStatusPorcelainSummary);
});

test('parsePorcelainWorktreeList reads branch, detached, bare and prunable rows', () => {
  const main = path.resolve('C:/repo/main');
  const feature = path.resolve('C:/repo/feature');
  const gone = path.resolve('C:/repo/gone');
  const rows = parsePorcelainWorktreeList([
    `worktree ${main}`, 'HEAD aaa', 'branch refs/heads/main', '',
    `worktree ${feature}`, 'HEAD bbb', 'detached', '',
    `worktree ${gone}`, 'HEAD ccc', 'branch refs/heads/jenny/gone', 'prunable gitdir file points to non-existent location',
  ].join('\n'));

  assert.deepEqual(rows.map((row) => [row.path, row.branch, row.detached, row.prunable === true]), [
    [main, 'main', false, false],
    [feature, '', true, false],
    [gone, 'jenny/gone', false, true],
  ]);
  assert.equal(canonicalRepositoryRootFromWorktreeList(rows.length ? `worktree ${main}\n` : '', 'C:/x'), main);
  assert.equal(canonicalRepositoryRootFromWorktreeList('', 'C:/fallback'), path.resolve('C:/fallback'));
});

test('parseGitStatusPorcelainSummary counts every dirty class', () => {
  const summary = parseGitStatusPorcelainSummary(['M  staged.js', ' M modified.js', '?? new.txt', '!! build/'].join('\n'));
  assert.deepEqual(summary, { modified_count: 1, staged_count: 1, untracked_count: 1, ignored_count: 1 });
  assert.equal(dirtySummaryHasChanges(summary), true);
  assert.equal(dirtySummaryHasChanges(parseGitStatusPorcelainSummary('')), false);
});

test('ref names and slugs are validated and normalized', () => {
  assert.equal(branchNameIsSafe('jenny/feature-alpha'), true);
  for (const bad of ['-x', 'a..b', 'a/', 'x.lock', 'a@{1}', 'a\\b', 'x'.repeat(201)]) {
    assert.equal(branchNameIsSafe(bad), false, bad);
  }
  assert.equal(baseRefIsSafe('origin/main@x'), true);
  assert.equal(normalizeBaseRef(''), 'HEAD');
  assert.equal(normalizeBranchName({ branch: 'explicit', name: 'ignored' }), 'explicit');
  assert.equal(normalizeBranchName({ name: 'Feature Alpha' }), 'jenny/feature-alpha');
  assert.equal(slugify('a/b/Some Name!'), 'some-name');
  assert.equal(slugify('...', 'fallback'), 'fallback');
  assert.equal(clipText('line\nbreak'), 'line break');
  assert.equal(clipText('x'.repeat(900)).length, 800);
});
