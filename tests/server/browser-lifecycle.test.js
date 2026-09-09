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

function enterPrompt(instance, value) {
  const input = instance.window.document.querySelector('#composer-prompt');
  assert.ok(input, 'composer input should be mounted');
  input.value = value;
  input.dispatchEvent(new instance.window.Event('input', { bubbles: true }));
}

async function waitFor(predicate, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.equal(predicate(), true, 'condition did not settle in time');
}

function snapshot(sessionId, revision, control = null, activeTurn = null) {
  return {
    session: { session_id: sessionId, title: sessionId, revision, plan_mode: false },
    messages: [],
    pending_approvals: [],
    pending_questions: [],
    control,
    active_turn: activeTurn,
    live_projection: null,
  };
}

function appState(overrides = {}) {
  return {
    authenticated: true,
    connectionState: 'connected',
    sessions: [
      { session_id: 'session_a', title: 'A', message_count: 0 },
      { session_id: 'session_b', title: 'B', message_count: 0 },
    ],
    selectedSessionId: 'session_a',
    snapshot: snapshot('session_a', 'r2', { client_id: 'client_a', generation: 1, expires_at: 999999 }),
    liveProjection: null,
    activeStreamId: '',
    planMode: false,
    draft: '',
    control: { owned: true, ownerClientId: 'client_a', generation: 1, expiresAt: 999999 },
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

function bridgeBase(command) {
  return {
    clientId: 'client_a',
    login: async () => {},
    bootstrap: async () => {},
    registerClient: async () => {},
    logout: async () => {},
    dispose: () => {},
    connectEvents: async (options) => {
      bridgeBase.lastEvents = options;
      return { close() {} };
    },
    command,
  };
}

function connectedApp(bridge, state) {
  let app;
  let connected;
  const reconnect = {
    start() {
      connected = app._connectEvents();
    },
    stop() {},
    reconnectNow() {},
  };
  const instance = dom();
  app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state,
    view,
    reconnect,
  });
  return { app, instance, connected: () => connected, events: () => bridgeBase.lastEvents };
}

function closeApp(app, instance) {
  app.dispose();
  delete global.window;
  delete global.document;
  delete bridgeBase.lastEvents;
}

function bridgeFailure(reason, code, status = 409) {
  return new BrowserBridgeError(reason, {
    code,
    status,
    payload: { ok: false, error: { code, reason, retryable: true } },
  });
}

test('a late snapshot cannot regress takeover, live delta, or terminal state', async () => {
  let snapshotCalls = 0;
  const staleSnapshot = deferred();
  const bridge = bridgeBase(async (operation, options) => {
    if (operation === 'sessions.list') return { ok: true, sessions: [{ session_id: 'session_a', title: 'A' }] };
    if (operation !== 'sessions.snapshot') return { ok: true };
    snapshotCalls += 1;
    if (snapshotCalls === 1) return { ok: true, snapshot: { ...snapshot('session_a', 'r2', { client_id: 'client_a', generation: 1 }), cursor: 10 } };
    if (snapshotCalls === 2) return staleSnapshot.promise;
    return { ok: true, snapshot: { ...snapshot('session_a', 'r3', { client_id: 'client_b', generation: 2 }), cursor: 13 } };
  });
  const { app, instance, connected } = connectedApp(bridge, appState());
  try {
    await app.start();
    await connected();
    const events = bridgeBase.lastEvents;
    events.onEvent({ cursor: 10, event_type: 'chat_stream', event: { stream_id: 'stream_a', type: 'started' } });
    await waitFor(() => snapshotCalls === 2);
    events.onEvent({ cursor: 11, event_type: 'control_changed', client_id: 'client_b', generation: 2, expires_at: 999999 });
    events.onEvent({ cursor: 12, event_type: 'chat_stream', event: { stream_id: 'stream_a', type: 'delta', content: 'new answer' } });
    events.onEvent({ cursor: 13, event_type: 'chat_stream', event: { stream_id: 'stream_a', type: 'complete' } });
    staleSnapshot.resolve({
      ok: true,
      snapshot: { ...snapshot('session_a', 'r1', { client_id: 'client_a', generation: 1 }, { stream_id: 'old_stream' }), cursor: 10 },
    });
    await waitFor(() => app.state.snapshot?.session?.revision === 'r3');
    await waitFor(() => app.state.liveProjection === null && app.state.activeStreamId === '');
    assert.equal(app.state.snapshot.session.revision, 'r3');
    assert.equal(app.state.control.ownerClientId, 'client_b');
    assert.equal(app.state.control.owned, false);
    assert.equal(app.state.liveProjection, null);
    assert.equal(app.state.activeStreamId, '');
  } finally {
    closeApp(app, instance);
  }
});

