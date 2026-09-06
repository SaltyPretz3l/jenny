'use strict';

// Lease-aware garbage collection ("Durable generation commit" step 7):
// "Garbage collection deletes only content unreachable from active, retained,
// staged, quarantine, recovery, or live-lease references. Runtime leases held
// by turns, approvals, hosts, views, workers, and deferred cleanup are
// first-class references."
//
// The headline property -- GC never collects a leased generation -- is proved
// two ways: by construction over the full source cross-product, and by a seeded
// randomized sweep, because the dangerous case is a digest reachable through
// exactly ONE source that a future refactor might forget to union in.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { putContent, listContentDigests, sha256Hex } = require('../../../services/plugins/store/content-store');
const {
  computeReachableDigests,
  planGarbageCollection,
  executeGarbageCollection,
} = require('../../../services/plugins/store/gc');
const { buildGenerationRecord } = require('../../../services/plugins/store/generation-store');
const { makeRng } = require('../../helpers/plugins/lifecycle-explorer');
const { POLICY_GRANT_REF, NOW } = require('../../helpers/plugins/durability-scenario');

const BASE_DIR = 'plugins';

const REACHABILITY_SOURCES = [
  'stagedDigests',
  'quarantineDigests',
  'recoveryDigests',
  'liveLeaseDigests',
];

async function storeBlobs(facade, count) {
  const digests = [];
  for (let index = 0; index < count; index += 1) {
    const result = await putContent(facade, BASE_DIR, `blob-${index}`);
    assert.equal(result.ok, true);
    digests.push(result.digest);
  }
  return digests;
}

function generationReferencing(generationId, artifactDigest) {
  return buildGenerationRecord({
    generationId,
    createdAt: NOW,
    plugins: [{
      publisher_id: 'acme',
      plugin_id: 'alpha',
      display_name: 'Plugin alpha',
      resolved_version: '1.0.0',
      publisher_key_id: 'c'.repeat(64),
      artifact_digest: artifactDigest,
      desired_state: 'installed_disabled',
      effective_state: 'installed_disabled',
      depends_on: [],
    }],
    policyGrantRef: POLICY_GRANT_REF,
    dataSchemaRefs: [],
  });
}

test('a digest reachable through ONLY a live lease is never collected', async () => {
  const facade = createMemoryFsFacade();
  const [activeDigest, leasedDigest, orphanDigest] = await storeBlobs(facade, 3);

  const reachable = computeReachableDigests({
    activeGeneration: generationReferencing('gen-active', activeDigest),
    liveLeaseDigests: [leasedDigest],
  });

  const plan = await planGarbageCollection(facade, BASE_DIR, { reachableDigests: reachable });
  assert.ok(plan.toKeep.includes(leasedDigest), 'a live-lease reference must keep its content');
  assert.equal(plan.toDelete.includes(leasedDigest), false, 'GC must never collect a leased generation');
  assert.deepEqual(plan.toDelete, [orphanDigest]);

  const executed = await executeGarbageCollection(facade, BASE_DIR, { plan });
  assert.deepEqual(executed.removed, [orphanDigest]);
  assert.deepEqual(executed.failed, []);

  const remaining = await listContentDigests(facade, BASE_DIR);
  assert.deepEqual(remaining.sort(), [activeDigest, leasedDigest].sort());
});

test('each reachability source alone is sufficient to protect a digest', async () => {
  for (const source of REACHABILITY_SOURCES) {
    const facade = createMemoryFsFacade();
    const [protectedDigest, orphanDigest] = await storeBlobs(facade, 2);

    const reachable = computeReachableDigests({ [source]: [protectedDigest] });
    const plan = await planGarbageCollection(facade, BASE_DIR, { reachableDigests: reachable });

    assert.equal(plan.toDelete.includes(protectedDigest), false, `${source} failed to protect its digest`);
    assert.ok(plan.toDelete.includes(orphanDigest), `${source} run should still collect the orphan`);
  }
});

test('retained generations keep their artifacts even when the active generation does not', async () => {
  const facade = createMemoryFsFacade();
  const [activeDigest, retainedDigest] = await storeBlobs(facade, 2);

  const reachable = computeReachableDigests({
    activeGeneration: generationReferencing('gen-active', activeDigest),
    retainedGenerations: [generationReferencing('gen-retained', retainedDigest)],
  });

  const plan = await planGarbageCollection(facade, BASE_DIR, { reachableDigests: reachable });
  assert.deepEqual(plan.toDelete, [], 'the health window keeps the prior generation reachable');
  assert.deepEqual(plan.toKeep.sort(), [activeDigest, retainedDigest].sort());
});

