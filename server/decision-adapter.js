'use strict';

const { randomBytes } = require('node:crypto');

const MAX_PUBLIC_TEXT = 500;
// Row 175 F5: the exact change a team approval card shows (the presentation services/backend/chat-stream-exact-approval.js
// builds when the approval opens). Only the file tools the team offers carry one; one pending list carries at most
// EXACT_LIST_BUDGET bytes of it, and an entry past that carries the too-large shape instead.
const EXACT_TOOLS = new Set(['write_file', 'edit_file']);
const EXACT_FIELD_MAX = 16;
const EXACT_LIST_BUDGET = 256 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
// Row 175 (D14): the plan decisions an `approval.resolve` may carry, for an exit_plan_mode approval only (with
// approved: true), passed to the backend with the feedback; the backend bounds the feedback to the same 800.
const PLAN_TOOL = 'exit_plan_mode';
const PLAN_DECISIONS = Object.freeze(['approved', 'accepted', 'rejected']);
const MAX_PLAN_FEEDBACK = 800;

function text(value, limit = MAX_PUBLIC_TEXT) {
  return String(value == null ? '' : value).trim().slice(0, limit);
}

function pendingMap(backend, name) {
  return backend?.[name] instanceof Map ? backend[name] : null;
}

function sameLiveIdentity(pending, sessionId, streamId = '') {
  return text(pending?.sessionId, 128) === sessionId
    && (!streamId || text(pending?.streamId, 128) === streamId);
}

function approvalSummary(backend, pending) {
  const direct = text(pending?.summary);
  if (direct) return direct;
  const session = backend?.sessionStore?.getSession?.(pending?.sessionId);
  const message = Array.isArray(session?.messages)
    ? session.messages.find((entry) => text(entry?.id, 256) === text(pending?.messageId, 256))
    : null;
  return text(message?.tool_call?.summary);
}

function tooLargeExact(bytes, limit) {
  return { schema_version: 1, too_large: true, bytes, limit_bytes: limit };
}

// The pending entry's presentation as a team client may read it, rebuilt field by field (the entry is untrusted).
// undefined for a tool that carries none; null for a write or edit whose presentation is missing or malformed, which
// fails closed (the card then offers no Allow, as the local chat). `budget.left` is what the rest of this list may
// still carry. Nothing here logs.
function publicExactApproval(toolName, exact, budget) {
  if (!EXACT_TOOLS.has(toolName)) return undefined;
  if (!exact || typeof exact !== 'object' || exact.schema_version !== 1) return null;
  if (exact.too_large === true) {
    return Number.isSafeInteger(exact.bytes) && Number.isSafeInteger(exact.limit_bytes)
      && exact.bytes >= 0 && exact.limit_bytes >= 0 ? tooLargeExact(exact.bytes, exact.limit_bytes) : null;
  }
  if (!Array.isArray(exact.fields) || exact.fields.length > EXACT_FIELD_MAX || typeof exact.sha256 !== 'string'
    || !SHA256_HEX.test(exact.sha256)) return null;
  const fields = [];
  let bytes = 0;
  for (const field of exact.fields) {
    if (!field || typeof field.name !== 'string' || typeof field.text !== 'string') return null;
    fields.push({ name: field.name, text: field.text });
    bytes += Buffer.byteLength(field.name, 'utf8') + Buffer.byteLength(field.text, 'utf8');
  }
  if (bytes > budget.left) return tooLargeExact(bytes, EXACT_LIST_BUDGET);
  budget.left -= bytes;
  return { schema_version: 1, fields, bytes, sha256: exact.sha256 };
}

// The options for `approveToolCall`: `{ decision: 'approved' }` for a plain approval, the plan decision and its
// feedback for exit_plan_mode, or null for a plan decision that cannot apply (a deny, another tool, an unknown word,
// feedback with no plan decision).
function planOptions(toolName, approved, planDecision, feedback) {
  if (planDecision === undefined && feedback === undefined) return { decision: 'approved' };
  if (approved !== true || toolName !== PLAN_TOOL || !PLAN_DECISIONS.includes(planDecision)) return null;
  if (feedback !== undefined && (typeof feedback !== 'string' || feedback.length > MAX_PLAN_FEEDBACK)) return null;
  return { decision: planDecision, ...(feedback ? { feedback } : {}) };
}

