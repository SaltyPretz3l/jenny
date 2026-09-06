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
 * Mirrors the source-control panel's delegation pattern: markup strings + one
 * click listener on the shared #ideRailPanel, selector-guarded on data-ide-prb-*
 * attributes, with a content-hash render guard so identical renders don't churn
 * the DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeProblemsPanel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // Worst-first ordering for file groups + the statusbar/summary buckets.
  const SEVERITY_ORDER = { error: 0, warning: 1, info: 2, hint: 3 };

  // Inline SVG severity glyphs (CSP-safe, currentColor; colour is set per
  // data-diag-severity in styles/ide-problems.css so they re-theme).
  const SEVERITY_ICON = {
    error: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle><path d="M10 6 6 10M6 6l4 4"></path></svg>',
    warning: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 14 13H2L8 2.5Z"></path><path d="M8 6.4v3"></path><path d="M8 11.2v.1"></path></svg>',
    info: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle><path d="M8 7.2v3.2"></path><path d="M8 5.2v.1"></path></svg>',
    hint: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><circle cx="8" cy="8" r="2.6"></circle></svg>',
  };

  // Spoken severity names for the summary chips (WIDE-056b): the chip markup is
  // an aria-hidden icon + a bare number, which exposes no severity to AT. Pair
  // singular/plural so "1 error" / "3 errors" reads naturally.
  const SEVERITY_LABEL = { error: 'error', warning: 'warning', info: 'info notice', hint: 'hint' };
  const SEVERITY_LABEL_PLURAL = { error: 'errors', warning: 'warnings', info: 'info notices', hint: 'hints' };

  function resolveActionButton(options) {
    if (typeof options.actionButton === 'function') {
      return options.actionButton;
    }
    if (typeof globalRef.inventoryActionButton === 'function') {
      return globalRef.inventoryActionButton;
    }
    if (typeof require === 'function') {
      try {
        return require('../inventory/action-button');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function fileNameOf(path) {
    const normalized = String(path || '');
    return normalized.split('/').pop() || normalized;
  }

  function parentDirOf(path) {
    const index = String(path || '').lastIndexOf('/');
    return index === -1 ? '' : String(path).slice(0, index);
  }

  function createIdeProblemsPanel(deps) {
    const options = deps || {};
    const getDom = typeof options.getDom === 'function' ? options.getDom : () => ({});
    const getIde = typeof options.getIde === 'function' ? options.getIde : () => ({});
    const escapeHtml = typeof options.escapeHtml === 'function'
      ? options.escapeHtml
      : (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const actionButton = resolveActionButton(options);
    // The editor host owns monacoApi + the jenny-workspace model-URI mapping;
    // the panel reads diagnostics through its getMarkers/onMarkersChanged surface.
    const editorHost = options.editorHost || {};
    const requestRender = typeof options.requestRender === 'function' ? options.requestRender : noop;
    // Re-homed from the rail into the bottom panel: the controller injects the
    // mount host (#ideBottomPanelContent) + an active-view check; the fallbacks
    // keep the old rail behavior for any caller that omits them.
    const getMountEl = typeof options.getMountEl === 'function'
      ? options.getMountEl
      : () => getDom().ideRailPanel || null;
    const isActivePanel = typeof options.isActivePanel === 'function'
      ? options.isActivePanel
      : () => getIde().railPanel === 'problems';
    const onReveal = typeof options.onReveal === 'function' ? options.onReveal : noop;

    let markersDisposable = null;
    let boundPanel = null;
    // Computed marker view-model, cached between onDidChangeMarkers events so a
    // frequent statusbar re-render (cursor moves) doesn't re-scan + re-sort.
    let cachedModel = null;

    // Groups markers by file (each group sorted by line/column), files sorted by
    // worst severity then path, plus the severity counts the statusbar reads.
    function buildModel() {
      const markers = typeof editorHost.getMarkers === 'function' ? editorHost.getMarkers() : [];
      const byPath = new Map();
      const counts = { error: 0, warning: 0, info: 0, hint: 0, total: 0 };
      for (const marker of markers) {
        counts[marker.severity] = (counts[marker.severity] || 0) + 1;
        counts.total += 1;
        if (!byPath.has(marker.path)) {
          byPath.set(marker.path, []);
        }
        byPath.get(marker.path).push(marker);
      }
      const groups = [...byPath.entries()].map(([path, items]) => {
        items.sort((a, b) => (a.line - b.line) || (a.column - b.column));
        const worst = items.reduce(
          (acc, marker) => Math.min(acc, SEVERITY_ORDER[marker.severity] ?? 3),
          3
        );
        return { path, items, worst };
      });
      groups.sort((a, b) => (a.worst - b.worst) || a.path.localeCompare(b.path));
      return { groups, counts };
    }

    function model() {
      if (!cachedModel) {
        cachedModel = buildModel();
      }
      return cachedModel;
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
      const loc = `Ln ${marker.line}, Col ${marker.column}`;
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

    function buildGroupMarkup(group) {
      const path = String(group.path || '');
      const dirHint = parentDirOf(path);
      const first = group.items[0] || { line: 1, column: 1 };
      const head = actionButton
        ? actionButton({
          plain: true,
          className: 'ide-prb-file',
          title: `${path} — ${group.items.length} problem${group.items.length === 1 ? '' : 's'}`,
          dataset: {
            'ide-prb-path': path,
            'ide-prb-line': String(first.line),
            'ide-prb-col': String(first.column),
          },
          trustedHtml: `<span class="ide-prb-file-name">${escapeHtml(fileNameOf(path))}</span>`
            + (dirHint ? `<span class="ide-prb-file-dir">${escapeHtml(dirHint)}</span>` : '')
            + `<span class="ide-prb-file-count">${escapeHtml(String(group.items.length))}</span>`,
        })
        : '';
      const rows = group.items.map((marker) => buildRowMarkup(path, marker)).join('');
      return `<div class="ide-prb-group">${head}${rows}</div>`;
    }

    function buildPanelMarkup() {
      const { groups, counts } = model();
      if (!counts.total) {
        return '<div class="ide-prb">'
          + '<div class="ide-prb-empty">No problems detected in open files.</div>'
          + '<p class="ide-prb-empty-hint">Diagnostics from open TypeScript, JavaScript, JSON and CSS files appear here.</p>'
          + '</div>';
      }
      const body = groups.map((group) => buildGroupMarkup(group)).join('');
      return `<div class="ide-prb">${buildSummaryMarkup(counts)}${body}</div>`;
    }

    function renderPanel() {
      const panel = getMountEl();
      if (!panel || !isActivePanel()) {
        return;
      }
      const markup = buildPanelMarkup();
      if (panel.__jennyIdeRailMarkup === markup) {
        return;
      }
      panel.innerHTML = markup;
      panel.__jennyIdeRailMarkup = markup;
    }

    // Severity counts for the statusbar badge. Reads the cached model so the
    // frequent statusbar re-render stays cheap.
    function getCounts() {
      return model().counts;
    }

    // Marker change (worker finished, file opened/closed): drop the cache and
    // ask the controller to re-render. renderIde refreshes the active panel
    // (us, if showing) AND the statusbar badge in one pass. A full renderIde
    // (rather than a targeted panel+statusbar update) is deliberate: every IDE
    // render is content-hash guarded so unchanged surfaces never touch the DOM,
    // and marker events are infrequent (worker-debounced, only on edit settle /
    // open / close) - so the extra markup recompute is noise.
    function refresh() {
      cachedModel = null;
      requestRender();
    }

    function disposeSubscription() {
      if (markersDisposable && typeof markersDisposable.dispose === 'function') {
        markersDisposable.dispose();
      }
      markersDisposable = null;
    }

    function handleClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      // Selector-guarded: the explorer/search/changes/source-control panels
      // delegate on this same #ideRailPanel element.
      const row = target.closest('[data-ide-prb-path]');
      if (!row) {
        return;
      }
      const path = String(row.dataset.idePrbPath || '');
      if (!path) {
        return;
      }
      onReveal(path, Number(row.dataset.idePrbLine) || 1, Number(row.dataset.idePrbCol) || 1);
    }

    function bindEvents() {
      const panel = getMountEl();
      if (!panel || boundPanel === panel) {
        return;
      }
      boundPanel = panel;
      panel.addEventListener('click', handleClick);
      // Live diagnostics: refresh on every marker change. The host wires the
      // underlying onDidChangeMarkers once Monaco boots and fans out to us.
      if (!markersDisposable && typeof editorHost.onMarkersChanged === 'function') {
        markersDisposable = editorHost.onMarkersChanged(() => refresh());
      }
    }

    function dispose() {
      disposeSubscription();
      if (boundPanel) {
        boundPanel.removeEventListener('click', handleClick);
        boundPanel = null;
      }
    }

    return {
      bindEvents,
      dispose,
      getCounts,
      renderPanel,
    };
  }

  return {
    createIdeProblemsPanel,
  };
});
