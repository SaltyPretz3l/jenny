'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildWebSearchSectionMarkup,
  normalizeWebSearchState,
  WEB_SEARCH_PROVIDERS,
  WEB_SEARCH_SECRET_KEY_IDS,
} = require('../renderer/shell/renderer-settings-support');
const { createSettingsEventBindings } = require('../renderer/shell/renderer-settings-event-utils.js');
const textField = require('../renderer/inventory/text-field');
const { WEB_SEARCH_PROVIDER_IDS } = require('../services/shell-config-web-search');
const { WEB_SEARCH_PROVIDER_KEY_IDS } = require('../services/backend/secure-store');
const {
  escapeHtml,
  withGlobals,
  renderToDom,
  createHarness,
  createBaseDeps,
} = require('./helpers/settings-web-search-harness');

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
    assert.match(doc.body.textContent, /DuckDuckGo needs no setup/);
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


test('Web provider and credential rows retain their values and disable every control with Web tools off', () => {
  withGlobals(() => {
    for (const provider of ['searxng', 'google_pse']) {
      const doc = renderToDom(buildWebSearchSectionMarkup({ visible: true, parentOff: true, webSearch: { provider, searxngUrl: 'https://example.com' } }));
      const rows = doc.querySelectorAll('.settings-field--row');
      assert.ok(rows.length >= 2);
      for (const row of rows) {
        assert.equal(row.dataset.settingParentOff, 'true');
        assert.ok(row.classList.contains('settings-field--sub'));
        for (const control of row.querySelectorAll('input, select, button')) assert.equal(control.disabled, true);
        assert.equal(row.querySelectorAll('label.settings-field-title').length, 1);
        assert.equal(row.querySelectorAll('.inv-select-field-label, .inv-text-field-label').length, 0, 'no second visible label');
      }
      assert.equal(doc.getElementById('webSearchProviderSelect').value, provider);
      assert.equal(rows[0].nextElementSibling.matches('p.settings-field-note[data-web-search-test-status]'), true);
    }
  });
});

test('a refused provider save shows its reason on the provider row', async (t) => {
  const harness = createHarness('<div id="toolsConfigFieldList"></div>');
  t.after(() => harness.cleanup());
  const toolsConfigFieldList = harness.document.getElementById('toolsConfigFieldList');
  withGlobals(() => {
    toolsConfigFieldList.innerHTML = buildWebSearchSectionMarkup({ visible: true, webSearch: { provider: 'duckduckgo' }, escapeHtml });
  });
  createSettingsEventBindings(createBaseDeps({
    state: { features: { featureFlags: { web_search_providers: true }, webSearch: { provider: 'duckduckgo' } } },
    dom: { toolsConfigFieldList },
    callbacks: { async refreshFeatureState() { throw new Error('provider refused'); } },
  })).bind();
  const select = toolsConfigFieldList.querySelector('#webSearchProviderSelect');
  select.value = 'searxng';
  select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  const row = toolsConfigFieldList.querySelector('[data-settings-field="webSearchProviderSelect"]');
  assert.equal(row.getAttribute('data-state'), 'error');
  assert.equal(row.querySelector('.settings-field-error').hidden, false);
});
