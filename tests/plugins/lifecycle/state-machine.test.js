'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATES,
  TRANSITIONS,
  evaluateTransition,
  applyEffectiveTransition,
  classifyExternalSignal,
  admitsContributionWork,
  allowedNextStates,
  reachableStates,
  EXTERNAL_SIGNALS,
} = require('../../../services/plugins/lifecycle/state-machine');

test('the table matches the architecture doc row for row', () => {
  assert.deepEqual(STATES.slice().sort(), [
    'absent', 'active', 'blocked', 'disabling', 'installed_disabled',
    'preparing', 'quarantined', 'staged', 'uninstalling',
  ]);
  assert.deepEqual([...TRANSITIONS.absent], ['staged']);
  assert.deepEqual([...TRANSITIONS.staged], ['installed_disabled', 'absent', 'quarantined']);
  assert.deepEqual([...TRANSITIONS.uninstalling], ['absent']);
  // "quarantined -> installed_disabled only after explicit repair/re-trust, or uninstalling"
  assert.deepEqual([...TRANSITIONS.quarantined], ['installed_disabled', 'uninstalling']);
});

test('every state is reachable from absent and every transition target is a known state', () => {
  assert.deepEqual(reachableStates('absent', 9), STATES.slice().sort());
  for (const [from, targets] of Object.entries(TRANSITIONS)) {
    for (const to of targets) {
      assert.ok(STATES.includes(to), `${from} -> ${to} targets an unknown state`);
    }
  }
});

test('illegal transitions fail closed with a bounded result and never mutate', () => {
  const record = { desired_state: 'active', effective_state: 'installed_disabled' };
  const decision = applyEffectiveTransition(record, 'active');
  assert.equal(decision.ok, false);
  assert.equal(decision.reason, 'illegal_transition');
  // installed_disabled -> active is not an edge; only preparing -> active is.
  assert.deepEqual(decision.detail.allowed, [...TRANSITIONS.installed_disabled]);
  assert.deepEqual(decision.record, record, 'the input record must be untouched');
});

test('active is only enterable from preparing (the admission fence)', () => {
  const enteringActive = Object.entries(TRANSITIONS)
    .filter(([, targets]) => targets.includes('active'))
    .map(([from]) => from);
  assert.deepEqual(enteringActive, ['preparing']);
});

test('absent is only enterable from uninstalling or staged rejection', () => {
  const enteringAbsent = Object.entries(TRANSITIONS)
    .filter(([, targets]) => targets.includes('absent'))
    .map(([from]) => from)
    .sort();
  assert.deepEqual(enteringAbsent, ['staged', 'uninstalling']);
});

test('quarantine release requires explicit repair proof; uninstall does not', () => {
  const withoutProof = evaluateTransition('quarantined', 'installed_disabled');
  assert.equal(withoutProof.ok, false);
  assert.equal(withoutProof.reason, 'transition_proof_required');
  assert.equal(withoutProof.detail.requires, 'repairVerified');

  const withProof = evaluateTransition('quarantined', 'installed_disabled', { repairVerified: true });
  assert.equal(withProof.ok, true);

  // A falsy-but-present proof is not proof.
  assert.equal(evaluateTransition('quarantined', 'installed_disabled', { repairVerified: 'yes' }).ok, false);

  assert.equal(evaluateTransition('quarantined', 'uninstalling').ok, true);
});

test('unknown states and no-op transitions are rejected distinctly', () => {
  assert.equal(evaluateTransition('nope', 'active').reason, 'unknown_from_state');
  assert.equal(evaluateTransition('active', 'nope').reason, 'unknown_to_state');
  assert.equal(evaluateTransition('active', 'active').reason, 'no_op_transition');
  assert.deepEqual(allowedNextStates('nope'), []);
});

test('no external signal promotes an authority state', () => {
  for (const signal of EXTERNAL_SIGNALS) {
    const verdict = classifyExternalSignal(signal);
    assert.equal(verdict.promotes, false, `${signal} must never promote`);
    assert.equal(verdict.known, true);
  }
  // Cleanup signals may touch only the orthogonal cleanup record (PLUG-D17).
  assert.equal(classifyExternalSignal('cleanup_failed').effect, 'cleanup_record_only');
  assert.equal(classifyExternalSignal('process_exit').effect, 'reconcile_only');
  // An unknown signal fails closed the same way rather than defaulting open.
  const unknown = classifyExternalSignal('totally_made_up');
  assert.equal(unknown.known, false);
  assert.equal(unknown.promotes, false);
});

test('only active admits contribution work', () => {
  for (const state of STATES) {
    assert.equal(admitsContributionWork(state), state === 'active', `${state} admission`);
  }
});

test('desired and effective state move independently', () => {
  const record = { desired_state: 'active', effective_state: 'preparing' };
  const next = applyEffectiveTransition(record, 'blocked');
  assert.equal(next.ok, true);
  assert.equal(next.record.effective_state, 'blocked');
  assert.equal(next.record.desired_state, 'active', 'intent must survive an effective-state change');
});
