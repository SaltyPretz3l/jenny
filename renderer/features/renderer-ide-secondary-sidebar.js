/* renderer/features/renderer-ide-secondary-sidebar.js - Workspace IDE secondary
 * sidebar (the "multi-container workbench" second side panel). A second side
 * container OPPOSITE the primary rail (rail left -> sidebar right, rail right ->
 * sidebar left) that hosts the rail panels the user has MOVED here (the "Move
 * View" model: a panel lives on exactly one side, per ide.panelLocations).
 *
 * Like the primary rail (renderer-ide-rail.js), this module owns only the
 * container CHROME: the open/close visibility lifecycle (it drives
 * [data-secondary-open] on #ideShell, which the CSS grid reads to size the
 * `secondary` column), the persisted width + the left/right-aware resize drag,
 * and the header. The header mirrors the primary rail's activity bar
 * (.ide-activitybar / .ide-activity-button): one button per LOCATED panel to
 * switch the active one (right-click a button to move it back to the primary
 * rail), + a collapse control. The panel CONTENT is rendered by the panels' own
 * single instances into this host via their location-aware getMountEl. Modelled
 * on the bottom panel. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeSecondarySidebar = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // Mirror renderer-ide-state.js clamp bounds; the 600px maximum is safe because
  // renderer-ide-layout.js clamps the applied width to the viewport budget.
  const MIN_SECONDARY_WIDTH = 160;
  const MAX_SECONDARY_WIDTH = 600;
  const KEYBOARD_RESIZE_STEP = 24;
  // Trailing collapse (hide) control glyph (inline, CSP-safe).
  const COLLAPSE_GLYPH = '<span aria-hidden="true">&#x2715;</span>';
  // The label source for every rail panel; the header renders a button only for
  // the panels currently LOCATED in the secondary sidebar (ide.panelLocations).
  const PANELS = [
    { id: 'explorer', label: 'Explorer' },
    { id: 'search', label: 'Search' },
    { id: 'changes', label: "Jenny's Changes" },
    { id: 'source-control', label: 'Source Control' },
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

  // The shared context-menu primitive backs the right-click "Move View" action
  // (it replaced the old hover control). Resolved like actionButton.
  function resolveContextMenu() {
    if (globalRef.inventoryContextMenu) {
      return globalRef.inventoryContextMenu;
    }
    if (typeof require === 'function') {
      try {
        return require('../inventory/context-menu');
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  function clampWidth(value) {
    const width = Number(value);
    if (!Number.isFinite(width)) {
      return MIN_SECONDARY_WIDTH;
    }
    return Math.min(MAX_SECONDARY_WIDTH, Math.max(MIN_SECONDARY_WIDTH, Math.trunc(width)));
  }

  function createIdeSecondarySidebar(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const requestRender = typeof deps?.requestRender === 'function' ? deps.requestRender : noop;
    const schedulePersist = typeof deps?.schedulePersist === 'function' ? deps.schedulePersist : noop;
    // Optional: re-homes a panel to the other side (the right-click "Move to
    // Primary Sidebar" menu item). When absent, no move action is offered.
    const onMovePanel = typeof deps?.onMovePanel === 'function' ? deps.onMovePanel : null;
    // Viewport-aware ceiling (renderer-ide-layout.js budget); default = none.
    const getMaxWidth = typeof deps?.getMaxWidth === 'function' ? deps.getMaxWidth : () => Infinity;
    const actionButton = resolveActionButton();

    function clampWidthForViewport(value) {
      const dynamicMax = Number(getMaxWidth());
      const bounded = clampWidth(value);
      return Number.isFinite(dynamicMax)
        ? Math.max(MIN_SECONDARY_WIDTH, Math.min(bounded, Math.trunc(dynamicMax)))
        : bounded;
    }
    const contextMenu = resolveContextMenu();
    const windowRef = globalRef.window || globalRef;

    let boundHeader = null;
    let boundResizer = null;
    let dragState = null; // { startX, startWidth }

    // The panels currently homed in the secondary sidebar (in PANELS order, which
    // mirrors the rail's panel order), with their labels - the header's tabs.
    function secondaryPanelList() {
      const ide = getIde();
      return PANELS.filter((panel) => ide.panelLocations && ide.panelLocations[panel.id] === 'secondary');
    }

    // The active tab: the located panel matching secondaryPanel, else the first
    // located panel, else '' (empty side).
    function activePanelId() {
      const list = secondaryPanelList();
      const id = getIde().secondaryPanel;
      return list.some((panel) => panel.id === id) ? id : (list[0]?.id || '');
    }

    // The sidebar sits OPPOSITE the rail: rail right -> sidebar on the left.
    function isOnLeft() {
      return getIde().railSide === 'right';
    }

    // Setting --ide-secondary-sidebar-width on #ideShell (the grid container)
    // sizes the `secondary` column; the :root default backs it before first
    // render. Value-guarded (mirrors the rail's applyRailGeometry) so a no-change
    // render pass does not re-write the property.
    function applyWidthVar() {
      const shell = getDom().ideShell || null;
      if (!shell?.style) {
        return;
      }
      // Display-level viewport clamp (hydration / persisted load / resize
      // renders); the persisted preference itself is not mutated.
      const next = `${clampWidthForViewport(getIde().secondaryWidth)}px`;
      if (shell.style.getPropertyValue('--ide-secondary-sidebar-width') !== next) {
        shell.style.setProperty('--ide-secondary-sidebar-width', next);
      }
    }

    // Drive [data-secondary-open] on #ideShell (the CSS grid reads it to add the
    // `secondary` column) and hide the container + resizer while collapsed. The
    // shell attribute is value-guarded so a no-change pass is a true no-op.
    function applyOpenState() {
      const dom = getDom();
      // An empty secondary side is always visually closed, even if the open flag
      // is stale - there is nothing to show.
      const open = getIde().secondaryPanelOpen === true && secondaryPanelList().length > 0;
      const openAttr = open ? 'true' : 'false';
      if (dom.ideShell && dom.ideShell.getAttribute('data-secondary-open') !== openAttr) {
        dom.ideShell.setAttribute('data-secondary-open', openAttr);
      }
      dom.ideSecondarySidebar?.classList.toggle('hidden', !open);
      dom.ideSecondarySidebarResizer?.classList.toggle('hidden', !open);
      return open;
    }

    function buildHeaderMarkup() {
      if (typeof actionButton !== 'function') {
        return '';
      }
      const list = secondaryPanelList();
      const active = activePanelId();
      // The active tab owns the single roving tabindex=0; defensively fall back to
      // the first tab so the tablist always keeps one Tab-reachable member.
      const activeIndex = list.findIndex((panel) => panel.id === active);
      const focusIndex = activeIndex >= 0 ? activeIndex : 0;
      // Mirror the primary rail's activity bar: each located panel is a plain
      // .ide-activity-button. Moving it back to the rail is a right-click action
      // (handleHeaderContextMenu). Roving tabindex + arrow keys (handleHeaderKeydown)
      // match the rail so the tablist behaves like a real tab widget.
      const tabs = list.map((panel, index) => actionButton({
        plain: true,
        className: `ide-activity-button${panel.id === active ? ' ide-activity-button--active' : ''}`,
        role: 'tab',
        ariaSelected: panel.id === active,
        tabIndex: index === focusIndex ? 0 : -1,
        label: panel.label || panel.id,
        title: panel.label || panel.id,
        dataset: { 'ide-secondary-panel': panel.id },
      }));
      // Only role=tab children may live in a tablist, so the panel tabs sit in an
      // inner role="tablist" wrapper (display:contents keeps the header's flex
      // layout) while the collapse button stays a sibling in the role="toolbar".
      const tablist = `<div class="ide-tablist-group" role="tablist" aria-label="Secondary sidebar panels">${tabs.join('')}</div>`;
      const collapse = actionButton({
        plain: true,
        className: 'ide-secondary-sidebar-collapse',
        ariaLabel: 'Hide secondary sidebar',
        title: 'Hide secondary sidebar',
        dataset: { 'ide-secondary-collapse': '1' },
        trustedHtml: COLLAPSE_GLYPH,
      });
      return tablist + collapse;
    }

    function renderHeader() {
      const header = getDom().ideSecondarySidebarHeader || null;
      if (!header) {
        return;
      }
      const markup = buildHeaderMarkup();
      if (header.__jennyIdeSecondaryHeader !== markup) {
        header.innerHTML = markup;
        header.__jennyIdeSecondaryHeader = markup;
      }
    }

    // Called by the layout module on every renderIde pass. Chrome only - the
    // panels' single instances paint their own content into this host.
    function render() {
      const open = applyOpenState();
      applyWidthVar();
      if (!open) {
        return; // collapsed or empty: skip header churn
      }
      renderHeader();
    }

    function open(panel) {
      const ide = getIde();
      if (panel && secondaryPanelList().some((entry) => entry.id === panel)) {
        ide.secondaryPanel = panel;
      }
      ide.secondaryPanelOpen = true;
      schedulePersist();
      requestRender();
    }

    function close() {
      getIde().secondaryPanelOpen = false;
      schedulePersist();
      requestRender();
    }

    function toggle() {
      if (getIde().secondaryPanelOpen === true) {
        close();
      } else {
        open();
      }
    }

    // Switch the active tab among the panels LOCATED in the secondary sidebar
    // (moving a panel here/away is onMovePanel's job, not this).
    function setPanel(id) {
      if (!secondaryPanelList().some((panel) => panel.id === id)) {
        return;
      }
      const ide = getIde();
      if (ide.secondaryPanel === id && ide.secondaryPanelOpen === true) {
        return;
      }
      ide.secondaryPanel = id;
      ide.secondaryPanelOpen = true;
      schedulePersist();
      requestRender();
    }

    function handleHeaderClick(event) {
      const target = event.target;
      if (!target || typeof target.closest !== 'function') {
        return;
      }
      if (target.closest('[data-ide-secondary-collapse]')) {
        close();
        return;
      }
      const tab = target.closest('[data-ide-secondary-panel]');
      if (tab) {
        setPanel(tab.dataset.ideSecondaryPanel);
      }
    }

    // Right-click a panel button to move it back to the primary rail (the "Move
    // View" affordance). Moving to the primary side is always allowed - the rail
    // can always grow - so the action is never disabled.
    function handleHeaderContextMenu(event) {
      if (!onMovePanel || typeof contextMenu?.show !== 'function') {
        return;
      }
      const tab = event.target?.closest?.('[data-ide-secondary-panel]');
      const id = tab?.dataset?.ideSecondaryPanel;
      if (!id || !secondaryPanelList().some((panel) => panel.id === id)) {
        return;
      }
      event.preventDefault?.();
      contextMenu.show({
        rootEl: getDom().ideSecondarySidebarHeader || null,
        anchorX: event.clientX,
        anchorY: event.clientY,
        items: [{
          label: 'Move to Primary Sidebar',
          action: () => onMovePanel(id, 'primary'),
        }],
      });
    }

    // Roving arrow-key focus across the panel tabs (vertical header, so
    // ArrowUp/Down + Home/End), with automatic activation. render() rebuilds the
    // header synchronously, so we re-query the new active tab and restore focus to
    // it. The collapse button is NOT a tab, so arrows pressed on it are ignored.
    function handleHeaderKeydown(event) {
      const fromTab = event.target?.closest?.('[data-ide-secondary-panel]');
      if (!fromTab) {
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step === 0 && event.key !== 'Home' && event.key !== 'End') {
        return;
      }
      const header = getDom().ideSecondarySidebarHeader || null;
      const tabs = header ? [...header.querySelectorAll('[data-ide-secondary-panel]')] : [];
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
      const panelId = tabs[next].dataset.ideSecondaryPanel;
      setPanel(panelId);
      // After the synchronous re-render the old node is gone; focus the fresh one.
      const refreshed = getDom().ideSecondarySidebarHeader?.querySelector?.(`[data-ide-secondary-panel="${panelId}"]`);
      (refreshed || tabs[next]).focus?.();
    }

    function handlePointerMove(event) {
      if (!dragState) {
        return;
      }
      // The grab edge is the sidebar's INNER edge (facing the editor): when the
      // sidebar is on the left, dragging right (clientX grows) widens it; when on
      // the right, dragging left (clientX shrinks) widens it.
      const delta = isOnLeft()
        ? event.clientX - dragState.startX
        : dragState.startX - event.clientX;
      getIde().secondaryWidth = clampWidthForViewport(dragState.startWidth + delta);
      applyWidthVar();
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
      dragState = { startX: event.clientX, startWidth: clampWidth(getIde().secondaryWidth) };
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
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }
      // Side-aware so the keyboard matches the grab edge + the pointer drag: the
      // "grow" key points AWAY from the editor. Sidebar on the left (rail right)
      // -> grab edge on the right -> ArrowRight grows; sidebar on the right ->
      // grab edge on the left -> ArrowLeft grows.
      const growKey = isOnLeft() ? 'ArrowRight' : 'ArrowLeft';
      const step = event.key === growKey ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
      getIde().secondaryWidth = clampWidthForViewport((Number(getIde().secondaryWidth) || MIN_SECONDARY_WIDTH) + step);
      applyWidthVar();
      schedulePersist();
      event.preventDefault();
    }

    function bindEvents() {
      const dom = getDom();
      if (dom.ideSecondarySidebarHeader && !boundHeader) {
        boundHeader = dom.ideSecondarySidebarHeader;
        boundHeader.addEventListener('click', handleHeaderClick);
        boundHeader.addEventListener('contextmenu', handleHeaderContextMenu);
        boundHeader.addEventListener('keydown', handleHeaderKeydown);
      }
      if (dom.ideSecondarySidebarResizer && !boundResizer) {
        boundResizer = dom.ideSecondarySidebarResizer;
        boundResizer.addEventListener('pointerdown', handleResizerPointerDown);
        boundResizer.addEventListener('keydown', handleResizerKeydown);
      }
    }

    function dispose() {
      endDrag();
      if (boundHeader) {
        boundHeader.removeEventListener('click', handleHeaderClick);
        boundHeader.removeEventListener('contextmenu', handleHeaderContextMenu);
        boundHeader.removeEventListener('keydown', handleHeaderKeydown);
        boundHeader = null;
      }
      if (boundResizer) {
        boundResizer.removeEventListener('pointerdown', handleResizerPointerDown);
        boundResizer.removeEventListener('keydown', handleResizerKeydown);
        boundResizer = null;
      }
    }

    return {
      bindEvents,
      close,
      dispose,
      open,
      render,
      setPanel,
      toggle,
    };
  }

  return {
    MIN_SECONDARY_WIDTH,
    MAX_SECONDARY_WIDTH,
    clampWidth,
    createIdeSecondarySidebar,
  };
});
