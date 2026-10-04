'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const {
  createAdvancedTuningSection,
} = require('../renderer/shell/renderer-settings-advanced-section');
const {
  ENGINE_TUNING_FIELDS,
  ENGINE_TUNING_GROUPS,
} = require('../renderer/shared/engine-tuning-schema');
const { createHarness, fire, inventory } = require('./helpers/settings-advanced-section-harness');

test('renders the table once: four groups, one fold, 24 rows and all side labels', () => {
  const { sectionDom, documentRef } = createHarness();
  const host = sectionDom.advancedTuningFields;
  assert.deepEqual([...host.querySelectorAll('[data-limits-group]')].map(node => node.dataset.limitsGroup), ['reply', 'timeouts', 'helpers', 'running']);
  assert.equal(host.querySelectorAll('.settings-field--stack').length, 24);
  assert.equal(host.querySelectorAll('[data-limits-line]').length, 35);
  assert.equal(host.querySelectorAll('[data-tuning-input]').length, 24);
  assert.equal(host.querySelector('[data-limits-fold]').open, false);
  assert.equal(documentRef.getElementById('advancedTuningProfileSwitch'), null);
  for (const line of host.querySelectorAll('[data-limits-line]')) {
    assert.ok(['Local', 'Cloud', 'Both'].includes(line.querySelector('.settings-field-side').textContent));
  }
  assert.equal(host.querySelectorAll('.settings-field-meta-modified:not([hidden])').length, 0);
  assert.equal(sectionDom.advancedTuningStatus.hidden, true);
  for (const key of ['maxLoopIterations', 'tokenBudgetReservedForSummary', 'tokenBudgetToolOverhead', 'tokenBudgetAutoCompactRatio', 'maxBudgetUsd']) {
    assert.equal(host.querySelector('[data-tuning-input="' + key + '"]'), null);
  }
});

test('background state updates preserve every input and a focused draft', () => {
  const h = createHarness();
  const host = h.sectionDom.advancedTuningFields;
  const nodes = [...host.querySelectorAll('input')];
  const input = host.querySelector('[data-tuning-input="cloudMaxToolsPerTurn"]');
  input.focus(); input.value = '123';
  h.section.setState({ values: { cloudMaxToolsPerTurn: 7 }, fields: ENGINE_TUNING_FIELDS }, h.sectionDom);
  h.section.setState({ values: { cloudMaxToolsPerTurn: 9 }, fields: ENGINE_TUNING_FIELDS }, h.sectionDom);
  assert.equal(input.value, '123');
  assert.deepEqual([...host.querySelectorAll('input')], nodes);
  assert.equal(h.documentRef.activeElement, input);
});

test('the delegated binder edits the cloud line without a profile switch', () => {
  // The listeners are bound to the stable containers, not the rows; if they
  // were bound per-row, every control would go dead after one switch.
  const { sectionDom, documentRef, window, calls } = createHarness();
  const input = sectionDom.advancedTuningFields.querySelector('[data-tuning-input="cloudMaxToolsPerTurn"]');
  assert.ok(input, 'cloud pane rendered its inputs');
  input.value = '150';
  fire(documentRef, window, input, 'change');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].payload, { key: 'cloudMaxToolsPerTurn', value: 150 });
});

test('a field change sends exactly one update', () => {
  const { sectionDom, documentRef, window, calls } = createHarness();
  const input = sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  input.value = '7';
  fire(documentRef, window, input, 'change');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'update', payload: { key: 'maxToolsPerTurn', value: 7 } });
});

test('clearing an optional field sends a reset rather than a zero', () => {
  const { sectionDom, documentRef, window, calls } = createHarness();
  const input = sectionDom.advancedTuningFields.querySelector(
    '[data-tuning-input="tokenBudgetWarningRatio"]'
  );
  input.value = '';
  fire(documentRef, window, input, 'change');
  assert.deepEqual(calls[0].payload, { key: 'tokenBudgetWarningRatio', value: null });
});

