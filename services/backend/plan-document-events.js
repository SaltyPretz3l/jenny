'use strict';

const crypto = require('node:crypto');
const { normalizePlan } = require('../tools/builtin/exit-plan-mode-tool');

const TERMINAL_STATES = new Set(['approved', 'approved_auto', 'rejected', 'abandoned', 'superseded']);
const INSPECTION_TOOLS = new Set([
  'read_file', 'list_dir', 'glob_files', 'grep_search',
]);
const MAX_FILES_READ = 20;
const STALE_PLAN_AUDITS = new WeakMap();

function deterministicPlanId(streamId, toolCallId) {
  const token = `${String(streamId || '').trim()}:${String(toolCallId || '').trim()}`;
  return `plan_${crypto.createHash('sha256').update(token).digest('hex').slice(0, 20)}`;
}

function safeRelativePath(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/\\/g, '/');
  if (!normalized || normalized.includes('\0') || normalized.startsWith('/')
    || /^[a-z]:/iu.test(normalized) || normalized.split('/').includes('..')) return '';
  return normalized.split('/').filter((segment) => segment && segment !== '.').join('/').slice(0, 300);
}

function deriveFilesRead(messages, streamId = '') {
  const rows = Array.isArray(messages) ? messages : [];
  const currentStreamId = String(streamId || '').trim();
  const uses = new Map();
  for (const row of rows) {
    if (row?.kind !== 'tool_use') continue;
    const call = row.tool_call && typeof row.tool_call === 'object' ? row.tool_call : {};
    if (currentStreamId && String(call.parent_stream_id || '').trim() !== currentStreamId) continue;
    const callId = String(call.call_id || '').trim();
    if (callId) uses.set(callId, call);
  }
  const paths = [];
  for (const row of rows) {
    if (row?.kind !== 'tool_result') continue;
    const result = row.tool_result && typeof row.tool_result === 'object' ? row.tool_result : {};
    if (currentStreamId && String(result.parent_stream_id || '').trim() !== currentStreamId) continue;
    if (result.is_error === true) continue;
    const call = uses.get(String(result.call_id || '').trim());
    if (!call || !INSPECTION_TOOLS.has(String(call.tool_name || '').trim())) continue;
    const metadata = result.metadata && typeof result.metadata === 'object' ? result.metadata : {};
    const source = metadata.source && typeof metadata.source === 'object' ? metadata.source : {};
    const snapshot = metadata.read_snapshot && typeof metadata.read_snapshot === 'object'
      ? metadata.read_snapshot : {};
    // Tool-call inputs are model-authored. Only surface paths echoed from the
    // successful executor result after workspace validation.
    for (const candidate of [metadata.path, source.path, snapshot.path, snapshot.relative_path]) {
      const path = safeRelativePath(candidate);
      if (path && !paths.includes(path)) paths.push(path);
      if (paths.length >= MAX_FILES_READ) return paths;
    }
  }
  return paths;
}

function serializePlanTranscript(plan, state, feedback = '') {
  const lines = [`Plan: ${plan.title}`];
  if (plan.summary) lines.push(plan.summary);
  plan.steps.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  if (plan.verification) lines.push(`Verification: ${plan.verification}`);
  lines.push(`Decision: ${state}`);
  if (feedback) lines.push(`Feedback: ${feedback}`);
  return lines.join('\n').slice(0, 12_000);
}

function stateMap(service) {
  if (!(service._planDocumentsByStream instanceof Map)) service._planDocumentsByStream = new Map();
  while (service._planDocumentsByStream.size > 128) {
    service._planDocumentsByStream.delete(service._planDocumentsByStream.keys().next().value);
  }
  return service._planDocumentsByStream;
}

