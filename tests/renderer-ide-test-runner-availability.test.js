'use strict';
// SPEC: row 40 W1 - the Workspace Test Runner's honest off state and the
// panel runs that keep their output (docs/archive/WORKSPACE_UNIFIED_PANELS_SPEC_2026-10-06.md).

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTestRunnerWiring } = require('../renderer/features/renderer-ide-test-runner-wiring.js');
const { createIdeTestRunnerPanel } = require('../renderer/features/renderer-ide-test-runner-panel.js');
const actionButton = require('../renderer/inventory/action-button.js');
const textField = require('../renderer/inventory/text-field.js');
const selectField = require('../renderer/inventory/select-field.js');
const { tick, clickEl, makeApi, setup } = require('./helpers/test-runner-wiring-fixture');

// ---------------------------------------------------------------------------
// Row 40 W1-A: an honest off state + panel runs that request their output.
// ---------------------------------------------------------------------------

const DISABLED_STATE = { configs: [], history: { byConfig: {} }, activeRun: null, activeConfigId: null, available: false, reason: 'feature_disabled' };

function setupAvailability(opts = {}) {
  const base = setup(opts);
  const changes = [];
  const wiring = createIdeTestRunnerWiring({
    getApi: () => base.fake.api,
    getMountEl: () => base.host,
    isActiveView: () => true,
    panelFactory: createIdeTestRunnerPanel,
    actionButton,
    textField,
    selectField,
    showShellErrorToast: (message, meta) => base.toasts.push({ message, meta }),
    onAvailabilityChange: (available) => changes.push(available),
  });
  return { ...base, wiring, changes };
}

test('row40: a feature_disabled getState envelope marks the runner unavailable, then any live envelope restores it', async () => {
  const { wiring, fake, changes } = setupAvailability();
  assert.equal(wiring.isAvailable(), true, 'available until proven otherwise');
  fake.setState(DISABLED_STATE);
  wiring.bindEvents();
  await tick();
  assert.equal(wiring.isAvailable(), false);
  assert.deepEqual(changes, [false], 'the owner is told exactly once');
  fake.setState({ configs: [{ id: 'unit', command: 'npm test' }], history: { byConfig: {} }, activeRun: null, activeConfigId: null });
  await wiring.refresh();
  assert.equal(wiring.isAvailable(), true);
  assert.deepEqual(changes, [false, true]);
});

test('row40: root_missing and a reasonless envelope do not mark the feature unavailable', async () => {
  const { wiring, fake, changes } = setupAvailability();
  fake.setState({ configs: [], available: false, reason: 'root_missing' });
  wiring.bindEvents();
  await tick();
  assert.equal(wiring.isAvailable(), true, 'root_missing keeps the tab and its empty state');
  fake.setState({ available: false, configs: [] });
  await wiring.refresh();
  assert.equal(wiring.isAvailable(), true);
  assert.deepEqual(changes, []);
});

test('row40: a disabled envelope still keeps the last good config cache', async () => {
  const { host, wiring, fake } = setupAvailability();
  wiring.bindEvents();
  await tick();
  fake.setState(DISABLED_STATE);
  await wiring.refresh();
  wiring.render();
  assert.equal(wiring.isAvailable(), false);
  assert.ok(host.querySelector('[data-config-id="unit"]'), 'configs stay cached');
});

test('row40: saveConfigs against a disabled feature fails with a toast and never refreshes as if it saved', async () => {
  const { host, wiring, fake, toasts } = setupAvailability();
  wiring.bindEvents();
  await tick();
  fake.setSaveBehavior(() => ({ available: false, reason: 'feature_disabled' }));
  const before = fake.calls.getState;
  host.querySelector('#ideTestRunnerFieldId').value = 'e2e';
  host.querySelector('#ideTestRunnerFieldCommand').value = 'npm run e2e';
  clickEl(host.querySelector('[data-test-runner-add]'));
  await tick();
  await tick();
  assert.equal(fake.calls.saveConfigs.length, 1);
  assert.equal(fake.calls.getState, before, 'no success refresh');
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'Test running is turned off.');
  assert.equal(toasts[0].meta.dedupeKey, 'ide:test-runner:save');
});

