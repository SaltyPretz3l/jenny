/* renderer/features/renderer-ide-chip-picker.js
 *
 * Inventory-backed pickers used by the IDE: quick-picks behind the interactive
 * statusbar chips (tab size, EOL, language, indentation, encoding). The Workspace
 * Chat Dock's session switcher lives in renderer-ide-chat-session-picker.
 *
 * The popover is appended to the IDE shell (NOT the cursor-driven statusbar
 * markup, which re-renders on every cursor move and would otherwise destroy an
 * open popover). Buttons render through the inventory action-button. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeChipPicker = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  const TAB_SIZES = [2, 4, 8];
  const INDENT_SIZES = [1, 2, 3, 4, 6, 8];
  // Thunks so each note keeps a literal key the i18n scanner can read.
  const INDENT_SOURCE_NOTES = {
    file: () => jt('ide.chipPicker.indentSourceFile', 'Indentation set for this file'),
    editorconfig: () => jt('ide.chipPicker.indentSourceEditorconfig', 'Indentation from .editorconfig'),
    default: () => jt('ide.chipPicker.indentSourceDefault', 'Indentation from the editor default'),
  };
  const EOL_OPTIONS = [['lf', 'LF'], ['crlf', 'CRLF']];

  function resolveInventoryPrimitive(globalName, requirePath) {
    if (typeof globalRef[globalName] === 'function') {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  const defaultEscape = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function createIdeChipPicker(deps) {
    const options = deps || {};
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const editorHost = options.editorHost || null;
    const getActivePath = typeof options.getActivePath === 'function' ? options.getActivePath : () => '';
    const escapeHtml = typeof options.escapeHtml === 'function' ? options.escapeHtml : defaultEscape;
    const actionButton = typeof options.actionButton === 'function' ? options.actionButton : null;
    const popover = typeof options.popover === 'function' ? options.popover : null;
    const onAfterChange = typeof options.onAfterChange === 'function' ? options.onAfterChange : noop;
    const textField = typeof options.textField === 'function' ? options.textField : resolveInventoryPrimitive('inventoryTextField', '../inventory/text-field');
    // Re-renders the status bar after a per-tab (session-only) language / indentation change.
    const requestStatusRender = typeof options.requestStatusRender === 'function' ? options.requestStatusRender : noop;
    // { insertSpaces, tabSize }: the preference defaults "Detect Indentation" falls back to.
    const getIndentDefaults = typeof options.getIndentDefaults === 'function' ? options.getIndentDefaults : () => ({});

    let sessionTabSize = null; // null -> follow the file/editor default
    let sessionEol = null;
    let host = null;
    let bound = false;

    function ensureHost() {
      const shell = getDom().ideShell || null;
      if (!shell || !popover || typeof shell.appendChild !== 'function') {
        return null;
      }
      if (host && shell.contains(host)) {
        return host;
      }
      const docRef = shell.ownerDocument || (typeof document !== 'undefined' ? document : null);
      if (!docRef) {
        return null;
      }
      const wrap = docRef.createElement('div');
      wrap.innerHTML = popover({ id: 'ideChipPicker', className: 'ide-chip-popover', ariaLabel: jt('ide.chipPicker.editorSetting', 'Editor setting') });
      host = wrap.firstChild;
      // The popover hosts single-select menuitemradio options, so it is a menu
      // (the popover primitive defaults to role="dialog"; its logic keys on the
      // .inv-popover class + hidden, not role, so this override is safe).
      if (host && typeof host.setAttribute === 'function') {
        host.setAttribute('role', 'menu');
      }
      shell.appendChild(host);
      if (typeof host.addEventListener === 'function') {
        host.addEventListener('click', handleHostClick);
        host.addEventListener('input', handleHostInput);
        host.addEventListener('keydown', handleHostKeydown);
      }
      return host;
    }

    function position(anchor) {
      const shell = getDom().ideShell || null;
      if (!host || !shell || typeof anchor?.getBoundingClientRect !== 'function') {
        return;
      }
      const a = anchor.getBoundingClientRect();
      const s = shell.getBoundingClientRect();
      host.style.left = `${Math.max(4, a.left - s.left)}px`;
      host.style.bottom = `${Math.max(0, s.bottom - a.top + 4)}px`;
    }

    function buildMenu(kind) {
      if (!actionButton) {
        return '';
      }
      if (kind === 'tab-size') {
        const current = Number(editorHost?.getTabSize?.()) || sessionTabSize || 2;
        // Single-select group -> menuitemradio; aria-checked is set imperatively
        // after render (openPicker) since the action-button primitive does not
        // emit aria-checked.
        return TAB_SIZES.map((size) => actionButton({
          plain: true,
          className: `ide-chip-option${size === current ? ' ide-chip-option--active' : ''}`,
          role: 'menuitemradio',
          trustedHtml: escapeHtml(jt('ide.statusbar.spaces', 'Spaces: {size}', { size })),
          dataset: { 'ide-chip-kind': 'tab-size', 'ide-chip-value': String(size) },
        })).join('');
      }
      if (kind === 'language') {
        return buildLanguageMenu();
      }
      if (kind === 'indent') {
        return buildIndentMenu();
      }
      if (kind === 'indent-size') {
        return INDENT_SIZES.map((size) => actionButton({
          plain: true,
          className: `ide-chip-option${size === Number(pending.tabSize) ? ' ide-chip-option--active' : ''}`,
          role: 'menuitemradio',
          trustedHtml: escapeHtml(String(size)),
          title: jt('ide.chipPicker.tabDisplaySizeOption', 'Tab size {size}', { size }),
          dataset: { 'ide-chip-kind': 'indent-size', 'ide-chip-value': String(size) },
        })).join('');
      }
      if (kind === 'encoding') {
        const name = pending.bom === true ? jt('ide.statusbar.encodingUtf8Bom', 'UTF-8 with BOM') : jt('ide.statusbar.encodingUtf8', 'UTF-8');
        return `<div class="ide-chip-note ide-chip-note--value" role="note">${escapeHtml(name)}</div>`
          + `<div class="ide-chip-note" role="note">${escapeHtml(jt('ide.chipPicker.encodingReadOnly', 'Jenny reads and saves files as UTF-8; re-encoding is not available.'))}</div>`;
      }
      const currentEol = editorHost?.getEol?.(getActivePath()) === 'crlf' ? 'crlf' : 'lf';
      return EOL_OPTIONS.map(([value, label]) => actionButton({
        plain: true,
        className: `ide-chip-option${value === currentEol ? ' ide-chip-option--active' : ''}`,
        role: 'menuitemradio',
        trustedHtml: escapeHtml(label),
        dataset: { 'ide-chip-kind': 'eol', 'ide-chip-value': value },
      })).join('');
    }

    // The opener config of the picker that is open now (onPick callbacks, current values).
    let pending = {};

    function languageEntries(languages) {
      return (Array.isArray(languages) ? languages : [])
        .filter((entry) => entry && entry.id && Array.isArray(entry.aliases) && entry.aliases.length > 0)
        .map((entry) => ({ id: String(entry.id), label: String(entry.aliases[0]), aliases: entry.aliases.map(String) }))
        .sort((left, right) => left.label.localeCompare(right.label));
    }

    function languageRows(query) {
      const needle = String(query || '').trim().toLowerCase();
      const auto = jt('ide.chipPicker.autoDetect', 'Auto Detect');
      const rows = [];
      if (!needle || auto.toLowerCase().includes(needle)) {
        rows.push({ id: '', label: auto, description: '' });
      }
      for (const entry of pending.entries || []) {
        if (!needle || entry.label.toLowerCase().includes(needle) || entry.id.toLowerCase().includes(needle)
          || entry.aliases.some((alias) => alias.toLowerCase().includes(needle))) {
          rows.push({ id: entry.id, label: entry.label, description: entry.id });
        }
      }
      return rows;
    }

    function languageListMarkup(query) {
      const rows = languageRows(query);
      if (!rows.length) {
        return `<div class="ide-chip-note" role="note">${escapeHtml(jt('ide.chipPicker.noLanguagesFound', 'No languages found'))}</div>`;
      }
      return rows.map((row) => {
        const selected = Boolean(row.id) && row.id === pending.current;
        return actionButton({
          plain: true,
          className: `ide-chip-option${selected ? ' ide-chip-option--active' : ''}`,
          role: 'option',
          ariaSelected: selected,
          dataset: { 'ide-chip-kind': 'language', 'ide-chip-value': row.id },
          title: row.description ? `${row.label} (${row.description})` : row.label,
          trustedHtml: `<span class="ide-chip-option-label">${escapeHtml(row.label)}</span>`
            + (row.description ? `<span class="ide-chip-option-desc">${escapeHtml(row.description)}</span>` : ''),
        });
      }).join('');
    }

    function buildLanguageMenu() {
      if (typeof textField !== 'function') {
        return '';
      }
      const search = textField({
        id: 'ideChipLanguageSearch',
        placeholder: jt('ide.statusbar.selectLanguageMode', 'Select Language Mode'),
        ariaLabel: jt('ide.chipPicker.searchLanguages', 'Search languages'),
        className: 'ide-chip-search',
        dataset: { 'ide-chip-search': '1' },
      });
      return search
        + `<div class="ide-chip-list" role="listbox" aria-label="${escapeHtml(jt('ide.chipPicker.languages', 'Languages'))}" data-ide-chip-list>${languageListMarkup('')}</div>`;
    }

    function buildIndentMenu() {
      const note = (INDENT_SOURCE_NOTES[pending.source] || INDENT_SOURCE_NOTES.default)();
      const spaces = pending.insertSpaces !== false;
      const row = (value, label, radio, active) => actionButton({
        plain: true,
        className: `ide-chip-option${active ? ' ide-chip-option--active' : ''}`,
        role: radio ? 'menuitemradio' : 'menuitem',
        trustedHtml: escapeHtml(label),
        title: label,
        dataset: { 'ide-chip-kind': 'indent', 'ide-chip-value': value },
      });
      return `<div class="ide-chip-note" role="note">${escapeHtml(note)}</div>`
        + row('spaces', jt('ide.chipPicker.indentUsingSpaces', 'Indent Using Spaces'), true, spaces)
        + row('tabs', jt('ide.chipPicker.indentUsingTabs', 'Indent Using Tabs'), true, !spaces)
        + row('size', jt('ide.chipPicker.changeTabDisplaySize', 'Change Tab Display Size'), false, false)
        + row('detect', jt('ide.chipPicker.detectIndentation', 'Detect Indentation from Content'), false, false)
        + row('convert-spaces', jt('ide.chipPicker.convertToSpaces', 'Convert Indentation to Spaces'), false, false)
        + row('convert-tabs', jt('ide.chipPicker.convertToTabs', 'Convert Indentation to Tabs'), false, false);
    }

    // Shows `kind` in the popover (open already, or about to open).
    function renderKind(popEl, kind) {
      popEl.__chipKind = kind;
      popEl.setAttribute('role', kind === 'language' ? 'dialog' : 'menu');
      popEl.innerHTML = buildMenu(kind);
      // aria-checked tracks the active option (the primitive can't emit it).
      popEl.querySelectorAll('[role="menuitemradio"]').forEach((btn) => {
        btn.setAttribute(
          'aria-checked',
          btn.classList.contains('ide-chip-option--active') ? 'true' : 'false'
        );
      });
    }

    function openPicker(kind, anchor, config = {}) {
      const popEl = ensureHost();
      if (!popEl) {
        return;
      }
      // Re-clicking the same chip toggles the popover closed; restoreFocus
      // returns focus to the chip instead of stranding it.
      if (popover.isOpen(popEl) && popEl.__chipKind === kind) {
        popover.close(popEl, { restoreFocus: true });
        return;
      }
      pending = config;
      renderKind(popEl, kind);
      position(anchor);
      popover.open(popEl, { trigger: anchor, focus: kind !== 'language' });
      if (kind === 'language') {
        popEl.querySelector('[data-ide-chip-search]')?.focus?.();
      }
    }

    function indentInfo() {
      const info = editorHost?.getIndentInfo?.(getActivePath());
      return info || { insertSpaces: true, tabSize: Number(editorHost?.getTabSize?.()) || 2, source: 'default' };
    }

    // Default onPick handlers: apply to the active tab, then refresh the status bar.
    function pickLanguage(id) {
      editorHost?.setLanguage?.(getActivePath(), id || null);
      requestStatusRender();
    }

    function pickIndent(pick) {
      const info = indentInfo();
      const path = getActivePath();
      if (pick?.kind === 'spaces' || pick?.kind === 'tabs') {
        editorHost?.setIndent?.(path, { insertSpaces: pick.kind === 'spaces', tabSize: info.tabSize, source: 'file' });
      } else if (pick?.kind === 'size' && Number(pick.value) > 0) {
        editorHost?.setIndent?.(path, { insertSpaces: info.insertSpaces, tabSize: Number(pick.value), source: 'file' });
      } else if (pick?.kind === 'detect') {
        editorHost?.detectIndentation?.(path, getIndentDefaults());
      } else if (pick?.kind === 'convert') {
        Promise.resolve(editorHost?.convertIndentation?.(path, pick.to === 'tabs' ? 'tabs' : 'spaces'))
          .then(requestStatusRender, noop);
      }
      requestStatusRender();
    }

    function openLanguagePicker(anchor, opts = {}) {
      const languages = Array.isArray(opts.languages) ? opts.languages : (editorHost?.getMonaco?.()?.languages?.getLanguages?.() || []);
      const current = opts.current !== undefined ? opts.current : (editorHost?.getFocusedLanguageId?.() || editorHost?.getActiveLanguageId?.() || '');
      openPicker('language', anchor, {
        entries: languageEntries(languages),
        current: String(current || ''),
        onPick: typeof opts.onPick === 'function' ? opts.onPick : pickLanguage,
      });
    }

    function openIndentationPicker(anchor, opts = {}) {
      const info = indentInfo();
      openPicker('indent', anchor, {
        insertSpaces: opts.insertSpaces !== undefined ? opts.insertSpaces : info.insertSpaces,
        tabSize: Number(opts.tabSize) > 0 ? Number(opts.tabSize) : info.tabSize,
        source: opts.source || info.source,
        onPick: typeof opts.onPick === 'function' ? opts.onPick : pickIndent,
      });
    }

    // The "Change Tab Display Size" list on its own (palette entry point).
    function openTabDisplaySizePicker(anchor, opts = {}) {
      openPicker('indent-size', anchor, {
        tabSize: Number(opts.tabSize) > 0 ? Number(opts.tabSize) : indentInfo().tabSize,
        onPick: typeof opts.onPick === 'function' ? opts.onPick : pickIndent,
      });
    }

    function openEncodingInfo(anchor, opts = {}) {
      const info = opts.encoding !== undefined ? opts : (editorHost?.getEncodingInfo?.(getActivePath()) || {});
      openPicker('encoding', anchor, { encoding: info.encoding || 'utf-8', bom: info.bom === true });
    }

    function apply(kind, value) {
      if (kind === 'tab-size') {
        const size = Number(value);
        if (size > 0) {
          sessionTabSize = size;
          editorHost?.setTabSize?.(size);
        }
      } else if (kind === 'eol') {
        const eol = value === 'crlf' ? 'crlf' : 'lf';
        sessionEol = eol;
        editorHost?.setEol?.(getActivePath(), eol);
      }
      // Notify the controller so it can persist the selected default.
      onAfterChange({ kind, value: kind === 'tab-size' ? sessionTabSize : sessionEol });
    }

    // Picks from the per-tab pickers (language / indentation) go to the opener's onPick.
    function dispatchPick(kind, value) {
      const onPick = pending.onPick;
      if (kind === 'language') {
        onPick?.(value === '' ? null : value);
      } else if (kind === 'indent-size') {
        onPick?.({ kind: 'size', value: Number(value) });
      } else if (value === 'spaces' || value === 'tabs') {
        onPick?.({ kind: value });
      } else if (value === 'detect') {
        onPick?.({ kind: 'detect' });
      } else if (value === 'convert-spaces' || value === 'convert-tabs') {
        onPick?.({ kind: 'convert', to: value === 'convert-tabs' ? 'tabs' : 'spaces' });
      }
    }

    function handleHostClick(event) {
      const target = event.target;
      const btn = target && typeof target.closest === 'function'
        ? target.closest('[data-ide-chip-value]')
        : null;
      if (!btn) {
        return;
      }
      const kind = btn.getAttribute('data-ide-chip-kind');
      const value = btn.getAttribute('data-ide-chip-value');
      if (kind === 'indent' && value === 'size') {
        // Second list inside the same popover; picking a size closes it.
        renderKind(host, 'indent-size');
        host.querySelector('[data-ide-chip-value]')?.focus?.();
        return;
      }
      if (kind === 'tab-size' || kind === 'eol') {
        apply(kind, value);
      } else {
        dispatchPick(kind, value);
      }
      if (host) {
        popover.close(host, { restoreFocus: true });
      }
    }

    function languageOptions() {
      return host ? [...host.querySelectorAll('[data-ide-chip-kind="language"]')] : [];
    }

    function handleHostInput(event) {
      if (!event.target?.matches?.('[data-ide-chip-search]') || host?.__chipKind !== 'language') {
        return;
      }
      const list = host.querySelector('[data-ide-chip-list]');
      if (list) {
        list.innerHTML = languageListMarkup(event.target.value);
      }
    }

    function handleHostKeydown(event) {
      if (host?.__chipKind !== 'language') {
        return;
      }
      const search = event.target?.matches?.('[data-ide-chip-search]');
      const option = event.target?.closest?.('[data-ide-chip-kind="language"]');
      if (!search && !option) {
        return;
      }
      // Enter that commits an IME composition belongs to the IME.
      if (event.key === 'Enter' && (event.isComposing || event.keyCode === 229)) {
        return;
      }
      const options = languageOptions();
      if (event.key === 'Enter') {
        (search ? options[0] : option)?.click?.();
        event.preventDefault();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !options.length) {
        return;
      }
      let next = 0;
      if (search) {
        next = event.key === 'ArrowUp' || event.key === 'End' ? options.length - 1 : 0;
      } else if (event.key === 'ArrowDown') {
        next = (options.indexOf(option) + 1) % options.length;
      } else if (event.key === 'ArrowUp') {
        next = (options.indexOf(option) - 1 + options.length) % options.length;
      } else if (event.key === 'End') {
        next = options.length - 1;
      }
      options[next]?.focus?.();
      event.preventDefault();
    }

    // Palette rows for the status-bar pickers (row 82); pickers anchor on the matching chip.
    function chipAnchor(action) {
      const bar = getDom().ideStatusBar || null;
      return bar?.querySelector?.(`[data-ide-status-action="${action}"]`) || bar || null;
    }

    function registerCommands(registry) {
      if (!registry || typeof registry.register !== 'function') {
        return noop;
      }
      const when = (ctx) => ctx.activeView === 'ide' && ctx.hasActiveFile === true;
      const rows = [
        ['ide:change-language-mode', jt('ide.statusCommands.changeLanguageMode', 'Change Language Mode'), () => openLanguagePicker(chipAnchor('language')), ['ctrl+k m']],
        ['ide:change-eol', jt('ide.statusCommands.changeEol', 'Change End of Line Sequence'), () => openPicker('eol', chipAnchor('eol'))],
        ['ide:indent-using-spaces', jt('ide.chipPicker.indentUsingSpaces', 'Indent Using Spaces'), () => pickIndent({ kind: 'spaces' })],
        ['ide:indent-using-tabs', jt('ide.chipPicker.indentUsingTabs', 'Indent Using Tabs'), () => pickIndent({ kind: 'tabs' })],
        ['ide:change-tab-display-size', jt('ide.chipPicker.changeTabDisplaySize', 'Change Tab Display Size'), () => openTabDisplaySizePicker(chipAnchor('indentation'))],
        ['ide:detect-indentation', jt('ide.chipPicker.detectIndentation', 'Detect Indentation from Content'), () => pickIndent({ kind: 'detect' })],
        ['ide:convert-indentation-to-spaces', jt('ide.chipPicker.convertToSpaces', 'Convert Indentation to Spaces'), () => pickIndent({ kind: 'convert', to: 'spaces' })],
        ['ide:convert-indentation-to-tabs', jt('ide.chipPicker.convertToTabs', 'Convert Indentation to Tabs'), () => pickIndent({ kind: 'convert', to: 'tabs' })],
      ];
      const disposers = rows.map(([id, label, run, keys]) => registry.register({
        id,
        label,
        group: 'Workspace',
        ...(keys ? { keys } : {}),
        when,
        run,
      }));
      return () => disposers.forEach((dispose) => { if (typeof dispose === 'function') dispose(); });
    }

    function initHandlers() {
      if (bound) {
        return;
      }
      const shell = getDom().ideShell || null;
      if (!shell || !popover) {
        return;
      }
      bound = true;
      popover.initPopoverHandlers(shell);
      ensureHost();
    }

    // Applies the session defaults (if the user changed them) to a freshly
    // opened file; called by the controller after the doc is activated.
    function applyDefaults(path) {
      if (sessionTabSize !== null) {
        editorHost?.setTabSize?.(sessionTabSize, path);
      }
      if (sessionEol !== null) {
        editorHost?.setEol?.(path, sessionEol);
      }
    }

    // Hydrate persisted defaults; null leaves the per-file setting unchanged.
    function seedDefaults({ tabSize = null, eol = null } = {}) {
      if (tabSize !== null && Number(tabSize) > 0) {
        sessionTabSize = Number(tabSize);
        editorHost?.setTabSize?.(sessionTabSize);
      }
      if (eol === 'lf' || eol === 'crlf') {
        sessionEol = eol;
        editorHost?.setEol?.(getActivePath(), sessionEol);
      }
    }

    function dispose() {
      if (host && typeof host.removeEventListener === 'function') {
        host.removeEventListener('click', handleHostClick);
        host.removeEventListener('input', handleHostInput);
        host.removeEventListener('keydown', handleHostKeydown);
      }
      if (host && host.parentNode) {
        host.parentNode.removeChild(host);
      }
      host = null;
      bound = false;
    }

    return {
      initHandlers,
      openTabSizePicker: (anchor) => openPicker('tab-size', anchor),
      openEolPicker: (anchor) => openPicker('eol', anchor),
      openLanguagePicker,
      openIndentationPicker,
      openTabDisplaySizePicker,
      openEncodingInfo,
      registerCommands,
      applyDefaults,
      seedDefaults,
      dispose,
    };
  }

  return { createIdeChipPicker };
});
