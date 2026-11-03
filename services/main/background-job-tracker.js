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
//
// Finished jobs stay as the chat's history (the Session rail's Background
// tasks list): the newest MAX_FINISHED_PER_SESSION per session, evicted by
// count, never by time. In-process subscribers (`onChanged`, `onJobSettled`)
// let the rail invalidate without a second poll.

const fs = require('fs');
const path = require('path');
const { isProcessAlive, killProcessTree, getProcessStartTime } = require('../backend/process-utils');
const { readBoundedTextFile, readJobProgress } = require('./background-job-progress');

const { BACKGROUND_JOB_ID_PATTERN: JOB_ID_PATTERN } = require('../backend/chat-stream-background-jobs'); // shell_background.py's uuid4().hex[:12]; anything else is refused before a path join (WIDE-011)
// Mirrors sidecar shell_background_status.MAX_STATUS_FILE_BYTES: bounds the read before JSON.parse so an
// oversized/hostile status file cannot force an unbounded in-memory parse on the Electron side either.
const MAX_STATUS_FILE_BYTES = 262_144;
const POLL_INTERVAL_MS = 1_500;
// A "running" status whose pid has been dead this long is settled locally as
// failed — the sidecar reconciles orphaned statuses only when the MODEL polls
// (read_background_job), which never happens for a rail-only observer.
const DEAD_PID_GRACE_MS = 10_000;
// Missing status.json right after registration is a startup race (the initial
// status write is ordered before the tool result, but the fs is not atomic
// with our poll); missing this long means the job dir was swept or never
// materialized.
const MISSING_STATUS_GRACE_MS = 10_000;
// A process that survives the polite kill this long gets the forceful one so a
// trapped SIGTERM cannot leave the row stuck "Stopping…".
const KILL_ESCALATION_MS = 5_000;
// Global ceiling across sessions; at the cap the oldest finished job is
// evicted (a running/killing job never is).
const MAX_TRACKED_JOBS = 128;
const MAX_FINISHED_PER_SESSION = 20;
// readOutput tail bounds: the rail's inline output view, not a log viewer.
const MAX_OUTPUT_LINES = 60;
const MAX_OUTPUT_CHARS = 8_000;
const MAX_COMMAND_CHARS = 400;
const MAX_ERROR_CHARS = 400;
const MAX_STATUS_FAILURES = 3;

