'use strict';

// Exhaustive breadth-first exploration of the lifecycle table to depth 7, per
// the Wave-0 decision to hand-roll model-based lifecycle testing rather than
// take a property-testing dependency.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bfsWalks,
  checkWalksAgainstMachine,
  assertDepthSufficient,
  checkSignalsNeverPromote,
  firstReachedDepth,
} = require('../../../tests/helpers/plugins/lifecycle-explorer');
const { STATES } = require('../../../services/plugins/lifecycle/state-machine');

const MAX_DEPTH = 7;

test('depth 7 is provably sufficient to reach every state', () => {
  const verdict = assertDepthSufficient('absent', MAX_DEPTH);
  assert.deepEqual(verdict.unreachable, [], 'every state must be reachable from absent');
  assert.deepEqual(verdict.tooDeep, [], 'no state may first appear deeper than the sweep');
  // Recorded so a future stage that lengthens the chain trips this instead of
  // silently under-exploring. The deepest state today is `disabling` at 5 hops
  // (absent -> staged -> installed_disabled -> preparing -> active -> disabling),
  // leaving depth 7 with two hops of margin.
  assert.equal(verdict.maxObservedDepth, 5);
});

test('exhaustive depth-7 sweep: every enumerated walk is accepted by the machine', () => {
  const walks = bfsWalks('absent', MAX_DEPTH);
  // The exact enumeration size is a property of the table, so pin it rather
  // than asserting a floor: an accidental early-exit in the enumerator OR a
  // silently added/removed transition both trip this instead of passing
  // vacuously. Depth 4/5/6/7 = 31/81/220/604 walks.
  assert.equal(walks.length, 604, 'exhaustive depth-7 walk count changed');
  const violations = checkWalksAgainstMachine(walks);
  assert.deepEqual(violations, [], 'no enumerated walk may be rejected by evaluateTransition');
});

test('exhaustive sweep visits every state and every table edge at least once', () => {
  const walks = bfsWalks('absent', MAX_DEPTH);
  const seenStates = new Set();
  const seenEdges = new Set();
  for (const walk of walks) {
    for (let index = 0; index < walk.length; index += 1) {
      seenStates.add(walk[index]);
      if (index > 0) seenEdges.add(`${walk[index - 1]}->${walk[index]}`);
    }
  }
  assert.deepEqual([...seenStates].sort(), STATES.slice().sort());

  const { TRANSITIONS } = require('../../../services/plugins/lifecycle/state-machine');
  const allEdges = [];
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) allEdges.push(`${from}->${to}`);
  }
  const unvisited = allEdges.filter((edge) => !seenEdges.has(edge));
  assert.deepEqual(unvisited, [], 'the sweep must exercise every edge in the table');
});

test('no walk reaches active without preparing immediately before it', () => {
  const walks = bfsWalks('absent', MAX_DEPTH);
  const violations = [];
  for (const walk of walks) {
    for (let index = 1; index < walk.length; index += 1) {
      if (walk[index] === 'active' && walk[index - 1] !== 'preparing') {
        violations.push(walk.join('->'));
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('no walk leaves quarantined except to installed_disabled or uninstalling', () => {
  const walks = bfsWalks('absent', MAX_DEPTH);
  const violations = [];
  for (const walk of walks) {
    for (let index = 1; index < walk.length; index += 1) {
      if (walk[index - 1] !== 'quarantined') continue;
      if (!['installed_disabled', 'uninstalling'].includes(walk[index])) {
        violations.push(walk.join('->'));
      }
    }
  }
  assert.deepEqual(violations, []);
});

test('external signals never promote authority from any state', () => {
  // Every state, not every position of every walk: the check does not depend on
  // the path taken to reach a state, and each signal is now driven through the
  // transition machine rather than only read off the classifier.
  assert.deepEqual(checkSignalsNeverPromote(), []);
});

test('first-reached depths are stable and recorded', () => {
  const depths = Object.fromEntries([...firstReachedDepth('absent').entries()].sort());
  assert.deepEqual(depths, {
    absent: 0,
    active: 4,
    blocked: 3,
    disabling: 5,
    installed_disabled: 2,
    preparing: 3,
    quarantined: 2,
    staged: 1,
    uninstalling: 3,
  });
});
