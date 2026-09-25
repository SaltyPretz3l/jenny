'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeContinuationOperationHandler } = require('../../services/backend/runtime-continuation-operations');

function fixture() {
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
    authority_revision: 'authority_1' };
  const context = { schema_version: 1, work_id: 'work_1', turn_id: 'turn_1', source_attempt: attempt,
    authority: { project_id: 'project_1', root_id: null, root_revision: 0, sha256: 'a'.repeat(64) },
    route: { route_id: 'route_1', route_revision: 'config:1', sha256: 'b'.repeat(64) } };
  const params = { api_version: '2026-08-17', schema_version: 1, kind: 'continuation', phase: 'checkpoint',
    request_id: 'stream_1', session_id: 'session_1', authority_revision: 'authority_1', operation_id: 'call_1',
    continuation_context: context, position: {}, eligibility: {}, tool_calls: [{ call_id: 'call_1', tool_id: 'view_file' }],
    tool_batch_bytes: 'e30=', tool_batch_sha256: 'c'.repeat(64),
    frozen_input: { call_id: 'call_1', tool_name: 'view_file', visible_tool_arguments: { path: 'README.md' },
      effective_tool_arguments: { path: 'README.md', _jenny_session_id: 'session_1' } },
    frozen_input_bytes: 'e30=', frozen_input_sha256: 'd'.repeat(64) };
  const state = { current: true, waiting: true, durable: true, prefixCalls: 0, publishes: [], afterPrefix: null };
  const dependencies = { context, sessionId: 'session_1', assertCurrent: () => state.current,
    historySelector: { schema_version: 1, history_scope: 'session', compaction_ref: null,
      canonical_cutoff: { boundary_message_id: null, boundary_message_count: 0, sha256: 'f'.repeat(64) } },
    resourceOperations: { validateResourceWait(id, toolName, args) {
      return state.waiting && id === 'call_1' && toolName === 'view_file' && args?.path === 'README.md'
        ? { resource_class: 'filesystem', dependency_id: null } : null;
    } },
    async persistCanonicalPrefix() {
      state.prefixCalls += 1;
      await state.afterPrefix?.();
      return { through_seq: 7, commit: { ok: state.durable, applied: true, durable: state.durable,
        reason: null, commitEpoch: 3, dirtyEpoch: 3, durableEpoch: state.durable ? 3 : 2, value: null } };
    },
    coordinator: { publish(input) {
      state.publishes.push(input);
      return { schema_version: 1, checkpoint_id: input.proposal.checkpoint_id,
        sha256: 'e'.repeat(64), bytes: 2048, source_attempt: attempt };
    } } };
  return { params, state, dependencies, handle: createRuntimeContinuationOperationHandler(dependencies) };
}

test('checkpoint request uses owner wait classification, canonical sequence and app-minted identity', async () => {
  const f = fixture();
  const response = await f.handle(f.params);
  assert.equal(response.status, 'checkpointed');
  assert.equal(response.operation_id, 'call_1');
  assert.deepEqual(response.checkpoint_ref.source_attempt, f.params.continuation_context.source_attempt);
  assert.match(response.checkpoint_ref.checkpoint_id, /^checkpoint_[0-9a-f]{64}$/u);
  const saved = f.state.publishes[0];
  assert.equal(saved.proposal.through_seq, 7);
  assert.deepEqual(saved.proposal.history_selector, f.dependencies.historySelector);
  assert.deepEqual(saved.wait, { kind: 'resource', operation_id: 'call_1', resource_class: 'filesystem', dependency_id: null });
  assert.equal(saved.proposal.frozen_input_bytes, f.params.frozen_input_bytes);
  assert.equal(saved.proposal.tool_batch_bytes, f.params.tool_batch_bytes);
  assert.equal(saved.proposal.frozen_input.effective_tool_arguments._jenny_session_id, 'session_1');
});

test('publication failure diagnostics identify bounded stages without exposing exceptions', async () => {
  for (const [dependency, stage, code, expected] of [
    ['wait', 'wait_validation', 'runtime_resource_progress_unproven', 'runtime_resource_progress_unproven'],
    ['prefix', 'canonical_prefix', 'ENOSPC', 'ENOSPC'],
    ['publish', 'checkpoint_publication', 'secret-token', 'unclassified'],
  ]) {
    const f = fixture();
    const diagnostics = [];
    const fail = () => { throw Object.assign(new Error('private path and arguments'), { code }); };
    if (dependency === 'wait') f.dependencies.resourceOperations.validateResourceWait = fail;
    if (dependency === 'prefix') f.dependencies.persistCanonicalPrefix = fail;
    if (dependency === 'publish') f.dependencies.coordinator.publish = fail;
    const handle = createRuntimeContinuationOperationHandler({ ...f.dependencies,
      onPublicationFailure: detail => diagnostics.push(detail) });
    const first = await handle(f.params);
    assert.equal(first.reason, 'runtime_continuation_publication_failed');
    assert.deepEqual(await handle(f.params), first);
    assert.deepEqual(diagnostics, [{ stage, error_code: expected }]);
    assert.ok(!JSON.stringify({ first, diagnostics }).includes('private'));
    assert.ok(!JSON.stringify({ first, diagnostics }).includes('secret-token'));
  }
});

test('diagnostic failure cannot replace the fail-closed checkpoint rejection', async () => {
  const f = fixture();
  f.dependencies.coordinator.publish = () => { throw new Error('runtime_continuation_resource_unproven'); };
  const handle = createRuntimeContinuationOperationHandler({ ...f.dependencies,
    onPublicationFailure: detail => {
      assert.equal(detail.error_code, 'runtime_continuation_resource_unproven');
      throw new Error('logging unavailable');
    } });
  assert.equal((await handle(f.params)).reason, 'runtime_continuation_publication_failed');
});

