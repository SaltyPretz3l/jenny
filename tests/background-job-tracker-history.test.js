'use strict';

// Background-job tracker, Session rail half: count-based finished-job history,
// stopRequested, getSessionJobs, the in-process onChanged / onJobSettled
// subscriptions and the readOutput tail.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createBackgroundJobTracker,
  DEAD_PID_GRACE_MS,
  MAX_FINISHED_PER_SESSION,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES,
  MAX_TRACKED_JOBS,
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

// ---- finished-job history (Session rail Background tasks) ------------------

function jobIdAt(index) {
  return index.toString(16).padStart(12, '0');
}

function settle(h, jobId, state = 'completed', extra = {}) {
  h.statusByPath.set(h.statusPath(jobId), { job_id: jobId, state, exit_code: 0, ...extra });
}

test('finished jobs stay as history: the newest twenty per session survive, by count not time', (t) => {
  const h = makeTracker(t);
  for (let index = 1; index <= MAX_FINISHED_PER_SESSION + 3; index += 1) {
    assert.equal(h.tracker.registerJob({ jobId: jobIdAt(index), sessionId: 's-1' }), true);
    settle(h, jobIdAt(index));
    h.advance(1_000);
    h.tracker.pollNow();
  }
  h.tracker.registerJob({ jobId: jobIdAt(900), sessionId: 's-2' });
  settle(h, jobIdAt(900));
  h.tracker.pollNow();
  const kept = h.tracker.getSessionJobs('s-1');
  assert.equal(kept.length, MAX_FINISHED_PER_SESSION);
  assert.equal(kept.some((job) => job.jobId === jobIdAt(1) || job.jobId === jobIdAt(3)), false, 'oldest evicted');
  assert.equal(kept[0].jobId, jobIdAt(MAX_FINISHED_PER_SESSION + 3), 'newest first');
  assert.equal(h.tracker.getSessionJobs('s-2').length, 1, 'another session keeps its own history');

  h.advance(24 * 60 * 60_000);
  h.tracker.pollNow();
  assert.equal(h.tracker.getSessionJobs('s-1').length, MAX_FINISHED_PER_SESSION, 'no time-based pruning');
});

test('at the global cap the oldest finished job is evicted and running jobs never are', (t) => {
  const h = makeTracker(t);
  assert.equal(MAX_TRACKED_JOBS, 128);
  // 100 running jobs across sessions, then finished history filling the cap.
  for (let index = 1; index <= 100; index += 1) {
    h.tracker.registerJob({ jobId: jobIdAt(index), sessionId: `run-${index % 4}` });
    h.statusByPath.set(h.statusPath(jobIdAt(index)), { state: 'running' });
  }
  for (let index = 101; index <= MAX_TRACKED_JOBS; index += 1) {
    h.tracker.registerJob({ jobId: jobIdAt(index), sessionId: `done-${index % 5}` });
    settle(h, jobIdAt(index));
    h.advance(1_000);
    h.tracker.pollNow();
  }
  assert.equal(h.tracker.getState().jobs.length, MAX_TRACKED_JOBS);
  const changes = [];
  h.tracker.onChanged((sessionIds) => changes.push(sessionIds));
  assert.equal(h.tracker.registerJob({ jobId: jobIdAt(500), sessionId: 'new' }), true);
  const ids = new Set(h.tracker.getState().jobs.map((job) => job.jobId));
  assert.equal(ids.has(jobIdAt(101)), false, 'the oldest finished job was evicted');
  assert.equal(ids.has(jobIdAt(102)), true);
  assert.deepEqual(changes.at(-1).sort(), ['done-1', 'new'], 'both the new and the evicted session are affected');

  const live = makeTracker(t);
  for (let index = 1; index <= MAX_TRACKED_JOBS; index += 1) {
    live.tracker.registerJob({ jobId: jobIdAt(index), sessionId: 's' });
  }
  assert.equal(live.tracker.registerJob({ jobId: jobIdAt(999), sessionId: 's' }), false, 'all running: refused');
  assert.equal(live.tracker.getState().jobs.length, MAX_TRACKED_JOBS);
  assert.equal(live.tracker.getState().jobs.every((job) => job.state === 'running'), true);
});

