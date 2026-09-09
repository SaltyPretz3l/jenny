'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const view = require('../../renderer/browser/browser-view');
const { BrowserApp } = require('../../renderer/browser/app');
const { BrowserBridge, BrowserBridgeError } = require('../../renderer/browser/browser-bridge');

function snapshot(sessionId = 'session_a') {
  return {
    session: { session_id: sessionId, title: sessionId, revision: 'r1', plan_mode: false },
    messages: [], pending_approvals: [], pending_questions: [], active_turn: null, live_projection: null,
    control: { client_id: 'client_a', generation: 1, expires_at: 999999 },
  };
}

function state(overrides = {}) {
  return {
    authenticated: true, connectionState: 'connected', error: '', statusMessage: '',
    sessions: [{ session_id: 'session_a', title: 'A' }, { session_id: 'session_b', title: 'B' }],
    selectedSessionId: 'session_a', snapshot: snapshot(), liveProjection: null, activeStreamId: '',
    planMode: false, draft: 'send once', editingSessionId: '',
    control: { owned: true, ownerClientId: 'client_a', generation: 1, expiresAt: 999999 },
    controlBusy: false, pendingDecisionKey: '', composerMode: 'send', attachments: [],
    authSessions: [], authSessionsOpen: false, authSessionsBusy: false, authSessionsError: '',
    mutationPending: false, mutationChecking: false, ...overrides,
  };
}

function ambiguous(command, code = 'request_timeout') {
  const error = new BrowserBridgeError(code, { code, retryable: true });
  error.requestId = command.request_id;
  error.command = command;
  return error;
}

function command(operation, requestId, options = {}) {
  return {
    api_version: 1, operation, request_id: requestId, client_id: 'client_a', boot_epoch: 'boot_a',
    session_id: options.sessionId, control_generation: options.controlGeneration,
    expected_revision: options.expectedRevision || '', params: options.params || {},
  };
}

function appWithBridge(bridge, overrides = {}) {
  const instance = new JSDOM('<!doctype html><div id="root"></div>');
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'), bridge, state: state(overrides), view,
    reconnect: { start() {}, stop() {}, reconnectNow() {} },
  });
  return { app, instance };
}

function close(app, instance) {
  app.dispose();
  instance.window.close();
}

function flush() { return new Promise((resolve) => setImmediate(resolve)); }

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.equal(predicate(), true, 'condition did not settle in time');
}

function response(payload, status = 200, json = async () => payload) {
  return { ok: status >= 200 && status < 300, status, json };
}

test('a committed chat whose response is lost settles by receipt without a second backend effect', async () => {
  let effects = 0;
  let committedId = '';
  const bridge = new BrowserBridge({ fetchImpl: async (_url, options) => {
    const sent = JSON.parse(options.body);
    if (sent.operation === 'chat.send') {
      effects += 1;
      committedId = sent.request_id;
      return response(null, 200, async () => { throw new Error('truncated response'); });
    }
    if (sent.operation === 'requests.status') {
      assert.equal(sent.params.request_id, committedId);
      return response({ ok: true, state: 'settled', result: { ok: true, accepted: true, stream_id: 'stream_once', revision: 'r2' } });
    }
    if (sent.operation === 'sessions.snapshot') {
      return response({ ok: true, snapshot: { ...snapshot(sent.session_id), active_turn: { stream_id: 'stream_once' } } });
    }
    throw new Error(`unexpected operation ${sent.operation}`);
  } });
  Object.assign(bridge, { clientId: 'client_a', clientToken: 'token', csrfToken: 'csrf', bootEpoch: 'boot_a' });
  const { app, instance } = appWithBridge(bridge);
  try {
    await app.send();
    assert.equal(effects, 1);
    assert.match(committedId, /^request_/u);
    assert.equal(app.state.draft, '');
    assert.equal(app.state.activeStreamId, 'stream_once');
    assert.equal(app.state.mutationPending, false);
  } finally { close(app, instance); }
});

