/* Normalize + defaults for the Workspace IDE persisted UI slice
 * (the `workspaceIde` config key).
 *
 * The numeric bounds + enums/whitelists here are mirrored in
 * renderer/features/renderer-ide-state.js (that UMD module cannot import
 * services); keep those in sync. (One pre-existing asymmetry is deliberately
 * NOT mirrored: the renderer's applyPersistedState accepts any railWidth > 0
 * while this normalizer clamps to [200, 560] before write — the service is the
 * authority on the persisted path. Both sides now default railSide to 'left':
 * the fresh-profile layout docks Explorer + Search in the primary rail on the
 * left and homes Changes + Source Control in the secondary sidebar on the
 * right, which stays collapsed until the user reveals it.) */

const WORKSPACE_IDE_RAIL_WIDTH_DEFAULT = 300;
const WORKSPACE_IDE_RAIL_WIDTH_MIN = 200;
// Max reconciled 560 → 600 with the UI drag ceiling (renderer-ide-rail.js
// MAX_RAIL_WIDTH) per WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md Phase 5 — safe
// only because the renderer applies a viewport-aware clamp (renderer-ide-
// layout.js computeViewportWidthLimits) on hydration/drag/resize/config load.
const WORKSPACE_IDE_RAIL_WIDTH_MAX = 600;
const WORKSPACE_IDE_MAX_OPEN_TABS = 64;
const WORKSPACE_IDE_MAX_EXPANDED_DIRS = 200;
// Editor preference bounds/whitelists (exposed via the Settings "Editor"
// section + the statusbar chips).
const WORKSPACE_IDE_FONT_SIZE_DEFAULT = 13;
const WORKSPACE_IDE_FONT_SIZE_MIN = 8;
const WORKSPACE_IDE_FONT_SIZE_MAX = 40;
const WORKSPACE_IDE_TAB_SIZES = Object.freeze([2, 4, 8]);
const WORKSPACE_IDE_TAB_SIZE_DEFAULT = 2;
const WORKSPACE_IDE_LINE_NUMBERS = Object.freeze(['on', 'off']);
const WORKSPACE_IDE_RENDER_WHITESPACE = Object.freeze(['none', 'boundary', 'selection', 'trailing', 'all']);
// '' = follow the file's own EOL; 'lf'/'crlf' force a default for new files.
const WORKSPACE_IDE_EOL = Object.freeze(['', 'lf', 'crlf']);
const WORKSPACE_IDE_EXPLORER_SORT_MODES = Object.freeze(['name', 'type', 'modified']);
// Bottom panel (Terminal/Problems/Run output, re-homed out of the rail at
// CONFIG_VERSION 26). 'test-runner' (the Workspace Test Runner view) was added
// additively — no CONFIG_VERSION bump, since the default 'terminal' stays valid
// and the normalize only widens the accepted set (mirrors the 'problems'/'run'
// additions). The renderer mirror in renderer-ide-state.js BOTTOM_VIEWS must
// match (UMD cannot import services).
const WORKSPACE_IDE_BOTTOM_HEIGHT_DEFAULT = 220;
const WORKSPACE_IDE_BOTTOM_HEIGHT_MIN = 80;
const WORKSPACE_IDE_BOTTOM_HEIGHT_MAX = 600;
const WORKSPACE_IDE_BOTTOM_VIEWS = Object.freeze(['terminal', 'problems', 'run', 'test-runner']);
// The rail-panel whitelist is shared by the primary rail and the secondary
// sidebar (the secondary sidebar reuses existing panel ids; it never adds one).
const WORKSPACE_IDE_RAIL_PANELS = Object.freeze(['explorer', 'search', 'changes', 'source-control']);
// Editor-stage surfaces (WORKSPACE_PREVIEW_AND_MAP_PANELS_PLAN.md): which
// stage sibling is visible in #ideEditorStage. Added additively (no
// CONFIG_VERSION bump — absent keys backfill to the 'editor' default and the
// accept-set only widens). Mirrored in renderer/features/renderer-ide-state.js
// STAGE_SURFACES (the renderer UMD can't import services). Unknown ids reset
// to 'editor' — this whitelist is the persistence authority; do NOT rely on
// backfill alone when adding a surface id.
const WORKSPACE_IDE_STAGE_SURFACES = Object.freeze(['editor', 'preview', 'file_map', 'exploded']);
// Secondary sidebar (a second static side container opposite the primary rail,
// hosting one of the existing rail panels) — added at CONFIG_VERSION 27.
const WORKSPACE_IDE_SECONDARY_WIDTH_DEFAULT = 260;
const WORKSPACE_IDE_SECONDARY_WIDTH_MIN = 160;
// Max widened 480 → 600 (Phase 5, same viewport-clamp caveat as railWidth).
const WORKSPACE_IDE_SECONDARY_WIDTH_MAX = 600;
// Workspace Chat Dock (ide_chat_dock): its own design bounds — deliberately
// NOT the secondary-sidebar values (the dock hosts the composer, which needs a
// wider floor). Mirrored in renderer/features/renderer-ide-state.js (the
// renderer UMD can't import services — same precedent as secondaryWidth).
const WORKSPACE_IDE_CHAT_DOCK_WIDTH_DEFAULT = 380;
const WORKSPACE_IDE_CHAT_DOCK_WIDTH_MIN = 280;
const WORKSPACE_IDE_CHAT_DOCK_WIDTH_MAX = 2400;
const WORKSPACE_IDE_CHAT_DOCK_SIDES = Object.freeze(['left', 'right']);
// Inline autocomplete (CONFIG_VERSION 29): a quick on/off toggle (default on,
// the whole feature is still gated by the default-on workspace_inline_suggest
// flag), a selected Ollama model tag for the fill-in-the-middle completion
// model, and an advanced "run on GPU" opt-in (default off => CPU-pinned so the
// FIM model never evicts the chat model on a single GPU).
const WORKSPACE_IDE_MODEL_TAG_MAX = 200;
// Editor column rulers (CONFIG_VERSION 34): vertical guides at the given 1-based
// columns. Bounded so a hand-edited config can't push a huge/duplicate set into
// Monaco's `rulers` option; [] = no rulers (the default).
const WORKSPACE_IDE_RULERS_MAX_COUNT = 8;
const WORKSPACE_IDE_RULERS_MAX_COLUMN = 500;
const WORKSPACE_IDE_ROOT_LRU_MAX = 10;
const WORKSPACE_IDE_REPLACE_JOURNAL_MAX_APPLIED = 200;
const WORKSPACE_IDE_REPLACE_JOURNAL_QUERY_MAX = 500;
const WORKSPACE_IDE_ROOT_KEYS = Object.freeze([
  'openTabs',
  'activeTabPath',
  'expandedDirs',
  'activeStageSurface',
  'previewPath',
  'replaceJournal',
]);
const DEFAULT_WORKSPACE_IDE = Object.freeze({
  openTabs: Object.freeze([]),
  activeTabPath: '',
  expandedDirs: Object.freeze([]),
  railPanel: 'explorer',
  // Editor-stage surface + Preview stage source file (additive keys — no
  // CONFIG_VERSION bump; normalizeWorkspaceIde backfills them on every read).
  activeStageSurface: 'editor',
  previewPath: '',
  replaceJournal: null,
  // Fresh-profile layout splits the rail (the "Move View" model): Explorer +
  // Search dock in the primary rail on the LEFT; Jenny's Changes + Source Control
  // are homed in the secondary sidebar on the RIGHT, which stays COLLAPSED by
  // default (secondaryPanelOpen:false) until the user reveals it via the left
  // rail's toggle. secondaryPanel names the tab shown when it is opened.
  railSide: 'left',
  railWidth: WORKSPACE_IDE_RAIL_WIDTH_DEFAULT,
  bottomPanelOpen: false,
  bottomPanelHeight: WORKSPACE_IDE_BOTTOM_HEIGHT_DEFAULT,
  bottomPanelActiveView: 'terminal',
  secondaryPanelOpen: false,
  secondaryPanel: 'changes',
  secondaryWidth: WORKSPACE_IDE_SECONDARY_WIDTH_DEFAULT,
  // Workspace Chat Dock (ide_chat_dock): closed by default; right is the
  // default side. Additive keys — no CONFIG_VERSION bump (normalizeWorkspaceIde
  // backfills them idempotently on every read).
  chatDockOpen: false,
  chatDockSide: 'right',
  chatDockWidth: WORKSPACE_IDE_CHAT_DOCK_WIDTH_DEFAULT,
  panelLocations: Object.freeze({
    explorer: 'primary',
    search: 'primary',
    changes: 'secondary',
    'source-control': 'secondary',
  }),
  showGenerated: false,
  explorerSortMode: 'name',
  wordWrap: 'off',
  fontSize: WORKSPACE_IDE_FONT_SIZE_DEFAULT,
  tabSize: WORKSPACE_IDE_TAB_SIZE_DEFAULT,
  minimap: true,
  lineNumbers: 'on',
  renderWhitespace: 'selection',
  eol: '',
  inlineSuggestEnabled: true,
  inlineSuggestModel: '',
  // Debounced auto-save (CONFIG_VERSION 31). DEFAULT-OFF: this writes the user's
  // files, so only the literal boolean true enables it (the inverse of the
  // default-on minimap/inlineSuggestEnabled toggles). This preference is the
  // sole auto-save gate.
  autoSaveEnabled: false,
  // Save-time hygiene (CONFIG_VERSION 34): all DEFAULT-OFF (only a literal true
  // enables, the autoSaveEnabled idiom) — format-on-save runs Monaco's formatter,
  // trim drops trailing whitespace, and insert-final-newline ensures a trailing
  // newline, each on save before the write.
  formatOnSave: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
  // Editor column rulers (CONFIG_VERSION 34): vertical guides at these 1-based
  // columns; [] = off (default). normalizeRulers bounds/sorts/dedupes the set.
  rulers: Object.freeze([]),
});
const WORKSPACE_IDE_PREFERENCE_KEYS = Object.freeze(
  Object.keys(DEFAULT_WORKSPACE_IDE).filter((key) => !WORKSPACE_IDE_ROOT_KEYS.includes(key))
);

