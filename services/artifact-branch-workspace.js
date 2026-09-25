'use strict';

const { normalizeGeneratedArtifactMetadata } = require('./artifact-metadata-utils');
const { sameProjectAuthority } = require('./artifact-session-authority');
const { createMissingSessionCleanup } = require('./artifact-session-cleanup');

function capError(reason, bytes) {
  const error = new Error(`branch clone aborted: ${reason}`);
  error.cloneCapReason = reason;
  error.cloneBytes = bytes;
  return error;
}

async function collectScratchCopyPlan(service, rootDir, { byteCap, entryCap }) {
  const files = [];
  let bytes = 0;
  let entriesSeen = 0;
  const walk = async (relativeDir) => {
    const absoluteDir = relativeDir ? service._path.join(rootDir, relativeDir) : rootDir;
    const entries = await service._fs.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      entriesSeen += 1;
      if (entriesSeen > entryCap) throw capError('entry_cap_exceeded', bytes);
      const relativePath = relativeDir
        ? service._path.join(relativeDir, entry.name)
        : entry.name;
      if (entry.isDirectory()) {
        await walk(relativePath);
      } else if (entry.isFile()) {
        const stats = await service._fs.stat(service._path.join(rootDir, relativePath));
        files.push(relativePath);
        bytes += Number(stats.size || 0);
        if (bytes > byteCap) throw capError('size_cap_exceeded', bytes);
      }
    }
  };
  await walk('');
  return { files, bytes };
}

function buildBranchArtifactEntryRewriter(service, sourceId, targetId, targetDir, contract) {
  const artifactRootPosix = contract.sessionArtifactRoot.replace(/\\/g, '/');
  const sourceDisplayPrefix = `${artifactRootPosix}/${sourceId}/`;
  const targetDisplayPrefix = `${artifactRootPosix}/${targetId}/`;
  const sourceIdPrefix = `artifact_file_${sourceId}_`;
  const targetIdPrefix = `artifact_file_${targetId}_`;
  return (entry) => {
    const normalized = normalizeGeneratedArtifactMetadata(entry);
    if (!normalized) return null;
    const displayPath = normalized.display_path.replace(/\\/g, '/');
    if (!displayPath.startsWith(sourceDisplayPrefix)) return null;
    const scratchRelativePath = displayPath.slice(sourceDisplayPrefix.length);
    if (!scratchRelativePath) return null;
    const artifactId = normalized.artifact_id.startsWith(sourceIdPrefix)
      ? `${targetIdPrefix}${normalized.artifact_id.slice(sourceIdPrefix.length)}`
      : normalized.artifact_id;
    return {
      ...normalized,
      artifact_id: artifactId,
      display_path: `${targetDisplayPrefix}${scratchRelativePath}`,
      absolute_path: contract.isRedactedArtifactPath(normalized.absolute_path)
        ? normalized.absolute_path
        : service._path.join(targetDir, scratchRelativePath),
    };
  };
}

