/* renderer/shell/renderer-settings-editor-section.js
 *
 * The Settings "Editor" section: live, persisted Monaco editor preferences for
 * the Workspace IDE. Controls are built from inventory primitives and injected
 * into a stable container (the Tools-section precedent), so no raw select or
 * input markup is added outside renderer/inventory. Changes mutate the shared
 * state.ui.ide slice and persist a PARTIAL patch through the existing
 * workspaceIde.updateSettings IPC (the main process merges, so open tabs / rail
 * layout are never clobbered). A change reaches the shared slice only after the
 * main process acknowledges it, so failed writes cannot strand runtime/UI state.
 * No new IPC. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsEditorSection = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Fallback defaults for the fields that need one when the slice is absent.
  // The toggles (wordWrap/minimap/lineNumbers) derive their default inline, so
  // only these three are read; fontSize/tabSize bounds live in renderer-ide-state.
  const DEFAULTS = {
    fontSize: 13,
    tabSize: 2,
    renderWhitespace: 'selection',
  };
  // Section-specific UI option list (not a config concept; the config only
  // bounds fontSize via min/max, which clampFontSize() reuses).
  const FONT_SIZES = [10, 11, 12, 13, 14, 16, 18, 20];
  // Recommended inline-completion model (fill-in-the-middle; use the -base
  // variant — instruct variants don't FIM). Shown in the section status text.
  const RECOMMENDED_INLINE_MODEL = 'qwen2.5-coder:1.5b-base';
  // The editor-pref subset the section owns; sent as a partial patch on change.
  const PATCH_KEYS = [
    'fontSize', 'tabSize', 'wordWrap', 'minimap', 'lineNumbers', 'renderWhitespace', 'rulers',
    'formatOnSave', 'trimTrailingWhitespace', 'insertFinalNewline',
    'autoSaveEnabled',
    'inlineSuggestEnabled', 'inlineSuggestModel',
  ];
  // Column-ruler presets. The slice stores an int array; the select round-trips
  // it through a comma-joined string value so a stored [80,120] selects "80,120".
  const RULER_OPTIONS = [
    { value: '', label: 'Off' },
    { value: '80', label: '80 columns' },
    { value: '100', label: '100 columns' },
    { value: '120', label: '120 columns' },
    { value: '80,120', label: '80 and 120' },
  ];
  // Editor prefs whose value is a plain boolean written straight to the slice
  // (no enum/string coercion, no keyed side effect) — collapsed into one apply
  // arm so a new on/off toggle needs only its TOGGLE_PREFS entry, not a bespoke
  // branch. inlineSuggestEnabled is deliberately NOT here: it has a keyed
  // warm/clear side effect below and keeps its own explicit arm.
  const PURE_BOOL_PREFS = new Set([
    'minimap', 'formatOnSave', 'trimTrailingWhitespace', 'insertFinalNewline',
    'autoSaveEnabled',
  ]);
  // Toggle control id -> slice key (toggle-switch has no dataset hook).
  const TOGGLE_PREFS = {
    editorWordWrapToggle: 'wordWrap',
    editorMinimapToggle: 'minimap',
    editorLineNumbersToggle: 'lineNumbers',
    editorFormatOnSaveToggle: 'formatOnSave',
    editorTrimTrailingWhitespaceToggle: 'trimTrailingWhitespace',
    editorInsertFinalNewlineToggle: 'insertFinalNewline',
    editorAutoSaveToggle: 'autoSaveEnabled',
    editorInlineSuggestToggle: 'inlineSuggestEnabled',
  };
  // Installed Ollama models, fetched once by bindEditorSection and cached so
  // renderEditorSection can populate the completion-model picker. Each entry is
  // { id, fim } where fim === true marks a fill-in-the-middle (insert-capable)
  // model. Empty until the fetch resolves (the picker then re-renders).
  let installedModels = [];
  // Transient feedback for the completion-model load: set when the user selects a
  // model (bindEditorSection warms it through inline.complete), read by
  // renderEditorSection into the section status line so the selection is
  // confirmed. Null = show the default recommendation text. Mirrors the
  // installedModels module-cache pattern (one settings section per app).
  let inlineModelStatus = null;
  let catalogInvalidator = null;

  function ideStateRef() {
    return (typeof globalThis !== 'undefined' && globalThis.rendererIdeState) || null;
  }

  // Reuse the canonical model-tag sanitizer from renderer-ide-state (the same
  // whitelist the schema enforces) rather than keep a third private copy of the
  // regex; fail closed to '' if that module somehow isn't loaded.
  function sanitizeModelTag(value) {
    const ideState = ideStateRef();
    return typeof ideState?.sanitizeInlineSuggestModel === 'function'
      ? ideState.sanitizeInlineSuggestModel(value)
      : '';
  }

  // The tab-size enum, render-whitespace whitelist, and fontSize bounds are
  // owned by renderer-ide-state.js (the renderer-canonical source, mirrored from
  // shell-config-state.js). Reuse them so the section can never drift from the
  // persisted-slice validation; the literal fallbacks only matter if that module
  // somehow isn't loaded (never in the real app).
  function tabSizes() {
    const ref = ideStateRef();
    return Array.isArray(ref && ref.TAB_SIZES) ? ref.TAB_SIZES : [2, 4, 8];
  }
  function whitespaceValues() {
    const ref = ideStateRef();
    return Array.isArray(ref && ref.RENDER_WHITESPACE)
      ? ref.RENDER_WHITESPACE
      : ['none', 'boundary', 'selection', 'trailing', 'all'];
  }
  function clampFontSize(value) {
    const ref = ideStateRef();
    const min = Number(ref && ref.FONT_SIZE_MIN) > 0 ? Number(ref.FONT_SIZE_MIN) : 8;
    const max = Number(ref && ref.FONT_SIZE_MAX) > 0 ? Number(ref.FONT_SIZE_MAX) : 40;
    const next = Math.trunc(Number(value));
    return Number.isFinite(next) && next > 0 ? Math.min(max, Math.max(min, next)) : DEFAULTS.fontSize;
  }

  // Column rulers round-trip between the slice (int array) and the select value
  // (comma-joined string). stringToRulers reuses the canonical renderer-ide-state
  // normalizer so the bounds/sort/dedupe can never drift from the persisted slice.
  function rulersToString(value) {
    return Array.isArray(value) ? value.join(',') : '';
  }
  function stringToRulers(value) {
    const ref = ideStateRef();
    const nums = String(value || '')
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (typeof ref?.normalizeRulers === 'function') {
      return ref.normalizeRulers(nums);
    }
    // No state ref (isolated context): mirror normalizeRulers' bounds (column
    // <= 500, at most 8) so this last-resort path can't drift from the canonical
    // sanitizer the comment above promises.
    return [...new Set(nums.map((n) => Math.trunc(n)).filter((n) => n > 0 && n <= 500))]
      .sort((a, b) => a - b)
      .slice(0, 8);
  }

  // The renderer/inventory barrel (globalThis.inventory) exposes both primitives
  // as render FUNCTIONS, so the barrel path needs no unwrapping. Fall back to the
  // standalone UMD globals when the barrel isn't loaded — note the asymmetry
  // there: select-field's global IS the function, while toggle-switch's global is
  // a { toggleSwitch, ... } module, so only that one is unwrapped.
  function selectFieldFn() {
    if (typeof globalThis === 'undefined') { return null; }
    const inv = globalThis.inventory;
    const fn = (inv && inv.selectField) || globalThis.inventorySelectField;
    return typeof fn === 'function' ? fn : null;
  }

  function toggleSwitchFn() {
    if (typeof globalThis === 'undefined') { return null; }
    const inv = globalThis.inventory;
    const standalone = globalThis.inventoryToggleSwitch;
    const fn = (inv && inv.toggleSwitch) || (standalone && standalone.toggleSwitch);
    return typeof fn === 'function' ? fn : null;
  }

  // Inventory action-button used for the canonical Model Library route.
  function actionButtonFn() {
    if (typeof globalThis === 'undefined') { return null; }
    const inv = globalThis.inventory;
    const fn = (inv && inv.actionButton) || globalThis.inventoryActionButton;
    return typeof fn === 'function' ? fn : null;
  }

  function titleCase(value) {
    const str = String(value || '');
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  // Reads the live prefs off the slice with safe fallbacks (the slice may be
  // null/partial before the IDE is ever opened).
  function readPrefs(ide) {
    const source = ide && typeof ide === 'object' ? ide : {};
    return {
      fontSize: clampFontSize(source.fontSize),
      tabSize: tabSizes().includes(Number(source.tabSize)) ? Number(source.tabSize) : DEFAULTS.tabSize,
      wordWrap: source.wordWrap === 'on' ? 'on' : 'off',
      minimap: source.minimap === false ? false : true,
      lineNumbers: source.lineNumbers === 'off' ? 'off' : 'on',
      renderWhitespace: whitespaceValues().includes(source.renderWhitespace)
        ? source.renderWhitespace
        : DEFAULTS.renderWhitespace,
      rulers: Array.isArray(source.rulers) ? source.rulers : [],
      // Save-time hygiene: all DEFAULT-OFF (only a literal true enables).
      formatOnSave: source.formatOnSave === true,
      trimTrailingWhitespace: source.trimTrailingWhitespace === true,
      insertFinalNewline: source.insertFinalNewline === true,
      // Auto-save is DEFAULT-OFF (it writes files): only a literal true enables.
      autoSaveEnabled: source.autoSaveEnabled === true,
      inlineSuggestEnabled: source.inlineSuggestEnabled === false ? false : true,
      inlineSuggestModel: sanitizeModelTag(source.inlineSuggestModel),
    };
  }

  // Completion-model picker is deliberately role-filtered: only installed
  // models whose catalog advertises the FIM/insert capability are selectable.
  function inlineModelOptions() {
    const fim = installedModels.filter((m) => m && m.fim).map((m) => m.id);
    const options = [{ value: '', label: 'Off (no model)' }];
    fim.forEach((tag) => options.push({ value: tag, label: tag }));
    return options;
  }

  function fontSizeOptions(current) {
    const sizes = FONT_SIZES.includes(current) ? FONT_SIZES.slice() : [...FONT_SIZES, current].sort((a, b) => a - b);
    return sizes.map((n) => ({ value: String(n), label: `${n}px` }));
  }

  // Builds the controls' markup from inventory primitives and injects it into
  // the stable container. Safe to call repeatedly (re-render on every change).
  function renderEditorSection({ container, badge, status, ide, inlineSuggestVisible, autoSaveVisible } = {}) {
    if (!container) { return; }
    const selectField = selectFieldFn();
    const toggleSwitch = toggleSwitchFn();
    if (typeof selectField !== 'function' || typeof toggleSwitch !== 'function') {
      return; // inventory not loaded (defensive; both load before app.js)
    }
    const prefs = readPrefs(ide);
    const primary = [
      selectField({
        id: 'editorFontSizeSelect',
        label: 'Font size',
        value: String(prefs.fontSize),
        options: fontSizeOptions(prefs.fontSize),
        ariaLabel: 'Editor font size',
        dataset: { 'editor-pref': 'fontSize' },
      }),
      selectField({
        id: 'editorTabSizeSelect',
        label: 'Default tab size',
        value: String(prefs.tabSize),
        options: tabSizes().map((n) => ({ value: String(n), label: `${n} spaces` })),
        ariaLabel: 'Editor tab size',
        dataset: { 'editor-pref': 'tabSize' },
      }),
      toggleSwitch({ id: 'editorWordWrapToggle', label: 'Word wrap', checked: prefs.wordWrap === 'on' }),
      toggleSwitch({ id: 'editorMinimapToggle', label: 'Minimap', checked: prefs.minimap !== false }),
      toggleSwitch({ id: 'editorLineNumbersToggle', label: 'Line numbers', checked: prefs.lineNumbers !== 'off' }),
      toggleSwitch({
        id: 'editorAutoSaveToggle',
        label: 'Auto-save files',
        checked: prefs.autoSaveEnabled === true,
      }),
    ];
    const advanced = [
      selectField({
        id: 'editorRenderWhitespaceSelect',
        label: 'Render whitespace',
        value: prefs.renderWhitespace,
        options: whitespaceValues().map((v) => ({ value: v, label: titleCase(v) })),
        ariaLabel: 'Render whitespace',
        dataset: { 'editor-pref': 'renderWhitespace' },
      }),
      selectField({
        id: 'editorRulersSelect',
        label: 'Column rulers',
        value: rulersToString(prefs.rulers),
        options: RULER_OPTIONS,
        ariaLabel: 'Editor column rulers',
        dataset: { 'editor-pref': 'rulers' },
      }),
      // Save-time hygiene (all default-off; applied on Ctrl+S and auto-save).
      toggleSwitch({ id: 'editorFormatOnSaveToggle', label: 'Format on save', checked: prefs.formatOnSave === true }),
      toggleSwitch({ id: 'editorTrimTrailingWhitespaceToggle', label: 'Trim trailing whitespace on save', checked: prefs.trimTrailingWhitespace === true }),
      toggleSwitch({ id: 'editorInsertFinalNewlineToggle', label: 'Insert final newline on save', checked: prefs.insertFinalNewline === true }),
    ];
    const parts = primary.concat([
      '<details class="settings-group settings-group--wide settings-editor-advanced">'
        + '<summary>Advanced</summary><div class="settings-editor-advanced-fields">'
        + advanced.join('') + '</div></details>',
    ]);
    // Inline-autocomplete controls only when the feature is enabled (the same
    // default-on workspace_inline_suggest flag that gates the provider + the
    // status-bar toggle). Model options remain limited to FIM/insert-capable tags;
    // install/load lifecycle stays owned by Model Library.
    if (inlineSuggestVisible === true) {
      const actionButton = actionButtonFn();
      const fimTags = new Set(installedModels.filter((m) => m?.fim === true).map((m) => m.id));
      const currentAvailable = !prefs.inlineSuggestModel || fimTags.has(prefs.inlineSuggestModel);
      parts.push(
        toggleSwitch({ id: 'editorInlineSuggestToggle', label: 'Inline suggestions', checked: prefs.inlineSuggestEnabled !== false }),
        selectField({
          id: 'editorInlineSuggestModelSelect',
          label: 'Completion model',
          value: currentAvailable ? prefs.inlineSuggestModel : '',
          options: inlineModelOptions(),
          ariaLabel: 'Inline completion model',
          dataset: { 'editor-pref': 'inlineSuggestModel' },
        }),
        typeof actionButton === 'function'
          ? actionButton({
            id: 'openEditorModelLibrary',
            label: currentAvailable ? 'Open Model Library' : 'Install or choose a completion model',
            variant: 'secondary',
            size: 'sm',
            ariaLabel: 'Open Model Library',
            title: 'Manage model installation and lifecycle in Model Library',
          })
          : ''
      );
    }
    container.innerHTML = parts.join('');
    if (badge) { badge.textContent = 'Workspace'; }
    if (status) {
      const autoSaveNote = autoSaveVisible === true
        ? ' Auto-save writes the active file about a second after you stop typing; a file changed on disk is never silently overwritten.'
        : '';
      const base = `Editor preferences apply to the Workspace IDE and persist across restarts.${autoSaveNote}`;
      if (inlineSuggestVisible !== true) {
        status.textContent = base;
      } else if (inlineModelStatus && inlineModelStatus.message) {
        // Live load feedback wins over the static recommendation so selecting a
        // model is visibly confirmed (loading → ready / still warming).
        status.textContent = `${base} ${inlineModelStatus.message}`;
      } else {
        const unavailable = prefs.inlineSuggestModel
          && !installedModels.some((m) => m?.fim === true && m.id === prefs.inlineSuggestModel)
          ? ` The saved completion model "${prefs.inlineSuggestModel}" is unavailable or not insert-capable; choose one in Model Library.`
          : '';
        status.textContent = `${base} Completion models are limited to installed fill-in-the-middle/insert-capable models; compute placement is automatic.${unavailable} Recommended: ${RECOMMENDED_INLINE_MODEL} (use the -base variant).`;
      }
    }
  }

  // Ensures state.ui.ide exists without clobbering an IDE-populated slice.
  function ensureIdeSlice(state) {
    if (!state.ui || typeof state.ui !== 'object') { state.ui = {}; }
    if (!state.ui.ide || typeof state.ui.ide !== 'object') {
      const ideStateUtils = (typeof globalThis !== 'undefined' && globalThis.rendererIdeState) || null;
      state.ui.ide = ideStateUtils?.createIdeUiState?.() || {};
    }
    return state.ui.ide;
  }

  // Copies ONLY the editor-pref keys off a persisted slice (getState result is
  // already normalized by the main process) - never touches openTabs/rail.
  function seedEditorPrefs(ide, persisted) {
    if (!persisted || typeof persisted !== 'object') { return; }
    for (const key of [...PATCH_KEYS, 'eol']) {
      if (key in persisted) { ide[key] = persisted[key]; }
    }
  }

  // Wires delegated handlers exactly once. Preference projection happens only
  // after the main process acknowledges the narrow patch.
  function bindEditorSection({ container, state, renderSettings, registerListener, listenerOptions, showShellErrorToast, openSettingsSection, appendClientLog } = {}) {
    if (!container || !state || typeof registerListener !== 'function') { return; }
    const rerender = typeof renderSettings === 'function' ? renderSettings : function noop() {};
    // Guards the lazy hydration below from clobbering a change the user makes
    // while the async getState() is still in flight (lost-update race).
    let userTouched = false;

    const showError = typeof showShellErrorToast === 'function' ? showShellErrorToast : function noop() {};
    const log = typeof appendClientLog === 'function' ? appendClientLog : function noop() {};
    const openSection = typeof openSettingsSection === 'function' ? openSettingsSection : function noop() {};
    const signal = listenerOptions?.signal;
    let preferenceWriteQueue = Promise.resolve();

    function persist(pref, value) {
      const operation = preferenceWriteQueue.catch(function ignore() {}).then(async () => {
        const api = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.workspaceIde) || null;
        if (!api || typeof api.updateSettings !== 'function') {
          const error = new Error('Workspace IDE settings bridge is unavailable.');
          error.code = 'workspace_ide_settings_unavailable';
          throw error;
        }
        const result = await api.updateSettings({ [pref]: value });
        if (!result || result.updated !== true) {
          const error = new Error('Workspace IDE setting update was refused.');
          error.code = String(result?.code || 'workspace_ide_settings_refused');
          throw error;
        }
        return Object.prototype.hasOwnProperty.call(result, pref) ? result[pref] : value;
      });
      preferenceWriteQueue = operation;
      return operation;
    }

    // Monotonic guard so a stale warm round (slow cold load) can't overwrite the
    // status after the user picks a different model.
    let warmToken = 0;

    function setInlineModelStatus(message) {
      inlineModelStatus = message ? { message } : null;
      rerender();
    }

    function describeWarmResult(tag, result) {
      if (result && result.ok === true) {
        return `Completion model "${tag}" is loaded and ready.`;
      }
      const reason = String((result && result.reason) || '');
      // Inline completion uses its own FIM model; current transient warm failures
      // are chat_stream_active and sidecar_*.
      if (reason === 'chat_stream_active') {
        return `"${tag}" will load once the current chat reply finishes.`;
      }
      if (reason === 'sidecar_unavailable' || reason === 'sidecar_not_ready') {
        return `Backend isn't ready yet — "${tag}" will load when you start typing in a file.`;
      }
      // generate_failed / timeout / unknown: the request already kicked the
      // (cold) load on the daemon, so report progress rather than failure.
      return `"${tag}" selected — the first completion may take a few seconds while the model loads. Start typing in a file to use it.`;
    }

    // Warm the freshly-selected completion model so the first real keystroke
    // isn't a cold load, and surface the outcome as confirmation (the feature
    // otherwise gives no signal that a selection took effect). Reuses the
    // inline.complete IPC with a 1-token probe; a cold model can exceed the
    // short per-request cap, so a single retry (after the first kicked the load)
    // upgrades the message to "ready" once the daemon finishes loading.
    async function warmCompletionModel(modelTag) {
      if (signal?.aborted) return;
      const tag = sanitizeModelTag(modelTag);
      if (!tag) { if (!signal?.aborted) setInlineModelStatus(''); return; }
      const api = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.inline) || null;
      if (!api || typeof api.complete !== 'function') {
        if (!signal?.aborted) {
          setInlineModelStatus(`Selected "${tag}". Open the Workspace IDE and start typing in a file to use it.`);
        }
        return;
      }
      const myToken = warmToken + 1;
      warmToken = myToken;
      if (signal?.aborted) return;
      setInlineModelStatus(`Loading completion model "${tag}"…`);
      const probe = () => Promise.resolve(
        api.complete({ prefix: '\n', suffix: '', model: tag, maxTokens: 1 })
      ).catch(function ignore() { return null; });
      let result = await probe();
      if (signal?.aborted || myToken !== warmToken) { return; } // superseded by a newer pick
      if (!(result && result.ok === true)) {
        // The first probe kicks the (cold) model load on the daemon; a second
        // probe usually lands once that finishes — two short windows give a cold
        // load room to complete before we report the outcome.
        result = await probe();
        if (signal?.aborted || myToken !== warmToken) { return; }
      }
      if (signal?.aborted) return;
      setInlineModelStatus(describeWarmResult(tag, result));
    }

    function normalizedEditorPref(pref, value) {
      if (pref === 'fontSize') return clampFontSize(value);
      if (pref === 'tabSize') return tabSizes().includes(Number(value)) ? Number(value) : undefined;
      if (pref === 'renderWhitespace') return whitespaceValues().includes(String(value)) ? String(value) : undefined;
      if (pref === 'rulers') return stringToRulers(value);
      if (pref === 'wordWrap') return value ? 'on' : 'off';
      if (pref === 'lineNumbers') return value ? 'on' : 'off';
      if (PURE_BOOL_PREFS.has(pref) || pref === 'inlineSuggestEnabled') return Boolean(value);
      if (pref === 'inlineSuggestModel') return sanitizeModelTag(value);
      return undefined;
    }

    async function applyEditorPref(pref, value) {
      const ide = ensureIdeSlice(state);
      userTouched = true;
      const next = normalizedEditorPref(pref, value);
      if (next === undefined) return;
      try {
        const normalized = await persist(pref, next);
        if (signal?.aborted) return;
        ide[pref] = normalized;
      } catch (error) {
        if (signal?.aborted) return;
        showError('That editor preference could not be saved. Your previous setting is still active.', {
          title: 'Editor Setting Not Saved',
          dedupeKey: `settings:editor:${pref}`,
        });
        log('WARN', 'settings.editor_preference_failed', {
          preference: pref,
          code: String(error?.code || 'workspace_ide_settings_failed').slice(0, 80),
        });
        rerender();
        return;
      }
      rerender();
      // Warm + confirm the completion model at the moment of selection (or when
      // inline suggestions are re-enabled with a model already chosen) so the
      // pick gives visible feedback and the first keystroke isn't a cold load.
      if (pref === 'inlineSuggestModel') {
        warmCompletionModel(ide.inlineSuggestModel);
      } else if (pref === 'inlineSuggestEnabled') {
        if (ide.inlineSuggestEnabled === false) {
          setInlineModelStatus('');
        } else if (String(ide.inlineSuggestModel || '').trim()) {
          warmCompletionModel(ide.inlineSuggestModel);
        }
      }
    }

    // Selects emit native 'change'; toggles emit a bubbling 'inv-toggle-change'.
    registerListener(container, 'change', (event) => {
      const select = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-editor-pref]')
        : null;
      if (!select) { return; }
      applyEditorPref(select.getAttribute('data-editor-pref'), select.value);
    }, listenerOptions);
    registerListener(container, 'inv-toggle-change', (event) => {
      const id = event.detail && event.detail.id;
      const pref = TOGGLE_PREFS[id];
      if (pref) { void applyEditorPref(pref, Boolean(event.detail.checked)); }
    }, listenerOptions);

    // Lazy hydration: if the IDE has never run (no editor prefs on the slice),
    // pull the persisted values once so the controls show the real state.
    let hydrated = false;
    function hydrateFromPersisted() {
      if (hydrated) { return; }
      hydrated = true;
      const existing = state.ui && state.ui.ide;
      const needs = !existing || existing.fontSize === undefined;
      const ide = ensureIdeSlice(state);
      const api = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.workspaceIde) || null;
      if (!needs || !api || typeof api.getState !== 'function') { return; }
      Promise.resolve(api.getState()).then((persisted) => {
        // A change made during the fetch wins; persisted is now stale for it.
        if (userTouched) { return; }
        seedEditorPrefs(ide, persisted);
        rerender();
      }).catch(function ignore() {});
    }
    hydrateFromPersisted();

    // Fetch the RAW installed Ollama tags to populate the completion-model
    // picker. A FIM completion model is always a separate Ollama pull, unrelated
    // to whichever engine serves chat, so this must source models.listOllamaTags
    // (engine-scoped to ollama) rather than models.list (scoped to the CHAT
    // engine — a freshly-pulled FIM tag is invisible there when the chat engine
    // isn't ollama). Cached after the
    // first non-forced run; a forced run (the Refresh button) re-scans so a model
    // pulled after the picker populated appears without an app restart. Only runs
    // when the inline-suggest feature is on, to skip an otherwise-unused IPC.
    let catalogToken = 0;
    function fetchInstalledModels({ force = false } = {}) {
      if (signal?.aborted) { return; }
      if (!force && installedModels.length > 0) { return; }
      if (state.features?.featureFlags?.workspace_inline_suggest !== true) { return; }
      const api = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.models) || null;
      if (!api || typeof api.listOllamaTags !== 'function') { return; }
      const request = api.listOllamaTags();
      const token = ++catalogToken;
      Promise.resolve(request).then((payload) => {
        if (signal?.aborted || token !== catalogToken) return;
        const data = Array.isArray(payload && payload.data) ? payload.data : [];
        const seen = new Set();
        const models = [];
        data.forEach((m) => {
          const id = sanitizeModelTag(m && (m.id || m.name || m.model));
          if (!id || seen.has(id)) { return; }
          seen.add(id);
          // FIM-capable === the Ollama "insert" capability surfaced by the
          // catalog (see sidecar catalog.py _entry_supports_fim).
          models.push({ id, fim: Boolean(m && m.capabilities && m.capabilities.insert === true) });
        });
        installedModels = models;
        rerender();
      }).catch((error) => {
        if (signal?.aborted || token !== catalogToken) return;
        log('INFO', 'settings.inline_model_catalog_failed', {
          code: String(error?.code || 'model_catalog_unavailable').slice(0, 80),
        });
      });
    }
    fetchInstalledModels();
    catalogInvalidator = () => {
      installedModels = [];
      fetchInstalledModels({ force: true });
    };
    registerListener(container, 'click', (event) => {
      const target = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('[data-action="openEditorModelLibrary"]')
        : null;
      if (!target) { return; }
      openSection('models', { source: 'editor_completion_model' });
    }, listenerOptions);
  }

  function invalidateInlineModelCatalog() {
    installedModels = [];
    if (typeof catalogInvalidator === 'function') catalogInvalidator();
  }

  // Public surface: the two wired entry points + the two helpers covered by
  // unit tests. The rest stay module-private (no consumer binds to them).
  return {
    bindEditorSection,
    clampFontSize,
    invalidateInlineModelCatalog,
    renderEditorSection,
  };
});
