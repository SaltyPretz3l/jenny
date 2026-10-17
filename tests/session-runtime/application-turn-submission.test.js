'use strict';

/* SessionRuntimeService.submitApplicationTurn (row 59 checkpoint 3): the internal
 * durable admission entry for a turn the application authored. It is `submit`
 * (prepareSubmission -> store.submit -> scheduler), never `startImmediate`; it
 * answers a refusal as data and a replay as the existing work. */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAdapterHarness, waitFor } = require('../helpers/session-runtime-chat-adapter-harness');
const { SessionRuntimeScheduler } = require('../../services/session-runtime/scheduler');
const { SessionRuntimeService } = require('../../services/session-runtime/service');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { captureSessionRuntimeProviderRoute } = require('../../services/backend/session-runtime-provider-route');
const { retainManagedRuntimeController } = require('../../services/backend/chat-lifecycle-contracts');

const DECISION = {
  proposal_id: `proposal_${'a'.repeat(64)}`,
  decision_id: '11111111-1111-4111-8111-111111111111',
  accepted_revision: 2,
  choice: 'commit',
};

function harness(t) {
  const h = createAdapterHarness(t);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-runtime-app-turn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const starts = [];
  let immediateStarts = 0;
  h.service._startManagedSidecarChatStream = async request => {
    const lease = request.turnLease;
    starts.push(request);
    const controller = new AbortController();
    h.service.sessionTurnActors.attachController(lease, controller);
    controller._runtimeCompletion = Promise.resolve({ status: 'completed', producerSettled: true, canonicalSettled: true });
    const result = retainManagedRuntimeController({ sessionId: h.sessionId, streamId: lease.identity.streamId }, controller);
    h.service.sessionTurnActors.release(lease, { status: 'completed' });
    return result;
  };
  const store = new RuntimeStore(root);
  const a = h.adapter;
  const scheduler = new SessionRuntimeScheduler({ store, lanes: h.lanes,
    resolveRoute: work => a.resolveRoute(work), validateWork: (work, route) => a.validateWork(work, route),
    prepareCanonical: (work, route) => a.prepareCanonical(work, route),
    claimCanonical: (work, route) => a.claimCanonical(work, route),
    startProducer: context => a.startProducer(context), discardPending: work => a.discardPending(work) });
  h.lanes.onChange = () => scheduler.notifyLaneAvailability();
  const runtime = new SessionRuntimeService({ store, scheduler, chatAdapter: a });
  const startImmediate = runtime.startImmediate.bind(runtime);
  runtime.startImmediate = (...args) => { immediateStarts += 1; return startImmediate(...args); };
  h.service.sessionRuntime = runtime;
  const request = (overrides = {}) => ({ sessionId: h.sessionId, prompt: 'Commit these files',
    visiblePrompt: 'Commit the proposed changes', preferredModel: 'fixture-model', planMode: false,
    proposalDecision: DECISION, ...overrides });
  return { ...h, store, scheduler, runtime, starts, request, immediateStarts: () => immediateStarts };
}

test('admits a durable pending turn that carries the proposal decision in its work input only', async t => {
  const h = harness(t);
  const result = await h.runtime.submitApplicationTurn(h.request(), { idempotencyKey: 'pdk_one' });
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.session_id, h.sessionId);
  const work = h.store.get(result.work_id);
  assert.deepEqual(work.input.request.proposalDecision, DECISION);
  assert.equal(work.input.request.visiblePrompt, 'Commit the proposed changes');
  await waitFor(() => h.store.get(result.work_id).status === 'completed', 'application turn never ran');
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].turnLease.identity.turnId, result.turn_id);
  assert.equal(h.immediateStarts(), 0, 'never the non-durable start');
});

