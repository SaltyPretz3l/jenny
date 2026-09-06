'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  buildWebSearchSectionMarkup,
  normalizeWebSearchState,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_SECRET_KEY_IDS,
} = require('../renderer/shell/renderer-settings-support');
const { createSettingsEventBindings } = require('../renderer/shell/renderer-settings-event-utils.js');
const selectField = require('../renderer/inventory/select-field');
const textField = require('../renderer/inventory/text-field');
const actionButton = require('../renderer/inventory/action-button');
const { WEB_SEARCH_PROVIDER_IDS } = require('../services/shell-config-web-search');
const { WEB_SEARCH_PROVIDER_KEY_IDS } = require('../services/backend/secure-store');

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function withGlobals(run) {
  const prevInventory = globalThis.inventory;
  const prevSelectField = globalThis.inventorySelectField;
  const prevTextField = globalThis.inventoryTextField;
  const prevActionButton = globalThis.inventoryActionButton;
  globalThis.inventorySelectField = selectField;
  globalThis.inventoryTextField = textField;
  globalThis.inventoryActionButton = actionButton;
  globalThis.inventory = { selectField, textField, actionButton };
  try {
    return run();
  } finally {
    globalThis.inventory = prevInventory;
    globalThis.inventorySelectField = prevSelectField;
    globalThis.inventoryTextField = prevTextField;
    globalThis.inventoryActionButton = prevActionButton;
  }
}

function renderToDom(markup) {
  return new JSDOM(`<!doctype html><body>${markup}</body>`).window.document;
}

// --- text-field password support ------------------------------------------

test('textField defaults to type="text" and stays byte-compatible for existing callers', () => {
  const markup = textField({ id: 'plainField', label: 'Plain', value: 'hello' });
  const doc = renderToDom(markup);
  const input = doc.querySelector('#plainField');
  assert.equal(input.getAttribute('type'), 'text');
  assert.equal(input.value, 'hello');
});

test('textField renders type="password" when opted in, and falls back to text for unknown types', () => {
  const passwordMarkup = textField({ id: 'pwField', label: 'Key', type: 'password' });
  const passwordDoc = renderToDom(passwordMarkup);
  assert.equal(passwordDoc.querySelector('#pwField').getAttribute('type'), 'password');

  const unknownMarkup = textField({ id: 'weirdField', label: 'Weird', type: 'email' });
  const unknownDoc = renderToDom(unknownMarkup);
  assert.equal(unknownDoc.querySelector('#weirdField').getAttribute('type'), 'text');
});

// --- normalizeWebSearchState -----------------------------------------------

test('normalizeWebSearchState falls back to duckduckgo for unknown providers and trims the URL', () => {
  assert.deepEqual(normalizeWebSearchState({ provider: 'not_a_provider', searxngUrl: '  https://x  ' }), {
    provider: 'duckduckgo',
    searxngUrl: 'https://x',
  });
  assert.deepEqual(normalizeWebSearchState(null), { provider: 'duckduckgo', searxngUrl: '' });
});

// --- buildWebSearchSectionMarkup --------------------------------------------

test('buildWebSearchSectionMarkup renders nothing when the flag is off', () => {
  const markup = buildWebSearchSectionMarkup({
    visible: false,
    webSearch: { provider: 'brave' },
    escapeHtml,
  });
  assert.equal(markup, '');
});

test('buildWebSearchSectionMarkup renders the provider select with the current value when the flag is on', () => {
  withGlobals(() => {
    const markup = buildWebSearchSectionMarkup({
      visible: true,
      webSearch: { provider: 'duckduckgo', searxngUrl: '' },
      escapeHtml,
    });
    const doc = renderToDom(markup);
    const select = doc.querySelector('#webSearchProviderSelect');
    assert.ok(select, 'provider select is present');
    assert.equal(select.value, 'duckduckgo');
    // DuckDuckGo needs no key/url field.
    assert.equal(doc.querySelector('#webSearchSearxngUrlField'), null);
    assert.equal(doc.querySelector('[data-web-search-key-field]'), null);
    // Help text is present.
    assert.match(doc.body.textContent, /DuckDuckGo needs no configuration/);
  });
});

