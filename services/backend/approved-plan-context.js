'use strict';

const MAX_APPROVED_PLAN_BYTES = 8 * 1024;
// No-todo safety bound; todo completion remains the primary plan lifecycle.
const NO_TODO_PLAN_USER_TURN_LIMIT = 10;

function normalizeText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20)
    .map((step) => normalizeText(step, 300))
    .filter(Boolean);
}

function normalizeApprovedPlan(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const title = normalizeText(source.title, 120);
  const steps = normalizeSteps(source.steps);
  if (!title || !steps.length) return null;
  const normalized = {
    plan_id: normalizeText(source.plan_id, 80),
    title,
    summary: normalizeText(source.summary, 800),
    steps,
    notes: normalizeText(source.notes, 4000),
    verification: normalizeText(source.verification, 400),
  };
  return Buffer.byteLength(JSON.stringify(normalized), 'utf8') <= MAX_APPROVED_PLAN_BYTES
    ? normalized
    : null;
}

function messagePlanDocument(message) {
  if (String(message?.kind || '') !== 'plan_document') return null;
  const document = message.plan_document && typeof message.plan_document === 'object'
    ? message.plan_document : null;
  if (!document) return null;
  return {
    message,
    document,
    state: normalizeText(document.state || document.transition, 32),
  };
}

function latestTodoProjection(messages, startIndex) {
  let latest = null;
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (String(message?.kind || '') !== 'tool_use') continue;
    const call = message.tool_call && typeof message.tool_call === 'object' ? message.tool_call : {};
    if (String(call.tool_name || '') !== 'todo_write') continue;
    const input = call.input && typeof call.input === 'object' ? call.input : {};
    if (!Array.isArray(input.todos) || !input.todos.length) continue;
    latest = input.todos.slice(0, 100).map((todo) => ({
      status: normalizeText(todo?.status, 32).toLowerCase(),
    }));
    if (latest.every((todo) => todo.status === 'completed')) {
      return { expired: true, latest };
    }
  }
  return { expired: false, latest };
}

function deriveApprovedPlanContext(messages, { includeCurrentUserTurn = false } = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  let latestPlan = null;
  for (let index = 0; index < rows.length; index += 1) {
    const candidate = messagePlanDocument(rows[index]);
    if (candidate) latestPlan = { ...candidate, index };
  }
  if (!latestPlan || !['approved', 'approved_auto'].includes(latestPlan.state)) return null;

  const plan = normalizeApprovedPlan({
    ...latestPlan.document,
    plan_id: latestPlan.document.plan_id,
  });
  if (!plan) return null;

  const todoProjection = latestTodoProjection(rows, latestPlan.index);
  if (todoProjection.expired) return null;
  if (todoProjection.latest) return plan;

  let subsequentUserTurns = includeCurrentUserTurn ? 1 : 0;
  for (let index = latestPlan.index + 1; index < rows.length; index += 1) {
    if (String(rows[index]?.role || '') === 'user') subsequentUserTurns += 1;
  }
  return subsequentUserTurns <= NO_TODO_PLAN_USER_TURN_LIMIT ? plan : null;
}

function buildApprovedPlanOverlay(plan, guidance) {
  const normalized = normalizeApprovedPlan(plan);
  if (!normalized) return '';
  const lines = [normalizeText(guidance, 1200), '', `Approved plan: ${normalized.title}`];
  if (normalized.summary) lines.push(normalized.summary);
  normalized.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  if (normalized.notes) lines.push('', normalized.notes);
  if (normalized.verification) lines.push('', `Verification: ${normalized.verification}`);
  return lines.join('\n').trim().slice(0, 8000);
}

function buildApprovedPlanSendFields(planMode, effectiveMode, messages) {
  const approvedPlan = deriveApprovedPlanContext(messages);
  return {
    plan_mode: Boolean(planMode) && effectiveMode !== 'chat',
    ...(approvedPlan ? { approved_plan: approvedPlan } : {}),
  };
}

module.exports = {
  MAX_APPROVED_PLAN_BYTES,
  normalizeApprovedPlan,
  deriveApprovedPlanContext,
  buildApprovedPlanOverlay,
  buildApprovedPlanSendFields,
};
