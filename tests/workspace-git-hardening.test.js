'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { WorkspaceGitService } = require('../services/workspace-git-service');
const { buildPathspecCommand } = require('../services/workspace-git-executor');

const ROOT = 'C:/repo';

function createService(exec) {
  return new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: () => ROOT },
    featureFlagProvider: () => ({ workspace_git: true }),
    exec,
    fs: { realpath: async (value) => value },
    logger() {},
  });
}

function scopeResult(args) {
  if (args.includes('--is-inside-work-tree')) return { success: true, stdout: 'true\n' };
  if (args.includes('--show-toplevel')) return { success: true, stdout: `${ROOT}\n` };
  return null;
}

test('wide-037: a truncated streamed status keeps complete records and reports partial metadata', async () => {
  const exec = async (_cwd, args) => scopeResult(args) || {
    success: true,
    stdout: '## main\0?? complete.txt\0?? incomplete',
    stderr: '',
    truncated: true,
    droppedBytes: 321,
  };
  const res = await createService(exec).getStatus();
  assert.equal(res.ok, true);
  assert.equal(res.truncated, true);
  assert.equal(res.droppedBytes, 321);
  assert.deepEqual(res.files.map((entry) => entry.path), ['complete.txt']);
});

test('wide-037: warning stderr cannot mask typed no-op outcomes from stdout', async () => {
  const exec = async (_cwd, args) => {
    const scope = scopeResult(args);
    if (scope) return scope;
    const output = args[0] === 'commit'
      ? 'nothing to commit, working tree clean'
      : args[0] === 'stash'
        ? 'No local changes to save'
        : 'fatal: ambiguous argument HEAD~1';
    return {
      success: false,
      stdout: output,
      stderr: 'warning: benign host warning',
      message: 'warning: benign host warning',
      reason: 'git_failed',
    };
  };
  const svc = createService(exec);
  assert.equal((await svc.commit({ message: 'noop' })).reason, 'nothing_to_commit');
  assert.equal((await svc.stash({ op: 'push' })).reason, 'nothing_to_stash');
  assert.equal((await svc.undoLastCommit()).reason, 'no_prior_commit');
});

test('wide-037: commit messages are bounded before process execution', async () => {
  const exec = async (_cwd, args) => scopeResult(args) || { success: true, stdout: '' };
  await assert.rejects(
    () => createService(exec).commit({ message: 'x'.repeat(10_001) }),
    /cannot exceed 10000 characters/
  );
});

test('wide-037: stash messages reject oversize input instead of silently truncating it', async () => {
  const exec = async (_cwd, args) => scopeResult(args) || { success: true, stdout: '' };
  await assert.rejects(
    () => createService(exec).stash({ op: 'push', message: 'x'.repeat(1001) }),
    /cannot exceed 1000 characters/
  );
});

test('wide-037: large path selections use one bounded NUL stdin pathspec', () => {
  const paths = Array.from({ length: 5000 }, (_value, index) => `dir-${index}/file name.txt`);
  const command = buildPathspecCommand(['add'], paths);
  assert.deepEqual(command.args, ['add', '--pathspec-from-file=-', '--pathspec-file-nul']);
  assert.equal(command.input.split('\0').length, paths.length + 1);
  assert.ok(Buffer.byteLength(command.input) < 1024 * 1024);
  assert.throws(
    () => buildPathspecCommand(['add'], Array.from({ length: 10_001 }, () => 'x')),
    /Too many paths/
  );
  assert.throws(
    () => buildPathspecCommand(['add'], ['safe.txt', 'bad\0path.txt']),
    /must not contain NUL bytes/
  );
  assert.throws(
    () => buildPathspecCommand(['add'], ['é'.repeat(524_288)]),
    /paths are too large/
  );
  const poison = { toString() { throw new Error('count guard iterated an oversized list'); } };
  assert.throws(
    () => buildPathspecCommand(['add'], Array.from({ length: 10_001 }, () => poison)),
    /Too many paths/
  );
});

// Fail-oracle: a broken HEAD probe (abort/timeout/spawn failure) must never be
// silently read as "no HEAD" — getDiff surfaces the failure and unstage aborts
// rather than taking the no-HEAD `reset` fallback.

function headProbeFailingExec(headResult) {
  return async (_cwd, args) => {
    const scope = scopeResult(args);
    if (scope) return scope;
    if (args[0] === 'rev-parse' && args.includes('--verify')) return headResult;
    return { success: true, stdout: '', stderr: '' };
  };
}

test('fail-oracle: getDiff propagates a broken HEAD probe instead of reporting no_head', async () => {
  const exec = headProbeFailingExec({
    success: false, reason: 'aborted', stdout: '', stderr: '', message: 'Git command aborted.',
  });
  const res = await createService(exec).getDiff({});
  assert.equal(res.ok, false);
  assert.equal(res.isRepo, true);
  assert.equal(res.error_code, 'CMP-GIT-0040');
  assert.notEqual(res.note, 'no_head');
  assert.equal(res.diff, undefined);
});

test('fail-oracle: a confirmed unborn HEAD still diffs the empty tree (no false failure)', async () => {
  const exec = headProbeFailingExec({
    success: false, reason: 'git_failed', stdout: '', stderr: "fatal: ambiguous argument 'HEAD': unknown revision", message: '',
  });
  const res = await createService(exec).getDiff({});
  assert.equal(res.ok, true);
  assert.equal(res.note, 'no_head');
});

test('fail-oracle: unstage propagates a broken HEAD probe instead of falling back to reset', async () => {
  const seen = [];
  const exec = async (_cwd, args) => {
    seen.push(args);
    const scope = scopeResult(args);
    if (scope) return scope;
    if (args[0] === 'rev-parse' && args.includes('--verify')) {
      return { success: false, reason: 'git_failed', stdout: '', stderr: 'fatal: unable to read HEAD', message: 'fatal: unable to read HEAD' };
    }
    return { success: true, stdout: '', stderr: '' };
  };
  await assert.rejects(
    () => createService(exec).unstage({ paths: ['src/a.js'] }),
    /HEAD/i
  );
  assert.ok(!seen.some((args) => args[0] === 'reset'), 'never executes the no-HEAD reset fallback');
});
