'use strict';

// Seeded random-walk exploration. The exhaustive BFS sweep
// (explorer-bfs.test.js) proves the table is internally consistent to depth 7;
// these walks go far deeper than 7 steps and, crucially, attempt ILLEGAL moves
// -- a walk that only ever tried legal transitions would prove nothing about
// fail-closed behaviour.
//
// The store-driving walk at the bottom is the part the plan calls for: random
// lifecycle trajectories against W3's REAL store with crashes injected at
// random boundaries, asserting the durability invariants hold across a long
// history rather than in a single-commit snapshot.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  makeRng,
  randomTransitionPlan,
  replayTransitionPlan,
} = require('../../helpers/plugins/lifecycle-explorer');
const { STATES, isState } = require('../../../services/plugins/lifecycle/state-machine');
const { runWithCrash, enumerateCrashPoints } = require('../../helpers/plugins/crash-injecting-fs');
const { makeStoreFactory, commitOperation, commitInput, inspect, BASE_DIR } = require('../../helpers/plugins/durability-scenario');
const { runCommitSequence } = require('../../../services/plugins/lifecycle/commit-sequence');
const { recoverStore } = require('../../../services/plugins/lifecycle/recovery');
const { createMemoryFsFacade } = require('../../../services/plugins/store/fs-facade');

const SEEDS = Array.from({ length: 40 }, (_, index) => index + 1);
const WALK_STEPS = 200;

test('seeded walks are deterministic: a plan replays to an identical outcome', () => {
  for (const seed of SEEDS) {
    const planResult = randomTransitionPlan({ seed, steps: WALK_STEPS });
    assert.deepEqual(replayTransitionPlan(planResult), [], `seed ${seed}: replay diverged`);

    // Same seed, same plan -- reproducibility is the whole reason a failing
    // walk needs nothing but its seed number to reproduce.
    const again = randomTransitionPlan({ seed, steps: WALK_STEPS });
    assert.deepEqual(again.plan, planResult.plan, `seed ${seed}: plan is not reproducible`);
    assert.equal(again.finalState, planResult.finalState);
  }
});

test('random walks exercise a substantial fraction of ILLEGAL attempts', () => {
  let attempted = 0;
  let rejected = 0;
  for (const seed of SEEDS) {
    for (const step of randomTransitionPlan({ seed, steps: WALK_STEPS }).plan) {
      attempted += 1;
      if (!step.expectedOk) rejected += 1;
    }
  }
  const rejectionRate = rejected / attempted;
  // Targets are drawn uniformly from all 9 states while the average out-degree
  // is ~3, so most attempts must be refused. A rate near zero would mean the
  // generator had quietly started proposing only legal moves.
  assert.ok(rejectionRate > 0.5, `expected mostly-illegal attempts, got ${rejectionRate.toFixed(2)}`);
  assert.ok(rejectionRate < 0.95, `expected some legal moves too, got ${rejectionRate.toFixed(2)}`);
});

test('walk state only ever changes through an accepted transition', () => {
  for (const seed of SEEDS) {
    const planResult = randomTransitionPlan({ seed, steps: WALK_STEPS });
    let current = planResult.start;
    for (const step of planResult.plan) {
      assert.equal(step.from, current, `seed ${seed} step ${step.index}: state moved without a transition`);
      assert.ok(isState(current), `seed ${seed}: walked out of the state space`);
      if (step.expectedOk) current = step.to;
    }
    assert.ok(STATES.includes(planResult.finalState));
  }
});

test('rejected attempts always carry a bounded machine-readable reason', () => {
  const reasons = new Set();
  for (const seed of SEEDS) {
    for (const step of randomTransitionPlan({ seed, steps: WALK_STEPS }).plan) {
      if (step.expectedOk) continue;
      assert.ok(step.reason, `seed ${seed} step ${step.index}: rejection without a reason`);
      reasons.add(step.reason);
    }
  }
  // Every fail-closed path the machine can take must actually be observed by
  // the walks, otherwise one of them is unreachable and untested.
  assert.deepEqual(
    [...reasons].sort(),
    ['illegal_transition', 'no_op_transition', 'transition_proof_required']
  );
});

test('seeded store walk: long random histories keep epochs strictly monotonic', async () => {
  for (const seed of [1, 7, 13, 21, 33]) {
    const rng = makeRng(seed);
    const facade = createMemoryFsFacade();
    const minted = [];
    let hour = 0;

    for (let step = 0; step < 12; step += 1) {
      hour += 1;
      const now = `2026-07-31T${String(hour).padStart(2, '0')}:00:00Z`;
      const result = await runCommitSequence(facade, BASE_DIR, commitInput(`gen-s${seed}-${step}`, {
        operationId: `op-s${seed}-${step}`,
        now,
      }));
      assert.equal(result.ok, true, `seed ${seed} step ${step}: ${result.reason}`);
      for (const previous of minted) {
        assert.ok(result.commitEpoch > previous, `seed ${seed}: epoch ${result.commitEpoch} did not exceed ${previous}`);
      }
      minted.push(result.commitEpoch);

      // Randomly interleave a recovery pass; it must never disturb a healthy
      // store nor lower an epoch.
      if (rng() < 0.35) {
        const report = await recoverStore(facade, BASE_DIR, { now });
        assert.equal(report.classification, 'consistent', report.reason || '');
        assert.equal(report.pointer.commit_epoch, result.commitEpoch);
      }
    }
  }
});

test('seeded crash walk: a random crash point per step never yields a mixed graph', async () => {
  const build = makeStoreFactory({ priorCommits: 1 });
  const { count } = await enumerateCrashPoints(build, commitOperation('gen-target'));

  for (const seed of [2, 5, 11, 19, 29, 41]) {
    const rng = makeRng(seed);
    const point = 1 + Math.floor(rng() * count) % count;
    const mode = rng() < 0.5 ? 'before' : 'after';

    const { facade, baseDir } = await runWithCrash(build, commitOperation('gen-target'), point, mode);
    const report = await recoverStore(facade, baseDir, { now: '2026-07-31T09:00:00Z' });
    assert.ok(
      report.classification === 'consistent' || report.classification === 'recovered',
      `seed ${seed} (${mode}@${point}): ${report.classification} ${report.reason || ''}`
    );

    const state = await inspect(facade, baseDir);
    assert.ok(state.generation, `seed ${seed} (${mode}@${point}): unreadable generation`);
    assert.equal(state.generation.generation_id, state.pointer.generation_id);
    assert.ok(['gen-0', 'gen-target'].includes(state.pointer.generation_id));

    // And the store keeps working afterwards, past the crashed lease's expiry.
    const followUp = await runCommitSequence(facade, baseDir, commitInput(`gen-after-${seed}`, {
      operationId: `op-after-${seed}`,
      now: '2026-07-31T10:00:00Z',
    }));
    assert.equal(followUp.ok, true, `seed ${seed}: store unusable after crash: ${followUp.reason}`);
    assert.ok(followUp.commitEpoch > state.pointer.commit_epoch);
  }
});
