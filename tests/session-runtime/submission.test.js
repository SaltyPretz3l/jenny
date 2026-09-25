'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAdapterHarness, waitFor } = require('../helpers/session-runtime-chat-adapter-harness');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
const { SessionRuntimeService } = require('../../services/session-runtime/service');
const { RuntimeApplicationService } = require('../../services/session-runtime/application-service');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { updatePendingInput } = require('../../services/session-runtime/pending-input');
const { captureSessionRuntimeProviderRoute } = require('../../services/backend/session-runtime-provider-route');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { retainManagedRuntimeController } = require('../../services/backend/chat-lifecycle-contracts');

const tick = () => new Promise(resolve => setImmediate(resolve));

function harness(t) {
  const h = createAdapterHarness(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-submit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starts = [];
  h.service._startManagedSidecarChatStream = async request => {
    const lease = request.turnLease;
    starts.push(request);
    const controller = new AbortController();
    h.service.sessionTurnActors.attachController(lease, controller);
    controller._runtimeCompletion = Promise.resolve({ status: 'completed',
      producerSettled: true, canonicalSettled: true });
    const result = retainManagedRuntimeController({ sessionId: h.sessionId,
      streamId: lease.identity.streamId }, controller);
    h.service.sessionTurnActors.release(lease, { status: 'completed' });
    return result;
  };
  function compose(store) {
    const a = h.adapter;
    const scheduler = new SessionRuntimeScheduler({ store, lanes: h.lanes,
      resolveRoute: work => a.resolveRoute(work), validateWork: (work, route) => a.validateWork(work, route),
      prepareCanonical: (work, route) => a.prepareCanonical(work, route),
      claimCanonical: (work, route) => a.claimCanonical(work, route),
      startProducer: context => a.startProducer(context), discardPending: work => a.discardPending(work) });
    h.lanes.onChange = () => scheduler.notifyLaneAvailability();
    const runtime = new SessionRuntimeService({ store, scheduler, chatAdapter: a });
    h.service.sessionRuntime = runtime;
    return { store, scheduler, runtime };
  }
  const owners = compose(new RuntimeStore(root));
  const application = new RuntimeApplicationService({ getRuntime: () => h.service.sessionRuntime });
  function payload(key = 'send_1', overrides = {}) {
    return { session_id: h.sessionId, idempotency_key: key, prompt: 'hello',
      preferred_model: 'fixture-model', ...overrides };
  }
  function hold() {
    const result = h.lanes.tryAcquireTurn({ sessionId: 'lane_holder',
      route: captureSessionRuntimeProviderRoute(h.service) });
    assert.equal(result.status, 'granted');
    return result.lease;
  }
  return { ...h, ...owners, application, starts, payload, hold,
    restart() {
      owners.scheduler.beginClosing();
      for (const context of [...h.adapter.contexts.values()]) h.adapter.discard(context);
      return compose(new RuntimeStore(root));
    } };
}

test('durable Send returns identity before an actor, stream, or producer starts', async t => {
  const h = harness(t);
  const result = await h.application.submit(h.payload());
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.revision, 1);
  assert.equal(result.status, 'pending');
  assert.equal(Object.hasOwn(result, 'stream_id'), false);
  assert.equal(h.store.get(result.work_id).turn_id, result.turn_id);
  assert.equal(h.starts.length, 0);
  assert.equal(h.service.sessionTurnActors, undefined);
  await waitFor(() => h.store.get(result.work_id).status === 'completed', 'send never completed');
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].turnLease.identity.turnId, result.turn_id);
  assert.equal(h.adapter.contexts.size, 0);
});