function defaultReadStatusFile(statusPath) {
  // Bounded read: an oversized file is detectable without slurping it.
  const read = readBoundedTextFile(statusPath, MAX_STATUS_FILE_BYTES);
  return read.reason === 'too_large' ? { ok: false, reason: 'status_too_large' } : read;
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

// Row 96: listeners refetch the whole workspace summary, so a running test job only
// notifies them per 5% step or new failure; finer progress goes out on the bridge push.
function changeKey(job) {
  const progress = job.progress;
  const step = progress ? `${Math.floor((progress.percent ?? -5) / 5)}:${progress.failed}` : '';
  return `${job.state}:${job.pid}:${job.exitCode}:${job.error}:${step}`;
}

function isLive(job) {
  return job.state === 'running' || job.state === 'killing';
}

// Newest first: by timestamp, then registration order for equal stamps.
function newestFirst(field) {
  return (left, right) => (right[field] - left[field]) || (right.seq - left.seq);
}

// Last MAX_OUTPUT_LINES lines and MAX_OUTPUT_CHARS characters of the status
// file's captured stdout (+ stderr after a blank line). Text is data only.
function tailOutput(payload) {
  const stdout = typeof payload.stdout === 'string' ? payload.stdout : '';
  const stderr = typeof payload.stderr === 'string' ? payload.stderr : '';
  let text = stderr.trim()
    ? (stdout.trim() ? `${stdout.replace(/[\r\n]+$/, '')}\n\n${stderr}` : stderr)
    : stdout;
  text = text.replace(/[\r\n]+$/, '');
  let truncated = payload.output_truncated === true;
  const lines = text.split('\n');
  if (lines.length > MAX_OUTPUT_LINES) {
    text = lines.slice(-MAX_OUTPUT_LINES).join('\n');
    truncated = true;
  }
  if (text.length > MAX_OUTPUT_CHARS) {
    text = text.slice(-MAX_OUTPUT_CHARS);
    // Never start on the low half of a split surrogate pair.
    if (/^[\udc00-\udfff]/.test(text)) text = text.slice(1);
    truncated = true;
  }
  return { text, truncated };
}

function createBackgroundJobTracker({
  getWorkspaceRoot = () => '',
  sendBridgeEvent = () => {},
  log = () => {},
  readStatusFileImpl = defaultReadStatusFile,
  readProgressFileImpl = readJobProgress, // row 96: progress.json beside status.json
  isPidAliveImpl = isProcessAlive,
  killPidTreeImpl = defaultKillPidTree,
  getProcessStartTimeImpl = getProcessStartTime,
  fileExistsImpl = (filePath) => fs.existsSync(filePath),
  nowImpl = () => Date.now(),
  pollIntervalMs = POLL_INTERVAL_MS,
  platform = process.platform,
} = {}) {
  /** @type {Map<string, Object>} jobId -> tracked job record */
  const jobs = new Map();
  const changeListeners = new Set();
  const settleListeners = new Set();
  let pollTimer = null;
  let disposed = false;
  let registrationSeq = 0;

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
      stopRequested: job.stopRequested === true,
      progress: isLive(job) ? job.progress : null,
    };
  }

  function notifyListeners(listeners, value, event) {
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (error) {
        log('WARN', event, { message: String((error && error.message) || error) });
      }
    }
  }

  function subscribe(listeners, listener) {
    if (disposed || typeof listener !== 'function') return () => {};
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }

  function getState() {
    return {
      jobs: Array.from(jobs.values()).map(snapshotJob),
      generatedAt: new Date(nowImpl()).toISOString(),
    };
  }

  function emitBridgeState() {
    try {
      sendBridgeEvent('backgroundJobs.onChanged', getState());
    } catch (error) {
      log('WARN', 'background_jobs.bridge_emit_failed', {
        message: String((error && error.message) || error),
      });
    }
  }

  function emitChanged(sessionIds) {
    emitBridgeState();
    const affected = Array.from(new Set(sessionIds)).filter(Boolean);
    notifyListeners(changeListeners, affected, 'background_jobs.change_listener_failed');
  }

  function stopPolling() {
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function hasLiveJobs() {
    for (const job of jobs.values()) {
      if (isLive(job)) return true;
    }
    return false;
  }

  function ensurePolling() {
    // The timer runs only while a job is running/killing: history is evicted
    // by count at registration/settle, so it needs no timer of its own.
    if (disposed || pollTimer !== null || !hasLiveJobs()) {
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

  function finishedJobs(sessionId = null) {
    return Array.from(jobs.values())
      .filter((job) => !isLive(job) && (sessionId === null || job.sessionId === sessionId))
      .sort(newestFirst('endedAtMs'));
  }

  function trimSessionHistory(sessionId) {
    for (const job of finishedJobs(sessionId).slice(MAX_FINISHED_PER_SESSION)) {
      jobs.delete(job.jobId);
    }
  }

  // Every mutation path ends here: report each running/killing -> terminal
  // move exactly once, trim that session's history, stop an idle timer, then
  // push the snapshot and notify in-process subscribers.
  function commit(affected, progressMoved = false) {
    const settled = [];
    for (const job of jobs.values()) {
      if (!job.settleReported && !isLive(job)) {
        job.settleReported = true;
        settled.push(snapshotJob(job));
        affected.add(job.sessionId);
      }
    }
    for (const snapshot of settled) trimSessionHistory(snapshot.sessionId);
    if (!hasLiveJobs()) stopPolling();
    if (affected.size) emitChanged(affected);
    else if (progressMoved) emitBridgeState();
    for (const snapshot of settled) {
      notifyListeners(settleListeners, snapshot, 'background_jobs.settle_listener_failed');
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
      // 'running' would re-arm the row's Stop button mid-kill.
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
    // rendering attacker-controlled text as a row state.
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
    // would otherwise pin the row on "Stopping…" until its own timeout.
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
          if (!disposed && !isLive(job)) commit(new Set([job.sessionId]));
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
    const affected = new Set();
    let progressMoved = false;
    for (const job of jobs.values()) {
      if (!isLive(job)) {
        continue;
      }
      const before = changeKey(job);
      const beforeProgress = JSON.stringify(job.progress);
      pollJob(job);
      job.progress = isLive(job) ? readProgressFileImpl(path.join(path.dirname(job.statusPath), 'progress.json'), { jobId: job.jobId }) : null;
      if (changeKey(job) !== before) {
        affected.add(job.sessionId);
      } else if (JSON.stringify(job.progress) !== beforeProgress) {
        progressMoved = true;
      }
    }
    commit(affected, progressMoved);
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
    const normalizedSessionId = String(sessionId || '').trim();
    const affected = new Set([normalizedSessionId]);
    if (jobs.size >= MAX_TRACKED_JOBS) {
      const oldest = finishedJobs().at(-1);
      if (!oldest) {
        log('WARN', 'background_jobs.tracked_job_cap_reached', { jobId: normalizedJobId });
        return false;
      }
      jobs.delete(oldest.jobId);
      affected.add(oldest.sessionId);
    }
    registrationSeq += 1;
    jobs.set(normalizedJobId, {
      jobId: normalizedJobId,
      seq: registrationSeq,
      sessionId: normalizedSessionId,
      command: String(command || '').slice(0, MAX_COMMAND_CHARS),
      toolCallId: String(toolCallId || '').trim(),
      // The workspace root is captured at registration: a later root switch
      // must not redirect this job's status path to a different tree.
      workspaceRoot,
      statusPath: path.join(workspaceRoot, '.jenny', 'tool-results', normalizedJobId, 'status.json'),
      state: 'running',
      // Registration always starts live, so a settle is always a transition.
      settleReported: false,
      stopRequested: false,
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
      progress: null,
    });
    const registered = jobs.get(normalizedJobId);
    if (registered.pid) {
      registered.identityReady = lookupStartTime(registered.pid).then((value) => { registered.processStartTime = value; });
    }
    log('INFO', 'background_jobs.registered', { jobId: normalizedJobId });
    emitChanged(affected);
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
      commit(new Set([job.sessionId]));
      return { ok: false, reason: 'pid_identity_unverified' };
    }
    if (job.state !== 'running' && job.state !== 'killing') {
      return { ok: false, reason: 'not_running' }; // it finished while the identity check ran
    }
    job.state = 'killing';
    // A person pressed Stop and the signal is going out: the finished row
    // reads "stopped", not a plain failure.
    job.stopRequested = true;
    job.killRequestedAtMs = nowImpl();
    commit(new Set([job.sessionId]));
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
      // The kill never reached a still-live process; re-arm the row instead
      // of leaving it stuck in 'killing' forever. A dead pid stays 'killing'
      // — the poll's liveness backstop settles it.
      job.state = 'running';
      job.stopRequested = false;
      commit(new Set([job.sessionId]));
    }
    return { ok: result.ok === true, reason: String(result.reason || '') };
  }

  function getSessionJobs(sessionId) {
    const wanted = String(sessionId || '').trim();
    return Array.from(jobs.values())
      .filter((job) => job.sessionId === wanted)
      .sort(newestFirst('startedAtMs'))
      .map(snapshotJob);
  }

  // Read-only: a chat's finished jobs with the root captured at registration, so deleting the chat can remove their output.
  const getSessionJobRoots = (sessionId) => finishedJobs(String(sessionId || '').trim()).map((job) => ({ jobId: job.jobId, workspaceRoot: job.workspaceRoot }));

  // The finished job's captured output tail for the rail's inline view.
  // fullOutputPath is derived ONLY from the root captured at registration and
  // only when that file exists; status.json is workspace-writable, so no
  // path is ever taken from it.
  function readOutput(jobId) {
    const normalizedJobId = String(jobId || '').trim();
    const job = JOB_ID_PATTERN.test(normalizedJobId) ? jobs.get(normalizedJobId) : null;
    if (!job) {
      return { ok: false, reason: 'not_found' };
    }
    if (isLive(job)) {
      return { ok: true, state: job.state, text: '', truncated: false, fullOutputPath: '' };
    }
    const outputPath = path.join(job.workspaceRoot, '.jenny', 'tool-results', normalizedJobId, 'output.txt');
    let fullOutputPath;
    try {
      fullOutputPath = fileExistsImpl(outputPath) ? outputPath : '';
    } catch (_error) {
      fullOutputPath = '';
    }
    const read = readStatusFileImpl(job.statusPath);
    let payload;
    try {
      payload = read.ok ? JSON.parse(read.text) : null;
    } catch (_error) {
      payload = null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'output_unavailable', state: job.state, fullOutputPath };
    }
    return { ok: true, state: job.state, ...tailOutput(payload), fullOutputPath };
  }

  function dispose() {
    disposed = true;
    stopPolling();
    jobs.clear();
    changeListeners.clear();
    settleListeners.clear();
  }

  return {
    registerJob,
    killJob,
    getState,
    getSessionJobs,
    getSessionJobRoots,
    readOutput,
    onChanged: (listener) => subscribe(changeListeners, listener),
    onJobSettled: (listener) => subscribe(settleListeners, listener),
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
  MAX_TRACKED_JOBS,
  MAX_FINISHED_PER_SESSION,
  MAX_OUTPUT_LINES,
  MAX_OUTPUT_CHARS,
};
