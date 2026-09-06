const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applySingleInstance,
  startWhenSingleInstanceAvailable,
} = require('../services/apply-single-instance');

test('single-instance helper quits when lock is unavailable', () => {
  let quitCalled = false;
  const app = {
    requestSingleInstanceLock() {
      return false;
    },
    quit() {
      quitCalled = true;
    },
    on() {},
  };

  const acquired = applySingleInstance(app);
  assert.equal(acquired, false);
  assert.equal(quitCalled, true);
});

test('single-instance helper registers the second-instance handler', () => {
  const listeners = new Map();
  const app = {
    requestSingleInstanceLock() {
      return true;
    },
    quit() {},
    on(event, handler) {
      listeners.set(event, handler);
    },
  };
  let called = false;

  const acquired = applySingleInstance(app, () => {
    called = true;
  });

  assert.equal(acquired, true);
  listeners.get('second-instance')();
  assert.equal(called, true);
});

test('startup guard skips bootstrap work when the single-instance lock is unavailable', () => {
  let started = false;

  const startedApp = startWhenSingleInstanceAvailable({
    acquireLock() {
      return false;
    },
    onStart() {
      started = true;
    },
  });

  assert.equal(startedApp, false);
  assert.equal(started, false);
});

test('startup guard runs bootstrap work when the single-instance lock is available', () => {
  let startCalls = 0;

  const startedApp = startWhenSingleInstanceAvailable({
    acquireLock() {
      return true;
    },
    onStart() {
      startCalls += 1;
    },
  });

  assert.equal(startedApp, true);
  assert.equal(startCalls, 1);
});