test('a real BrowserBridgeError lease failure clears control ownership', async () => {
  const bridge = bridgeBase(async (operation) => {
    if (operation === 'chat.send') throw bridgeFailure('control_lease_required', 'CMP-HOST-0003');
    return { ok: true };
  });
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state: appState({ draft: 'send this' }),
    view,
  });
  try {
    await app.send();
    assert.equal(app.state.control.owned, false);
    assert.equal(app.state.control.ownerClientId, '');
  } finally {
    closeApp(app, instance);
  }
});

test('a real BrowserBridgeError revision conflict refreshes the canonical snapshot', async () => {
  const calls = [];
  const bridge = bridgeBase(async (operation) => {
    calls.push(operation);
    if (operation === 'chat.send') throw bridgeFailure('revision_conflict', 'CMP-HOST-0004');
    if (operation === 'sessions.snapshot') return { ok: true, snapshot: snapshot('session_a', 'r3') };
    return { ok: true };
  });
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state: appState({ draft: 'send this' }),
    view,
  });
  try {
    await app.send();
    await waitFor(() => app.state.snapshot?.session?.revision === 'r3');
    assert.deepEqual(calls, ['chat.send', 'sessions.snapshot']);
  } finally {
    closeApp(app, instance);
  }
});

test('a null snapshot control clears ownership and a fresh lease starts heartbeat', async () => {
  const intervals = [];
  const previousSetInterval = global.setInterval;
  const previousClearInterval = global.clearInterval;
  global.setInterval = (callback, delay) => {
    const token = { callback, delay };
    intervals.push(token);
    return token;
  };
  global.clearInterval = () => {};
  const bridge = bridgeBase(async (operation) => {
    if (operation === 'sessions.list') return { ok: true, sessions: [{ session_id: 'session_a', title: 'A' }] };
    if (operation === 'sessions.snapshot') return { ok: true, snapshot: snapshot('session_a', 'r4', null) };
    if (operation === 'control.acquire') return { ok: true, lease: { generation: 4, expires_at: 999999 } };
    return { ok: true };
  });
  const { app, instance } = connectedApp(bridge, appState());
  try {
    await app.start();
    assert.equal(app.state.control.owned, false);
    assert.equal(app.state.control.ownerClientId, '');
    await app.acquireControl(false);
    assert.equal(app.state.control.owned, true);
    assert.equal(intervals.length, 1);
    assert.equal(intervals[0].delay, 15000);
  } finally {
    closeApp(app, instance);
    global.setInterval = previousSetInterval;
    global.clearInterval = previousClearInterval;
  }
});

test('switching sessions before acquire resolves cannot mutate the new session', async () => {
  const acquire = deferred();
  const bridge = bridgeBase(async (operation, options) => {
    if (operation === 'control.acquire') return acquire.promise;
    if (operation === 'sessions.snapshot') return { ok: true, snapshot: snapshot(options.sessionId, 'r5') };
    return { ok: true };
  });
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state: appState({ control: { owned: false, ownerClientId: '', generation: 0, expiresAt: 0 } }),
    view,
  });
  try {
    const pendingAcquire = app.acquireControl(false);
    await flush();
    app.state.draft = 'B draft';
    await app.selectSession('session_b');
    acquire.resolve({ ok: true, lease: { generation: 6, expires_at: 999999 } });
    await pendingAcquire;
    assert.equal(app.state.selectedSessionId, 'session_b');
    assert.equal(app.state.draft, 'B draft');
    assert.equal(app.state.control.owned, false);
    assert.equal(app.state.activeStreamId, '');
  } finally {
    closeApp(app, instance);
  }
});

