'use strict';

/* services/chat-messaging-auto-resume.js - a linked child whose turn stopped on a resumable budget is
 * resumed by Jenny (an ordinary durable turn under the child's own run mode, model and effort) instead
 * of waking its parent with a half-finished report. The report still lands in the parent's inbox; the
 * chain's final report wakes the parent, whose turn admits every queued report. Bounded by `maxChain`
 * and a no-progress check; anything else hands the report to the ordinary wake. Per process only.
 */

const { createHash } = require('node:crypto');
const { sessionAllowsChatSend } = require('./backend/session-type');
const { boundedSet, buildWakeRequest } = require('./chat-messaging-wake');
const { APPLICATION_TURN_AUTO_RESUME } = require('./backend/application-turns');

// diminishing_returns is itself a no-progress stop: resuming it would only spin.
const AUTO_RESUME_STOPS = new Set(['tool_cap', 'max_iterations', 'context_budget']);
const RESUME_PROMPT = 'resume: continue your task from where your last turn stopped (it used up its turn budget). '
  + 'Do not repeat steps you already finished.';
const RESUME_VISIBLE_PROMPT = 'Resumed automatically after a turn-budget stop';
// Refusals that mean "not now": the child's previous turn is still settling.
const DEFER_REASONS = new Set(['session_busy', 'linked_first_turn_pending']);
const MESSAGE_SCAN_LIMIT = 200;

const sha = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');
const autoResumeIdempotencyKey = (messageId) => `ar_${sha(messageId).slice(0, 32)}`;

