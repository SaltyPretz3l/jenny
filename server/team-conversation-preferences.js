'use strict';

// Row 172: a team conversation's model, thinking effort and tool switches (the team conversation controls plan).
//
// `sessions.preferences` may carry `preferred_model` (null: the team default), `reasoning_effort` and `team_tools`
// ({ read?, write? }). Only a team host takes them, after the one authorization function allowed the mutation and the
// lease guard passed; any other host refuses `team_preference_unsupported` before anything is written. A model must
// be offered by the pool at the time of the call (`conversation_model_not_offered`); the change needs a member author
// (`member_author_required`, as a send does) and no running turn (`session_active`), so one turn never mixes two settings. The change reaches the session
// store under a symbol key (services/backend/session-normalizers.js), which writes the values and one log entry naming
// the authorized member.
//
// Row 175 item 7: on a team host `plan_mode` is a team preference too. It needs a member author and no running turn,
// as the keys above, and the change names it (`plan`) for the log; the key itself still reaches the store as the
// plan_mode preference every host sets, so the session's `plan_mode` stays the on/off truth. Any other host takes
// plan_mode as before (no author, no log).
//
// The turn: a switch that is off removes its tools from the request's `tool_preferences.disabled_tools`. The switches
// only remove tools; nothing here adds one, so the host's own tool boundary stays the limit (fail closed).
//
// The snapshot: a team host's `session` object also carries the stored values, the log and whether this host's
// backend offers the typed file tools now (`file_tools`), read from the managed sidecar's reported tool status.

const { hostFailure } = require('./api-contract');
const {
  TEAM_CONVERSATION_PREFERENCES, normalizePreferenceLog, normalizeTeamToolSwitches, teamEffort, teamModelPick,
} = require('../services/backend/session-normalizers');
const { resolveSessionToolDenyList } = require('../services/backend/backend-service-utils');

const TEAM_KEYS = Object.freeze(['preferred_model', 'reasoning_effort', 'team_tools']);
const TOOL_GROUPS = Object.freeze({
  read: Object.freeze(['read_file', 'list_dir', 'glob_files', 'grep_search']),
  write: Object.freeze(['write_file', 'edit_file', 'propose_change']),
});
const FILE_TOOLS = Object.freeze(['read_file', 'write_file']);
// Team host file tools (row 123): why a host with the setting on offers no file tools. The words of the Windows
// file access spec's failure table, plus one generic word for anything else (an unknown word, no report). The member
// client checks the same list (services/team/project-answers.js); a test keeps the two equal.
const FILE_TOOLS_GENERIC_REASON = 'file_access_unavailable';
const FILE_TOOLS_REASONS = Object.freeze([
  'file_access_api_missing', 'file_access_backup_privilege', 'file_access_component_missing', 'file_access_elevated',
  'file_access_platform_unsupported', 'file_access_root_identity', 'file_access_root_invalid',
  'file_access_selfcheck_failed', 'file_access_switch_off', 'file_access_volume_unsupported',
  FILE_TOOLS_GENERIC_REASON,
]);
// The newest entries a snapshot carries (the store keeps 50): enough for the lines near the messages a view holds.
const SNAPSHOT_LOG_MAX = 20;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function refused(command, reason, kind = 'invalid') {
  return Object.assign(new Error(reason), { routerFailure: hostFailure(kind, reason, command.request_id) });
}

// The model ids the pool offers now (the turn route's own list); none without a pool.
function offeredModels(backend) {
  try {
    const listed = backend?.turnRoute?.offeredModels?.();
    return Array.isArray(listed) ? listed.filter((id) => typeof id === 'string') : [];
  } catch (_error) {
    return [];
  }
}

/**
 * Splits the team keys off `params`: `{ rest, change }`, where `change` is null without a team key, else the change the
 * session store applies. Throws a router failure for a host that is not a team host or a model not offered now.
 */
function teamPreferenceChange(command, params, { teamHost, backend, author, busy = false, now = Date.now }) {
  const rest = { ...params };
  for (const key of TEAM_KEYS) delete rest[key];
  const plan = teamHost === true && Object.hasOwn(params, 'plan_mode');
  if (!plan && !TEAM_KEYS.some((key) => Object.hasOwn(params, key))) return { rest, change: null };
  if (teamHost !== true) throw refused(command, 'team_preference_unsupported');
  if (typeof author?.member_id !== 'string') throw refused(command, 'member_author_required', 'forbidden');
  if (busy === true) throw refused(command, 'session_active', 'conflict');
  const change = { by: author.member_id, at: new Date(now()).toISOString(), ...(plan ? { plan: params.plan_mode === true } : {}) };
  return { rest, change: withTeamValues(command, params, change, backend) };
}

