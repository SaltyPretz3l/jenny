'use strict';

// Builds the managed NInfer runtime's main-process services (row 54) for
// backend-service-wiring.js: the eligibility probe, the runtime installer and
// the artifact downloader, bundled as `backendService.ninferRuntime` so the
// manager (services/main/ninfer-manager.js), the IPC surface and the load path
// read one object. Flag-off (JENNY_ENABLE_NINFER=0) builds nothing that could
// probe nvidia-smi or touch disk; the stub refuses every launch.

const { EventEmitter } = require('events');
const { createNinferEligibilityProbe } = require('../ninfer-eligibility');

function createNinferRuntime({
  userDataPath,
  flags = {},
  platform = process.platform,
  log = () => {},
  InstallService = null,
  ArtifactService = null,
} = {}) {
  const runtime = new EventEmitter();
  runtime.enabled = flags?.ninfer !== false;
  if (!runtime.enabled) {
    Object.assign(runtime, {
      install: null,
      artifacts: null,
      eligibility: () => Promise.resolve({ eligible: false, reason: 'ninfer_flag_off', device: null, probed: false }),
      getState: () => ({ enabled: false }),
      dispose: () => {},
    });
    return runtime;
  }
  const { NinferRuntimeInstallService } = InstallService ? { NinferRuntimeInstallService: InstallService } : require('../ninfer-runtime-install');
  const { NinferArtifactDownloadService } = ArtifactService ? { NinferArtifactDownloadService: ArtifactService } : require('../ninfer-artifact-download');
  const logger = (level, event, fields) => log(String(level || 'info').toUpperCase(), event, fields);
  const install = new NinferRuntimeInstallService({ userDataPath, logger });
  const artifacts = new NinferArtifactDownloadService({ userDataPath, logger });
  const getState = () => ({ enabled: true, install: install.getState(), artifacts: artifacts.getState() });
  const changed = () => runtime.emit('changed', getState());
  install.on('changed', changed);
  artifacts.on('changed', changed);
  Object.assign(runtime, {
    install,
    artifacts,
    // Memoized: one nvidia-smi call per process (ninfer-eligibility.js).
    eligibility: createNinferEligibilityProbe({ flags, platform }),
    getState,
    dispose: () => {
      install.dispose?.();
      artifacts.dispose?.();
      runtime.removeAllListeners();
    },
  });
  try {
    install.start();
  } catch (error) {
    log('WARN', 'ninfer.runtime.install_state_unavailable', { message: String(error?.message || error).slice(0, 200) });
  }
  return runtime;
}

module.exports = { createNinferRuntime };