test('submission distinguishes refusal before persistence from uncertain durable writes', async t => {
  const h = harness(t);
  h.scheduler.setEnabled(false);
  const refused = await h.application.submit(h.payload());
  assert.equal(refused.ok, false);
  assert.equal(refused.acceptance, 'rejected');
  h.scheduler.setEnabled(true);
  h.hold();
  const io = h.store.io;
  h.store.io = { ...io, writeJsonAtomic(file, value) {
    io.writeJsonAtomic(file, value);
    if (file === h.store.journalPath) throw new Error('lost durable acknowledgement');
  } };
  const uncertain = await h.application.submit(h.payload());
  assert.equal(uncertain.ok, false);
  assert.equal(uncertain.acceptance, 'unknown');
  const recovered = new RuntimeStore(h.store.root);
  assert.equal(recovered.findSubmission('send_1').status, 'paused');
});

test('queued Send allocates no actor or transcript while a lane is occupied', async t => {
  const h = harness(t);
  const lease = h.hold();
  const original = h.service.sessionStore.getSession;
  h.service.sessionStore.getSession = () => { throw new Error('pending transcript hydration'); };
  const result = await h.application.submit(h.payload());
  assert.equal(result.ok, true);
  await tick();
  assert.equal(h.store.get(result.work_id).status, 'pending');
  assert.equal(h.service.sessionTurnActors, undefined);
  assert.equal(h.starts.length, 0);
  h.service.sessionStore.getSession = original;
  h.lanes.release(lease, { producerSettled: true });
  await waitFor(() => h.store.get(result.work_id).status === 'completed', 'lane release did not dispatch');
});

test('duplicate Send never dispatches or resumes and changed input conflicts', async t => {
  const h = harness(t);
  const lease = h.hold();
  const result = await h.application.submit(h.payload());
  const duplicate = await h.application.submit(h.payload());
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.work_id, result.work_id);
  assert.equal(h.adapter.contexts.size, 1);
  assert.equal((await h.application.submit(h.payload('send_1', { prompt: 'changed' }))).error.reason,
    'idempotency_conflict');
  h.runtime.pausePending({ sessionId: h.sessionId });
  const pausedDuplicate = await h.application.submit(h.payload());
  assert.equal(pausedDuplicate.created, false);
  assert.equal(pausedDuplicate.status, 'paused');
  assert.equal(h.adapter.contexts.size, 0);
  h.lanes.release(lease, { producerSettled: true });
  await tick();
  assert.equal(h.starts.length, 0);
  assert.equal(h.store.get(result.work_id).status, 'paused');
});

test('never-attempted paused work resumes explicitly without checkpoint hydration', async t => {
  const h = harness(t);
  const lease = h.hold();
  const result = await h.application.submit(h.payload());
  h.runtime.pausePending({ sessionId: h.sessionId });
  const paused = h.store.get(result.work_id);
  assert.equal(paused.attempt, null);
  assert.equal(paused.checkpoint_ref, null);
  h.adapter.checkpointStore = { read() { throw new Error('no checkpoint exists'); } };
  assert.equal(h.application.resume({ work_id: result.work_id, expected_revision: paused.revision }).ok, true);
  h.lanes.release(lease, { producerSettled: true });
  await waitFor(() => h.store.get(result.work_id).status === 'completed', 'explicit new turn resume failed');
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].runtimeContinuation, undefined);
});

test('restart leaves queued work paused until explicit resume, including a duplicate Send', async t => {
  const h = harness(t);
  const lease = h.hold();
  const result = await h.application.submit(h.payload());
  const restarted = h.restart();
  const duplicate = await h.application.submit(h.payload());
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.status, 'paused');
  h.lanes.release(lease, { producerSettled: true });
  await tick();
  assert.equal(h.starts.length, 0);
  const paused = restarted.store.get(result.work_id);
  assert.equal(h.application.resume({ work_id: result.work_id, expected_revision: paused.revision }).ok, true);
  await waitFor(() => restarted.store.get(result.work_id).status === 'completed', 'restart resume failed');
});

