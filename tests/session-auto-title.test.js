'use strict';

// Row 112 S2: the model-written chat name. The sidecar method is faked; the
// store is a real ElectronSessionStore so the title-equals-derived guard is
// proven against what a real send stores.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ElectronSessionStore } = require('../services/backend/electron-session-store');
const { API_VERSION } = require('../services/backend/sidecar-client');
const { RuntimeLaneAdmission } = require('../services/session-runtime/lanes');
const { requestRuntimeInference } = require('../services/backend/backend-runtime-inference');
const {
  beginRuntimeInferenceInitialization,
  completeRuntimeInferenceInitialization,
} = require('../services/session-runtime/inference-protocol');
const { deriveSessionTitleFromMessage } = require('../renderer/shared/string-utils');
const { buildFeatureFlagDefaults, INTERNAL_FEATURE_FLAG_KEYS } = require('../services/feature-flags');
const { REQUEST_TIMEOUT_MS_BY_METHOD } = require('../services/backend/sidecar-request-timeouts');
const { AUTHORITY, createAdapterHarness, request, waitFor } = require('./helpers/session-runtime-chat-adapter-harness');
const {
  isTitleEligible,
  maybeGenerateSessionTitle,
} = require('../services/backend/session-auto-title');

const FIRST = 'Please refactor the renderer stream handler to support resumable sessions';
const REPLY = 'Start by extracting the reducer, then add a resume token.';

