const { normalizeReasoningEffort } = require('../../reasoning-effort-profiles');
const {
  GENERAL_PROJECT_ID,
  normalizeProjectId,
} = require('../projects/project-schema');
const {
  MAX_FOLLOW_UP_BODY_CHARS,
  MAX_FOLLOW_UP_LABEL_CHARS,
} = require('../shell-config-followups-schema');
const { normalizeDelegateChildren } = require('./delegate-active-turn-children');
const { allowedNodesField } = require('./session-allowed-nodes');
const { memberAuthor } = require('./message-author');

const ACTIVE_TURN_STATUSES = new Set(['awaiting_assistant', 'streaming']);
const TOOL_CATEGORY_OVERRIDE_KEYS = Object.freeze([
  'files', 'web', 'local_browser', 'python', 'terminal', 'git', 'code',
  'checks', 'artifacts', 'images', 'knowledge', 'home', 'helpers', 'browser_use',
  // Row 196: the Computer switch.
  'computer_use',
]);
const TOOL_CONNECTION_OVERRIDES_MAX = 64;
const COMPOSER_DRAFT_CLIP_MARKER = '\n\n[clipped]';
const MAX_COMPOSER_DRAFT_CHARS = MAX_FOLLOW_UP_LABEL_CHARS + 2 + MAX_FOLLOW_UP_BODY_CHARS;

function normalizeComposerDraft(value) {
  const text = typeof value === 'string' ? value.replace(/\0/g, '').trim() : '';
  return text.length > MAX_COMPOSER_DRAFT_CHARS
    ? `${text.slice(0, MAX_COMPOSER_DRAFT_CHARS - COMPOSER_DRAFT_CLIP_MARKER.length).trimEnd()}${COMPOSER_DRAFT_CLIP_MARKER}`
    : text;
}
// The longest connection id: 'plugin:' + a 64-char publisher id + ':' + a 64-char plugin id.
const TOOL_CONNECTION_KEY_MAX = 136;

function normalizeToolCategoryOverrides(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const key of TOOL_CATEGORY_OVERRIDE_KEYS) {
    if (typeof source[key] === 'boolean') normalized[key] = source[key];
  }
  return normalized;
}

function normalizeToolConnectionOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return {};
  const normalized = {};
  for (const [rawKey, enabled] of Object.entries(value)) {
    const key = rawKey.trim();
    if (key && key.length <= TOOL_CONNECTION_KEY_MAX && /^(mcp|plugin):[^\s]+$/.test(key)
      && typeof enabled === 'boolean') normalized[key] = enabled;
  }
  return normalized;
}

function normalizePreferredModel(value) {
  return String(value || '').trim();
}

function normalizeSessionProjectId(value, { legacyFallback = false } = {}) {
  const normalized = normalizeProjectId(value);
  if (normalized) return normalized;
  if (value === undefined || legacyFallback) return GENERAL_PROJECT_ID;
  const evidence = typeof value === 'string' ? value.trim().slice(0, 256) : '';
  return evidence || 'invalid_project_scope';
}

function normalizeActiveTurnStatus(value) {
  const token = String(value || '').trim().toLowerCase();
  return ACTIVE_TURN_STATUSES.has(token) ? token : '';
}

function normalizeActiveTurnPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function buildActiveTurnLifecycleSnapshot(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const taskId = String(source.task_id || source.taskId || '').trim();
  const taskType = String(source.task_type || source.taskType || '').trim();
  const agentStage = String(source.agent_stage || source.agentStage || '').trim();
  const agentSummary = String(source.agent_summary || source.agentSummary || '').trim();
  const agentPercent = normalizeActiveTurnPercent(
    Object.prototype.hasOwnProperty.call(source, 'agent_percent')
      ? source.agent_percent
      : source.agentPercent
  );
  const delegateChildren = normalizeDelegateChildren(source.delegate_children);
  return {
    ...(taskId ? { task_id: taskId } : {}),
    ...(taskType ? { task_type: taskType } : {}),
    ...(agentStage ? { agent_stage: agentStage } : {}),
    ...(agentSummary ? { agent_summary: agentSummary } : {}),
    ...(agentPercent != null ? { agent_percent: agentPercent } : {}),
    ...(delegateChildren.length ? { delegate_children: delegateChildren } : {}),
  };
}

function normalizeActiveTurnMatch(match = {}) {
  return {
    matchRequestId: String(match.request_id || '').trim(),
    matchStreamId: String(match.stream_id || '').trim(),
  };
}

function activeTurnMatchesRequest(current, { matchRequestId, matchStreamId }) {
  return (!matchRequestId || current.request_id === matchRequestId)
    && (!matchStreamId || current.stream_id === matchStreamId);
}

function activeTurnClearMatchIsExplicit({ matchRequestId, matchStreamId }) {
  return Boolean(matchRequestId || matchStreamId);
}

