'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createWindowExitPreflight,
} = require('../renderer/features/renderer-window-exit-preflight');

// Hand-built fake of the IDE close orchestrator (the real dirty-buffer
// preflight primitive). `plan` is whatever the orchestrator would resolve for
// the injected dirty set.
function makeOrchestrator({ dirty = [], open = null, plan = { ready: true, decision: 'clean' } } = {}) {
  const calls = { preflight: [], commit: 0, cancel: 0 };
  const orch = {
    getDirtyPaths: () => dirty.slice(),
    openTabPaths: () => (open || dirty).slice(),
    preflight: async (paths) => { calls.preflight.push(paths); return plan; },
    commit: () => { calls.commit += 1; return { committed: true }; },
    cancel: () => { calls.cancel += 1; return { canceled: true }; },
  };
  return { orch, calls };
}

function makeCoordinator(overrides = {}) {
  const toasts = [];
  const logs = [];
  const coordinator = createWindowExitPreflight({
    // Left undefined by default so the factory falls back to globalThis, which
    // carries no mounted plugin-session controller in these unit tests.
    root: overrides.root,
    getCloseOrchestrator: overrides.getCloseOrchestrator || (() => null),
    getShell: overrides.getShell || (() => null),
    showToast: (message) => toasts.push(message),
    appendClientLog: (level, event, details) => logs.push({ level, event, details }),
  });
  return { coordinator, toasts, logs };
}

// A session-bound native plugin is settled before the dirty-buffer prompt.
function makePluginSessionRoot(guard, { sessionId = 's-plugin' } = {}) {
  return {
    rendererPluginSessions: {
      instance: {
        getActiveSessionId: () => sessionId,
        guardLeaveSession: guard,
      },
    },
  };
}

test('a clean IDE proceeds with no prompt', async () => {
  const { orch, calls } = makeOrchestrator({ dirty: [] });
  const { coordinator } = makeCoordinator({ getCloseOrchestrator: () => orch });

  const result = await coordinator.preflightExit('close');

  assert.deepEqual(result, { proceed: true, reason: 'clean' });
  assert.equal(calls.preflight.length, 0, 'a clean IDE never runs the prompting preflight');
});

test('no IDE controller mounted fails open (proceed)', async () => {
  const { coordinator } = makeCoordinator({ getCloseOrchestrator: () => null });

  const result = await coordinator.preflightExit('close');

  assert.deepEqual(result, { proceed: true, reason: 'no_ide' });
});

test('dirty + Save awaits every file over the full open-tab set, then proceeds', async () => {
  const { orch, calls } = makeOrchestrator({
    dirty: ['a.js'],
    open: ['a.js', 'b.js'],
    plan: { ready: true, decision: 'save' },
  });
  const { coordinator } = makeCoordinator({ getCloseOrchestrator: () => orch });

  const result = await coordinator.preflightExit('close');

  assert.deepEqual(result, { proceed: true, reason: 'save' });
  assert.deepEqual(calls.preflight, [['a.js', 'b.js']], 'preflight covers ALL open tabs, not just dirty');
  assert.equal(calls.commit, 0, 'the plan is NOT committed on window exit (frame is going away)');
});

test('a failing save cancels the exit and names the file', async () => {
  const { orch } = makeOrchestrator({
    dirty: ['a.js', 'b.js'],
    plan: { ready: false, code: 'save_failed', failedPath: 'b.js' },
  });
  const { coordinator, toasts } = makeCoordinator({ getCloseOrchestrator: () => orch });

  const result = await coordinator.preflightExit('close');

  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'save_failed');
  assert.equal(result.failedPath, 'b.js');
  assert.equal(toasts.length, 1, 'the failure is surfaced');
  assert.match(toasts[0], /b\.js/, 'the toast names the file that failed to save');
});

test('Don’t Save (discard) proceeds without saving or committing', async () => {
  const { orch, calls } = makeOrchestrator({
    dirty: ['a.js'],
    plan: { ready: true, decision: 'discard' },
  });
  const { coordinator } = makeCoordinator({ getCloseOrchestrator: () => orch });

  const result = await coordinator.preflightExit('close');

  assert.deepEqual(result, { proceed: true, reason: 'discard' });
  assert.equal(calls.commit, 0);
});

test('Cancel blocks the exit', async () => {
  const { orch } = makeOrchestrator({
    dirty: ['a.js'],
    plan: { ready: false, canceled: true, code: 'user_canceled' },
  });
  const { coordinator } = makeCoordinator({ getCloseOrchestrator: () => orch });

  const result = await coordinator.preflightExit('close');

  assert.equal(result.proceed, false);
  assert.equal(result.reason, 'canceled');
});

test('the update-restart path aborts when the user cancels', async () => {
  const { orch } = makeOrchestrator({
    dirty: ['draft.md'],
    plan: { ready: false, canceled: true, code: 'user_canceled' },
  });
  const { coordinator } = makeCoordinator({ getCloseOrchestrator: () => orch });

  const result = await coordinator.preflightExit('update-restart');

  assert.equal(result.proceed, false, 'a canceled preflight aborts the update restart');
});

test('an active plugin session blocks the exit when teardown proof is declined', async () => {
  const { orch, calls } = makeOrchestrator({ dirty: [] });
  const seen = [];
  const { coordinator } = makeCoordinator({
    getCloseOrchestrator: () => orch,
    root: makePluginSessionRoot(async (sessionId, reason) => {
      seen.push([sessionId, reason]);
      return false;
    }),
  });

  const result = await coordinator.preflightExit('close');

  assert.deepEqual(result, { proceed: false, reason: 'plugin_session_active' });
  assert.deepEqual(seen, [['s-plugin', 'window_close']], 'the guard is told which session and why');
  assert.equal(calls.preflight.length, 0, 'a blocked plugin exit never reaches the dirty-buffer prompt');
});

