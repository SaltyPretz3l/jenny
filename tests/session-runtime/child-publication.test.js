'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { waitFor } = require('../helpers/session-runtime-chat-adapter-harness');
const { initializeSessionRuntimeComposition } = require('../../services/session-runtime/composition');
const { RuntimeApplicationService } = require('../../services/session-runtime/application-service');
const { fixture } = require('../helpers/session-runtime-children-fixture');

const tick = () => new Promise(resolve => setImmediate(resolve));

function admit(entry, operationId) {
  const inference = entry.request.runtimeOperationGateway.inference;
  const base = { schema_version: 1, api_version: '2026-08-17', kind: 'inference', operation_id: operationId,
    request_id: inference.requestId, session_id: entry.request.sessionId, authority_revision: inference.authorityRevision };
  const result = inference.handle({ ...base, phase: 'admit', engine_type: 'mock',
    maxima: { inference_requests: 1, input_tokens: 32, output_tokens: 32 } });
  if (result.status === 'granted') inference.handle({ ...base, phase: 'settle', status: 'succeeded',
    cleanup: 'confirmed', consumption: 'unknown', charge_consumption: true });
  return result;
}

test('real parent gateway publishes one durable read-only child, queues without an actor, and shares the root budget', async t => {
  const h = await fixture(t);
  assert.equal(admit(h.starts[0], 'parent_inference').status, 'granted');
  const [first, duplicate] = await Promise.all([h.spawn(), h.spawn()]);
  assert.deepEqual(duplicate, first);
  assert.deepEqual(await h.spawn(), first);
  await assert.rejects(h.spawn('Changed task'), /lineage_spawn_conflict/);
  const child = h.runtime.store.get(first.child_work_id);
  assert.equal(child.status, 'pending');
  assert.equal(child.input.kind, 'child_chat');
  assert.equal(child.input.request.runtimeChildReadOnly, true);
  assert.equal(child.project_id, h.runtime.store.get(h.started.work_id).project_id);
  assert.equal(h.runtime.lineageStore.get(h.started.root_run_id).children.length, 1);
  assert.equal(h.service.sessionStore.getSession(first.session_id).messages.length, 0);
  assert.equal(h.service.sessionTurnActors._actors.has(first.session_id), false);
  await tick();
  assert.equal(h.starts.length, 1);
  h.starts[0].complete();
  await waitFor(() => h.starts.length === 2, () => JSON.stringify(h.logs));
  assert.equal(admit(h.starts[1], 'child_inference').status, 'granted');
  const budget = h.runtime.budgetStore.get(h.started.root_run_id);
  assert.equal(h.runtime.budgetStore.snapshot().root_record_count, 1);
  assert.equal(budget.charged.inference_requests, 2);
  assert.equal(budget.reservations.at(-1).work_id, first.child_work_id);
  h.starts[1].complete();
  await waitFor(() => h.runtime.store.get(first.child_work_id).status === 'completed', 'child completion');
});

test('captured descendant limit and later lower limit fence new children', async t => {
  const h = await fixture(t);
  h.runtime.lanes.limits.local.descendants = 1;
  await h.spawn();
  await assert.rejects(h.spawn('Second task', 'spawn_2'), /lineage_descendant_capacity/);
  h.runtime.lanes.limits.local.descendants = 512;
  for (let i = 1; i < 8; i++) await h.spawn(`Task ${i}`, `spawn_${i + 1}`);
  await assert.rejects(h.spawn('Too many', 'spawn_9'), /lineage_descendant_capacity/);
});

test('closing a parent capability during preparation retains evidence without publishing executable child work', async t => {
  const h = await fixture(t);
  const prepare = h.runtime.chatAdapter.prepareImmediate.bind(h.runtime.chatAdapter);
  h.runtime.chatAdapter.prepareImmediate = async (...args) => {
    const prepared = await prepare(...args);
    h.starts[0].request.runtimeOperationGateway.children.close();
    return prepared;
  };
  await assert.rejects(h.spawn(), /runtime_child_parent_not_current/);
  const lineage = h.runtime.lineageStore.get(h.started.root_run_id);
  assert.equal(lineage.children[0].state, 'session_created');
  assert.equal(h.runtime.store.listSummaries({}).items.length, 1);
  assert.equal(h.runtime.children.publications.size, 0);
});

