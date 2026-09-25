'use strict';

const crypto = require('node:crypto');

const {
  WORKSPACE_FS_ERROR_CODES: VERSIONED_WORKSPACE_FILE_ERROR_CODES,
  workspaceFsError,
} = require('./workspace-ide-errors');
const {
  sameFileIdentity,
  sameReadSnapshot,
} = require('./versioned-workspace-file-bytes');
const {
  assertAdmittedResourceTarget,
  markResourceCleanupUncertain,
} = require('./versioned-workspace-file-resources');

function buildPathHint(relPath) {
  const normalized = String(relPath || '');
  return {
    file_name: normalized.split('/').pop() || '',
    path_hash: crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12),
  };
}

async function replaceFileBytes(service, {
  root,
  target,
  relPath,
  current,
  bytes,
  lease,
  buildLanded,
}) {
  const parent = await service._openParent(root, target, lease);
  let temp = null;
  let replaced = false;
  let writeTicket = null;
  let writeObserved = false;
  try {
    const mode = current.stats.mode & 0o7777;
    temp = await service._createTemp(root, parent, target, mode, lease);
    await service._writeAndCloseTemp(temp, bytes, mode, target, lease);
    await service._runHook('beforeReplace', {
      operationId: lease.operationId,
      path: target.displayPath,
      mode,
    }, lease);

    const beforeReplaceTarget = await service._resolveTarget(root, relPath, lease);
    if (beforeReplaceTarget.pathKey !== target.pathKey) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT,
        'The file path identity changed before replacement.',
        buildPathHint(relPath)
      );
    }
    const beforeReplace = await service._openStableBytes(
      root, beforeReplaceTarget, lease, 'pre-replace', { statsOnly: true }
    );
    if (!sameReadSnapshot(current.stats, beforeReplace.stats)) {
      throw workspaceFsError(
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.WRITE_CONFLICT,
        'File changed on disk before replacement.',
        buildPathHint(relPath)
      );
    }
    await service._revalidateParent(root, parent, lease);
    await service._revalidateTemp(root, temp, target, lease);
    writeTicket = service._observeWrite('begin', {
      path: target.displayPath,
      pathKey: target.pathKey,
      rootId: lease.context.rootId,
      generation: lease.context.generation,
    });
    try {
      assertAdmittedResourceTarget(target.realPath);
      await service._step(lease, () => service._fs.rename(temp.path, target.realPath));
    } catch (error) {
      if (service._structured(error)) throw error;
      throw service._ioError(
        'atomic_replace',
        relPath,
        error,
        VERSIONED_WORKSPACE_FILE_ERROR_CODES.ATOMIC_WRITE_FAILED
      );
    }
    replaced = true;
    await service._syncParent(parent, target, lease);

    const landedTarget = await service._resolveTarget(root, relPath, lease);
    const landedSnapshot = await service._openStableBytes(
      root, landedTarget, lease, 'write-result', { statsOnly: true }
    );
    if (!sameFileIdentity(temp.stats, landedSnapshot.stats)
      || Number(landedSnapshot.stats.size) !== bytes.length) {
      throw service._ioError('verify_replace', relPath, { code: 'IDENTITY_CHANGED' });
    }
    const landed = buildLanded(landedSnapshot, bytes);
    service._assertCurrent(lease);
    if (writeTicket) writeObserved = service._observeWrite('commit', writeTicket, landed.stats) === true;
    service._log('INFO', 'workspace_file.write', {
      ...buildPathHint(relPath),
      size: landed.bytes.length,
      root_id: lease.context.rootId,
      generation: lease.context.generation,
    });
    service._assertCurrent(lease);
    return landed;
  } finally {
    if (writeTicket && !writeObserved) service._observeWrite('abort', writeTicket);
    if (temp?.handle) await temp.handle.close().catch(() => markResourceCleanupUncertain());
    if (temp && !replaced) await service._cleanupTemp(temp.path, relPath);
    try {
      await parent.handle.close();
    } catch (error) {
      markResourceCleanupUncertain();
      service._log('WARN', 'workspace_file.parent_close_failed', {
        ...buildPathHint(relPath),
        os_code: String(error?.code || ''),
      });
    }
  }
}

module.exports = {
  buildPathHint,
  replaceFileBytes,
};
