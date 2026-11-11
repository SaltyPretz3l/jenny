'use strict';

/* services/background-job-wake.js - a background job Jenny started finishes after her turn ended: wake that
 * chat once so she reads the result (owner pick 2026-11-01, Claude Code parity).
 *
 * Pure decision logic over injected ports, beside row 70's message wake (chat-messaging-wake.js) and with its
 * guards: the chat must allow a send (not archived, locked down or read-only), a paused chat drops the wake, a
 * per-chat rate window caps chains (a woken turn may start another job), and the wake is an ordinary durable
 * turn under the chat's own run mode, model and effort (APPLICATION_TURN_WAKE: no bubble; Jenny's reply says
 * what finished).
 *
 * A job needs no wake when its result already reached the model: a check_background_job or
 * stop_background_job result that reported it settled (noteResultRead), typically a wait_ms poll in the turn
 * that started it. A job the person stopped never wakes: it is held and told to the model on the chat's next
 * step, in the live turn or the next one (onTurnStarted). A job that settles while the chat is working is
 * pushed into the live turn (deliverMidTurn, row 71): the tool loop tells the model before its next step and
 * the acknowledgement marks it read. A notice nobody acknowledges leaves the job pending, so the turn's end
 * still wakes the chat. Every map is per process and bounded: a restart forgets them and never wakes
 * anything. Diagnostics carry ids, states and counts only, never commands.
 */

const { createHash } = require('node:crypto');
const { sessionAllowsChatSend } = require('./backend/session-type');
const { APPLICATION_TURN_WAKE } = require('./backend/application-turns');
const { promptCommand, pushMidTurnJobNotices } = require('./backend/background-job-mid-turn');
const { boundedSet, isTurnSettledEvent, wakeAuthority } = require('./chat-messaging-wake');

const RUNTIME_ABSENT = Object.freeze({ ok: false, reason: 'runtime_unavailable', acceptance: 'rejected' });
const DEFER_REASONS = new Set(['session_busy', 'linked_first_turn_pending']);

function jobLine(job) {
  const exit = Number.isInteger(job.exitCode) ? `, exit ${job.exitCode}` : '';
  return `- ${job.jobId} (\`${promptCommand(job.command)}\`): ${job.state}${exit}`;
}

function jobWakePrompt(jobs) {
  const noun = jobs.length === 1 ? 'A background job' : 'Background jobs';
  return `${noun} you started earlier in this chat finished:\n${jobs.map(jobLine).join('\n')}\n`
    + 'Read the result with check_background_job and finish what it was for (for example, report the outcome '
    + 'to the user). If it no longer matters, reply with one short line.';
}

function jobWakeIdempotencyKey(jobIds) {
  return `wake_job_${createHash('sha256').update(jobIds.join(',')).digest('hex').slice(0, 32)}`;
}

