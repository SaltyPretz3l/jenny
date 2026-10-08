'use strict';

/* Row 40 W4 (owner decision F6): the Test Runner row's "Show output" action. It
 * appears only when the wiring kept output for the config, routes to the host's
 * onShowOutput, and the wiring exposes runConfig for the test-output view. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTestRunnerWiring } = require('../renderer/features/renderer-ide-test-runner-wiring.js');
const { createIdeTestRunnerPanel } = require('../renderer/features/renderer-ide-test-runner-panel.js');
const actionButton = require('../renderer/inventory/action-button.js');
const textField = require('../renderer/inventory/text-field.js');
const selectField = require('../renderer/inventory/select-field.js');
const { tick, clickEl, makeApi } = require('./helpers/test-runner-wiring-fixture');

function setup() {
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const host = dom.window.document.getElementById('host');
  const fake = makeApi();
  const shown = [];
  const changed = [];
  fake.api.run = (payload) => {
    fake.calls.run.push(payload);
    return Promise.resolve({ configId: payload.configId, runId: `r${fake.calls.run.length}`, status: 'failed', exitCode: 2, stdoutTail: 'out', stderrTail: '' });
  };
  const wiring = createIdeTestRunnerWiring({
    getApi: () => fake.api,
    getMountEl: () => host,
    isActiveView: () => true,
    panelFactory: createIdeTestRunnerPanel,
    actionButton,
    textField,
    selectField,
    onShowOutput: (id) => shown.push(id),
    onOutputChange: (id) => changed.push(id),
  });
  return { host, wiring, fake, shown, changed };
}

const showButton = (host) => host.querySelector('[data-test-runner-show-output]');

test('Show output is absent before a run and appears once the run kept output', async () => {
  const { host, wiring, changed } = setup();
  wiring.bindEvents();
  await tick();
  assert.equal(showButton(host), null, 'no output yet, no action');
  clickEl(host.querySelector('[data-test-runner-run]'));
  await tick();
  assert.ok(showButton(host), 'the row now offers Show output');
  assert.equal(showButton(host).textContent.trim(), 'Show output');
  assert.deepEqual(changed, ['unit'], 'the host is told the kept output changed');
});

test('Show output calls onShowOutput with the row config id', async () => {
  const { host, wiring, shown } = setup();
  wiring.bindEvents();
  await tick();
  clickEl(host.querySelector('[data-test-runner-run]'));
  await tick();
  clickEl(showButton(host));
  assert.deepEqual(shown, ['unit']);
});

test('the kept output records the exit code, and runConfig re-runs through the panel path', async () => {
  const { wiring, fake, changed } = setup();
  wiring.bindEvents();
  await tick();
  await wiring.runConfig('unit');
  assert.deepEqual(fake.calls.run, [{ configId: 'unit', includeOutput: true }]);
  assert.equal(wiring.getLastRunOutput('unit').exitCode, 2);
  assert.equal(changed.length, 1);
});

test('the optional onShowOutput dep is not required to render', async () => {
  const dom = new JSDOM('<main><div id="host"></div></main>');
  const host = dom.window.document.getElementById('host');
  const fake = makeApi();
  const wiring = createIdeTestRunnerWiring({
    getApi: () => fake.api, getMountEl: () => host, isActiveView: () => true, panelFactory: createIdeTestRunnerPanel, actionButton, textField, selectField,
  });
  wiring.bindEvents();
  await tick();
  assert.ok(host.querySelector('.ide-test-runner-panel__row'));
  assert.equal(showButton(host), null);
});

test('a workspace root switch drops the kept output, so Show output and the output view go away', async () => {
  const { host, wiring } = setup();
  wiring.bindEvents();
  await tick();
  await wiring.runConfig('unit');
  assert.ok(wiring.getLastRunOutput('unit'));
  await wiring.resetForRoot();
  await tick();
  assert.equal(wiring.getLastRunOutput('unit'), null);
  assert.equal(showButton(host), null);
});

test('getConfigLabel names a config by its label, else its id', async () => {
  const { wiring } = setup();
  wiring.bindEvents();
  await tick();
  assert.equal(wiring.getConfigLabel('unit'), 'Unit');
  assert.equal(wiring.getConfigLabel('gone'), 'gone');
});
