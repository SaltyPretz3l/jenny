"use strict";
const assert = require('node:assert/strict');
const test = require('node:test');
const { RuntimeStore } = require('../../services/session-runtime/store');
const { reconcileMutationPreparations } = require('../../services/session-runtime/mutation-preparation-recovery');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization } = require('../../services/session-runtime/inference-protocol');
function fixture(count) {
  const saved = new Map();
  const store = Object.create(RuntimeStore.prototype);
  store.root = 'runtime'; store.readOnly = false;
  store.io = { readJson: name => saved.has(name) ? { status: 'ok', value: saved.get(name) } : { status: 'missing' },
    writeJsonAtomic: (name, value) => saved.set(name, structuredClone(value)) };
  const records = new Map(Array.from({ length: count }, (_, index) => {
    const work_id = `work_${index}`;
    return [work_id, { work_id, status: 'needs_attention', session_id: 'session', turn_id: `turn_${index}`,
      attempt: { attempt_id: `attempt_${index}` }, authority: { root_path: 'workspace', device_id: '1', inode: '2' },
      checkpoint_ref: null }];
  }));
  store.index = { summaries: [...records.values()].map(({ work_id, status }) => ({ work_id, status })) };
  store.get = id => structuredClone(records.get(id));
  const calls = [];
  const client = { process: {}, request: async (method, params, options) => {
    calls.push({ method, params, options }); return { schema_version: 1, status: 'reconciled', interrupted: 0 };
  } };
  completeRuntimeInferenceInitialization(client, beginRuntimeInferenceInitialization(client), {
    runtime_inference_admission_version: 1, runtime_tool_resource_admission_version: 1, runtime_continuation_version: 1 });
  const runtime = { store, scheduler: { active: new Map() },
    checkpointStore: { findCommittedForWork: () => ({ status: 'none' }) } };
  return { runtime, records, calls, service: { sidecarClient: client } };
}
test('startup scans bounded nonterminal candidates and rotates beyond successful and skipped rows', async () => {
  const f = fixture(100);
  f.runtime.store.index.summaries.unshift(...Array.from({ length: 100000 }, (_, index) => ({ work_id: `terminal_${index}`, status: 'completed' })));
  const first = await reconcileMutationPreparations(f.service, f.runtime);
  assert.equal(first.inspected, 16); assert.equal(first.blocked, 84);
  assert.equal(f.calls.length, 16);
  const firstIds = new Set(f.calls.map(call => call.params.work_id));
  const second = await reconcileMutationPreparations(f.service, f.runtime);
  assert.equal(second.inspected, 16);
  assert.ok(f.calls.slice(16).every(call => !firstIds.has(call.params.work_id)));
  assert.equal(f.calls[16].params.work_id, 'work_83');
  for (const record of f.records.values()) record.status = 'paused';
  f.runtime.store.index.summaries = [...f.records.values()].map(({ work_id, status }) => ({ work_id, status }));
  // More than one scan window of ordinary paused records cannot permanently hide an orphan.
  f.records.get('work_0').status = 'needs_attention';
  for (let run = 0; run < 2; run++) await reconcileMutationPreparations(f.service, f.runtime);
  assert.ok(f.calls.some(call => call.params.work_id === 'work_0'));
});
test('shared deadline stops dispatch and rotates past timeout failures', async () => {
  const f = fixture(30); let elapsed = 0;
  f.service.sidecarClient.request = async (_method, params, options) => {
    f.calls.push(params.work_id); assert.ok(options.timeoutMs <= 3000);
    elapsed += options.timeoutMs; throw new Error('timeout');
  };
  const first = await reconcileMutationPreparations(f.service, f.runtime, { now: () => elapsed });
  assert.equal(first.inspected, 5); assert.equal(first.blocked, 30); assert.equal(elapsed, 15000);
  elapsed = 0;
  await reconcileMutationPreparations(f.service, f.runtime, { now: () => elapsed });
  assert.equal(f.calls[5], 'work_24');
});
test('live producers, ordinary pauses, terminal history and ambiguous publication receive no orphan RPC', async () => {
  const f = fixture(4);
  f.records.get('work_0').status = 'paused';
  f.runtime.scheduler.active.set('work_1', {});
  f.records.get('work_2').status = 'failed';
  f.runtime.checkpointStore.findCommittedForWork = () => ({ status: 'blocked' });
  const result = await reconcileMutationPreparations(f.service, f.runtime);
  assert.equal(result.blocked, 1); assert.equal(f.calls.length, 0);
});

test('corrupt optional cursor resets its scan without authorizing different work', async () => {
  const f = fixture(2);
  const read = f.runtime.store.io.readJson;
  f.runtime.store.io.readJson = () => ({ status: 'corrupt' });
  const result = await reconcileMutationPreparations(f.service, f.runtime);
  assert.equal(result.inspected, 2); assert.equal(result.blocked, 1);
  f.runtime.store.io.readJson = read;
  assert.equal(f.runtime.store.listMutationRecoveryCandidates().cursor_blocked, false);
});
for (const operation of ['read', 'write']) test(`cursor ${operation} failure leaves initialization usable and evidence untouched`, async () => {
  const f = fixture(2);
  f.runtime.store.io[operation === 'read' ? 'readJson' : 'writeJsonAtomic'] = () => { throw new Error('disk_failure'); };
  const result = await reconcileMutationPreparations(f.service, f.runtime);
  assert.equal(result.inspected, 0); assert.ok(result.blocked > 0); assert.equal(f.calls.length, 0);
});
