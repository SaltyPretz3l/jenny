'use strict';

// Gate SW1-2 / F14: the engine lines locked by a reply in progress re-read
// their state until the reply ends, instead of staying locked until restart.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ENGINE_TUNING_FIELDS,
  ENGINE_TUNING_GROUPS,
} = require('../renderer/shared/engine-tuning-schema');
const { createHarness, fire } = require('./helpers/settings-advanced-section-harness');

// SW1-2 / F14: an edit refused during a reply stored activeStream:true, and
// nothing re-read the state, so the page stayed locked with the app idle.
test('a refused edit during a reply unlocks the page once the reply has ended', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let streaming = true;
  const stateNow = () => ({ values: {}, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS, activeStream: streaming });
  const bridge = {
    getState: async () => stateNow(),
    update: async () => ({ status: 'rejected', reason: 'active_stream', state: stateNow() }),
    reset: async () => ({ status: 'applied', state: stateNow() }),
  };
  const { sectionDom, documentRef, window, section } = createHarness({ bridge });
  const input = () => sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  input().value = '6';
  fire(documentRef, window, input(), 'change');
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(input().disabled, true);
  assert.match(input().closest('.settings-field').querySelector('.settings-field-error').textContent, /Finish the current reply/);

  // Still streaming at the first re-check: stays locked and checks again.
  t.mock.timers.tick(3000);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(input().disabled, true);

  streaming = false;
  t.mock.timers.tick(3000);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(input().disabled, false);
  section.dispose();
});

test('a failed re-check keeps checking until the reply lock clears', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let streaming = true;
  let failNext = false;
  const bridge = {
    getState: async () => {
      if (failNext) { failNext = false; throw new Error('read failed'); }
      return { values: {}, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS, activeStream: streaming };
    },
    update: async () => ({ status: 'applied' }),
    reset: async () => ({ status: 'applied' }),
  };
  const { sectionDom, section } = createHarness({ bridge, activeStream: true });
  const input = () => sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  failNext = true;
  t.mock.timers.tick(3000);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(input().disabled, true);

  streaming = false;
  t.mock.timers.tick(3000);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(input().disabled, false);
  section.dispose();
});

test('a disposed section stops re-checking a reply lock', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reads = 0;
  const bridge = {
    getState: async () => { reads += 1; return { values: {}, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS, activeStream: true }; },
    update: async () => ({ status: 'applied' }),
    reset: async () => ({ status: 'applied' }),
  };
  const { section } = createHarness({ bridge, activeStream: true });
  section.dispose();
  t.mock.timers.tick(10000);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  assert.equal(reads, 0);
});
