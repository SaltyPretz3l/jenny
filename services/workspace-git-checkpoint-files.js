/* services/workspace-git-checkpoint-files.js - file-by-file checkpoint
 * preflight and restore for the Changes view (row 34 S5 step 4).
 *
 * `restoreCheckpoint` rewinds the whole worktree and index; the undo sheet
 * needs to put back single files instead. These operations run inside the
 * same root-bound serialized checkpoint transaction as every other checkpoint
 * operation and reuse its pieces: the service's path containment (lexical +
 * realpath, symlink/junction escapes refused), the literal-pathspec command
 * builder, the rollback snapshot (`createSnapshotRef`, which is also the Redo
 * target) and the untracked-file restore with a path filter.
 *
 * Restores touch the WORKTREE only (`git restore --source=<sha> --worktree`
 * with literal pathspecs); the index is never written. Nothing is deleted
 * outright: `removePaths` go to the OS recycle bin through the service's
 * trash implementation, and a path absent from the checkpoint is refused,
 * never removed.
 */

'use strict';

const fsPromises = require('fs/promises');

const { WORKSPACE_GIT_ERROR_CODES, workspaceGitError } = require('./workspace-git-errors');
const { buildPathspecCommand } = require('./workspace-git-executor');
const { cQuotePath } = require('./workspace-git-checkpoint-untracked');
const { normalizeDiffInputText, sha256Text } = require('./tools/structured-diff');
const { sha256Bytes } = require('./workspace-recovery-safety-copies');
const { mapWithConcurrency } = require('./bounded-concurrency');

const SHA_RE = /^[0-9a-f]{40,64}$/;
const OBJECT_LINE_RE = /^([0-9a-f]{40,64}) (blob|tree|commit|tag)$/;
const MAX_FILES = 500;
const AFTER_HASH_MAX_BYTES = 2 * 1024 * 1024;
const FS_CONCURRENCY = 16;
const HASH_TIMEOUT_MS = 30000;
const HASH_KINDS = Object.freeze(['diff_input_text', 'raw_bytes']);

function diskKind(stats) {
  if (stats.isSymbolicLink()) return 'symlink';
  if (stats.isFile()) return 'file';
  return stats.isDirectory() ? 'directory' : 'other';
}

function sameIdentity(left, right) {
  return String(left?.dev) === String(right?.dev) && String(left?.ino) === String(right?.ino);
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (_error) {
    return null;
  }
}

