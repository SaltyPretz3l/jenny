'use strict';

// W2-2: background-job tracker — status.json polling, liveness backstop, kill.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBackgroundJobTracker,
  DEAD_PID_GRACE_MS,
  KILL_ESCALATION_MS,
  MISSING_STATUS_GRACE_MS,
  TERMINAL_RETENTION_MS,
} = require('../services/main/background-job-tracker');

const JOB_ID = 'abc123def456';

function makeTracker(t, overrides = {}) {
  const bridgeEvents = [];
  const statusByPath = overrides.statusByPath || new Map();
  let now = 1_000_000;
  const tracker = createBackgroundJobTracker({
    getWorkspaceRoot: () => overrides.workspaceRoot ?? 'C:\\ws',
    sendBridgeEvent: (name, payload) => bridgeEvents.push({ name, payload }),
    log: () => {},
    readStatusFileImpl: overrides.readStatusFileImpl || ((statusPath) => {
      if (!statusByPath.has(statusPath)) {
        return { ok: false, reason: 'not_found' };
      }
      return { ok: true, text: JSON.stringify(statusByPath.get(statusPath)) };
    }),
    isPidAliveImpl: overrides.isPidAliveImpl || (() => true),
    killPidTreeImpl: overrides.killPidTreeImpl || (async () => ({ ok: true, reason: '' })),
    nowImpl: () => now,
    // Long interval: tests drive polls deterministically via pollNow().
    pollIntervalMs: 3_600_000,
  });
  t.after(() => tracker.dispose());
  return {
    tracker,
    bridgeEvents,
    statusByPath,
    statusPath: (jobId = JOB_ID) => `C:\\ws\\.jenny\\tool-results\\${jobId}\\status.json`,
    advance: (ms) => { now += ms; },
  };
}

test('registerJob validates the job id and requires a workspace root', (t) => {
  const { tracker, bridgeEvents } = makeTracker(t);
  assert.equal(tracker.registerJob({ jobId: '../../evil' }), false);
  assert.equal(tracker.registerJob({ jobId: 'ABC123DEF456' }), false, 'uppercase hex refused');
  assert.equal(tracker.registerJob({ jobId: 'abc123' }), false, 'short id refused');
  assert.equal(bridgeEvents.length, 0);

  const rootless = makeTracker(t, { workspaceRoot: '' });
  assert.equal(rootless.tracker.registerJob({ jobId: JOB_ID }), false);
});

test('registration emits a running snapshot and duplicate ids are idempotent', (t) => {
  const { tracker, bridgeEvents } = makeTracker(t);
  assert.equal(
    tracker.registerJob({ jobId: JOB_ID, sessionId: 's-1', command: 'npm run build', toolCallId: 'call-1' }),
    true
  );
  assert.equal(tracker.registerJob({ jobId: JOB_ID, command: 'other' }), false, 'duplicate refused');
  assert.equal(bridgeEvents.length, 1);
  assert.equal(bridgeEvents[0].name, 'backgroundJobs.onChanged');
  const [job] = bridgeEvents[0].payload.jobs;
  assert.equal(job.jobId, JOB_ID);
  assert.equal(job.sessionId, 's-1');
  assert.equal(job.command, 'npm run build');
  assert.equal(job.state, 'running');
});

test('the registered pid is authoritative and status pids are ignored; terminal status settles', (t) => {
  const { tracker, bridgeEvents, statusByPath, statusPath } = makeTracker(t);
  tracker.registerJob({ jobId: JOB_ID, command: 'sleep 60', pid: 4321 });
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'running', pid: 9999 });
  tracker.pollNow();
  let snapshot = bridgeEvents.at(-1).payload.jobs[0];
  assert.equal(snapshot.state, 'running');
  assert.equal(snapshot.pid, 4321, 'status.json pid never replaces the registered pid');

  statusByPath.set(statusPath(), {
    job_id: JOB_ID,
    state: 'completed',
    exit_code: 0,
    stdout: '',
    stderr: '',
    output_truncated: true,
  });
  tracker.pollNow();
  snapshot = bridgeEvents.at(-1).payload.jobs[0];
  assert.equal(snapshot.state, 'completed');
  assert.equal(snapshot.exitCode, 0);
  assert.equal(snapshot.outputTruncated, true);

  // Terminal: no further polling emissions without a change.
  const emitted = bridgeEvents.length;
  tracker.pollNow();
  assert.equal(bridgeEvents.length, emitted);
});