test('a malformed gateway 5xx after commit retains the request id and settles without a second effect', async () => {
  let effects = 0;
  let committedId = '';
  let statusLookups = 0;
  const bridge = new BrowserBridge({ fetchImpl: async (_url, options) => {
    const sent = JSON.parse(options.body);
    if (sent.operation === 'chat.send') {
      effects += 1;
      committedId = sent.request_id;
      return response({ gateway: 'upstream response lost' }, 502);
    }
    if (sent.operation === 'requests.status') {
      statusLookups += 1;
      assert.equal(sent.params.request_id, committedId);
      return response({ ok: true, state: 'settled', result: { ok: true, accepted: true, stream_id: 'stream_gateway', revision: 'r2' } });
    }
    if (sent.operation === 'sessions.snapshot') {
      return response({ ok: true, snapshot: { ...snapshot(sent.session_id), active_turn: { stream_id: 'stream_gateway' } } });
    }
    throw new Error(`unexpected operation ${sent.operation}`);
  } });
  Object.assign(bridge, { clientId: 'client_a', clientToken: 'token', csrfToken: 'csrf', bootEpoch: 'boot_a' });
  const { app, instance } = appWithBridge(bridge);
  try {
    await app.send();
    assert.equal(effects, 1);
    assert.equal(statusLookups, 1);
    assert.match(committedId, /^request_/u);
    assert.equal(app.state.draft, '');
    assert.equal(app.state.activeStreamId, 'stream_gateway');
    assert.equal(app.state.mutationPending, false);
  } finally { close(app, instance); }
});

test('an authoritative retryable server rejection is definitive and does not start reconciliation', async () => {
  let statusLookups = 0;
  const bridge = new BrowserBridge({ fetchImpl: async (_url, options) => {
    const sent = JSON.parse(options.body);
    if (sent.operation === 'chat.send') {
      return response({
        ok: false,
        error: { code: 'CMP-HOST-0005', reason: 'backend_unavailable', retryable: true },
      }, 503);
    }
    if (sent.operation === 'requests.status') statusLookups += 1;
    throw new Error(`unexpected operation ${sent.operation}`);
  } });
  Object.assign(bridge, { clientId: 'client_a', clientToken: 'token', csrfToken: 'csrf', bootEpoch: 'boot_a' });
  const { app, instance } = appWithBridge(bridge);
  try {
    await app.send();
    assert.equal(statusLookups, 0);
    assert.equal(app.state.mutationPending, false);
    assert.equal(app.state.draft, 'send once');
    assert.match(app.state.error, /backend unavailable/iu);
  } finally { close(app, instance); }
});

test('an unknown receipt retries the exact stored envelope and never generates a fresh request id', async () => {
  let original;
  let retry;
  let effects = 0;
  const bridge = {
    clientId: 'client_a',
    async command(operation, options) {
      original = command(operation, 'request_exact', options);
      throw ambiguous(original, 'host_unavailable');
    },
    async requestStatus() { return { ok: true, state: 'unknown' }; },
    async retryCommand(value) {
      retry = value;
      effects += 1;
      return { ok: true, session: { session_id: 'created_once' }, revision: 'r1' };
    },
    dispose() {},
  };
  const { app, instance } = appWithBridge(bridge);
  try {
    const result = await app._command('sessions.create', { params: { title: 'New chat' } });
    assert.equal(result.session.session_id, 'created_once');
    assert.equal(retry, original);
    assert.equal(retry.request_id, 'request_exact');
    assert.equal(effects, 1);
  } finally { close(app, instance); }
});

test('pending and indeterminate receipts block fresh mutations and expose a bounded check action', async () => {
  let statusState = 'pending';
  let mutationCalls = 0;
  let statusCalls = 0;
  const bridge = {
    clientId: 'client_a',
    async command(operation, options) {
      mutationCalls += 1;
      throw ambiguous(command(operation, 'request_pending', options));
    },
    async requestStatus() { statusCalls += 1; return { ok: true, state: statusState }; },
    dispose() {}, clearCredentials() {},
  };
  const { app, instance } = appWithBridge(bridge);
  try {
    await app.send();
    assert.equal(app.state.mutationPending, true);
    assert.equal(app.root.querySelector('[data-action="send-chat"]')?.disabled, true);
    assert.equal(app.root.querySelector('[data-mutation-retry]')?.hidden, false);
    await app.createSession();
    assert.equal(mutationCalls, 1, 'a different mutation is rejected before bridge dispatch');
    statusState = 'indeterminate';
    await app._reconcilePendingMutation();
    assert.equal(app.state.mutationPending, true);
    assert.match(app.state.statusMessage, /cannot safely determine/u);

    app._invalidateAuthentication();
    await app._reconcilePendingMutation();
    assert.equal(statusCalls, 2, 'auth change prevents receipt lookup or replay under a new identity');
    assert.match(app.state.statusMessage, /reload Jenny/u);
  } finally { close(app, instance); }
});

