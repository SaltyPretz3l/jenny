'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAdapterHarness, waitFor } = require('../helpers/session-runtime-chat-adapter-harness');
const { initializeSessionRuntimeComposition } = require('../../services/session-runtime/composition');
const { RuntimeApplicationService } = require('../../services/session-runtime/application-service');
const { RootRunBudgetStore } = require('../../services/session-runtime/budgets');
const { captureSessionRuntimeProviderRoute } = require('../../services/backend/session-runtime-provider-route');
const { ensureSessionTurnActorRegistry } = require('../../services/backend/session-turn-actor');
const { retainManagedRuntimeController } = require('../../services/backend/chat-lifecycle-contracts');
const { createJennyShellBridge } = require('../../services/ipc-contract');
const { registerSessionRuntimeIpcHandlers } = require('../../services/main/session-runtime-ipc-registration');

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const h = createAdapterHarness(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-start-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  h.service.options = { userDataPath: root };
  h.service.featureFlags.session_runtime = true;
  h.service.turnEventJournal = { list: () => [] };
  const logs = [];
  h.service._emitServiceLog = (...args) => logs.push(args);
  ensureSessionTurnActorRegistry(h.service);
  let runtime = initializeSessionRuntimeComposition(h.service);
  const starts = [];
  h.service._startManagedSidecarChatStream = async request => {
    const { inference } = request.runtimeOperationGateway;
    const base = { schema_version: 1, api_version: '2026-08-17', kind: 'inference',
      operation_id: `operation_${starts.length}`, request_id: inference.requestId,
      session_id: h.sessionId, authority_revision: inference.authorityRevision };
    const work = runtime.store.listSummaries({ sessionId: h.sessionId }).items.find(item => item.status === 'running');
    const record = runtime.store.get(work.work_id);
    const admitted = inference.handle({ ...base, phase: 'admit', engine_type: 'mock',
      maxima: { inference_requests: 1, input_tokens: 32, output_tokens: 32 } });
    starts.push({ request, admitted, record });
    if (admitted.status === 'granted') {
      const durable = new RootRunBudgetStore(path.join(root, 'session-runtime-budgets')).get(record.input.root_run.root_run_id);
      assert.equal(durable.reservations.at(-1).attempt_id, record.attempt.attempt_id);
      assert.equal(durable.reservations.at(-1).settlement, null);
      assert.equal(inference.handle({ ...base, phase: 'settle', status: 'succeeded', cleanup: 'confirmed',
        consumption: 'unknown', charge_consumption: true }).status, 'settled');
    }
    const lease = request.turnLease;
    const controller = new AbortController();
    h.service.sessionTurnActors.attachController(lease, controller);
    const status = admitted.status === 'granted' ? 'completed' : 'failed';
    controller._runtimeCompletion = Promise.resolve({ status, producerSettled: true, canonicalSettled: true });
    h.service.sessionTurnActors.release(lease, { status });
    return retainManagedRuntimeController({ sessionId: h.sessionId, streamId: lease.identity.streamId }, controller);
  };
  const app = new RuntimeApplicationService({ getRuntime: () => runtime });
  let trusted = true;
  const handlers = new Map();
  registerSessionRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    applicationService: {}, runtimeApplicationService: app,
    authorization: { authorize: () => trusted, unauthorizedResult: () => ({ ok: false, reason: 'untrusted' }) },
  });
  const bridge = createJennyShellBridge({ ipcRenderer: { send() {},
    invoke: (channel, ...args) => handlers.get(channel)({}, ...args) } });
  const payload = (patch = {}) => ({ session_id: h.sessionId, prompt: 'hello', idempotency_key: 'start_1',
    purpose: 'Inspect the project', limits: { inference_requests: 2, input_tokens: 64, output_tokens: 64 }, ...patch });
  const hold = () => runtime.lanes.tryAcquireTurn({ sessionId: 'held_session',
    route: captureSessionRuntimeProviderRoute(h.service) }).lease;
  return { ...h, root, app, bridge, payload, starts, logs, hold, get runtime() { return runtime; },
    setTrusted: value => { trusted = value; },
    restart() {
      runtime.scheduler.beginClosing();
      for (const context of [...runtime.chatAdapter.contexts.values()]) runtime.chatAdapter.discard(context);
      runtime = initializeSessionRuntimeComposition(h.service);
      return runtime;
    } };
}

test('trusted desktop Start durably binds caller limits before acknowledgement and actual adapter admission', async t => {
  const h = fixture(t);
  h.setTrusted(false);
  assert.equal((await h.bridge.sessionRuntime.start(h.payload())).ok, false);
  assert.equal(h.runtime.budgetStore.snapshot().root_record_count, 0);
  h.setTrusted(true);
  const result = await h.bridge.sessionRuntime.start(h.payload());
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(h.starts.length, 0);
  assert.equal(h.service.sessionTurnActors._actors.size, 0);
  const work = h.runtime.store.get(result.work_id);
  assert.equal(work.input.kind, 'root_chat');
  assert.equal(work.purpose, h.payload().purpose);
  assert.equal(work.input.root_run.root_run_id, result.root_run_id);
  assert.deepEqual(h.runtime.budgetStore.get(result.root_run_id).limits, h.payload().limits);
  await waitFor(() => h.runtime.store.get(result.work_id).status === 'completed', () => JSON.stringify(h.logs));
  assert.equal(h.starts[0].admitted.status, 'granted');
  assert.equal(h.starts[0].request.runtimeOperationGateway.inference.budget.requiresMaxima, true);
  assert.deepEqual(h.runtime.budgetStore.get(result.root_run_id).charged,
    { inference_requests: 1, input_tokens: 32, output_tokens: 32 });
});

