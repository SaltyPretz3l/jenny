/* renderer/shell/renderer-settings-web-search.js - the Tools page web-search block.
 *
 * Split out of renderer-settings-support.js (which keeps re-exporting this surface): the provider
 * list, its normalizer and the provider/key rows. Pure markup builders; the Tools section binds them.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsWebSearch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }
  const defaultEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  // Web provider rows follow the Web tools switch in toolsWebList.
  const WEB_SEARCH_PROVIDERS = Object.freeze([
    Object.freeze({ value: 'duckduckgo', label: jt('settings.tools.webSearch.provider.duckDuckGo', 'DuckDuckGo (default, no key)') }),
    Object.freeze({ value: 'searxng', label: jt('settings.tools.webSearch.provider.searxng', 'SearXNG (self-hosted URL)') }),
    Object.freeze({ value: 'brave', label: jt('settings.tools.webSearch.provider.brave', 'Brave Search API') }),
    Object.freeze({ value: 'tavily', label: jt('settings.tools.webSearch.provider.tavily', 'Tavily') }),
    Object.freeze({ value: 'serper', label: jt('settings.tools.webSearch.provider.serper', 'Serper.dev') }),
    Object.freeze({ value: 'google_pse', label: jt('settings.tools.webSearch.provider.googlePse', 'Google Programmable Search') }),
  ]);
  const WEB_SEARCH_PROVIDER_VALUES = WEB_SEARCH_PROVIDERS.map((entry) => entry.value);
  // Providers whose credential is a single secret-store key id matching the
  // provider id. google_pse additionally needs the cx field (handled inline).
  const WEB_SEARCH_KEY_PROVIDERS = Object.freeze(['brave', 'tavily', 'serper', 'google_pse']);
  // All secret-store key ids the "Save key" affordance can write, including
  // the google_pse cx companion field (not itself a provider option).
  const WEB_SEARCH_SECRET_KEY_IDS = Object.freeze([...WEB_SEARCH_KEY_PROVIDERS, 'google_pse_cx']);

  function normalizeWebSearchState(payload) {
    const source = isPlainObject(payload) ? payload : {};
    const provider = WEB_SEARCH_PROVIDER_VALUES.includes(source.provider) ? source.provider : 'duckduckgo';
    return {
      provider,
      searxngUrl: normalizeString(source.searxngUrl),
    };
  }

  function getInventoryFn(name, standaloneGlobalName) {
    if (typeof globalThis === 'undefined') { return null; }
    const inv = globalThis.inventory;
    const fromBarrel = inv && inv[name];
    const standalone = globalThis[standaloneGlobalName];
    const fn = fromBarrel || standalone;
    return typeof fn === 'function' ? fn : null;
  }

  // Provider-specific credentials remain masked and use the secret bridge.
  function buildWebSearchSectionMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    if (source.visible !== true) {
      return '';
    }
    const escapeHtmlFn = typeof source.escapeHtml === 'function' ? source.escapeHtml : defaultEscapeHtml;
    const selectFieldFn = typeof source.selectField === 'function'
      ? source.selectField
      : getInventoryFn('selectField', 'inventorySelectField');
    const textFieldFn = typeof source.textField === 'function'
      ? source.textField
      : getInventoryFn('textField', 'inventoryTextField');
    const actionButtonFn = typeof source.actionButton === 'function'
      ? source.actionButton
      : getInventoryFn('actionButton', 'inventoryActionButton');
    const settingsField = source.settingsField || getInventoryFn('settingsField', 'inventorySettingsField');
    if (!settingsField || typeof selectFieldFn !== 'function' || typeof textFieldFn !== 'function') {
      return '';
    }
    const webSearch = normalizeWebSearchState(source.webSearch);
    const configured = isPlainObject(source.secretStatus?.configured) ? source.secretStatus.configured : {};
    const disabled = source.parentOff === true;
    const dataset = disabled ? { 'setting-parent-off': 'true' } : {};
    const testButton = typeof actionButtonFn === 'function' ? actionButtonFn({
      id: 'webSearchConnectionTest',
      label: jt('settings.tools.webSearch.testConnection', 'Test'),
      variant: 'secondary',
      size: 'sm',
      disabled,
      dataset: { 'web-search-test': 'true' },
    }) : '';
    const parts = [settingsField({
      // The row carries its descriptor's id, so a refused save lands in its alert slot.
      id: 'webSearchProviderSelect',
      variant: 'row',
      // Provider names run long ("Google Programmable Search"): the wide dropdown.
      className: 'settings-field--sub settings-field--wide-control',
      dataset,
      label: jt('settings.tools.webSearch.providerLabel', 'Search provider'),
      labelFor: 'webSearchProviderSelect',
      help: jt('settings.tools.webSearch.providerHelp', 'DuckDuckGo needs no setup.'),
      controlHtml: testButton + selectFieldFn({
        id: 'webSearchProviderSelect',
        value: webSearch.provider,
        disabled,
        options: WEB_SEARCH_PROVIDERS.map((entry) => ({ value: entry.value, label: entry.label })),
        ariaLabel: jt('settings.tools.webSearch.providerAriaLabel', 'Web search provider'),
        dataset: { 'web-search-field': 'provider' },
      }),
    }), '<p class="settings-field-note" data-web-search-test-status aria-live="polite"></p>'];
    if (webSearch.provider === 'searxng') {
      const label = jt('settings.tools.webSearch.searxngUrlLabel', 'SearXNG instance URL');
      parts.push(settingsField({
        id: 'webSearchSearxngUrlField',
        variant: 'row',
        className: 'settings-field--sub settings-field--block',
        label,
        labelFor: 'webSearchSearxngUrlField',
        dataset,
        controlHtml: textFieldFn({
          id: 'webSearchSearxngUrlField',
          value: webSearch.searxngUrl,
          disabled,
          ariaLabel: label,
          placeholder: jt('settings.tools.webSearch.searxngUrlPlaceholder', 'https://searx.example.com'),
          dataset: { 'web-search-field': 'searxngUrl' },
        }),
      }));
    }
    if (WEB_SEARCH_KEY_PROVIDERS.includes(webSearch.provider)) {
      parts.push(buildWebSearchKeyFieldMarkup({
        keyId: webSearch.provider,
        settingsField,
        disabled,
        label: jt('settings.tools.webSearch.apiKeyLabel', 'API key'),
        configured: configured[webSearch.provider] === true,
        textField: textFieldFn,
        actionButton: actionButtonFn,
        escapeHtml: escapeHtmlFn,
      }));
      if (webSearch.provider === 'google_pse') {
        parts.push(buildWebSearchKeyFieldMarkup({
          keyId: 'google_pse_cx',
          settingsField,
          disabled,
          label: jt('settings.tools.webSearch.searchEngineIdLabel', 'Search engine ID (cx)'),
          configured: configured.google_pse_cx === true,
          textField: textFieldFn,
          actionButton: actionButtonFn,
          escapeHtml: escapeHtmlFn,
        }));
      }
    }
    return '<div data-web-search-section="true">' + parts.join('') + '</div>';
  }

  // One key field row: password-masked input + inline Save button + a subtle
  // "configured" hint. The input is NEVER pre-filled with a real secret value.
  function buildWebSearchKeyFieldMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const escapeHtmlFn = typeof source.escapeHtml === 'function' ? source.escapeHtml : defaultEscapeHtml;
    const keyId = normalizeString(source.keyId);
    const fieldId = `webSearchKeyField-${keyId}`.replace(/[^A-Za-z0-9_-]/g, '-');
    const fieldMarkup = source.textField({
      id: fieldId,
      disabled: source.disabled,
      value: '',
      type: 'password',
      // The search engine ID is not a key, so its empty field does not ask for one.
      placeholder: source.configured === true ? jt('settings.tools.webSearch.configuredPlaceholder', 'Configured (hidden)')
        : keyId === 'google_pse_cx' ? '' : jt('settings.tools.webSearch.enterApiKeyPlaceholder', 'Enter API key'),
      ariaLabel: source.label,
      dataset: { 'web-search-key-field': keyId },
    });
    const saveButtonMarkup = typeof source.actionButton === 'function'
      ? source.actionButton({
        id: `webSearchKeySave-${keyId}`,
        disabled: source.disabled,
        label: jt('settings.tools.webSearch.saveKey', 'Save key'),
        variant: 'secondary',
        size: 'sm',
        ariaLabel: jt('settings.tools.webSearch.saveKeyAriaLabel', 'Save {label}', { label: source.label }),
        title: jt('settings.tools.webSearch.saveKeyTitle', 'Save this API key'),
        dataset: { 'web-search-key-save': keyId },
      })
      : '';
    const hint = source.configured === true
      ? `<span class="settings-field-note" data-web-search-key-hint="${escapeHtmlFn(keyId)}">${escapeHtmlFn(jt('common.configured', 'Configured'))}</span>`
      : '';
    return source.settingsField({
      id: `webSearchKeyRow-${keyId}`,
      variant: 'row',
      className: 'settings-field--sub settings-field--block',
      label: source.label,
      labelFor: fieldId,
      controlHtml: fieldMarkup + saveButtonMarkup + hint,
      dataset: { 'web-search-key-row': keyId, ...(source.disabled ? { 'setting-parent-off': 'true' } : {}) },
    });
  }

  // Resolves a delegated click on a "Save key" button into { keyId } or null.
  function resolveWebSearchKeySaveClickEvent(event) {
    const target = event?.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-web-search-key-save]')
      : null;
    if (!target) {
      return null;
    }
    const keyId = normalizeString(target.getAttribute('data-web-search-key-save'));
    return keyId ? { keyId } : null;
  }

  return {
    WEB_SEARCH_PROVIDERS,
    WEB_SEARCH_SECRET_KEY_IDS,
    normalizeWebSearchState,
    buildWebSearchSectionMarkup,
    resolveWebSearchKeySaveClickEvent,
  };
});
