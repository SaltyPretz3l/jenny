'use strict';

// Mid-turn background-job notices (row 71, waits half): a background run_command job that settles while
// its chat's managed turn is still working is pushed to the sidecar (`session.job_settled`); the tool loop
// tells the model before its next step and acknowledges with `session.job_notice_consumed`, which marks the
// jobs read (`background-job-read`) so the post-turn wake (background-job-wake.js) skips them. A push that
// is never acknowledged leaves the job pending there, so that wake still delivers it: the push needs no
// capability negotiation and reserves nothing. Logs carry counts and reasons, never a command.

const { BACKGROUND_JOB_ID_PATTERN } = require('./chat-stream-background-jobs');
const { acceptMailConsumedNotification, liveManagedStream } = require('./session-mail-mid-turn');
const { notifyJobSettled } = require('./sidecar-client-notifications');

const COMMAND_PROMPT_CHARS = 120;
const MAX_JOBS_PER_FRAME = 8;
const MAX_ACK_IDS = 16;
const SETTLED_STATES = new Set(['completed', 'failed', 'stopped']); // stopped: the person pressed Stop
// stream ctx -> Set<job id> already sent on that stream: a re-check never resends, a newer stream may.
const pushedByStream = new WeakMap();

const refuse = (reason) => ({ ok: false, reason });

// A job's command as model-facing prompt text (this notice and the post-turn wake): one line, no backticks.
function promptCommand(raw) {
  const clean = String(raw ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}`]/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > COMMAND_PROMPT_CHARS ? `${clean.slice(0, COMMAND_PROMPT_CHARS - 1)}…` : clean;
}

function log(service, level, event, details) {
  try {
    service?._emitServiceLog?.(level, event, details);
  } catch {
    // Diagnostics never change the turn.
  }
}

function wireJob(job) {
  return {
    job_id: job.jobId,
    command: promptCommand(job.command),
    state: job.state,
    exit_code: Number.isInteger(job.exitCode) ? job.exitCode : null,
  };
}

// {ok: true, pushed} or {ok: false, reason}. `jobs` are the wake's pending snapshots, oldest first.
// Never throws.
function pushMidTurnJobNotices(service, { sessionId, jobs } = {}) {
  try {
    if (service?.featureFlags?.background_job_notices === false) return refuse('disabled');
    const id = String(sessionId || '').trim();
    const ctx = id ? liveManagedStream(service, id) : null;
    if (!ctx) return refuse('no_live_stream');
    let pushedIds = pushedByStream.get(ctx);
    if (!pushedIds) {
      pushedIds = new Set();
      pushedByStream.set(ctx, pushedIds);
    }
    const fresh = [];
    for (const job of Array.isArray(jobs) ? jobs : []) {
      if (fresh.length >= MAX_JOBS_PER_FRAME) break;
      const jobId = typeof job?.jobId === 'string' ? job.jobId : '';
      if (!BACKGROUND_JOB_ID_PATTERN.test(jobId) || !SETTLED_STATES.has(job.state)) continue;
      if (pushedIds.has(jobId) || fresh.some((entry) => entry.job_id === jobId)) continue;
      fresh.push(wireJob(job));
    }
    if (!fresh.length) return refuse('nothing_to_push');
    const sent = notifyJobSettled(service.sidecarClient, { sessionId: id, requestId: ctx.streamId, jobs: fresh }) === true;
    if (!sent) {
      log(service, 'INFO', 'chat.background_job_notice_send_failed', { sessionId: id, streamId: ctx.streamId, count: fresh.length });
      return refuse('send_failed');
    }
    for (const entry of fresh) pushedIds.add(entry.job_id);
    log(service, 'INFO', 'chat.background_job_notice_pushed', { sessionId: id, streamId: ctx.streamId, count: fresh.length });
    return { ok: true, pushed: fresh.length };
  } catch {
    return refuse('exception');
  }
}

// Router entry for `session.job_notice_consumed`: every well-formed id is marked read (the wake's
// listener drops it from its pending set). Anything malformed is ignored. Returns the count emitted.
function acceptJobNoticeConsumedNotification(ctx, params) {
  try {
    const service = ctx?.service;
    const ids = params?.job_ids;
    if (!Array.isArray(ids) || typeof service?.emit !== 'function') return 0;
    let marked = 0;
    for (const jobId of ids.slice(0, MAX_ACK_IDS)) {
      if (typeof jobId !== 'string' || !BACKGROUND_JOB_ID_PATTERN.test(jobId)) continue;
      service.emit('background-job-read', { jobId });
      marked += 1;
    }
    log(service, 'INFO', 'chat.background_job_notice_consumed', {
      sessionId: ctx.resolvedSessionId, streamId: ctx.streamId, count: marked,
    });
    return marked;
  } catch {
    return 0;
  }
}

// Acknowledgement methods the managed stream routes by name (chat-stream-managed-runtime-notifications.js):
// ids only, no rows or text; mail rows persist at the terminal settle, job ids become reads.
const MID_TURN_ACKS = new Map([
  ['session.mail_consumed', acceptMailConsumedNotification],
  ['session.job_notice_consumed', acceptJobNoticeConsumedNotification],
]);

module.exports = {
  MID_TURN_ACKS,
  acceptJobNoticeConsumedNotification,
  promptCommand,
  pushMidTurnJobNotices,
};
