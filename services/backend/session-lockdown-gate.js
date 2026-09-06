'use strict';

const net = require('node:net');
const toolManifest = require('../tools/tool-manifest.json');
const { inferEngineTypeFromModel, resolveRequestedEngineType } = require('./backend-service-utils');

const LOCKDOWN_REMOTE_ENGINE = 'lockdown_remote_engine';
const NETWORK_NONE = 'none';
const NETWORK_POSSIBLE = 'possible';

// Checked-in, fail-closed classification for every canonical manifest tool.
// Dynamic MCP and plugin tools are intentionally absent and therefore denied.
const TOOL_NETWORK_CLASSIFICATION = Object.freeze({
  read_file: NETWORK_NONE,
  operation_status: NETWORK_NONE,
  write_file: NETWORK_NONE,
  edit_file: NETWORK_NONE,
  delete_file: NETWORK_NONE,
  move_file: NETWORK_NONE,
  glob_files: NETWORK_NONE,
  list_dir: NETWORK_NONE,
  workspace_manifest_read: NETWORK_NONE,
  grep_search: NETWORK_NONE,
  knowledge_search: NETWORK_NONE,
  knowledge_view: NETWORK_NONE,
  knowledge_exec: NETWORK_NONE,
  git_status: NETWORK_NONE,
  git_log: NETWORK_NONE,
  git_diff: NETWORK_NONE,
  git_show: NETWORK_NONE,
  workspace_change_baseline: NETWORK_NONE,
  workspace_change_delta: NETWORK_NONE,
  web_search: NETWORK_POSSIBLE,
  fetch_url: NETWORK_POSSIBLE,
  create_artifact: NETWORK_NONE,
  worktree_list: NETWORK_NONE,
  worktree_create: NETWORK_NONE,
  worktree_select: NETWORK_NONE,
  worktree_delete: NETWORK_NONE,
  automation_list: NETWORK_NONE,
  automation_read: NETWORK_NONE,
  workspace_present: NETWORK_NONE,
  preview_test: NETWORK_NONE,
  verify: NETWORK_POSSIBLE,
  home: NETWORK_NONE,
  task_board: NETWORK_NONE,
  delegate: NETWORK_POSSIBLE,
  python_execute: NETWORK_POSSIBLE,
  run_command: NETWORK_POSSIBLE,
  run_temp_script: NETWORK_POSSIBLE,
  monitor: NETWORK_POSSIBLE,
  check_background_job: NETWORK_NONE,
  stop_background_job: NETWORK_NONE,
  check_monitor: NETWORK_NONE,
  todo_write: NETWORK_NONE,
  todo_read: NETWORK_NONE,
  connections_list: NETWORK_NONE,
  mermaid_generate: NETWORK_NONE,
  lsp: NETWORK_POSSIBLE,
  exit_plan_mode: NETWORK_NONE,
  ask_user: NETWORK_NONE,
  jenny_status: NETWORK_NONE,
  tool_search: NETWORK_NONE,
  load_skill: NETWORK_NONE,
});

function validateClassificationTable() {
  const manifestNames = new Set(toolManifest.tools.map((tool) => String(tool.name || '')));
  const classifiedNames = Object.keys(TOOL_NETWORK_CLASSIFICATION);
  if (classifiedNames.length !== manifestNames.size
    || classifiedNames.some((name) => !manifestNames.has(name))
    || [...manifestNames].some((name) => !Object.hasOwn(TOOL_NETWORK_CLASSIFICATION, name))) {
    throw new Error('session_lockdown_tool_classification_drift');
  }
}

validateClassificationTable();

function isSessionOfflineLockdownActive(featureFlags, session) {
  return featureFlags?.session_offline_lockdown === true && session?.lockdown === true;
}

function isToolAvailableDuringSessionLockdown(toolName, active) {
  if (!active) return true;
  return TOOL_NETWORK_CLASSIFICATION[String(toolName || '').trim()] === NETWORK_NONE;
}