test('duplicate Start reuses work and root, conflicts on changed limits or purpose, and cannot become Send', async t => {
  const h = fixture(t);
  const held = h.hold();
  const result = await h.app.start(h.payload());
  const duplicate = await h.app.start(h.payload());
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.work_id, result.work_id);
  assert.equal(duplicate.root_run_id, result.root_run_id);
  for (const patch of [{ purpose: 'Changed' }, { limits: { ...h.payload().limits, inference_requests: 3 } }]) {
    assert.equal((await h.app.start(h.payload(patch))).error.reason, 'idempotency_conflict');
  }
  const { purpose: _purpose, limits: _limits, ...send } = h.payload();
  assert.equal((await h.app.submit(send)).error.reason, 'idempotency_conflict');
  assert.equal(h.runtime.budgetStore.snapshot().root_record_count, 1);
  h.runtime.pausePending({ sessionId: h.sessionId });
  h.runtime.lanes.release(held, { producerSettled: true });
  await tick();
  assert.equal(h.starts.length, 0);
});

test('restart and explicit resume reuse the original budget and never dispatch a duplicate Start', async t => {
  const h = fixture(t);
  const held = h.hold();
  const result = await h.app.start(h.payload());
  h.runtime.lanes.release(held, { producerSettled: true });
  h.restart();
  const before = h.runtime.budgetStore.get(result.root_run_id);
  const duplicate = await h.app.start(h.payload());
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.status, 'paused');
  await tick();
  assert.equal(h.starts.length, 0);
  assert.deepEqual(h.runtime.budgetStore.get(result.root_run_id), before);
  assert.equal(h.app.resume({ work_id: result.work_id, expected_revision: duplicate.revision }).ok, true);
  await waitFor(() => h.runtime.store.get(result.work_id).status === 'completed', () => JSON.stringify(h.logs));
  assert.equal(h.runtime.budgetStore.snapshot().root_record_count, 1);
  assert.equal(h.runtime.budgetStore.get(result.root_run_id).charged.inference_requests, 1);
});

test('failed root creation leaves recoverable paused work; only identical explicit Start can finish the root', async t => {
  const h = fixture(t);
  const create = h.runtime.budgetStore.create.bind(h.runtime.budgetStore);
  h.runtime.budgetStore.create = () => { throw new Error('disk offline'); };
  assert.equal((await h.app.start(h.payload())).ok, false);
  const work = h.runtime.store.listSummaries({}).items[0];
  assert.equal(work.status, 'paused');
  assert.equal(h.runtime.chatAdapter.contexts.size, 0);
  assert.equal(h.app.resume({ work_id: work.work_id, expected_revision: work.revision }).ok, false);
  assert.equal(h.runtime.budgetStore.snapshot().root_record_count, 0);
  h.runtime.budgetStore.create = create;
  const retry = await h.app.start(h.payload());
  assert.equal(retry.work_id, work.work_id);
  assert.equal(retry.created, false);
  await tick();
  assert.equal(h.starts.length, 0);
  assert.equal(h.app.resume({ work_id: work.work_id, expected_revision: retry.revision }).ok, true);
  await waitFor(() => h.runtime.store.get(work.work_id).status === 'completed', 'repaired Start did not resume');
});

for (const drift of ['policy', 'missing', 'limits']) test(`resume refuses ${drift} budget authority before canonical claim`, async t => {
  const h = fixture(t);
  const held = h.hold();
  const result = await h.app.start(h.payload());
  h.runtime.pausePending({ sessionId: h.sessionId });
  h.runtime.lanes.release(held, { producerSettled: true });
  const work = h.runtime.store.get(result.work_id);
  if (drift === 'policy') h.service.sessionExecutionAuthority._permissionStore.getSnapshot = () => ({ version: 4, rules: [] });
  else {
    const get = h.runtime.budgetStore.get.bind(h.runtime.budgetStore);
    h.runtime.budgetStore.get = id => {
      if (drift === 'missing') throw new Error('missing');
      return { ...get(id), limits: { ...get(id).limits, inference_requests: 3 } };
    };
  }
  assert.equal(h.app.resume({ work_id: work.work_id, expected_revision: work.revision }).ok, false);
  await tick();
  assert.equal(h.starts.length, 0);
  assert.equal(h.runtime.chatAdapter.contexts.size, 0);
  assert.equal(h.service.sessionTurnActors._actors.size, 0);
});

