// Background-job visibility tracker (cohesiveness QoL W2-2).
//
// `run_command` background jobs execute inside the builtin MCP server
// subprocess and outlive the tool call, so the W2-1 per-call streaming wire
// cannot carry their lifecycle. Instead, Electron owns visibility: the tool
// result's `metadata.background_job_id` registers the job here, and this
// tracker polls the job's `status.json` (written by the sidecar's waiter
// thread under `<workspace>/.jenny/tool-results/<job_id>/`) and pushes
// bounded snapshots to the renderer over the bridge-event bus
// (`backgroundJobs.onChanged`) — never the turn-scoped chat stream.
//
// Kill is an OS pid-tree kill: the builtin server's waiter thread observes
// the process death and publishes the authoritative terminal status itself,
// so no cross-process control API is needed.

const fs = require('fs');
const path = require('path');
const { isProcessAlive, killProcessTree, getProcessStartTime } = require('../backend/process-utils');

// Mirrors the canonical job-ID format minted by shell_background.py
// (uuid4().hex[:12]) — anything else is refused before any path join
// (WIDE-011 posture).
const JOB_ID_PATTERN = /^[0-9a-f]{12}$/;
// Mirrors sidecar shell_background_status.MAX_STATUS_FILE_BYTES: bounds the
// read before JSON.parse so an oversized/hostile status file cannot force an
// unbounded in-memory parse on the Electron side either.
const MAX_STATUS_FILE_BYTES = 262_144;
const POLL_INTERVAL_MS = 1_500;
// A "running" status whose pid has been dead this long is settled locally as
// failed — the sidecar reconciles orphaned statuses only when the MODEL polls
// (read_background_job), which never happens for a chip-only observer.
const DEAD_PID_GRACE_MS = 10_000;
// Missing status.json right after registration is a startup race (the initial
// status write is ordered before the tool result, but the fs is not atomic
// with our poll); missing this long means the job dir was swept or never
// materialized.
const MISSING_STATUS_GRACE_MS = 10_000;
const TERMINAL_RETENTION_MS = 5 * 60_000;
// A process that survives the polite kill this long gets the forceful one so a
// trapped SIGTERM cannot leave the chip stuck "Stopping…".
const KILL_ESCALATION_MS = 5_000;
const MAX_TRACKED_JOBS = 32;
const MAX_COMMAND_CHARS = 400;
const MAX_ERROR_CHARS = 400;
const MAX_STATUS_FAILURES = 3;

function defaultReadStatusFile(statusPath) {
  // Bounded read: open + read at most MAX_STATUS_FILE_BYTES + 1 so an
  // oversized file is detectable without slurping it.
  let fd = null;
  try {
    fd = fs.openSync(statusPath, 'r');
    const buffer = Buffer.alloc(MAX_STATUS_FILE_BYTES + 1);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_STATUS_FILE_BYTES) {
      return { ok: false, reason: 'status_too_large' };
    }
    return { ok: true, text: buffer.toString('utf8', 0, bytesRead) };
  } catch (error) {
    return {
      ok: false,
      reason: error && error.code === 'ENOENT' ? 'not_found' : 'read_failed',
    };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_error) { /* best-effort close */ }
    }
  }
}

async function defaultKillPidTree(pid, { platform = process.platform, force = false } = {}) {
  try {
    const result = await killProcessTree(pid, { platform, force: platform === 'win32' || force,
      processGroup: platform !== 'win32' });
    return { ok: result?.terminated === true, reason: result?.terminated ? '' : 'kill_failed' };
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) };
  }
}

