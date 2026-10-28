/* renderer/features/renderer-ide-problems-panel.js - Workspace IDE Problems /
 * diagnostics rail panel (the IDE's 6th rail panel). Surfaces the TS/JS/JSON/CSS
 * markers Monaco's in-process language workers already produce for OPEN file
 * models - previously invisible - grouped by file and sorted by location, with a
 * severity summary. Clicking a row reveals the spot in the editor.
 *
 * No new workers, no new IPC: the panel reads its diagnostics view-model through
 * the editor host (editorHost.getMarkers / onMarkersChanged), which owns the
 * Monaco namespace and the jenny-workspace model-URI -> path mapping - this panel
 * never touches monacoApi. Diagnostics only exist for files currently OPEN in the
 * editor (Monaco lints live models; there is no project-wide LSP) - the empty
 * state says so.
 *
 * Toolbar (runtime-only filter state): a text filter, Errors / Warnings / Info
 * chips, "Active file only", Collapse All. The filter input keeps its DOM node
 * (focus, caret, IME) across re-renders - only the actions + list regions are
 * patched, like the search panel. The summary chips and the badge counts stay
 * unfiltered.
 *
 * Mirrors the source-control panel's delegation pattern: markup strings + one
 * click listener on its own view host, selector-guarded on data-ide-prb-*
 * attributes, with a content-hash render guard so identical renders don't churn
 * the DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeProblemsPanel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  // Pure filter state, the row cap, the F8 walk order, the glyphs and the toolbar markup;
  // loaded before this panel by the IDE script manifest (and required directly under Node).
  const filterLib = globalRef.rendererIdeProblemsFilter || require('./renderer-ide-problems-filter');
  const { GLYPHS, SEVERITY_ICON, fileNameOf, parentDirOf } = filterLib;
  function noop() {}
  // Trailing window that folds a burst of marker events into one refresh.
  const REFRESH_COALESCE_MS = 100;
  // Trailing window for the text filter: a burst of keystrokes rebuilds the list once.
  const FILTER_DEBOUNCE_MS = 150;

  // Spoken severity names for the summary chips (WIDE-056b): the chip markup is
  // an aria-hidden icon + a bare number, which exposes no severity to AT. Pair
  // singular/plural so "1 error" / "3 errors" reads naturally.
  const SEVERITY_LABEL = { error: jt('ide.problems.error', 'error'), warning: jt('ide.problems.warning', 'warning'), info: jt('ide.problems.infoNotice', 'info notice'), hint: jt('ide.problems.hint', 'hint') };
  const SEVERITY_LABEL_PLURAL = { error: jt('ide.problems.errors', 'errors'), warning: jt('ide.problems.warnings', 'warnings'), info: jt('ide.problems.infoNotices', 'info notices'), hint: jt('ide.problems.hints', 'hints') };

  // Inventory primitives: an injected option, the browser global, or require().
  function resolvePrimitive(injected, globalName, requirePath) {
    if (typeof injected === 'function') {
      return injected;
    }
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

  function createIdeProblemsPanel(deps) {
    const options = deps || {};
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const getIde = typeof options.getIde === 'function' ? options.getIde : () => ({});
    const escapeHtml = typeof options.escapeHtml === 'function'
      ? options.escapeHtml
      : (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
    const actionButton = resolvePrimitive(options.actionButton, 'inventoryActionButton', '../inventory/action-button');
    const textField = resolvePrimitive(options.textField, 'inventoryTextField', '../inventory/text-field');
    // The editor host owns monacoApi + the jenny-workspace model-URI mapping;
    // the panel reads diagnostics through its getMarkers/onMarkersChanged surface.
    const editorHost = options.editorHost || {};
    // R2: the Tasks source, problems from Run output for files with no open model
    // (open files carry them as Monaco `task` markers, already in getMarkers).
    const getTaskProblems = typeof options.getTaskProblems === 'function' ? options.getTaskProblems : () => null;
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : noop;
    // The controller injects the view host (#wbView-problems) + an active-view check.
    const getMountEl = typeof options.getMountEl === 'function'
      ? options.getMountEl
      : () => null;
    const isActivePanel = typeof options.isActivePanel === 'function'
      ? options.isActivePanel
      : () => getIde().railPanel === 'problems';
    const onReveal = typeof options.onReveal === 'function' ? options.onReveal : noop;
    const setTimeoutFn = typeof options.setTimeoutFn === 'function' ? options.setTimeoutFn : (fn, ms) => setTimeout(fn, ms);
    const clearTimeoutFn = typeof options.clearTimeoutFn === 'function' ? options.clearTimeoutFn : (id) => clearTimeout(id);

    let markersDisposable = null;
    let taskDisposable = null;
    let refreshTimer = null;
    let filterTimer = null;
    let boundPanel = null;
    // Computed marker view-model, cached between onDidChangeMarkers events so a
    // frequent statusbar re-render (cursor moves) doesn't re-scan + re-sort.
    let cachedModel = null;
    // Runtime-only toolbar state (never persisted). hint markers follow `info`.
    const filterApi = filterLib.createProblemsFilter();
    const filter = filterApi.state;
    const collapsed = new Set();
    // The filter input mid-IME-composition, and what this instance last painted ({ root, summary, actions, list }).
    let composingEl = null;
    let painted = null;

    // Editor markers plus the Tasks source, grouped by file (renderer-ide-problems-filter.js
    // groupMarkers); a file whose markers disappeared forgets its collapsed state. One
    // getMarkers() snapshot per refresh, shared with the tree badges (getMarkerSnapshot).
    function buildModel() {
      const markers = typeof editorHost.getMarkers === 'function' ? editorHost.getMarkers() : [];
      const tasks = getTaskProblems()?.getMarkers?.() || [];
      const all = tasks.length ? markers.concat(tasks) : markers;
      const built = Object.assign(filterLib.groupMarkers(all), { markers: all });
      const paths = new Set(built.groups.map((group) => group.path));
      for (const path of [...collapsed]) {
        if (!paths.has(path)) collapsed.delete(path);
      }
      return built;
    }

    function model() {
      if (!cachedModel) {
        cachedModel = buildModel();
      }
      return cachedModel;
    }

    // Groups/rows that pass the toolbar filters (the model itself stays whole).
    function visibleModel() {
      return filterApi.apply(model().groups, getIde().activeTabPath, model().counts.total);
    }

    function severityChip(severity, count) {
      const label = count === 1 ? SEVERITY_LABEL[severity] : SEVERITY_LABEL_PLURAL[severity];
      const accessibleName = `${count} ${label || severity}`;
      return `<span class="ide-prb-chip" data-diag-severity="${severity}" role="text" aria-label="${escapeHtml(accessibleName)}">`
        + `<span class="ide-prb-chip-icon" aria-hidden="true">${SEVERITY_ICON[severity] || ''}</span>`
        + `<span class="ide-prb-chip-count" aria-hidden="true">${escapeHtml(String(count))}</span></span>`;
    }

    function buildSummaryMarkup(counts) {
      const parts = [];
      for (const severity of ['error', 'warning', 'info', 'hint']) {
        if (counts[severity]) {
          parts.push(severityChip(severity, counts[severity]));
        }
      }
      return `<div class="ide-prb-summary">${parts.join('')}</div>`;
    }

    function buildRowMarkup(path, marker) {
      if (!actionButton) {
        return '';
      }
      const loc = jt('ide.problems.lineColumn', 'Ln {line}, Col {column}', { line: marker.line, column: marker.column });
      const sourceHint = marker.source
        ? `<span class="ide-prb-row-source">${escapeHtml(marker.source)}${marker.code ? `(${escapeHtml(marker.code)})` : ''}</span>`
        : '';
      return actionButton({
        plain: true,
        className: 'ide-prb-row',
        title: `${marker.message} — ${loc}`,
        ariaLabel: `${marker.severity}: ${marker.message}, ${loc}`,
        dataset: {
          'ide-prb-path': path,
          'ide-prb-line': String(marker.line),
          'ide-prb-col': String(marker.column),
        },
        trustedHtml: `<span class="ide-prb-row-icon" data-diag-severity="${marker.severity}" aria-hidden="true">${SEVERITY_ICON[marker.severity] || ''}</span>`
          + `<span class="ide-prb-row-msg">${escapeHtml(marker.message)}</span>`
          + sourceHint
          + `<span class="ide-prb-row-loc">${escapeHtml(loc)}</span>`,
      });
    }

    // The header toggles its group (rows reveal individually).
    function buildGroupMarkup(group) {
      const path = String(group.path || '');
      const dirHint = parentDirOf(path);
      const isCollapsed = collapsed.has(path);
      const total = group.total || group.items.length; // a group cut by the row cap counts all
      const head = actionButton
        ? actionButton({
          plain: true,
          className: 'ide-prb-file',
          ariaExpanded: !isCollapsed,
          title: jtn('ide.problems.fileProblemCount', total, { path, count: total }, '{path} — {count} problem', '{path} — {count} problems'),
          dataset: { 'ide-prb-group': path },
          trustedHtml: `<span class="ide-prb-file-chevron" aria-hidden="true">${GLYPHS.chevron || ''}</span>`
            + `<span class="ide-prb-file-name">${escapeHtml(fileNameOf(path))}</span>`
            + (dirHint ? `<span class="ide-prb-file-dir">${escapeHtml(dirHint)}</span>` : '')
            + `<span class="ide-prb-file-count">${escapeHtml(String(total))}</span>`,
        })
        : '';
      const rows = isCollapsed ? '' : group.items.map((marker) => buildRowMarkup(path, marker)).join('');
      return `<div class="ide-prb-group">${head}${rows}</div>`;
    }

    function buildFilterFieldMarkup() {
      if (!textField) return '';
      return textField({
        className: 'ide-prb-filter',
        value: filter.text,
        placeholder: jt('ide.problems.filterPlaceholder', 'Filter (e.g. text, path)'),
        ariaLabel: jt('ide.problems.filter', 'Filter problems'),
        maxLength: 256,
        dataset: { 'ide-prb-filter': '1' },
      });
    }

    // Severity toggles + Active file only + Collapse/Expand All (a patched region);
    // the markup lives in renderer-ide-problems-filter.js beside its glyphs.
    function buildActionsMarkup(counts, visibleGroups) {
      if (!actionButton) return '<div class="ide-prb-toolbar-actions"></div>';
      const allCollapsed = visibleGroups.length > 0 && visibleGroups.every((group) => collapsed.has(group.path));
      return filterLib.buildToolbarActionsMarkup({
        actionButton, escapeHtml, filter, counts, severityIcons: SEVERITY_ICON, allCollapsed, hasGroups: visibleGroups.length > 0,
      });
    }

    // Status line (only while filters hide something) + the file groups.
    function buildListMarkup(counts, visible) {
      if (!counts.total) {
        return '<div class="ide-prb-empty">' + escapeHtml(jt('ide.problems.empty', 'No problems detected in open files.')) + '</div>'
          + '<p class="ide-prb-empty-hint">' + escapeHtml(jt('ide.problems.emptyHintWithRun', 'Diagnostics from open TypeScript, JavaScript, JSON and CSS files, and problems found in Run output, appear here.')) + '</p>';
      }
      const listed = filterLib.capRows(visible.groups, (path) => collapsed.has(path));
      let status = '';
      if (listed.capped) {
        status = '<div class="ide-prb-filter-status">' + escapeHtml(jt('ide.problems.showingFirstOf', 'Showing the first {shown} of {total}',
          { shown: filterLib.MAX_ROWS.toLocaleString(), total: visible.shown.toLocaleString() })) + '</div>';
      } else if (visible.shown === 0) {
        const clear = actionButton
          ? actionButton({ plain: true, className: 'ide-prb-clear-filters', dataset: { 'ide-prb-action': 'clear-filters' }, label: jt('ide.problems.clearFilters', 'Clear filters') })
          : '';
        status = '<div class="ide-prb-filter-status">' + escapeHtml(jt('ide.problems.noMatches', 'No problems match the current filters.')) + clear + '</div>';
      } else if (visible.shown < counts.total) {
        status = '<div class="ide-prb-filter-status">' + escapeHtml(jt('ide.problems.showingOf', 'Showing {shown} of {total}', { shown: visible.shown, total: counts.total })) + '</div>';
      }
      return status + listed.groups.map((group) => buildGroupMarkup(group)).join('');
    }

    // The panel's regions: summary (unfiltered), toolbar (filter field + actions), list.
    function buildParts() {
      const { counts } = model();
      const visible = visibleModel();
      const hasToolbar = counts.total > 0 || filterApi.isActive();
      return {
        hasToolbar,
        summary: counts.total ? buildSummaryMarkup(counts) : '',
        field: hasToolbar ? buildFilterFieldMarkup() : '',
        actions: hasToolbar ? buildActionsMarkup(counts, visible.groups) : '',
        list: buildListMarkup(counts, visible),
      };
    }

    function panelMarkupOf(parts) {
      const toolbar = parts.hasToolbar ? `<div class="ide-prb-toolbar">${parts.field}${parts.actions}</div>` : '';
      return `<div class="ide-prb">${parts.summary}${toolbar}<div class="ide-prb-list">${parts.list}</div></div>`;
    }

    // Still our panel in this host: the filter input stays the same node (value
    // written only on a programmatic change, e.g. Clear filters, and never
    // mid-composition, so focus/caret/IME survive); the summary, actions and
    // list regions swap alone.
    function patchPainted(panel, parts) {
      const root = painted?.root?.parentNode === panel && panel.childElementCount === 1 ? painted.root : null;
      const inputEl = root?.querySelector(':scope > .ide-prb-toolbar input[data-ide-prb-filter]');
      const actionsEl = root?.querySelector(':scope > .ide-prb-toolbar > .ide-prb-toolbar-actions');
      const listEl = root?.querySelector(':scope > .ide-prb-list');
      if (!parts.hasToolbar || !inputEl || !actionsEl || !listEl) return false;
      if (inputEl !== composingEl && inputEl.value !== filter.text) inputEl.value = filter.text;
      if (painted.summary !== parts.summary) {
        root.querySelector(':scope > .ide-prb-summary')?.remove();
        if (parts.summary) root.insertAdjacentHTML('afterbegin', parts.summary);
      }
      if (painted.actions !== parts.actions) actionsEl.outerHTML = parts.actions;
      if (painted.list !== parts.list) listEl.innerHTML = parts.list;
      return true;
    }

    // Identity of the focused control inside the panel, so a re-render that
    // replaces it can hand focus back (keyboard users toggling chips / groups).
    const FOCUS_ATTRS = ['data-ide-prb-severity', 'data-ide-prb-active-only', 'data-ide-prb-action', 'data-ide-prb-group', 'data-ide-prb-filter', 'data-ide-prb-path'];
    function focusKeyOf(panel) {
      const el = panel.ownerDocument?.activeElement;
      if (!el || !panel.contains(el) || typeof el.getAttribute !== 'function') return null;
      const attr = FOCUS_ATTRS.find((name) => el.hasAttribute(name));
      if (!attr) return null;
      return {
        attr,
        value: el.getAttribute(attr),
        line: attr === 'data-ide-prb-path' ? el.getAttribute('data-ide-prb-line') : null,
        col: attr === 'data-ide-prb-path' ? el.getAttribute('data-ide-prb-col') : null,
        selection: attr === 'data-ide-prb-filter' ? [el.selectionStart, el.selectionEnd] : null,
      };
    }

    function restoreFocus(panel, key) {
      if (!key) return;
      const target = [...panel.querySelectorAll(`[${key.attr}]`)].find((el) => el.getAttribute(key.attr) === key.value
        && (key.line === null || (el.getAttribute('data-ide-prb-line') === key.line && el.getAttribute('data-ide-prb-col') === key.col)));
      if (!target || panel.ownerDocument.activeElement === target) return;
      target.focus();
      if (key.selection) {
        try {
          target.setSelectionRange(key.selection[0], key.selection[1]);
        } catch (_error) {
          /* selection restore is best-effort */
        }
      }
    }

    function renderPanel() {
      const panel = getMountEl();
      if (!panel || !isActivePanel()) {
        return;
      }
      const parts = buildParts();
      const markup = panelMarkupOf(parts);
      if (panel.__jennyIdeRailMarkup === markup) {
        return;
      }
      const focusKey = focusKeyOf(panel);
      if (!patchPainted(panel, parts)) {
        panel.innerHTML = markup;
        painted = { root: panel.firstElementChild };
        // The composing input (if any) was just replaced; its compositionend never arrives.
        composingEl = null;
      }
      Object.assign(painted, { summary: parts.summary, actions: parts.actions, list: parts.list });
      restoreFocus(panel, focusKey);
      panel.__jennyIdeRailMarkup = markup;
    }

    // Severity counts for the statusbar badge. Reads the cached model so the
    // frequent statusbar re-render stays cheap. Never filtered.
    function getCounts() {
      return model().counts;
    }

    // Any marker at all: whether the Problems tab shows (F7), so info and hints stay reachable.
    function hasMarkers() {
      const c = getCounts() || {};
      return Number(c.total) > 0;
    }

    // Errors + warnings: the Problems tab's badge.
    function getBadgeCount() {
      const c = getCounts() || {};
      return (Number(c.error) || 0) + (Number(c.warning) || 0);
    }

    // F8 / Shift+F8: every marker in open files, regardless of the panel's filters
    // (VS Code's marker navigation), walked in path, line, column order
    // (renderer-ide-problems-filter.js) from the cursor in the active file,
    // wrapping at either end. Reveals through onReveal (the controller's
    // group-aware open-at-line path).
    // The path and cursor come from one editor: the focused group's when the host reports
    // it (a secondary group can hold focus), else the primary's.
    function cursorSpot() {
      const focused = String(editorHost.getFocusedPath?.() || '');
      const path = focused || String(editorHost.getActivePath?.() || getIde().activeTabPath || '');
      const info = (focused ? editorHost.getFocusedCursorInfo?.() : editorHost.getCursorInfo?.()) || null;
      return { path, line: Number(info?.lineNumber) || 1, column: Number(info?.column) || 1 };
    }

    function walkProblems(direction) {
      const target = filterLib.findAdjacentProblem(model().groups, cursorSpot(), direction);
      if (target) onReveal(target.path, target.line, target.column);
      return target;
    }

    function nextProblem() {
      return walkProblems(1);
    }

    function previousProblem() {
      return walkProblems(-1);
    }

    // Marker change (worker finished, file opened/closed): drop the cache and
    // ask the controller to re-render. renderIde refreshes the active panel
    // (us, if showing) AND the statusbar badge in one pass; every IDE render is
    // content-hash guarded so unchanged surfaces never touch the DOM. Monaco
    // fires one event per model/owner, so a worker settling many files arrives
    // as a burst: a short trailing window folds it into one rescan + render.
    // The cached model drops at once, so a reader inside the window (the tree badges)
    // never takes a stale snapshot; the render still waits for the window to close.
    function refresh() {
      cachedModel = null;
      if (refreshTimer !== null) return;
      refreshTimer = setTimeoutFn(flushRefresh, REFRESH_COALESCE_MS);
    }

    function flushRefresh() {
      refreshTimer = null;
      requestRender();
    }

    function cancelFilterRender() {
      if (filterTimer !== null) clearTimeoutFn(filterTimer);
      filterTimer = null;
    }

    function disposeSubscription() {
      markersDisposable?.dispose?.();
      markersDisposable = null;
      taskDisposable?.dispose?.();
      taskDisposable = null;
    }

    function toggleGroup(path) {
      if (collapsed.has(path)) collapsed.delete(path);
      else collapsed.add(path);
    }

    // Collapses every file group; when the visible ones are already all
    // collapsed it expands everything instead.
    function collapseAll() {
      const visible = visibleModel().groups;
      if (visible.length && visible.every((group) => collapsed.has(group.path))) {
        collapsed.clear();
        return;
      }
      model().groups.forEach((group) => collapsed.add(group.path));
    }

    // One activation path for a click and for Enter on a focused row/header.
    function activate(target) {
      if (!target || typeof target.closest !== 'function') {
        return false;
      }
      const severityEl = target.closest('[data-ide-prb-severity]');
      if (severityEl) {
        filterApi.toggle(String(severityEl.dataset.idePrbSeverity || ''));
        renderPanel();
        return true;
      }
      if (target.closest('[data-ide-prb-active-only]')) {
        filterApi.toggle('activeOnly');
        renderPanel();
        return true;
      }
      const actionEl = target.closest('[data-ide-prb-action]');
      if (actionEl) {
        const action = actionEl.dataset.idePrbAction;
        if (action === 'collapse-all') collapseAll();
        else if (action === 'clear-filters') { cancelFilterRender(); filterApi.clear(); } else return false;
        renderPanel();
        return true;
      }
      const groupEl = target.closest('[data-ide-prb-group]');
      if (groupEl) {
        toggleGroup(String(groupEl.dataset.idePrbGroup || ''));
        renderPanel();
        return true;
      }
      // Selector-guarded on the row attribute.
      const row = target.closest('[data-ide-prb-path]');
      const path = row ? String(row.dataset.idePrbPath || '') : '';
      if (!path) {
        return false;
      }
      onReveal(path, Number(row.dataset.idePrbLine) || 1, Number(row.dataset.idePrbCol) || 1);
      return true;
    }

    const handleClick = (event) => { activate(event.target); };

    function isFilterInput(target) {
      return Boolean(target?.closest?.('[data-ide-prb-filter]'));
    }

    function handleInput(event) {
      // Mid-composition keystrokes wait for compositionend.
      if (!isFilterInput(event.target) || event.isComposing === true || (composingEl && event.target === composingEl)) {
        return;
      }
      filter.text = String(event.target.value || '');
      cancelFilterRender();
      filterTimer = setTimeoutFn(() => { filterTimer = null; renderPanel(); }, FILTER_DEBOUNCE_MS);
    }

    const handleCompositionStart = (event) => { if (isFilterInput(event.target)) composingEl = event.target; };

    function handleCompositionEnd(event) {
      if (!isFilterInput(event.target)) return;
      composingEl = null;
      handleInput({ target: event.target });
    }

    function moveFocus(from, step) {
      const items = [...boundPanel.querySelectorAll('.ide-prb-file, .ide-prb-row')];
      const next = items[items.indexOf(from) + step];
      if (next) next.focus();
    }

    function handleKeydown(event) {
      const target = event.target;
      if (isFilterInput(target)) {
        // The IME owns Enter/Escape while composing.
        if (event.isComposing || event.keyCode === 229 || composingEl) return;
        if (event.key === 'Escape' && filter.text) {
          event.preventDefault();
          cancelFilterRender();
          filter.text = '';
          renderPanel();
        }
        return;
      }
      const isItem = typeof target?.matches === 'function' && target.matches('.ide-prb-row, .ide-prb-file');
      if (!isItem) return;
      if (event.key === 'Enter') {
        // Handled here (and the native click suppressed), so Enter activates exactly once.
        if (activate(target)) event.preventDefault();
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        moveFocus(target, event.key === 'ArrowDown' ? 1 : -1);
      }
    }

    function bindEvents() {
      const panel = getMountEl();
      if (!panel || boundPanel === panel) {
        return;
      }
      boundPanel = panel;
      panel.addEventListener('click', handleClick);
      panel.addEventListener('input', handleInput);
      panel.addEventListener('keydown', handleKeydown);
      panel.addEventListener('compositionstart', handleCompositionStart);
      panel.addEventListener('compositionend', handleCompositionEnd);
      // Live diagnostics: refresh on every marker change. The host wires the
      // underlying onDidChangeMarkers once Monaco boots and fans out to us.
      if (!markersDisposable && typeof editorHost.onMarkersChanged === 'function') {
        markersDisposable = editorHost.onMarkersChanged(() => refresh());
      }
      bindTaskSource();
    }

    function bindTaskSource() {
      const tasks = getTaskProblems();
      if (!taskDisposable && typeof tasks?.onChange === 'function') taskDisposable = tasks.onChange(() => refresh());
    }

    function dispose() {
      disposeSubscription();
      cancelFilterRender();
      if (refreshTimer !== null) {
        clearTimeoutFn(refreshTimer);
        refreshTimer = null;
      }
      if (boundPanel) {
        boundPanel.removeEventListener('click', handleClick);
        boundPanel.removeEventListener('input', handleInput);
        boundPanel.removeEventListener('keydown', handleKeydown);
        boundPanel.removeEventListener('compositionstart', handleCompositionStart);
        boundPanel.removeEventListener('compositionend', handleCompositionEnd);
        boundPanel = null;
      }
      painted = null;
      composingEl = null;
    }

    return {
      bindEvents,
      dispose,
      getCounts,
      getBadgeCount,
      // Every marker of the current refresh (editor + Tasks), for the tree badges.
      getMarkerSnapshot: () => model().markers,
      hasMarkers,
      nextProblem,
      previousProblem,
      renderPanel,
    };
  }

  return {
    createIdeProblemsPanel,
  };
});
