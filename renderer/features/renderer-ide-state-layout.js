/* renderer/features/renderer-ide-state-layout.js - the workbench-layout half of
 * renderer-ide-state.js (no DOM, no IPC): rail / bottom-panel / secondary-sidebar / chat-dock
 * bounds and clamps, the per-panel location model, and the layout-tree accessors that keep the
 * legacy `ide` fields a derived mirror. Split out of renderer-ide-state.js to keep it under the
 * file-size ceiling; that module re-exports these names. Eager script: loaded before
 * renderer-ide-state.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeStateLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  // Terminal + Problems moved to the bottom panel (CONFIG_VERSION 26); BOTTOM_VIEWS
  // is its tab whitelist. Changes left the rail in row 34 S5 (it lives in the chat
  // dock); a stale 'changes' id coerces like any unknown id.
  const RAIL_PANELS = ['explorer', 'search', 'source-control'];
  // Mirrors the service's WORKSPACE_IDE_BOTTOM_VIEWS ('test-runner' was added
  // additively: no CONFIG_VERSION bump, the accept-set only widened).
  const BOTTOM_VIEWS = ['terminal', 'problems', 'run', 'test-runner'];
  const BOTTOM_HEIGHT_MIN = 80;
  const BOTTOM_HEIGHT_MAX = 600;
  const BOTTOM_HEIGHT_DEFAULT = 220;
  // Secondary sidebar (a second static side container opposite the primary rail);
  // reuses RAIL_PANELS. Width bounds mirror the service (CONFIG_VERSION 27; max
  // widened 480 -> 600 in Phase 5, safe via the viewport-aware layout clamp).
  const SECONDARY_WIDTH_MIN = 160;
  const SECONDARY_WIDTH_MAX = 600;
  const SECONDARY_WIDTH_DEFAULT = 260;
  // Workspace Chat Dock (ide_chat_dock): its own bounds, NOT the secondary-sidebar
  // values (the composer needs a wider floor). Mirrors the service schema.
  const CHAT_DOCK_WIDTH_MIN = 320;
  const CHAT_DOCK_WIDTH_MAX = 2400;
  const CHAT_DOCK_WIDTH_DEFAULT = 380;
  const CHAT_DOCK_SIDES = ['left', 'right'];
  // The fresh-profile home side for each panel; MUST match the service's
  // DEFAULT_WORKSPACE_IDE.panelLocations (Explorer + Search primary, Source Control
  // secondary). The per-id fallback for an ABSENT key in coercePanelLocations.
  const DEFAULT_PANEL_LOCATIONS = {
    explorer: 'primary',
    search: 'primary',
    'source-control': 'secondary',
  };

  // Bottom-panel height clamp (shared by create/persist/apply; the panel module mirrors it).
  function clampBottomHeight(value) {
    const height = Number(value);
    return Number.isFinite(height)
      ? Math.min(BOTTOM_HEIGHT_MAX, Math.max(BOTTOM_HEIGHT_MIN, Math.trunc(height)))
      : BOTTOM_HEIGHT_DEFAULT;
  }

  // Secondary-sidebar width clamp (the sidebar module mirrors these bounds).
  function clampSecondaryWidth(value) {
    const width = Number(value);
    return Number.isFinite(width)
      ? Math.min(SECONDARY_WIDTH_MAX, Math.max(SECONDARY_WIDTH_MIN, Math.trunc(width)))
      : SECONDARY_WIDTH_DEFAULT;
  }

  // Chat-dock width clamp (the dock module mirrors these bounds).
  function clampChatDockWidth(value) {
    const width = Number(value);
    return Number.isFinite(width)
      ? Math.min(CHAT_DOCK_WIDTH_MAX, Math.max(CHAT_DOCK_WIDTH_MIN, Math.trunc(width)))
      : CHAT_DOCK_WIDTH_DEFAULT;
  }

  function coerceChatDockSide(value) {
    return CHAT_DOCK_SIDES.includes(value) ? value : 'right';
  }

  // ---- Workbench layout tree (row 40 W3) ----------------------------------
  // ide.workbenchLayout (a normalized tree, renderer/shared/workbench-layout-*.js)
  // is the source of truth for the arrangement; the legacy fields (railPanel,
  // panelLocations, secondary*, bottomPanel*, chatDock*, railSide, sizes) stay on
  // `ide` as a DERIVED mirror. The shared modules load lazily with the IDE manifest,
  // after this eager script, so they resolve on first use; when absent every helper
  // below keeps the legacy behaviour (the old code sits behind the `!mods` branches).
  let resolvedLayoutModules = null;
  let layoutModulesOverride; // undefined = resolve normally (test seam)

  function layoutModules() {
    if (layoutModulesOverride !== undefined) {
      return layoutModulesOverride;
    }
    if (resolvedLayoutModules) {
      return resolvedLayoutModules;
    }
    const scope = typeof globalThis !== 'undefined' ? globalThis : {};
    let model = scope.jennyWorkbenchLayoutModel;
    let legacy = scope.jennyWorkbenchLayoutLegacy;
    let ops = scope.jennyWorkbenchLayoutOps;
    try {
      if ((!model || !legacy || !ops) && typeof require === 'function') {
        model = model || require('../shared/workbench-layout-model');
        legacy = legacy || require('../shared/workbench-layout-legacy');
        ops = ops || require('../shared/workbench-layout-ops');
      }
    } catch (_error) {
      return null;
    }
    resolvedLayoutModules = model && legacy && ops ? { model, legacy, ops } : null;
    return resolvedLayoutModules;
  }

  // Test seam: undefined = normal resolution, null = force the legacy fallback
  // path, an object = inject {model, legacy, ops}.
  function __setLayoutModulesForTest(value) {
    layoutModulesOverride = value;
    resolvedLayoutModules = null;
  }

  // The tree for this slice (null when the modules are unavailable). A missing or
  // corrupt tree heals: normalized when salvageable, else migrated from the legacy
  // fields.
  function getWorkbenchLayout(ide) {
    const mods = layoutModules();
    if (!mods) {
      return null;
    }
    const current = ide.workbenchLayout;
    const normalized = current ? mods.model.normalizeLayout(current) : null;
    if (!normalized || !mods.ops.isLayoutEqual(normalized, current)) {
      ide.workbenchLayout = normalized || mods.legacy.fromLegacy(ide);
    }
    return ide.workbenchLayout;
  }

  // Copies the legacy keys derived from the tree onto `ide` through the same
  // clamps/coercions the legacy path uses, so the old invariants hold (>=1 primary
  // panel; secondaryPanel '' + closed when the secondary side is empty).
  function syncLegacyFromLayout(ide) {
    const mods = layoutModules();
    const layout = mods ? getWorkbenchLayout(ide) : null;
    if (!layout) {
      return ide;
    }
    const derived = mods.legacy.toLegacy(layout);
    ide.railSide = derived.railSide === 'right' ? 'right' : 'left';
    ide.railWidth = derived.railWidth;
    ide.panelLocations = derived.panelLocations;
    ide.railPanel = derived.railPanel;
    ide.secondaryPanel = derived.secondaryPanel;
    ide.secondaryPanelOpen = derived.secondaryPanelOpen === true;
    normalizeLegacyPanelFields(ide);
    ide.secondaryWidth = clampSecondaryWidth(derived.secondaryWidth);
    ide.bottomPanelOpen = derived.bottomPanelOpen === true;
    ide.bottomPanelHeight = clampBottomHeight(derived.bottomPanelHeight);
    ide.bottomPanelActiveView = BOTTOM_VIEWS.includes(derived.bottomPanelActiveView)
      ? derived.bottomPanelActiveView
      : 'terminal';
    ide.chatDockOpen = derived.chatDockOpen === true;
    ide.chatDockSide = coerceChatDockSide(derived.chatDockSide);
    ide.chatDockWidth = clampChatDockWidth(derived.chatDockWidth);
    return ide;
  }

  // Installs `next` as the tree and refreshes the legacy mirror. False (and no
  // change) for the same reference or an equal tree.
  function commitWorkbenchLayout(ide, next) {
    const mods = layoutModules();
    if (!mods || !next || next === ide.workbenchLayout || mods.ops.isLayoutEqual(next, ide.workbenchLayout)) {
      return false;
    }
    ide.workbenchLayout = next;
    syncLegacyFromLayout(ide);
    return true;
  }

  // ---- Per-panel location (the "Move View" model) -------------------------
  // A panel lives on exactly one side. On the tree, "primary" is the stack holding
  // Explorer and "secondary" is any other stack holding a rail panel.

  // Coerce any raw value into a full RAIL_PANELS-keyed map with >=1 primary panel.
  // An EXPLICIT 'primary'/'secondary' is preserved; only an ABSENT (or invalid) key
  // falls back to that panel's DEFAULT_PANEL_LOCATIONS home.
  function coercePanelLocations(value) {
    const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const map = {};
    for (const id of RAIL_PANELS) {
      map[id] = raw[id] === 'secondary' ? 'secondary'
        : raw[id] === 'primary' ? 'primary'
          : DEFAULT_PANEL_LOCATIONS[id];
    }
    if (RAIL_PANELS.every((id) => map[id] === 'secondary')) {
      map[RAIL_PANELS[0]] = 'primary';
    }
    return map;
  }

  function getPanelLocation(ide, id) {
    const mods = layoutModules();
    if (mods) {
      const derived = mods.legacy.toLegacy(getWorkbenchLayout(ide));
      return derived.panelLocations[id] === 'secondary' ? 'secondary' : 'primary';
    }
    return ide.panelLocations && ide.panelLocations[id] === 'secondary' ? 'secondary' : 'primary';
  }

  function secondaryPanels(ide) {
    return RAIL_PANELS.filter((id) => getPanelLocation(ide, id) === 'secondary');
  }

  // Self-heal the LEGACY fields: full map, >=1 primary, railPanel primary-located,
  // secondaryPanel secondary-located ('' + closed when the secondary side is empty).
  function normalizeLegacyPanelFields(ide) {
    ide.panelLocations = coercePanelLocations(ide.panelLocations);
    const primaries = RAIL_PANELS.filter((id) => ide.panelLocations[id] !== 'secondary');
    const secondaries = RAIL_PANELS.filter((id) => ide.panelLocations[id] === 'secondary');
    if (!primaries.includes(ide.railPanel)) {
      ide.railPanel = primaries[0];
    }
    if (!secondaries.includes(ide.secondaryPanel)) {
      ide.secondaryPanel = secondaries[0] || '';
    }
    if (!secondaries.length) {
      ide.secondaryPanelOpen = false;
    }
    return ide;
  }

  return {
    RAIL_PANELS,
    BOTTOM_VIEWS,
    CHAT_DOCK_WIDTH_MIN,
    CHAT_DOCK_WIDTH_MAX,
    CHAT_DOCK_WIDTH_DEFAULT,
    BOTTOM_HEIGHT_DEFAULT,
    SECONDARY_WIDTH_DEFAULT,
    clampBottomHeight,
    clampSecondaryWidth,
    clampChatDockWidth,
    coerceChatDockSide,
    __setLayoutModulesForTest,
    getWorkbenchLayout,
    syncLegacyFromLayout,
    commitWorkbenchLayout,
    coercePanelLocations,
    getPanelLocation,
    secondaryPanels,
    normalizeLegacyPanelFields,
    layoutModules,
  };
});