function activeTurnPassesStreamCas(current, expectedPriorStreamId) {
  return !current || String(current.stream_id || '') === String(expectedPriorStreamId);
}

function buildTouchedActiveTurn(current, patch) {
  return {
    ...current,
    ...(Object.prototype.hasOwnProperty.call(patch, 'status')
      ? { status: normalizeActiveTurnStatus(patch.status) || current.status }
      : {}),
    last_event_at: String(patch.last_event_at || new Date().toISOString()),
    ...buildActiveTurnLifecycleSnapshot({
      ...current,
      ...(patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {}),
    }),
  };
}

function normalizeActiveTurn(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const requestId = String(value.request_id || value.requestId || '').trim();
  const streamId = String(value.stream_id || value.streamId || '').trim();
  const traceId = String(value.trace_id || value.traceId || '').trim();
  const userMessageId = String(value.user_message_id || value.userMessageId || '').trim();
  const turnId = String(value.turn_id || value.turnId || streamId).trim();
  const sessionIncarnation = String(
    value.session_incarnation || value.sessionIncarnation || ''
  ).trim();
  const parsedGeneration = Number(value.generation);
  const generation = Number.isInteger(parsedGeneration) && parsedGeneration > 0
    ? parsedGeneration
    : null;
  const startedAt = String(value.started_at || value.startedAt || '').trim();
  const lastEventAt = String(value.last_event_at || value.lastEventAt || '').trim();
  const status = normalizeActiveTurnStatus(value.status);
  const continuationRestoreRequired = value.continuation_restore_required === true
    || value.continuationRestoreRequired === true;
  if (!requestId || !streamId || !userMessageId || !startedAt || !lastEventAt || !status) {
    return null;
  }
  return {
    request_id: requestId,
    stream_id: streamId,
    turn_id: turnId,
    ...(sessionIncarnation ? { session_incarnation: sessionIncarnation } : {}),
    ...(generation != null ? { generation } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
    user_message_id: userMessageId,
    started_at: startedAt,
    last_event_at: lastEventAt,
    status,
    ...(continuationRestoreRequired ? { continuation_restore_required: true } : {}),
    ...buildActiveTurnLifecycleSnapshot(value),
  };
}

// Local-timezone calendar-date helpers for session records (session_start_date
// et al). Hosted here (rather than electron-session-store.js, their historical
// home, which re-exports them) to keep the store under the file-size ceiling.
function getLocalISODate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function localIsoDateFromTimestamp(value) {
  const token = String(value || '').trim();
  if (!token) {
    return '';
  }
  return getLocalISODate(new Date(token));
}

// Session start date: a literal YYYY-MM-DD wins; otherwise derive the local
// calendar date from the created_at timestamp.
function normalizeSessionStartDate(value, createdAt = '') {
  const token = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    return token;
  }
  return localIsoDateFromTimestamp(createdAt);
}

// Row 172: a team conversation's model, thinking effort and tool switches, set only by the team host's
// `sessions.preferences` (server/team-conversation-preferences.js), which hands the change over under this symbol key:
// no IPC payload or JSON body can carry it (structured clone and JSON drop symbol keys), as with
// session-allowed-nodes.js. The record keeps the existing `preferred_model` and `reasoning_effort`, plus
// `team_tool_switches` ({ read, write }) and a bounded `preference_log`; a record without them reads as the team
// default, both switches on and an empty log. `team_tool_switches` present marks the pick as the team's own: from then
// on only this key changes `preferred_model` or `reasoning_effort` (a turn's echo of its routing alias never does).
const TEAM_CONVERSATION_PREFERENCES = Symbol('team_conversation_preferences');
// The pool gateway's model alias (server/team/pool-gateway.js `POOL_MODEL_ALIAS`), restated: with Team off desktop
// main loads no server/team module (tests/team-off.test.js). Stored, it means the team default.
const TEAM_POOL_MODEL_ALIAS = 'team-pool';
const TEAM_EFFORTS = Object.freeze(['default', 'low', 'medium', 'high']);
const TEAM_MODEL_NAME = /^[\x21-\x7e][\x20-\x7e]{0,255}$/u;
const TEAM_LOG_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/u;
const PREFERENCE_LOG_MAX = 50;

