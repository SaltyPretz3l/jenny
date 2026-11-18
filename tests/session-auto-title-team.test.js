'use strict';

// new-test-file: tests/session-auto-title.test.js is at 490 lines and these cases would pass its 600-line
// ceiling; this file holds the team host's naming (row 175 item 10, owner decision D4) in one place.
//
// The sidecar method is faked; the store is a real ElectronSessionStore, the turn route is a spy, and the
// router hook runs on the real command router.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ClientRegistry } = require('../server/client-registry');
const { CommandReceipts } = require('../server/command-receipts');
const { ControlLeases } = require('../server/control-leases');
const { createCommandRouter } = require('../server/command-router');
const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { ALLOWED_NODES_PREFERENCE } = require('../services/backend/session-allowed-nodes');
const { API_VERSION } = require('../services/backend/sidecar-client');
const { maybeGenerateSessionTitle } = require('../services/backend/session-auto-title');
const { deriveSessionTitleFromMessage } = require('../renderer/shared/string-utils');
const { BOOT, BackendHarness } = require('./helpers/command-router-fixture');

const FIRST = 'Please refactor the renderer stream handler to support resumable sessions';
const REPLY = 'Start by extracting the reducer, then add a resume token.';
const TOKEN = 'T'.repeat(43);
const MEMBER = 'member_alice';

// A scratch folder removed after the test, once every disposer given to `onDone` has run (a store flushes on dispose).
function scratch(t, prefix) {
  const base = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, prefix));
  const disposers = [];
  t.after(() => {
    for (const dispose of disposers) dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, onDone: (dispose) => disposers.push(dispose) };
}

// A team host's backend: hosted mode, a turn route spy, a real store.
function teamFixture(t, { acquire } = {}) {
  const { root, onDone } = scratch(t, 'auto-title-team-');
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {}, writeDebounceMs: 60000 });
  onDone(() => store.dispose());
  const logs = [];
  const changed = [];
  const acquired = [];
  const released = [];
  const service = {
    sessionStore: store,
    hostMode: 'server',
    currentStatus: { model_loaded: true },
    currentModel: 'team-pool',
    sidecarClient: { request: async () => ({ title: '' }) },
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    featureFlags: {},
    turnRoute: {
      acquire: acquire || (async (args) => {
        acquired.push(args);
        return { token: TOKEN, model: { id: 'alpha', context_length: 8192 }, release: (info) => released.push(info) };
      }),
    },
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    emitSessionsChanged: (payload) => changed.push(payload),
  };
  return { store, service, logs, changed, acquired, released };
}

function seedChat(store, { prompt = FIRST, reply = REPLY, author = MEMBER } = {}) {
  const id = `s_${Math.random().toString(36).slice(2, 10)}`;
  store.createSessionWithId(id, {
    title: deriveSessionTitleFromMessage(prompt) || 'New Chat',
    projectId: 'project_a',
    preferences: { preferred_model: 'alpha', [ALLOWED_NODES_PREFERENCE]: ['node_one'] },
  });
  store.appendMessage(id, { role: 'user', content: prompt, ...(author ? { author: { kind: 'member', member_id: author } } : {}) });
  if (reply !== null) store.appendMessage(id, { role: 'assistant', content: reply });
  return id;
}

function fakeInference(result, { onCall } = {}) {
  const calls = [];
  const fn = async (service, method, params, options) => {
    calls.push({ method, params, options });
    if (onCall) await onCall({ service, options });
    return options.consumeResult(result, { assertNotPreempted: () => {} });
  };
  fn.calls = calls;
  return fn;
}

test('a team host names the conversation through its own route and tells the audience', async (t) => {
  const { store, service, logs, changed, acquired, released } = teamFixture(t);
  const id = seedChat(store);
  const infer = fakeInference({ title: 'Resumable streams' });
  assert.deepEqual(await maybeGenerateSessionTitle(service, id, { requestInference: infer }),
    { applied: true, reason: 'applied' });
  assert.equal(store.getSession(id).title, 'Resumable streams');
  assert.deepEqual(acquired, [{
    sessionId: id, projectId: 'project_a', memberId: MEMBER, model: 'alpha', wantsVision: false,
    allowedNodes: ['node_one'], signal: undefined, wait: false,
  }]);
  assert.equal(infer.calls.length, 1);
  assert.equal(infer.calls[0].method, 'session.generate_title');
  assert.equal(infer.calls[0].params.route_token, TOKEN);
  assert.equal(infer.calls[0].params.accept_version, API_VERSION);
  assert.equal(Object.hasOwn(infer.calls[0].params, 'model_profile'), false, 'only the token rides on the title call');
  assert.deepEqual(changed, [{ session_ids: [id] }]);
  assert.deepEqual(released, [{ ok: true }], 'the lease is released once, as used');
  assert.ok(logs.some((entry) => entry.event === 'session_title.generated'));
});

