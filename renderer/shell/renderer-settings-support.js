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

  // --- Web search provider section (Tools > Optional capabilities) ---------
  // Renders INTO the existing toolsConfigFieldList container (index.html owns
  // no dedicated container for this group this wave), appended after the
  // toggle-field rows. Visible only behind the web_search_providers flag.
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

  // Builds the "Web search provider" group markup. Returns '' when the flag is
  // off (zero DOM output) or required inventory primitives aren't loaded.
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
    if (typeof selectFieldFn !== 'function' || typeof textFieldFn !== 'function') {
      return '';
    }
    const webSearch = normalizeWebSearchState(source.webSearch);
    const configured = isPlainObject(source.secretStatus?.configured) ? source.secretStatus.configured : {};
    const parts = [];
    parts.push(selectFieldFn({
      id: 'webSearchProviderSelect',
      label: jt('settings.tools.webSearch.providerLabel', 'Search provider'),
      value: webSearch.provider,
      options: WEB_SEARCH_PROVIDERS.map((entry) => ({ value: entry.value, label: entry.label })),
      ariaLabel: jt('settings.tools.webSearch.providerAriaLabel', 'Web search provider'),
      dataset: { 'web-search-field': 'provider' },
    }));
    if (webSearch.provider === 'searxng') {
      parts.push(textFieldFn({
        id: 'webSearchSearxngUrlField',
        label: jt('settings.tools.webSearch.searxngUrlLabel', 'SearXNG instance URL'),
        value: webSearch.searxngUrl,
        placeholder: jt('settings.tools.webSearch.searxngUrlPlaceholder', 'https://searx.example.com'),
        ariaLabel: jt('settings.tools.webSearch.searxngUrlLabel', 'SearXNG instance URL'),
        dataset: { 'web-search-field': 'searxngUrl' },
      }));
    }
    if (WEB_SEARCH_KEY_PROVIDERS.includes(webSearch.provider)) {
      parts.push(buildWebSearchKeyFieldMarkup({
        keyId: webSearch.provider,
        label: jt('settings.tools.webSearch.apiKeyLabel', 'API key'),
        configured: configured[webSearch.provider] === true,
        textField: textFieldFn,
        actionButton: actionButtonFn,
        escapeHtml: escapeHtmlFn,
      }));
      if (webSearch.provider === 'google_pse') {
        parts.push(buildWebSearchKeyFieldMarkup({
          keyId: 'google_pse_cx',
          label: jt('settings.tools.webSearch.searchEngineIdLabel', 'Search engine ID (cx)'),
          configured: configured.google_pse_cx === true,
          textField: textFieldFn,
          actionButton: actionButtonFn,
          escapeHtml: escapeHtmlFn,
        }));
      }
    }
    const helpText = jt('settings.tools.webSearch.providerHelp', 'DuckDuckGo needs no configuration; other providers apply only when selected.');
    const testButton = typeof actionButtonFn === 'function' ? actionButtonFn({
      id: 'webSearchConnectionTest',
      label: jt('settings.tools.webSearch.testConnection', 'Test connection'),
      variant: 'secondary',
      size: 'sm',
      dataset: { 'web-search-test': 'true' },
    }) : '';
    return `
      <div class="settings-group settings-group--flush" role="group" aria-labelledby="toolsWebSearchHeading" data-web-search-section="true">
        <h4 class="settings-group-heading" id="toolsWebSearchHeading">${escapeHtmlFn(jt('settings.tools.webSearch.heading', 'Web search provider'))}</h4>
        ${parts.join('')}
        <div class="settings-actions">${testButton}</div>
        <div class="settings-note" data-web-search-test-status aria-live="polite"></div>
        <div class="settings-note tools-config-field-help">${escapeHtmlFn(helpText)}</div>
      </div>
    `;
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
      label: source.label,
      value: '',
      type: 'password',
      placeholder: source.configured === true ? jt('settings.tools.webSearch.configuredPlaceholder', 'Configured (hidden)') : jt('settings.tools.webSearch.enterApiKeyPlaceholder', 'Enter API key'),
      ariaLabel: source.label,
      dataset: { 'web-search-key-field': keyId },
    });
    const saveButtonMarkup = typeof source.actionButton === 'function'
      ? source.actionButton({
        id: `webSearchKeySave-${keyId}`,
        label: jt('settings.tools.webSearch.saveKey', 'Save key'),
        variant: 'secondary',
        size: 'sm',
        ariaLabel: jt('settings.tools.webSearch.saveKeyAriaLabel', 'Save {label}', { label: source.label }),
        title: jt('settings.tools.webSearch.saveKeyTitle', 'Save this API key'),
        dataset: { 'web-search-key-save': keyId },
      })
      : '';
    const hint = source.configured === true
      ? `<span class="settings-note tools-config-field-help" data-web-search-key-hint="${escapeHtmlFn(keyId)}">${escapeHtmlFn(jt('common.configured', 'Configured'))}</span>`
      : '';
    return `
      <div class="tools-config-field-row" data-web-search-key-row="${escapeHtmlFn(keyId)}">
        ${fieldMarkup}
        <div class="settings-actions">${saveButtonMarkup}</div>
        ${hint}
      </div>
    `;
  }

  // Resolves a native 'change' event bubbling out of the web-search section
  // container into a normalized { field, value } pair, or null if unrelated.
  function resolveWebSearchFieldChangeEvent(event) {
    const target = event?.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-web-search-field]')
      : null;
    if (!target) {
      return null;
    }
    const field = normalizeString(target.getAttribute('data-web-search-field'));
    if (!field) {
      return null;
    }
    return { field, value: String(target.value == null ? '' : target.value) };
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

  // Resolves the additive custom summarization guidance field only.
  function resolveCompactionFieldChangeEvent(event) {
    const target = event?.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-compaction-field]')
      : null;
    if (!target) {
      return null;
    }
    const field = normalizeString(target.getAttribute('data-compaction-field'));
    if (field !== 'customPrompt') {
      return null;
    }
    return { field, value: String(target.value == null ? '' : target.value) };
  }

  const TOOL_CONFIG_TOGGLE_ID_PREFIX = 'settings-tool-config-';
  const RUN_MODES = Object.freeze(['ask', 'auto', 'plan']);
  const RUN_MODE_HELP = Object.freeze({
    ask: jt('settings.runMode.help.ask', 'Jenny asks before running tools that change things.'),
    auto: jt('runMode.help.auto', 'Tools run without asking. Python and explicit denies still ask; blocked commands are refused.'),
    plan: jt('settings.runMode.help.plan', 'Read-only: Jenny plans first and presents it before acting.'),
  });
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
  const SAFETY_MODE_LABELS = Object.freeze({
    normal: jt('settings.safetyMode.option.normal', 'Normal'),
    strict: jt('settings.safetyMode.option.strict', 'Strict'),
    paranoid: jt('settings.safetyMode.option.paranoid', 'Paranoid'),
  });
  const DEFAULT_TOOL_CONFIG_FIELDS = Object.freeze([
    Object.freeze({
      key: 'imageRead',
      label: jt('settings.tools.imageRead.label', 'Image and PDF reads'),
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      helpText: jt('settings.tools.imageRead.description', 'Allow read_file to expose image and PDF page-read affordances.'),
      configFlag: 'tools_image_read_enabled',
      toolIds: Object.freeze(['read_file']),
    }),
    Object.freeze({
      key: 'fileTools',
      label: jt('settings.tools.fileTools.label', 'File tools'),
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      helpText: jt('settings.tools.fileTools.description', 'Allow workspace file tools. Availability still requires a workspace root.'),
      configFlag: '',
      toolIds: Object.freeze(['read_file', 'write_file', 'edit_file', 'delete_file', 'glob_files', 'grep_search', 'list_dir', 'create_artifact']),
    }),
    Object.freeze({
      key: 'richFiles',
      label: jt('settings.tools.richFiles.label', 'Rich file tools'),
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      helpText: jt('settings.tools.richFiles.description', 'Allow read_file to return bounded structured inspection for PDF, spreadsheet, document, presentation, and notebook files.'),
      configFlag: 'tools_rich_files_enabled',
      toolIds: Object.freeze(['read_file']),
    }),
    Object.freeze({
      key: 'web',
      label: jt('settings.tools.web.label', 'Web tools'),
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      helpText: jt('settings.tools.web.description', 'Enable web_search and fetch_url for live web lookup.'),
      configFlag: 'tools_web_enabled',
      toolIds: Object.freeze(['web_search', 'fetch_url']),
    }),
    Object.freeze({
      key: 'pythonRuntime',
      label: jt('settings.tools.pythonRuntime.label', 'Python execution'),
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      helpText: jt('settings.tools.pythonRuntime.description', 'Enable resource-bounded local Python execution. It is not a filesystem or network sandbox and always requires approval.'),
      configFlag: 'tools_python_runtime_enabled',
      toolIds: Object.freeze(['python_execute']),
    }),
    Object.freeze({
      key: 'worktree',
      label: jt('settings.tools.worktree.label', 'Worktree tools'),
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      helpText: jt('settings.tools.worktree.description', 'Enable Electron-local Git worktree setup tools.'),
      configFlag: 'tools_worktree_enabled',
      toolIds: Object.freeze(['worktree_list', 'worktree_create', 'worktree_select', 'worktree_delete']),
    }),
    Object.freeze({
      key: 'subagents',
      label: jt('settings.tools.subagents.label', 'Delegated repository research'),
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      helpText: jt('settings.tools.subagents.description', 'Bounded read-only repository research that may add model cost and latency.'),
      configFlag: 'tools_subagents_enabled',
      toolIds: Object.freeze(['delegate']),
    }),
    Object.freeze({
      key: 'bash',
      label: jt('settings.tools.bash.label', 'Terminal commands'),
      fieldType: 'toggle',
      storage: 'config',
      default: true,
      helpText: jt('settings.tools.bash.description', 'Allow shell commands. Availability still requires a workspace root.'),
      configFlag: '',
      toolIds: Object.freeze(['run_command', 'run_temp_script', 'check_background_job', 'stop_background_job']),
    }),
    Object.freeze({
      key: 'lsp',
      label: jt('settings.tools.lsp.label', 'LSP code intelligence'),
      fieldType: 'toggle',
      storage: 'config',
      default: false,
      helpText: jt('settings.tools.lsp.description', 'Enable read-only language-server diagnostics, symbols, definitions, and references.'),
      configFlag: 'tools_lsp_enabled',
      toolIds: Object.freeze(['lsp']),
    }),
  ]);

  function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function defaultEscapeHtml(value) {
    return String(value || '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

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
    if (!label) {
      return null;
    }
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

  function getToggleSwitchRenderer(toggleSwitchRenderer) {
    if (typeof toggleSwitchRenderer === 'function') {
      return toggleSwitchRenderer;
    }
    // The inventory barrel exposes toggleSwitch as the render function directly.
    const fromBarrel =
      typeof globalThis !== 'undefined' ? globalThis.inventory?.toggleSwitch : null;
    return typeof fromBarrel === 'function' ? fromBarrel : null;
  }

  function normalizeRunMode(value, { planModeFallback = false } = {}) {
    const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return RUN_MODES.includes(token) ? token : (planModeFallback === true ? 'plan' : 'ask');
  }

  const normalizeDefaultRunMode = normalizeRunMode;

  function normalizeUiLanguageTag(value) {
    if (typeof value !== 'string') return 'en';
    const normalized = value.toLowerCase();
    return UI_LANGUAGE_TAGS.find((tag) => tag.toLowerCase() === normalized) || 'en';
  }
  function normalizeSafetyMode(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return SAFETY_MODES.includes(normalized) ? normalized : 'normal';
  }
  function normalizeUnattendedGuardMinutes(value) {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return 0;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return 0;
    return parsed === 0 ? 0 : Math.min(120, Math.max(1, Math.trunc(parsed)));
  }
  function buildUiLanguageFieldMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const selectField = typeof source.selectField === 'function' ? source.selectField : getInventoryFn('selectField', 'inventorySelectField');
    if (typeof selectField !== 'function') return '';
    const copy = getFieldCopy('uiLanguageSelect');
    const hint = jt('settings.language.hint', 'Applies after you restart Jenny. Translations other than English are machine-drafted previews; report anything odd.');
    const tags = Array.isArray(globalThis.jennyI18n?.SUPPORTED_TAGS) ? globalThis.jennyI18n.SUPPORTED_TAGS : UI_LANGUAGE_TAGS;
    return selectField({ id: 'uiLanguageSelect', label: copy?.label || jt('settings.language.label', 'Language'),
      value: normalizeUiLanguageTag(source.value), options: tags.map((tag, index) => ({ value: tag, label: UI_LANGUAGE_LABELS[index] || tag })),
      hint, ariaLabel: copy?.label || jt('settings.language.label', 'Language'), title: hint, tooltip: hint, dataset: { 'ui-language': 'true' } })
      + selectField({ id: 'use24HourTimeSelect', label: jt('settings.timeFormat.label', '24-hour time'),
        hint: jt('settings.timeFormat.description', 'Use 00:00–23:59 throughout Jenny and in the time context given to the model.'),
        value: source.use24HourTime === true ? 'true' : 'false',
        options: [{ value: 'false', label: jt('common.off', 'Off') }, { value: 'true', label: jt('common.on', 'On') }] });
  }

  function buildSafetyModeFieldMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const selectField = typeof source.selectField === 'function' ? source.selectField : getInventoryFn('selectField', 'inventorySelectField');
    if (typeof selectField !== 'function') return '';
    const copy = getFieldCopy('safetyModeSelect');
    const hint = jt('settings.safetyMode.hint', 'Normal: the run mode decides which tools ask. Strict: also removes web search and browsing tools. Paranoid: every tool call asks, even in Auto. Applies from the next turn.');
    return `<div class="settings-group settings-group--flush" data-safety-mode-field>${selectField({ id: 'safetyModeSelect', label: copy?.label || jt('settings.safetyMode.label', 'Safety mode'),
      value: normalizeSafetyMode(source.value), options: SAFETY_MODES.map((mode) => ({ value: mode, label: SAFETY_MODE_LABELS[mode] })),
      hint, ariaLabel: copy?.label || jt('settings.safetyMode.label', 'Safety mode'), title: hint, tooltip: hint, dataset: { 'safety-mode': 'true' } })}</div>`;
  }

  function buildUnattendedGuardFieldMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const numberInput = typeof source.numberInput === 'function' ? source.numberInput : getInventoryFn('numberInput', 'inventoryNumberInput');
    if (typeof numberInput !== 'function') return '';
    const selectField = source.selectField || getInventoryFn('selectField', 'inventorySelectField');
    const minutes = normalizeUnattendedGuardMinutes(source.value);
    const copy = getFieldCopy('unattendedGuardMinutesInput');
    const label = copy?.label || jt('settings.unattendedGuard.label', 'Pause Auto mode when you step away (minutes)');
    const hint = jt('settings.unattendedGuard.optInHint', 'Off by default: Auto keeps working while you are away. When enabled, keyboard or mouse inactivity makes the next action ask for approval. Unanswered approvals stop the turn after a separate 10 minutes. Disabling prevents future inactivity pauses. An already-paused turn stays in Ask until you change its run mode or resume it after it stops; pending actions still require approval.');
    const mode = typeof selectField === 'function' ? selectField({ id: 'unattendedGuardModeSelect', label: jt('settings.unattendedGuard.modeLabel', 'Pause Auto when inactive'),
      value: minutes > 0 ? 'on' : 'off', options: [{ value: 'off', label: jt('common.off', 'Off') }, { value: 'on', label: jt('common.on', 'On') }],
      dataset: { 'unattended-guard-mode': 'true' } }) : '';
    return '<div class="settings-group settings-group--flush" data-unattended-guard-field>' + mode + numberInput({ id: 'unattendedGuardMinutesInput', label, value: minutes || 10, disabled: minutes === 0, min: 1, max: 120,
      step: 1, fallback: 10, hint, ariaLabel: label, title: hint, tooltip: hint, dataset: { 'unattended-guard-minutes': 'true' } })
      + `<span class="inv-number-input-hint">${defaultEscapeHtml(hint)}</span></div>`;
  }

  function buildDefaultRunModeFieldMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const selectField = typeof source.selectField === 'function'
      ? source.selectField
      : getInventoryFn('selectField', 'inventorySelectField');
    if (typeof selectField !== 'function') return '';
    const copy = getFieldCopy('defaultRunModeSelect');
    const hint = RUN_MODES.map((mode) => `${mode[0].toUpperCase()}${mode.slice(1)}: ${RUN_MODE_HELP[mode]}`)
      .concat(jt('settings.runMode.appliesToNewChats', 'Applies to new chats; the composer switcher changes the current chat.'))
      .join(' ');
    return `<div class="settings-group settings-group--flush" data-default-run-mode-field>${selectField({
      id: 'defaultRunModeSelect',
      label: copy ? copy.label : jt('settings.runMode.defaultLabel', 'Default run mode for new sessions'),
      value: normalizeDefaultRunMode(source.value),
      options: RUN_MODES.map((mode) => ({
        value: mode,
        label: `${mode[0].toUpperCase()}${mode.slice(1)}`,
      })),
      hint,
      ariaLabel: copy ? copy.label : jt('settings.runMode.defaultLabel', 'Default run mode for new sessions'),
      dataset: { 'default-run-mode': 'true' },
    })}</div>`;
  }

  function resolveDefaultRunModeChangeEvent(event) {
    const target = event?.target && typeof event.target.closest === 'function'
      ? event.target.closest('[data-default-run-mode]')
      : null;
    if (!target) return null;
    const value = typeof target.value === 'string' ? target.value.trim().toLowerCase() : '';
    return RUN_MODES.includes(value) ? { value } : null;
  }

  function resolveUiLanguageChangeEvent(event) {
    const target = event?.target?.closest?.('[data-ui-language]');
    if (!target) return null;
    const value = normalizeUiLanguageTag(target.value);
    return UI_LANGUAGE_TAGS.includes(target.value) ? { value } : null;
  }

  function resolveSafetyModeChangeEvent(event) {
    const target = event?.target?.closest?.('[data-safety-mode]');
    if (!target) return null;
    const value = normalizeSafetyMode(target.value);
    return SAFETY_MODES.includes(String(target.value).trim().toLowerCase()) ? { value } : null;
  }

  function resolveUnattendedGuardChangeEvent(event) {
    const mode = event?.target?.closest?.('[data-unattended-guard-mode]');
    if (mode) {
      if (!['on', 'off'].includes(mode.value)) return null;
      const duration = mode.closest('[data-unattended-guard-field]')?.querySelector('[data-unattended-guard-minutes]');
      return { value: mode.value === 'off' ? 0 : normalizeUnattendedGuardMinutes(duration?.value) || 10 };
    }
    const target = event?.target?.closest?.('[data-unattended-guard-minutes]');
    return target && !target.disabled ? { value: normalizeUnattendedGuardMinutes(target.value) } : null;
  }

  function encodeToolConfigToggleKey(key) {
    return encodeURIComponent(String(key || ''));
  }

  function decodeToolConfigToggleKey(key) {
    try {
      return decodeURIComponent(String(key || ''));
    } catch (_decodeError) {
      return String(key || '');
    }
  }

  function buildToolConfigFieldListMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const escapeHtml = typeof source.escapeHtml === 'function'
      ? source.escapeHtml
      : defaultEscapeHtml;
    const renderToggle = getToggleSwitchRenderer(source.toggleSwitch);
    if (!renderToggle) {
      return `<div class="settings-note">${escapeHtml(jt('settings.tools.controlsUnavailable', 'Tool controls are unavailable right now.'))}</div>`;
    }
    const tools = isPlainObject(source.tools) ? source.tools : {};
    const availability = isPlainObject(source.availability) ? source.availability : {};
    const fields = normalizeToolConfigFields(source.fields);
    if (!fields.length) {
      return `<div class="settings-note">${escapeHtml(jt('settings.tools.noConfiguredCapabilities', 'No optional tool capabilities are configured.'))}</div>`;
    }
    return fields.map((field) => {
      const id = `${TOOL_CONFIG_TOGGLE_ID_PREFIX}${encodeToolConfigToggleKey(field.key)}`;
      const copy = getFieldCopy(id);
      const metadata = isPlainObject(availability[field.key]) ? availability[field.key] : {};
      const checked = Object.prototype.hasOwnProperty.call(tools, field.key)
        ? tools[field.key] === true
        : field.default === true;
      const disabled = metadata.enabled === false;
      const noteParts = [];
      if (field.helpText) {
        noteParts.push(field.helpText);
      }
      if (disabled) {
        noteParts.push(jt('settings.tools.blockedByRuntime', 'Currently blocked by runtime availability.'));
      }
      const noteMarkup = noteParts.length
        ? `<div class="settings-note tools-config-field-help">${escapeHtml(noteParts.join(' '))}</div>`
        : '';
      return `
        <article class="tools-config-field-row" data-tool-config-key="${escapeHtml(field.key)}">
          ${renderToggle({
            id,
            label: field.label,
            tooltip: copy ? copy.tooltip : '',
            checked,
            disabled,
            className: 'settings-tool-config-toggle',
          })}
          ${noteMarkup}
        </article>
      `;
    }).join('');
  }

  // Generic inventory-switch list builder: turns a flat field spec into a
  // vertical stack of toggleSwitch rows so every settings section can drive
  // switches the same way the Tools capability list does (zero raw-HTML budget).
  function buildSettingsToggleListMarkup(options) {
    const source = isPlainObject(options) ? options : {};
    const escapeHtml = typeof source.escapeHtml === 'function'
      ? source.escapeHtml
      : defaultEscapeHtml;
    const renderToggle = getToggleSwitchRenderer(source.toggleSwitch);
    const fields = Array.isArray(source.fields) ? source.fields : [];
    if (!renderToggle) {
      return `<div class="settings-note">${escapeHtml(jt('settings.shell.controlsUnavailable', 'Controls are unavailable right now.'))}</div>`;
    }
    return fields
      .filter((field) => isPlainObject(field) && normalizeString(field.id))
      .map((field) => {
        const id = normalizeString(field.id);
        // A field that omits label/description inherits the plain-English
        // baseline from renderer-settings-field-copy.js; call-site values
        // (dynamic, state-dependent text) win.
        const copy = getFieldCopy(id);
        return renderToggle({
          id,
          label: field.label || (copy ? copy.label : ''),
          description: field.description || (copy ? copy.description : ''),
          tooltip: field.tooltip || (copy ? copy.tooltip : ''),
          checked: field.checked === true,
          disabled: field.disabled === true,
        });
      })
      .join('');
  }

  // Context section: two switch lists, keyed by persistence path. "sources" are
  // session runtime preferences (runRuntimePreferenceActivity); "runtime" are
  // managed feature flags (applyFeatureSettings). The ids are stable so the
  // delegated inv-toggle-change handler can route each back to the right call.
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
          { id: 'contextTokenBudgetToggle', checked: flags.token_budget === true, disabled: flagsDisabled },
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
    const textFieldFn = typeof source.textField === 'function'
      ? source.textField
      : getInventoryFn('textField', 'inventoryTextField');
    const actionButtonFn = typeof source.actionButton === 'function'
      ? source.actionButton
      : getInventoryFn('actionButton', 'inventoryActionButton');
    if (typeof textFieldFn !== 'function') {
      return '';
    }
    const disabled = source.disabled === true;
    const promptCopy = getFieldCopy('compactionPromptField');
    const parts = [];
    parts.push(textFieldFn({
      id: 'compactionPromptField',
      label: promptCopy ? promptCopy.label : jt('settings.context.customSummarizationPromptLabel', 'Custom summarization prompt'),
      value: source.customPromptValue || '',
      placeholder: jt('settings.context.customSummarizationPromptPlaceholder', 'Leave empty to use the built-in prompt'),
      multiline: true,
      hint: promptCopy ? promptCopy.description : '',
      ariaLabel: promptCopy ? promptCopy.label : jt('settings.context.customSummarizationPromptLabel', 'Custom summarization prompt'),
      disabled,
      dataset: { 'compaction-field': 'customPrompt' },
    }));
    if (typeof actionButtonFn === 'function') {
      parts.push('<div class="settings-inline-actions">' + actionButtonFn({
        id: 'reset-compaction-prompt',
        label: jt('settings.context.resetGuidance', 'Reset guidance'),
        variant: 'secondary',
        disabled: disabled || !String(source.customPromptValue || '').trim(),
      }) + '</div>');
    }
    const statusMessage = String(source.statusMessage || '').trim();
    if (statusMessage) {
      parts.push(`<div class="settings-note" id="compactionTuningStatus" data-compaction-status="${escapeHtmlFn(source.statusTone || 'info')}">${escapeHtmlFn(statusMessage)}</div>`);
    } else {
      parts.push('<div class="settings-note" id="compactionTuningStatus"></div>');
    }
    return parts.join('');
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
    DEFAULT_TOOL_CONFIG_FIELDS,
    normalizeToolConfig,
    encodeToolConfigToggleKey,
    decodeToolConfigToggleKey,
    getToolConfigFieldsForRender,
    UI_LANGUAGE_TAGS,
    buildUiLanguageFieldMarkup,
    buildSafetyModeFieldMarkup,
    buildUnattendedGuardFieldMarkup,
    buildDefaultRunModeFieldMarkup,
    buildToolConfigFieldListMarkup,
    buildSettingsToggleListMarkup,
    buildContextToggleListsMarkup,
    buildCompactionTuningMarkup,
    resolveToolConfigToggleEvent,
    normalizeRunMode,
    normalizeDefaultRunMode,
    normalizeUiLanguageTag,
    normalizeSafetyMode,
    normalizeUnattendedGuardMinutes,
    resolveUiLanguageChangeEvent,
    resolveSafetyModeChangeEvent,
    resolveUnattendedGuardChangeEvent,
    resolveDefaultRunModeChangeEvent,
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
    resolveWebSearchFieldChangeEvent,
    resolveWebSearchKeySaveClickEvent,
    resolveCompactionFieldChangeEvent,
  };
});
