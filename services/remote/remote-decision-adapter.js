'use strict';

const { summarizeToolPayload } = require('../backend/backend-service-utils');
const {
  buildPersistedToolInputSnapshot,
  redactSensitiveLikeText,
  sanitizeApprovalPolicyText,
  sanitizeToolSummary,
} = require('../backend/tool-loop-input-sanitization');
const askUserTool = require('../tools/builtin/ask-user-tool');
const exitPlanModeTool = require('../tools/builtin/exit-plan-mode-tool');

const MAX_FACT_CHARS = 200;
const MAX_FEEDBACK_CHARS = 800;
const MAX_ID_CHARS = 256;

function safeText(value, limit = MAX_FACT_CHARS) {
  return Array.from(redactSensitiveLikeText(String(value || '')).trim()).slice(0, limit).join('');
}

function failure(error, detail = '') {
  const safeDetail = safeText(detail);
  return {
    ok: false,
    error,
    reason: error,
    ...(safeDetail && safeDetail !== error ? { detail: safeDetail } : {}),
  };
}

function exactId(value, limit = MAX_ID_CHARS) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  return normalized && normalized.length <= limit ? normalized : '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function snapshotWasTruncated(snapshot) {
  try {
    return JSON.parse(snapshot?.inputJson || '{}')?.truncated === true;
  } catch (_error) {
    return true;
  }
}

function sanitizedField(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const sanitized = redactSensitiveLikeText(raw);
  return { raw, sanitized, unchanged: raw === sanitized };
}

function projectCanonicalPlan(input) {
  const normalized = exitPlanModeTool.normalizePlan(input);
  if (!normalized) return { plan: null, complete: false };
  const raw = isPlainObject(input) ? input : {};
  const exact = raw.title?.trim() === normalized.title
    && (raw.summary == null ? '' : raw.summary.trim()) === normalized.summary
    && (raw.notes == null ? '' : raw.notes.trim()) === normalized.notes
    && (raw.verification == null ? '' : raw.verification.trim()) === normalized.verification
    && Array.isArray(raw.steps) && raw.steps.length === normalized.steps.length
    && raw.steps.every((step, index) => typeof step === 'string'
      && step.trim() === normalized.steps[index]);
  const projected = {};
  let unchanged = exact;
  for (const field of ['title', 'summary', 'notes', 'verification']) {
    const sanitized = sanitizedField(normalized[field]);
    projected[field] = sanitized.sanitized;
    unchanged = unchanged && sanitized.unchanged;
  }
  projected.steps = normalized.steps.map((step) => {
    const sanitized = sanitizedField(step);
    unchanged = unchanged && sanitized.unchanged;
    return sanitized.sanitized;
  });
  return { plan: projected, complete: unchanged };
}

function projectApprovalFacts(pending) {
  const toolName = exactId(pending?.toolName, 128);
  const input = isPlainObject(pending?.toolInput) ? pending.toolInput : null;
  const rawSummary = input ? String(summarizeToolPayload(toolName, input) || '').trim() : '';
  const canonicalSummary = sanitizeToolSummary(rawSummary).trim();
  const summary = safeText(canonicalSummary);
  const snapshot = buildPersistedToolInputSnapshot(input || {});
  const policyScope = sanitizeApprovalPolicyText(pending?.policyScope);
  const policyConsequence = sanitizeApprovalPolicyText(pending?.policyConsequence);
  const facts = {
    tool_name: toolName,
    summary,
    policy_scope: policyScope,
    policy_consequence: policyConsequence,
  };
  let complete = Boolean(input && toolName && rawSummary === canonicalSummary
    && canonicalSummary === summary && !snapshotWasTruncated(snapshot));
  complete = complete
    && String(pending?.policyScope || '').trim() === policyScope
    && String(pending?.policyConsequence || '').trim() === policyConsequence;
  if (toolName === 'exit_plan_mode') {
    const plan = projectCanonicalPlan(input);
    facts.plan = plan.plan || { title: '', summary: '', steps: [], notes: '', verification: '' };
    complete = complete && plan.complete;
  }
  return { toolName, facts, complete };
}

function optionProjection(option) {
  const value = safeText(typeof option === 'string' ? option : option?.label, askUserTool.LIMITS.option);
  return value ? { id: value, label: value } : null;
}

function questionProjection(question) {
  if (!isPlainObject(question)) return null;
  const id = exactId(question.id, askUserTool.LIMITS.id);
  const prompt = safeText(question.prompt, askUserTool.LIMITS.prompt);
  if (!id || !prompt) return null;
  return {
    id,
    prompt,
    options: (Array.isArray(question.options) ? question.options : [])
      .slice(0, askUserTool.LIMITS.options).map(optionProjection).filter(Boolean),
    multi_select: question.multi_select === true,
    allow_other: question.allow_other === true,
  };
}

