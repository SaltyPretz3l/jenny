/* renderer/features/renderer-ide-statusbar.js - Workspace IDE editor chrome:
 * the bottom status bar (Ln/Col + selection count -> go-to-line, word-wrap
 * toggle, tab size, EOL, language id, dirty dot) and the breadcrumbs strip
 * above the editor (ancestor folder segments reveal in the explorer). Pure
 * render-from-callbacks module; the controller owns when to refresh. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeStatusBar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // Branch glyph copied from renderer-dashboard-widgets-git.js (CSP-safe inline
  // SVG, currentColor) and sized down for the statusbar chip.
  const BRANCH_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="4.5" cy="4" r="1.6"></circle><circle cx="4.5" cy="12" r="1.6"></circle><circle cx="11.5" cy="4.5" r="1.6"></circle><path d="M4.5 5.6v4.8"></path><path d="M11.5 6.1v1a3 3 0 0 1-3 3H6"></path></svg>';

  // Problems badge glyphs (same set the Problems panel uses; inline SVG keeps
  // them CSP-safe, currentColor tinted per data-diag-severity).
  const ERROR_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle><path d="M10 6 6 10M6 6l4 4"></path></svg>';
  const WARNING_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5 14 13H2L8 2.5Z"></path><path d="M8 6.4v3"></path><path d="M8 11.2v.1"></path></svg>';
  const PAUSE_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><rect x="4" y="3" width="3" height="10" rx=".7"></rect><rect x="9" y="3" width="3" height="10" rx=".7"></rect></svg>';

  // Bottom-panel toggle glyph: a framed editor with a divider near the bottom
  // edge (the panel). Inline SVG keeps it CSP-safe and currentColor-tinted.
  const PANEL_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1"></rect><path d="M2 10h12"></path></svg>';

  // Run "Running…" indicator glyph: a play triangle in a ring (inline SVG,
  // CSP-safe, currentColor). Paired with a small stop square for the kill action.
  const RUN_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle><path d="M6.6 5.4 11 8l-4.4 2.6Z" fill="currentColor"></path></svg>';
  const STOP_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx="1.2"></rect></svg>';

  // Inline-suggestions toggle glyph: a sparkle (the conventional "AI assist"
  // mark). Inline SVG keeps it CSP-safe and currentColor-tinted; the --active
  // class lights it up when suggestions are on.
  const INLINE_SUGGEST_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M8 2.5l1.3 3.2L12.5 7 9.3 8.3 8 11.5 6.7 8.3 3.5 7l3.2-1.3Z"></path><path d="M12.6 11.4l.4 1.1 1.1.4-1.1.4-.4 1.1-.4-1.1-1.1-.4 1.1-.4Z"></path></svg>';
  // Chevron-down caret: opens the completion-model + load/unload menu.
  const INLINE_SUGGEST_CARET_ICON = '<svg viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="M4 6l4 4 4-4"></path></svg>';

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

  function createIdeStatusBar(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const escapeHtml = typeof deps?.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    const callbacks = deps?.callbacks || {};
    const {
      getCursorInfo = () => null,
      getActiveLanguageId = () => '',
      getBranch = () => '',
      getDirtyCount = () => 0,
      getProblemCounts = () => null,
      getBottomPanelOpen = () => false,
      getRunning = () => false,
      getEol = () => 'lf',
      getTabSize = () => 2,
      isDirty = () => false,
      isDiffTab = () => false,
      getDocumentKind = () => 'file',
      isLargeFile = () => false,
      // Inline autocomplete: visible only when the workspace_inline_suggest
      // feature is on; enabled mirrors the per-user quick toggle; degraded is
      // true when the FIM backend last failed (model not loaded / sidecar down).
      getInlineSuggestVisible = () => false,
      getInlineSuggestEnabled = () => false,
      getInlineSuggestDegraded = () => false,
      getInlineSuggestPaused = () => false,
      getInlineSuggestComputeStatus = () => null,
      onGoToLine = noop,
      onToggleWordWrap = noop,
      onPickTabSize = noop,
      onPickEol = noop,
      onSwitchBranch = noop,
      onOpenProblems = noop,
      onToggleBottomPanel = noop,
      onToggleInlineSuggest = noop,
      onOpenInlineSuggestMenu = noop,
      onKillRun = noop,
    } = callbacks;
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');

    let boundStatusBar = null;

    function buildStatusMarkup(path) {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const ide = getIde();
      const cursor = getCursorInfo() || { lineNumber: 1, column: 1, selectedChars: 0 };
      const selectionSuffix = cursor.selectedChars > 0
        ? ` (${cursor.selectedChars} selected)`
        : '';
      const language = getActiveLanguageId() || 'plaintext';
      const eol = getEol(path) === 'crlf' ? 'CRLF' : 'LF';
      const wrapLabel = ide.wordWrap === 'on' ? 'Wrap: On' : 'Wrap: Off';
      const dirty = isDirty(path);
      // Left-most: the git branch + live dirty count (●N). Clickable - opens the
      // branch switcher (Quick-pick of local branches + create / guarded switch).
      // Hidden outside a repo.
      const branch = String(getBranch() || '').trim();
      const dirtyCount = Number(getDirtyCount()) || 0;
      const countMarkup = dirtyCount > 0
        ? `<span class="ide-statusbar-branch-count">${escapeHtml(`●${dirtyCount}`)}</span>`
        : '';
      const branchTitle = dirtyCount > 0
        ? `Git: ${branch} — ${dirtyCount} change${dirtyCount === 1 ? '' : 's'} (switch branch)`
        : `Git branch: ${branch} (switch branch)`;
      const branchSegment = branch
        ? actionButton({
          plain: true,
          className: 'ide-statusbar-item ide-statusbar-action ide-statusbar-branch',
          title: branchTitle,
          ariaLabel: branchTitle,
          trustedHtml: `${BRANCH_ICON}<span class="ide-statusbar-branch-name">${escapeHtml(branch)}</span>${countMarkup}`,
          dataset: { 'ide-status-action': 'switch-branch' },
        })
        : '';
      // Error/warning counts (open files only) - clicking opens the Problems
      // panel. Shown only when there is at least one error or warning; kept
      // AFTER the branch so the branch stays the left-most segment.
      const problems = getProblemCounts() || null;
      const problemErrors = Number(problems && problems.error) || 0;
      const problemWarnings = Number(problems && problems.warning) || 0;
      const problemsTitle = `${problemErrors} error${problemErrors === 1 ? '' : 's'}, `
        + `${problemWarnings} warning${problemWarnings === 1 ? '' : 's'} (open Problems)`;
      const problemsSegment = problemErrors + problemWarnings > 0
        ? actionButton({
          plain: true,
          className: 'ide-statusbar-item ide-statusbar-action ide-statusbar-problems',
          title: problemsTitle,
          ariaLabel: problemsTitle,
          trustedHtml: `<span class="ide-statusbar-problems-part" data-diag-severity="error">${ERROR_ICON}${escapeHtml(String(problemErrors))}</span>`
            + `<span class="ide-statusbar-problems-part" data-diag-severity="warning">${WARNING_ICON}${escapeHtml(String(problemWarnings))}</span>`,
          dataset: { 'ide-status-action': 'open-problems' },
        })
        : '';
      // Run indicator: shown only while a task launched from "Run this file" /
      // "Run npm script…" is in flight. A non-interactive label span carries the
      // glyph + "Running…"; the nested action-button is the one-click kill.
      const runSegment = getRunning() === true
        ? `<span class="ide-statusbar-item ide-statusbar-run" title="A task is running">`
          + `${RUN_ICON}<span class="ide-statusbar-run-label">Running…</span>`
          + actionButton({
            plain: true,
            className: 'ide-statusbar-run-kill',
            title: 'Stop the running task',
            ariaLabel: 'Stop the running task',
            trustedHtml: STOP_ICON,
            dataset: { 'ide-status-action': 'kill-run' },
          })
          + '</span>'
        : '';
      const minimapOverrideSegment = ide.minimap !== false && isLargeFile(path)
        ? '<span class="ide-statusbar-item ide-statusbar-effective-note" '
          + 'title="Minimap is disabled for this large file to protect editor performance">'
          + 'Minimap: Off (large file)</span>'
        : '';
      // Inline-suggestions quick toggle + caret (only when the feature is on).
      // The toggle keeps the instant on/off click (pressed state mirrors the
      // per-user inlineSuggestEnabled flag); the adjacent caret opens the
      // completion-model + load/unload menu. Both sit in one inline-flex group
      // so they read as a single control. A non-interactive status glyph tells
      // normal chat-stream pauses from genuine FIM degradation; a remembered
      // degraded warning outranks the transient paused state.
      const inlineSuggestEnabledNow = getInlineSuggestEnabled() === true;
      const inlineSuggestDegradedNow =
        inlineSuggestEnabledNow && getInlineSuggestDegraded() === true;
      const inlineSuggestPausedNow =
        inlineSuggestEnabledNow && getInlineSuggestPaused() === true;
      const computeStatus = getInlineSuggestComputeStatus() || {};
      const computeTarget = String(computeStatus.target || 'automatic').trim() || 'automatic';
      const computeReason = String(computeStatus.reason || '').trim();
      const computeTitle = `Compute: ${computeTarget}${computeReason ? ` — ${computeReason}` : ''}`;
      const FIM_DEGRADED_TITLE =
        'Inline suggestions unavailable — the completion model may not be loaded or the sidecar is down';
      const FIM_PAUSED_TITLE = 'Inline suggestions paused while chat is responding.';
      const inlineSuggestStatusTitle = inlineSuggestDegradedNow ? FIM_DEGRADED_TITLE : FIM_PAUSED_TITLE;
      const inlineSuggestWarn = inlineSuggestPausedNow || inlineSuggestDegradedNow
        ? `<span class="ide-statusbar-inline-suggest-warn" data-diag-severity="${inlineSuggestDegradedNow ? 'warning' : 'info'}" role="img" title="${escapeHtml(inlineSuggestStatusTitle)}" aria-label="${escapeHtml(inlineSuggestStatusTitle)}">${inlineSuggestDegradedNow ? WARNING_ICON : PAUSE_ICON}</span>`
        : '';
      const inlineSuggestSegment = getInlineSuggestVisible() === true
        ? `<span class="ide-statusbar-inline-suggest-group">${inlineSuggestWarn}${
          actionButton({
            plain: true,
            className: `ide-statusbar-item ide-statusbar-action ide-statusbar-inline-suggest${inlineSuggestEnabledNow ? ' ide-statusbar-action--active' : ''}${inlineSuggestDegradedNow ? ' ide-statusbar-inline-suggest--warn' : (inlineSuggestPausedNow ? ' ide-statusbar-inline-suggest--paused' : '')}`,
            title: inlineSuggestDegradedNow || inlineSuggestPausedNow
              ? inlineSuggestStatusTitle
              : (inlineSuggestEnabledNow
                ? `Inline suggestions: On (click to turn off). ${computeTitle}`
                : 'Inline suggestions: Off (click to turn on)'),
            ariaLabel: 'Toggle inline suggestions',
            ariaPressed: inlineSuggestEnabledNow,
            trustedHtml: INLINE_SUGGEST_ICON,
            dataset: { 'ide-status-action': 'toggle-inline-suggest' },
          })
        }${
          actionButton({
            plain: true,
            className: 'ide-statusbar-item ide-statusbar-action ide-statusbar-inline-suggest-caret',
            title: 'Completion model & load',
            ariaLabel: 'Open completion model menu',
            ariaHaspopup: 'dialog',
            trustedHtml: INLINE_SUGGEST_CARET_ICON,
            dataset: { 'ide-status-action': 'inline-suggest-menu' },
          })
        }</span>`
        : '';
      return branchSegment
        + problemsSegment
        + runSegment
        + minimapOverrideSegment
        + actionButton({
        plain: true,
        className: 'ide-statusbar-item ide-statusbar-action',
        title: 'Go to Line/Column (Ctrl+G)',
        trustedHtml: escapeHtml(`Ln ${cursor.lineNumber}, Col ${cursor.column}${selectionSuffix}`),
        dataset: { 'ide-status-action': 'go-to-line' },
      })
        + '<span class="ide-statusbar-spacer"></span>'
        + (dirty ? '<span class="ide-statusbar-item ide-statusbar-dirty" title="Unsaved changes">●</span>' : '')
        + actionButton({
          plain: true,
          className: 'ide-statusbar-item ide-statusbar-action',
          title: 'Toggle Word Wrap (Alt+Z)',
          trustedHtml: escapeHtml(wrapLabel),
          dataset: { 'ide-status-action': 'toggle-wrap' },
        })
        + actionButton({
          plain: true,
          className: 'ide-statusbar-item ide-statusbar-action',
          title: 'Select indentation size',
          trustedHtml: escapeHtml(`Spaces: ${Number(getTabSize()) || 2}`),
          dataset: { 'ide-status-action': 'tab-size' },
        })
        + actionButton({
          plain: true,
          className: 'ide-statusbar-item ide-statusbar-action',
          title: 'Select line ending',
          trustedHtml: escapeHtml(eol),
          dataset: { 'ide-status-action': 'eol' },
        })
        + `<span class="ide-statusbar-item">${escapeHtml(language)}</span>`
        + inlineSuggestSegment
        // Far-right layout control: an always-present bottom-panel toggle so the
        // panel is discoverable without knowing the Ctrl+` shortcut. Pressed
        // state mirrors bottomPanelOpen.
        + actionButton({
          plain: true,
          className: `ide-statusbar-item ide-statusbar-action ide-statusbar-panel${getBottomPanelOpen() === true ? ' ide-statusbar-action--active' : ''}`,
          title: 'Toggle bottom panel (Ctrl+`)',
          ariaLabel: 'Toggle bottom panel',
          ariaPressed: getBottomPanelOpen() === true,
          trustedHtml: PANEL_ICON,
          dataset: { 'ide-status-action': 'toggle-panel' },
        });
    }

    function buildBreadcrumbsMarkup(path) {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const segments = String(path || '').split('/').filter(Boolean);
      const parts = [];
      let prefix = '';
      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index];
        prefix = prefix ? `${prefix}/${segment}` : segment;
        const isLeaf = index === segments.length - 1;
        if (index > 0) {
          parts.push('<span class="ide-crumb-sep" aria-hidden="true">›</span>');
        }
        if (isLeaf) {
          // Leaf (filename) crumb: a button that opens the file's symbol outline
          // (renderer-ide-breadcrumbs.js handles the click via data-ide-crumb-leaf).
          parts.push(actionButton({
            plain: true,
            className: 'ide-crumb ide-crumb--leaf ide-crumb-action',
            // quickOutline opens a filterable listbox picker (role=listbox), not a
            // role=menu — advertise the matching popup so AT announces it correctly.
            ariaHaspopup: 'listbox',
            title: `Outline of ${segment}`,
            trustedHtml: escapeHtml(segment),
            dataset: { 'ide-crumb-leaf': prefix },
          }));
        } else {
          // Folder crumb: opens a dropdown of that folder's contents (handled in
          // renderer-ide-breadcrumbs.js via data-ide-crumb-path).
          parts.push(actionButton({
            plain: true,
            className: 'ide-crumb ide-crumb-action',
            ariaHaspopup: 'menu',
            title: `Browse ${prefix}`,
            trustedHtml: escapeHtml(segment),
            dataset: { 'ide-crumb-path': prefix },
          }));
        }
      }
      return parts.join('');
    }

    // Re-renders both chrome strips for the active tab. Diff tabs and the
    // empty state hide them; image previews keep the breadcrumbs but drop
    // the text-editing status strip (no cursor/EOL to report).
    function render() {
      const dom = getDom();
      const ide = getIde();
      const path = String(ide.activeTabPath || '');
      const visible = Boolean(path) && !isDiffTab(path);
      const statusVisible = visible && getDocumentKind(path) !== 'image';
      if (dom.ideStatusBar) {
        const markup = statusVisible ? buildStatusMarkup(path) : '';
        if (dom.ideStatusBar.__jennyIdeStatusMarkup !== markup) {
          dom.ideStatusBar.innerHTML = markup;
          dom.ideStatusBar.__jennyIdeStatusMarkup = markup;
        }
        dom.ideStatusBar.classList.toggle('hidden', !statusVisible);
      }
      if (dom.ideBreadcrumbs) {
        const markup = visible ? buildBreadcrumbsMarkup(path) : '';
        if (dom.ideBreadcrumbs.__jennyIdeCrumbMarkup !== markup) {
          dom.ideBreadcrumbs.innerHTML = markup;
          dom.ideBreadcrumbs.__jennyIdeCrumbMarkup = markup;
        }
        dom.ideBreadcrumbs.classList.toggle('hidden', !visible);
      }
    }

    function handleStatusClick(event) {
      const action = event.target?.closest?.('[data-ide-status-action]');
      if (!action) {
        return;
      }
      if (action.dataset.ideStatusAction === 'go-to-line') {
        onGoToLine();
      } else if (action.dataset.ideStatusAction === 'toggle-wrap') {
        onToggleWordWrap();
      } else if (action.dataset.ideStatusAction === 'tab-size') {
        onPickTabSize(action);
      } else if (action.dataset.ideStatusAction === 'eol') {
        onPickEol(action);
      } else if (action.dataset.ideStatusAction === 'switch-branch') {
        onSwitchBranch();
      } else if (action.dataset.ideStatusAction === 'open-problems') {
        onOpenProblems();
      } else if (action.dataset.ideStatusAction === 'toggle-panel') {
        onToggleBottomPanel();
      } else if (action.dataset.ideStatusAction === 'toggle-inline-suggest') {
        onToggleInlineSuggest();
      } else if (action.dataset.ideStatusAction === 'inline-suggest-menu') {
        onOpenInlineSuggestMenu(action);
      } else if (action.dataset.ideStatusAction === 'kill-run') {
        onKillRun();
      }
    }

    function bindEvents() {
      const dom = getDom();
      if (dom.ideStatusBar && !boundStatusBar) {
        boundStatusBar = dom.ideStatusBar;
        boundStatusBar.addEventListener('click', handleStatusClick);
      }
    }

    function dispose() {
      boundStatusBar?.removeEventListener('click', handleStatusClick);
      boundStatusBar = null;
    }

    return {
      bindEvents,
      dispose,
      render,
    };
  }

  return {
    createIdeStatusBar,
  };
});