test('an unrecognized status state settles the job as a local failure', (t) => {
  const { tracker, bridgeEvents, statusByPath, statusPath } = makeTracker(t);
  tracker.registerJob({ jobId: JOB_ID });
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'totally-bogus' });
  tracker.pollNow();
  const snapshot = bridgeEvents.at(-1).payload.jobs[0];
  assert.equal(snapshot.state, 'failed');
  assert.match(snapshot.error, /unrecognized/);
});

test('a dead pid with a stuck running status settles as failed after the grace', (t) => {
  const { tracker, bridgeEvents, statusByPath, statusPath, advance } = makeTracker(t, {
    isPidAliveImpl: () => false,
  });
  tracker.registerJob({ jobId: JOB_ID, pid: 77 });
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'running' });
  tracker.pollNow();
  assert.equal(bridgeEvents.at(-1).payload.jobs[0].state, 'running', 'grace not yet elapsed');
  advance(DEAD_PID_GRACE_MS + 1_000);
  tracker.pollNow();
  const snapshot = bridgeEvents.at(-1).payload.jobs[0];
  assert.equal(snapshot.state, 'failed');
  assert.match(snapshot.error, /exited before its status/);
});

test('a missing status file is tolerated within the grace and fails after it', (t) => {
  const { tracker, bridgeEvents, advance } = makeTracker(t);
  tracker.registerJob({ jobId: JOB_ID });
  tracker.pollNow();
  assert.equal(bridgeEvents.at(-1).payload.jobs[0].state, 'running', 'startup race tolerated');
  advance(MISSING_STATUS_GRACE_MS + 1_000);
  tracker.pollNow();
  const snapshot = bridgeEvents.at(-1).payload.jobs[0];
  assert.equal(snapshot.state, 'failed');
  assert.match(snapshot.error, /not found/);
});

test('oversized and malformed status files settle as local failures', (t) => {
  const first = makeTracker(t, {
    readStatusFileImpl: () => ({ ok: false, reason: 'status_too_large' }),
  });
  first.tracker.registerJob({ jobId: JOB_ID });
  first.tracker.pollNow();
  assert.equal(first.bridgeEvents.at(-1).payload.jobs[0].state, 'failed');

  const second = makeTracker(t, {
    readStatusFileImpl: () => ({ ok: true, text: 'not json {{' }),
  });
  second.tracker.registerJob({ jobId: JOB_ID });
  second.tracker.pollNow();
  const snapshot = second.bridgeEvents.at(-1).payload.jobs[0];
  assert.equal(snapshot.state, 'failed');
  assert.match(snapshot.error, /malformed/);
});

test('killJob dispatches a pid-tree kill and holds the killing state', async (t) => {
  const killCalls = [];
  const { tracker, bridgeEvents, statusByPath, statusPath } = makeTracker(t, {
    killPidTreeImpl: async (pid, opts) => {
      killCalls.push({ pid, opts });
      return { ok: true, reason: '' };
    },
  });
  tracker.registerJob({ jobId: JOB_ID, pid: 555 });
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'running' });
  tracker.pollNow();

  const result = await tracker.killJob(JOB_ID);
  assert.equal(result.ok, true);
  assert.deepEqual(killCalls.map((c) => c.pid), [555]);
  assert.equal(bridgeEvents.at(-1).payload.jobs[0].state, 'killing');

  // The sidecar waiter still says running mid-kill: the killing state must
  // not flap back to running (which would re-arm the Stop button).
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].state, 'killing');

  // The waiter publishes the authoritative terminal status.
  statusByPath.set(statusPath(), {
    job_id: JOB_ID, state: 'failed', exit_code: -1, error: 'background job was cancelled',
  });
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].state, 'failed');
});

