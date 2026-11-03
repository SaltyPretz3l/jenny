'use strict';

/* services/backend/primary-settings-tool-gate.js - which chats are offered `settings_get` and
 * `settings_change` (row 88 D2/D7), `chat_organize` and `chat_configure` (row 94 P1), `schedule_list` and
 * `schedule_change` (row 85 D8), `project_create` and `projects_list` (row 94 P2), `app_view` (row 94 P3), `session_export` and `terminal_run` (row 94 P4) and `away_digest` (row 86 D3): only the
 * primary Jenny chat. Every other chat gets
 * those names on its per-request `disabled_tools`. Fail closed: a chat whose role cannot be read is not offered
 * them. A separate module from session-directory-tool-gate.js because the rule differs (the directory tools also
 * reach linked chats) and the kill switches differ.
 *
 * Kill switches: with `primary_settings_writes` off the settings tools are not registered at all, with
 * `primary_chat_manage` off the chat tools are not, with `primary_chat_placement` off the project tools are not, with `primary_app_view` off `app_view` is not,
 * with `primary_chat_export` off `session_export` is not, with `terminal_tools` off `terminal_run` is not,
 * with `primary_scheduled_checks` off the schedule tools are
 * not, and with `primary_digests` not on (default off) `away_digest` is not, so the request is left as it was for
 * that group.
 */

const { isPrimaryChatTurn } = require('./chat-send-optional-fields');
const { PRIMARY_SETTINGS_TOOL_NAMES } = require('../primary-settings-contract');

const PRIMARY_CHAT_MANAGE_TOOL_NAMES = Object.freeze(['chat_organize', 'chat_configure']);
const PRIMARY_CHAT_PLACEMENT_TOOL_NAMES = Object.freeze(['project_create', 'projects_list']);
const PRIMARY_APP_VIEW_TOOL_NAMES = Object.freeze(['app_view']);
const PRIMARY_EXPORT_TOOL_NAMES = Object.freeze(['session_export']);
// terminal_read is not here: a project chat on the IDE's open project may read the terminal too (owner pick T1).
const PRIMARY_TERMINAL_TOOL_NAMES = Object.freeze(['terminal_run']);
const PRIMARY_SCHEDULE_TOOL_NAMES = Object.freeze(['schedule_list', 'schedule_change']);
const PRIMARY_DIGEST_TOOL_NAMES = Object.freeze(['away_digest']);

function primaryOnly(service, session) {
  try {
    return isPrimaryChatTurn(service, session) === true;
  } catch (_error) {
    return false;
  }
}

function primarySettingsToolsOffered(service, { session } = {}) {
  if (service?.featureFlags?.primary_settings_writes === false) return true;
  return primaryOnly(service, session);
}

function primaryChatManageToolsOffered(service, { session } = {}) {
  if (service?.featureFlags?.primary_chat_manage === false) return true;
  return primaryOnly(service, session);
}

function primaryChatPlacementToolsOffered(service, { session } = {}) {
  if (service?.featureFlags?.primary_chat_placement === false) return true;
  return primaryOnly(service, session);
}

function primaryAppViewToolsOffered(service, { session } = {}) {
  if (service?.featureFlags?.primary_app_view === false) return true;
  return primaryOnly(service, session);
}

function primaryExportToolsOffered(service, { session } = {}) {
  if (service?.featureFlags?.primary_chat_export === false) return true;
  return primaryOnly(service, session);
}

function primaryTerminalToolsOffered(service, { session } = {}) {
  if (service?.featureFlags?.terminal_tools === false) return true;
  return primaryOnly(service, session);
}

function primaryScheduleToolsOffered(service, { session } = {}) {
  if (service?.featureFlags?.primary_scheduled_checks === false) return true;
  return primaryOnly(service, session);
}

// Default off: the tool is registered only when `primary_digests` is true.
function primaryDigestToolsOffered(service, { session } = {}) {
  if (service?.featureFlags?.primary_digests !== true) return true;
  return primaryOnly(service, session);
}

// The turn's tool preferences with the primary-only tools denied when this chat is not offered them.
function withPrimarySettingsToolGate(service, target, toolPreferences) {
  const names = [
    ...(primarySettingsToolsOffered(service, target) ? [] : PRIMARY_SETTINGS_TOOL_NAMES),
    ...(primaryChatManageToolsOffered(service, target) ? [] : PRIMARY_CHAT_MANAGE_TOOL_NAMES),
    ...(primaryChatPlacementToolsOffered(service, target) ? [] : PRIMARY_CHAT_PLACEMENT_TOOL_NAMES),
    ...(primaryAppViewToolsOffered(service, target) ? [] : PRIMARY_APP_VIEW_TOOL_NAMES),
    ...(primaryExportToolsOffered(service, target) ? [] : PRIMARY_EXPORT_TOOL_NAMES),
    ...(primaryTerminalToolsOffered(service, target) ? [] : PRIMARY_TERMINAL_TOOL_NAMES),
    ...(primaryScheduleToolsOffered(service, target) ? [] : PRIMARY_SCHEDULE_TOOL_NAMES),
    ...(primaryDigestToolsOffered(service, target) ? [] : PRIMARY_DIGEST_TOOL_NAMES),
  ];
  if (!names.length) return toolPreferences;
  const base = toolPreferences && typeof toolPreferences === 'object' && !Array.isArray(toolPreferences)
    ? toolPreferences : {};
  const denied = new Set([...(Array.isArray(base.disabled_tools) ? base.disabled_tools : []), ...names]);
  return { ...base, disabled_tools: [...denied].sort() };
}

module.exports = {
  PRIMARY_APP_VIEW_TOOL_NAMES, PRIMARY_CHAT_MANAGE_TOOL_NAMES, PRIMARY_CHAT_PLACEMENT_TOOL_NAMES, PRIMARY_DIGEST_TOOL_NAMES, PRIMARY_SCHEDULE_TOOL_NAMES,
  PRIMARY_EXPORT_TOOL_NAMES, PRIMARY_TERMINAL_TOOL_NAMES,
  primaryAppViewToolsOffered, primaryChatManageToolsOffered, primaryChatPlacementToolsOffered, primaryExportToolsOffered, primaryTerminalToolsOffered,
  primaryDigestToolsOffered, primaryScheduleToolsOffered, primarySettingsToolsOffered, withPrimarySettingsToolGate,
};