function createBackgroundJobWakeOps({
  enabled = () => true,
  paused = () => false,
  storeReadOnly = () => false,
  getSessionSummary = () => null,
  getActiveTurn = () => null,
  hasSessionWork = () => false,
  deliverMidTurn = () => ({ ok: false, reason: 'unavailable' }),
  submitTurn = async () => RUNTIME_ABSENT,
  scheduleRecheck = (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; },
  settlingRecheckMs = 1500,
  now = () => Date.now(),
  log = () => {},
  rateLimit = { max: 6, windowMs: 600000 },
  maxTracked = 256,
} = {}) {
  const pending = new Map(); // job id -> settled job snapshot whose result the model has not read
  const stopped = new Map(); // job id -> a job the person stopped, until the model has been told
  const resultRead = new Map(); // job id -> true: its settled result reached the model
  const wakes = new Map(); // session id -> submit times (ms) inside the rate window
  const inFlight = new Set(); // session ids with a wake submit awaiting its answer
  const settling = new Map(); // session id -> re-checks left

  const read = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  function noteResultRead(jobId) {
    if (typeof jobId !== 'string' || !jobId) return;
    boundedSet(resultRead, jobId, true, maxTracked);
    pending.delete(jobId);
    stopped.delete(jobId);
  }

  // Pushed into the live turn if there is one; unacknowledged stops wait for the next turn.
  function pushStopped(sessionId) {
    const jobs = [...stopped.values()].filter((job) => job.sessionId === sessionId);
    if (!jobs.length) return { outcome: 'none' };
    const pushed = read(() => deliverMidTurn(sessionId, jobs), { ok: false, reason: 'exception' });
    const outcome = pushed?.ok === true ? 'delivered' : 'held';
    log('INFO', 'background_job_wake.stop_notice', { session_id: sessionId, job_count: jobs.length, outcome });
    return { outcome };
  }

  function idle(sessionId) {
    return !inFlight.has(sessionId) && read(() => getActiveTurn(sessionId), true) == null
      && read(() => hasSessionWork(sessionId), true) !== true;
  }

  function eligibleSummary(sessionId) {
    if (read(() => storeReadOnly(), true) === true) return null;
    const summary = read(() => getSessionSummary(sessionId), null);
    return summary && !summary.archived_at && summary.lockdown !== true && sessionAllowsChatSend(summary) ? summary : null;
  }

  function recentWakes(sessionId) {
    const cutoff = read(now, Date.now()) - rateLimit.windowMs;
    const kept = (wakes.get(sessionId) || []).filter((at) => at > cutoff);
    if (kept.length) boundedSet(wakes, sessionId, kept, maxTracked);
    else wakes.delete(sessionId);
    return kept.length;
  }

  // Between a turn's terminal event and the runtime releasing its work the chat is not idle yet: a bounded
  // re-check gives the settle its wake (as chat-messaging-wake's watchSettling does).
  function watchSettling(sessionId) {
    if (settling.has(sessionId) || read(() => getActiveTurn(sessionId), true) != null) return;
    settling.set(sessionId, 5);
    const tick = () => {
      const left = settling.get(sessionId);
      if (left == null) return;
      if (idle(sessionId) || left <= 1) {
        settling.delete(sessionId);
        if (idle(sessionId)) void route(sessionId);
        return;
      }
      settling.set(sessionId, left - 1);
      read(() => scheduleRecheck(tick, settlingRecheckMs), null);
    };
    read(() => scheduleRecheck(tick, settlingRecheckMs), null);
  }

  function drop(jobs, reason) {
    for (const job of jobs) pending.delete(job.jobId);
    log('INFO', 'background_job_wake.skipped', { session_id: jobs[0].sessionId, job_count: jobs.length, reason });
    return { outcome: reason };
  }

  async function route(sessionId) {
    const jobs = [...pending.values()].filter((job) => job.sessionId === sessionId)
      .sort((a, b) => (a.endedAtMs || 0) - (b.endedAtMs || 0));
    if (!jobs.length) return { outcome: 'none' };
    if (read(() => enabled(), false) !== true) return drop(jobs, 'disabled');
    if (read(() => paused(sessionId), false) === true) return drop(jobs, 'paused');
    const summary = eligibleSummary(sessionId);
    if (!summary) return drop(jobs, 'ineligible');
    if (!idle(sessionId)) {
      // The live turn may read the result itself, or acknowledge the mid-turn notice; its settle decides.
      // The jobs stay pending until background-job-read.
      const pushed = read(() => deliverMidTurn(sessionId, jobs), { ok: false, reason: 'exception' });
      const outcome = pushed?.ok === true ? 'delivered' : String(pushed?.reason || 'refused');
      log('INFO', 'background_job_wake.mid_turn', { session_id: sessionId, job_count: jobs.length, outcome });
      watchSettling(sessionId);
      return { outcome: 'deferred' };
    }
    const count = recentWakes(sessionId);
    if (count >= rateLimit.max) {
      log('WARN', 'background_job_wake.rate_limited', { session_id: sessionId, job_count: jobs.length, count });
      return drop(jobs, 'rate_limited');
    }
    for (const job of jobs) pending.delete(job.jobId);
    const jobIds = jobs.map((job) => job.jobId);
    const request = {
      sessionId,
      prompt: jobWakePrompt(jobs),
      visiblePrompt: jobs.length === 1 ? 'Woken by a finished background job' : 'Woken by finished background jobs',
      applicationTurn: APPLICATION_TURN_WAKE,
      attachments: [],
      ...wakeAuthority(summary),
    };
    inFlight.add(sessionId);
    let result;
    try {
      result = await submitTurn(request, { idempotencyKey: jobWakeIdempotencyKey(jobIds) });
    } catch {
      result = { ok: false, reason: 'runtime_submission_refused' };
    } finally {
      inFlight.delete(sessionId);
    }
    if (result?.ok === true) {
      boundedSet(wakes, sessionId, [...(wakes.get(sessionId) || []), read(now, Date.now())], maxTracked);
      log('INFO', 'background_job_wake.submitted', { session_id: sessionId, job_count: jobs.length });
      return { outcome: 'submitted', turn_id: typeof result.turn_id === 'string' ? result.turn_id : null };
    }
    const reason = typeof result?.reason === 'string' ? result.reason : 'runtime_submission_refused';
    log('WARN', 'background_job_wake.refused', { session_id: sessionId, job_count: jobs.length, reason });
    if (DEFER_REASONS.has(reason)) {
      // Busy after all (a send raced the idle test): back to pending for that turn's settle.
      for (const job of jobs) if (!resultRead.has(job.jobId)) boundedSet(pending, job.jobId, job, maxTracked);
      return { outcome: 'deferred' };
    }
    return { outcome: 'refused', reason };
  }

  // A tracked job moved to completed/failed (background-job-tracker onJobSettled). Never throws.
  async function onJobSettled(job) {
    try {
      const jobId = typeof job?.jobId === 'string' ? job.jobId : '';
      const sessionId = typeof job?.sessionId === 'string' ? job.sessionId : '';
      if (!jobId || !sessionId || resultRead.has(jobId)) return { outcome: 'not_needed' };
      if (job.stopRequested === true) {
        boundedSet(stopped, jobId, {
          jobId, sessionId, command: job.command, state: 'stopped', exitCode: null, endedAtMs: job.endedAtMs,
        }, maxTracked);
        return pushStopped(sessionId);
      }
      boundedSet(pending, jobId, {
        jobId, sessionId, command: job.command, state: job.state, exitCode: job.exitCode, endedAtMs: job.endedAtMs,
      }, maxTracked);
      return await route(sessionId);
    } catch {
      log('WARN', 'background_job_wake.failed', { reason: 'exception' });
      return { outcome: 'refused', reason: 'exception' };
    }
  }

  // That chat's turn ended: a job that settled during it and was not read wakes the chat now. Never throws.
  async function onTurnSettled(sessionId) {
    try {
      return await route(String(sessionId || ''));
    } catch {
      log('WARN', 'background_job_wake.failed', { reason: 'exception' });
      return { outcome: 'refused', reason: 'exception' };
    }
  }

  // That chat's chat.send just went out: its first step hears about any held stop. Never throws.
  function onTurnStarted(sessionId) {
    try {
      return pushStopped(String(sessionId || ''));
    } catch {
      log('WARN', 'background_job_wake.failed', { reason: 'exception' });
      return { outcome: 'held' };
    }
  }

  function stats() {
    return { pending: pending.size, read: resultRead.size, rate_sessions: wakes.size, stopped: stopped.size };
  }

  return { noteResultRead, onJobSettled, onTurnSettled, onTurnStarted, stats };
}

