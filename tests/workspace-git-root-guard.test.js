'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizePathForComparison,
  pathsEqual,
  resolveAndCompare,
  detectRepoScope,
} = require('../services/workspace-git-root-guard');

// normalizePathForComparison reads process.platform at call time and works on
// strings only, so both platform branches run on every OS by stubbing it.
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

describe('workspace-git-root-guard — normalizePathForComparison / pathsEqual', () => {
  test('strips a single trailing separator (both slash styles)', () => {
    assert.equal(normalizePathForComparison('C:/repo/'), normalizePathForComparison('C:/repo'));
    assert.equal(normalizePathForComparison('C:\\repo\\'), normalizePathForComparison('C:\\repo'));
  });

  test('treats backslash and forward-slash separators as equivalent', () => {
    assert.equal(normalizePathForComparison('C:\\repo\\sub'), normalizePathForComparison('C:/repo/sub'));
  });

  test('is case-insensitive on win32', () => {
    withPlatform('win32', () => {
      assert.equal(pathsEqual('C:\\Repo\\Sub', 'c:\\repo\\sub'), true);
      assert.equal(pathsEqual('C:\\Repo', 'C:\\repo\\'), true);
    });
  });

  test('is case-sensitive off win32', () => {
    withPlatform('linux', () => {
      assert.equal(pathsEqual('/Repo/Sub', '/repo/sub'), false);
    });
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

// Answers the combined probe the way git does (two lines) and the legacy split
// probes one line each, so the spawn-count case below is red on the old shape.
function scopeExec(calls, toplevel) {
  return async (_root, args) => {
    calls.push(args);
    const lines = [];
    if (args.includes('--is-inside-work-tree')) lines.push('true');
    if (args.includes('--show-toplevel')) lines.push(toplevel);
    return { success: true, stdout: `${lines.join('\n')}\n` };
  };
}

test('wide-008: detectRepoScope reports repository and toplevel from one probe', async () => {
  const calls = [];
  const result = await detectRepoScope(scopeExec(calls, 'C:/repo'), 'C:/repo/subdir', {
    fs: { realpath: async (value) => value },
  });
  assert.equal(result.isRepo, true);
  assert.equal(result.isToplevel, false);
  assert.equal(result.toplevel, 'C:/repo');
});

test('row 82 G1: detectRepoScope costs exactly one git spawn', async () => {
  const calls = [];
  const result = await detectRepoScope(scopeExec(calls, 'C:/repo'), 'C:/repo', {
    fs: { realpath: async (value) => value },
  });
  assert.deepEqual(result, { isRepo: true, isToplevel: true, toplevel: 'C:/repo' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['rev-parse', '--is-inside-work-tree', '--show-toplevel']);
});

test('row 82 G1: detectRepoScope keeps every failure classification', async () => {
  const fs = { realpath: async (value) => value };
  // Outside any repository: a clean miss.
  const outside = await detectRepoScope(async () => ({ success: false, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git', message: 'fatal: not a git repository' }), 'C:/x', { fs });
  assert.deepEqual(outside, { isRepo: false });
  // Inside `.git` or a bare repository git prints "false" and then fails on
  // --show-toplevel: still a clean miss, as the split probe reported it.
  const gitDir = await detectRepoScope(async () => ({ success: false, stdout: 'false\n', stderr: 'fatal: this operation must be run in a work tree', message: 'fatal: this operation must be run in a work tree' }), 'C:/x/.git', { fs });
  assert.deepEqual(gitDir, { isRepo: false });
  const bareOk = await detectRepoScope(async () => ({ success: true, stdout: 'false\n' }), 'C:/x.git', { fs });
  assert.deepEqual(bareOk, { isRepo: false });
  // A spawn failure (abort, timeout, git missing) surfaces as { failure }.
  const failure = { success: false, stdout: '', stderr: '', message: 'Git command aborted.', reason: 'aborted' };
  assert.deepEqual(await detectRepoScope(async () => failure, 'C:/repo', { fs }), { failure });
  // A root switch observed after the probe reports stale.
  const stale = await detectRepoScope(scopeExec([], 'C:/repo'), 'C:/repo', { fs, isCurrent: () => false });
  assert.deepEqual(stale, { stale: true });
});
