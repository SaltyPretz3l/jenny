'use strict';

// The job table of the team pool scheduler (row 123, slice 4a-1; spec "Job state
// table"). Pure: no timers and no I/O. Every job state change goes through
// transitionJob, which names the from-state, the to-state and the trigger and
// refuses anything outside JOB_TRANSITIONS without changing the record. Node
// output is untrusted: it is bounded, and a stream job's output is scanned only
// for SSE line ends and the `data: [DONE]` line, never parsed. A non-stream job
// (a plain JSON reply) is bounded per chunk and per job only.

const { newId } = require('./state');

const JOB_STATES = Object.freeze(['queued', 'claimed', 'streaming', 'done', 'failed', 'cancelled']);
const JOB_TERMINAL = Object.freeze(new Set(['done', 'failed', 'cancelled']));
const JOB_LIVE = Object.freeze(new Set(['queued', 'claimed', 'streaming']));
const JOB_RUNNING = Object.freeze(new Set(['claimed', 'streaming']));

// 'from>to' -> the triggers that may cause it. 'new' is a job being created. A
// claimed job never returns to queued.
const JOB_TRANSITIONS = Object.freeze({
  'new>queued': Object.freeze(['accepted']),
  'queued>claimed': Object.freeze(['claimed']),
  'queued>queued': Object.freeze(['requeued']),
  'queued>failed': Object.freeze(['wait_timeout', 'lease_terminal']),
  'claimed>streaming': Object.freeze(['first_chunk']),
  'claimed>failed': Object.freeze(['first_byte_timeout', 'job_timeout', 'node_fail', 'node_lost', 'node_stopped',
    'stream_incomplete']),
  'claimed>cancelled': Object.freeze(['request_closed', 'lease_cancelled']),
  // closed_after_done: the gateway request closed after the stream carried [DONE].
  'streaming>done': Object.freeze(['final_chunk', 'closed_after_done']),
  'streaming>failed': Object.freeze(['stall_timeout', 'job_timeout', 'size_bound', 'node_fail', 'node_lost',
    'node_stopped', 'stream_incomplete']),
  'streaming>cancelled': Object.freeze(['request_closed', 'lease_cancelled']),
});

const JOB_REFUSED = Object.freeze({ ok: false, reason: 'job_transition_refused' });

function transitionJob(record, from, to, trigger, reason, now) {
  const actual = record.state === undefined ? 'new' : record.state;
  const allowed = JOB_TRANSITIONS[`${from}>${to}`];
  if (actual !== from || !allowed || !allowed.includes(trigger)) return JOB_REFUSED;
  record.state = to;
  record.reason = reason === undefined ? null : reason;
  if (to === 'claimed') record.claimed_at = now;
  if (to === 'streaming' || JOB_TERMINAL.has(to)) record.request = null;
  if (trigger === 'requeued') record.requeued = true;
  if (JOB_TERMINAL.has(to)) record.terminal_at = now;
  return { ok: true, transition: { table: 'job', from, to, trigger, reason: record.reason } };
}

// ---------------------------------------------------------------------------
// The SSE scan: decides what a chunk does without changing the job.

const DONE_LINE = /^data: ?\[DONE\]\r?$/u;
const HEAD_CHARS = 16;
const MIN_DONE_BYTES = 'data:[DONE]'.length;

function isDoneLine(head, lineBytes) {
  return lineBytes >= MIN_DONE_BYTES && lineBytes <= HEAD_CHARS && DONE_LINE.test(head);
}

/**
 * Returns { lineBytes, head, sawDone, violation } for the job after `bytes`;
 * violation is 'frame_too_large' or 'output_too_large' or null. `final` treats
 * the end of the chunk as a line end.
 */
function scanChunk(job, bytes, final, limits) {
  if (job.total_bytes + bytes.length > limits.maxJobBytes) {
    return { lineBytes: job.line_bytes, head: job.line_head, sawDone: job.saw_done, violation: 'output_too_large' };
  }
  if (!job.stream) return { lineBytes: 0, head: '', sawDone: false, violation: null };
  let lineBytes = job.line_bytes;
  let head = job.line_head;
  let sawDone = job.saw_done;
  let start = 0;
  while (start <= bytes.length) {
    const newline = bytes.indexOf(0x0a, start);
    const end = newline === -1 ? bytes.length : newline;
    lineBytes += end - start;
    if (lineBytes > limits.maxLineBytes) return { lineBytes, head, sawDone, violation: 'frame_too_large' };
    if (end > start && head.length < HEAD_CHARS) {
      head += bytes.subarray(start, Math.min(end, start + HEAD_CHARS - head.length)).toString('latin1');
    }
    if (newline === -1) break;
    if (isDoneLine(head, lineBytes)) sawDone = true;
    lineBytes = 0;
    head = '';
    start = newline + 1;
  }
  if (final && lineBytes > 0 && isDoneLine(head, lineBytes)) sawDone = true;
  return { lineBytes, head, sawDone, violation: null };
}