test('a late acquire response cannot resurrect control after a newer control event', async () => {
  const acquire = deferred();
  const bridge = bridgeBase(async (operation) => {
    if (operation === 'control.acquire') return acquire.promise;
    return { ok: true };
  });
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state: appState({ control: { owned: false, ownerClientId: '', generation: 0, expiresAt: 0 } }),
    view,
    reconnect: { start() {}, stop() {} },
  });
  try {
    const pendingAcquire = app.acquireControl(false);
    await flush();
    app.conversation.applyControlEvent({ client_id: 'client_b', generation: 7, expires_at: 999999 });
    acquire.resolve({ ok: true, lease: { generation: 6, expires_at: 999999 } });
    await pendingAcquire;
    assert.equal(app.state.control.owned, false);
    assert.equal(app.state.control.ownerClientId, 'client_b');
    assert.equal(app.state.control.generation, 7);
    assert.equal(app.state.controlBusy, false);
  } finally {
    closeApp(app, instance);
  }
});

test('visibility and focus recover an expired owned lease without takeover and listeners dispose', async () => {
  const calls = [];
  let heartbeatExpired = true;
  const bridge = bridgeBase(async (operation, options) => {
    calls.push({ operation, options });
    if (operation === 'control.heartbeat' && heartbeatExpired) {
      heartbeatExpired = false;
      return { ok: false, error: { reason: 'control_lease_required' } };
    }
    if (operation === 'control.heartbeat') return { ok: true, lease: { generation: 9, expires_at: 999999 } };
    if (operation === 'control.acquire') return { ok: true, lease: { generation: 9, expires_at: 999999 } };
    return { ok: true };
  });
  const instance = dom();
  let visibilityState = 'visible';
  Object.defineProperty(instance.window.document, 'visibilityState', { configurable: true, get: () => visibilityState });
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state: appState(),
    view,
    reconnect: { start() {}, stop() {} },
  });
  try {
    app.conversation.syncControlFromSnapshot(app.state.snapshot);
    visibilityState = 'hidden';
    instance.window.document.dispatchEvent(new instance.window.Event('visibilitychange'));
    visibilityState = 'visible';
    instance.window.document.dispatchEvent(new instance.window.Event('visibilitychange'));
    await waitFor(() => calls.some((entry) => entry.operation === 'control.acquire'));
    const recovery = calls.find((entry) => entry.operation === 'control.acquire');
    assert.equal(recovery.options.params.takeover, false);
    assert.equal(app.state.control.owned, true);

    const beforeFocus = calls.filter((entry) => entry.operation === 'control.heartbeat').length;
    instance.window.dispatchEvent(new instance.window.Event('focus'));
    await waitFor(() => calls.filter((entry) => entry.operation === 'control.heartbeat').length > beforeFocus);
    app.dispose();
    const afterDispose = calls.length;
    instance.window.dispatchEvent(new instance.window.Event('focus'));
    instance.window.document.dispatchEvent(new instance.window.Event('visibilitychange'));
    await flush();
    assert.equal(calls.length, afterDispose);
  } finally {
    closeApp(app, instance);
  }
});

test('a successful SSE reconnect refreshes the snapshot before renewing owned control', async () => {
  const calls = [];
  const bridge = bridgeBase(async (operation, options) => {
    calls.push(operation);
    if (operation === 'sessions.snapshot') {
      return { ok: true, snapshot: snapshot(options.sessionId, 'r9', { client_id: 'client_a', generation: 3, expires_at: 999999 }) };
    }
    if (operation === 'control.heartbeat') return { ok: true, lease: { generation: 3, expires_at: 999999 } };
    return { ok: true };
  });
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state: appState(),
    view,
    reconnect: { start() {}, stop() {} },
  });
  try {
    app.conversation.prepareForResume();
    await app._handleConnected();
    assert.deepEqual(calls, ['sessions.snapshot', 'control.heartbeat']);
    assert.equal(app.state.snapshot.session.revision, 'r9');
    assert.equal(app.state.control.generation, 3);
  } finally {
    closeApp(app, instance);
  }
});

test('switching sessions before send resolves preserves the new draft and stream state', async () => {
  const send = deferred();
  const bridge = bridgeBase(async (operation, options) => {
    if (operation === 'chat.send') return send.promise;
    if (operation === 'sessions.snapshot') return { ok: true, snapshot: snapshot(options.sessionId, 'r6') };
    return { ok: true };
  });
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state: appState({ draft: 'A draft' }),
    view,
  });
  try {
    const pendingSend = app.send();
    await flush();
    app.state.draft = 'B draft';
    await app.selectSession('session_b');
    send.resolve({ ok: true, accepted: true, stream_id: 'stream_a' });
    await pendingSend;
    assert.equal(app.state.selectedSessionId, 'session_b');
    assert.equal(app.state.draft, 'B draft');
    assert.equal(app.state.control.owned, false);
    assert.equal(app.state.activeStreamId, '');
  } finally {
    closeApp(app, instance);
  }
});