// The ports, from the backend service the tracker and chat streams already hang off.
function wireBackgroundJobWake(backendService, tracker, { log = () => {} } = {}) {
  const store = () => backendService.sessionStore || null;
  const runtime = () => backendService.sessionRuntime || null;
  const ops = createBackgroundJobWakeOps({
    enabled: () => backendService.featureFlags?.background_job_wake !== false,
    paused: (sessionId) => backendService.primaryChatControls?.isPaused?.(sessionId) === true,
    storeReadOnly: () => store()?.hasNewerSchema?.() === true,
    getSessionSummary: (sessionId) => store()?.getSessionSummary?.(sessionId) || null,
    getActiveTurn: (sessionId) => (typeof store()?.peekActiveTurn === 'function'
      ? store().peekActiveTurn(sessionId) || null : store()?.getActiveTurn?.(sessionId) || null),
    hasSessionWork: (sessionId) => runtime()?.hasSessionWork?.(sessionId) === true,
    deliverMidTurn: (sessionId, jobs) => pushMidTurnJobNotices(backendService, { sessionId, jobs }),
    submitTurn: async (request, options) => (typeof runtime()?.submitApplicationTurn === 'function'
      ? runtime().submitApplicationTurn(request, options) : RUNTIME_ABSENT),
    log,
  });
  tracker?.onJobSettled?.((job) => { void ops.onJobSettled(job); });
  backendService.on('background-job-read', (info) => ops.noteResultRead(info?.jobId));
  backendService.on('chat-stream', (event) => {
    if (isTurnSettledEvent(event)) void ops.onTurnSettled(event.sessionId || event.session_id);
  });
  backendService.backgroundJobWake = ops;
  return ops;
}

module.exports = {
  createBackgroundJobWakeOps,
  jobWakeIdempotencyKey,
  jobWakePrompt,
  wireBackgroundJobWake,
};
