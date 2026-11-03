'use strict';

// Row 96: taskbar progress for the most recent live test run
// (services/main/test-progress-taskbar.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MIN_UPDATE_GAP_MS,
  createTestProgressTaskbar,
  wireTestProgressTaskbar,
} = require('../services/main/test-progress-taskbar');

function makeHarness({ enabled = () => true } = {}) {
  let clock = 1_000_000;
  const timers = [];
  const calls = [];
  const win = {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    setProgressBar(...args) { calls.push(args); },
  };
  const taskbar = createTestProgressTaskbar({
    getMainWindow: () => win,
    enabled: () => enabled(),
    now: () => clock,
    setTimeoutImpl: (fn, ms) => {
      const handle = { fn, ms, cleared: false, fired: false };
      timers.push(handle);
      return handle;
    },
    clearTimeoutImpl: (handle) => { handle.cleared = true; },
  });
  return {
    taskbar,
    calls,
    win,
    timers,
    advance: (ms) => { clock += ms; },
    // Fire the pending (uncleared) timers, as the real clock would after their delay.
    fire() {
      const pending = timers.filter((timer) => !timer.cleared && !timer.fired);
      for (const timer of pending) { timer.fired = true; timer.fn(); }
      return pending.length;
    },
  };
}

function progressEvent(overrides = {}) {
  return { type: 'tool_test_progress', sessionId: 's1', streamId: 'st1', callId: 'c1', percent: 40, failed: 0, final: false, ...overrides };
}

test('a foreground run sets normal mode, flips to error on a failure, and clears on final', () => {
  const h = makeHarness();
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 40 }));
  assert.deepEqual(h.calls, [[0.4, { mode: 'normal' }]]);
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 60, failed: 1 }));
  assert.deepEqual(h.calls.at(-1), [0.6, { mode: 'error' }]);
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 100, failed: 1, final: true }));
  assert.deepEqual(h.calls.at(-1), [-1]);
});

test('a terminal event for the stream clears every run of that stream only', () => {
  const h = makeHarness();
  h.taskbar.handleChatStreamEvent(progressEvent({ callId: 'a', streamId: 'st1', percent: 30 }));
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleChatStreamEvent(progressEvent({ callId: 'b', streamId: 'st2', percent: 70 }));
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleChatStreamEvent({ type: 'complete', sessionId: 's1', streamId: 'st2' });
  assert.deepEqual(h.calls.at(-1), [0.3, { mode: 'normal' }], 'the other stream is still live');
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleChatStreamEvent({ type: 'error', sessionId: 's1', streamId: 'st1', terminal_status: 'cancelled' });
  assert.deepEqual(h.calls.at(-1), [-1], 'a Stop also clears');
});

test('the most recently updated run with a percent wins; runs without a percent are skipped', () => {
  const h = makeHarness();
  h.taskbar.handleChatStreamEvent(progressEvent({ callId: 'a', percent: 20 }));
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleChatStreamEvent(progressEvent({ callId: 'tap', percent: null }));
  assert.equal(h.calls.length, 1, 'a TAP run without a percent changes nothing');
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleBackgroundJobs([{ jobId: 'job1', state: 'running', progress: { percent: 55, failed: 2 } }]);
  assert.deepEqual(h.calls.at(-1), [0.55, { mode: 'error' }]);
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleChatStreamEvent(progressEvent({ callId: 'a', percent: 25 }));
  assert.deepEqual(h.calls.at(-1), [0.25, { mode: 'normal' }], 'the foreground run updated last');
});

test('background jobs: finished, progress-less and vanished jobs clear', () => {
  const h = makeHarness();
  h.taskbar.handleBackgroundJobs([
    { jobId: 'j1', state: 'running', progress: { percent: 10, failed: 0 } },
    { jobId: 'j2', state: 'running', progress: null },
    { jobId: 'j3', state: 'completed', progress: { percent: 99, failed: 0 } },
  ]);
  assert.deepEqual(h.calls, [[0.1, { mode: 'normal' }]]);
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleBackgroundJobs([{ jobId: 'j1', state: 'completed', progress: null }]);
  assert.deepEqual(h.calls.at(-1), [-1]);
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleBackgroundJobs([]);
  assert.equal(h.calls.length, 2, 'nothing live and nothing set: no further call');
});

