/* renderer/shell/renderer-settings-editor-section.js
 *
 * The Settings "Editor" section: live, persisted Monaco editor preferences for
 * the Workspace IDE. Every row renders from its descriptor
 * (renderer-settings-field-descriptors.js) through the shared field binding,
 * and every write goes through one workspaceIde adapter on the settings
 * coordinator: a PARTIAL patch to the existing workspaceIde.updateSettings IPC
 * (the main process merges, so open tabs / rail layout are never clobbered),
 * projected into state.ui.ide only after the main process acknowledges it, so
 * failed writes cannot strand runtime/UI state. No new IPC. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsEditorSection = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  // Section-specific UI option list (not a config concept; the config only
  // bounds fontSize via min/max, which clampFontSize() reuses).
  // 0 = "Match text size"; 13 is omitted because it reads as Match (the
  // pre-rebase default) - renderer-ide-state.normalizeEditorFontSize.
  const FONT_SIZES = [0, 10, 11, 12, 14, 16, 18, 20];
  // Column-ruler presets. The slice stores an int array; the select round-trips
  // it through a comma-joined string value so a stored [80,120] selects "80,120".
  const RULER_OPTIONS = [
    { value: '', label: jt('common.off', 'Off') },
    { value: '80', label: jt('settings.editor.rulers80', '80 columns') },
    { value: '100', label: jt('settings.editor.rulers100', '100 columns') },
    { value: '120', label: jt('settings.editor.rulers120', '120 columns') },
    { value: '80,120', label: jt('settings.editor.rulers80And120', '80 and 120') },
  ];

  function ideStateRef() {
    return (typeof globalThis !== 'undefined' && globalThis.rendererIdeState) || null;
  }

  function fieldModules() {
    const load = (path) => (typeof require === 'function' ? require(path) : null);
    return {
      descriptors: globalThis.rendererSettingsFieldDescriptors || load('./renderer-settings-field-descriptors'),
      binding: globalThis.rendererSettingsFieldBinding || load('./renderer-settings-field-binding'),
    };
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
    if (typeof ref?.normalizeEditorFontSize === 'function') return ref.normalizeEditorFontSize(value);
    const min = Number(ref && ref.FONT_SIZE_MIN) > 0 ? Number(ref.FONT_SIZE_MIN) : 8;
    const max = Number(ref && ref.FONT_SIZE_MAX) > 0 ? Number(ref.FONT_SIZE_MAX) : 40;
    const next = Math.trunc(Number(value));
    return Number.isFinite(next) && next > 0 && next !== 13 ? Math.min(max, Math.max(min, next)) : 0;
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

  function titleCase(value) {
    const str = String(value || '');
    return str ? str.charAt(0).toUpperCase() + str.slice(1) : str;
  }

  // The slice <-> the form object the rows edit (descriptor keys, control
  // values). This pair is the one place the persisted shapes are mapped: the
  // slice may be null/partial before the IDE is ever opened.
  function readForm(ide) {
    const source = ide && typeof ide === 'object' ? ide : {};
    return {
      fontSize: clampFontSize(source.fontSize),
      tabSize: tabSizes().includes(Number(source.tabSize)) ? Number(source.tabSize) : 2,
      renderWhitespace: whitespaceValues().includes(source.renderWhitespace) ? source.renderWhitespace : 'selection',
      rulers: rulersToString(source.rulers),
      wordWrap: source.wordWrap === 'on',
      minimap: source.minimap !== false,
      lineNumbers: source.lineNumbers !== 'off',
      // Save-time hygiene and auto-save (it writes files) are DEFAULT-OFF:
      // only a literal true enables.
      formatOnSave: source.formatOnSave === true,
      trimTrailingWhitespace: source.trimTrailingWhitespace === true,
      insertFinalNewline: source.insertFinalNewline === true,
      autoSaveEnabled: source.autoSaveEnabled === true,
    };
  }
  function toSlice(key, value) {
    if (key === 'fontSize') return clampFontSize(value);
    if (key === 'tabSize') return Number(value);
    if (key === 'renderWhitespace') return String(value);
    if (key === 'rulers') return stringToRulers(value);
    if (key === 'wordWrap' || key === 'lineNumbers') return value ? 'on' : 'off';
    return value === true;
  }

  // The section's descriptors with each 'source:<name>' resolved into a live
  // options list, so the rendered control, edit validation (an Off value of ''
  // is a listed option), hydration and the "Default:" label read one list.
  // `form` returns the current form (the font list keeps an off-list size).
  function editorDescriptors(form) {
    const sources = {
      editorFontSizes: () => {
        const current = form().fontSize;
        const sizes = FONT_SIZES.includes(current) ? FONT_SIZES : [...FONT_SIZES, current].sort((a, b) => a - b);
        return sizes.map((n) => ({
          value: n,
          label: n === 0
            ? jt('settings.editor.fontSizeMatchText', 'Match text size')
            : jt('settings.editor.fontSizeOption', '{size}px', { size: n }),
        }));
      },
      editorTabSizes: () => tabSizes().map((n) => ({ value: n, label: jt('settings.editor.tabSizeOption', '{count} spaces', { count: n }) })),
      editorWhitespace: () => whitespaceValues().map((v) => ({ value: v, label: titleCase(v) })),
      editorRulers: () => RULER_OPTIONS,
    };
    return fieldModules().descriptors.listSettingDescriptors({ adapterId: 'workspaceIde' }).map((d) => {
      const source = typeof d.options === 'string' ? sources[d.options.slice('source:'.length)] : null;
      return source ? Object.defineProperty(Object.assign({}, d), 'options', { get: source, enumerable: true }) : d;
    });
  }

  // Builds the rows from their descriptors and injects them into the stable
  // container. Safe to call repeatedly (re-render on every change).
  function renderEditorSection({ container, status, ide } = {}) {
    const { binding, descriptors } = fieldModules();
    if (!container || !binding || !descriptors) { return; }
    const form = readForm(ide);
    const byKey = {};
    editorDescriptors(() => form).forEach((d) => { byKey[d.key] = d; });
    const row = (key) => binding.renderSettingRow(byKey[key], descriptors.normalizeSettingValue(byKey[key], form[key]));
    const advanced = ['renderWhitespace', 'rulers', 'formatOnSave', 'trimTrailingWhitespace', 'insertFinalNewline'].map(row);
    const parts = ['fontSize', 'tabSize', 'wordWrap', 'minimap', 'lineNumbers', 'autoSaveEnabled'].map(row).concat([
      '<details class="settings-group settings-group--wide settings-editor-advanced">'
        + '<summary>Advanced</summary><div class="settings-editor-advanced-fields">'
        + advanced.join('') + '</div></details>',
    ]);
    container.innerHTML = parts.join('');
    // The section status line only ever carried completion-model feedback;
    // with inline suggestions removed it stays empty and hidden.
    if (status) {
      status.textContent = '';
      status.hidden = true;
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
  function seedEditorPrefs(ide, persisted, skip) {
    if (!persisted || typeof persisted !== 'object') { return; }
    const keys = fieldModules().descriptors.listSettingDescriptors({ adapterId: 'workspaceIde' }).map((d) => d.key);
    for (const key of [...keys, 'eol']) {
      if (key in persisted && !(skip && skip.has(key))) { ide[key] = persisted[key]; }
    }
  }

  function notSavedText() {
    return jt('settings.editor.settingNotSaved', 'That editor preference could not be saved. Your previous setting is still active.');
  }

  // Wires the descriptor rows to the workspaceIde adapter exactly once.
  // Preference projection happens only after the main process acknowledges
  // the narrow patch.
  function bindEditorSection({ container, state, renderSettings, registerListener, listenerOptions, showShellErrorToast, appendClientLog } = {}) {
    const { binding } = fieldModules();
    if (!container || !state || typeof registerListener !== 'function' || !binding) { return; }
    const rerender = typeof renderSettings === 'function' ? renderSettings : function noop() {};
    // Guards the lazy hydration below from clobbering a change the user makes
    // while the async getState() is still in flight (lost-update race).
    const touched = new Set(); // keys edited before hydration returned: theirs wins

    const showError = typeof showShellErrorToast === 'function' ? showShellErrorToast : function noop() {};
    const log = typeof appendClientLog === 'function' ? appendClientLog : function noop() {};
    const signal = listenerOptions?.signal;

    function refusal(code) {
      const error = new Error(notSavedText());
      error.code = String(code);
      return error;
    }

    // One adapter for the workspaceIde slice: after-ack partial patches. `ack`
    // keeps the confirmed values (the echoed slice value, else the requested
    // one) for `apply` to project; a refused batch projects nothing and the
    // re-render restores the controls.
    let acknowledged = null;
    // One coordinator per app state across bind generations (Settings closed and
    // reopened while a write is in flight); the adapter reaches the current
    // binding's abort signal, re-render, toast, log and hydration guard through `live`.
    const shared = binding.sharedRegistryFor(state, 'workspaceIde');
    const live = Object.assign(shared.live, { signal, rerender, showError, log, touched });
    const registry = shared.registry;
    if (!registry.has('workspaceIde')) registry.register({
      id: 'workspaceIde',
      mode: 'patch',
      optimistic: false,
      read: () => readForm(ensureIdeSlice(state)),
      normalize: (form) => form, // readForm is total; composed values are descriptor-validated
      write: (payload) => {
        Object.keys(payload).forEach((key) => live.touched.add(key));
        const api = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.workspaceIde) || null;
        if (!api || typeof api.updateSettings !== 'function') throw refusal('workspace_ide_settings_unavailable');
        const patch = {};
        Object.keys(payload).forEach((key) => { patch[key] = toSlice(key, payload[key]); });
        return api.updateSettings(patch);
      },
      ack: (result, payload, composed) => {
        if (!result || result.updated !== true) throw refusal(result?.code || 'workspace_ide_settings_refused');
        // Acknowledged from the echo only: every written key must come back
        // (workspaceIde.updateSettings spreads the persisted preferences) with
        // the value that was written; a missing or different key is a refusal.
        const echoed = {};
        const requested = {};
        Object.keys(payload).forEach((key) => {
          if (!Object.prototype.hasOwnProperty.call(result, key)) throw refusal('workspace_ide_settings_unconfirmed');
          echoed[key] = result[key];
          requested[key] = toSlice(key, payload[key]);
        });
        const confirmed = readForm(echoed);
        const wanted = readForm(requested);
        acknowledged = {};
        Object.keys(payload).forEach((key) => {
          if (JSON.stringify(confirmed[key]) !== JSON.stringify(wanted[key])) throw refusal('workspace_ide_settings_mismatch');
          acknowledged[key] = confirmed[key];
        });
        return Object.assign({}, composed, acknowledged);
      },
      apply: () => {
        if (live.signal?.aborted) return;
        const ide = ensureIdeSlice(state);
        Object.keys(acknowledged || {}).forEach((key) => { ide[key] = toSlice(key, acknowledged[key]); });
        acknowledged = null;
        live.rerender();
      },
      onError: (error, keys) => {
        if (live.signal?.aborted) return;
        live.log('WARN', 'settings.editor_preference_failed', {
          preference: keys.join(','),
          code: String(error?.code || 'workspace_ide_settings_failed').slice(0, 80),
        });
      },
    });
    binding.bindSettingFields({
      container,
      descriptors: editorDescriptors(() => readForm(state.ui && state.ui.ide)),
      registry,
      registerListener,
      listenerOptions,
      // The reason shows on the row or under the switch; a toast only when it has no place on the page.
      onError: (descriptor, _error, shown) => {
        if (shown?.inline || live.signal?.aborted) return;
        live.showError(notSavedText(), {
          title: jt('settings.editor.settingNotSavedTitle', 'Editor Setting Not Saved'),
          dedupeKey: `settings:editor:${descriptor.key}`,
        });
      },
    });

    // Lazy hydration: if the IDE has never run (no editor prefs on the slice),
    // pull the persisted values once so the controls show the real state.
    const existing = state.ui && state.ui.ide;
    const needsHydration = !existing || existing.fontSize === undefined;
    const ide = ensureIdeSlice(state);
    const ideApi = (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.workspaceIde) || null;
    if (needsHydration && ideApi && typeof ideApi.getState === 'function') {
      Promise.resolve(ideApi.getState()).then((persisted) => {
        // A change made during the fetch wins for its key; the siblings still hydrate.
        seedEditorPrefs(ide, persisted, touched);
        rerender();
      }).catch(function ignore() {});
    }
  }

  // Public surface: the two wired entry points + the helper covered by unit
  // tests. The rest stay module-private (no consumer binds to them).
  return {
    bindEditorSection,
    clampFontSize,
    renderEditorSection,
  };
});
