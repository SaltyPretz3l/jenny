'use strict';
// Bug-pass #3 (workspace panels): a Test Runner state push (a run starting or
// finishing, including Jenny's gate runs) must not rebuild the add-config form
// (typed values + focus survive), focus follows the clicked Run to the
// equivalent control, and one run shows exactly one Stop.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTestRunnerPanel } = require('../renderer/features/renderer-ide-test-runner-panel.js');
const actionButton = require('../renderer/inventory/action-button.js');
const textField = require('../renderer/inventory/text-field.js');
const selectField = require('../renderer/inventory/select-field.js');

function clickEl(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('click', { bubbles: true }));
}

function setup(stateOverrides = {}, actions = {}) {
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const host = dom.window.document.getElementById('host');
  const state = { configs: [], history: { byConfig: {} }, activeRun: null, activeConfigId: null, ...stateOverrides };
  const panel = createIdeTestRunnerPanel({
    getMountEl: () => host,
    getState: () => state,
    actions,
    actionButton,
    textField,
    selectField,
  });
  panel.bindEvents();
  panel.render();
  return { dom, host, panel, state };
}

test('bug-pass #3: a run state push keeps the add form (same inputs, typed values, focus)', () => {
  const { host, panel, state, dom } = setup({ configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }] });
  const idField = host.querySelector('#ideTestRunnerFieldId');
  const commandField = host.querySelector('#ideTestRunnerFieldCommand');
  idField.value = 'e2e';
  commandField.value = 'npm run e2e';
  commandField.focus();
  // Jenny's gate run starts, then finishes with a new history record.
  state.activeRun = 'r1';
  state.activeConfigId = 'unit';
  panel.render();
  assert.ok(host.querySelector('.ide-test-runner-panel__active-run'), 'the run repainted the header region');
  state.activeRun = null;
  state.activeConfigId = null;
  state.history = { byConfig: { unit: [{ status: 'passed', durationMs: 900, initiator: 'jenny' }] } };
  panel.render();
  assert.equal(host.querySelector('[data-config-id="unit"] .ide-test-runner-panel__status').dataset.status, 'passed');
  assert.equal(host.querySelector('#ideTestRunnerFieldId'), idField, 'the id input is the same element');
  assert.equal(host.querySelector('#ideTestRunnerFieldCommand'), commandField, 'the command input is the same element');
  assert.equal(idField.value, 'e2e');
  assert.equal(commandField.value, 'npm run e2e');
  assert.equal(dom.window.document.activeElement, commandField, 'focus stays in the form');
  assert.equal(host.querySelectorAll('.ide-test-runner-panel').length, 1);
  assert.equal(host.querySelectorAll('.ide-test-runner-panel__form').length, 1);
});

test('bug-pass #3: focus follows the clicked Run to Stop, then back to Run when the run ends', () => {
  const { host, panel, state, dom } = setup(
    { configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }, { id: 'lint', label: 'Lint', command: 'npm run lint' }] },
    { runConfig: (id) => { state.activeRun = 'r1'; state.activeConfigId = id; panel.render(); } }
  );
  const doc = dom.window.document;
  // A re-render with the focused control still enabled keeps it on the equivalent control.
  const lintRemove = host.querySelector('[data-config-id="lint"] [data-test-runner-remove]');
  lintRemove.focus();
  state.history = { byConfig: { lint: [{ status: 'failed', durationMs: 5 }] } };
  panel.render();
  assert.equal(doc.activeElement, host.querySelector('[data-config-id="lint"] [data-test-runner-remove]'));
  const run = host.querySelector('[data-config-id="unit"] [data-test-runner-run]');
  run.focus();
  clickEl(run);
  const stop = host.querySelector('[data-test-runner-abort]');
  assert.ok(stop, 'the run is active');
  assert.equal(doc.activeElement, stop, 'the disabled Run hands focus to Stop');
  state.activeRun = null;
  state.activeConfigId = null;
  panel.render();
  assert.equal(doc.activeElement, host.querySelector('[data-config-id="unit"] [data-test-runner-run]'), 'focus returns to Run');
});

test('bug-pass #3: one run shows exactly one Stop (the active-run card), none on the row', () => {
  const { host } = setup({ configs: [{ id: 'unit', label: 'Unit', command: 'npm test' }], activeRun: 'r1', activeConfigId: 'unit' });
  const stops = host.querySelectorAll('[data-test-runner-abort]');
  assert.equal(stops.length, 1);
  assert.ok(stops[0].closest('.ide-test-runner-panel__active-run'));
  assert.equal(host.querySelector('[data-config-id="unit"] [data-test-runner-abort]'), null);
});