test('a replayed key returns the existing work without preparing or dispatching again', async t => {
  const h = harness(t);
  const lease = h.lanes.tryAcquireTurn({ sessionId: 'lane_holder', route: captureSessionRuntimeProviderRoute(h.service) }).lease;
  const first = await h.runtime.submitApplicationTurn(h.request(), { idempotencyKey: 'pdk_two' });
  const contexts = h.adapter.contexts.size;
  const again = await h.runtime.submitApplicationTurn(h.request({ prompt: 'a route-changing retry' }), { idempotencyKey: 'pdk_two' });
  assert.equal(again.ok, true);
  assert.equal(again.created, false);
  assert.equal(again.work_id, first.work_id);
  assert.equal(h.adapter.contexts.size, contexts);
  assert.equal(h.runtime.findApplicationSubmission('pdk_two').work_id, first.work_id);
  const view = h.runtime.getApplicationWork(first.work_id);
  assert.equal(view.status, 'pending');
  assert.equal(Object.hasOwn(view, 'input'), false, 'the prompt never leaves the store');
  h.lanes.release(lease, { producerSettled: true });
  await waitFor(() => h.store.get(first.work_id).status === 'completed', 'lane release did not dispatch');
});

test('a replayed key for another session is a conflict, not another session work', async t => {
  const h = harness(t);
  await h.runtime.submitApplicationTurn(h.request(), { idempotencyKey: 'pdk_three' });
  const other = await h.runtime.submitApplicationTurn(h.request({ sessionId: 'sess_other' }), { idempotencyKey: 'pdk_three' });
  assert.deepEqual([other.ok, other.reason, other.acceptance], [false, 'idempotency_conflict', 'unknown']);
});

test('disabled and closing runtimes refuse as data, create no work and never fall back', async t => {
  const h = harness(t);
  h.scheduler.setEnabled(false);
  const disabled = await h.runtime.submitApplicationTurn(h.request(), { idempotencyKey: 'pdk_off' });
  assert.deepEqual([disabled.ok, disabled.reason, disabled.acceptance], [false, 'runtime_disabled', 'rejected']);
  h.scheduler.setEnabled(true);
  h.scheduler.beginClosing();
  const closing = await h.runtime.submitApplicationTurn(h.request(), { idempotencyKey: 'pdk_closing' });
  assert.deepEqual([closing.ok, closing.reason], [false, 'runtime_closing']);
  assert.equal(h.store.findSubmission('pdk_off'), null);
  assert.equal(h.store.findSubmission('pdk_closing'), null);
  assert.equal(h.immediateStarts(), 0);
  assert.equal(h.starts.length, 0);
});

test('malformed requests and keys are rejected without touching the store', async t => {
  const h = harness(t);
  const cases = [
    [h.request(), 'bad key with spaces'],
    [{ ...h.request(), prompt: '   ' }, 'pdk_a'],
    [{ ...h.request(), sessionId: '' }, 'pdk_b'],
    [null, 'pdk_c'],
    [h.request({ interactiveResponse: {} }), 'pdk_d'],
  ];
  for (const [request, key] of cases) {
    const result = await h.runtime.submitApplicationTurn(request, { idempotencyKey: key });
    assert.equal(result.ok, false, key);
    assert.equal(result.acceptance, 'rejected', key);
  }
  assert.equal(h.store.getStatus().pending.host_count, 0);
  assert.equal(h.runtime.findApplicationSubmission('nope'), null);
  assert.equal(h.runtime.getApplicationWork('not a work id'), null);
});

test('a linked child waiting for its first turn refuses other submissions before preparing; its first turn is admitted', async t => {
  const h = harness(t);
  h.service.chatProposals = { linkedFirstTurnBlock: (_sessionId, key) => (key === 'pdk_first' ? null : 'linked_first_turn_pending') };
  const refused = await h.runtime.submitApplicationTurn(h.request(), { idempotencyKey: 'pdk_other' });
  assert.deepEqual([refused.ok, refused.reason, refused.acceptance], [false, 'linked_first_turn_pending', 'rejected']);
  assert.equal(h.store.findSubmission('pdk_other'), null, 'nothing was stored');
  const first = await h.runtime.submitApplicationTurn(h.request(), { idempotencyKey: 'pdk_first' });
  assert.equal(first.ok, true);
  await waitFor(() => h.store.get(first.work_id).status === 'completed', 'the first turn never ran');
});
