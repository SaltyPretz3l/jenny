/* services/workspace-git-checkpoint.js - bounded checkpoint lifecycle for
 * WorkspaceGitService (WIDE-035). Checkpoints are non-destructive stash-created
 * commits (worktree tree = commit tree, index tree = second parent's tree) held
 * under refs/jenny/checkpoints/<session>/<sequence> (the row 106 sandbox restore
 * points use the same core under refs/jenny/sandbox; workspace-git-checkpoint-refs).
 *
 * Transaction model: EVERY operation (create, list, restore, delete) runs
 * inside ONE service-provided root-bound serialized transaction (`runTransaction`
 * acquires a single mutation lease, serializes on the root identity, and
 * re-validates repo scope once). Within a transaction, the root snapshot is
 * re-verified (`tx.isCurrent()`) immediately before every git mutation, and no
 * operation ever opens a nested transaction (a rollback snapshot is created by
 * a helper inside the SAME restore transaction).
 *
 * Untracked files (row 34 A1) ride along as a stash -u-shaped third parent
 * built by workspace-git-checkpoint-untracked without touching the real index
 * or the working tree; restore writes them back without deleting anything.
 *
 * Ref writes are compare-and-swap: creation passes the zero OID as the expected
 * old value (the ref must not exist; a concurrent create loses cleanly and the
 * retry re-reads the namespace for a fresh sequence), and deletion passes the
 * SHA observed inside the same transaction (a ref that moved since listing is
 * refused, never blind-deleted).
 */

'use strict';

const { WORKSPACE_GIT_ERROR_CODES, workspaceGitError } = require('./workspace-git-errors');
const { createUntrackedCheckpointSupport } = require('./workspace-git-checkpoint-untracked');
const { createCheckpointFileOps } = require('./workspace-git-checkpoint-files');
const {
  CHECKPOINT_FORMAT,
  CHECKPOINT_NAMESPACE,
  SHA_RE,
  sanitizeCheckpointSession,
} = require('./workspace-git-checkpoint-refs');

const MAX_CREATE_ATTEMPTS = 5;
// The only verbs this owner may hand to the executor as mutations. The last
// three write objects only (blobs, trees, commits), never the index or worktree.
const CHECKPOINT_WRITE_VERBS = new Set(['stash', 'update-ref', 'restore', 'hash-object', 'mktree', 'commit-tree']);
// The turn-checkpoint namespace (refs/jenny/checkpoints); the sandbox restore
// points pass their own namespace to createWorkspaceGitCheckpointApi.
const checkpointRefIsSafe = CHECKPOINT_NAMESPACE.refIsSafe;
const planCheckpointRetention = CHECKPOINT_NAMESPACE.planRetention;

// `git stash create` exits 1 with no output when a racily-clean tracked file
// passes its first change check but not the second (git's do_create_stash
// "no changes" path). That is "nothing to snapshot", not a failure. A timeout
// or abort carries its own message and never matches.
function stashFoundNothing(result) {
  return result.reason === 'git_failed'
    && !String(result.stdout || '').trim()
    && !String(result.stderr || '').trim()
    && /^command failed: git stash create\s*$/i.test(String(result.message || ''));
}

// The transaction runner (WIDE-035 design point 1): ONE mutation lease + ONE
// serialized slot for the whole checkpoint operation (create/list/restore/
// delete), with repo scope validated once up front. The handler receives the
// root snapshot plus isCurrent()/stale() and re-verifies before every
// mutation; its result is returned AS-IS — never overwritten after mutations
// may have run, so a rollbackRef survives a late root change or abort. The
// seams are WorkspaceGitService primitives, injected so the transaction core
// lives here (file-size cap) while policy shapes stay owned by the service.
function createCheckpointTransactionRunner({
  gitEnabled,
  acquireMutation,
  runSerialized,
  detectScope,
  unavailable,
  notARepo,
  notToplevel,
  execFailure,
  runWithResources = async (_operation, handler) => handler(),
  isResourceError = () => false,
}) {
  return async function runTransaction(op, handler, { signal = null } = {}) {
    if (!gitEnabled()) return unavailable(op, 'feature_disabled');
    const operation = acquireMutation(signal);
    if (!operation.acquired) return unavailable(op, operation.code);
    try {
      return await runSerialized(operation.context?.rootId || operation.root, async () => {
        try {
          return await runWithResources(operation, async () => {
            if (!operation.isCurrent()) return unavailable(op, 'root_changed');
            const detect = await detectScope(operation.root, {
              signal: operation.signal,
              isCurrent: operation.isCurrent,
            });
            if (detect.stale || !operation.isCurrent()) return unavailable(op, 'root_changed');
            if (detect.failure) return execFailure(op, detect.failure);
            if (!detect.isRepo) return notARepo(op);
            if (!detect.isToplevel) return notToplevel(op);
            return handler({
              root: operation.root,
              signal: operation.signal,
              isCurrent: () => operation.isCurrent(),
              stale: () => unavailable(op, 'root_changed'),
            });
          });
        } catch (error) {
          if (isResourceError(error)) return unavailable(op, error.reason);
          throw error;
        }
      });
    } finally {
      operation.release();
    }
  };
}