test('a late 401 from the old login cannot log out the new login', async () => {
  const oldList = deferred();
  let listCalls = 0;
  const bridge = bridgeBase(async (operation) => {
    if (operation !== 'sessions.list') return { ok: true };
    listCalls += 1;
    if (listCalls === 1) return oldList.promise;
    return { ok: true, sessions: [{ session_id: 'new_session', title: 'New' }] };
  });
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state: appState({ authenticated: false, sessions: [], selectedSessionId: '', snapshot: null, control: { owned: false, ownerClientId: '', generation: 0, expiresAt: 0 } }),
    view,
  });
  try {
    const oldLogin = app.login('old');
    await waitFor(() => listCalls === 1);
    await app.logout();
    const newLogin = app.login('new');
    await newLogin;
    assert.equal(app.state.authenticated, true);
    oldList.reject(bridgeFailure('authentication_required', 'AUTH_UNAUTHENTICATED', 401));
    await oldLogin;
    assert.equal(app.state.authenticated, true);
    assert.equal(app.state.selectedSessionId, 'new_session');
  } finally {
    closeApp(app, instance);
  }
});

test('a current 401 invalidates peer requests and clears browser authority', async () => {
  const acquire = deferred();
  let cleared = 0;
  const bridge = bridgeBase(async (operation) => {
    if (operation === 'control.acquire') return acquire.promise;
    if (operation === 'sessions.list') throw bridgeFailure('authentication_required', 'auth_required', 401);
    return { ok: true };
  });
  bridge.clearCredentials = () => {
    cleared += 1;
    bridge.clientId = '';
  };
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state: appState({ control: { owned: false, ownerClientId: '', generation: 0, expiresAt: 0 } }),
    view,
    reconnect: { start() {}, stop() {} },
  });
  try {
    const pendingAcquire = app.acquireControl(false);
    await flush();
    await app._command('sessions.list', { params: {} });
    acquire.resolve({ ok: true, lease: { generation: 8, expires_at: 999999 } });
    await pendingAcquire;
    assert.equal(cleared, 1);
    assert.equal(app.state.authenticated, false);
    assert.equal(app.state.control.owned, false);
    assert.equal(app.state.error, 'Your hosted login expired. Sign in again.');
  } finally {
    closeApp(app, instance);
  }
});

test('resync reloads the session list before restoring the selected snapshot', async () => {
  let listCalls = 0;
  const bridge = bridgeBase(async (operation, options) => {
    if (operation === 'sessions.list') {
      listCalls += 1;
      return listCalls === 1
        ? { ok: true, sessions: [{ session_id: 'session_a', title: 'Old' }] }
        : { ok: true, sessions: [{ session_id: 'session_b', title: 'Reloaded' }] };
    }
    if (operation === 'sessions.snapshot') return { ok: true, snapshot: snapshot(options.sessionId, 'r7') };
    return { ok: true };
  });
  const { app, instance, connected } = connectedApp(bridge, appState());
  try {
    await app.start();
    await connected();
    bridgeBase.lastEvents.onEvent({ event_type: 'resync_required', boot_epoch: 'boot_next' });
    await waitFor(() => listCalls === 2 && app.state.sessions[0]?.title === 'Reloaded');
    assert.equal(app.state.selectedSessionId, 'session_b');
    assert.equal(app.state.snapshot.session.session_id, 'session_b');
  } finally {
    closeApp(app, instance);
  }
});

