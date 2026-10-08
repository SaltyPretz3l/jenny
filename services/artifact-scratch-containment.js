'use strict';

const { ARTIFACT_ERROR_CODES, artifactError } = require('./artifact-workspace-errors');

async function resolveRealPath(fsImpl, targetPath) {
  return fsImpl.realpath(targetPath);
}

async function assertRealPathInside(fsImpl, pathImpl, targetPath, parentPath) {
  const realTarget = await resolveRealPath(fsImpl, targetPath);
  const realParent = await resolveRealPath(fsImpl, parentPath);
  const relative = pathImpl.relative(realParent, realTarget);
  if (relative.startsWith('..') || pathImpl.isAbsolute(relative)) {
    throw artifactError(
      ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
      'Resolved path escapes the expected parent directory.'
    );
  }
  return realTarget;
}

function assertSessionScratchDirUnredirected({
  pathImpl,
  realWorkspaceRoot,
  realScratchDir,
  sessionId,
  sessionArtifactRoot,
  platform = process.platform,
}) {
  let actual = pathImpl.normalize(pathImpl.relative(realWorkspaceRoot, realScratchDir));
  let expected = pathImpl.normalize(pathImpl.join(sessionArtifactRoot, sessionId));
  // Windows paths fold case (drive letters, 8.3 names); macOS volumes may be
  // case-sensitive, where `sess_a` and `sess_A` are distinct directories, so
  // only win32 compares case-insensitively.
  if (platform === 'win32') {
    actual = actual.toLowerCase();
    expected = expected.toLowerCase();
  }
  if (actual !== expected) {
    throw artifactError(
      ARTIFACT_ERROR_CODES.REAL_PATH_ESCAPES,
      'Session scratch directory is redirected outside its own session.'
    );
  }
}

module.exports = { resolveRealPath, assertRealPathInside, assertSessionScratchDirUnredirected };
