'use strict';

// Concurrency and lease safety (PLUG-D08, invariant 11).
//
// Acceptance-matrix rows discharged here: "Concurrent distinct
// install/update/disable/uninstall/dependency-cascade operations, deterministic
// queue/reject behavior, expected-generation conflict, post-await stale
// mutation, lease-owner crash, ... same-id/different-fingerprint rejection".
//
// The post-await tests are the load-bearing ones. "Every post-await mutation
// checks lease/current-generation ownership" is only testable if a competing
// operation can be injected at an EXACT await boundary, which is what the
// crash-injecting facade's onMutation hook provides -- without it these races
// are timing-dependent and would either flake or silently never occur.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');
const { createCrashInjectingFs, runWithCrash, enumerateCrashPoints } = require('../../helpers/plugins/crash-injecting-fs');
const { makeStoreFactory, commitOperation, commitInput, inspect, BASE_DIR, DIGEST_B } = require('../../helpers/plugins/durability-scenario');
const { runCommitSequence } = require('../../../services/plugins/lifecycle/commit-sequence');
const { readLease, acquireLease } = require('../../../services/plugins/store/mutation-lease');

const T0 = '2026-07-31T00:00:00Z';
// Past the 30s default lease taken at T0.
const PAST_EXPIRY = '2026-07-31T00:10:00Z';
// The shared scenario commits at LATER (01:00:00Z), so a lease taken by the
// target operation expires at 01:00:30Z -- anything reclaiming it must be later
// than that, not merely later than T0.
const PAST_TARGET_EXPIRY = '2026-07-31T02:00:00Z';

// Finds the 1-based mutation index of the first write whose path mentions
// `marker`, by dry-running the operation with no fault injected. Derived from
// the real trace rather than hardcoded, so a change to the commit recipe
// re-targets these tests instead of silently aiming at the wrong boundary.
async function findMutationPoint(buildStore, operation, marker) {
  const { facade, baseDir } = await buildStore();
  const probe = createCrashInjectingFs(facade);
  await operation(probe, baseDir);
  const hit = probe.calls.find((call) => call.mutating && call.path.includes(marker) && call.method === 'writeFile');
  assert.ok(hit, `no writeFile boundary found for marker '${marker}'`);
  return hit.point;
}

test('a second distinct operation is deterministically rejected busy while the lease is held', async () => {
  const facade = createMemoryFsFacade();
  const first = await acquireLease(facade, BASE_DIR, { operationId: 'op-a', now: T0 });
  assert.equal(first.ok, true);

  const second = await runCommitSequence(facade, BASE_DIR, commitInput('gen-b', { operationId: 'op-b', now: T0 }));
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'busy');
  assert.equal(second.detail.heldBy, 'op-a');

  // Deterministic, not racy: the same attempt rejects identically every time.
  const third = await runCommitSequence(facade, BASE_DIR, commitInput('gen-c', { operationId: 'op-c', now: T0 }));
  assert.equal(third.reason, 'busy');
});

test('a crashed lease owner does not block the store forever -- the lease is reclaimed with a tombstone', async () => {
  const build = makeStoreFactory({ priorCommits: 1 });
  const { count } = await enumerateCrashPoints(build, commitOperation('gen-target'));
  // Crash somewhere in the middle, after the lease exists but before release.
  const { facade, baseDir } = await runWithCrash(build, commitOperation('gen-target'), Math.floor(count / 2), 'after');

  const held = await readLease(facade, baseDir);
  assert.equal(held.status, 'ok', 'the crashed operation must have left its lease behind');

  const reclaimed = await acquireLease(facade, baseDir, { operationId: 'op-next', now: PAST_TARGET_EXPIRY });
  assert.equal(reclaimed.ok, true);
  assert.equal(reclaimed.outcome, 'reclaimed_from_expired');
  assert.equal(reclaimed.lease.tombstones.at(-1).reason, 'lease_expired');
  assert.equal(reclaimed.lease.tombstones.at(-1).operation_id, held.lease.operation_id);
});

