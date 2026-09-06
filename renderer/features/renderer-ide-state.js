/* renderer/features/renderer-ide-state.js - pure state shape + reducers for
 * the Workspace IDE page (no DOM, no IPC). Operates on the state.ui.ide slice
 * the bootstrap seeds; every mutator returns the slice for chaining. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeState = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAX_OPEN_TABS = 64;
  // Cap on persisted expanded-dir entries. Mirrors the service's
  // WORKSPACE_IDE_MAX_EXPANDED_DIRS (this UMD module cannot import services,
  // same precedent as RAIL_PANELS); the service normalizer also slices to this
  // on read, so this clamps the write side to match.
  const MAX_EXPANDED_DIRS = 200;
  // Terminal + Problems were re-homed out of the rail into the bottom panel
  // (CONFIG_VERSION 26), so the rail whitelist drops them; BOTTOM_VIEWS is the
  // bottom-panel tab whitelist that replaced them.
  const RAIL_PANELS = ['explorer', 'search', 'changes', 'source-control'];
  // Mirrors services/workspace-ide-config-schema.js WORKSPACE_IDE_BOTTOM_VIEWS
  // (UMD can't import services). 'test-runner' added additively (no CONFIG_VERSION
  // bump — the default 'terminal' stays valid, the accept-set only widened).
  const BOTTOM_VIEWS = ['terminal', 'problems', 'run', 'test-runner'];
  const BOTTOM_HEIGHT_MIN = 80;
  const BOTTOM_HEIGHT_MAX = 600;
  const BOTTOM_HEIGHT_DEFAULT = 220;
  // Secondary sidebar (a second static side container opposite the primary rail).
  // It reuses RAIL_PANELS — no new panel id. Width bounds mirror the service
  // (CONFIG_VERSION 27); same UMD-can't-import-services precedent as RAIL_PANELS.
  const SECONDARY_WIDTH_MIN = 160;
  // Max widened 480 → 600 (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md Phase 5;
  // mirrors the service — the viewport-aware layout clamp makes it safe).
  const SECONDARY_WIDTH_MAX = 600;
  const SECONDARY_WIDTH_DEFAULT = 260;
  // Workspace Chat Dock (ide_chat_dock): its own design bounds — deliberately
  // NOT the secondary-sidebar values; the dock hosts the composer, which needs
  // a wider floor. Mirrors services/workspace-ide-config-schema.js (UMD
  // can't-import-services precedent, same as SECONDARY_WIDTH_*).
  const CHAT_DOCK_WIDTH_MIN = 280;
  const CHAT_DOCK_WIDTH_MAX = 2400;
  const CHAT_DOCK_WIDTH_DEFAULT = 380;
  const CHAT_DOCK_SIDES = ['left', 'right'];
  // Per-panel side location (CONFIG_VERSION 28, the "Move View" model): each rail
  // panel lives on exactly one side - the primary rail or the secondary sidebar.
  // Mirrors the service whitelist (UMD can't import services, same precedent).
  const PANEL_LOCATIONS = ['primary', 'secondary'];
  // The fresh-profile home side for each panel. MUST match
  // services/workspace-ide-config-schema.js DEFAULT_WORKSPACE_IDE.panelLocations:
  // Explorer + Search dock in the primary rail (left), Changes + Source Control
  // in the secondary sidebar (right). Used as the per-id fallback for an ABSENT
  // key in coercePanelLocations (an explicit value is always preserved).
  const DEFAULT_PANEL_LOCATIONS = {
    explorer: 'primary',
    search: 'primary',
    changes: 'secondary',
    'source-control': 'secondary',
  };
  // Editor preference bounds/whitelists. Duplicated from
  // services/shell-config-state.js (this UMD module cannot import services),
  // same precedent as RAIL_PANELS above. Defaults MUST match the service side.
  const FONT_SIZE_MIN = 8;
  const FONT_SIZE_MAX = 40;
  const FONT_SIZE_DEFAULT = 13;
  const TAB_SIZES = [2, 4, 8];
  const TAB_SIZE_DEFAULT = 2;
  const LINE_NUMBERS = ['on', 'off'];
  const RENDER_WHITESPACE = ['none', 'boundary', 'selection', 'trailing', 'all'];
  const EOL_VALUES = ['', 'lf', 'crlf'];
  const EXPLORER_SORT_MODES = ['name', 'type', 'modified'];
  const REPLACE_JOURNAL_MAX_APPLIED = 200;
  const REPLACE_JOURNAL_QUERY_MAX = 500;
  // Inline autocomplete (CONFIG_VERSION 29). Mirrors
  // services/workspace-ide-config-schema.js (UMD can't import services, same
  // precedent as RAIL_PANELS). The model tag is whitelisted so no control chars /
  // shell metacharacters survive into a generate request.
  const MODEL_TAG_MAX = 200;
  function sanitizeInlineSuggestModel(value) {
    const raw = String(value || '').trim();
    if (!raw || raw.length > MODEL_TAG_MAX) {
      return '';
    }
    return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(raw) ? raw : '';
  }
  // Editor column rulers (CONFIG_VERSION 34). Mirrors the service bounds in
  // services/workspace-ide-config-schema.js (this UMD module cannot import
  // services, same precedent as RAIL_PANELS). [] = off (default).
  const RULERS_MAX_COUNT = 8;
  const RULERS_MAX_COLUMN = 500;
  function normalizeRulers(value) {
    const raw = Array.isArray(value) ? value : [];
    const seen = new Set();
    for (const entry of raw) {
      const column = Math.trunc(Number(entry));
      if (Number.isFinite(column) && column > 0 && column <= RULERS_MAX_COLUMN) {
        seen.add(column);
      }
    }
    return [...seen].sort((a, b) => a - b).slice(0, RULERS_MAX_COUNT);
  }
  // Diff tabs (runtime-only review surfaces) share the tab strip with file
  // tabs but use ids no file tab can collide with: normalizeIdeRelativePath
  // collapses '//' runs, so an openTab() result never equals a 'diff://' id.
  const DIFF_TAB_PREFIX = 'diff://';
  // Markdown/Mermaid preview tabs (W8): same non-colliding id scheme, source
  // path encoded after the prefix so reopening the same file dedupes.
  const PREVIEW_TAB_PREFIX = 'preview://';
  // Workspace File Map tab (workspace_file_map): a single synthetic tab whose
  // pane is a stage sibling of the editor (not an editor document). Same
  // non-colliding id scheme as diff/preview; exactly one instance per IDE.
  const MAP_TAB_PREFIX = 'map://';
  const MAP_TAB_ID = 'map://workspace';
  // Editor-stage surfaces (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md): exactly
  // one is visible in #ideEditorStage at a time. 'editor' covers the Monaco/
  // diff/image/empty states; 'preview'/'file_map'/'exploded' are the stable
  // keep-alive stage siblings. Mirrors the service whitelist
  // WORKSPACE_IDE_STAGE_SURFACES (UMD can't import services, the RAIL_PANELS
  // precedent). The stage-surface CONTROLLER owns flag gating and transition
  // policy; these reducers stay pure enum/path validation.
  const STAGE_SURFACES = ['editor', 'preview', 'file_map', 'exploded'];

  function coerceStageSurface(value) {
    return STAGE_SURFACES.includes(value) ? value : 'editor';
  }

  // Sets the active stage surface; invalid input is a no-op. Returns the
  // surface now in effect (mirrors toggleTabViewMode's report-the-result
  // discipline) so callers can branch without re-reading the slice.
  function setStageSurface(ide, surface) {
    if (STAGE_SURFACES.includes(surface)) {
      ide.activeStageSurface = surface;
    }
    return coerceStageSurface(ide.activeStageSurface);
  }

  // Preview-source gate: stricter than normalizeIdeRelativePath because the
  // relative-path gate collapses '//' runs (a legacy 'preview://a.md' id would
  // survive as the junk path 'preview:/a.md') and stringifies non-strings.
  // Only a real string with no scheme-like ':' segment passes.
  function normalizePreviewSourcePath(value) {
    if (typeof value !== 'string') {
      return '';
    }
    const normalized = normalizeIdeRelativePath(value);
    return normalized.includes(':') ? '' : normalized;
  }

  // Sets the Preview stage's source file. Anything that fails the source gate
  // (absolute, escaping, legacy preview:///map:// ids, non-strings) clears the
  // target rather than carrying an unusable value. Returns the applied path.
  function setPreviewPath(ide, path) {
    ide.previewPath = normalizePreviewSourcePath(path);
    return ide.previewPath;
  }

  // Mirror of the main-process lexical path gate: workspace-relative POSIX
  // paths only. Returns '' for anything absolute / drive-lettered / escaping.
  function normalizeIdeRelativePath(value) {
    const raw = String(value || '').trim().replace(/\\/g, '/');
    if (!raw || raw.includes('\0') || raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) {
      return '';
    }
    const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
    if (!segments.length || segments.some((segment) => segment === '..')) {
      return '';
    }
    return segments.join('/');
  }

  function normalizeReplaceJournal(value) {
    if (value === null || value === undefined) return null;
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
      || typeof value.query !== 'string'
      || typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total < 0
      || !Array.isArray(value.applied)
      || (value.truncated !== undefined && typeof value.truncated !== 'boolean')) return null;
    const validPaths = value.applied.map(normalizeIdeRelativePath).filter(Boolean);
    return {
      startedAt: value.startedAt,
      query: value.query.slice(0, REPLACE_JOURNAL_QUERY_MAX),
      total: value.total,
      applied: validPaths.slice(0, REPLACE_JOURNAL_MAX_APPLIED),
      truncated: value.truncated === true || validPaths.length > REPLACE_JOURNAL_MAX_APPLIED,
    };
  }

  // Bottom-panel height clamp (shared by create/persist/apply + the panel module
  // mirrors these bounds, same UMD-can't-import-services precedent as RAIL_PANELS).
  function clampBottomHeight(value) {
    const height = Number(value);
    return Number.isFinite(height)
      ? Math.min(BOTTOM_HEIGHT_MAX, Math.max(BOTTOM_HEIGHT_MIN, Math.trunc(height)))
      : BOTTOM_HEIGHT_DEFAULT;
  }

  // Secondary-sidebar width clamp (shared by create/persist/apply; the sidebar
  // module mirrors these bounds, same precedent as clampBottomHeight).
  function clampSecondaryWidth(value) {
    const width = Number(value);
    return Number.isFinite(width)
      ? Math.min(SECONDARY_WIDTH_MAX, Math.max(SECONDARY_WIDTH_MIN, Math.trunc(width)))
      : SECONDARY_WIDTH_DEFAULT;
  }

  // Chat-dock width clamp (shared by create/persist/apply; the dock module
  // mirrors these bounds, same precedent as clampSecondaryWidth).
  function clampChatDockWidth(value) {
    const width = Number(value);
    return Number.isFinite(width)
      ? Math.min(CHAT_DOCK_WIDTH_MAX, Math.max(CHAT_DOCK_WIDTH_MIN, Math.trunc(width)))
      : CHAT_DOCK_WIDTH_DEFAULT;
  }

  function coerceChatDockSide(value) {
    return CHAT_DOCK_SIDES.includes(value) ? value : 'right';
  }

  // ---- Per-panel location (the "Move View" model) -------------------------
  // A panel lives on exactly one side; these helpers are the single source of
  // truth shared by the rail, the secondary sidebar, the layout, and the
  // controller's per-panel mount/active wiring.

  // Coerce any raw value into a full RAIL_PANELS-keyed map, guaranteeing >=1
  // primary panel so the rail content area is never empty. An EXPLICIT
  // 'primary'/'secondary' is preserved; only an ABSENT (or invalid) key falls
  // back to that panel's DEFAULT_PANEL_LOCATIONS home, so the split default
  // reaches fresh slices without flipping a persisted (fully explicit) one.
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
    return ide.panelLocations && ide.panelLocations[id] === 'secondary' ? 'secondary' : 'primary';
  }

  function primaryPanels(ide) {
    return RAIL_PANELS.filter((id) => getPanelLocation(ide, id) !== 'secondary');
  }

  function secondaryPanels(ide) {
    return RAIL_PANELS.filter((id) => getPanelLocation(ide, id) === 'secondary');
  }

  // Which single panel is the active, visible one for its side - the gate each
  // panel module's isActivePanel() resolves to.
  function isPanelActive(ide, id) {
    if (getPanelLocation(ide, id) === 'secondary') {
      return ide.secondaryPanelOpen === true && ide.secondaryPanel === id;
    }
    return ide.railPanel === id;
  }

  // Re-home a panel to the other side, fixing the active-panel invariants. Keeps
  // >=1 panel in the primary rail (the last primary panel can't be moved out).
  function movePanelLocation(ide, id, target) {
    if (!RAIL_PANELS.includes(id) || !PANEL_LOCATIONS.includes(target)) {
      return ide;
    }
    // Self-heal a missing/partial map to a full one before mutating.
    ide.panelLocations = coercePanelLocations(ide.panelLocations);
    if (getPanelLocation(ide, id) === target) {
      return ide;
    }
    if (target === 'secondary' && primaryPanels(ide).length <= 1) {
      return ide;
    }
    ide.panelLocations[id] = target;
    if (target === 'secondary') {
      ide.secondaryPanel = id;
      ide.secondaryPanelOpen = true;
      if (ide.railPanel === id) {
        ide.railPanel = primaryPanels(ide)[0];
      }
    } else {
      ide.railPanel = id;
      if (ide.secondaryPanel === id) {
        const rest = secondaryPanels(ide);
        ide.secondaryPanel = rest[0] || '';
        if (!rest.length) {
          ide.secondaryPanelOpen = false;
        }
      }
    }
    return ide;
  }

  // Self-heal locations + active-panel fields after hydrate (or any external
  // mutation): full map, >=1 primary, railPanel primary-located, secondaryPanel
  // secondary-located ('' + closed when the secondary side is empty).
  function normalizePanelLocations(ide) {
    ide.panelLocations = coercePanelLocations(ide.panelLocations);
    const primaries = primaryPanels(ide);
    const secondaries = secondaryPanels(ide);
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

  function createIdeUiState() {
    return {
      openTabs: [],
      activeTabPath: '',
      dirtyByPath: {},
      // Dirty buffers whose file changed (or vanished) on disk underneath
      // them; cleared on reload/close. Runtime-only, never persisted.
      staleByPath: {},
      expandedDirs: new Set(),
      treeRootLoaded: false,
      railPanel: 'explorer',
      // Editor-stage surface: which stage sibling is visible in #ideEditorStage
      // ('editor' | 'preview' | 'file_map' | 'exploded') + the Preview stage's
      // source file ('' = none picked yet).
      activeStageSurface: 'editor',
      previewPath: '',
      replaceJournal: null,
      // The primary rail defaults left, matching the service schema; this renderer
      // value is the pre-hydrate/getState-failure fallback.
      railSide: 'left',
      railWidth: 300,
      // Bottom panel (Terminal / Problems / Run output) — collapsed by default;
      // opens on Ctrl+`, the Problems statusbar badge, or Debug-this-file.
      bottomPanelOpen: false,
      bottomPanelHeight: BOTTOM_HEIGHT_DEFAULT,
      bottomPanelActiveView: 'terminal',
      // Secondary sidebar (opposite the primary rail, so on the RIGHT). Changes +
      // Source Control are homed here by default (see DEFAULT_PANEL_LOCATIONS),
      // but it stays COLLAPSED until the user reveals it via the left rail toggle.
      // secondaryPanel names the tab shown when it opens.
      secondaryPanelOpen: false,
      secondaryPanel: 'changes',
      secondaryWidth: SECONDARY_WIDTH_DEFAULT,
      // The chat dock defaults right so its wider composer remains beside the editor.
      chatDockOpen: false,
      chatDockSide: 'right',
      chatDockWidth: CHAT_DOCK_WIDTH_DEFAULT,
      // Each rail panel's home side (the split default): Explorer/Search primary,
      // Changes/Source Control secondary.
      panelLocations: coercePanelLocations(),
      showGenerated: false,
      explorerSortMode: 'name',
      wordWrap: 'off',
      fontSize: FONT_SIZE_DEFAULT,
      tabSize: TAB_SIZE_DEFAULT,
      minimap: true,
      lineNumbers: 'on',
      renderWhitespace: 'selection',
      eol: '',
      // Inline autocomplete: enabled default-on (only literal false disables);
      // the whole feature is gated by the (now default-on) workspace_inline_suggest
      // flag, so this is the in-feature quick toggle. Model = selected Ollama FIM
      // tag ('' = none); compute placement is selected by the live runtime.
      inlineSuggestEnabled: true,
      inlineSuggestModel: '',
      // Debounced auto-save (the in-feature toggle). DEFAULT-OFF: this writes the
      // user's files, so only a literal true enables it. This is the sole gate.
      autoSaveEnabled: false,
      // Save-time hygiene (CONFIG_VERSION 34): all DEFAULT-OFF.
      formatOnSave: false,
      trimTrailingWhitespace: false,
      insertFinalNewline: false,
      // Editor column rulers (CONFIG_VERSION 34): vertical guides at these
      // columns; [] = off (default).
      rulers: [],
      search: { query: '', results: [], busy: false },
      monaco: { ready: false, failed: false },
    };
  }

  function resetIdeRootState(ide) {
    ide.openTabs = [];
    ide.activeTabPath = '';
    ide.dirtyByPath = {};
    ide.staleByPath = {};
    ide.expandedDirs = new Set();
    ide.treeRootLoaded = false;
    ide.activeStageSurface = 'editor';
    ide.previewPath = '';
    ide.replaceJournal = null;
    ide.search = { query: '', results: [], busy: false };
    return ide;
  }

  function findTabIndex(ide, path) {
    return ide.openTabs.findIndex((tab) => tab.path === path);
  }

  function getTab(ide, path) {
    const index = findTabIndex(ide, path);
    return index === -1 ? null : ide.openTabs[index];
  }

  function isDiffTabId(value) {
    return String(value || '').startsWith(DIFF_TAB_PREFIX);
  }

  function isPreviewTabId(value) {
    return String(value || '').startsWith(PREVIEW_TAB_PREFIX);
  }

  function isMapTabId(value) {
    return String(value || '').startsWith(MAP_TAB_PREFIX);
  }

  // NOTE: the File Map is a stage SURFACE (activeStageSurface), not a tab —
  // the old openMapTab reducer is gone. isMapTabId stays as the legacy-id
  // cleanup guard (persistence filters + the file-lifecycle open guard).

  // Opens (or re-activates) a markdown/mermaid preview tab; mirrors
  // openDiffTab - the preview content lives in the editor host by id.
  function openPreviewTab(ide, { id, label = '' } = {}) {
    const tabId = String(id || '');
    if (!isPreviewTabId(tabId)) {
      return ide;
    }
    const existing = getTab(ide, tabId);
    if (existing) {
      existing.label = String(label || existing.label || 'Preview');
    } else {
      if (ide.openTabs.length >= MAX_OPEN_TABS) {
        return ide;
      }
      ide.openTabs.push({ path: tabId, kind: 'preview', label: String(label || 'Preview') });
    }
    ide.activeTabPath = tabId;
    return ide;
  }

  // Opens (or re-activates) a diff review tab. Reopening the same id just
  // refreshes its label - the controller owns the diff content separately
  // in the editor host, keyed by the same id.
  function openDiffTab(ide, { id, label = '' } = {}) {
    const tabId = String(id || '');
    if (!isDiffTabId(tabId)) {
      return ide;
    }
    const existing = getTab(ide, tabId);
    if (existing) {
      existing.label = String(label || existing.label || 'Diff');
    } else {
      if (ide.openTabs.length >= MAX_OPEN_TABS) {
        return ide;
      }
      ide.openTabs.push({ path: tabId, kind: 'diff', label: String(label || 'Diff') });
    }
    ide.activeTabPath = tabId;
    return ide;
  }

  // WIDE-051: pure tab-capacity probe. openFile consults this BEFORE creating
  // an editor document (and again after its awaited read, for a lost race), so
  // openTab's silent MAX_OPEN_TABS refusal below can never strand a hidden,
  // untabbed-but-activated model. An already-open path always fits (openTab
  // re-activates it without pushing). Typed result:
  //   { ok: true } | { ok: false, code: 'TAB_LIMIT', limit: MAX_OPEN_TABS }
  function checkTabCapacity(ide, path) {
    const normalized = normalizeIdeRelativePath(path);
    if (normalized && findTabIndex(ide, normalized) === -1
      && ide.openTabs.length >= MAX_OPEN_TABS) {
      return { ok: false, code: 'TAB_LIMIT', limit: MAX_OPEN_TABS };
    }
    return { ok: true };
  }

  function openTab(ide, path, options = {}) {
    const transientPreview = options?.transientPreview === true;
    const normalized = normalizeIdeRelativePath(path);
    if (!normalized) {
      return ide;
    }
    const existing = getTab(ide, normalized);
    if (!existing) {
      if (ide.openTabs.length >= MAX_OPEN_TABS) {
        return ide;
      }
      ide.openTabs.push({
        path: normalized,
        kind: 'file',
        ...(transientPreview === true ? { transientPreview: true } : {}),
      });
    } else if (transientPreview !== true) {
      delete existing.transientPreview;
    }
    ide.activeTabPath = normalized;
    return ide;
  }

  // Closes a tab and returns the path that should become active next: the
  // right neighbor, else the left, else '' when the strip empties.
  function closeTab(ide, path) {
    const index = findTabIndex(ide, path);
    if (index === -1) {
      return ide.activeTabPath;
    }
    ide.openTabs.splice(index, 1);
    delete ide.dirtyByPath[path];
    if (ide.staleByPath) {
      delete ide.staleByPath[path];
    }
    if (ide.activeTabPath !== path) {
      return ide.activeTabPath;
    }
    const nextTab = ide.openTabs[index] || ide.openTabs[index - 1] || null;
    ide.activeTabPath = nextTab ? nextTab.path : '';
    return ide.activeTabPath;
  }

  function setActiveTab(ide, path) {
    if (findTabIndex(ide, path) === -1) {
      return ide;
    }
    ide.activeTabPath = path;
    return ide;
  }

  function setTabDirty(ide, path, dirty) {
    if (dirty) {
      ide.dirtyByPath[path] = true;
      const tab = getTab(ide, path);
      if (tab) delete tab.transientPreview;
    } else {
      delete ide.dirtyByPath[path];
    }
    return ide;
  }

  // Pinned tabs always clamp to the left of the strip. This stable partition is
  // the single source of truth for that ordering invariant: both the pin
  // gesture (toggleTabPinned) and restore (applyPersistedState) route through
  // it, so the two can never drift.
  function sortTabsPinnedFirst(ide) {
    const tabs = ide.openTabs || [];
    ide.openTabs = [
      ...tabs.filter((tab) => tab.pinned === true),
      ...tabs.filter((tab) => tab.pinned !== true),
    ];
    return ide;
  }

  // Toggles a file tab's pinned flag and re-clamps pinned-first. Diff/preview
  // surfaces are session-scoped and never pin. Returns true only when a file
  // tab's flag actually flipped (mirrors closeTab returning a useful value
  // rather than the slice).
  function toggleTabPinned(ide, path) {
    const tab = getTab(ide, path);
    if (!tab || tab.kind !== 'file') {
      return false;
    }
    tab.pinned = !tab.pinned;
    delete tab.transientPreview;
    sortTabsPinnedFirst(ide);
    return true;
  }

  // "Exploded View" per-file-tab view mode ('code'|'exploded'), FILE tabs
  // only - mirrors toggleTabPinned's kind:'file' gate exactly. The TS/JS
  // language gate for when exploded view is offered lives in the controller,
  // not here; these reducers stay pure and unconditional on file type.
  function getTabViewMode(ide, path) {
    const tab = getTab(ide, path);
    return tab && tab.kind === 'file' && tab.viewMode === 'exploded' ? 'exploded' : 'code';
  }

  // Sets a file tab's view mode explicitly. Returns the applied mode, or null
  // for a non-file tab (diff/preview/map surfaces never carry a view mode).
  function setTabViewMode(ide, path, mode) {
    const tab = getTab(ide, path);
    if (!tab || tab.kind !== 'file') {
      return null;
    }
    tab.viewMode = mode === 'exploded' ? 'exploded' : 'code';
    return tab.viewMode;
  }

  // Flips code<->exploded on a file tab. Returns the new mode, or false for a
  // non-file tab (mirrors toggleTabPinned's boolean-false-on-miss discipline).
  function toggleTabViewMode(ide, path) {
    const tab = getTab(ide, path);
    if (!tab || tab.kind !== 'file') {
      return false;
    }
    tab.viewMode = tab.viewMode === 'exploded' ? 'code' : 'exploded';
    return tab.viewMode;
  }

  function setTabStale(ide, path, stale) {
    if (!ide.staleByPath || typeof ide.staleByPath !== 'object') {
      ide.staleByPath = {};
    }
    if (stale) {
      ide.staleByPath[path] = true;
    } else {
      delete ide.staleByPath[path];
    }
    return ide;
  }

  // Subset persisted to shell config (workspaceIde slice). Runtime-only fields
  // (dirty map, monaco status, search results, view states) never persist.
  function toPersistedState(ide) {
    return {
      // POSITIVE kind filter: only real file tabs persist (diff/preview are
      // session-scoped review surfaces).
      // `pinned` persists end-to-end: the main-side normalizer
      // (services/workspace-ide-config-schema.js) carries the flag through and
      // CONFIG_VERSION 32 re-normalizes old configs, so pins survive restart.
      // Emit it ONLY when true — the normalizer treats an absent flag as false,
      // so omitting it for unpinned tabs keeps up to MAX_OPEN_TABS redundant
      // `false`s out of the debounced IPC payload. `viewMode` ("Exploded View")
      // rides the same sparse-emit idiom: emit it ONLY when 'exploded' (never
      // the 'code' default), and it coexists independently of `pinned`.
      openTabs: ide.openTabs
        .filter((tab) => tab.kind === 'file' && tab.transientPreview !== true)
        .map((tab) => {
          const entry = { path: tab.path };
          if (tab.pinned === true) {
            entry.pinned = true;
          }
          if (tab.viewMode === 'exploded') {
            entry.viewMode = 'exploded';
          }
          return entry;
        }),
      activeTabPath: isDiffTabId(ide.activeTabPath) || isPreviewTabId(ide.activeTabPath) || isMapTabId(ide.activeTabPath)
        || getTab(ide, ide.activeTabPath)?.transientPreview === true
        ? ''
        : normalizeIdeRelativePath(ide.activeTabPath),
      // Clamp to the same bound the service normalizer applies on read so the
      // persisted payload can never balloon past MAX_EXPANDED_DIRS entries.
      expandedDirs: [...ide.expandedDirs].slice(0, MAX_EXPANDED_DIRS),
      // Stage surface + preview target persist additively (no CONFIG_VERSION
      // bump); both re-validate here so a corrupt in-memory value never lands.
      activeStageSurface: coerceStageSurface(ide.activeStageSurface),
      previewPath: normalizePreviewSourcePath(ide.previewPath),
      replaceJournal: normalizeReplaceJournal(ide.replaceJournal),
      railPanel: ide.railPanel,
      railSide: ide.railSide,
      railWidth: ide.railWidth,
      bottomPanelOpen: ide.bottomPanelOpen === true,
      bottomPanelHeight: clampBottomHeight(ide.bottomPanelHeight),
      bottomPanelActiveView: BOTTOM_VIEWS.includes(ide.bottomPanelActiveView)
        ? ide.bottomPanelActiveView
        : 'terminal',
      secondaryPanelOpen: ide.secondaryPanelOpen === true && secondaryPanels(ide).length > 0,
      secondaryPanel: secondaryPanels(ide).includes(ide.secondaryPanel) ? ide.secondaryPanel : '',
      secondaryWidth: clampSecondaryWidth(ide.secondaryWidth),
      chatDockOpen: ide.chatDockOpen === true,
      chatDockSide: coerceChatDockSide(ide.chatDockSide),
      chatDockWidth: clampChatDockWidth(ide.chatDockWidth),
      panelLocations: coercePanelLocations(ide.panelLocations),
      showGenerated: ide.showGenerated === true,
      explorerSortMode: EXPLORER_SORT_MODES.includes(ide.explorerSortMode) ? ide.explorerSortMode : 'name',
      wordWrap: ide.wordWrap === 'on' ? 'on' : 'off',
      // Editor prefs (validated here too so a corrupt in-memory value never persists).
      fontSize: Number.isFinite(Number(ide.fontSize))
        ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.trunc(Number(ide.fontSize))))
        : FONT_SIZE_DEFAULT,
      tabSize: TAB_SIZES.includes(Number(ide.tabSize)) ? Number(ide.tabSize) : TAB_SIZE_DEFAULT,
      minimap: ide.minimap === false ? false : true,
      lineNumbers: LINE_NUMBERS.includes(ide.lineNumbers) ? ide.lineNumbers : 'on',
      renderWhitespace: RENDER_WHITESPACE.includes(ide.renderWhitespace) ? ide.renderWhitespace : 'selection',
      eol: EOL_VALUES.includes(ide.eol) ? ide.eol : '',
      inlineSuggestEnabled: ide.inlineSuggestEnabled === false ? false : true,
      inlineSuggestModel: sanitizeInlineSuggestModel(ide.inlineSuggestModel),
      // Auto-save is DEFAULT-OFF, so only a literal true persists as enabled.
      autoSaveEnabled: ide.autoSaveEnabled === true,
      formatOnSave: ide.formatOnSave === true,
      trimTrailingWhitespace: ide.trimTrailingWhitespace === true,
      insertFinalNewline: ide.insertFinalNewline === true,
      rulers: normalizeRulers(ide.rulers),
    };
  }

  function applyPersistedState(ide, persisted) {
    const source = persisted && typeof persisted === 'object' ? persisted : {};
    const rawTabs = Array.isArray(source.openTabs) ? source.openTabs : [];
    ide.openTabs = [];
    const seen = new Set();
    for (const entry of rawTabs) {
      const path = normalizeIdeRelativePath(typeof entry === 'string' ? entry : entry?.path);
      if (!path || entry?.transientPreview === true || seen.has(path) || ide.openTabs.length >= MAX_OPEN_TABS) {
        continue;
      }
      seen.add(path);
      ide.openTabs.push({
        path,
        kind: 'file',
        pinned: entry?.pinned === true,
        // "Exploded View": absent/anything-but-'exploded' restores to 'code'.
        viewMode: entry?.viewMode === 'exploded' ? 'exploded' : 'code',
      });
    }
    // Enforce the pinned-first clamp on restore (a hand-edited slice may
    // interleave the groups) - same helper the pin gesture uses.
    sortTabsPinnedFirst(ide);
    const activeTabPath = normalizeIdeRelativePath(source.activeTabPath);
    ide.activeTabPath = seen.has(activeTabPath) ? activeTabPath : (ide.openTabs[0]?.path || '');
    ide.expandedDirs = new Set(
      (Array.isArray(source.expandedDirs) ? source.expandedDirs : [])
        .map((dir) => normalizeIdeRelativePath(dir))
        .filter(Boolean)
    );
    ide.railPanel = RAIL_PANELS.includes(source.railPanel) ? source.railPanel : ide.railPanel;
    // Stage surface: unknown/legacy values (e.g. an old 'map://workspace' id)
    // coerce to 'editor'. The stage-surface controller applies flag-off
    // normalization AFTER hydrate — this reducer stays flag-unaware.
    ide.activeStageSurface = coerceStageSurface(source.activeStageSurface);
    ide.previewPath = normalizePreviewSourcePath(source.previewPath);
    ide.replaceJournal = normalizeReplaceJournal(source.replaceJournal);
    ide.railSide = source.railSide === 'right' ? 'right' : 'left';
    const railWidth = Number(source.railWidth);
    if (Number.isFinite(railWidth) && railWidth > 0) {
      ide.railWidth = railWidth;
    }
    ide.bottomPanelOpen = source.bottomPanelOpen === true;
    ide.bottomPanelHeight = clampBottomHeight(source.bottomPanelHeight);
    ide.bottomPanelActiveView = BOTTOM_VIEWS.includes(source.bottomPanelActiveView)
      ? source.bottomPanelActiveView
      : 'terminal';
    ide.panelLocations = coercePanelLocations(source.panelLocations);
    ide.secondaryPanelOpen = source.secondaryPanelOpen === true;
    ide.secondaryPanel = RAIL_PANELS.includes(source.secondaryPanel) ? source.secondaryPanel : '';
    ide.secondaryWidth = clampSecondaryWidth(source.secondaryWidth);
    ide.chatDockOpen = source.chatDockOpen === true;
    ide.chatDockSide = coerceChatDockSide(source.chatDockSide);
    ide.chatDockWidth = clampChatDockWidth(source.chatDockWidth);
    ide.showGenerated = source.showGenerated === true;
    ide.explorerSortMode = EXPLORER_SORT_MODES.includes(source.explorerSortMode)
      ? source.explorerSortMode
      : 'name';
    // Cross-validate the active railPanel/secondaryPanel against the locations
    // (and force the secondary closed when it ends up empty).
    normalizePanelLocations(ide);
    ide.wordWrap = source.wordWrap === 'on' ? 'on' : 'off';
    const fontSize = Number(source.fontSize);
    ide.fontSize = Number.isFinite(fontSize)
      ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.trunc(fontSize)))
      : FONT_SIZE_DEFAULT;
    ide.tabSize = TAB_SIZES.includes(Number(source.tabSize)) ? Number(source.tabSize) : TAB_SIZE_DEFAULT;
    ide.minimap = source.minimap === false ? false : true;
    ide.lineNumbers = LINE_NUMBERS.includes(source.lineNumbers) ? source.lineNumbers : 'on';
    ide.renderWhitespace = RENDER_WHITESPACE.includes(source.renderWhitespace) ? source.renderWhitespace : 'selection';
    ide.eol = EOL_VALUES.includes(source.eol) ? source.eol : '';
    ide.inlineSuggestEnabled = source.inlineSuggestEnabled === false ? false : true;
    ide.inlineSuggestModel = sanitizeInlineSuggestModel(source.inlineSuggestModel);
    ide.autoSaveEnabled = source.autoSaveEnabled === true;
    ide.formatOnSave = source.formatOnSave === true;
    ide.trimTrailingWhitespace = source.trimTrailingWhitespace === true;
    ide.insertFinalNewline = source.insertFinalNewline === true;
    ide.rulers = normalizeRulers(source.rulers);
    return ide;
  }

  function fileNameOf(path) {
    const normalized = String(path || '');
    return normalized.split('/').pop() || normalized;
  }

  function fileExtensionOf(path) {
    const name = fileNameOf(path);
    const dotIndex = name.lastIndexOf('.');
    return dotIndex > 0 ? name.slice(dotIndex + 1).toLowerCase() : '';
  }

  return {
    BOTTOM_HEIGHT_DEFAULT,
    BOTTOM_HEIGHT_MAX,
    BOTTOM_HEIGHT_MIN,
    BOTTOM_VIEWS,
    DIFF_TAB_PREFIX,
    MAP_TAB_ID,
    MAP_TAB_PREFIX,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    MAX_OPEN_TABS,
    PANEL_LOCATIONS,
    PREVIEW_TAB_PREFIX,
    RAIL_PANELS,
    RENDER_WHITESPACE,
    REPLACE_JOURNAL_MAX_APPLIED,
    REPLACE_JOURNAL_QUERY_MAX,
    RULERS_MAX_COLUMN,
    STAGE_SURFACES,
    RULERS_MAX_COUNT,
    SECONDARY_WIDTH_DEFAULT,
    SECONDARY_WIDTH_MAX,
    SECONDARY_WIDTH_MIN,
    CHAT_DOCK_WIDTH_DEFAULT,
    CHAT_DOCK_WIDTH_MAX,
    CHAT_DOCK_WIDTH_MIN,
    clampChatDockWidth,
    TAB_SIZES,
    applyPersistedState,
    checkTabCapacity,
    clampBottomHeight,
    clampSecondaryWidth,
    closeTab,
    coerceStageSurface,
    createIdeUiState,
    fileExtensionOf,
    fileNameOf,
    getPanelLocation,
    getTab,
    getTabViewMode,
    isDiffTabId,
    isMapTabId,
    isPanelActive,
    isPreviewTabId,
    movePanelLocation,
    normalizeIdeRelativePath,
    normalizePanelLocations,
    normalizePreviewSourcePath,
    normalizeRulers,
    openDiffTab,
    openPreviewTab,
    openTab,
    primaryPanels,
    resetIdeRootState,
    sanitizeInlineSuggestModel,
    secondaryPanels,
    setActiveTab,
    setPreviewPath,
    setStageSurface,
    setTabDirty,
    setTabStale,
    setTabViewMode,
    sortTabsPinnedFirst,
    toPersistedState,
    toggleTabPinned,
    toggleTabViewMode,
  };
});
