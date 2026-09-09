'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUnattendedGuard } = require('../services/main/unattended-guard');

function createHarness({
  idleSeconds = 0,
  thresholdMinutes = 5,
  enabled = true,
  runMode = 'auto',
  pauseResult = { requested: true },
  powerMonitor = null,
} = {}) {
  let currentIdleSeconds = idleSeconds;
  let currentThresholdMinutes = thresholdMinutes;
  let currentEnabled = enabled;
  let currentPauseResult = pauseResult;
  const activeStreams = new Map([['stream-1', {}]]);
  const sessions = new Map([['session-1', {
    id: 'session-1',
    run_mode: runMode,
    active_turn: { stream_id: 'stream-1' },
  }]]);
  const pauseCalls = [];
  const bridgeEvents = [];
  const logs = [];
  const intervals = [];
  const cleared = [];
  const backend = {
    activeStreams,
    sessionStore: {
      listSessionRecords: () => [...sessions.values()],
    },
    pauseSessionAutoRun(sessionId, options) {
      pauseCalls.push({ sessionId, options });
      if (currentPauseResult instanceof Error) throw currentPauseResult;
      return currentPauseResult;
    },
  };
  const guard = createUnattendedGuard({
    powerMonitor: powerMonitor || {
      getSystemIdleTime: () => currentIdleSeconds,
    },
    getBackendService: () => backend,
    getThresholdMinutes: () => currentThresholdMinutes,
    isEnabled: () => currentEnabled,
    sendBridgeEvent: (event, payload) => bridgeEvents.push({ event, payload }),
    log: (level, event, details) => logs.push({ level, event, details }),
    setIntervalFn(callback, intervalMs) {
      const timer = { callback, intervalMs, unrefCalls: 0, unref() { this.unrefCalls += 1; } };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => cleared.push(timer),
  });
  return {
    activeStreams,
    backend,
    bridgeEvents,
    cleared,
    guard,
    intervals,
    logs,
    pauseCalls,
    sessions,
    setEnabled: (value) => { currentEnabled = value; },
    setIdleSeconds: (value) => { currentIdleSeconds = value; },
    setPauseResult: (value) => { currentPauseResult = value; },
    setThresholdMinutes: (value) => { currentThresholdMinutes = value; },
  };
}

test('idle threshold requests one unattended pause per auto stream', () => {
  const harness = createHarness({ idleSeconds: 299 });

  harness.guard.tick();
  assert.deepEqual(harness.pauseCalls, []);

  harness.setIdleSeconds(300);
  harness.guard.tick();
  harness.guard.tick();

  assert.deepEqual(harness.pauseCalls, [{
    sessionId: 'session-1',
    options: { streamId: 'stream-1', reason: 'unattended_idle', idleSeconds: 300 },
  }]);
  assert.deepEqual(harness.bridgeEvents, [{
    event: 'safety.onUnattendedPause',
    payload: {
      session_id: 'session-1',
      stream_id: 'stream-1',
      idle_seconds: 300,
      threshold_minutes: 5,
      state: 'requested',
    },
  }]);
});

test('a removed stream is pruned and a replacement stream can pause', () => {
  const harness = createHarness({ idleSeconds: 300 });

  harness.guard.tick();
  harness.activeStreams.delete('stream-1');
  harness.guard.tick();
  harness.sessions.set('session-1', {
    id: 'session-1',
    run_mode: 'auto',
    active_turn: { request_id: 'stream-2' },
  });
  harness.activeStreams.set('stream-2', {});
  harness.guard.tick();

  assert.deepEqual(harness.pauseCalls.map((call) => call.options.streamId), [
    'stream-1',
    'stream-2',
  ]);
  assert.deepEqual(harness.guard.snapshot().pausedStreamIds, ['stream-2']);
});

test('non-auto sessions are skipped', () => {
  const harness = createHarness({ idleSeconds: 300, runMode: 'ask' });

  harness.guard.tick();

  assert.deepEqual(harness.pauseCalls, []);
  assert.deepEqual(harness.bridgeEvents, []);
});

test('disabled and invalid-threshold ticks stay inert', () => {
  const harness = createHarness({ idleSeconds: 999, enabled: false });

  harness.guard.tick();
  harness.setEnabled(true);
  for (const threshold of [0, undefined, Number.NaN]) {
    harness.setThresholdMinutes(threshold);
    harness.guard.tick();
  }

  assert.deepEqual(harness.pauseCalls, []);
  assert.deepEqual(harness.bridgeEvents, []);
});

test('start logs a missing idle API once and stays unavailable', () => {
  const harness = createHarness({ powerMonitor: {} });

  harness.guard.start();
  harness.guard.start();

  assert.equal(harness.guard.snapshot().unavailable, true);
  assert.equal(harness.guard.snapshot().running, false);
  assert.equal(harness.intervals.length, 0);
  assert.deepEqual(harness.logs, [{
    level: 'WARN',
    event: 'unattended_guard.unavailable',
    details: { reason: 'no_idle_api' },
  }]);
});

test('a rejected pause stays retryable and a successful retry is one-shot', () => {
  const harness = createHarness({
    idleSeconds: 300,
    pauseResult: { requested: false, reason: 'transport_unavailable' },
  });

  harness.guard.tick();

  assert.deepEqual(harness.bridgeEvents, []);
  assert.equal(harness.logs.at(-1).event, 'unattended_guard.pause_skipped');
  assert.equal(harness.logs.at(-1).details.reason, 'transport_unavailable');

  harness.setPauseResult({ requested: true });
  harness.guard.tick();
  harness.guard.tick();

  assert.equal(harness.pauseCalls.length, 2);
  assert.equal(harness.bridgeEvents.length, 1);
});

test('tick swallows a thrown backend error and retries on the next tick', () => {
  const harness = createHarness({
    idleSeconds: 300,
    pauseResult: new Error('backend exploded'),
  });

  assert.doesNotThrow(() => harness.guard.tick());
  harness.setPauseResult({ requested: true });
  assert.doesNotThrow(() => harness.guard.tick());

  assert.equal(harness.pauseCalls.length, 2);
  assert.equal(harness.bridgeEvents.length, 1);
  assert.equal(
    harness.logs.filter((entry) => entry.event === 'unattended_guard.tick_failed').length,
    1
  );
});

test('start is idempotent, ticks immediately, unrefs the timer, and stop clears state', () => {
  const harness = createHarness({ idleSeconds: 300 });

  harness.guard.start();
  harness.guard.start();

  assert.equal(harness.pauseCalls.length, 1);
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].unrefCalls, 1);
  assert.equal(harness.guard.snapshot().running, true);

  harness.guard.stop();
  harness.guard.stop();

  assert.deepEqual(harness.cleared, [harness.intervals[0]]);
  assert.deepEqual(harness.guard.snapshot(), {
    running: false,
    pausedStreamIds: [],
    unavailable: false,
  });
});