test('policy changes between parent and child preparation refuse broader authority', async t => {
  const h = await fixture(t);
  const prepare = h.runtime.chatAdapter.prepareImmediate.bind(h.runtime.chatAdapter);
  h.runtime.chatAdapter.prepareImmediate = async (...args) => {
    h.service.sessionExecutionAuthority._permissionStore.getSnapshot = () => ({ version: 4, legacy_policies: {}, rules: [] });
    return prepare(...args);
  };
  await assert.rejects(h.spawn(), /runtime_child_grant_expanded/);
  assert.equal(h.runtime.store.listSummaries({}).items.length, 1);
});

test('parent cancellation rejects later spawn and prevents pending child admission', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  const parent = h.runtime.store.get(h.started.work_id);
  h.runtime.cancel(parent.work_id, { expectedRevision: parent.revision });
  await assert.rejects(h.spawn('late', 'spawn_late'));
  await tick();
  assert.equal(h.starts.length, 1);
  assert.notEqual(h.runtime.store.get(child.child_work_id).status, 'running');
});


test('restart preserves a published child paused and explicit resume retains its original root', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  h.runtime.scheduler.beginClosing();
  h.starts[0].complete();
  await waitFor(() => h.runtime.store.get(h.started.work_id).status === 'completed', 'parent completion');
  for (const context of [...h.runtime.chatAdapter.contexts.values()]) h.runtime.chatAdapter.discard(context);
  const restored = initializeSessionRuntimeComposition(h.service);
  t.after(() => restored.scheduler.beginClosing());
  assert.equal(restored.store.get(child.child_work_id).status, 'paused');
  await tick();
  assert.equal(h.starts.length, 1);
  const app = new RuntimeApplicationService({ getRuntime: () => restored });
  const result = app.resume({ work_id: child.child_work_id,
    expected_revision: restored.store.get(child.child_work_id).revision });
  assert.equal(result.ok, true, JSON.stringify(result));
  await waitFor(() => h.starts.length === 2, () => JSON.stringify(h.logs));
  assert.equal(admit(h.starts[1], 'restored_child_inference').status, 'granted');
  assert.equal(restored.budgetStore.snapshot().root_record_count, 1);
  assert.equal(restored.budgetStore.get(h.started.root_run_id).charged.inference_requests, 1);
  h.starts[1].complete();
  await waitFor(() => restored.store.get(child.child_work_id).status === 'completed', 'restored child completion');
});

test('ambiguous canonical creation crash refuses to adopt the existing session on retry', async t => {
  const h = await fixture(t);
  const record = h.runtime.lineageStore.recordSession.bind(h.runtime.lineageStore);
  h.runtime.lineageStore.recordSession = () => { throw new Error('creation proof interrupted'); };
  await assert.rejects(h.spawn(), /creation proof interrupted/);
  h.runtime.lineageStore.recordSession = record;
  await assert.rejects(h.spawn(), /runtime_child_session_ambiguous/);
  assert.equal(h.runtime.lineageStore.get(h.started.root_run_id).children[0].state, 'preparing');
  assert.equal(h.runtime.store.listSummaries({}).items.length, 1);
});

test('root cancellation fence blocks child inference even if durable cancellation fails', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  const rootId = h.started.work_id;
  h.runtime.scheduler.cancellationFences.set(rootId, { session_id: h.sessionId });
  h.runtime.scheduler.notifyLaneAvailability();
  await assert.rejects(h.spawn());
  assert.notEqual(h.runtime.store.get(child.child_work_id).status, 'running');
  h.runtime.scheduler.cancellationFences.delete(rootId);
});


