/* Workspace IDE page controller: owns lazy activation, editor flows, and composed panels. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return {};
  }

  function createIdeController(deps) {
    const { state } = deps || {};
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const registerCleanup = typeof deps?.registerCleanup === 'function' ? deps.registerCleanup : noop;
    const workspaceRootService = deps?.workspaceRootService || null;
    const callbacks = deps?.callbacks || {};
    const {
      escapeHtml = (value) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;'),
      appendClientLog = noop,
      showToastMessage = noop,
      showShellErrorToast = noop,
      toErrorMessage = (error, fallback) => String(error?.message || error || fallback || ''),
      // Same canonical turn view-models the chat code-review rail reads;
      // threaded in from the lifecycle composition via the service registry.
      getTurnViewModelsForActiveSession = () => [],
      onSendToJenny = noop, activateWorkspaceSession = noop,
    } = callbacks;

    const windowRef = globalRef.window || globalRef;
    const ideStateUtils = resolveModule('rendererIdeState', './renderer-ide-state');
    const editorHostUtils = resolveModule('rendererIdeEditorHost', './renderer-ide-editor-host');
    const tabsUtils = resolveModule('rendererIdeTabs', './renderer-ide-tabs');
    const wiringUtils = resolveModule('rendererIdeExplorerWiring', './renderer-ide-explorer-wiring');
    const railUtils = resolveModule('rendererIdeRail', './renderer-ide-rail');
    const searchPanelUtils = resolveModule('rendererIdeSearchPanel', './renderer-ide-search-panel');
    const changesPanelUtils = resolveModule('rendererIdeChangesPanel', './renderer-ide-changes-panel');
    const statusBarUtils = resolveModule('rendererIdeStatusBar', './renderer-ide-statusbar');
    const ledgerUtils = resolveModule('rendererJennyChangeLedger', '../chat/renderer-jenny-change-ledger');
    const tabsControllerUtils = resolveModule('rendererIdeTabsController', './renderer-ide-tabs-controller');
    const quickOpenUtils = resolveModule('rendererIdeQuickOpen', './renderer-ide-quick-open');
    const previewControllerUtils = resolveModule('rendererIdePreviewController', './renderer-ide-preview-controller');
    const diffControllerUtils = resolveModule('rendererIdeDiffController', './renderer-ide-diff-controller');
    const terminalPanelUtils = resolveModule('rendererIdeTerminalPanel', './renderer-ide-terminal-panel');
    const themeBridgeUtils = resolveModule('rendererIdeThemeBridge', './renderer-ide-theme-bridge');
    const actionButton = resolveModule('inventoryActionButton', '../inventory/action-button');
    const pathMenuUtils = resolveModule('rendererIdePathMenu', './renderer-ide-path-menu');
    const welcomeUtils = resolveModule('rendererIdeWelcome', './renderer-ide-welcome');
    const ideShortcutsUtils = resolveModule('rendererIdeShortcuts', './renderer-ide-shortcuts');
    const selectionIntentsUtils = resolveModule('rendererIdeSelectionIntents', './renderer-ide-selection-intents');
    const closedTabsUtils = resolveModule('rendererIdeClosedTabs', './renderer-ide-closed-tabs');
    const confirmDialogUtils = resolveModule('rendererIdeConfirmDialog', './renderer-ide-confirm-dialog');
    const closeOrchestratorUtils = resolveModule('rendererIdeCloseOrchestrator', './renderer-ide-close-orchestrator');
    const helpOverlayUtils = resolveModule('inventoryHelpOverlay', '../inventory/help-overlay');
    const watchControllerUtils = resolveModule('rendererIdeWatchController', './renderer-ide-watch-controller');
    const chipPickerUtils = resolveModule('rendererIdeChipPicker', './renderer-ide-chip-picker');
    const editorPrefsUtils = resolveModule('rendererIdeEditorPrefs', './renderer-ide-editor-prefs');
    const popoverUtils = resolveModule('inventoryPopover', '../inventory/popover');
    const gitFeatureUtils = resolveModule('rendererIdeGitFeature', './renderer-ide-git-feature');
    const problemsPanelUtils = resolveModule('rendererIdeProblemsPanel', './renderer-ide-problems-panel');
    const debugInspectorUtils = resolveModule('rendererIdeDebugInspector', './renderer-ide-debug-inspector');
    const bottomPanelUtils = resolveModule('rendererIdeBottomPanel', './renderer-ide-bottom-panel');
    const secondarySidebarUtils = resolveModule('rendererIdeSecondarySidebar', './renderer-ide-secondary-sidebar');
    const mruUtils = resolveModule('rendererIdeMru', './renderer-ide-mru');
    const chatDockUtils = resolveModule('rendererIdeChatDock', './renderer-ide-chat-dock');
    const layoutUtils = resolveModule('rendererIdeLayout', './renderer-ide-layout');
    const commandsUtils = resolveModule('rendererIdeCommands', './renderer-ide-commands');
    const navBookmarksUtils = resolveModule('rendererIdeNavBookmarks', './renderer-ide-nav-bookmarks');
    const inlineSuggestUtils = resolveModule('rendererIdeInlineSuggest', './renderer-ide-inline-suggest');
    const autoSaveUtils = resolveModule('rendererIdeAutoSave', './renderer-ide-auto-save');
    const fimPickerUtils = resolveModule('rendererIdeFimPicker', './renderer-ide-fim-picker');
    const branchSwitcherUtils = resolveModule('rendererIdeBranchSwitcher', './renderer-ide-branch-switcher');
    const keyboardUtils = resolveModule('rendererChatKeyboardUtils', '../chat/renderer-chat-keyboard-utils');
    /* Path/OS utility context-menu items (reveal/open-in-default/copy) live in
     * the sibling module; the wrapper degrades to no items if it is absent. */
    const idePathMenu = pathMenuUtils.createIdePathMenu?.({
      getWorkspaceFsApi,
      windowRef,
      showShellErrorToast,
      showToastMessage,
      toErrorMessage,
      appendClientLog,
    }) || null;
    function buildPathUtilityMenuItems(path, kind) {
      return idePathMenu ? idePathMenu.buildPathUtilityMenuItems(path, kind) : [];
    }
    let activated = false, bound = false, disposed = false, lifecycleEpoch = 0; registerCleanup(() => { disposed = true; lifecycleEpoch += 1; });
    const lifecycleCurrent = (epoch) => !disposed && epoch === lifecycleEpoch;
    // Runtime file-tab MRU for the Ctrl+E jump list (extracted sibling).
    const ideMru = mruUtils.createIdeMru?.({
      isDiffTabId: (path) => ideStateUtils.isDiffTabId?.(path) === true,
      isPreviewTabId: (path) => ideStateUtils.isPreviewTabId?.(path) === true,
    }) || { record: noop, getRecentFiles: () => [] };
    const getRecentFiles = () => ideMru.getRecentFiles(getIde().openTabs);
    function getIde() {
      if (!state.ui.ide || typeof state.ui.ide !== 'object') {
        state.ui.ide = ideStateUtils.createIdeUiState?.() || {};
      }
      return state.ui.ide;
    }

    function getWorkspaceFsApi() {
      return windowRef.jennyShell?.workspaceFs || null;
    }
    function getWorkspaceIdeApi() {
      return windowRef.jennyShell?.workspaceIde || null;
    }
    function getWorkspaceRootApi() {
      return workspaceRootService;
    }
    function getWorkspaceTerminalApi() {
      return windowRef.jennyShell?.workspaceTerminal || null;
    }

    const themeBridge = themeBridgeUtils.createIdeThemeBridge?.({
      documentRef: windowRef.document || null, appendClientLog,
    }) || null;
    const editorHost = editorHostUtils.createIdeEditorHost?.({
      getDom,
      log: (...args) => appendClientLog(...args),
      onDirtyChange(path, dirty) {
        fileLifecycle?.noteDirty(path, dirty); ideStateUtils.setTabDirty?.(getIde(), path, dirty);
        renderTabs();
      },
      onSaveRequest() {
        saveActiveFile();
      },
      onCursorActivity(info) {
        // Cursor choke point -> nav-bookmarks facade (drops the null non-file
        // diff/preview case; nav-history coalesces the rest).
        navBookmarks?.recordCursorNav(info);
        statusBar?.render();
        // After statusBar (which owns #ideBreadcrumbs innerHTML) so the symbol
        // path segments survive its file-path render.
        symbolNav?.render();
      },
      onModelChange(path) {
        fileLifecycle?.noteEdit(path); previewController?.handleModelChange(path);
        qol?.previewStage?.handleModelChange(path);
        qol?.presentation?.noteEdit(); // recent-typing signal for presentation policy
        gutterDecorations?.schedule(path);
        autoSave?.onChange(path);
      },
      onGlyphMarginClick(line) { navBookmarks?.toggleAtGlyph(line); },
      onPreviewDomInjected(containerEl) {
        previewController?.handlePreviewDomInjected(containerEl);
      },
      onMonacoReady(monacoApi) {
        // Swap the load-time vs-dark default for the palette-matched theme.
        themeBridge?.handleMonacoReady(monacoApi);
        editorPrefsUtils.applyEditorPrefs?.(getIde(), editorHost, chipPicker);
        selectionIntents?.registerActions();
        wordWrap?.registerAction(monacoApi);
        debugInspector?.registerActions(); runScripts?.registerActions();
        inlineSuggest?.handleMonacoReady(monacoApi);
        symbolNav?.handleMonacoReady(monacoApi);
      },
    }) || null;
    // Git gutter change-bars: a green/blue/red strip vs HEAD on the active editor
    // (self-contained module - owns its git client, debounce, and lifecycle).
    const gutterDecorations = resolveModule('rendererIdeGutterDecorations', './renderer-ide-gutter-decorations')
      .createIdeGutterDecorations?.({ editorHost, windowRef, appendClientLog }) || null;
    // Cursor-navigation glue behind ONE facade (file-size ceiling): Go
    // Back/Forward history + runtime line bookmarks. Controller feeds the cursor
    // choke point, glyph click, prune + spreads its thunks; reveal = search open.
    const navBookmarks = navBookmarksUtils.createIdeNavBookmarks?.({
      editorHost, getDom, windowRef, escapeHtml, openFile, appendClientLog,
      reveal: (path, line, column) => handleSearchResultOpen(path, line, column),
    }) || null;
    // TS/JS symbol navigation: caret symbol breadcrumb + Ctrl+T workspace-symbol
    // picker (self-contained module - owns its breadcrumb host, TS-worker calls,
    // and the picker overlay; self-subscribes to ide:active-file-changed).
    const symbolNav = resolveModule('rendererIdeSymbolNav', './renderer-ide-symbol-nav')
      .createIdeSymbolNav?.({
        editorHost, getDom, windowRef, escapeHtml, appendClientLog,
        onOpenFile: (path) => openFile(path),
      }) || null;
    // Inline autocomplete provider (registers itself onto Monaco in
    // onMonacoReady above when the workspace_inline_suggest flag is on; also owns
    // its statusbar quick-toggle via statusCallbacks() below).
    const inlineSuggest = inlineSuggestUtils.createIdeInlineSuggest?.({
      editorHost,
      getIde: () => getIde(),
      isFeatureEnabled: () => state?.features?.featureFlags?.workspace_inline_suggest === true,
      isTestHookEnabled: () => state?.features?.featureFlags?.agent_test_hooks === true,
      windowRef,
      commitPreference: (key, value) => commitEditorPreference(key, value),
      requestStatusRender: () => statusBar?.render(),
      log: (...args) => appendClientLog(...args),
    }) || null;
    // Debounced auto-save (default-OFF via the per-user autoSaveEnabled pref).
    // Reuses saveActiveFile so the
    // mtime-conflict + stale guards hold; the module skips non-file/stale tabs and
    // is cancelled on tab switch/close (debounce + gating live in the module).
    const autoSave = autoSaveUtils.createIdeAutoSave?.({
      editorHost,
      getIde: () => getIde(),
      saveActiveFile: () => saveActiveFile({ unattended: true }),
      isSaving: () => fileLifecycle?.isSaving() === true,
      isEnabled: () => getIde().autoSaveEnabled === true,
    }) || null;
    // Word-wrap toggle (Alt+Z action + statusbar) lives in editor-prefs for the cap.
    const wordWrap = editorPrefsUtils.createWordWrapController?.({
      getIde: () => getIde(),
      editorHost,
      commitPreference: (key, value) => commitEditorPreference(key, value),
      requestStatusRender: () => statusBar?.render(),
    }) || null;
    const tabStrip = tabsUtils.createIdeTabStrip?.({ getDom, escapeHtml }) || null;
    // Each rail panel is a SINGLE instance whose home side follows
    // ide.panelLocations (the "Move View" model): getMountEl resolves the host
    // from the location, isActivePanel is the shared per-side visibility gate,
    // and onMovePanel re-homes a panel (keeping >=1 in the rail).
    const panelHost = (id) => (ideStateUtils.getPanelLocation(getIde(), id) === 'secondary'
      ? getDom().ideSecondarySidebarPanel
      : getDom().ideRailPanel);
    const panelDeps = (id) => ({
      getMountEl: () => panelHost(id),
      isActivePanel: () => ideStateUtils.isPanelActive(getIde(), id),
    });
    const onMovePanel = (id, target) => {
      ideStateUtils.movePanelLocation(getIde(), id, target);
      schedulePersist();
      renderIde();
    };
    const explorer = wiringUtils.createIdeExplorerWiring?.({
      getDom, escapeHtml, getIde, getWorkspaceFsApi, openFile,
      buildFileContextMenuItems, buildPathUtilityMenuItems, schedulePersist,
      getWorkspaceRootApi, showShellErrorToast, appendClientLog, panelDeps,
      getChooseWorkspaceRoot: () => chooseWorkspaceRoot,
      getFileLifecycle: () => fileLifecycle, getSearchPanel: () => searchPanel,
      getCloseOrchestrator: () => closeOrchestrator, getConfirmDialog: () => confirmDialog,
      getGitFeature: () => gitFeature, getTerminalPanel: () => terminalPanel, getBottomPanel: () => bottomPanel,
      getFeatureFlags: () => state?.features?.featureFlags,
    }) || null;
    const tree = explorer?.tree || null;
    const rail = railUtils.createIdeRail?.({
      getDom,
      getIde: () => getIde(),
      requestRender: () => renderIde(),
      schedulePersist: () => schedulePersist(),
      onToggleSecondary: () => secondarySidebar?.toggle(),
      onToggleChatDock: () => ideChatDock?.toggle(),
      isChatDockEnabled: () => state?.features?.featureFlags?.ide_chat_dock === true,
      onMovePanel,
      // Stage-surface entries (two-entry-kind activity strip): flag getters
      // read per render; activation routes through the stage-surface machine
      // (qol is built later — the thunks resolve lazily on click/render).
      onActivateStageSurface: (surface) => qol?.stageSurface?.toggle(surface),
      isStageSurfaceEnabled: (surface) => (surface === 'preview'
        ? state?.features?.featureFlags?.workspace_preview_surface === true
        : surface === 'file_map' && state?.features?.featureFlags?.workspace_file_map === true),
      getActiveStageSurface: () => qol?.stageSurface?.getEffectiveSurface() || 'editor',
      // Viewport-aware drag ceiling (layout owns the budget; thunk — layout
      // is constructed later).
      getMaxRailWidth: () => layout?.maxRailWidth() ?? Infinity,
    }) || null;
    // The panel owns its find-AND-replace controller internally (keeps this
    // controller under the line cap); it just needs editor-host + save context.
    const searchDeps = {
      getDom,
      escapeHtml,
      getIde: () => getIde(),
      getWorkspaceFsApi,
      editorHost, getFileOperations: () => fileLifecycle?.fileOperations, schedulePersist: () => schedulePersist(), flushPersist: () => flushPersist(),
      onOpenResult: handleSearchResultOpen, appendClientLog, showShellErrorToast: (...args) => showShellErrorToast(...args),
      renderTabs: () => renderTabs(),
      isSaving: () => fileLifecycle?.isSaving() === true,
      // Find-in-Folder switches the rail to search (rail state + renderIde live here).
      onActivateSearch: () => { const ide = getIde(); if (ide.railPanel !== 'search') { ide.railPanel = 'search'; schedulePersist(); } renderIde(); },
    };
    const searchPanel = searchPanelUtils.createIdeSearchPanel?.({ ...searchDeps, ...panelDeps('search') }) || null;
    const changesDeps = {
      getDom,
      escapeHtml,
      getIde: () => getIde(),
      getWorkspaceId: () => String(state.workspaceRoot?.rootId || ''),
      getChangeLedger,
      getDirtyPaths: () => Object.keys(getIde().dirtyByPath || {}),
      onOpenChangeDiff: (change) => {
        openChangeDiff(change);
      },
      onCompareUnsaved: (path) => {
        openUnsavedCompare(path);
      },
      onRevert: (change) => diffController?.revertChange(change), appendClientLog,
    };
    const changesPanel = changesPanelUtils.createIdeChangesPanel?.({ ...changesDeps, ...panelDeps('changes') }) || null;

    const ptyTerminalPanelUtils = resolveModule('rendererIdePtyTerminalPanel', './renderer-ide-pty-terminal-panel');
    const terminalPanel = resolveModule('rendererIdeTerminalWiring', './renderer-ide-terminal-wiring').createIdeTerminalPanelForFlags?.({
      isPtyEnabled: () => state?.features?.featureFlags?.workspace_pty_terminal === true, getPtyMountEl: () => getDom().ideBottomTerminalHost, terminalPanelUtils, ptyTerminalPanelUtils,
      deps: {
        getDom, getIde: () => getIde(), getWorkspaceTerminalApi, appendClientLog, getMountEl: () => getDom().ideBottomPanelContent,
        getWorkspacePtyApi: () => windowRef.jennyShell?.workspacePty || null,
        isActivePanel: () => getIde().bottomPanelOpen === true && getIde().bottomPanelActiveView === 'terminal',
        showError: (message, meta) => showShellErrorToast(message, meta), toErrorMessage: (...args) => toErrorMessage(...args),
      },
    }) || null;

    const statusBar = statusBarUtils.createIdeStatusBar?.({
      getDom,
      escapeHtml,
      getIde: () => getIde(),
      callbacks: {
        getCursorInfo: () => editorHost?.getCursorInfo() || null,
        getActiveLanguageId: () => editorHost?.getActiveLanguageId() || '',
        getBranch: () => gitFeature?.getBranch() || '',
        getDirtyCount: () => gitFeature?.getDirtyCount() || 0,
        getProblemCounts: () => problemsPanel?.getCounts() || null,
        getBottomPanelOpen: () => getIde().bottomPanelOpen === true, getRunning: () => runScripts?.isRunning() === true,
        ...(inlineSuggest?.statusCallbacks?.() || {}),
        onOpenInlineSuggestMenu: (anchor) => fimPicker?.open(anchor),
        onSwitchBranch: () => branchSwitcher?.open(),
        onOpenProblems: () => bottomPanel?.open('problems'),
        onToggleBottomPanel: () => bottomPanel?.toggle(), onKillRun: () => runScripts?.kill(),
        getEol: (path) => editorHost?.getEol(path) || 'lf',
        getTabSize: () => editorHost?.getTabSize?.() || 2,
        onPickTabSize: (anchor) => chipPicker?.openTabSizePicker(anchor),
        onPickEol: (anchor) => chipPicker?.openEolPicker(anchor),
        isDirty: (path) => editorHost?.isDirty(path) === true,
        isDiffTab: (path) => ideStateUtils.isDiffTabId?.(path) === true
          || ideStateUtils.isPreviewTabId?.(path) === true,
        getDocumentKind: (path) => editorHost?.getDocumentKind(path) || '',
        isLargeFile: (path) => editorHost?.isLargeFile?.(path) === true,
        onGoToLine: () => editorHost?.triggerGoToLine(),
        onToggleWordWrap: () => wordWrap?.toggle(),
      },
    }) || null;

    const tabsController = tabsControllerUtils.createIdeTabsController?.({
      getDom,
      getIde: () => getIde(),
      callbacks: {
        activateTab: (path) => activateTab(path),
        closeTab: (path) => requestCloseTab(path),
        closeOthers: (path) => closeOrchestrator?.requestCloseOthers(path),
        closeAll: () => closeOrchestrator?.requestCloseAll(),
        closeSaved: () => closeOrchestrator?.requestCloseSaved(),
        openUnsavedCompare: (path) => openUnsavedCompare(path),
        isDirty: (path) => editorHost?.isDirty(path) === true,
        isDiffTabId: (path) => ideStateUtils.isDiffTabId?.(path) === true,
        isPreviewTabId: (path) => ideStateUtils.isPreviewTabId?.(path) === true,
        buildExtraMenuItems: (path) => buildFileContextMenuItems(path),
        revealInExplorer: (path) => revealInExplorer(path),
        schedulePersist: () => schedulePersist(),
        renderTabs: () => renderTabs(),
        showShellErrorToast: (...args) => showShellErrorToast(...args),
        showToastMessage: (...args) => showToastMessage(...args),
        toErrorMessage: (...args) => toErrorMessage(...args),
      },
    }) || null;

    const previewController = previewControllerUtils.createIdePreviewController?.({
      getIde: () => getIde(),
      getWorkspaceFsApi,
      callbacks: {
        hasDocument: (path) => editorHost?.hasDocument(path) === true,
        getValue: (path) => editorHost?.getValue(path) || '',
        openPreviewDocument: (payload) => editorHost?.openPreviewDocument(payload),
        updatePreview: (id, html) => editorHost?.updatePreview(id, html),
        activateDocument: (id) => editorHost?.activateDocument(id),
        renderTabs: () => renderTabs(),
        showShellErrorToast: (...args) => showShellErrorToast(...args), appendClientLog,
        // Unified Preview stage retarget (workspace_preview_surface): flag-on
        // routes Open Preview to the stage surface; flag-off keeps preview tabs.
        openPreviewStage: (path) => qol?.previewStage?.open(path),
        isPreviewStageEnabled: () => state?.features?.featureFlags?.workspace_preview_surface === true,
      },
    }) || null;

    const quickOpen = quickOpenUtils.createIdeQuickOpen?.({
      getDom,
      escapeHtml,
      callbacks: {
        getWorkspaceFsApi,
        onOpenFile: (path) => openFile(path),
        // ":N" off a path opens then reveals; a bare ":N" (path '') reveals in
        // the already-open file. Reuses the search open-then-reveal helper.
        onOpenFileAtLine: (path, line, column) => (path
          ? handleSearchResultOpen(path, line, column)
          : editorHost?.revealPosition(getIde().activeTabPath, line, column)),
        getRecentFiles,
        onClosed: () => editorHost?.focus(), appendClientLog,
      },
    }) || null;

    // Welcome / Start surface for the empty editor state. Owns the empty-state
    // copy + Choose-Folder action (extracted from this controller for the
    // file-size ceiling) and adds recent files + a keyboard cheat-sheet.
    const welcome = welcomeUtils.createIdeWelcome?.({
      getDom,
      escapeHtml,
      actionButton: typeof actionButton === 'function' ? actionButton : null,
      getFsApi: () => getWorkspaceFsApi(),
      buildShortcutsHtml: () => ideShortcutsUtils.buildIdeShortcutsHtml?.() || '',
      onOpenFile: (path) => {
        openFile(path);
      },
      onChooseFolder: () => chooseWorkspaceRoot(),
    }) || null;

    // Editor selection actions (Send to Jenny + Explain/Fix/Refactor/Tests
    // intents). Prefill-only; registered against Monaco in onMonacoReady.
    const selectionIntents = selectionIntentsUtils.createIdeSelectionIntents?.({
      editorHost,
      isDiffTabId: (path) => ideStateUtils.isDiffTabId?.(path) === true,
      onSendToJenny, onNotice: (message) => showToastMessage(message, { dedupeKey: 'ide-selection-intents' }),
    }) || null;

    // "Debug this file (Node Inspector)" launches via the
    // terminal + scrape the ws:// banner; all logic lives in the sibling.
    const debugInspector = debugInspectorUtils.createIdeDebugInspector?.({
      editorHost, getWorkspaceTerminalApi, appendClientLog, showToastMessage,
      openTerminalPanel: () => bottomPanel?.open('terminal'),
      startTerminalSession: () => terminalPanel?.startSession(),
      isDiffTabId: (path) => ideStateUtils.isDiffTabId?.(path) === true,
      getClipboardApi: () => windowRef.jennyShell?.clipboard || null,
    }) || null;

    // Bounded LIFO of recently closed file tabs for Ctrl+Shift+T. When true,
    // closes do NOT record into the stack (delete/rename - the file is gone).
    const closedTabs = closedTabsUtils.createIdeClosedTabsStack?.({ limit: 10 }) || null;

    // Dirty-tab close confirm + the async orchestrator that batches it across
    // single / Close Others / Close All closes. The controller's closeTab stays
    // the no-prompt force-close primitive (delete/rename bypass the prompt).
    const confirmDialog = confirmDialogUtils.createIdeConfirmDialog?.({
      document: windowRef.document || null,
      escapeHtml,
      actionButton: typeof actionButton === 'function' ? actionButton : null,
      helpOverlayFactory: helpOverlayUtils.createHelpOverlay,
    }) || null;
    const closeOrchestrator = closeOrchestratorUtils.createIdeCloseOrchestrator?.({
      getIde: () => getIde(),
      isDirty: (path) => editorHost?.isDirty(path) === true,
      isDiffTabId: (path) => ideStateUtils.isDiffTabId?.(path) === true,
      isPreviewTabId: (path) => ideStateUtils.isPreviewTabId?.(path) === true,
      forceClose: (path) => closeTab(path),
      saveFile: (path) => saveFile(path),
      getDocumentRevision: (path) => { const snapshot = fileLifecycle?.fileOperations?.captureReload?.(path, { allowDirty: true }); return snapshot ? `${snapshot.documentId}:${snapshot.editVersion}` : null; },
      confirmClose: (payload) => (confirmDialog
        ? confirmDialog.confirmClose(payload)
        : Promise.resolve('cancel')),
    }) || null;

    // IDE palette commands (Format / Go to Symbol / Find References / Toggle
    // Minimap / Reopen Closed Tab) + the "?" shortcuts overlay. getCommandItems
    // is empty off the IDE view; the overlay shares renderer-ide-shortcuts.
    const ideCommands = commandsUtils.createIdeCommands?.({
      document: windowRef.document || null,
      getActiveView: () => state.ui?.activeView || '',
      editorHost,
      toggleMinimap: () => editorPrefsUtils.toggleMinimap?.(getIde(), editorHost, commitEditorPreference, () => statusBar?.render()),
      reopenClosedTab: () => reopenClosedTab(),
      workspaceSymbolPicker: () => symbolNav?.openPicker(), openFileMap: () => qol?.mapController?.openFileMap(), isFileMapEnabled: () => state.features?.featureFlags?.workspace_file_map === true, revealInMap: () => qol?.revealActiveFileInMap?.(), showBlastRadius: () => qol?.blastActiveFileInMap?.(), toggleExplodedView: () => qol?.explodeController?.toggleActiveTab(), isExplodedViewEnabled: () => state.features?.featureFlags?.workspace_exploded_view === true, openPreviewSurface: () => qol?.stageSurface?.activate('preview'), previewActiveFile: () => qol?.previewStage?.open(getIde().activeTabPath || ''), isPreviewSurfaceEnabled: () => state.features?.featureFlags?.workspace_preview_surface === true,
      ...(navBookmarks?.bookmarkActions),
      helpOverlayFactory: helpOverlayUtils.createHelpOverlay,
      buildShortcutsHtml: () => ideShortcutsUtils.buildIdeShortcutsHtml?.() || '',
    }) || null;

    // Single-tab closes (×, middle-click, Ctrl+F4, context Close) route through
    // the orchestrator; degrades to a direct force-close if it is unavailable.
    function requestCloseTab(path) {
      if (closeOrchestrator) {
        return closeOrchestrator.requestClose(path);
      }
      closeTab(path);
      return undefined;
    }

    // Interactive tab-size / EOL statusbar chips update the durable defaults.
    const chipPicker = chipPickerUtils.createIdeChipPicker?.({
      getDom,
      editorHost,
      getActivePath: () => editorHost?.getActivePath() || '',
      escapeHtml,
      actionButton: typeof actionButton === 'function' ? actionButton : null,
      popover: typeof popoverUtils === 'function' ? popoverUtils : popoverUtils?.default,
      onAfterChange: (change) => { void editorPrefsUtils.persistChipChange?.(getIde(), change, commitEditorPreference); },
    }) || null;

    // Completion-model menu behind the statusbar autocomplete caret (FIM model
    // pick + live load/unload). Controller-free chrome like chipPicker.
    const fimPicker = fimPickerUtils.createIdeFimPicker?.({
      getDom,
      getIde: () => getIde(),
      popover: typeof popoverUtils === 'function' ? popoverUtils : popoverUtils?.default,
      actionButton: typeof actionButton === 'function' ? actionButton : null,
      escapeHtml,
      commitPreference: (key, value) => commitEditorPreference(key, value),
      requestStatusRender: () => statusBar?.render(),
      windowRef,
    }) || null;

    // Breadcrumb clicks / "Reveal in Explorer": switch the rail to the
    // explorer panel and route tree focus (which scrolls) to the path.
    function revealInExplorer(path, options) {
      const ide = getIde();
      if (ide.railPanel !== 'explorer') {
        ide.railPanel = 'explorer';
        schedulePersist();
      }
      renderIde();
      tree?.revealPath(path, options);
    }

    function getChangeLedger() {
      const build = ledgerUtils.buildJennyChangeLedgerFromTurnViewModels;
      if (typeof build !== 'function') {
        return { changes: [], skipped: [] };
      }
      return build(getTurnViewModelsForActiveSession() || [], {
        sessionId: String(state.currentSessionId || ''),
        workspaceId: String(state.workspaceRoot?.rootId || ''),
      });
    }

    // Diff review-tab flows live in renderer-ide-diff-controller (extracted
    // for the file-size ceiling); same editorHost/diff-tab plumbing.
    const diffController = diffControllerUtils.createIdeDiffController?.({
      getIde: () => getIde(),
      getDom,
      getWorkspaceFsApi,
      editorHost, getFileOperations: () => fileLifecycle?.fileOperations,
      getWorkspaceId: () => String(state.workspaceRoot?.rootId || ''),
      confirmDialog,
      escapeHtml,
      callbacks: {
        renderTabs: () => renderTabs(),
        showShellErrorToast: (...args) => showShellErrorToast(...args), appendClientLog,
        buildHunksSummaryText: (change) => changesPanelUtils.buildHunksSummaryText?.(change) || '',
      },
    }) || null;

    function openChangeDiff(change) {
      return diffController ? diffController.openChangeDiff(change) : false;
    }

    function openUnsavedCompare(path) {
      return diffController ? diffController.openUnsavedCompare(path) : false;
    }

    // Git client + status store + Source Control panel; the tree + statusbar read its getters.
    const gitFeature = gitFeatureUtils.createIdeGitFeature?.({
      windowRef, getDom, getIde, editorHost, getWorkspaceFsApi, getFileLifecycle: () => fileLifecycle, onDeleteUntracked: (path) => tree?.deleteEntry(path, 'file'), confirmDialog, escapeHtml,
      appendClientLog, showShellErrorToast, renderTabs, schedulePersist, requestRender: renderIde,
      onChange: () => { tree?.applyGitDecorations(); statusBar?.render(); gutterDecorations?.refreshActive(); },
      // Single Source Control view; its host + active-gate follow the panel's
      // location like the other panels.
      ...panelDeps('source-control'),
    }) || null;
    // Beginner-friendly branch switcher + gentle git guardrails: a Quick-pick of
    // local branches (dirty-tree -> shelve/switch/cancel guard), create-branch,
    // and de-jargoned undo-last-commit / shelve / restore actions. All copy is
    // static templates with computed counts - no model calls. Reads the git
    // feature's getters + refresh; lives behind the same workspace_git flag.
    const branchSwitcher = branchSwitcherUtils.createIdeBranchSwitcher?.({
      getDom, escapeHtml, windowRef, confirmDialog,
      showToastMessage, showShellErrorToast, appendClientLog,
      callbacks: {
        getCurrentBranch: () => gitFeature?.getBranch() || '',
        getDirtyCount: () => gitFeature?.getDirtyCount() || 0,
        // Ahead/behind come from the status store snapshot (no new IPC), exposed
        // as a getter on the git feature like getBranch / getDirtyCount.
        getAheadBehind: () => gitFeature?.getAheadBehind?.() || { ahead: 0, behind: 0 },
        isRepo: () => gitFeature?.isRepo() === true,
        isAvailable: () => gitFeature?.isAvailable() === true,
        refreshGit: () => (gitFeature ? gitFeature.refreshNow() : Promise.resolve()),
        onClosed: () => editorHost?.focus(),
      },
    }) || null;
    // Problems panel + statusbar badge over the editor
    // host's diagnostics surface (getMarkers/onMarkersChanged) for open files;
    // rows reveal through the same open-then-revealPosition path search uses.
    const problemsPanel = problemsPanelUtils.createIdeProblemsPanel?.({
      getDom, getIde, escapeHtml, editorHost, requestRender: renderIde,
      getMountEl: () => getDom().ideBottomPanelContent,
      isActivePanel: () => getIde().bottomPanelOpen === true && getIde().bottomPanelActiveView === 'problems',
      onReveal: (path, line, column) => handleSearchResultOpen(path, line, column),
    }) || null;
    const runScripts = resolveModule('rendererIdeRunScripts', './renderer-ide-run-scripts').createIdeRunScripts?.({
      getDom, escapeHtml, editorHost, getWorkspaceFsApi, getWorkspaceTerminalApi, appendClientLog, showToastMessage,
      isActivePanel: () => getIde().bottomPanelOpen === true && getIde().bottomPanelActiveView === 'run',
      isDiffTabId: (p) => ideStateUtils.isDiffTabId?.(p) === true || ideStateUtils.isPreviewTabId?.(p) === true,
      openRunPanel: () => bottomPanel?.open('run'), onRunStateChange: () => statusBar?.render(),
    }) || null;
    const testRunnerWiring = resolveModule('rendererIdeTestRunnerWiring', './renderer-ide-test-runner-wiring').createIdeTestRunnerWiring?.({ windowRef, actionButton, getMountEl: () => getDom().ideBottomPanelContent, isActiveView: () => getIde().bottomPanelOpen === true && getIde().bottomPanelActiveView === 'test-runner', showShellErrorToast }) || null;
    // Collapsible bottom panel (Terminal/Problems/Run).
    const bottomPanel = bottomPanelUtils.createIdeBottomPanel?.({
      getDom, getIde: () => getIde(), escapeHtml,
      requestRender: () => renderIde(), schedulePersist: () => schedulePersist(),
      renderTerminal: () => terminalPanel?.renderTerminalPanel(),
      renderProblems: () => problemsPanel?.renderPanel(), renderRun: () => runScripts?.renderRunPanel(), renderTestRunner: () => testRunnerWiring?.render(), hasPersistentTerminalHost: () => state?.features?.featureFlags?.workspace_pty_terminal === true,
    }) || null;
    // Secondary sidebar: a second static side container opposite the rail. The
    // module owns the chrome (which panels live here + the visibility/width);
    // the single panel instances render into it via their location-aware hosts.
    const secondarySidebar = secondarySidebarUtils.createIdeSecondarySidebar?.({
      getDom, getIde: () => getIde(),
      requestRender: () => renderIde(), schedulePersist: () => schedulePersist(),
      onMovePanel,
      getMaxWidth: () => layout?.maxSecondaryWidth() ?? Infinity,
    }) || null;
    // Workspace Chat Dock (ide_chat_dock): the chat subtree relocated into an
    // outermost #ideShell column. The module owns the chrome + the idempotent
    // host reconcile; the chat render pipeline ALSO drives reconcile() from the
    // top of renderLayout before visibility toggles. New-chat
    // reuses the live #newChatButton handler (the button stays in #chatView).
    const ideChatDock = chatDockUtils.createIdeChatDock?.({
      state, getDom, getIde: () => getIde(),
      requestRender: () => renderIde(), schedulePersist: () => schedulePersist(),
      layoutIdeEditor: () => layoutIdeEditor(), getMaxWidth: () => layout?.maxChatDockWidth() ?? Infinity,
      onNewChat: () => getDom().ideChatDock?.ownerDocument?.getElementById('newChatButton')?.click(),
      onSelectSession: (sessionId) => activateWorkspaceSession(sessionId), showShellErrorToast, appendClientLog, noteProgrammaticWrite: (reason) => callbacks.noteScrollProgrammaticWrite?.(reason),
    }) || null;
    // Layout owns the panel render fan-out + secondary-sidebar + bottom-panel
    // render. Each panel render fn self-targets (getMountEl) and self-gates
    // (isActivePanel), so the layout calls all four unconditionally.
    const layout = layoutUtils.createIdeLayout?.({
      getDom, getIde: () => getIde(),
      renderActivityBar: () => rail?.renderActivityBar(),
      renderExplorer: () => tree?.renderExplorer(),
      renderSearch: () => searchPanel?.renderSearchPanel(),
      renderChanges: () => changesPanel?.renderChangesPanel(),
      renderSourceControl: () => gitFeature?.renderPanel(),
      bottomPanel,
      secondarySidebar,
      chatDock: ideChatDock,
    }) || null;
    async function handleSearchResultOpen(path, line, column) {
      const opened = await openFile(path);
      if (opened) {
        editorHost?.revealPosition(
          ideStateUtils.normalizeIdeRelativePath?.(path) || '', line, column
        );
      }
      return opened === true;
    }

    function renderTabs() {
      const ide = getIde();
      ideMru.record(ide.activeTabPath);
      // Drop nav-history entries + bookmarks for files no longer open (close /
      // rename) so Go Back never reveals a dead path and stale glyphs are gone.
      navBookmarks?.prune((ide.openTabs || []).map((tab) => tab.path));
      tabStrip?.renderTabs({
        openTabs: ide.openTabs,
        activeTabPath: ide.activeTabPath,
        dirtyByPath: ide.dirtyByPath,
        staleByPath: ide.staleByPath || {},
      });
      const dom = getDom();
      if (dom.ideEmptyState) {
        dom.ideEmptyState.classList.toggle('hidden', ide.openTabs.length > 0);
      }
      tree?.syncSelection();
      statusBar?.render();
      diffController?.renderToolbar();
    }

    // Root-bound persistence pump; wrappers preserve the controller call sites.
    const persistence = resolveModule('rendererIdePersistence', './renderer-ide-persistence')
      .createIdePersistence?.({
        getIde: () => getIde(),
        getWorkspaceIdeApi,
        ideStateUtils,
        appendClientLog, showToastMessage: (...args) => showToastMessage(...args),
        onHydrated: (ide) => welcome?.seedRecent((ide.openTabs || []).map((tab) => tab.path)),
        onPreferenceCommitted: () => statusBar?.render(),
        onPreferenceError: (key) => showShellErrorToast('That editor preference could not be saved. Your previous setting is still active.', { title: 'Editor Setting Not Saved', dedupeKey: `ide:preference:${String(key || 'unknown')}` }),
      }) || null;
    function flushPersist() { return persistence?.flushPersist(); }
    function schedulePersist() { persistence?.schedulePersist(); }
    function commitEditorPreference(key, value) {
      if (persistence) return persistence.commitPreference(key, value);
      showShellErrorToast('That editor preference could not be saved. Your previous setting is still active.', { title: 'Editor Setting Not Saved', dedupeKey: `ide:preference:${String(key || 'unknown')}` });
      return Promise.resolve({ updated: false, code: 'workspace_ide_settings_unavailable' });
    }
    function hydratePersistedState() {
      return persistence ? persistence.hydratePersistedState() : Promise.resolve();
    }

    function openChangesPanel() {
      const ide = getIde();
      if (ideStateUtils.getPanelLocation(ide, 'changes') === 'secondary') {
        secondarySidebar?.open('changes');
        return;
      }
      ide.railPanel = 'changes';
      schedulePersist();
      renderIde();
    }

    // QoL chrome (breadcrumb nav + Ctrl+Tab MRU + save-time hygiene) behind one
    // collector so features add no per-module wiring to this at-ceiling controller;
    // built pre-fileLifecycle/keydown so saveHygiene + mruSwitcher thread into them.
    const qol = resolveModule('rendererIdeQolWiring', './renderer-ide-qol-wiring').createIdeQolWiring?.({
      getDom, getIde, editorHost, windowRef, escapeHtml, appendClientLog, getWorkspaceFsApi, getRecentFiles,
      getActiveView: () => state.ui.activeView,
      onOpenFile: (p) => openFile(p), activateTab: (p) => activateTab(p),
      onRevealInExplorer: (p) => revealInExplorer(p, { expandSelf: true }), onOpenSymbolPicker: () => editorHost?.runAction('editor.action.quickOutline'),
      getWorkspaceId: () => String(state.workspace?.activeWorkspaceId || ''), getFeatureFlags: () => state.features?.featureFlags || {}, sendToJenny: (payload) => onSendToJenny(payload), getGitDecoration: (p) => gitFeature?.getDecoration(p), subscribeGitChange: (fn) => gitFeature?.subscribe(fn), ideStateUtils, requestRender: () => renderIde(), activityBus: state.workspaceActivityBus || null, getActiveSessionId: () => String(state.currentSessionId || ''), // Shared bus + active-session accessor for the map controller's presenter
      getWorkspaceRootContext: () => state.workspaceRoot || null, chooseWorkspaceRoot: (...args) => chooseWorkspaceRoot(...args), getChangeLedger: () => getChangeLedger(), openChangeDiff: (change) => openChangeDiff(change), openChangesPanel, showShellErrorToast: (...args) => showShellErrorToast(...args), // Root context is the canonical File Map identity, never 'default'
      schedulePersist: () => schedulePersist(), getFileOperations: () => fileLifecycle?.fileOperations,
    }) || null;

    // The open-tab document lifecycle (open / activate / save / close / reopen +
    // tree delete/rename fan-out) plus the `saving` and `bypassReopenPush` flags
    // live in renderer-ide-file-lifecycle for the file-size ceiling. The
    // thunk-objects mirror the controller surfaces those bodies used to close
    // over, so behavior is unchanged; the controller keeps the thin facade below.
    const fileLifecycle = resolveModule('rendererIdeFileLifecycle', './renderer-ide-file-lifecycle')
      .createIdeFileLifecycle?.({
        getIde: () => getIde(),
        ideStateUtils,
        editorHost,
        getWorkspaceFsApi,
        closedTabs,
        welcome: {
          drop: (path) => welcome?.drop(path),
          noteOpened: (path) => welcome?.noteOpened(path),
          render: () => welcome?.render(),
        },
        chipPicker: { applyDefaults: (path) => chipPicker?.applyDefaults(path) },
        gitFeature: { requestRefresh: () => gitFeature?.requestRefresh() },
        searchPanel: { isReplacing: () => searchPanel?.isReplacing?.() === true },
        saveHygiene: qol?.saveHygiene || null,
        renderTabs: () => renderTabs(),
        // Stage-surface hooks: document activations pull the stage back to the
        // editor cluster; a legacy map:// open routes to the
        // File Map stage instead of creating the old synthetic tab.
        onEditorDocumentActivated: () => qol?.stageSurface?.noteEditorActivation(),
        activateMapStage: () => qol?.mapController?.openFileMap(),
        schedulePersist: () => schedulePersist(), requestRender: () => renderIde(),
        showShellErrorToast: (...args) => showShellErrorToast(...args),
        showToastMessage: (...args) => showToastMessage(...args),
        toErrorMessage: (...args) => toErrorMessage(...args), appendClientLog,
      }) || null;

    // Thin facade: the rest of the controller keeps calling these by name; each
    // delegates to the lifecycle module (degrading to a no-op if it is absent).
    function openFile(path, options) {
      return fileLifecycle ? fileLifecycle.openFile(path, options) : Promise.resolve(false);
    }
    function activateTab(path) {
      autoSave?.cancel();
      fileLifecycle?.activateTab(path);
    }
    function closeTab(path) {
      autoSave?.cancel();
      fileLifecycle?.closeTab(path);
    }
    function reopenClosedTab() {
      return fileLifecycle ? fileLifecycle.reopenClosedTab() : Promise.resolve();
    }
    function saveFile(targetPath) {
      return fileLifecycle ? fileLifecycle.saveFile(targetPath) : Promise.resolve(false);
    }
    function saveActiveFile(options) {
      return fileLifecycle ? fileLifecycle.saveActiveFile(options) : Promise.resolve(false);
    }

    // External-change watcher (workspaceFs.onChange) lives in a sibling module
    // for the file-size ceiling. The clean-delete close routes back through
    // closeTab WITHOUT recording for reopen (the file is gone) and purges the
    // reopen stack.
    const watchController = watchControllerUtils.createIdeWatchController?.({
      getIde: () => getIde(),
      getWorkspaceFsApi,
      editorHost, fileOperations: fileLifecycle?.fileOperations,
      ideStateUtils,
      showToastMessage: (...args) => showToastMessage(...args),
      renderTabs: () => renderTabs(), appendClientLog,
      onTreeExternalChanges: (changes, opts) => { tree?.handleExternalChanges(changes, opts); quickOpen?.handleExternalChanges(changes, opts); },
      refreshChangesPanelIfOpen: () => {
        if (ideStateUtils.isPanelActive(getIde(), 'changes')) {
          changesPanel?.renderChangesPanel();
        }
      },
      onExternalDelete: (path) => fileLifecycle?.closeExternalDelete(path),
      onExternalPreviewChange: (change) => { previewController?.handleExternalChange?.(change); qol?.previewStage?.handleExternalChange?.(change); },
    }) || null;
    // Shell-owned transaction facade refreshes this controller only after commit.
    const chooseWorkspaceRoot = welcomeUtils.createChooseWorkspaceRoot?.({
      getWorkspaceRootApi,
      showShellErrorToast,
      toErrorMessage,
      appendClientLog,
    }) || (() => Promise.resolve(false));

    // Shared extras for file rows/tabs: Open Preview (md/mermaid) + path/OS
    // utilities + send (the Send-to-Jenny items live in selection-intents).
    function buildFileContextMenuItems(path) {
      return [
        { label: 'Open in New Tab', action: () => openFile(path) },
        ...(previewController?.buildPreviewMenuItems(path) || []),
        ...buildPathUtilityMenuItems(path, 'file'),
        ...(selectionIntents?.buildSendToJennyMenuItems(path) || []),
      ];
    }

    // View-scoped shortcuts (capture phase on #ideView). Ctrl+W is reserved by
    // Electron's default-menu close-window accelerator, which fires before the
    // renderer - tab close rides Ctrl+F4 instead. The handler body lives in
    // renderer-ide-commands (file-size ceiling); the controller keeps the
    // addEventListener/removeEventListener wiring below.
    const handleViewKeydown = commandsUtils.createViewKeydownHandler?.({
      state,
      saveActiveFile,
      tabsController,
      quickOpen,
      bottomPanel,
      chatDock: ideChatDock, isChatDockEnabled: () => state?.features?.featureFlags?.ide_chat_dock === true,
      mruSwitcher: qol?.mruSwitcher || null,
      reopenClosedTab,
      workspaceSymbolPicker: () => symbolNav?.openPicker(),
      navBack: () => navBookmarks?.back(),
      navForward: () => navBookmarks?.forward(),
      ...(navBookmarks?.bookmarkActions),
      ideCommands,
      keyboardUtils, getStageSurface: () => qol?.stageSurface?.getEffectiveSurface?.() || 'editor', exitStageSurface: () => qol?.stageSurface?.activate('editor'),
      windowRef,
    }) || (() => {});

    function bindEvents() {
      if (bound || disposed) {
        return;
      }
      const dom = getDom();
      if (!dom.ideView) {
        return;
      }
      bound = true;
      tabsController?.bindEvents();
      welcome?.bindEvents();
      // Capture-phase so the save shortcut wins even when focus sits in the
      // tree/rail; Monaco's own Ctrl+S command covers editor focus.
      dom.ideView.addEventListener('keydown', handleViewKeydown, true);
      explorer?.bindAll(); rail?.bindEvents();
      searchPanel?.bindEvents(); changesPanel?.bindEvents();
      diffController?.bindEvents(); terminalPanel?.bindEvents();
      statusBar?.bindEvents(); gitFeature?.bindEvents();
      problemsPanel?.bindEvents();
      bottomPanel?.bindEvents(); runScripts?.bindEvents(); testRunnerWiring?.bindEvents();
      // Secondary-sidebar chrome only; the panels are single instances bound
      // above (each binds BOTH hosts, so a moved panel stays live).
      secondarySidebar?.bindEvents();
      ideChatDock?.bindEvents();
      symbolNav?.bindEvents(); qol?.bindAll();
      chipPicker?.initHandlers(); fimPicker?.initHandlers();
      // Flush the pending debounced persist before a hard window close (mirrors
      // the dashboard scratchpad beforeunload flush) so edits are not lost.
      const flushOnUnload = () => { persistence?.flushIfPending(); };
      windowRef.addEventListener?.('beforeunload', flushOnUnload);
      // Debounced viewport-clamp re-render (resize streams events).
      let resizeTimer = null;
      const onWindowResize = () => {
        if (resizeTimer) { clearTimeout(resizeTimer); }
        resizeTimer = setTimeout(() => { resizeTimer = null; renderIde(); }, 120);
      };
      windowRef.addEventListener?.('resize', onWindowResize);
      registerCleanup(function disposeIdeBindings() {
        disposed = true; lifecycleEpoch += 1;
        bound = false;
        welcome?.dispose();
        confirmDialog?.dispose();
        ideCommands?.disposeHelp();
        chipPicker?.dispose(); fimPicker?.dispose();
        dom.ideView.removeEventListener('keydown', handleViewKeydown, true);
        // Flush any pending persist before teardown (clears the timer internally).
        persistence?.flushIfPending();
        persistence?.dispose();
        windowRef.removeEventListener?.('beforeunload', flushOnUnload);
        windowRef.removeEventListener?.('resize', onWindowResize);
        if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
        watchController?.stop(); fileLifecycle?.dispose();
        debugInspector?.dispose(); previewController?.dispose();
        quickOpen?.dispose(); branchSwitcher?.dispose();
        tabsController?.dispose(); statusBar?.dispose();
        gitFeature?.dispose(); problemsPanel?.dispose();
        bottomPanel?.dispose(); runScripts?.dispose(); testRunnerWiring?.dispose();
        secondarySidebar?.dispose();
        ideChatDock?.dispose();
        terminalPanel?.dispose();
        changesPanel?.dispose();
        diffController?.dispose();
        searchPanel?.dispose();
        rail?.dispose();
        explorer?.disposeAll();
        themeBridge?.dispose();
        inlineSuggest?.dispose();
        autoSave?.dispose();
        gutterDecorations?.dispose();
        navBookmarks?.dispose();
        symbolNav?.dispose(); qol?.disposeAll();
        editorHost?.dispose();
      });
    }

    // Layout (rail + bottom panel) lives in renderer-ide-layout.js; renderTabs
    // stays here (it touches the tree / tab strip / statusbar).
    function renderIde() {
      layout?.render();
      renderTabs();
      // Single visibility owner: the stage-surface controller shows/hides the
      // map/exploded/preview stage hosts (they can never stack).
      qol?.stageSurface?.sync();
    }

    async function activateIde() {
      if (disposed) return;
      const epoch = lifecycleEpoch;
      bindEvents();
      if (!activated) {
        activated = true;
        appendClientLog('INFO', 'ide.view_first_activation', {});
        await hydratePersistedState();
        if (!lifecycleCurrent(epoch)) return;
        await welcome?.render();
        if (!lifecycleCurrent(epoch)) return;
        renderIde();
        watchController?.start();
        const ide = getIde();
        if (ide.activeTabPath) {
          // Hydrate-time restore must not reset a persisted preview/file_map
          // surface — suppress the stage machine's activation reset once.
          qol?.stageSurface?.suppressNextActivationReset();
          await openFile(ide.activeTabPath);
          if (!lifecycleCurrent(epoch)) return;
        }
        return;
      }
      renderIde();
      // Re-apply editor prefs so a change made in the Settings "Editor" section
      // (which mutates the shared ide slice) takes effect on return to the IDE.
      editorPrefsUtils.applyEditorPrefs?.(getIde(), editorHost, chipPicker);
      // Re-arm after a failed start (e.g. the root was configured since).
      watchController?.start();
    }

    function layoutIdeEditor() { editorHost?.layout(); }

    async function handleWorkspaceRootCommitted({ context } = {}) { if (disposed) return;
      const epoch = ++lifecycleEpoch;
      fileLifecycle?.resetForRoot(context); ideStateUtils.resetIdeRootState?.(getIde()); tree?.resetForRoot?.(); searchPanel?.resetForRoot?.(); diffController?.resetForRoot?.(); quickOpen?.invalidate(); ideMru?.clear?.(); navBookmarks?.resetForRoot?.(); tabsController?.resetForRoot?.(); testRunnerWiring?.resetForRoot?.(); gitFeature?.resetForRoot?.(); // Git presentation must not survive a root switch.
      // The decoupled composer singletons (@-mention autocomplete, active-file consent) hear root commits only via this window event — they have no controller wire by design.
      try { windowRef.dispatchEvent?.(new windowRef.CustomEvent('ide:workspace-root-committed', { detail: { context } })); } catch (_error) { /* stub windows without CustomEvent */ }
      await persistence?.hydrateForContext(context); if (!lifecycleCurrent(epoch)) return; watchController?.start(); qol?.handleWorkspaceRootCommitted?.({ context });
      await Promise.allSettled([Promise.resolve(welcome?.render({ hasRoot: Boolean(context?.rootPath) })), Promise.resolve(tree?.refreshRoot())]);
      if (!lifecycleCurrent(epoch)) return;
      renderIde(); if (getIde().activeTabPath) await openFile(getIde().activeTabPath);
    }

    return {
      renderIde,
      activateIde,
      layoutIdeEditor,
      getCloseOrchestrator: () => closeOrchestrator,
      getConfirmDialog: () => confirmDialog,
      handleWorkspaceRootCommitted,
      handleWorkspaceRootSettled: ({ context, committed = false } = {}) => persistence?.settleContext(context, { committed }),
      prepareWorkspaceRootTransition: ({ context } = {}) => persistence?.prepareTransition(context),
      // Chat-dock surface for the render pipeline's renderLayout reconcile.
      chatDock: ideChatDock,
      openFile,
      openFileAtLine: (path, line, column) => handleSearchResultOpen(path, line, column), // Chat timeline path chips and cite links use the same open-then-revealPosition seam as search; resolves true only when the file actually opened.
      saveActiveFile,
      // Surfaced for the command palette + the global "?" router (shell bindings).
      // both halves stay empty off the IDE view so other surfaces stay uncluttered.
      getIdeCommandItems: () => {
        if (state.ui?.activeView !== 'ide') {
          return [];
        }
        return [
          ...(ideCommands ? ideCommands.getCommandItems() : []),
          ...(branchSwitcher?.getCommandItems?.() || []),
        ];
      },
      openHelpOverlay: () => { ideCommands?.openHelpOverlay(); },
      // Transcript diff rows resolve a ledger changeId to its record and open the diff://change/ review tab.
      openLedgerChangeById: (changeId) => { const id = String(changeId || '').trim(); const change = id ? (getChangeLedger().changes || []).find((entry) => String(entry?.changeId || '') === id) : null; return change ? openChangeDiff(change) : false; },
    };
  }

  return {
    createIdeController,
  };
});