// Workspace IDE persisted UI state. Paths are workspace-root-relative,
// POSIX-separated; anything absolute, drive-lettered, UNC, or `..`-escaping
// collapses to empty and is dropped (the main process re-validates on use).
function normalizeWorkspaceIdeRelativePath(value) {
  const raw = String(value || '').trim().replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || raw.startsWith('/') || raw.startsWith('//')) {
    return '';
  }
  if (/^[A-Za-z]:/.test(raw)) {
    return '';
  }
  const segments = raw.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (!segments.length || segments.some((segment) => segment === '..')) {
    return '';
  }
  return segments.join('/');
}

function normalizeWorkspaceIdeReplaceJournal(value) {
  if (value === null || value === undefined) return null;
  if (!isWorkspaceIdeRecord(value)
    || typeof value.startedAt !== 'number' || !Number.isFinite(value.startedAt)
    || typeof value.query !== 'string'
    || typeof value.total !== 'number' || !Number.isFinite(value.total) || value.total < 0
    || !Array.isArray(value.applied)
    || (value.truncated !== undefined && typeof value.truncated !== 'boolean')) {
    return null;
  }
  const validPaths = value.applied.map(normalizeWorkspaceIdeRelativePath).filter(Boolean);
  return {
    startedAt: value.startedAt,
    query: value.query.slice(0, WORKSPACE_IDE_REPLACE_JOURNAL_QUERY_MAX),
    total: value.total,
    applied: validPaths.slice(0, WORKSPACE_IDE_REPLACE_JOURNAL_MAX_APPLIED),
    truncated: value.truncated === true || validPaths.length > WORKSPACE_IDE_REPLACE_JOURNAL_MAX_APPLIED,
  };
}

