'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const view = require('../../renderer/browser/browser-view');
const { BrowserApp } = require('../../renderer/browser/app');
const { BrowserBridgeError } = require('../../renderer/browser/browser-bridge');

const MARKER = 'jenny.browser.signOutPending';

function dom() {
  const instance = new JSDOM('<!doctype html><div id="root"></div>');
  global.window = instance.window;
  global.document = instance.window.document;
  return instance;
}

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: (key) => { data.delete(key); },
    has: (key) => data.has(key),
  };
}

function throwingStorage() {
  const fail = () => { throw new Error('storage blocked'); };
  return { getItem: fail, setItem: fail, removeItem: fail };
}

function networkError() {
  return new BrowserBridgeError('offline', { code: 'bridge_unavailable', status: 0 });
}

function authError(status = 401) {
  return new BrowserBridgeError('expired', { code: 'auth_required', status });
}

function makeBridge(overrides = {}) {
  const calls = [];
  const bridge = {
    calls,
    clientId: 'client_a',
    login: async () => { calls.push('login'); },
    bootstrap: async () => { calls.push('bootstrap'); return { tools: { execution: false } }; },
    registerClient: async () => { calls.push('registerClient'); },
    logout: async () => { calls.push('logout'); },
    clearCredentials() {},
    dispose() {},
    connectEvents: async () => ({ close() {} }),
    command: async (operation) => {
      calls.push(operation);
      if (operation === 'sessions.list') return { ok: true, sessions: [] };
      return { ok: true };
    },
    ...overrides,
  };
  return bridge;
}

function signedInState(extra = {}) {
  return {
    authenticated: true,
    connectionState: 'connected',
    sessions: [],
    selectedSessionId: '',
    snapshot: null,
    control: { owned: false, ownerClientId: '', generation: 0, expiresAt: 0 },
    ...extra,
  };
}

function buildApp({ bridge, storage, state }) {
  const instance = dom();
  const app = new BrowserApp({
    root: instance.window.document.getElementById('root'),
    bridge,
    state,
    view,
    storage,
    reconnect: { start() {}, stop() {} },
  });
  return { app, instance, doc: instance.window.document };
}

function close(app, instance) {
  app.dispose?.();
  instance.window.close();
}

const noticeIn = (doc) => doc.querySelector('[data-signout-unconfirmed]');
const retryButtonIn = (doc) => doc.querySelector('[data-action="retry-logout"]');

test('an offline logout locks the browser but reports the sign-out as unconfirmed', async () => {
  const storage = memoryStorage();
  const bridge = makeBridge({ logout: async () => { throw networkError(); } });
  const { app, instance, doc } = buildApp({ bridge, storage, state: signedInState() });
  try {
    await app.logout();
    assert.equal(app.state.authenticated, false);
    assert.equal(app.state.signOutUnconfirmed, true);
    assert.equal(storage.getItem(MARKER), '1');
    assert.ok(noticeIn(doc), 'the unconfirmed notice should be shown');
    assert.match(noticeIn(doc).textContent, /could not reach the host/);
    assert.ok(retryButtonIn(doc), 'a retry button should be shown');
  } finally {
    close(app, instance);
  }
});

test('a logout rejected as unauthenticated counts as confirmed', async () => {
  for (const failure of [authError(401), new BrowserBridgeError('expired', { code: 'bridge_unavailable', status: 401 })]) {
    const storage = memoryStorage({ [MARKER]: '1' });
    const bridge = makeBridge({ logout: async () => { throw failure; } });
    const { app, instance, doc } = buildApp({ bridge, storage, state: signedInState() });
    try {
      await app.logout();
      assert.equal(app.state.signOutUnconfirmed, false);
      assert.equal(storage.has(MARKER), false);
      assert.equal(noticeIn(doc), null);
    } finally {
      close(app, instance);
    }
  }
});

test('a server error or forbidden logout stays unconfirmed', async () => {
  for (const status of [500, 403]) {
    const storage = memoryStorage();
    const bridge = makeBridge({ logout: async () => { throw new BrowserBridgeError('no', { code: 'host_error', status }); } });
    const { app, instance } = buildApp({ bridge, storage, state: signedInState() });
    try {
      await app.logout();
      assert.equal(app.state.signOutUnconfirmed, true, `status ${status}`);
      assert.equal(storage.getItem(MARKER), '1');
    } finally {
      close(app, instance);
    }
  }
});

