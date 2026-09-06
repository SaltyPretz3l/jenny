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

const inventory = {
  settingsField: require('../renderer/inventory/settings-field'),
  numberInput: require('../renderer/inventory/number-input'),
  segmentedControl: require('../renderer/inventory/segmented-control'),
  actionButton: require('../renderer/inventory/action-button'),
  badge: require('../renderer/inventory/badge'),
  statusRow: require('../renderer/inventory/status-row'),
};

function createHarness({ values = {}, activeStream = false, bridge = null } = {}) {
  const dom = new JSDOM(
    '<!doctype html><body>'
    + '<div id="advancedTuningStatus"></div>'
    + '<div id="advancedTuningProfileSwitch"></div>'
    + '<div id="advancedTuningFields"></div>'
    + '<div id="advancedTuningActions"></div>'
    + '</body>',
    { pretendToBeVisual: true }
  );
  const documentRef = dom.window.document;
  const sectionDom = {
    advancedTuningStatus: documentRef.getElementById('advancedTuningStatus'),
    advancedTuningProfileSwitch: documentRef.getElementById('advancedTuningProfileSwitch'),
    advancedTuningFields: documentRef.getElementById('advancedTuningFields'),
    advancedTuningActions: documentRef.getElementById('advancedTuningActions'),
  };
  const calls = [];
  const activeBridge = bridge || {
    getState: async () => ({
      values, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS, activeStream,
    }),
    update: async (payload) => {
      calls.push({ method: 'update', payload });
      return { status: 'applied', state: { values, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS } };
    },
    reset: async (payload) => {
      calls.push({ method: 'reset', payload });
      return { status: 'applied', state: { values: {}, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS } };
    },
  };
  const statuses = [];
  const section = createAdvancedTuningSection({
    inventory,
    getBridge: () => activeBridge,
    onStatus: (status) => statuses.push(status),
  });
  section.setState({
    values, fields: ENGINE_TUNING_FIELDS, groups: ENGINE_TUNING_GROUPS, activeStream,
  }, sectionDom);
  const listeners = [];
  section.bind(sectionDom, (target, eventName, handler) => {
    if (!target) return;
    target.addEventListener(eventName, handler);
    listeners.push({ target, eventName });
  });
  return { dom, documentRef, sectionDom, section, calls, statuses, listeners, window: dom.window };
}

function fire(documentRef, window, element, type, detail) {
  const event = detail
    ? new window.CustomEvent(type, { detail, bubbles: true })
    : new window.Event(type, { bubbles: true });
  element.dispatchEvent(event);
}

test('renders a row for every field on the local pane', () => {
  const { sectionDom } = createHarness();
  const rows = sectionDom.advancedTuningFields.querySelectorAll('[data-tuning-key]');
  const expected = ENGINE_TUNING_FIELDS.filter(
    (field) => field.scope === 'local' || field.scope === 'shared'
  );
  assert.equal(rows.length, expected.length);
  assert.ok(rows.length > 0);
});

test('switching to the cloud pane swaps the field list', () => {
  const { sectionDom, section, documentRef, window } = createHarness();
  const localKeys = [...sectionDom.advancedTuningFields.querySelectorAll('[data-tuning-key]')]
    .map((row) => row.getAttribute('data-tuning-key'));
  fire(documentRef, window, sectionDom.advancedTuningProfileSwitch, 'inv-segmented-change', { value: 'cloud' });
  const cloudKeys = [...sectionDom.advancedTuningFields.querySelectorAll('[data-tuning-key]')]
    .map((row) => row.getAttribute('data-tuning-key'));
  assert.equal(
    sectionDom.advancedTuningProfileSwitch.querySelector('[data-value="cloud"]').getAttribute('aria-checked'),
    'true'
  );
  assert.notDeepEqual(localKeys, cloudKeys);
  assert.ok(cloudKeys.includes('cloudMaxToolsPerTurn'));
  assert.ok(!cloudKeys.includes('maxToolsPerTurn'), 'local-only fields leave the cloud pane');
  assert.ok(cloudKeys.includes('maxSubAgentLoopIterations'), 'shared fields stay on both panes');
});

test('the delegated binder survives the innerHTML swap a profile switch performs', () => {
  // The listeners are bound to the stable containers, not the rows; if they
  // were bound per-row, every control would go dead after one switch.
  const { sectionDom, documentRef, window, calls } = createHarness();
  fire(documentRef, window, sectionDom.advancedTuningProfileSwitch, 'inv-segmented-change', { value: 'cloud' });
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
    '[data-tuning-input="tokenBudgetAutoCompactRatio"]'
  );
  input.value = '';
  fire(documentRef, window, input, 'change');
  assert.deepEqual(calls[0].payload, { key: 'tokenBudgetAutoCompactRatio', value: null });
});