test('modified badge and per-field reset track hasOwnProperty on the values map', () => {
  const { sectionDom } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const modifiedRow = sectionDom.advancedTuningFields.querySelector('[data-settings-field="limitsRow-toolCallsPerReply"]');
  const cleanRow = sectionDom.advancedTuningFields.querySelector('[data-settings-field="limitsRow-chatRounds"]');
  assert.ok(modifiedRow.querySelector('[data-setting-revert="advancedTuningField-maxToolsPerTurn"]'), 'an override offers a reset');
  assert.match(modifiedRow.querySelector('.settings-field-meta-modified').textContent, /Modified/, 'an override is badged');
  assert.ok(!cleanRow.querySelector('[data-setting-revert]'), 'a default field offers no reset');
  assert.equal(cleanRow.querySelector('.settings-field-meta-modified').hidden, true);
});

test('an unset optional field renders empty with the engine default as placeholder', () => {
  // Inventing a number here would read as a value the user chose.
  const { sectionDom } = createHarness();
  const optional = sectionDom.advancedTuningFields.querySelector(
    '[data-tuning-input="tokenBudgetWarningRatio"]'
  );
  assert.equal(optional.value, '');
  assert.equal(optional.getAttribute('placeholder'), 'Auto');
  const withDefault = sectionDom.advancedTuningFields.querySelector(
    '[data-tuning-input="maxToolsPerTurn"]'
  );
  assert.equal(withDefault.value, '20', 'a field with a default shows the effective value');
});

test('a fractional field keeps its precision instead of rounding to 1', () => {
  const { sectionDom } = createHarness({ values: { tokenBudgetWarningRatio: 0.85 } });
  const input = sectionDom.advancedTuningFields.querySelector(
    '[data-tuning-input="tokenBudgetWarningRatio"]'
  );
  assert.equal(input.value, '85');
});

test('a per-field reset sends null for that key only', () => {
  const { sectionDom, documentRef, window, calls } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const resetButton = sectionDom.advancedTuningFields.querySelector('[data-setting-revert="advancedTuningField-maxToolsPerTurn"]');
  fire(documentRef, window, resetButton, 'click');
  assert.deepEqual(calls[0], { method: 'update', payload: { key: 'maxToolsPerTurn', value: null } });
});

test('section reset is two-step: arming does not mutate anything', () => {
  const { sectionDom, documentRef, window, calls } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const armButton = sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="arm"]');
  assert.ok(armButton, 'a pane with overrides offers a reset-all');
  assert.equal(armButton.textContent, 'Reset this page');
  fire(documentRef, window, armButton, 'click');
  assert.deepEqual(calls, [], 'arming must not reset anything');
  const confirmButton = sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="confirm"]');
  assert.ok(confirmButton, 'arming swaps in a confirm control');
  assert.match(confirmButton.textContent, /^Confirm: reset every limit/);
  fire(documentRef, window, confirmButton, 'click');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'reset', payload: undefined });
});

test('reset-all is hidden when nothing on the pane is modified', () => {
  const { sectionDom } = createHarness();
  assert.equal(sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]'), null);
});

test('one confirmed reset invokes limits first, then engine reset without scope', async () => {
  const order = [];
  const bridge = { reset: async (...args) => { order.push(['engine', args]); return { status: 'applied', state: { values: {} } }; } };
  const h = createHarness({ values: { cloudMaxToolsPerTurn: 7 }, bridge, resetLimitsToDefaults: async () => { order.push(['limits']); return true; } });
  h.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]').click();
  assert.deepEqual(order, []);
  h.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]').click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, [['limits'], ['engine', []]]);
});

test('an active stream disables the controls and says why', () => {
  const { sectionDom } = createHarness({ activeStream: true });
  const input = sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  assert.equal(input.disabled, true);
  assert.ok(/Finish the current reply/.test(sectionDom.advancedTuningStatus.textContent));
});

test('a rolled-back result surfaces on the field instead of failing silently', async () => {
  const rolledBack = {
    getState: async () => ({ values: {}, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS }),
    update: async () => ({
      status: 'rolled_back',
      reason: 'runtime_refresh_failed',
      state: { values: {}, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS },
    }),
    reset: async () => ({ status: 'applied', state: { values: {} } }),
  };
  const { sectionDom, documentRef, window, statuses } = createHarness({ bridge: rolledBack });
  const input = sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  input.value = '7';
  fire(documentRef, window, input, 'change');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const danger = statuses.filter((status) => status.tone === 'danger');
  assert.ok(danger.length > 0, 'the user must be told the value did not stick');
  assert.ok(/rejected|restored/i.test(danger[danger.length - 1].text));
  assert.match(input.closest('.settings-field').querySelector('.settings-field-error').textContent, /restored/);
  assert.match(sectionDom.advancedTuningStatus.textContent, /restored/);
  assert.equal(sectionDom.advancedTuningStatus.hidden, false);
});