function notePlanEvent({ turnEventCollector, streamId, callId, planId, state, plan, feedback, filesRead,
  planEdited = false }) {
  if (!turnEventCollector?.noteEvent) return null;
  return turnEventCollector.noteEvent({
    event_id: `${streamId}:plan_document:${planId}:${state}`,
    turn_id: streamId,
    kind: 'plan_document',
    primary_message_id: `plan_document_${planId}`,
    source_message_ids: [`plan_document_${planId}`],
    tool_call_id: callId,
    status: state,
    payload: {
      plan_id: planId,
      tool_call_id: callId,
      transition: state,
      title: plan.title,
      summary: plan.summary,
      steps: plan.steps,
      notes: plan.notes,
      verification: plan.verification,
      feedback: String(feedback || '').slice(0, 800),
      files_read: filesRead,
      plan_edited: planEdited === true,
      render_collapsed: TERMINAL_STATES.has(state),
    },
  });
}

function appendTranscriptMessage(service, sessionId, entry) {
  const message = {
    id: `plan_document_${entry.planId}`,
    role: 'assistant',
    kind: 'plan_document',
    content: serializePlanTranscript(entry.plan, entry.state, entry.feedback),
    plan_document: {
      plan_id: entry.planId,
      tool_call_id: entry.callId,
      state: entry.state,
      ...entry.plan,
      feedback: entry.feedback,
      files_read: entry.filesRead,
      parent_stream_id: entry.streamId,
      plan_edited: entry.planEdited === true,
    },
    timestamp: new Date().toISOString(),
  };
  const store = service?.sessionStore || service?.shadowStore;
  if (typeof store?.appendMessage === 'function') {
    store.appendMessage(sessionId, message, { updatePreview: false });
  } else if (typeof store?.appendLocalMessage === 'function') {
    store.appendLocalMessage(sessionId, message, { updatePreview: false });
  }
}

function updateTranscriptMessage(service, sessionId, entry) {
  const store = service?.sessionStore || service?.shadowStore;
  const patch = {
    content: serializePlanTranscript(entry.plan, entry.state, entry.feedback),
    plan_document: {
      plan_id: entry.planId, tool_call_id: entry.callId, state: entry.state,
      ...entry.plan, feedback: entry.feedback, files_read: entry.filesRead,
      parent_stream_id: entry.streamId,
      plan_edited: entry.planEdited === true,
    },
    finalizedAt: new Date().toISOString(),
  };
  if (typeof store?.updateMessage === 'function') {
    store.updateMessage(sessionId, `plan_document_${entry.planId}`, patch);
  }
}

function recordPendingPlanDocument({ service, sessionId, streamId, callId, input, turnEventCollector }) {
  const plan = normalizePlan(input);
  if (!plan) return null;
  const map = stateMap(service);
  const previous = map.get(streamId);
  if (previous?.state === 'rejected') {
    previous.state = 'superseded';
    notePlanEvent({ turnEventCollector, streamId, callId: previous.callId, planId: previous.planId,
      state: previous.state, plan: previous.plan, feedback: previous.feedback, filesRead: previous.filesRead,
      planEdited: previous.planEdited });
    updateTranscriptMessage(service, sessionId, previous);
  } else if (previous?.state === 'pending' || previous?.state === 'approved' || previous?.state === 'approved_auto') {
    return null;
  }
  const preferredStore = service?.sessionStore || service?.shadowStore;
  const messages = preferredStore?.getSessionMessages?.(sessionId) || [];
  const entry = {
    planId: deterministicPlanId(streamId, callId), callId, streamId, plan, state: 'pending', feedback: '',
    planEdited: false,
    filesRead: deriveFilesRead(messages, streamId),
  };
  map.set(streamId, entry);
  while (map.size > 128) map.delete(map.keys().next().value);
  appendTranscriptMessage(service, sessionId, entry);
  notePlanEvent({ turnEventCollector, streamId, callId, planId: entry.planId,
    state: entry.state, plan, feedback: '', filesRead: entry.filesRead });
  return entry;
}