test('closed submission schema rejects continuation and internal authority fields', async t => {
  const h = harness(t);
  for (const extra of [{ edited_message_id: 'x' }, { interactive_response: {} },
    { failure_retry: true }, { root_path: 'private' }, { runtimePreferredEngineType: 'cloud' },
    { work_id: 'forged' }, { prompt: '' }, { plan_mode: 'false' }]) {
    const result = await h.application.submit(h.payload('invalid', extra));
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, 'runtime_submission_request_invalid');
  }
  assert.equal(h.store.getStatus().pending.host_count, 0);
  assert.equal(h.service.sessionTurnActors, undefined);
});

test('shared plugin and interactive validation remains ahead of durable insertion', async t => {
  const h = harness(t);
  assert.equal((await h.application.submit(h.payload('bad_plugin',
    { plugin_command_invocation: { arbitrary: true } }))).ok, false);
  await assert.rejects(h.runtime.submit({ sessionId: h.sessionId, prompt: 'hello',
    interactiveResponse: {} }, { idempotencyKey: 'bad_interactive' }), /runtime_new_send_required/);
  assert.equal(h.store.getStatus().pending.host_count, 0);
});

test('pause, OFF/ON, shutdown, deletion, root and provider changes fence async submission', async t => {
  for (const action of ['pause', 'off', 'shutdown', 'deletion', 'root', 'provider']) {
    const h = harness(t);
    let finish;
    h.service.offlineIntelligenceService = { getState: () => new Promise(resolve => { finish = resolve; }) };
    const captureRoute = captureSessionRuntimeProviderRoute(h.service);
    const promise = h.application.submit(h.payload());
    assert.equal(typeof finish, 'function');
    if (action === 'pause') h.runtime.pausePending({ sessionId: h.sessionId });
    if (action === 'off') { h.runtime.setEnabled(false); h.runtime.setEnabled(true); }
    if (action === 'shutdown') h.runtime.beginShutdown();
    if (action === 'deletion') ensureSessionTurnActorRegistry(h.service)
      .beginDeletion(h.sessionId);
    if (action === 'root') h.service.projectAuthority.requireCurrent = () => { throw new Error('root changed'); };
    if (action === 'provider') h.service.sessionRuntimeProviderRouteRegistry = { resolve: () => ({
      route: { ...captureRoute, configuration_revision: 'changed' },
      credential: { required: false, available: true, revision: 'none' },
    }) };
    finish({ mode: 'normal' });
    assert.equal((await promise).ok, false, action);
    await tick();
    assert.equal(h.store.getStatus().pending.host_count, 0, action);
    assert.equal(h.adapter.contexts.size, 0, action);
    assert.equal(h.runtime.pendingSubmissions.size, 0, action);
    assert.equal(h.starts.length, 0, action);
  }
});

test('submission queues behind an ordinary actor but rejects a deletion without allocating another actor', async t => {
  const h = harness(t);
  const actors = ensureSessionTurnActorRegistry(h.service);
  const lease = actors.reserveStart({ sessionId: h.sessionId, store: h.service.sessionStore,
    activeStreams: h.service.activeStreams, prompt: 'first', path: 'managed' });
  const result = await h.application.submit(h.payload());
  assert.equal(result.ok, true);
  await tick();
  assert.equal(h.store.get(result.work_id).status, 'pending');
  assert.equal(actors.size, 1);
  actors.release(lease, { status: 'completed' });
  // Ordinary production turns release a runtime lane; exercise that wake edge.
  const external = h.hold();
  h.lanes.release(external, { producerSettled: true });
  await waitFor(() => h.store.get(result.work_id).status === 'completed', 'actor release wake failed');
});


test('force-local submission does not require credentials for the unused selected provider', async t => {
  const h = harness(t);
  h.service.currentEngineType = 'chatgpt';
  h.service.offlineIntelligenceService = { getState: async () => ({ mode: 'local_only',
    preferredLocalModel: 'local-fixture', selectedLocalEngineType: 'ollama',
    localCatalog: { available: true }, localChatReady: true, localVisionReady: true }) };
  const result = await h.application.submit(h.payload());
  assert.equal(result.ok, true);
  assert.equal(h.store.get(result.work_id).input.route.engine_type, 'ollama');
  await waitFor(() => h.store.get(result.work_id).status === 'completed', 'forced local send failed');
  assert.equal(h.starts[0].runtimePreferredEngineType, 'ollama');
});