test('failure reasons map to messages a person can act on', () => {
  const { section } = createHarness();
  assert.match(section.describeFailure({ reason: 'active_stream' }), /Finish the current reply/);
  assert.match(section.describeFailure({ reason: 'invalid_value' }), /allowed range/);
  assert.match(section.describeFailure({ status: 'rolled_back' }), /previous setting was restored/);
  assert.match(section.describeFailure({ status: 'degraded' }), /Restart Jenny/);
});

test('a missing bridge degrades to a message rather than throwing', () => {
  const { sectionDom, documentRef, window, statuses } = createHarness({ bridge: {} });
  const input = sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  input.value = '7';
  assert.doesNotThrow(() => fire(documentRef, window, input, 'change'));
  assert.ok(statuses.length > 0);
});

test('tuning controls retain their schema quick picks and accessible row labels', () => {
  const { sectionDom } = createHarness({ values: { maxToolsPerTurn: 40 } });
  const host = sectionDom.advancedTuningFields;
  for (const line of host.querySelectorAll('[data-limits-line^="advancedTuningField-"]')) {
    assert.ok(line.querySelector('[data-setting-preset]'));
    assert.ok(line.querySelector('input').getAttribute('aria-label'));
  }
  const pressed = host.querySelector('[data-setting-preset="advancedTuningField-maxToolsPerTurn"][aria-pressed="true"]');
  assert.equal(pressed.dataset.settingPresetValue, '40');
  assert.equal(pressed.title, 'Tool calls per reply, Local preset: 40');
  assert.equal(host.querySelector('[data-tuning-input="cloudMaxToolsPerTurn"]').getAttribute('aria-label'), 'Tool calls per reply, Cloud');
  // Every engine control of a row points at the row's one help line.
  for (const input of host.querySelectorAll('[data-tuning-input]')) {
    const help = input.closest('.settings-field').querySelector('.settings-field-help');
    assert.ok(help.id && input.getAttribute('aria-describedby').split(' ').includes(help.id), input.id);
  }
});

test('clicking a quick pick sends that value as an update', () => {
  const { sectionDom, calls, documentRef, window } = createHarness();
  const chip = sectionDom.advancedTuningFields.querySelector(
    '[data-setting-preset="advancedTuningField-maxToolsPerTurn"][data-setting-preset-value="40"]'
  );
  assert.ok(chip, 'preset chip rendered');
  fire(documentRef, window, chip, 'click');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'update', payload: { key: 'maxToolsPerTurn', value: 40 } });
});

test('a per-field revert is offered only for overrides and reads as Revert', () => {
  const { sectionDom } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const revert = sectionDom.advancedTuningFields.querySelector('[data-setting-revert="advancedTuningField-maxToolsPerTurn"]');
  assert.ok(revert, 'override row offers a revert');
  assert.equal(revert.getAttribute('data-setting-revert-default'), '20');
  assert.match(revert.getAttribute('aria-label') || '', /^Revert .* to 20$/);
  assert.ok(revert.classList.contains('settings-field-reset'), 'same affordance class as the Appearance per-field reset');
  assert.equal(sectionDom.advancedTuningFields.querySelector('[data-setting-revert="advancedTuningField-maxChatLoopIterations"]'), null);
});

test('a stacked row places Modified beside the title and Revert before its side label', () => {
  const { sectionDom } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const row = sectionDom.advancedTuningFields.querySelector('[data-settings-field="limitsRow-toolCallsPerReply"]');
  assert.ok(row.querySelector('.settings-field-text .settings-field-meta-modified'));
  const lines = [...row.querySelectorAll('.settings-field-stack-line')];
  assert.equal(lines.length, 2);
  assert.deepEqual([...lines[0].children].map(node => node.className), ['settings-field-revert-slot', 'settings-field-side', 'settings-field-number']);
  assert.equal(lines[0].querySelector('button[data-setting-revert]').getAttribute('data-setting-revert-default'), '20');
  assert.equal(lines[1].querySelector('.settings-field-revert-slot').textContent, '');
  assert.equal(row.querySelector('.settings-field-meta-default'), null);
});

