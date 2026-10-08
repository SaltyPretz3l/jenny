'use strict';

/* services/workspace-ide-recovery-io.js - byte-exact recovery IO for
 * WorkspaceIdeService (row 34 S5 step 4). Split out of
 * workspace-ide-service.js, which sits at the 1015-line ceiling.
 *
 * Main-process internal only: these helpers back the workspaceRecovery
 * safety copies and are never exposed over IPC. They use the caller's root
 * lease and the WorkspaceRootOperationManager's leaf resolution, so the
 * lexical path guard, realpath containment and symlink/junction-escape checks
 * are the SAME ones every Workspace IDE write uses. A link leaf is never
 * followed. Writes go through `replaceLeafAtomically`, the temp+rename writer
 * shared with WorkspaceIdeService.writeFile.
 *
 * Nothing here logs bytes or absolute paths; logs carry the usual file-name +
 * path-hash hint only.
 */

const crypto = require('crypto');

const { WORKSPACE_FS_ERROR_CODES, workspaceFsError } = require('./workspace-ide-errors');
const { buildPathLogHint } = require('./workspace-ide-path-guard');
const { readCappedFile } = require('./workspace-ide-file-reads');
const { SAFETY_COPY_LIMITS, stateOfCapture } = require('./workspace-recovery-safety-copies');

const DEFAULT_MAX_BYTES = SAFETY_COPY_LIMITS.maxFileBytes;

