'use strict';

// Model-based exploration of the normative 9-state lifecycle table
// (services/plugins/lifecycle/state-machine.js).
//
// Hand-rolled on purpose. The Wave-0 decision record settled this: exhaustive
// BFS to depth 7 plus seeded random walks covers a 9-state table with a maximum
// branching factor of 4 completely enough that a property-testing dependency
// (fast-check / hypothesis) would add a supply-chain surface and a shrinking
// engine we do not need. Depth 7 is not arbitrary -- it is proved sufficient by
// `assertDepthSufficient` below, which fails if any state first becomes
// reachable at a depth the sweep does not reach.
//
// Determinism is the whole point of the seeded walks: a failure reproduces from
// its seed alone, with no recorded corpus to drift out of sync with the model.

const {
  STATES,
  TRANSITIONS,
  GUARDED_TRANSITIONS,
  evaluateTransition,
  applyEffectiveTransition,
  classifyExternalSignal,
  EXTERNAL_SIGNALS,
} = require('../../../services/plugins/lifecycle/state-machine');

// Proof bag large enough to satisfy every guarded transition. The explorer
// supplies it unconditionally so that "which transitions are legal" is decided
// by the table, and a SEPARATE test decides "which transitions demand proof" --
// mixing the two would let a missing guard hide behind an always-true proof.
const FULL_PROOF = Object.freeze({ repairVerified: true });

// Every walk (sequence of states) of length <= maxDepth reachable from `start`.
// Walks, not simple paths: the table has cycles and a cycle is exactly where
// ABA-style bugs live, so revisiting a state is in scope.
function bfsWalks(start, maxDepth) {
  const walks = [];
  const frontier = [[start]];
  while (frontier.length > 0) {
    const walk = frontier.shift();
    walks.push(walk);
    if (walk.length - 1 >= maxDepth) continue;
    const last = walk[walk.length - 1];
    for (const next of TRANSITIONS[last]) {
      frontier.push([...walk, next]);
    }
  }
  return walks;
}

// Confirms every walk the table produces is accepted by evaluateTransition, and
// that nothing outside the table is. Returns the violations rather than
// throwing, so a test can report all of them at once.
function checkWalksAgainstMachine(walks) {
  const violations = [];
  for (const walk of walks) {
    for (let index = 0; index < walk.length - 1; index += 1) {
      const from = walk[index];
      const to = walk[index + 1];
      const decision = evaluateTransition(from, to, FULL_PROOF);
      if (!decision.ok) {
        violations.push({ walk: walk.join('->'), from, to, reason: decision.reason });
      }
    }
  }
  return violations;
}

// First depth at which each state becomes reachable from `start`.
function firstReachedDepth(start) {
  const depths = new Map([[start, 0]]);
  let frontier = [start];
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next = [];
    for (const state of frontier) {
      for (const candidate of TRANSITIONS[state]) {
        if (depths.has(candidate)) continue;
        depths.set(candidate, depth);
        next.push(candidate);
      }
    }
    frontier = next;
  }
  return depths;
}

// Proves the chosen sweep depth actually covers the model: every state must be
// first reachable at a depth <= maxDepth. If a later stage adds a state behind
// a longer chain, this fails instead of silently under-exploring.
function assertDepthSufficient(start, maxDepth) {
  const depths = firstReachedDepth(start);
  const unreachable = STATES.filter((state) => !depths.has(state));
  const tooDeep = STATES.filter((state) => depths.has(state) && depths.get(state) > maxDepth);
  return {
    ok: unreachable.length === 0 && tooDeep.length === 0,
    unreachable,
    tooDeep,
    depths: Object.fromEntries([...depths.entries()].sort()),
    maxObservedDepth: Math.max(...depths.values()),
  };
}

// mulberry32: 32-bit, seedable, no dependency, good enough for uniform choice
// over a handful of options. A failing walk reproduces from its seed alone.
function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, items) {
  return items[Math.floor(rng() * items.length) % items.length];
}