function recordPlanDocumentOutcome({ service, sessionId, streamId, callId, result, turnEventCollector }) {
  if (String(result?.metadata?.result_kind || '') !== 'plan_mode_transition') return null;
  const entry = stateMap(service).get(streamId);
  if (!entry || entry.callId !== callId) return null;
  const effectivePlan = normalizePlan(result.metadata.plan);
  if (effectivePlan) entry.plan = effectivePlan;
  entry.planEdited = Boolean(effectivePlan && result.metadata.plan_edited === true);
  const decision = String(result.metadata.plan_decision || '').trim();
  entry.state = result.isError ? 'abandoned' : (TERMINAL_STATES.has(decision) ? decision : 'abandoned');
  entry.feedback = String(result.metadata.plan_feedback || '').trim().slice(0, 800);
  updateTranscriptMessage(service, sessionId, entry);
  notePlanEvent({ turnEventCollector, streamId, callId, planId: entry.planId,
    state: entry.state, plan: entry.plan, feedback: entry.feedback, filesRead: entry.filesRead,
    planEdited: entry.planEdited });
  return entry;
}

function preparePlanApproval({
  toolName, service, sessionId, streamId, callId, input, approvalId, turnEventCollector,
}) {
  if (toolName !== 'exit_plan_mode') return { messageFields: {} };
  const previous = stateMap(service).get(streamId);
  const duplicate = ['pending', 'approved', 'approved_auto'].includes(String(previous?.state || ''));
  const entry = duplicate ? null : recordPendingPlanDocument({
    service, sessionId, streamId, callId, input, turnEventCollector,
  });
  // Size overruns already clamp. A missing non-duplicate entry is structurally
  // unrenderable; the approval flow owns terminal-result persistence either way.
  return {
    entry,
    duplicate,
    unrenderable: !entry && !duplicate,
    messageFields: entry ? {
      planDocument: {
        plan_id: entry.planId,
        tool_call_id: callId,
        approval_id: approvalId,
        state: 'pending',
        ...entry.plan,
        files_read: entry.filesRead,
        parent_stream_id: streamId,
      },
    } : {},
  };
}

const UNRENDERABLE_PLAN_MESSAGE = 'The plan proposal was missing a title or steps, so it could not be '
  + 'shown for review. Resubmit exit_plan_mode with a non-empty title and at least one step.';
const DUPLICATE_PLAN_MESSAGE = 'A plan is already pending or approved for this turn. Continue with the approved '
  + 'plan, or ask the user before proposing a replacement.';

function denyUnrenderablePlan(planApproval, persistTerminal, fields) {
  if (!planApproval?.unrenderable && !planApproval?.duplicate) return false;
  const output = planApproval.duplicate ? DUPLICATE_PLAN_MESSAGE : UNRENDERABLE_PLAN_MESSAGE;
  persistTerminal({ ...fields, approvalState: 'denied', output });
  return true;
}

function abandonPlanApproval({ toolName, service, sessionId, streamId, callId, turnEventCollector }) {
  if (toolName !== 'exit_plan_mode') return null;
  return recordPlanDocumentOutcome({
    service, sessionId, streamId, callId,
    result: {
      isError: true,
      metadata: { result_kind: 'plan_mode_transition', plan_decision: 'abandoned' },
    },
    turnEventCollector,
  });
}

function planApprovalWaiterResult({ toolName, approved, state, feedback, plan }) {
  if (!approved) return false;
  if (toolName !== 'exit_plan_mode' || !['approved', 'approved_auto', 'rejected'].includes(state)) {
    return true;
  }
  return {
    approved: true,
    decision: state,
    feedback: String(feedback || '').trim().slice(0, 800),
    ...(plan && typeof plan === 'object' && !Array.isArray(plan) ? { edited_plan: plan } : {}),
  };
}

function resolvePlanApprovalState(approved, approvalState) {
  if (!approved) return String(approvalState || 'denied').trim() || 'denied';
  return ['approved', 'approved_auto', 'rejected'].includes(approvalState) ? approvalState : 'approved';
}

function recordPlanToolOutcome({ toolName, ...context }) {
  return toolName === 'exit_plan_mode' ? recordPlanDocumentOutcome(context) : null;
}