test('dependency proof accepts only canonical completed spawn results matching durable child publication', async t => {
  const { proveDependencyPrefix } = require('../../services/session-runtime/dependency-proof');
  const h = await fixture(t);
  const child = await h.spawn();
  const work = h.runtime.store.get(h.started.work_id);
  const events = ['tool_use', 'tool_executing', 'tool_result'].map((kind, index) => ({
    event_id: `${work.attempt.stream_id}:canonical:${index + 1}`, turn_id: work.turn_id,
    kind, tool_call_id: 'spawn_1', payload: { canonical_seq: index + 1,
      canonical_event_type: ['tool_call_requested', 'tool_execution_started', 'tool_execution_completed'][index],
      tool_name: 'session_spawn', tool_input: { task: 'Read the project' },
      ...(kind === 'tool_result' ? { success: true, tool_output_summary: JSON.stringify(child) } : {}) },
  }));
  const prove = (supplied = events, patch = {}) => proveDependencyPrefix({ runtime: h.runtime,
    work, events: supplied, dependencyId: child.child_work_id, ...patch });
  const proof = prove();
  assert.equal(proof.completed_spawn_refs[0].child_work_id, child.child_work_id);
  assert.equal(proof.wait.kind, 'dependency');
  for (const mutate of [
    list => { list[0].payload.tool_input.task = 'Other task'; },
    list => { list[2].payload.success = false; },
    list => { list[2].payload.tool_output_summary = '{}'; },
    list => { list[1].payload.tool_name = 'run_command'; },
    list => { list[2].event_id = 'old_stream:canonical:3'; },
    list => { list[2].payload.canonical_seq = 1; },
    list => { list.splice(1, 1); },
    list => { list.push({ ...list[2], event_id: `${work.attempt.stream_id}:canonical:4`,
      payload: { ...list[2].payload, canonical_seq: 4 } }); },
  ]) {
    const changed = structuredClone(events);
    mutate(changed);
    assert.throws(() => prove(changed), /runtime_dependency_/);
  }
  assert.throws(() => prove(events, { dependencyId: 'unrelated_child' }), /runtime_dependency_prefix_incomplete/);
  assert.throws(() => prove(events, { expectedRefs: [] }), /runtime_dependency_prefix_incomplete/);
  assert.deepEqual(prove(events, { expectedRefs: proof.completed_spawn_refs }), proof);
});


test('an admitted child publishes a grandchild with the original root and captured depth cap', async t => {
  const h = await fixture(t);
  await h.spawn();
  h.starts[0].complete();
  await waitFor(() => h.starts.length === 2, 'child admission');
  const grandchild = await h.starts[1].request.runtimeOperationGateway.children.spawn({ task: 'Read deeper' }, 'grandchild_1');
  assert.equal(grandchild.root_run_id, h.started.root_run_id);
  assert.equal(h.runtime.lineageStore.get(h.started.root_run_id).children.at(-1).depth, 2);
  assert.equal(h.runtime.store.get(grandchild.child_work_id).status, 'pending');
  h.starts[1].complete();
  await waitFor(() => h.starts.length === 3, 'grandchild admission');
  assert.equal(admit(h.starts[2], 'grandchild_inference').status, 'granted');
  assert.equal(h.runtime.budgetStore.get(h.started.root_run_id).reservations.at(-1).work_id, grandchild.child_work_id);
  await assert.rejects(h.starts[2].request.runtimeOperationGateway.children.spawn({ task: 'Too deep' }, 'greatgrandchild'),
    /lineage_descendant_capacity/);
  h.starts[2].complete();
  await waitFor(() => h.runtime.store.get(grandchild.child_work_id).status === 'completed', 'grandchild completion');
});

test('an admitted child loses new inference and spawn authority when its root is fenced', async t => {
  const h = await fixture(t);
  await h.spawn();
  h.starts[0].complete();
  await waitFor(() => h.starts.length === 2, 'child admission');
  h.runtime.scheduler.cancellationFences.set(h.started.work_id, { session_id: h.sessionId });
  assert.equal(admit(h.starts[1], 'revoked_child_inference').status, 'rejected');
  await assert.rejects(h.starts[1].request.runtimeOperationGateway.children.spawn({ task: 'Late child' }, 'late_child'),
    /runtime_child_ancestor_unavailable/);
  assert.equal(h.runtime.budgetStore.get(h.started.root_run_id).charged.inference_requests, 0);
  h.runtime.scheduler.cancellationFences.delete(h.started.work_id);
});


