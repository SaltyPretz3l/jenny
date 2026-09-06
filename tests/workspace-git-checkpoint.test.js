'use strict';

// WIDE-035 rebuild: root-bound serialized checkpoint transactions.
// Unit tests cover session-id stabilization and internal retention
// normalization; stub-exec service tests cover the transaction barriers
// (root change, CAS create/delete, rollback discoverability, typed HEAD
// probe); real-repo tests cover exact staged/unstaged round-trips, durable
// clean-tree rollbacks, concurrent creates, and honest retention reporting.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const { WorkspaceGitService } = require('../services/workspace-git-service');
const {
  checkpointRefIsSafe,
  createWorkspaceGitCheckpointApi,
  planCheckpointRetention,
  sanitizeCheckpointSession,
} = require('../services/workspace-git-checkpoint');
const { probeHeadState } = require('../services/workspace-git-root-guard');
const { runWorkspaceGit } = require('../services/workspace-git-executor');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

const execFileAsync = promisify(execFile);
const DAY_MS = 24 * 60 * 60 * 1000;
const SHA_A = 'a'.repeat(40);

function git(cwd, args) {
  return execFileAsync('git', args, { cwd, windowsHide: true, encoding: 'utf8' });
}

async function createGitRepo(prefix = 'jenny-git-checkpoint-') {
  const repoRoot = createTrackedTempDir(prefix);
  await git(repoRoot, ['init']);
  await git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await git(repoRoot, ['config', 'user.email', 'jenny@example.invalid']);
  await git(repoRoot, ['config', 'user.name', 'Jenny Tests']);
  await git(repoRoot, ['config', 'commit.gpgsign', 'false']);
  await git(repoRoot, ['config', 'core.autocrlf', 'false']);
  await fs.writeFile(path.join(repoRoot, 'README.md'), 'line1\nline2\nline3\n', 'utf8');
  await git(repoRoot, ['add', 'README.md']);
  await git(repoRoot, ['commit', '-m', 'initial']);
  return repoRoot;
}

function createService(root, { exec, rootProvider, stubFs = false } = {}) {
  return new WorkspaceGitService({
    configService: { getToolsWorkspaceRoot: rootProvider || (() => root) },
    featureFlagProvider: () => ({ workspace_git: true }),
    ...(exec ? { exec } : {}),
    ...(stubFs ? { fs: { realpath: async (value) => value } } : {}),
    logger() {},
  });
}

// Bare transaction harness around the checkpoint api for real-repo tests that
// need retention-cap overrides without growing the service surface.
function directApi(root, { retention } = {}) {
  return createWorkspaceGitCheckpointApi({
    runTransaction: async (op, handler) => handler({
      root,
      signal: null,
      isCurrent: () => true,
      stale: () => ({ ok: false, available: false, isRepo: false, op, reason: 'root_changed' }),
    }),
    exec: (cwd, args, options) => runWorkspaceGit(cwd, args, options),
    execFailure: (op, result) => ({
      ok: false, available: true, isRepo: true, op,
      error_code: 'CMP-GIT-0040',
      reason: result?.reason || 'git_failed',
      message: result?.message || '',
    }),
    probeHeadState,
    ...(retention ? { retention } : {}),
  });
}

const STUB_ROOT = 'C:/repo';

function scopeResult(args) {
  if (args.includes('--is-inside-work-tree')) return { success: true, stdout: 'true\n' };
  if (args.includes('--show-toplevel')) return { success: true, stdout: `${STUB_ROOT}\n` };
  return null;
}

function isHeadProbe(args) {
  return args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'HEAD' && args.length === 3;
}

test.afterEach(async () => {
  await cleanupTrackedResources();
});