test('send revision is available to immediate cancel and terminal waits for snapshot before a new send', async () => {
  let snapshotCalls = 0;
  let terminalSnapshot;
  const calls = [];
  const bridge = bridgeBase(async (operation, options) => {
    calls.push({ operation, options });
    if (operation === 'sessions.list') return { ok: true, sessions: [{ session_id: 'session_a', title: 'A' }] };
    if (operation === 'chat.send') {
      return { ok: true, accepted: true, stream_id: 'stream_a', revision: 'r8' };
    }
    if (operation === 'chat.cancel') return { ok: true, revision: 'r9' };
    if (operation === 'sessions.snapshot') {
      snapshotCalls += 1;
      if (snapshotCalls === 1) return { ok: true, snapshot: snapshot('session_a', 'r1', { client_id: 'client_a', generation: 1 }) };
      if (snapshotCalls === 2) return { ok: true, snapshot: snapshot('session_a', 'r8', { client_id: 'client_a', generation: 1 }, { stream_id: 'stream_a' }) };
      terminalSnapshot = deferred();
      return terminalSnapshot.promise;
    }
    return { ok: true };
  });
  const { app, instance, connected } = connectedApp(bridge, appState());
  try {
    await app.start();
    await connected();
    enterPrompt(instance, 'start turn');
    await app.send();
    await waitFor(() => app.state.snapshot?.session?.revision === 'r8');
    await app.cancel();
    const cancel = calls.find((entry) => entry.operation === 'chat.cancel');
    assert.equal(cancel.options.expectedRevision, 'r8');

    bridgeBase.lastEvents.onEvent({ event_type: 'chat_stream', event: { stream_id: 'stream_a', type: 'complete' } });
    await waitFor(() => snapshotCalls === 3 && terminalSnapshot);
    enterPrompt(instance, 'next turn');
    await app.send();
    assert.equal(calls.filter((entry) => entry.operation === 'chat.send').length, 1);

    terminalSnapshot.resolve({ ok: true, snapshot: snapshot('session_a', 'r9', { client_id: 'client_a', generation: 1 }) });
    await waitFor(() => app.state.snapshot?.session?.revision === 'r9' && !app.state.snapshotPending);
    enterPrompt(instance, 'next turn');
    await app.send();
    assert.equal(calls.filter((entry) => entry.operation === 'chat.send').length, 2);
  } finally {
    closeApp(app, instance);
  }
});

test('repeated owned snapshots preserve the heartbeat cadence beyond one minute', async () => {
  const previousSetInterval = global.setInterval;
  const previousClearInterval = global.clearInterval;
  const timers = new Map();
  let nextTimer = 0;
  let now = 0;
  let heartbeatCalls = 0;
  const advance = async (milliseconds) => {
    const target = now + milliseconds;
    while (true) {
      const due = Array.from(timers.values()).filter((timer) => timer.nextAt <= target)
        .sort((left, right) => left.nextAt - right.nextAt)[0];
      if (!due) break;
      now = due.nextAt;
      due.nextAt += due.delay;
      due.callback();
      await flush();
    }
    now = target;
  };
  global.setInterval = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, delay, nextAt: now + delay });
    return id;
  };
  global.clearInterval = (id) => timers.delete(id);
  let snapshotCalls = 0;
  const bridge = bridgeBase(async (operation, options) => {
    if (operation === 'sessions.list') return { ok: true, sessions: [{ session_id: 'session_a', title: 'A' }] };
    if (operation === 'sessions.snapshot') {
      snapshotCalls += 1;
      return { ok: true, snapshot: { ...snapshot(options.sessionId, `r${snapshotCalls}`, { client_id: 'client_a', generation: 1 }), cursor: snapshotCalls } };
    }
    if (operation === 'control.heartbeat') heartbeatCalls += 1;
    return { ok: true, lease: { generation: 1, expires_at: 999999 } };
  });
  const { app, instance, connected } = connectedApp(bridge, appState());
  try {
    await app.start();
    await connected();
    const events = bridgeBase.lastEvents;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await advance(5000);
      events.onEvent({ cursor: attempt + 2, event_type: 'chat_stream', event: { stream_id: 'stream_a', type: 'started' } });
      await waitFor(() => snapshotCalls === attempt + 2);
    }
    await advance(60001);
    await flush();
    assert.equal(timers.size, 1);
    assert.equal(heartbeatCalls, 5);
  } finally {
    closeApp(app, instance);
    global.setInterval = previousSetInterval;
    global.clearInterval = previousClearInterval;
  }
});

