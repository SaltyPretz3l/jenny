// Every service is reached through a getter, never captured: shellConfigService
// and backendService are assigned during startup, long after this facade is
// constructed, so a captured value would be a permanent undefined.

const {
  applyFeatureSettingsPatch: applyFeatureSettingsPatchWithDeps,
  buildEffectiveFeatureFlags: buildEffectiveFeatureFlagsWithDeps,
  buildFeatureStatePayload: buildFeatureStatePayloadWithDeps,
} = require('../feature-settings-service');
const { handleCometOverlayToggle } = require('./comet-overlay-controller');

function createFeatureSettingsFacade({
  env = process.env,
  platform = process.platform,
  getShellConfigService = () => null,
  getBackendService = () => null,
  getOverlayRef = () => null,
  setOverlayRef = () => {},
  sendToWindow = () => {},
} = {}) {
  function buildEffectiveFeatureFlags() {
    return buildEffectiveFeatureFlagsWithDeps({
      shellConfigService: getShellConfigService(),
      env,
    });
  }

  // The overrides exist so a caller can evaluate the flag against a snapshot
  // other than the live one; the defaults read live state on every call so a
  // mid-session settings change wins over a stale startup value.
  function isCometOverlayEnabled({
    configService = getShellConfigService(),
    env: envOverride = env,
  } = {}) {
    return buildEffectiveFeatureFlagsWithDeps({
      shellConfigService: configService,
      env: envOverride,
    }).comet_overlay === true;
  }

  function closeCometOverlayIfDisabled() {
    const currentOverlayRef = getOverlayRef();
    if (!currentOverlayRef || isCometOverlayEnabled()) {
      return;
    }
    setOverlayRef(handleCometOverlayToggle({
      data: { enabled: false },
      currentOverlayRef,
    }));
  }

  function buildFeatureStatePayload() {
    return buildFeatureStatePayloadWithDeps({
      shellConfigService: getShellConfigService(),
      backendService: getBackendService(),
      env,
      platform,
    });
  }

  async function applyFeatureSettingsPatch(patch = {}) {
    return applyFeatureSettingsPatchWithDeps({
      patch,
      shellConfigService: getShellConfigService(),
      backendService: getBackendService(),
      sendToWindow,
      env,
      platform,
    });
  }

  return {
    applyFeatureSettingsPatch,
    buildEffectiveFeatureFlags,
    buildFeatureStatePayload,
    closeCometOverlayIfDisabled,
    isCometOverlayEnabled,
  };
}

module.exports = { createFeatureSettingsFacade };
