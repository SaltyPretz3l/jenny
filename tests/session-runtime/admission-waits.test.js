'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AdmissionWaits } = require('../../services/session-runtime/admission-waits');

function blocker(sessionId, quarantinedAt = null) {
  return Object.freeze({ session_id: sessionId, quarantined_at: quarantinedAt });
}

test('wait reasons distinguish live work from fully quarantined cleanup', () => {
  let now = 100;
  const waits = new AdmissionWaits({ now: () => now });
  waits.note('session', { status: 'waiting', reason: 'session_busy',
    blockers: [blocker('session_live'), blocker('session_old', 50)] });
  assert.deepEqual(waits.get('session'), {
    reason: 'session_busy', since: 100, blocking_session_id: 'session_live',
  });

  now = 200;
  waits.note('model', { status: 'waiting', reason: 'lane_capacity',
    blockers: [blocker('session_old', 50), blocker('session_live')] });
  assert.deepEqual(waits.get('model'), {
    reason: 'model_busy', since: 200, blocking_session_id: 'session_live',
  });

  waits.note('switch', { status: 'waiting', reason: 'runtime_model_switch_busy', blockers: [blocker('session_live')] });
  assert.deepEqual(waits.get('switch'), {
    reason: 'model_busy', since: 200, blocking_session_id: 'session_live',
  });

  waits.note('cleanup', { status: 'waiting', reason: 'downstream_capacity',
    blockers: [blocker('session_first', 80), blocker('session_earliest', 40)] });
  assert.deepEqual(waits.get('cleanup'), {
    reason: 'cleanup_unconfirmed', since: 40, blocking_session_id: 'session_first',
  });
  assert.equal(Object.isFrozen(waits.get('cleanup')), true);
});

test('unchanged reasons preserve since, changed reasons reset it, and unknown waits clear', () => {
  let now = 10;
  const waits = new AdmissionWaits({ now: () => now });
  waits.note('work', { status: 'waiting', reason: 'session_busy', blockers: [] });
  now = 20;
  waits.note('work', { status: 'waiting', reason: 'session_busy', blockers: [] });
  assert.equal(waits.get('work').since, 10);
  now = 30;
  waits.note('work', { status: 'waiting', reason: 'downstream_capacity', blockers: [] });
  assert.deepEqual(waits.get('work'), {
    reason: 'model_busy', since: 30, blocking_session_id: null,
  });
  waits.note('work', { status: 'waiting', reason: 'runtime_disabled',
    blockers: [blocker('quarantined', 5)] });
  assert.equal(waits.get('work'), null);
  waits.note('work', { status: 'waiting', reason: 'session_busy', blockers: [] });
  waits.clear('work');
  assert.equal(waits.get('work'), null);
});

test('the oldest wait is discarded when the bound is exceeded', () => {
  let now = 0;
  const waits = new AdmissionWaits({ now: () => ++now, max: 2 });
  for (const workId of ['one', 'two', 'three']) {
    waits.note(workId, { status: 'waiting', reason: 'session_busy', blockers: [] });
  }
  assert.equal(waits.get('one'), null);
  assert.equal(waits.get('two').since, 2);
  assert.equal(waits.get('three').since, 3);
});

test('a blocker id the projection would refuse is recorded as unknown, not copied', () => {
  const waits = new AdmissionWaits({ now: () => 1 });
  waits.note('work', { status: 'waiting', reason: 'lane_capacity', blockers: [blocker('lane:scoped:id')] });
  assert.deepEqual(waits.get('work'), { reason: 'model_busy', since: 1, blocking_session_id: null });
  waits.note('stuck', { status: 'waiting', reason: 'session_busy', blockers: [blocker('x'.repeat(200), 7)] });
  assert.deepEqual(waits.get('stuck'), { reason: 'cleanup_unconfirmed', since: 7, blocking_session_id: null });
});