test('Start requires closed finite positive limits and rejects caller authority', async t => {
  const h = fixture(t);
  for (const patch of [{ limits: null }, { limits: {} }, { limits: { ...h.payload().limits, input_tokens: 0 } },
    { limits: { ...h.payload().limits, inference_requests: Infinity } }, { purpose: '' },
    { root_run_id: 'forged' }, { allowed_provider_ids: ['cloud'] }, { authority_fingerprint: 'a'.repeat(64) },
    { limits: { ...h.payload().limits, dollars: 5 } }]) {
    assert.equal((await h.app.start(h.payload(patch))).error.reason, 'runtime_start_request_invalid');
  }
  assert.equal(h.runtime.budgetStore.snapshot().root_record_count, 0);
  assert.equal(h.runtime.store.getStatus().pending.host_count, 0);
});

for (const failingRead of [1, 2, 3]) test(`post-claim budget read failure ${failingRead} releases unused canonical and runtime capacity`, async t => {
  const h = fixture(t);
  const adapter = h.runtime.chatAdapter;
  const start = adapter.startProducer.bind(adapter);
  const get = h.runtime.budgetStore.get.bind(h.runtime.budgetStore);
  let binding;
  adapter.startProducer = context => {
    binding = adapter.contexts.get(context.work.work_id).binding;
    let reads = 0;
    h.runtime.budgetStore.get = id => {
      if (++reads === failingRead) throw new Error('budget disk failure after claim');
      return get(id);
    };
    return start(context);
  };
  const result = await h.app.start(h.payload());
  assert.equal(result.ok, true);
  await waitFor(() => h.runtime.store.get(result.work_id).status === 'failed', () => JSON.stringify(h.logs));
  assert.equal(h.starts.length, 0);
  assert.equal(adapter.contexts.size, 0);
  assert.equal(h.service.sessionTurnActors.hasActiveLifecycle(h.sessionId), false);
  assert.equal(h.service.sessionTurnActors.pendingUnattachedLeaseSettlementBarriers().length, 0);
  assert.equal(h.service.sessionStore.getActiveTurn(h.sessionId), null);
  assert.equal(h.runtime.lanes.snapshot().active_leases, 0);
  assert.throws(() => h.service.sessionExecutionAuthority.toExecutionContext(binding));
});


test('Start captures orchestration limits once; settings changes cannot expand a duplicate root', async t => {
  const h = fixture(t);
  const held = h.hold();
  const initial = await h.bridge.sessionRuntime.start(h.payload());
  const root = h.runtime.store.get(initial.work_id).input.root_run;
  assert.equal(root.schema_version, 2);
  assert.deepEqual(root.orchestration_limits, { descendants: 8, descendant_depth: 2 });
  h.runtime.lanes.setLimits({ local: { descendants: 32, descendant_depth: 5 } });
  const repeated = await h.bridge.sessionRuntime.start(h.payload());
  assert.equal(repeated.created, false);
  assert.deepEqual(h.runtime.store.get(initial.work_id).input.root_run, root);
  assert.equal(h.runtime.lineageStore.snapshot().root_record_count, 0,
    'capturing a grant does not create child lineage or block a child-free session deletion');
  h.runtime.lanes.release(held, { producerSettled: true });
  await waitFor(() => h.runtime.store.get(initial.work_id).status === 'completed');
});

test('existing v1 Start retries retain their original input and never gain a child grant', async t => {
  const h = fixture(t);
  h.hold();
  const originalSubmit = h.runtime.store.submit.bind(h.runtime.store);
  h.runtime.store.submit = options => {
    const legacy = structuredClone(options);
    legacy.input.root_run.schema_version = 1;
    delete legacy.input.root_run.orchestration_limits;
    return originalSubmit(legacy);
  };
  const first = await h.bridge.sessionRuntime.start(h.payload());
  assert.equal(first.ok, true);
  const prior = h.runtime.store.get(first.work_id).input;
  h.restart();
  const repeated = await h.bridge.sessionRuntime.start(h.payload());
  assert.equal(repeated.ok, true);
  assert.equal(repeated.created, false);
  assert.deepEqual(h.runtime.store.get(first.work_id).input, prior);
  assert.equal(prior.root_run.schema_version, 1);
  assert.equal(Object.hasOwn(prior.root_run, 'orchestration_limits'), false);
  assert.equal(h.starts.length, 0);
});

test('pending root edits preserve the original grant and root budget without creating a new run', async t => {
  const h = fixture(t);
  const lease = h.hold();
  const started = await h.app.start(h.payload());
  const before = h.runtime.store.get(started.work_id);
  const budgets = h.runtime.budgetStore.exportPortableSnapshot();
  const updated = await h.app.updatePending({ work_id: started.work_id, expected_revision: before.revision, prompt: 'Edited purpose input' });
  assert.equal(updated.ok, true, JSON.stringify(updated));
  assert.deepEqual(h.runtime.store.get(started.work_id).input.root_run, before.input.root_run);
  assert.deepEqual(h.runtime.budgetStore.exportPortableSnapshot(), budgets);
  h.runtime.lanes.release(lease, { producerSettled: true });
  await waitFor(() => h.runtime.store.get(started.work_id).status === 'completed', 'edited root failed to execute');
  assert.equal(h.starts.length, 1);
});