async function cloneSessionArtifactsForBranch(
  service,
  sourceSessionId,
  targetSessionId,
  { maxTotalBytes, maxEntries } = {},
  admittedAuthority,
  contract
) {
  const sourceId = contract.sanitizeSessionId(sourceSessionId);
  const targetId = contract.sanitizeSessionId(targetSessionId);
  let sourceScope;
  let targetScope = null;
  let targetInitiallyAbsent = false;
  try {
    sourceScope = service._captureSessionScope(sourceId, admittedAuthority);
    if (sourceScope.kind === 'project') {
      try {
        targetScope = service._captureSessionScope(targetId, null);
      } catch (error) {
        if (error?.reason !== 'session_not_found') throw error;
        targetInitiallyAbsent = true;
      }
      if (targetScope && !sameProjectAuthority(sourceScope.authority, targetScope.authority)) {
        return { cloned: false, reason: 'project_authority_mismatch' };
      }
    }
  } catch (_error) {
    return { cloned: false, reason: 'workspace_root_unavailable' };
  }
  const byteCap = Number.isFinite(maxTotalBytes) && maxTotalBytes > 0
    ? maxTotalBytes : contract.maxTotalBytes;
  const entryCap = Number.isFinite(maxEntries) && maxEntries > 0
    ? maxEntries : contract.maxEntries;
  let workspaceRoot;
  try {
    workspaceRoot = await service._requireWorkspaceRootForScope(sourceScope);
  } catch (_error) {
    return { cloned: false, reason: 'workspace_root_unavailable' };
  }
  const artifactsRoot = service._path.join(
    service._path.resolve(workspaceRoot), contract.sessionArtifactRoot
  );
  const sourceDir = service._buildSessionScratchDir(workspaceRoot, sourceId);
  const sourceStats = await service._fs.stat(sourceDir).catch(() => null);
  if (!sourceStats?.isDirectory()) return { cloned: false, reason: 'source_scratch_missing' };
  const targetDir = service._buildSessionScratchDir(workspaceRoot, targetId);
  const assertCurrent = () => {
    service._assertSessionScopeCurrent(sourceScope);
    if (targetScope) {
      service._assertSessionScopeCurrent(targetScope);
      return;
    }
    if (!targetInitiallyAbsent || sourceScope.kind !== 'project') return;
    let capturedTarget;
    try {
      capturedTarget = service._captureSessionScope(targetId, null);
    } catch (error) {
      if (error?.reason === 'session_not_found') return;
      throw error;
    }
    if (!sameProjectAuthority(sourceScope.authority, capturedTarget.authority)) {
      const error = new Error('Branch target was claimed by another project.');
      error.branchCloneReason = 'project_authority_mismatch';
      throw error;
    }
    targetScope = capturedTarget;
  };
  let createdTargetDir = false;
  try {
    assertCurrent();
    const realSourceDir = await service._assertRealPathInside(sourceDir, artifactsRoot);
    assertCurrent();
    const plan = await collectScratchCopyPlan(service, realSourceDir, { byteCap, entryCap });
    assertCurrent();
    await service._fs.mkdir(targetDir);
    createdTargetDir = true;
    assertCurrent();
    const realTargetDir = await service._assertRealPathInside(targetDir, artifactsRoot);
    for (const relativePath of plan.files) {
      const destination = service._path.join(realTargetDir, relativePath);
      assertCurrent();
      await service._fs.mkdir(service._path.dirname(destination), { recursive: true });
      assertCurrent();
      await service._fs.copyFile(service._path.join(realSourceDir, relativePath), destination);
      assertCurrent();
    }
    service._logger('INFO', 'artifacts.branch_cloned', {
      sourceSessionId: sourceId, targetSessionId: targetId,
      files: plan.files.length, bytes: plan.bytes,
    });
    return {
      cloned: true,
      files: plan.files.length,
      bytes: plan.bytes,
      rewriteEntry: buildBranchArtifactEntryRewriter(service, sourceId, targetId, realTargetDir, contract),
      cleanupArtifacts: sourceScope.kind === 'project'
        ? createMissingSessionCleanup(
          service, targetId, sourceScope.authority, contract.sessionArtifactRoot
        )
        : null,
    };
  } catch (error) {
    if (createdTargetDir) {
      if (sourceScope.kind === 'project') {
        await createMissingSessionCleanup(
          service, targetId, sourceScope.authority, contract.sessionArtifactRoot
        )().catch(() => {});
      } else {
        await service._fs.rm(targetDir, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (error?.cloneCapReason) {
      service._logger('WARN', 'artifacts.branch_clone_skipped', {
        sourceSessionId: sourceId, targetSessionId: targetId,
        reason: error.cloneCapReason, bytes: error.cloneBytes, byteCap,
      });
      return { cloned: false, reason: error.cloneCapReason, bytes: error.cloneBytes };
    }
    if (error?.branchCloneReason) {
      return { cloned: false, reason: error.branchCloneReason };
    }
    service._logger('WARN', 'artifacts.branch_clone_failed', {
      sourceSessionId: sourceId, targetSessionId: targetId,
      error: String(error?.code || error?.name || 'error'),
    });
    return { cloned: false, reason: 'copy_failed' };
  }
}

module.exports = { cloneSessionArtifactsForBranch };
