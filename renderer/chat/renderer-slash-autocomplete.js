/* Shared, completion-only slash menu for the composer and Commands button (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/text-field'), require('../shell/renderer-command-palette').scoreMatch);
    return;
  }
  root.rendererSlashAutocomplete = factory(root.inventoryTextField, (text, query) => root.rendererCommandPaletteUtils.scoreMatch(text, query));
})(typeof globalThis !== 'undefined' ? globalThis : this, function (textField, scoreMatch) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const TRIGGER_RE = /^\/([a-z0-9_-]*)$/i;
  let nextId = 0;

  function searchCommands(entries, query) {
    const needle = String(query || '').trim().toLowerCase().replace(/^\//, '');
    return entries.map((entry, index) => {
      const name = entry.name.toLowerCase().replace(/^\//, '');
      const text = [name, entry.description, entry.skill?.name].filter(Boolean).join(' ').toLowerCase();
      const match = scoreMatch(text, needle);
      if (!match) return null;
      const rank = match.score;
      return { entry, rank, index };
    }).filter(Boolean).sort((a, b) => b.rank - a.rank || a.index - b.index).map((item) => item.entry);
  }

  // Deliberately separate from palette insertion: composer completion replaces
  // a leading partial command, while the global palette retains its own policy.
  function completeCommand(value, name) {
    const current = String(value || '');
    const leading = current.match(/^\s*\/\S*/);
    const suffix = leading ? current.slice(leading[0].length) : current;
    const separator = /^\s/.test(suffix) ? '' : ' ';
    const next = name + separator + suffix;
    return { value: next, caret: name.length + (separator ? 1 : 0) };
  }

  function createSlashAutocomplete(deps) {
    const options = deps || {};
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const win = options.window || doc?.defaultView;
    const registry = options.registry;
    const state = options.state;
    const id = 'composer-slash-menu-' + (++nextId);
    let input, button, popover, search, results, timer, unsubscribe;
    let rows = [];
    let selectedIndex = 0;
    let mode = '';
    let context = '';
    let fingerprint = '';
    let attached = false;
    let disposed = false;
    let completing = false;
    const savedAttributes = new Map();

    function contextKey() {
      return JSON.stringify([state?.currentSessionId, state?.ui?.activeView]);
    }
    function owner() { return mode === 'button' ? search : input; }
    function remember(el, names) {
      if (el) savedAttributes.set(el, names.map((name) => [name, el.getAttribute(name)]));
    }
    function combobox(el) {
      el.setAttribute('role', 'combobox');
      el.setAttribute('aria-autocomplete', 'list');
      el.setAttribute('aria-controls', id);
      el.setAttribute('aria-expanded', 'false');
    }
    function hide(restoreFocus = false) {
      const previous = mode;
      mode = '';
      fingerprint = '';
      win?.clearTimeout(timer);
      timer = null;
      popover?.classList.add('hidden');
      for (const el of [input, search]) {
        el?.setAttribute('aria-expanded', 'false');
        el?.removeAttribute('aria-activedescendant');
      }
      button?.setAttribute('aria-expanded', 'false');
      if (restoreFocus) (previous === 'button' ? button : input)?.focus();
    }
    function position() {
      if (!mode || !popover) return;
      const rect = (mode === 'button' ? button : input).getBoundingClientRect();
      const width = Math.min(Math.max(320, input.getBoundingClientRect().width), Math.max(0, win.innerWidth - 16));
      popover.style.position = 'fixed';
      popover.style.width = width + 'px';
      popover.style.left = Math.max(8, Math.min(rect.left, win.innerWidth - width - 8)) + 'px';
      const above = Math.max(0, rect.top - 14);
      const below = Math.max(0, win.innerHeight - rect.bottom - 14);
      const space = Math.max(above, below);
      popover.style.maxHeight = Math.min(420, space) + 'px';
      popover.style.bottom = above >= below ? Math.max(8, win.innerHeight - rect.top + 6) + 'px' : 'auto';
      popover.style.top = above >= below ? 'auto' : Math.max(8, rect.bottom + 6) + 'px';
    }
    function render() {
      results.replaceChildren();
      owner()?.removeAttribute('aria-activedescendant');
      if (!rows.length) {
        const empty = doc.createElement('div');
        empty.className = 'slash-autocomplete-empty';
        empty.setAttribute('role', 'status');
        empty.textContent = jt('composer.slash.noMatchingCommandOrSkill', 'No matching command or skill');
        results.append(empty);
      }
      rows.forEach((entry, index) => {
        const row = doc.createElement('div');
        row.id = id + '-' + index;
        row.className = 'slash-autocomplete-row' + (index === selectedIndex ? ' slash-autocomplete-row--selected' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(index === selectedIndex));
        row.dataset.slashIndex = String(index);
        if (entry.available === false) {
          row.setAttribute('aria-disabled', 'true');
          row.classList.add('slash-autocomplete-row--disabled');
        }
        const command = doc.createElement('span');
        command.className = 'slash-autocomplete-command';
        command.textContent = entry.name;
        const copy = doc.createElement('span');
        copy.className = 'slash-autocomplete-copy';
        copy.textContent = [entry.skill?.name, entry.description, entry.available === false && entry.unavailableReason].filter(Boolean).join(' — ');
        const tag = doc.createElement('span');
        tag.className = 'slash-autocomplete-tag';
        tag.textContent = entry.skill ? jt('composer.slash.skill', 'Skill') : jt("mcp.servers.command", "Command");
        row.append(command, copy, tag);
        results.append(row);
        if (index === selectedIndex) owner()?.setAttribute('aria-activedescendant', row.id);
      });
      results.querySelector('.slash-autocomplete-row--selected')?.scrollIntoView?.({ block: 'nearest' });
    }
    function ensurePopover() {
      if (popover) return;
      popover = doc.createElement('div');
      popover.className = 'slash-autocomplete-popover hidden';
      const searchWrapper = doc.createElement('div');
      searchWrapper.innerHTML = textField({ id: id + '-search', spellcheck: false, ariaLabel: jt("slashAutocomplete.searchCommandsAndSkills", "Search commands and skills") });
      search = searchWrapper.querySelector('input');
      search.type = 'search';
      search.className = 'slash-autocomplete-search';
      search.placeholder = jt("slashAutocomplete.searchCommandsAndSkills2", "Search commands and skills…");
      search.setAttribute('aria-label', jt("slashAutocomplete.searchCommandsAndSkills", "Search commands and skills"));
      combobox(search);
      results = doc.createElement('div');
      results.id = id;
      results.className = 'slash-autocomplete-results';
      results.setAttribute('role', 'listbox');
      results.setAttribute('aria-label', jt("composer.slash.autocompleteAriaLabel", "Slash commands and skills"));
      const footer = doc.createElement('div');
      footer.className = 'slash-autocomplete-footer';
      footer.textContent = jt("slashAutocomplete.chooseEnterTabCompleteEscDismissSendToRun", "↑↓ choose · Enter/Tab complete · Esc dismiss · Send to run");
      popover.append(search, results, footer);
      (options.getMountEl?.() || doc.body).append(popover);
      search.addEventListener('input', refresh);
      popover.addEventListener('mousedown', preventRowBlur);
      popover.addEventListener('click', clickRow);
    }
    function detectTrigger() {
      if (!input || input.selectionStart !== input.selectionEnd) return null;
      return TRIGGER_RE.exec(input.value.slice(0, input.selectionStart));
    }
    function refresh(event) {
      if (disposed || completing || event?.isComposing) return;
      if (mode && context !== contextKey()) return hide();
      const match = detectTrigger();
      if (mode !== 'button' && !match) return hide();
      if (!mode) { mode = 'inline'; context = contextKey(); }
      ensurePopover();
      const query = mode === 'button' ? search.value : match[1];
      const nextRows = searchCommands(registry.listCommands(), query);
      const nextFingerprint = JSON.stringify([query, nextRows]);
      if (fingerprint !== nextFingerprint) {
        rows = nextRows;
        selectedIndex = 0;
        fingerprint = nextFingerprint;
        render();
      }
      search.hidden = mode !== 'button';
      popover.classList.remove('hidden');
      owner().setAttribute('aria-expanded', 'true');
      position();
      if (!timer) timer = win.setTimeout(checkContext, 150);
    }
    // Only while open: session/view ownership and availability aren't registry
    // mutations. This bounded watcher also covers programmatic draft changes.
    function checkContext() {
      timer = null;
      if (mode) refresh();
    }
    function openButton() {
      if (disposed || !button) return;
      if (mode === 'button') return hide(true);
      hide();
      ensurePopover();
      mode = 'button';
      context = contextKey();
      search.value = '';
      fingerprint = '';
      button.setAttribute('aria-expanded', 'true');
      refresh();
      search.focus();
    }
    function accept(index) {
      if (context !== contextKey()) return hide();
      const entry = rows[index];
      // Revalidate against the live catalog before inserting a stale row.
      if (!entry || !registry.listCommands().some((item) => item.name === entry.name && item.available !== false)) return;
      const completion = completeCommand(input.value, entry.name);
      completing = true;
      input.value = completion.value;
      input.setSelectionRange(completion.caret, completion.caret);
      hide();
      input.focus();
      input.dispatchEvent(new win.Event('input', { bubbles: true }));
      completing = false;
      options.onAccept?.(entry, completion.value);
    }
    function handleKeydown(event) {
      if (!mode || event.target !== owner() || event.defaultPrevented || event.isComposing || event.keyCode === 229
        || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (context !== contextKey()) return hide();
      if (event.key === 'Escape') return hide(true);
      if (event.key === 'Enter' || event.key === 'Tab') return accept(selectedIndex);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      for (let count = 0; count < rows.length; count++) {
        selectedIndex = (selectedIndex + delta + rows.length) % rows.length;
        if (rows[selectedIndex].available !== false) break;
      }
      render();
    }
    function preventRowBlur(event) {
      if (event.target.closest('[data-slash-index]')) event.preventDefault();
    }
    function clickRow(event) {
      const row = event.target.closest('[data-slash-index]');
      if (row) { event.preventDefault(); accept(Number(row.dataset.slashIndex)); }
    }
    function clickButton(event) {
      // Claim this entry point before the fallback legacy popover listeners.
      if (!button || !button.contains(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openButton();
    }
    function outside(event) {
      if (mode && event.target !== owner() && !popover?.contains(event.target) && !button?.contains(event.target)) hide();
    }
    function focusChanged(event) {
      if (mode && event.target !== owner() && !popover?.contains(event.target) && event.target !== button) hide();
    }
    function caretChanged() { if (mode === 'inline') refresh(); }
    function attach() {
      if (disposed || attached || !registry || !doc) return dispose;
      input = options.getInput?.() || doc.getElementById('chatInput');
      if (!input) return dispose;
      attached = true;
      button = doc.getElementById('composerTerminalShortcut');
      remember(input, ['role', 'aria-autocomplete', 'aria-controls', 'aria-expanded', 'aria-activedescendant']);
      remember(button, ['aria-haspopup', 'aria-controls', 'aria-expanded', 'data-slash-menu-owned']);
      button?.setAttribute('data-slash-menu-owned', 'true');
      combobox(input);
      button?.setAttribute('aria-haspopup', 'listbox');
      button?.setAttribute('aria-controls', id);
      input.addEventListener('input', refresh);
      input.addEventListener('click', caretChanged);
      input.addEventListener('keyup', caretChanged);
      doc.addEventListener('keydown', handleKeydown, true);
      doc.addEventListener('click', clickButton, true);
      doc.addEventListener('pointerdown', outside, true);
      doc.addEventListener('focusin', focusChanged);
      win.addEventListener('resize', position);
      unsubscribe = registry.subscribe?.(() => { if (mode) refresh(); });
      return dispose;
    }
    function dispose() {
      if (disposed) return;
      hide();
      disposed = true;
      unsubscribe?.();
      input?.removeEventListener('input', refresh);
      input?.removeEventListener('click', caretChanged);
      input?.removeEventListener('keyup', caretChanged);
      doc?.removeEventListener('keydown', handleKeydown, true);
      doc?.removeEventListener('click', clickButton, true);
      doc?.removeEventListener('pointerdown', outside, true);
      doc?.removeEventListener('focusin', focusChanged);
      win?.removeEventListener('resize', position);
      popover?.remove();
      for (const [el, attributes] of savedAttributes) {
        for (const [name, value] of attributes) {
          if (value === null) el.removeAttribute(name);
          else el.setAttribute(name, value);
        }
      }
      savedAttributes.clear();
      attached = false;
    }
    return { attach, dispose, isOpen: () => Boolean(mode), refresh, openButton, hide };
  }
  return { TRIGGER_RE, searchCommands, completeCommand, createSlashAutocomplete };
});
