'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  FEATURE_STATE_CHANGE_REASONS,
  resolveBootFailureAction,
  shouldAutoStartMainProcess,
  shouldBroadcastFeatureState,
  shouldRefreshManagedConfigForShellConfigReason,
} = require('../services/main/main-process-policy');

test('managed config refresh policy recognizes only canonical refresh reasons', () => {
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('workspace_root_updated'), true);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('feature_settings_updated'), true);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('time_format_updated'), true);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason(' model_tuning_updated '), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('model_tuning_legacy_claimed'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('chunk_inactivity_seconds_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('context_length_tuning_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('compaction_tuning_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('unrelated_change'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason(null), false);
});

test('managed config refresh policy reads every sub-reason of a combined chat UI commit', () => {
  // The sidecar parses ui_language from the managed config (sidecar/ai/config.py).
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('ui_language_updated'), true);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('chat_ui_settings_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('chat_ui_settings_updated',
    ['safety_mode_updated', 'time_format_updated']), true);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('chat_ui_settings_updated',
    ['ui_language_updated', 'unattended_guard_minutes_updated']), true);
  // Safety mode and the streak cap ride every chat.send; they never refresh the config.
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('safety_mode_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('auto_approve_streak_cap_updated'), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('chat_ui_settings_updated',
    ['safety_mode_updated', 'auto_approve_streak_cap_updated']), false);
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('unrelated_change', 'not-a-list'), false);
});

test('feature state broadcast follows the config sections the feature payload reads', () => {
  for (const reason of [
    'feature_settings_updated',
    'feature_settings_reverted',
    'tools_web_enabled_updated',
    'tools_image_read_enabled_updated',
    'tools_worktree_enabled_updated',
    'web_search_settings_updated',
    'memory_capture_suggestions_updated',
    'workspace_root_updated',
    'workspace_root_cleared',
    'workspace_root_status_updated',
    'state_replaced',
  ]) {
    assert.equal(FEATURE_STATE_CHANGE_REASONS.has(reason), true, reason);
    assert.equal(shouldBroadcastFeatureState(reason), true, reason);
  }
  assert.equal(shouldBroadcastFeatureState('feature_override_text_spellcheck_updated'), true);
  for (const reason of [
    'time_format_updated',
    'window_ui_settings_updated',
    'workspace_state_updated',
    'home_config_updated',
    'follow_up_updated',
    'proactive_reminder_upserted',
    'model_tuning_updated',
  ]) {
    assert.equal(shouldBroadcastFeatureState(reason), false, reason);
  }
  assert.equal(shouldBroadcastFeatureState('chat_ui_settings_updated',
    ['time_format_updated', 'safety_mode_updated', 'chat_ui_settings_updated']), false);
  assert.equal(shouldBroadcastFeatureState('setup_state_updated', ['workspace_root_updated']), true);
});

test('feature state broadcast fails open for unknown or empty reasons', () => {
  assert.equal(shouldBroadcastFeatureState(''), true);
  assert.equal(shouldBroadcastFeatureState(undefined), true);
  assert.equal(shouldBroadcastFeatureState('some_future_reason'), true);
  assert.equal(shouldBroadcastFeatureState('chat_ui_settings_updated', ['some_future_reason']), true);
});

test('main auto-start policy honors the explicit skip before runtime detection', () => {
  assert.equal(shouldAutoStartMainProcess({
    hasElectronRuntime: true,
    isMainModule: true,
    env: { JENNY_SKIP_MAIN_AUTOSTART: 'yes' },
  }), false);
  assert.equal(shouldAutoStartMainProcess({
    hasElectronRuntime: false,
    isMainModule: false,
    env: {},
  }), false);
  assert.equal(shouldAutoStartMainProcess({
    hasElectronRuntime: true,
    isMainModule: false,
    env: {},
  }), true);
  assert.equal(shouldAutoStartMainProcess({
    hasElectronRuntime: false,
    isMainModule: true,
    env: {},
  }), true);
});

test('a boot-time backend failure keeps a live window for the curtain Retry instead of exiting', () => {
  assert.equal(resolveBootFailureAction({ hasLiveWindow: true, env: {} }), 'keep-window');
  assert.equal(resolveBootFailureAction({ hasLiveWindow: false, env: {} }), 'exit', 'no window to show the failure');
  assert.equal(resolveBootFailureAction({ hasLiveWindow: true, env: { JENNY_EXIT_ON_BOOT_FAILURE: '1' } }), 'exit',
    'headless runs can opt back into exiting');
  assert.equal(resolveBootFailureAction({ hasPackagedSmoke: true, hasLiveWindow: true, env: {} }), 'packaged-smoke',
    'packaged smoke keeps its own failure reporter');
});