test('killJob works immediately from the registered pid with no poll at all', async (t) => {
  const killCalls = [];
  const { tracker } = makeTracker(t, {
    killPidTreeImpl: async (pid) => {
      killCalls.push(pid);
      return { ok: true, reason: '' };
    },
  });
  tracker.registerJob({ jobId: JOB_ID, pid: 888 });
  const result = await tracker.killJob(JOB_ID);
  assert.equal(result.ok, true);
  assert.deepEqual(killCalls, [888]);
});

test('killJob refuses without a registered pid and never consults status.json for one', async (t) => {
  const killCalls = [];
  const { tracker, statusByPath, statusPath } = makeTracker(t, {
    killPidTreeImpl: async (pid) => {
      killCalls.push(pid);
      return { ok: true, reason: '' };
    },
  });
  tracker.registerJob({ jobId: JOB_ID });
  // A workspace writer plants a pid; it must not become kill authority.
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'running', pid: 12345 });
  tracker.pollNow();
  const result = await tracker.killJob(JOB_ID);
  assert.deepEqual(result, { ok: false, reason: 'pid_unknown' });
  assert.deepEqual(killCalls, []);
  assert.equal(tracker.getState().jobs[0].pid, null);
});

test('a failed kill re-arms the job instead of leaving it stuck in killing', async (t) => {
  const { tracker, statusByPath, statusPath } = makeTracker(t, {
    killPidTreeImpl: async () => ({ ok: false, reason: 'refused' }),
  });
  tracker.registerJob({ jobId: JOB_ID, pid: 999 });
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'running' });
  tracker.pollNow();
  const result = await tracker.killJob(JOB_ID);
  assert.equal(result.ok, false);
  assert.equal(tracker.getState().jobs[0].state, 'running');
});

test('killJob refuses unknown, invalid, and already-terminal jobs', async (t) => {
  const { tracker, statusByPath, statusPath } = makeTracker(t);
  assert.deepEqual(await tracker.killJob('nope'), { ok: false, reason: 'unknown_job' });
  assert.deepEqual(await tracker.killJob('ffffffffffff'), { ok: false, reason: 'unknown_job' });

  tracker.registerJob({ jobId: JOB_ID });
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'completed', exit_code: 0 });
  tracker.pollNow();
  assert.deepEqual(await tracker.killJob(JOB_ID), { ok: false, reason: 'not_running' });
});

test('the workspace root is captured at registration, not at poll time', (t) => {
  const readPaths = [];
  let root = 'C:\\first-root';
  const bridgeEvents = [];
  const tracker = createBackgroundJobTracker({
    getWorkspaceRoot: () => root,
    sendBridgeEvent: (name, payload) => bridgeEvents.push({ name, payload }),
    log: () => {},
    readStatusFileImpl: (statusPath) => {
      readPaths.push(statusPath);
      return { ok: true, text: JSON.stringify({ job_id: JOB_ID, state: 'running', pid: 1 }) };
    },
    isPidAliveImpl: () => true,
    nowImpl: () => 5_000,
    pollIntervalMs: 3_600_000,
  });
  t.after(() => tracker.dispose());
  tracker.registerJob({ jobId: JOB_ID });
  root = 'D:\\second-root';
  tracker.pollNow();
  assert.equal(readPaths.length, 1);
  assert.ok(readPaths[0].startsWith('C:\\first-root'), `read from ${readPaths[0]}`);
});