function workspaceIdePathKey(value, { platform = process.platform } = {}) {
  const normalized = normalizeWorkspaceIdeRelativePath(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// Coerce any raw value into a full WORKSPACE_IDE_RAIL_PANELS-keyed location map,
// guaranteeing >=1 primary panel so the rail content area is never empty. An
// EXPLICIT 'primary'/'secondary' is preserved; only an ABSENT (or otherwise
// invalid) key falls back to that panel's DEFAULT_WORKSPACE_IDE location. This
// absent-vs-explicit distinction is what lets the new split default reach fresh
// profiles (no persisted panelLocations) without flipping existing profiles,
// whose persisted map carries an explicit value for every panel. Mirrors the
// renderer-side helper of the same name in renderer/features/renderer-ide-state.js
// (kept in sync; the UMD module cannot import services, same precedent as the
// RAIL_PANELS whitelist).
function coercePanelLocations(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const map = {};
  for (const id of WORKSPACE_IDE_RAIL_PANELS) {
    map[id] = raw[id] === 'secondary' ? 'secondary'
      : raw[id] === 'primary' ? 'primary'
        : DEFAULT_WORKSPACE_IDE.panelLocations[id];
  }
  if (WORKSPACE_IDE_RAIL_PANELS.every((id) => map[id] === 'secondary')) {
    map[WORKSPACE_IDE_RAIL_PANELS[0]] = 'primary';
  }
  return map;
}

// Sanitize a persisted Ollama model tag (e.g. 'qwen2.5-coder:1.5b-base',
// 'JetBrains/Mellum-4b-sft-all:latest'). Whitelist the tag character set so no
// control chars / shell metacharacters can survive into a generate request;
// require an alphanumeric first char and cap the length. Anything else -> ''.
function normalizeInlineSuggestModel(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > WORKSPACE_IDE_MODEL_TAG_MAX) {
    return '';
  }
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(raw) ? raw : '';
}

// Sanitize a persisted rulers array: unique positive integer columns within
// bounds, sorted ascending, capped in count. Anything non-array or out-of-range
// is dropped, so a garbage value normalizes to [].
function normalizeRulers(value) {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set();
  for (const entry of raw) {
    const column = Number(entry);
    if (Number.isInteger(column) && column > 0 && column <= WORKSPACE_IDE_RULERS_MAX_COLUMN) {
      seen.add(column);
    }
  }
  return [...seen].sort((a, b) => a - b).slice(0, WORKSPACE_IDE_RULERS_MAX_COUNT);
}

function normalizeWorkspaceIde(value = {}, { platform = process.platform } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const rawTabs = Array.isArray(source.openTabs) ? source.openTabs : [];
  const seenTabPaths = new Set();
  const tabPathsByKey = new Map();
  const openTabs = [];
  for (const entry of rawTabs) {
    const tabPath = normalizeWorkspaceIdeRelativePath(
      typeof entry === 'string' ? entry : entry?.path
    );
    const pathKey = workspaceIdePathKey(tabPath, { platform });
    if (!tabPath || seenTabPaths.has(pathKey)) {
      continue;
    }
    seenTabPaths.add(pathKey);
    tabPathsByKey.set(pathKey, tabPath);
    // `pinned` rides inside each tab object; a string or legacy `{ path }` entry
    // has no `pinned` and hydrates unpinned (default false).
    const openTab = { path: tabPath, pinned: entry?.pinned === true };
    // "Exploded View" per-file-tab mode (renderer/features/renderer-ide-state.js
    // getTabViewMode/setTabViewMode/toggleTabViewMode). Unlike `pinned`, this
    // key is sparse/tolerant rather than always-materialized: it is carried
    // through ONLY when strictly 'exploded', and simply omitted otherwise (an
    // absent key reads back as the 'code' default). This keeps the normalizer
    // additive/whitelist-tolerant of the new optional key with no
    // CONFIG_VERSION bump — existing `{ path, pinned }` fixtures are byte-for-
    // byte unaffected.
    if (entry && entry.viewMode === 'exploded') {
      openTab.viewMode = 'exploded';
    }
    openTabs.push(openTab);
    if (openTabs.length >= WORKSPACE_IDE_MAX_OPEN_TABS) {
      break;
    }
  }
  const activeTabPath = normalizeWorkspaceIdeRelativePath(source.activeTabPath);
  const activeTabKey = workspaceIdePathKey(activeTabPath, { platform });
  const rawDirs = Array.isArray(source.expandedDirs) ? source.expandedDirs : [];
  const expandedDirs = [];
  const seenDirPaths = new Set();
  for (const rawDir of rawDirs) {
    const dirPath = normalizeWorkspaceIdeRelativePath(rawDir);
    const pathKey = workspaceIdePathKey(dirPath, { platform });
    if (!dirPath || seenDirPaths.has(pathKey)) continue;
    seenDirPaths.add(pathKey);
    expandedDirs.push(dirPath);
    if (expandedDirs.length >= WORKSPACE_IDE_MAX_EXPANDED_DIRS) break;
  }
  // Stage surface: includes-whitelist (mirrors railPanel); unknown/legacy
  // values (including old 'map://workspace' transient ids) reset to 'editor'.
  const activeStageSurface = WORKSPACE_IDE_STAGE_SURFACES.includes(source.activeStageSurface)
    ? source.activeStageSurface
    : DEFAULT_WORKSPACE_IDE.activeStageSurface;
  // Stricter than the shared relative-path gate: the gate collapses '//' runs
  // (a legacy 'preview://a.md' transient id would survive as junk) and
  // stringifies non-strings; a preview source must be a real ':'-free string.
  const previewPathCandidate = typeof source.previewPath === 'string'
    ? normalizeWorkspaceIdeRelativePath(source.previewPath)
    : '';
  const previewPath = previewPathCandidate.includes(':') ? '' : previewPathCandidate;
  const replaceJournal = normalizeWorkspaceIdeReplaceJournal(source.replaceJournal);
  // 'problems'/'terminal' left the rail at v26; a stale persisted value coerces
  // back to the default 'explorer' (the v26 migration relies on this).
  const railPanelCandidate = WORKSPACE_IDE_RAIL_PANELS.includes(source.railPanel)
    ? source.railPanel
    : DEFAULT_WORKSPACE_IDE.railPanel;
  const railSide = source.railSide === 'left' ? 'left'
    : source.railSide === 'right' ? 'right'
      : DEFAULT_WORKSPACE_IDE.railSide;
  const railWidthRaw = Number(source.railWidth);
  const railWidth = Number.isFinite(railWidthRaw)
    ? Math.min(WORKSPACE_IDE_RAIL_WIDTH_MAX, Math.max(WORKSPACE_IDE_RAIL_WIDTH_MIN, Math.trunc(railWidthRaw)))
    : DEFAULT_WORKSPACE_IDE.railWidth;
  // Per-panel location (CONFIG_VERSION 28): each rail panel lives on exactly one
  // side. coercePanelLocations builds the full 4-key map (default 'primary',
  // always >=1 primary); railPanel/secondaryPanel are then cross-validated below.
  const panelLocations = coercePanelLocations(source.panelLocations);
  const primaryIds = WORKSPACE_IDE_RAIL_PANELS.filter((id) => panelLocations[id] !== 'secondary');
  const secondaryIds = WORKSPACE_IDE_RAIL_PANELS.filter((id) => panelLocations[id] === 'secondary');
  // railPanel must be a primary-located id; coerce a drifted value to the first.
  const railPanel = primaryIds.includes(railPanelCandidate) ? railPanelCandidate : primaryIds[0];
  // Bottom panel: open only on literal true; height clamp; view enum.
  const bottomPanelOpen = source.bottomPanelOpen === true;
  const bottomHeightRaw = Number(source.bottomPanelHeight);
  const bottomPanelHeight = Number.isFinite(bottomHeightRaw)
    ? Math.min(WORKSPACE_IDE_BOTTOM_HEIGHT_MAX, Math.max(WORKSPACE_IDE_BOTTOM_HEIGHT_MIN, Math.trunc(bottomHeightRaw)))
    : DEFAULT_WORKSPACE_IDE.bottomPanelHeight;
  const bottomPanelActiveView = WORKSPACE_IDE_BOTTOM_VIEWS.includes(source.bottomPanelActiveView)
    ? source.bottomPanelActiveView
    : DEFAULT_WORKSPACE_IDE.bottomPanelActiveView;
  // Secondary sidebar: secondaryPanel is the active panel among the secondary-
  // located ids ('' when none are there); open only on literal true AND only when
  // the secondary side actually hosts a panel; width clamp mirrors railWidth.
  const secondaryPanelCandidate = WORKSPACE_IDE_RAIL_PANELS.includes(source.secondaryPanel)
    ? source.secondaryPanel
    : '';
  const secondaryPanel = secondaryIds.includes(secondaryPanelCandidate)
    ? secondaryPanelCandidate
    : (secondaryIds[0] || '');
  const secondaryPanelOpen = source.secondaryPanelOpen === true && secondaryIds.length > 0;
  const secondaryWidthRaw = Number(source.secondaryWidth);
  const secondaryWidth = Number.isFinite(secondaryWidthRaw)
    ? Math.min(WORKSPACE_IDE_SECONDARY_WIDTH_MAX, Math.max(WORKSPACE_IDE_SECONDARY_WIDTH_MIN, Math.trunc(secondaryWidthRaw)))
    : DEFAULT_WORKSPACE_IDE.secondaryWidth;
  // Chat dock triad: open only on literal true; side whitelist; width clamps
  // to the dock's own bounds (mirrors the secondaryWidth idiom).
  const chatDockOpen = source.chatDockOpen === true;
  const chatDockSide = WORKSPACE_IDE_CHAT_DOCK_SIDES.includes(source.chatDockSide)
    ? source.chatDockSide
    : DEFAULT_WORKSPACE_IDE.chatDockSide;
  const chatDockWidthRaw = Number(source.chatDockWidth);
  const chatDockWidth = Number.isFinite(chatDockWidthRaw)
    ? Math.min(WORKSPACE_IDE_CHAT_DOCK_WIDTH_MAX, Math.max(WORKSPACE_IDE_CHAT_DOCK_WIDTH_MIN, Math.trunc(chatDockWidthRaw)))
    : DEFAULT_WORKSPACE_IDE.chatDockWidth;
  const showGenerated = source.showGenerated === true;
  const explorerSortMode = WORKSPACE_IDE_EXPLORER_SORT_MODES.includes(source.explorerSortMode)
    ? source.explorerSortMode
    : DEFAULT_WORKSPACE_IDE.explorerSortMode;
  // fontSize: numeric clamp (mirrors railWidth).
  const fontSizeRaw = Number(source.fontSize);
  const fontSize = Number.isFinite(fontSizeRaw)
    ? Math.min(WORKSPACE_IDE_FONT_SIZE_MAX, Math.max(WORKSPACE_IDE_FONT_SIZE_MIN, Math.trunc(fontSizeRaw)))
    : DEFAULT_WORKSPACE_IDE.fontSize;
  // tabSize: enum {2,4,8} (a clamp would let 3/5/6/7 through; the UI offers a fixed set).
  const tabSize = WORKSPACE_IDE_TAB_SIZES.includes(Number(source.tabSize))
    ? Number(source.tabSize)
    : DEFAULT_WORKSPACE_IDE.tabSize;
  // minimap: default-on; only the literal boolean false disables it.
  const minimap = source.minimap === false ? false : true;
  // lineNumbers / renderWhitespace / eol: includes-whitelist (mirrors railPanel).
  const lineNumbers = WORKSPACE_IDE_LINE_NUMBERS.includes(source.lineNumbers)
    ? source.lineNumbers
    : DEFAULT_WORKSPACE_IDE.lineNumbers;
  const renderWhitespace = WORKSPACE_IDE_RENDER_WHITESPACE.includes(source.renderWhitespace)
    ? source.renderWhitespace
    : DEFAULT_WORKSPACE_IDE.renderWhitespace;
  const eol = WORKSPACE_IDE_EOL.includes(source.eol) ? source.eol : DEFAULT_WORKSPACE_IDE.eol;
  // Inline autocomplete: enabled default-on (only literal false disables, mirrors
  // minimap); model = sanitized tag ('' when unset/invalid). Compute placement is
  // selected by the live runtime rather than persisted as a user preference.
  const inlineSuggestEnabled = source.inlineSuggestEnabled === false ? false : true;
  const inlineSuggestModel = normalizeInlineSuggestModel(source.inlineSuggestModel);
  // Auto-save: DEFAULT-OFF, so only the literal boolean true enables it (the
  // inverse of minimap/inlineSuggestEnabled which only literal false disables).
  const autoSaveEnabled = source.autoSaveEnabled === true;
  const formatOnSave = source.formatOnSave === true;
  const trimTrailingWhitespace = source.trimTrailingWhitespace === true;
  const insertFinalNewline = source.insertFinalNewline === true;
  const rulers = normalizeRulers(source.rulers);
  return {
    openTabs,
    activeTabPath: tabPathsByKey.get(activeTabKey) || '',
    expandedDirs,
    activeStageSurface,
    previewPath,
    replaceJournal,
    railPanel,
    railSide,
    railWidth,
    bottomPanelOpen,
    bottomPanelHeight,
    bottomPanelActiveView,
    secondaryPanelOpen,
    secondaryPanel,
    secondaryWidth,
    chatDockOpen,
    chatDockSide,
    chatDockWidth,
    panelLocations,
    showGenerated,
    explorerSortMode,
    wordWrap: source.wordWrap === 'on' ? 'on' : 'off',
    fontSize,
    tabSize,
    minimap,
    lineNumbers,
    renderWhitespace,
    eol,
    inlineSuggestEnabled,
    inlineSuggestModel,
    autoSaveEnabled,
    formatOnSave,
    trimTrailingWhitespace,
    insertFinalNewline,
    rulers,
  };
}

function pickWorkspaceIdeFields(source, keys) {
  const result = {};
  for (const key of keys) result[key] = source[key];
  return result;
}

function isWorkspaceIdeRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function pickWorkspaceIdePatch(value, keys) {
  if (!isWorkspaceIdeRecord(value)) return {};
  const result = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
  }
  return result;
}