function createAutoResumeOps({
  enabled = () => true,
  paused = () => false, // (parentSessionId) -> boolean: a paused parent stops its children's chains too
  storeReadOnly = () => false,
  getSessionSummary = () => null,
  readMessages = () => [],
  getActiveTurn = () => null,
  hasSessionWork = () => false,
  submitTurn = async () => ({ ok: false, reason: 'runtime_unavailable' }),
  fallback = async () => {}, // (operation) -> the ordinary wake for a report this module gave back
  depthForTurn = () => 0, // the wake chain depth: a resume turn inherits its stopped turn's depth
  noteWakeTurn = () => {},
  scheduleRecheck = (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  recheckMs = 1500,
  maxRechecks = 20,
  maxChain = 5,
  maxTracked = 256,
  log = () => {},
} = {}) {
  const chains = new Map(); // child id -> { count, bodyHash } of the resumes in a row
  const pending = new Map(); // child id -> the resume waiting for the child to be idle
  const ended = new Map(); // child id -> the count of the chain that ended on a budget stop (the card's "after n")

  const read = (fn, fallbackValue) => { try { return fn(); } catch { return fallbackValue; } };

  // The child's assistant row that produced this report, newest first; '' when it is gone or not the
  // child's newest assistant row (a newer turn means the child moved on).
  function reportRow(childId, messageId) {
    const rows = read(() => readMessages(childId), []);
    if (!Array.isArray(rows)) return { row: null, latest: false };
    let newerAssistant = false;
    for (let i = rows.length - 1; i >= 0 && i >= rows.length - MESSAGE_SCAN_LIMIT; i -= 1) {
      const row = rows[i];
      if (row?.terminal_report_message_id === messageId) return { row, latest: !newerAssistant };
      if (row?.role === 'assistant') newerAssistant = true;
    }
    return { row: null, latest: false };
  }

  function eligibleChild(childId) {
    if (read(() => storeReadOnly(), true) === true) return null;
    const summary = read(() => getSessionSummary(childId), null);
    return summary && !summary.archived_at && summary.lockdown !== true && sessionAllowsChatSend(summary) ? summary : null;
  }

  function idle(childId) {
    return read(() => getActiveTurn(childId), true) == null && read(() => hasSessionWork(childId), true) !== true;
  }

  function endChain(childId, messageId, reason) {
    boundedSet(ended, childId, chains.get(childId)?.count || 0, maxTracked);
    chains.delete(childId);
    log('INFO', 'chat_messaging.auto_resume_skipped', { child_session_id: childId, message_id: messageId, reason });
    return false;
  }

  function giveBack(childId, job, reason) {
    pending.delete(childId);
    endChain(childId, job.messageId, reason);
    void Promise.resolve().then(() => fallback(job.operation)).catch(() => {});
  }

  function recheck(childId, job) {
    if (job.scheduled) return;
    if (job.rechecks <= 0) { giveBack(childId, job, 'child_busy'); return; }
    job.rechecks -= 1;
    job.scheduled = true;
    read(() => scheduleRecheck(() => { job.scheduled = false; void drain(childId); }, recheckMs), null);
  }

  async function drain(childId) {
    const job = pending.get(childId);
    if (!job || job.submitting) return;
    if (!idle(childId)) { recheck(childId, job); return; }
    if (read(() => paused(job.parentId), false) === true) { giveBack(childId, job, 'parent_paused'); return; }
    if (!reportRow(childId, job.messageId).latest) { giveBack(childId, job, 'superseded'); return; }
    job.submitting = true;
    let result;
    try {
      result = await submitTurn(job.request, { idempotencyKey: autoResumeIdempotencyKey(job.messageId) });
    } catch {
      result = { ok: false, reason: 'runtime_submission_refused' };
    }
    if (pending.get(childId) !== job) return;
    job.submitting = false;
    if (result?.ok === true) {
      pending.delete(childId);
      if (typeof result.turn_id === 'string') read(() => noteWakeTurn(result.turn_id, depthForTurn(job.sourceTurnId)), null);
      log('INFO', 'chat_messaging.auto_resume_submitted', {
        child_session_id: childId, stop: job.stop, count: chains.get(childId)?.count || 0,
        work_id: typeof result.work_id === 'string' ? result.work_id : null,
      });
      return;
    }
    const reason = typeof result?.reason === 'string' ? result.reason : 'runtime_submission_refused';
    if (DEFER_REASONS.has(reason)) { recheck(childId, job); return; }
    giveBack(childId, job, reason);
  }

  // A delivered report: true when a resume of its child takes it over (the parent is not woken now), false
  // when the ordinary wake should handle it. Never throws.
  function take(operation) {
    try {
      const envelope = operation?.envelope;
      if (operation?.state !== 'delivered' || envelope?.kind !== 'terminal_report') return false;
      const childId = typeof envelope.source_session_id === 'string' ? envelope.source_session_id : '';
      const parentId = typeof envelope.destination_session_id === 'string' ? envelope.destination_session_id : '';
      const messageId = typeof envelope.message_id === 'string' ? envelope.message_id : '';
      if (!childId || !parentId || childId === parentId || !messageId || pending.has(childId)) return false;
      const completed = envelope.report?.outcome === 'completed';
      const stop = completed ? String(reportRow(childId, messageId).row?.resumable_stop || '') : '';
      // A finished or failed turn ends the chain; the parent's wake reads every report it queued.
      if (!AUTO_RESUME_STOPS.has(stop)) { chains.delete(childId); ended.delete(childId); return false; }
      if (read(() => enabled(), false) !== true) return endChain(childId, messageId, 'disabled');
      if (read(() => paused(parentId), false) === true) return endChain(childId, messageId, 'parent_paused');
      const summary = eligibleChild(childId);
      if (!summary) return endChain(childId, messageId, 'ineligible');
      const chain = chains.get(childId) || { count: 0, bodyHash: '' };
      const bodyHash = sha(envelope.body);
      if (chain.count >= maxChain) return endChain(childId, messageId, 'chain_cap');
      if (chain.count > 0 && bodyHash === chain.bodyHash) return endChain(childId, messageId, 'no_progress');
      boundedSet(chains, childId, { count: chain.count + 1, bodyHash }, maxTracked);
      const request = {
        ...buildWakeRequest({ destination: childId, kind: 'report' }, summary, ''),
        prompt: RESUME_PROMPT,
        visiblePrompt: RESUME_VISIBLE_PROMPT,
        applicationTurn: APPLICATION_TURN_AUTO_RESUME,
      };
      boundedSet(pending, childId, {
        operation, request, messageId, parentId, stop, rechecks: maxRechecks, scheduled: false, submitting: false,
        sourceTurnId: typeof envelope.source_turn_id === 'string' ? envelope.source_turn_id : '',
      }, maxTracked);
      void drain(childId);
      return true;
    } catch {
      return false;
    }
  }

  // The child's turn ended: a resume waiting for it runs now.
  async function onTurnSettled(sessionId) {
    try {
      if (pending.has(sessionId)) await drain(sessionId);
    } catch {
      log('WARN', 'chat_messaging.auto_resume_failed', { reason: 'exception' });
    }
  }

  function stats() {
    return { chains: chains.size, pending: pending.size };
  }

  // A child's chain as its proposal card shows it: a resume waiting to run, and how many ran in a row.
  function probe(childId) {
    return { pending: pending.has(childId), count: chains.get(childId)?.count ?? ended.get(childId) ?? 0, max: maxChain };
  }

  return { take, onTurnSettled, probe, stats };
}

module.exports = { autoResumeIdempotencyKey, createAutoResumeOps };
