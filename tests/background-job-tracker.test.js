'use strict';

// W2-2: background-job tracker — status.json polling, liveness backstop, kill.
// Finished-job history, subscriptions and readOutput live in
// background-job-tracker-history.test.js.

const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBackgroundJobTracker,
  DEAD_PID_GRACE_MS,
  KILL_ESCALATION_MS,
  MISSING_STATUS_GRACE_MS,
} = require('../services/main/background-job-tracker');

const JOB_ID = 'abc123def456';

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

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
    readProgressFileImpl: overrides.readProgressFileImpl,
    isPidAliveImpl: overrides.isPidAliveImpl || (() => true),
    getProcessStartTimeImpl: overrides.getProcessStartTimeImpl || (() => 'generation-1'),
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

test('MON-05: a job polls under its own execution root, not the global root', (t) => {
  const h = makeTracker(t);
  const projectRoot = path.join('D:', 'proj');
  const projectStatus = path.join(projectRoot, '.jenny', 'tool-results', JOB_ID, 'status.json');
  h.statusByPath.set(projectStatus, { job_id: JOB_ID, state: 'completed', exit_code: 0 });
  assert.equal(h.tracker.registerJob({ jobId: JOB_ID, workspaceRoot: projectRoot }), true);
  h.tracker.pollNow();
  const job = h.tracker.getState().jobs.find((entry) => entry.jobId === JOB_ID);
  assert.equal(job.state, 'completed', 'status read from the project root settles the job');

  const rootless = makeTracker(t, { workspaceRoot: '' });
  assert.equal(rootless.tracker.registerJob({ jobId: JOB_ID, workspaceRoot: projectRoot }), true,
    'an explicit execution root registers without a global root');
});

test('Stop never adopts a baseline identity after registration failed to read one', async (t) => {
  let identity = '';
  const killCalls = [];
  const { tracker } = makeTracker(t, {
    getProcessStartTimeImpl: () => identity,
    killPidTreeImpl: async (pid) => { killCalls.push(pid); return { ok: true }; },
  });
  tracker.registerJob({ jobId: JOB_ID, pid: 555 });
  await flushAsync();
  identity = 'replacement-process';
  assert.deepEqual(await tracker.killJob(JOB_ID), { ok: false, reason: 'pid_identity_unverified' });
  assert.deepEqual(killCalls, []);
});

test('Stop refuses a reused or unverifiable pid before signaling', async (t) => {
  for (const replacement of ['generation-2', '']) {
    let identity = 'generation-1';
    const killCalls = [];
    const { tracker } = makeTracker(t, {
      getProcessStartTimeImpl: () => identity,
      killPidTreeImpl: async (pid) => { killCalls.push(pid); return { ok: true }; },
    });
    tracker.registerJob({ jobId: JOB_ID, pid: 555 });
    await flushAsync();
    identity = replacement;
    assert.deepEqual(await tracker.killJob(JOB_ID), { ok: false, reason: 'pid_identity_unverified' });
    assert.deepEqual(killCalls, []);
    const job = tracker.getState().jobs[0];
    if (replacement) {
      assert.match(job.error, /no longer be verified/, 'a different creation time settles the job');
    } else {
      assert.equal(job.state, 'running', 'a failed lookup keeps the job and its Stop');
      identity = 'generation-1';
      assert.equal((await tracker.killJob(JOB_ID)).ok, true, 'Stop succeeds once the lookup works');
    }
  }
});

test('escalation rechecks process identity before its forceful signal', async (t) => {
  let identity = 'generation-1';
  const killCalls = [];
  const { tracker, statusByPath, statusPath, advance } = makeTracker(t, {
    getProcessStartTimeImpl: () => identity,
    killPidTreeImpl: async (pid) => { killCalls.push(pid); return { ok: true }; },
  });
  tracker.registerJob({ jobId: JOB_ID, pid: 555 });
  statusByPath.set(statusPath(), { state: 'running' });
  await tracker.killJob(JOB_ID);
  identity = 'generation-2';
  advance(KILL_ESCALATION_MS + 1);
  tracker.pollNow();
  await flushAsync();
  assert.deepEqual(killCalls, [555], 'replacement process must receive no escalation');
});

test('a transient status read failure preserves Stop and recovers on the next poll', async (t) => {
  let read = { ok: false, reason: 'read_failed' };
  const { tracker } = makeTracker(t, { readStatusFileImpl: () => read });
  tracker.registerJob({ jobId: JOB_ID, pid: 555 });
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].state, 'running', 'observation failure is not termination');
  assert.equal((await tracker.killJob(JOB_ID)).ok, true);
  read = { ok: true, text: JSON.stringify({ state: 'completed', exit_code: 0 }) };
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].state, 'completed');
});

test('a successful observation resets the consecutive status failure bound', (t) => {
  let read = { ok: false, reason: 'read_failed' };
  const { tracker } = makeTracker(t, { readStatusFileImpl: () => read });
  tracker.registerJob({ jobId: JOB_ID, pid: 555 });
  tracker.pollNow();
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].state, 'running');
  read = { ok: true, text: JSON.stringify({ state: 'running' }) };
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].error, '');
  read = { ok: false, reason: 'read_failed' };
  tracker.pollNow();
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].state, 'running');
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].state, 'failed');
});