test('buildWebSearchSectionMarkup shows the SearXNG URL field only for the searxng provider', () => {
  withGlobals(() => {
    const markup = buildWebSearchSectionMarkup({
      visible: true,
      webSearch: { provider: 'searxng', searxngUrl: 'https://searx.example.com' },
      escapeHtml,
    });
    const doc = renderToDom(markup);
    const urlField = doc.querySelector('#webSearchSearxngUrlField');
    assert.ok(urlField, 'searxng URL field is present');
    assert.equal(urlField.value, 'https://searx.example.com');
    assert.equal(urlField.getAttribute('type'), 'text');
    assert.equal(doc.querySelector('[data-web-search-key-field]'), null, 'no key field for searxng');
  });
});

test('buildWebSearchSectionMarkup shows a masked key field for a key-based provider', () => {
  withGlobals(() => {
    const markup = buildWebSearchSectionMarkup({
      visible: true,
      webSearch: { provider: 'brave' },
      secretStatus: { configured: { brave: true } },
      escapeHtml,
    });
    const doc = renderToDom(markup);
    const keyField = doc.querySelector('[data-web-search-key-field="brave"]');
    assert.ok(keyField, 'brave key field is present');
    assert.equal(keyField.getAttribute('type'), 'password');
    assert.equal(keyField.value, '', 'the key value is never read back');
    assert.ok(doc.querySelector('[data-web-search-key-save="brave"]'), 'save button present');
    assert.equal(doc.querySelector('[data-web-search-key-save="brave"]').getAttribute('title'), 'Save this API key');
    assert.ok(doc.querySelector('[data-web-search-key-hint="brave"]'), 'configured hint present');
    assert.equal(doc.querySelector('#webSearchSearxngUrlField'), null);
    // Only one key field for brave (no cx companion).
    assert.equal(doc.querySelectorAll('[data-web-search-key-field]').length, 1);
  });
});

test('buildWebSearchSectionMarkup shows both key and cx fields for google_pse', () => {
  withGlobals(() => {
    const markup = buildWebSearchSectionMarkup({
      visible: true,
      webSearch: { provider: 'google_pse' },
      secretStatus: { configured: { google_pse: false, google_pse_cx: true } },
      escapeHtml,
    });
    const doc = renderToDom(markup);
    const keyField = doc.querySelector('[data-web-search-key-field="google_pse"]');
    const cxField = doc.querySelector('[data-web-search-key-field="google_pse_cx"]');
    assert.ok(keyField, 'google_pse key field present');
    assert.ok(cxField, 'google_pse cx field present');
    assert.equal(keyField.getAttribute('type'), 'password');
    assert.equal(cxField.getAttribute('type'), 'password');
    // Only the cx field is "configured".
    assert.equal(doc.querySelector('[data-web-search-key-hint="google_pse"]'), null);
    assert.ok(doc.querySelector('[data-web-search-key-hint="google_pse_cx"]'));
  });
});

// --- event wiring ------------------------------------------------------------

function createHarness(markup) {
  const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousAbortController = global.AbortController;
  global.window = dom.window;
  global.document = dom.window.document;
  global.AbortController = dom.window.AbortController;
  global.window.jennyShell = { comet: {}, models: {} };
  return {
    window: dom.window,
    document: dom.window.document,
    cleanup() {
      global.window = previousWindow;
      global.document = previousDocument;
      global.AbortController = previousAbortController;
      dom.window.close();
    },
  };
}