test('the team-titles switch off skips quietly, with no lease and no call', async (t) => {
  const { store, service, logs, acquired } = teamFixture(t);
  const id = seedChat(store);
  const infer = fakeInference({ title: 'Resumable streams' });
  assert.deepEqual(await maybeGenerateSessionTitle({ ...service, featureFlags: { team_titles: false } }, id,
    { requestInference: infer }), { applied: false, reason: 'team_titles_off' });
  const saved = process.env.JENNY_ENABLE_TEAM_TITLES;
  process.env.JENNY_ENABLE_TEAM_TITLES = '0';
  t.after(() => { if (saved === undefined) delete process.env.JENNY_ENABLE_TEAM_TITLES; else process.env.JENNY_ENABLE_TEAM_TITLES = saved; });
  assert.deepEqual(await maybeGenerateSessionTitle(service, id, { requestInference: infer }),
    { applied: false, reason: 'team_titles_off' }, 'the kill switch reads through the feature-flag owner');
  assert.deepEqual([acquired.length, infer.calls.length, logs.length], [0, 0, 0]);
  assert.equal(store.getSession(id).title, deriveSessionTitleFromMessage(FIRST));
});

test('a hosted server without a turn route still skips as hosted_mode', async (t) => {
  const { store, service, acquired } = teamFixture(t);
  const id = seedChat(store);
  const infer = fakeInference({ title: 'Resumable streams' });
  const { turnRoute: _route, ...bare } = service;
  assert.deepEqual(await maybeGenerateSessionTitle(bare, id, { requestInference: infer }),
    { applied: false, reason: 'hosted_mode' });
  assert.deepEqual([acquired.length, infer.calls.length], [0, 0]);
});

test('a busy pool skips quietly and the first question stays; nothing is sent', async (t) => {
  const refusals = [];
  const busy = async (args) => { refusals.push(args); throw Object.assign(new Error('busy'), { reason: 'pool_busy' }); };
  const { store, service, logs } = teamFixture(t, { acquire: busy });
  const id = seedChat(store);
  const infer = fakeInference({ title: 'Resumable streams' });
  assert.deepEqual(await maybeGenerateSessionTitle(service, id, { requestInference: infer }),
    { applied: false, reason: 'pool_busy' });
  assert.equal(refusals[0].wait, false, 'the route is asked never to queue');
  assert.equal(infer.calls.length, 0);
  assert.equal(logs.length, 0);
  assert.equal(store.getSession(id).title, deriveSessionTitleFromMessage(FIRST));
});

test('another refusal is skipped with its own reason and one info line', async (t) => {
  const forbid = async () => { throw Object.assign(new Error('no'), { reason: 'role_forbidden' }); };
  const { store, service, logs } = teamFixture(t, { acquire: forbid });
  const id = seedChat(store);
  assert.deepEqual(await maybeGenerateSessionTitle(service, id, { requestInference: fakeInference({ title: 'x' }) }),
    { applied: false, reason: 'role_forbidden' });
  assert.deepEqual(logs, [{ level: 'INFO', event: 'session_title.skipped', details: { sessionId: id, reason: 'role_forbidden' } }]);
});

test('a next turn running or queued in the conversation skips without acquiring', async (t) => {
  const { store, service, acquired, logs } = teamFixture(t);
  const id = seedChat(store);
  const infer = fakeInference({ title: 'Resumable streams' });
  const queued = { listSummaries: () => ({ items: [{ session_id: id, status: 'pending' }], next_cursor: null }) };
  assert.deepEqual(await maybeGenerateSessionTitle({ ...service, sessionRuntime: { store: queued } }, id,
    { requestInference: infer }), { applied: false, reason: 'conversation_busy' });
  const done = { listSummaries: () => ({ items: [{ session_id: id, status: 'completed' }], next_cursor: null }) };
  const running = Object.create(store);
  running.peekActiveTurn = () => ({ turn_id: 'turn_next' });
  assert.deepEqual(await maybeGenerateSessionTitle({ ...service, sessionStore: running, sessionRuntime: { store: done } }, id,
    { requestInference: infer }), { applied: false, reason: 'conversation_busy' });
  const broken = { listSummaries: () => { throw new Error('index unreadable'); } };
  assert.equal((await maybeGenerateSessionTitle({ ...service, sessionRuntime: { store: broken } }, id,
    { requestInference: infer })).reason, 'conversation_busy', 'an unreadable queue fails closed');
  assert.deepEqual([acquired.length, infer.calls.length, logs.length], [0, 0, 0]);
  // A finished neighbour turn does not block the name.
  assert.equal((await maybeGenerateSessionTitle({ ...service, sessionRuntime: { store: done } }, id,
    { requestInference: infer })).applied, true);
});