test('seeded randomized sweep: a planned deletion is never a reachable digest', async () => {
  // The invariant is a set-disjointness property, so drive it with many random
  // shapes rather than a handful of hand-picked ones. Seeded, so a failure
  // reproduces from its seed alone.
  for (let seed = 1; seed <= 60; seed += 1) {
    const rng = makeRng(seed);
    const facade = createMemoryFsFacade();
    const onDisk = await storeBlobs(facade, 6);

    const buckets = { stagedDigests: [], quarantineDigests: [], recoveryDigests: [], liveLeaseDigests: [] };
    const expectedReachable = new Set();
    for (const digest of onDisk) {
      if (rng() < 0.45) {
        const source = REACHABILITY_SOURCES[Math.floor(rng() * REACHABILITY_SOURCES.length) % REACHABILITY_SOURCES.length];
        buckets[source].push(digest);
        expectedReachable.add(digest);
      }
    }
    // Sometimes add an active generation referencing a random on-disk blob.
    let activeGeneration = null;
    if (rng() < 0.5) {
      const digest = onDisk[Math.floor(rng() * onDisk.length) % onDisk.length];
      activeGeneration = generationReferencing('gen-active', digest);
      expectedReachable.add(digest);
    }

    const reachable = computeReachableDigests({ activeGeneration, ...buckets });
    const plan = await planGarbageCollection(facade, BASE_DIR, { reachableDigests: reachable });

    for (const digest of plan.toDelete) {
      assert.equal(reachable.has(digest), false, `seed ${seed}: planned deletion of a reachable digest`);
      assert.equal(expectedReachable.has(digest), false, `seed ${seed}: planned deletion of a protected digest`);
    }
    assert.deepEqual(
      [...plan.toDelete, ...plan.toKeep].sort(),
      onDisk.slice().sort(),
      `seed ${seed}: the plan must partition exactly the on-disk set`
    );

    await executeGarbageCollection(facade, BASE_DIR, { plan });
    const remaining = new Set(await listContentDigests(facade, BASE_DIR));
    for (const digest of expectedReachable) {
      assert.ok(remaining.has(digest), `seed ${seed}: a protected digest was deleted`);
    }
  }
});

test('a lease taken between plan and execute still protects its digest', async () => {
  // The plan/execute split means the reachable set can move underneath a plan.
  // Every other test here freezes it, so the suite proved lease safety only for
  // leases that already existed at planning time -- never for one acquired in
  // the window where the plan is already a list of deletions.
  const facade = createMemoryFsFacade();
  const [keepDigest, lateLeaseDigest, orphanDigest] = await storeBlobs(facade, 3);

  const atPlanTime = computeReachableDigests({ liveLeaseDigests: [keepDigest] });
  const plan = await planGarbageCollection(facade, BASE_DIR, { reachableDigests: atPlanTime });
  assert.deepEqual(plan.toDelete.sort(), [lateLeaseDigest, orphanDigest].sort());

  // A runtime lease now references a digest the plan had already condemned.
  const atExecuteTime = computeReachableDigests({ liveLeaseDigests: [keepDigest, lateLeaseDigest] });
  const executed = await executeGarbageCollection(facade, BASE_DIR, {
    plan,
    reachableDigests: atExecuteTime,
  });

  assert.deepEqual(executed.removed, [orphanDigest], 'only the still-unreachable digest may be collected');
  assert.deepEqual(executed.skipped, [lateLeaseDigest], 'a newly leased digest must be skipped, not deleted');
  const remaining = await listContentDigests(facade, BASE_DIR);
  assert.deepEqual(remaining.sort(), [keepDigest, lateLeaseDigest].sort());
});

test('garbage collection converges: a second run has nothing left to plan', async () => {
  // Regression guard. removeContent deletes the blob but the facade cannot
  // remove the now-empty digest directory, so a directory-name-only listing
  // kept re-planning already-collected digests on every run.
  const facade = createMemoryFsFacade();
  const [keepDigest] = await storeBlobs(facade, 4);
  const reachable = computeReachableDigests({ liveLeaseDigests: [keepDigest] });

  const firstPlan = await planGarbageCollection(facade, BASE_DIR, { reachableDigests: reachable });
  assert.equal(firstPlan.toDelete.length, 3);
  const firstRun = await executeGarbageCollection(facade, BASE_DIR, { plan: firstPlan });
  assert.equal(firstRun.removed.length, 3);
  assert.deepEqual(firstRun.failed, []);

  const secondPlan = await planGarbageCollection(facade, BASE_DIR, { reachableDigests: reachable });
  assert.deepEqual(secondPlan.toDelete, [], 'a converged store has nothing left to collect');
  assert.deepEqual(secondPlan.toKeep, [keepDigest]);
});

test('planning never deletes anything by itself', async () => {
  const facade = createMemoryFsFacade();
  const onDisk = await storeBlobs(facade, 3);
  const plan = await planGarbageCollection(facade, BASE_DIR, { reachableDigests: new Set() });
  assert.deepEqual(plan.toDelete.sort(), onDisk.slice().sort());
  // Inspecting a plan must be side-effect free -- callers (and tests) rely on
  // being able to review a destructive plan before it runs.
  assert.deepEqual((await listContentDigests(facade, BASE_DIR)).sort(), onDisk.slice().sort());
});

test('an unknown digest in the reachable set does not resurrect or mask on-disk content', async () => {
  const facade = createMemoryFsFacade();
  const onDisk = await storeBlobs(facade, 2);
  const ghost = sha256Hex('never-stored');
  const plan = await planGarbageCollection(facade, BASE_DIR, { reachableDigests: new Set([ghost]) });
  assert.deepEqual(plan.toKeep, []);
  assert.deepEqual(plan.toDelete.sort(), onDisk.slice().sort());
});