test('updates are trailing-throttled to one per 250 ms', () => {
  const h = makeHarness();
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 10 }));
  assert.equal(h.calls.length, 1);
  h.advance(50);
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 20 }));
  h.advance(50);
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 30 }));
  assert.equal(h.calls.length, 1, 'bursts inside the window are held');
  assert.equal(h.timers.length, 1, 'one trailing timer covers the burst');
  assert.equal(h.timers[0].ms, MIN_UPDATE_GAP_MS - 50);
  h.advance(MIN_UPDATE_GAP_MS - 100);
  assert.equal(h.fire(), 1);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(h.calls.at(-1), [0.3, { mode: 'normal' }], 'the trailing update carries the latest value');
});

test('a disabled flag never sets the bar and clears once if it had', () => {
  let on = true;
  const h = makeHarness({ enabled: () => on });
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 50 }));
  assert.equal(h.calls.length, 1);
  on = false;
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 60 }));
  assert.deepEqual(h.calls.at(-1), [-1]);
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 70 }));
  assert.equal(h.calls.length, 2, 'no repeat clear while disabled');

  const off = makeHarness({ enabled: () => false });
  off.taskbar.handleChatStreamEvent(progressEvent({ percent: 50 }));
  off.taskbar.handleBackgroundJobs([{ jobId: 'j1', state: 'running', progress: { percent: 5, failed: 0 } }]);
  assert.deepEqual(off.calls, []);
});

test('a missing or destroyed window is skipped without throwing', () => {
  const h = makeHarness();
  h.win.destroyed = true;
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 50 }));
  assert.deepEqual(h.calls, []);
  const none = createTestProgressTaskbar({ getMainWindow: () => null });
  assert.doesNotThrow(() => none.handleChatStreamEvent(progressEvent({ percent: 50 })));
  assert.doesNotThrow(() => none.dispose());
});

test('malformed events are ignored; dispose clears the bar and stops the timer', () => {
  const h = makeHarness();
  h.taskbar.handleChatStreamEvent(null);
  h.taskbar.handleChatStreamEvent({ type: 'tool_test_progress' });
  h.taskbar.handleChatStreamEvent({ type: 'delta', streamId: 'st1' });
  h.taskbar.handleBackgroundJobs(null);
  assert.deepEqual(h.calls, []);
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 10 }));
  h.advance(10);
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 20 }));
  h.taskbar.dispose();
  assert.equal(h.timers[0].cleared, true);
  assert.deepEqual(h.calls.at(-1), [-1]);
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 30 }));
  assert.equal(h.timers.length, 1, 'a disposed taskbar schedules nothing');
});

test('wireTestProgressTaskbar subscribes to the stream and tracker and honors the live flag', () => {
  function wire(flags) {
    const listeners = { stream: [], jobs: [] };
    const backend = {
      featureFlags: flags,
      on: (name, fn) => { assert.equal(name, 'chat-stream'); listeners.stream.push(fn); },
    };
    const tracker = {
      onChanged: (fn) => listeners.jobs.push(fn),
      getState: () => ({ jobs: [{ jobId: 'j1', state: 'running', progress: { percent: 80, failed: 0 } }] }),
    };
    const calls = [];
    const win = { isDestroyed: () => false, setProgressBar: (...args) => calls.push(args) };
    wireTestProgressTaskbar(backend, tracker, { getMainWindow: () => win });
    return { listeners, calls };
  }
  const on = wire({ test_progress: true });
  on.listeners.jobs[0](['s1']);
  assert.deepEqual(on.calls, [[0.8, { mode: 'normal' }]]);
  assert.doesNotThrow(() => on.listeners.stream[0](null));

  const off = wire({ test_progress: false });
  off.listeners.jobs[0](['s1']);
  off.listeners.stream[0]({ type: 'tool_test_progress', streamId: 'st', callId: 'c', percent: 10, failed: 0 });
  assert.deepEqual(off.calls, [], 'the kill switch keeps the taskbar untouched');

  const unset = wire(undefined);
  unset.listeners.jobs[0](['s1']);
  assert.equal(unset.calls.length, 1, 'an absent flag object means default-on');
});

test('a late or out-of-order batch after the final one does not revive the run', () => {
  const h = makeHarness();
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 50, sequence: 5 }));
  h.advance(MIN_UPDATE_GAP_MS);
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 40, sequence: 4 }));
  assert.deepEqual(h.calls.at(-1), [0.5, { mode: 'normal' }], 'an older batch is ignored');
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 100, sequence: 7, final: true }));
  h.advance(MIN_UPDATE_GAP_MS);
  h.fire();
  h.taskbar.handleChatStreamEvent(progressEvent({ percent: 90, sequence: 6 }));
  h.advance(MIN_UPDATE_GAP_MS);
  h.fire();
  assert.deepEqual(h.calls.at(-1), [-1], 'the bar stays cleared');
});
