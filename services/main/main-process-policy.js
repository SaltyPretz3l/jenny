'use strict';

const MANAGED_CONFIG_REFRESH_REASONS = new Set([
  'workspace_root_updated',
  'workspace_root_cleared',
  'assistant_identity_updated',
  'assistant_identity_reset',
  'skills_settings_updated',
  'tools_worktree_enabled_updated',
  'feature_settings_updated',
  // Model/context tuning uses ModelTuningService's awaited transaction so the
  // renderer gets a truthful applied/rolled-back acknowledgement. Do not also
  // trigger this fire-and-forget policy refresh for those writes.
]);

function shouldRefreshManagedConfigForShellConfigReason(reason) {
  return MANAGED_CONFIG_REFRESH_REASONS.has(String(reason || '').trim());
}

function shouldAutoStartMainProcess({
  hasElectronRuntime = Boolean(process.versions && process.versions.electron),
  isMainModule = require.main === module,
  env = process.env,
} = {}) {
  const skipAutoStart = /^(1|true|yes)$/i.test(String(env.JENNY_SKIP_MAIN_AUTOSTART || '').trim());
  return !skipAutoStart && (isMainModule || hasElectronRuntime);
}

module.exports = {
  MANAGED_CONFIG_REFRESH_REASONS,
  shouldAutoStartMainProcess,
  shouldRefreshManagedConfigForShellConfigReason,
};
