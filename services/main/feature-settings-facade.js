// Every service is reached through a getter, never captured: shellConfigService
// and backendService are assigned during startup, long after this facade is
// constructed, so a captured value would be a permanent undefined.

const {
  applyFeatureSettingsPatch: applyFeatureSettingsPatchWithDeps,
  buildEffectiveFeatureFlags: buildEffectiveFeatureFlagsWithDeps,
  buildFeatureStatePayload: buildFeatureStatePayloadWithDeps,
} = require('../feature-settings-service');
const { createTeamDataProbe } = require('./team-data-probe');

function userDataPath() {
  return require('electron').app.getPath('userData');
}

function createFeatureSettingsFacade({
  env = process.env,
  platform = process.platform,
  getShellConfigService = () => null,
  getBackendService = () => null,
  sendToWindow = () => {},
  // Row 123, E50: whether team data is on disk, for the payload's `teamData` (asked only with the team flag on).
  hasTeamData = createTeamDataProbe(userDataPath),
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
      hasTeamData,
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
      hasTeamData,
    });
  }

  return {
    applyFeatureSettingsPatch,
    buildEffectiveFeatureFlags,
    buildFeatureStatePayload,
  };
}

module.exports = { createFeatureSettingsFacade };