describe('checkpoint session ids (design point 10)', () => {
  test('lossless pass-through, deterministic hash-stabilization, caps, collision resistance', () => {
    assert.equal(sanitizeCheckpointSession('sess_1'), 'sess_1');
    assert.equal(
      sanitizeCheckpointSession('sess_1751980000000_abcdef123456'),
      'sess_1751980000000_abcdef123456',
      'real Electron session ids round-trip losslessly'
    );
    const evil = sanitizeCheckpointSession('../evil');
    assert.match(evil, /^evil-[0-9a-f]{8}$/);
    assert.equal(sanitizeCheckpointSession('../evil'), evil, 'stabilization is deterministic');
    assert.notEqual(
      sanitizeCheckpointSession('..%evil'),
      evil,
      'distinct raw inputs with the same safe stem stay distinct via the hash suffix'
    );
    for (const raw of ['', '..', 'a/b/c', 'name.lock', '.hidden', 'ünïcode', 'x'.repeat(200), 'refs/../../HEAD']) {
      const safe = sanitizeCheckpointSession(raw);
      assert.ok(safe.length <= 40, `capped: ${JSON.stringify(raw)} -> ${safe}`);
      assert.ok(
        checkpointRefIsSafe(`refs/jenny/checkpoints/${safe}/1`),
        `git-ref-safe: ${JSON.stringify(raw)} -> ${safe}`
      );
    }
  });
});

describe('checkpoint retention planning (design points 8, 9)', () => {
  const row = (session, seq, iso, sha = SHA_A) => ({
    ref: `refs/jenny/checkpoints/${session}/${seq}`, sha, createdAt: iso,
  });

  test('rows are normalized internally: malformed dropped, duplicates deduped, caller order ignored', () => {
    const rows = [
      row('s', 1, '2026-01-01T00:00:00Z'),
      row('s', 3, '2026-01-03T00:00:00Z'),
      row('s', 2, '2026-01-02T00:00:00Z'),
      row('s', 2, '2026-01-02T00:00:00Z'),
      { ref: 'refs/jenny/checkpoints/../evil/1', sha: SHA_A, createdAt: '2026-01-01T00:00:00Z' },
      { ref: 'refs/jenny/checkpoints/s/4', sha: 'not-a-sha', createdAt: '2026-01-04T00:00:00Z' },
      { ref: 'refs/heads/main', sha: SHA_A, createdAt: '2026-01-04T00:00:00Z' },
      null,
      'garbage',
    ];
    const options = { nowMs: Date.parse('2026-01-10T00:00:00Z'), perSession: 2, total: 100, maxAgeMs: 365 * DAY_MS };
    const plan = planCheckpointRetention(rows, options);
    assert.deepEqual(plan.map((entry) => entry.ref), ['refs/jenny/checkpoints/s/1'],
      'keeps the newest two by internal ordering; malformed/duplicate/foreign refs never planned');
    assert.equal(plan[0].sha, SHA_A, 'plan rows carry the SHA for CAS deletion');
    assert.deepEqual(planCheckpointRetention([...rows].reverse(), options), plan,
      'a shuffled caller list produces the identical plan');
  });

  test('protected refs are never pruned, even when age-expired', () => {
    const rows = [
      row('s', 1, '2020-01-01T00:00:00Z'),
      row('rollback-s', 1, '2020-01-02T00:00:00Z'),
      row('s', 2, '2020-01-03T00:00:00Z'),
    ];
    const plan = planCheckpointRetention(rows, {
      nowMs: Date.parse('2026-01-10T00:00:00Z'),
      maxAgeMs: 30 * DAY_MS,
      protectedRefs: ['refs/jenny/checkpoints/s/2', 'refs/jenny/checkpoints/rollback-s/1'],
    });
    assert.deepEqual(plan.map((entry) => entry.ref), ['refs/jenny/checkpoints/s/1'],
      'the restore target and rollback ref survive an age sweep that removes everything else');
  });
});