function normalizePid(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function createBackgroundJobTracker({
  getWorkspaceRoot = () => '',
  sendBridgeEvent = () => {},
  log = () => {},
  readStatusFileImpl = defaultReadStatusFile,
  isPidAliveImpl = isProcessAlive,
  killPidTreeImpl = defaultKillPidTree,
  getProcessStartTimeImpl = getProcessStartTime,
  nowImpl = () => Date.now(),
  pollIntervalMs = POLL_INTERVAL_MS,
  platform = process.platform,
} = {}) {
  /** @type {Map<string, Object>} jobId -> tracked job record */
  const jobs = new Map();
  let pollTimer = null;
  let disposed = false;

  function snapshotJob(job) {
    return {
      jobId: job.jobId,
      sessionId: job.sessionId,
      command: job.command,
      toolCallId: job.toolCallId,
      state: job.state,
      pid: job.pid,
      exitCode: job.exitCode,
      error: job.error,
      startedAtMs: job.startedAtMs,
      endedAtMs: job.endedAtMs,
      outputTruncated: job.outputTruncated === true,
    };
  }

  function getState() {
    return {
      jobs: Array.from(jobs.values()).map(snapshotJob),
      generatedAt: new Date(nowImpl()).toISOString(),
    };
  }

  function emitChanged() {
    try {
      sendBridgeEvent('backgroundJobs.onChanged', getState());
    } catch (error) {
      log('WARN', 'background_jobs.bridge_emit_failed', {
        message: String((error && error.message) || error),
      });
    }
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function ensurePolling() {
    // The timer runs while ANY job is tracked — including settled ones —
    // because retention pruning has no other callback; gating on active jobs
    // alone leaves terminal chips undeletable.
    if (disposed || pollTimer !== null || jobs.size === 0) {
      return;
    }
    pollTimer = setInterval(() => pollNow(), pollIntervalMs);
    if (typeof pollTimer.unref === 'function') {
      pollTimer.unref();
    }
  }

  function settleLocally(job, error) {
    job.state = 'failed';
    job.error = String(error || '').slice(0, MAX_ERROR_CHARS);
    job.endedAtMs = nowImpl();
  }

  function recordStatusFailure(job, error) {
    job.statusFailures += 1;
    job.error = error;
    if (job.statusFailures >= MAX_STATUS_FAILURES) settleLocally(job, error);
  }

  function lookupStartTime(pid) {
    return Promise.resolve().then(() => getProcessStartTimeImpl(pid, { platform }))
      .then((value) => String(value || ''), () => '');
  }

  // A failed lookup refuses the signal but keeps the job running and Stop
  // retryable; only a different creation time proves our process is gone.
  // The baseline comes only from registration: taken at Stop, it could be a
  // replacement process's identity, which the next lookup would then match.
  async function verifyProcessIdentity(job) {
    await job.identityReady;
    if (!job.processStartTime) return false;
    const current = await lookupStartTime(job.pid);
    if (current === job.processStartTime) return true;
    if (current) settleLocally(job, 'Background job process can no longer be verified.');
    return false;
  }

  function pruneJobs() {
    const now = nowImpl();
    for (const [jobId, job] of jobs) {
      const terminal = job.state !== 'running' && job.state !== 'killing';
      if (terminal && job.endedAtMs && now - job.endedAtMs > TERMINAL_RETENTION_MS) {
        jobs.delete(jobId);
      }
    }
  }

  function applyStatusPayload(job, payload) {
    const state = String(payload.state || '');
    // PID trust: status.json lives in the workspace, which the background
    // command itself (or any workspace writer) can rewrite — it NEVER grants
    // kill authority. The kill target is bound once at registration from the
    // sidecar's trusted tool-result channel; the file's pid is display-only
    // and divergence is logged and ignored.
    const payloadPid = normalizePid(payload.pid);
    if (payloadPid && job.pid !== null && payloadPid !== job.pid) {
      log('WARN', 'background_jobs.status_pid_divergence_ignored', {
        jobId: job.jobId,
      });
    }
    if (state === 'running') {
      // A kill in flight stays 'killing' until the waiter publishes terminal
      // status (or the dead-pid grace settles it) — flapping back to
      // 'running' would re-arm the chip's kill button mid-kill.
      if (job.state !== 'killing') {
        job.state = 'running';
      }
      return;
    }
    if (state === 'completed' || state === 'failed') {
      job.state = state;
      job.exitCode = Number.isInteger(payload.exit_code) ? payload.exit_code : null;
      job.error = String(payload.error || '').slice(0, MAX_ERROR_CHARS);
      job.outputTruncated = payload.output_truncated === true;
      job.endedAtMs = job.endedAtMs || nowImpl();
      return;
    }
    // Unknown/hostile state strings degrade to a local failure rather than
    // rendering attacker-controlled text as a chip state.
    recordStatusFailure(job, 'background job reported an unrecognized state');
  }

  function pollJob(job) {
    const read = job.statusPath ? readStatusFileImpl(job.statusPath) : { ok: false, reason: 'read_failed' };
    const now = nowImpl();
    if (!read.ok) {
      if (read.reason === 'not_found' && now - job.startedAtMs < MISSING_STATUS_GRACE_MS) {
        return; // startup race: the initial status write may still be landing
      }
      recordStatusFailure(job, read.reason === 'not_found'
        ? 'background job status was not found'
        : `background job status could not be read (${read.reason})`);
      return;
    }
    let payload;
    try {
      payload = JSON.parse(read.text);
    } catch (_error) {
      payload = null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      recordStatusFailure(job, 'background job status was malformed');
      return;
    }
    if (payload.state === 'running' || payload.state === 'completed' || payload.state === 'failed') {
      job.statusFailures = 0;
      job.error = '';
    }
    applyStatusPayload(job, payload);
    if (job.state !== 'running' && job.state !== 'killing') {
      return;
    }
    // Liveness backstop: a dead pid with a stuck "running" status means the
    // waiter thread died with the sidecar — settle locally after the grace.
    if (job.pid && !isPidAliveImpl(job.pid)) {
      if (!job.pidDeadSinceMs) {
        job.pidDeadSinceMs = now;
      } else if (now - job.pidDeadSinceMs > DEAD_PID_GRACE_MS) {
        settleLocally(job, 'background job process exited before its status was recorded');
      }
      return;
    }
    job.pidDeadSinceMs = 0;
    // Kill escalation: a process that traps SIGTERM
    // would otherwise pin the chip on "Stopping…" until its own timeout.
    if (
      job.state === 'killing'
      && job.pid
      && job.killRequestedAtMs
      && !job.killEscalated
      && now - job.killRequestedAtMs > KILL_ESCALATION_MS
    ) {
      job.killEscalated = true;
      verifyProcessIdentity(job).then((verified) => {
        if (!verified) {
          job.killEscalated = job.state !== 'killing';
          return null;
        }
        log('WARN', 'background_jobs.kill_escalated', { jobId: job.jobId });
        return killPidTreeImpl(job.pid, { platform, force: true });
      }).catch(() => {});
    }
  }

  function pollNow() {
    if (disposed) {
      return;
    }
    let changed = false;
    for (const job of jobs.values()) {
      if (job.state !== 'running' && job.state !== 'killing') {
        continue;
      }
      const before = `${job.state}:${job.pid}:${job.exitCode}:${job.error}`;
      pollJob(job);
      if (`${job.state}:${job.pid}:${job.exitCode}:${job.error}` !== before) {
        changed = true;
      }
    }
    const sizeBefore = jobs.size;
    pruneJobs();
    if (jobs.size === 0) {
      stopPolling();
    }
    if (changed || jobs.size !== sizeBefore) {
      emitChanged();
    }
  }

  function registerJob({ jobId, sessionId, command, toolCallId, pid, workspaceRoot: jobRoot } = {}) {
    const normalizedJobId = String(jobId || '').trim();
    if (disposed || !JOB_ID_PATTERN.test(normalizedJobId) || jobs.has(normalizedJobId)) {
      return false;
    }
    const workspaceRoot = String(jobRoot || getWorkspaceRoot() || '').trim();
    if (!workspaceRoot) {
      log('WARN', 'background_jobs.register_without_workspace_root', { jobId: normalizedJobId });
      return false;
    }
    if (jobs.size >= MAX_TRACKED_JOBS) {
      pruneJobs();
      if (jobs.size >= MAX_TRACKED_JOBS) {
        log('WARN', 'background_jobs.tracked_job_cap_reached', { jobId: normalizedJobId });
        return false;
      }
    }
    jobs.set(normalizedJobId, {
      jobId: normalizedJobId,
      sessionId: String(sessionId || '').trim(),
      command: String(command || '').slice(0, MAX_COMMAND_CHARS),
      toolCallId: String(toolCallId || '').trim(),
      // The workspace root is captured at registration: a later root switch
      // must not redirect this job's status path to a different tree.
      statusPath: path.join(workspaceRoot, '.jenny', 'tool-results', normalizedJobId, 'status.json'),
      state: 'running',
      // Kill authority: ONLY the PID carried through the trusted registration
      // path (the sidecar tool result). Never assigned from status.json.
      pid: normalizePid(pid),
      processStartTime: '',
      identityReady: null,
      statusFailures: 0,
      exitCode: null,
      error: '',
      startedAtMs: nowImpl(),
      endedAtMs: 0,
      pidDeadSinceMs: 0,
      killRequestedAtMs: 0,
      killEscalated: false,
      outputTruncated: false,
    });
    const registered = jobs.get(normalizedJobId);
    if (registered.pid) {
      registered.identityReady = lookupStartTime(registered.pid).then((value) => { registered.processStartTime = value; });
    }
    log('INFO', 'background_jobs.registered', { jobId: normalizedJobId });
    emitChanged();
    ensurePolling();
    return true;
  }

  async function killJob(jobId) {
    const normalizedJobId = String(jobId || '').trim();
    const job = JOB_ID_PATTERN.test(normalizedJobId) ? jobs.get(normalizedJobId) : null;
    if (!job) {
      return { ok: false, reason: 'unknown_job' };
    }
    if (job.state !== 'running' && job.state !== 'killing') {
      return { ok: false, reason: 'not_running' };
    }
    if (!job.pid) {
      // No trusted PID arrived at registration; refuse rather than derive
      // one from the workspace-writable status file.
      return { ok: false, reason: 'pid_unknown' };
    }
    // Sensitive-pid floor: defense in depth — never aim the kill at the
    // system, this process, or its parent.
    if (job.pid <= 4 || job.pid === process.pid || job.pid === process.ppid) {
      log('WARN', 'background_jobs.kill_refused_sensitive_pid', { jobId: normalizedJobId });
      return { ok: false, reason: 'pid_refused' };
    }
    if (!(await verifyProcessIdentity(job))) {
      emitChanged();
      return { ok: false, reason: 'pid_identity_unverified' };
    }
    job.state = 'killing';
    job.killRequestedAtMs = nowImpl();
    emitChanged();
    ensurePolling();
    const result = await killPidTreeImpl(job.pid, { platform });
    log(result.ok ? 'INFO' : 'WARN', 'background_jobs.kill_dispatched', {
      jobId: normalizedJobId,
      ok: result.ok === true,
      reason: String(result.reason || ''),
    });
    if (
      !result.ok
      && job.state === 'killing'
      && jobs.has(normalizedJobId)
      && isPidAliveImpl(job.pid)
    ) {
      // The kill never reached a still-live process; re-arm the chip instead
      // of leaving it stuck in 'killing' forever. A dead pid stays 'killing'
      // — the poll's liveness backstop settles it.
      job.state = 'running';
      emitChanged();
    }
    return { ok: result.ok === true, reason: String(result.reason || '') };
  }

  function dispose() {
    disposed = true;
    stopPolling();
    jobs.clear();
  }

  return {
    registerJob,
    killJob,
    getState,
    pollNow,
    dispose,
  };
}

module.exports = {
  createBackgroundJobTracker,
  JOB_ID_PATTERN,
  MAX_STATUS_FILE_BYTES,
  DEAD_PID_GRACE_MS,
  KILL_ESCALATION_MS,
  MISSING_STATUS_GRACE_MS,
  TERMINAL_RETENTION_MS,
};
