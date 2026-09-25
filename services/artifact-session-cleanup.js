'use strict';

async function deleteSessionArtifactsForScope(service, sessionId, scope, sessionArtifactRoot) {
  const workspaceRoot = scope.rootPath;
  if (!workspaceRoot) return { deleted: false };
  const artifactsRoot = service._path.join(
    service._path.resolve(workspaceRoot), sessionArtifactRoot
  );
  const scratchDir = service._path.join(artifactsRoot, sessionId);
  service._assertSessionScopeCurrent(scope);
  const stats = await service._fs.stat(scratchDir).catch(() => null);
  service._assertSessionScopeCurrent(scope);
  if (!stats?.isDirectory()) return { deleted: false };
  // Both descendants must remain in the captured workspace. Comparing only
  // scratchDir to artifactsRoot would trust a redirected .jenny ancestor.
  await service._assertRealPathInside(artifactsRoot, workspaceRoot);
  service._assertSessionScopeCurrent(scope);
  await service._assertRealPathInside(scratchDir, artifactsRoot);
  await service._assertRealPathInside(scratchDir, workspaceRoot);
  service._assertSessionScopeCurrent(scope);
  await service._fs.rm(scratchDir, { recursive: true, force: true });
  service._logger('INFO', 'artifacts.session_deleted', { sessionId });
  return { deleted: true };
}

function createMissingSessionCleanup(service, sessionId, authority, sessionArtifactRoot) {
  const capturedAuthority = Object.freeze({ ...authority });
  return async () => {
    const scope = service._sessionAuthority.captureMissing(sessionId, capturedAuthority);
    return deleteSessionArtifactsForScope(service, sessionId, scope, sessionArtifactRoot);
  };
}

function prepareSessionArtifactDeletion(service, sessionId, authority, sessionArtifactRoot) {
  const scope = service._captureSessionScope(sessionId, authority);
  return Object.freeze({
    deleteSessionArtifacts: createMissingSessionCleanup(
      service, sessionId, scope.authority, sessionArtifactRoot
    ),
  });
}

module.exports = {
  createMissingSessionCleanup,
  deleteSessionArtifactsForScope,
  prepareSessionArtifactDeletion,
};