test('the shared Revert goes through submit: one null update, controls locked until it settles', async () => {
  let resolveUpdate = null;
  const calls = [];
  const bridge = {
    getState: async () => ({ values: { maxToolsPerTurn: 7 }, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS }),
    update: (payload) => {
      calls.push(payload);
      return new Promise((resolve) => { resolveUpdate = resolve; });
    },
    reset: async () => ({ status: 'applied' }),
  };
  const { sectionDom, documentRef, window } = createHarness({ values: { maxToolsPerTurn: 7 }, bridge });
  const revert = sectionDom.advancedTuningFields.querySelector('.settings-field-revert-slot [data-setting-revert="advancedTuningField-maxToolsPerTurn"]');
  assert.ok(revert, 'the shared binding emits the revert');
  fire(documentRef, window, revert, 'click');
  assert.deepEqual(calls, [{ key: 'maxToolsPerTurn', value: null }]);
  for (const control of sectionDom.advancedTuningFields.querySelectorAll('[data-tuning-input], [data-setting-preset], [data-setting-revert^="advancedTuningField-"]')) {
    assert.equal(control.disabled, true, control.id);
  }
  resolveUpdate({ status: 'applied', state: { values: {}, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const row = sectionDom.advancedTuningFields.querySelector('[data-settings-field="limitsRow-toolCallsPerReply"]');
  assert.equal(row.querySelector('[data-setting-revert]'), null, 'the reverted row is back at its default');
  assert.equal(documentRef.getElementById('advancedTuningField-maxToolsPerTurn').value, '20');
  assert.equal(documentRef.getElementById('advancedTuningField-maxToolsPerTurn').disabled, false);
});

test('a deferred apply is announced as saved, not as a failure', async () => {
  const values = {};
  const bridge = {
    getState: async () => ({ values, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS }),
    update: async () => ({ status: 'applied', reason: 'deferred', state: { values: { maxToolsPerTurn: 7 }, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS } }),
    reset: async () => ({ status: 'applied' }),
  };
  const { sectionDom, statuses, documentRef, window } = createHarness({ bridge });
  const input = sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  input.value = '7';
  fire(documentRef, window, input, 'change');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const danger = statuses.filter((status) => status.tone === 'danger');
  assert.deepEqual(danger, [], 'a deferred apply is not an error');
  const saved = statuses.find((status) => /next time it starts/.test(status.text));
  assert.ok(saved, 'the user is told the value is saved and when it applies');
  assert.equal(saved.tone, 'success');
});

test('the reset describes the whole page and the fold counts modified rows', () => {
  const { sectionDom } = createHarness({ values: { maxInlinePayloadBytes: 16384 } });
  assert.equal(sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]').textContent, 'Reset this page');
  assert.equal(sectionDom.advancedTuningFields.querySelector('.settings-fold-count').textContent, '1 modified');
});

test('binding uses four delegated listeners, not one per field', () => {
  const { listeners, sectionDom } = createHarness();
  const rowCount = sectionDom.advancedTuningFields.querySelectorAll('.settings-field--stack').length;
  assert.equal(listeners.length, 4);
  assert.ok(rowCount > 4, 'the point only holds when there are many more rows than listeners');
});

test('a second edit while one is applying is blocked and announced, never silently dropped', async () => {
  let resolveUpdate = null;
  const values = {};
  const bridge = {
    getState: async () => ({ values, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS }),
    update: () => new Promise((resolve) => { resolveUpdate = resolve; }),
    reset: async () => ({ status: 'applied', state: { values: {} } }),
  };
  const { documentRef, window, sectionDom, statuses } = createHarness({ bridge });
  const first = documentRef.getElementById('advancedTuningField-maxToolsPerTurn');
  const second = documentRef.getElementById('advancedTuningField-maxChatLoopIterations');
  first.value = '9';
  fire(documentRef, window, first, 'change');
  assert.ok(resolveUpdate, 'first edit reached the bridge');

  // Every other control is locked while the sidecar refresh is in flight, so
  // the user cannot type a value that the post-apply re-render would revert.
  const controls = sectionDom.advancedTuningFields.querySelectorAll('[data-tuning-input], [data-setting-preset], [data-setting-revert^="advancedTuningField-"]');
  assert.ok(controls.length > 1);
  for (const control of controls) assert.equal(control.disabled, true, control.id);

  // If a change slips through anyway (keyboard, programmatic), it is announced.
  second.value = '4';
  fire(documentRef, window, second, 'change');
  const warned = statuses.find((status) => status.tone === 'warning');
  assert.ok(warned, 'in-flight guard must surface a status');
  assert.match(warned.text, /still applying/i);

  resolveUpdate({
    status: 'applied',
    state: { values: { maxToolsPerTurn: 9 }, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS, pending: false },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = sectionDom.advancedTuningFields.querySelectorAll('[data-tuning-input], [data-setting-preset], [data-setting-revert^="advancedTuningField-"]');
  for (const control of after) assert.equal(control.disabled, false, control.id);
  assert.equal(documentRef.getElementById('advancedTuningField-maxToolsPerTurn').value, '9');
});

test('controls are released again after a successful apply', async () => {
  // The service now guarantees pending:false on every transaction result; this
  // pins the renderer side of that contract for a bridge that honours it.
  const { documentRef, window, sectionDom } = createHarness();
  const input = documentRef.getElementById('advancedTuningField-maxToolsPerTurn');
  input.value = '9';
  fire(documentRef, window, input, 'change');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const control of sectionDom.advancedTuningFields.querySelectorAll('[data-tuning-input], [data-setting-preset], [data-setting-revert^="advancedTuningField-"]')) {
    assert.equal(control.disabled, false, control.id);
  }
});

test('dispose fences a slow refresh: the late getState result must not repaint (hyg-W4-54-F01)', async () => {
  let resolveGetState = null;
  const slowBridge = {
    getState: () => new Promise((resolve) => { resolveGetState = resolve; }),
    update: async () => ({ status: 'applied' }),
    reset: async () => ({ status: 'applied' }),
  };
  const { sectionDom, section } = createHarness({ bridge: slowBridge });
  const before = sectionDom.advancedTuningFields.innerHTML;
  const pending = section.refresh(sectionDom);
  assert.equal(typeof section.dispose, 'function', 'the section exposes an idempotent dispose seam');
  section.dispose();
  section.dispose();
  resolveGetState({
    values: { maxToolsPerTurn: 9 },
    fields: ENGINE_TUNING_FIELDS,
    groups: ENGINE_TUNING_GROUPS,
  });
  await pending;
  assert.equal(
    sectionDom.advancedTuningFields.innerHTML,
    before,
    'a getState result landing after dispose must not repaint the shared DOM'
  );
});

test('dispose clears an armed reset so the disarm timer and confirm control die with the binding (hyg-W4-54-F01)', () => {
  const { documentRef, window, sectionDom, section, calls } = createHarness({
    values: { maxToolsPerTurn: 9 },
  });
  const armButton = sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="arm"]');
  assert.ok(armButton, 'a pane with overrides offers a reset-all');
  fire(documentRef, window, armButton, 'click');
  assert.ok(
    sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="confirm"]'),
    'arming swaps in a confirm control'
  );
  section.dispose();
  section.render(sectionDom);
  assert.equal(
    sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="confirm"]'),
    null,
    'dispose disarms the pending reset (and cancels its disarm timer)'
  );
  assert.deepEqual(calls, [], 'nothing was reset');
});

test('W2-4 test 2: a cloud override reverts in its stacked line', () => {
  const h = createHarness({ values: { cloudMaxToolsPerTurn: 7 } });
  const slot = h.sectionDom.advancedTuningFields.querySelector('[data-setting-revert-slot="advancedTuningField-cloudMaxToolsPerTurn"]');
  assert.ok(slot);
  assert.equal(slot.querySelector('button').getAttribute('data-setting-revert-default'), '200');
  assert.equal(slot.closest('.settings-field').querySelector('.settings-field-meta-modified').hidden, false);
  assert.ok(h.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]'));
  slot.querySelector('button').click();
  assert.deepEqual(h.calls[0], { method: 'update', payload: { key: 'cloudMaxToolsPerTurn', value: null } });
});

test('W2-4 test 4: displayed minutes and percent write stored units', async () => {
  const h = createHarness({ values: { maxLoopWallSeconds: 3600 } });
  const minutes = h.sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxLoopWallSeconds"]');
  assert.equal(minutes.value, '60');
  minutes.value = '90';
  fire(h.documentRef, h.window, minutes, 'change');
  assert.deepEqual(h.calls[0].payload, { key: 'maxLoopWallSeconds', value: 5400 });
  await new Promise(resolve => setImmediate(resolve));
  const percent = h.sectionDom.advancedTuningFields.querySelector('[data-tuning-input="tokenBudgetWarningRatio"]');
  assert.equal(percent.value, '');
  assert.equal(percent.placeholder, 'Auto');
  percent.value = '80';
  fire(h.documentRef, h.window, percent, 'change');
  assert.deepEqual(h.calls[1].payload, { key: 'tokenBudgetWarningRatio', value: 0.8 });
});

test('the Ollama timeout follows the known engine, leaving an unknown engine visible', () => {
  let engine = '';
  const h = createHarness({ getEngineType: () => engine });
  const row = h.sectionDom.advancedTuningFields.querySelector('[data-settings-field="limitsRow-ollamaRequest"]');
  assert.equal(row.hidden, false);
  engine = 'llama_cpp'; h.section.render(h.sectionDom); assert.equal(row.hidden, true);
  engine = 'ollama'; h.section.render(h.sectionDom); assert.equal(row.hidden, false);
});

test('a value that is not a number in range is refused at the row and never clears the override', () => {
  const { sectionDom, documentRef, window, calls } = createHarness({ values: { maxToolsPerTurn: 40 } });
  const input = sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  for (const typed of ['', '2.5', '9999']) {
    input.value = typed;
    fire(documentRef, window, input, 'change');
  }
  assert.deepEqual(calls, [], 'nothing is written, and an empty required field is not a reset');
  const row = input.closest('.settings-field');
  assert.equal(row.getAttribute('data-state'), 'error');
  assert.match(row.querySelector('.settings-field-error').textContent, /whole number from 1 to 500/);
});

test('a limits update that changes nothing keeps the reset button, and arming keeps focus on it', () => {
  const h = createHarness({ values: { maxToolsPerTurn: 7 } });
  const button = h.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]');
  button.focus();
  fire(h.documentRef, h.window, h.sectionDom.advancedTuningFields, 'limits-lines-updated');
  assert.equal(h.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]'), button, 'the same node survives a poll');
  button.click();
  const confirm = h.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="confirm"]');
  assert.ok(confirm);
  assert.equal(h.documentRef.activeElement, confirm, 'the confirm step is reachable from the keyboard');
});