function workspaceIdePreferencePatch(value) {
  return pickWorkspaceIdePatch(value, WORKSPACE_IDE_PREFERENCE_KEYS);
}

function workspaceIdeRootPatch(value) {
  return pickWorkspaceIdePatch(value, WORKSPACE_IDE_ROOT_KEYS);
}

function normalizeWorkspaceIdeRootState(value = {}) {
  return pickWorkspaceIdeFields(normalizeWorkspaceIde(value), WORKSPACE_IDE_ROOT_KEYS);
}

function normalizeWorkspaceIdePreferences(value = {}) {
  const normalized = normalizeWorkspaceIde(value);
  const preferences = { ...normalized };
  for (const key of WORKSPACE_IDE_ROOT_KEYS) delete preferences[key];
  return preferences;
}

function validRootId(value) {
  return /^root_[0-9a-f]{24}$/.test(String(value || '').trim().toLowerCase())
    ? String(value).trim().toLowerCase()
    : '';
}

function normalizeWorkspaceIdeStore(value = {}, { onDrop = null } = {}) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const preferences = normalizeWorkspaceIdePreferences(source.preferences || source);
  const rawRoots = source.roots && typeof source.roots === 'object' && !Array.isArray(source.roots)
    ? source.roots
    : {};
  const reportDrop = typeof onDrop === 'function' ? onDrop : () => {};
  const orderedIds = [];
  const seen = new Set();
  const addId = (rawId) => {
    const id = validRootId(rawId);
    if (id && seen.has(id)) {
      return;
    }
    if (!id || !Object.prototype.hasOwnProperty.call(rawRoots, id)) {
      if (rawId != null && String(rawId)) reportDrop('invalid_or_missing_root_id');
      return;
    }
    const entry = rawRoots[id];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      // Mark it seen so a malformed root referenced by both rootLru and the
      // roots keys is counted once, not once per pass.
      seen.add(id);
      reportDrop('malformed_root_state');
      return;
    }
    seen.add(id);
    orderedIds.push(id);
  };
  for (const id of Array.isArray(source.rootLru) ? source.rootLru : []) addId(id);
  for (const id of Object.keys(rawRoots).sort()) addId(id);
  if (orderedIds.length > WORKSPACE_IDE_ROOT_LRU_MAX) {
    reportDrop('root_lru_overflow', orderedIds.length - WORKSPACE_IDE_ROOT_LRU_MAX);
  }
  const rootLru = orderedIds.slice(0, WORKSPACE_IDE_ROOT_LRU_MAX);
  const roots = Object.create(null);
  for (const id of rootLru) {
    const entry = rawRoots[id];
    roots[id] = normalizeWorkspaceIdeRootState(entry);
  }
  const filteredLru = rootLru.filter((id) => Object.prototype.hasOwnProperty.call(roots, id));
  return { preferences, rootLru: filteredLru, roots };
}