test('a confirmed logout shows the plain signed-out view', async () => {
  const storage = memoryStorage();
  const { app, instance, doc } = buildApp({ bridge: makeBridge(), storage, state: signedInState() });
  try {
    await app.logout();
    assert.equal(app.state.signOutUnconfirmed, false);
    assert.equal(storage.has(MARKER), false);
    assert.equal(noticeIn(doc), null);
    assert.equal(retryButtonIn(doc), null);
  } finally {
    close(app, instance);
  }
});

test('retrying the sign-out confirms it without signing the user back in', async () => {
  const storage = memoryStorage();
  let offline = true;
  const bridge = makeBridge({
    logout: async function logout() {
      bridge.calls.push('logout');
      if (offline) throw networkError();
    },
  });
  const { app, instance, doc } = buildApp({ bridge, storage, state: signedInState() });
  try {
    await app.logout();
    assert.equal(app.state.signOutUnconfirmed, true);
    offline = false;
    bridge.calls.length = 0;
    retryButtonIn(doc).dispatchEvent(new instance.window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(bridge.calls, ['bootstrap', 'logout']);
    assert.equal(app.state.signOutUnconfirmed, false);
    assert.equal(storage.has(MARKER), false);
    assert.equal(app.state.authenticated, false);
    assert.equal(app.state.busy, false);
    assert.equal(noticeIn(doc), null, 'the notice disappears on re-render');
    assert.equal(retryButtonIn(doc), null);
    assert.ok(doc.querySelector('[data-browser-login]'));
  } finally {
    close(app, instance);
  }
});

test('retrying while still offline keeps the unconfirmed state and clears busy', async () => {
  const storage = memoryStorage();
  for (const failing of ['bootstrap', 'logout']) {
    const bridge = makeBridge({ logout: async () => { throw networkError(); } });
    const { app, instance, doc } = buildApp({ bridge, storage, state: signedInState() });
    try {
      await app.logout();
      if (failing === 'bootstrap') bridge.bootstrap = async () => { throw networkError(); };
      await app.identity.retryLogout();
      assert.equal(app.state.signOutUnconfirmed, true, failing);
      assert.equal(storage.getItem(MARKER), '1', failing);
      assert.equal(app.state.busy, false, failing);
      assert.equal(app.state.authenticated, false, failing);
      assert.ok(noticeIn(doc), failing);
      assert.equal(retryButtonIn(doc).disabled, false, failing);
    } finally {
      close(app, instance);
    }
  }
});

test('a retry whose host session is already invalid counts as confirmed', async () => {
  const storage = memoryStorage({ [MARKER]: '1' });
  const bridge = makeBridge({ bootstrap: async () => { throw authError(401); } });
  const { app, instance } = buildApp({ bridge, storage, state: signedInState({ authenticated: false, signOutUnconfirmed: true }) });
  try {
    await app.identity.retryLogout();
    assert.equal(app.state.signOutUnconfirmed, false);
    assert.equal(storage.has(MARKER), false);
  } finally {
    close(app, instance);
  }
});

test('a retry is ignored while another request is busy', async () => {
  const bridge = makeBridge();
  const { app, instance } = buildApp({ bridge, storage: memoryStorage(), state: signedInState({ authenticated: false, busy: true }) });
  try {
    await app.identity.retryLogout();
    assert.deepEqual(bridge.calls, []);
  } finally {
    close(app, instance);
  }
});

test('starting with a pending sign-out retries it instead of resuming the session', async () => {
  const storage = memoryStorage({ [MARKER]: '1' });
  const bridge = makeBridge();
  const { app, instance, doc } = buildApp({ bridge, storage, state: signedInState({ authenticated: false }) });
  try {
    await app.start();
    assert.equal(app.state.authenticated, false);
    assert.deepEqual(bridge.calls, ['bootstrap', 'logout']);
    assert.equal(storage.has(MARKER), false);
    assert.equal(app.state.signOutUnconfirmed, false);
    assert.ok(doc.querySelector('[data-browser-login]'));
  } finally {
    close(app, instance);
  }
});

test('starting with a pending sign-out while offline stays signed out with the notice', async () => {
  const storage = memoryStorage({ [MARKER]: '1' });
  const bridge = makeBridge({ bootstrap: async () => { throw networkError(); } });
  const { app, instance, doc } = buildApp({ bridge, storage, state: signedInState({ authenticated: false }) });
  try {
    await app.start();
    assert.equal(app.state.authenticated, false);
    assert.equal(app.state.signOutUnconfirmed, true);
    assert.equal(storage.getItem(MARKER), '1');
    assert.ok(noticeIn(doc));
    assert.equal(bridge.calls.includes('registerClient'), false);
  } finally {
    close(app, instance);
  }
});

test('starting without the marker resumes the session as before', async () => {
  const bridge = makeBridge();
  const { app, instance } = buildApp({ bridge, storage: memoryStorage(), state: signedInState({ authenticated: false }) });
  try {
    await app.start();
    assert.equal(app.state.authenticated, true);
    assert.equal(bridge.calls.includes('registerClient'), true);
  } finally {
    close(app, instance);
  }
});

test('signing in again clears the unconfirmed sign-out, and a failed login keeps it', async () => {
  const storage = memoryStorage({ [MARKER]: '1' });
  let reject = true;
  const bridge = makeBridge({
    login: async () => { if (reject) throw new BrowserBridgeError('bad password', { code: 'invalid_credentials', status: 401 }); },
  });
  const { app, instance } = buildApp({ bridge, storage, state: signedInState({ authenticated: false, signOutUnconfirmed: true }) });
  try {
    await app.login('wrong');
    assert.equal(app.state.authenticated, false);
    assert.equal(app.state.signOutUnconfirmed, true);
    assert.equal(storage.getItem(MARKER), '1');
    reject = false;
    await app.login('right');
    assert.equal(app.state.authenticated, true);
    assert.equal(app.state.signOutUnconfirmed, false);
    assert.equal(storage.has(MARKER), false);
  } finally {
    close(app, instance);
  }
});

test('logout and retry work when storage throws on every call', async () => {
  const bridge = makeBridge({ logout: async () => { throw networkError(); } });
  const { app, instance, doc } = buildApp({ bridge, storage: throwingStorage(), state: signedInState() });
  try {
    await app.logout();
    assert.equal(app.state.signOutUnconfirmed, true);
    assert.ok(noticeIn(doc));
    bridge.logout = async () => {};
    await app.identity.retryLogout();
    assert.equal(app.state.signOutUnconfirmed, false);
    assert.equal(app.state.busy, false);
    await app.start();
    assert.equal(app.state.authenticated, true);
  } finally {
    close(app, instance);
  }
});

function deleteState() {
  return signedInState({
    sessions: [
      { session_id: 'session_a', title: 'A', message_count: 0 },
      { session_id: 'session_b', title: 'B', message_count: 0 },
    ],
    selectedSessionId: 'session_a',
    planMode: false,
    snapshot: {
      session: { session_id: 'session_a', title: 'A', revision: 'r1', plan_mode: false },
      messages: [],
      pending_approvals: [],
      pending_questions: [],
      control: { client_id: 'client_a', generation: 4, expires_at: 999999 },
      active_turn: null,
      live_projection: null,
    },
    control: { owned: true, ownerClientId: 'client_a', generation: 4, expiresAt: 999999 },
  });
}

async function deleteWith(deleteResult) {
  const bridge = makeBridge({
    command: async (operation, options) => {
      if (operation === 'sessions.delete') return deleteResult;
      if (operation === 'sessions.snapshot') {
        return {
          ok: true,
          snapshot: {
            session: { session_id: options.sessionId, title: 'B', revision: 'r1', plan_mode: false },
            messages: [],
            pending_approvals: [],
            pending_questions: [],
            control: null,
            active_turn: null,
            live_projection: null,
          },
        };
      }
      return { ok: true, sessions: [] };
    },
  });
  const { app, instance } = buildApp({ bridge, storage: memoryStorage(), state: deleteState() });
  try {
    await app.deleteSession('session_a');
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve));
    return { message: app.state.statusMessage, selected: app.state.selectedSessionId, sessions: app.state.sessions.length };
  } finally {
    close(app, instance);
  }
}

test('a delete with degraded cleanup keeps its notice after the next chat loads', async () => {
  const outcome = await deleteWith({ ok: true, deleted: true, cleanup_status: 'degraded' });
  assert.equal(outcome.message, 'The chat was deleted, but some of its files could not be removed from the host.');
  assert.equal(outcome.selected, 'session_b');
  assert.equal(outcome.sessions, 1);
});

test('a delete with complete or absent cleanup status sets no notice', async () => {
  for (const result of [{ ok: true, deleted: true, cleanup_status: 'complete' }, { ok: true, deleted: true }]) {
    const outcome = await deleteWith(result);
    assert.equal(outcome.message, '');
    assert.equal(outcome.sessions, 1);
  }
});