function isRecordValue(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The conversation's own model, or null for the team default (empty, the alias, or not a model name). */
function teamModelPick(value) {
  const model = typeof value === 'string' ? value.trim() : '';
  return model && model !== TEAM_POOL_MODEL_ALIAS && TEAM_MODEL_NAME.test(model) ? model : null;
}

function teamEffort(value) {
  return TEAM_EFFORTS.includes(value) ? value : 'default';
}

// Absent switches are on; a stored switch that is not exactly true is off (fail closed).
function normalizeTeamToolSwitches(value) {
  const source = isRecordValue(value) ? value : {};
  return { read: !Object.hasOwn(source, 'read') || source.read === true,
    write: !Object.hasOwn(source, 'write') || source.write === true };
}

function teamPreferenceState(record = {}) {
  const switches = normalizeTeamToolSwitches(record?.team_tool_switches);
  return { model: teamModelPick(record?.preferred_model), effort: teamEffort(record?.reasoning_effort),
    read: switches.read, write: switches.write, plan: record?.plan_mode === true };
}

function checkedLogState(value) {
  if (!isRecordValue(value) || typeof value.read !== 'boolean' || typeof value.write !== 'boolean'
    || !TEAM_EFFORTS.includes(value.effort)) return null;
  if (value.model !== null && teamModelPick(value.model) !== value.model) return null;
  // Row 175 item 7: `plan` (Plan mode on or off) is optional; an entry an older host wrote has none.
  return { model: value.model, effort: value.effort, read: value.read, write: value.write,
    ...(typeof value.plan === 'boolean' ? { plan: value.plan } : {}) };
}

function checkedLogEntry(value) {
  if (!isRecordValue(value) || typeof value.at !== 'string' || !TEAM_LOG_STAMP.test(value.at)) return null;
  const by = value.by === null ? null : memberAuthor(value.by)?.member_id ?? undefined;
  const from = checkedLogState(value.from);
  const to = checkedLogState(value.to);
  return by === undefined || !from || !to ? null : { at: value.at, by, from, to };
}

/** The stored log: its valid entries, the newest 50. */
function normalizePreferenceLog(value) {
  if (!Array.isArray(value)) return [];
  return value.map(checkedLogEntry).filter(Boolean).slice(-PREFERENCE_LOG_MAX);
}

/** The team-only fields a stored record keeps (the allowed-node list included); none for a desktop record. */
function teamConversationFields(input = {}) {
  const log = normalizePreferenceLog(input.preference_log);
  return { ...allowedNodesField(input.allowed_nodes),
    ...(Object.hasOwn(input, 'team_tool_switches') ? { team_tool_switches: normalizeTeamToolSwitches(input.team_tool_switches) } : {}),
    ...(log.length ? { preference_log: log } : {}) };
}

/**
 * The patch for a team change `{ model?, effort?, tools?: { read?, write? }, by, at }` against the current record: the
 * given values, the switches (always written, which marks the pick as the team's), and one log entry when the result
 * differs from what was there. A change that changes nothing appends nothing.
 */
function teamPreferencesPatch(change, record = {}) {
  const from = teamPreferenceState(record);
  const tools = isRecordValue(change.tools) ? change.tools : {};
  const to = {
    model: Object.hasOwn(change, 'model') ? teamModelPick(change.model) : from.model,
    effort: Object.hasOwn(change, 'effort') ? teamEffort(change.effort) : from.effort,
    read: typeof tools.read === 'boolean' ? tools.read : from.read,
    write: typeof tools.write === 'boolean' ? tools.write : from.write,
    // Row 175 item 7: Plan mode is logged like the other team keys (the store write itself is `plan_mode`).
    plan: typeof change.plan === 'boolean' ? change.plan : from.plan,
  };
  const patch = { team_tool_switches: { read: to.read, write: to.write } };
  if (Object.hasOwn(change, 'model')) patch.preferred_model = to.model ?? '';
  if (Object.hasOwn(change, 'effort')) patch.reasoning_effort = to.effort;
  const changed = ['model', 'effort', 'read', 'write', 'plan'].some((key) => from[key] !== to[key]);
  // `plan` is written only on an entry that changes it, so an entry for another key reads as before.
  const logged = (state) => {
    const { plan, ...rest } = state;
    return from.plan === to.plan ? rest : { ...rest, plan };
  };
  const entry = changed ? checkedLogEntry({ at: change.at, by: change.by ?? null, from: logged(from), to: logged(to) }) : null;
  if (changed && !entry) throw Object.assign(new RangeError('team_preferences_invalid'), { reason: 'team_preferences_invalid' });
  if (entry) patch.preference_log = [...normalizePreferenceLog(record.preference_log), entry].slice(-PREFERENCE_LOG_MAX);
  return patch;
}

module.exports = {
  TEAM_CONVERSATION_PREFERENCES,
  normalizePreferenceLog,
  normalizeTeamToolSwitches,
  teamConversationFields,
  teamEffort,
  teamModelPick,
  teamPreferencesPatch,
  TOOL_CONNECTION_OVERRIDES_MAX,
  activeTurnClearMatchIsExplicit,
  activeTurnMatchesRequest,
  activeTurnPassesStreamCas,
  buildTouchedActiveTurn,
  getLocalISODate,
  localIsoDateFromTimestamp,
  normalizeActiveTurn,
  normalizeActiveTurnMatch,
  normalizeActiveTurnStatus,
  normalizeComposerDraft,
  normalizePreferredModel,
  normalizeReasoningEffort,
  normalizeSessionProjectId,
  normalizeSessionStartDate,
  normalizeToolCategoryOverrides,
  normalizeToolConnectionOverrides,
};
