/* renderer/shell/renderer-command-palette-render.js — UMD
 *
 * Row construction + a keyed reconciler for the ⌘K / Ctrl+K palette list.
 *
 * Rows are keyed and reused.
 *
 * Rows are div elements carrying role="option" rather than form buttons. A
 * button is not a valid listbox option, focus stays on the combobox input at
 * all times (aria-activedescendant does the pointing).
 *
 * Optional DOM dependencies must no-op when absent.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererCommandPaletteRender = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 16x16 stroke glyphs, hand-written constants — never interpolated. Inline
     SVG (stroke: currentColor) keeps them CSP-proof on file:// with no
     @font-face and no fetched asset, same rationale as renderer-ide-icons.js. */
  const GLYPH_BODIES = {
    search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="m10.4 10.4 3 3"/>',
    arrow: '<path d="M3 8h9"/><path d="m8.5 4.5 3.5 3.5-3.5 3.5"/>',
    chat: '<path d="M2.5 4.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7L4 13v-2.5h-.5a1 1 0 0 1-1-1z"/>',
    action: '<path d="M9 2 4 9h3.5L7 14l5-7H8.5z"/>',
    code: '<path d="M6 5 3 8l3 3"/><path d="m10 5 3 3-3 3"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 3v1.6M8 11.4V13M3 8h1.6M11.4 8H13M4.5 4.5l1.1 1.1M10.4 10.4l1.1 1.1M11.5 4.5l-1.1 1.1M5.6 10.4l-1.1 1.1"/>',
    plug: '<path d="M6 2v3M10 2v3"/><path d="M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0z"/><path d="M8 11v3"/>',
    undo: '<path d="M3 7h6.5a3 3 0 0 1 0 6H6"/><path d="m5.5 4.5-2.5 2.5 2.5 2.5"/>',
    slash: '<path d="m4 5 3 3-3 3"/><path d="M8.5 11H12"/>',
    help: '<circle cx="8" cy="8" r="5.5"/><path d="M6.5 6.3a1.6 1.6 0 1 1 1.9 1.7v1"/><path d="M8.3 11.3h.01"/>',
  };

  const GLYPH_OPEN = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">';

  function glyphMarkup(name) {
    const body = GLYPH_BODIES[name] || GLYPH_BODIES.action;
    return GLYPH_OPEN + body + '</svg>';
  }

  const LEGEND_DEFAULT = '↑↓ move · ↵ open · tab scope · esc close';
  const LEGEND_SCOPED = '↑↓ move · ↵ open · ⌫ clear scope · esc close';

  function createPaletteRenderer(deps) {
    const {
      documentRef: injectedDocument = null,
      listEl = null,
      scopeEl = null,
      countEl = null,
      legendEl = null,
      statusEl = null,
      fieldIconEl = null,
      escapeHtml = (value) => String(value || ''),
      highlightRanges = (text) => String(text || ''),
    } = deps || {};

    // Create nodes in the document that actually OWNS the list, not whatever
    // ambient global happens to be set: a harness can mount the palette in a
    // JSDOM document without making it globalThis.document, and elements built
    // from a foreign document never render.
    const documentRef = (listEl && listEl.ownerDocument) || injectedDocument;

    const rowById = new Map();
    const headerByGroup = new Map();
    let emptyEl = null;
    let activeEl = null;

    if (fieldIconEl && !fieldIconEl.innerHTML) {
      fieldIconEl.innerHTML = glyphMarkup('search');
    }

    function el(tag, className) {
      const node = documentRef.createElement(tag);
      if (className) node.className = className;
      return node;
    }

    function buildRow(item) {
      const row = el('div', 'command-palette-item');
      row.setAttribute('role', 'option');
      row.setAttribute('tabindex', '-1');
      const icon = el('span', 'command-palette-item-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = glyphMarkup(item.icon);
      const text = el('span', 'command-palette-item-text');
      const label = el('span', 'command-palette-item-label');
      const description = el('span', 'command-palette-item-description');
      text.append(label, description);
      const trailing = el('span', 'command-palette-item-trailing');
      row.append(icon, text, trailing);
      row._paletteParts = { icon, label, description, trailing, iconName: item.icon };
      return row;
    }

    // Only writes what actually changed: on a keystroke the highlight ranges
    // move but the icon, tag, and description text usually do not.
    function updateRow(row, entry, index, query) {
      const item = entry.item;
      const parts = row._paletteParts;
      const optionId = 'command-palette-option-' + index;
      if (row.id !== optionId) row.id = optionId;
      if (row.getAttribute('data-palette-index') !== String(index)) {
        row.setAttribute('data-palette-index', String(index));
      }
      if (row.getAttribute('data-palette-id') !== item.id) {
        row.setAttribute('data-palette-id', item.id);
      }
      if (item.disabled) {
        row.classList.add('command-palette-item--disabled');
        row.setAttribute('aria-disabled', 'true');
      } else {
        row.classList.remove('command-palette-item--disabled');
        row.removeAttribute('aria-disabled');
      }
      if (parts.iconName !== item.icon) {
        parts.icon.innerHTML = glyphMarkup(item.icon);
        parts.iconName = item.icon;
      }
      const labelHtml = query
        ? highlightRanges(item.label, entry.labelRanges, escapeHtml)
        : escapeHtml(item.label);
      if (parts.label.innerHTML !== labelHtml) parts.label.innerHTML = labelHtml;

      const rawDescription = String(item.description || '');
      const descriptionHtml = rawDescription
        ? ' · ' + ((query && entry.descriptionRanges && entry.descriptionRanges.length)
          ? highlightRanges(rawDescription, entry.descriptionRanges, escapeHtml)
          : escapeHtml(rawDescription))
        : '';
      if (parts.description.innerHTML !== descriptionHtml) parts.description.innerHTML = descriptionHtml;

      // A real shortcut wins over the type word; never both.
      const trailingText = item.hint ? String(item.hint) : String(item.tag || '');
      const trailingIsKbd = Boolean(item.hint);
      if (parts.trailing.textContent !== trailingText
        || parts.trailing.classList.contains('command-palette-item-trailing--kbd') !== trailingIsKbd) {
        parts.trailing.textContent = trailingText;
        parts.trailing.classList.toggle('command-palette-item-trailing--kbd', trailingIsKbd);
        parts.trailing.classList.toggle('kbd', trailingIsKbd);
      }
    }

    function buildHeader(groupName) {
      const header = el('div', 'command-palette-group-label');
      header.setAttribute('aria-hidden', 'true');
      const text = el('span', 'kicker kicker--md');
      text.textContent = groupName;
      header.append(text);
      return header;
    }

    function clearEmpty() {
      if (emptyEl && emptyEl.parentNode) emptyEl.parentNode.removeChild(emptyEl);
      emptyEl = null;
    }

    function renderEmpty(query) {
      reconcile([], false, '');
      clearEmpty();
      emptyEl = el('div', 'command-palette-empty');
      const claim = el('p', 'empty-state-claim');
      claim.textContent = query ? 'No matches for “' + String(query) + '”' : 'Nothing to show yet.';
      emptyEl.append(claim);
      listEl.append(emptyEl);
      activeEl = null;
    }

    /* Reuse by key, reorder with a cursor, drop what's unused. Returns nothing;
       the controller reads row identity back through the list when it needs to. */
    function reconcile(entries, grouped, query) {
      const usedRows = new Set();
      const usedHeaders = new Set();
      let cursor = listEl.firstChild;
      let lastGroup = null;

      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const groupName = entry.item.group;
        if (grouped && groupName !== lastGroup) {
          let header = headerByGroup.get(groupName);
          if (!header) {
            header = buildHeader(groupName);
            headerByGroup.set(groupName, header);
          }
          usedHeaders.add(groupName);
          if (header !== cursor) listEl.insertBefore(header, cursor);
          else cursor = header.nextSibling;
          lastGroup = groupName;
        }
        let row = rowById.get(entry.item.id);
        if (!row) {
          row = buildRow(entry.item);
          rowById.set(entry.item.id, row);
        }
        usedRows.add(entry.item.id);
        updateRow(row, entry, index, query);
        if (row !== cursor) listEl.insertBefore(row, cursor);
        else cursor = row.nextSibling;
      }

      rowById.forEach((row, id) => {
        if (!usedRows.has(id)) {
          if (row.parentNode) row.parentNode.removeChild(row);
          rowById.delete(id);
        }
      });
      headerByGroup.forEach((header, name) => {
        if (!usedHeaders.has(name)) {
          if (header.parentNode) header.parentNode.removeChild(header);
          headerByGroup.delete(name);
        }
      });
    }

    function render(model) {
      if (!listEl || !documentRef) return;
      const entries = Array.isArray(model.entries) ? model.entries : [];
      if (!entries.length) {
        renderEmpty(model.query);
      } else {
        clearEmpty();
        reconcile(entries, model.grouped === true, model.query);
      }
      writeChrome(model);
    }

    function writeChrome(model) {
      const total = Number(model.totalCount) || 0;
      if (countEl) {
        countEl.textContent = total === 1 ? '1 result' : String(total) + ' results';
      }
      if (legendEl) {
        legendEl.textContent = model.scopeLabel ? LEGEND_SCOPED : LEGEND_DEFAULT;
      }
      if (scopeEl) {
        scopeEl.textContent = model.scopeLabel || '';
        scopeEl.classList.toggle('hidden', !model.scopeLabel);
      }
      // The count, not the list, is what changes meaningfully per keystroke —
      // aria-live on the listbox itself re-announced every row every time.
      if (statusEl) {
        statusEl.textContent = total === 1 ? '1 result' : String(total) + ' results';
      }
    }

    /* Exactly two nodes touched per arrow press, not every row in the list. */
    function setActive(index, scrollBehavior) {
      if (!listEl) return '';
      const next = listEl.querySelector('[data-palette-index="' + String(index) + '"]');
      if (activeEl && activeEl !== next) {
        activeEl.classList.remove('command-palette-item--active');
        activeEl.removeAttribute('aria-selected');
      }
      activeEl = next || null;
      if (!activeEl) return '';
      activeEl.classList.add('command-palette-item--active');
      activeEl.setAttribute('aria-selected', 'true');
      if (typeof activeEl.scrollIntoView === 'function') {
        activeEl.scrollIntoView({ block: 'nearest', behavior: scrollBehavior || 'auto' });
      }
      return activeEl.id || '';
    }

    function reset() {
      if (listEl) {
        while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      }
      rowById.clear();
      headerByGroup.clear();
      emptyEl = null;
      activeEl = null;
      if (countEl) countEl.textContent = '';
      if (statusEl) statusEl.textContent = '';
      if (scopeEl) {
        scopeEl.textContent = '';
        scopeEl.classList.add('hidden');
      }
    }

    return { render, setActive, reset, glyphMarkup };
  }

  return {
    createPaletteRenderer,
    glyphMarkup,
    GLYPH_BODIES,
    LEGEND_DEFAULT,
    LEGEND_SCOPED,
  };
});