test('default Stop keeps POSIX group semantics without signaling a replacement pid fallback', async (t) => {
  const signals = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push({ pid, signal });
    throw Object.assign(new Error('group gone'), { code: 'ESRCH' });
  });
  const tracker = createBackgroundJobTracker({
    getWorkspaceRoot: () => 'C:\\ws', platform: 'linux',
    getProcessStartTimeImpl: () => 'generation-1', isPidAliveImpl: () => false,
  });
  t.after(() => tracker.dispose());
  tracker.registerJob({ jobId: JOB_ID, pid: 555 });
  assert.equal((await tracker.killJob(JOB_ID)).ok, true);
  assert.deepEqual(signals, [{ pid: -555, signal: 'SIGTERM' }]);
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

test('consecutive unrecognized status states settle the job as a local failure', (t) => {
  const { tracker, bridgeEvents, statusByPath, statusPath } = makeTracker(t);
  tracker.registerJob({ jobId: JOB_ID });
  statusByPath.set(statusPath(), { job_id: JOB_ID, state: 'totally-bogus' });
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].state, 'running');
  tracker.pollNow();
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
  tracker.pollNow();
  tracker.pollNow();
  const snapshot = bridgeEvents.at(-1).payload.jobs[0];
  assert.equal(snapshot.state, 'failed');
  assert.match(snapshot.error, /not found/);
});

test('consecutive oversized and malformed status files settle as local failures', (t) => {
  const first = makeTracker(t, {
    readStatusFileImpl: () => ({ ok: false, reason: 'status_too_large' }),
  });
  first.tracker.registerJob({ jobId: JOB_ID });
  first.tracker.pollNow();
  first.tracker.pollNow();
  first.tracker.pollNow();
  assert.equal(first.bridgeEvents.at(-1).payload.jobs[0].state, 'failed');

  const second = makeTracker(t, {
    readStatusFileImpl: () => ({ ok: true, text: 'not json {{' }),
  });
  second.tracker.registerJob({ jobId: JOB_ID });
  second.tracker.pollNow();
  second.tracker.pollNow();
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
  await flushAsync();
  assert.deepEqual(killCalls.at(-1), { pid: 555, force: true });
  // Escalation fires once, not on every subsequent poll.
  advance(1_000);
  tracker.pollNow();
  await flushAsync();
  assert.equal(killCalls.length, 2);
});

// Row 96: live test-run progress read from progress.json while a job runs.
test('progress appears in getSessionJobs while running, changes emit, and finishing drops it', (t) => {
  let progress = { percent: 10, done: 100, total: 1000, totalUnit: 'tests', failed: 0, failureMarks: [] };
  const seen = [];
  const { tracker, bridgeEvents, statusByPath, statusPath } = makeTracker(t, {
    readProgressFileImpl: (progressPath, options) => {
      seen.push({ progressPath, jobId: options.jobId });
      return progress;
    },
  });
  const changes = [];
  tracker.onChanged((sessionIds) => changes.push(sessionIds));
  tracker.registerJob({ jobId: JOB_ID, sessionId: 's1', pid: 0 });
  statusByPath.set(statusPath(), { state: 'running' });
  const startingEvents = bridgeEvents.length;
  tracker.pollNow();
  assert.deepEqual(seen[0], { progressPath: statusPath().replace('status.json', 'progress.json'), jobId: JOB_ID });
  assert.deepEqual(tracker.getSessionJobs('s1')[0].progress, progress);
  assert.equal(bridgeEvents.length, startingEvents + 1, 'first progress is a change');

  tracker.pollNow();
  assert.equal(bridgeEvents.length, startingEvents + 1, 'an unchanged poll emits nothing');

  progress = { ...progress, percent: 55, done: 550, failed: 1, failureMarks: [0.5] };
  tracker.pollNow();
  assert.equal(bridgeEvents.length, startingEvents + 2, 'a progress change emits');
  assert.equal(changes.at(-1)[0], 's1');
  assert.equal(tracker.getState().jobs[0].progress.percent, 55);

  const changeCount = changes.length;
  progress = { ...progress, percent: 57, done: 570 };
  tracker.pollNow();
  assert.equal(bridgeEvents.length, startingEvents + 3, 'a move inside one 5% step still pushes the bridge state');
  assert.equal(changes.length, changeCount, 'but does not make listeners refetch the workspace summary');
  progress = { ...progress, percent: 61, done: 610 };
  tracker.pollNow();
  assert.equal(changes.length, changeCount + 1, 'the next 5% step notifies listeners');

  statusByPath.set(statusPath(), { state: 'completed', exit_code: 0 });
  tracker.pollNow();
  assert.equal(tracker.getSessionJobs('s1')[0].state, 'completed');
  assert.equal(tracker.getSessionJobs('s1')[0].progress, null, 'a finished job drops progress');
  const callsAtFinish = seen.length;
  tracker.pollNow();
  assert.equal(seen.length, callsAtFinish, 'finished jobs are not re-read');
});

test('a job without a progress file reports progress null', (t) => {
  const { tracker, statusByPath, statusPath } = makeTracker(t, { readProgressFileImpl: () => null });
  tracker.registerJob({ jobId: JOB_ID, sessionId: 's1' });
  statusByPath.set(statusPath(), { state: 'running' });
  tracker.pollNow();
  assert.equal(tracker.getSessionJobs('s1')[0].progress, null);
});
