'use strict';

// Leaving Propose (row 35): with suggestions still waiting the switch asks Keep
// or Discard; Cancel keeps Propose; nothing is ever applied by the switch.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunModeHarness } = require('./helpers/run-mode-harness');

function bridge({ pending = 0, discard = { ok: true, discarded: 1 }, listThrows = false } = {}) {
  const calls = { list: [], discard: [] };
  return {
    calls,
    list(payload) {
      calls.list.push(payload);
      return listThrows ? Promise.reject(new Error('gone')) : Promise.resolve({ pending_count: pending });
    },
    discardPending(payload) {
      calls.discard.push(payload);
      return Promise.resolve(discard);
    },
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('nothing pending: leaving Propose switches without asking', async (t) => {
  const suggestedChanges = bridge({ pending: 0 });
  const harness = createRunModeHarness(t, { runMode: 'propose', currentSessionId: 'sess_a', suggestedChanges });
  assert.equal(await harness.control.setRunMode('ask'), true);
  assert.equal(harness.prefs.runMode, 'ask');
  assert.equal(harness.calls.choose.length, 0);
  assert.deepEqual(suggestedChanges.calls.list, [{ sessionId: 'sess_a' }]);
});

test('Keep switches and leaves the suggestions alone', async (t) => {
  const suggestedChanges = bridge({ pending: 2 });
  const harness = createRunModeHarness(t, {
    runMode: 'propose', currentSessionId: 'sess_a', suggestedChanges, choice: () => 'keep',
  });
  assert.equal(await harness.control.setRunMode('plan'), true);
  assert.equal(harness.prefs.runMode, 'plan');
  assert.equal(harness.calls.choose.length, 1);
  assert.deepEqual(harness.calls.choose[0].choices.map((choice) => choice.action), ['keep', 'discard']);
  assert.equal(harness.calls.choose[0].title, 'Leave Propose?');
  assert.equal(suggestedChanges.calls.discard.length, 0);
});

test('Discard rejects the pending suggestions, then switches', async (t) => {
  const suggestedChanges = bridge({ pending: 1 });
  const harness = createRunModeHarness(t, {
    runMode: 'propose', currentSessionId: 'sess_a', suggestedChanges, choice: () => 'discard',
  });
  assert.equal(await harness.control.setRunMode('auto'), true);
  assert.deepEqual(suggestedChanges.calls.discard, [{ sessionId: 'sess_a' }]);
  assert.equal(harness.prefs.runMode, 'auto');
});

test('Cancel stays in Propose', async (t) => {
  const suggestedChanges = bridge({ pending: 1 });
  const harness = createRunModeHarness(t, {
    runMode: 'propose', currentSessionId: 'sess_a', suggestedChanges, choice: () => 'cancel',
  });
  assert.equal(await harness.control.setRunMode('ask'), false);
  assert.equal(harness.prefs.runMode, 'propose');
  assert.equal(harness.calls.persistence.length, 0);
  assert.equal(suggestedChanges.calls.discard.length, 0);
});

test('a failed discard stays in Propose and says so', async (t) => {
  const suggestedChanges = bridge({ pending: 1, discard: { ok: false, error: 'write_failed' } });
  const harness = createRunModeHarness(t, {
    runMode: 'propose', currentSessionId: 'sess_a', suggestedChanges, choice: () => 'discard',
  });
  assert.equal(await harness.control.setRunMode('ask'), false);
  assert.equal(harness.prefs.runMode, 'propose');
  assert.equal(harness.calls.errors.length, 1);
});

test('an unreadable suggestion list keeps the suggestions and still switches', async (t) => {
  const suggestedChanges = bridge({ listThrows: true });
  const harness = createRunModeHarness(t, { runMode: 'propose', currentSessionId: 'sess_a', suggestedChanges });
  assert.equal(await harness.control.setRunMode('ask'), true);
  assert.equal(harness.calls.choose.length, 0);
  assert.equal(harness.prefs.runMode, 'ask');
});

test('entering Propose and cycling into it never asks', async (t) => {
  const suggestedChanges = bridge({ pending: 5 });
  const harness = createRunModeHarness(t, { runMode: 'plan', currentSessionId: 'sess_a', suggestedChanges });
  assert.equal(await harness.control.setRunMode('propose'), true);
  await settle();
  assert.equal(harness.prefs.runMode, 'propose');
  assert.equal(suggestedChanges.calls.list.length, 0);
  assert.equal(harness.calls.choose.length, 0);
});