test('a refused edit gives the field its acknowledged value back', () => {
  const { sectionDom, documentRef, window, calls } = createHarness({ values: { maxToolsPerTurn: 40 } });
  const input = sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  input.value = '9999';
  fire(documentRef, window, input, 'change');
  assert.deepEqual(calls, []);
  assert.equal(input.value, '40', 'the refused number does not stay on screen');
  assert.equal(input.closest('.settings-field').getAttribute('data-state'), 'error');
});

test('a page reset whose limits half was not saved says so, whatever the engine half answered', async () => {
  for (const [limitsAnswer, engineAnswer] of [[false, { status: 'applied' }], [false, { status: 'applied', reason: 'deferred' }], [undefined, { status: 'applied' }]]) {
    const bridge = { reset: async () => ({ ...engineAnswer, state: { values: {} } }) };
    const h = createHarness({ values: { cloudMaxToolsPerTurn: 7 }, bridge, resetLimitsToDefaults: async () => limitsAnswer });
    h.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]').click();
    h.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]').click();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));
    assert.match(h.sectionDom.advancedTuningStatus.textContent, /Limits weren't saved/, JSON.stringify([limitsAnswer, engineAnswer]));
    assert.equal(h.sectionDom.advancedTuningStatus.hidden, false);
  }
});