test('modified badge and per-field reset track hasOwnProperty on the values map', () => {
  const { sectionDom } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const modifiedRow = sectionDom.advancedTuningFields.querySelector('[data-tuning-key="maxToolsPerTurn"]');
  const cleanRow = sectionDom.advancedTuningFields.querySelector('[data-tuning-key="maxLoopIterations"]');
  assert.ok(modifiedRow.querySelector('[data-tuning-reset]'), 'an override offers a reset');
  assert.ok(/Modified/.test(modifiedRow.textContent), 'an override is badged');
  assert.ok(!cleanRow.querySelector('[data-tuning-reset]'), 'a default field offers no reset');
  assert.ok(!/Modified/.test(cleanRow.textContent));
});

test('an unset optional field renders empty with the engine default as placeholder', () => {
  // Inventing a number here would read as a value the user chose.
  const { sectionDom } = createHarness();
  const optional = sectionDom.advancedTuningFields.querySelector(
    '[data-tuning-input="tokenBudgetAutoCompactRatio"]'
  );
  assert.equal(optional.value, '');
  assert.equal(optional.getAttribute('placeholder'), 'Auto');
  const withDefault = sectionDom.advancedTuningFields.querySelector(
    '[data-tuning-input="maxToolsPerTurn"]'
  );
  assert.equal(withDefault.value, '20', 'a field with a default shows the effective value');
});

test('a fractional field keeps its precision instead of rounding to 1', () => {
  const { sectionDom } = createHarness({ values: { tokenBudgetAutoCompactRatio: 0.85 } });
  const input = sectionDom.advancedTuningFields.querySelector(
    '[data-tuning-input="tokenBudgetAutoCompactRatio"]'
  );
  assert.equal(input.value, '0.85');
});

test('a per-field reset sends null for that key only', () => {
  const { sectionDom, documentRef, window, calls } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const resetButton = sectionDom.advancedTuningFields.querySelector('[data-tuning-reset="maxToolsPerTurn"]');
  fire(documentRef, window, resetButton, 'click');
  assert.deepEqual(calls[0], { method: 'update', payload: { key: 'maxToolsPerTurn', value: null } });
});

test('section reset is two-step: arming does not mutate anything', () => {
  const { sectionDom, documentRef, window, calls } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const armButton = sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="arm"]');
  assert.ok(armButton, 'a pane with overrides offers a reset-all');
  assert.equal(armButton.getAttribute('title'), armButton.getAttribute('aria-label'));
  fire(documentRef, window, armButton, 'click');
  assert.deepEqual(calls, [], 'arming must not reset anything');
  const confirmButton = sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="confirm"]');
  assert.ok(confirmButton, 'arming swaps in a confirm control');
  assert.equal(confirmButton.getAttribute('title'), confirmButton.getAttribute('aria-label'));
  fire(documentRef, window, confirmButton, 'click');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'reset', payload: { scope: 'local' } });
});

test('reset-all is hidden when nothing on the pane is modified', () => {
  const { sectionDom } = createHarness();
  assert.equal(sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all]'), null);
});