test('a poisoned status file, even before the first poll, cannot retarget the kill', async (t) => {
  const killCalls = [];
  const { tracker, statusByPath, statusPath } = makeTracker(t, {
    killPidTreeImpl: async (pid) => {
      killCalls.push(pid);
      return { ok: true, reason: '' };
    },
  });
  tracker.registerJob({ jobId: JOB_ID, pid: 100 });
  // The status file is poisoned from the very first observation — the
  // pre-poll rewrite that defeated first-observation pinning (W1-29-F04).
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'running', pid: 4321 });
  tracker.pollNow();
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'running', pid: 12345 });
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].pid, 100, 'registered pid survives every rewrite');
  await tracker.killJob(JOB_ID);
  assert.deepEqual(killCalls, [100]);
});

test('killJob refuses sensitive pids even when registration claims them', async (t) => {
  const killCalls = [];
  const { tracker, statusByPath, statusPath } = makeTracker(t, {
    killPidTreeImpl: async (pid) => {
      killCalls.push(pid);
      return { ok: true, reason: '' };
    },
  });
  tracker.registerJob({ jobId: JOB_ID, pid: process.pid });
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'running' });
  tracker.pollNow();
  const result = await tracker.killJob(JOB_ID);
  assert.deepEqual(result, { ok: false, reason: 'pid_refused' });
  assert.deepEqual(killCalls, []);
});

test('a kill that leaves the process alive escalates to a forceful kill after the grace', async (t) => {
  const killCalls = [];
  const { tracker, statusByPath, statusPath, advance } = makeTracker(t, {
    killPidTreeImpl: async (pid, opts) => {
      killCalls.push({ pid, force: opts && opts.force === true });
      return { ok: true, reason: '' };
    },
  });
  tracker.registerJob({ jobId: JOB_ID, pid: 555 });
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'running' });
  tracker.pollNow();
  await tracker.killJob(JOB_ID);
  assert.deepEqual(killCalls, [{ pid: 555, force: false }]);
  tracker.pollNow();
  assert.equal(killCalls.length, 1, 'no escalation before the grace');
  advance(KILL_ESCALATION_MS + 500);
  tracker.pollNow();
  assert.deepEqual(killCalls.at(-1), { pid: 555, force: true });
  // Escalation fires once, not on every subsequent poll.
  advance(1_000);
  tracker.pollNow();
  assert.equal(killCalls.length, 2);
});

test('the standing timer keeps pruning after the last job settles', async (t) => {
  let now = 1_000_000;
  const statusByPath = new Map();
  const bridgeEvents = [];
  const tracker = createBackgroundJobTracker({
    getWorkspaceRoot: () => 'C:\\ws',
    sendBridgeEvent: (name, payload) => bridgeEvents.push({ name, payload }),
    log: () => {},
    readStatusFileImpl: (statusPath) => (statusByPath.has(statusPath)
      ? { ok: true, text: JSON.stringify(statusByPath.get(statusPath)) }
      : { ok: false, reason: 'not_found' }),
    isPidAliveImpl: () => true,
    nowImpl: () => now,
    pollIntervalMs: 10,
  });
  t.after(() => tracker.dispose());
  tracker.registerJob({ jobId: JOB_ID });
  statusByPath.set(
    `C:\\ws\\.jenny\\tool-results\\${JOB_ID}\\status.json`,
    { job_id: JOB_ID, state: 'completed', exit_code: 0 }
  );
  tracker.pollNow();
  assert.equal(tracker.getState().jobs.length, 1);
  now += TERMINAL_RETENTION_MS + 1_000;
  // No manual pollNow: the standing interval must prune on its own.
  const deadline = Date.now() + 2_000;
  while (tracker.getState().jobs.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(tracker.getState().jobs.length, 0);
});

test('terminal jobs are pruned from the snapshot after the retention window', (t) => {
  const { tracker, statusByPath, statusPath, advance } = makeTracker(t);
  tracker.registerJob({ jobId: JOB_ID });
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'completed', exit_code: 0 });
  tracker.pollNow();
  assert.equal(tracker.getState().jobs.length, 1);
  advance(TERMINAL_RETENTION_MS + 1_000);
  tracker.pollNow();
  assert.equal(tracker.getState().jobs.length, 0);
});