test('row40: the panel save outcome for a disabled feature is typed ok:false with the reason as its code', async () => {
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const fake = makeApi();
  fake.setSaveBehavior(() => ({ available: false, reason: 'feature_disabled' }));
  let actions = null;
  createIdeTestRunnerWiring({
    getApi: () => fake.api,
    getMountEl: () => dom.window.document.getElementById('host'),
    panelFactory: (deps) => { actions = deps.actions; return { render() {}, bindEvents() {}, dispose() {} }; },
    showShellErrorToast: () => {},
  });
  const outcome = await actions.saveConfigs([{ id: 'a', command: 'x' }]);
  assert.deepEqual(outcome, { ok: false, code: 'feature_disabled', message: 'Test running is turned off.' });
});

test('row40: a panel run keeps its output tails in memory, newest-last, capped at 8 configs', async () => {
  const { host, wiring, fake } = setupAvailability();
  wiring.bindEvents();
  await tick();
  assert.equal(wiring.getLastRunOutput('unit'), null, 'nothing before a run');
  fake.api.run = (payload) => {
    fake.calls.run.push(payload);
    return Promise.resolve({ configId: payload.configId, runId: `r-${payload.configId}`, status: 'failed', finishedAt: 'F', stdoutTail: 'out', stderrTail: 'err' });
  };
  clickEl(host.querySelector('[data-test-runner-run]'));
  await tick();
  assert.deepEqual(wiring.getLastRunOutput('unit'), { configId: 'unit', runId: 'r-unit', status: 'failed', exitCode: null, stdoutTail: 'out', stderrTail: 'err', finishedAt: 'F' });
  assert.equal(fake.calls.run[0].includeOutput, true);

  const configs = Array.from({ length: 10 }, (_v, i) => ({ id: `c${i}`, label: `C${i}`, command: 'x' }));
  fake.setState({ configs, history: { byConfig: {} }, activeRun: null, activeConfigId: null });
  await wiring.refresh();
  assert.equal(host.querySelectorAll('[data-test-runner-run]').length, 10);
  // Each finished run repaints its row (Show output appears), so re-query per click.
  for (let index = 0; index < 10; index += 1) {
    clickEl(host.querySelectorAll('[data-test-runner-run]')[index]);
    await tick();
  }
  assert.equal(wiring.getLastRunOutput('unit'), null, 'the oldest entry was evicted');
  assert.equal(wiring.getLastRunOutput('c0'), null, 'c0 and c1 fell off once 10 distinct ids ran');
  assert.ok(wiring.getLastRunOutput('c2'));
  assert.ok(wiring.getLastRunOutput('c9'));
});

test('row40: a refused or errored run stores no output', async () => {
  const { host, wiring, fake } = setupAvailability();
  wiring.bindEvents();
  await tick();
  fake.api.run = () => Promise.resolve({ error: { code: 'CMP-TESTRUNNER-0005', message: 'busy' } });
  clickEl(host.querySelector('[data-test-runner-run]'));
  await tick();
  fake.api.run = () => Promise.resolve({ available: false, reason: 'feature_disabled' });
  clickEl(host.querySelector('[data-test-runner-run]'));
  await tick();
  assert.equal(wiring.getLastRunOutput('unit'), null);
});

test('row40: a run refused because the feature turned off mid-session toasts and hides the tab', async () => {
  const { host, wiring, fake, toasts, changes } = setupAvailability();
  wiring.bindEvents();
  await tick();
  fake.api.run = () => Promise.resolve({ available: false, reason: 'feature_disabled' });
  clickEl(host.querySelector('[data-test-runner-run]'));
  await tick();
  await tick();
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].message, 'Test running is turned off.');
  assert.equal(wiring.isAvailable(), false);
  assert.deepEqual(changes, [false]);
});

test('row40: a features change re-reads availability, so a hidden tab comes back when the flag turns on', async () => {
  const base = setup();
  const listeners = [];
  let unsubscribed = 0;
  const windowRef = { jennyShell: { features: { onChanged: (cb) => { listeners.push(cb); return () => { unsubscribed += 1; }; } } } };
  const wiring = createIdeTestRunnerWiring({
    windowRef,
    getApi: () => base.fake.api,
    getMountEl: () => base.host,
    isActiveView: () => false,
    panelFactory: createIdeTestRunnerPanel,
    actionButton,
    textField,
    selectField,
    showShellErrorToast: () => {},
  });
  base.fake.setState(DISABLED_STATE);
  wiring.bindEvents();
  await tick();
  assert.equal(wiring.isAvailable(), false);
  assert.equal(listeners.length, 1);
  base.fake.setState({ configs: [], history: { byConfig: {} }, activeRun: null, activeConfigId: null });
  listeners[0]({});
  await tick();
  await tick();
  assert.equal(wiring.isAvailable(), true);
  wiring.dispose();
  assert.equal(unsubscribed, 1);
});
