const {
  touchActiveTurnProgress,
} = require('./chat-stream-session-lifecycle');
const { normalizeString } = require('../../renderer/shared/string-utils');
const { normalizeUsage } = require('./subagent-report-metadata');

const TERMINAL_AGENT_STATUSES = new Set([
  'completed',
  'closed',
  'failed',
  'error',
  'cancelled',
  'canceled',
  'killed',
]);
const SUCCESS_AGENT_STATUSES = new Set(['completed', 'closed']);

function normalizePercent(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(100, Math.max(0, Math.round(parsed)));
}

function normalizeTerminal(status, explicitTerminal) {
  if (typeof explicitTerminal === 'boolean') {
    return explicitTerminal;
  }
  return TERMINAL_AGENT_STATUSES.has(status);
}

function normalizeSuccess(status, explicitSuccess, terminal) {
  if (typeof explicitSuccess === 'boolean') {
    return explicitSuccess;
  }
  if (!terminal) {
    return false;
  }
  return SUCCESS_AGENT_STATUSES.has(status);
}

function normalizeAgentStatusEvent(value = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const streamId = normalizeString(source.streamId || source.stream_id || source.requestId || source.request_id);
  const sessionId = normalizeString(source.sessionId || source.session_id);
  const requestId = normalizeString(source.requestId || source.request_id || streamId);
  const taskId = normalizeString(source.taskId || source.task_id);
  const taskType = normalizeString(source.taskType || source.task_type);
  const eventSource = normalizeString(source.source) || 'local_agent';
  const status = normalizeString(source.status).toLowerCase() || 'running';
  const stage = normalizeString(source.stage) || 'working';
  const percent = normalizePercent(source.percent, 0);
  const terminal = normalizeTerminal(status, source.terminal);
  const success = normalizeSuccess(status, source.success, terminal);
  const summary = normalizeString(source.summary || source.message) || `Agent is ${status}.`;
  const terminalSubcode = normalizeString(
    source.terminalSubcode || source.terminal_subcode
  );
  const agentId = normalizeString(source.agentId || source.agent_id);
  const parentAgentId = normalizeString(source.parentAgentId || source.parent_agent_id);
  const toolCallId = normalizeString(source.toolCallId || source.tool_call_id);
  const childTaskId = normalizeString(source.childTaskId || source.child_task_id);
  const childAgentId = normalizeString(source.childAgentId || source.child_agent_id);
  const childOrdinal = normalizePositiveInteger(source.childOrdinal || source.child_ordinal);
  const childCount = normalizePositiveInteger(source.childCount || source.child_count);
  const childLabel = normalizeString(source.childLabel || source.child_label).slice(0, 80);
  const model = normalizeRouteIdentifier(source.model);
  const provider = normalizeRouteIdentifier(source.provider);
  const usage = normalizeUsage(source.usage);
  const terminalReason = normalizeString(source.terminalReason || source.terminal_reason)
    .toLowerCase()
    .slice(0, 64);

  if (!streamId || !sessionId || !requestId || !taskId || !taskType) {
    return null;
  }

  const event = {
    type: 'agent_status',
    streamId,
    sessionId,
    requestId,
    taskId,
    taskType,
    source: eventSource,
    status,
    stage,
    percent,
    summary,
    terminal,
    success,
  };
  if (agentId) {
    event.agentId = agentId;
  }
  if (parentAgentId) {
    event.parentAgentId = parentAgentId;
  }
  if (terminalSubcode) {
    event.terminalSubcode = terminalSubcode;
  }
  if (toolCallId) event.toolCallId = toolCallId;
  if (childTaskId) event.childTaskId = childTaskId;
  if (childAgentId) event.childAgentId = childAgentId;
  if (childOrdinal != null) event.childOrdinal = childOrdinal;
  if (childCount != null) event.childCount = childCount;
  if (childLabel) event.childLabel = childLabel;
  if (childTaskId || childAgentId) {
    event.childTerminal = source.childTerminal === true || source.child_terminal === true;
    event.childSuccess = source.childSuccess === true || source.child_success === true;
  }
  if (model) event.model = model;
  if (provider) event.provider = provider;
  if (usage) event.usage = usage;
  if (terminalReason) event.terminalReason = terminalReason;
  return event;
}

function normalizePositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 1000) : null;
}

function normalizeRouteIdentifier(value) {
  const text = normalizeString(value).slice(0, 96);
  return text && !/[\\/]/.test(text) ? text : '';
}

function normalizeAgentProgressNotification(params = {}, {
  streamId = '',
  sessionId = '',
  requestId = '',
} = {}) {
  return normalizeAgentStatusEvent({
    streamId: streamId || params.request_id,
    sessionId: sessionId || params.session_id,
    requestId: requestId || params.request_id || streamId,
    taskId: params.task_id,
    taskType: params.task_type,
    source: params.source,
    status: params.status,
    stage: params.stage,
    percent: params.percent,
    summary: params.summary || params.message,
    terminal: params.terminal,
    success: params.success,
    agentId: params.agent_id || params.agentId,
    parentAgentId: params.parent_agent_id || params.parentAgentId,
    terminalSubcode: params.terminal_subcode || params.terminalSubcode,
    toolCallId: params.tool_call_id || params.toolCallId,
    childTaskId: params.child_task_id || params.childTaskId,
    childAgentId: params.child_agent_id || params.childAgentId,
    childOrdinal: params.child_ordinal || params.childOrdinal,
    childCount: params.child_count || params.childCount,
    childLabel: params.child_label || params.childLabel,
    childTerminal: params.child_terminal === true || params.childTerminal === true,
    childSuccess: params.child_success === true || params.childSuccess === true,
    model: params.model,
    provider: params.provider,
    usage: params.usage,
    terminalReason: params.terminal_reason || params.terminalReason,
  });
}

function mirrorAgentStatusToActiveTurn(adapter, event) {
  if (!adapter || !event) {
    return null;
  }
  return touchActiveTurnProgress(adapter, {
    requestId: event.requestId,
    streamId: event.streamId,
    status: 'streaming',
    taskId: event.taskId,
    taskType: event.taskType,
    agentStage: event.stage,
    agentSummary: event.summary,
    agentPercent: event.percent,
  });
}

function agentExecutorLifecycleEnabled(service) {
  return service?.featureFlags?.agent_executor === true;
}

function isAgentStatusSurfaceEnabled(service) {
  return agentExecutorLifecycleEnabled(service);
}

function coordinateWorkLifecycle(service, adapter, event) {
  if (!event || !isAgentStatusSurfaceEnabled(service, event)) {
    return null;
  }
  mirrorAgentStatusToActiveTurn(adapter, event);
  return event;
}

module.exports = {
  agentExecutorLifecycleEnabled,
  coordinateWorkLifecycle,
  isAgentStatusSurfaceEnabled,
  mirrorAgentStatusToActiveTurn,
  normalizeAgentProgressNotification,
  normalizeAgentStatusEvent,
};
