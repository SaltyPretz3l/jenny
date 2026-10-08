(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-settings-field-copy.js'));
    return;
  }
  root.rendererSettingsSupport = factory(root.rendererSettingsFieldCopy || null);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (fieldCopyModule) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const getFieldCopy = fieldCopyModule && typeof fieldCopyModule.getSettingsFieldCopy === 'function'
    ? fieldCopyModule.getSettingsFieldCopy
    : function () { return null; };
  function inferEngineTypeFromModel(model) {
    const token = String(model || '').trim().toLowerCase();
    if (!token) {
      return '';
    }
    if (token.startsWith('mock')) return 'mock';
    return 'ollama';
  }

  function resolveReasoningEffortSupport(status, runtimePreferences) {
    const localRuntime =
      status?.local_runtime
      && typeof status.local_runtime === 'object'
      && !Array.isArray(status.local_runtime)
        ? status.local_runtime
        : null;
    const localRuntimeSupport = String(localRuntime?.reasoning?.support || '').trim().toLowerCase();
    if (localRuntimeSupport === 'supported' || localRuntimeSupport === 'unsupported') {
      return localRuntimeSupport;
    }
    const providerCapabilities =
      status?.provider_capabilities
      && typeof status.provider_capabilities === 'object'
      && !Array.isArray(status.provider_capabilities)
        ? status.provider_capabilities
        : null;
    const preferredEngine = inferEngineTypeFromModel(runtimePreferences?.preferredModel);
    const statusEngine = String(status?.engine || '').trim().toLowerCase();
    const targetEngine = statusEngine || preferredEngine;
    const declaredSupport = String(
      targetEngine && providerCapabilities
        ? providerCapabilities[targetEngine]?.reasoning_effort_support || ''
        : ''
    ).trim().toLowerCase();
    if (declaredSupport === 'supported' || declaredSupport === 'unsupported') {
      return declaredSupport;
    }
    const fallbackSupport = String(status?.reasoning_effort_support || 'unknown').trim().toLowerCase();
    return fallbackSupport || 'unknown';
  }

  // Derives the Models card badge { state, text } from runtime signals, ready to
  // pass to the design-system applyBadgeState (renderer-settings-foundation.js).
  // Lives here next to the other Models/session resolvers rather than in the
  // generic foundation module, which holds only section-agnostic primitives.
  function resolveModelBadge(signals) {
    const s = signals && typeof signals === 'object' ? signals : {};
    const state = s.busy ? 'busy'
      : s.errored ? 'error'
      : (s.catalogUnavailable && !s.activeModel) ? 'warn'
      : s.activeModel ? 'live' : 'info';
    const text = s.busy ? (s.loadingModel ? 'Switching' : 'Unloading')
      : state === 'error' ? 'Error'
      : state === 'warn' ? 'Unavailable'
      : (s.activeModel || jt('settings.modelLibrary.defaultBackend', 'Default backend'));
    return { state, text };
  }

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

  const TOOL_CONFIG_TOGGLE_ID_PREFIX = 'settings-tool-config-';
  // Dependent row (or row set) -> the tool switch it follows. While the parent is
  // off the dependent row is marked parent-off and locked, and its stored value is kept.
  const TOOL_DEPENDENTS = Object.freeze({ richFiles: 'fileTools', commandSandbox: 'bash', webSearch: 'web' });
  const RUN_MODES = Object.freeze(['ask', 'auto', 'plan', 'propose']);
  // Propose (row 35) is chosen per chat, never as the new-chat default.
  const DEFAULT_RUN_MODES = Object.freeze(['ask', 'auto', 'plan']);
  const UI_LANGUAGE_TAGS = Object.freeze(['en', 'es', 'fr', 'de', 'it', 'pt-BR', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'hi', 'id', 'vi', 'ja', 'ko', 'zh-CN', 'zh-TW']);
  const UI_LANGUAGE_LABELS = Object.freeze([
    jt('settings.language.option.en', 'English'), jt('settings.language.option.es', 'Español (Spanish)'), jt('settings.language.option.fr', 'Français (French)'), jt('settings.language.option.de', 'Deutsch (German)'),
    jt('settings.language.option.it', 'Italiano (Italian)'), jt('settings.language.option.ptBr', 'Português do Brasil (Brazilian Portuguese)'), jt('settings.language.option.nl', 'Nederlands (Dutch)'), jt('settings.language.option.pl', 'Polski (Polish)'),
    jt('settings.language.option.ru', 'Русский (Russian)'), jt('settings.language.option.uk', 'Українська (Ukrainian)'), jt('settings.language.option.tr', 'Türkçe (Turkish)'), jt('settings.language.option.ar', 'العربية (Arabic)'),
    jt('settings.language.option.hi', 'हिन्दी (Hindi)'), jt('settings.language.option.id', 'Bahasa Indonesia (Indonesian)'), jt('settings.language.option.vi', 'Tiếng Việt (Vietnamese)'), jt('settings.language.option.ja', '日本語 (Japanese)'),
    jt('settings.language.option.ko', '한국어 (Korean)'), jt('settings.language.option.zhCn', '简体中文 (Simplified Chinese)'),
    jt('settings.language.option.zhTw', '繁體中文 (Traditional Chinese)'),
  ]);
  const SAFETY_MODES = Object.freeze(['normal', 'strict', 'paranoid']);
  // The switch copy (label, help, detail) is written once, on the descriptors
  // (settings-tool-config-<key>); every reader of these fields still finds it here.
  const toolDescriptors = globalThis.rendererSettingsFieldDescriptors || (typeof require === 'function' ? require('./renderer-settings-field-descriptors.js') : null);
  const DEFAULT_TOOL_CONFIG_FIELDS = Object.freeze([
    {
      key: 'fileTools',
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      configFlag: '',
      toolIds: Object.freeze(['read_file', 'write_file', 'edit_file', 'delete_file', 'glob_files', 'grep_search', 'list_dir', 'create_artifact']),
    },
    {
      key: 'richFiles',
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      configFlag: 'tools_rich_files_enabled',
      toolIds: Object.freeze(['read_file']),
    },
    {
      key: 'imageRead',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      configFlag: 'tools_image_read_enabled',
      toolIds: Object.freeze(['read_file']),
    },
    {
      key: 'web',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      configFlag: 'tools_web_enabled',
      toolIds: Object.freeze(['web_search', 'fetch_url']),
    },
    {
      key: 'bash',
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      configFlag: '',
      toolIds: Object.freeze(['run_command', 'run_temp_script', 'check_background_job', 'stop_background_job']),
    },
    {
      key: 'pythonRuntime',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      configFlag: 'tools_python_runtime_enabled',
      toolIds: Object.freeze(['python_execute']),
    },
    {
      key: 'lsp',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      configFlag: 'tools_lsp_enabled',
      toolIds: Object.freeze(['lsp']),
    },
    {
      key: 'worktree',
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      configFlag: 'tools_worktree_enabled',
      toolIds: Object.freeze(['worktree_list', 'worktree_create', 'worktree_select', 'worktree_delete']),
    },
    {
      key: 'subagents',
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      configFlag: 'tools_subagents_enabled',
      toolIds: Object.freeze(['delegate']),
    },
  ].map((field) => {
    const copy = toolDescriptors.getSettingDescriptor('settings-tool-config-' + field.key).copy;
    return Object.freeze(Object.assign(field, { label: copy.label, helpText: copy.description, detail: copy.detail }));
  }));

  function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  const defaultEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function readMetadataField(source, keys) {
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        return source[key];
      }
    }
    return undefined;
  }

  function normalizeToolIds(value) {
    if (!Array.isArray(value)) {
      return [];
    }
    const ids = [];
    for (const entry of value) {
      const id = normalizeString(entry);
      if (id && !ids.includes(id)) {
        ids.push(id);
      }
    }
    return ids;
  }

  function cloneToolConfigField(field) {
    return {
      key: field.key,
      label: field.label,
      fieldType: field.fieldType,
      storage: field.storage,
      default: field.default === true,
      helpText: field.helpText,
      configFlag: field.configFlag,
      toolIds: [...(field.toolIds || [])],
    };
  }

  function hasControlCharacter(value) {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 32 || code === 127) {
        return true;
      }
    }
    return false;
  }

  function normalizeToolConfigField(rawField) {
    if (!isPlainObject(rawField)) {
      return null;
    }
    const key = normalizeString(rawField.key);
    if (!key || hasControlCharacter(key)) {
      return null;
    }
    const label = normalizeString(rawField.label);
    if (!label) return null;
    const fieldType = normalizeString(readMetadataField(rawField, ['fieldType', 'field_type'])) || 'toggle';
    const storage = normalizeString(rawField.storage) || 'config';
    if (fieldType !== 'toggle' || storage !== 'config') {
      return null;
    }
    if (
      Object.prototype.hasOwnProperty.call(rawField, 'default')
      && typeof rawField.default !== 'boolean'
    ) {
      return null;
    }
    return {
      key,
      label,
      fieldType,
      storage,
      default: rawField.default === true,
      helpText: normalizeString(readMetadataField(rawField, ['helpText', 'help_text'])),
      configFlag: normalizeString(readMetadataField(rawField, ['configFlag', 'config_flag'])),
      toolIds: normalizeToolIds(readMetadataField(rawField, ['toolIds', 'tool_ids'])),
    };
  }

  function normalizeToolConfigFields(fields) {
    return (Array.isArray(fields) ? fields : [])
      .map(normalizeToolConfigField)
      .filter(Boolean);
  }

  function normalizeToolConfig(toolConfig) {
    if (!isPlainObject(toolConfig)) {
      return { schemaVersion: 0, fields: [] };
    }
    const schemaVersion = Number(toolConfig.schemaVersion);
    return {
      schemaVersion: Number.isSafeInteger(schemaVersion) && schemaVersion >= 0 ? schemaVersion : 0,
      fields: normalizeToolConfigFields(toolConfig.fields),
    };
  }

  function getToolConfigFieldsForRender(featureState) {
    const normalizedConfig = normalizeToolConfig(featureState?.toolConfig);
    const fields = normalizedConfig.fields.length
      ? normalizedConfig.fields
      : DEFAULT_TOOL_CONFIG_FIELDS;
    return fields.map(cloneToolConfigField);
  }

  function normalizeRunMode(value, { planModeFallback = false } = {}) {
    const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return RUN_MODES.includes(token) ? token : (planModeFallback === true ? 'plan' : 'ask');
  }

  function normalizeDefaultRunMode(value, options) {
    const mode = normalizeRunMode(value, options);
    return DEFAULT_RUN_MODES.includes(mode) ? mode : 'ask';
  }

  function normalizeUiLanguageTag(value) {
    if (typeof value !== 'string') return 'en';
    const normalized = value.toLowerCase();
    return UI_LANGUAGE_TAGS.find((tag) => tag.toLowerCase() === normalized) || 'en';
  }
  function normalizeSafetyMode(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return SAFETY_MODES.includes(normalized) ? normalized : 'normal';
  }
  function normalizeBoundedCount(value, max, fallback) {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed <= 0 ? 0 : Math.min(max, Math.max(fallback === 0 ? 1 : 0, Math.trunc(parsed)));
  }
  const normalizeUnattendedGuardMinutes = (value) => normalizeBoundedCount(value, 120, 0);
  const normalizeAutoApproveStreakCap = (value) => normalizeBoundedCount(value, 500, 50);
  // Settings cohesion S3: the chatUi builders are shims over the shared descriptor
  // row (renderer-settings-field-binding.js); renderer-settings-event-utils.js binds them.
  function renderDescriptorRow(id, value, options, extra) {
    const source = isPlainObject(options) ? options : {};
    const binding = globalThis.rendererSettingsFieldBinding || (typeof require === 'function' ? require('./renderer-settings-field-binding.js') : null);
    const descriptors = globalThis.rendererSettingsFieldDescriptors || (typeof require === 'function' ? require('./renderer-settings-field-descriptors.js') : null);
    const descriptor = descriptors?.getSettingDescriptor?.(id);
    if (!descriptor || typeof binding?.renderSettingRow !== 'function') return '';
    return binding.renderSettingRow(descriptor, descriptors.normalizeSettingValue(descriptor, value),
      { inventory: source, ...extra });
  }
  function buildUiLanguageFieldMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const tags = Array.isArray(globalThis.jennyI18n?.SUPPORTED_TAGS) ? globalThis.jennyI18n.SUPPORTED_TAGS : UI_LANGUAGE_TAGS;
    const uiLanguages = tags.map((tag, index) => ({ value: tag, label: UI_LANGUAGE_LABELS[index] || tag }));
    // Registered, so the row's revert names the language ("English") and not its tag.
    (globalThis.rendererSettingsFieldDescriptors || (typeof require === 'function' ? require('./renderer-settings-field-descriptors.js') : null))?.registerOptionSource?.('uiLanguages', uiLanguages);
    return renderDescriptorRow('uiLanguageSelect', normalizeUiLanguageTag(source.value), source, {
      help: jt('settings.language.hint', 'Applies after you restart Jenny. Translations other than English are machine-drafted previews; report anything odd.') })
      + '<div class="settings-toggle-list">' + renderDescriptorRow('use24HourTime', source.use24HourTime === true, source) + '</div>';
  }

  function encodeToolConfigToggleKey(key) {
    return encodeURIComponent(String(key || ''));
  }

  // The row and its DOM ids are tokens; the switch still reports the encoded backend id.
  // Every character outside letters, digits and "-" becomes "_<hex>_" (the underscore
  // too), so two different keys can never land on the same row id.
  function toolConfigRowId(toggleId) {
    return String(toggleId || '').replace(/[^A-Za-z0-9-]/g, (ch) => '_' + ch.charCodeAt(0).toString(16) + '_');
  }

  function decodeToolConfigToggleKey(key) {
    try {
      return decodeURIComponent(String(key || ''));
    } catch (_decodeError) {
      return String(key || '');
    }
  }

  // The help line of a tool row. The PDF add-on rewrites the two PDF rows with it when
  // its state changes, so the row and the add-on can never word it differently.
  function composeToolHelp(field, state) {
    const s = isPlainObject(state) ? state : {};
    const help = [field.helpText];
    if (s.pdfAddonNeeded === true && ['richFiles', 'imageRead'].includes(field.key)) {
      help.push(jt('settings.tools.needsPdfAddon', 'Needs the PDF reading add-on.'));
    }
    if (s.blocked === true) help.push(jt('settings.tools.blockedByRuntime', 'Currently blocked by runtime availability.'));
    return help.join(' ');
  }

  function buildToolConfigFieldListMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const binding = globalThis.rendererSettingsFieldBinding || (typeof require === 'function' ? require('./renderer-settings-field-binding.js') : null);
    const tools = isPlainObject(source.tools) ? source.tools : {};
    const availability = isPlainObject(source.availability) ? source.availability : {};
    const fields = normalizeToolConfigFields(source.fields);
    const knownKeys = DEFAULT_TOOL_CONFIG_FIELDS.map((field) => field.key);
    fields.sort((a, b) => (knownKeys.includes(a.key) ? knownKeys.indexOf(a.key) : knownKeys.length)
      - (knownKeys.includes(b.key) ? knownKeys.indexOf(b.key) : knownKeys.length));
    return fields.map((field) => {
      const id = `${TOOL_CONFIG_TOGGLE_ID_PREFIX}${encodeToolConfigToggleKey(field.key)}`;
      const copy = DEFAULT_TOOL_CONFIG_FIELDS.find((entry) => entry.key === field.key) || field;
      const checked = Object.prototype.hasOwnProperty.call(tools, field.key) ? tools[field.key] === true : field.default === true;
      const disabled = availability[field.key]?.enabled === false;
      const parentKey = TOOL_DEPENDENTS[field.key];
      const parentOff = Boolean(parentKey) && (Object.prototype.hasOwnProperty.call(tools, parentKey)
        ? tools[parentKey] !== true : fields.find((entry) => entry.key === parentKey)?.default === false);
      const rowId = toolConfigRowId(id);
      return binding.renderToggleRow({
        id: rowId,
        controlId: rowId,
        toggleId: id,
        label: copy.label,
        help: composeToolHelp(copy, { pdfAddonNeeded: source.pdfAddonNeeded === true, blocked: disabled }),
        detail: copy.detail,
        checked,
        disabled,
        sub: Boolean(parentKey),
        parentOff,
        inventory: source,
      });
    }).join('');
  }

  // Patches the dependent rows under `root` (#toolsConfigFieldList) in place to the
  // state a fresh render gives. It runs after every Tools render, because the patch
  // guard holds the lists while focus or an unsaved key is inside them.
  function syncToolDependents(root, options) {
    const source = isPlainObject(options) ? options : {};
    const toolOn = typeof source.toolOn === 'function' ? source.toolOn : () => true;
    const availability = isPlainObject(source.availability) ? source.availability : {};
    const setSwitchDisabled = source.inventory?.toggleSwitch?.setDisabled;
    const markParentOff = (row, off) => {
      if (off) row.setAttribute('data-setting-parent-off', 'true');
      else row.removeAttribute('data-setting-parent-off');
    };
    // The same lock setRowDisabled applies; a write or test in flight keeps its busy lock.
    const setUnavailable = (control, unavailable) => {
      control.toggleAttribute('data-setting-unavailable', unavailable);
      if (typeof setSwitchDisabled === 'function' && control.hasAttribute('data-inv-toggle')) setSwitchDisabled(control, unavailable);
      control.disabled = unavailable || control.hasAttribute('data-setting-busy');
    };
    const richFiles = root?.querySelector?.(`[data-inv-toggle="${TOOL_CONFIG_TOGGLE_ID_PREFIX}richFiles"]`);
    if (richFiles) {
      const parentOff = !toolOn(TOOL_DEPENDENTS.richFiles);
      const row = richFiles.closest('.settings-field');
      if (row) markParentOff(row, parentOff);
      setUnavailable(richFiles, parentOff || availability.richFiles?.enabled === false);
    }
    const webSection = root?.querySelector?.('[data-web-search-section]');
    if (webSection) {
      const parentOff = !toolOn(TOOL_DEPENDENTS.webSearch);
      webSection.querySelectorAll('.settings-field').forEach((row) => markParentOff(row, parentOff));
      webSection.querySelectorAll('select, input, button').forEach((control) => setUnavailable(control, parentOff));
    }
    const commandSandbox = globalThis.rendererSettingsCommandSandboxUtils
      || (typeof require === 'function' ? require('./renderer-settings-command-sandbox.js') : null);
    commandSandbox?.onParentChange?.(toolOn(TOOL_DEPENDENTS.commandSandbox));
  }

  // Generic inventory-switch list builder: turns a flat field spec into a stack
  // of standard switch rows, the same way the Tools capability list does.
  function buildSettingsToggleListMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const binding = globalThis.rendererSettingsFieldBinding || (typeof require === 'function' ? require('./renderer-settings-field-binding.js') : null);
    const fields = Array.isArray(source.fields) ? source.fields : [];
    return fields
      .filter((field) => isPlainObject(field) && normalizeString(field.id))
      .map((field) => {
        const id = normalizeString(field.id);
        // A field that omits label/description/detail inherits the baseline from
        // renderer-settings-field-copy.js; call-site (dynamic) text wins.
        const copy = getFieldCopy(id);
        return binding.renderToggleRow({
          id,
          controlId: id,
          label: field.label || (copy ? copy.label : ''),
          help: field.description || (copy ? copy.description : ''),
          detail: field.detail || (copy ? copy.detail : ''),
          checked: field.checked === true,
          disabled: field.disabled === true,
          inventory: source,
        });
      })
      .join('');
  }

  // Context section: two switch lists, keyed by persistence path. "sources" are
  // session runtime preferences; "runtime" are managed feature flags. The ids
  // are descriptor controlIds, so the shared field binding routes each switch.
  function buildContextToggleListsMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const prefs = isPlainObject(source.contextPreferences) ? source.contextPreferences : {};
    const flags = isPlainObject(source.featureFlags) ? source.featureFlags : {};
    const prefsDisabled = source.prefsDisabled === true;
    const flagsDisabled = source.flagsDisabled === true;
    const shared = { toggleSwitch: source.toggleSwitch, escapeHtml: source.escapeHtml };
    return {
      sources: buildSettingsToggleListMarkup({
        ...shared,
        fields: [
          { id: 'contextIncludePersonalityToggle', checked: prefs.includePersonality === true, disabled: prefsDisabled },
          { id: 'contextIncludeMemoryToggle', checked: prefs.includeMemory === true, disabled: prefsDisabled },
        ],
      }),
      runtime: buildSettingsToggleListMarkup({
        ...shared,
        fields: [
          { id: 'contextCompactionToggle', checked: flags.context_compaction === true, disabled: flagsDisabled },
        ],
      }),
    };
  }

  // Advanced Context owns only the additive custom summarization guidance.
  // Per-model context/threshold controls live in Model Library and Compact now
  // lives beside the Composer context meter.
  function buildCompactionTuningMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const escapeHtmlFn = typeof source.escapeHtml === 'function' ? source.escapeHtml : defaultEscapeHtml;
    const row = renderDescriptorRow('compactionPromptField', source.customPromptValue || '', source, {
      multiline: true,
      rowClassName: 'settings-field--block',
      disabled: source.disabled === true,
      // The draft guard in the shell controller finds the field by this attribute.
      dataset: { 'compaction-field': 'customPrompt' },
      placeholder: jt('settings.context.customSummarizationPromptPlaceholder', 'Leave empty to use the built-in prompt'),
    });
    if (!row) {
      return '';
    }
    const statusMessage = String(source.statusMessage || '').trim();
    return row + (statusMessage
      ? `<div class="settings-note" id="compactionTuningStatus" data-compaction-status="${escapeHtmlFn(source.statusTone || 'info')}">${escapeHtmlFn(statusMessage)}</div>`
      : '<div class="settings-note" id="compactionTuningStatus"></div>');
  }

  function resolveToolConfigToggleEvent(event, fields) {
    const detail = isPlainObject(event?.detail) ? event.detail : {};
    const detailId = normalizeString(detail.id);
    const targetToggle =
      event?.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-inv-toggle]')
        : null;
    const toggleId = detailId || normalizeString(targetToggle?.getAttribute('data-inv-toggle'));
    if (!toggleId.startsWith(TOOL_CONFIG_TOGGLE_ID_PREFIX)) {
      return null;
    }
    const key = decodeToolConfigToggleKey(toggleId.slice(TOOL_CONFIG_TOGGLE_ID_PREFIX.length));
    const field = normalizeToolConfigFields(fields).find((entry) => entry.key === key);
    if (!field) {
      return null;
    }
    const checked = typeof detail.checked === 'boolean'
      ? detail.checked
      : targetToggle?.getAttribute('aria-checked') === 'true';
    return {
      key: field.key,
      checked,
      label: field.label,
    };
  }

  function normalizeFeatureState(payload) {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    return {
      loaded: true,
      // Display-only Tier C #12 seam: carried through so a render-time
      // normalize pass (renderer-settings-utils.js) doesn't drop the flag
      // applyFeatureStatePayload set. Never influences tools/featureFlags
      // below, only status-chip rendering.
      availabilityResolved: source.availabilityResolved === true,
      tools: source.tools && typeof source.tools === 'object' && !Array.isArray(source.tools)
        ? { ...source.tools }
        : {},
      memory: source.memory && typeof source.memory === 'object' && !Array.isArray(source.memory)
        ? { captureSuggestions: source.memory.captureSuggestions !== false }
        : { captureSuggestions: true },
      featureFlags: source.featureFlags && typeof source.featureFlags === 'object' && !Array.isArray(source.featureFlags)
        ? { ...source.featureFlags }
        : {},
      featureOverrides:
        source.featureOverrides && typeof source.featureOverrides === 'object' && !Array.isArray(source.featureOverrides)
          ? { ...source.featureOverrides }
          : {},
      availability: source.availability && typeof source.availability === 'object' && !Array.isArray(source.availability)
        ? source.availability
        : {
            runtime: {
              managedSidecarActive: true,
              windowsOnly: true,
              workspaceRootStatus: {
                state: 'missing',
                message: jt('settings.tools.workspaceNotConfigured', 'No workspace root is configured yet.'),
              },
            },
            tools: {},
            featureFlags: {},
          },
      toolConfig: normalizeToolConfig(source.toolConfig),
      webSearch: normalizeWebSearchState(source.webSearch),
    };
  }

  function normalizeWorkspaceRootState(payload) {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const status =
      source.status && typeof source.status === 'object' && !Array.isArray(source.status)
        ? {
            state: String(source.status.state || 'missing').trim() || 'missing',
            message: String(source.status.message || '').trim(),
          }
        : source.workspaceRootStatus && typeof source.workspaceRootStatus === 'object' && !Array.isArray(source.workspaceRootStatus)
          ? {
              state: String(source.workspaceRootStatus.state || 'missing').trim() || 'missing',
              message: String(source.workspaceRootStatus.message || '').trim(),
            }
          : {
              state: 'missing',
              message: jt('settings.tools.workspaceNotConfigured', 'No workspace root is configured yet.'),
            };
    return {
      path: String(source.path || source.workspaceRoot || '').trim(),
      status,
      // Settings normalizes shared renderer state; retain the coordinator's
      // identity so rendering settings cannot invalidate later change reviews.
      rootId: String(source.rootId ?? source.context?.rootId ?? '').trim(),
      generation: Number.isSafeInteger(source.generation ?? source.context?.generation)
        ? (source.generation ?? source.context.generation) : 0,
    };
  }

  function getStatusRowRenderer() {
    return globalThis.inventory && typeof globalThis.inventory.statusRow === 'function'
      ? globalThis.inventory.statusRow
      : null;
  }

  /* Mirrors renderer/inventory/status-row.js's flat shape so a missing
   * primitive degrades to the same DOM rather than a different one. */
  function buildStatusRowFallbackMarkup(model, escapeHtml) {
    const tone = String(model?.tone || 'default').trim();
    const label = String(model?.label || '').trim();
    const badgeText = String(model?.badgeText || '').trim();
    const message = String(model?.message || '').trim();
    const toneClass = tone && tone !== 'default' ? ` inv-status-row--${escapeHtml(tone)}` : '';
    return ''
      + `<div class="inv-status-row${toneClass}" data-status-tone="${escapeHtml(tone || 'default')}">`
      + '<span class="inv-status-row-leading" aria-hidden="true"><span class="inv-status-row-dot"></span></span>'
      + '<div class="inv-status-row-main"><div class="inv-status-row-message">'
      + (label ? `<span class="inv-status-row-label">${escapeHtml(label)}</span>` : '')
      + escapeHtml(message)
      + (badgeText ? `<span class="inv-status-row-badge">${escapeHtml(badgeText)}</span>` : '')
      + '</div></div></div>';
  }

  function renderStatusRowContainer(target, model, escapeHtml) {
    if (!target) {
      return;
    }
    if (!model || !String(model.message || '').trim()) {
      target.innerHTML = '';
      return;
    }
    const statusRow = getStatusRowRenderer();
    target.innerHTML = statusRow
      ? statusRow(model)
      : buildStatusRowFallbackMarkup(model, escapeHtml);
  }

  function buildSettingsSummaryModel(options) {
    const source = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
    return {
      tone: String(source.tone || 'default').trim() || 'default',
      label: String(source.label || '').trim(),
      message: String(source.message || '').trim(),
      badgeText: String(source.badgeText || '').trim(),
      spinner: source.spinner === true,
      compact: source.compact !== false,
    };
  }

  return {
    inferEngineTypeFromModel,
    resolveReasoningEffortSupport,
    resolveModelBadge,
    TOOL_CONFIG_TOGGLE_ID_PREFIX,
    TOOL_DEPENDENTS,
    DEFAULT_TOOL_CONFIG_FIELDS,
    normalizeToolConfig,
    encodeToolConfigToggleKey,
    decodeToolConfigToggleKey,
    toolConfigRowId,
    getToolConfigFieldsForRender,
    UI_LANGUAGE_TAGS,
    buildUiLanguageFieldMarkup,
    buildToolConfigFieldListMarkup,
    composeToolHelp,
    syncToolDependents,
    buildSettingsToggleListMarkup,
    buildContextToggleListsMarkup,
    buildCompactionTuningMarkup,
    resolveToolConfigToggleEvent,
    normalizeRunMode,
    normalizeDefaultRunMode,
    normalizeUiLanguageTag,
    normalizeSafetyMode,
    normalizeUnattendedGuardMinutes,
    normalizeAutoApproveStreakCap,
    normalizeFeatureState,
    normalizeWorkspaceRootState,
    getStatusRowRenderer,
    buildStatusRowFallbackMarkup,
    renderStatusRowContainer,
    buildSettingsSummaryModel,
    WEB_SEARCH_PROVIDERS,
    WEB_SEARCH_KEY_PROVIDERS,
    WEB_SEARCH_SECRET_KEY_IDS,
    normalizeWebSearchState,
    buildWebSearchSectionMarkup,
    resolveWebSearchKeySaveClickEvent,
  };
});
