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
  // The pure normalizers and the workbench-layout half live in eager siblings (loaded
  // before this script in index.html; plain require under Node).
  const normalizers = (typeof globalThis !== 'undefined' && globalThis.rendererIdeStateNormalizers)
    || require('./renderer-ide-state-normalizers');
  const layoutState = (typeof globalThis !== 'undefined' && globalThis.rendererIdeStateLayout)
    || require('./renderer-ide-state-layout');
  const {
    FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_DEFAULT, normalizeEditorFontSize, TAB_SIZES, TAB_SIZE_DEFAULT,
    EDITOR_PREF_SPECS, RENDER_WHITESPACE,
    EXPLORER_SORT_MODES, REPLACE_JOURNAL_MAX_APPLIED, REPLACE_JOURNAL_QUERY_MAX,
    CURSOR_STYLES, CURSOR_BLINKING, AUTO_SAVE_MODES, AUTO_SAVE_DELAY_MIN, AUTO_SAVE_DELAY_MAX,
    TERMINAL_SCROLLBACK_MIN, TERMINAL_SCROLLBACK_DEFAULT, TERMINAL_SCROLLBACK_MAX,
    normalizeFontFamily, normalizeRulers, normalizeIdeRelativePath, normalizePreviewSourcePath,
    normalizeReplaceJournal, normalizeSearchHistory, normalizeEditorPrefs,
  } = normalizers;
  const {
    RAIL_PANELS, BOTTOM_VIEWS, CHAT_DOCK_WIDTH_MIN, CHAT_DOCK_WIDTH_MAX, CHAT_DOCK_WIDTH_DEFAULT,
    BOTTOM_HEIGHT_DEFAULT, SECONDARY_WIDTH_DEFAULT,
    clampBottomHeight, clampSecondaryWidth, clampChatDockWidth, coerceChatDockSide,
    __setLayoutModulesForTest, getWorkbenchLayout, syncLegacyFromLayout, commitWorkbenchLayout,
    coercePanelLocations, getPanelLocation, secondaryPanels, normalizeLegacyPanelFields, layoutModules,
  } = layoutState;
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

  // Sets the Preview stage's source file; anything failing the source gate
  // (absolute, escaping, legacy preview:///map:// ids, non-strings) clears it.
  function setPreviewPath(ide, path) {
    ide.previewPath = normalizePreviewSourcePath(path);
    return ide.previewPath;
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
      followJenny: true, // Follow Jenny (row 121): on unless switched off
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
      followJenny: ide.followJenny !== false,
      explorerSortMode: EXPLORER_SORT_MODES.includes(ide.explorerSortMode) ? ide.explorerSortMode : 'name',
      ...normalizeEditorPrefs(ide),
    };
    if (layout) {
      persisted.workbenchLayout = mods.model.cloneLayout(layout);
    }
    return persisted;
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
    ide.followJenny = source.followJenny !== false;
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
