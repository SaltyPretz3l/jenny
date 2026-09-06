'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createWindowExitGuard } = require('../services/main/window-exit-guard');
const { getBridgeChannel } = require('../services/ipc-contract');

const REQUEST_CHANNEL = getBridgeChannel('window.onExitPreflightRequest', 'subscribe');

// Fake BrowserWindow modelled on Electron semantics: close() fires the 'close'
// event (which the guard's interceptor sees), and destroy fires 'closed'.
function createFakeWindow() {
  const listeners = {};
  const state = { sent: [], closeCount: 0, destroyed: false };
  const win = {
    on(name, handler) {
      (listeners[name] = listeners[name] || []).push(handler);
      return win;
    },
    isDestroyed: () => state.destroyed,
    webContents: {
      send(channel, payload) {
        state.sent.push({ channel, payload });
      },
    },
    close() {
      state.closeCount += 1;
      const event = { preventDefault() { state.lastPrevented = true; } };
      (listeners.close || []).forEach((handler) => handler(event));
    },
    destroyNow() {
      state.destroyed = true;
      (listeners.closed || []).forEach((handler) => handler());
    },
  };
  function fireClose() {
    let prevented = false;
    const event = { preventDefault() { prevented = true; } };
    (listeners.close || []).forEach((handler) => handler(event));
    return { prevented };
  }
  return { win, state, fireClose };
}

function createManualTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeoutFn: (fn) => {
      const id = (seq += 1);
      timers.set(id, fn);
      return id;
    },
    clearTimeoutFn: (id) => { timers.delete(id); },
    flushAll() {
      for (const [id, fn] of [...timers]) {
        timers.delete(id);
        fn();
      }
    },
    size: () => timers.size,
  };
}

function captureLog() {
  const entries = [];
  return { log: (level, event, details) => entries.push({ level, event, details }), entries };
}

test('a native close is intercepted, prevented, and pushed to the renderer', () => {
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const guard = createWindowExitGuard({ log: () => {}, ...timers });
  guard.attach(win);

  const { prevented } = fireClose();

  assert.equal(prevented, true, 'the native close must be prevented pending the preflight');
  assert.equal(state.closeCount, 0, 'the window must not close before the renderer replies');
  assert.equal(state.sent.length, 1, 'one preflight request is pushed');
  assert.equal(state.sent[0].channel, REQUEST_CHANNEL);
  assert.equal(typeof state.sent[0].payload.requestId, 'string');
  assert.ok(guard.isPreflightPending());
});

test('reply proceed:true bypasses the interceptor and closes the window', () => {
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const guard = createWindowExitGuard({ log: () => {}, ...timers });
  guard.attach(win);
  fireClose();
  const requestId = state.sent[0].payload.requestId;

  const result = guard.resolvePreflight({ requestId, proceed: true });

  assert.deepEqual(result, { ok: true, proceed: true });
  assert.equal(state.closeCount, 1, 'proceed:true closes the window exactly once');
  assert.equal(guard.isPreflightPending(), false, 'the pending entry is cleared');
  assert.equal(timers.size(), 0, 'the timeout timer is cleared');
});

test('reply proceed:false drops the pending close and keeps the window open', () => {
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const guard = createWindowExitGuard({ log: () => {}, ...timers });
  guard.attach(win);
  fireClose();
  const requestId = state.sent[0].payload.requestId;

  const result = guard.resolvePreflight({ requestId, proceed: false });

  assert.deepEqual(result, { ok: true, proceed: false });
  assert.equal(state.closeCount, 0, 'proceed:false must not close the window');
  assert.equal(guard.isPreflightPending(), false);
  assert.equal(timers.size(), 0);
});

test('a hung renderer (timeout) FAILS OPEN: warns and closes', () => {
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const { log, entries } = captureLog();
  const guard = createWindowExitGuard({ log, timeoutMs: 3000, ...timers });
  guard.attach(win);
  fireClose();

  assert.equal(state.closeCount, 0, 'still open while the timer is armed');
  timers.flushAll();

  assert.equal(state.closeCount, 1, 'timeout fails open and closes the window');
  assert.equal(guard.isPreflightPending(), false);
  assert.ok(
    entries.some((entry) => entry.event === 'window.exit_preflight_timeout'),
    'a structured timeout warning is logged'
  );
});

