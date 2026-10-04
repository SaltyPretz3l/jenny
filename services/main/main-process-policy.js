'use strict';

const MANAGED_CONFIG_REFRESH_REASONS = new Set([
  'workspace_root_updated',
  'workspace_root_cleared',
  'assistant_identity_updated',
  'assistant_identity_reset',
  'skills_settings_updated',
  'tools_worktree_enabled_updated',
  'feature_settings_updated',
  'time_format_updated',
  // The sidecar parses ui_language from the managed config. Safety mode and the
  // auto-approve streak cap are NOT here: they ride every chat.send (owner D3).
  'ui_language_updated',
  // Model/context tuning uses ModelTuningService's awaited transaction so the
  // renderer gets a truthful applied/rolled-back acknowledgement. Do not also
  // trigger this fire-and-forget policy refresh for those writes.
]);

// A combined commit (updateChatUiSettings) names every sub-change in `reasons`.
function changeReasons(reason, reasons) {
  return [reason, ...(Array.isArray(reasons) ? reasons : [])]
    .map((entry) => String(entry || '').trim())
    .filter(Boolean);
}

function shouldRefreshManagedConfigForShellConfigReason(reason, reasons) {
  return changeReasons(reason, reasons).some((entry) => MANAGED_CONFIG_REFRESH_REASONS.has(entry));
}

// Shell-config write reasons for the sections buildFeatureStatePayload
// (services/feature-settings-service.js) reads: tools, featureOverrides,
// webSearch, memory, and the workspace root and its status. Whole-state writes
// (replaceState) are included. Dynamic `feature_override_<key>_updated` reasons
// and any reason not classified below fail open.
const FEATURE_STATE_CHANGE_REASONS = new Set([
  'feature_settings_updated',
  'feature_settings_reverted',
  'tools_web_enabled_updated',
  'tools_image_read_enabled_updated',
  'tools_python_runtime_enabled_updated',
  'tools_todo_enabled_updated',
  'tools_mermaid_enabled_updated',
  'tools_worktree_enabled_updated',
  'web_search_settings_updated',
  'memory_capture_suggestions_updated',
  'workspace_root_updated',
  'workspace_root_cleared',
  'workspace_root_seeded_from_env',
  'workspace_root_status_updated',
  'host_workspace_root_configured',
  'state_replaced',
]);

// Known shell-config write reasons whose sections the feature payload never reads.
const NON_FEATURE_STATE_REASONS = new Set([
  'time_format_updated',
  'default_run_mode_updated',
  'ui_language_updated',
  'safety_mode_updated',
  'unattended_guard_minutes_updated',
  'auto_approve_streak_cap_updated',
  'chat_ui_settings_updated',
  'window_ui_settings_updated',
  'workspace_state_updated',
  'workspace_state_reconciled',
  'workspace_ide_state_updated',
  'workspace_ide_preferences_updated',
  'home_config_updated',
  'setup_state_updated',
  'setup_completed',
  'setup_reset',
  'setup_endpoint_saved',
  'assistant_identity_updated',
  'onboarding_reset',
  'companion_mode_updated',
  'compaction_tuning_updated',
  'context_length_tuning_updated',
  'model_tuning_updated',
  'model_tuning_legacy_claimed',
  'engine_tuning_updated',
  'engine_tuning_reset',
  'skills_settings_updated',
  'follow_up_updated',
  'follow_up_deleted',
  'follow_up_deferred',
  'follow_up_archived',
  'proactive_reminder_upserted',
  'proactive_reminder_deleted',
  'offline_intelligence_updated',
  'startup_model_load_updated',
  'local_engine_acceleration_updated',
  'managed_llama_server_updated',
  'preferred_engine_type_updated',
  'command_sandbox_updated',
  'session_runtime_updated',
]);

function shouldBroadcastFeatureState(reason, reasons) {
  const entries = changeReasons(reason, reasons);
  return !entries.length || entries.some((entry) => FEATURE_STATE_CHANGE_REASONS.has(entry)
    || !NON_FEATURE_STATE_REASONS.has(entry));
}

function shouldAutoStartMainProcess({
  hasElectronRuntime = Boolean(process.versions && process.versions.electron),
  isMainModule = require.main === module,
  env = process.env,
} = {}) {
  const skipAutoStart = /^(1|true|yes)$/i.test(String(env.JENNY_SKIP_MAIN_AUTOSTART || '').trim());
  return !skipAutoStart && (isMainModule || hasElectronRuntime);
}

// A boot-time backend failure keeps a live window so the boot curtain can show
// the failure and its Retry (backend.retryStart). Exiting is for packaged smoke
// (its own reporter), windowless failures, and an explicit headless opt-in.
function resolveBootFailureAction({ hasPackagedSmoke = false, hasLiveWindow = false, env = process.env } = {}) {
  if (hasPackagedSmoke) return 'packaged-smoke';
  const exitRequested = /^(1|true|yes)$/i.test(String(env.JENNY_EXIT_ON_BOOT_FAILURE || '').trim());
  return hasLiveWindow && !exitRequested ? 'keep-window' : 'exit';
}

module.exports = {
  FEATURE_STATE_CHANGE_REASONS,
  MANAGED_CONFIG_REFRESH_REASONS,
  resolveBootFailureAction,
  shouldAutoStartMainProcess,
  shouldBroadcastFeatureState,
  shouldRefreshManagedConfigForShellConfigReason,
};
