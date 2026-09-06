'use strict';

// W2-2: background-job chip strip (renderer-background-jobs.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createBackgroundJobsStrip,
  formatElapsed,
} = require('../renderer/chat/renderer-background-jobs');

function makeStrip(t, overrides = {}) {
  const dom = new JSDOM('<div id="backgroundJobsStrip" class="hidden" aria-hidden="true"></div>');
  const container = dom.window.document.getElementById('backgroundJobsStrip');
  const toasts = [];
  const killCalls = [];
  let onChangedListener = null;
  const jennyShell = {
    backgroundJobs: {
      onChanged(listener) {
        onChangedListener = listener;
        return () => { onChangedListener = null; };
      },
      getState: overrides.getState || (async () => ({ jobs: [], generatedAt: '' })),
      kill: overrides.kill || (async (jobId) => {
        killCalls.push(jobId);
        return { ok: true, reason: '' };
      }),
    },
  };
  const strip = createBackgroundJobsStrip({
    container,
    jennyShell,
    showToastMessage: (message, options) => toasts.push({ message, options }),
    getActiveSessionId: () => overrides.activeSessionId ?? 'session-1',
    nowFn: overrides.nowFn || (() => 100_000),
  });
  strip.attach();
  t.after(() => strip.detach());
  return {
    strip,
    container,
    toasts,
    killCalls,
    push: (jobs) => onChangedListener && onChangedListener({ jobs, generatedAt: '' }),
  };
}

function runningJob(overrides = {}) {
  return {
    jobId: 'abc123def456',
    sessionId: 'session-1',
    command: 'npm run build',
    state: 'running',
    pid: 42,
    exitCode: null,
    error: '',
    startedAtMs: 40_000,
    endedAtMs: 0,
    ...overrides,
  };
}

test('a running job renders a chip with command, elapsed time, and a Stop button', (t) => {
  const { container, push } = makeStrip(t);
  push([runningJob()]);

  assert.equal(container.classList.contains('hidden'), false);
  const chip = container.querySelector('.background-job-chip');
  assert.ok(chip);
  assert.equal(chip.dataset.jobState, 'running');
  assert.equal(chip.querySelector('.background-job-chip-command').textContent, 'npm run build');
  // nowFn 100_000 - startedAtMs 40_000 = 60s
  assert.equal(chip.querySelector('.background-job-chip-status').textContent, '01:00');
  assert.equal(chip.querySelector('.background-job-chip-action').textContent, 'Stop');
  assert.equal(chip.querySelector('.background-job-chip-action').title, 'Stop this background job');
});

test('an authoritative empty push wins over an older initial pull', async (t) => {
  let resolveInitialPull;
  const initialPull = new Promise((resolve) => { resolveInitialPull = resolve; });
  const { container, push } = makeStrip(t, { getState: () => initialPull });

  push([]);
  resolveInitialPull({ jobs: [runningJob({ jobId: 'stale', command: 'old' })] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(container.querySelectorAll('.background-job-chip').length, 0);
  assert.equal(container.classList.contains('hidden'), true);
});

test('Stop click invokes backgroundJobs.kill with the job id', (t) => {
  const { container, push, killCalls } = makeStrip(t);
  push([runningJob()]);
  container.querySelector('.background-job-chip-action').click();
  assert.deepEqual(killCalls, ['abc123def456']);
});

test('a failed kill surfaces a toast', async (t) => {
  const { container, push, toasts } = makeStrip(t, {
    kill: async () => ({ ok: false, reason: 'pid_unknown' }),
  });
  push([runningJob()]);
  container.querySelector('.background-job-chip-action').click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /Could not stop/);
});

test('running→terminal transition toasts once; already-terminal snapshots stay silent', (t) => {
  const { push, toasts } = makeStrip(t);
  push([runningJob()]);
  assert.equal(toasts.length, 0);
  push([runningJob({ state: 'completed', exitCode: 0, endedAtMs: 90_000 })]);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /Background job finished: npm run build/);
  assert.doesNotMatch(toasts[0].message, /other session/);
  // Re-pushing the same terminal snapshot must not re-toast.
  push([runningJob({ state: 'completed', exitCode: 0, endedAtMs: 90_000 })]);
  assert.equal(toasts.length, 1);
});

test('a job owned by another session tags its completion toast', (t) => {
  const { push, toasts } = makeStrip(t, { activeSessionId: 'session-OTHER' });
  push([runningJob()]);
  push([runningJob({ state: 'failed', exitCode: 1, error: 'boom', endedAtMs: 90_000 })]);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /Background job failed: npm run build \(other session\)/);
});

test('terminal chips swap to a dismiss action that hides the chip locally', (t) => {
  const { container, push } = makeStrip(t);
  push([runningJob({ state: 'completed', exitCode: 0, endedAtMs: 90_000 })]);
  const action = container.querySelector('.background-job-chip-action');
  assert.equal(action.textContent, '✕');
  assert.equal(action.title, 'Dismiss this job');
  action.click();
  assert.equal(container.querySelectorAll('.background-job-chip').length, 0);
  assert.equal(container.classList.contains('hidden'), true);
  // A later snapshot still carrying the dismissed job stays hidden.
  push([runningJob({ state: 'completed', exitCode: 0, endedAtMs: 90_000 })]);
  assert.equal(container.querySelectorAll('.background-job-chip').length, 0);
});

test('a killing job disables its Stop button and shows the stopping label', (t) => {
  const { container, push } = makeStrip(t);
  push([runningJob({ state: 'killing' })]);
  const chip = container.querySelector('.background-job-chip');
  assert.equal(chip.querySelector('.background-job-chip-status').textContent, 'Stopping…');
  assert.equal(chip.querySelector('.background-job-chip-action').disabled, true);
});

test('more than four visible jobs collapse into an overflow count', (t) => {
  const { container, push } = makeStrip(t);
  const jobs = Array.from({ length: 6 }, (_, i) => runningJob({
    jobId: `${i}bc123def456`,
    command: `job-${i}`,
  }));
  push(jobs);
  assert.equal(container.querySelectorAll('.background-job-chip:not(.background-job-chip-overflow)').length, 4);
  const overflow = container.querySelector('.background-job-chip-overflow');
  assert.equal(overflow.textContent, '+2 more');
});

test('tickElapsed patches the elapsed label without a re-render', (t) => {
  let now = 100_000;
  const { strip, container, push } = makeStrip(t, { nowFn: () => now });
  push([runningJob()]);
  const status = container.querySelector('.background-job-chip-status');
  assert.equal(status.textContent, '01:00');
  now = 161_000; // +61s
  strip.tickElapsed();
  assert.equal(status.textContent, '02:01');
  // Same node patched in place — no rebuild.
  assert.equal(container.querySelector('.background-job-chip-status'), status);
});

test('job-derived text renders via textContent, never as markup', (t) => {
  const { container, push } = makeStrip(t);
  push([runningJob({ command: '<img src=x onerror=alert(1)>' })]);
  assert.equal(container.querySelectorAll('img').length, 0);
  assert.match(
    container.querySelector('.background-job-chip-command').textContent,
    /<img src=x/
  );
});

test('formatElapsed covers minute and hour shapes', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(59_999), '00:59');
  assert.equal(formatElapsed(61_000), '01:01');
  assert.equal(formatElapsed(3_600_000 + 65_000), '1:01:05');
});
