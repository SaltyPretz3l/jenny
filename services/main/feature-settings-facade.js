// Every service is reached through a getter, never captured: shellConfigService
// and backendService are assigned during startup, long after this facade is
// constructed, so a captured value would be a permanent undefined.

const {
  applyFeatureSettingsPatch: applyFeatureSettingsPatchWithDeps,
  buildEffectiveFeatureFlags: buildEffectiveFeatureFlagsWithDeps,
  buildFeatureStatePayload: buildFeatureStatePayloadWithDeps,
} = require('../feature-settings-service');

function createFeatureSettingsFacade({
  env = process.env,
  platform = process.platform,
  getShellConfigService = () => null,
  getBackendService = () => null,
  sendToWindow = () => {},
} = {}) {
  function buildEffectiveFeatureFlags() {
    return buildEffectiveFeatureFlagsWithDeps({
      shellConfigService: getShellConfigService(),
      env,
    });
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
  };
}

module.exports = { createFeatureSettingsFacade };
