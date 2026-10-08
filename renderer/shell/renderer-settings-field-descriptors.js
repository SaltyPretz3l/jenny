/**
 * renderer/shell/renderer-settings-field-descriptors.js
 *
 * One frozen descriptor per Settings preference (docs/plans/settings-cohesion/
 * SETTINGS_CONTROL_CONTRACT.md §2). A descriptor is presentation plus a
 * reference to its persistence owner: kind, control, default, validation,
 * copy, and the adapter/key it writes through. Operational choices (write,
 * acknowledgement, rollback) live in renderer-settings-field-binding.js.
 *
 * Rules: hydration normalizes (normalizeSettingValue never clamps; an
 * out-of-range stored value falls back to the default), edits validate
 * (validateSettingValue rejects, never coerces). `searchOnly` descriptors
 * mirror controls a schema still generates (Advanced engine tuning, Runtime
 * limits) so search reaches them; the schema keeps the bounds authority.
 *
 * Pure data: no DOM, no bridge, no requires of shell modules.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsFieldDescriptors = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const KINDS = Object.freeze(['boolean', 'enum', 'integer', 'decimal', 'optionalInteger', 'text']);
  const CONTROLS = Object.freeze(['toggle', 'segmented', 'select', 'number', 'optionalNumber', 'choice', 'text']);
  const SEGMENTED_MAX_OPTIONS = 4;

  function isRecord(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
  function isFiniteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
  /* Option lists that only exist at runtime ('source:<name>': palettes, installed
   * models, languages) are registered by the section that owns the list, so
   * validation, coercion and the "Default:" label read the same list the
   * control renders. Static option arrays win; an unregistered source is null. */
  const OPTION_SOURCES = new Map();
  function registerOptionSource(name, provider) {
    if (typeof name !== 'string' || !name) throw new TypeError('registerOptionSource(name, provider): name is required');
    if (typeof provider !== 'function' && !Array.isArray(provider)) throw new TypeError(`registerOptionSource("${name}"): provider must be a function or an array`);
    OPTION_SOURCES.set(name, provider);
  }
  function resolveSettingOptions(descriptor) {
    if (Array.isArray(descriptor.options)) return descriptor.options;
    const source = typeof descriptor.options === 'string' && descriptor.options.startsWith('source:') ? OPTION_SOURCES.get(descriptor.options.slice('source:'.length)) : null;
    const list = typeof source === 'function' ? source() : source;
    return Array.isArray(list) ? list : null;
  }
  function optionValues(descriptor) {
    const options = resolveSettingOptions(descriptor);
    return options ? options.map((option) => String(option.value)) : null;
  }

  /* Control by value type (contract §3): boolean -> toggle; enum with 2-4
   * static options -> segmented, otherwise select; numbers -> number input;
   * optionalInteger -> empty-means-off number; text -> text field. */
  function resolveControlKind(descriptor) {
    switch (descriptor.kind) {
      case 'boolean': return 'toggle';
      case 'enum': {
        const values = optionValues(descriptor);
        return values && values.length <= SEGMENTED_MAX_OPTIONS ? 'segmented' : 'select';
      }
      case 'integer':
      case 'decimal': return 'number';
      case 'optionalInteger': return 'optionalNumber';
      default: return 'text';
    }
  }

  function inRange(descriptor, value) {
    const v = descriptor.validation;
    if (isFiniteNumber(v.min) && value < v.min) return false;
    if (isFiniteNumber(v.max) && value > v.max) return false;
    return true;
  }

  /* Hydration: total, never clamps. A value the schema would not produce
   * resolves to the default (engine tuning drops out-of-range overrides the
   * same way), so a stale record can never render as an invalid edit. */
  function normalizeSettingValue(descriptor, raw) {
    const d = descriptor;
    switch (d.kind) {
      case 'boolean': return typeof raw === 'boolean' ? raw : d.default;
      case 'enum': {
        const values = optionValues(d);
        if (raw == null) return d.default;
        if (values) return values.includes(String(raw)) ? raw : d.default;
        return typeof raw === 'string' || typeof raw === 'number' ? raw : d.default;
      }
      case 'integer': return Number.isInteger(raw) && inRange(d, raw) ? raw : d.default;
      case 'decimal': return isFiniteNumber(raw) && inRange(d, raw) ? raw : d.default;
      case 'optionalInteger':
        if (raw === d.offValue) return d.offValue;
        return Number.isInteger(raw) && inRange(d, raw) ? raw : d.default;
      default: return typeof raw === 'string' ? raw : d.default;
    }
  }

  function invalidNumberMessage(descriptor, integer) {
    const v = descriptor.validation;
    const shown = (bound) => (isFiniteNumber(bound) ? Number((bound / descriptor.presentation.scale).toFixed(6)) : '');
    const params = { min: shown(v.min), max: shown(v.max) };
    return integer
      ? jt('runtime.limits.fieldError', 'Enter a whole number from {min} to {max}.', params)
      : jt('settings.field.invalidNumber', 'Enter a number from {min} to {max}.', params);
  }

  /* Edit validation: rejects, never coerces. Returns { ok, value } or { ok:false, error }. */
  function validateSettingValue(descriptor, value) {
    const d = descriptor;
    const reject = (error) => ({ ok: false, error });
    switch (d.kind) {
      case 'boolean':
        return typeof value === 'boolean' ? { ok: true, value } : reject(jt('settings.field.invalidOption', 'Choose one of the listed options.'));
      case 'enum': {
        const values = optionValues(d);
        if (values ? values.includes(String(value)) : (typeof value === 'string' && value !== '')) return { ok: true, value };
        return reject(jt('settings.field.invalidOption', 'Choose one of the listed options.'));
      }
      case 'integer':
        return Number.isInteger(value) && inRange(d, value) ? { ok: true, value } : reject(invalidNumberMessage(d, true));
      case 'decimal':
        return isFiniteNumber(value) && inRange(d, value) ? { ok: true, value } : reject(invalidNumberMessage(d, false));
      case 'optionalInteger':
        if (value === d.offValue) return { ok: true, value };
        return Number.isInteger(value) && inRange(d, value) ? { ok: true, value } : reject(invalidNumberMessage(d, true));
      default:
        if (typeof value !== 'string') return reject(jt('settings.field.invalidOption', 'Choose one of the listed options.'));
        if (isFiniteNumber(d.validation.maxLength) && value.length > d.validation.maxLength) {
          return reject(jt('settings.field.tooLong', 'Keep it under {max} characters.', { max: d.validation.maxLength }));
        }
        return { ok: true, value };
    }
  }

  /* "Modified" follows the owner's storage semantics (contract §2): a null
   * default means "override present"; otherwise the normalized value differs
   * from the default. Booleans carry no meta but still answer truthfully. */
  function isSettingModified(descriptor, value, liveDefault) {
    if (descriptor.defaultSource === 'adapter') {
      return liveDefault != null && normalizeSettingValue(descriptor, value) !== liveDefault;
    }
    if (descriptor.default === null) return value != null && value !== '';
    return normalizeSettingValue(descriptor, value) !== descriptor.default;
  }

  /* Meta text for the title line. `liveDefault` lets an adapter-sourced
   * default (Runtime limits) be described once the adapter has hydrated it. */
  function describeSettingDefaultValue(descriptor, liveDefault) {
    const d = descriptor;
    if (d.kind === 'boolean' || d.noMeta) return '';
    const value = d.defaultSource === 'adapter' ? liveDefault : d.default;
    if (value == null || (d.kind === 'text' && value === '')) return d.defaultLabel || '';
    const options = resolveSettingOptions(d);
    const option = options ? options.find((entry) => String(entry.value) === String(value)) : null;
    if (option) return option.label;
    const choice = d.presentation.choices.find((entry) => entry.value === value);
    if (choice) return choice.label;
    if (value === d.offValue && d.presentation.offLabel) return d.presentation.offLabel;
    const shown = typeof value === 'number' ? Number((value / d.presentation.scale).toFixed(6)) : value;
    return String(shown) + (d.presentation.unit ? ' ' + d.presentation.unit : '');
  }

  const REGISTRY = new Map();

  function defineSettingDescriptor(spec) {
    if (!isRecord(spec)) throw new TypeError('defineSettingDescriptor(spec): spec must be an object');
    const id = String(spec.id || '').trim();
    if (!id) throw new TypeError('defineSettingDescriptor: id is required');
    if (REGISTRY.has(id)) throw new TypeError(`defineSettingDescriptor("${id}"): duplicate id`);
    if (!KINDS.includes(spec.kind)) throw new TypeError(`defineSettingDescriptor("${id}"): unknown kind "${spec.kind}"`);
    if (!spec.sectionId) throw new TypeError(`defineSettingDescriptor("${id}"): sectionId is required`);
    if (spec.kind === 'enum' && !(Array.isArray(spec.options) || /^source:[a-zA-Z]+$/.test(String(spec.options)))) {
      throw new TypeError(`defineSettingDescriptor("${id}"): enum needs options or 'source:<name>'`);
    }
    if (spec.kind === 'optionalInteger' && spec.offValue === undefined) throw new TypeError(`defineSettingDescriptor("${id}"): optionalInteger needs offValue`);
    if (spec.control && !CONTROLS.includes(spec.control)) throw new TypeError(`defineSettingDescriptor("${id}"): unknown control "${spec.control}"`);
    if (spec.control && !spec.controlReason) throw new TypeError(`defineSettingDescriptor("${id}"): a control override needs controlReason`);
    if (!spec.adapterId || !spec.key) throw new TypeError(`defineSettingDescriptor("${id}"): adapterId and key are required`);
    const defaultSource = spec.defaultSource === 'adapter' ? 'adapter' : 'static';
    if (defaultSource === 'static' && spec.default === undefined) throw new TypeError(`defineSettingDescriptor("${id}"): default is required`);
    if (defaultSource === 'static' && spec.default === null && !spec.defaultLabel && !spec.noMeta) {
      throw new TypeError(`defineSettingDescriptor("${id}"): a null default needs defaultLabel`);
    }
    const copy = spec.copy === undefined ? 'field-copy:' + id : spec.copy;
    if (!(typeof copy === 'string' && copy.startsWith('field-copy:')) && !(isRecord(copy) && copy.label)) {
      throw new TypeError(`defineSettingDescriptor("${id}"): copy must be 'field-copy:<id>' or { label, description }`);
    }
    const presentation = Object.assign({ unit: '', presets: [], offLabel: '', choices: [], scale: 1 }, isRecord(spec.presentation) ? spec.presentation : {});
    if (!isFiniteNumber(presentation.scale) || presentation.scale <= 0) throw new TypeError(`defineSettingDescriptor("${id}"): scale must be a finite number greater than zero`);
    const descriptor = Object.freeze({
      id,
      sectionId: String(spec.sectionId),
      kind: spec.kind,
      controlId: String(spec.controlId || id),
      control: spec.control || resolveControlKind(spec),
      controlReason: spec.controlReason ? String(spec.controlReason) : '',
      default: spec.default === undefined ? null : spec.default,
      defaultLabel: spec.defaultLabel ? String(spec.defaultLabel) : '',
      defaultSource,
      noMeta: spec.noMeta === true,
      options: Array.isArray(spec.options) ? Object.freeze(spec.options.map((option) => Object.freeze({ value: option.value, label: String(option.label == null ? option.value : option.label) }))) : (spec.options || null),
      validation: Object.freeze(Object.assign({}, isRecord(spec.validation) ? spec.validation : {})),
      presentation: Object.freeze(presentation),
      offValue: spec.offValue,
      copy: typeof copy === 'string' ? copy : Object.freeze({ label: String(copy.label), description: String(copy.description || ''), detail: String(copy.detail || ''), keywords: Object.freeze(Array.isArray(copy.keywords) ? copy.keywords.slice() : []) }),
      adapterId: String(spec.adapterId),
      key: String(spec.key),
      searchOnly: spec.searchOnly === true,
    });
    REGISTRY.set(id, descriptor);
    return descriptor;
  }

  function getSettingDescriptor(id) {
    return REGISTRY.get(String(id == null ? '' : id)) || null;
  }

  function getSettingDescriptorByControlId(controlId) {
    const wanted = String(controlId == null ? '' : controlId);
    if (!wanted) return null;
    for (const descriptor of REGISTRY.values()) {
      if (descriptor.controlId === wanted) return descriptor;
    }
    return null;
  }

  function listSettingDescriptors(filter) {
    const f = isRecord(filter) ? filter : {};
    const out = [];
    for (const descriptor of REGISTRY.values()) {
      if (f.sectionId && descriptor.sectionId !== f.sectionId) continue;
      if (f.adapterId && descriptor.adapterId !== f.adapterId) continue;
      if (f.searchOnly !== undefined && descriptor.searchOnly !== f.searchOnly) continue;
      out.push(descriptor);
    }
    return out;
  }

  /* Search projection for descriptors that carry their own copy. Descriptors
   * that reference a field-copy entry are already in the legacy copy map;
   * renderer-settings-field-copy.js unions the two and dedupes by id. */
  function listDescriptorCopyEntries() {
    const out = [];
    for (const descriptor of REGISTRY.values()) {
      if (typeof descriptor.copy === 'string') continue;
      out.push({
        id: descriptor.controlId,
        label: descriptor.copy.label,
        description: descriptor.copy.description,
        sectionId: descriptor.sectionId,
        keywords: descriptor.copy.keywords.slice(),
      });
    }
    return out;
  }

  // ── Descriptor table ─────────────────────────────────────────────────────
  // Slice ownership: the settings-cohesion descriptor assignments plan.
  const def = defineSettingDescriptor;
  // A source-backed list resolves after this table is built, so its 2-4 presets name the control here.
  const SOURCE_SEGMENTED = 'source-backed:2-4-presets';
  const bool = (id, sectionId, adapterId, key, dflt, extra) => def(Object.assign({ id, sectionId, kind: 'boolean', adapterId, key, default: dflt }, extra || {}));
  // Units show in number boxes, Revert buttons and quick picks, so translators see them too.
  const UNIT = Object.freeze({ sec: jt('settings.unit.sec', 'sec'), min: jt('settings.unit.min', 'min'), kb: jt('settings.unit.kb', 'KB'), mb: jt('settings.unit.mb', 'MB') });
  // A saved pause length that is not on the list is worded like the listed ones.
  const guardMinutesLabel = (n) => jt('settings.unattendedGuard.choice.minutes', '{n} min', { n });

  // Tools (chatUi scalars, tool config, web search, command sandbox)
  def({ id: 'safetyModeSelect', sectionId: 'tools', kind: 'enum', default: 'normal', adapterId: 'chatUi', key: 'safetyMode',
    options: [{ value: 'normal', label: jt('settings.safetyMode.option.normal', 'Normal') }, { value: 'strict', label: jt('settings.safetyMode.option.strict', 'Strict') }, { value: 'paranoid', label: jt('settings.safetyMode.option.paranoid', 'Paranoid') }] });
  def({ id: 'defaultRunModeSelect', sectionId: 'tools', kind: 'enum', default: 'ask', adapterId: 'chatUi', key: 'defaultRunMode',
    options: [{ value: 'ask', label: jt('composer.runMode.ask', 'Ask') }, { value: 'auto', label: jt('composer.runMode.auto', 'Auto') }, { value: 'plan', label: jt('composer.runMode.plan', 'Plan') }] });
  def({ id: 'unattendedGuardMinutesInput', sectionId: 'tools', kind: 'optionalInteger', default: 0, offValue: 0, control: 'choice', controlReason: 'row-standard:off-capable-dropdown', adapterId: 'chatUi', key: 'unattendedGuardMinutes',
    validation: { min: 1, max: 120, step: 1 }, presentation: { unit: UNIT.min, offLabel: jt('settings.unattendedGuard.choice.never', 'Never'), choiceLabel: guardMinutesLabel,
      choices: [5, 10, 15, 30].map((n) => ({ value: n, label: guardMinutesLabel(n) })).concat([
        { value: 60, label: jt('settings.unattendedGuard.choice.oneHour', '1 hour') }, { value: 120, label: jt('settings.unattendedGuard.choice.twoHours', '2 hours') },
      ]) } });
  def({ id: 'autoApproveStreakCapInput', sectionId: 'tools', kind: 'optionalInteger', offValue: 0, default: 50, adapterId: 'chatUi', key: 'autoApproveStreakCap', validation: { min: 1, max: 500, step: 1 }, presentation: { offLabel: jt('settings.field.noLimit', 'No limit') } });
  // Tool toggles: the only place their copy is written. The tool-config field table in
  // renderer-settings-support.js reads label, help and detail from these descriptors.
  const TOOL_COPY = {
    imageRead: [jt('settings.tools.imageRead.label', 'Image and PDF page reads'), jt('settings.tools.imageRead.description', 'Let the model look at images and PDF pages.')],
    fileTools: [jt('settings.tools.fileTools.label', 'File tools'), jt('settings.tools.fileTools.description', 'Read, write, edit and search files in the workspace.')],
    richFiles: [jt('settings.tools.richFiles.label', 'Rich file reading'), jt('settings.tools.richFiles.description', 'Open PDFs, spreadsheets, documents, slides and notebooks as structured content.')],
    web: [jt('settings.tools.web.label', 'Web tools'), jt('settings.tools.web.description', 'Search the web and fetch pages.')],
    pythonRuntime: [jt('settings.tools.pythonRuntime.label', 'Python execution'), jt('settings.tools.pythonRuntime.description', 'Run Python with the same file access as Jenny. Every run asks first.'), jt('settings.tools.pythonRuntime.detail', 'Resource-bounded, but not a filesystem or network sandbox.')],
    worktree: [jt('settings.tools.worktree.label', 'Worktree tools'), jt('settings.tools.worktree.description', 'Create and switch isolated Git worktrees.')],
    subagents: [jt('settings.tools.subagents.label', 'Delegated research'), jt('settings.tools.subagents.description', 'Hand read-only repository research to helper tasks. Adds model cost and time.')],
    bash: [jt('settings.tools.bash.label', 'Terminal commands'), jt('settings.tools.bash.description', 'Run shell commands in the workspace.')],
    lsp: [jt('settings.tools.lsp.label', 'Code intelligence'), jt('settings.tools.lsp.description', 'Read-only diagnostics, symbols and definitions from language servers.')],
  };
  [['imageRead', false], ['fileTools', true], ['richFiles', true], ['web', false], ['pythonRuntime', false], ['worktree', false], ['subagents', true], ['bash', true], ['lsp', false]].forEach(([key, dflt]) => {
    bool('settings-tool-config-' + key, 'tools', 'features', 'toolConfig.' + key, dflt, { copy: { label: TOOL_COPY[key][0], description: TOOL_COPY[key][1], detail: TOOL_COPY[key][2] } });
  });
  def({ id: 'webSearchProviderSelect', sectionId: 'tools', kind: 'enum', default: 'duckduckgo', adapterId: 'features', key: 'webSearch.provider', options: 'source:webSearchProviders',
    copy: { label: jt('settings.tools.webSearch.providerLabel', 'Search provider'), description: jt('settings.tools.webSearch.providerHelp', 'DuckDuckGo needs no setup.') } });
  def({ id: 'webSearchSearxngUrlField', sectionId: 'tools', kind: 'text', default: '', adapterId: 'features', key: 'webSearch.searxngUrl',
    copy: { label: jt('settings.tools.webSearch.searxngUrlLabel', 'SearXNG instance URL'), description: jt('settings.tools.webSearch.providerHelp', 'DuckDuckGo needs no setup.') } });
  bool('commandSandboxEnabled', 'tools', 'commandSandbox', 'enabled', false, { copy: { label: jt('settings.commandSandbox.rowLabel', 'Run commands in a sandbox'), description: jt('settings.commandSandbox.rowHelp', 'A disposable copy with no network. Needs Docker.') } });

  // Models
  bool('modelStartupLoadToggle', 'models', 'engines', 'startupModelLoad', true);
  bool('chatgptModelsEnabledToggle', 'models', 'cloudModels', 'chatgptEnabled', true, { copy: { label: jt('settings.cloudModels.chatgptShowLabel', 'Show ChatGPT models in Composer'), description: jt('settings.cloudModels.chatgptShowHelp', 'Turning it off keeps you signed in.') } });

  // Context (session runtime preferences and managed feature flags)
  def({ id: 'contextHistoryScopeSelect', sectionId: 'context', kind: 'enum', control: 'select', controlReason: 'row-standard:labels-over-260px', default: 'session', adapterId: 'runtimePreferences', key: 'contextPreferences.historyScope',
    options: [{ value: 'session', label: jt('settings.context.fullSession', 'Full session') }, { value: 'recent', label: jt('settings.context.historyScope.lastSixTurns', 'Last 6 turns') }, { value: 'fresh', label: jt('settings.context.historyScope.newPromptOnly', 'New prompt only') }] });
  bool('contextIncludePersonalityToggle', 'context', 'runtimePreferences', 'contextPreferences.includePersonality', true);
  bool('contextIncludeMemoryToggle', 'context', 'runtimePreferences', 'contextPreferences.includeMemory', true);
  bool('contextCompactionToggle', 'context', 'features', 'featureFlags.context_compaction', true);
  // Summary guidance saves through the compaction tuning transaction (services/model-tuning-service.js), not the feature settings.
  def({ id: 'compactionPromptField', sectionId: 'context', kind: 'text', default: '', adapterId: 'compactionTuning', key: 'customPrompt', validation: { maxLength: 20000 }, defaultLabel: jt('settings.field.defaultNone', 'None') });

  // Skills (hosted by Extensions)
  // Off by default: services/shell-config-normalizers.js seeds userEnabled/projectEnabled false.
  bool('skillsUserToggle', 'skills', 'skills', 'userEnabled', false);
  bool('skillsProjectToggle', 'skills', 'skills', 'projectEnabled', false);
  def({ id: 'skillsAutoIndexToggle', sectionId: 'skills', kind: 'enum', default: 'auto', adapterId: 'skills', key: 'autoIndex',
    options: [{ value: 'auto', label: jt('settings.advanced.auto', 'Auto') }, { value: 'on', label: jt('common.on', 'On') }, { value: 'off', label: jt('common.off', 'Off') }],
    copy: { label: jt('skills.settings.autoChoose', 'Let Jenny choose skills automatically'), description: jt('skills.autoIndex.description', 'Adds a short skill index to every turn (~900 tokens). Auto: on for cloud models, off for local models.') } });

  // Appearance (renderer-local appearance store, chatUi scalars, windowUi zoom, managed spellcheck flag)
  def({ id: 'appearanceThemeBundleSelect', sectionId: 'appearance', kind: 'enum', default: null, noMeta: true, adapterId: 'appearance', key: 'themeBundleId', options: 'source:themeBundles' });
  def({ id: 'appearancePaletteSelect', sectionId: 'appearance', kind: 'enum', default: 'slate', adapterId: 'appearance', key: 'paletteId', options: 'source:palettes' });
  def({ id: 'appearanceTypographySelect', sectionId: 'appearance', kind: 'enum', default: 'technical', adapterId: 'appearance', key: 'typographyId', options: 'source:typography' });
  def({ id: 'appearanceFontScaleSelect', sectionId: 'appearance', kind: 'enum', default: 'default', adapterId: 'appearance', key: 'fontScaleId', options: 'source:fontScales', control: 'segmented', controlReason: SOURCE_SEGMENTED });
  def({ id: 'appearanceChatWidthSelect', sectionId: 'appearance', kind: 'enum', default: 'standard', adapterId: 'appearance', key: 'chatWidthId', options: 'source:chatWidths', control: 'segmented', controlReason: SOURCE_SEGMENTED });
  def({ id: 'appearanceSurfaceEffectSelect', sectionId: 'appearance', kind: 'enum', default: 'none', adapterId: 'appearance', key: 'surfaceEffectId', options: 'source:surfaceEffects' });
  bool('appearanceComposerHoloToggle', 'appearance', 'appearance', 'composerHoloId', true);
  bool('appearanceStartupAnimationToggle', 'appearance', 'appearance', 'startupAnimation', true);
  bool('appearanceTitlebarLoadToggle', 'appearance', 'appearance', 'titlebarLoad', false);
  bool('appearanceArtifactAutoOpenToggle', 'appearance', 'appearance', 'artifactAutoOpen', false);
  bool('appearanceSpellcheckToggle', 'appearance', 'features', 'featureFlags.text_spellcheck', true);
  def({ id: 'appearanceAppZoomSelect', sectionId: 'appearance', kind: 'enum', default: 110, adapterId: 'windowUi', key: 'appZoomPercent', options: 'source:appZoomPresets' });
  def({ id: 'uiLanguageSelect', sectionId: 'appearance', kind: 'enum', default: 'en', adapterId: 'chatUi', key: 'uiLanguage', options: 'source:uiLanguages' });
  def({ id: 'use24HourTime', sectionId: 'appearance', kind: 'boolean', default: false, controlId: 'use24HourTimeToggle', adapterId: 'chatUi', key: 'use24HourTime', copy: 'field-copy:use24HourTimeToggle' });
  def({ id: 'transcriptViewDefaultSelect', sectionId: 'appearance', kind: 'enum', default: 'thinking', adapterId: 'chatUi', key: 'transcriptViewDefault',
    options: [{ value: 'answers', label: jt('settings.transcriptView.answers', 'Answers') }, { value: 'thinking', label: jt('settings.transcriptView.thinking', 'Thinking') }, { value: 'everything', label: jt('settings.transcriptView.everything', 'Everything') }] });

  // Editor (workspaceIde object)
  def({ id: 'editorFontSizeSelect', sectionId: 'editor', kind: 'enum', default: 0, adapterId: 'workspaceIde', key: 'fontSize', options: 'source:editorFontSizes' });
  def({ id: 'editorTabSizeSelect', sectionId: 'editor', kind: 'enum', default: 2, adapterId: 'workspaceIde', key: 'tabSize', options: 'source:editorTabSizes', control: 'select', controlReason: 'runtime-options:S5-decides' });
  def({ id: 'editorRenderWhitespaceSelect', sectionId: 'editor', kind: 'enum', default: 'selection', adapterId: 'workspaceIde', key: 'renderWhitespace', options: 'source:editorWhitespace' });
  def({ id: 'editorRulersSelect', sectionId: 'editor', kind: 'enum', default: '', adapterId: 'workspaceIde', key: 'rulers', options: 'source:editorRulers' });
  bool('editorWordWrapToggle', 'editor', 'workspaceIde', 'wordWrap', false);
  bool('editorMinimapToggle', 'editor', 'workspaceIde', 'minimap', true);
  bool('editorLineNumbersToggle', 'editor', 'workspaceIde', 'lineNumbers', true);
  bool('editorFormatOnSaveToggle', 'editor', 'workspaceIde', 'formatOnSave', false);
  bool('editorTrimTrailingWhitespaceToggle', 'editor', 'workspaceIde', 'trimTrailingWhitespace', false);
  bool('editorInsertFinalNewlineToggle', 'editor', 'workspaceIde', 'insertFinalNewline', false);
  bool('editorAutoSaveToggle', 'editor', 'workspaceIde', 'autoSaveEnabled', false);

  // Home (scratchpad settings object). The contextual-tips control is retired (checkpoint 1, D2).
  def({ id: 'homeScratchpadCaptureSelect', sectionId: 'home', kind: 'enum', default: 'append', adapterId: 'home', key: 'captureMode',
    options: [{ value: 'append', label: jt('settings.home.appendTimestampedLine', 'Append a timestamped line') }, { value: 'overwrite', label: jt('settings.home.replaceNote', 'Replace the note') }] });
  bool('homeScratchpadGlobalCaptureToggle', 'home', 'home', 'globalCapture', true);

  // Notifications (windowUi.notifications object; S0 pilot)
  bool('notificationsEnabledToggle', 'notifications', 'windowUi.notifications', 'enabled', true);
  bool('notificationsBackgroundOnlyToggle', 'notifications', 'windowUi.notifications', 'onlyWhenUnfocused', true);
  bool('notificationsSoundToggle', 'notifications', 'windowUi.notifications', 'sound', true);
  ['replies', 'failures', 'permissions', 'questions', 'reminders'].forEach((category) => {
    bool('notificationsCategory' + category[0].toUpperCase() + category.slice(1) + 'Toggle', 'notifications', 'windowUi.notifications', 'categories.' + category, true);
  });
  bool('notificationsReplyPreviewToggle', 'notifications', 'windowUi.notifications', 'replyPreview', false);

  // Offline, Memories
  bool('offlineLocalOnlyToggle', 'offline', 'offline', 'localOnly', false);
  bool('memoryCaptureSuggestions', 'memories', 'memory', 'captureSuggestions', true);

  // The Limits & budgets page: its groups, rows and the engine or runtime limit each line edits.
  // renderer-settings-advanced-section.js draws it; the search stubs below take their copy from it.
  const LIMITS_PAGE_GROUPS = Object.freeze([
    { id: 'reply', label: jt('settings.limits.group.reply', 'One reply'), rows: [
      { id: 'toolCallsPerReply', label: jt('settings.limits.toolCallsPerReply.label', 'Tool calls per reply'), help: jt('settings.limits.toolCallsPerReply.help', 'File reads, searches and other tool calls Jenny may make while answering one message.'), lines: [{ side: 'local', tuning: 'maxToolsPerTurn' }, { side: 'cloud', tuning: 'cloudMaxToolsPerTurn' }] },
      { id: 'chatRounds', label: jt('settings.limits.chatRounds.label', 'Thinking rounds in a chat'), help: jt('settings.limits.chatRounds.help', 'How many times Jenny may think again after running tools in an ordinary reply.'), lines: [{ side: 'local', tuning: 'maxChatLoopIterations' }, { side: 'cloud', tuning: 'cloudMaxChatLoopIterations' }] },
      { id: 'taskRounds', label: jt('settings.limits.taskRounds.label', 'Thinking rounds in a task'), help: jt('settings.limits.taskRounds.help', 'The same limit for task mode, where longer multi-step work is expected.'), lines: [{ side: 'local', tuning: 'maxTaskLoopIterations' }, { side: 'cloud', tuning: 'cloudMaxTaskLoopIterations' }] },
      { id: 'webCalls', label: jt('settings.limits.webCalls.label', 'Web calls per reply'), help: jt('settings.limits.webCalls.help', 'Web searches or page fetches one reply may use. Failed calls are not counted.'), lines: [{ side: 'local', tuning: 'maxWebToolCallsPerTurn' }, { side: 'cloud', tuning: 'cloudMaxWebToolCallsPerTurn' }] },
      { id: 'codeIntelCalls', label: jt('settings.limits.codeIntelCalls.label', 'Code-intelligence calls per reply'), help: jt('settings.limits.codeIntelCalls.help', 'Code-analysis tool calls one reply may use.'), lines: [{ side: 'both', tuning: 'maxCodeIntelligenceToolCallsPerTurn' }] },
      { id: 'conversationToolCalls', label: jt('settings.limits.conversationToolCalls.label', 'Tool calls per conversation'), help: jt('settings.limits.conversationToolCalls.help', 'A safety cap across a whole chat, so a runaway loop cannot keep going.'), lines: [{ side: 'local', tuning: 'maxToolCallsPerSession' }, { side: 'cloud', tuning: 'cloudMaxToolCallsPerSession' }] },
    ] },
    { id: 'timeouts', label: jt('settings.limits.group.timeouts', 'Timeouts'), rows: [
      { id: 'toolTimeout', label: jt('settings.limits.toolTimeout.label', 'One tool call'), help: jt('settings.limits.toolTimeout.help', 'How long a single tool call may run before it is stopped.'), lines: [{ side: 'local', tuning: 'toolsExecutionTimeoutSeconds' }, { side: 'cloud', tuning: 'cloudToolsExecutionTimeoutSeconds' }] },
      { id: 'replyWorkingTime', label: jt('settings.limits.replyWorkingTime.label', 'One reply, working time'), help: jt('settings.limits.replyWorkingTime.help', 'Time a local reply may spend working. Waiting for your approval does not count.'), lines: [{ side: 'local', tuning: 'maxLoopWallSeconds' }] },
      { id: 'modelLoading', label: jt('settings.limits.modelLoading.label', 'Model loading'), help: jt('settings.limits.modelLoading.help', 'How long to wait for the first words while a local model loads.'), lines: [{ side: 'local', tuning: 'modelLoadGraceSeconds' }] },
      { id: 'ollamaRequest', label: jt('settings.limits.ollamaRequest.label', 'One Ollama request'), help: jt('settings.limits.ollamaRequest.help', 'How long a single request to Ollama may take.'), lines: [{ side: 'local', tuning: 'ollamaRequestTimeoutSeconds' }] },
      { id: 'pythonRun', label: jt('settings.limits.pythonRun.label', 'One Python run'), help: jt('settings.limits.pythonRun.help', 'How long a Python snippet may run.'), lines: [{ side: 'both', tuning: 'toolsPythonRuntimeTimeoutSeconds' }] },
      { id: 'gitCommand', label: jt('settings.limits.gitCommand.label', 'One git command'), help: jt('settings.limits.gitCommand.help', 'How long a git command may run.'), lines: [{ side: 'both', tuning: 'toolsGitTimeoutSeconds' }] },
    ] },
    { id: 'helpers', label: jt('settings.limits.group.helpers', 'Helpers'), rows: [
      { id: 'helpersAtOnce', label: jt('settings.limits.helpersAtOnce.label', 'Helpers at the same time'), help: jt('settings.limits.helpersAtOnce.help', 'Helper tasks one reply may run side by side. On a local model helpers take turns, so the local value only raises how many may be active across chats.'), lines: [{ side: 'local', tuning: 'maxSubAgentConcurrency' }, { side: 'cloud', tuning: 'maxCloudSubAgentConcurrency' }] },
      { id: 'helpersPerRun', label: jt('settings.limits.helpersPerRun.label', 'Helpers per run, in total'), help: jt('settings.limits.helpersPerRun.help', 'How many helper tasks one run may start altogether.'), lines: [{ side: 'local', limit: 'limit_local_descendants' }, { side: 'cloud', limit: 'limit_cloud_descendants' }] },
      { id: 'helperDepth', label: jt('settings.limits.helperDepth.label', 'Levels deep'), help: jt('settings.limits.helperDepth.help', 'How many levels down a helper may start helpers of its own.'), lines: [{ side: 'local', limit: 'limit_local_descendant_depth' }, { side: 'cloud', limit: 'limit_cloud_descendant_depth' }] },
      { id: 'helperRounds', label: jt('settings.limits.helperRounds.label', 'Thinking rounds per helper'), help: jt('settings.limits.helperRounds.help', 'How many times a helper may think again after running tools. The same for local and cloud on purpose: a bigger job should use more helpers, not longer ones.'), lines: [{ side: 'both', tuning: 'maxSubAgentLoopIterations' }] },
    ] },
    { id: 'running', label: jt('settings.limits.group.running', 'Running at once'), rows: [
      { id: 'chatsAtOnce', label: jt('settings.limits.chatsAtOnce.label', 'Chats'), help: jt('settings.limits.chatsAtOnce.help', 'Chats that may be working at the same moment. Others wait their turn.'), lines: [{ side: 'local', limit: 'limit_local_runnable_turns' }, { side: 'cloud', limit: 'limit_cloud_runnable_turns' }] },
      { id: 'modelRequests', label: jt('settings.limits.modelRequests.label', 'Model requests'), help: jt('settings.limits.modelRequests.help', 'Requests sent to the model at the same time.'), lines: [{ side: 'local', limit: 'limit_local_inference_requests' }, { side: 'cloud', limit: 'limit_cloud_inference_requests' }] },
      { id: 'toolOperations', label: jt('settings.limits.toolOperations.label', 'Tool operations'), help: jt('settings.limits.toolOperations.help', 'File, search and web tools running together.'), lines: [{ side: 'both', limit: 'limit_resources_tool_operations' }] },
      { id: 'programs', label: jt('settings.limits.programs.label', 'Programs'), help: jt('settings.limits.programs.help', 'Commands and scripts running together.'), lines: [{ side: 'both', limit: 'limit_resources_native_processes' }] },
    ] },
    { id: 'rare', label: jt('settings.limits.group.rare', 'Rarely needed'), rows: [
      { id: 'warnBeforeSummarizing', label: jt('settings.limits.warnBeforeSummarizing.label', 'Warn before summarizing'), help: jt('settings.limits.warnBeforeSummarizing.help', "When a chat fills this share of the model's context window, Jenny warns that a summary is coming."), lines: [{ side: 'both', tuning: 'tokenBudgetWarningRatio' }] },
      { id: 'inlinePayload', label: jt('settings.limits.inlinePayload.label', 'Largest tool output kept in chat'), help: jt('settings.limits.inlinePayload.help', 'Tool output bigger than this is saved to a file and linked instead of pasted into the chat.'), lines: [{ side: 'both', tuning: 'maxInlinePayloadBytes' }] },
      { id: 'pythonMemory', label: jt('settings.limits.pythonMemory.label', 'Python memory cap'), help: jt('settings.limits.pythonMemory.help', 'Memory one Python run may use.'), lines: [{ side: 'both', tuning: 'toolsPythonRuntimeMaxMemoryMb' }] },
      { id: 'testRuns', label: jt('settings.limits.testRuns.label', 'Tests'), help: jt('settings.limits.testRuns.help', 'Test commands running together.'), lines: [{ side: 'both', limit: 'limit_resources_tests' }] },
    ] },
  ].map((group) => {
    group.rows.forEach((row) => {
      row.lines.forEach(Object.freeze);
      Object.freeze(row.lines);
      Object.freeze(row);
    });
    Object.freeze(group.rows);
    return Object.freeze(group);
  }));
  const LIMIT_ROWS = new Map(LIMITS_PAGE_GROUPS.flatMap((group) => group.rows.map((row) => [row.id, row])));

  // Advanced engine tuning: search-only mirrors of renderer/shared/engine-tuning-schema.js
  // (key, scope, default, unit, min, max, step). tests/renderer-settings-field-descriptors.test.js
  // holds this list to the schema, which stays the bounds authority.
  // Earlier names of these limits: kept only as search keywords, so an old name still finds its row.
  const ENGINE_LABELS = {
    maxToolsPerTurn: jt('engineTuning.maxToolsPerTurn.label', 'Tool calls per turn'),
    maxChatLoopIterations: jt('engineTuning.maxChatLoopIterations.label', 'Reasoning rounds (chat)'),
    maxTaskLoopIterations: jt('engineTuning.maxTaskLoopIterations.label', 'Reasoning rounds (task)'),
    cloudMaxChatLoopIterations: jt('engineTuning.cloudMaxChatLoopIterations.label', 'Reasoning rounds (chat)'),
    cloudMaxTaskLoopIterations: jt('engineTuning.cloudMaxTaskLoopIterations.label', 'Reasoning rounds (task)'),
    cloudMaxToolsPerTurn: jt('engineTuning.cloudMaxToolsPerTurn.label', 'Tool calls per turn'),
    maxSubAgentConcurrency: jt('engineTuning.maxSubAgentConcurrency.label', 'Parallel sub-agents'),
    maxCloudSubAgentConcurrency: jt('engineTuning.maxCloudSubAgentConcurrency.label', 'Parallel sub-agents'),
    maxSubAgentLoopIterations: jt('engineTuning.maxSubAgentLoopIterations.label', 'Sub-agent reasoning rounds'),
    maxToolCallsPerSession: jt('engineTuning.maxToolCallsPerSession.label', 'Tool calls per session'),
    maxWebToolCallsPerTurn: jt('engineTuning.maxWebToolCallsPerTurn.label', 'Web calls per turn'),
    maxCodeIntelligenceToolCallsPerTurn: jt('engineTuning.maxCodeIntelligenceToolCallsPerTurn.label', 'Code-intelligence calls per turn'),
    maxInlinePayloadBytes: jt('engineTuning.maxInlinePayloadBytes.label', 'Inline payload cap'),
    cloudMaxToolCallsPerSession: jt('engineTuning.cloudMaxToolCallsPerSession.label', 'Tool calls per session'),
    cloudMaxWebToolCallsPerTurn: jt('engineTuning.cloudMaxWebToolCallsPerTurn.label', 'Web calls per turn'),
    toolsExecutionTimeoutSeconds: jt('engineTuning.toolsExecutionTimeoutSeconds.label', 'Tool execution timeout'),
    cloudToolsExecutionTimeoutSeconds: jt('engineTuning.cloudToolsExecutionTimeoutSeconds.label', 'Tool execution timeout'),
    maxLoopWallSeconds: jt('engineTuning.maxLoopWallSeconds.label', 'Turn working-time limit'),
    modelLoadGraceSeconds: jt('engineTuning.modelLoadGraceSeconds.label', 'Model load grace'),
    ollamaRequestTimeoutSeconds: jt('engineTuning.ollamaRequestTimeoutSeconds.label', 'Ollama request timeout'),
    toolsPythonRuntimeTimeoutSeconds: jt('engineTuning.toolsPythonRuntimeTimeoutSeconds.label', 'Python tool timeout'),
    toolsPythonRuntimeMaxMemoryMb: jt('engineTuning.toolsPythonRuntimeMaxMemoryMb.label', 'Python tool memory cap'),
    toolsGitTimeoutSeconds: jt('engineTuning.toolsGitTimeoutSeconds.label', 'Git tool timeout'),
    tokenBudgetWarningRatio: jt('engineTuning.tokenBudgetWarningRatio.label', 'Warn at'),
  };
  // [key, scope, default, unit, min, max, step, schema type, presets, row id] — mirrors renderer/shared/engine-tuning-schema.js (held by test).
  const ENGINE_TUNING_STUBS = [
    ['maxToolsPerTurn', 'local', 20, '', 1, 500, 1, 'integer', [[10, '10'], [20, '20'], [40, '40']], 'toolCallsPerReply'],
    ['maxChatLoopIterations', 'local', 8, '', 1, 32, 1, 'integer', [[4, '4'], [8, '8'], [16, '16']], 'chatRounds'],
    ['maxTaskLoopIterations', 'local', 30, '', 1, 250, 1, 'integer', [[10, '10'], [20, '20'], [30, '30']], 'taskRounds'],
    ['cloudMaxChatLoopIterations', 'cloud', 40, '', 1, 1000, 1, 'integer', [[20, '20'], [40, '40'], [100, '100']], 'chatRounds'],
    ['cloudMaxTaskLoopIterations', 'cloud', 300, '', 1, 1000, 1, 'integer', [[100, '100'], [300, '300'], [600, '600']], 'taskRounds'],
    ['cloudMaxToolsPerTurn', 'cloud', 200, '', 1, 500, 1, 'integer', [[100, '100'], [200, '200'], [400, '400']], 'toolCallsPerReply'],
    ['maxSubAgentConcurrency', 'local', 1, '', 1, 8, 1, 'integer', [[1, '1'], [2, '2'], [4, '4']], 'helpersAtOnce'],
    ['maxCloudSubAgentConcurrency', 'cloud', 3, '', 1, 3, 1, 'integer', [[1, '1'], [2, '2'], [3, '3']], 'helpersAtOnce'],
    ['maxSubAgentLoopIterations', 'shared', 10, '', 1, 32, 1, 'integer', [[5, '5'], [10, '10'], [20, '20']], 'helperRounds'],
    ['maxToolCallsPerSession', 'local', 2000, '', 1, 2000, 10, 'integer', [[500, '500'], [1000, '1000'], [2000, '2000']], 'conversationToolCalls'],
    ['maxWebToolCallsPerTurn', 'local', 10, '', 1, 100, 1, 'integer', [[5, '5'], [10, '10'], [25, '25']], 'webCalls'],
    ['maxCodeIntelligenceToolCallsPerTurn', 'shared', 16, '', 1, 100, 1, 'integer', [[8, '8'], [16, '16'], [32, '32']], 'codeIntelCalls'],
    ['maxInlinePayloadBytes', 'shared', 65536, UNIT.kb, 4096, 2097152, 4096, 'integer', [[16384, '16 ' + UNIT.kb], [65536, '64 ' + UNIT.kb], [262144, '256 ' + UNIT.kb]], 'inlinePayload'],
    ['cloudMaxToolCallsPerSession', 'cloud', 2000, '', 1, 2000, 50, 'integer', [[500, '500'], [1000, '1000'], [2000, '2000']], 'conversationToolCalls'],
    ['cloudMaxWebToolCallsPerTurn', 'cloud', 30, '', 1, 100, 1, 'integer', [[10, '10'], [30, '30'], [60, '60']], 'webCalls'],
    ['toolsExecutionTimeoutSeconds', 'local', 120, UNIT.sec, 5, 600, 5, 'number', [[60, '60'], [120, '120'], [300, '300']], 'toolTimeout'],
    ['cloudToolsExecutionTimeoutSeconds', 'cloud', 1800, UNIT.sec, 5, 3600, 30, 'number', [[600, '600'], [1800, '1800'], [3600, '3600']], 'toolTimeout'],
    ['maxLoopWallSeconds', 'local', 3600, UNIT.min, 30, 7200, 30, 'number', [[1800, '30'], [3600, '60'], [7200, '120']], 'replyWorkingTime'],
    ['modelLoadGraceSeconds', 'local', 300, UNIT.sec, 60, 1800, 30, 'number', [[120, '120'], [300, '300'], [600, '600']], 'modelLoading'],
    ['ollamaRequestTimeoutSeconds', 'local', 300, UNIT.sec, 30, 3600, 30, 'integer', [[120, '120'], [300, '300'], [900, '900']], 'ollamaRequest'],
    ['toolsPythonRuntimeTimeoutSeconds', 'shared', 30, UNIT.sec, 1, 600, 5, 'integer', [[15, '15'], [30, '30'], [120, '120']], 'pythonRun'],
    ['toolsPythonRuntimeMaxMemoryMb', 'shared', 512, UNIT.mb, 64, 4096, 64, 'integer', [[256, '256'], [512, '512'], [1024, '1024']], 'pythonMemory'],
    ['toolsGitTimeoutSeconds', 'shared', 20, UNIT.sec, 1, 120, 1, 'number', [[10, '10'], [20, '20'], [60, '60']], 'gitCommand'],
    ['tokenBudgetWarningRatio', 'shared', null, '%', 0.1, 0.99, 0.01, 'number', [[0.6, '60%'], [0.75, '75%'], [0.85, '85%']], 'warnBeforeSummarizing'],
  ];
  ENGINE_TUNING_STUBS.forEach(([key, scope, dflt, unit, min, max, step, type, presets, rowId]) => {
    const { label, help } = LIMIT_ROWS.get(rowId);
    const side = scope === 'cloud' ? jt('settings.limits.side.cloud', 'Cloud') : jt('settings.limits.side.local', 'Local');
    def({ id: 'advancedTuningField-' + key, sectionId: 'advanced', kind: type === 'number' ? 'decimal' : 'integer', default: dflt, adapterId: 'engineTuning', key, searchOnly: true,
      defaultLabel: dflt === null ? jt('settings.field.defaultAuto', 'Auto') : '',
      validation: { min, max, step, allowEmpty: dflt === null },
      presentation: { unit, scale: key === 'maxLoopWallSeconds' ? 60 : key === 'tokenBudgetWarningRatio' ? 0.01 : key === 'maxInlinePayloadBytes' ? 1024 : 1,
        offLabel: dflt === null ? jt('settings.field.defaultAuto', 'Auto') : '', presets: presets.map(([value, label]) => ({ value, label })) },
      copy: { label: scope === 'shared' ? label : label + ', ' + side, description: help, keywords: [ENGINE_LABELS[key], scope === 'shared' ? '' : scope].filter(Boolean) } });
  });

  // Runtime limits: search-only mirrors of renderer/shell/renderer-runtime-limits-view.js (defaults come from the runtime).
  const RUNTIME_LIMIT_STUBS = [
    ['local', 'runnable_turns', 'chatsAtOnce'],
    ['cloud', 'runnable_turns', 'chatsAtOnce'],
    ['local', 'inference_requests', 'modelRequests'],
    ['cloud', 'inference_requests', 'modelRequests'],
    ['local', 'descendants', 'helpersPerRun'],
    ['cloud', 'descendants', 'helpersPerRun'],
    ['local', 'descendant_depth', 'helperDepth'],
    ['cloud', 'descendant_depth', 'helperDepth'],
    ['resources', 'tool_operations', 'toolOperations'],
    ['resources', 'native_processes', 'programs'],
    ['resources', 'tests', 'testRuns'],
  ];
  RUNTIME_LIMIT_STUBS.forEach(([group, key, rowId]) => {
    const { label, help } = LIMIT_ROWS.get(rowId);
    const side = group === 'cloud' ? jt('settings.limits.side.cloud', 'Cloud') : jt('settings.limits.side.local', 'Local');
    def({ id: 'runtime_limit_' + group + '_' + key, sectionId: 'advanced', kind: 'integer', defaultSource: 'adapter', adapterId: 'runtimeLimits', key: group + '.' + key, searchOnly: true,
      validation: { step: 1 },
      copy: { label: group === 'resources' ? label : label + ', ' + side, description: help, keywords: [group, jt('runtime.limits.title', 'Runtime limits')] } });
  });

  return {
    KINDS,
    CONTROLS,
    SEGMENTED_MAX_OPTIONS,
    LIMITS_PAGE_GROUPS,
    defineSettingDescriptor,
    getSettingDescriptor,
    getSettingDescriptorByControlId,
    listSettingDescriptors,
    listDescriptorCopyEntries,
    resolveControlKind,
    registerOptionSource,
    resolveSettingOptions,
    normalizeSettingValue,
    validateSettingValue,
    isSettingModified,
    describeSettingDefaultValue,
  };
});