test('identical concurrent requests share one transaction and changed retries cannot replace it', async () => {
  const f = fixture();
  let release;
  f.state.afterPrefix = () => new Promise(resolve => { release = resolve; });
  const first = f.handle(f.params);
  const second = f.handle(structuredClone(f.params));
  assert.equal(first, second);
  await Promise.resolve();
  const conflict = await f.handle({ ...f.params, frozen_input_bytes: 'b3RoZXI=' });
  assert.equal(conflict.reason, 'runtime_continuation_request_conflict');
  release();
  assert.equal((await first).status, 'checkpointed');
  assert.equal(f.state.prefixCalls, 1);
  assert.equal(f.state.publishes.length, 1);
  assert.deepEqual(await f.handle(f.params), await first);
});

test('closed request identity rejects stale authority, forged context and sidecar-controlled sequence', async () => {
  for (const mutate of [
    value => { value.schema_version = true; },
    value => { value.session_id = 'other'; },
    value => { value.request_id = 'old_stream'; },
    value => { value.authority_revision = 'old'; },
    value => { value.continuation_context.source_attempt.attempt_id = 'forged'; },
    value => { value.through_seq = 999; },
    value => { value.history_selector = { history_scope: 'fresh' }; },
    value => { value.frozen_input.call_id = 'other'; },
    value => { value.tool_calls[0].tool_id = 'write_file'; },
  ]) {
    const f = fixture();
    const invalid = structuredClone(f.params);
    mutate(invalid);
    assert.equal((await f.handle(invalid)).status, 'rejected');
    assert.equal(f.state.prefixCalls, 0);
  }
});

test('live wait and exact admitted visible input are required before writing a canonical prefix', async () => {
  const f = fixture();
  f.params.frozen_input.visible_tool_arguments.path = 'other';
  assert.equal((await f.handle(f.params)).reason, 'runtime_continuation_wait_unavailable');
  assert.equal(f.state.prefixCalls, 0);
  const g = fixture();
  g.state.waiting = false;
  assert.equal((await g.handle(g.params)).status, 'rejected');
  assert.equal(g.state.prefixCalls, 0);
});

test('authority revocation or failed durability while flushing cannot publish a checkpoint', async () => {
  for (const change of [state => { state.current = false; }, state => { state.waiting = false; },
    state => { state.durable = false; }]) {
    const f = fixture();
    f.state.afterPrefix = () => change(f.state);
    assert.equal((await f.handle(f.params)).status, 'rejected');
    assert.equal(f.state.publishes.length, 0);
  }
});

test('request snapshots resist mutation during awaits and publication failures expose no private details', async () => {
  const f = fixture();
  f.state.afterPrefix = () => {
    f.params.frozen_input.effective_tool_arguments.path = 'changed';
    f.dependencies.historySelector.history_scope = 'fresh';
  };
  assert.equal((await f.handle(f.params)).status, 'checkpointed');
  assert.equal(f.state.publishes[0].proposal.frozen_input.effective_tool_arguments.path, 'README.md');
  assert.equal(f.state.publishes[0].proposal.history_selector.history_scope, 'session');
  const g = fixture();
  g.dependencies.coordinator.publish = () => { throw new Error('private path and user input'); };
  const result = await g.handle(g.params);
  assert.equal(result.reason, 'runtime_continuation_publication_failed');
  assert.equal(JSON.stringify(result).includes('private'), false);
  const large = fixture();
  large.params.frozen_input_bytes = 'x'.repeat(1024 * 1024);
  assert.equal((await large.handle(large.params)).reason, 'runtime_continuation_request_capacity');
  assert.equal(large.state.prefixCalls, 0);
});


test('explicit pause probe publishes only a live exact-attempt intent without resource classification', async () => {
  const f = fixture();
  const work = { work_id: 'work_1', turn_id: 'turn_1', session_id: 'session_1', status: 'running',
    attempt: f.params.continuation_context.source_attempt, control_request: null };
  f.dependencies.getCurrentWork = () => work;
  f.dependencies.resourceOperations.validateResourceWait = () => { throw new Error('no resource dependency'); };
  const handle = createRuntimeContinuationOperationHandler(f.dependencies);
  const probe = { ...f.params, phase: 'pause_probe' };
  assert.equal((await handle(probe)).status, 'continue');
  assert.equal(f.state.prefixCalls, 0);
  work.control_request = { kind: 'pause' };
  assert.equal((await handle(probe)).status, 'checkpointed');
  assert.deepEqual(f.state.publishes[0].wait, { kind: 'explicit_pause', operation_id: 'call_1',
    resource_class: null, dependency_id: null });
  assert.equal((await handle(probe)).status, 'checkpointed');
  assert.equal(f.state.publishes.length, 1);
});

test('pause probe rejects cancellation or stale attempt during prefix persistence', async () => {
  for (const invalidate of [work => { work.control_request = { kind: 'cancel' }; },
    work => { work.attempt = { ...work.attempt, attempt_id: 'stale' }; }]) {
    const f = fixture();
    const work = { work_id: 'work_1', turn_id: 'turn_1', session_id: 'session_1', status: 'running',
      attempt: f.params.continuation_context.source_attempt, control_request: { kind: 'pause' } };
    f.dependencies.getCurrentWork = () => work;
    f.state.afterPrefix = () => invalidate(work);
    const handle = createRuntimeContinuationOperationHandler(f.dependencies);
    assert.equal((await handle({ ...f.params, phase: 'pause_probe' })).status, 'rejected');
    assert.equal(f.state.publishes.length, 0);
  }
});
