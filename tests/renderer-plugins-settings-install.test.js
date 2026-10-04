'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');
const toggleSwitch = require('../renderer/inventory/toggle-switch');
const pluginsSettings = require('../renderer/shell/renderer-plugins-settings');

const INSTALL_BUTTON = '#pluginsHeaderActionsHost [data-plugins-settings-action="install-package"]';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const waitFor = async (predicate) => {
  for (let turn = 0; turn < 50 && !predicate(); turn += 1) await new Promise((resolve) => setTimeout(resolve, 2));
};

/* The Plugins page with a bridge shaped like production distribution: an
 * install answers `pending` at admission and its receipt carries the outcome.
 * `receiptStatuses` is what successive operation queries report. */
function harness(t, receiptStatuses, { getOperation = null, operationWaitMs, developerProfile = false } = {}) {
  const { window: windowRef } = new JSDOM(`<!doctype html><body>
    <section class="settings-card" data-settings-section="plugins">
      <div id="pluginsHeaderActionsHost"></div>
      <div id="pluginsSettingsHost"></div>
      <div id="pluginsSourcesHost"></div>
    </section></body>`, { pretendToBeVisual: true });
  const queries = [];
  const toasts = [];
  const queue = receiptStatuses.slice();
  const state = { ok: true, enabled: true, safe_mode_active: false, read_only: false,
    store_writable: true, runtime_status: 'ready', revision: 1, installed_count: 0, plugins: [] };
  windowRef.jennyShell = { plugins: {
    getState: async () => state,
    installLocalPackage: async () => ({ ok: true, operation_id: 'op_install_1', status: 'pending' }),
    getOperation: getOperation || (async (payload) => {
      queries.push(payload);
      const status = queue.length > 1 ? queue.shift() : queue[0];
      return { ok: true, classification: status === 'pending' ? 'pending' : 'terminal', receipt: { status } };
    }),
  } };
  const previous = [globalThis.inventoryActionButton, globalThis.inventoryTextField,
    globalThis.inventoryToggleSwitch];
  globalThis.inventoryActionButton = actionButton;
  globalThis.inventoryTextField = textField;
  globalThis.inventoryToggleSwitch = toggleSwitch;
  const controller = pluginsSettings.createPluginsSettingsController({
    state: { features: { featureFlags: { plugins: true, plugin_developer_profile: developerProfile } }, ui: {} },
    windowRef, documentRef: windowRef.document, operationPollMs: 0, operationWaitMs,
    showToastMessage: (message, options) => toasts.push({ message, tone: options?.tone }),
  });
  t.after(() => { controller.dispose(); [globalThis.inventoryActionButton, globalThis.inventoryTextField,
    globalThis.inventoryToggleSwitch] = previous; });
  return { controller, document: windowRef.document, queries, toasts };
}

test('an admitted install reports success only once its receipt is committed', async (t) => {
  const h = harness(t, ['pending', 'pending', 'committed']);
  h.controller.bind();
  await flush();
  h.document.querySelector(INSTALL_BUTTON).click();
  await flush();
  assert.deepEqual(h.toasts, [], 'admission alone is not an install');
  await waitFor(() => h.toasts.length > 0);
  assert.deepEqual(h.queries, Array(3).fill({ operation_id: 'op_install_1' }));
  assert.deepEqual(h.toasts, [{ message: 'Plugin installed — inactive.', tone: undefined }]);
});

test('an admitted install that fails later is reported as a failure, never as installed', async (t) => {
  const h = harness(t, ['pending', 'failed']);
  h.controller.bind();
  await flush();
  h.document.querySelector(INSTALL_BUTTON).click();
  await waitFor(() => h.toasts.length > 0);
  assert.deepEqual(h.toasts, [{ message: 'The operation failed.', tone: 'warning' }]);
  assert.equal(h.controller._test.getLastError(), 'The operation failed.');
});

test('a status query that never answers ends the wait at the deadline and frees the page', async (t) => {
  const h = harness(t, [], { getOperation: () => new Promise(() => {}), operationWaitMs: 20 });
  h.controller.bind();
  await flush();
  h.document.querySelector(INSTALL_BUTTON).click();
  await flush();
  assert.equal(h.document.querySelector(INSTALL_BUTTON).disabled, true, 'busy while waiting');
  await waitFor(() => h.toasts.length > 0);
  assert.deepEqual(h.toasts, [{
    message: 'Another plugin operation is still running. Wait for it to finish.', tone: 'warning' }]);
  await waitFor(() => h.document.querySelector(INSTALL_BUTTON).disabled === false);
  assert.equal(h.document.querySelector(INSTALL_BUTTON).disabled, false);
});

test('the drop zone mentions unsigned plugins only while the developer profile is on', async (t) => {
  const HINT = /Unsigned plugins are labelled and run in the developer profile\./;
  const off = harness(t, []);
  off.controller.bind();
  await flush();
  const offZone = off.document.querySelector('[data-plugins-drop-zone]');
  assert.match(offZone.textContent, /Drop a \.jenny-plugin file here or use Install plugin\./);
  assert.doesNotMatch(offZone.textContent, HINT);

  const on = harness(t, [], { developerProfile: true });
  on.controller.bind();
  await flush();
  assert.match(on.document.querySelector('[data-plugins-drop-zone]').textContent, HINT);
});