describe('checkpoint transaction barriers (stub exec)', () => {
  test('design point 12: a broken HEAD probe propagates as an error, never as unborn', async () => {
    const calls = [];
    const exec = async (_cwd, args) => {
      calls.push(args);
      const scope = scopeResult(args);
      if (scope) return scope;
      if (isHeadProbe(args)) {
        return { success: false, reason: 'git_failed', stdout: '', stderr: 'fatal: unable to read tree', message: 'fatal: unable to read tree' };
      }
      return { success: true, stdout: '', stderr: '' };
    };
    const res = await createService(STUB_ROOT, { exec, stubFs: true }).createCheckpoint({ session: 's' });
    assert.equal(res.ok, false);
    assert.equal(res.error_code, 'CMP-GIT-0040');
    assert.notEqual(res.reason, 'no_head');
    assert.ok(!calls.some((args) => args[0] === 'stash'), 'no snapshot is attempted on a broken probe');
  });

  test('design point 1: a root change mid-transaction refuses before the ref mutation', async () => {
    let currentRoot = STUB_ROOT;
    const calls = [];
    const exec = async (_cwd, args) => {
      calls.push(args);
      const scope = scopeResult(args);
      if (scope) return scope;
      if (isHeadProbe(args)) return { success: true, stdout: `${SHA_A}\n` };
      if (args[0] === 'stash') {
        currentRoot = 'C:/other';
        return { success: true, stdout: `${SHA_A}\n` };
      }
      if (args[0] === 'for-each-ref') return { success: true, stdout: '' };
      return { success: true, stdout: '' };
    };
    const svc = createService(STUB_ROOT, { exec, stubFs: true, rootProvider: () => currentRoot });
    const res = await svc.createCheckpoint({ session: 's' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'root_changed');
    assert.ok(!calls.some((args) => args[0] === 'update-ref'), 'no ref mutation after the root moved');
  });

  test('design point 2: a lost CAS create retries onto the NEXT sequence (distinct refs, zero-OID guard)', async () => {
    const created = [];
    let listCalls = 0;
    const exec = async (_cwd, args) => {
      const scope = scopeResult(args);
      if (scope) return scope;
      if (isHeadProbe(args)) return { success: true, stdout: `${SHA_A}\n` };
      if (args[0] === 'stash') return { success: true, stdout: `${SHA_A}\n` };
      if (args[0] === 'for-each-ref') {
        listCalls += 1;
        // First (pre-create) listing: empty. Second (retry) listing: a racer
        // now owns sequence 1. Later (retention) listings: just our ref.
        if (listCalls === 1) return { success: true, stdout: '' };
        if (listCalls === 2) {
          return { success: true, stdout: `refs/jenny/checkpoints/s/1\u0000${SHA_A}\u00002026-01-01T00:00:00Z\n` };
        }
        return { success: true, stdout: `refs/jenny/checkpoints/s/2\u0000${SHA_A}\u00002026-01-01T00:00:00Z\n` };
      }
      if (args[0] === 'update-ref' && args[1] !== '-d') {
        created.push(args);
        return created.length === 1
          ? { success: false, reason: 'git_failed', stdout: '', stderr: '', message: 'cannot lock ref: reference already exists' }
          : { success: true, stdout: '' };
      }
      return { success: true, stdout: '' };
    };
    const res = await createService(STUB_ROOT, { exec, stubFs: true }).createCheckpoint({ session: 's' });
    assert.equal(res.ok, true);
    assert.equal(res.created, true);
    assert.equal(res.ref, 'refs/jenny/checkpoints/s/2');
    assert.deepEqual(created.map((args) => args[1]),
      ['refs/jenny/checkpoints/s/1', 'refs/jenny/checkpoints/s/2'],
      'the two attempts target DISTINCT refs — never a second write to the lost ref');
    for (const args of created) {
      assert.equal(args[3], '0'.repeat(40), 'creation is CAS-guarded on the zero OID (must-not-exist)');
    }
  });

  test('checkpoint creation uses a SHA-256-width zero OID for compare-and-swap', async () => {
    const sha = 'a'.repeat(64);
    let createArgs = null;
    const exec = async (_cwd, args) => {
      const scope = scopeResult(args);
      if (scope) return scope;
      if (isHeadProbe(args)) return { success: true, stdout: `${sha}\n` };
      if (args[0] === 'stash') return { success: true, stdout: `${sha}\n` };
      if (args[0] === 'for-each-ref') return { success: true, stdout: '' };
      if (args[0] === 'update-ref' && args[1] !== '-d') {
        createArgs = args;
      }
      return { success: true, stdout: '' };
    };

    const res = await createService(STUB_ROOT, { exec, stubFs: true }).createCheckpoint({ session: 's' });
    assert.equal(res.created, true);
    assert.deepEqual(createArgs, ['update-ref', 'refs/jenny/checkpoints/s/1', sha, '0'.repeat(64)]);
  });

  function restoreExecStub({ calls, onRollbackCreated = null, worktreeRestoreFails = false }) {
    const targetSha = 'b'.repeat(40);
    const indexSha = 'c'.repeat(40);
    return async (_cwd, args) => {
      calls.push(args);
      const scope = scopeResult(args);
      if (scope) return scope;
      if (isHeadProbe(args)) return { success: true, stdout: `${'d'.repeat(40)}\n` };
      if (args[0] === 'rev-parse' && String(args[3] || '').endsWith('^{commit}')) {
        return { success: true, stdout: `${targetSha}\n` };
      }
      if (args[0] === 'rev-parse' && String(args[3] || '').endsWith('^2')) {
        return { success: true, stdout: `${indexSha}\n` };
      }
      if (args[0] === 'stash') return { success: true, stdout: `${'e'.repeat(40)}\n` };
      if (args[0] === 'for-each-ref') return { success: true, stdout: '' };
      if (args[0] === 'update-ref' && args[1] !== '-d') {
        if (onRollbackCreated) onRollbackCreated();
        return { success: true, stdout: '' };
      }
      if (args[0] === 'restore' && args.includes('--worktree') && worktreeRestoreFails) {
        return { success: false, reason: 'git_failed', stdout: '', stderr: 'error: unable to write file', message: 'error: unable to write file' };
      }
      return { success: true, stdout: '' };
    };
  }

  test('design points 4/5/6: partial restore failure still reports rollbackRef; I restores before W', async () => {
    const calls = [];
    const exec = restoreExecStub({ calls, worktreeRestoreFails: true });
    const svc = createService(STUB_ROOT, { exec, stubFs: true });
    const res = await svc.restoreCheckpoint({ ref: 'refs/jenny/checkpoints/sess/1' });
    assert.equal(res.ok, false);
    assert.equal(res.restored, false);
    assert.equal(res.partial, true);
    assert.equal(res.rollbackRef, 'refs/jenny/checkpoints/rollback-sess/1',
      'the caller can always discover the way back once the rollback exists');
    const restores = calls.filter((args) => args[0] === 'restore');
    assert.equal(restores.length, 2);
    assert.ok(restores[0].includes('--staged') && restores[0].includes(`--source=${'c'.repeat(40)}`),
      'the INDEX tree (stash ^2) restores first');
    assert.ok(restores[1].includes('--worktree') && restores[1].includes(`--source=${'b'.repeat(40)}`),
      'the worktree tree restores second');
    const rollbackCreate = calls.find((args) => args[0] === 'update-ref' && args[1] !== '-d');
    assert.ok(calls.indexOf(rollbackCreate) < calls.indexOf(restores[0]),
      'the durable rollback ref exists BEFORE any restore mutation');
  });

  test('restore returns an execution failure when the second-parent probe times out', async () => {
    const calls = [];
    const baseExec = restoreExecStub({ calls });
    const exec = async (cwd, args) => {
      if (args[0] === 'rev-parse' && String(args[3] || '').endsWith('^2')) {
        calls.push(args);
        return { success: false, reason: 'timed_out', stdout: '', stderr: '', message: 'git timed out' };
      }
      return baseExec(cwd, args);
    };

    const res = await createService(STUB_ROOT, { exec, stubFs: true })
      .restoreCheckpoint({ ref: 'refs/jenny/checkpoints/sess/1' });
    assert.equal(res.ok, false);
    assert.equal(res.restored, false);
    assert.equal(res.partial, false);
    assert.equal(res.reason, 'timed_out');
    assert.equal(res.rollbackRef, 'refs/jenny/checkpoints/rollback-sess/1');
    assert.ok(!calls.some((args) => args[0] === 'restore'), 'no restore mutation follows a failed probe');
  });

  test('design point 6: an abort (root change) after rollback creation still returns rollbackRef', async () => {
    let currentRoot = STUB_ROOT;
    const calls = [];
    const exec = restoreExecStub({
      calls,
      onRollbackCreated: () => { currentRoot = 'C:/other'; },
    });
    const svc = createService(STUB_ROOT, { exec, stubFs: true, rootProvider: () => currentRoot });
    const res = await svc.restoreCheckpoint({ ref: 'refs/jenny/checkpoints/sess/1' });
    assert.equal(res.ok, false);
    assert.equal(res.restored, false);
    assert.equal(res.reason, 'root_changed');
    assert.equal(res.rollbackRef, 'refs/jenny/checkpoints/rollback-sess/1');
    assert.ok(!calls.some((args) => args[0] === 'restore'), 'no restore mutation ran after the abort');
  });

  test('design point 7: deletion is CAS-guarded — a ref that moved since listing is refused', async () => {
    const deletes = [];
    const exec = async (_cwd, args) => {
      const scope = scopeResult(args);
      if (scope) return scope;
      if (args[0] === 'rev-parse') return { success: true, stdout: `${SHA_A}\n` };
      if (args[0] === 'update-ref' && args[1] === '-d') {
        deletes.push(args);
        return { success: false, reason: 'git_failed', stdout: '', stderr: `cannot lock ref: is at ${'f'.repeat(40)} but expected ${SHA_A}`, message: 'cannot lock ref' };
      }
      return { success: true, stdout: '' };
    };
    const svc = createService(STUB_ROOT, { exec, stubFs: true });
    const res = await svc.deleteCheckpoint({ ref: 'refs/jenny/checkpoints/s/1' });
    assert.equal(res.ok, false);
    assert.equal(res.error_code, 'CMP-GIT-0040');
    assert.deepEqual(deletes, [['update-ref', '-d', 'refs/jenny/checkpoints/s/1', SHA_A]],
      'the delete passes the SHA observed inside this transaction as the expected old value');
  });

  test('invalid refs are rejected before any git call', async () => {
    const svc = createService(STUB_ROOT, {
      exec: async (_cwd, args) => scopeResult(args) || { success: true, stdout: '' },
      stubFs: true,
    });
    for (const ref of ['refs/heads/main', 'refs/jenny/checkpoints/../../HEAD/1', 'refs/jenny/checkpoints/s/0', '']) {
      await assert.rejects(() => svc.restoreCheckpoint({ ref }), /Invalid checkpoint ref/);
      await assert.rejects(() => svc.deleteCheckpoint({ ref }), /Invalid checkpoint ref/);
    }
  });
});

describe('checkpoint transactions (real repo)', () => {
  test('design points 3/5: staged vs unstaged state round-trips exactly', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'notes.txt'), 'base\n', 'utf8');
    await git(repo, ['add', 'notes.txt']);
    await git(repo, ['commit', '-m', 'notes']);
    // Staged edit on README, unstaged edit on notes.
    await fs.writeFile(path.join(repo, 'README.md'), 'staged-readme\n', 'utf8');
    await git(repo, ['add', 'README.md']);
    await fs.writeFile(path.join(repo, 'notes.txt'), 'unstaged-notes\n', 'utf8');
    const statusBefore = (await git(repo, ['status', '--porcelain=v1'])).stdout;
    const cachedBefore = (await git(repo, ['diff', '--cached'])).stdout;

    const svc = createService(repo);
    const created = await svc.createCheckpoint({ session: 'sess_rt' });
    assert.equal(created.created, true);

    // Scramble both index and worktree.
    await fs.writeFile(path.join(repo, 'README.md'), 'scrambled\n', 'utf8');
    await fs.writeFile(path.join(repo, 'notes.txt'), 'scrambled\n', 'utf8');
    await git(repo, ['add', 'README.md', 'notes.txt']);

    const restored = await svc.restoreCheckpoint({ ref: created.ref });
    assert.equal(restored.ok, true);
    assert.equal(restored.restored, true);
    assert.ok(restored.rollbackRef, 'restore reports its rollback ref');
    await git(repo, ['rev-parse', '--verify', restored.rollbackRef]);

    assert.equal((await git(repo, ['status', '--porcelain=v1'])).stdout, statusBefore,
      'porcelain status (staged vs unstaged classification) is identical');
    assert.equal((await git(repo, ['diff', '--cached'])).stdout, cachedBefore,
      'the staged diff round-trips exactly (index tree preserved via stash ^2)');
    assert.equal(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), 'staged-readme\n');
    assert.equal(await fs.readFile(path.join(repo, 'notes.txt'), 'utf8'), 'unstaged-notes\n');
  });

  test('design point 4: restoring onto a CLEAN tree still creates a durable rollback ref', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'dirty\n', 'utf8');
    const svc = createService(repo);
    const created = await svc.createCheckpoint({ session: 'sess_clean' });
    assert.equal(created.created, true);
    // Clean the tree completely, then restore the checkpoint.
    await git(repo, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
    assert.equal((await git(repo, ['status', '--porcelain=v1'])).stdout, '', 'tree is clean pre-restore');

    const restored = await svc.restoreCheckpoint({ ref: created.ref });
    assert.equal(restored.restored, true);
    assert.ok(restored.rollbackRef, 'a clean tree still yields a rollback ref');
    const rollbackSha = (await git(repo, ['rev-parse', '--verify', restored.rollbackRef])).stdout.trim();
    const headSha = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(rollbackSha, headSha, 'the clean-tree rollback pins HEAD itself');
    assert.equal(await fs.readFile(path.join(repo, 'README.md'), 'utf8'), 'dirty\n');

    // Round-trip back through the plain-commit rollback target (^2 fallback).
    const rolledBack = await svc.restoreCheckpoint({ ref: restored.rollbackRef });
    assert.equal(rolledBack.restored, true);
    assert.equal((await git(repo, ['status', '--porcelain=v1'])).stdout, '', 'rollback returns the tree to clean');
  });

  test('design points 1/2: concurrent creates serialize and receive distinct refs', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'dirty\n', 'utf8');
    const svc = createService(repo);
    const [first, second] = await Promise.all([
      svc.createCheckpoint({ session: 'sess_con' }),
      svc.createCheckpoint({ session: 'sess_con' }),
    ]);
    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.notEqual(first.ref, second.ref, 'two concurrent creates never share a ref');
    await git(repo, ['rev-parse', '--verify', first.ref]);
    await git(repo, ['rev-parse', '--verify', second.ref]);
  });

  test('design points 9/11: retention prunes beyond caps, protects the fresh ref, reports honestly', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'dirty\n', 'utf8');
    const api = directApi(repo, { retention: { perSession: 2, total: 10, maxAgeMs: 365 * DAY_MS } });
    const first = await api.createCheckpoint({ session: 'ret' });
    const second = await api.createCheckpoint({ session: 'ret' });
    const third = await api.createCheckpoint({ session: 'ret' });
    assert.equal(third.created, true);
    assert.equal(third.retention.prunedRefs, 1, 'the third create prunes exactly the oldest ref');
    assert.equal(third.retention.skippedRefs, 0);
    assert.equal(third.retention.diskReclaim, 'deferred_to_git_gc',
      'reporting claims ref removal only — disk bytes wait for git gc');
    assert.ok(!('bytes' in third.retention) && !('bytesReclaimed' in third.retention),
      'no immediate disk-byte reclamation is ever claimed');
    await assert.rejects(() => git(repo, ['rev-parse', '--verify', first.ref]), /Command failed/i);
    await git(repo, ['rev-parse', '--verify', second.ref]);
    await git(repo, ['rev-parse', '--verify', third.ref]);

    const listed = await api.listCheckpoints({ session: 'ret' });
    assert.equal(listed.ok, true);
    assert.deepEqual(listed.checkpoints.map((entry) => entry.ref).sort(), [second.ref, third.ref].sort());
  });

  test('delete removes an existing checkpoint and reports a missing one as not found', async () => {
    const repo = await createGitRepo();
    await fs.writeFile(path.join(repo, 'README.md'), 'dirty\n', 'utf8');
    const svc = createService(repo);
    const created = await svc.createCheckpoint({ session: 'sess_del' });
    const deleted = await svc.deleteCheckpoint({ ref: created.ref });
    assert.equal(deleted.deleted, true);
    await assert.rejects(() => git(repo, ['rev-parse', '--verify', created.ref]));
    const again = await svc.deleteCheckpoint({ ref: created.ref });
    assert.equal(again.deleted, false);
    assert.equal(again.reason, 'checkpoint_not_found');
  });
});
