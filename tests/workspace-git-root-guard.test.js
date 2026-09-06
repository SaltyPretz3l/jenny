'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePathForComparison,
  pathsEqual,
  resolveAndCompare,
  checkRootIsToplevel,
  detectRepoScope,
} = require('../services/workspace-git-root-guard');

describe('workspace-git-root-guard — normalizePathForComparison / pathsEqual', () => {
  test('strips a single trailing separator (both slash styles)', () => {
    assert.equal(normalizePathForComparison('C:/repo/'), normalizePathForComparison('C:/repo'));
    assert.equal(normalizePathForComparison('C:\\repo\\'), normalizePathForComparison('C:\\repo'));
  });

  test('treats backslash and forward-slash separators as equivalent', () => {
    assert.equal(normalizePathForComparison('C:\\repo\\sub'), normalizePathForComparison('C:/repo/sub'));
  });

  test('is case-insensitive on win32', { skip: process.platform !== 'win32' }, () => {
    assert.equal(pathsEqual('C:\\Repo\\Sub', 'c:\\repo\\sub'), true);
    assert.equal(pathsEqual('C:\\Repo', 'C:\\repo\\'), true);
  });

  test('is case-sensitive off win32', { skip: process.platform === 'win32' }, () => {
    assert.equal(pathsEqual('/Repo/Sub', '/repo/sub'), false);
  });

  test('non-matching paths compare false', () => {
    assert.equal(pathsEqual('C:\\repo', 'C:\\repo\\sub'), false);
    assert.equal(pathsEqual('C:\\repo-a', 'C:\\repo-b'), false);
  });

  test('empty/nullish input never throws and never matches a real path', () => {
    assert.equal(normalizePathForComparison(null), '');
    assert.equal(normalizePathForComparison(undefined), '');
    assert.equal(pathsEqual(null, 'C:\\repo'), false);
  });
});

describe('workspace-git-root-guard — resolveAndCompare (injected fs)', () => {
  test('two different literal paths that realpath to the same target compare equal (8.3-vs-long / symlink alias)', async () => {
    const fakeFs = {
      realpath: async (p) => {
        if (p === 'C:\\REPO~1' || p === 'C:\\repo-long-name') return 'C:\\repo-long-name';
        return p;
      },
    };
    const result = await resolveAndCompare(fakeFs, 'C:\\REPO~1', 'C:\\repo-long-name');
    assert.equal(result, true);
  });

  test('a subdirectory does not compare equal to its parent toplevel', async () => {
    const fakeFs = { realpath: async (p) => p };
    const result = await resolveAndCompare(fakeFs, 'C:\\repo\\sub', 'C:\\repo');
    assert.equal(result, false);
  });

  test('realpath failure falls back to a literal comparison instead of throwing', async () => {
    const fakeFs = { realpath: async () => { throw new Error('ENOENT'); } };
    const same = await resolveAndCompare(fakeFs, 'C:\\repo', 'C:\\repo');
    assert.equal(same, true);
    const different = await resolveAndCompare(fakeFs, 'C:\\repo', 'C:\\repo\\sub');
    assert.equal(different, false);
  });
});

describe('workspace-git-root-guard — checkRootIsToplevel (injected exec)', () => {
  test('reports isToplevel:true when git reports the selected root itself', async () => {
    const exec = async () => ({ success: true, stdout: 'C:\\repo\n', stderr: '', message: '', reason: '' });
    const fakeFs = { realpath: async (p) => p };
    const res = await checkRootIsToplevel(exec, 'C:\\repo', { fs: fakeFs });
    assert.equal(res.isToplevel, true);
    assert.equal(res.toplevel, 'C:\\repo');
  });

  test('reports isToplevel:false when git reports a different (parent) toplevel', async () => {
    const exec = async () => ({ success: true, stdout: 'C:\\repo\n', stderr: '', message: '', reason: '' });
    const fakeFs = { realpath: async (p) => p };
    const res = await checkRootIsToplevel(exec, 'C:\\repo\\sub', { fs: fakeFs });
    assert.equal(res.isToplevel, false);
  });

  test('a linked-worktree root reports its own toplevel and is therefore allowed', async () => {
    // Inside a linked worktree, `git rev-parse --show-toplevel` reports the
    // worktree's own root, not the main repository's — so root === toplevel.
    const exec = async () => ({ success: true, stdout: 'C:\\worktrees\\feature-x\n', stderr: '', message: '', reason: '' });
    const fakeFs = { realpath: async (p) => p };
    const res = await checkRootIsToplevel(exec, 'C:\\worktrees\\feature-x', { fs: fakeFs });
    assert.equal(res.isToplevel, true);
  });

  test('a spawn failure surfaces as { failure } instead of throwing', async () => {
    const failure = { success: false, stdout: '', stderr: 'fatal: boom', message: 'boom', reason: 'aborted' };
    const exec = async () => failure;
    const res = await checkRootIsToplevel(exec, 'C:\\repo');
    assert.equal(res.failure, failure);
  });
});

test('wide-008: detectRepoScope composes repository and toplevel probes', async () => {
  const calls = [];
  const exec = async (_root, args) => {
    calls.push(args);
    return args.includes('--is-inside-work-tree')
      ? { success: true, stdout: 'true\n' }
      : { success: true, stdout: 'C:/repo\n' };
  };
  const result = await detectRepoScope(exec, 'C:/repo/subdir', {
    fs: { realpath: async (value) => value },
  });
  assert.equal(result.isRepo, true);
  assert.equal(result.isToplevel, false);
  assert.equal(calls.length, 2);
});
