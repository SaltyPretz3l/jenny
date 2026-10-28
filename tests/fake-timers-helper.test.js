'use strict';

// Pins the shared virtual clock in tests/helpers/fake-timers.js, chiefly the
// runPending()/delays() pair the debounce suites flush through.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFakeTimers } = require('./helpers/fake-timers');

test('tick fires due tasks in due-time order and advances the clock', () => {
  const timers = createFakeTimers();
  const fired = [];
  timers.setTimeout(() => fired.push(['b', timers.now()]), 20);
  timers.setTimeout(() => fired.push(['a', timers.now()]), 10);
  timers.setTimeout(() => fired.push(['c', timers.now()]), 50);
  timers.tick(30);
  assert.deepEqual(fired, [['a', 10], ['b', 20]]);
  assert.equal(timers.now(), 30);
  assert.equal(timers.pending(), 1);
});

test('delays lists the pending requests in schedule order and drops cleared ones', () => {
  const timers = createFakeTimers();
  timers.setTimeout(() => {}, 300);
  const cleared = timers.setTimeout(() => {}, 5);
  timers.setTimeout(() => {}, -4);
  timers.clearTimeout(cleared);
  assert.deepEqual(timers.delays(), [300, 0]);
});

test('runPending fires every pending task whatever its delay, in due order, moving the clock forward', () => {
  const timers = createFakeTimers();
  const fired = [];
  timers.setTimeout(() => fired.push(['late', timers.now()]), 60000);
  timers.setTimeout(() => fired.push(['first', timers.now()]), 100);
  timers.setTimeout(() => fired.push(['tie', timers.now()]), 100);
  timers.runPending();
  assert.deepEqual(fired, [['first', 100], ['tie', 100], ['late', 60000]]);
  assert.equal(timers.pending(), 0);
  assert.equal(timers.now(), 60000);
});

test('runPending leaves tasks scheduled by its callbacks pending and skips tasks they clear', () => {
  const timers = createFakeTimers();
  const fired = [];
  let victim = 0;
  timers.setTimeout(() => {
    fired.push('one');
    timers.clearTimeout(victim);
    timers.setTimeout(() => fired.push('rescheduled'), 0);
  }, 10);
  victim = timers.setTimeout(() => fired.push('victim'), 20);
  timers.runPending();
  assert.deepEqual(fired, ['one']);
  assert.deepEqual(timers.delays(), [0]);
  timers.runPending();
  assert.deepEqual(fired, ['one', 'rescheduled']);
});

test('runPending fires an interval once and keeps it scheduled', () => {
  const timers = createFakeTimers();
  let count = 0;
  const id = timers.setInterval(() => { count += 1; }, 1000);
  timers.runPending();
  assert.equal(count, 1);
  assert.equal(timers.pending(), 1);
  timers.tick(1000);
  assert.equal(count, 2);
  timers.clearInterval(id);
  assert.equal(timers.pending(), 0);
});