test('failed admission releases pending context so explicit resume can retry after repair', async t => {
  const h = harness(t);
  const lease = h.hold();
  const result = await h.application.submit(h.payload());
  const requireCurrent = h.service.projectAuthority.requireCurrent;
  h.service.projectAuthority.requireCurrent = () => { throw new Error('authority stale'); };
  h.lanes.release(lease, { producerSettled: true });
  await waitFor(() => h.store.get(result.work_id).status === 'paused', 'stale work was not paused');
  assert.equal(h.adapter.contexts.size, 0);
  assert.equal(h.starts.length, 0);
  h.service.projectAuthority.requireCurrent = requireCurrent;
  const paused = h.store.get(result.work_id);
  assert.equal(h.application.resume({ work_id: result.work_id, expected_revision: paused.revision }).ok, true);
  await waitFor(() => h.store.get(result.work_id).status === 'completed', 'repaired work could not resume');
});


test('a competing lane wake cannot start a new producer before submission acknowledgement', async t => {
  const h = harness(t);
  const submit = h.store.submit.bind(h.store);
  h.store.submit = (...args) => {
    const result = submit(...args);
    queueMicrotask(() => h.scheduler.pump());
    return result;
  };
  const result = await h.application.submit(h.payload());
  assert.equal(result.ok, true);
  assert.equal(h.starts.length, 0, 'competing wake started a producer before acknowledgement');
  await waitFor(() => h.store.get(result.work_id).status === 'completed', 'acknowledged work did not start');
});


test('trusted desktop Send and resume reach the real durable runtime', async t => {
  const { createJennyShellBridge } = require('../../services/ipc-contract');
  const { registerSessionRuntimeIpcHandlers } = require('../../services/main/session-runtime-ipc-registration');
  const h = harness(t);
  const handlers = new Map();
  registerSessionRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    applicationService: {}, runtimeApplicationService: h.application,
    authorization: { authorize: event => event.trusted,
      unauthorizedResult: () => ({ ok: false, reason: 'ipc_sender_unauthorized' }) },
  });
  let trusted = false;
  const bridge = createJennyShellBridge({ ipcRenderer: {
    invoke: (channel, ...args) => handlers.get(channel)({ trusted }, ...args), send() {},
  } });
  assert.equal((await bridge.sessionRuntime.submit(h.payload())).ok, false);
  assert.equal(h.store.listSummaries().items.length, 0);
  trusted = true;
  const lease = h.hold();
  const submitted = await bridge.sessionRuntime.submit(h.payload());
  assert.equal(submitted.ok, true);
  assert.equal(h.store.get(submitted.work_id).revision, submitted.revision);
  assert.equal(h.starts.length, 0);
  assert.equal((await bridge.sessionRuntime.pause({
    work_id: submitted.work_id, expected_revision: submitted.revision,
  })).status, 'paused');
  const paused = h.store.get(submitted.work_id);
  const resumed = await bridge.sessionRuntime.resume({
    work_id: paused.work_id, expected_revision: paused.revision,
  });
  assert.equal(resumed.ok, true);
  h.lanes.release(lease, { producerSettled: true });
  await waitFor(() => h.store.get(paused.work_id).status === 'completed', 'bridge resume did not dispatch');
  assert.equal(h.starts.length, 1);
});

