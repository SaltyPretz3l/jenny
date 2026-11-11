/* services/shell-config-settings-blocks.js - ShellConfigService methods that commit one
 * settings block: feature/tool/web-search/memory settings, offline intelligence,
 * command sandbox, session runtime, performance telemetry, API providers and the
 * primary chat.
 *
 * Extracted from shell-config-service.js as a behavior-preserving move and
 * installed on ShellConfigService.prototype the same way as the other
 * shell-config-*-actions bags; every method keeps its `this` contract
 * (state, getState, _writeState, _commitState, _getNow).
 */
const { CONFIG_ERROR_CODES } = require('./backend/error-codes');
const { FEATURE_OVERRIDE_KEYS, TOOL_SETTING_KEYS, normalizeFeatureOverrides } = require('./feature-flags');
const { COMMAND_SANDBOX_MODES } = require('./shell-config-command-sandbox');
const { applySessionRuntimePatch } = require('./shell-config-session-runtime');
const { applyPerformanceTelemetryPatch } = require('./shell-config-performance');
const { applyPrimaryChatPatch } = require('./shell-config-primary-chat');
const { normalizeApiProvidersConfig } = require('./backend/api-provider-config');
const { applySubagentRoutingPatch } = require('./subagent-routing-settings');
const { applyMemorySettingsPatch } = require('./shell-config-normalizers');
const {
  normalizeOfflineIntelligence,
  normalizeToolsSettings,
  normalizeWebSearchSettings,
} = require('./shell-config-state');


function commitBlock(service, key, next, reason, failure) {
  if (JSON.stringify(next) !== JSON.stringify(service.state[key]) && !service._commitState({ ...service.state, [key]: next }, reason).persisted) throw Object.assign(new Error(failure), { reason: failure });
  return service.getState()[key];
}

