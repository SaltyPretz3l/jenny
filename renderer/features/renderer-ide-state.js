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
  // A tab in a secondary editor group carries `group` (row 40 W5); absent = primary.
  const GROUP_ID_RE = /^editor-[2-4]$/;
  // Cap on persisted expanded-dir entries. Mirrors the service's
  // WORKSPACE_IDE_MAX_EXPANDED_DIRS (this UMD module cannot import services,
  // same precedent as RAIL_PANELS); the service normalizer also slices to this
  // on read, so this clamps the write side to match.
  const MAX_EXPANDED_DIRS = 200;
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
  // Editor preference bounds/whitelists, duplicated from services/shell-config-state.js
  // (this UMD module cannot import services). Defaults MUST match the service side.
  const FONT_SIZE_MIN = 8;
  const FONT_SIZE_MAX = 40;
  // 0 = "Match text size" (code role, 13px x --font-scale). The pre-rebase
  // default 13 was persisted for everyone, so it also reads as Match.
  const FONT_SIZE_DEFAULT = 0;
  const FONT_SIZE_LEGACY_DEFAULT = 13;
  function normalizeEditorFontSize(value) {
    const size = Math.trunc(Number(value));
    if (!Number.isFinite(size) || size <= 0 || size === FONT_SIZE_LEGACY_DEFAULT) {
      return FONT_SIZE_DEFAULT;
    }
    return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size));
  }
  const TAB_SIZES = [2, 4, 8];
  const TAB_SIZE_DEFAULT = 2;
  const LINE_NUMBERS = ['on', 'off'];
  const RENDER_WHITESPACE = ['none', 'boundary', 'selection', 'trailing', 'all'];
  const EOL_VALUES = ['', 'lf', 'crlf'];
  const EXPLORER_SORT_MODES = ['name', 'type', 'modified'];
  const REPLACE_JOURNAL_MAX_APPLIED = 200;
  const REPLACE_JOURNAL_QUERY_MAX = 500;
  // Row 82 editor/terminal/auto-save prefs: additive persisted keys, table-driven and
  // mirrored by services/workspace-ide-config-schema.js (same specs, same results; the
  // parity test pins it). 'bool' defaults true -> false only on literal false; default
  // false -> true only on literal true. `legacy(src)` is the fallback for an invalid enum.
  const CURSOR_STYLES = ['line', 'block', 'underline'];
  const CURSOR_BLINKING = ['smooth', 'blink', 'phase', 'expand', 'solid'];
  const AUTO_SAVE_MODES = ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'];
  const AUTO_SAVE_DELAY_MIN = 100;
  const AUTO_SAVE_DELAY_MAX = 60000;
  const FONT_FAMILY_MAX_CHARS = 200;
  // Shell profile id ('' = platform default): the ids workspace-pty-profiles.js emits
  // (pwsh, git-bash, ...); main checks it against the detected shells.
  const TERMINAL_PROFILE_ID_RE = /^[a-z0-9-]{1,32}$/;
  // D1: 25,000 lines (about 1.5 MB per 1,000 lines per terminal); a larger stored value clamps on load.
  const TERMINAL_SCROLLBACK_MIN = 500;
  const TERMINAL_SCROLLBACK_DEFAULT = 1000;
  const TERMINAL_SCROLLBACK_MAX = 25000;
  // '' = use the app mono token. Only plain family-list characters survive; anything else
  // (or an over-long value) collapses to '' rather than reaching Monaco's CSS.
  function normalizeFontFamily(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 && text.length <= FONT_FAMILY_MAX_CHARS && /^[A-Za-z0-9 _\-.,'"]+$/.test(text) ? text : '';
  }
  function clampPrefInt(value, min, max, fallback) {
    const numeric = typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
      ? Math.trunc(Number(value))
      : NaN;
    return Number.isFinite(numeric) ? Math.min(max, Math.max(min, numeric)) : fallback;
  }
  const EDITOR_PREF_SPECS = [
    { key: 'fontFamily', kind: 'text', def: '', clean: normalizeFontFamily },
    { key: 'cursorStyle', kind: 'enum', def: 'line', values: CURSOR_STYLES },
    { key: 'cursorBlinking', kind: 'enum', def: 'smooth', values: CURSOR_BLINKING },
    { key: 'cursorSmoothCaretAnimation', kind: 'bool', def: true },
    { key: 'fontLigatures', kind: 'bool', def: true },
    { key: 'bracketPairColorization', kind: 'bool', def: true },
    { key: 'indentGuides', kind: 'bool', def: true },
    { key: 'stickyScroll', kind: 'bool', def: true },
    { key: 'folding', kind: 'bool', def: true },
    { key: 'insertSpaces', kind: 'bool', def: true },
    { key: 'detectIndentation', kind: 'bool', def: true },
    // A valid autoSaveMode wins; else the pre-row-82 boolean migrates (true -> afterDelay).
    {
      key: 'autoSaveMode', kind: 'enum', def: 'off', values: AUTO_SAVE_MODES,
      legacy: (src) => (src.autoSaveEnabled === true ? 'afterDelay' : 'off'),
    },
    { key: 'autoSaveDelayMs', kind: 'int', def: 1000, min: AUTO_SAVE_DELAY_MIN, max: AUTO_SAVE_DELAY_MAX },
    { key: 'scrollBeyondLastLine', kind: 'bool', def: false },
    { key: 'mouseWheelZoom', kind: 'bool', def: true },
    { key: 'inlineBlame', kind: 'bool', def: true },
    { key: 'terminalScrollback', kind: 'int', def: TERMINAL_SCROLLBACK_DEFAULT, min: TERMINAL_SCROLLBACK_MIN, max: TERMINAL_SCROLLBACK_MAX },
    {
      key: 'terminalDefaultProfile', kind: 'text', def: '',
      clean: (value) => (typeof value === 'string' && TERMINAL_PROFILE_ID_RE.test(value) ? value : ''),
    },
  ];
  function normalizeEditorPrefSpec(spec, src) {
    const raw = src[spec.key];
    if (spec.kind === 'bool') {
      return spec.def === true ? raw !== false : raw === true;
    }
    if (spec.kind === 'enum') {
      return spec.values.includes(raw) ? raw : (spec.legacy ? spec.legacy(src) : spec.def);
    }
    if (spec.kind === 'int') {
      return clampPrefInt(raw, spec.min, spec.max, spec.def);
    }
    return spec.clean(raw);
  }
  // Editor column rulers (CONFIG_VERSION 34); mirrors the service bounds. [] = off.
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
  // Diff tabs (runtime-only review surfaces) use ids no file tab can collide
  // with: normalizeIdeRelativePath collapses '//' runs, so never 'diff://'.
  const DIFF_TAB_PREFIX = 'diff://';
  // Markdown/Mermaid preview tabs (W8): same id scheme, source path after the prefix.
  const PREVIEW_TAB_PREFIX = 'preview://';
  // Workspace File Map tab: one synthetic tab whose pane is a stage sibling of the
  // editor. Same id scheme as diff/preview; one instance per IDE.
  const MAP_TAB_PREFIX = 'map://';
  const MAP_TAB_ID = 'map://workspace';
  // Editor-stage surfaces (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md): exactly one is
  // visible in #ideEditorStage at a time ('editor' covers Monaco/diff/image/empty;
  // the rest are keep-alive stage siblings). Mirrors the service's
  // WORKSPACE_IDE_STAGE_SURFACES; the stage-surface CONTROLLER owns flag gating and
  // transitions, these reducers stay pure enum/path validation.
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

  // Sets the Preview stage's source file; anything failing the source gate
  // (absolute, escaping, legacy preview:///map:// ids, non-strings) clears it.
  function setPreviewPath(ide, path) {
    ide.previewPath = normalizePreviewSourcePath(path);
    return ide.previewPath;
  }

  // Mirror of the main-process lexical path gate: workspace-relative POSIX
  // paths only. Returns '' for anything absolute / drive-lettered / escaping.
  function normalizeIdeRelativePath(value) {
    const raw = String(value || '').replace(/\\/g, '/');
    const lead = raw.trimStart();
    if (!lead || raw.includes('\0') || lead.startsWith('/') || /^[A-Za-z]:/.test(lead)) {
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

  // Search history (root-bound, mirrors the service normalizer): trimmed non-empty
  // strings <= 256 chars, de-duplicated keeping the newest, newest last, max 20.
  function normalizeSearchHistory(value) {
    if (!Array.isArray(value)) return [];
    const newestFirst = [];
    for (let index = value.length - 1; index >= 0 && newestFirst.length < 20; index -= 1) {
      const entry = typeof value[index] === 'string' ? value[index].trim() : '';
      if (entry && entry.length <= 256 && !newestFirst.includes(entry)) newestFirst.push(entry);
    }
    return newestFirst.reverse();
  }

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

  function createIdeUiState() {
    return {
      openTabs: [],
      activeTabPath: '',
      // Per secondary group's active path (runtime-only; activeTabPath stays primary).
      groupActive: {},
      dirtyByPath: {},
      // Dirty buffers whose file changed (or vanished) on disk; runtime-only.
      staleByPath: {},
      expandedDirs: new Set(),
      treeRootLoaded: false,
      railPanel: 'explorer',
      // Visible editor-stage sibling + the Preview stage's source file ('' = none).
      activeStageSurface: 'editor',
      previewPath: '',
      replaceJournal: null,
      searchHistory: [],
      // Primary rail defaults left (the service schema); pre-hydrate fallback.
      railSide: 'left',
      railWidth: 300,
      // Bottom panel (Terminal / Problems / Run output) — collapsed by default;
      // opens on Ctrl+`, the Problems statusbar badge, or Debug-this-file.
      bottomPanelOpen: false,
      bottomPanelHeight: BOTTOM_HEIGHT_DEFAULT,
      bottomPanelActiveView: 'terminal',
      // Secondary sidebar (opposite the rail). Source Control is homed here by
      // default (DEFAULT_PANEL_LOCATIONS) but stays COLLAPSED until revealed.
      secondaryPanelOpen: false,
      secondaryPanel: 'source-control',
      secondaryWidth: SECONDARY_WIDTH_DEFAULT,
      // The chat dock defaults right so its wider composer remains beside the editor.
      chatDockOpen: false,
      chatDockSide: 'right',
      chatDockWidth: CHAT_DOCK_WIDTH_DEFAULT,
      // Each rail panel's home side (the split default).
      panelLocations: coercePanelLocations(),
      // Layout tree (row 40 W3): null until hydrate/first use builds it from the
      // legacy fields above, which are then its derived mirror.
      workbenchLayout: null,
      showGenerated: false,
      explorerSortMode: 'name',
      wordWrap: 'off',
      fontSize: FONT_SIZE_DEFAULT,
      tabSize: TAB_SIZE_DEFAULT,
      minimap: true,
      lineNumbers: 'on',
      renderWhitespace: 'selection',
      eol: '',
      // Auto-save (DEFAULT-OFF: it writes the user's files). autoSaveMode is the gate;
      // autoSaveEnabled is only its derived mirror (kept one release for rollback safety).
      autoSaveEnabled: false,
      ...Object.fromEntries(EDITOR_PREF_SPECS.map((spec) => [spec.key, spec.def])),
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
    ide.groupActive = {};
    ide.dirtyByPath = {};
    ide.staleByPath = {};
    ide.expandedDirs = new Set();
    ide.treeRootLoaded = false;
    ide.activeStageSurface = 'editor';
    ide.previewPath = '';
    ide.replaceJournal = null;
    ide.searchHistory = [];
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

  // NOTE: the File Map is a stage SURFACE (activeStageSurface), not a tab; isMapTabId
  // stays as the legacy-id cleanup guard (persistence filters + file-lifecycle open guard).

  // Opens (or re-activates) a diff review tab; reopening refreshes its label (the
  // controller owns the diff content in the editor host, keyed by the same id).
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
    if (existing?.group) (ide.groupActive || (ide.groupActive = {}))[existing.group] = tabId; else ide.activeTabPath = tabId;
    return ide;
  }

  // WIDE-051: pure tab-capacity probe. openFile consults this BEFORE creating an
  // editor document (and after its awaited read), so openTab's silent MAX_OPEN_TABS
  // refusal can never strand a hidden, untabbed model. An already-open path always
  // fits. Typed result:
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
    if (existing?.group) {
      // Opening a file moves it back to the primary group (activeTabPath stays primary).
      if (ide.groupActive?.[existing.group] === normalized) delete ide.groupActive[existing.group];
      delete existing.group;
    }
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
    const closedGroup = ide.openTabs.splice(index, 1)[0].group;
    if (closedGroup && ide.groupActive?.[closedGroup] === path) delete ide.groupActive[closedGroup];
    delete ide.dirtyByPath[path];
    if (ide.staleByPath) {
      delete ide.staleByPath[path];
    }
    if (ide.activeTabPath !== path) {
      return ide.activeTabPath;
    }
    // The next active tab is the right, else left, neighbour among PRIMARY tabs only.
    const primary = (tab) => !tab.group;
    const nextTab = ide.openTabs.slice(index).find(primary)
      || ide.openTabs.slice(0, index).reverse().find(primary) || null;
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

  // Pinned tabs clamp to the left of the strip. This stable partition is the single
  // source of truth for that invariant (the pin gesture and restore both use it).
  function sortTabsPinnedFirst(ide) {
    const tabs = ide.openTabs || [];
    ide.openTabs = [
      ...tabs.filter((tab) => tab.pinned === true),
      ...tabs.filter((tab) => tab.pinned !== true),
    ];
    return ide;
  }

  // Toggles a file tab's pinned flag and re-clamps pinned-first. Diff/preview
  // surfaces never pin. Returns true only when a file tab's flag actually flipped.
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

  // Keep Open: a transient preview tab becomes a regular tab (the double-click and
  // menu gesture). Returns true only when the tab was a preview and now is not.
  function keepTabOpen(ide, path) {
    const tab = getTab(ide, path);
    if (!tab || tab.kind !== 'file' || tab.transientPreview !== true) {
      return false;
    }
    delete tab.transientPreview;
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
    const mods = layoutModules();
    const layout = mods ? getWorkbenchLayout(ide) : null;
    // The legacy fields written are DERIVED from the tree (ide merged with toLegacy)
    // so the dual-written pair never disagrees and a rollback build reads a valid layout.
    const view = layout ? { ...ide, ...mods.legacy.toLegacy(layout) } : ide;
    const persisted = {
      // Only file tabs persist, including the transient explorer preview.
      // `pinned` persists end-to-end: the main-side normalizer
      // (services/workspace-ide-config-schema.js) carries the flag through and
      // CONFIG_VERSION 32 re-normalizes old configs, so pins survive restart.
      // Emit it ONLY when true — the normalizer treats an absent flag as false,
      // so omitting it for unpinned tabs keeps up to MAX_OPEN_TABS redundant
      // `false`s out of the debounced IPC payload. `viewMode` ("Exploded View")
      // rides the same sparse-emit idiom: emit it ONLY when 'exploded' (never
      // the 'code' default), and it coexists independently of `pinned`.
      openTabs: ide.openTabs
        .filter((tab) => tab.kind === 'file')
        .map((tab) => {
          const entry = { path: tab.path };
          if (tab.transientPreview === true) entry.preview = true;
          if (tab.pinned === true) {
            entry.pinned = true;
          }
          if (tab.viewMode === 'exploded') {
            entry.viewMode = 'exploded';
          }
          if (GROUP_ID_RE.test(tab.group)) {
            entry.group = tab.group;
          }
          return entry;
        }),
      activeTabPath: isDiffTabId(ide.activeTabPath) || isPreviewTabId(ide.activeTabPath) || isMapTabId(ide.activeTabPath)
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
      searchHistory: normalizeSearchHistory(ide.searchHistory),
      railPanel: view.railPanel,
      railSide: view.railSide,
      railWidth: view.railWidth,
      bottomPanelOpen: view.bottomPanelOpen === true,
      bottomPanelHeight: clampBottomHeight(view.bottomPanelHeight),
      bottomPanelActiveView: BOTTOM_VIEWS.includes(view.bottomPanelActiveView)
        ? view.bottomPanelActiveView
        : 'terminal',
      secondaryPanelOpen: view.secondaryPanelOpen === true && secondaryPanels(view).length > 0,
      secondaryPanel: secondaryPanels(view).includes(view.secondaryPanel) ? view.secondaryPanel : '',
      secondaryWidth: clampSecondaryWidth(view.secondaryWidth),
      chatDockOpen: view.chatDockOpen === true,
      chatDockSide: coerceChatDockSide(view.chatDockSide),
      chatDockWidth: clampChatDockWidth(view.chatDockWidth),
      panelLocations: coercePanelLocations(view.panelLocations),
      showGenerated: ide.showGenerated === true,
      explorerSortMode: EXPLORER_SORT_MODES.includes(ide.explorerSortMode) ? ide.explorerSortMode : 'name',
      ...normalizeEditorPrefs(ide),
    };
    if (layout) {
      persisted.workbenchLayout = mods.model.cloneLayout(layout);
    }
    return persisted;
  }

  // Editor prefs, validated on write and on restore so a corrupt value never lands.
  function normalizeEditorPrefs(src) {
    const prefs = {
      wordWrap: src.wordWrap === 'on' ? 'on' : 'off',
      fontSize: normalizeEditorFontSize(src.fontSize),
      tabSize: TAB_SIZES.includes(Number(src.tabSize)) ? Number(src.tabSize) : TAB_SIZE_DEFAULT,
      minimap: src.minimap === false ? false : true,
      lineNumbers: LINE_NUMBERS.includes(src.lineNumbers) ? src.lineNumbers : 'on',
      renderWhitespace: RENDER_WHITESPACE.includes(src.renderWhitespace) ? src.renderWhitespace : 'selection',
      eol: EOL_VALUES.includes(src.eol) ? src.eol : '',
      formatOnSave: src.formatOnSave === true,
      trimTrailingWhitespace: src.trimTrailingWhitespace === true,
      insertFinalNewline: src.insertFinalNewline === true,
      rulers: normalizeRulers(src.rulers),
    };
    for (const spec of EDITOR_PREF_SPECS) {
      prefs[spec.key] = normalizeEditorPrefSpec(spec, src);
    }
    // Derived mirror of the resolved mode (rollback safety for one release); never trusted
    // independently, so a stale autoSaveEnabled can't override an explicit 'off'.
    prefs.autoSaveEnabled = prefs.autoSaveMode !== 'off';
    return prefs;
  }

  function applyPersistedState(ide, persisted) {
    const source = persisted && typeof persisted === 'object' ? persisted : {};
    // A stale tree must not overwrite the legacy fields applied below (rebuilt at the end).
    ide.workbenchLayout = null;
    const rawTabs = Array.isArray(source.openTabs) ? source.openTabs : [];
    ide.openTabs = [];
    const seen = new Set();
    for (const entry of rawTabs) {
      const path = normalizeIdeRelativePath(typeof entry === 'string' ? entry : entry?.path);
      if (!path || seen.has(path) || ide.openTabs.length >= MAX_OPEN_TABS) {
        continue;
      }
      seen.add(path);
      ide.openTabs.push({
        path,
        kind: 'file',
        pinned: entry?.pinned === true,
        viewMode: entry?.viewMode === 'exploded' ? 'exploded' : 'code',
        ...(entry?.preview === true ? { transientPreview: true } : {}),
        ...(Number.isInteger(entry?.line) || Number.isInteger(entry?.top) || entry?.page || entry?.zoom ? { restore: { line: entry.line, top: entry.top, ...(entry.page && { page: entry.page }), ...(entry.zoom && { zoom: entry.zoom }) } } : {}),
        ...(GROUP_ID_RE.test(entry?.group) ? { group: entry.group } : {}),
      });
    }
    // Enforce the pinned-first clamp on restore (a hand-edited slice may
    // interleave the groups) - same helper the pin gesture uses.
    sortTabsPinnedFirst(ide);
    const activeTabPath = normalizeIdeRelativePath(source.activeTabPath);
    const primaryPaths = ide.openTabs.filter((tab) => !tab.group).map((tab) => tab.path);
    ide.activeTabPath = primaryPaths.includes(activeTabPath) ? activeTabPath : (primaryPaths[0] || '');
    ide.groupActive = {};
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
    ide.searchHistory = normalizeSearchHistory(source.searchHistory);
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
    normalizeLegacyPanelFields(ide);
    Object.assign(ide, normalizeEditorPrefs(source));
    // A saved tree wins over the legacy keys just applied; with none (or a corrupt
    // one) the legacy keys migrate. The mirror is then re-derived.
    const mods = layoutModules();
    if (mods) {
      ide.workbenchLayout = mods.model.normalizeLayout(source.workbenchLayout) || mods.legacy.fromLegacy(ide);
      syncLegacyFromLayout(ide);
    }
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
    BOTTOM_VIEWS,
    TERMINAL_SCROLLBACK_MIN,
    TERMINAL_SCROLLBACK_DEFAULT,
    TERMINAL_SCROLLBACK_MAX,
    DIFF_TAB_PREFIX,
    MAP_TAB_ID,
    FONT_SIZE_MAX,
    FONT_SIZE_MIN,
    normalizeEditorFontSize,
    CURSOR_STYLES,
    CURSOR_BLINKING,
    AUTO_SAVE_MODES,
    AUTO_SAVE_DELAY_MIN,
    AUTO_SAVE_DELAY_MAX,
    normalizeFontFamily,
    normalizeEditorPrefs,
    MAX_OPEN_TABS,
    RAIL_PANELS,
    RENDER_WHITESPACE,
    REPLACE_JOURNAL_MAX_APPLIED,
    REPLACE_JOURNAL_QUERY_MAX,
    STAGE_SURFACES,
    CHAT_DOCK_WIDTH_DEFAULT,
    CHAT_DOCK_WIDTH_MAX,
    CHAT_DOCK_WIDTH_MIN,
    clampChatDockWidth,
    TAB_SIZES,
    __setLayoutModulesForTest,
    applyPersistedState,
    checkTabCapacity,
    commitWorkbenchLayout,
    clampBottomHeight,
    clampSecondaryWidth,
    closeTab,
    coerceStageSurface,
    createIdeUiState,
    fileExtensionOf,
    fileNameOf,
    getPanelLocation,
    getWorkbenchLayout,
    getTab,
    getTabViewMode,
    isDiffTabId,
    isMapTabId,
    isPreviewTabId,
    keepTabOpen,
    normalizeIdeRelativePath,
    normalizePreviewSourcePath,
    normalizeRulers,
    openDiffTab,
    openTab,
    resetIdeRootState,
    secondaryPanels,
    setActiveTab,
    setPreviewPath,
    setStageSurface,
    setTabDirty,
    setTabStale,
    setTabViewMode,
    sortTabsPinnedFirst,
    syncLegacyFromLayout,
    toPersistedState,
    toggleTabPinned,
    toggleTabViewMode,
  };
});