function publicQuestions(questions) {
  return Array.isArray(questions) ? questions.slice(0, 8).map((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) return null;
    const options = Array.isArray(question.options) ? question.options.slice(0, 8).map((option) => {
      // ask-user-tool's live shape is an array of strings. Keep accepting the
      // object shape used by older in-process callers at this boundary, while
      // never exposing arbitrary option fields to the browser.
      const id = typeof option === 'string' ? text(option, 128) : text(option?.id, 128);
      const label = typeof option === 'string' ? text(option, 240) : text(option?.label, 240);
      return id && label ? { id, label } : null;
    }).filter(Boolean) : [];
    const id = text(question.id, 128);
    const prompt = text(question.prompt, 2_000);
    return id && prompt ? {
      id,
      prompt,
      options,
      ...(question.allow_other === true ? { allow_other: true } : {}),
      ...(question.multi_select === true ? { multi_select: true } : {}),
    } : null;
  }).filter(Boolean) : [];
}

// `exactApprovals`: a team host only (row 175 F5); a single-owner host's list keeps its keys as before.
function createDecisionAdapter({ backend, exactApprovals = false } = {}) {
  if (!backend || typeof backend !== 'object') throw new TypeError('Decision adapter requires backend.');
  const approvalRevisions = new WeakMap();

  function decisionRevision(pending) {
    if (!pending || typeof pending !== 'object') return '';
    let value = approvalRevisions.get(pending);
    if (!value) {
      value = `dec_${randomBytes(18).toString('base64url')}`;
      approvalRevisions.set(pending, value);
    }
    return value;
  }

  function listApprovals(sessionId, streamId = '') {
    const normalizedSessionId = text(sessionId, 128);
    const normalizedStreamId = text(streamId, 128);
    const map = pendingMap(backend, 'pendingToolApprovals');
    if (!normalizedSessionId || !map) return [];
    const result = [];
    const budget = { left: EXACT_LIST_BUDGET };
    for (const [key, pending] of map.entries()) {
      const approvalId = text(key, 512);
      if (!approvalId || !sameLiveIdentity(pending, normalizedSessionId, normalizedStreamId)
        || text(pending?.approvalId, 512) !== approvalId) continue;
      const exact = exactApprovals ? publicExactApproval(text(pending.toolName, 128), pending.exactApproval, budget) : undefined;
      result.push({
        approval_id: approvalId,
        decision_revision: decisionRevision(pending),
        stream_id: text(pending.streamId, 128),
        call_id: text(pending.callId, 128),
        tool_name: text(pending.toolName, 128),
        summary: approvalSummary(backend, pending),
        ...(text(pending.policyScope, 128) ? { policy_scope: text(pending.policyScope, 128) } : {}),
        ...(text(pending.policyConsequence, 128)
          ? { policy_consequence: text(pending.policyConsequence, 128) } : {}),
        ...(text(pending.reason) ? { reason: text(pending.reason) } : {}),
        ...(exact === undefined ? {} : { exact_approval: exact }),
      });
    }
    return result;
  }

  function listQuestions(sessionId, streamId = '') {
    const normalizedSessionId = text(sessionId, 128);
    const normalizedStreamId = text(streamId, 128);
    const map = pendingMap(backend, 'pendingUserQuestions');
    if (!normalizedSessionId || !map) return [];
    const result = [];
    for (const [key, pending] of map.entries()) {
      const questionRef = text(key, 512);
      if (!questionRef || !sameLiveIdentity(pending, normalizedSessionId, normalizedStreamId)
        || text(pending?.questionRef, 512) !== questionRef) continue;
      result.push({
        question_ref: questionRef,
        stream_id: text(pending.streamId, 128),
        call_id: text(pending.callId, 128),
        questions: publicQuestions(pending.questions),
      });
    }
    return result;
  }

  function findApproval({ sessionId, streamId, approvalId, revision }) {
    const map = pendingMap(backend, 'pendingToolApprovals');
    const key = text(approvalId, 512);
    const pending = map?.get(key);
    if (!key || !pending || !sameLiveIdentity(pending, text(sessionId, 128), text(streamId, 128))
      || text(pending.approvalId, 512) !== key || decisionRevision(pending) !== revision) return null;
    return { key, pending };
  }

  // Slice 3-6b: the waiting approval a resolve with these ids and this revision would settle, as
  // `{ toolName, callId }`, or null when that resolve would answer stale. Reads only; settles nothing.
  function peekApproval({ sessionId, streamId, approvalId, decisionRevision: revision } = {}) {
    const entry = findApproval({ sessionId, streamId, approvalId, revision });
    return entry ? { toolName: text(entry.pending.toolName, 128), callId: text(entry.pending.callId, 128) } : null;
  }

  // Row 175 (D14): whether a plan decision (and its feedback) can apply to a waiting approval of this tool.
  function planDecisionValid(toolName, { approved, planDecision, feedback } = {}) {
    return planOptions(toolName, approved, planDecision, feedback) !== null;
  }

  function resolveApproval({
    sessionId, streamId, approvalId, decisionRevision: revision, approved, planDecision, feedback,
  } = {}) {
    const entry = findApproval({ sessionId, streamId, approvalId, revision });
    if (!entry || typeof approved !== 'boolean') return { ok: false, reason: 'decision_stale' };
    const options = planOptions(text(entry.pending.toolName, 128), approved, planDecision, feedback);
    if (!options) return { ok: false, reason: 'plan_decision_invalid' };
    const settled = approved
      ? backend.approveToolCall?.(entry.key, options)
      : backend.denyToolCall?.(entry.key);
    if (settled !== true) return { ok: false, reason: 'decision_stale' };
    return { ok: true, approval_id: entry.key, approved };
  }

  function findQuestions({ sessionId, streamId, questionRef }) {
    const map = pendingMap(backend, 'pendingUserQuestions');
    const key = text(questionRef, 512);
    const pending = map?.get(key);
    if (!key || !pending || !sameLiveIdentity(pending, text(sessionId, 128), text(streamId, 128))
      || text(pending.questionRef, 512) !== key) return null;
    return { key, pending };
  }

  // Row 175 item 11: the waiting question batch an answer with these ids would settle, as `{ callId }`, or null.
  function peekQuestions({ sessionId, streamId, questionRef } = {}) {
    const entry = findQuestions({ sessionId, streamId, questionRef });
    return entry ? { callId: text(entry.pending.callId, 128) } : null;
  }

  function answerQuestions({ sessionId, streamId, questionRef, answers } = {}) {
    const entry = findQuestions({ sessionId, streamId, questionRef });
    const expected = publicQuestions(entry?.pending?.questions);
    if (!entry || !Array.isArray(answers) || answers.length !== expected.length) {
      return { ok: false, reason: 'question_batch_stale' };
    }
    const seen = new Set();
    const normalized = [];
    for (const answer of answers) {
      const id = text(answer?.question_id, 128);
      if (!id || seen.has(id) || !expected.some((question) => question.id === id)) {
        return { ok: false, reason: 'question_batch_stale' };
      }
      seen.add(id);
      const question = expected.find((candidate) => candidate.id === id);
      const values = Array.isArray(answer.answer) ? answer.answer : [answer.answer];
      const other = typeof answer.other === 'string' ? answer.other.trim() : '';
      if ((Array.isArray(answer.answer) && !question.multi_select)
        || values.some((value) => typeof value !== 'string' || value.length > 8000)
        || new Set(values).size !== values.length || values.length > 8
        || (other && (!question.allow_other || other.length > 8000))
        || (question.options.length && values.some((value) => value !== ''
          && !question.options.some((option) => option.id === value)))) {
        return { ok: false, reason: 'question_answer_invalid' };
      }
      normalized.push({ id, value: question.multi_select ? values : values[0], ...(other ? { other } : {}) });
    }
    if (seen.size !== expected.length) return { ok: false, reason: 'question_batch_stale' };
    if (backend.answerUserQuestions?.(entry.key, { answers: normalized }) !== true) {
      return { ok: false, reason: 'question_batch_stale' };
    }
    return { ok: true, question_ref: entry.key, answered: true };
  }

  function declineQuestions({ sessionId, streamId, questionRef } = {}) {
    const entry = findQuestions({ sessionId, streamId, questionRef });
    if (!entry || backend.declineUserQuestions?.(entry.key) !== true) {
      return { ok: false, reason: 'question_batch_stale' };
    }
    return { ok: true, question_ref: entry.key, declined: true };
  }

  return Object.freeze({ listApprovals, listQuestions, peekApproval, peekQuestions, planDecisionValid, resolveApproval,
    answerQuestions, declineQuestions });
}

module.exports = { createDecisionAdapter };
