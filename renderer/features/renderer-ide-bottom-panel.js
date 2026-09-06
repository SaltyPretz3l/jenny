/* renderer/features/renderer-ide-bottom-panel.js - Workspace IDE bottom panel
 * (the multi-container "Layout foundation"). A collapsible horizontal container
 * that nests inside #ideMain between the editor stage and the statusbar, hosting
 * the Terminal + Problems views (re-homed out of the rail) plus a Run-output
 * placeholder, as tabbed views. This module owns the tab bar, the collapse
 * toggle, and the top-edge resize drag; it mutates ide.bottomPanel* state and
 * delegates content rendering to each view's injected render() (Terminal +
 * Problems own their own markup into the shared #ideBottomPanelContent host,
 * exactly as they used to share #ideRailPanel). Models renderer-ide-rail.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeBottomPanel = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // Mirror the renderer-ide-state.js clamp bounds (UMD module can't import it,
  // same precedent as rail's clampRailWidth).
  const MIN_BOTTOM_HEIGHT = 80;
  const MAX_BOTTOM_HEIGHT = 600;
  const KEYBOARD_RESIZE_STEP = 24;
  // Trailing collapse control glyph (inline, CSP-safe).
  const COLLAPSE_GLYPH = '<span aria-hidden="true">&#x2715;</span>';
  // Collapsed-state handle glyph: a chevron pointing up (expand upward), inline
  // and CSP-safe.
  const HANDLE_GLYPH = '<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10l4-4 4 4"></path></svg>';
  // The bottom panel's fixed tab set. Terminal + Problems + Run have real
  // renderers (injected); Test Runner routes to its injected renderTestRunner
  // when wired, else falls through to the placeholder (mirrors how Run shipped).
  const VIEWS = [
    { id: 'terminal', label: 'Terminal' },
    { id: 'problems', label: 'Problems' },
    { id: 'run', label: 'Run output' },
    { id: 'test-runner', label: 'Test Runner' },
  ];

  function resolveActionButton() {
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

  function clampHeight(value) {
    const height = Number(value);
    if (!Number.isFinite(height)) {
      return MIN_BOTTOM_HEIGHT;
    }
    return Math.min(MAX_BOTTOM_HEIGHT, Math.max(MIN_BOTTOM_HEIGHT, Math.round(height)));
  }

  function createIdeBottomPanel(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const escapeHtml = typeof deps?.escapeHtml === 'function'
      ? deps.escapeHtml
      : (value) => String(value == null ? '' : value);
    const requestRender = typeof deps?.requestRender === 'function' ? deps.requestRender : noop;
    const schedulePersist = typeof deps?.schedulePersist === 'function' ? deps.schedulePersist : noop;
    // Injected view renderers paint the shared host, while missing Run or Test Runner renderers degrade to the placeholder.
    const renderTerminal = typeof deps?.renderTerminal === 'function' ? deps.renderTerminal : noop;
    const renderProblems = typeof deps?.renderProblems === 'function' ? deps.renderProblems : noop;
    const renderRun = typeof deps?.renderRun === 'function' ? deps.renderRun : null;
    const renderTestRunner = typeof deps?.renderTestRunner === 'function' ? deps.renderTestRunner : null;
    // UIUX-011: when true, Terminal owns a persistent host (#ideBottomTerminalHost)
    // outside the shared #ideBottomPanelContent that Problems/Run/Test Runner
    // innerHTML-replace on every activation. Terminal's live xterm instance +
    // ResizeObserver need a host that is never destructively rewritten by a
    // sibling view, so switching views toggles visibility between the two hosts
    // instead of tearing Terminal's DOM down. Defaults false (legacy line-terminal
    // stays in the shared host exactly as before — it holds no live external
    // resource that a rebuild would orphan).
    const hasPersistentTerminalHost = typeof deps?.hasPersistentTerminalHost === 'function'
      ? deps.hasPersistentTerminalHost
      : () => false;
    const actionButton = resolveActionButton();
    const windowRef = globalRef.window || globalRef;

    let boundTabs = null;
    let boundResizer = null;
    let boundHandle = null;
    let dragState = null; // { startY, startHeight }

    function activeViewId() {
      const id = getIde().bottomPanelActiveView;
      return VIEWS.some((view) => view.id === id) ? id : (VIEWS[0]?.id || '');
    }

    // Setting --ide-bottom-height on #ideShell (an ancestor of .ide-bottom-panel)
    // drives its flex-basis; the :root default backs it up before the first render.
    function applyHeightVar() {
      const shell = getDom().ideShell || getDom().ideMain || null;
      shell?.style?.setProperty('--ide-bottom-height', `${clampHeight(getIde().bottomPanelHeight)}px`);
    }

    function applyOpenState() {
      const dom = getDom();
      const open = getIde().bottomPanelOpen === true;
      if (dom.ideBottomPanel) {
        dom.ideBottomPanel.classList.toggle('hidden', !open);
        dom.ideBottomPanel.setAttribute('data-open', open ? 'true' : 'false');
      }
      dom.ideBottomResizer?.classList.toggle('hidden', !open);
      // The collapsed handle is the inverse of the panel: shown only when closed.
      dom.ideBottomHandle?.classList.toggle('hidden', open);
    }

    // UIUX-011: when Terminal has a persistent host, exactly one of the two
    // content hosts is visible at a time — never both (no visual overlap) and
    // never neither (no blank panel). Runs unconditionally (even while the
    // bottom panel is collapsed) so state is already correct the instant it
    // reopens; a plain CSS toggle is cheap regardless of open state.
    function applyTerminalHostVisibility() {
      const dom = getDom();
      const terminalHost = dom.ideBottomTerminalHost || null;
      if (!terminalHost || !hasPersistentTerminalHost()) {
        terminalHost?.classList.add('hidden');
        return;
      }
      const showTerminalHost = activeViewId() === 'terminal';
      terminalHost.classList.toggle('hidden', !showTerminalHost);
      dom.ideBottomPanelContent?.classList.toggle('hidden', showTerminalHost);
    }

    function buildTabsMarkup() {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const active = activeViewId();
      // Each view button is a tab; roving tabindex keeps only the active one in
      // the Tab order (arrows move between the rest - handleTabsKeydown).
      const tabs = VIEWS.map((view) => actionButton({
        plain: true,
        className: `ide-bottom-tab${view.id === active ? ' ide-bottom-tab--active' : ''}`,
        role: 'tab',
        ariaSelected: view.id === active,
        tabIndex: view.id === active ? 0 : -1,
        label: view.label || view.id,
        title: view.label || view.id,
        dataset: { 'ide-bottom-view': view.id },
      }));
      // Only role=tab children may live in a tablist, so the view tabs sit in an
      // inner role="tablist" wrapper (display:contents preserves the flex layout)
      // while the collapse button stays a sibling in the role="toolbar" bar.
      const tablist = `<div class="ide-tablist-group" role="tablist" aria-label="Bottom panel views">${tabs.join('')}</div>`;
      const collapse = actionButton({
        plain: true,
        className: 'ide-bottom-collapse',
        ariaLabel: 'Hide bottom panel',
        title: 'Hide panel (Ctrl+`)',
        dataset: { 'ide-bottom-collapse': '1' },
        trustedHtml: COLLAPSE_GLYPH,
      });
      return tablist + collapse;
    }

    function renderTabs() {
      const tabs = getDom().ideBottomTabs || null;
      if (!tabs) {
        return;
      }
      const markup = buildTabsMarkup();
      if (tabs.__jennyIdeBottomTabs !== markup) {
        tabs.innerHTML = markup;
        tabs.__jennyIdeBottomTabs = markup;
      }
    }

    // Collapsed-state handle: a single click target (visible only while closed,
    // toggled by applyOpenState) labelled with the view it will reopen.
    function buildHandleMarkup() {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const view = VIEWS.find((entry) => entry.id === activeViewId()) || VIEWS[0];
      const label = (view && view.label) || 'Panel';
      return actionButton({
        plain: true,
        className: 'ide-bottom-handle-btn',
        ariaLabel: `Show bottom panel (${label})`,
        title: `Show panel: ${label} (Ctrl+\`)`,
        dataset: { 'ide-bottom-handle': '1' },
        trustedHtml: `${HANDLE_GLYPH}<span class="ide-bottom-handle-label">${escapeHtml(label)}</span>`,
      });
    }

    function renderHandle() {
      const handle = getDom().ideBottomHandle || null;
      if (!handle) {
        return;
      }
      const markup = buildHandleMarkup();
      if (handle.__jennyIdeBottomHandle !== markup) {
        handle.innerHTML = markup;
        handle.__jennyIdeBottomHandle = markup;
      }
    }

    // Placeholder for a view with no content renderer yet (Run output). Reuses
    // the rail placeholder visual classes so the bottom panel never looks empty.
    function buildPlaceholderMarkup(view) {
      const label = escapeHtml((view && view.label) || 'Output');
      return `
        <div class="ide-rail-placeholder" data-ide-bottom-placeholder="${escapeHtml((view && view.id) || '')}">
          <div class="ide-rail-placeholder-title">${label}</div>
          <p class="ide-rail-placeholder-copy">Run a script or task here - the ${label} view lands here.</p>
        </div>
      `;
    }

    function renderContent() {
      // Terminal/Problems own their write into #ideBottomPanelContent (each
      // guards isActivePanel()); the bottom panel only routes which one paints.
      const id = activeViewId();
      if (id === 'terminal') {
        renderTerminal();
        return;
      }
      if (id === 'problems') {
        renderProblems();
        return;
      }
      if (id === 'run' && renderRun) {
        renderRun();
        return;
      }
      if (id === 'test-runner' && renderTestRunner) {
        renderTestRunner();
        return;
      }
      const host = getDom().ideBottomPanelContent || null;
      const markup = buildPlaceholderMarkup(VIEWS.find((view) => view.id === id));
      if (host && host.__jennyIdeRailMarkup !== markup) {
        host.innerHTML = markup;
        host.__jennyIdeRailMarkup = markup;
      }
    }

    // Called by the layout module on every renderIde pass.
    function render() {
      applyOpenState();
      applyHeightVar();
      applyTerminalHostVisibility();
      // The collapsed handle is cheap + content-hash guarded; render it every
      // pass so its label tracks the active view (it is hidden while open).
      renderHandle();
      if (getIde().bottomPanelOpen !== true) {
        return; // collapsed: skip tab/content churn
      }
      renderTabs();
      renderContent();
    }

    // Switching views reuses the shared content host. Terminal writes a fixed
    // sentinel + Problems/Run write a content hash into host.__jennyIdeRailMarkup,
    // so the incoming view always repaints; nulling it here is belt-and-suspenders
    // so a future view that hashes identically can't short-circuit its first paint.
    function switchView(id) {
      const host = getDom().ideBottomPanelContent || null;
      if (host) {
        host.__jennyIdeRailMarkup = null;
      }
      getIde().bottomPanelActiveView = id;
    }

    function open(view) {
      const ide = getIde();
      if (view && VIEWS.some((entry) => entry.id === view) && ide.bottomPanelActiveView !== view) {
        switchView(view);
      }
      ide.bottomPanelOpen = true;
      schedulePersist();
      requestRender();
    }

    function close() {
      getIde().bottomPanelOpen = false;
      schedulePersist();
      requestRender();
    }

    function toggle() {
      if (getIde().bottomPanelOpen === true) {
        close();
      } else {
        open();
      }
    }

    function setActiveView(id) {
      if (!VIEWS.some((view) => view.id === id)) {
        return;
      }
      const ide = getIde();
      if (ide.bottomPanelActiveView === id && ide.bottomPanelOpen === true) {
        return;
      }
      switchView(id);
      ide.bottomPanelOpen = true;
      schedulePersist();
      requestRender();
    }

    function handleTabsClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      if (target.closest('[data-ide-bottom-collapse]')) {
        close();
        return;
      }
      const tab = target.closest('[data-ide-bottom-view]');
      if (tab) {
        setActiveView(tab.dataset.ideBottomView);
      }
    }

    function handleHandleClick(event) {
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest('[data-ide-bottom-handle]')) {
        open(); // reopen on the last active view
      }
    }

    // Roving arrow-key focus across the view tabs (horizontal bar, so Left/Right
    // and Up/Down both move, plus Home/End), with automatic activation. render()
    // rebuilds the tab bar synchronously, so we re-query the new active tab and
    // restore focus to it. The collapse button is NOT a tab, so arrows on it are
    // ignored.
    function handleTabsKeydown(event) {
      const fromTab = event.target?.closest?.('[data-ide-bottom-view]');
      if (!fromTab) {
        return;
      }
      const step = event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
      if (step === 0 && event.key !== 'Home' && event.key !== 'End') {
        return;
      }
      const tabsEl = getDom().ideBottomTabs || null;
      const tabs = tabsEl ? [...tabsEl.querySelectorAll('[data-ide-bottom-view]')] : [];
      if (tabs.length === 0) {
        return;
      }
      event.preventDefault();
      const current = Math.max(0, tabs.indexOf(fromTab));
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (current + step + tabs.length) % tabs.length;
      const viewId = tabs[next].dataset.ideBottomView;
      setActiveView(viewId);
      // After the synchronous re-render the old node is gone; focus the fresh one.
      const refreshed = getDom().ideBottomTabs?.querySelector?.(`[data-ide-bottom-view="${viewId}"]`);
      (refreshed || tabs[next]).focus?.();
    }

    function handlePointerMove(event) {
      if (!dragState) {
        return;
      }
      // Resizer sits on the panel's TOP edge: dragging up (clientY decreases)
      // grows the panel.
      const delta = dragState.startY - event.clientY;
      getIde().bottomPanelHeight = clampHeight(dragState.startHeight + delta);
      applyHeightVar();
    }

    function endDrag() {
      if (!dragState) {
        return;
      }
      dragState = null;
      windowRef.removeEventListener?.('pointermove', handlePointerMove);
      windowRef.removeEventListener?.('pointerup', endDrag);
      windowRef.removeEventListener?.('pointercancel', endDrag);
      schedulePersist();
    }

    function handleResizerPointerDown(event) {
      if (typeof event.button === 'number' && event.button !== 0) {
        return;
      }
      dragState = { startY: event.clientY, startHeight: clampHeight(getIde().bottomPanelHeight) };
      try {
        boundResizer?.setPointerCapture?.(event.pointerId);
      } catch (_error) {
        /* pointer capture is best-effort (absent in jsdom) */
      }
      windowRef.addEventListener?.('pointermove', handlePointerMove);
      windowRef.addEventListener?.('pointerup', endDrag);
      windowRef.addEventListener?.('pointercancel', endDrag);
      event.preventDefault?.();
    }

    function handleResizerKeydown(event) {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
        return;
      }
      const step = event.key === 'ArrowUp' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
      getIde().bottomPanelHeight = clampHeight((Number(getIde().bottomPanelHeight) || MIN_BOTTOM_HEIGHT) + step);
      applyHeightVar();
      schedulePersist();
      event.preventDefault();
    }

    function bindEvents() {
      const dom = getDom();
      if (dom.ideBottomTabs && !boundTabs) {
        boundTabs = dom.ideBottomTabs;
        boundTabs.addEventListener('click', handleTabsClick);
        boundTabs.addEventListener('keydown', handleTabsKeydown);
      }
      if (dom.ideBottomResizer && !boundResizer) {
        boundResizer = dom.ideBottomResizer;
        boundResizer.addEventListener('pointerdown', handleResizerPointerDown);
        boundResizer.addEventListener('keydown', handleResizerKeydown);
      }
      if (dom.ideBottomHandle && !boundHandle) {
        boundHandle = dom.ideBottomHandle;
        boundHandle.addEventListener('click', handleHandleClick);
      }
    }

    function dispose() {
      endDrag();
      if (boundTabs) {
        boundTabs.removeEventListener('click', handleTabsClick);
        boundTabs.removeEventListener('keydown', handleTabsKeydown);
        boundTabs = null;
      }
      if (boundResizer) {
        boundResizer.removeEventListener('pointerdown', handleResizerPointerDown);
        boundResizer.removeEventListener('keydown', handleResizerKeydown);
        boundResizer = null;
      }
      if (boundHandle) {
        boundHandle.removeEventListener('click', handleHandleClick);
        boundHandle = null;
      }
    }

    return {
      bindEvents,
      close,
      dispose,
      open,
      render,
      setActiveView,
      toggle,
    };
  }

  return {
    MIN_BOTTOM_HEIGHT,
    MAX_BOTTOM_HEIGHT,
    clampHeight,
    createIdeBottomPanel,
  };
});