test('switching panes disarms a pending section reset', () => {
  // Otherwise the confirm click would wipe a pane the user never armed.
  const { sectionDom, documentRef, window } = createHarness({ values: { maxToolsPerTurn: 7 } });
  fire(documentRef, window, sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="arm"]'), 'click');
  fire(documentRef, window, sectionDom.advancedTuningProfileSwitch, 'inv-segmented-change', { value: 'cloud' });
  assert.equal(sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="confirm"]'), null);
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

test('every field renders its schema quick picks, with the effective value pressed', () => {
  const { sectionDom } = createHarness({ values: { maxToolsPerTurn: 40 } });
  const rows = [...sectionDom.advancedTuningFields.querySelectorAll('[data-tuning-key]')];
  const withoutPresets = rows.filter((row) => !row.querySelector('[data-tuning-preset]'));
  assert.deepEqual(withoutPresets.map((row) => row.getAttribute('data-tuning-key')), []);

  const toolCalls = sectionDom.advancedTuningFields.querySelector('[data-tuning-key="maxToolsPerTurn"]');
  const pressed = [...toolCalls.querySelectorAll('[data-tuning-preset][aria-pressed="true"]')];
  assert.equal(pressed.length, 1, 'exactly one pick is pressed');
  assert.equal(pressed[0].getAttribute('data-tuning-preset-value'), '40', 'the override wins');
  assert.equal(pressed[0].getAttribute('title'), 'Tool calls per turn preset: 40');

  // A default field is pressed on the pick equal to its default.
  const chatRounds = sectionDom.advancedTuningFields.querySelector('[data-tuning-key="maxChatLoopIterations"]');
  const chatPressed = chatRounds.querySelector('[data-tuning-preset][aria-pressed="true"]');
  assert.equal(chatPressed.getAttribute('data-tuning-preset-value'), '8');

  // An unset optional field presses nothing.
  const ratio = sectionDom.advancedTuningFields.querySelector('[data-tuning-key="tokenBudgetAutoCompactRatio"]');
  assert.equal(ratio.querySelector('[data-tuning-preset][aria-pressed="true"]'), null);
  assert.match(ratio.textContent, /70%/, 'labelled presets render their label');
});

test('clicking a quick pick sends that value as an update', () => {
  const { sectionDom, calls, documentRef, window } = createHarness();
  const chip = sectionDom.advancedTuningFields.querySelector(
    '[data-tuning-preset="maxToolsPerTurn"][data-tuning-preset-value="40"]'
  );
  assert.ok(chip, 'preset chip rendered');
  fire(documentRef, window, chip, 'click');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { method: 'update', payload: { key: 'maxToolsPerTurn', value: 40 } });
});

test('a per-field revert is offered only for overrides and reads as Revert', () => {
  const { sectionDom } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const revert = sectionDom.advancedTuningFields.querySelector('[data-tuning-reset="maxToolsPerTurn"]');
  assert.ok(revert, 'override row offers a revert');
  assert.match(revert.textContent, /Revert/);
  assert.match(revert.getAttribute('aria-label') || '', /default/i);
  assert.ok(revert.classList.contains('settings-field-reset'), 'same affordance class as the Appearance per-field reset');
  assert.equal(sectionDom.advancedTuningFields.querySelector('[data-tuning-reset="maxChatLoopIterations"]'), null);
});

test('default, Modified, and Revert sit on the title line - the control column holds only the input and picks', () => {
  const { sectionDom } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const row = sectionDom.advancedTuningFields.querySelector('[data-tuning-key="maxToolsPerTurn"]');
  const titleRow = row.querySelector('.settings-field-text .settings-field-title-row');
  assert.ok(titleRow, 'title line exists');
  assert.match(titleRow.querySelector('.settings-field-meta-default').textContent, /Default 20 calls/);
  assert.match(titleRow.querySelector('.settings-field-meta-modified').textContent, /Modified/);
  assert.ok(titleRow.querySelector('[data-tuning-reset="maxToolsPerTurn"]'), 'revert is on the title line');
  const control = row.querySelector('.settings-field-control');
  assert.equal(control.querySelector('[data-tuning-reset], .settings-field-meta, .inv-badge'), null, 'nothing but the input and quick picks in the control column');
  assert.ok(control.querySelector('[data-tuning-input="maxToolsPerTurn"]'));
  assert.ok(control.querySelector('[data-tuning-preset="maxToolsPerTurn"]'));
  assert.doesNotMatch(row.querySelector('.settings-field-help').textContent, /Default/, 'help text no longer repeats the default');

  const clean = sectionDom.advancedTuningFields.querySelector('[data-tuning-key="maxChatLoopIterations"]');
  assert.ok(clean.querySelector('.settings-field-meta-default'), 'default shows on an unmodified row too');
  assert.equal(clean.querySelector('.settings-field-meta-modified'), null);
  const optional = sectionDom.advancedTuningFields.querySelector('[data-tuning-key="tokenBudgetAutoCompactRatio"]');
  assert.match(optional.querySelector('.settings-field-meta-default').textContent, /Auto/);
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

test('the pane reset says which pane it covers', () => {
  const { sectionDom } = createHarness({ values: { maxToolsPerTurn: 7 } });
  const arm = sectionDom.advancedTuningActions.querySelector('[data-tuning-reset-all="arm"]');
  assert.match(arm.textContent, /Local/);
  assert.match(arm.getAttribute('aria-label') || '', /shared/);
});

test('binding uses four delegated listeners, not one per field', () => {
  const { listeners, sectionDom } = createHarness();
  const rowCount = sectionDom.advancedTuningFields.querySelectorAll('[data-tuning-key]').length;
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
  const first = documentRef.getElementById('advancedTuning-maxToolsPerTurn');
  const second = documentRef.getElementById('advancedTuning-maxLoopIterations');
  first.value = '9';
  fire(documentRef, window, first, 'change');
  assert.ok(resolveUpdate, 'first edit reached the bridge');

  // Every other control is locked while the sidecar refresh is in flight, so
  // the user cannot type a value that the post-apply re-render would revert.
  const controls = sectionDom.advancedTuningFields.querySelectorAll('input, button');
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
  const after = sectionDom.advancedTuningFields.querySelectorAll('input, button');
  for (const control of after) assert.equal(control.disabled, false, control.id);
  assert.equal(documentRef.getElementById('advancedTuning-maxToolsPerTurn').value, '9');
});

test('controls are released again after a successful apply', async () => {
  // The service now guarantees pending:false on every transaction result; this
  // pins the renderer side of that contract for a bridge that honours it.
  const { documentRef, window, sectionDom } = createHarness();
  const input = documentRef.getElementById('advancedTuning-maxToolsPerTurn');
  input.value = '9';
  fire(documentRef, window, input, 'change');
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const control of sectionDom.advancedTuningFields.querySelectorAll('input, button')) {
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