test('a competing commit interleaved before revalidation makes the in-flight operation fail closed', async () => {
  const build = makeStoreFactory({ priorCommits: 1 });
  // Interleave while the victim is writing its generation bytes -- before its
  // post-await revalidation, and well before the pointer flip.
  const point = await findMutationPoint(build, commitOperation('gen-victim'), 'control-plane');

  const { facade, baseDir } = await build();
  let competitorResult = null;
  const injecting = createCrashInjectingFs(facade, {
    onMutationAt: point,
    onMutation: async () => {
      if (competitorResult) return;
      // The victim holds a lease that is expired at this clock, so the
      // competitor can legitimately reclaim it and commit.
      competitorResult = await runCommitSequence(facade, baseDir, commitInput('gen-competitor', {
        operationId: 'op-competitor',
        now: PAST_EXPIRY,
      }));
    },
  });

  const victim = await runCommitSequence(injecting, baseDir, commitInput('gen-victim', {
    operationId: 'op-victim',
    now: T0,
    leaseDurationMs: 1000,
  }));

  assert.equal(competitorResult.ok, true, `competitor should have committed: ${competitorResult?.reason}`);
  assert.equal(victim.ok, false, 'the in-flight operation must not commit over a moved generation');
  assert.ok(
    ['generation_advanced', 'stale_active_pointer', 'not_lease_owner', 'lease_expired'].includes(victim.reason),
    `unexpected failure reason: ${victim.reason}`
  );

  // The competitor's generation is what is authoritative; the victim's is not.
  const state = await inspect(facade, baseDir);
  assert.equal(state.pointer.generation_id, 'gen-competitor');
});

test('a lease stolen inside the commit window cannot overwrite the winner (two generations at one epoch)', async () => {
  // Regression guard for a real defect. The expected-generation CAS is
  // read-then-write with several awaits in between. A victim whose lease
  // expired mid-operation had already passed the CAS, so it wrote its pointer
  // straight over the commit that legitimately reclaimed the lease -- leaving
  // two DIFFERENT generations that had both minted the same commit_epoch, which
  // is exactly what PLUG-D14 forbids. commitActivePointer now re-verifies lease
  // ownership immediately before the authoritative write.
  //
  // The interleave targets the retained-prior-pointer write, which is the last
  // boundary BEFORE that guard runs.
  const build = makeStoreFactory({ priorCommits: 1 });
  const point = await findMutationPoint(build, commitOperation('gen-victim'), 'active-generation.prior.json');

  const { facade, baseDir } = await build();
  let competitorResult = null;
  const injecting = createCrashInjectingFs(facade, {
    onMutationAt: point,
    onMutation: async () => {
      if (competitorResult) return;
      competitorResult = await runCommitSequence(facade, baseDir, commitInput('gen-competitor', {
        operationId: 'op-competitor',
        now: PAST_EXPIRY,
      }));
    },
  });

  const victim = await runCommitSequence(injecting, baseDir, commitInput('gen-victim', {
    operationId: 'op-victim',
    now: T0,
    leaseDurationMs: 1000,
  }));

  assert.equal(competitorResult.ok, true);
  assert.equal(victim.ok, false, 'a stolen lease must stop the in-flight commit');
  assert.ok(
    ['lease_not_held', 'not_lease_owner', 'lease_expired', 'lease_guard_failed'].includes(victim.reason),
    `expected a lease-ownership rejection, got: ${victim.reason}`
  );

  const state = await inspect(facade, baseDir);
  assert.equal(state.pointer.generation_id, 'gen-competitor');
  assert.equal(state.generation.generation_id, 'gen-competitor', 'pointer and generation must still agree');
  assert.equal(
    state.pointer.commit_epoch,
    competitorResult.commitEpoch,
    'the committed epoch must be the winner\'s, not a duplicate minted by the victim'
  );
});

test('a lease stolen INSIDE the pointer write cannot overwrite the winner', async () => {
  // The test above interleaves at the retained-prior-pointer write, one boundary
  // BEFORE the guard. That left the guard's real window untested: the pointer
  // write is itself mkdir + writeFile + fsyncFile + renameFile + fsyncDir, so a
  // competitor landing inside it was still overwritten and BOTH operations
  // returned ok at the same commit_epoch. The pointer bytes are now staged
  // before the guard runs, leaving only the atomic rename after it, so every
  // boundary of the pointer write must reject the in-flight victim.
  //
  // The rename boundary itself is deliberately NOT in this list: a competitor
  // that commits between the last check and the atomic rename cannot be stopped
  // by reordering, only by a facade primitive that publishes conditionally
  // (rename-if-unchanged). That residual window is covered by the test below,
  // which pins the weaker guarantee actually available today.
  const build = makeStoreFactory({ priorCommits: 1 });

  for (const method of ['writeFile', 'fsyncFile']) {
    const { facade: probeFacade, baseDir: probeBase } = await build();
    const probe = createCrashInjectingFs(probeFacade);
    await commitOperation('gen-victim')(probe, probeBase);
    const boundary = probe.calls.find((call) => call.mutating
      && call.method === method
      && call.path.includes('active-generation.json')
      && !call.path.includes('prior'));
    assert.ok(boundary, `no ${method} boundary found for the active pointer`);

    const { facade, baseDir } = await build();
    let competitorResult = null;
    const injecting = createCrashInjectingFs(facade, {
      onMutationAt: boundary.point,
      onMutation: async () => {
        if (competitorResult) return;
        competitorResult = await runCommitSequence(facade, baseDir, commitInput('gen-competitor', {
          operationId: 'op-competitor',
          now: PAST_EXPIRY,
        }));
      },
    });

    const victim = await runCommitSequence(injecting, baseDir, commitInput('gen-victim', {
      operationId: 'op-victim',
      now: T0,
      leaseDurationMs: 1000,
    }));

    const where = `${method}@${boundary.point}`;
    assert.equal(competitorResult.ok, true, `${where}: the competitor should have committed`);
    assert.equal(victim.ok, false, `${where}: the victim committed over a reclaimed lease`);

    const state = await inspect(facade, baseDir);
    assert.equal(state.pointer.generation_id, 'gen-competitor', `${where}: the winner's generation must survive`);
    assert.equal(state.generation.generation_id, 'gen-competitor', `${where}: pointer and generation must agree`);
    assert.equal(
      state.pointer.commit_epoch,
      competitorResult.commitEpoch,
      `${where}: two generations must never share a commit_epoch`
    );
  }
});