function applySessionLockdownToToolPreferences(toolPreferences, active) {
  if (!active) return toolPreferences;
  const source = toolPreferences && typeof toolPreferences === 'object' ? toolPreferences : {};
  const explicitlyEnabled = Array.isArray(source.enabled_tools) ? source.enabled_tools : null;
  const allowedTools = Object.keys(TOOL_NETWORK_CLASSIFICATION)
    .filter((name) => TOOL_NETWORK_CLASSIFICATION[name] === NETWORK_NONE);
  const enabledTools = explicitlyEnabled
    ? explicitlyEnabled.filter((name) => isToolAvailableDuringSessionLockdown(name, true))
    : allowedTools;
  const deniedTools = new Set(Array.isArray(source.disabled_tools) ? source.disabled_tools : []);
  for (const [name, classification] of Object.entries(TOOL_NETWORK_CLASSIFICATION)) {
    if (classification === NETWORK_POSSIBLE) deniedTools.add(name);
  }
  for (const name of explicitlyEnabled || []) {
    if (!isToolAvailableDuringSessionLockdown(name, true)) deniedTools.add(name);
  }
  return {
    enabled_tools: [...new Set(enabledTools)].sort(),
    disabled_tools: [...deniedTools].sort(),
    disabled_tool_families: Array.isArray(source.disabled_tool_families)
      ? [...source.disabled_tool_families] : [],
  };
}

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(String(value || '')).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === 'localhost.'
      || hostname === '::1' || hostname === '[::1]' || hostname === '0.0.0.0'
      || (net.isIP(hostname) === 4 && hostname.split('.')[0] === '127');
  } catch (_error) {
    return false;
  }
}

function isLocalEngine(engineType, openAiCompatibleApiUrl = '') {
  const normalized = String(engineType || '').trim().toLowerCase();
  if (['ollama', 'vllm', 'mock', 'replay'].includes(normalized)) return true;
  if (normalized !== 'openai-compatible') return false;
  return !String(openAiCompatibleApiUrl || '').trim() || isLoopbackUrl(openAiCompatibleApiUrl);
}

function lockdownRemoteEngineError(engineType) {
  return Object.assign(
    new Error('Offline lockdown blocks this session from using a remote engine.'),
    {
      code: LOCKDOWN_REMOTE_ENGINE,
      reason: LOCKDOWN_REMOTE_ENGINE,
      engine_type: String(engineType || '').trim().toLowerCase(),
      category: 'availability',
      status: 'runtime_error',
      terminal_subcode: LOCKDOWN_REMOTE_ENGINE,
      retryable: false,
      user_visible: true,
    }
  );
}

function assertSessionLockdownAllowsEngine({
  active,
  engineType,
  openAiCompatibleApiUrl = '',
} = {}) {
  if (active && !isLocalEngine(engineType, openAiCompatibleApiUrl)) {
    throw lockdownRemoteEngineError(engineType);
  }
}

function openAiCompatibleUrlFromService(service) {
  const state = service?.configService?.getState?.() || {};
  const engines = state.localEngines || state.local_engines || {};
  const settings = engines.openaiCompatible || engines.openai_compatible || {};
  return String(settings.apiUrl || settings.api_url || '').trim();
}

function resolveSessionLockdownRequest(service, session, { requestedEngine, requestedModel }, toolPreferences) {
  const active = isSessionOfflineLockdownActive(service?.featureFlags, session);
  const pinned = String(requestedEngine || '').trim().toLowerCase();
  const model = String(requestedModel || '').trim();
  // Every engine the loader could pick for this turn: the running one, the
  // catalog's provenance hint for the model, the configured engine pin, and the
  // id-inferred fallback (backend-runtime.js normalizeModelLoadRequest /
  // loadModel). Admission is conservative; assertResolvedEngine() re-checks the
  // engine the resolver actually switched to before anything is dispatched.
  const candidates = (pinned
    ? [pinned]
    : [
      String(service?.currentEngineType || '').trim().toLowerCase(),
      model ? String(service?._modelEngineHints?.get?.(model) || '').trim().toLowerCase() : '',
      model ? resolveRequestedEngineType(service?.configService?.getState?.()?.preferredEngineType, model) : '',
      model ? inferEngineTypeFromModel(model) : '',
    ]).filter(Boolean);
  for (const engineType of candidates.length ? candidates : ['']) {
    assertSessionLockdownAllowsEngine({
      active,
      engineType,
      openAiCompatibleApiUrl: openAiCompatibleUrlFromService(service),
    });
  }
  return {
    active,
    toolPreferences: applySessionLockdownToToolPreferences(toolPreferences, active),
    assertResolvedEngine: () => assertSessionLockdownAllowsEngine({
      active,
      engineType: String(service?.currentEngineType || '').trim().toLowerCase(),
      openAiCompatibleApiUrl: openAiCompatibleUrlFromService(service),
    }),
  };
}

module.exports = {
  LOCKDOWN_REMOTE_ENGINE,
  NETWORK_NONE,
  NETWORK_POSSIBLE,
  TOOL_NETWORK_CLASSIFICATION,
  applySessionLockdownToToolPreferences,
  assertSessionLockdownAllowsEngine,
  isLocalEngine,
  isSessionOfflineLockdownActive,
  isToolAvailableDuringSessionLockdown,
  openAiCompatibleUrlFromService,
  resolveSessionLockdownRequest,
};