test('an acked preflight cancels the fail-open timer: a user deliberating at the dialog is never force-closed', () => {
  // Code-review High: the 3s fail-open timer could not distinguish "renderer
  // hung" from "human reading the Save / Don't Save / Cancel dialog" — at
  // timeoutMs it force-closed the window mid-prompt and discarded the very
  // buffers UIUX-003 protects. The renderer now acks the request immediately
  // (before the dialog); the ack proves liveness and cancels the timer, so
  // the timeout only covers a renderer too wedged to receive the request.
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const { log, entries } = captureLog();
  const guard = createWindowExitGuard({ log, timeoutMs: 3000, ...timers });
  guard.attach(win);
  fireClose();
  const requestId = state.sent[0].payload.requestId;

  const ackResult = guard.resolvePreflight({ requestId, ack: true });

  assert.equal(ackResult.ok, true, 'the ack is accepted');
  assert.equal(ackResult.ack, true, 'the ack reply is distinguishable from a final proceed reply');
  assert.equal(guard.isPreflightPending(), true, 'the ack must NOT consume the pending preflight');
  assert.equal(timers.size(), 0, 'the ack cancels the fail-open timer');
  assert.equal(state.closeCount, 0, 'the ack itself never closes the window');

  // However long the user deliberates, no timer remains to force-close.
  timers.flushAll();
  assert.equal(state.closeCount, 0, 'no force-close fires after the ack, no matter how long the dialog stays up');

  // The eventual human decision still resolves normally.
  const result = guard.resolvePreflight({ requestId, proceed: true });
  assert.deepEqual(result, { ok: true, proceed: true });
  assert.equal(state.closeCount, 1, 'the final proceed:true closes exactly once');
  assert.ok(entries.some((entry) => entry.event === 'window.exit_preflight_acked'));
});

test('an ack for a stale/unknown requestId is refused and touches nothing', () => {
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const guard = createWindowExitGuard({ log: () => {}, ...timers });
  guard.attach(win);
  fireClose();

  const result = guard.resolvePreflight({ requestId: 'win-exit-999', ack: true });

  assert.deepEqual(result, { ok: false, code: 'no_pending' });
  assert.equal(guard.isPreflightPending(), true, 'the live pending entry is untouched');
  assert.equal(timers.size(), 1, 'the fail-open timer stays armed for the real request');
  assert.equal(state.closeCount, 0);
});

test('a throwing webContents.send FAILS OPEN and closes', () => {
  const timers = createManualTimers();
  const { log, entries } = captureLog();
  const listeners = {};
  const state = { closeCount: 0 };
  const win = {
    on(name, handler) { (listeners[name] = listeners[name] || []).push(handler); },
    isDestroyed: () => false,
    webContents: { send() { throw new Error('renderer gone'); } },
    close() {
      state.closeCount += 1;
      (listeners.close || []).forEach((handler) => handler({ preventDefault() {} }));
    },
  };
  const guard = createWindowExitGuard({ log, ...timers });
  guard.attach(win);

  (listeners.close || []).forEach((handler) => handler({ preventDefault() {} }));

  assert.equal(state.closeCount, 1, 'a failed push must fail open, not strand the window');
  assert.ok(entries.some((entry) => entry.event === 'window.exit_preflight_fail_open'));
});

test('app-quitting allows the close immediately without a preflight prompt', () => {
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const guard = createWindowExitGuard({
    log: () => {},
    getMainLifecycle: () => ({ isAppQuitting: () => true }),
    ...timers,
  });
  guard.attach(win);

  const { prevented } = fireClose();

  assert.equal(prevented, false, 'shutdown-path close is allowed, not prevented');
  assert.equal(state.sent.length, 0, 'no preflight request during app quit');
});

test('a second native close while a preflight is pending is de-duped', () => {
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const { log, entries } = captureLog();
  const guard = createWindowExitGuard({ log, ...timers });
  guard.attach(win);

  fireClose();
  const second = fireClose();

  assert.equal(state.sent.length, 1, 'only one preflight request is in flight');
  assert.equal(second.prevented, true, 'the duplicate close is still prevented');
  assert.ok(entries.some((entry) => entry.event === 'window.exit_preflight_in_flight'));
});

test('authorizeNextClose lets a renderer-preflighted close through without re-prompting', () => {
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const guard = createWindowExitGuard({ log: () => {}, ...timers });
  guard.attach(win);

  guard.authorizeNextClose();
  const { prevented } = fireClose();

  assert.equal(prevented, false, 'an authorized close is not intercepted');
  assert.equal(state.sent.length, 0, 'no second preflight prompt');
});

test('a window destroyed mid-preflight clears its pending entry (no dangling timer)', () => {
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const guard = createWindowExitGuard({ log: () => {}, ...timers });
  guard.attach(win);
  fireClose();
  assert.ok(guard.isPreflightPending());

  win.destroyNow();

  assert.equal(guard.isPreflightPending(), false, 'the pending entry is cleaned on destroy');
  assert.equal(timers.size(), 0, 'its timeout timer is cleared');
  assert.doesNotThrow(() => timers.flushAll());
  assert.equal(state.closeCount, 0);
});

test('a reply for a stale/unknown requestId is a no-op', () => {
  const { win, state, fireClose } = createFakeWindow();
  const timers = createManualTimers();
  const guard = createWindowExitGuard({ log: () => {}, ...timers });
  guard.attach(win);
  fireClose();

  const result = guard.resolvePreflight({ requestId: 'not-the-pending-one', proceed: true });

  assert.deepEqual(result, { ok: false, code: 'no_pending' });
  assert.equal(state.closeCount, 0);
  assert.ok(guard.isPreflightPending(), 'the real pending entry is untouched');
});
