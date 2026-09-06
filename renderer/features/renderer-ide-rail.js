/* renderer/features/renderer-ide-rail.js - Workspace IDE secondary rail
 * chrome: the mini activity bar that lists the panels currently homed in the
 * primary rail (the "Move View" model) and switches ide.railPanel, a right-click
 * "Move to Secondary Sidebar" action on each panel button that re-homes it, the
 * pointer/keyboard width-drag on #ideRailResizer, and the side-flip control
 * that toggles [data-rail-side]. Panel CONTENT is owned by the tree/search/
 * changes modules; this file only renders the bar and mutates rail state, then
 * asks the controller to re-render. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeRail = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  // The rail hosts four side panels; Terminal and Problems live in the bottom panel.
  const RAIL_PANELS = [
    { id: 'explorer', label: 'Explorer', title: 'Explorer — browse workspace files' },
    { id: 'search', label: 'Search', title: 'Search — find text across the workspace' },
    { id: 'changes', label: "Jenny's Changes", title: "Jenny's Changes — review edits Jenny made" },
    { id: 'source-control', label: 'Source Control', title: 'Source Control — stage, commit, and switch branches' },
  ];
  // Stage-surface entries (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md): the
  // activity strip renders TWO entry kinds — rail-panel entries (click → set
  // ide.railPanel, content renders in #ideRailPanel) and these stage-surface
  // entries (click → activate an editor-stage surface via the stage-surface
  // controller; content lives in the keep-alive #ideEditorStage hosts).
  // Deliberately a SEPARATE flag-gated list: stage surfaces must never be
  // added to RAIL_PANELS — the rail-panel host is destructively rebuilt via
  // innerHTML on activation, which would destroy map/preview keep-alive state.
  const STAGE_SURFACE_ENTRIES = [
    { id: 'preview', surface: 'preview', label: 'Preview' },
    { id: 'file-map', surface: 'file_map', label: 'File Map' },
  ];
  const MIN_RAIL_WIDTH = 200;
  const MAX_RAIL_WIDTH = 600;
  const KEYBOARD_RESIZE_STEP = 16;

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

  function clampRailWidth(value) {
    const width = Number(value);
    if (!Number.isFinite(width)) {
      return MIN_RAIL_WIDTH;
    }
    return Math.min(MAX_RAIL_WIDTH, Math.max(MIN_RAIL_WIDTH, Math.round(width)));
  }

  // A panel lives on exactly one side (the "Move View" model); the activity bar
  // only lists the panels currently homed in the primary rail.
  function railPanelLocation(ide, id) {
    return ide && ide.panelLocations && ide.panelLocations[id] === 'secondary' ? 'secondary' : 'primary';
  }

  function createIdeRail(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const requestRender = typeof deps?.requestRender === 'function' ? deps.requestRender : noop;
    const schedulePersist = typeof deps?.schedulePersist === 'function' ? deps.schedulePersist : noop;
    // Optional: toggles the secondary sidebar (a second static side container).
    // When absent, the activity bar renders no secondary control (back-compat).
    const onToggleSecondary = typeof deps?.onToggleSecondary === 'function' ? deps.onToggleSecondary : null;
    // Optional: re-homes a panel to the other side (the right-click "Move to
    // Secondary Sidebar" menu item). When absent, no move action is offered.
    const onMovePanel = typeof deps?.onMovePanel === 'function' ? deps.onMovePanel : null;
    // Optional: toggles the Workspace Chat Dock (ide_chat_dock). The enabled
    // getter is read PER RENDER (never latched at construct) so the control
    // appears once the flag seed hydrates — the artifact-panel RC2 race.
    const onToggleChatDock = typeof deps?.onToggleChatDock === 'function' ? deps.onToggleChatDock : null;
    const isChatDockEnabled = typeof deps?.isChatDockEnabled === 'function' ? deps.isChatDockEnabled : () => false;
    // Stage-surface entries: activation callback + per-surface flag getters +
    // the active-surface getter. Each is read PER RENDER (never latched at
    // construct) so late flag hydration reveals the buttons without a re-bind
    // (the chat-dock precedent); flag-off keeps the bar byte-identical — no
    // stage-group markup at all when neither entry is enabled.
    const onActivateStageSurface = typeof deps?.onActivateStageSurface === 'function'
      ? deps.onActivateStageSurface
      : null;
    const isStageSurfaceEnabled = typeof deps?.isStageSurfaceEnabled === 'function'
      ? deps.isStageSurfaceEnabled
      : () => false;
    const getActiveStageSurface = typeof deps?.getActiveStageSurface === 'function'
      ? deps.getActiveStageSurface
      : () => 'editor';
    // Viewport-aware drag ceiling (renderer-ide-layout.js budget): the static
    // MAX_RAIL_WIDTH (600) still applies; this dynamic max keeps a wide rail
    // from starving the editor column on a small monitor. Default = no bound.
    const getMaxRailWidth = typeof deps?.getMaxRailWidth === 'function'
      ? deps.getMaxRailWidth
      : () => Infinity;

    function clampRailWidthForViewport(value) {
      const dynamicMax = Number(getMaxRailWidth());
      const bounded = clampRailWidth(value);
      return Number.isFinite(dynamicMax)
        ? Math.max(MIN_RAIL_WIDTH, Math.min(bounded, Math.trunc(dynamicMax)))
        : bounded;
    }
    const actionButton = resolveActionButton();
    const contextMenu = resolveContextMenu();
    const windowRef = globalRef.window || globalRef;
    // Split-panel glyph for the secondary-sidebar toggle (inline, CSP-safe).
    const SECONDARY_GLYPH = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3.5" width="12" height="9" rx="1"></rect><line x1="10.5" y1="3.5" x2="10.5" y2="12.5"></line></svg>';
    // Chat-bubble glyph for the chat-dock toggle (inline, CSP-safe).
    const CHAT_DOCK_GLYPH = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8.5L5.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"></path></svg>';

    let boundBar = null;
    let boundResizer = null;
    let dragState = null; // { startX, startWidth, side }

    function buildActivityMarkup() {
      if (!actionButton) {
        return '';
      }
      const ide = getIde();
      const primaries = RAIL_PANELS.filter((panel) => railPanelLocation(ide, panel.id) !== 'secondary');
      const secondaries = RAIL_PANELS.filter((panel) => railPanelLocation(ide, panel.id) === 'secondary');
      // The active panel owns the single roving tabindex=0; if (defensively) no
      // primary matches railPanel, the first tab stays Tab-reachable.
      const activeIndex = primaries.findIndex((panel) => ide.railPanel === panel.id);
      const focusIndex = activeIndex >= 0 ? activeIndex : 0;
      // Each panel button is a plain activity-bar item; moving it to the
      // secondary sidebar is a right-click action (handleActivityContextMenu).
      const tabs = primaries.map((panel, index) => {
        const active = ide.railPanel === panel.id;
        // Panel switcher = a tablist (the inner role="tablist" wrapper below);
        // each button selects which panel renders, so it is a tab, not a toggle.
        // Roving tabindex: only the active tab is in the Tab order; arrows move
        // between the rest (handleActivityKeydown).
        return actionButton({
          plain: true,
          className: `ide-activity-button${active ? ' ide-activity-button--active' : ''}`,
          role: 'tab',
          ariaSelected: active,
          tabIndex: index === focusIndex ? 0 : -1,
          label: panel.label,
          title: panel.title,
          dataset: { 'ide-rail-panel': panel.id },
        });
      });
      // Only role=tab children may live in a tablist, so the tabs sit in an inner
      // role="tablist" wrapper (display:contents keeps the bar's flex layout) while
      // the secondary-toggle + side-flip stay as siblings in the role="toolbar" bar.
      // The tablist is then wrapped in a presentational scroll box (.ide-activitybar-
      // scroll) so the four panel labels scroll horizontally inside the narrow rail
      // instead of overflowing it onto neighbouring surfaces; the trailing controls
      // stay pinned as bar siblings outside the scroll box.
      // Stage-surface entries render as a distinct group AFTER the panel
      // tablist (they are plain toggle buttons, not tabs — no roving
      // tabindex; Tab reaches them, Enter/Space activates). aria-pressed
      // mirrors the secondary/chat-dock toggles. Only enabled entries render.
      const activeSurface = getActiveStageSurface();
      const stageButtons = onActivateStageSurface
        ? STAGE_SURFACE_ENTRIES
          .filter((entry) => isStageSurfaceEnabled(entry.surface) === true)
          .map((entry) => {
            const active = activeSurface === entry.surface;
            return actionButton({
              plain: true,
              className: `ide-activity-button ide-stage-button${active ? ' ide-activity-button--active' : ''}`,
              ariaPressed: active,
              label: entry.label,
              title: active ? `${entry.label} — click to return to the editor` : `Show ${entry.label}`,
              dataset: { 'ide-stage-surface': entry.surface },
            });
          })
        : [];
      const stageGroup = stageButtons.length
        ? `<div class="ide-stage-group" role="group" aria-label="Workspace views">${stageButtons.join('')}</div>`
        : '';
      const tabStrip = `<div class="ide-activitybar-scroll"><div class="ide-tablist-group" role="tablist" aria-label="Workspace panels">${tabs.join('')}</div>${stageGroup}</div>`;
      const extras = [];
      // The visibility toggle only makes sense once the secondary side hosts a
      // panel (moving one there forces it open); hide it while the side is empty.
      if (onToggleSecondary && secondaries.length > 0) {
        const open = ide.secondaryPanelOpen === true;
        extras.push(actionButton({
          plain: true,
          className: `ide-rail-secondary-toggle${open ? ' ide-rail-secondary-toggle--active' : ''}`,
          ariaPressed: open,
          ariaLabel: open ? 'Hide secondary sidebar' : 'Show secondary sidebar',
          title: open ? 'Hide secondary sidebar' : 'Show secondary sidebar',
          dataset: { 'ide-rail-secondary': '1' },
          trustedHtml: SECONDARY_GLYPH,
        }));
      }
      // Chat-dock toggle (ide_chat_dock): rendered only while the flag is known
      // true, so flag-off keeps the activity bar byte-identical.
      if (onToggleChatDock && isChatDockEnabled() === true) {
        const dockOpen = ide.chatDockOpen === true;
        extras.push(actionButton({
          plain: true,
          className: `ide-rail-chatdock-toggle${dockOpen ? ' ide-rail-chatdock-toggle--active' : ''}`,
          ariaPressed: dockOpen,
          ariaLabel: dockOpen ? 'Collapse chat dock' : 'Show chat dock',
          title: dockOpen ? 'Collapse chat dock' : 'Show chat dock',
          dataset: { 'ide-rail-chatdock': '1' },
          trustedHtml: CHAT_DOCK_GLYPH,
        }));
      }
      const flipLabel = ide.railSide === 'right'
        ? 'Move panel to the left side'
        : 'Move panel to the right side';
      extras.push(actionButton({
        plain: true,
        className: 'ide-rail-flip',
        ariaLabel: flipLabel,
        title: flipLabel,
        dataset: { 'ide-rail-flip': '1' },
        trustedHtml: '<span aria-hidden="true">&#8644;</span>',
      }));
      return tabStrip + extras.join('');
    }

    function renderActivityBar() {
      const bar = getDom().ideActivityBar || null;
      if (!bar) {
        return;
      }
      const markup = buildActivityMarkup();
      if (bar.__jennyIdeActivityMarkup !== markup) {
        bar.innerHTML = markup;
        bar.__jennyIdeActivityMarkup = markup;
      }
    }

    function applyRailWidth() {
      const shell = getDom().ideShell || null;
      shell?.style?.setProperty('--ide-rail-width', `${getIde().railWidth}px`);
    }

    function handleActivityClick(event) {
      // Stage-surface entries switch the editor-stage surface; they never
      // touch ide.railPanel (the two-entry-kind dispatch rule).
      const stageButton = event.target?.closest?.('[data-ide-stage-surface]');
      if (stageButton) {
        const surface = stageButton.dataset.ideStageSurface;
        if (onActivateStageSurface && STAGE_SURFACE_ENTRIES.some((entry) => entry.surface === surface)) {
          onActivateStageSurface(surface);
        }
        return;
      }
      const secondary = event.target?.closest?.('[data-ide-rail-secondary]');
      if (secondary) {
        onToggleSecondary?.();
        return;
      }
      const chatDockToggle = event.target?.closest?.('[data-ide-rail-chatdock]');
      if (chatDockToggle) {
        onToggleChatDock?.();
        return;
      }
      const flip = event.target?.closest?.('[data-ide-rail-flip]');
      if (flip) {
        const ide = getIde();
        ide.railSide = ide.railSide === 'right' ? 'left' : 'right';
        schedulePersist();
        requestRender();
        return;
      }
      const panelButton = event.target?.closest?.('[data-ide-rail-panel]');
      if (!panelButton) {
        return;
      }
      const panelId = panelButton.dataset.ideRailPanel;
      const ide = getIde();
      if (!RAIL_PANELS.some((panel) => panel.id === panelId) || ide.railPanel === panelId) {
        return;
      }
      ide.railPanel = panelId;
      schedulePersist();
      requestRender();
    }

    // Right-click a panel button to move it to the secondary sidebar (the
    // "Move View" affordance). The action is disabled on the last remaining
    // primary panel - the rail must always keep >=1.
    function handleActivityContextMenu(event) {
      if (!onMovePanel || typeof contextMenu?.show !== 'function') {
        return;
      }
      const panelButton = event.target?.closest?.('[data-ide-rail-panel]');
      const id = panelButton?.dataset?.ideRailPanel;
      if (!id || !RAIL_PANELS.some((panel) => panel.id === id)) {
        return;
      }
      event.preventDefault?.();
      const ide = getIde();
      const primaryCount = RAIL_PANELS.filter((panel) => railPanelLocation(ide, panel.id) !== 'secondary').length;
      contextMenu.show({
        rootEl: getDom().ideActivityBar || null,
        anchorX: event.clientX,
        anchorY: event.clientY,
        items: [{
          label: 'Move to Secondary Sidebar',
          disabled: primaryCount <= 1,
          action: () => onMovePanel(id, 'secondary'),
        }],
      });
    }

    // Roving arrow-key focus across the panel tabs (vertical activity bar, so
    // ArrowUp/Down + Home/End), with automatic activation: moving focus switches
    // the panel. renderIde rebuilds the bar synchronously, so we re-query the new
    // active tab and restore focus to it after the re-render. The flip/toggle
    // toolbar buttons are NOT tabs, so arrows pressed on them are ignored.
    function handleActivityKeydown(event) {
      const fromTab = event.target?.closest?.('[data-ide-rail-panel]');
      if (!fromTab) {
        return;
      }
      const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      if (step === 0 && event.key !== 'Home' && event.key !== 'End') {
        return;
      }
      const bar = getDom().ideActivityBar || null;
      const tabs = bar ? [...bar.querySelectorAll('[data-ide-rail-panel]')] : [];
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
      const panelId = tabs[next].dataset.ideRailPanel;
      const ide = getIde();
      if (panelId && ide.railPanel !== panelId && RAIL_PANELS.some((panel) => panel.id === panelId)) {
        ide.railPanel = panelId;
        schedulePersist();
        requestRender();
      }
      // After the synchronous re-render the old node is gone; focus the fresh one.
      const refreshed = getDom().ideActivityBar?.querySelector?.(`[data-ide-rail-panel="${panelId}"]`);
      (refreshed || tabs[next]).focus?.();
    }

    function handlePointerMove(event) {
      if (!dragState) {
        return;
      }
      const delta = event.clientX - dragState.startX;
      const ide = getIde();
      // Right-pinned rail grows when the pointer moves left, and vice versa.
      ide.railWidth = clampRailWidthForViewport(
        dragState.side === 'left' ? dragState.startWidth + delta : dragState.startWidth - delta
      );
      applyRailWidth();
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
      const ide = getIde();
      dragState = {
        startX: event.clientX,
        startWidth: clampRailWidth(ide.railWidth),
        side: ide.railSide === 'right' ? 'right' : 'left',
      };
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
      const ide = getIde();
      const grows = ide.railSide === 'left' ? 'ArrowRight' : 'ArrowLeft';
      const step = event.key === grows ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP;
      ide.railWidth = clampRailWidthForViewport((Number(ide.railWidth) || MIN_RAIL_WIDTH) + step);
      applyRailWidth();
      schedulePersist();
      event.preventDefault();
    }

    function bindEvents() {
      const dom = getDom();
      if (dom.ideActivityBar && !boundBar) {
        boundBar = dom.ideActivityBar;
        boundBar.addEventListener('click', handleActivityClick);
        boundBar.addEventListener('contextmenu', handleActivityContextMenu);
        boundBar.addEventListener('keydown', handleActivityKeydown);
      }
      if (dom.ideRailResizer && !boundResizer) {
        boundResizer = dom.ideRailResizer;
        boundResizer.addEventListener('pointerdown', handleResizerPointerDown);
        boundResizer.addEventListener('keydown', handleResizerKeydown);
      }
    }

    function dispose() {
      endDrag();
      if (boundBar) {
        boundBar.removeEventListener('click', handleActivityClick);
        boundBar.removeEventListener('contextmenu', handleActivityContextMenu);
        boundBar.removeEventListener('keydown', handleActivityKeydown);
        boundBar = null;
      }
      if (boundResizer) {
        boundResizer.removeEventListener('pointerdown', handleResizerPointerDown);
        boundResizer.removeEventListener('keydown', handleResizerKeydown);
        boundResizer = null;
      }
    }

    return {
      bindEvents,
      dispose,
      renderActivityBar,
    };
  }

  return {
    MIN_RAIL_WIDTH,
    MAX_RAIL_WIDTH,
    RAIL_PANELS,
    STAGE_SURFACE_ENTRIES,
    clampRailWidth,
    createIdeRail,
  };
});
