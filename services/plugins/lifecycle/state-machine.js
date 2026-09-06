'use strict';

// The normative 9-state authority machine, transcribed from
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md "Normative lifecycle state machine".
// Pure data + pure guards: no I/O, no clock, no facade. Everything durable that
// this machine gates lives in services/plugins/store/; this module only answers
// "is this transition legal, and under what proof?".
//
// Three normative properties are mechanized here rather than left to review:
//
//   1. `desired_state` (user/admin intent) and `effective_state` (what the
//      committed generation can actually serve) are separate values. They are
//      "never inferred from process liveness alone", so this module exposes no
//      function that derives either one from a runtime signal.
//   2. `quarantined -> installed_disabled` is legal ONLY with explicit repair or
//      re-trust proof. Every other exit from quarantine is `uninstalling`.
//      evaluateTransition() therefore takes a proof bag, not just two states.
//   3. "Process exit, sidecar restart, renderer reload, view crash, cleanup
//      success, or cleanup failure never promotes an authority state by itself."
//      classifyExternalSignal() encodes that as a total function returning
//      `promotes: false` for every known signal -- a signal can request
//      reconciliation, never an authority change (PLUG-D17: cleanup is
//      orthogonal to authority).
//
// Invalid transitions return a bounded structured result and never mutate
// anything; there is nothing here to mutate, which is the point.

const STATES = Object.freeze([
  'absent',
  'staged',
  'installed_disabled',
  'preparing',
  'active',
  'disabling',
  'blocked',
  'quarantined',
  'uninstalling',
]);

const STATE_SET = new Set(STATES);

// Allowed next states, verbatim from the architecture doc's table.
const TRANSITIONS = Object.freeze({
  absent: Object.freeze(['staged']),
  staged: Object.freeze(['installed_disabled', 'absent', 'quarantined']),
  installed_disabled: Object.freeze(['preparing', 'uninstalling', 'blocked', 'quarantined']),
  preparing: Object.freeze(['active', 'installed_disabled', 'blocked', 'quarantined']),
  active: Object.freeze(['disabling', 'preparing', 'blocked', 'quarantined']),
  disabling: Object.freeze(['installed_disabled', 'blocked', 'quarantined']),
  blocked: Object.freeze(['preparing', 'installed_disabled', 'uninstalling', 'quarantined']),
  quarantined: Object.freeze(['installed_disabled', 'uninstalling']),
  uninstalling: Object.freeze(['absent']),
});

// States in which a contribution may admit work. Exactly one: the doc's
// `active` row ("Committed generation may admit contribution work"). Kept as a
// set rather than an `=== 'active'` comparison so a future stage that adds an
// admitting state has one place to change and one place to test.
const ADMITTING_STATES = Object.freeze(new Set(['active']));

// Transitions that require an explicit proof beyond "the table allows it".
// Keyed `${from}->${to}`; the value is the proof field that must be true.
const GUARDED_TRANSITIONS = Object.freeze({
  'quarantined->installed_disabled': 'repairVerified',
});

// Runtime events that are NOT authority transitions. Each may trigger
// reconciliation or a cleanup-record update; none may change authority state.
const EXTERNAL_SIGNALS = Object.freeze([
  'process_exit',
  'sidecar_restart',
  'renderer_reload',
  'view_crash',
  'host_crash',
  'cleanup_succeeded',
  'cleanup_failed',
  'cleanup_pending_restart',
]);

const EXTERNAL_SIGNAL_SET = new Set(EXTERNAL_SIGNALS);

function isState(value) {
  return typeof value === 'string' && STATE_SET.has(value);
}

function allowedNextStates(from) {
  return isState(from) ? TRANSITIONS[from] : [];
}

// The single decision function. Returns a bounded structured result -- never
// throws, never mutates -- because an invalid transition is an ordinary
// fail-closed outcome (a stale caller, a replayed request), not a crash.
//
// `proof` carries the explicit evidence a guarded transition requires, e.g.
// { repairVerified: true } for quarantine release. Proof is never inferred.
function evaluateTransition(from, to, proof = {}) {
  if (!isState(from)) {
    return { ok: false, reason: 'unknown_from_state', detail: { from: String(from) } };
  }
  if (!isState(to)) {
    return { ok: false, reason: 'unknown_to_state', detail: { to: String(to) } };
  }
  if (from === to) {
    return { ok: false, reason: 'no_op_transition', detail: { from, to } };
  }
  if (!TRANSITIONS[from].includes(to)) {
    return {
      ok: false,
      reason: 'illegal_transition',
      detail: { from, to, allowed: [...TRANSITIONS[from]] },
    };
  }
  const guardField = GUARDED_TRANSITIONS[`${from}->${to}`];
  if (guardField && proof[guardField] !== true) {
    return {
      ok: false,
      reason: 'transition_proof_required',
      detail: { from, to, requires: guardField },
    };
  }
  return { ok: true, from, to };
}

// Applies a transition to a plain {desired_state, effective_state} pair. The
// two move independently: a caller commits intent (`desired`) and separately
// commits what the generation can serve (`effective`). This function refuses to
// couple them, which is what keeps "never inferred from process liveness alone"
// true by construction rather than by discipline.
function applyEffectiveTransition(record, to, proof = {}) {
  const decision = evaluateTransition(record.effective_state, to, proof);
  if (!decision.ok) {
    return { ok: false, reason: decision.reason, detail: decision.detail, record };
  }
  return {
    ok: true,
    record: { desired_state: record.desired_state, effective_state: to },
  };
}

// Total function over the runtime-signal vocabulary. Every known signal returns
// promotes:false; an unknown signal fails closed the same way. There is
// deliberately no branch that can return promotes:true -- the architecture's
// "never promotes an authority state by itself" is therefore checkable by
// reading nine lines instead of auditing every call site.
function classifyExternalSignal(signal) {
  const known = typeof signal === 'string' && EXTERNAL_SIGNAL_SET.has(signal);
  return {
    signal: String(signal),
    known,
    promotes: false,
    // A cleanup signal may update the orthogonal cleanup record (PLUG-D17);
    // a liveness signal may only ask recovery to reconcile.
    effect: known && signal.startsWith('cleanup_') ? 'cleanup_record_only' : 'reconcile_only',
  };
}

function admitsContributionWork(effectiveState) {
  return ADMITTING_STATES.has(effectiveState);
}

// Breadth-first reachability from `start`, bounded by `maxDepth`. Used by the
// W4 explorer to prove the table is fully connected from `absent` and that no
// unexpected state is reachable; exported here (rather than living in the test)
// so the reachability definition and the transition table cannot drift apart.
function reachableStates(start, maxDepth) {
  if (!isState(start)) return [];
  const seen = new Set([start]);
  let frontier = [start];
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next = [];
    for (const state of frontier) {
      for (const candidate of TRANSITIONS[state]) {
        if (seen.has(candidate)) continue;
        seen.add(candidate);
        next.push(candidate);
      }
    }
    frontier = next;
  }
  return [...seen].sort();
}

module.exports = {
  STATES,
  TRANSITIONS,
  ADMITTING_STATES,
  GUARDED_TRANSITIONS,
  EXTERNAL_SIGNALS,
  isState,
  allowedNextStates,
  evaluateTransition,
  applyEffectiveTransition,
  classifyExternalSignal,
  admitsContributionWork,
  reachableStates,
};
