'use strict';

const { randomBytes } = require('node:crypto');

const MAX_PUBLIC_TEXT = 500;

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

function createDecisionAdapter({ backend } = {}) {
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
    for (const [key, pending] of map.entries()) {
      const approvalId = text(key, 512);
      if (!approvalId || !sameLiveIdentity(pending, normalizedSessionId, normalizedStreamId)
        || text(pending?.approvalId, 512) !== approvalId) continue;
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

  function resolveApproval({ sessionId, streamId, approvalId, decisionRevision: revision, approved } = {}) {
    const entry = findApproval({ sessionId, streamId, approvalId, revision });
    if (!entry || typeof approved !== 'boolean') return { ok: false, reason: 'decision_stale' };
    const settled = approved
      ? backend.approveToolCall?.(entry.key, { decision: 'approved' })
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

  return Object.freeze({ listApprovals, listQuestions, resolveApproval, answerQuestions, declineQuestions });
}

module.exports = { createDecisionAdapter };