function createCheckpointFileOps({
  runTransaction,
  exec,
  mutate,
  execFailure,
  softResult,
  untracked,
  createSnapshotRef,
  rollbackSessionFor,
  checkpointRefIsSafe,
  resolveInsideRoot,
  trashItem = null,
  fs = fsPromises,
}) {
  function refusal(op, reason, errorCode) {
    // No message: the IPC layer answers with its own fixed text by reason.
    return { ok: false, available: true, isRepo: true, op, error_code: errorCode, reason };
  }

  function assertRef(ref) {
    if (!checkpointRefIsSafe(ref)) {
      throw workspaceGitError(WORKSPACE_GIT_ERROR_CODES.REF_INVALID, 'Invalid checkpoint ref.');
    }
  }

  async function resolveCommit(tx, ref) {
    const resolved = await exec(tx.root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { signal: tx.signal });
    const sha = String(resolved.stdout || '').trim().toLowerCase();
    return resolved.success && SHA_RE.test(sha) ? sha : '';
  }

  // Lexical + realpath containment through the service, deduped by the
  // normalized relative path; `item` rides along on each entry. A path git
  // cannot address line-wise (CR/LF) is refused with the rest of the request.
  async function resolvePaths(tx, op, items) {
    const resolved = new Map();
    for (const item of items) {
      let entry;
      try {
        entry = await resolveInsideRoot(item.path, tx.root);
      } catch (error) {
        if (error?.code === WORKSPACE_GIT_ERROR_CODES.PATH_OUTSIDE_ROOT) return { result: refusal(op, 'path_outside_root', error.code) };
        if (error?.code === WORKSPACE_GIT_ERROR_CODES.PATH_INVALID) return { result: refusal(op, 'path_invalid', error.code) };
        throw error;
      }
      if (/[\r\n]/.test(entry.relPath)) return { result: refusal(op, 'path_invalid', WORKSPACE_GIT_ERROR_CODES.PATH_INVALID) };
      if (!resolved.has(entry.relPath)) resolved.set(entry.relPath, { ...entry, item });
    }
    if (resolved.size > MAX_FILES) return { result: refusal(op, 'too_many_paths', WORKSPACE_GIT_ERROR_CODES.PATH_INVALID) };
    return { resolved: [...resolved.values()] };
  }

  // One `cat-file --batch-check` per tree: `<commit>:<path>` -> { oid, type }
  // or null when the path is not in that tree.
  async function treeEntries(tx, commit, relPaths) {
    if (!commit || !relPaths.length) return { entries: relPaths.map(() => null) };
    const listed = await exec(tx.root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
      signal: tx.signal,
      input: `${relPaths.map((relPath) => `${commit}:${relPath}`).join('\n')}\n`,
    });
    if (!listed.success) return { failure: listed };
    const lines = String(listed.stdout || '').split('\n').map((line) => line.replace(/\r$/, ''));
    if (lines.filter(Boolean).length !== relPaths.length) {
      return { failure: { reason: 'git_failed', message: 'cat-file returned an unexpected line count' } };
    }
    return {
      entries: relPaths.map((_relPath, index) => {
        const match = OBJECT_LINE_RE.exec(lines[index]);
        return match ? { oid: match[1], type: match[2] } : null;
      }),
    };
  }

  // Where each path lives in the checkpoint: its worktree tree, else its
  // shape-checked untracked parent (`^3`), else absent.
  async function membership(tx, targetSha, relPaths) {
    const tracked = await treeEntries(tx, targetSha, relPaths);
    if (tracked.failure) return tracked;
    const parent = await untracked.findUntrackedParent(tx, targetSha);
    if (parent.failure) return parent;
    const loose = await treeEntries(tx, parent.commit, relPaths);
    if (loose.failure) return loose;
    return {
      entries: relPaths.map((_relPath, index) => {
        if (tracked.entries[index]) return { where: 'tracked', ...tracked.entries[index] };
        if (loose.entries[index]) return { where: 'untracked', ...loose.entries[index] };
        return { where: 'absent', oid: '', type: '' };
      }),
    };
  }

  async function inspectDisk(absolute) {
    try {
      const stats = await fs.lstat(absolute);
      return { kind: diskKind(stats), size: Number(stats.size) || 0, mtimeMs: Number(stats.mtimeMs) || 0, stats };
    } catch (error) {
      const missing = error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
      return { kind: missing ? 'missing' : 'other', size: 0, mtimeMs: 0, stats: null };
    }
  }

  // Bounded read of a regular file that must still be the inode lstat saw
  // (a swap for a link between lstat and open is refused).
  async function readSmallFile(absolute, lstats) {
    let handle;
    try {
      handle = await fs.open(absolute, 'r');
      const stats = await handle.stat();
      if (!stats.isFile() || !sameIdentity(stats, lstats) || stats.size > AFTER_HASH_MAX_BYTES) return null;
      // One spare byte shows a file that grew while it was read.
      const bytes = Buffer.alloc(stats.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return offset > stats.size ? null : bytes.subarray(0, offset);
    } catch (_error) {
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function matchesAfter(absolute, disk, item) {
    const afterHash = typeof item?.afterHash === 'string' ? item.afterHash.toLowerCase() : '';
    if (!afterHash || disk.kind !== 'file') return null;
    const bytes = await readSmallFile(absolute, disk.stats);
    if (!bytes) return null;
    if (item.hashKind === 'raw_bytes') return sha256Bytes(bytes) === afterHash;
    const text = bytes.includes(0) ? null : decodeUtf8(bytes);
    return text === null ? null : sha256Text(normalizeDiffInputText(text)) === afterHash;
  }

  // `git hash-object` (no -w) of the regular files, so blob ids compare with
  // the checkpoint's without JS reading content. A failed hash degrades to
  // "unknown" for every file; an abort stays an abort.
  async function worktreeBlobIds(tx, relPaths) {
    if (!relPaths.length) return { ids: [] };
    const hashed = await exec(tx.root, ['hash-object', '--stdin-paths'], {
      signal: tx.signal,
      input: `${relPaths.map(cQuotePath).join('\n')}\n`,
      timeoutMs: HASH_TIMEOUT_MS,
    });
    if (!hashed.success) return hashed.reason === 'aborted' ? { failure: hashed } : { ids: relPaths.map(() => null) };
    const ids = String(hashed.stdout || '').split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean);
    return ids.length === relPaths.length && ids.every((id) => SHA_RE.test(id)) ? { ids } : { ids: relPaths.map(() => null) };
  }

  async function preflightCheckpointFiles({ ref = '', files = [], signal = null } = {}) {
    const normalizedRef = String(ref || '').trim();
    const requested = (Array.isArray(files) ? files : []).map((item) => ({ ...item }));
    return runTransaction('preflightCheckpointFiles', async (tx) => {
      const op = 'preflightCheckpointFiles';
      assertRef(normalizedRef);
      const targetSha = await resolveCommit(tx, normalizedRef);
      if (!targetSha) return softResult(op, { found: false, reason: 'checkpoint_not_found', files: [] });
      const paths = await resolvePaths(tx, op, requested);
      if (paths.result) return paths.result;
      const relPaths = paths.resolved.map((entry) => entry.relPath);
      const member = await membership(tx, targetSha, relPaths);
      if (member.failure) return execFailure(op, member.failure);
      const disk = await mapWithConcurrency(paths.resolved, FS_CONCURRENCY, (entry) => inspectDisk(entry.resolved));
      const regular = relPaths.filter((_relPath, index) => disk[index].kind === 'file');
      const hashed = await worktreeBlobIds(tx, regular);
      if (hashed.failure) return execFailure(op, hashed.failure);
      const worktreeIds = new Map(regular.map((relPath, index) => [relPath, hashed.ids[index]]));
      const results = await mapWithConcurrency(paths.resolved, FS_CONCURRENCY, async (entry, index) => {
        const onDisk = disk[index];
        const worktreeId = worktreeIds.get(entry.relPath);
        return {
          path: entry.relPath,
          inCheckpoint: member.entries[index].where,
          exists: onDisk.kind !== 'missing',
          kind: onDisk.kind,
          size: onDisk.size,
          mtimeMs: onDisk.mtimeMs,
          matchesCheckpoint: onDisk.kind !== 'file' || !worktreeId ? null : worktreeId === member.entries[index].oid,
          matchesAfter: await matchesAfter(entry.resolved, onDisk, entry.item),
        };
      });
      return softResult(op, { found: true, ref: normalizedRef, files: results });
    }, { signal });
  }

  // Splits the request into git-restorable tracked paths, untracked-parent
  // paths, removals, and per-path refusals. Read-only.
  async function planFileRestore(tx, targetSha, wanted, removing) {
    const all = [...wanted, ...removing];
    const member = await membership(tx, targetSha, all.map((entry) => entry.relPath));
    if (member.failure) return member;
    const loosePaths = wanted.filter((_entry, index) => member.entries[index].where === 'untracked').map((entry) => entry.relPath);
    const untrackedPlan = loosePaths.length
      ? await untracked.planRestore(tx, targetSha, { onlyPaths: new Set(loosePaths) })
      : { commit: null, paths: [] };
    if (untrackedPlan.failure) return untrackedPlan;
    const restorableLoose = new Set(untrackedPlan.paths || []);
    const plan = { tracked: [], loose: [], removals: [], failed: [], untrackedPlan };
    const conflicts = await mapWithConcurrency(wanted, FS_CONCURRENCY, (entry, index) => (
      member.entries[index].where === 'tracked' ? untracked.pathConflicts(tx.root, entry.relPath) : false));
    wanted.forEach((entry, index) => {
      const where = member.entries[index];
      if (where.where === 'absent') plan.failed.push({ path: entry.relPath, reason: 'not_in_checkpoint' });
      else if (where.where === 'tracked' && where.type !== 'blob') plan.failed.push({ path: entry.relPath, reason: 'not_restorable' });
      else if (where.where === 'tracked' && conflicts[index]) plan.failed.push({ path: entry.relPath, reason: 'path_conflict' });
      else if (where.where === 'tracked') plan.tracked.push(entry.relPath);
      else if (restorableLoose.has(entry.relPath)) plan.loose.push(entry.relPath);
      else plan.failed.push({ path: entry.relPath, reason: 'not_restorable' });
    });
    const disk = await mapWithConcurrency(removing, FS_CONCURRENCY, (entry) => inspectDisk(entry.resolved));
    removing.forEach((entry, index) => {
      const onDisk = disk[index];
      let reason = '';
      if (member.entries[wanted.length + index].where !== 'absent') reason = 'in_checkpoint';
      else if (onDisk.kind === 'missing') reason = 'not_found';
      else if (onDisk.kind === 'directory') reason = 'directory_unsupported';
      else if (onDisk.kind === 'other') reason = 'not_a_file';
      if (reason) plan.failed.push({ path: entry.relPath, reason });
      else plan.removals.push(entry);
    });
    return { plan };
  }

  // Trashes each removal (never a hard delete). A trash error that still left
  // the path gone counts as removed, like discardFile.
  async function trashRemovals(tx, removals, lists) {
    for (const entry of removals) {
      if (!tx.isCurrent()) return { stale: true };
      // A parent swapped for a link since planning must not redirect the trash.
      const again = await resolvePaths(tx, 'restoreCheckpointFiles', [{ path: entry.relPath }]);
      if (again.result || again.resolved[0]?.resolved !== entry.resolved) {
        lists.failed.push({ path: entry.relPath, reason: 'path_changed' });
        continue;
      }
      const before = await inspectDisk(entry.resolved);
      if (before.kind !== 'file' && before.kind !== 'symlink') {
        lists.failed.push({ path: entry.relPath, reason: before.kind === 'missing' ? 'not_found' : 'not_a_file' });
        continue;
      }
      try {
        await trashItem(entry.resolved);
        lists.removed.push(entry.relPath);
      } catch (_error) {
        if ((await inspectDisk(entry.resolved)).kind === 'missing') lists.removed.push(entry.relPath);
        else lists.failed.push({ path: entry.relPath, reason: 'trash_failed' });
      }
    }
    return {};
  }

  // The rollback skipped some untracked files (capture caps): any file this
  // restore would overwrite or trash that the rollback does not hold is
  // refused, so Redo can always bring back what the restore replaced.
  async function dropUncaptured(tx, rollbackSha, plan, entries, lists) {
    const resolvedByPath = new Map(entries.map((entry) => [entry.relPath, entry.resolved]));
    const targets = [...plan.tracked, ...plan.loose, ...plan.removals.map((entry) => entry.relPath)];
    const member = await membership(tx, rollbackSha, targets);
    if (member.failure) return member;
    const disk = await mapWithConcurrency(targets, FS_CONCURRENCY, (relPath) => inspectDisk(resolvedByPath.get(relPath)));
    const refused = new Set(targets.filter((_relPath, index) => member.entries[index].where === 'absent' && disk[index].kind !== 'missing'));
    if (!refused.size) return {};
    plan.tracked = plan.tracked.filter((relPath) => !refused.has(relPath));
    plan.loose = plan.loose.filter((relPath) => !refused.has(relPath));
    plan.removals = plan.removals.filter((entry) => !refused.has(entry.relPath));
    for (const relPath of refused) lists.failed.push({ path: relPath, reason: 'rollback_incomplete' });
    return {};
  }

  async function restoreCheckpointFiles({ ref = '', paths = [], removePaths = [], signal = null } = {}) {
    const normalizedRef = String(ref || '').trim();
    const restoreItems = (Array.isArray(paths) ? paths : []).map((path) => ({ path }));
    const removeItems = (Array.isArray(removePaths) ? removePaths : []).map((path) => ({ path }));
    return runTransaction('restoreCheckpointFiles', async (tx) => {
      const op = 'restoreCheckpointFiles';
      assertRef(normalizedRef);
      const lists = { restored: [], removed: [], failed: [] };
      const targetSha = await resolveCommit(tx, normalizedRef);
      if (!targetSha) return softResult(op, { found: false, reason: 'checkpoint_not_found', rollbackRef: null, ...lists });
      const wanted = await resolvePaths(tx, op, restoreItems);
      if (wanted.result) return wanted.result;
      const removing = await resolvePaths(tx, op, removeItems);
      if (removing.result) return removing.result;
      const requestOrder = [...wanted.resolved, ...removing.resolved].map((entry) => entry.relPath);
      if (new Set(requestOrder).size !== requestOrder.length || requestOrder.length > MAX_FILES) {
        return refusal(op, 'paths_invalid', WORKSPACE_GIT_ERROR_CODES.PATH_INVALID);
      }
      if (removing.resolved.length && typeof trashItem !== 'function') {
        return { ok: false, available: true, isRepo: true, op, reason: 'trash_unavailable', rollbackRef: null, ...lists };
      }
      const planned = await planFileRestore(tx, targetSha, wanted.resolved, removing.resolved);
      if (planned.failure) return execFailure(op, planned.failure);
      const { plan } = planned;
      lists.failed.push(...plan.failed);
      if (!plan.tracked.length && !plan.loose.length && !plan.removals.length) {
        return softResult(op, { ref: normalizedRef, sha: targetSha, rollbackRef: null, ...lists });
      }
      // Pin the rollback (the Redo target) exactly as restoreCheckpoint does;
      // if it cannot be pinned, nothing is restored.
      const rollback = await createSnapshotRef(tx, rollbackSessionFor(normalizedRef), op, { allowClean: true });
      if (rollback.result) {
        return { ...rollback.result, ok: false, op, reason: rollback.result.reason || 'rollback_failed', rollbackRef: null, ...lists };
      }
      if (rollback.untracked && rollback.untracked.skipped > 0) {
        const kept = await dropUncaptured(tx, rollback.sha, plan, [...wanted.resolved, ...removing.resolved], lists);
        if (kept.failure) return { ...execFailure(op, kept.failure), rollbackRef: rollback.ref, ...lists };
      }
      const byRequest = (left, right) => requestOrder.indexOf(left) - requestOrder.indexOf(right);
      // From here on EVERY return carries rollbackRef.
      const withRollback = (result) => ({
        ...result, rollbackRef: rollback.ref, restored: [...lists.restored].sort(byRequest),
        removed: [...lists.removed].sort(byRequest), failed: lists.failed,
      });
      const stale = () => withRollback({ ok: false, available: true, isRepo: true, op, reason: 'root_changed' });
      if (!tx.isCurrent()) return stale();
      if (plan.tracked.length) {
        const command = buildPathspecCommand(['restore', `--source=${targetSha}`, '--worktree'], plan.tracked);
        const restored = await mutate(tx, command.args, { input: command.input });
        if (restored.success) {
          lists.restored.push(...plan.tracked);
        } else {
          // Git stops at the first file it cannot write, after rewriting
          // others: restore one at a time so each file reports its own result.
          for (const relPath of plan.tracked) {
            if (!tx.isCurrent()) return stale();
            const single = buildPathspecCommand(['restore', `--source=${targetSha}`, '--worktree'], [relPath]);
            const one = await mutate(tx, single.args, { input: single.input });
            if (one.success) lists.restored.push(relPath);
            else lists.failed.push({ path: relPath, reason: 'restore_failed' });
          }
        }
      }
      if (plan.loose.length) {
        if (!tx.isCurrent()) return stale();
        const applied = await untracked.applyRestore(tx, { ...plan.untrackedPlan, paths: plan.loose });
        if (applied.stale) return stale();
        if (applied.failure) return withRollback(execFailure(op, applied.failure));
        lists.restored.push(...applied.restoredPaths);
        lists.failed.push(...applied.conflictedPaths.map((path) => ({ path, reason: 'path_conflict' })));
      }
      const trashed = await trashRemovals(tx, plan.removals, lists);
      if (trashed.stale) return stale();
      return withRollback(softResult(op, { ref: normalizedRef, sha: targetSha }));
    }, { signal });
  }

  return { preflightCheckpointFiles, restoreCheckpointFiles };
}

module.exports = {
  AFTER_HASH_MAX_BYTES,
  HASH_KINDS,
  MAX_FILES,
  createCheckpointFileOps,
};