function createWorkspaceIdeStoreFromFlat(value, rootId = '') {
  const normalized = normalizeWorkspaceIde(value);
  const id = validRootId(rootId);
  const roots = Object.create(null);
  if (id) roots[id] = normalizeWorkspaceIdeRootState(normalized);
  return {
    preferences: normalizeWorkspaceIdePreferences(normalized),
    rootLru: id ? [id] : [],
    roots,
  };
}

function workspaceIdeStateForRoot(storeValue, rootId = '') {
  const store = normalizeWorkspaceIdeStore(storeValue);
  const id = validRootId(rootId);
  return normalizeWorkspaceIde({
    ...store.preferences,
    ...(id && store.roots[id] ? store.roots[id] : normalizeWorkspaceIdeRootState()),
  });
}

function updateWorkspaceIdeStore(
  storeValue,
  rootId,
  patch = {},
  { preferencesOnly = false, includeEvictions = false } = {}
) {
  const store = normalizeWorkspaceIdeStore(storeValue);
  const id = validRootId(rootId);
  const current = workspaceIdeStateForRoot(store, id);
  const next = normalizeWorkspaceIde({ ...current, ...patch });
  const roots = Object.assign(Object.create(null), store.roots);
  let rootLru = [...store.rootLru];
  let evictedRootIds = [];
  if (!preferencesOnly && id) {
    roots[id] = normalizeWorkspaceIdeRootState(next);
    rootLru = [id, ...rootLru.filter((entry) => entry !== id)];
    evictedRootIds = rootLru.slice(WORKSPACE_IDE_ROOT_LRU_MAX);
    for (const evicted of evictedRootIds) delete roots[evicted];
    rootLru = rootLru.slice(0, WORKSPACE_IDE_ROOT_LRU_MAX);
  }
  const result = {
    preferences: normalizeWorkspaceIdePreferences(next),
    rootLru,
    roots,
  };
  return includeEvictions ? { store: result, evictedRootIds } : result;
}