test('a refused edit committed with Enter does not stay in the focused field', () => {
  const { sectionDom, documentRef, window, calls } = createHarness({ values: { maxToolsPerTurn: 40 } });
  const input = sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  input.focus();
  input.value = '9999';
  fire(documentRef, window, input, 'change');
  assert.deepEqual(calls, []);
  assert.equal(input.value, '40');
  assert.equal(documentRef.activeElement, input);
});

test('focus comes back after an engine change settles: the field, the quick pick, and the field after Revert', async () => {
  const state = (values) => ({ values, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS });
  const bridge = { getState: async () => state({ maxToolsPerTurn: 7 }), update: async ({ value }) => ({ status: 'applied', state: state(value == null ? {} : { maxToolsPerTurn: value }) }) };
  const { sectionDom, documentRef, window } = createHarness({ values: { maxToolsPerTurn: 7 }, bridge });
  const host = sectionDom.advancedTuningFields;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const input = host.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  input.focus();
  input.value = '9';
  fire(documentRef, window, input, 'change');
  await settle();
  assert.equal(documentRef.activeElement, input, 'an edit committed with Enter keeps the field');
  const pick = host.querySelector('[data-setting-preset="advancedTuningField-maxToolsPerTurn"][data-setting-preset-value="40"]');
  pick.focus();
  fire(documentRef, window, pick, 'click');
  await settle();
  assert.equal(documentRef.activeElement, pick, 'a quick pick keeps itself');
  const revert = host.querySelector('[data-setting-revert="advancedTuningField-maxToolsPerTurn"]');
  revert.focus();
  fire(documentRef, window, revert, 'click');
  await settle();
  assert.equal(documentRef.activeElement, input, 'Revert removes its own button, so the field takes focus');
});