/**
 * Transaction-core factory. Seams (all supplied by WorkspaceGitService):
 *  - runTransaction(op, handler, { signal }): a createCheckpointTransactionRunner
 *    product (or a test harness with the same contract).
 *  - exec(root, args, { signal, input }): the service's guarded git executor.
 *  - execFailure(op, result): the service's structured failure factory.
 *  - probeHeadState(exec, root, signal): typed HEAD probe — a broken probe
 *    surfaces as { failure } and is NEVER read as "unborn HEAD".
 *  - retention: optional cap overrides (tests/config), defaults above.
 *  - untrackedLimits / fs: optional untracked-capture caps and fs seam (tests).
 *  - resolveInsideRoot(relPath, root) / trashItem(absolutePath): the service's
 *    path containment and recycle-bin seams for the per-file operations.
 *  - namespace: the ref namespace (workspace-git-checkpoint-refs); turn
 *    checkpoints by default. Rollback refs land in the same namespace.
 */
function createWorkspaceGitCheckpointApi({
  namespace = CHECKPOINT_NAMESPACE,
  runTransaction,
  exec,
  execFailure,
  probeHeadState,
  log = () => {},
  retention: retentionCaps = {},
  untrackedLimits = {},
  fs = undefined,
  resolveInsideRoot = null,
  trashItem = null,
} = {}) {
  // `identity` is a fixed `-c user.*` prefix for commit-tree; it is prepended
  // only after the verb check, so args[0] is always the checked verb.
  function mutate(tx, args, { input = null, timeoutMs, identity = [] } = {}) {
    if (!CHECKPOINT_WRITE_VERBS.has(args[0])) {
      throw workspaceGitError(
        WORKSPACE_GIT_ERROR_CODES.GIT_COMMAND_FAILED,
        `Unexpected checkpoint mutation verb: ${String(args[0])}`
      );
    }
    return exec(tx.root, [...identity, ...args], {
      signal: tx.signal,
      ...(input !== null ? { input } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  }

  const untracked = createUntrackedCheckpointSupport({
    exec,
    mutate,
    limits: untrackedLimits,
    ...(fs ? { fs } : {}),
  });

  function softResult(op, extra) {
    return { ok: true, available: true, isRepo: true, op, ...extra };
  }

  async function listRefs(tx, prefix) {
    return exec(tx.root, ['for-each-ref', `--format=${CHECKPOINT_FORMAT}`, prefix], {
      signal: tx.signal,
    });
  }

  // CAS ref creation with bounded retry: re-read the session namespace for a
  // fresh sequence, then `update-ref <ref> <sha> <zero OID>` (must-not-exist).
  // A concurrent creator that wins a sequence makes our attempt fail cleanly;
  // the retry re-lists and lands on the next free number — two concurrent
  // creates always receive DISTINCT refs, never a last-writer-wins overwrite.
  async function casCreateRef(tx, sessionSegment, sha) {
    const prefix = `${namespace.prefix}/${sessionSegment}/`;
    let lastFailure = null;
    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      const listed = await listRefs(tx, prefix);
      if (!listed.success) return { failure: listed };
      const sequence = namespace.nextSequence(listed.stdout);
      const ref = `${prefix}${sequence}`;
      if (!namespace.refIsSafe(ref)) {
        throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.REF_INVALID, 'Invalid checkpoint ref.', { ref });
      }
      if (!tx.isCurrent()) return { stale: true };
      const zeroOid = '0'.repeat(sha.length === 64 ? 64 : 40);
      const created = await mutate(tx, ['update-ref', ref, sha, zeroOid]);
      if (created.success) return { ref, sequence };
      lastFailure = created;
    }
    return { failure: lastFailure };
  }

  // Snapshot the current repo state (`git stash create`: non-destructive,
  // preserves the index tree as the commit's second parent so staged vs
  // unstaged state round-trips exactly), add untracked files as a third
  // parent when there are any, and pin it under a CAS-created ref.
  // With { allowClean: true } a clean tree still yields a DURABLE ref by
  // pinning HEAD itself (used for pre-restore rollback snapshots).
  // Returns { ref, sha, sequence, untracked } or { result } (a terminal
  // soft/failure result the caller must return).
  async function createSnapshotRef(tx, sessionSegment, op, { allowClean = false } = {}) {
    const head = await probeHeadState(exec, tx.root, tx.signal);
    if (head.failure) return { result: execFailure(op, head.failure) };
    if (!head.hasHead) {
      return { result: softResult(op, { created: false, reason: 'no_head' }) };
    }
    if (!tx.isCurrent()) return { result: tx.stale() };
    const stash = await mutate(tx, ['stash', 'create']);
    if (!stash.success && !stashFoundNothing(stash)) return { result: execFailure(op, stash) };
    // `stash create` signals "nothing to snapshot" via EMPTY stdout + exit 0.
    const stashSha = stash.success ? String(stash.stdout || '').trim().toLowerCase() : '';
    if (stashSha && !SHA_RE.test(stashSha)) {
      return { result: execFailure(op, { message: 'stash create returned an invalid object id' }) };
    }
    const extended = await untracked.captureCheckpoint(tx, { stashSha });
    if (extended.stale) return { result: tx.stale() };
    if (extended.failure) return { result: execFailure(op, extended.failure) };
    let sha = extended.sha || stashSha;
    if (!sha) {
      if (!allowClean) {
        return { result: softResult(op, { created: false, reason: 'nothing_to_checkpoint', untracked: extended.summary }) };
      }
      const headSha = await exec(tx.root, ['rev-parse', '--verify', 'HEAD'], { signal: tx.signal });
      sha = String(headSha.stdout || '').trim().toLowerCase();
      if (!headSha.success || !SHA_RE.test(sha)) return { result: execFailure(op, headSha) };
    }
    const cas = await casCreateRef(tx, sessionSegment, sha);
    if (cas.stale) return { result: tx.stale() };
    if (cas.failure) return { result: execFailure(op, cas.failure) };
    return { ref: cas.ref, sha, sequence: cas.sequence, untracked: extended.summary };
  }

  // Count/age retention sweep. Every delete is CAS'd against the SHA observed
  // in this transaction's listing. Reported honestly: pruning removes REFS
  // immediately; the underlying objects' disk bytes are reclaimed only by a
  // later `git gc`, so no byte figure is ever claimed here.
  async function pruneWithRetention(tx, protectedRefs) {
    const summary = { prunedRefs: 0, skippedRefs: 0, diskReclaim: 'deferred_to_git_gc' };
    const listed = await listRefs(tx, namespace.prefix);
    if (!listed.success) {
      summary.warning = 'checkpoint_list_failed';
      log('WARN', 'workspace_git.checkpoint_retention_failed', { reason: summary.warning });
      return summary;
    }
    const candidates = namespace.planRetention(namespace.parseRefs(listed.stdout), {
      ...retentionCaps,
      protectedRefs,
    });
    for (const candidate of candidates) {
      if (!tx.isCurrent()) {
        summary.skippedRefs += 1;
        summary.warning = 'root_changed';
        break;
      }
      const removed = await mutate(tx, ['update-ref', '-d', candidate.ref, candidate.sha]);
      if (removed.success) summary.prunedRefs += 1;
      else summary.skippedRefs += 1;
    }
    if (summary.warning === 'root_changed') {
      log('WARN', 'workspace_git.checkpoint_retention_failed', { reason: summary.warning });
    }
    return summary;
  }

  // `allowClean` pins HEAD when nothing is dirty, so the run always has a
  // restore point to put script-changed files back from (row 34 S5).
  async function createCheckpoint({ session = '', signal = null, allowClean = false } = {}) {
    const safeSession = sanitizeCheckpointSession(session);
    return runTransaction('createCheckpoint', async (tx) => {
      const snapshot = await createSnapshotRef(tx, safeSession, 'createCheckpoint', { allowClean: allowClean === true });
      if (snapshot.result) return snapshot.result;
      const retention = await pruneWithRetention(tx, [snapshot.ref]);
      return softResult('createCheckpoint', {
        created: true,
        ref: snapshot.ref,
        sha: snapshot.sha,
        sequence: snapshot.sequence,
        untracked: snapshot.untracked,
        retention,
      });
    }, { signal });
  }

  async function listCheckpoints({ session = '', limit = 50, signal = null } = {}) {
    return runTransaction('listCheckpoints', async (tx) => {
      const safeSession = String(session || '').trim() ? sanitizeCheckpointSession(session) : '';
      const prefix = safeSession ? `${namespace.prefix}/${safeSession}/` : namespace.prefix;
      const listed = await listRefs(tx, prefix);
      if (!listed.success) return execFailure('listCheckpoints', listed);
      const checkpoints = namespace.parseRefs(listed.stdout);
      const boundedLimit = Math.max(1, Math.min(100, Math.trunc(Number(limit)) || 50));
      return softResult('listCheckpoints', {
        checkpoints: checkpoints.slice(0, boundedLimit),
        total: checkpoints.length,
        truncated: checkpoints.length > boundedLimit,
      });
    }, { signal });
  }

  async function restoreCheckpoint({ ref = '', signal = null } = {}) {
    const normalizedRef = String(ref || '').trim();
    return runTransaction('restoreCheckpoint', async (tx) => {
      const op = 'restoreCheckpoint';
      if (!namespace.refIsSafe(normalizedRef)) {
        throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.REF_INVALID, 'Invalid checkpoint ref.');
      }
      const resolved = await exec(
        tx.root,
        ['rev-parse', '--verify', '--quiet', `${normalizedRef}^{commit}`],
        { signal: tx.signal }
      );
      const targetSha = String(resolved.stdout || '').trim().toLowerCase();
      if (!resolved.success || !SHA_RE.test(targetSha)) {
        return softResult(op, { found: false, restored: false, reason: 'checkpoint_not_found' });
      }
      // Durable rollback ref BEFORE any restore mutation — even when the tree
      // is currently clean (the rollback then pins HEAD). If the rollback
      // cannot be pinned, the restore never starts.
      const targetSession = namespace.sessionOf(normalizedRef);
      const rollback = await createSnapshotRef(
        tx,
        sanitizeCheckpointSession(`rollback-${targetSession}`),
        op,
        { allowClean: true }
      );
      if (rollback.result) {
        return { ...rollback.result, ok: false, op, restored: false, reason: rollback.result.reason || 'rollback_failed' };
      }
      const rollbackRef = rollback.ref;
      // From here on EVERY return carries rollbackRef: once the rollback
      // exists the caller must always be able to discover the way back, even
      // on abort or partial failure.
      const withRollback = (result) => ({ ...result, rollbackRef });
      if (!tx.isCurrent()) {
        return withRollback({ ok: false, available: true, isRepo: true, op, restored: false, partial: false, reason: 'root_changed' });
      }
      // Stash commits carry the INDEX tree as their second parent; restore it
      // to the index FIRST, then the commit's own (worktree) tree to the
      // worktree. A plain-commit target (clean-tree rollback ref) has no ^2 and
      // uses its own tree for both.
      const indexProbe = await exec(
        tx.root,
        ['rev-parse', '--verify', '--quiet', `${targetSha}^2`],
        { signal: tx.signal }
      );
      const probedIndexSha = String(indexProbe.stdout || '').trim().toLowerCase();
      let indexSha;
      if (indexProbe.success && SHA_RE.test(probedIndexSha)) {
        indexSha = probedIndexSha;
      } else {
        const detail = String(indexProbe.stderr || indexProbe.message || '');
        const missingIndexParent = !indexProbe.success
          && indexProbe.reason === 'git_failed'
          && (!detail
            || /needed a single revision|unknown revision|bad revision|ambiguous argument/i.test(detail)
            || /^command failed: git rev-parse --verify --quiet [0-9a-f]{40,64}\^2\s*$/i.test(detail));
        if (!missingIndexParent) {
          return withRollback({ ...execFailure(op, indexProbe), restored: false, partial: false });
        }
        indexSha = targetSha;
      }
      // Untracked files (third parent) are listed and validated BEFORE any
      // restore mutation; old checkpoints without one restore as before.
      const untrackedPlan = await untracked.planRestore(tx, targetSha);
      if (untrackedPlan.failure) {
        return withRollback({ ...execFailure(op, untrackedPlan.failure), restored: false, partial: false });
      }
      const indexRestore = await mutate(tx, ['restore', `--source=${indexSha}`, '--staged', '--', '.']);
      if (!indexRestore.success) {
        return withRollback({ ...execFailure(op, indexRestore), restored: false, partial: false });
      }
      if (!tx.isCurrent()) {
        return withRollback({ ok: false, available: true, isRepo: true, op, restored: false, partial: true, reason: 'root_changed' });
      }
      const worktreeRestore = await mutate(tx, ['restore', `--source=${targetSha}`, '--worktree', '--', '.']);
      if (!worktreeRestore.success) {
        return withRollback({ ...execFailure(op, worktreeRestore), restored: false, partial: true });
      }
      if (untrackedPlan.commit) {
        const applied = await untracked.applyRestore(tx, untrackedPlan);
        if (applied.stale) {
          return withRollback({ ok: false, available: true, isRepo: true, op, restored: false, partial: true, reason: 'root_changed' });
        }
        if (applied.failure) {
          return withRollback({ ...execFailure(op, applied.failure), restored: false, partial: true });
        }
        return withRollback(softResult(op, { restored: true, ref: normalizedRef, sha: targetSha, untracked: applied.summary }));
      }
      return withRollback(softResult(op, { restored: true, ref: normalizedRef, sha: targetSha }));
    }, { signal });
  }

  async function deleteCheckpoint({ ref = '', signal = null } = {}) {
    const normalizedRef = String(ref || '').trim();
    return runTransaction('deleteCheckpoint', async (tx) => {
      const op = 'deleteCheckpoint';
      if (!namespace.refIsSafe(normalizedRef)) {
        throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.REF_INVALID, 'Invalid checkpoint ref.');
      }
      const resolved = await exec(
        tx.root,
        ['rev-parse', '--verify', '--quiet', normalizedRef],
        { signal: tx.signal }
      );
      const sha = String(resolved.stdout || '').trim().toLowerCase();
      if (!resolved.success || !SHA_RE.test(sha)) {
        return softResult(op, { found: false, deleted: false, reason: 'checkpoint_not_found' });
      }
      if (!tx.isCurrent()) return tx.stale();
      // CAS delete: expected old SHA from THIS transaction's read — a ref that
      // moved since being observed is refused, never blind-deleted.
      const removed = await mutate(tx, ['update-ref', '-d', normalizedRef, sha]);
      if (!removed.success) return execFailure(op, removed);
      return softResult(op, { deleted: true, ref: normalizedRef, sha });
    }, { signal });
  }

  // Row 34 S5: per-file preflight/restore (worktree only) in the same
  // transaction model; the rollback snapshot doubles as the Redo target.
  const fileOps = createCheckpointFileOps({
    runTransaction,
    exec,
    mutate,
    execFailure,
    softResult,
    untracked,
    createSnapshotRef,
    rollbackSessionFor: (ref) => sanitizeCheckpointSession(`rollback-${namespace.sessionOf(ref)}`),
    checkpointRefIsSafe: namespace.refIsSafe,
    resolveInsideRoot: async (relPath, root) => {
      if (typeof resolveInsideRoot !== 'function') {
        throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.PATH_INVALID, 'Path containment is unavailable.');
      }
      return resolveInsideRoot(relPath, root);
    },
    trashItem,
    ...(fs ? { fs } : {}),
  });

  return {
    createCheckpoint,
    listCheckpoints,
    restoreCheckpoint,
    deleteCheckpoint,
    preflightCheckpointFiles: fileOps.preflightCheckpointFiles,
    restoreCheckpointFiles: fileOps.restoreCheckpointFiles,
  };
}

module.exports = {
  CHECKPOINT_WRITE_VERBS,
  checkpointRefIsSafe,
  createCheckpointTransactionRunner,
  createWorkspaceGitCheckpointApi,
  planCheckpointRetention,
  sanitizeCheckpointSession,
};