test('an allowed plugin-session guard falls through to the dirty-buffer preflight', async () => {
  const { orch } = makeOrchestrator({ dirty: [] });
  const { coordinator } = makeCoordinator({
    getCloseOrchestrator: () => orch,
    root: makePluginSessionRoot(async () => true),
  });

  const result = await coordinator.preflightExit('reload');

  assert.deepEqual(result, { proceed: true, reason: 'clean' });
});

test('a rejecting plugin-session guard fails closed and blocks the exit', async () => {
  // The guard decision is fail-closed on purpose: if the guard itself breaks we
  // must not fall through to "allow" and destroy an in-flight generation.
  const { orch, calls } = makeOrchestrator({ dirty: [] });
  const { coordinator } = makeCoordinator({
    getCloseOrchestrator: () => orch,
    root: makePluginSessionRoot(async () => { throw new Error('guard exploded'); }),
  });

  const result = await coordinator.preflightExit('close');

  assert.deepEqual(result, { proceed: false, reason: 'plugin_session_active' });
  assert.equal(calls.preflight.length, 0);
});

test('a synchronously throwing plugin-session guard also fails closed', async () => {
  // Guards the try/catch specifically: a `.catch()` on the returned promise
  // would miss a guard that throws before it ever returns one.
  const { orch } = makeOrchestrator({ dirty: [] });
  const { coordinator } = makeCoordinator({
    getCloseOrchestrator: () => orch,
    root: makePluginSessionRoot(() => { throw new Error('sync explosion'); }),
  });

  const result = await coordinator.preflightExit('close');

  assert.deepEqual(result, { proceed: false, reason: 'plugin_session_active' });
});

test('a native-close request runs the preflight and replies over the bridge', async () => {
  const { orch } = makeOrchestrator({ dirty: [] });
  let requestListener = null;
  const replies = [];
  const shell = {
    window: {
      onExitPreflightRequest(listener) {
        requestListener = listener;
        return () => { requestListener = null; };
      },
      respondExitPreflight(payload) {
        replies.push(payload);
        return Promise.resolve({ ok: true });
      },
    },
  };
  const { coordinator } = makeCoordinator({
    getCloseOrchestrator: () => orch,
    getShell: () => shell,
  });

  coordinator.bind();
  assert.equal(typeof requestListener, 'function', 'bind subscribes to the native-close request push');

  await requestListener({ requestId: 'win-exit-7' });
  // allow the async preflight + reply microtasks to settle
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(replies, [
    { requestId: 'win-exit-7', ack: true },
    { requestId: 'win-exit-7', proceed: true },
  ]);
});

test('a native-close request replies proceed:false when the user cancels', async () => {
  const { orch } = makeOrchestrator({
    dirty: ['a.js'],
    plan: { ready: false, canceled: true },
  });
  let requestListener = null;
  const replies = [];
  const shell = {
    window: {
      onExitPreflightRequest(listener) { requestListener = listener; return () => {}; },
      respondExitPreflight(payload) { replies.push(payload); return Promise.resolve({ ok: true }); },
    },
  };
  const { coordinator } = makeCoordinator({
    getCloseOrchestrator: () => orch,
    getShell: () => shell,
  });

  coordinator.bind();
  await requestListener({ requestId: 'win-exit-9' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(replies, [
    { requestId: 'win-exit-9', ack: true },
    { requestId: 'win-exit-9', proceed: false },
  ]);
});

test('a native-close request acks IMMEDIATELY, before the interactive dialog resolves', async () => {
  // Code-review High: the main-side guard fail-opens (force-closes) at
  // timeoutMs unless it can tell a live renderer showing a dialog from a
  // wedged one. The coordinator must therefore send {ack:true} the moment the
  // request arrives — while the Save / Don't Save / Cancel decision is still
  // pending — never after it.
  let resolvePlan = null;
  const planPromise = new Promise((resolve) => { resolvePlan = resolve; });
  const orch = {
    getDirtyPaths: () => ['a.js'],
    openTabPaths: () => ['a.js'],
    preflight: () => planPromise, // the "dialog": unresolved until the user decides
    cancel: () => ({ canceled: true }),
  };
  let requestListener = null;
  const replies = [];
  const shell = {
    window: {
      onExitPreflightRequest(listener) { requestListener = listener; return () => {}; },
      respondExitPreflight(payload) { replies.push(payload); return Promise.resolve({ ok: true }); },
    },
  };
  const { coordinator } = makeCoordinator({
    getCloseOrchestrator: () => orch,
    getShell: () => shell,
  });

  coordinator.bind();
  const handled = requestListener({ requestId: 'win-exit-10' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(
    replies,
    [{ requestId: 'win-exit-10', ack: true }],
    'the ack is sent while the dialog is still up (preflight unresolved)'
  );

  resolvePlan({ ready: true, decision: 'save' });
  await handled;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(replies[1], { requestId: 'win-exit-10', proceed: true });
});

test('bind is idempotent and one dispose removes the only native-close listener', () => {
  const listeners = new Set();
  const shell = {
    window: {
      onExitPreflightRequest(listener) {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
      },
    },
  };
  const { coordinator } = makeCoordinator({ getShell: () => shell });

  const firstDisposer = coordinator.bind();
  const secondDisposer = coordinator.bind();

  assert.equal(listeners.size, 1);
  assert.equal(secondDisposer, firstDisposer);

  coordinator.dispose();
  assert.equal(listeners.size, 0);
});