function touchWorkspaceIdeRoot(storeValue, rootId, { includeEvictions = false } = {}) {
  const store = normalizeWorkspaceIdeStore(storeValue);
  const id = validRootId(rootId);
  if (!id) return includeEvictions ? { store, evictedRootIds: [] } : store;
  const roots = Object.assign(Object.create(null), store.roots);
  if (!roots[id]) roots[id] = normalizeWorkspaceIdeRootState();
  const rootLru = [id, ...store.rootLru.filter((entry) => entry !== id)];
  const evictedRootIds = rootLru.slice(WORKSPACE_IDE_ROOT_LRU_MAX);
  for (const evicted of evictedRootIds) delete roots[evicted];
  const result = {
    ...store,
    roots,
    rootLru: rootLru.slice(0, WORKSPACE_IDE_ROOT_LRU_MAX),
  };
  return includeEvictions ? { store: result, evictedRootIds } : result;
}

// CONFIG_VERSION 35 migration: the default rail layout split into Explorer +
// Search (left primary rail) and Jenny's Changes + Source Control (right secondary
// sidebar, collapsed). This nudges ONLY a slice still on the PRIOR default (rail
// right + all four panels primary) onto the split; any customized layout (a
// flipped railSide or an explicitly-secondary panel) rides through untouched.
// Detect on the RAW persisted slice (`rawIde`), never a re-normalized one — the
// per-id coercePanelLocations default would itself turn an absent panelLocations
// into the split, so only an EXPLICIT all-primary raw map (what every >=v28
// prior-default profile persists) is a true prior-default match. `migratedIde` is
// the already-migrated slice used as the base in both branches.
function migrateWorkspaceIdeSplitDefault(rawIde, migratedIde) {
  const raw = rawIde && typeof rawIde === 'object' && !Array.isArray(rawIde) ? rawIde : null;
  const rawLocations = raw && raw.panelLocations && typeof raw.panelLocations === 'object'
    ? raw.panelLocations
    : null;
  const onPriorDefault = !!raw
    && raw.railSide === 'right'
    && !!rawLocations
    && WORKSPACE_IDE_RAIL_PANELS.every((id) => rawLocations[id] === 'primary');
  if (!onPriorDefault) {
    return normalizeWorkspaceIde(migratedIde || raw);
  }
  // On the prior default: carry tabs / widths / editor prefs from the base slice
  // and override only the three layout fields. A single normalizeWorkspaceIde pass
  // clamps the carried-over fields and cross-validates railPanel/secondaryPanel
  // against the new panelLocations, so no inner pre-normalize is needed. The split
  // is pinned as a literal (NOT sourced from DEFAULT_WORKSPACE_IDE) so this
  // migration reproduces the v35-era layout verbatim regardless of any future
  // change to the live default.
  return normalizeWorkspaceIde({
    ...(migratedIde || raw),
    railSide: 'left',
    panelLocations: {
      explorer: 'primary',
      search: 'primary',
      changes: 'secondary',
      'source-control': 'secondary',
    },
    secondaryPanel: 'changes',
  });
}

