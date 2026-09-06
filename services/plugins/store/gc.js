'use strict';

// Lease-aware garbage collection ("Durable generation commit" step 7):
// "Garbage collection deletes only content unreachable from active, retained,
// staged, quarantine, recovery, or live-lease references." Runtime leases held
// by turns, approvals, hosts, views, workers, and deferred cleanup are
// first-class references, so a caller must fold every live-lease digest into
// the reachable set alongside the structural sources before anything is
// planned for deletion.
//
// This module never wires itself to a real runtime lease registry (Stage 2
// has none yet) -- callers pass every reachable-digest source as an explicit
// Set, keeping gc.js a pure reachability/plan/execute pipeline that Stage 3B
// can point at real data without changing this module's contract.
//
// Planning is deliberately separated from execution: `planGarbageCollection`
// never deletes anything, so a caller (or a test) can inspect exactly what
// would be removed before `executeGarbageCollection` acts on that plan.

const { listContentDigests, removeContent } = require('./content-store');

const GENERATION_DIGEST_FIELDS = Object.freeze([
  'artifact_digest',
  'package_record_digest',
  'source_trust_digest',
  'advisory_snapshot_digest',
  'data_snapshot_digest',
]);
const GENERATION_DIGEST_ARRAY_FIELDS = Object.freeze([
  'remote_binding_digests',
  'restricted_module_digests',
  'view_content_digests',
  'provider_descriptor_digests',
  'executable_object_digests',
  'full_host_binding_digests',
  'native_mcp_binding_digests',
  'session_provider_digests',
  'engine_adapter_digests',
  'hook_descriptor_digests',
  'containment_profile_digests',
  'build_provenance_digests',
]);

function collectDigestsFromGeneration(record) {
  if (!record || !Array.isArray(record.plugins)) return [];
  const digests = [];
  for (const entry of record.plugins) {
    for (const field of GENERATION_DIGEST_FIELDS) {
      if (entry[field]) digests.push(entry[field]);
    }
    for (const field of GENERATION_DIGEST_ARRAY_FIELDS) {
      for (const digest of entry[field] || []) digests.push(digest);
    }
  }
  return digests;
}

// Unions every reachable-digest source into one Set. `activeGeneration` and
// each entry of `retainedGenerations` are full PluginGenerationV1 records (or
// null/undefined, tolerated); the remaining sources are plain arrays/sets of
// sha256 digest strings supplied directly by the caller.
function computeReachableDigests({
  activeGeneration = null,
  retainedGenerations = [],
  stagedDigests = [],
  quarantineDigests = [],
  recoveryDigests = [],
  liveLeaseDigests = [],
} = {}) {
  const reachable = new Set();
  for (const digest of collectDigestsFromGeneration(activeGeneration)) reachable.add(digest);
  for (const generation of retainedGenerations) {
    for (const digest of collectDigestsFromGeneration(generation)) reachable.add(digest);
  }
  for (const digest of stagedDigests) reachable.add(digest);
  for (const digest of quarantineDigests) reachable.add(digest);
  for (const digest of recoveryDigests) reachable.add(digest);
  for (const digest of liveLeaseDigests) reachable.add(digest);
  return reachable;
}

async function planGarbageCollection(facade, baseDir, { reachableDigests }) {
  const onDisk = await listContentDigests(facade, baseDir);
  const toDelete = [];
  const toKeep = [];
  for (const digest of onDisk) {
    if (reachableDigests.has(digest)) {
      toKeep.push(digest);
    } else {
      toDelete.push(digest);
    }
  }
  // The plan carries the set it was computed against so execution can re-check
  // it even when a caller does not supply a fresher one.
  return { toDelete, toKeep, reachableDigests };
}

// Executes a previously computed plan. A single removal failure is recorded
// and skipped rather than aborting the whole run -- a partial GC failure must
// never leave the plan's remaining, otherwise-safe deletions un-applied.
//
// A plan is a SNAPSHOT, and runtime leases are first-class references that can
// appear at any moment: a turn, approval, host, view, worker, or deferred
// cleanup can take a reference to a digest that was genuinely unreachable when
// the plan was made. Replaying the plan blindly would then delete content that
// is live by the time the deletion runs, so `reachableDigests` is consulted
// again here, at the instant of deletion. Callers should pass a freshly
// computed set; omitting it falls back to the plan's own, which is no weaker
// than the previous behaviour.
async function executeGarbageCollection(facade, baseDir, { plan, reachableDigests = null }) {
  const liveNow = reachableDigests || plan.reachableDigests || null;
  const removed = [];
  const failed = [];
  const skipped = [];
  for (const digest of plan.toDelete) {
    if (liveNow && liveNow.has(digest)) {
      skipped.push(digest);
      continue;
    }
    try {
      await removeContent(facade, baseDir, digest);
      removed.push(digest);
    } catch (error) {
      failed.push({ digest, error: (error && error.message) || String(error) });
    }
  }
  return { removed, failed, skipped };
}

module.exports = {
  computeReachableDigests,
  planGarbageCollection,
  executeGarbageCollection,
};
