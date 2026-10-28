/* renderer/features/renderer-ide-outline-view.js - the Workspace Outline view (row 82 O1;
 * docs/plans/IDE_VSCODE_PARITY_2026-10-26.md 7.6).
 *
 * The active editor's symbols as a tree in the explorer's row grammar (the
 * `.ide-tree-header` / `.ide-tree-row` classes; no stylesheet of its own). It follows the
 * cursor (the innermost symbol holding the caret is the active row and its ancestors
 * open), reveals a symbol on click or Enter, offers Collapse All and sort by position or
 * name. Symbols come from renderer-ide-outline-providers.js: TS/JS through the navigation
 * tree renderer-ide-symbol-nav.js already caches, other languages from bounded scanners.
 *
 * Self-contained: it renders into the workbench's `outline` view host only while that
 * view is visible, does no work while hidden beyond marking itself stale, and
 * self-subscribes to ide:active-file-changed and ide:workspace-root-committed. The
 * controller feeds the cursor choke point (noteCursor) and the layout calls render(). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeOutlineView = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  const CURSOR_DEBOUNCE_MS = 90;
  const TYPING_DEBOUNCE_MS = 400;
  const MAX_REMEMBERED_FILES = 50;
  const SORT_MODES = ['position', 'name'];

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  // The explorer header's sort and collapse glyphs (loaded earlier on the IDE manifest).
  const { sort: SORT_SVG, collapse: COLLAPSE_SVG } = resolveModule('rendererIdeTreeMarkup', './renderer-ide-tree-markup').HEADER_GLYPHS;

  function kindLabel(kind, symbolNav) {
    switch (kind) {
      case 'heading': return jt('ide.outline.kind.heading', 'heading');
      case 'key': return jt('ide.outline.kind.key', 'key');
      case 'object':
      case 'array': return jt('ide.outline.kind.item', 'item');
      case 'selector': return jt('ide.outline.kind.selector', 'selector');
      case 'at-rule': return jt('ide.outline.kind.atRule', 'at-rule');
      default: return typeof symbolNav.symbolKindLabel === 'function' ? symbolNav.symbolKindLabel(kind) : String(kind || '');
    }
  }

  function createIdeOutlineView(deps) {
    const d = deps || {};
    const viewDeps = () => (typeof d.getViewDeps === 'function' ? d.getViewDeps() : null) || {};
    const getMountEl = () => (typeof viewDeps().getMountEl === 'function' ? viewDeps().getMountEl() : null);
    const isVisible = () => typeof viewDeps().isActivePanel === 'function' && viewDeps().isActivePanel() === true;
    const editorHost = d.editorHost || null;
    const getSymbolNav = typeof d.getSymbolNav === 'function' ? d.getSymbolNav : () => null;
    const windowRef = d.windowRef || globalRef.window || globalRef;
    const appendClientLog = typeof d.appendClientLog === 'function' ? d.appendClientLog : () => {};
    const setTimeoutFn = typeof d.setTimeoutFn === 'function' ? d.setTimeoutFn : (typeof setTimeout === 'function' ? setTimeout : null);
    const clearTimeoutFn = typeof d.clearTimeoutFn === 'function' ? d.clearTimeoutFn : (typeof clearTimeout === 'function' ? clearTimeout : null);
    const providers = d.providers || resolveModule('rendererIdeOutlineProviders', './renderer-ide-outline-providers');
    const symbolNavUtils = resolveModule('rendererIdeSymbolNav', './renderer-ide-symbol-nav');
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const escapeHtml = typeof d.escapeHtml === 'function'
      ? d.escapeHtml
      : (globalRef.stringUtils || resolveModule('stringUtils', '../shared/string-utils')).escapeHtml;

    // doc = { path, version, status, symbols, truncated }; status: none | unsupported | loading | too-large | ready.
    let doc = { path: '', version: null, status: 'none', symbols: [], truncated: '' };
    let sortMode = 'position';
    let sorted = null; // { symbols, mode, list } cache for the paint
    const collapsedByPath = new Map();
    let activeKey = '';
    let focusedKey = '';
    let revealActive = false;
    let stale = true;
    let timer = null;
    let generation = 0;
    let inflight = ''; // `${path}@${version}` of the navigation-tree request in flight
    let lastMarkup = '';
    let boundHost = null;
    let disposed = false;
    let byKey = new Map();
    let modelWatch = null; // { model, subscription }: content changes of the followed model (O3)

    function logError(site, error) {
      try { appendClientLog('WARN', 'ide.outline_failed', { site, message: String(error?.message || error || '') }); } catch (_error) { /* logging must not throw */ }
    }

    // The editor the Outline follows: a focused secondary group's file, else the primary's.
    function activePath() {
      return String(editorHost?.getFocusedPath?.() || editorHost?.getActivePath?.() || '');
    }

    function cursorLine() {
      const info = editorHost?.getFocusedCursorInfo?.() || editorHost?.getCursorInfo?.() || null;
      return Number(info?.lineNumber) || 0;
    }

    function collapsedFor(path) {
      let set = collapsedByPath.get(path);
      if (!set) {
        set = new Set();
        collapsedByPath.set(path, set);
        while (collapsedByPath.size > MAX_REMEMBERED_FILES) collapsedByPath.delete(collapsedByPath.keys().next().value);
      }
      return set;
    }

    /* ---------------------------------------------------------------- symbols */

    // The text a provider reads: at most MAX_TEXT_CHARS, cut in the model (no full copy).
    function boundedText(model) {
      const cap = providers.MAX_TEXT_CHARS || 1024 * 1024;
      const length = typeof model.getValueLength === 'function' ? model.getValueLength() : -1;
      if (length > cap && typeof model.getPositionAt === 'function' && typeof model.getValueInRange === 'function') {
        const end = model.getPositionAt(cap);
        return { text: model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: 1 }), cut: true };
      }
      return { text: String(model.getValue?.() || ''), cut: false };
    }

    function setDoc(next) {
      doc = next;
      sorted = null;
    }

    // Typing that moves no caret (a paste below it, another group's edit) still re-scans.
    function watchModel(model) {
      if (modelWatch?.model === model) return;
      try { modelWatch?.subscription?.dispose?.(); } catch (_error) { /* already gone */ }
      modelWatch = null;
      if (!model || typeof model.onDidChangeContent !== 'function') return;
      const subscription = model.onDidChangeContent(() => {
        if (disposed) return;
        if (isVisible()) schedule(TYPING_DEBOUNCE_MS);
        else stale = true;
      });
      modelWatch = { model, subscription };
    }

    async function loadNavigationTree(path, model, version) {
      const token = generation;
      const want = `${path}@${version}`;
      inflight = want;
      const nav = getSymbolNav();
      let tree = null;
      try {
        tree = nav && typeof nav.getNavigationTree === 'function' ? await nav.getNavigationTree(path) : null;
      } catch (error) {
        logError('navigation_tree', error);
      }
      if (inflight === want) inflight = '';
      if (disposed || token !== generation || activePath() !== path || model.getVersionId?.() !== version) return;
      const out = providers.outlineFromNavigationTree(tree, (offset) => model.getPositionAt(offset), {});
      // No tree yet (the worker is still starting): show empty and fetch again on the next activity.
      setDoc({ path, version: tree ? version : null, status: 'ready', symbols: out.symbols, truncated: out.truncated });
      updateActive();
      paint();
    }

    function refresh() {
      if (timer && clearTimeoutFn) clearTimeoutFn(timer);
      timer = null;
      if (disposed) return;
      stale = false;
      try {
        refreshNow();
      } catch (error) {
        logError('refresh', error);
      }
    }

    function refreshNow() {
      const path = activePath();
      // Text documents only: diff, preview, PDF and image tabs have no outline.
      const kind = path && typeof editorHost?.getDocumentKind === 'function' ? editorHost.getDocumentKind(path) : 'file';
      const model = path && kind === 'file' ? editorHost?.getModel?.(path) || null : null;
      watchModel(model);
      if (!model) {
        generation += 1;
        inflight = '';
        setDoc({ path: '', version: null, status: 'none', symbols: [], truncated: '' });
        activeKey = '';
        paint();
        return;
      }
      const version = typeof model.getVersionId === 'function' ? model.getVersionId() : null;
      // Current symbols, or the worker already asked for this version: only the caret moved.
      if ((doc.path === path && doc.version !== null && doc.version === version) || inflight === `${path}@${version}`) {
        updateActive();
        paint();
        return;
      }
      const languageId = String(editorHost?.getFocusedLanguageId?.() || editorHost?.getActiveLanguageId?.() || model.getLanguageId?.() || '');
      const provider = providers.providerFor(languageId, path);
      generation += 1;
      inflight = '';
      if (!provider) {
        setDoc({ path, version, status: 'unsupported', symbols: [], truncated: '' });
      } else if (provider === 'navtree') {
        if (editorHost?.isLargeFile?.(path) === true) {
          setDoc({ path, version, status: 'too-large', symbols: [], truncated: '' });
        } else {
          // Keep the previous symbols of the same file while the worker answers (no flicker).
          setDoc(doc.path === path ? { ...doc, version: null } : { path, version: null, status: 'loading', symbols: [], truncated: '' });
          void loadNavigationTree(path, model, version);
        }
      } else {
        const { text, cut } = boundedText(model);
        const out = providers.outlineFromText(languageId, text, { path });
        setDoc({ path, version, status: 'ready', symbols: out.symbols, truncated: out.truncated || (cut ? 'size' : '') });
      }
      updateActive();
      paint();
    }

    // The innermost symbol holding the caret; a change opens its ancestors and reveals it.
    function updateActive() {
      const chain = providers.findActivePath(doc.symbols, cursorLine());
      const key = chain.length ? chain[chain.length - 1].key : '';
      if (key === activeKey) return;
      activeKey = key;
      if (!key) return;
      const collapsed = collapsedFor(doc.path);
      for (let i = 0; i < chain.length - 1; i += 1) collapsed.delete(chain[i].key);
      revealActive = true;
    }

    function schedule(delay) {
      if (disposed || !setTimeoutFn) return;
      if (timer && clearTimeoutFn) clearTimeoutFn(timer);
      timer = setTimeoutFn(refresh, delay);
    }

    /* ---------------------------------------------------------------- markup */

    function displaySymbols() {
      if (sorted && sorted.symbols === doc.symbols && sorted.mode === sortMode) return sorted.list;
      const list = providers.sortSymbols(doc.symbols, sortMode);
      sorted = { symbols: doc.symbols, mode: sortMode, list };
      return list;
    }

    function statusRow(text) {
      return `<div class="ide-tree-status" style="--ide-tree-depth:0">${escapeHtml(text)}</div>`;
    }

    function statusText() {
      switch (doc.status) {
        case 'none': return jt('ide.outline.noEditor', 'No file is open. Open one to see its outline.');
        case 'unsupported': return jt('ide.outline.unsupported', 'No outline for this file type.');
        case 'too-large': return jt('ide.outline.tooLarge', 'This file is too large for an outline.');
        case 'loading': return jt('ide.outline.loading', 'Loading symbols…');
        default: return doc.symbols.length ? '' : jt('ide.outline.empty', 'No symbols found in this file.');
      }
    }

    function truncatedText() {
      if (doc.truncated === 'symbols') return jt('ide.outline.truncatedSymbols', 'Showing the first {count} symbols.', { count: (providers.MAX_SYMBOLS || 2000).toLocaleString() });
      if (doc.truncated === 'size') return jt('ide.outline.truncatedSize', 'Showing symbols from the first 1 MB of this file.');
      return '';
    }

    function rowMarkup(symbol, depth, collapsed, rows, nav) {
      const hasChildren = symbol.children.length > 0;
      const expanded = hasChildren && !collapsed.has(symbol.key);
      const classes = ['ide-tree-row', 'ide-tree-row--outline'];
      const title = jt('ide.outline.rowTitle', '{name} ({kind}, line {line})', { name: symbol.name, kind: kindLabel(symbol.kind, nav), line: symbol.line });
      rows.push(`<div class="${classes.join(' ')}" role="treeitem" aria-level="${depth + 1}"`
        + (hasChildren ? ` aria-expanded="${expanded ? 'true' : 'false'}"` : '')
        + ` data-ide-outline-key="${escapeHtml(symbol.key)}" style="--ide-tree-depth:${depth}" tabindex="-1" title="${escapeHtml(title)}">`
        + `<span class="ide-tree-twisty" aria-hidden="true">${hasChildren ? (expanded ? '▾' : '▸') : ''}</span>`
        + `<span class="ide-tree-name">${escapeHtml(symbol.name)}</span></div>`);
      byKey.set(symbol.key, symbol);
      if (expanded) for (const child of symbol.children) rowMarkup(child, depth + 1, collapsed, rows, nav);
    }

    function headerMarkup() {
      const byName = sortMode === 'name';
      const sortLabel = byName ? jt('ide.outline.sortByName', 'Sort by: Name') : jt('ide.outline.sortByPosition', 'Sort by: Position');
      const buttons = typeof actionButton === 'function' && doc.status !== 'none'
        ? [
          actionButton({ plain: true, className: 'ide-tree-header-button', ariaLabel: sortLabel, title: sortLabel, ariaPressed: byName, trustedHtml: SORT_SVG, dataset: { 'ide-outline-action': 'sort' } }),
          actionButton({ plain: true, className: 'ide-tree-header-button', ariaLabel: jt('ide.tree.collapseAll', 'Collapse All'), title: jt('ide.tree.collapseAll', 'Collapse All'), trustedHtml: COLLAPSE_SVG, dataset: { 'ide-outline-action': 'collapse-all' } }),
        ].join('')
        : '';
      return '<div class="ide-tree-header">'
        + `<span class="ide-tree-header-title">${escapeHtml(jt('ide.workbench.view.outline', 'Outline'))}</span>`
        + `<span class="ide-tree-header-actions">${buttons}</span></div>`;
    }

    function buildMarkup() {
      byKey = new Map();
      const rows = [];
      const status = statusText();
      if (status) {
        rows.push(statusRow(status));
      } else {
        const collapsed = collapsedFor(doc.path);
        for (const symbol of displaySymbols()) rowMarkup(symbol, 0, collapsed, rows, symbolNavUtils);
        const note = truncatedText();
        if (note) rows.push(statusRow(note));
      }
      if (focusedKey && !byKey.has(focusedKey)) focusedKey = '';
      const name = doc.path ? doc.path.split('/').pop() : '';
      const label = name ? jt('ide.outline.treeLabel', 'Outline of {file}', { file: name }) : jt('ide.workbench.view.outline', 'Outline');
      return headerMarkup()
        + `<div class="ide-tree ide-tree--qol ide-outline-tree" role="tree" aria-label="${escapeHtml(label)}">${rows.join('')}</div>`;
    }

    // One row by key through an attribute query (a caret move never walks every row).
    function rowFor(host, key) {
      if (!host || !key) return null;
      return host.querySelector(`[data-ide-outline-key="${String(key).replace(/["\\]/g, '\\$&')}"]`);
    }

    // The active row is marked in place (O1): a caret move inside the same tree rebuilds nothing.
    function syncActive(host) {
      const target = activeKey ? rowFor(host, activeKey) : null;
      for (const row of host.querySelectorAll('.ide-tree-row--active')) {
        if (row === target) continue;
        row.classList.remove('ide-tree-row--active');
        row.removeAttribute('aria-current');
      }
      if (target) {
        target.classList.add('ide-tree-row--active');
        target.setAttribute('aria-current', 'true');
      }
    }

    // One row carries tabindex 0: the focused row, else the active one, else the first.
    // Rows are built with tabindex -1, so only the previous holder and the target change.
    function syncRoving(host) {
      if (!host) return null;
      const target = rowFor(host, focusedKey) || rowFor(host, activeKey) || host.querySelector('[data-ide-outline-key]');
      for (const row of host.querySelectorAll('[data-ide-outline-key][tabindex="0"]')) {
        if (row !== target) row.setAttribute('tabindex', '-1');
      }
      target?.setAttribute('tabindex', '0');
      return target;
    }

    function paint() {
      const host = getMountEl();
      if (!host || !isVisible()) {
        stale = true;
        return false;
      }
      bindHost(host);
      const markup = buildMarkup();
      const focused = host.ownerDocument?.activeElement || null;
      const hadFocus = Boolean(focused && host.contains(focused));
      // A header button keeps focus across the repaint (Sort, Collapse All by keyboard).
      const focusedAction = hadFocus ? focused.closest?.('[data-ide-outline-action]')?.getAttribute('data-ide-outline-action') || '' : '';
      if (markup !== lastMarkup || !host.querySelector('.ide-outline-tree')) {
        host.innerHTML = markup;
        lastMarkup = markup;
      }
      syncActive(host);
      const target = syncRoving(host);
      if (hadFocus && host.ownerDocument.activeElement !== focused) {
        const action = focusedAction ? host.querySelector(`[data-ide-outline-action="${focusedAction}"]`) : null;
        (action || target)?.focus?.();
      }
      if (revealActive) {
        revealActive = false;
        rowFor(host, activeKey)?.scrollIntoView?.({ block: 'nearest' });
      }
      return true;
    }

    /* ---------------------------------------------------------------- actions */

    function reveal(symbol, focusEditor) {
      if (!symbol || !doc.path) return false;
      editorHost?.revealPosition?.(doc.path, symbol.line, symbol.column);
      if (focusEditor) editorHost?.focus?.();
      return true;
    }

    function toggle(key, open) {
      const symbol = byKey.get(key);
      if (!symbol || !symbol.children.length) return false;
      const collapsed = collapsedFor(doc.path);
      const isOpen = !collapsed.has(key);
      const next = open === undefined ? !isOpen : open;
      if (next === isOpen) return false;
      if (next) collapsed.delete(key);
      else collapsed.add(key);
      paint();
      return true;
    }

    function collapseAll() {
      const collapsed = collapsedFor(doc.path);
      (function walk(list) {
        for (const symbol of list) {
          if (symbol.children.length) collapsed.add(symbol.key);
          walk(symbol.children);
        }
      })(doc.symbols);
      // A collapsed child's row is gone: keyboard focus falls back to its top-level ancestor.
      const top = providers.findActivePath(doc.symbols, byKey.get(focusedKey)?.line || 0)[0];
      if (focusedKey) focusedKey = top ? top.key : '';
      paint();
      return true;
    }

    function setSortMode(mode) {
      if (!SORT_MODES.includes(mode) || mode === sortMode) return false;
      sortMode = mode;
      paint();
      return true;
    }

    // Puts keyboard focus on the active row (else the first); renders first if stale.
    function focus() {
      if (stale) refresh();
      else paint();
      const host = getMountEl();
      const target = host && isVisible() ? syncRoving(host) : null;
      if (target) {
        target.focus?.();
        focusedKey = target.getAttribute('data-ide-outline-key') || '';
        return true;
      }
      host?.focus?.();
      return false;
    }

    function moveFocus(row, host) {
      if (!row) return;
      focusedKey = row.getAttribute('data-ide-outline-key') || '';
      syncRoving(host);
      row.focus?.();
    }

    function parentKeyOf(key) {
      const chain = [];
      (function find(list, trail) {
        for (const symbol of list) {
          if (symbol.key === key) { chain.push(...trail); return true; }
          if (find(symbol.children, trail.concat(symbol))) return true;
        }
        return false;
      })(doc.symbols, []);
      return chain.length ? chain[chain.length - 1].key : '';
    }

    function handleKeydown(event) {
      const host = getMountEl();
      const row = event.target?.closest?.('[data-ide-outline-key]');
      if (!host || !row || !host.contains(row)) return;
      const key = row.getAttribute('data-ide-outline-key') || '';
      const symbol = byKey.get(key);
      const rows = [...host.querySelectorAll('[data-ide-outline-key]')];
      const index = rows.indexOf(row);
      let handled = true;
      switch (event.key) {
        case 'ArrowDown': moveFocus(rows[index + 1], host); break;
        case 'ArrowUp': moveFocus(rows[index - 1], host); break;
        case 'Home': moveFocus(rows[0], host); break;
        case 'End': moveFocus(rows[rows.length - 1], host); break;
        case 'ArrowRight':
          if (symbol?.children.length && !toggle(key, true)) moveFocus(rows[index + 1], host);
          else if (symbol?.children.length) moveFocus(rowFor(host, key), host);
          break;
        case 'ArrowLeft':
          if (!(symbol?.children.length && toggle(key, false))) moveFocus(rowFor(host, parentKeyOf(key)), host);
          else moveFocus(rowFor(host, key), host);
          break;
        case 'Enter': reveal(symbol, true); break;
        case ' ': reveal(symbol, false); break;
        default: handled = false;
      }
      if (handled) {
        event.preventDefault?.();
        event.stopPropagation?.();
      }
    }

    function handleClick(event) {
      const host = getMountEl();
      const target = event.target;
      if (!host || !target?.closest) return;
      const action = target.closest('[data-ide-outline-action]');
      if (action && host.contains(action)) {
        const name = action.getAttribute('data-ide-outline-action');
        if (name === 'sort') setSortMode(sortMode === 'name' ? 'position' : 'name');
        else if (name === 'collapse-all') collapseAll();
        return;
      }
      const row = target.closest('[data-ide-outline-key]');
      if (!row || !host.contains(row)) return;
      const key = row.getAttribute('data-ide-outline-key') || '';
      focusedKey = key;
      if (target.closest('.ide-tree-twisty') && toggle(key)) return;
      reveal(byKey.get(key), true);
    }

    function bindHost(host) {
      if (boundHost === host) return;
      unbindHost();
      boundHost = host;
      lastMarkup = '';
      host.addEventListener('click', handleClick);
      host.addEventListener('keydown', handleKeydown);
    }

    function unbindHost() {
      if (!boundHost) return;
      boundHost.removeEventListener('click', handleClick);
      boundHost.removeEventListener('keydown', handleKeydown);
      boundHost = null;
    }

    /* ---------------------------------------------------------------- lifecycle */

    // Layout pass: paint the current state; a stale outline refreshes itself first.
    function render() {
      if (disposed || !isVisible()) return;
      if (stale && !timer) {
        refresh();
        return;
      }
      paint();
    }

    // Cursor choke point (controller onCursorActivity, any editor group).
    function noteCursor() {
      if (disposed) return;
      if (!isVisible()) {
        stale = true;
        return;
      }
      const model = editorHost?.getModel?.(activePath());
      const typing = Boolean(model) && doc.path === activePath() && doc.version !== null && model.getVersionId?.() !== doc.version;
      schedule(typing ? TYPING_DEBOUNCE_MS : CURSOR_DEBOUNCE_MS);
    }

    function handleActiveFileChanged() {
      stale = true;
      if (isVisible()) schedule(0);
    }

    function handleWorkspaceRootCommitted() {
      generation += 1;
      collapsedByPath.clear();
      setDoc({ path: '', version: null, status: 'none', symbols: [], truncated: '' });
      activeKey = '';
      focusedKey = '';
      stale = true;
      watchModel(null);
    }

    windowRef?.addEventListener?.('ide:active-file-changed', handleActiveFileChanged);
    windowRef?.addEventListener?.('ide:workspace-root-committed', handleWorkspaceRootCommitted);

    function dispose() {
      disposed = true;
      generation += 1;
      if (timer && clearTimeoutFn) clearTimeoutFn(timer);
      timer = null;
      windowRef?.removeEventListener?.('ide:active-file-changed', handleActiveFileChanged);
      windowRef?.removeEventListener?.('ide:workspace-root-committed', handleWorkspaceRootCommitted);
      unbindHost();
      watchModel(null);
      collapsedByPath.clear();
    }

    return {
      render,
      noteCursor,
      refresh,
      focus,
      collapseAll,
      setSortMode,
      getSortMode: () => sortMode,
      getSnapshot: () => ({ path: doc.path, status: doc.status, truncated: doc.truncated, activeKey, count: byKey.size }),
      dispose,
    };
  }

  return { createIdeOutlineView, SORT_MODES };
});