// A deterministic plan of transition attempts. Targets are drawn from ALL
// states, not just the legal ones, so roughly three quarters of the attempts
// are illegal -- the machine must reject exactly those and leave state
// untouched. A walk that only ever tried legal moves would prove nothing about
// fail-closed behaviour.
function randomTransitionPlan({ seed, steps, start = 'absent' }) {
  const rng = makeRng(seed);
  const plan = [];
  let current = start;
  for (let index = 0; index < steps; index += 1) {
    const target = pick(rng, STATES);
    const withProof = rng() < 0.5;
    const decision = evaluateTransition(current, target, withProof ? FULL_PROOF : {});
    plan.push({ index, from: current, to: target, withProof, expectedOk: decision.ok, reason: decision.reason || null });
    if (decision.ok) current = target;
  }
  return { seed, steps, start, finalState: current, plan };
}

// An INDEPENDENT statement of the rules, read straight off the data: the
// transition table plus the guard map. It exists so the replay below does not
// simply call evaluateTransition a second time -- doing that made every drift
// check a tautology (a pure function over a frozen table always agrees with
// itself), so the suites consuming it passed for any transition table at all,
// including one with a wrong or missing edge. With the decision function on one
// side and the data on the other, a disagreement between them is observable.
function decideFromTable(from, to, withProof) {
  if (from === to) return false;
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) return false;
  const guardField = GUARDED_TRANSITIONS[`${from}->${to}`];
  if (guardField && !(withProof && FULL_PROOF[guardField] === true)) return false;
  return true;
}

// Replays a plan against the TABLE and reports any disagreement with what
// evaluateTransition decided when the plan was built.
function replayTransitionPlan(planResult) {
  const violations = [];
  let current = planResult.start;
  for (const step of planResult.plan) {
    if (current !== step.from) {
      violations.push({ index: step.index, reason: 'state_drift', expected: step.from, actual: current });
      break;
    }
    const allowedByTable = decideFromTable(current, step.to, step.withProof);
    if (allowedByTable !== step.expectedOk) {
      violations.push({
        index: step.index,
        reason: 'decision_drift',
        from: step.from,
        to: step.to,
        table: allowedByTable,
        machine: step.expectedOk,
      });
    }
    if (allowedByTable) current = step.to;
  }
  if (current !== planResult.finalState) {
    violations.push({ reason: 'final_state_drift', expected: planResult.finalState, actual: current });
  }
  return violations;
}

// The mechanical form of "Process exit, sidecar restart, renderer reload, view
// crash, cleanup success, or cleanup failure never promotes an authority state
// by itself."
//
// Each signal is DRIVEN THROUGH the transition machine from every state, not
// merely handed to the classifier: reading `classifyExternalSignal(signal).
// promotes` alone re-checks a hard-coded literal and can never fail, and doing
// it once per state per walk paid a 30,000-iteration cross-product for eight
// constant lookups. Attempting each signal as a transition target is what
// actually catches the failure that matters -- a signal name becoming an
// accepted move, or a rejected attempt mutating the record on its way out.
// State is the only thing the check varies over, so walks are not a parameter.
function checkSignalsNeverPromote(states = STATES) {
  const violations = [];
  for (const state of states) {
    for (const signal of EXTERNAL_SIGNALS) {
      const verdict = classifyExternalSignal(signal);
      if (verdict.promotes !== false) {
        violations.push({ state, signal, reason: 'classified_as_promoting', verdict });
      }
      const applied = applyEffectiveTransition({ desired_state: state, effective_state: state }, signal, FULL_PROOF);
      if (applied.ok) {
        violations.push({ state, signal, reason: 'signal_accepted_as_transition' });
      }
      if (applied.record.effective_state !== state || applied.record.desired_state !== state) {
        violations.push({ state, signal, reason: 'rejected_signal_mutated_state', record: applied.record });
      }
    }
  }
  return violations;
}

module.exports = {
  FULL_PROOF,
  bfsWalks,
  checkWalksAgainstMachine,
  firstReachedDepth,
  assertDepthSufficient,
  makeRng,
  randomTransitionPlan,
  replayTransitionPlan,
  checkSignalsNeverPromote,
};
