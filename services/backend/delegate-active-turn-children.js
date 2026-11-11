'use strict';

// One compact row per delegated child on the in-flight active_turn. The live
// per-child state otherwise exists only on a renderer message that a chat
// refetch replaces, so reopening a chat mid-delegation lost the summary card
// and any child that sends no frame until it starts. Rows hold lifecycle facts
// only: activity and transcripts stay ephemeral (docs/operations/SUB_AGENT_DESIGN.md).

const { normalizeString } = require('../shared/normalize');
const { normalizeUsage } = require('./subagent-report-metadata');

const MAX_DELEGATE_CHILDREN = 24;
const MAX_ID_CHARS = 200;
const MAX_LABEL_CHARS = 80;
const MAX_SUMMARY_CHARS = 240;
const MAX_TOKEN_CHARS = 64;
const MAX_ROUTE_CHARS = 138;
const MAX_CHILD_COUNT = 1000;

function text(value, max) {
  return typeof value === 'string' ? normalizeString(value).slice(0, max) : '';
}

function positiveInteger(value, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : null;
}

function normalizeDelegateChild(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const toolCallId = text(value.tool_call_id, MAX_ID_CHARS);
  const childTaskId = text(value.child_task_id, MAX_ID_CHARS);
  const childAgentId = text(value.child_agent_id, MAX_ID_CHARS);
  const status = text(value.status, MAX_TOKEN_CHARS).toLowerCase();
  if (!toolCallId || (!childTaskId && !childAgentId) || !status) return null;
  const optionalText = {
    task_id: text(value.task_id, MAX_ID_CHARS),
    agent_id: text(value.agent_id, MAX_ID_CHARS),
    label: text(value.label, MAX_LABEL_CHARS),
    source: text(value.source, MAX_TOKEN_CHARS),
    summary: text(value.summary, MAX_SUMMARY_CHARS),
    terminal_reason: text(value.terminal_reason, MAX_TOKEN_CHARS),
    model: text(value.model, MAX_ROUTE_CHARS),
    reasoning_effort: text(value.reasoning_effort, MAX_TOKEN_CHARS),
  };
  const optionalNumbers = {
    ordinal: positiveInteger(value.ordinal, MAX_CHILD_COUNT),
    count: positiveInteger(value.count, MAX_CHILD_COUNT),
    started_at_ms: positiveInteger(value.started_at_ms),
    updated_at_ms: positiveInteger(value.updated_at_ms),
  };
  const usage = normalizeUsage(value.usage);
  return {
    tool_call_id: toolCallId,
    ...(childTaskId ? { child_task_id: childTaskId } : {}),
    ...(childAgentId ? { child_agent_id: childAgentId } : {}),
    status,
    child_terminal: value.child_terminal === true,
    child_success: value.child_success === true,
    ...Object.fromEntries(Object.entries(optionalText).filter(([, field]) => field)),
    ...Object.fromEntries(Object.entries(optionalNumbers).filter(([, field]) => field != null)),
    ...(usage ? { usage } : {}),
  };
}

function normalizeDelegateChildren(value) {
  return Array.isArray(value)
    ? value.slice(-MAX_DELEGATE_CHILDREN).map(normalizeDelegateChild).filter(Boolean)
    : [];
}

function isDelegateChildFrame(event) {
  return event?.taskType === 'sub_agent' && Boolean(event.toolCallId)
    && Boolean(event.childTaskId || event.childAgentId);
}

// The next row list for one normalized agent_status event, or null when the
// frame changes no child's lifecycle (activity frames, repeats, late frames).
// `children` is already normalized: it comes from the active turn.
function applyDelegateChildEvent(children, event, nowMs = Date.now()) {
  if (!isDelegateChildFrame(event)) return null;
  const rows = Array.isArray(children) ? children.slice() : [];
  const key = event.childTaskId || event.childAgentId;
  const index = rows.findIndex((row) => (row.child_task_id || row.child_agent_id) === key);
  const existing = index === -1 ? null : rows[index];
  if (existing?.child_terminal) return null;
  const settles = event.childTerminal === true;
  if (existing && !settles && existing.status === event.status) return null;
  const started = !existing || (existing.status === 'queued' && event.status === 'running');
  const row = normalizeDelegateChild({
    tool_call_id: event.toolCallId,
    child_task_id: event.childTaskId,
    child_agent_id: event.childAgentId,
    task_id: event.taskId,
    agent_id: event.agentId,
    ordinal: event.childOrdinal ?? existing?.ordinal,
    count: event.childCount ?? existing?.count,
    label: event.childLabel || existing?.label,
    source: event.source,
    status: event.status,
    summary: event.summary,
    child_terminal: settles,
    child_success: event.childSuccess === true,
    terminal_reason: event.terminalReason,
    model: event.model || existing?.model,
    reasoning_effort: event.reasoningEffort || existing?.reasoning_effort,
    usage: event.usage || existing?.usage,
    started_at_ms: started ? nowMs : existing.started_at_ms,
    updated_at_ms: nowMs,
  });
  if (!row) return null;
  if (existing) rows[index] = row;
  else rows.push(row);
  while (rows.length > MAX_DELEGATE_CHILDREN) {
    const settled = rows.slice(0, -1).findIndex((entry) => entry.child_terminal);
    rows.splice(settled === -1 ? 0 : settled, 1);
  }
  return rows;
}

module.exports = {
  MAX_DELEGATE_CHILDREN,
  applyDelegateChildEvent,
  isDelegateChildFrame,
  normalizeDelegateChildren,
};