test('pending prompt edits use CAS, preserve authority and execute only the winning text', async t => {
  const h = harness(t);
  const lease = h.hold();
  const sent = await h.application.submit(h.payload());
  const original = h.store.get(sent.work_id);
  const results = await Promise.all(['first edit', 'second edit'].map(prompt => h.application.updatePending({
    work_id: sent.work_id, expected_revision: sent.revision, prompt })));
  assert.equal(results.filter(row => row.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter(row => !row.ok)[0].error.reason, 'revision_conflict');
  const work = h.store.get(sent.work_id);
  assert.equal(work.revision, 2);
  assert.equal(h.adapter.contexts.get(work.work_id).request.prompt, work.input.request.prompt);
  assert.deepEqual(work.authority, original.authority);
  assert.deepEqual(work.input.route, original.input.route);
  assert.equal(h.starts.length, 0);
  assert.equal((await h.application.submit(h.payload())).error.reason, 'idempotency_conflict');
  h.lanes.release(lease, { producerSettled: true });
  await waitFor(() => h.store.get(work.work_id).status === 'completed', 'edited Send never completed');
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].prompt, work.input.request.prompt);
  assert.equal((await h.application.updatePending({ work_id: work.work_id,
    expected_revision: h.store.get(work.work_id).revision, prompt: 'late' })).ok, false);
});

test('pending prompt edits reject an invalid store clock before persistence', async t => {
  const h = harness(t);
  h.hold();
  const sent = await h.application.submit(h.payload());
  const before = h.store.get(sent.work_id);
  h.store.now = () => Number.NaN;
  assert.throws(() => updatePendingInput(h.store, sent.work_id, {
    expectedRevision: sent.revision,
    prompt: 'edited after invalid clock',
  }), error => error?.code === 'invalid_clock');
  assert.deepEqual(h.store.get(sent.work_id), before);
});

test('editing paused unattempted work never resumes or allocates an actor', async t => {
  const h = harness(t);
  const lease = h.hold();
  const sent = await h.application.submit(h.payload());
  h.runtime.pausePending({ sessionId: h.sessionId });
  const paused = h.store.get(sent.work_id);
  const edited = await h.application.updatePending({ work_id: sent.work_id, expected_revision: paused.revision, prompt: 'paused edit' });
  assert.equal(edited.ok, true, JSON.stringify(edited));
  assert.equal(edited.status, 'paused');
  assert.equal(h.adapter.contexts.size, 0);
  h.lanes.release(lease, { producerSettled: true });
  await tick();
  assert.equal(h.starts.length, 0);
  assert.equal(h.service.sessionTurnActors, undefined);
});

for (const boundary of ['journal', 'record', 'index', 'repair_journal']) test(`pending edit recovers interruption after ${boundary} without changing authority`, async t => {
  const h = harness(t);
  h.hold();
  const sent = await h.application.submit(h.payload());
  const original = h.store.get(sent.work_id);
  const io = h.store.io;
  h.store.io = { ...io, writeJsonAtomic(file, value) {
    io.writeJsonAtomic(file, value);
    const target = boundary === 'record' ? h.store._workPath(sent.work_id)
      : boundary === 'index' ? h.store.indexPath : h.store.journalPath;
    if (file === target) throw new Error('injected');
  } };
  assert.equal((await h.application.updatePending({ work_id: sent.work_id, expected_revision: sent.revision,
    prompt: 'durable edit' })).ok, false);
  if (boundary === 'repair_journal') {
    const recovery = new RuntimeStore(h.store.root, { io: { ...io, writeJsonAtomic(file, value) {
      io.writeJsonAtomic(file, value);
      if (file === h.store.journalPath && value.record?.recovery?.kind === 'transition_repaired') throw new Error('repair interrupted');
    } } });
    assert.equal(recovery.getStatus().read_only, true);
  }
  const recovered = h.restart();
  assert.equal(recovered.store.getStatus().read_only, false, recovered.store.getStatus().reason);
  const work = recovered.store.get(sent.work_id);
  assert.equal(work.input.request.prompt, 'durable edit');
  assert.equal(work.status, 'paused');
  assert.deepEqual(work.authority, original.authority);
  assert.equal(h.starts.length, 0);
});