// The model, effort and tool switches of `params` added to `change`; a model not offered now is refused.
function withTeamValues(command, params, change, backend) {
  if (Object.hasOwn(params, 'preferred_model')) {
    const model = params.preferred_model;
    if (model !== null && (teamModelPick(model) !== model || !offeredModels(backend).includes(model))) {
      throw refused(command, 'conversation_model_not_offered');
    }
    change.model = model;
  }
  if (Object.hasOwn(params, 'reasoning_effort')) change.effort = params.reasoning_effort;
  if (Object.hasOwn(params, 'team_tools')) {
    const tools = params.team_tools;
    change.tools = Object.fromEntries(['read', 'write'].filter((key) => typeof tools?.[key] === 'boolean').map((key) => [key, tools[key]]));
  }
  return change;
}

function withTeamPreferences(preferences, change) {
  return change ? { ...preferences, [TEAM_CONVERSATION_PREFERENCES]: change } : preferences;
}

// The session's own family and connection switches, as every host sends them.
function sessionToolPreferences(session) {
  const families = isRecord(session.tool_category_overrides) ? structuredClone(session.tool_category_overrides) : null;
  const connections = isRecord(session.tool_connection_overrides) ? structuredClone(session.tool_connection_overrides) : null;
  if (!families && !connections) return undefined;
  return { ...(families ? { families } : {}), ...(connections ? { connections } : {}) };
}

/**
 * The turn's tool preferences. On a team host with a switch off, the session's families and connections are resolved
 * against the host's tool catalog (as the request would resolve them) and the switched-off group joins them as
 * `disabled_tools`; otherwise the session's own switches, unchanged.
 */
function turnToolPreferences(session, { teamHost, catalog }) {
  const base = sessionToolPreferences(session);
  if (teamHost !== true) return base;
  const switches = normalizeTeamToolSwitches(session.team_tool_switches);
  const off = Object.keys(TOOL_GROUPS).filter((group) => switches[group] === false);
  if (!off.length) return base;
  const resolved = resolveSessionToolDenyList(session, isRecord(catalog) ? catalog : null);
  return { disabled_tools: [...new Set([...resolved, ...off.flatMap((group) => TOOL_GROUPS[group])])].sort() };
}

// 'available' only while the managed sidecar reports its worker's file tools started (`hosted_files.available`, sent
// only by a host whose owner turned file tools on) and both typed file tools registered. The main sidecar lists them
// as needing a workspace, because its own process has no root; each request binds the project's folder.
function fileToolsState(backend) {
  const status = backend?.currentStatus;
  const tools = status?.tools_status;
  const registered = isRecord(tools) && FILE_TOOLS.every((name) => isRecord(tools[name]));
  return registered && status?.hosted_files?.available === true ? 'available' : 'unavailable';
}

// The reason word while a host with file tools on offers none; null when they are available or the setting is off.
function fileToolsReason(backend) {
  const hosted = backend?.currentStatus?.hosted_files;
  if (!isRecord(hosted) || fileToolsState(backend) === 'available') return null;
  return FILE_TOOLS_REASONS.includes(hosted.reason) ? hosted.reason : FILE_TOOLS_GENERIC_REASON;
}

/** The snapshot's team fields for a stored session record. */
function teamSnapshotFields(session, backend) {
  return {
    preferred_model: teamModelPick(session?.preferred_model),
    reasoning_effort: teamEffort(session?.reasoning_effort),
    team_tools: normalizeTeamToolSwitches(session?.team_tool_switches),
    preference_log: normalizePreferenceLog(session?.preference_log).slice(-SNAPSHOT_LOG_MAX),
    file_tools: fileToolsState(backend),
    ...(fileToolsReason(backend) ? { file_tools_reason: fileToolsReason(backend) } : {}),
  };
}

module.exports = { FILE_TOOLS_REASONS, TOOL_GROUPS, fileToolsReason, fileToolsState, teamPreferenceChange,
  teamSnapshotFields, turnToolPreferences, withTeamPreferences };
