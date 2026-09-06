(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererViewPanelRegistry = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Per-view contextual panel descriptors (nav overhaul). A view with
  // `panel: null` renders full-bleed (`.view-shell.panel-none`). Dock-right and
  // additional workspace widgets are follow-ons; the shape is fixed here so the
  // top rail, shortcuts, and persistence cannot drift apart.
  var PANEL_DESCRIPTORS = {
    home: { panel: null },
    chat: { panel: 'chat-sessions', defaultWidth: 320, collapsible: true, dock: 'left' },
    // Workspace renders full-bleed: the IDE owns its internal explorer rail
    // (left by default), and the shared host's only content today is the
    // chats panel, which doesn't belong on the Workspace view (owner pass,
    // W10). The dockable 'workspace-files' widget host remains the follow-on
    // that re-introduces a panel descriptor here.
    ide: { panel: null },
    memory: { panel: null },
    artifacts: { panel: null },
    plugin: { panel: 'chat-sessions', defaultWidth: 320, collapsible: true, dock: 'left' },
    logs: { panel: null },
    settings: { panel: null },
  };
  var NO_PANEL = { panel: null };
  var AUTO_COLLAPSE_MAX_WIDTH = 480;

  // Stateless fail-open backend (shared singleton) used when no real storage is
  // reachable; mirrors the NO_PANEL sentinel idiom above.
  var NO_OP_STORAGE = { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} };

  // Resolve a storage backend without throwing at construction. A bare
  // `window.localStorage` reference throws when `window` is absent (jsdom/node)
  // or when storage is disabled (SecurityError); fall through to a no-op so the
  // registry stays fail-open in any environment.
  function resolveDefaultStorage() {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        return window.localStorage;
      }
    } catch (_error) { /* storage access denied — use the no-op below */ }
    return NO_OP_STORAGE;
  }

  function createViewPanelRegistry(deps) {
    const { workspace, viewPanel, sidebarResizer } = deps.dom;
    const storage = deps.storage || resolveDefaultStorage();
    const mathUtilsRef = deps.mathUtils || { clamp: (v, lo, hi) => Math.min(Math.max(v, lo), hi) };
    const {
      PANEL_STORAGE_KEY, SIDEBAR_STORAGE_KEY, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH,
      SIDEBAR_COLLAPSED_WIDTH, SIDEBAR_MAIN_STAGE_MIN_WIDTH,
    } = deps.constants;
    const { appendClientLog, updateComposerSafeOffset, onLayoutChanged } = deps.callbacks || {};

    let panelState = null;
    let preservedViewState = Object.create(null);
    const forceExpandedViews = new Set();

    function getWorkspaceWidth() {
      const measured = Number(workspace?.getBoundingClientRect?.().width);
      if (Number.isFinite(measured) && measured > 0) {
        return measured;
      }
      const viewport = Number(
        workspace?.ownerDocument?.defaultView?.innerWidth
        ?? (typeof window !== 'undefined' ? window.innerWidth : 0)
      );
      return Number.isFinite(viewport) && viewport > 0 ? viewport : Infinity;
    }

    function logPanelWarning(eventName, error) {
      if (typeof appendClientLog !== 'function') {
        return;
      }
      try {
        appendClientLog('WARN', eventName, {
          message: String(error && error.message || error || 'Panel preferences unavailable').slice(0, 160),
        });
      } catch (_logError) {
        // Storage fallbacks must stay fail-open even if diagnostics are unavailable.
      }
    }

    if (storage === NO_OP_STORAGE) {
      logPanelWarning('viewpanel.storage_unavailable', new Error('Panel preferences are unavailable.'));
    }

    function getPanelDescriptor(viewId) {
      return PANEL_DESCRIPTORS[viewId] || NO_PANEL;
    }

    function getPanelWidthBounds(viewId) {
      const descriptor = getPanelDescriptor(viewId);
      const workspaceWidth = getWorkspaceWidth();
      const min = Math.ceil(SIDEBAR_MIN_WIDTH);
      const max = Math.max(
        min,
        Math.min(Math.floor(SIDEBAR_MAX_WIDTH), Math.floor(workspaceWidth - SIDEBAR_MAIN_STAGE_MIN_WIDTH))
      );
      const defaultWidth = mathUtilsRef.clamp(
        Math.round(descriptor.defaultWidth || SIDEBAR_MIN_WIDTH),
        min,
        max
      );
      return { min, max, defaultWidth };
    }

    function normalizeViewState(viewId, raw) {
      const descriptor = getPanelDescriptor(viewId);
      const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const fallbackWidth = descriptor.defaultWidth || SIDEBAR_MIN_WIDTH;
      const width = Number.isFinite(source.width) && source.width > 0 && Number.isInteger(source.width)
        ? source.width
        : fallbackWidth;
      return {
        width: mathUtilsRef.clamp(width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
        collapsed: source.collapsed === true,
        dock: source.dock === 'right' ? 'right' : 'left',
      };
    }

    function seedFromLegacyPreferences() {
      preservedViewState = Object.create(null);
      let legacy = {};
      try {
        const raw = storage.getItem(SIDEBAR_STORAGE_KEY);
        legacy = raw ? JSON.parse(raw) : {};
      } catch (error) {
        logPanelWarning('viewpanel.legacy_preferences_read_failed', error);
      }
      const byView = {};
      for (const viewId of Object.keys(PANEL_DESCRIPTORS)) {
        if (!PANEL_DESCRIPTORS[viewId].panel) continue;
        byView[viewId] = normalizeViewState(viewId, {
          width: viewId === 'chat' && Number.isFinite(legacy.width) ? legacy.width : undefined,
          collapsed: legacy.collapsed === true,
        });
      }
      return { version: 2, byView };
    }

    function loadPanelState() {
      if (panelState) {
        return panelState;
      }
      let parsed = null;
      try {
        const raw = storage.getItem(PANEL_STORAGE_KEY);
        parsed = raw ? JSON.parse(raw) : null;
      } catch (error) {
        logPanelWarning('viewpanel.preferences_read_failed', error);
      }
      if (parsed && parsed.version === 2 && parsed.byView && typeof parsed.byView === 'object') {
        preservedViewState = Object.create(null);
        for (const viewId of Object.keys(parsed.byView)) {
          if (!Object.prototype.hasOwnProperty.call(PANEL_DESCRIPTORS, viewId)) {
            preservedViewState[viewId] = parsed.byView[viewId];
          }
        }
        const byView = {};
        for (const viewId of Object.keys(PANEL_DESCRIPTORS)) {
          if (!PANEL_DESCRIPTORS[viewId].panel) continue;
          byView[viewId] = normalizeViewState(viewId, parsed.byView[viewId]);
        }
        panelState = { version: 2, byView };
        return panelState;
      }
      // First run on v2: seed from the legacy single-sidebar preferences. The
      // v1 key is left in place as a one-time read-only migration source.
      panelState = seedFromLegacyPreferences();
      savePanelState();
      return panelState;
    }

    function savePanelState() {
      if (!panelState) {
        return;
      }
      try {
        storage.setItem(PANEL_STORAGE_KEY, JSON.stringify({
          version: panelState.version,
          byView: { ...preservedViewState, ...panelState.byView },
        }));
      } catch (error) {
        logPanelWarning('viewpanel.preferences_write_failed', error);
      }
    }

    function getViewPanelState(viewId) {
      const stateForViews = loadPanelState();
      if (!stateForViews.byView[viewId]) {
        stateForViews.byView[viewId] = normalizeViewState(viewId, null);
      }
      return stateForViews.byView[viewId];
    }

    function setPanelWidth(viewId, width, { apply = true, persist = true } = {}) {
      const descriptor = getPanelDescriptor(viewId);
      if (!descriptor.panel) {
        return;
      }
      const { min, max } = getPanelWidthBounds(viewId);
      const normalizedWidth = Number.isFinite(width) ? Math.round(width) : min;
      getViewPanelState(viewId).width = mathUtilsRef.clamp(normalizedWidth, min, max);
      if (persist) savePanelState();
      if (apply) applyPanelForView(viewId);
    }

    function resetPanelWidth(viewId, { apply = true, persist = true } = {}) {
      const descriptor = getPanelDescriptor(viewId);
      if (!descriptor.panel) return;
      const { defaultWidth } = getPanelWidthBounds(viewId);
      setPanelWidth(viewId, defaultWidth, { apply, persist });
    }

    function setPanelCollapsed(viewId, collapsed, { apply = true, persist = true } = {}) {
      const descriptor = getPanelDescriptor(viewId);
      if (!descriptor.panel || !descriptor.collapsible) {
        return;
      }
      const shouldCollapse = Boolean(collapsed);
      getViewPanelState(viewId).collapsed = shouldCollapse;
      if (shouldCollapse) forceExpandedViews.delete(viewId);
      else if (getWorkspaceWidth() <= AUTO_COLLAPSE_MAX_WIDTH) forceExpandedViews.add(viewId);
      else forceExpandedViews.delete(viewId);
      if (persist) savePanelState();
      if (apply) applyPanelForView(viewId);
    }

    function togglePanelCollapsed(viewId) {
      setPanelCollapsed(viewId, !getViewPanelState(viewId).collapsed);
    }

    function applyPanelForView(viewId) {
      const descriptor = getPanelDescriptor(viewId);
      const hasPanel = Boolean(descriptor.panel);
      const viewState = getViewPanelState(viewId);
      const { min, max, defaultWidth } = getPanelWidthBounds(viewId);
      const expandedWidth = mathUtilsRef.clamp(
        Number.isFinite(viewState.width) ? viewState.width : defaultWidth,
        min,
        max
      );
      viewState.width = expandedWidth;
      const workspaceWidth = getWorkspaceWidth();
      if (workspaceWidth > AUTO_COLLAPSE_MAX_WIDTH) forceExpandedViews.delete(viewId);
      const autoCollapsed = hasPanel
        && descriptor.collapsible
        && workspaceWidth <= AUTO_COLLAPSE_MAX_WIDTH
        && !forceExpandedViews.has(viewId);
      const collapsed = hasPanel && descriptor.collapsible && (viewState.collapsed || autoCollapsed);
      const currentWidth = !hasPanel ? 0 : (collapsed ? SIDEBAR_COLLAPSED_WIDTH : expandedWidth);
      workspace.classList.toggle('panel-none', !hasPanel);
      workspace.classList.toggle('panel-collapsed', collapsed);
      workspace.classList.toggle('panel-dock-right', hasPanel && viewState.dock === 'right');
      if (workspace.dataset) {
        workspace.dataset.panelAutoCollapsed = autoCollapsed ? 'true' : 'false';
      }
      // The legacy .workspace grid still consumes --sidebar-current-width until the
      // W12 cleanup; keep both names in lockstep.
      workspace.style.setProperty('--view-panel-current-width', `${currentWidth}px`);
      workspace.style.setProperty('--sidebar-current-width', `${currentWidth}px`);
      if (viewPanel) {
        viewPanel.hidden = false;
        viewPanel.setAttribute('aria-hidden', hasPanel ? 'false' : 'true');
        viewPanel.toggleAttribute('inert', !hasPanel);
      }
      if (sidebarResizer) {
        const resizerEnabled = hasPanel && !collapsed;
        sidebarResizer.hidden = false;
        sidebarResizer.setAttribute('aria-hidden', resizerEnabled ? 'false' : 'true');
        sidebarResizer.toggleAttribute('inert', !resizerEnabled);
        sidebarResizer.tabIndex = resizerEnabled ? 0 : -1;
        sidebarResizer.setAttribute('aria-valuemin', String(min));
        sidebarResizer.setAttribute('aria-valuemax', String(max));
        sidebarResizer.setAttribute('aria-valuenow', String(Math.round(expandedWidth)));
      }
      if (typeof updateComposerSafeOffset === 'function') {
        updateComposerSafeOffset({ force: true, syncViewport: true });
      }
      if (typeof onLayoutChanged === 'function') {
        onLayoutChanged({
          viewId,
          currentWidth,
          expandedWidth,
          collapsed,
          autoCollapsed,
          hasPanel,
          sidebarVisible: hasPanel,
        });
      }
      return { currentWidth, expandedWidth, collapsed, autoCollapsed, hasPanel };
    }

    return {
      getPanelDescriptor,
      getPanelWidthBounds,
      loadPanelState,
      savePanelState,
      getViewPanelState,
      setPanelWidth,
      resetPanelWidth,
      setPanelCollapsed,
      togglePanelCollapsed,
      applyPanelForView,
    };
  }

  return { createViewPanelRegistry, PANEL_DESCRIPTORS, AUTO_COLLAPSE_MAX_WIDTH };
});