// ---------------------------------------------------------------------------
// Job table. Live jobs are bounded by the active leases (one live job each);
// terminal jobs by limits.maxTerminalJobs and limits.terminalKeepMs.

function createJobTable({ limits, randomBytes }) {
  const jobs = new Map(); // job_id -> record
  let seq = 0;

  // Takes ownership of requestBytes: the caller must not change the buffer afterwards.
  function create(lease, requestBytes, stream, now) {
    const record = {
      job_id: newId('job_', randomBytes), lease_id: lease.lease_id, node_id: lease.node_id, member_id: lease.member_id,
      model: lease.model, stream, state: undefined, reason: null, seq: seq++, continuation: lease.job_count > 0,
      created_at: now, claimed_at: null, last_data_at: null, terminal_at: null, requeued: false,
      request: requestBytes, request_bytes: requestBytes.length, claim_seq: null, next_seq: 0, total_bytes: 0,
      line_bytes: 0, line_head: '', saw_done: false, watchers: [],
    };
    const result = transitionJob(record, 'new', 'queued', 'accepted', null, now);
    jobs.set(record.job_id, record);
    return { record, transition: result.transition };
  }

  // The job table's one transition function.
  function transition(record, from, to, trigger, reason, now) {
    const result = transitionJob(record, from, to, trigger, reason, now);
    if (result.ok && JOB_TERMINAL.has(to)) trimTerminal();
    return result;
  }

  function trimTerminal() {
    const terminal = [...jobs.values()].filter((job) => JOB_TERMINAL.has(job.state));
    terminal.sort((a, b) => a.terminal_at - b.terminal_at || a.seq - b.seq);
    for (let i = 0; i < terminal.length - limits.maxTerminalJobs; i += 1) jobs.delete(terminal[i].job_id);
  }

  function purge(now) {
    for (const job of [...jobs.values()]) {
      if (JOB_TERMINAL.has(job.state) && now - job.terminal_at >= limits.terminalKeepMs) {
        job.watchers = [];
        jobs.delete(job.job_id);
      }
    }
  }

  // Applies a scan decided by scanChunk: the counters only.
  function applyScan(record, scan, bytes, now) {
    Object.assign(record, {
      next_seq: record.next_seq + 1, line_bytes: scan.lineBytes, line_head: scan.head, saw_done: scan.sawDone,
      total_bytes: record.total_bytes + bytes.length,
      last_data_at: bytes.length > 0 ? now : record.last_data_at,
    });
  }

  return {
    get: (jobId) => (typeof jobId === 'string' ? jobs.get(jobId) || null : null),
    all: () => [...jobs.values()],
    create,
    transition,
    purge,
    applyScan,
  };
}

// What the claiming node receives.
function claimDescriptor(record, limits) {
  return {
    job_id: record.job_id, lease_id: record.lease_id, model: record.model, request_bytes: record.request_bytes,
    first_byte_ms: limits.firstByteMs, stall_ms: limits.stallMs, total_ms: limits.jobTotalMs,
  };
}

// The job as callers see it. No request or response bytes.
function jobView(record) {
  return {
    job_id: record.job_id, lease_id: record.lease_id, node_id: record.node_id, stream: record.stream,
    state: record.state, reason: record.reason, continuation: record.continuation, request_bytes: record.request_bytes,
    next_seq: record.next_seq, total_bytes: record.total_bytes, created_at: record.created_at,
    claimed_at: record.claimed_at, terminal_at: record.terminal_at,
  };
}

module.exports = {
  JOB_LIVE, JOB_RUNNING, JOB_STATES, JOB_TERMINAL, JOB_TRANSITIONS, claimDescriptor, createJobTable, jobView,
  scanChunk, transitionJob,
};
