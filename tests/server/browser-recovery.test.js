'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const view = require('../../renderer/browser/browser-view');
const { BrowserApp } = require('../../renderer/browser/app');
const { BrowserBridgeError } = require('../../renderer/browser/browser-bridge');

function dom() {
  const instance = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = instance.window;
  global.document = instance.window.document;
  return instance;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.equal(predicate(), true, 'condition did not settle in time');
}

function snapshot(sessionId, revision, planMode = false) {
  return {
    session: { session_id: sessionId, title: sessionId, revision, plan_mode: planMode },
    messages: [],
    pending_approvals: [],
    pending_questions: [],
    control: { client_id: 'client_a', generation: 7, expires_at: 999999 },
    active_turn: null,
    live_projection: null,
  };
}

function state(overrides = {}) {
  return {
    authenticated: true,
    connectionState: 'connected',
    sessions: [
      { session_id: 'session_a', title: 'A', message_count: 0 },
      { session_id: 'session_b', title: 'B', message_count: 0 },
    ],
    selectedSessionId: 'session_a',
    snapshot: snapshot('session_a', 'r1'),
    liveProjection: null,
    activeStreamId: '',
    planMode: false,
    draft: '',
    control: { owned: true, ownerClientId: 'client_a', generation: 7, expiresAt: 999999 },
    controlBusy: false,
    pendingDecisionKey: '',
    composerMode: 'send',
    attachments: [],
    authSessions: [],
    authSessionsOpen: false,
    authSessionsBusy: false,
    authSessionsError: '',
    ...overrides,
  };
}

function bridge(command) {
  return {
    clientId: 'client_a',
    login: async () => {},
    bootstrap: async () => {},
    registerClient: async () => {},
    logout: async () => {},
    dispose: () => {},
    connectEvents: async () => ({ close() {} }),
    command,
  };
}

function close(app, instance) {
  app.dispose();
  delete global.window;
  delete global.document;
}

function bridgeFailure(reason, code, status) {
  return new BrowserBridgeError(reason, {
    code,
    status,
    payload: { ok: false, error: { code, reason, retryable: true } },
  });
}

test('send, rename, delete, and preferences carry the current lease generation', async () => {
  const calls = [];
  const bridgeInstance = bridge(async (operation, options) => {
    calls.push({ operation, options });
    if (operation === 'sessions.list') return { ok: true, sessions: state().sessions };
    if (operation === 'sessions.snapshot') return { ok: true, snapshot: snapshot(options.sessionId, 'r2') };
    if (operation === 'chat.send') return { ok: true, accepted: true, stream_id: 'stream_a' };
    if (operation === 'sessions.rename') return { ok: true, session: { session_id: 'session_a', title: 'Renamed' } };
    return { ok: true };
  });
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge: bridgeInstance,
    state: state({ draft: 'hello' }),
    view,
    reconnect: { start() {}, stop() {} },
  });
  try {
    await app.start();
    await app.send();
    app.startRename('session_a');
    const title = instance.window.document.querySelector('.browser-session--editing .inv-text-field-control');
    title.value = 'Renamed';
    await app.saveRename('session_a');
    await app.deleteSession('session_b');
    assert.equal(calls.some((entry) => entry.operation === 'sessions.delete'), false,
      'a different session cannot borrow the selected conversation authority');
    app.root.dispatchEvent(new instance.window.CustomEvent('inv-segmented-change', {
      bubbles: true,
      detail: { id: 'plan-mode', value: 'on' },
    }));
    await waitFor(() => calls.some((entry) => entry.operation === 'sessions.preferences'));
    await app.deleteSession('session_a');
    for (const operation of ['chat.send', 'sessions.rename', 'sessions.delete', 'sessions.preferences']) {
      const call = calls.find((entry) => entry.operation === operation);
      assert.equal(call.options.controlGeneration, 7, operation);
    }
  } finally {
    close(app, instance);
  }
});

test('a delayed old-session preference result cannot revert the new session plan mode', async () => {
  const oldPreference = deferred();
  const newPreference = deferred();
  let preferenceCalls = 0;
  const calls = [];
  const bridgeInstance = bridge(async (operation, options) => {
    calls.push({ operation, options });
    if (operation === 'sessions.list') return { ok: true, sessions: state().sessions };
    if (operation === 'sessions.snapshot') return { ok: true, snapshot: snapshot(options.sessionId, 'r3') };
    if (operation === 'sessions.preferences') {
      preferenceCalls += 1;
      return preferenceCalls === 1 ? oldPreference.promise : newPreference.promise;
    }
    return { ok: true };
  });
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge: bridgeInstance,
    state: state(),
    view,
    reconnect: { start() {}, stop() {} },
  });
  const changePlan = () => app.root.dispatchEvent(new instance.window.CustomEvent('inv-segmented-change', {
    bubbles: true,
    detail: { id: 'plan-mode', value: 'on' },
  }));
  try {
    await app.start();
    changePlan();
    await waitFor(() => preferenceCalls === 1);
    await app.selectSession('session_b');
    assert.equal(app.state.planMode, false);
    changePlan();
    await flush();
    assert.equal(preferenceCalls, 1, 'a second canonical mutation is blocked while the first is in flight');
    oldPreference.resolve({ ok: false, error: { reason: 'revision_conflict' } });
    await flush();
    assert.equal(app.state.selectedSessionId, 'session_b');
    assert.equal(app.state.planMode, false);
    changePlan();
    await waitFor(() => preferenceCalls === 2);
    newPreference.resolve({ ok: true });
    await flush();
    assert.equal(app.state.planMode, true);
    const preferences = calls.filter((entry) => entry.operation === 'sessions.preferences');
    assert.equal(preferences[0].options.sessionId, 'session_a');
    assert.equal(preferences[1].options.sessionId, 'session_b');
    assert.equal(preferences[0].options.controlGeneration, 7);
    assert.equal(preferences[1].options.controlGeneration, 7);
  } finally {
    close(app, instance);
  }
});

test('an expired client 403 re-registers once and reconnects from cursor zero', async () => {
  let bootstrapCalls = 0;
  let registerCalls = 0;
  let listCalls = 0;
  let connectCalls = 0;
  const cursors = [];
  const bridgeInstance = bridge(async (operation, options) => {
    if (operation === 'sessions.list') {
      listCalls += 1;
      return { ok: true, sessions: [{ session_id: 'session_a', title: 'A' }] };
    }
    if (operation === 'sessions.snapshot') return { ok: true, snapshot: snapshot(options.sessionId, `r${listCalls}`) };
    return { ok: true };
  });
  bridgeInstance.bootstrap = async () => { bootstrapCalls += 1; };
  bridgeInstance.registerClient = async () => { registerCalls += 1; };
  bridgeInstance.connectEvents = async (options) => {
    connectCalls += 1;
    cursors.push(options.cursor);
    if (connectCalls === 1) {
      return { done: Promise.reject(bridgeFailure('client_expired', 'AUTH_CLIENT_EXPIRED', 403)), close() {} };
    }
    return { done: new Promise(() => {}), close() {} };
  };
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge: bridgeInstance,
    state: state(),
    view,
  });
  try {
    await app.start();
    await waitFor(() => bootstrapCalls === 2 && registerCalls === 2 && listCalls === 2 && connectCalls === 2);
    assert.deepEqual(cursors, [0, 0]);
    assert.equal(app.state.authenticated, true);
    assert.equal(app.state.selectedSessionId, 'session_a');
  } finally {
    close(app, instance);
  }
});