test('polling stops once only history is left and restarts with a new running job', async (t) => {
  let now = 1_000_000;
  const statusByPath = new Map();
  const reads = [];
  const tracker = createBackgroundJobTracker({
    getWorkspaceRoot: () => 'C:\\ws',
    log: () => {},
    readStatusFileImpl: (statusPath) => {
      reads.push(statusPath);
      return statusByPath.has(statusPath)
        ? { ok: true, text: JSON.stringify(statusByPath.get(statusPath)) }
        : { ok: false, reason: 'not_found' };
    },
    isPidAliveImpl: () => true,
    nowImpl: () => now,
    pollIntervalMs: 5,
  });
  t.after(() => tracker.dispose());
  const statusOf = (jobId) => `C:\\ws\\.jenny\\tool-results\\${jobId}\\status.json`;
  tracker.registerJob({ jobId: JOB_ID, sessionId: 's-1' });
  statusByPath.set(statusOf(JOB_ID), { state: 'completed', exit_code: 0 });
  const deadline = Date.now() + 2_000;
  while (tracker.getState().jobs[0].state !== 'completed' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(tracker.getState().jobs[0].state, 'completed');
  const readsAtSettle = reads.length;
  now += 60_000;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(reads.length, readsAtSettle, 'no timer keeps polling for history alone');
  assert.equal(tracker.getState().jobs.length, 1, 'history is kept');

  tracker.registerJob({ jobId: 'fedcba987654', sessionId: 's-1' });
  const restart = Date.now() + 2_000;
  while (reads.length === readsAtSettle && Date.now() < restart) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(reads.length > readsAtSettle, 'a new running job restarts the timer');
  assert.equal(reads.includes(statusOf(JOB_ID), readsAtSettle), false, 'finished jobs are not re-read');
});

test('stopRequested marks a dispatched Stop and clears when the kill never reached the process', async (t) => {
  const h = makeTracker(t);
  h.tracker.registerJob({ jobId: JOB_ID, pid: 555 });
  assert.equal(h.tracker.getState().jobs[0].stopRequested, false);
  await h.tracker.killJob(JOB_ID);
  assert.equal(h.tracker.getState().jobs[0].stopRequested, true);
  settle(h, JOB_ID, 'failed', { exit_code: -1 });
  h.tracker.pollNow();
  assert.deepEqual([h.tracker.getState().jobs[0].state, h.tracker.getState().jobs[0].stopRequested], ['failed', true]);

  const refused = makeTracker(t, { killPidTreeImpl: async () => ({ ok: false, reason: 'refused' }) });
  refused.tracker.registerJob({ jobId: JOB_ID, pid: 555 });
  await refused.tracker.killJob(JOB_ID);
  assert.deepEqual([refused.tracker.getState().jobs[0].state, refused.tracker.getState().jobs[0].stopRequested], ['running', false]);
});

test('getSessionJobs returns that session only, newest first', (t) => {
  const h = makeTracker(t);
  h.tracker.registerJob({ jobId: jobIdAt(1), sessionId: 's-1', command: 'first' });
  h.advance(10);
  h.tracker.registerJob({ jobId: jobIdAt(2), sessionId: 's-2' });
  h.tracker.registerJob({ jobId: jobIdAt(3), sessionId: 's-1', command: 'second' });
  h.tracker.registerJob({ jobId: jobIdAt(4), sessionId: 's-1', command: 'third' });
  assert.deepEqual(h.tracker.getSessionJobs('s-1').map((job) => job.command), ['third', 'second', 'first']);
  assert.deepEqual(h.tracker.getSessionJobs('nobody'), []);
  assert.deepEqual(h.tracker.getSessionJobs(null), []);
});

test('onJobSettled fires once per settle and onChanged carries the affected session ids', async (t) => {
  const h = makeTracker(t, { isPidAliveImpl: () => false });
  const settled = [];
  const changes = [];
  h.tracker.onJobSettled((snapshot) => settled.push(snapshot));
  const unsubscribe = h.tracker.onChanged((sessionIds) => changes.push(sessionIds));
  h.tracker.registerJob({ jobId: jobIdAt(1), sessionId: 's-1', command: 'npm test' });
  h.tracker.registerJob({ jobId: jobIdAt(2), sessionId: 's-2', pid: 77 });
  assert.deepEqual(changes, [['s-1'], ['s-2']]);
  assert.deepEqual(settled, [], 'registration is never a settle');

  settle(h, jobIdAt(1));
  h.statusByPath.set(h.statusPath(jobIdAt(2)), { state: 'running' });
  h.tracker.pollNow();
  assert.deepEqual(changes.at(-1), ['s-1']);
  assert.equal(settled.length, 1);
  assert.deepEqual([settled[0].jobId, settled[0].state, settled[0].command], [jobIdAt(1), 'completed', 'npm test']);
  h.tracker.pollNow();
  assert.equal(settled.length, 1, 'a second poll does not re-fire');

  // A locally settled job (dead pid past the grace) is a settle too.
  h.advance(DEAD_PID_GRACE_MS + 1_000);
  h.tracker.pollNow();
  h.advance(DEAD_PID_GRACE_MS + 1_000);
  h.tracker.pollNow();
  assert.deepEqual(settled.map((snapshot) => [snapshot.jobId, snapshot.state]),
    [[jobIdAt(1), 'completed'], [jobIdAt(2), 'failed']]);
  assert.deepEqual(changes.at(-1), ['s-2']);

  unsubscribe();
  const count = changes.length;
  h.tracker.registerJob({ jobId: jobIdAt(3), sessionId: 's-3' });
  assert.equal(changes.length, count, 'unsubscribed listeners stay quiet');
});

test('a throwing subscriber is contained and never breaks the tracker', (t) => {
  const logs = [];
  const statusByPath = new Map();
  const bridgeEvents = [];
  const tracker = createBackgroundJobTracker({
    getWorkspaceRoot: () => 'C:\\ws',
    sendBridgeEvent: (name, payload) => bridgeEvents.push({ name, payload }),
    log: (level, event) => logs.push([level, event]),
    readStatusFileImpl: (statusPath) => (statusByPath.has(statusPath)
      ? { ok: true, text: JSON.stringify(statusByPath.get(statusPath)) }
      : { ok: false, reason: 'not_found' }),
    isPidAliveImpl: () => true,
    pollIntervalMs: 3_600_000,
  });
  t.after(() => tracker.dispose());
  const seen = [];
  tracker.onChanged(() => { throw new Error('boom'); });
  tracker.onJobSettled(() => { throw new Error('boom'); });
  tracker.onJobSettled((snapshot) => seen.push(snapshot.jobId));
  assert.equal(tracker.registerJob({ jobId: JOB_ID, sessionId: 's-1' }), true);
  statusByPath.set(`C:\\ws\\.jenny\\tool-results\\${JOB_ID}\\status.json`, { state: 'completed', exit_code: 0 });
  tracker.pollNow();
  assert.equal(tracker.getState().jobs[0].state, 'completed');
  assert.deepEqual(seen, [JOB_ID], 'later listeners still run');
  assert.equal(bridgeEvents.length, 2, 'bridge snapshots still go out');
  assert.ok(logs.some(([level, event]) => level === 'WARN' && event === 'background_jobs.change_listener_failed'));
  assert.ok(logs.some(([level, event]) => level === 'WARN' && event === 'background_jobs.settle_listener_failed'));
  tracker.dispose();
  assert.equal(typeof tracker.onChanged(() => {}), 'function', 'subscribing after dispose is inert');
});

// ---- readOutput ---------------------------------------------------------------

function makeOutputTracker(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-bg-output-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tracker = createBackgroundJobTracker({
    getWorkspaceRoot: () => root,
    log: () => {},
    isPidAliveImpl: () => true,
    getProcessStartTimeImpl: () => 'generation-1',
    pollIntervalMs: 3_600_000,
  });
  t.after(() => tracker.dispose());
  const jobDir = (jobId = JOB_ID) => path.join(root, '.jenny', 'tool-results', jobId);
  const writeStatus = (payload, jobId = JOB_ID) => {
    fs.mkdirSync(jobDir(jobId), { recursive: true });
    fs.writeFileSync(path.join(jobDir(jobId), 'status.json'), typeof payload === 'string' ? payload : JSON.stringify(payload));
  };
  return { root, tracker, jobDir, writeStatus };
}

test('readOutput returns the stdout tail with stderr after a blank line', (t) => {
  const h = makeOutputTracker(t);
  h.tracker.registerJob({ jobId: JOB_ID, sessionId: 's-1' });
  assert.deepEqual(h.tracker.readOutput(JOB_ID), { ok: true, state: 'running', text: '', truncated: false, fullOutputPath: '' },
    'a running job has no output view yet');
  h.writeStatus({ state: 'completed', exit_code: 0, stdout: 'built\nok\n', stderr: 'warning: x\n' });
  h.tracker.pollNow();
  assert.deepEqual(h.tracker.readOutput(JOB_ID), {
    ok: true, state: 'completed', text: 'built\nok\n\nwarning: x', truncated: false, fullOutputPath: '',
  });
  h.writeStatus({ state: 'completed', exit_code: 0, stdout: 'only out\n', stderr: '', output_truncated: true });
  assert.deepEqual(h.tracker.readOutput(JOB_ID), {
    ok: true, state: 'completed', text: 'only out', truncated: true, fullOutputPath: '',
  }, 'empty stderr adds no separator; output_truncated carries through');
  h.writeStatus({ state: 'completed', stdout: 42, stderr: 'err only' });
  assert.equal(h.tracker.readOutput(JOB_ID).text, 'err only', 'non-string stdout is ignored');
});

test('readOutput bounds the tail to sixty lines and eight thousand characters', (t) => {
  const h = makeOutputTracker(t);
  h.tracker.registerJob({ jobId: JOB_ID });
  const lines = Array.from({ length: 100 }, (_, index) => `line ${index}`);
  h.writeStatus({ state: 'failed', exit_code: 1, stdout: lines.join('\n') });
  h.tracker.pollNow();
  const tail = h.tracker.readOutput(JOB_ID);
  assert.equal(tail.state, 'failed');
  assert.equal(tail.truncated, true);
  assert.equal(tail.text.split('\n').length, MAX_OUTPUT_LINES);
  assert.ok(tail.text.endsWith('line 99'));
  assert.ok(tail.text.startsWith(`line ${100 - MAX_OUTPUT_LINES}`));

  h.writeStatus({ state: 'failed', exit_code: 1, stdout: `${'x'.repeat(20_000)}END` });
  const wide = h.tracker.readOutput(JOB_ID);
  assert.equal(wide.text.length, MAX_OUTPUT_CHARS);
  assert.ok(wide.text.endsWith('END'));
  assert.equal(wide.truncated, true);
});

test('readOutput refuses unknown ids and degrades on an unreadable status', (t) => {
  const h = makeOutputTracker(t);
  assert.deepEqual(h.tracker.readOutput('../../evil'), { ok: false, reason: 'not_found' });
  assert.deepEqual(h.tracker.readOutput('ffffffffffff'), { ok: false, reason: 'not_found' });
  h.tracker.registerJob({ jobId: JOB_ID });
  h.writeStatus({ state: 'completed', exit_code: 0 });
  h.tracker.pollNow();
  h.writeStatus('not json {{');
  assert.deepEqual(h.tracker.readOutput(JOB_ID), { ok: false, reason: 'output_unavailable', state: 'completed', fullOutputPath: '' });
});

test('readOutput fullOutputPath comes only from the registered root, never from status.json', (t) => {
  const h = makeOutputTracker(t);
  h.tracker.registerJob({ jobId: JOB_ID });
  const hostile = path.join(os.tmpdir(), 'elsewhere', 'output.txt');
  h.writeStatus({
    state: 'completed', exit_code: 0, stdout: 'done',
    output_path: hostile, full_output_path: hostile, fullOutputPath: hostile,
  });
  h.tracker.pollNow();
  assert.equal(h.tracker.readOutput(JOB_ID).fullOutputPath, '', 'no output.txt under the root: no path at all');
  fs.writeFileSync(path.join(h.jobDir(), 'output.txt'), 'full output');
  assert.equal(h.tracker.readOutput(JOB_ID).fullOutputPath, path.join(h.root, '.jenny', 'tool-results', JOB_ID, 'output.txt'));
});
