const test = require('node:test');
const assert = require('node:assert/strict');

const { createToastStore } = require('../renderer/shared/toast-utils');
const { createDestructiveUndoScheduler } = require('../renderer/features/renderer-destructive-undo-utils');

// The scheduler commits from the toast's own clock (row 162), so these tests
// drive it against the real store with a manual clock.
function setup() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const store = createToastStore({
    now: () => now,
    setTimeout: (fn, delay) => { const id = nextId++; timers.set(id, { fn, dueAt: now + delay }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
  });
  const cleanups = [];
  const scheduler = createDestructiveUndoScheduler({
    registerCleanup: (fn) => cleanups.push(fn),
    showToastMessage: (message, options) => store.enqueue({ ...options, message }),
    dismissToast: (id) => store.dismiss(id),
  });
  const advance = (ms) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].dueAt - b[1].dueAt)) {
      if (timer.dueAt <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
    }
  };
  const calls = { commit: 0, undo: 0, dispose: 0 };
  const schedule = (key, extra = {}) => scheduler.schedule([key], {
    windowMs: 6000,
    commit: () => { calls.commit += 1; },
    onUndo: () => { calls.undo += 1; },
    onDisposeCleanup: () => { calls.dispose += 1; },
    buildToast: ({ onUndo }) => ({
      message: 'Deleted "Trip"',
      options: { tone: 'danger', actions: [{ id: 'undo', label: 'Undo', onClick: onUndo }] },
    }),
    ...extra,
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { store, scheduler, advance, calls, schedule, settle, dispose: () => cleanups.forEach((fn) => fn()) };
}

test('the delete commits when the toast runs out, and the toast closes with it', async () => {
  const app = setup();
  assert.equal(app.schedule('a'), true);
  const [toast] = app.store.getSnapshot();
  assert.equal(toast.sticky, false, 'a danger tone no longer makes the Undo toast permanent');
  assert.equal(toast.countdownMs, 6000);

  app.advance(5999);
  await app.settle();
  assert.equal(app.calls.commit, 0);
  app.advance(1);
  await app.settle();
  assert.equal(app.calls.commit, 1);
  assert.equal(app.store.getSnapshot().length, 0);
  assert.deepEqual(app.scheduler.list(), []);
});

test('holding the stack holds the delete with the toast', async () => {
  const app = setup();
  app.schedule('a');
  app.advance(3000);
  app.store.pauseAll();
  app.advance(60000);
  await app.settle();
  assert.equal(app.calls.commit, 0, 'what you see is what happens: no commit behind a held toast');
  app.store.resumeAll();
  app.advance(3000);
  await app.settle();
  assert.equal(app.calls.commit, 1);
});

test('the toast\'s × commits now; Undo cancels without committing', async () => {
  const app = setup();
  app.schedule('a');
  app.store.dismiss(app.store.getSnapshot()[0].id);
  await app.settle();
  assert.equal(app.calls.commit, 1);

  app.schedule('b');
  app.scheduler.list()[0].undo();
  app.advance(10000);
  await app.settle();
  assert.equal(app.calls.commit, 1, 'the Undo did not commit');
  assert.equal(app.calls.undo, 1);
  assert.equal(app.store.getSnapshot().length, 0);
});

test('teardown cancels pending deletes instead of committing them', async () => {
  const app = setup();
  app.schedule('a');
  app.dispose();
  await app.settle();
  assert.equal(app.calls.commit, 0);
  assert.equal(app.calls.dispose, 1);
  assert.equal(app.store.getSnapshot().length, 0);
});

test('with no toast to carry the clock, a plain timer still commits', async () => {
  const app = setup();
  app.schedule('a', { windowMs: 5, buildToast: () => null });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(app.calls.commit, 1);
});