test('real dependency checkpoint releases the single parent turn, runs its child, then resumes without replaying spawn', async t => {
  const { dependencyFixture } = require('../helpers/session-runtime-dependency-fixture');
  const h = await fixture(t);
  const child = await h.spawn();
  const f = dependencyFixture(h, child, { announceWait: true });
  const published = await f.boundary.handleOperation(f.params);
  assert.equal(published.status, 'checkpointed', JSON.stringify(published));
  assert.equal(h.starts.length, 1);
  assert.equal(h.runtime.store.get(child.child_work_id).status, 'pending');
  const reply = { status: 'paused', request_id: f.params.request_id, checkpoint_ref: published.checkpoint_ref };
  const outcome = f.boundary.settlePause(reply, f.releaseArgs);
  assert.equal(outcome.checkpointSettled, true);
  assert.equal(h.starts.length, 1);
  h.starts[0].settle(outcome);
  await waitFor(() => h.starts.length === 2, () => JSON.stringify(h.logs));
  assert.equal(h.runtime.store.get(h.started.work_id).status, 'paused');
  assert.equal(h.runtime.eligibilityCoordinator.snapshot().wait_count, 1);
  h.starts[1].complete();
  await waitFor(() => h.starts.length === 3, () => JSON.stringify(h.logs));
  assert.equal(h.starts[2].request.sessionId, h.sessionId);
  assert.throws(() => h.starts[2].request.runtimeOperationGateway.children.validateWait(
    'wait_2', 'session_wait', { child_work_id: child.child_work_id }, [], []),
  /runtime_dependency_prior_checkpoint_unsupported/);
  const hydration = h.runtime.chatAdapter.contexts.get(h.started.work_id).resumeHydration;
  const messages = hydration.buildMessages();
  assert.equal(messages.filter(message => message.tool_calls?.[0]?.function.name === 'session_spawn').length, 1);
  assert.equal(messages.filter(message => message.role === 'tool' && message.tool_call_id === 'spawn_1').length, 1);
  assert.equal(messages.filter(message => message.tool_calls?.some(call => call.function.name === 'session_wait')).length, 0);
  assert.equal(h.runtime.lineageStore.get(h.started.root_run_id).children.length, 1);
  assert.equal(h.runtime.eligibilityCoordinator.snapshot().wait_count, 0);
  h.starts[2].complete();
  await waitFor(() => h.runtime.store.get(h.started.work_id).status === 'completed', 'resumed parent completion');
});


test('cancelling a paused child wakes its dependency parent without a lane event', async t => {
  const { dependencyFixture } = require('../helpers/session-runtime-dependency-fixture');
  const h = await fixture(t);
  const child = await h.spawn();
  h.runtime.pause(child.child_work_id, { expectedRevision: h.runtime.store.get(child.child_work_id).revision });
  const f = dependencyFixture(h, child);
  const published = await f.boundary.handleOperation(f.params);
  assert.equal(published.status, 'checkpointed');
  h.starts[0].settle(f.boundary.settlePause({ status: 'paused', request_id: f.params.request_id,
    checkpoint_ref: published.checkpoint_ref }, f.releaseArgs));
  await waitFor(() => h.runtime.eligibilityCoordinator.snapshot().wait_count === 1, 'parent wait');
  assert.equal(h.starts.length, 1);
  const result = h.runtime.cancel(child.child_work_id,
    { expectedRevision: h.runtime.store.get(child.child_work_id).revision });
  assert.equal(result.status, 'cancelled');
  await waitFor(() => h.starts.length === 2, () => JSON.stringify(h.logs));
  assert.equal(h.starts[1].request.sessionId, h.sessionId);
  h.starts[1].complete();
  await waitFor(() => h.runtime.store.get(h.started.work_id).status === 'completed', 'parent completion');
});


test('registered child tools traverse the actual Electron executor only with current parent authority', async t => {
  const { createDefaultRegistry, ToolExecutor, ToolPathPolicy } = require('../../services/tools');
  const { executeElectronToolRequest } = require('../../services/backend/electron-tool-bridge');
  const h = await fixture(t, { workspace: true });
  h.service.toolExecutor = new ToolExecutor({ registry: createDefaultRegistry(),
    permissionStore: h.service.sessionExecutionAuthority._permissionStore,
    logger() {}, pathPolicy: new ToolPathPolicy({ fs: fs.promises, path }) });
  const binding = h.runtime.chatAdapter.contexts.get(h.started.work_id).binding;
  const invoke = (tool, args, authority = binding, call = 'spawn_bridge') => executeElectronToolRequest(h.service, {
    executionAuthority: authority, params: { tool_name: tool, arguments: args, tool_call_id: call },
    sessionId: h.sessionId, streamId: h.starts[0].request.turnLease.identity.streamId,
  });
  assert.equal((await invoke('session_spawn', { task: 'Read' }, { ...binding })).success, false);
  const spawned = await invoke('session_spawn', { task: 'Read' });
  assert.equal(spawned.success, true, JSON.stringify(spawned));
  const child = JSON.parse(spawned.output);
  assert.deepEqual(JSON.parse((await invoke('session_spawn', { task: 'Read' })).output), child);
  const pending = await invoke('session_result', { child_work_id: child.child_work_id });
  assert.deepEqual(JSON.parse(pending.output), { child_work_id: child.child_work_id, status: 'pending' });
  assert.equal((await invoke('session_result', { child_work_id: h.started.work_id })).success, false);
  h.runtime.cancel(child.child_work_id, { expectedRevision: h.runtime.store.get(child.child_work_id).revision });
  h.service.sessionStore.appendMessage(child.session_id, { id: 'child_output', role: 'assistant',
    kind: 'message', turn_id: child.turn_id, content: '😀'.repeat(10000), timestamp: new Date().toISOString() });
  const result = JSON.parse((await invoke('session_wait', { child_work_id: child.child_work_id })).output);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(result.result), 32768);
  assert.equal(result.result.includes('�'), false);
  h.starts[0].request.runtimeOperationGateway.children.close();
  assert.equal((await invoke('session_result', { child_work_id: child.child_work_id })).success, false);
});