test('a transient snapshot 503 exposes reload and preserves unrelated state after retry', async () => {
  let snapshotCalls = 0;
  const deferredRetry = deferred();
  const bridge = bridgeBase(async (operation, options) => {
    if (operation === 'sessions.list') return { ok: true, sessions: [{ session_id: 'session_a', title: 'A' }] };
    if (operation === 'sessions.snapshot') {
      snapshotCalls += 1;
      if (snapshotCalls === 2) throw bridgeFailure('snapshot_unavailable', 'CMP-HOST-0005', 503);
      if (snapshotCalls === 3) return deferredRetry.promise;
      if (snapshotCalls === 4) throw bridgeFailure('snapshot_unavailable', 'CMP-HOST-0005', 503);
      return { ok: true, snapshot: snapshot(options.sessionId, `r${snapshotCalls}`, { client_id: 'client_a', generation: 1 }) };
    }
    return { ok: true };
  });
  const { app, instance, connected } = connectedApp(bridge, appState());
  try {
    await app.start();
    await connected();
    bridgeBase.lastEvents.onEvent({ cursor: 2, event_type: 'chat_stream', event: { stream_id: 'stream_a', type: 'started' } });
    await waitFor(() => app.state.snapshotUnavailable === true);
    const expected = 'The conversation could not be refreshed. Use Reload conversation to retry.';
    assert.equal(app.state.error, expected);
    const retry = instance.window.document.querySelector('[data-action="reload-conversation"]');
    assert.ok(retry);
    assert.equal(retry.closest('[data-snapshot-retry]').hidden, false);
    retry.dispatchEvent(new instance.window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => snapshotCalls === 3 && app.state.snapshotPending === true);
    app.state.error = 'An unrelated attachment failed.';
    app.state.statusMessage = 'Keep this status while reloading.';
    deferredRetry.resolve({ ok: true, snapshot: snapshot('session_a', 'r3', { client_id: 'client_a', generation: 1 }) });
    await waitFor(() => app.state.snapshotUnavailable === false && !app.state.snapshotPending);
    assert.equal(app.state.error, 'An unrelated attachment failed.');
    assert.equal(app.state.statusMessage, 'Keep this status while reloading.');

    bridgeBase.lastEvents.onEvent({ cursor: 3, event_type: 'chat_stream', event: { stream_id: 'stream_a', type: 'started' } });
    await waitFor(() => snapshotCalls === 4 && app.state.snapshotUnavailable === true);
    assert.equal(app.state.error, expected);
    retry.dispatchEvent(new instance.window.MouseEvent('click', { bubbles: true }));
    await waitFor(() => snapshotCalls === 5 && !app.state.snapshotPending && !app.state.snapshotUnavailable);
    assert.equal(app.state.error, '');
  } finally {
    closeApp(app, instance);
  }
});

test('snapshot event buffering is bounded and overflow closes the live stream', async () => {
  let snapshotCalls = 0;
  const pending = deferred();
  let closed = 0;
  const bridge = bridgeBase(async (operation, options) => {
    if (operation === 'sessions.list') return { ok: true, sessions: [{ session_id: 'session_a', title: 'A' }] };
    if (operation === 'sessions.snapshot') {
      snapshotCalls += 1;
      if (snapshotCalls === 2) return pending.promise;
      return { ok: true, snapshot: snapshot(options.sessionId, `r${snapshotCalls}`, { client_id: 'client_a', generation: 1 }) };
    }
    return { ok: true };
  });
  bridge.closeEvents = () => { closed += 1; };
  const { app, instance, connected } = connectedApp(bridge, appState());
  try {
    await app.start();
    await connected();
    const events = bridgeBase.lastEvents;
    events.onEvent({ cursor: 2, event_type: 'chat_stream', event: { stream_id: 'stream_a', type: 'started' } });
    await waitFor(() => snapshotCalls === 2 && app.state.snapshotPending);
    for (let cursor = 3; cursor <= 260; cursor += 1) {
      events.onEvent({ cursor, event_type: 'chat_stream', event: { stream_id: 'stream_a', type: 'delta', content: 'x' } });
    }
    pending.resolve({ ok: true, snapshot: snapshot('session_a', 'r3', { client_id: 'client_a', generation: 1 }) });
    await waitFor(() => app.state.snapshotUnavailable === true && !app.state.snapshotPending);
    assert.equal(closed, 1);
    assert.equal(app.state.control.owned, false);
  } finally {
    closeApp(app, instance);
  }
});
