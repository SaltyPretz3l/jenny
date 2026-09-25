'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');
const { createHash } = require('node:crypto');
const { stableJson } = require('../../services/session-runtime/contracts');
const { readRuntimeChildResult } = require('../../services/session-runtime/child-capabilities');
const { dependencyFixture } = require('../helpers/session-runtime-dependency-fixture');
const { fixture } = require('../helpers/session-runtime-children-fixture');
const { waitFor } = require('../helpers/session-runtime-chat-adapter-harness');
const hash = value => createHash('sha256').update(stableJson(value)).digest('hex');
async function pause(h, f, entryIndex) {
  const reply = await f.boundary.handleOperation(f.params);
  assert.equal(reply.status, 'checkpointed', JSON.stringify(reply));
  h.starts[entryIndex].settle(f.boundary.settlePause({ status: 'paused', request_id: f.params.request_id,
    checkpoint_ref: reply.checkpoint_ref }, f.releaseArgs));
  return reply.checkpoint_ref;
}

for (const announcements of [true, false]) test(`repeated dependency retains proof/budgets with announcements=${announcements}`, async t => {
  const h = await fixture(t, { workspace: true });
  const child = await h.spawn();
  const first = dependencyFixture(h, child, { announceWait: announcements, omitSpawnAnnouncement: !announcements });
  const originalRef = await pause(h, first, 0);
  await waitFor(() => h.starts.length === 2, 'child running');
  h.starts[1].complete();
  await waitFor(() => h.starts.length === 3, () => JSON.stringify(h.logs));
  const work = h.runtime.store.get(h.started.work_id);
  const args = { child_work_id: child.child_work_id };
  const result = readRuntimeChildResult({ runtime: h.runtime, work }, args);
  const events = ['tool_executing', 'tool_result'].map((kind, index) => ({
    event_id: `${work.attempt.stream_id}:canonical:${index + 1}`, turn_id: work.turn_id, kind,
    tool_call_id: 'wait_1', payload: { canonical_seq: index + 1, tool_name: 'session_wait', tool_input: args,
      canonical_event_type: index ? 'tool_execution_completed' : 'tool_execution_started',
      ...(index ? { success: true, tool_output_summary: JSON.stringify(result) } : {}) } }));
  const prior = { prior_checkpoint_ref: originalRef, prior_effect_count: 1,
    completed_spawn_refs: first.params.completed_spawn_refs,
    completed_wait_refs: [{ call_id: 'wait_1', child_work_id: child.child_work_id, result_sha256: hash(result) }] };
  const second = dependencyFixture(h, child, { entryIndex: 2, prior, currentEvents: events,
    waitId: 'wait_2', announceWait: true });
  const details = { ...prior, position: second.params.position };
  const validate = changes => h.starts[2].request.runtimeOperationGateway.children.validateWait('wait_2',
    'session_wait', args, prior.completed_spawn_refs, second.events, { ...details, ...changes });
  assert.equal(validate({}).wait.dependency_id, child.child_work_id);
  assert.throws(() => validate({ prior_effect_count: 0 }), /progress_invalid/);
  assert.throws(() => validate({ position: { ...details.position, tool_call_limit: 21 } }), /progress_invalid/);
  assert.throws(() => validate({ prior_checkpoint_ref: { ...originalRef, sha256: 'f'.repeat(64) } }), /prior_checkpoint/);
  const secondRef = await pause(h, second, 2);
  await waitFor(() => h.starts.length === 4, () => JSON.stringify(h.logs));
  const body = h.runtime.checkpointStore.readHistorical(secondRef,
    { ...h.runtime.store.get(h.started.work_id), attempt: secondRef.source_attempt });
  assert.equal(body.schema_version, 2);
  assert.equal(body.position.tool_calls_consumed, 3);
  assert.equal(body.position.remaining_iterations, 5);
  assert.deepEqual(body.prior_checkpoint_ref, originalRef);
  const hydration = h.runtime.chatAdapter.contexts.get(h.started.work_id).resumeHydration;
  const messages = hydration.buildMessages();
  assert.deepEqual(messages.flatMap(row => row.tool_calls || []).map(call => call.id), ['spawn_1', 'wait_1']);
  assert.deepEqual(messages.filter(row => row.role === 'tool').map(row => row.tool_call_id), ['spawn_1', 'wait_1']);
  assert.equal(h.runtime.lineageStore.get(h.started.root_run_id).children.length, 1);
  const nextWork = h.runtime.store.get(h.started.work_id);
  const thirdEvents = ['tool_executing', 'tool_result'].map((kind, index) => ({
    event_id: `${nextWork.attempt.stream_id}:canonical:${index + 1}`, turn_id: nextWork.turn_id, kind,
    tool_call_id: 'wait_2', payload: { canonical_seq: index + 1, tool_name: 'session_wait', tool_input: args,
      canonical_event_type: index ? 'tool_execution_completed' : 'tool_execution_started',
      ...(index ? { success: true, tool_output_summary: JSON.stringify(result) } : {}) } }));
  const thirdPrior = { ...prior, prior_checkpoint_ref: secondRef, prior_effect_count: 2,
    completed_wait_refs: [...prior.completed_wait_refs, { ...prior.completed_wait_refs[0], call_id: 'wait_2' }] };
  const third = dependencyFixture(h, child, { entryIndex: 3, prior: thirdPrior, currentEvents: thirdEvents,
    waitId: 'wait_3', announceWait: true });
  Object.assign(third.params.position, { completed_iterations: 4, current_iteration: 4,
    remaining_iterations: 4, tool_calls_consumed: 4, active_budget_ms_remaining: 4000 });
  const thirdRef = await pause(h, third, 3);
  await waitFor(() => h.starts.length === 5, () => JSON.stringify(h.logs));
  const latest = h.runtime.chatAdapter.contexts.get(h.started.work_id).resumeHydration.buildMessages();
  assert.deepEqual(latest.flatMap(row => row.tool_calls || []).map(call => call.id), ['spawn_1', 'wait_1', 'wait_2']);
  const { readDependencyPredecessor } = require('../../services/session-runtime/dependency-predecessor');
  assert.equal(readDependencyPredecessor(h.runtime, h.runtime.store.get(h.started.work_id), thirdRef).checkpoint.schema_version, 2);
  if (announcements) {
    const freshWork = h.runtime.store.get(h.started.work_id);
    const request = h.starts[4].request;
    const execution = h.service.sessionExecutionAuthority.toExecutionContext(request.runtimeExecutionAuthority);
    const context = buildAdmittedContinuationContext({ work: freshWork, attempt: freshWork.attempt,
      route: request.runtimeRoute, executionContext: execution });
    const view = h.runtime.chatAdapter.contexts.get(h.started.work_id).resumeHydration;
    const payload = { legacy_quota_disabled: true, child_result: result, runtime_continuation_resume: view.buildResumeFields({ work: freshWork, context }),
      fresh_request: { request_id: freshWork.attempt.stream_id, session_id: freshWork.session_id,
        logical_turn_id: freshWork.turn_id, messages: view.buildMessages(), canonical_session_messages: view.buildMessages(),
        execution_context: execution, continuation_context: context, inference_budget_required: true, runtime_children_enabled: true } };
    const root = path.resolve(__dirname, '../..');
    const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const run = spawnSync(python, ['tests/helpers/session-runtime-python-resume.py'], {
      cwd: root, input: JSON.stringify(payload), encoding: 'utf8', timeout: 90000, maxBuffer: 1024 * 1024 });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const observed = JSON.parse(run.stdout);
    assert.equal(observed.status, 'completed');
    assert.equal(observed.engine_calls, 1);
    assert.deepEqual(observed.events.filter(event => event[0] === 'tool'), [['tool', 'session_wait', args]]);
  }
  h.starts[4].complete();
  await waitFor(() => h.runtime.store.get(h.started.work_id).status === 'completed', 'root completion');
});