test('engine lines stay locked until their state has loaded, and a failed read says why', async () => {
  const bridge = { getState: async () => { throw new Error('offline'); } };
  const { sectionDom, section } = createHarness({ bridge, loaded: false });
  const inputs = [...sectionDom.advancedTuningFields.querySelectorAll('[data-tuning-input]')];
  assert.ok(inputs.length > 0 && inputs.every((input) => input.disabled), 'schema defaults are not editable as if they were current');
  await section.refresh(sectionDom);
  assert.ok(inputs.every((input) => input.disabled));
  assert.match(sectionDom.advancedTuningStatus.textContent, /Could not read engine settings/);
  section.setState({ values: {}, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS }, sectionDom);
  assert.ok(inputs.every((input) => !input.disabled), 'a loaded state unlocks them');
});

test('the fold opens when a row in it is refused, and a repaint does not reopen it', () => {
  const { sectionDom, documentRef, window } = createHarness({ values: { toolsPythonRuntimeMaxMemoryMb: 512 } });
  const host = sectionDom.advancedTuningFields;
  const fold = host.querySelector('[data-limits-fold]');
  const input = host.querySelector('[data-tuning-input="toolsPythonRuntimeMaxMemoryMb"]');
  assert.equal(fold.open, false);
  input.value = '-1';
  fire(documentRef, window, input, 'change');
  assert.equal(fold.open, true);
  fold.open = false;
  fire(documentRef, window, host, 'limits-lines-updated');
  assert.equal(fold.open, false, 'a person may close it while the error is still shown');
});

test('the page reset is not offered for an override in a hidden row, and a reset that went through clears refused engine lines', async () => {
  for (const [engine, offered] of [['llama_server', false], ['ollama', true]]) {
    const page = createHarness({ values: { ollamaRequestTimeoutSeconds: 900 }, getEngineType: () => engine });
    const row = page.sectionDom.advancedTuningFields.querySelector('[data-settings-field="limitsRow-ollamaRequest"]');
    assert.equal(row.hidden, !offered);
    assert.ok(row.querySelector('[data-setting-revert]'), 'the override is there either way');
    assert.equal(Boolean(page.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]')), offered, engine);
  }

  const h = createHarness({ values: { maxToolsPerTurn: 40 } });
  const input = h.sectionDom.advancedTuningFields.querySelector('[data-tuning-input="maxToolsPerTurn"]');
  input.value = '9999';
  fire(h.documentRef, h.window, input, 'change');
  assert.equal(input.closest('.settings-field').getAttribute('data-state'), 'error');
  h.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]').click();
  h.sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.closest('.settings-field').hasAttribute('data-state'), false);
});
