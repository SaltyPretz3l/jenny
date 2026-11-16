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

test('a failed activity stays until its scope is begun again, unless the caller times it', () => {
  const timerHarness = createTimerHarness();
  const registry = createActivityRegistry({
    now: timerHarness.now,
    setTimeout: timerHarness.setTimeoutMock,
    clearTimeout: timerHarness.clearTimeoutMock,
  });

  registry.failActivity('composer.runMode', { message: 'Could not save run mode.' });
  timerHarness.advance(60_000);
  assert.equal(registry.getActivitySnapshot('composer.runMode').state, 'error');
  assert.equal(registry.getActivitySnapshot('composer.runMode').message, 'Could not save run mode.');
  registry.beginActivity('composer.runMode');
  assert.equal(registry.getActivitySnapshot('composer.runMode').state, 'pending');
  assert.equal(registry.getActivitySnapshot('composer.runMode').message, '');

  registry.failActivity('settings.timed', { message: 'x', autoClearMs: 600 });
  timerHarness.advance(600);
  timerHarness.advance(180);
  assert.equal(registry.getActivitySnapshot('settings.timed'), null);
});

test('clearFailedActivities drops failed scopes under the given prefixes only', () => {
  const cleared = [];
  const registry = createActivityRegistry({ onChange: (scope, snapshot, meta) => { if (meta.reason === 'clear') cleared.push(scope); } });

  registry.failActivity('composer.runMode', { message: 'a' });
  registry.failActivity('settings.contextPreferences', { message: 'b' });
  registry.failActivity('backend.failed', { message: 'c' });
  registry.beginActivity('composer.preferredModel:s1');
  registry.clearFailedActivities(['composer.', 'settings.']);

  assert.deepEqual(cleared.sort(), ['composer.runMode', 'settings.contextPreferences']);
  assert.equal(registry.getActivitySnapshot('backend.failed').state, 'error');
  assert.equal(registry.getActivitySnapshot('composer.preferredModel:s1').state, 'pending');
});

test('activity registry reports reduced motion in snapshots', () => {
  const registry = createActivityRegistry({
    matchMedia: () => ({ matches: true }),
  });

  registry.beginActivity('settings.modelLoad');

  const snapshot = registry.getActivitySnapshot('settings.modelLoad');
  assert.equal(snapshot.reducedMotion, true);
});