function fixture(t) {
  const scratch = path.join(process.cwd(), '.tmp');
  fs.mkdirSync(scratch, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratch, 'auto-title-'));
  const store = new ElectronSessionStore(path.join(root, 'sessions.json'), { logger() {}, writeDebounceMs: 60000 });
  t.after(() => { store.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  const logs = [];
  const changed = [];
  const service = {
    sessionStore: store,
    currentStatus: { model_loaded: true },
    currentModel: 'mock-v1',
    sidecarClient: { request: async () => ({ title: '' }) },
    sidecarManager: { getStatus: () => ({ phase: 'ready' }) },
    featureFlags: {},
    _emitServiceLog: (level, event, details) => logs.push({ level, event, details }),
    emitSessionsChanged: (payload) => changed.push(payload),
  };
  return { store, service, logs, changed };
}

// A chat as a real send leaves it: the title and the stored user row both come
// from the same visible prompt.
function seedChat(store, { prompt = FIRST, reply = REPLY, extra = {}, title } = {}) {
  const id = `s_${Math.random().toString(36).slice(2, 10)}`;
  store.createSessionWithId(id, { title: title ?? (deriveSessionTitleFromMessage(prompt) || 'New Chat'), ...extra });
  store.appendMessage(id, { role: 'user', content: prompt });
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

const rejecting = (error) => {
  const fn = async (_service, method, params, options) => {
    fn.calls.push({ method, params, options });
    throw error;
  };
  fn.calls = [];
  return fn;
};

// --- skips ---------------------------------------------------------------

test('skips, in order, each with its own reason and no sidecar call', async (t) => {
  const { store, service } = fixture(t);
  const id = seedChat(store);
  const infer = fakeInference({ title: 'Resumable streams' });
  const run = (patch) => maybeGenerateSessionTitle({ ...service, ...patch }, id, { requestInference: infer });

  assert.deepEqual(await run({ featureFlags: { session_model_titles: false } }),
    { applied: false, reason: 'flag_off' });
  assert.deepEqual(await run({ hostMode: 'server' }), { applied: false, reason: 'hosted_mode' });
  assert.deepEqual(await run({ sidecarClient: null }), { applied: false, reason: 'sidecar_unavailable' });
  assert.deepEqual(await run({ sidecarManager: { getStatus: () => ({ phase: 'starting' }) } }),
    { applied: false, reason: 'sidecar_not_ready' });
  assert.deepEqual(await run({ currentStatus: { model_loaded: false }, currentModel: '' }),
    { applied: false, reason: 'model_not_loaded' });
  store.appendMessage(id, { role: 'user', content: 'second' });
  assert.deepEqual(await run({}), { applied: false, reason: 'not_eligible' });
  assert.equal(infer.calls.length, 0);
  // Order: the flag is checked before everything else.
  assert.equal((await run({ featureFlags: { session_model_titles: false }, hostMode: 'server', sidecarClient: null })).reason, 'flag_off');
  assert.equal((await run({ hostMode: 'server', sidecarClient: null })).reason, 'hosted_mode');
});

test('a request already in flight for the session is not duplicated, and is cleared afterwards', async (t) => {
  const { store, service } = fixture(t);
  const id = seedChat(store);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const infer = fakeInference({ title: 'Resumable streams' }, { onCall: () => gate });
  const first = maybeGenerateSessionTitle(service, id, { requestInference: infer });
  const second = await maybeGenerateSessionTitle(service, id, { requestInference: infer });
  assert.deepEqual(second, { applied: false, reason: 'request_in_flight' });
  release();
  assert.deepEqual(await first, { applied: true, reason: 'applied' });
  assert.equal(infer.calls.length, 1);
  // Cleared in finally: a later call on the (now renamed) chat reaches eligibility again.
  assert.equal((await maybeGenerateSessionTitle(service, id, { requestInference: infer })).reason, 'not_eligible');
});

test('the in-flight guard is cleared after a failed call', async (t) => {
  const { store, service } = fixture(t);
  const id = seedChat(store);
  const failing = rejecting(new Error('boom'));
  assert.equal((await maybeGenerateSessionTitle(service, id, { requestInference: failing })).applied, false);
  const infer = fakeInference({ title: 'Resumable streams' });
  assert.equal((await maybeGenerateSessionTitle(service, id, { requestInference: infer })).applied, true);
});

// --- eligibility ---------------------------------------------------------

test('eligibility: the first reply of an untouched chat', (t) => {
  const { store } = fixture(t);
  const id = seedChat(store);
  assert.equal(isTitleEligible(store.getSession(id)), true);
  assert.equal(isTitleEligible(null), false);
  assert.equal(isTitleEligible({}), false);
});

test('eligibility: the stored user text and title agree with a real send', (t) => {
  const { store } = fixture(t);
  for (const prompt of [
    FIRST,
    'Hi Jenny. Refactor the renderer stream handler to support resumable sessions',
    '/plan   fix   the   flaky   rail   test',
    `  ${'long words '.repeat(20)}  `,
  ]) {
    const id = seedChat(store, { prompt });
    const session = store.getSession(id);
    const stored = session.messages.find((m) => m.role === 'user').content;
    assert.equal(session.title, deriveSessionTitleFromMessage(stored), `title matches stored text for: ${prompt}`);
    assert.equal(isTitleEligible(session), true, prompt);
  }
});

test('eligibility: a second user message ends it', (t) => {
  const { store } = fixture(t);
  const id = seedChat(store);
  store.appendMessage(id, { role: 'user', content: 'and then?' });
  assert.equal(isTitleEligible(store.getSession(id)), false);
});

test('eligibility: a manual rename wins; the default title stays eligible', (t) => {
  const { store } = fixture(t);
  const renamed = seedChat(store);
  store.renameSession(renamed, 'My own name');
  assert.equal(isTitleEligible(store.getSession(renamed)), false);
  const fresh = seedChat(store, { title: 'New Chat' });
  assert.equal(isTitleEligible(store.getSession(fresh)), true);
  const blank = { ...store.getSession(fresh), title: '' };
  assert.equal(isTitleEligible(blank), true);
});

test('eligibility: primary, plugin and spawned sessions are excluded', (t) => {
  const { store } = fixture(t);
  const base = store.getSession(seedChat(store));
  assert.equal(isTitleEligible({ ...base, session_role: 'primary' }), false);
  assert.equal(isTitleEligible({ ...base, session_type: 'plugin' }), false);
  assert.equal(isTitleEligible({ ...base, spawned_from: { schema_version: 1 } }), false);
});

test('eligibility: context rows are ignored and a real assistant reply is required', (t) => {
  const { store } = fixture(t);
  const base = store.getSession(seedChat(store));
  const user = base.messages.find((m) => m.role === 'user');
  const assistant = base.messages.find((m) => m.role === 'assistant');
  const withContext = { ...base, messages: [
    { role: 'context', content: 'earlier' }, user, { role: 'context', content: 'more' }, assistant,
  ] };
  assert.equal(isTitleEligible(withContext), true);
  const twoUsers = { ...base, messages: [{ role: 'user', content: 'an earlier user row' }, user, assistant] };
  assert.equal(isTitleEligible(twoUsers), false, 'two non-context user rows');
  assert.equal(isTitleEligible({ ...base, messages: [user] }), false, 'no assistant');
  assert.equal(isTitleEligible({ ...base, messages: [user, { ...assistant, content: '   ' }] }), false, 'blank assistant');
  assert.equal(isTitleEligible({ ...base, messages: [user, { ...assistant, content: 5 }] }), false, 'non-string assistant');
  assert.equal(isTitleEligible({ ...base, messages: [user, { ...assistant, kind: 'interactive_round_recap' }] }), false,
    'a recap row is not a reply');
  assert.equal(isTitleEligible({ ...base, messages: [user, { ...assistant, kind: 'interactive_round_recap' }, assistant] }), true);
});

test('eligibility fails closed when the title does not match the stored user text', (t) => {
  const { store } = fixture(t);
  const base = store.getSession(seedChat(store));
  assert.equal(isTitleEligible({ ...base, title: 'Something else entirely' }), false);
  const user = base.messages.find((m) => m.role === 'user');
  assert.equal(isTitleEligible({ ...base, messages: base.messages.map((m) => (m === user ? { ...m, content: ['x'] } : m)) }), false);
});

// --- the call and the write ------------------------------------------------

test('success: one unscoped preemptible call, written through setSessionMeta, then a list event', async (t) => {
  const { store, service, logs, changed } = fixture(t);
  const id = seedChat(store);
  const before = store.getSession(id).updated_at;
  const metaCalls = [];
  const realMeta = store.setSessionMeta.bind(store);
  store.setSessionMeta = (...args) => { metaCalls.push(args); return realMeta(...args); };
  store.renameSession = () => { throw new Error('renameSession must not be used'); };
  const infer = fakeInference({ title: '  Resumable streams  ' });

  const result = await maybeGenerateSessionTitle(service, id, { requestInference: infer });

  assert.deepEqual(result, { applied: true, reason: 'applied' });
  assert.equal(infer.calls.length, 1);
  const [{ method, params, options }] = infer.calls;
  assert.equal(method, 'session.generate_title');
  assert.deepEqual(params, { accept_version: API_VERSION, user_message: FIRST, assistant_message: REPLY });
  assert.equal(options.preemptible, true);
  assert.equal(typeof options.consumeResult, 'function');
  assert.ok(!Object.hasOwn(options, 'sessionId'), 'unscoped: no session turn lease');
  assert.deepEqual(metaCalls, [[id, { title: 'Resumable streams' }]]);
  const after = store.getSession(id);
  assert.equal(after.title, 'Resumable streams');
  assert.equal(after.updated_at, before, 'the list does not reorder');
  assert.deepEqual(changed, [{ session_ids: [id] }]);
  assert.deepEqual(logs.map((l) => [l.level, l.event]), [['INFO', 'session_title.generated']]);
  assert.equal(logs[0].details.sessionId, id);
});

test('the call clips both messages to 2000 characters and uses the last eligible assistant text', async (t) => {
  const { store, service } = fixture(t);
  const prompt = `Summarise ${'x'.repeat(3000)}`;
  const id = seedChat(store, { prompt, reply: 'early reply' });
  store.appendMessage(id, { role: 'assistant', content: 'y'.repeat(3000) });
  store.appendMessage(id, { role: 'assistant', content: 'recap', kind: 'interactive_round_recap' });
  const infer = fakeInference({ title: 'Summary' });
  assert.equal((await maybeGenerateSessionTitle(service, id, { requestInference: infer })).applied, true);
  const { params } = infer.calls[0];
  assert.equal(params.user_message, prompt.slice(0, 2000));
  assert.equal(params.assistant_message, 'y'.repeat(2000));
});

test('a rename during the call wins and nothing is written', async (t) => {
  const { store, service, logs, changed } = fixture(t);
  const id = seedChat(store);
  const infer = fakeInference({ title: 'Resumable streams' }, { onCall: () => store.renameSession(id, 'Mine') });
  const result = await maybeGenerateSessionTitle(service, id, { requestInference: infer });
  assert.deepEqual(result, { applied: false, reason: 'not_eligible' });
  assert.equal(store.getSession(id).title, 'Mine');
  assert.deepEqual(changed, []);
  assert.equal(logs.length, 0);
});

test('a follow-up message during the call also discards the result', async (t) => {
  const { store, service } = fixture(t);
  const id = seedChat(store);
  const before = store.getSession(id).title;
  const infer = fakeInference({ title: 'Resumable streams' }, { onCall: () => store.appendMessage(id, { role: 'user', content: 'wait' }) });
  assert.equal((await maybeGenerateSessionTitle(service, id, { requestInference: infer })).applied, false);
  assert.equal(store.getSession(id).title, before);
});

test('an empty or missing title writes nothing', async (t) => {
  const { store, service, changed } = fixture(t);
  const id = seedChat(store);
  const before = store.getSession(id).title;
  for (const result of [{ title: '' }, { title: '   ' }, {}, null, { title: 7 }]) {
    const outcome = await maybeGenerateSessionTitle(service, id, { requestInference: fakeInference(result) });
    assert.deepEqual(outcome, { applied: false, reason: 'empty_title' }, JSON.stringify(result));
  }
  assert.equal(store.getSession(id).title, before);
  assert.deepEqual(changed, []);
});

test('a refused store write is reported, not claimed', async (t) => {
  const { store, service, changed } = fixture(t);
  const id = seedChat(store);
  store.setSessionMeta = () => null;
  const outcome = await maybeGenerateSessionTitle(service, id, { requestInference: fakeInference({ title: 'Name' }) });
  assert.deepEqual(outcome, { applied: false, reason: 'write_refused' });
  assert.deepEqual(changed, []);
});

test('a list-event failure does not undo or fail an applied title', async (t) => {
  const { store, service } = fixture(t);
  const id = seedChat(store);
  service.emitSessionsChanged = () => { throw new Error('bridge down'); };
  const outcome = await maybeGenerateSessionTitle(service, id, { requestInference: fakeInference({ title: 'Name' }) });
  assert.deepEqual(outcome, { applied: true, reason: 'applied' });
  assert.equal(store.getSession(id).title, 'Name');
});

// --- failures and logging ----------------------------------------------------

test('a rejected call resolves applied:false, logs WARN, and never logs message or title text', async (t) => {
  const { store, service, logs, changed } = fixture(t);
  const id = seedChat(store);
  const outcome = await maybeGenerateSessionTitle(service, id, { requestInference: rejecting(new Error('sidecar down')) });
  assert.deepEqual(outcome, { applied: false, reason: 'generate_failed' });
  assert.deepEqual(logs.map((l) => [l.level, l.event]), [['WARN', 'session_title.generate_failed']]);
  assert.deepEqual(changed, []);
  const blob = JSON.stringify(logs);
  assert.ok(!blob.includes(FIRST) && !blob.includes(REPLY));
  assert.ok(!blob.includes('Resumable'));
});

test('a success log carries no title or message text', async (t) => {
  const { store, service, logs } = fixture(t);
  const id = seedChat(store);
  await maybeGenerateSessionTitle(service, id, { requestInference: fakeInference({ title: 'Resumable streams' }) });
  const blob = JSON.stringify(logs);
  assert.ok(!blob.includes('Resumable streams') && !blob.includes(FIRST) && !blob.includes(REPLY));
});

test('preemption, a cloud route and other admission failures are INFO skips', async (t) => {
  const { store, service, logs } = fixture(t);
  const id = seedChat(store);
  for (const reason of ['auxiliary_preempted', 'runtime_route_not_local', 'lane_capacity']) {
    logs.length = 0;
    const error = Object.assign(new Error('x'), { reason });
    const outcome = await maybeGenerateSessionTitle(service, id, { requestInference: rejecting(error) });
    assert.deepEqual(outcome, { applied: false, reason });
    assert.deepEqual(logs.map((l) => [l.level, l.event, l.details.reason]), [['INFO', 'session_title.skipped', reason]]);
  }
});

test('never rejects, even when the service is unusable', async () => {
  assert.deepEqual((await maybeGenerateSessionTitle(null, 's1')).applied, false);
  assert.deepEqual((await maybeGenerateSessionTitle({ sidecarClient: {}, sessionStore: { getSession() { throw new Error('x'); } },
    currentModel: 'm', _emitServiceLog() { throw new Error('log'); } }, 's1')).applied, false);
});

// --- the real turn path --------------------------------------------------------

// A turn run through the adapter the app uses, with only the stream itself faked.
async function runTurn(t, { status = 'completed', engine = 'ollama' } = {}) {
  const harness = createAdapterHarness(t);
  const { adapter, lanes, service, sessionId } = harness;
  const requests = [];
  const client = { process: {}, runtimeOperationHandlers: new Map(), async request(method) {
    requests.push({ method, lanes: lanes.snapshot().lanes });
    return { title: 'Resumable streams' };
  } };
  const token = beginRuntimeInferenceInitialization(client);
  completeRuntimeInferenceInitialization(client, token, { runtime_inference_admission_version: 1 });
  Object.assign(service, { sidecarClient: client, currentModel: 'mock-v1',
    sessionRuntime: { lanes, scheduler: { closing: false, beginClosing() {} } } });
  const store = service.sessionStore;
  store.setSessionMeta(sessionId, { title: deriveSessionTitleFromMessage(FIRST) });
  const prepared = await adapter.prepareImmediate(request(sessionId), {}, { workId: 'work-title', turnId: 'turn-title' });
  adapter.register(prepared.workId, prepared);
  const work = { work_id: prepared.workId, turn_id: prepared.turnId, session_id: sessionId,
    project_id: AUTHORITY.project_id, input: prepared.input };
  const claim = adapter.claimCanonical(work, prepared.route);
  service._startManagedSidecarChatStream = async (options) => {
    store.appendMessage(sessionId, { role: 'user', content: FIRST });
    store.appendMessage(sessionId, { role: 'assistant', content: REPLY });
    const controller = new AbortController();
    service.sessionTurnActors.attachController(options.turnLease, controller);
    service.sessionTurnActors.release(options.turnLease, { status });
    controller._runtimeCompletion = Promise.resolve({ status, producerSettled: true, canonicalSettled: true });
    service.activeStreams.set(claim.streamId, controller);
    return { sessionId, streamId: claim.streamId };
  };
  service.currentEngineType = engine;
  const outcome = await adapter.startProducer({ work, route: prepared.route, assertCurrent: () => true });
  service.activeStreams.delete(claim.streamId);
  return { outcome, requests, store, sessionId };
}

test('a completed turn on the real path names the chat, after it gave back its inference slot', async (t) => {
  const { outcome, requests, store, sessionId } = await runTurn(t);
  assert.equal(outcome.status, 'completed');
  await waitFor(() => store.getSession(sessionId).title === 'Resumable streams', 'the chat was never named');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'session.generate_title');
  assert.equal(requests[0].lanes[0].inference_requests, 1, 'only the naming call holds the lane');
});

test('a turn that did not complete never asks for a name', async (t) => {
  const { requests } = await runTurn(t, { status: 'failed' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 0);
});

for (const engine of ['mock', 'replay']) {
  test(`a scripted engine (${engine}) never spends a reply on a name`, async (t) => {
    const { outcome, requests } = await runTurn(t, { engine });
    assert.equal(outcome.status, 'completed');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 0);
  });
}

// --- what the log says ---------------------------------------------------------

test('every way an eligible chat goes unnamed leaves a log line', async (t) => {
  const { store, service, logs } = fixture(t);
  const id = seedChat(store);
  await maybeGenerateSessionTitle(service, id, { requestInference: fakeInference({ title: '' }) });
  await maybeGenerateSessionTitle({ ...service, currentStatus: {}, currentModel: '' }, id, { requestInference: fakeInference({ title: 'x' }) });
  assert.deepEqual(logs.map((entry) => [entry.event, entry.details.reason]), [
    ['session_title.skipped', 'empty_title'],
    ['session_title.skipped', 'model_not_loaded'],
  ]);
});

test('a turn that was never eligible, or a chat with the flag off, logs nothing', async (t) => {
  const { store, service, logs } = fixture(t);
  const secondTurn = seedChat(store, { title: 'Chosen by hand' });
  await maybeGenerateSessionTitle(service, secondTurn, { requestInference: fakeInference({ title: 'x' }) });
  await maybeGenerateSessionTitle({ ...service, currentModel: '', currentStatus: {} }, secondTurn, { requestInference: fakeInference({ title: 'x' }) });
  await maybeGenerateSessionTitle({ ...service, featureFlags: { session_model_titles: false } }, seedChat(store), { requestInference: fakeInference({ title: 'x' }) });
  assert.deepEqual(logs, []);
});

// --- route, timeout and flag -----------------------------------------------------

function routedService(engineType) {
  const calls = [];
  const client = { process: {}, runtimeOperationHandlers: new Map(), async request(method, params) {
    calls.push({ method, params });
    return { title: 'Name' };
  } };
  const token = beginRuntimeInferenceInitialization(client);
  completeRuntimeInferenceInitialization(client, token, { runtime_inference_admission_version: 1 });
  return { calls, currentEngineType: engineType, configService: { getState: () => ({}) }, sidecarClient: client,
    featureFlags: { session_runtime: true }, _emitServiceLog() {},
    sessionRuntime: { lanes: new RuntimeLaneAdmission(), scheduler: { closing: false } } };
}

test('session.generate_title is refused on a non-local route and passes on a local one', async () => {
  const params = { accept_version: API_VERSION, user_message: 'u', assistant_message: 'a' };
  for (const engineType of ['chatgpt', 'codex-cli']) {
    const target = routedService(engineType);
    await assert.rejects(requestRuntimeInference(target, 'session.generate_title', params, { preemptible: true }),
      (error) => error.reason === 'runtime_route_not_local', engineType);
    assert.equal(target.calls.length, 0, 'nothing reaches the sidecar');
    assert.equal(target.sessionRuntime.lanes.snapshot().active_leases, 0);
  }
  const local = routedService('mock');
  const result = await requestRuntimeInference(local, 'session.generate_title', params, { preemptible: true });
  assert.deepEqual(result, { title: 'Name' });
  assert.equal(local.calls[0].method, 'session.generate_title');
});

test('session.generate_title is unscoped and cannot pin an engine', async () => {
  const target = routedService('mock');
  const params = { accept_version: API_VERSION, user_message: 'u', assistant_message: 'a' };
  await assert.rejects(requestRuntimeInference(target, 'session.generate_title', { ...params, session_id: 's1' },
    { sessionId: 's1' }), /runtime_auxiliary_scope_invalid/u);
  await assert.rejects(requestRuntimeInference(target, 'session.generate_title', params, { engineType: 'mock' }),
    /runtime_auxiliary_scope_invalid/u);
});

test('reflection keeps its own route special-casing', async () => {
  const target = routedService('chatgpt');
  await assert.rejects(requestRuntimeInference(target, 'memory.reflect', { session_id: 's1' }, { sessionId: 's1' }),
    (error) => error.reason === 'runtime_route_not_local');
});

test('without a session runtime the local-only method fails closed, since no route check can run', async () => {
  const calls = [];
  const legacy = { featureFlags: {}, sidecarClient: { request: async (...args) => { calls.push(args); return { title: 'Name' }; } } };
  await assert.rejects(requestRuntimeInference(legacy, 'session.generate_title', { accept_version: API_VERSION }, { preemptible: true }),
    (error) => error.reason === 'runtime_unavailable');
  assert.equal(calls.length, 0, 'nothing reaches the sidecar');
});

test('the request timeout row exists', () => {
  assert.equal(REQUEST_TIMEOUT_MS_BY_METHOD['session.generate_title'], 20_000);
});

test('session_model_titles is an internal default-on flag with env rollback', () => {
  assert.equal(buildFeatureFlagDefaults({}).session_model_titles, true);
  assert.equal(buildFeatureFlagDefaults({ JENNY_ENABLE_SESSION_MODEL_TITLES: '0' }).session_model_titles, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('session_model_titles'));
});