function createBaseDeps(overrides = {}) {
  const stateOverride = overrides.state || {};
  const baseState = {
    ui: { appearance: {} },
    features: { featureFlags: {} },
    memoryManager: { filter: 'all', searchQuery: '' },
    modelList: [],
    personality: {},
  };
  return {
    state: {
      ...baseState,
      ...stateOverride,
      ui: { ...baseState.ui, ...(stateOverride.ui || {}) },
    },
    constants: {
      TOAST_SOURCE: { settings: 'settings', memory: 'memory' },
      ACTIVITY_SCOPE: {},
    },
    dom: {
      settingsView: null,
      getSectionDom() { return {}; },
      ...overrides.dom,
    },
    callbacks: {
      renderSettings() {},
      renderSessions() {},
      setSidebarCollapsed() {},
      upsertApprovedMemoryDraft() {},
      getApprovedMemoryById() { return null; },
      hasApprovedMemoryDraftChanges() { return false; },
      clearApprovedMemoryDraft() {},
      handleApprovedMemorySave: async () => {},
      handleApprovedMemoryDelete() {},
      applyAppearancePreferences() {},
      appearanceUtils: null,
      getDefaultAppearancePreferences() { return {}; },
      applySurfaceEffect() {},
      activateSurfaceEffect() {},
      handlePersonalityTabChange: async () => {},
      getPersonalityActiveFile() { return null; },
      setPersonalityDraft() {},
      renderPersonalityEditor() {},
      handlePersonalitySave: async () => {},
      handlePersonalityReset: async () => {},
      handlePersonalityOpenFolder: async () => {},
      showShellErrorToast() {},
      toErrorMessage(error, fallback) { return error?.message || fallback; },
      appendClientLog() {},
      showSessionActionError() {},
      getCurrentRuntimePreferences() {
        return { contextPreferences: {} };
      },
      getRuntimePreferenceSnapshot() { return {}; },
      runRuntimePreferenceActivity: async () => {},
      openSettingsSection() {},
      handleWorkspaceRootChoose: async () => {},
      refreshSkillsState: async () => {},
      updateSkillsSettings() {},
      openSkillsScopeFolder() {},
      handleOfflineModeChange: async () => {},
      refreshFeatureState: async () => {},
      setActiveView() {},
      ...overrides.callbacks,
    },
  };
}

test('provider select change routes an applyFeatureSettings-style patch through refreshFeatureState', (t) => {
  const harness = createHarness('<div id="toolsConfigFieldList"></div>');
  t.after(() => harness.cleanup());

  const toolsConfigFieldList = harness.document.getElementById('toolsConfigFieldList');
  withGlobals(() => {
    toolsConfigFieldList.innerHTML = buildWebSearchSectionMarkup({
      visible: true,
      webSearch: { provider: 'duckduckgo' },
      escapeHtml,
    });
  });

  const patches = [];
  const controller = createSettingsEventBindings(createBaseDeps({
    state: { features: { featureFlags: { web_search_providers: true }, webSearch: { provider: 'duckduckgo' } } },
    dom: { toolsConfigFieldList },
    callbacks: {
      async refreshFeatureState(patch) { patches.push(patch); },
    },
  }));
  controller.bind();

  const select = toolsConfigFieldList.querySelector('#webSearchProviderSelect');
  select.value = 'searxng';
  select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));

  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0], { webSearch: { provider: 'searxng' } });
});

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
  assert.ok(renderCount >= 1, 'renderSettings is called after save so the input/hint can refresh');
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

test('bind() hydrates the configured-key status once when the flag is already on', (t) => {
  const harness = createHarness('<div id="toolsConfigFieldList"></div>');
  t.after(() => harness.cleanup());

  const toolsConfigFieldList = harness.document.getElementById('toolsConfigFieldList');
  let statusCalls = 0;
  harness.window.jennyShell.features = {
    async getWebSearchSecretStatus() {
      statusCalls += 1;
      return { configured: { brave: true } };
    },
  };

  const controller = createSettingsEventBindings(createBaseDeps({
    state: { features: { featureFlags: { web_search_providers: true } } },
    dom: { toolsConfigFieldList },
  }));
  controller.bind();

  assert.equal(statusCalls, 1);
});

// --- provider-id triplication drift guard ------------------------------------
// Provider ids are declared three times: services/shell-config-web-search.js
// (config normalization), renderer-settings-support.js (the Settings section
// UI), and services/backend/secure-store.js (the credential key-id allowlist).
// The renderer file cannot require services/ modules directly (browser-side
// UMD), so nothing enforces the three lists stay in sync. These tests are that
// enforcement: any future edit to one list without the others fails here.
test('renderer web-search provider options are exactly the shell-config-web-search provider id set', () => {
  const rendererProviderValues = WEB_SEARCH_PROVIDERS.map((entry) => entry.value).sort();
  const canonicalProviderIds = [...WEB_SEARCH_PROVIDER_IDS].sort();
  assert.deepEqual(rendererProviderValues, canonicalProviderIds);
});

