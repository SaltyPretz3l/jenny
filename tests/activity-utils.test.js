const test = require('node:test');
const assert = require('node:assert/strict');

const { createActivityRegistry } = require('../renderer/shared/activity-utils');

function createTimerHarness() {
  let now = 0;
  let nextId = 1;
  const timers = [];

  function setTimeoutMock(fn, delay) {
    const id = nextId++;
    timers.push({
      id,
      fn,
      dueAt: now + Math.max(Number(delay) || 0, 0),
      active: true,
    });
    return id;
  }

  function clearTimeoutMock(id) {
    const timer = timers.find((entry) => entry.id === id);
    if (timer) {
      timer.active = false;
    }
  }

  function advance(ms) {
    now += Math.max(Number(ms) || 0, 0);
    let executed = true;
    while (executed) {
      executed = false;
      const due = timers
        .filter((entry) => entry.active && entry.dueAt <= now)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
      if (!due.length) {
        continue;
      }
      executed = true;
      const timer = due[0];
      timer.active = false;
      timer.fn();
    }
  }

  return {
    advance,
    clearTimeoutMock,
    now: () => now,
    setTimeoutMock,
  };
}

test('activity registry settles and clears resolved work using default timings', () => {
  const timerHarness = createTimerHarness();
  const registry = createActivityRegistry({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  registry.beginActivity('composer.preferredModel');
  registry.resolveActivity('composer.preferredModel');
  assert.equal(registry.getActivitySnapshot('composer.preferredModel').state, 'success');
  timerHarness.advance(600);
  assert.equal(registry.getActivitySnapshot('composer.preferredModel').state, 'settle');
  timerHarness.advance(180);
  assert.equal(registry.getActivitySnapshot('composer.preferredModel'), null);
});

test('activity registry retains previousValue for revert-on-error flows', () => {
  const timerHarness = createTimerHarness();
  const registry = createActivityRegistry({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  registry.beginActivity('composer.planMode', {
    previousValue: { planMode: false },
  });
  registry.failActivity('composer.planMode', {
    message: 'Could not save plan mode.',
  });

  const snapshot = registry.getActivitySnapshot('composer.planMode');
  assert.deepEqual(snapshot.previousValue, { planMode: false });
  assert.equal(snapshot.message, 'Could not save plan mode.');
});

test('activity registry reports reduced motion in snapshots', () => {
  const registry = createActivityRegistry({
    matchMedia: () => ({ matches: true }),
  });

  registry.beginActivity('settings.modelLoad');

  const snapshot = registry.getActivitySnapshot('settings.modelLoad');
  assert.equal(snapshot.reducedMotion, true);
});
