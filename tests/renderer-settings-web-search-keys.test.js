'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildWebSearchSectionMarkup } = require('../renderer/shell/renderer-settings-support');
const { createSettingsEventBindings } = require('../renderer/shell/renderer-settings-event-utils.js');
const {
  escapeHtml,
  withGlobals,
  createHarness,
  createBaseDeps,
} = require('./helpers/settings-web-search-harness');

test('key save calls features.setWebSearchSecret and clears the input', async (t) => {
  const harness = createHarness('<div id="toolsConfigFieldList"></div>');
  t.after(() => harness.cleanup());

  const toolsConfigFieldList = harness.document.getElementById('toolsConfigFieldList');
  withGlobals(() => {
    toolsConfigFieldList.innerHTML = buildWebSearchSectionMarkup({
      visible: true,
      webSearch: { provider: 'brave' },
      secretStatus: { configured: { brave: false } },
      escapeHtml,
    });
  });

  const savedCalls = [];
  harness.window.jennyShell.features = {
    async getWebSearchSecretStatus() { return { configured: { brave: false } }; },
    async setWebSearchSecret(payload) {
      savedCalls.push(payload);
      return { configured: { brave: true } };
    },
  };

  let renderCount = 0;
  const controller = createSettingsEventBindings(createBaseDeps({
    state: { features: { featureFlags: { web_search_providers: true }, webSearch: { provider: 'brave' } } },
    dom: { toolsConfigFieldList },
    callbacks: {
      renderSettings() { renderCount += 1; },
    },
  }));
  controller.bind();

  const input = toolsConfigFieldList.querySelector('[data-web-search-key-field="brave"]');
  input.value = 'k';
  const saveButton = toolsConfigFieldList.querySelector('[data-web-search-key-save="brave"]');
  saveButton.dispatchEvent(new harness.window.Event('click', { bubbles: true }));

  // The save handler's IPC round-trip resolves on a microtask; flush it.
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(savedCalls, [{ keyId: 'brave', value: 'k' }]);
  assert.equal(input.value, '', 'the saved key no longer reads as an unsaved draft');
  assert.ok(renderCount >= 1, 'renderSettings is called after save so the input/hint can refresh');
});

test('a refused key save keeps the typed key in the input', async (t) => {
  const harness = createHarness('<div id="toolsConfigFieldList"></div>');
  t.after(() => harness.cleanup());
  const toolsConfigFieldList = harness.document.getElementById('toolsConfigFieldList');
  withGlobals(() => {
    toolsConfigFieldList.innerHTML = buildWebSearchSectionMarkup({
      visible: true, webSearch: { provider: 'brave' }, secretStatus: { configured: { brave: false } }, escapeHtml,
    });
  });
  harness.window.jennyShell.features = {
    async getWebSearchSecretStatus() { return { configured: { brave: false } }; },
    async setWebSearchSecret() { throw new Error('store locked'); },
  };
  const errors = [];
  const controller = createSettingsEventBindings(createBaseDeps({
    state: { features: { featureFlags: { web_search_providers: true } }, webSearchSecrets: { configured: { brave: false } } },
    dom: { toolsConfigFieldList },
    callbacks: { showSessionActionError(error, title) { errors.push(title); } },
  }));
  controller.bind();
  const input = toolsConfigFieldList.querySelector('[data-web-search-key-field="brave"]');
  input.value = 'k';
  toolsConfigFieldList.querySelector('[data-web-search-key-save="brave"]').dispatchEvent(new harness.window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.value, 'k');
  assert.deepEqual(errors, ['Web Search Key Update Failed']);
});

test('a failed key-status hydration is logged and retried on the next provider change', async (t) => {
  const harness = createHarness('<div id="toolsConfigFieldList"></div>');
  t.after(() => harness.cleanup());
  const toolsConfigFieldList = harness.document.getElementById('toolsConfigFieldList');
  let reads = 0;
  harness.window.jennyShell.features = {
    async getWebSearchSecretStatus() { reads += 1; if (reads === 1) throw new Error('bridge down'); return { configured: {} }; },
  };
  const logs = [];
  const features = { featureFlags: { web_search_providers: true }, webSearch: { provider: 'duckduckgo', searxngUrl: '' } };
  const controller = createSettingsEventBindings(createBaseDeps({
    state: { features },
    dom: { toolsConfigFieldList },
    callbacks: {
      appendClientLog(level, event) { logs.push([level, event]); },
      async refreshFeatureState(patch) {
        features.webSearch = { ...features.webSearch, ...patch.webSearch };
        return features;
      },
    },
  }));
  controller.bind();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 1);
  assert.deepEqual(logs.filter(([, event]) => event === 'settings.web_search_secret_status_failed'), [['WARN', 'settings.web_search_secret_status_failed']]);
  // The provider row is a descriptor field: a confirmed provider save hydrates again.
  withGlobals(() => {
    toolsConfigFieldList.innerHTML = buildWebSearchSectionMarkup({ visible: true, webSearch: { provider: 'duckduckgo' }, escapeHtml });
  });
  const select = toolsConfigFieldList.querySelector('#webSearchProviderSelect');
  select.value = 'brave';
  select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 2, 'the hydration flag was reset, so the next attempt reads again');
});

test('a late secret-status hydration cannot overwrite a newer successful key save', async (t) => {
  const harness = createHarness('<div id="toolsConfigFieldList"></div>');
  t.after(() => harness.cleanup());
  const toolsConfigFieldList = harness.document.getElementById('toolsConfigFieldList');
  withGlobals(() => {
    toolsConfigFieldList.innerHTML = buildWebSearchSectionMarkup({
      visible: true,
      webSearch: { provider: 'brave' },
      secretStatus: { configured: { brave: false } },
      escapeHtml,
    });
  });
  let resolveHydration;
  harness.window.jennyShell.features = {
    getWebSearchSecretStatus() {
      return new Promise((resolve) => { resolveHydration = resolve; });
    },
    async setWebSearchSecret() { return { configured: { brave: true } }; },
  };
  const state = { features: { featureFlags: { web_search_providers: true },
    webSearch: { provider: 'brave' } } };
  const deps = createBaseDeps({
    state,
    dom: { toolsConfigFieldList },
  });
  const controller = createSettingsEventBindings(deps);
  controller.bind();
  const input = toolsConfigFieldList.querySelector('[data-web-search-key-field="brave"]');
  input.value = 'new-key';
  toolsConfigFieldList.querySelector('[data-web-search-key-save="brave"]')
    .dispatchEvent(new harness.window.Event('click', { bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(deps.state.webSearchSecrets.configured.brave, true);

  resolveHydration({ configured: { brave: false } });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(deps.state.webSearchSecrets.configured.brave, true);
});
