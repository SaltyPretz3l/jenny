/* renderer/features/renderer-ide-layout.js - Workspace IDE layout orchestration,
 * extracted from the controller's renderIde() to keep it under the file-size cap
 * and to give the multi-container workbench (rail + secondary sidebar + bottom
 * panel) one home.
 *
 * render() applies the rail side/width, repaints the activity bar, then renders
 * all four panels (explorer / search / changes / source-control - Terminal +
 * Problems moved to the bottom panel). Each panel is a SINGLE instance that
 * self-targets its host from its location (the "Move View" model) and self-gates
 * on isActivePanel, so at most one paints the rail host and at most one the
 * secondary host. It then renders the secondary-sidebar chrome + the bottom
 * panel. It owns no state and no events; the controller injects every panel's
 * render fn + the bottom-panel + secondary-sidebar instances, and still owns
 * renderTabs() (which touches the tree / tab strip / statusbar). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function noop() {}

  // ── Viewport-aware width budget (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md
  // Phase 5) ── The persisted rail/secondary maxima widened to 600, so a small
  // monitor (or a shrunk window) needs a live clamp: rail + secondary + chat
  // dock must always leave a usable editor column. The editor floor scales
  // with the root font size (font/surface scaling users still get a readable
  // editor). Returns Infinity maxima when the viewport is unknown (jsdom,
  // pre-layout) so the static clamps stay the only bound.
  const VIEWPORT_MIN_EDITOR_WIDTH = 360;
  const RAIL_WIDTH_FLOOR = 200;
  const SECONDARY_WIDTH_FLOOR = 160;
  const CHAT_DOCK_WIDTH_FLOOR = 280;
  const CHAT_DOCK_VIEWPORT_RATIO = 0.65;

  function computeViewportWidthLimits(ide, viewportWidth, { fontScale = 1 } = {}) {
    const vw = Number(viewportWidth);
    if (!Number.isFinite(vw) || vw <= 0) {
      return { railMax: Infinity, secondaryMax: Infinity, chatDockMax: Infinity };
    }
    const scale = Number.isFinite(Number(fontScale)) && Number(fontScale) > 0 ? Number(fontScale) : 1;
    const editorMin = Math.round(VIEWPORT_MIN_EDITOR_WIDTH * scale);
    const railRequested = Math.max(RAIL_WIDTH_FLOOR, Number(ide?.railWidth) || RAIL_WIDTH_FLOOR);
    const secondaryOpen = ide?.secondaryPanelOpen === true;
    const secondaryRequested = secondaryOpen
      ? Math.max(SECONDARY_WIDTH_FLOOR, Number(ide?.secondaryWidth) || SECONDARY_WIDTH_FLOOR)
      : 0;
    const chatDockMax = Math.max(
      CHAT_DOCK_WIDTH_FLOOR,
      Math.min(
        Math.floor(vw * CHAT_DOCK_VIEWPORT_RATIO),
        Math.max(0, vw - editorMin - railRequested - secondaryRequested)
      )
    );
    // Clamp only the display budget. The persisted request stays untouched so
    // returning to a wider monitor restores the user's chosen width.
    const dockWidth = ide?.chatDockOpen === true
      ? Math.min(Number(ide.chatDockWidth) || 0, chatDockMax)
      : 0;
    const budget = Math.max(0, vw - editorMin - dockWidth);
    const secondaryCurrent = secondaryOpen ? (Number(ide.secondaryWidth) || SECONDARY_WIDTH_FLOOR) : 0;
    // Deterministic order: the rail is clamped against the secondary's CURRENT
    // width, then the secondary against the (already clamped) rail. Floors are
    // never violated — when the budget is smaller than the floors, the editor
    // column takes the squeeze (its grid track is minmax(0, 1fr)).
    const railMax = Math.max(RAIL_WIDTH_FLOOR, budget - secondaryCurrent);
    const railCurrent = Math.min(Number(ide?.railWidth) || RAIL_WIDTH_FLOOR, railMax);
    const secondaryMax = Math.max(SECONDARY_WIDTH_FLOOR, budget - railCurrent);
    return { railMax, secondaryMax, chatDockMax };
  }

  // Root font-size ratio (16px browser default) — the cheap font/surface-scale
  // signal for the editor floor. Guarded for jsdom/absent computed styles.
  function resolveFontScale(shellEl) {
    try {
      const doc = shellEl?.ownerDocument;
      const view = doc?.defaultView;
      const size = parseFloat(view?.getComputedStyle?.(doc.documentElement)?.fontSize);
      return Number.isFinite(size) && size > 0 ? size / 16 : 1;
    } catch (_error) {
      return 1;
    }
  }

  function createIdeLayout(deps) {
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const getIde = typeof deps?.getIde === 'function' ? deps.getIde : () => ({});
    const renderActivityBar = typeof deps?.renderActivityBar === 'function' ? deps.renderActivityBar : noop;
    const renderExplorer = typeof deps?.renderExplorer === 'function' ? deps.renderExplorer : noop;
    const renderSearch = typeof deps?.renderSearch === 'function' ? deps.renderSearch : noop;
    const renderChanges = typeof deps?.renderChanges === 'function' ? deps.renderChanges : noop;
    const renderSourceControl = typeof deps?.renderSourceControl === 'function' ? deps.renderSourceControl : noop;
    const bottomPanel = deps?.bottomPanel || null;
    const secondarySidebar = deps?.secondarySidebar || null;
    const chatDock = deps?.chatDock || null;

    // Current viewport limits for the shell (Infinity when unmeasurable). The
    // controller threads maxRailWidth()/maxSecondaryWidth() into the rail +
    // secondary-sidebar drag/keyboard clamps so a widened persisted width can
    // never be dragged past what the viewport affords.
    function currentLimits(dom, ide) {
      const shell = dom?.ideShell || null;
      const view = shell?.ownerDocument?.defaultView || null;
      return computeViewportWidthLimits(ide, view?.innerWidth, {
        fontScale: resolveFontScale(shell),
      });
    }

    function maxRailWidth() {
      return currentLimits(getDom(), getIde()).railMax;
    }

    function maxSecondaryWidth() {
      return currentLimits(getDom(), getIde()).secondaryMax;
    }

    function maxChatDockWidth() {
      return currentLimits(getDom(), getIde()).chatDockMax;
    }

    function applyRailGeometry(dom, ide) {
      if (!dom.ideShell) {
        return;
      }
      const railSide = ide.railSide === 'right' ? 'right' : 'left';
      if (dom.ideShell.dataset.railSide !== railSide) {
        dom.ideShell.dataset.railSide = railSide;
      }
      // Display-level viewport clamp (runs on hydration, persisted-config
      // load, and every resize-driven render): the persisted preference is
      // NOT mutated, so returning to a wider monitor restores it.
      const limits = currentLimits(dom, ide);
      const railPx = Math.min(Number(ide.railWidth) || 300, limits.railMax);
      const railWidth = `${railPx}px`;
      if (dom.ideShell.style.getPropertyValue('--ide-rail-width') !== railWidth) {
        dom.ideShell.style.setProperty('--ide-rail-width', railWidth);
      }
    }

    function render() {
      const dom = getDom();
      const ide = getIde();
      applyRailGeometry(dom, ide);
      renderActivityBar();
      // Each panel is a SINGLE instance that self-targets its host (getMountEl
      // from its location) and self-gates (isActivePanel), so render all four:
      // at most one paints the rail host and at most one the secondary host.
      renderExplorer();
      renderSearch();
      renderChanges();
      renderSourceControl();
      // The sidebar module owns the secondary chrome (which panels live here +
      // the visibility/width/resize/header); it self-guards when closed/empty.
      secondarySidebar?.render();
      bottomPanel?.render();
      // Chat-dock chrome + host reconcile (self-guards flag-off/closed).
      chatDock?.render();
    }

    return { render, maxRailWidth, maxSecondaryWidth, maxChatDockWidth };
  }

  return {
    RAIL_WIDTH_FLOOR,
    SECONDARY_WIDTH_FLOOR,
    CHAT_DOCK_WIDTH_FLOOR,
    CHAT_DOCK_VIEWPORT_RATIO,
    VIEWPORT_MIN_EDITOR_WIDTH,
    computeViewportWidthLimits,
    createIdeLayout,
  };
});
