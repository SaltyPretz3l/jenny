/* Shift+Tab cycles Ask -> Auto -> Plan; Alt+P stays the direct Plan toggle
   (COMPOSER_RUN_MODE_SPEC §5, owner decision 3). Both route through the
   rendererRunModeControl surface the settings-bindings module registers. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  handlePlanModeShortcut,
  handleRunModeCycleShortcut,
} = require('../renderer/chat/renderer-plan-mode-shortcut');

function buildDoc() {
  return new JSDOM('<!doctype html><body><textarea id="chatInput"></textarea></body>').window;
}

function keyEvent(win, key, init = {}) {
  return new win.KeyboardEvent('keydown', { key, cancelable: true, ...init });
}

function withControl(t, control) {
  const previous = globalThis.rendererRunModeControl;
  globalThis.rendererRunModeControl = control;
  t.after(() => { globalThis.rendererRunModeControl = previous; });
}

test('Shift+Tab cycles the run mode and swallows the keystroke', (t) => {
  const win = buildDoc();
  const calls = { cycle: 0 };
  withControl(t, { cycleRunMode: () => { calls.cycle += 1; return Promise.resolve(true); } });
  const event = keyEvent(win, 'Tab', { shiftKey: true });
  assert.equal(handleRunModeCycleShortcut(event, win.document), true);
  assert.equal(calls.cycle, 1);
  assert.equal(event.defaultPrevented, true);
});

test('Shift+Tab stands down when no run-mode control is registered', (t) => {
  const win = buildDoc();
  withControl(t, undefined);
  const event = keyEvent(win, 'Tab', { shiftKey: true });
  assert.equal(handleRunModeCycleShortcut(event, win.document), false);
  assert.equal(event.defaultPrevented, false, 'Tab keeps its focus-navigation meaning');
});

test('plain Tab, modified Tab, and key repeat never cycle', (t) => {
  const win = buildDoc();
  const calls = { cycle: 0 };
  withControl(t, { cycleRunMode: () => { calls.cycle += 1; } });
  for (const init of [
    {},
    { shiftKey: true, ctrlKey: true },
    { shiftKey: true, altKey: true },
    { shiftKey: true, metaKey: true },
    { shiftKey: true, repeat: true },
  ]) {
    const event = keyEvent(win, 'Tab', init);
    assert.equal(handleRunModeCycleShortcut(event, win.document), false, JSON.stringify(init));
    assert.equal(event.defaultPrevented, false);
  }
  assert.equal(calls.cycle, 0);
});

test('Alt+P routes to the plan toggle on the run-mode control', (t) => {
  const win = buildDoc();
  const calls = { plan: 0 };
  withControl(t, { togglePlanMode: () => { calls.plan += 1; return Promise.resolve(true); } });
  const event = keyEvent(win, 'p', { altKey: true });
  assert.equal(handlePlanModeShortcut(event, win.document), true);
  assert.equal(calls.plan, 1);
  assert.equal(event.defaultPrevented, true);
});

test('Alt+P stands down without a control and never double-fires on repeat', (t) => {
  const win = buildDoc();
  withControl(t, undefined);
  assert.equal(handlePlanModeShortcut(keyEvent(win, 'p', { altKey: true }), win.document), false);

  const calls = { plan: 0 };
  withControl(t, { togglePlanMode: () => { calls.plan += 1; } });
  assert.equal(
    handlePlanModeShortcut(keyEvent(win, 'p', { altKey: true, repeat: true }), win.document),
    false
  );
  assert.equal(calls.plan, 0);
});