// Atomic temp+rename replace of a resolved leaf inside its (re-validated)
// parent. `beforeReplace(current)` sees the leaf's revalidation result right
// before the rename and throws to abort. Returns the final stats.
async function replaceLeafAtomically({
  fs, path, rootOperations, operation, root, target, data, encoding = null, beforeReplace = () => {},
}) {
  const tempPath = path.join(
    target.parent.realPath,
    `.${path.basename(target.operationPath)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`
  );
  let tempCreated = false;
  try {
    await fs.writeFile(tempPath, data, encoding ? { encoding, flag: 'wx' } : { flag: 'wx' });
    tempCreated = true;
    await rootOperations.revalidateParent(root, target.parent, operation);
    beforeReplace(await rootOperations.revalidateLeaf(root, target, operation));
    await fs.rename(tempPath, target.operationPath);
    tempCreated = false;
  } catch (error) {
    if (tempCreated) await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  await rootOperations.revalidateRoot(root, operation);
  await rootOperations.revalidateParent(root, target.parent, operation);
  const stats = await fs.stat(target.operationPath);
  rootOperations.assertCurrent(operation);
  return stats;
}

function statText(stats, key) {
  const value = stats?.[key];
  return typeof value === 'bigint' ? value.toString() : String(value ?? '');
}

function missingCapture(relPath) {
  return { path: relPath, kind: 'missing', size: 0, mtimeMs: 0, bytes: null, reason: '' };
}

function changedSince(before) {
  return { reason: 'changed_since', before };
}

function isChangedError(error) {
  return error?.code === WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT
    || (error?.code === WORKSPACE_FS_ERROR_CODES.ROOT_INVALID
      && ['leaf_identity_changed', 'parent_identity_changed'].includes(error?.details?.reason));
}

function writeConflict(relPath) {
  return workspaceFsError(
    WORKSPACE_FS_ERROR_CODES.WRITE_CONFLICT,
    'The file changed before it could be restored.',
    buildPathLogHint(relPath)
  );
}

function createWorkspaceIdeRecoveryIo({ fs, path, rootOperations, getTrashItem, log = () => {} }) {
  // Resolves and reads one leaf without following a link leaf. Returns the
  // resolved target (null when a parent is missing) and the capture.
  async function inspect(relPath, operation, requestedMaxBytes) {
    const root = operation.root;
    const maxBytes = Number.isSafeInteger(requestedMaxBytes) && requestedMaxBytes >= 0
      ? requestedMaxBytes : DEFAULT_MAX_BYTES;
    let target;
    try {
      target = await rootOperations.resolveLeaf(root, relPath, operation, { allowMissing: true, preserveLeaf: true });
    } catch (error) {
      if (error?.code === WORKSPACE_FS_ERROR_CODES.NOT_FOUND) return { target: null, capture: missingCapture(relPath) };
      if (error?.code === WORKSPACE_FS_ERROR_CODES.ROOT_INVALID && error?.details?.reason === 'parent_not_directory') {
        return { target: null, capture: { ...missingCapture(relPath), kind: 'other' } };
      }
      throw error;
    }
    if (!target.lexicalStats) return { target, capture: missingCapture(relPath) };
    const stats = target.stats;
    const base = { path: relPath, size: Number(stats.size) || 0, mtimeMs: Number(stats.mtimeMs) || 0, bytes: null, reason: '' };
    if (target.lexicalStats.isSymbolicLink?.()) return { target, capture: { ...base, kind: 'symlink' } };
    if (stats.isDirectory()) return { target, capture: { ...base, kind: 'directory' } };
    if (!stats.isFile()) return { target, capture: { ...base, kind: 'other' } };
    if (base.size > maxBytes) return { target, capture: { ...base, kind: 'file', reason: 'too_large' } };
    let bytes;
    try {
      bytes = await readCappedFile(fs, target.operationPath, maxBytes);
    } catch (error) {
      if (String(error?.code || '').startsWith('CMP-')) throw error;
      return { target, capture: { ...base, kind: 'file', reason: 'unreadable' } };
    }
    if (bytes.length > maxBytes) return { target, capture: { ...base, kind: 'file', reason: 'too_large' } };
    const current = await rootOperations.revalidateLeaf(root, target, operation);
    const stamp = current.currentStats;
    if (!stamp || stamp.size !== stats.size || stamp.mtimeMs !== stats.mtimeMs || bytes.length !== base.size) {
      return { target, capture: { ...base, kind: 'file', reason: 'unreadable' } };
    }
    return { target, capture: { ...base, kind: 'file', bytes } };
  }

  // Guards a replace/trash: the leaf must still be the one that was read.
  function assertUnchanged(relPath, target, capture) {
    return (current) => {
      if (!target.lexicalStats) {
        if (current.exists) throw writeConflict(relPath);
        return;
      }
      const stamp = current.currentStats;
      if (!stamp || stamp.size !== capture.size || stamp.mtimeMs !== capture.mtimeMs) throw writeConflict(relPath);
    };
  }

  async function readFileBytes(relPath, operation, { maxBytes }) {
    return (await inspect(relPath, operation, maxBytes)).capture;
  }

  // Writes `bytes` only when the current state equals `expectedState`.
  // Returns { written, before } or { written: false, reason, before }.
  async function writeFileBytes(relPath, operation, { bytes, expectedState, maxBytes }) {
    const root = operation.root;
    const { target: inspected, capture } = await inspect(relPath, operation, maxBytes);
    if (stateOfCapture(capture) !== expectedState) return { written: false, ...changedSince(capture) };
    let target = inspected;
    if (!target) {
      target = await rootOperations.resolveLeaf(root, relPath, operation, {
        createParents: true, allowMissing: true, preserveLeaf: true,
      });
      if (target.lexicalStats) return { written: false, ...changedSince(capture) };
    }
    await rootOperations.runHook('beforeLeafMutation', { kind: 'recoveryWrite', operation, root, target }, operation);
    let stats;
    try {
      stats = await replaceLeafAtomically({
        fs, path, rootOperations, operation, root, target, data: bytes,
        beforeReplace: assertUnchanged(relPath, target, capture),
      });
    } catch (error) {
      if (isChangedError(error)) return { written: false, ...changedSince(capture) };
      throw error;
    }
    log('INFO', 'workspace_fs.recovery_write', { ...buildPathLogHint(relPath), size: stats.size });
    return { written: true, before: capture, size: stats.size, mtimeMs: stats.mtimeMs };
  }

  // Moves the file to the OS recycle bin only when its current state equals
  // `expectedState`. Never deletes outright.
  async function trashFile(relPath, operation, { expectedState, maxBytes }) {
    const root = operation.root;
    const trashItem = getTrashItem();
    const { target, capture } = await inspect(relPath, operation, maxBytes);
    if (!trashItem) return { trashed: false, reason: 'trash_unavailable', before: capture };
    if (!target?.lexicalStats || stateOfCapture(capture) !== expectedState) {
      return { trashed: false, ...changedSince(capture) };
    }
    await rootOperations.runHook('beforeLeafMutation', { kind: 'recoveryTrash', operation, root, target }, operation);
    try {
      assertUnchanged(relPath, target, capture)(await rootOperations.revalidateLeaf(root, target, operation));
    } catch (error) {
      if (isChangedError(error)) return { trashed: false, ...changedSince(capture) };
      throw error;
    }
    try {
      await trashItem(target.operationPath);
    } catch (_error) {
      return { trashed: false, reason: 'trash_failed', before: capture };
    }
    rootOperations.assertCurrent(operation);
    log('INFO', 'workspace_fs.recovery_trash', buildPathLogHint(relPath));
    return { trashed: true, before: capture };
  }

  // The identity a safety copy is bound to: the coordinator's root id plus
  // the root directory's own file identity (a folder swapped in behind the
  // same path does not match).
  function bindingFor(operation) {
    return {
      rootId: String(operation?.context?.rootId || ''),
      workspaceId: `${statText(operation?.root?.stats, 'dev')}:${statText(operation?.root?.stats, 'ino')}`,
    };
  }

  return { bindingFor, readFileBytes, trashFile, writeFileBytes };
}

module.exports = {
  createWorkspaceIdeRecoveryIo,
  replaceLeafAtomically,
};