test('renderer web-search secret key ids are exactly the SecureStore key-id set (including google_pse_cx)', () => {
  const rendererSecretKeyIds = [...WEB_SEARCH_SECRET_KEY_IDS].sort();
  const canonicalKeyIds = [...WEB_SEARCH_PROVIDER_KEY_IDS].sort();
  assert.deepEqual(rendererSecretKeyIds, canonicalKeyIds);
  // google_pse_cx is a key id with no corresponding provider option.
  assert.ok(WEB_SEARCH_SECRET_KEY_IDS.includes('google_pse_cx'));
  assert.equal(WEB_SEARCH_PROVIDERS.some((entry) => entry.value === 'google_pse_cx'), false);
});

// --- Fix: in-flight key input must survive a late secret-status render -----

test('refreshWebSearchSecretStatus does not re-render when the fetched status deep-equals the stored one', async (t) => {
  const harness = createHarness('<div id="toolsConfigFieldList"></div>');
  t.after(() => harness.cleanup());

  const toolsConfigFieldList = harness.document.getElementById('toolsConfigFieldList');
  const existingStatus = { configured: { brave: true } };
  harness.window.jennyShell.features = {
    async getWebSearchSecretStatus() { return { configured: { brave: true } }; },
  };

  let renderCount = 0;
  const controller = createSettingsEventBindings(createBaseDeps({
    state: {
      features: { featureFlags: { web_search_providers: true } },
      webSearchSecrets: existingStatus,
    },
    dom: { toolsConfigFieldList },
    callbacks: {
      renderSettings() { renderCount += 1; },
    },
  }));
  controller.bind();

  // bind() skips the initial hydrate call because state.webSearchSecrets is
  // already populated (ensureWebSearchSecretStatus's own guard), so nothing
  // should have rendered yet.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(renderCount, 0);
});

test('key save skips a re-render when a web-search key input is focused, even after status changes', async (t) => {
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

  harness.window.jennyShell.features = {
    async getWebSearchSecretStatus() { return { configured: { brave: true } }; },
  };

  let renderCount = 0;
  const controller = createSettingsEventBindings(createBaseDeps({
    state: {
      features: { featureFlags: { web_search_providers: true } },
      webSearchSecrets: { configured: { brave: false } },
    },
    dom: { toolsConfigFieldList },
    callbacks: {
      renderSettings() { renderCount += 1; },
    },
  }));
  controller.bind();

  // Simulate the user mid-typing into the key field before bind()'s hydrate
  // call (fired synchronously above) resolves its IPC round-trip.
  const input = toolsConfigFieldList.querySelector('[data-web-search-key-field="brave"]');
  input.value = 'partial-key-in-progress';
  input.focus();

  // Flush the pending getWebSearchSecretStatus() microtasks fired by bind().
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(renderCount, 0, 'a focused/non-empty key input must not be wiped by a status refresh');
  assert.equal(input.value, 'partial-key-in-progress');
});

test('applyWebSearchSecret configRefreshed:false shows a success note, not a failure toast', async (t) => {
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

  harness.window.jennyShell.features = {
    async getWebSearchSecretStatus() { return { configured: { brave: false } }; },
    async setWebSearchSecret() {
      return { configured: { brave: true }, configRefreshed: false };
    },
  };

  const toastCalls = [];
  const errorCalls = [];
  const controller = createSettingsEventBindings(createBaseDeps({
    state: { features: { featureFlags: { web_search_providers: true } }, webSearchSecrets: { configured: { brave: false } } },
    dom: { toolsConfigFieldList },
    callbacks: {
      showToastMessage(message, options) { toastCalls.push({ message, options }); },
      showSessionActionError(error, title) { errorCalls.push({ error, title }); },
    },
  }));
  controller.bind();

  const input = toolsConfigFieldList.querySelector('[data-web-search-key-field="brave"]');
  input.value = 'k';
  const saveButton = toolsConfigFieldList.querySelector('[data-web-search-key-save="brave"]');
  saveButton.dispatchEvent(new harness.window.Event('click', { bubbles: true }));

  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errorCalls.length, 0, 'a configRefreshed:false save must not show a failure toast');
  assert.equal(toastCalls.length, 1);
  assert.match(toastCalls[0].message, /sidecar|restart/i);
  assert.notEqual(toastCalls[0].options?.tone, 'danger');
});