function createRemoteDecisionAdapter(deps = {}) {
  const { backendService, featureFlags = () => ({}), policy = {} } = deps;
  if (!backendService) throw new TypeError('Remote decisions require a backend service.');
  const revisions = new Map();
  let nextRevision = 1;

  function revisionFor(approvalId, entry) {
    const existing = revisions.get(approvalId);
    if (existing?.entry === entry) return existing.revision;
    const revision = nextRevision;
    nextRevision += 1;
    revisions.set(approvalId, { entry, revision });
    return revision;
  }

  function pruneRevisions() {
    const liveIds = new Set();
    for (const [key, entry] of backendService.pendingToolApprovals || []) {
      if (entry?.approvalId === key) liveIds.add(key);
    }
    for (const approvalId of revisions.keys()) {
      if (!liveIds.has(approvalId)) revisions.delete(approvalId);
    }
  }

  function sessionAllowsDecisions(sessionId) {
    try {
      const session = backendService.sessionStore?.getSession?.(sessionId);
      return !session || policy.canListSession(session, featureFlags() || {});
    } catch (_error) {
      return false;
    }
  }

  function projectApproval(approvalId, pending) {
    const projectedFacts = projectApprovalFacts(pending);
    const normalized = {
      toolName: projectedFacts.toolName,
      factsComplete: projectedFacts.complete,
      authority: policy.authorityForTool?.(projectedFacts.toolName) || 'desktop_only',
    };
    return {
      approval_id: approvalId,
      stream_id: exactId(pending?.streamId),
      call_id: exactId(pending?.callId),
      tool_name: projectedFacts.toolName,
      decision_revision: revisionFor(approvalId, pending),
      classification: policy.classifyDecision(normalized),
      facts: projectedFacts.facts,
    };
  }

  function pendingFor(sessionId) {
    pruneRevisions();
    const normalizedSessionId = exactId(sessionId, 128);
    const result = { tool: [], questions: [], plan: [] };
    if (!normalizedSessionId || !sessionAllowsDecisions(normalizedSessionId)) return result;
    for (const [key, pending] of backendService.pendingToolApprovals || []) {
      if (exactId(pending?.sessionId, 128) !== normalizedSessionId) continue;
      const approvalId = exactId(pending?.approvalId || key);
      if (!approvalId || approvalId !== key) continue;
      const projected = projectApproval(approvalId, pending);
      (projected.tool_name === 'exit_plan_mode' ? result.plan : result.tool).push(projected);
    }
    for (const [key, pending] of backendService.pendingUserQuestions || []) {
      if (exactId(pending?.sessionId, 128) !== normalizedSessionId) continue;
      const questionRef = exactId(pending?.questionRef || key, 4096);
      if (!questionRef || questionRef !== key) continue;
      result.questions.push({
        question_ref: questionRef,
        batch_id: exactId(pending?.batchId || pending?.batch_id || pending?.questionId, 4096),
        call_id: exactId(pending?.callId),
        questions: (Array.isArray(pending?.questions) ? pending.questions : [])
          .slice(0, askUserTool.LIMITS.questions).map(questionProjection).filter(Boolean),
      });
    }
    return result;
  }

  function leaseHeld(lease, deviceId, sessionId) {
    return lease?.device_id === deviceId && lease?.session_id === sessionId;
  }

  function exactApproval({ sessionId, streamId, approvalId, decisionRevision, lease, deviceId }) {
    if (!leaseHeld(lease, deviceId, sessionId)) return { error: failure('unauthorized') };
    if (!sessionAllowsDecisions(sessionId)) return { error: failure('unauthorized') };
    if (!exactId(streamId) || !exactId(approvalId)) return { error: failure('stale_approval') };
    const pending = backendService.pendingToolApprovals?.get?.(approvalId);
    if (!pending || pending.approvalId !== approvalId
      || pending.sessionId !== sessionId || pending.streamId !== streamId) {
      return { error: failure('stale_approval') };
    }
    const projected = projectApproval(approvalId, pending);
    if (projected.decision_revision !== decisionRevision) {
      return { error: failure('stale_approval') };
    }
    return { pending, projected };
  }

  function settleApproval(approvalId, settle) {
    try {
      const settled = settle();
      if (!settled) {
        if (!backendService.pendingToolApprovals?.has?.(approvalId)) revisions.delete(approvalId);
        return failure('stale_approval');
      }
      revisions.delete(approvalId);
      return { ok: true, data: { settled: true } };
    } catch (error) {
      if (!backendService.pendingToolApprovals?.has?.(approvalId)) revisions.delete(approvalId);
      return failure('not_reachable', error?.message || error);
    }
  }

  function decideTool(input = {}) {
    const found = exactApproval(input);
    if (found.error) return found.error;
    if (found.projected.classification !== 'phone_ok') return failure('desktop_only');
    if (!['approve_once', 'deny'].includes(input.decision)) return failure('stale_approval');
    return settleApproval(input.approvalId, () => (input.decision === 'approve_once'
      ? backendService.approveToolCall(input.approvalId, { decision: 'approved' })
      : backendService.denyToolCall(input.approvalId)));
  }

  function decidePlan(input = {}) {
    const found = exactApproval(input);
    if (found.error) return found.error;
    if (found.pending.toolName !== 'exit_plan_mode') return failure('stale_approval');
    if (found.projected.classification !== 'phone_ok') return failure('desktop_only');
    let options;
    if (input.decision === 'approve') {
      options = { decision: 'approved' };
    } else if (input.decision === 'revise') {
      const feedback = typeof input.feedback === 'string' ? input.feedback.trim() : '';
      if (!feedback || feedback.length > MAX_FEEDBACK_CHARS) {
        return failure('invalid_request', 'bounded feedback is required');
      }
      options = { decision: 'rejected', feedback };
    } else {
      return failure('stale_approval');
    }
    return settleApproval(input.approvalId, () => (
      backendService.approveToolCall(input.approvalId, options)
    ));
  }

  function exactQuestion({ sessionId, questionRef, batchId, lease, deviceId }) {
    if (!leaseHeld(lease, deviceId, sessionId)) return { error: failure('unauthorized') };
    if (!sessionAllowsDecisions(sessionId)) return { error: failure('unauthorized') };
    const pending = backendService.pendingUserQuestions?.get?.(questionRef);
    const liveBatchId = exactId(pending?.batchId || pending?.batch_id || pending?.questionId, 4096);
    if (!pending || pending.questionRef !== questionRef || pending.sessionId !== sessionId
      || liveBatchId !== batchId) return { error: failure('stale_approval') };
    return { pending };
  }

  function rawAnswerFits(answer) {
    if (!isPlainObject(answer) || typeof answer.id !== 'string') return false;
    const values = Object.hasOwn(answer, 'value')
      ? (Array.isArray(answer.value) ? answer.value : [answer.value]) : [];
    if (values.some((value) => typeof value !== 'string'
      || !value.trim() || value.trim().length > askUserTool.LIMITS.answer)) return false;
    if (Object.hasOwn(answer, 'other') && (typeof answer.other !== 'string'
      || !answer.other.trim() || answer.other.trim().length > askUserTool.LIMITS.answer)) return false;
    return values.length > 0 || Object.hasOwn(answer, 'other');
  }

  function validateNormalizedAnswers(questions, answers) {
    if (!Array.isArray(answers) || !answers.length || answers.length > askUserTool.LIMITS.questions) return null;
    const live = new Map(questions.map((question) => [question.id, question]));
    const ids = answers.map((answer) => exactId(answer?.id, askUserTool.LIMITS.id));
    if (ids.some((id) => !id || !live.has(id)) || new Set(ids).size !== ids.length
      || answers.some((answer) => !rawAnswerFits(answer))) return null;
    const normalized = askUserTool.normalizeAnswers(questions, { answers });
    if (normalized.length !== answers.length) return null;
    for (const answer of normalized) {
      const question = live.get(answer.id);
      const options = new Set(question.options.map((option) => (
        typeof option === 'string' ? option : option?.id
      )).filter(Boolean));
      const other = typeof answer.other === 'string' && answer.other.trim();
      if (!question.options.length) {
        if (typeof answer.value !== 'string' || !answer.value.trim()) return null;
      } else if (question.multi_select) {
        if (!Array.isArray(answer.value) || answer.value.length > Math.min(options.size, askUserTool.LIMITS.options)
          || answer.value.some((value) => !options.has(value)) || (!answer.value.length && !other)) return null;
      } else if (typeof answer.value !== 'string'
        || (!options.has(answer.value) && !(question.allow_other && other))) return null;
      if (other && !question.allow_other) return null;
    }
    return normalized;
  }

  function answerQuestions(input = {}) {
    const found = exactQuestion(input);
    if (found.error) return found.error;
    const questions = (Array.isArray(found.pending.questions) ? found.pending.questions : [])
      .slice(0, askUserTool.LIMITS.questions).map(questionProjection).filter(Boolean);
    const answers = validateNormalizedAnswers(questions, input.answers);
    if (!answers) return failure('invalid_request', 'answers do not match the live batch');
    try {
      return backendService.answerUserQuestions(input.questionRef, { answers })
        ? { ok: true, data: { settled: true } } : failure('stale_approval');
    } catch (error) {
      return failure('not_reachable', error?.message || error);
    }
  }

  function declineQuestions(input = {}) {
    const found = exactQuestion(input);
    if (found.error) return found.error;
    try {
      return backendService.declineUserQuestions(input.questionRef)
        ? { ok: true, data: { settled: true } } : failure('stale_approval');
    } catch (error) {
      return failure('not_reachable', error?.message || error);
    }
  }

  return Object.freeze({ pendingFor, decideTool, decidePlan, answerQuestions, declineQuestions });
}

module.exports = { createRemoteDecisionAdapter };
