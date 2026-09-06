/** Anchored listbox primitive with filtering, roving active option, typeahead,
 * viewport clamping, and caller-owned overlay registration. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.inventoryAnchoredListbox = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var instanceCounter = 0;

  function safeToken(value, fallback) {
    var token = String(value || '').trim().replace(/[^A-Za-z0-9_-]+/g, '-');
    return token || fallback;
  }

  function normalizeItems(value) {
    if (!Array.isArray(value)) return [];
    return value.map(function (item, index) {
      var source = item && typeof item === 'object' ? item : {};
      return {
        id: String(source.id || index),
        label: String(source.label || ''),
        meta: String(source.meta || ''),
        searchText: String(source.searchText || source.label || '').toLowerCase(),
        // Trusted static/sanitized markup only. Labels, metadata, and search
        // text remain text-only below.
        trustedGlyphHtml: typeof source.trustedGlyphHtml === 'string' ? source.trustedGlyphHtml : '',
        selected: source.selected === true,
        disabled: source.disabled === true,
        value: source.value == null ? source.id : source.value,
      };
    });
  }

  function createAnchoredListbox(opts) {
    var options = opts || {};
    var doc = options.documentRef || (typeof document !== 'undefined' ? document : null);
    if (!doc || !doc.body) return null;
    var win = doc.defaultView || globalThis;
    var instanceId = safeToken(options.id, 'inv-listbox-' + (++instanceCounter));
    var rootEl = doc.createElement('div');
    rootEl.className = 'inv-anchored-listbox' + (options.className ? ' ' + String(options.className) : '');
    rootEl.id = instanceId;

    var listEl = doc.createElement('div');
    listEl.className = 'inv-anchored-listbox-options';
    listEl.id = instanceId + '-options';
    listEl.setAttribute('role', 'listbox');
    listEl.setAttribute('aria-label', String(options.ariaLabel || 'Options'));
    listEl.tabIndex = 0;

    var allItems = normalizeItems(options.items);
    var visibleItems = allItems.slice();
    var activeIndex = Math.max(0, visibleItems.findIndex(function (item) { return item.selected && !item.disabled; }));
    var filterInput = null;
    var destroyed = false;
    var typeBuffer = '';
    var typeTimer = null;

    function activeDescendantId() {
      return visibleItems[activeIndex] ? instanceId + '-option-' + activeIndex : '';
    }

    function syncActiveDescendant() {
      var id = activeDescendantId();
      if (id) listEl.setAttribute('aria-activedescendant', id);
      else listEl.removeAttribute('aria-activedescendant');
      if (filterInput) {
        if (id) filterInput.setAttribute('aria-activedescendant', id);
        else filterInput.removeAttribute('aria-activedescendant');
      }
    }

    function renderRows() {
      listEl.textContent = '';
      if (!visibleItems.length) {
        var empty = doc.createElement('div');
        empty.className = 'inv-anchored-listbox-empty';
        empty.textContent = String(options.emptyLabel || 'No matching options');
        listEl.appendChild(empty);
        activeIndex = -1;
        syncActiveDescendant();
        return;
      }
      if (activeIndex < 0 || activeIndex >= visibleItems.length || visibleItems[activeIndex].disabled) {
        activeIndex = visibleItems.findIndex(function (item) { return !item.disabled; });
      }
      visibleItems.forEach(function (item, index) {
        var row = doc.createElement('div');
        row.id = instanceId + '-option-' + index;
        row.className = 'inv-anchored-listbox-option' + (index === activeIndex ? ' is-active' : '');
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', item.selected ? 'true' : 'false');
        row.setAttribute('data-inv-listbox-index', String(index));
        if (item.disabled) row.setAttribute('aria-disabled', 'true');

        var glyph = doc.createElement('span');
        glyph.className = 'inv-anchored-listbox-option-glyph';
        glyph.setAttribute('aria-hidden', 'true');
        glyph.innerHTML = item.trustedGlyphHtml;
        var label = doc.createElement('span');
        label.className = 'inv-anchored-listbox-option-label';
        label.textContent = item.label;
        var meta = doc.createElement('span');
        meta.className = 'inv-anchored-listbox-option-meta';
        meta.textContent = item.meta;
        row.appendChild(glyph);
        row.appendChild(label);
        row.appendChild(meta);
        listEl.appendChild(row);
      });
      syncActiveDescendant();
    }

    function setActive(nextIndex, scroll, direction) {
      if (!visibleItems.length) return;
      var count = visibleItems.length;
      var index = nextIndex;
      var stepDirection = direction === -1 ? -1 : 1;
      for (var step = 0; step < count; step += 1) {
        index = (index + count) % count;
        if (!visibleItems[index].disabled) break;
        index += stepDirection;
      }
      if (!visibleItems[index] || visibleItems[index].disabled) return;
      activeIndex = index;
      var rows = listEl.querySelectorAll('.inv-anchored-listbox-option');
      for (var i = 0; i < rows.length; i += 1) rows[i].classList.toggle('is-active', i === activeIndex);
      syncActiveDescendant();
      if (scroll !== false && rows[activeIndex]?.scrollIntoView) rows[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    function selectActive() {
      var item = visibleItems[activeIndex];
      if (!item || item.disabled || typeof options.onSelect !== 'function') return;
      options.onSelect(item.value, item);
    }

    function applyFilter(value) {
      var query = String(value || '').trim().toLowerCase();
      visibleItems = query
        ? allItems.filter(function (item) { return item.searchText.includes(query); })
        : allItems.slice();
      activeIndex = Math.max(0, visibleItems.findIndex(function (item) { return item.selected && !item.disabled; }));
      renderRows();
    }

    function handleKeydown(event) {
      if (event.isComposing) return;
      var key = event.key;
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Home' || key === 'End') {
        event.preventDefault();
        if (key === 'Home') setActive(0, true, 1);
        else if (key === 'End') setActive(visibleItems.length - 1, true, -1);
        else {
          var direction = key === 'ArrowDown' ? 1 : -1;
          setActive(activeIndex + direction, true, direction);
        }
        return;
      }
      if (key === 'Enter') {
        event.preventDefault();
        selectActive();
        return;
      }
      if (key === 'Escape' && typeof options.onEscape === 'function') {
        event.preventDefault();
        options.onEscape();
        return;
      }
      if (!filterInput && key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        typeBuffer += key.toLowerCase();
        if (typeTimer) win.clearTimeout(typeTimer);
        typeTimer = win.setTimeout(function () { typeBuffer = ''; }, 700);
        var match = visibleItems.findIndex(function (item) { return !item.disabled && item.label.toLowerCase().startsWith(typeBuffer); });
        if (match >= 0) setActive(match, true, 1);
      }
    }

    function handleClick(event) {
      var row = event.target.closest && event.target.closest('[data-inv-listbox-index]');
      if (!row || !rootEl.contains(row)) return;
      var index = Number(row.getAttribute('data-inv-listbox-index'));
      if (!Number.isInteger(index) || visibleItems[index]?.disabled) return;
      setActive(index, false, 1);
      selectActive();
    }

    var configuredThreshold = Number(options.filterThreshold);
    var filterThreshold = Number.isFinite(configuredThreshold) && configuredThreshold >= 0 ? configuredThreshold : 8;
    if (allItems.length > filterThreshold) {
      filterInput = doc.createElement('input');
      filterInput.type = 'search';
      filterInput.className = 'inv-anchored-listbox-filter';
      filterInput.placeholder = String(options.filterPlaceholder || 'Filter options');
      filterInput.setAttribute('aria-label', String(options.filterAriaLabel || options.filterPlaceholder || 'Filter options'));
      filterInput.setAttribute('aria-controls', listEl.id);
      filterInput.addEventListener('input', function () { applyFilter(filterInput.value); });
      rootEl.appendChild(filterInput);
    }
    rootEl.appendChild(listEl);
    rootEl.addEventListener('keydown', handleKeydown);
    rootEl.addEventListener('click', handleClick);
    doc.body.appendChild(rootEl);
    renderRows();

    function position(anchorEl) {
      var anchor = anchorEl && typeof anchorEl.getBoundingClientRect === 'function'
        ? anchorEl.getBoundingClientRect()
        : { left: 0, bottom: 0, width: 0 };
      var margin = 4;
      var requestedWidth = Number(options.width || anchor.width || 0);
      var viewportWidth = Number(win.innerWidth);
      var availableWidth = Number.isFinite(viewportWidth) ? Math.max(0, viewportWidth - (margin * 2)) : requestedWidth;
      if (requestedWidth > 0) rootEl.style.width = Math.round(Math.min(requestedWidth, availableWidth)) + 'px';
      var rect = rootEl.getBoundingClientRect();
      var viewportHeight = Number(win.innerHeight);
      var maxLeft = Number.isFinite(viewportWidth) ? viewportWidth - rect.width - margin : anchor.left;
      var maxTop = Number.isFinite(viewportHeight) ? viewportHeight - rect.height - margin : anchor.bottom + margin;
      var left = Math.max(margin, Math.min(anchor.left, maxLeft));
      var top = Math.max(margin, Math.min(anchor.bottom + margin, maxTop));
      rootEl.style.left = Math.round(left) + 'px';
      rootEl.style.top = Math.round(top) + 'px';
    }

    function focus() {
      var target = filterInput || listEl;
      try { target.focus({ preventScroll: true }); } catch (_error) { target.focus(); }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (typeTimer) win.clearTimeout(typeTimer);
      rootEl.removeEventListener('keydown', handleKeydown);
      rootEl.removeEventListener('click', handleClick);
      if (rootEl.parentNode) rootEl.parentNode.removeChild(rootEl);
    }

    return { root: rootEl, list: listEl, focus: focus, position: position, destroy: destroy, applyFilter: applyFilter };
  }

  return { createAnchoredListbox: createAnchoredListbox };
});