function settleStalePlanDocumentsOnRead({
  backend, logger, sessionId, session, normalizeSession,
}) {
  const auditSessionIds = STALE_PLAN_AUDITS.get(backend) || new Set();
  STALE_PLAN_AUDITS.set(backend, auditSessionIds);
  if (!session || auditSessionIds.has(sessionId)) return session;
  auditSessionIds.add(sessionId);
  try {
    const settled = settleStalePendingPlanDocuments(session);
    if (!settled.changed || backend.hasNewerSchema()) return session;
    const normalized = normalizeSession(sessionId, settled.session);
    if (backend.upsertSession(sessionId, normalized, { persist: true, alreadyNormalized: true })) {
      return normalized;
    }
  } catch (error) {
    logger?.('WARN', 'session_store.stale_plan_settlement_failed', {
      sessionId, message: String(error?.message || error || '').slice(0, 240),
    });
  }
  auditSessionIds.delete(sessionId);
  return session;
}

function settleStalePendingPlanDocuments(session) {
  // Lazy import avoids the session-turn-events -> plan-document-events cycle at module load.
  const { TURN_EVENT_LOG_VERSION } = require('./session-turn-events');
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : null;
  if (!source || Number(source.turn_event_log_version || 0) > TURN_EVENT_LOG_VERSION) {
    return { changed: false, session: source };
  }
  const events = Array.isArray(source.turn_events) ? source.turn_events : [];
  const latestByPlanId = new Map();
  for (const event of events) {
    if (String(event?.kind || '') !== 'plan_document') continue;
    const planId = String(event?.payload?.plan_id || '').trim();
    if (planId) latestByPlanId.set(planId, event);
  }
  const pending = [...latestByPlanId.entries()]
    .filter(([, event]) => String(event?.payload?.transition || event?.status || '') === 'pending');
  if (!pending.length) return { changed: false, session: source };

  const settledAt = new Date().toISOString();
  const maxExistingSeq = events.reduce((maximum, event) => (
    Number.isInteger(event?.event_seq) ? Math.max(maximum, event.event_seq) : maximum
  ), -1);
  let nextSeq = Math.max(Number(source.turn_event_seq_counter || 0), maxExistingSeq + 1, 0);
  const appended = [];
  const abandonedIds = new Set();
  for (const [planId, event] of pending) {
    abandonedIds.add(planId);
    appended.push({
      ...event,
      event_id: `${String(event.turn_id || '')}:plan_document:${planId}:abandoned`,
      event_seq: nextSeq,
      status: 'abandoned',
      completed_at: settledAt,
      payload: {
        ...(event.payload || {}),
        transition: 'abandoned',
        render_collapsed: true,
      },
    });
    nextSeq += 1;
  }
  const messages = (Array.isArray(source.messages) ? source.messages : []).map((message) => {
    const document = message?.plan_document;
    const planId = String(document?.plan_id || '').trim();
    if (!abandonedIds.has(planId)) return message;
    const plan = normalizePlan(document);
    return {
      ...message,
      content: plan ? serializePlanTranscript(plan, 'abandoned', document.feedback) : message.content,
      finalizedAt: settledAt,
      plan_document: { ...document, state: 'abandoned' },
    };
  });
  return {
    changed: true,
    session: {
      ...source,
      messages,
      turn_events: events.concat(appended),
      turn_event_seq_counter: nextSeq,
      turn_event_log_version: Math.max(Number(source.turn_event_log_version || 0), TURN_EVENT_LOG_VERSION),
    },
  };
}

module.exports = {
  deriveFilesRead,
  recordPendingPlanDocument,
  recordPlanDocumentOutcome,
  preparePlanApproval,
  denyUnrenderablePlan,
  abandonPlanApproval,
  planApprovalWaiterResult,
  resolvePlanApprovalState,
  recordPlanToolOutcome,
  settleStalePlanDocumentsOnRead,
  settleStalePendingPlanDocuments,
  UNRENDERABLE_PLAN_MESSAGE,
  DUPLICATE_PLAN_MESSAGE,
};