module.exports = {
  DEFAULT_WORKSPACE_IDE,
  migrateWorkspaceIdeSplitDefault,
  WORKSPACE_IDE_BOTTOM_VIEWS,
  WORKSPACE_IDE_RAIL_PANELS,
  WORKSPACE_IDE_STAGE_SURFACES,
  WORKSPACE_IDE_RAIL_WIDTH_MAX,
  WORKSPACE_IDE_SECONDARY_WIDTH_DEFAULT,
  WORKSPACE_IDE_SECONDARY_WIDTH_MAX,
  WORKSPACE_IDE_CHAT_DOCK_WIDTH_MIN,
  WORKSPACE_IDE_REPLACE_JOURNAL_MAX_APPLIED,
  WORKSPACE_IDE_REPLACE_JOURNAL_QUERY_MAX,
  normalizeInlineSuggestModel,
  normalizeRulers,
  normalizeWorkspaceIde,
  isWorkspaceIdeRecord,
  normalizeWorkspaceIdeRelativePath,
  normalizeWorkspaceIdeRootState,
  normalizeWorkspaceIdeStore,
  createWorkspaceIdeStoreFromFlat,
  touchWorkspaceIdeRoot,
  updateWorkspaceIdeStore,
  workspaceIdeStateForRoot,
  workspaceIdePathKey,
  workspaceIdePreferencePatch,
  workspaceIdeRootPatch,
};