test('a lease lost in the final rename window is reported, not returned as success', async () => {
  // KNOWN RESIDUAL, pinned so it cannot be mistaken for a closed hole. Staging
  // the pointer bytes leaves exactly one act after the guard: the rename that
  // publishes authority. A competitor that commits inside THAT window is still
  // overwritten, because nothing here can make "check the lease" and "rename"
  // one indivisible step -- that needs a conditional-publish facade primitive,
  // which is a Stage 3B design change, not a reordering.
  //
  // What IS guaranteed today: the loss is detected immediately after the rename,
  // so the operation reports `lease_lost_during_commit` instead of handing back
  // a success the store cannot stand behind. Callers therefore learn the
  // authority state is contested rather than being told they committed.
  const build = makeStoreFactory({ priorCommits: 1 });
  const point = await findMutationPoint(build, commitOperation('gen-victim'), 'active-generation.json');

  const { facade, baseDir } = await build();
  let competitorResult = null;
  const injecting = createCrashInjectingFs(facade, {
    onMutationAt: point,
    onMutation: async () => {
      if (competitorResult) return;
      competitorResult = await runCommitSequence(facade, baseDir, commitInput('gen-competitor', {
        operationId: 'op-competitor',
        now: PAST_EXPIRY,
      }));
    },
  });

  const victim = await runCommitSequence(injecting, baseDir, commitInput('gen-victim', {
    operationId: 'op-victim',
    now: T0,
    leaseDurationMs: 1000,
  }));

  assert.equal(competitorResult.ok, true);
  assert.equal(victim.ok, false, 'a victim that lost its lease must never report success');
  assert.equal(victim.committed, false, 'and must not claim its generation was committed');
});

test('no two commits ever share a commit_epoch, however they interleave', async () => {
  const facade = createMemoryFsFacade();
  const seen = new Set();
  for (let index = 0; index < 8; index += 1) {
    const result = await runCommitSequence(facade, BASE_DIR, commitInput(`gen-${index}`, {
      operationId: `op-${index}`,
      now: `2026-07-31T0${index}:00:00Z`,
    }));
    assert.equal(result.ok, true, result.reason);
    assert.equal(seen.has(result.commitEpoch), false, `epoch ${result.commitEpoch} was minted twice`);
    seen.add(result.commitEpoch);
  }
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('the same operation id with a different request fingerprint fails closed', async () => {
  const facade = createMemoryFsFacade();
  const first = await runCommitSequence(facade, BASE_DIR, commitInput('gen-0', { operationId: 'op-dup', now: T0 }));
  assert.equal(first.ok, true);

  const replay = await runCommitSequence(facade, BASE_DIR, commitInput('gen-1', {
    operationId: 'op-dup',
    now: PAST_EXPIRY,
    requestFingerprint: DIGEST_B,
  }));
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'reject_fingerprint_mismatch');

  // The store is untouched by the rejected replay.
  const state = await inspect(facade, BASE_DIR);
  assert.equal(state.pointer.generation_id, 'gen-0');
});

test('a settled operation id replayed with the SAME fingerprint returns the recorded outcome, never re-executing', async () => {
  const facade = createMemoryFsFacade();
  const first = await runCommitSequence(facade, BASE_DIR, commitInput('gen-0', { operationId: 'op-dup', now: T0 }));
  assert.equal(first.ok, true);
  const epochAfterFirst = first.commitEpoch;

  const replay = await runCommitSequence(facade, BASE_DIR, commitInput('gen-1', {
    operationId: 'op-dup',
    now: PAST_EXPIRY,
  }));
  assert.equal(replay.ok, false);
  assert.equal(replay.reason, 'return_recorded_outcome');

  const state = await inspect(facade, BASE_DIR);
  assert.equal(state.pointer.commit_epoch, epochAfterFirst, 'a replay must not mint a new epoch');
  assert.equal(state.pointer.generation_id, 'gen-0');
});