test('a manual rename during the call wins and the lease is still released once', async (t) => {
  const { store, service, changed, released } = teamFixture(t);
  const id = seedChat(store);
  const infer = fakeInference({ title: 'Model name' }, { onCall: () => store.renameSession(id, 'My own name') });
  assert.deepEqual(await maybeGenerateSessionTitle(service, id, { requestInference: infer }),
    { applied: false, reason: 'not_eligible' });
  assert.equal(store.getSession(id).title, 'My own name');
  assert.deepEqual(changed, []);
  assert.deepEqual(released, [{ ok: true }]);
});

test('a failed call keeps the first question, cancels the lease once and logs a reason only', async (t) => {
  const { store, service, logs, released } = teamFixture(t);
  const id = seedChat(store);
  const failing = async () => { throw new Error(`401 route_token_required for "${FIRST}" ${REPLY}`); };
  assert.deepEqual(await maybeGenerateSessionTitle(service, id, { requestInference: failing }),
    { applied: false, reason: 'generate_failed' });
  assert.equal(store.getSession(id).title, deriveSessionTitleFromMessage(FIRST));
  assert.deepEqual(released, [{ ok: false }]);
  assert.deepEqual(logs, [{ level: 'WARN', event: 'session_title.generate_failed', details: { sessionId: id, reason: 'generate_failed' } }]);
  assert.doesNotMatch(JSON.stringify(logs), /refactor|reducer|route_token_required/u);
});

test('an empty title (the sidecar swallowed a 401) warns with a reason and keeps the first question', async (t) => {
  const { store, service, logs, released } = teamFixture(t);
  const id = seedChat(store);
  assert.deepEqual(await maybeGenerateSessionTitle(service, id, { requestInference: fakeInference({ title: '' }) }),
    { applied: false, reason: 'empty_title' });
  assert.equal(store.getSession(id).title, deriveSessionTitleFromMessage(FIRST));
  assert.deepEqual(released, [{ ok: true }]);
  assert.deepEqual(logs, [{ level: 'WARN', event: 'session_title.generate_failed', details: { sessionId: id, reason: 'empty_title' } }]);
});

test('a malformed route token is released and nothing is sent', async (t) => {
  const released = [];
  const bad = async () => ({ token: 'short', release: (info) => released.push(info) });
  const { store, service } = teamFixture(t, { acquire: bad });
  const id = seedChat(store);
  const infer = fakeInference({ title: 'x' });
  assert.deepEqual(await maybeGenerateSessionTitle(service, id, { requestInference: infer }),
    { applied: false, reason: 'route_token_invalid' });
  assert.deepEqual([released, infer.calls.length], [[{ ok: false }], 0]);
});

test('a chat with no member author asks with a null member; nobody is invented', async (t) => {
  const { store, service, acquired } = teamFixture(t);
  const id = seedChat(store, { author: null });
  await maybeGenerateSessionTitle(service, id, { requestInference: fakeInference({ title: 'Resumable streams' }) });
  assert.equal(acquired[0].memberId, null, 'the pool refuses it (member_author_required)');
});

test('the team host router turns a stored title into session_changed renamed for the audience', async (t) => {
  const { root, onDone } = scratch(t, 'auto-title-router-');
  const backend = new BackendHarness(root);
  const published = [];
  const router = createCommandRouter({ backend, clients: new ClientRegistry(), leases: new ControlLeases(), bootEpoch: BOOT,
    receipts: new CommandReceipts({ filePath: path.join(root, 'receipts.json') }),
    eventStream: { publish: (type, payload) => published.push({ type, payload }) }, authorize: () => ({ ok: true }) });
  onDone(() => { router.dispose(); backend.dispose(); });
  const id = backend.sessionStore.createSession({ title: 'Clipped first question' }).id;
  assert.equal(typeof backend.emitSessionsChanged, 'function');
  backend.emitSessionsChanged({ session_ids: [id, 'session_unknown', 7] });
  assert.equal(published.length, 1, 'an unknown session or a malformed id publishes nothing');
  assert.equal(published[0].type, 'session_changed');
  assert.equal(published[0].payload.session_id, id);
  assert.equal(published[0].payload.reason, 'renamed');
  assert.match(published[0].payload.revision, /:1$/u);
  router.dispose();
  assert.equal(backend.emitSessionsChanged, undefined, 'the hook goes with the router');
});

test('a single-owner host router installs no title hook', (t) => {
  const { root, onDone } = scratch(t, 'auto-title-owner-');
  const backend = new BackendHarness(root);
  const router = createCommandRouter({ backend, clients: new ClientRegistry(), leases: new ControlLeases(), bootEpoch: BOOT,
    receipts: new CommandReceipts({ filePath: path.join(root, 'receipts.json') }), eventStream: { publish() {} } });
  onDone(() => { router.dispose(); backend.dispose(); });
  assert.equal(backend.emitSessionsChanged, undefined);
});
