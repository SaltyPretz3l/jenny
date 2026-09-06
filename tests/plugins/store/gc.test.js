'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { putContent, hasContent } = require('../../../services/plugins/store/content-store');
const {
  computeReachableDigests,
  planGarbageCollection,
  executeGarbageCollection,
} = require('../../../services/plugins/store/gc');

function fakeGeneration(digests) {
  return { plugins: digests.map((digest, index) => ({ artifact_digest: digest, publisher_id: 'p', plugin_id: `plugin-${index}` })) };
}

test('computeReachableDigests unions every reachable source', () => {
  const active = fakeGeneration(['a']);
  const retained = [fakeGeneration(['b']), fakeGeneration(['c'])];
  const reachable = computeReachableDigests({
    activeGeneration: active,
    retainedGenerations: retained,
    stagedDigests: ['d'],
    quarantineDigests: ['e'],
    recoveryDigests: ['f'],
    liveLeaseDigests: ['g'],
  });
  assert.deepEqual([...reachable].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('computeReachableDigests tolerates a null/undefined activeGeneration and empty arrays', () => {
  const reachable = computeReachableDigests({});
  assert.deepEqual([...reachable], []);
});

test('V3 generation evidence and remote bindings remain reachable', () => {
  const reachable = computeReachableDigests({
    activeGeneration: { plugins: [{
      artifact_digest: 'a', package_record_digest: 'b', source_trust_digest: 'c',
      advisory_snapshot_digest: 'd', data_snapshot_digest: 'e',
      remote_binding_digests: ['f', 'g'],
    }] },
  });
  assert.deepEqual([...reachable].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g']);
});

test('V4 through V6 runtime and privileged digests remain reachable', () => {
  const fields = [
    'restricted_module_digests', 'view_content_digests', 'provider_descriptor_digests',
    'executable_object_digests', 'full_host_binding_digests', 'native_mcp_binding_digests',
    'session_provider_digests', 'engine_adapter_digests', 'hook_descriptor_digests',
    'containment_profile_digests', 'build_provenance_digests',
  ];
  const plugin = {};
  fields.forEach((field, index) => { plugin[field] = [`digest-${index}`]; });
  const reachable = computeReachableDigests({ activeGeneration: { plugins: [plugin] } });
  assert.deepEqual([...reachable].sort(), fields.map((_field, index) => `digest-${index}`).sort());
});

test('planGarbageCollection separates on-disk digests into toDelete/toKeep without deleting anything', async () => {
  const facade = createMemoryFsFacade();
  const keep = await putContent(facade, 'plugins', 'keep-me');
  const drop = await putContent(facade, 'plugins', 'drop-me');
  const plan = await planGarbageCollection(facade, 'plugins', { reachableDigests: new Set([keep.digest]) });
  assert.deepEqual(plan.toKeep, [keep.digest]);
  assert.deepEqual(plan.toDelete, [drop.digest]);
  // Dry run: nothing has actually been removed yet.
  assert.equal(await hasContent(facade, 'plugins', drop.digest), true);
});

test('executeGarbageCollection removes only the planned toDelete digests, leaving live-lease-reachable content untouched', async () => {
  const facade = createMemoryFsFacade();
  const keep = await putContent(facade, 'plugins', 'keep-me');
  const drop = await putContent(facade, 'plugins', 'drop-me');
  const plan = await planGarbageCollection(facade, 'plugins', { reachableDigests: new Set([keep.digest]) });
  const result = await executeGarbageCollection(facade, 'plugins', { plan });
  // `skipped` carries digests that became reachable again between planning and
  // execution; nothing did here, so it is empty.
  assert.deepEqual(result, { removed: [drop.digest], failed: [], skipped: [] });
  assert.equal(await hasContent(facade, 'plugins', keep.digest), true);
  assert.equal(await hasContent(facade, 'plugins', drop.digest), false);
});

test('executeGarbageCollection records a per-digest removal failure without aborting the rest of the plan', async () => {
  const facade = createMemoryFsFacade();
  const a = await putContent(facade, 'plugins', 'alpha');
  const b = await putContent(facade, 'plugins', 'beta');
  const originalRemove = facade.remove.bind(facade);
  facade.remove = async (path) => {
    if (path.includes(a.digest)) {
      throw new Error('simulated removal failure');
    }
    return originalRemove(path);
  };
  const plan = { toDelete: [a.digest, b.digest], toKeep: [] };
  const result = await executeGarbageCollection(facade, 'plugins', { plan });
  assert.deepEqual(result.removed, [b.digest]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].digest, a.digest);
});