test('cancelling a completed root cancels running and queued descendants with durable lineage revocation', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  const sibling = await h.spawn('Sibling', 'spawn_sibling');
  h.starts[0].complete();
  await waitFor(() => h.starts.length === 2, 'child running');
  const grandchild = await h.starts[1].request.runtimeOperationGateway.children.spawn({ task: 'Deeper' }, 'deep_1');
  const result = h.runtime.cancel(h.started.work_id, { expectedRevision: h.runtime.store.get(h.started.work_id).revision });
  assert.equal(result.descendant_count, 3);
  assert.equal(result.cleanup_confirmed, false);
  assert.equal(h.runtime.lineageStore.get(h.started.root_run_id).cancelled, true);
  const settled = await result.settlement;
  assert.equal(settled.cleanup_confirmed, true, JSON.stringify(settled));
  for (const id of [child.child_work_id, sibling.child_work_id, grandchild.child_work_id]) {
    assert.equal(h.runtime.store.get(id).status, 'cancelled');
  }
  assert.equal(h.starts.length, 2);
});

test('child subtree cancellation leaves its sibling eligible and blocks in-flight publication', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  const sibling = await h.spawn('Sibling', 'spawn_sibling');
  h.starts[0].complete();
  await waitFor(() => h.starts.length === 2, 'child running');
  let release;
  const prepare = h.runtime.chatAdapter.prepareImmediate.bind(h.runtime.chatAdapter);
  h.runtime.chatAdapter.prepareImmediate = async (...args) => {
    const prepared = await prepare(...args);
    await new Promise(resolve => { release = resolve; });
    return prepared;
  };
  const pending = h.starts[1].request.runtimeOperationGateway.children.spawn({ task: 'Deeper' }, 'deep_1');
  await waitFor(() => !!release, 'publication prepared');
  const result = h.runtime.cancel(child.child_work_id, { expectedRevision: h.runtime.store.get(child.child_work_id).revision });
  assert.equal(result.cleanup_confirmed, false);
  release();
  await assert.rejects(pending);
  await result.settlement;
  await waitFor(() => h.starts.length === 3, 'sibling runs');
  assert.equal(h.starts[2].request.sessionId, sibling.session_id);
  assert.equal(h.runtime.lineageStore.get(h.started.root_run_id).cancelled, false);
  const descendant = h.runtime.lineageStore.get(h.started.root_run_id).children.find(row => row.call_id === 'deep_1');
  assert.equal(h.runtime.store.get(descendant.work_id), null);
  h.starts[2].complete();
});


test('failed root cancellation publication stays fenced until durable recovery and explicit retry', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  h.starts[0].complete();
  await waitFor(() => h.starts.length === 2, 'child running');
  const io = h.runtime.lineageStore.io = { ...h.runtime.lineageStore.io };
  const write = io.writeJsonAtomic;
  io.writeJsonAtomic = () => { throw new Error('disk unavailable'); };
  const result = h.runtime.cancel(h.started.work_id, { expectedRevision: h.runtime.store.get(h.started.work_id).revision });
  assert.equal(result.persisted, false);
  assert.equal((await result.settlement).cleanup_confirmed, false);
  assert.equal(h.runtime.scheduler.cancellationFences.has(h.started.work_id), true);
  assert.equal(h.runtime.store.get(child.child_work_id).status, 'cancelled');
  io.writeJsonAtomic = write;
  h.runtime.lineageStore.recover();
  const retried = h.runtime.cancel(h.started.work_id, { expectedRevision: h.runtime.store.get(h.started.work_id).revision });
  assert.equal(retried.persisted, true);
  assert.equal(retried.cleanup_confirmed, true, JSON.stringify(retried));
  assert.equal(h.runtime.lineageStore.get(h.started.root_run_id).cancelled, true);
});

