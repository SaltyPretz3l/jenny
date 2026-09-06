const { normalizeReasoningEffort } = require('../../reasoning-effort-profiles');

const ACTIVE_TURN_STATUSES = new Set(['awaiting_assistant', 'streaming']);
const TOOL_CATEGORY_OVERRIDE_KEYS = Object.freeze([
  'files', 'web', 'local_browser', 'python', 'terminal',
]);

function normalizeToolCategoryOverrides(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const normalized = {};
  for (const key of TOOL_CATEGORY_OVERRIDE_KEYS) {
    if (typeof source[key] === 'boolean') normalized[key] = source[key];
  }
  return normalized;
}

function normalizePreferredModel(value) {
  return String(value || '').trim();
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
  return {
    ...(taskId ? { task_id: taskId } : {}),
    ...(taskType ? { task_type: taskType } : {}),
    ...(agentStage ? { agent_stage: agentStage } : {}),
    ...(agentSummary ? { agent_summary: agentSummary } : {}),
    ...(agentPercent != null ? { agent_percent: agentPercent } : {}),
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

module.exports = {
  activeTurnClearMatchIsExplicit,
  activeTurnMatchesRequest,
  activeTurnPassesStreamCas,
  buildTouchedActiveTurn,
  getLocalISODate,
  localIsoDateFromTimestamp,
  normalizeActiveTurn,
  normalizeActiveTurnMatch,
  normalizeActiveTurnStatus,
  normalizePreferredModel,
  normalizeReasoningEffort,
  normalizeSessionStartDate,
  normalizeToolCategoryOverrides,
};
