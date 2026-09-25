'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { captureRuntimeRoute } = require('../../services/session-runtime/lanes');
const { stableJson } = require('../../services/session-runtime/contracts');
const { normalizeContinuationContext } = require('../../services/session-runtime/continuation-contracts');
const { buildAdmittedContinuationContext } = require('../../services/session-runtime/continuation-context');

function fixture() {
  const route = captureRuntimeRoute({ engine_type: 'chatgpt', provider_id: 'chatgpt',
    configuration_revision: 'config:1', resource_class: 'cloud', requires_gpu: false });
  const authority = { project_id: 'project_1', root_path: null, root_id: null,
    root_revision: 0, device_id: null, inode: null };
  const attempt = { attempt_id: 'attempt_1', stream_id: 'stream_1', incarnation: 'incarnation_1',
    authority_revision: 'authority_1' };
  return { route, attempt, work: { work_id: 'work_1', turn_id: 'turn_1', session_id: 'session_1',
    project_id: 'project_1', status: 'running', attempt: { ...attempt }, authority,
    input: { route: { ...route } } }, executionContext: { ...authority, schema_version: 1,
    authority_revision: 'authority_1', tool_policy_snapshot: {} } };
}

test('admitted context captures stable work/turn and exact physical attempt with opaque route/authority hashes', () => {
  const f = fixture();
  const context = buildAdmittedContinuationContext(f);
  assert.equal(context.work_id, f.work.work_id);
  assert.equal(context.turn_id, f.work.turn_id);
  assert.deepEqual(context.source_attempt, f.attempt);
  const hash = value => createHash('sha256').update(stableJson(value)).digest('hex');
  assert.equal(context.authority.sha256, hash(f.work.authority));
  assert.equal(context.route.sha256, hash(f.route));
  assert.equal(context.route.route_id, `route_${hash(f.route)}`);
  assert.equal(context.route.route_revision, 'config:1');
  assert.equal(Object.isFrozen(context.source_attempt), true);
  assert.equal(Object.hasOwn(context, 'execution_context'), false);
  const copy = normalizeContinuationContext(context);
  copy.source_attempt.stream_id = 'changed';
  assert.equal(context.source_attempt.stream_id, 'stream_1');
});

test('pending work, stale attempts, replaced routes and mismatched scoped context cannot mint continuation identity', () => {
  for (const mutate of [
    f => { f.work.status = 'pending'; },
    f => { f.attempt = { ...f.attempt, attempt_id: 'old_attempt' }; },
    f => { f.route = { ...f.route }; },
    f => { f.work.input.route.engine_type = 'ollama'; },
    f => { f.executionContext.authority_revision = 'old_authority'; },
    f => { f.executionContext.root_path = 'C:/unauthorized'; },
    f => { f.executionContext.project_id = 'other'; },
    f => { f.executionContext = null; },
  ]) {
    const f = fixture();
    mutate(f);
    assert.throws(() => buildAdmittedContinuationContext(f), /runtime_continuation_context_fence_conflict/);
  }
});

test('wire normalization is closed and shares checkpoint substructure validation', () => {
  const context = buildAdmittedContinuationContext(fixture());
  for (const invalid of [null, { ...context, schema_version: true },
    { ...context, schema_version: 2 }, { ...context, session_id: 'model_session' },
    { ...context, source_attempt: { ...context.source_attempt, stream_id: '../escape' } },
    { ...context, authority: { ...context.authority, credentials: 'forbidden' } },
    { ...context, route: { ...context.route, sha256: 'bad' } },
  ]) assert.throws(() => normalizeContinuationContext(invalid));
});
