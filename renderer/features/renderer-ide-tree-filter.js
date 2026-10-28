/* renderer/features/renderer-ide-tree-filter.js - Files-header name filter.
 * A toggle in the tree header opens a search-bar under it; rows are filtered
 * among what the tree already renders (root + expanded, cached directories),
 * never triggering new listings. A file shows iff its name matches; a
 * directory shows iff its name matches or a rendered descendant does. State is
 * runtime-only. The tree owns the panel's innerHTML, so the bar element is
 * re-mounted into a placeholder after every markup swap (beforeSwap/afterSwap). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTreeFilter = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const DEBOUNCE_MS = 100;
  const HIT_CLASS = 'ide-tree-filter-hit';
  const HOST_ATTR = 'data-ide-tree-filter-host';
  const FUNNEL_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M2.5 3h11l-4.2 5v4.5l-2.6 1.3V8z"/></svg>';

  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  function createIdeTreeFilter(deps) {
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const getMountEl = typeof deps?.getMountEl === 'function' ? deps.getMountEl : () => null;
    const escapeHtml = typeof deps?.escapeHtml === 'function' ? deps.escapeHtml : (value) => String(value);
    const childrenByDir = deps?.childrenByDir || new Map();
    const getFocusedPath = typeof deps?.getFocusedPath === 'function' ? deps.getFocusedPath : () => '';
    const setFocusedPath = typeof deps?.setFocusedPath === 'function' ? deps.setFocusedPath : noop;
    const selection = deps?.selection || {};
    const render = typeof deps?.render === 'function' ? deps.render : noop;
    const searchBarModule = resolveModule('inventorySearchBar', '../inventory/search-bar');

    let isOpenFlag = false;
    let query = '';
    let caseSensitive = false;
    let wholeWord = false;
    let pattern = null; // RegExp for the active query, else null
    let visible = null; // Set of rendered paths that stay visible while filtering
    let matchCount = 0;
    let currentIndex = 0; // 1-based position of the last navigated match
    let currentPath = '';
    let wantFocus = false;
    let timer = null;
    // An open IME composition in the bar input: the debounced re-render swaps
    // the tree markup (detaching the input), so it waits for compositionend.
    let composing = false;
    let bar = null;
    let barRoot = null;

    function buildPattern() {
      if (!query) return null;
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const word = '[\\p{L}\\p{N}_]';
      const source = wholeWord ? `(?<!${word})${escaped}(?!${word})` : escaped;
      try {
        return new RegExp(source, `gu${caseSensitive ? '' : 'i'}`);
      } catch (_error) {
        return null;
      }
    }

    function nameMatches(name) {
      pattern.lastIndex = 0;
      return pattern.test(name);
    }

    // Recomputed once per tree render (markup calls it first): the set of
    // visible paths over the cached, expanded subtree.
    function prepare() {
      pattern = isOpenFlag ? buildPattern() : null;
      visible = null;
      matchCount = 0;
      if (!pattern) return;
      visible = new Set();
      const expanded = getIde().expandedDirs;
      const visit = (dirPath) => {
        let any = false;
        for (const entry of childrenByDir.get(dirPath) || []) {
          let show;
          if (entry.kind === 'directory') {
            const childHit = expanded?.has(entry.relPath) && childrenByDir.has(entry.relPath)
              ? visit(entry.relPath) : false;
            show = nameMatches(entry.name) || childHit;
          } else {
            show = nameMatches(entry.name);
            if (show) matchCount += 1;
          }
          if (show) {
            visible.add(entry.relPath);
            any = true;
          }
        }
        return any;
      };
      visit('');
    }

    function isVisible(relPath) {
      return !visible || visible.has(relPath);
    }

    function isActive() {
      return Boolean(pattern);
    }

    // Name HTML with the matched substrings wrapped; everything is escaped.
    function decorateName(name) {
      const text = String(name || '');
      if (!pattern) return escapeHtml(text);
      pattern.lastIndex = 0;
      let html = '';
      let last = 0;
      let match = pattern.exec(text);
      while (match && match[0]) {
        html += `${escapeHtml(text.slice(last, match.index))}<mark class="${HIT_CLASS}">${escapeHtml(match[0])}</mark>`;
        last = match.index + match[0].length;
        match = pattern.exec(text);
      }
      return html ? html + escapeHtml(text.slice(last)) : escapeHtml(text);
    }

    function headerButtonOptions() {
      const title = jt('ide.tree.filterFiles', 'Filter Files');
      return {
        className: `ide-tree-header-button ide-tree-filter-toggle${isOpenFlag ? ' ide-tree-filter-toggle--active' : ''}`,
        ariaLabel: title, title, ariaPressed: isOpenFlag, trustedHtml: FUNNEL_SVG,
        dataset: { 'ide-tree-action': 'toggle-filter' },
      };
    }

    function hostMarkup() {
      return isOpenFlag ? `<div class="ide-tree-filter" ${HOST_ATTR}></div>` : '';
    }

    function matchRows() {
      const panel = getMountEl();
      if (!panel) return [];
      return [...panel.querySelectorAll('[data-ide-tree-path]')].filter((row) => (
        row.dataset.ideTreeKind !== 'directory' && row.querySelector(`mark.${HIT_CLASS}`)
      ));
    }

    function navigate(step) {
      const rows = matchRows();
      if (!rows.length) return;
      const found = rows.findIndex((row) => row.dataset.ideTreePath === currentPath);
      const index = found === -1 ? (step > 0 ? -1 : 0) : found;
      const target = rows[(index + step + rows.length) % rows.length].dataset.ideTreePath;
      currentPath = target;
      currentIndex = rows.findIndex((row) => row.dataset.ideTreePath === target) + 1;
      setFocusedPath(target);
      selection.replace?.([target], target);
      render();
      const row = matchRows().find((candidate) => candidate.dataset.ideTreePath === target);
      row?.scrollIntoView?.({ block: 'nearest' });
      if (bar) syncCount(bar);
    }

    function queryChanged() {
      currentIndex = 0;
      currentPath = '';
      render();
    }

    function scheduleQuery() {
      if (timer !== null) clearTimeout(timer);
      if (composing) return;
      timer = setTimeout(() => {
        timer = null;
        query = bar ? bar.getQuery() : '';
        queryChanged();
      }, DEBOUNCE_MS);
    }

    function watchComposition(input) {
      if (!input || input.__jennyTreeFilterIme) return;
      input.__jennyTreeFilterIme = true;
      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => { composing = false; scheduleQuery(); });
    }

    // The primitive has no blank state: an empty query shows no count at all.
    function syncCount(current) {
      current.setMatchInfo(currentIndex || 1, matchCount);
      const countEl = barRoot?.querySelector('.chat-search-bar-count');
      if (countEl && !pattern) countEl.textContent = '';
    }

    function ensureBar() {
      if (bar) return bar;
      const factory = searchBarModule.createSearchBar;
      const doc = getMountEl()?.ownerDocument;
      if (typeof factory !== 'function' || !doc) return null;
      bar = factory({ document: doc, hostId: 'ide-tree-filter' });
      bar.on('input', scheduleQuery);
      bar.on('next', () => navigate(1));
      bar.on('prev', () => navigate(-1));
      bar.on('close', () => close());
      bar.on('toggle-case', (value) => { caseSensitive = value === true; queryChanged(); });
      bar.on('toggle-word', (value) => { wholeWord = value === true; queryChanged(); });
      return bar;
    }

    // Focus handling around the tree's innerHTML swap: the bar element is
    // detached by it, so remember whether focus lived in the bar.
    function ownsFocus(activeElement) {
      return Boolean(activeElement && barRoot && barRoot.contains(activeElement));
    }

    function beforeSwap() {
      if (ownsFocus(getMountEl()?.ownerDocument?.activeElement)) wantFocus = true;
    }

    function afterSwap(panel) {
      if (!isOpenFlag) return;
      const host = panel.querySelector(`[${HOST_ATTR}]`);
      const current = host ? ensureBar() : null;
      if (!current) return;
      current.mount(host);
      barRoot = host.firstElementChild;
      barRoot.classList.add('ide-tree-filter-bar');
      barRoot.setAttribute('aria-label', jt('ide.tree.filterBarLabel', 'Filter files'));
      const input = barRoot.querySelector('input');
      input?.setAttribute('aria-label', jt('ide.tree.filterInputLabel', 'Filter files by name'));
      input?.setAttribute('placeholder', jt('ide.tree.filterPlaceholder', 'Filter files by name'));
      watchComposition(input);
      syncCount(current);
      if (wantFocus) {
        wantFocus = false;
        current.focusInput(false);
      }
    }

    function open() {
      wantFocus = true;
      isOpenFlag = true;
      render();
      // Already open and mounted: the render above is a no-op, so focus here.
      if (barRoot?.isConnected) {
        wantFocus = false;
        bar.focusInput(true);
      }
    }

    function focusTree() {
      const panel = getMountEl();
      (panel?.querySelector('[data-ide-tree-path][tabindex="0"]')
        || panel?.querySelector('[data-ide-tree-path]'))?.focus();
    }

    function resetState() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      isOpenFlag = false;
      query = '';
      currentIndex = 0;
      currentPath = '';
      wantFocus = false;
      composing = false;
      bar?.setQuery('');
      bar?.unmount();
      barRoot = null;
    }

    function close() {
      const hadFocus = ownsFocus(getMountEl()?.ownerDocument?.activeElement);
      resetState();
      render();
      if (hadFocus) focusTree();
    }

    function toggle() {
      if (isOpenFlag) close();
      else open();
    }

    // Root change: the old query describes rows that no longer exist.
    function reset() {
      resetState();
    }

    function dispose() {
      resetState();
      bar?.dispose();
      bar = null;
    }

    return {
      isOpen: () => isOpenFlag,
      isActive,
      getQuery: () => query,
      prepare,
      isVisible,
      decorateName,
      headerButtonOptions,
      hostMarkup,
      beforeSwap,
      afterSwap,
      ownsFocus: () => ownsFocus(getMountEl()?.ownerDocument?.activeElement),
      open,
      close,
      toggle,
      reset,
      dispose,
    };
  }

  return { createIdeTreeFilter };
});