test('repeated checkpoint rejects a new child effect before the saved predecessor wait', async t => {
  const h = await fixture(t);
  const child = await h.spawn();
  const first = dependencyFixture(h, child, { announceWait: true });
  const reference = await pause(h, first, 0);
  await waitFor(() => h.starts.length === 2, 'child running');
  h.starts[1].complete();
  await waitFor(() => h.starts.length === 3, 'parent resumed');
  const gateway = h.starts[2].request.runtimeOperationGateway;
  const nextChild = await gateway.children.spawn({ task: 'Read the project' }, 'spawn_2');
  const work = h.runtime.store.get(h.started.work_id);
  const args = { child_work_id: child.child_work_id };
  const result = readRuntimeChildResult({ runtime: h.runtime, work }, args);
  const spawnEvents = first.events.slice(0, 3).map((event, index) => ({ ...event,
    event_id: `${work.attempt.stream_id}:canonical:${index + 1}`, tool_call_id: 'spawn_2',
    payload: { ...event.payload, ...(index === 2 ? { tool_output_summary: JSON.stringify(nextChild) } : {}) } }));
  const waitEvents = ['tool_executing', 'tool_result'].map((kind, index) => ({
    event_id: `${work.attempt.stream_id}:canonical:${index + 4}`, turn_id: work.turn_id, kind,
    tool_call_id: 'wait_1', payload: { canonical_seq: index + 4, tool_name: 'session_wait', tool_input: args,
      canonical_event_type: index ? 'tool_execution_completed' : 'tool_execution_started',
      ...(index ? { success: true, tool_output_summary: JSON.stringify(result) } : {}) } }));
  const refs = [...first.params.completed_spawn_refs, { call_id: 'spawn_2',
    child_work_id: nextChild.child_work_id, result_sha256: hash(nextChild) }];
  const details = { prior_checkpoint_ref: reference, prior_effect_count: 1,
    completed_wait_refs: [{ call_id: 'wait_1', child_work_id: child.child_work_id, result_sha256: hash(result) }],
    position: { ...first.params.position, current_iteration: 4, completed_iterations: 4,
      remaining_iterations: 4, tool_calls_consumed: 4, ordered_call_ids: ['wait_2'] } };
  assert.throws(() => gateway.children.validateWait('wait_2', 'session_wait', args,
    refs, [...spawnEvents, ...waitEvents], details), /predecessor_wait_order/);
});
