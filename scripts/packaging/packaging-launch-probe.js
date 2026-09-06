const { resolvePackagedSidecarLaunch } = require('../../services/backend/packaged-sidecar-launch');

function resolvePackagedLaunchProbe(resourcesPath, _cwd) {
  const spec = resolvePackagedSidecarLaunch({
    resourcesPath,
    probeVersion: false,
  });
  if (!spec.ok) {
    throw new Error(spec.failureReason || spec.packagedLaunchDetail || 'Packaged sidecar launch probe failed');
  }
  return {
    command: spec.launchCommand,
    args: spec.launchArgs,
    source: spec.launchSource,
  };
}

module.exports = {
  resolvePackagedLaunchProbe,
};