const settingsBlockMethods = {
  // One key per write: `enabled` or (row 106) `mode`. Every write persists both, so the effective
  // mode never flips with the enabled state and older builds still read `enabled`.
  updateCommandSandbox(patch) {
    const keys = patch ? Object.keys(patch) : [];
    if (keys.length !== 1 || !(typeof patch.enabled === 'boolean' || COMMAND_SANDBOX_MODES.includes(patch.mode))) {
      throw Object.assign(new Error('sandbox_settings_invalid'), { reason: 'sandbox_settings_invalid' });
    }
    const current = this.state.commandSandbox;
    const next = { enabled: current.enabled, mode: current.mode, ...patch };
    const result = this._commitState({ ...this.state, commandSandbox: next }, 'command_sandbox_updated');
    if (!result.persisted) throw Object.assign(new Error('sandbox_config_write_failed'), { reason: 'sandbox_config_write_failed' });
    return result.snapshot.commandSandbox;
  },

  updateSessionRuntime(patch) {
    const sessionRuntime = applySessionRuntimePatch(this.state.sessionRuntime, patch);
    const result = this._commitState({ ...this.state, sessionRuntime }, 'session_runtime_updated');
    if (!result.persisted) throw Object.assign(new Error('session_runtime_config_write_failed'), { reason: 'session_runtime_config_write_failed' });
    return result.snapshot.sessionRuntime;
  },

  // Non-feature blocks (performance telemetry, row 76 primaryChat, row 78 apiProviders): a changed block commits under a reason the managed-config refresh and feature broadcast ignore.
  updatePerformanceTelemetry(patch) { return commitBlock(this, 'performanceTelemetry', applyPerformanceTelemetryPatch(this.state.performanceTelemetry, patch), 'performance_telemetry_updated', 'performance_config_write_failed'); },

  updateApiProviders(next) { return commitBlock(this, 'apiProviders', normalizeApiProvidersConfig(next), 'api_providers_updated', 'api_providers_config_write_failed'); },

  updatePrimaryChat(patch) { return commitBlock(this, 'primaryChat', applyPrimaryChatPatch(this.state.primaryChat, patch), 'primary_chat_updated', 'primary_chat_config_write_failed'); },

  updateFeatureSettings(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const nextRouting = Object.hasOwn(source, 'subagentRouting')
      ? applySubagentRoutingPatch(this.state.subagentRouting, source.subagentRouting)
      : this.state.subagentRouting;
    const routingChanged = JSON.stringify(nextRouting) !== JSON.stringify(this.state.subagentRouting);
    const nextTools = normalizeToolsSettings({
      ...this.state.tools,
      ...(source.tools && typeof source.tools === 'object' && !Array.isArray(source.tools)
        ? source.tools
        : {}),
    });
    const nextFeatureOverrides = normalizeFeatureOverrides({
      ...this.state.featureOverrides,
      ...(source.featureOverrides
      && typeof source.featureOverrides === 'object'
      && !Array.isArray(source.featureOverrides)
        ? source.featureOverrides
        : {}),
    });
    const nextWebSearch = normalizeWebSearchSettings({
      ...this.state.webSearch,
      ...(source.webSearch && typeof source.webSearch === 'object' && !Array.isArray(source.webSearch)
        ? source.webSearch
        : {}),
    });
    const toolsChanged = JSON.stringify(nextTools) !== JSON.stringify(this.state.tools);
    const overridesChanged =
      JSON.stringify(nextFeatureOverrides) !== JSON.stringify(this.state.featureOverrides);
    const webSearchChanged =
      JSON.stringify(nextWebSearch) !== JSON.stringify(this.state.webSearch);
    const nextMemory = applyMemorySettingsPatch(this.state.memory, source.memory, this._getNow());
    const memoryChanged = JSON.stringify(nextMemory) !== JSON.stringify(this.state.memory);
    if (!toolsChanged && !overridesChanged && !webSearchChanged && !routingChanged && !memoryChanged) {
      return this.getState();
    }

    const nextState = {
      ...this.state,
      tools: nextTools,
      toolsWorktreeEnabled: nextTools.worktree === true,
      webSearch: nextWebSearch,
      featureOverrides: nextFeatureOverrides,
      memory: nextMemory,
      subagentRouting: nextRouting,
    };
    let reason = 'feature_settings_updated';
    if (toolsChanged && !overridesChanged) {
      const changedTool = TOOL_SETTING_KEYS.find((key) => nextTools[key] !== this.state.tools[key]);
      if (changedTool === 'web') {
        reason = 'tools_web_enabled_updated';
      } else if (changedTool === 'imageRead') {
        reason = 'tools_image_read_enabled_updated';
      } else if (changedTool === 'pythonRuntime') {
        reason = 'tools_python_runtime_enabled_updated';
      } else if (changedTool === 'todo') {
        reason = 'tools_todo_enabled_updated';
      } else if (changedTool === 'worktree') {
        reason = 'tools_worktree_enabled_updated';
      }
    }
    if (overridesChanged && !toolsChanged) {
      const changedFeature = FEATURE_OVERRIDE_KEYS.find(
        (key) => nextFeatureOverrides[key] !== this.state.featureOverrides[key]
      );
      if (changedFeature) {
        reason = `feature_override_${changedFeature}_updated`;
      }
    }
    if (webSearchChanged && !toolsChanged && !overridesChanged) {
      reason = 'web_search_settings_updated';
    }
    if (memoryChanged && !toolsChanged && !overridesChanged && !webSearchChanged) reason = 'memory_settings_updated';
    const committed = this._commitState(nextState, reason);
    if (!committed.persisted) throw Object.assign(new Error('Feature settings could not be saved.'), { code: CONFIG_ERROR_CODES.PERSISTENCE });
    return committed.snapshot;
  },

  updateOfflineIntelligence(patch = {}) {
    const nextOffline = {
      ...this.state.offlineIntelligence,
      ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
    };
    return this._writeState(
      {
        ...this.state,
        offlineIntelligence: normalizeOfflineIntelligence(nextOffline),
      },
      'offline_intelligence_updated'
    );
  },
};

module.exports = { settingsBlockMethods };