test('session cancellation waits for children of a completed root in other sessions', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  h.starts[0].complete();
  await waitFor(() => h.starts.length === 2, 'child running');
  h.service.cancelChatStream = () => {};
  const waiting = h.runtime.cancelSessionAndWait(h.sessionId, { timeoutMs: 1000 });
  await tick();
  assert.equal(h.runtime.store.get(child.child_work_id).control_request.kind, 'cancel');
  let settled = false;
  waiting.then(() => { settled = true; });
  await tick();
  assert.equal(settled, false);
  h.starts[1].complete('cancelled');
  assert.deepEqual(await waiting, { ok: true });
});


test('restart finishes durable root cancellation without resuming its pending child', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  h.runtime.scheduler.beginClosing();
  h.starts[0].complete();
  await waitFor(() => h.runtime.store.get(h.started.work_id).status === 'completed', 'root completion');
  h.runtime.lineageStore.cancelRoot(h.started.root_run_id);
  const restored = initializeSessionRuntimeComposition(h.service);
  t.after(() => restored.scheduler.beginClosing());
  assert.equal(restored.store.get(child.child_work_id).status, 'cancelled');
  await tick();
  assert.equal(h.starts.length, 1);
  assert.equal(restored.scheduler.cancellationFences.size, 0);
});


test('unreadable lineage still aborts an already-admitted grandchild of the cancelled child', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  h.starts[0].complete();
  await waitFor(() => h.starts.length === 2, 'child running');
  const grandchild = await h.starts[1].request.runtimeOperationGateway.children.spawn({ task: 'Deeper' }, 'deep_1');
  h.starts[1].complete();
  await waitFor(() => h.starts.length === 3, 'grandchild running');
  const get = h.runtime.lineageStore.get.bind(h.runtime.lineageStore);
  h.runtime.lineageStore.get = () => { throw new Error('unreadable lineage'); };
  const result = h.runtime.cancel(child.child_work_id, { expectedRevision: h.runtime.store.get(child.child_work_id).revision });
  assert.equal(result.persisted, false);
  assert.equal((await result.settlement).cleanup_confirmed, false);
  assert.equal(h.runtime.store.get(grandchild.child_work_id).status, 'cancelled');
  h.runtime.lineageStore.get = get;
  const retry = h.runtime.cancel(child.child_work_id, { expectedRevision: h.runtime.store.get(child.child_work_id).revision });
  assert.equal(retry.cleanup_confirmed, true);
});


test('repeated dependency proof accepts only settled canonical child results from permitted attempts', async t => {
  const { createHash } = require('node:crypto');
  const { stableJson } = require('../../services/session-runtime/contracts');
  const { proveDependencyPrefix } = require('../../services/session-runtime/dependency-proof');
  const { readRuntimeChildResult } = require('../../services/session-runtime/child-capabilities');
  const { dependencyFixture } = require('../helpers/session-runtime-dependency-fixture');
  const h = await fixture(t);
  const child = await h.spawn();
  const first = dependencyFixture(h, child);
  h.runtime.cancel(child.child_work_id, { expectedRevision: h.runtime.store.get(child.child_work_id).revision });
  const work = h.runtime.store.get(h.started.work_id);
  const receipt = readRuntimeChildResult({ runtime: h.runtime, work }, { child_work_id: child.child_work_id });
  const waitRef = { call_id: 'wait_previous', child_work_id: child.child_work_id,
    result_sha256: createHash('sha256').update(stableJson(receipt)).digest('hex') };
  const waitEvents = first.events.map((event, index) => ({ ...event, tool_call_id: waitRef.call_id,
    event_id: `next_stream:canonical:${index + 1}`, payload: { ...event.payload, canonical_seq: index + 1,
      tool_name: 'session_wait', tool_input: { child_work_id: child.child_work_id },
      ...(event.kind === 'tool_result' ? { tool_output_summary: JSON.stringify(receipt) } : {}) } }));
  const options = { runtime: h.runtime, work, events: [...first.events, ...waitEvents],
    dependencyId: child.child_work_id, expectedRefs: first.params.completed_spawn_refs,
    expectedWaitRefs: [waitRef], permittedStreams: [work.attempt.stream_id, 'next_stream'] };
  assert.deepEqual(proveDependencyPrefix(options).completed_wait_refs, [waitRef]);
  assert.throws(() => proveDependencyPrefix({ ...options, permittedStreams: [work.attempt.stream_id] }));
  waitEvents[2].payload.tool_output_summary = JSON.stringify({ ...receipt, result: 'forged output' });
  assert.throws(() => proveDependencyPrefix({ ...options, events: [...first.events, ...waitEvents] }), /spawn_result/);
});
