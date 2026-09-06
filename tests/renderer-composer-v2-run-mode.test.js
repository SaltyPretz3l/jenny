const test = require('node:test');
const assert = require('node:assert/strict');

const ToggleSwitch = require('../renderer/inventory/toggle-switch');
const Chip = require('../renderer/inventory/chip');
const Popover = require('../renderer/inventory/popover');
const settingsSupport = require('../renderer/shell/renderer-settings-support');
const composerV2State = require('../renderer/chat/renderer-composer-v2-state');
const {
  createComposerV2ToggleController,
} = require('../renderer/chat/renderer-composer-v2-toggle');

// Run-mode helpers (docs/plans/COMPOSER_RUN_MODE_SPEC.md §2): the closed
// Ask/Auto/Plan enum, its wire projection onto approval_mode/plan_mode, and
// the Shift+Tab cycle order share the Settings support normalizer so the send
// path, the switcher chip, and Settings all use one renderer source.

test('RUN_MODE_ORDER is the frozen ask -> auto -> plan cycle', () => {
  assert.deepEqual([...composerV2State.RUN_MODE_ORDER], ['ask', 'auto', 'plan']);
  assert.ok(Object.isFrozen(composerV2State.RUN_MODE_ORDER));
});

test('composer and Settings share the renderer run-mode normalizer owner', () => {
  assert.equal(composerV2State.normalizeRunMode, settingsSupport.normalizeRunMode);
  assert.equal(settingsSupport.normalizeDefaultRunMode, settingsSupport.normalizeRunMode);
});

test('normalizeRunMode accepts the closed enum with trim/case tolerance', () => {
  assert.equal(composerV2State.normalizeRunMode('auto'), 'auto');
  assert.equal(composerV2State.normalizeRunMode(' Plan '), 'plan');
  assert.equal(composerV2State.normalizeRunMode('ask'), 'ask');
});

test('normalizeRunMode falls back to ask, or plan when the legacy flag says so', () => {
  assert.equal(composerV2State.normalizeRunMode('garbage'), 'ask');
  assert.equal(composerV2State.normalizeRunMode(undefined), 'ask');
  assert.equal(composerV2State.normalizeRunMode(42), 'ask');
  // Old session records carry only plan_mode: true.
  assert.equal(composerV2State.normalizeRunMode(undefined, { planModeFallback: true }), 'plan');
  assert.equal(composerV2State.normalizeRunMode('', { planModeFallback: true }), 'plan');
  // An explicit valid run_mode beats the legacy fallback.
  assert.equal(composerV2State.normalizeRunMode('auto', { planModeFallback: true }), 'auto');
});

test('projectRunMode maps each mode onto the existing wire fields', () => {
  assert.deepEqual(composerV2State.projectRunMode('ask'), {
    runMode: 'ask',
    approvalMode: 'prompt',
    planMode: false,
  });
  assert.deepEqual(composerV2State.projectRunMode('auto'), {
    runMode: 'auto',
    approvalMode: 'auto_run',
    planMode: false,
  });
  assert.deepEqual(composerV2State.projectRunMode('plan'), {
    runMode: 'plan',
    approvalMode: 'prompt',
    planMode: true,
  });
});

test('projectRunMode normalizes before projecting', () => {
  assert.deepEqual(composerV2State.projectRunMode('nonsense'), {
    runMode: 'ask',
    approvalMode: 'prompt',
    planMode: false,
  });
  assert.deepEqual(composerV2State.projectRunMode(undefined, { planModeFallback: true }), {
    runMode: 'plan',
    approvalMode: 'prompt',
    planMode: true,
  });
});

test('nextRunMode cycles ask -> auto -> plan -> ask', () => {
  assert.equal(composerV2State.nextRunMode('ask'), 'auto');
  assert.equal(composerV2State.nextRunMode('auto'), 'plan');
  assert.equal(composerV2State.nextRunMode('plan'), 'ask');
  // Invalid input normalizes to ask first.
  assert.equal(composerV2State.nextRunMode('bogus'), 'auto');
});

// Retirement pins (spec §3.3): the one-shot Auto-run chip and its renderer
// state are gone outright — no orphan slot render, no leftover exports.

test('composer state no longer seeds the retired autoRunNextSend flag', () => {
  const composer = composerV2State.ensureComposerV2State({});
  assert.ok(composer, 'composer state initializes');
  assert.ok(!('autoRunNextSend' in composer), 'autoRunNextSend is retired');
});

test('toggle controller no longer exports the one-shot auto-run surface', () => {
  const controller = createComposerV2ToggleController({ state: {} });
  assert.equal(controller.consumeApprovalMode, undefined);
  assert.equal(controller.setAutoRunNextSend, undefined);
  assert.equal(controller.isAutoRunNextSendEnabled, undefined);
  assert.equal(controller.clearAutoRunNextSend, undefined);
});

test('renderToolToggles renders no auto-run chip slot', (t) => {
  const previousInventory = global.inventory;
  global.inventory = {
    toggleSwitch: ToggleSwitch.toggleSwitch,
    chip: Chip,
    popover: Popover,
  };
  t.after(() => {
    global.inventory = previousInventory;
  });
  const controller = createComposerV2ToggleController({ state: {} });
  controller.setAvailableTools(['web_search']);
  const html = controller.renderToolToggles();
  assert.ok(html.length > 0, 'toggles still render');
  assert.doesNotMatch(html, /composer-auto-approve/);
  assert.doesNotMatch(html, /Auto-run next send/);
});
