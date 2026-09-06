const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSessionPreferencesPatch } = require('../services/backend/session-preferences-patch');

// run_mode is the canonical session-level Ask/Auto/Plan enum
// (docs/plans/COMPOSER_RUN_MODE_SPEC.md §2-§3). plan_mode stays on the record
// as a derived compatibility field; the patch builder is the single write-time
// authority that keeps the two in sync and captures/restores the pre-plan mode.

test('run_mode passthrough normalizes to the closed enum and derives plan_mode', () => {
  assert.deepEqual(
    buildSessionPreferencesPatch({ run_mode: 'auto' }, {}),
    { run_mode: 'auto', plan_mode: false }
  );
  assert.deepEqual(
    buildSessionPreferencesPatch({ run_mode: 'ask' }, {}),
    { run_mode: 'ask', plan_mode: false }
  );
});

test('run_mode tolerates case and whitespace', () => {
  const patch = buildSessionPreferencesPatch({ run_mode: ' Auto ' }, {});
  assert.equal(patch.run_mode, 'auto');
  assert.equal(patch.plan_mode, false);
});

test('invalid run_mode values fall back to ask', () => {
  for (const value of ['garbage', '', 42, null, { nested: true }, ['auto']]) {
    const patch = buildSessionPreferencesPatch({ run_mode: value }, {});
    assert.equal(patch.run_mode, 'ask', `value ${JSON.stringify(value)} falls back to ask`);
    assert.equal(patch.plan_mode, false);
  }
});

test('entering plan captures the pre-plan mode on the record patch', () => {
  assert.deepEqual(
    buildSessionPreferencesPatch({ run_mode: 'plan' }, { run_mode: 'auto' }),
    { run_mode: 'plan', plan_mode: true, pre_plan_run_mode: 'auto' }
  );
  // A record with no run_mode yet is an ask-mode record.
  assert.deepEqual(
    buildSessionPreferencesPatch({ run_mode: 'plan' }, {}),
    { run_mode: 'plan', plan_mode: true, pre_plan_run_mode: 'ask' }
  );
});

test('re-asserting plan while already in plan preserves the stored pre-plan mode', () => {
  const patch = buildSessionPreferencesPatch(
    { run_mode: 'plan' },
    { run_mode: 'plan', pre_plan_run_mode: 'auto' }
  );
  assert.equal(patch.run_mode, 'plan');
  assert.equal(patch.plan_mode, true);
  assert.ok(!('pre_plan_run_mode' in patch), 'stored pre-plan mode is not overwritten');
});

test('an explicit run_mode write wins over a conflicting plan_mode in the same patch', () => {
  assert.deepEqual(
    buildSessionPreferencesPatch({ run_mode: 'auto', plan_mode: true }, {}),
    { run_mode: 'auto', plan_mode: false }
  );
});

test('an explicit run_mode exit from plan clears the captured pre-plan mode', () => {
  assert.deepEqual(
    buildSessionPreferencesPatch(
      { run_mode: 'auto', plan_mode: false },
      { run_mode: 'plan', plan_mode: true, pre_plan_run_mode: 'ask' }
    ),
    { run_mode: 'auto', plan_mode: false, pre_plan_run_mode: '' }
  );
});

test('legacy plan_mode:true writes map to run_mode plan and capture pre-plan', () => {
  assert.deepEqual(
    buildSessionPreferencesPatch({ plan_mode: true }, { run_mode: 'auto' }),
    { plan_mode: true, run_mode: 'plan', pre_plan_run_mode: 'auto' }
  );
});

test('legacy plan_mode:false writes restore the stored pre-plan mode', () => {
  assert.deepEqual(
    buildSessionPreferencesPatch(
      { plan_mode: false },
      { run_mode: 'plan', pre_plan_run_mode: 'auto' }
    ),
    { plan_mode: false, run_mode: 'auto', pre_plan_run_mode: '' }
  );
});

test('legacy plan_mode:false without a stored pre-plan mode falls back to ask', () => {
  assert.deepEqual(
    buildSessionPreferencesPatch({ plan_mode: false }, { run_mode: 'plan' }),
    { plan_mode: false, run_mode: 'ask', pre_plan_run_mode: '' }
  );
  // Old session record shape: plan_mode boolean only, no run_mode at all.
  assert.deepEqual(
    buildSessionPreferencesPatch({ plan_mode: false }, { plan_mode: true }),
    { plan_mode: false, run_mode: 'ask', pre_plan_run_mode: '' }
  );
});

test('a routine plan_mode:false echo while not in plan leaves run_mode untouched', () => {
  // Every model/effort save re-sends the full pref set including
  // plan_mode:false (toPersistedPreferences in renderer-activity-prefs-utils);
  // that echo must not stomp a session sitting in Auto back to Ask.
  assert.deepEqual(
    buildSessionPreferencesPatch({ plan_mode: false }, { run_mode: 'auto' }),
    { plan_mode: false }
  );
  assert.deepEqual(
    buildSessionPreferencesPatch({ plan_mode: false }, {}),
    { plan_mode: false }
  );
});

test('pre_plan_run_mode is derived state, never caller-writable', () => {
  assert.deepEqual(buildSessionPreferencesPatch({ pre_plan_run_mode: 'auto' }, {}), {});
});

test('patches without mode keys stay mode-free and other passthrough keys survive', () => {
  assert.deepEqual(buildSessionPreferencesPatch({}, {}), {});
  assert.deepEqual(
    buildSessionPreferencesPatch({ preferred_model: 'ornith:9b' }, {}),
    { preferred_model: 'ornith:9b' }
  );
});

test('record argument is optional for legacy callers', () => {
  assert.deepEqual(
    buildSessionPreferencesPatch({ run_mode: 'auto' }),
    { run_mode: 'auto', plan_mode: false }
  );
});
