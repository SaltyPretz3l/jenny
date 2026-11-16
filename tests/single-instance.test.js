const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applySingleInstance,
  revealExistingWindow,
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

test('development launch explains a shared-profile conflict and never bootstraps', () => {
  const notices = [];
  let quits = 0;
  let starts = 0;
  const app = {
    requestSingleInstanceLock: () => false,
    quit: () => { quits += 1; },
    on: () => { throw new Error('must not attach runtime listeners'); },
  };
  const started = startWhenSingleInstanceAvailable({
    acquireLock: () => applySingleInstance(app, undefined, {
      env: { JENNY_LAUNCH_PATH: 'dev' },
      showErrorBox: (...args) => notices.push(args),
    }),
    onStart: () => { starts += 1; },
  });
  assert.equal(started, false);
  assert.equal(starts, 0);
  assert.equal(quits, 1);
  assert.equal(notices.length, 1);
  assert.match(notices[0][1], /Close it.*launch Jenny \(Dev\) again/);
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

function fakeWindow({ destroyed = false, minimized = false, visible = true } = {}) {
  const calls = [];
  return {
    calls,
    isDestroyed: () => destroyed,
    isMinimized: () => minimized,
    isVisible: () => visible,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    focus: () => calls.push('focus'),
  };
}

test('a second launch shows a hidden window before focusing it', () => {
  const win = fakeWindow({ visible: false });
  assert.equal(revealExistingWindow(win), true);
  assert.deepEqual(win.calls, ['show', 'focus']);
});

test('a second launch restores a minimized window, then focuses it', () => {
  const win = fakeWindow({ minimized: true });
  assert.equal(revealExistingWindow(win), true);
  assert.deepEqual(win.calls, ['restore', 'focus']);
});

test('a second launch ignores a missing or destroyed window', () => {
  assert.equal(revealExistingWindow(null), false);
  const win = fakeWindow({ destroyed: true, visible: false });
  assert.equal(revealExistingWindow(win), false);
  assert.deepEqual(win.calls, []);
});

test('the lock forwards additionalData, and a file hand-off skips the dev conflict box (row 137)', () => {
  const notices = [];
  let lockData = 'unset';
  const app = {
    requestSingleInstanceLock: (data) => { lockData = data; return false; },
    quit() {},
    on() {},
  };
  const additionalData = { v: 1, outsidePaths: ['C:\\notes\\a.md'], cwd: 'C:\\' };
  assert.equal(applySingleInstance(app, undefined, {
    additionalData,
    env: { JENNY_LAUNCH_PATH: 'dev' },
    showErrorBox: (title) => notices.push(title),
    claimDesktopProfile: () => {},
  }), false);
  assert.equal(lockData, additionalData);
  assert.deepEqual(notices, [], 'handing a file to the running app is not a failed start');
  applySingleInstance(app, undefined, {
    additionalData: { v: 1, outsidePaths: [], cwd: 'C:\\' },
    env: { JENNY_LAUNCH_PATH: 'dev' },
    showErrorBox: (title) => notices.push(title),
    claimDesktopProfile: () => {},
  });
  assert.equal(notices.length, 1, 'a plain second dev launch still explains the conflict');
});

test('the second-instance listener passes argv, cwd and additionalData through', () => {
  const listeners = new Map();
  const app = { requestSingleInstanceLock: () => true, quit() {}, on: (event, handler) => listeners.set(event, handler) };
  let seen = null;
  applySingleInstance(app, (...args) => { seen = args; }, { claimDesktopProfile: () => {} });
  const data = { v: 1, outsidePaths: ['/a.md'], cwd: '/' };
  listeners.get('second-instance')({}, ['jenny', '--', '/a.md'], '/', data);
  assert.deepEqual(seen.slice(1), [['jenny', '--', '/a.md'], '/', data]);
});
