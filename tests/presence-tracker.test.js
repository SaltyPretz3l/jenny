'use strict';

/**
 * tests/presence-tracker.test.js
 *
 * Row 86 D1: the presence tracker writes `lastPresentAt` only on edges, stamps
 * the last instant the person was seen present, fires `onReturn` once per
 * away -> present edge after a long enough absence, and never throws out of a
 * broken port.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createPresenceTracker, DEFAULT_AWAY_THRESHOLD_MS, DEFAULT_IDLE_THRESHOLD_SECONDS,
} = require('../services/main/presence-tracker');

const T0 = Date.parse('2026-11-02T08:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();

function harness({ persisted = null, ...overrides } = {}) {
  const env = {
    nowMs: T0, focused: true, idle: 0, persisted, writes: [], returns: [], logs: [],
  };
  const tracker = createPresenceTracker({
    isWindowPresent: () => env.focused,
    getSystemIdleSeconds: () => env.idle,
    readLastPresentAt: () => env.persisted,
    writeLastPresentAt: (value) => { env.writes.push(value); env.persisted = value; },
    onReturn: (event) => env.returns.push(event),
    now: () => env.nowMs,
    log: (line) => env.logs.push(line),
    ...overrides,
  });
  env.tracker = tracker;
  env.advance = (ms) => { env.nowMs += ms; };
  return env;
}

test('defaults match the plan: 5 min idle, 4 h away', () => {
  assert.equal(DEFAULT_IDLE_THRESHOLD_SECONDS, 300);
  assert.equal(DEFAULT_AWAY_THRESHOLD_MS, 4 * HOUR);
});

test('N present ticks write nothing', () => {
  const env = harness();
  for (let i = 0; i < 50; i += 1) {
    env.tracker.tick();
    env.advance(30 * 1000);
  }
  assert.deepEqual(env.writes, []);
  assert.equal(env.tracker.state().present, true);
  assert.equal(env.tracker.state().lastSeenPresentAt, iso(T0 + 49 * 30 * 1000));
});

test('present -> away writes the last instant seen present, once', () => {
  const env = harness();
  env.tracker.tick();
  env.advance(30 * 1000);
  env.tracker.tick(); // last seen present at T0 + 30 s
  env.advance(30 * 1000);
  env.idle = DEFAULT_IDLE_THRESHOLD_SECONDS; // the threshold itself is away
  env.tracker.tick();
  env.advance(30 * 1000);
  env.tracker.tick();
  assert.deepEqual(env.writes, [iso(T0 + 30 * 1000)]);
  assert.deepEqual(env.tracker.state(), {
    present: false, lastPresentAt: iso(T0 + 30 * 1000), lastSeenPresentAt: iso(T0 + 30 * 1000),
  });
});

test('blur is an away edge; a visible-but-unfocused window is not present', () => {
  const env = harness();
  env.tracker.tick();
  env.advance(10 * 1000);
  env.tracker.noteBlur();
  assert.deepEqual(env.writes, [iso(T0)]);
  env.focused = false;
  env.advance(10 * 1000);
  env.tracker.noteFocus();
  assert.equal(env.tracker.state().present, false);
  assert.equal(env.writes.length, 1);
});

test('return after >= 4 h calls onReturn once with the right since', () => {
  const env = harness();
  env.tracker.tick();
  env.focused = false;
  env.advance(MIN);
  env.tracker.tick(); // away, wrote T0
  env.advance(4 * HOUR);
  env.tracker.tick(); // still away: no return
  assert.equal(env.returns.length, 0);
  env.focused = true;
  const returnedAt = env.nowMs;
  env.tracker.noteFocus();
  env.advance(30 * 1000);
  env.tracker.tick();
  env.tracker.noteFocus();
  assert.deepEqual(env.returns, [{ since: iso(T0), returnedAt: iso(returnedAt), awayMs: returnedAt - T0 }]);
  assert.equal(env.writes.length, 1, 'returning writes nothing');
});

test('exactly the threshold returns; just under does not', () => {
  const exact = harness();
  exact.tracker.tick();
  exact.tracker.noteBlur();
  exact.advance(4 * HOUR);
  exact.tracker.tick();
  assert.equal(exact.returns.length, 1);
  assert.equal(exact.returns[0].awayMs, 4 * HOUR);

  const short = harness();
  short.tracker.tick();
  short.tracker.noteBlur();
  short.advance(4 * HOUR - 1);
  short.tracker.tick();
  assert.deepEqual(short.returns, []);
  assert.equal(short.tracker.state().present, true);
});

test('startup present against a 5 h old persisted value fires', () => {
  const persisted = iso(T0 - 5 * HOUR);
  const env = harness({ persisted });
  env.tracker.tick();
  assert.deepEqual(env.returns, [{ since: persisted, returnedAt: iso(T0), awayMs: 5 * HOUR }]);
  assert.deepEqual(env.writes, []);
});

test('startup present against a recent or missing persisted value only becomes present', () => {
  for (const persisted of [iso(T0 - HOUR), null, 'not a date', '']) {
    const env = harness({ persisted });
    env.tracker.tick();
    assert.deepEqual(env.returns, [], String(persisted));
    assert.equal(env.tracker.state().present, true);
  }
});

test('startup away writes nothing, then returning measures against the persisted value', () => {
  const persisted = iso(T0 - 6 * HOUR);
  const env = harness({ persisted });
  env.focused = false;
  env.tracker.tick();
  env.tracker.noteBlur();
  env.tracker.noteSuspend();
  assert.deepEqual(env.writes, []);
  assert.equal(env.tracker.state().present, false);
  env.advance(MIN);
  env.focused = true;
  env.tracker.tick();
  assert.deepEqual(env.returns, [{ since: persisted, returnedAt: iso(T0 + MIN), awayMs: 6 * HOUR + MIN }]);
});

test('suspend is an away edge; resume after a long sleep returns', () => {
  const env = harness();
  env.tracker.tick();
  env.advance(20 * 1000);
  env.tracker.tick();
  env.advance(5 * 1000);
  env.tracker.noteSuspend();
  assert.deepEqual(env.writes, [iso(T0 + 20 * 1000)]);
  env.advance(8 * HOUR);
  env.tracker.noteResume();
  assert.equal(env.returns.length, 1);
  assert.equal(env.returns[0].since, iso(T0 + 20 * 1000));
  assert.equal(env.returns[0].awayMs, 8 * HOUR + 5 * 1000);
});

test('quit while present writes now; quit while away writes nothing', () => {
  const env = harness();
  env.tracker.tick();
  env.advance(15 * 1000);
  env.tracker.noteQuit();
  assert.deepEqual(env.writes, [iso(T0 + 15 * 1000)]);
  env.tracker.noteQuit();
  assert.equal(env.writes.length, 1, 'a second quit does not write again');

  const away = harness();
  away.tracker.tick();
  away.tracker.noteBlur();
  away.tracker.noteQuit();
  assert.deepEqual(away.writes, [iso(T0)]);
});

test('throwing ports never throw out and count as not present', () => {
  const boom = () => { throw new Error('boom'); };
  const env = harness({
    persisted: iso(T0 - 5 * HOUR),
    isWindowPresent: boom,
  });
  for (let i = 0; i < 3; i += 1) assert.doesNotThrow(() => env.tracker.tick());
  assert.equal(env.tracker.state().present, false);
  assert.equal(env.logs.length, 1, 'logged once');
  assert.match(env.logs[0], /isWindowPresent failed: boom/);

  const idleBroken = harness({ getSystemIdleSeconds: boom });
  idleBroken.tracker.tick();
  assert.equal(idleBroken.tracker.state().present, false);

  const allBroken = harness({
    readLastPresentAt: boom, writeLastPresentAt: boom, onReturn: boom, log: boom,
  });
  assert.doesNotThrow(() => {
    allBroken.tracker.tick();
    allBroken.tracker.noteBlur();
    allBroken.advance(5 * HOUR);
    allBroken.tracker.noteFocus();
    allBroken.tracker.noteQuit();
  });
  // The failed write is still remembered in-process, so the return was measured.
  assert.equal(allBroken.tracker.state().lastPresentAt, iso(T0 + 5 * HOUR));

  const nowBroken = harness({ now: boom });
  assert.doesNotThrow(() => nowBroken.tracker.tick());
  assert.equal(nowBroken.tracker.state().present, false);
});

test('a throwing onReturn is logged and the tracker stays present', () => {
  const env = harness({
    persisted: iso(T0 - 5 * HOUR),
    onReturn: () => { throw new Error('submit failed'); },
  });
  assert.doesNotThrow(() => env.tracker.tick());
  assert.equal(env.tracker.state().present, true);
  assert.match(env.logs[0], /onReturn failed: submit failed/);
});

test('a non-numeric idle reading is not present', () => {
  const env = harness();
  env.idle = undefined;
  env.tracker.tick();
  assert.equal(env.tracker.state().present, false);
  env.idle = -1;
  env.tracker.tick();
  assert.equal(env.tracker.state().present, false);
});

test('clock skew backwards is no return and no throw', () => {
  const env = harness({ persisted: iso(T0 + 10 * HOUR) });
  assert.doesNotThrow(() => env.tracker.tick());
  assert.deepEqual(env.returns, []);
  assert.equal(env.tracker.state().present, true);

  const live = harness();
  live.tracker.tick();
  live.tracker.noteBlur();
  live.advance(-6 * HOUR);
  live.tracker.tick();
  assert.deepEqual(live.returns, []);
  assert.equal(live.tracker.state().present, true);
});

test('custom thresholds are honoured', () => {
  const env = harness({ idleThresholdSeconds: 60, awayThresholdMs: HOUR });
  env.idle = 59;
  env.tracker.tick();
  assert.equal(env.tracker.state().present, true);
  env.advance(MIN);
  env.idle = 60;
  env.tracker.tick();
  assert.deepEqual(env.writes, [iso(T0)]);
  env.advance(HOUR);
  env.idle = 0;
  env.tracker.tick();
  assert.equal(env.returns.length, 1);
});
