/* First-token slash autocomplete for the chat composer (UMD). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shell/renderer-command-palette'));
    return;
  }
  root.rendererSlashAutocomplete = factory(root.rendererCommandPaletteUtils || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (paletteUtils) {
  'use strict';

  const TRIGGER_RE = /^\/([a-z0-9_-]*)$/;
  const MAX_ROWS = 8;

  function fallbackScore(value, query) {
    if (!query) return { score: 0 };
    const haystack = String(value || '').toLowerCase();
    const needle = String(query || '').toLowerCase();
    let at = -1;
    for (const char of needle) {
      at = haystack.indexOf(char, at + 1);
      if (at < 0) return null;
    }
    return { score: Math.max(1, 100 - at) };
  }

  function createSlashAutocomplete(deps) {
    const options = deps || {};
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const win = options.window || doc?.defaultView || (typeof window !== 'undefined' ? window : null);
    const registry = options.registry;
    const getInput = options.getInput || (() => doc?.getElementById?.('chatInput'));
    const getMountEl = options.getMountEl || (() => doc?.body || null);
    const onAccept = typeof options.onAccept === 'function' ? options.onAccept : function noop() {};
    // Resolved at create time: under `defer` the palette utils load after this
    // module's factory ran, so the UMD-time `paletteUtils` is empty in the app.
    const scoreMatch = options.scoreMatch || globalThis.rendererCommandPaletteUtils?.scoreMatch
      || paletteUtils?.scoreMatch || fallbackScore;
    let input = null;
    let popover = null;
    let results = null;
    let rows = [];
    let selectedIndex = 0;
    let open = false;
    let attached = false;
    let disposed = false;

    function detectTrigger() {
      if (!input) return null;
      const value = String(input.value || '');
      const caret = Number.isFinite(Number(input.selectionStart)) ? Number(input.selectionStart) : value.length;
      if (caret !== value.length) return null;
      const match = TRIGGER_RE.exec(value);
      return match ? { token: match[1] || '' } : null;
    }

    function rankGroup(entries, token) {
      return entries.map((entry, index) => {
        const haystack = [entry.name, entry.skill?.name, entry.description].filter(Boolean).join(' ');
        const match = token ? scoreMatch(haystack, token) : { score: 0 };
        return match ? { entry, score: Number(match.score || 0), index } : null;
      }).filter(Boolean).sort((a, b) => b.score - a.score || a.index - b.index);
    }

    function collectRows(token) {
      const listed = registry?.listCommands?.();
      const entries = Array.isArray(listed) ? listed : [];
      const skills = entries.filter((entry) => entry.action === 'attach');
      const commands = entries.filter((entry) => entry.action !== 'attach');
      return rankGroup(skills, token).concat(rankGroup(commands, token)).slice(0, MAX_ROWS).map((item) => item.entry);
    }

    function ensurePopover() {
      if (popover || !doc) return popover;
      const mount = getMountEl();
      if (!mount) return null;
      popover = doc.createElement('div');
      popover.className = 'slash-autocomplete-popover hidden';
      popover.setAttribute('role', 'listbox');
      popover.setAttribute('aria-label', 'Slash commands and skills');
      results = doc.createElement('div');
      results.className = 'slash-autocomplete-results';
      const footer = doc.createElement('div');
      footer.className = 'slash-autocomplete-footer';
      footer.textContent = '↑↓ choose · Tab attach · Esc dismiss';
      popover.append(results, footer);
      mount.appendChild(popover);
      popover.addEventListener('click', handleClick);
      return popover;
    }

    function positionPopover() {
      if (!popover || !input?.getBoundingClientRect) return;
      const rect = input.getBoundingClientRect();
      const viewportHeight = win?.innerHeight || 0;
      popover.style.position = 'fixed';
      popover.style.left = Math.max(8, rect.left) + 'px';
      popover.style.width = Math.max(240, rect.width) + 'px';
      popover.style.bottom = Math.max(8, viewportHeight - rect.top + 6) + 'px';
    }

    function render() {
      if (!results) return;
      results.replaceChildren();
      if (!rows.length) {
        const empty = doc.createElement('div');
        empty.className = 'slash-autocomplete-empty';
        empty.textContent = 'No matching command or skill';
        results.appendChild(empty);
        return;
      }
      let priorGroup = '';
      rows.forEach((entry, index) => {
        const group = entry.action === 'attach' ? 'Skills' : 'Commands';
        if (group !== priorGroup) {
          const heading = doc.createElement('div');
          heading.className = 'slash-autocomplete-group';
          heading.textContent = group;
          results.appendChild(heading);
          priorGroup = group;
        }
        const row = doc.createElement('div');
        row.className = 'slash-autocomplete-row' + (index === selectedIndex ? ' slash-autocomplete-row--selected' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', index === selectedIndex ? 'true' : 'false');
        row.dataset.slashIndex = String(index);
        if (entry.available === false) {
          row.classList.add('slash-autocomplete-row--disabled');
          row.setAttribute('aria-disabled', 'true');
        }
        const command = doc.createElement('span');
        command.className = 'slash-autocomplete-command';
        command.textContent = entry.name;
        const copy = doc.createElement('span');
        copy.className = 'slash-autocomplete-copy';
        copy.textContent = entry.action === 'attach'
          ? [entry.skill?.name, entry.description].filter(Boolean).join(' · ')
          : entry.available === false
            ? [entry.description, entry.unavailableReason].filter(Boolean).join(' — ')
            : entry.description;
        const tag = doc.createElement('span');
        tag.className = 'slash-autocomplete-tag';
        tag.textContent = entry.action === 'attach' ? 'Skill' : entry.actionLabel;
        row.append(command, copy, tag);
        results.appendChild(row);
      });
      results.querySelector('.slash-autocomplete-row--selected')?.scrollIntoView?.({ block: 'nearest' });
    }

    function refresh() {
      const trigger = detectTrigger();
      if (!trigger) return hide();
      rows = collectRows(trigger.token);
      selectedIndex = Math.max(0, Math.min(selectedIndex, rows.length - 1));
      if (!ensurePopover()) return;
      open = true;
      popover.classList.remove('hidden');
      positionPopover();
      render();
    }

    function hide() {
      open = false;
      popover?.classList.add('hidden');
    }

    function move(delta) {
      if (!rows.length) return;
      let next = selectedIndex;
      for (let count = 0; count < rows.length; count += 1) {
        next = (next + delta + rows.length) % rows.length;
        if (rows[next]?.available !== false) break;
      }
      selectedIndex = next;
      render();
    }

    function canAccept(index) {
      const entry = rows[index];
      return Boolean(entry) && entry.available !== false;
    }

    function accept(index) {
      if (!canAccept(index)) return;
      const entry = rows[index];
      const prompt = entry.name;
      input.value = prompt;
      input.setSelectionRange?.(prompt.length, prompt.length);
      hide();
      onAccept(entry, prompt);
    }

    function handleKeydown(event) {
      if (!open || event.target !== input) return;
      const actions = { ArrowDown: () => move(1), ArrowUp: () => move(-1), Tab: () => accept(selectedIndex), Enter: () => accept(selectedIndex), Escape: hide };
      const action = actions[event.key];
      if (!action) return;
      if ((event.key === 'Enter' || event.key === 'Tab') && !canAccept(selectedIndex)) {
        // Nothing to accept (no match / disabled row): close and let the
        // composer's own Enter-to-send or Tab focus move see the key.
        hide();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      action();
    }

    function handlePointer(event) {
      if (!open || event.target === input || event.target?.closest?.('.slash-autocomplete-popover')) return;
      hide();
    }

    function handleClick(event) {
      const row = event.target?.closest?.('[data-slash-index]');
      if (!row) return;
      event.preventDefault();
      accept(Number(row.dataset.slashIndex));
    }

    function attach() {
      if (disposed || attached || !registry || !doc) return dispose;
      input = getInput();
      if (!input) return dispose;
      attached = true;
      input.addEventListener('input', refresh);
      // No blur listener on purpose: a mousedown on a row blurs the textarea
      // before `click` fires, and a display:none popover never receives it.
      // Outside clicks close via the capture-phase pointerdown below.
      doc.addEventListener('keydown', handleKeydown, true);
      doc.addEventListener('pointerdown', handlePointer, true);
      return dispose;
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (attached) {
        input?.removeEventListener('input', refresh);
        doc?.removeEventListener('keydown', handleKeydown, true);
        doc?.removeEventListener('pointerdown', handlePointer, true);
      }
      popover?.removeEventListener('click', handleClick);
      popover?.remove();
      attached = false;
      hide();
    }

    return { attach, dispose, isOpen: () => open, refresh };
  }

  return { MAX_ROWS, TRIGGER_RE, createSlashAutocomplete };
});
