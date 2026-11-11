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
  const loadSiblingModule = (globalName, modulePath) => globalThis[globalName] || (typeof require === 'function' ? require(modulePath) : null);
  // The web-search block, the tool switch-field model and the chatUi value normalizers / external-change
  // sync live in sibling modules (loaded just before this one); this module re-exports their surface.
  const {
    WEB_SEARCH_PROVIDERS,
    WEB_SEARCH_SECRET_KEY_IDS,
    normalizeWebSearchState,
    buildWebSearchSectionMarkup,
    resolveWebSearchKeySaveClickEvent,
  } = loadSiblingModule('rendererSettingsWebSearch', './renderer-settings-web-search.js');
  const {
    DEFAULT_TOOL_CONFIG_FIELDS,
    normalizeToolConfig,
    normalizeToolConfigFields,
    getToolConfigFieldsForRender,
  } = loadSiblingModule('rendererSettingsToolConfig', './renderer-settings-tool-config.js');
  const {
    UI_LANGUAGE_TAGS,
    normalizeRunMode,
    normalizeDefaultRunMode,
    normalizeUiLanguageTag,
    normalizeSafetyMode,
    normalizeUnattendedGuardMinutes,
    normalizeAutoApproveStreakCap,
    normalizeDigestQuietStart,
    normalizeDigestQuietEnd,
    createExternalSettingsSync,
  } = loadSiblingModule('rendererSettingsExternalSync', './renderer-settings-external-sync.js');
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
    const text = s.busy ? (s.loadingModel ? jt('settings.modelLibrary.badgeSwitching', 'Switching') : jt('settings.modelLibrary.badgeUnloading', 'Unloading'))
      : state === 'error' ? jt('healthPill.error', 'Error')
      : state === 'warn' ? jt('diagnostics.common.unavailable', 'Unavailable')
      : (s.activeModel || jt('settings.modelLibrary.defaultBackend', 'Default backend'));
    return { state, text };
  }

  const TOOL_CONFIG_TOGGLE_ID_PREFIX = 'settings-tool-config-';
  // Dependent row (or row set) -> the tool switch it follows. While the parent is
  // off the dependent row is marked parent-off and locked, and its stored value is kept.
  const TOOL_DEPENDENTS = Object.freeze({ richFiles: 'fileTools', commandSandbox: 'bash', webSearch: 'web' });
  const UI_LANGUAGE_LABELS = Object.freeze([
    jt('settings.language.option.en', 'English'), jt('settings.language.option.es', 'Español (Spanish)'), jt('settings.language.option.fr', 'Français (French)'), jt('settings.language.option.de', 'Deutsch (German)'),
    jt('settings.language.option.it', 'Italiano (Italian)'), jt('settings.language.option.ptBr', 'Português do Brasil (Brazilian Portuguese)'), jt('settings.language.option.nl', 'Nederlands (Dutch)'), jt('settings.language.option.pl', 'Polski (Polish)'),
    jt('settings.language.option.ru', 'Русский (Russian)'), jt('settings.language.option.uk', 'Українська (Ukrainian)'), jt('settings.language.option.tr', 'Türkçe (Turkish)'), jt('settings.language.option.ar', 'العربية (Arabic)'),
    jt('settings.language.option.hi', 'हिन्दी (Hindi)'), jt('settings.language.option.id', 'Bahasa Indonesia (Indonesian)'), jt('settings.language.option.vi', 'Tiếng Việt (Vietnamese)'), jt('settings.language.option.ja', '日本語 (Japanese)'),
    jt('settings.language.option.ko', '한국어 (Korean)'), jt('settings.language.option.zhCn', '简体中文 (Simplified Chinese)'),
    jt('settings.language.option.zhTw', '繁體中文 (Traditional Chinese)'),
  ]);

  function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  function normalizeString(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  const defaultEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

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
      }) + (field.key === 'subagents' ? '<div data-subagent-routing-host></div>' : '');
    }).join('');
  }

  // Patches the dependent rows under `root` (#toolsConfigFieldList) in place to the
  // state a fresh render gives. It runs after every Tools render, because the patch
  // guard holds the lists while focus or an unsaved key is inside them.
  function syncToolDependents(root, options) {
    globalThis.rendererSettingsSubagents?.sync?.(root);
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
          { id: 'contextMemoryOptOutToggle', checked: prefs.memoryOptOut === true, disabled: prefsDisabled },
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
    const source = isPlainObject(payload) ? payload : {};
    return {
      loaded: true,
      // Display-only Tier C #12 seam: carried through so a render-time
      // normalize pass (renderer-settings-utils.js) doesn't drop the flag
      // applyFeatureStatePayload set. Never influences tools/featureFlags
      // below, only status-chip rendering.
      availabilityResolved: source.availabilityResolved === true,
      tools: isPlainObject(source.tools) ? { ...source.tools } : {},
      subagentRouting: Object.fromEntries(['chatgpt', 'codex-cli'].map((provider) => {
        const row = source.subagentRouting?.[provider] || {};
        return [provider, { defaultModel: String(row.defaultModel || ''), defaultEffort: String(row.defaultEffort || ''),
          preferredModels: Array.isArray(row.preferredModels) ? [...row.preferredModels] : [],
          allowedModels: Array.isArray(row.allowedModels) ? [...row.allowedModels] : [], maxEffort: String(row.maxEffort || '') }];
      })),
      subagentModelCatalogs: source.subagentModelCatalogs || {},
      memory: {
        takeNotes: source.memory?.takeNotes !== false,
        askBeforeSaving: source.memory?.askBeforeSaving === true,
        pauseSaving: source.memory?.pauseSaving === true,
        useInChats: source.memory?.useInChats !== false,
      },
      featureFlags: isPlainObject(source.featureFlags) ? { ...source.featureFlags } : {},
      featureOverrides: isPlainObject(source.featureOverrides) ? { ...source.featureOverrides } : {},
      availability: isPlainObject(source.availability)
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
    const source = isPlainObject(payload) ? payload : {};
    const status =
      isPlainObject(source.status)
        ? {
            state: String(source.status.state || 'missing').trim() || 'missing',
            message: String(source.status.message || '').trim(),
          }
        : isPlainObject(source.workspaceRootStatus)
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
    resolveModelBadge,
    TOOL_DEPENDENTS,
    DEFAULT_TOOL_CONFIG_FIELDS,
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
    normalizeDigestQuietStart,
    normalizeDigestQuietEnd,
    normalizeFeatureState,
    normalizeWorkspaceRootState,
    getStatusRowRenderer,
    buildStatusRowFallbackMarkup,
    renderStatusRowContainer,
    buildSettingsSummaryModel,
    createExternalSettingsSync,
    WEB_SEARCH_PROVIDERS,
    WEB_SEARCH_SECRET_KEY_IDS,
    normalizeWebSearchState,
    buildWebSearchSectionMarkup,
    resolveWebSearchKeySaveClickEvent,
  };
});