test('an auth change before an ambiguous completion keeps the old request blocked without replay', async () => {
  let rejectCommand;
  let statusCalls = 0;
  const original = command('chat.send', 'request_old_auth', {
    sessionId: 'session_a', controlGeneration: 1, params: { prompt: 'send once' },
  });
  const bridge = {
    clientId: 'client_a',
    command: async () => new Promise((_resolve, reject) => { rejectCommand = reject; }),
    async requestStatus() { statusCalls += 1; return { ok: true, state: 'unknown' }; },
    clearCredentials() {}, dispose() {},
  };
  const { app, instance } = appWithBridge(bridge);
  try {
    const sending = app.send();
    await flush();
    app._invalidateAuthentication();
    rejectCommand(ambiguous(original));
    await sending;
    assert.equal(app.state.mutationPending, true);
    await app._reconcilePendingMutation();
    assert.equal(statusCalls, 0);
    assert.match(app.state.statusMessage, /reload Jenny/u);
  } finally { close(app, instance); }
});

test('an auth change while receipt status is pending cannot settle or apply the old result', async () => {
  const statusResult = deferred();
  let statusCalls = 0;
  const original = command('chat.send', 'request_status_race', {
    sessionId: 'session_a', controlGeneration: 1, params: { prompt: 'send once' },
  });
  const bridge = {
    clientId: 'client_a',
    async command() { throw ambiguous(original); },
    async requestStatus() { statusCalls += 1; return statusResult.promise; },
    clearCredentials() {}, dispose() {},
  };
  const { app, instance } = appWithBridge(bridge);
  try {
    const sending = app.send();
    await waitFor(() => statusCalls === 1);
    app._invalidateAuthentication();
    statusResult.resolve({
      ok: true, state: 'settled',
      result: { ok: true, accepted: true, stream_id: 'stale_status_stream' },
    });
    await sending;
    assert.equal(app.state.mutationPending, true);
    assert.equal(app.state.draft, 'send once');
    assert.equal(app.state.activeStreamId, '');
    await app._reconcilePendingMutation();
    assert.equal(statusCalls, 1);
    assert.match(app.state.statusMessage, /reload Jenny/u);
  } finally { close(app, instance); }
});

test('an auth change while an exact retry is pending cannot settle or apply the old result', async () => {
  const retryResult = deferred();
  let retryCalls = 0;
  const original = command('chat.send', 'request_retry_race', {
    sessionId: 'session_a', controlGeneration: 1, params: { prompt: 'send once' },
  });
  const bridge = {
    clientId: 'client_a',
    async command() { throw ambiguous(original, 'host_unavailable'); },
    async requestStatus() { return { ok: true, state: 'unknown' }; },
    async retryCommand(value) {
      retryCalls += 1;
      assert.equal(value, original);
      return retryResult.promise;
    },
    clearCredentials() {}, dispose() {},
  };
  const { app, instance } = appWithBridge(bridge);
  try {
    const sending = app.send();
    await waitFor(() => retryCalls === 1);
    app._invalidateAuthentication();
    retryResult.resolve({ ok: true, accepted: true, stream_id: 'stale_retry_stream' });
    await sending;
    assert.equal(app.state.mutationPending, true);
    assert.equal(app.state.draft, 'send once');
    assert.equal(app.state.activeStreamId, '');
    await app._reconcilePendingMutation();
    assert.match(app.state.statusMessage, /reload Jenny/u);
  } finally { close(app, instance); }
});

test('settlement after selection changes refreshes the current session without clearing its draft', async () => {
  let statusState = 'pending';
  const bridge = {
    clientId: 'client_a',
    async command(operation, options) {
      if (operation === 'sessions.snapshot') return { ok: true, snapshot: snapshot(options.sessionId) };
      throw ambiguous(command(operation, 'request_old_session', options));
    },
    async requestStatus() {
      return statusState === 'pending' ? { ok: true, state: 'pending' }
        : { ok: true, state: 'settled', result: { ok: true, accepted: true, stream_id: 'old_stream' } };
    },
    dispose() {},
  };
  const { app, instance } = appWithBridge(bridge);
  try {
    await app.send();
    await app.selectSession('session_b');
    app.state.draft = 'same words, different session';
    statusState = 'settled';
    await app._reconcilePendingMutation({ refresh: true });
    assert.equal(app.state.selectedSessionId, 'session_b');
    assert.equal(app.state.draft, 'same words, different session');
    assert.equal(app.state.activeStreamId, '');
    assert.equal(app.state.snapshot.session.session_id, 'session_b');
  } finally { close(app, instance); }
});
