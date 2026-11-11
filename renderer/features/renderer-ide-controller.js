/* Workspace IDE page controller: owns lazy activation, editor flows, and composed panels. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeController = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}
  // The sibling-module table and the extracted wiring + lifecycle (the manifest loads them before this file).
  const { resolveControllerModules } = globalRef.rendererIdeControllerModules || require('./renderer-ide-controller-modules');

  function createIdeController(deps) {
    const { state } = deps || {};
    const getDom = typeof deps?.getDom === 'function' ? deps.getDom : () => ({});
    const registerCleanup = typeof deps?.registerCleanup === 'function' ? deps.registerCleanup : noop;
    const workspaceRootService = deps?.workspaceRootService || null;
    const callbacks = deps?.callbacks || {};
    const {
      escapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml,
      appendClientLog = noop,
      showToastMessage = noop,
      showShellErrorToast = noop,
      toErrorMessage = (error, fallback) => String(error?.message || error || fallback || ''),
      // Same canonical turn view-models the chat code-review rail reads;
      // threaded in from the lifecycle composition via the service registry.
      getTurnViewModelsForActiveSession = () => [], getSessionMessages = () => [], getChangesUndoController = () => null,
      onSendToJenny = noop, activateWorkspaceSession = noop, getProjectSwitcher = null, peekProjectSwitcher = null,
    } = callbacks;

    const windowRef = globalRef.window || globalRef;
    const mods = resolveControllerModules();
    const {
      ideStateUtils, tabsUtils, wiringUtils, workbenchWiringUtils, stageSwitchUtils, searchPanelUtils, ledgerUtils, quickOpenUtils,
      previewControllerUtils, diffControllerUtils, themeBridgeUtils, actionButton, pathMenuUtils, welcomeUtils, ideShortcutsUtils,
      selectionIntentsUtils, closedTabsUtils, confirmDialogUtils, closeOrchestratorUtils, helpOverlayUtils, watchControllerUtils, chipPickerUtils,
      editorPrefsUtils, popoverUtils, gitFeatureUtils, problemsPanelUtils, debugInspectorUtils, layoutModel, mruUtils, layoutUtils, commandsUtils,
      navBookmarksUtils, autoSaveUtils, branchSwitcherUtils, gutterDecorationsUtils, symbolNavUtils, tabRestoreUtils, terminalSetUtils,
      ptyTerminalPanelUtils, editorGroupsWiringUtils, runScriptsUtils, activityWiringUtils, persistenceUtils, qolWiringUtils, fileLifecycleUtils,
      viewLifecycleUtils, controllerWiringUtils,
    } = mods;
    const wiring = controllerWiringUtils;
    const isDiffTab = (path) => ideStateUtils.isDiffTabId?.(path) === true;
    const isPreviewTab = (path) => ideStateUtils.isPreviewTabId?.(path) === true;
    const isReviewTab = (path) => isDiffTab(path) || isPreviewTab(path);
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
    // Runtime file-tab MRU for the Ctrl+E jump list (extracted sibling).
    const ideMru = mruUtils.createIdeMru?.({
      isDiffTabId: isDiffTab, isPreviewTabId: isPreviewTab,
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
    function getWorkspacePtyApi() {
      return windowRef.jennyShell?.workspacePty || null;
    }

    // Lazy getters over this closure for the extracted wiring + lifecycle modules: a name is read when
    // a thunk runs, so a component built later in this function resolves exactly as it did inline.
    const parts = {
      get activateTab() { return activateTab; }, get activateWorkspaceSession() { return activateWorkspaceSession; },
      get activityView() { return activityView; }, get appendClientLog() { return appendClientLog; }, get autoSave() { return autoSave; },
      get bottomPanel() { return bottomPanel; }, get branchSwitcher() { return branchSwitcher; },
      get buildFileContextMenuItems() { return buildFileContextMenuItems; }, get callbacks() { return callbacks; },
      get chipPicker() { return chipPicker; }, get chooseWorkspaceRoot() { return chooseWorkspaceRoot; },
      get closeOrchestrator() { return closeOrchestrator; }, get commitEditorPreference() { return commitEditorPreference; },
      get confirmDialog() { return confirmDialog; }, get debugInspector() { return debugInspector; },
      get diffController() { return diffController; }, get editorGroups() { return editorGroups; }, get editorHost() { return editorHost; },
      get escapeHtml() { return escapeHtml; }, get explorer() { return explorer; }, get fileLifecycle() { return fileLifecycle; },
      get focusIdeEditor() { return focusIdeEditor; }, get getChangesUndoController() { return getChangesUndoController; },
      get getDom() { return getDom; }, get getIde() { return getIde; }, get getSessionMessages() { return getSessionMessages; },
      get getTurnViewModelsForActiveSession() { return getTurnViewModelsForActiveSession; }, get gitFeature() { return gitFeature; },
      get gutterDecorations() { return gutterDecorations; }, get handleViewKeydown() { return handleViewKeydown; },
      get hydratePersistedState() { return hydratePersistedState; }, get ideChatDock() { return ideChatDock; },
      get ideCommands() { return ideCommands; }, get ideMru() { return ideMru; }, get ideStateUtils() { return ideStateUtils; },
      get isDiffTab() { return isDiffTab; }, get isPreviewTab() { return isPreviewTab; }, get isReviewTab() { return isReviewTab; },
      get layout() { return layout; }, get layoutIdeEditor() { return layoutIdeEditor; }, get mods() { return mods; },
      get navBookmarks() { return navBookmarks; }, get newTerminalAction() { return newTerminalAction; },
      get openChangeDiff() { return openChangeDiff; }, get openDiffFrom() { return openDiffFrom; },
      get openRestoredTab() { return openRestoredTab; }, get openUnsavedCompare() { return openUnsavedCompare; },
      get panelDeps() { return panelDeps; }, get persistence() { return persistence; }, get problemCount() { return problemCount; },
      get problemsPanel() { return problemsPanel; }, get qol() { return qol; }, get quickOpen() { return quickOpen; },
      get renderIde() { return renderIde; }, get renderTabs() { return renderTabs; }, get reopenClosedTab() { return reopenClosedTab; },
      get requestCloseTab() { return requestCloseTab; }, get revealInExplorer() { return revealInExplorer; },
      get runScripts() { return runScripts; }, get saveActiveFile() { return saveActiveFile; }, get saveFile() { return saveFile; },
      get schedulePersist() { return schedulePersist; }, get searchPanel() { return searchPanel; },
      get selectionIntents() { return selectionIntents; }, get showPanel() { return showPanel; },
      get showShellErrorToast() { return showShellErrorToast; }, get showToastMessage() { return showToastMessage; },
      get stageSwitch() { return stageSwitch; }, get state() { return state; }, get statusBar() { return statusBar; },
      get symbolNav() { return symbolNav; }, get tabRestore() { return tabRestore; }, get tabsController() { return tabsController; },
      get terminals() { return terminals; }, get testOutputPanel() { return testOutputPanel; }, get testRunnerWiring() { return testRunnerWiring; },
      get themeBridge() { return themeBridge; }, get toErrorMessage() { return toErrorMessage; }, get tree() { return tree; },
      get watchController() { return watchController; }, get welcome() { return welcome; }, get windowRef() { return windowRef; },
      get wordWrap() { return wordWrap; }, get workbenchWiring() { return workbenchWiring; }, get workspaceChats() { return workspaceChats; },
    };
    const lifecycle = viewLifecycleUtils.createIdeViewLifecycle({
      state, getDom, windowRef, registerCleanup, appendClientLog, getIde, ideStateUtils, editorPrefsUtils, commandsUtils, parts,
    });
    const { renderIde, activateIde, handleWorkspaceRootCommitted } = lifecycle;

    const themeBridge = themeBridgeUtils.createIdeThemeBridge?.({
      documentRef: windowRef.document || null, appendClientLog,
    }) || null;
    const editorHost = wiring.createEditorHost(parts);
    // Git gutter change-bars: a green/blue/red strip vs HEAD on the active editor
    // (self-contained module - owns its git client, debounce, and lifecycle).
    const gutterDecorations = gutterDecorationsUtils.createIdeGutterDecorations?.({ editorHost, windowRef, appendClientLog, getDom, getIde, showToastMessage, refreshGit: () => gitFeature?.refreshNow() }) || null; // + row 82 G2 peek and blame
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
    const symbolNav = symbolNavUtils.createIdeSymbolNav?.({
        editorHost, getDom, windowRef, escapeHtml, appendClientLog,
        onOpenFile: (path) => openFile(path),
      }) || null;
    // Auto-save (default-OFF; the per-user autoSaveMode pref picks delay/focus/window).
    // Saves the edited path (a secondary group's file too) through saveFile, so the
    // mtime-conflict + stale guards hold; the module skips non-file/stale tabs and
    // re-validates the path when it fires (debounce + gating live in the module).
    const autoSave = autoSaveUtils.createIdeAutoSave?.({
      editorHost,
      getIde: () => getIde(),
      saveFile: (path) => (fileLifecycle ? fileLifecycle.saveFile(path, { unattended: true }) : false),
      isSaving: () => fileLifecycle?.isSaving() === true,
      getMode: () => getIde().autoSaveMode,
    }) || null;
    // Word-wrap toggle (Alt+Z action + statusbar) lives in editor-prefs for the cap.
    const wordWrap = editorPrefsUtils.createWordWrapController?.({
      getIde: () => getIde(),
      editorHost,
      commitPreference: (key, value) => commitEditorPreference(key, value),
      requestStatusRender: () => statusBar?.render(),
    }) || null;
    const tabStrip = tabsUtils.createIdeTabStrip?.({ getDom, escapeHtml, getGitDecoration: (path) => gitFeature?.getDecoration(path) || null }) || null;
    const tabRestore = tabRestoreUtils.createIdeTabRestore?.({ getDom, escapeHtml, editorHost, getWorkspaceFsApi, registerCleanup }) || null;
    // Workbench (row 40 W3): the layout tree of splits and stacks (built in renderer-ide-controller-wiring.js).
    const workbenchWiring = wiring.createWorkbenchWiring(parts);
    function problemCount() {
      return problemsPanel?.getBadgeCount?.() || 0;
    }
    // Palette New Terminal and Ctrl+Shift+`: the + path, offered only while the + is.
    const newTerminalAction = () => (terminals?.canAdd() ? () => terminals.newTerminal({ start: true, near: workbenchWiring?.groupBinding?.boundTerminal() || '' }) : undefined); // W7c: beside the focused group's terminal
    const panelDeps = (id) => workbenchWiring?.viewDeps(id) || {};
    const bottomPanel = workbenchWiring?.bottomPanel || null;
    const showPanel = (id, options) => workbenchWiring?.showPanel(id, options) === true;
    const explorer = wiringUtils.createIdeExplorerWiring?.({
      getDom, escapeHtml, getIde, getWorkspaceFsApi, openFile,
      buildFileContextMenuItems, buildPathUtilityMenuItems, schedulePersist,
      getWorkspaceRootApi, showShellErrorToast, appendClientLog, panelDeps,
      showToastMessage,
      getChooseWorkspaceRoot: () => chooseWorkspaceRoot, getProjectSwitcher, peekProjectSwitcher,
      getFileLifecycle: () => fileLifecycle, getSearchPanel: () => searchPanel,
      getCloseOrchestrator: () => closeOrchestrator, getConfirmDialog: () => confirmDialog,
      getGitFeature: () => gitFeature, getTerminalPanel: () => terminals, getBottomPanel: () => bottomPanel,
      getFeatureFlags: () => state?.features?.featureFlags, getEditorHost: () => editorHost, getEditorGroups: () => editorGroups, getProblemsPanel: () => problemsPanel, getRunScripts: () => runScripts,
    }) || null;
    const tree = explorer?.tree || null;
    // Editor toolbar at the end of the tab row: Preview / File map, Split, More (qol is built later; thunks).
    const stageSwitch = stageSwitchUtils.createIdeStageSwitch?.({
      getMountEl: () => getDom().ideStageSwitch, actionButton, onSplit: () => editorGroups?.splitActive('right'), onMore: (el) => tabsController?.showAllTabsMenu(el),
      onToggle: (surface) => qol?.stageSurface?.toggle(surface),
      getActiveSurface: () => qol?.stageSurface?.getEffectiveSurface() || 'editor',
    }) || null;
    // The panel owns its find-AND-replace controller internally (keeps this
    // controller under the line cap); it just needs editor-host + save context.
    const searchDeps = {
      getDom,
      escapeHtml,
      getIde: () => getIde(),
      getWorkspaceFsApi,
      editorHost, getFileOperations: () => fileLifecycle?.fileOperations, schedulePersist: () => schedulePersist(), flushPersist: () => flushPersist(),
      onOpenResult: handleSearchResultOpen, appendClientLog, showShellErrorToast,
      renderTabs: () => renderTabs(),
      isSaving: () => fileLifecycle?.isSaving() === true,
      // Find-in-Folder reveals Search wherever it lives.
      onActivateSearch: () => showPanel('search'),
    };
    const searchPanel = searchPanelUtils.createIdeSearchPanel?.({ ...searchDeps, ...panelDeps('search') }) || null;

    // Up to four terminals, one PTY panel per terminal view; the layout says which exist.
    const terminals = terminalSetUtils.createIdeTerminalSet?.({
      ptyTerminalPanelUtils, model: layoutModel || {}, viewDeps: panelDeps,
      baseDeps: {
        getDom, getIde: () => getIde(), appendClientLog, getWorkspacePtyApi, getWorkspaceRootPath: () => String(state.workspaceRoot?.path || ''),
        showError: (message, meta) => showShellErrorToast(message, meta), toErrorMessage,
      },
      actionIcons: workbenchWiringUtils.ACTION_ICONS || {}, commitPreference: (key, value) => commitEditorPreference(key, value), requestRender: () => renderIde(),
      listTerminalViews: () => workbenchWiring?.listViews() || [],
      // near: the requested neighbour; else the terminal whose + was pressed last, while it shows.
      addTerminalView: (id, near, last) => workbenchWiring?.addView(id, near || (last && workbenchWiring.isVisible(last) ? last : 'terminal')),
      removeTerminalView: (id) => workbenchWiring?.removeView(id),
      revealView: (id, options) => workbenchWiring?.showPanel(id, options),
    }) || null;

    const statusBar = wiring.createStatusBar(parts);

    const tabsController = wiring.createTabsController(parts);

    // Secondary editor groups (row 40 W5): their views, layout stacks and split/move/close intents.
    const editorGroups = editorGroupsWiringUtils.createIdeEditorGroupsWiring?.({
      getIde: () => getIde(), getDom, editorHost, escapeHtml, getWorkbenchWiring: () => workbenchWiring, getCloseOrchestrator: () => closeOrchestrator,
      loadDocument: (path) => fileLifecycle?.openFile(path, { background: true }) || Promise.resolve(false), activatePrimary: (path) => activateTab(path),
      requestCloseTab: (path) => requestCloseTab(path), saveFile: (path) => saveFile(path), revealInExplorer: (path) => revealInExplorer(path),
      onActivated: (path) => ideMru.record(path), renderReviewBar: (el, path) => diffController?.renderToolbarFor(el, path),
      getBoundGroups: () => workbenchWiring?.groupBinding?.boundGroups() || [], getBoundText: (id) => workbenchWiring?.groupBinding?.boundText(id) || '', unbindGroup: (id) => workbenchWiring?.groupBinding?.unbindGroup(id),
      schedulePersist: () => schedulePersist(), requestRender: () => renderIde(), getGitDecoration: (path) => gitFeature?.getDecoration(path) || null, reopenClosedTab: () => reopenClosedTab(),
    }) || null;

    const previewController = previewControllerUtils.createIdePreviewController?.({
      callbacks: {
        // Open Preview routes to the unified Preview stage surface.
        openPreviewStage: (path) => qol?.previewStage?.open(path),
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
      buildShortcutsHtml: () => ideShortcutsUtils.buildIdeShortcutsHtml?.(ideCommands?.registry) || '',
      onOpenFile: (path) => { openFile(path); },
      onChooseFolder: () => chooseWorkspaceRoot(),
      // Projects v2: "Your projects" rows + "Switch project…" share the lazy switcher.
      getProjects: () => peekProjectSwitcher?.()?.getProjects?.() || [], getProjectSwitcher,
    }) || null;

    // Editor selection actions (Send to Jenny + Explain/Fix/Refactor/Tests
    // intents). Prefill-only; registered against Monaco in onMonacoReady.
    const selectionIntents = selectionIntentsUtils.createIdeSelectionIntents?.({
      editorHost,
      isDiffTabId: isDiffTab,
      onSendToJenny, onNotice: (message) => showToastMessage(message, { dedupeKey: 'ide-selection-intents' }),
    }) || null;

    // "Debug this file (Node Inspector)" launches via the
    // terminal + scrape the ws:// banner; all logic lives in the sibling.
    const debugInspector = debugInspectorUtils.createIdeDebugInspector?.({
      editorHost, getWorkspacePtyApi, getWorkspaceRootApi, appendClientLog, showToastMessage, saveFile: (path) => saveForLaunch(path),
      openTerminalPanel: () => bottomPanel?.open('terminal'),
      sendTerminalCommand: (builder) => terminals?.sendCommand?.(builder) ?? false,
      // Its own terminal (never the user's shell) when the terminal set is up.
      openTaskTerminal: terminals ? (near) => terminals.openTaskTerminal(near) : undefined, captureTaskTarget: () => workbenchWiring?.groupBinding?.boundTerminal(),
      isDiffTabId: isDiffTab,
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
      isDiffTabId: isDiffTab, isPreviewTabId: isPreviewTab,
      forceClose: (path) => closeTab(path),
      saveFile: (path) => saveFile(path),
      getDocumentRevision: (path) => { const snapshot = fileLifecycle?.fileOperations?.captureReload?.(path, { allowDirty: true }); return snapshot ? `${snapshot.documentId}:${snapshot.editVersion}` : null; },
      confirmClose: (payload) => (confirmDialog
        ? confirmDialog.confirmClose(payload)
        : Promise.resolve('cancel')),
      onCloseRefused: () => showShellErrorToast(jt('ide.tabs.actionFailed', 'The tab action failed.'), { dedupeKey: 'ide:tab:close-refused' }), onExitDiscard: (paths) => qol?.hotExit?.discardBackups?.(paths),
    }) || null;

    // The IDE command registry (row 82) with its palette-only rows (Format / Go to
    // Symbol / Find References / File Map / layout) + the "?" shortcuts overlay. The
    // chorded commands register from the keydown handler below; getCommandItems is
    // empty off the IDE view; the overlay is generated from the registry's bindings.
    const ideCommands = commandsUtils.createIdeCommands?.({
      document: windowRef.document || null,
      getActiveView: () => state.ui?.activeView || '', getIde, isRepo: () => gitFeature?.isRepo?.() === true,
      editorHost, appendClientLog,
      toggleMinimap: () => editorPrefsUtils.toggleMinimap?.(getIde(), editorHost, commitEditorPreference, () => statusBar?.render()),
      layoutActions: workbenchWiring ? {
        resetLayout: () => workbenchWiring.resetLayout(),
        // Editor groups need Monaco: the row shows once it has loaded (a getter, read per palette open).
        get focusNextGroup() { return editorHost?.getMonaco?.() ? () => editorGroups?.focusNextGroup() : undefined; },
        // Keyboard move (W4): the menu for the panel focus was last in, anchored on its tab.
        moveView: () => { const wb = workbenchWiring.workbench; const viewId = wb?.getFocusedView?.(); return viewId ? wb.openMoveMenu(viewId) : false; },
      } : null,
      openFileMap: () => qol?.mapController?.openFileMap(), revealInMap: () => qol?.revealActiveFileInMap?.(), showBlastRadius: () => qol?.blastActiveFileInMap?.(), toggleExplodedView: () => qol?.explodeController?.toggleActiveTab(), openPreviewSurface: () => qol?.stageSurface?.activate('preview'),
      helpOverlayFactory: helpOverlayUtils.createHelpOverlay,
      buildShortcutsHtml: (registry) => ideShortcutsUtils.buildIdeShortcutsHtml?.(registry) || '',
    }) || null;

    // Single-tab closes (×, middle-click, Ctrl+F4, context Close) route through
    // the orchestrator; degrades to a direct force-close if it is unavailable.
    function requestCloseTab(path) {
      if (closeOrchestrator) return closeOrchestrator.requestClose(path);
      closeTab(path);
      return undefined;
    }

    // Interactive tab-size / EOL statusbar chips update the durable defaults.
    const chipPicker = chipPickerUtils.createIdeChipPicker?.({
      getDom,
      editorHost,
      getActivePath: () => editorHost?.getFocusedPath?.() || '',
      escapeHtml,
      actionButton: typeof actionButton === 'function' ? actionButton : null,
      popover: typeof popoverUtils === 'function' ? popoverUtils : popoverUtils?.default,
      onAfterChange: (change) => { void editorPrefsUtils.persistChipChange?.(getIde(), change, commitEditorPreference); },
      requestStatusRender: () => statusBar?.render(), getIndentDefaults: () => ({ insertSpaces: getIde().insertSpaces !== false, tabSize: Number(getIde().tabSize) || 2 }), // row 82 per-tab language/indent picks
    }) || null;

    // Breadcrumb clicks / "Reveal in Explorer": reveal Files wherever it lives,
    // then route tree focus (which scrolls) to the path.
    function revealInExplorer(path, options) {
      showPanel('explorer');
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
      showDiffTab,
      getIde: () => getIde(),
      getDom,
      getWorkspaceFsApi,
      editorHost, getFileOperations: () => fileLifecycle?.fileOperations,
      getWorkspaceId: () => String(state.workspaceRoot?.rootId || ''),
      confirmDialog,
      escapeHtml,
      callbacks: {
        renderTabs: () => renderTabs(),
        showShellErrorToast, appendClientLog,
      },
    }) || null;

    function showDiffTab(id) { return editorGroups?.activateInGroup(id) || editorHost.activateDocument(id); }
    // W7c: a diff opened from a bound chat (origin.pane) lands in that chat's group.
    function openDiffFrom(origin, open, id) {
      return workbenchWiring?.groupBinding ? workbenchWiring.groupBinding.openDiffFrom(origin?.pane, open, id) : open();
    }
    function openChangeDiff(change, origin) {
      return openDiffFrom(origin, () => (diffController ? diffController.openChangeDiff(change) : false), diffController?.changeDiffId(change));
    }

    function openUnsavedCompare(path) { return diffController ? diffController.openUnsavedCompare(path) : false; }

    // Git client + status store + Source Control panel; the tree + statusbar read its getters.
    const gitFeature = gitFeatureUtils.createIdeGitFeature?.({
      showDiffTab, openFile,
      windowRef, getDom, getIde, editorHost, getWorkspaceFsApi, getFileLifecycle: () => fileLifecycle, onDeleteUntracked: (path) => tree?.deleteEntry(path, 'file'), confirmDialog, escapeHtml,
      appendClientLog, showShellErrorToast, showToastMessage, renderTabs, schedulePersist, requestRender: renderIde, showPanel,
      onChange: () => { tree?.applyGitDecorations(); statusBar?.render(); gutterDecorations?.refreshActive(); },
      // F8 (row 40 W6): rows Jenny changed carry a marker that opens her turn in Changes.
      getJennyChange: (path) => workspaceChats?.jennyChangeFor(path) || null,
      onOpenJennyChange: ({ turnId, fileKey }) => ideChatDock?.openChanges?.({ turnId, fileKey }),
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
        getUnsavedCount: () => gitFeature?.getUnsavedCount?.() || 0,
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
      getDom, getIde, escapeHtml, editorHost, requestRender: renderIde, getTaskProblems: () => runScripts?.getTaskProblems?.() || null, // R2: the Tasks source
      ...panelDeps('problems'),
      onReveal: (path, line, column) => handleSearchResultOpen(path, line, column),
    }) || null;
    const runScripts = runScriptsUtils.createIdeRunScripts?.({
      getDom, escapeHtml, editorHost, getWorkspaceFsApi, appendClientLog, showToastMessage, saveFile: (path) => saveForLaunch(path),
      ...panelDeps('run'),
      isDiffTabId: isReviewTab,
      openRunPanel: (near) => workbenchWiring?.groupBinding?.revealTask('run', near) || bottomPanel?.open('run'), getRunTarget: () => workbenchWiring?.groupBinding?.boundTerminal() || '', onAskJenny: onSendToJenny,
      // The statusbar, and the Run tab's "Run: <script>" label (workbench chrome only).
      onRunStateChange: () => { statusBar?.render(); if (state.ui?.activeView === 'ide') workbenchWiring?.render(); },
    }) || null;
    const {testRunnerWiring,testOutputPanel,activityView} = activityWiringUtils.createIdeActivityWiring({
      state,workbench:workbenchWiring,windowRef,actionButton,escapeHtml,onAskJenny:onSendToJenny,
      showShellErrorToast,requestRender:renderIde,setActiveView:callbacks.setActiveView});
    // Focus fallback when a panel closes or hides: the editor (true only if focus got there).
    const focusIdeEditor = () => { editorHost?.focus?.(); const host = getDom().ideEditorHost; return Boolean(host?.contains?.(host.ownerDocument?.activeElement)); };
    // The Workspace's chats (row 40 W6) and the Workspace Chat Dock (ide_chat_dock), built in renderer-ide-controller-wiring.js.
    const { workspaceChats, ideChatDock } = wiring.createChatSurfaces(parts);
    // Layout: the workbench reconcile, then every panel's render (each self-targets
    // its own view host and self-gates on its view being visible), then the dock.
    const layout = layoutUtils.createIdeLayout?.({
      workbenchWiring,
      renderExplorer: () => tree?.renderExplorer(),
      renderSearch: () => searchPanel?.renderSearchPanel(),
      renderSourceControl: () => gitFeature?.renderPanel(),
      renderTerminal: () => { terminals?.renderAll(); terminals?.bindEvents(); }, // a new terminal binds on its first paint
      renderProblems: () => problemsPanel?.renderPanel(),
      renderRun: () => runScripts?.renderRunPanel(),
      renderTestRunner: () => testRunnerWiring?.render(),
      renderTestOutput: () => testOutputPanel?.render(), renderOutline: () => qol?.outline?.render(),
      renderActivity: () => {if(state.features?.featureFlags?.activity_monitor === true) activityView?.bind();activityView?.render();},
      chatDock: ideChatDock,
    }) || null;
    async function handleSearchResultOpen(path, line, column, origin) {
      const opened = await openFile(path, origin?.pane === undefined ? undefined : { group: workbenchWiring?.groupBinding?.chatTarget(origin.pane) }); // W7c: a bound chat's group
      // Reveal at the canonical document key: a case-different spelling opens the same document.
      const canonical = fileLifecycle?.fileOperations?.resolvePath?.(path) || ideStateUtils.normalizeIdeRelativePath?.(path) || '';
      if (opened) editorHost?.revealPosition(canonical, line, column); // a grouped file's group editor included
      return opened === true;
    }

    function renderTabs() {
      const ide = getIde();
      ideMru.record(ide.activeTabPath);
      // Drop nav-history entries + bookmarks for files no longer open (close /
      // rename) so Go Back never reveals a dead path and stale glyphs are gone.
      navBookmarks?.prune((ide.openTabs || []).map((tab) => tab.path));
      // The primary strip shows the primary group; each secondary group renders its own.
      const primaryTabs = ide.openTabs.filter((tab) => !tab.group);
      // Preview / File Map on stage reads as a real tab after the file tabs.
      const surfaceTab = stageSwitchUtils.surfaceTabFor?.(qol?.stageSurface?.getEffectiveSurface?.() || 'editor') || null;
      tabStrip?.renderTabs({ openTabs: primaryTabs, activeTabPath: ide.activeTabPath, dirtyByPath: ide.dirtyByPath, staleByPath: ide.staleByPath || {}, surfaceTab });
      tabRestore?.render(ide);
      editorGroups?.renderViews();
      const dom = getDom();
      if (dom.ideEmptyState) {
        dom.ideEmptyState.classList.toggle('hidden', primaryTabs.length > 0);
      }
      tree?.syncSelection();
      statusBar?.render();
      qol?.follow?.sync();
      diffController?.renderToolbar();
    }

    // Root-bound persistence pump; wrappers preserve the controller call sites.
    const persistence = persistenceUtils.createIdePersistence?.({
        getIde: () => getIde(),
        getWorkspaceIdeApi, getTabRestore: () => tabRestore,
        ideStateUtils,
        appendClientLog, showToastMessage,
        onHydrated: (ide) => welcome?.seedRecent((ide.openTabs || []).map((tab) => tab.path)),
        onLateHydrated: (ide) => { if (!lifecycle.isLive()) return; renderIde(); if (ide.activeTabPath) void openRestoredTab(ide.activeTabPath); },
        onPreferenceCommitted: () => statusBar?.render(),
        onPreferenceError: notifyPreferenceSaveFailed,
      }) || null;
    function notifyPreferenceSaveFailed(key) { showShellErrorToast(jt('ide.controller.preferenceSaveFailed', 'That editor preference could not be saved. Your previous setting is still active.'), { title: jt('ide.controller.preferenceSaveFailedTitle', 'Editor Setting Not Saved'), dedupeKey: `ide:preference:${String(key || 'unknown')}` }); }
    function flushPersist() { return persistence?.flushPersist(); }
    function schedulePersist() { persistence?.schedulePersist(); }
    function commitEditorPreference(key, value) {
      if (persistence) return persistence.commitPreference(key, value);
      notifyPreferenceSaveFailed(key);
      return Promise.resolve({ updated: false, code: 'workspace_ide_settings_unavailable' });
    }
    function hydratePersistedState() { return persistence ? persistence.hydratePersistedState() : Promise.resolve(); }

    // QoL chrome (breadcrumb nav + Ctrl+Tab MRU + save-time hygiene) behind one
    // collector so features add no per-module wiring to this at-ceiling controller;
    // built pre-fileLifecycle/keydown so saveHygiene + mruSwitcher thread into them.
    const qol = qolWiringUtils.createIdeQolWiring?.({
      getDom, getIde, editorHost, windowRef, escapeHtml, appendClientLog, getWorkspaceFsApi, getRecentFiles,
      getActiveView: () => state.ui.activeView,
      onOpenFile: (p) => openFile(p), activateTab: (p) => activateTab(p),
      onCloseTab: (p) => closeTab(p), renderTabs: () => renderTabs(), onOpenWritten: (p) => openFile(p, { preview: true }), // Follow Jenny
      onRevealInExplorer: (p) => revealInExplorer(p, { expandSelf: true }), onOpenSymbolPicker: () => editorHost?.runAction('editor.action.quickOutline'),
      getWorkspaceId: () => String(state.workspace?.activeWorkspaceId || ''), getFeatureFlags: () => state.features?.featureFlags || {}, sendToJenny: (payload) => onSendToJenny(payload), getGitDecoration: (p) => gitFeature?.getDecoration(p), subscribeGitChange: (fn) => gitFeature?.subscribe(fn), ideStateUtils, requestRender: () => renderIde(), activityBus: state.workspaceActivityBus || null, getActiveSessionId: () => String(state.currentSessionId || ''), // Shared bus + active-session accessor for the map controller's presenter
      getWorkspaceRootContext: () => state.workspaceRoot || null, chooseWorkspaceRoot: (...args) => chooseWorkspaceRoot(...args), getChangeLedger: () => getChangeLedger(), openChangeDiff: (change) => openChangeDiff(change), openChangesPanel: () => ideChatDock?.openChanges?.({}), showShellErrorToast, // Root context is the canonical File Map identity, never 'default'
      schedulePersist: () => schedulePersist(), getFileOperations: () => fileLifecycle?.fileOperations, showToastMessage, getWorkbenchWiring: () => workbenchWiring, getSymbolNav: () => symbolNav, // the Outline view's host and TS/JS tree
      isWatchActive: () => watchController?.isWatching?.() === true, // Preview's Live cue; read lazily (built later)
    }) || null;

    // The open-tab document lifecycle (open / activate / save / close / reopen +
    // tree delete/rename fan-out) plus the `saving` and `bypassReopenPush` flags
    // live in renderer-ide-file-lifecycle for the file-size ceiling. The
    // thunk-objects mirror the controller surfaces those bodies used to close
    // over, so behavior is unchanged; the controller keeps the thin facade below.
    const fileLifecycle = fileLifecycleUtils.createIdeFileLifecycle?.({
        getIde: () => getIde(),
        ideStateUtils,
        editorHost, getTabRestore: () => tabRestore,
        getWorkspaceFsApi,
        closedTabs,
        moveToGroup: (path, id) => editorGroups?.moveToGroup(path, id),
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
        showShellErrorToast,
        showToastMessage,
        toErrorMessage, appendClientLog,
      }) || null;

    // Thin facade: the rest of the controller keeps calling these by name; each
    // delegates to the lifecycle module (degrading to a no-op if it is absent).
    function openFile(path, options) {
      // A file already in a secondary group shows there (W5); a background open never activates.
      if (options?.background === true) return fileLifecycle ? fileLifecycle.openFile(path, options) : Promise.resolve(false);
      workbenchWiring?.workbench?.showEditor?.();
      const rel = ideStateUtils.normalizeIdeRelativePath?.(path) || '';
      const open = () => (fileLifecycle ? fileLifecycle.openFile(path, options) : Promise.resolve(false));
      // A preview open (tree arrow keys) stays in the primary group.
      return editorGroups?.openInGroup(rel) || (editorGroups && options?.preview !== true ? editorGroups.openFollowingFocus(rel, open, options?.group) : open());
    }
    function activateTab(path) {
      workbenchWiring?.workbench?.showEditor?.();
      if (editorGroups?.activateInGroup(path)) return;
      fileLifecycle?.activateTab(path);
    }
    function closeTab(path) { fileLifecycle?.closeTab(path); }
    // Restore opens (hydrate, late hydrate, root commit) must not reset a persisted
    // preview/file_map surface: the stage machine ignores activations until it settles.
    function openRestoredTab(path) {
      const stage = qol?.stageSurface;
      return stage?.suppressActivationResetDuring ? stage.suppressActivationResetDuring(() => openFile(path)) : openFile(path);
    }
    function reopenClosedTab() { return fileLifecycle ? fileLifecycle.reopenClosedTab() : Promise.resolve(); }
    function saveFile(targetPath) { return fileLifecycle ? fileLifecycle.saveFile(targetPath) : Promise.resolve(false); }
    function saveForLaunch(targetPath) { return fileLifecycle ? fileLifecycle.saveForLaunch(targetPath) : Promise.resolve(false); }
    function saveActiveFile(options) { return fileLifecycle ? fileLifecycle.saveActiveFile(options) : Promise.resolve(false); }

    // External-change watcher (workspaceFs.onChange) lives in a sibling module
    // for the file-size ceiling. The clean-delete close routes back through
    // closeTab WITHOUT recording for reopen (the file is gone) and purges the
    // reopen stack.
    const watchController = watchControllerUtils.createIdeWatchController?.({
      getIde: () => getIde(),
      getWorkspaceFsApi,
      editorHost, fileOperations: fileLifecycle?.fileOperations,
      ideStateUtils,
      showToastMessage,
      renderTabs: () => renderTabs(), appendClientLog,
      onTreeExternalChanges: (changes, opts) => { tree?.handleExternalChanges(changes, opts); quickOpen?.handleExternalChanges(changes, opts); },
      onExternalDelete: (path) => fileLifecycle?.closeExternalDelete(path),
      onExternalPreviewChange: (change) => { qol?.previewStage?.handleExternalChange?.(change); },
      runWithoutStageReset: (fn) => (qol?.stageSurface?.suppressActivationResetDuring ? qol.stageSurface.suppressActivationResetDuring(fn) : fn()),
      onExternalDocumentReloaded: (path) => { qol?.previewStage?.handleModelChange?.(path); },
      onWatchStateChange: () => { qol?.previewStage?.refreshLiveCue?.(); },
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
        { label: jt('ide.controller.openInNewTab', 'Open in New Tab'), action: () => openFile(path) },
        ...(previewController?.buildPreviewMenuItems(path) || []),
        ...buildPathUtilityMenuItems(path, 'file'),
        ...(selectionIntents?.buildSendToJennyMenuItems(path) || []),
      ];
    }

    // View-scoped keymap (capture phase on #ideView; row 82), built in renderer-ide-controller-wiring.js.
    const handleViewKeydown = wiring.createViewKeydownHandler(parts);

    function layoutIdeEditor() { editorHost?.layout(); }
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
      revealInExplorer: (path, options) => { revealInExplorer(path, options); return true; }, // Chat folder chips (row 95): the explorer tree reveal; true once requested.
      showActivityOutput: output => activityView?.showOutput(output),
      openFileAtLine: (path, line, column, origin) => handleSearchResultOpen(path, line, column, origin), // Chat timeline path chips and cite links use the same open-then-revealPosition seam as search; resolves true only when the file actually opened.
      saveActiveFile, openGitView: () => showPanel('source-control'), // The Changes panel's "Open in Git" (row 59 checkpoint 2).
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
      // app_view (row 94 P3): the terminal, opened and started.
      openTerminalPanel: async () => { await lifecycle.whenActivated().catch(() => {}); return workbenchWiring?.bottomPanel?.open('terminal') === true && (terminals?.panelFor?.(terminals.activeViewId())?.startSession?.().catch?.(() => {}), true); },
      closeBottomPanel: () => { workbenchWiring?.bottomPanel?.close(); return true; },
      // terminal_run (row 94 P4): the approved line in an idle Jenny terminal or a new one, never the user's shell
      // (null when none is free, false when its shell would not start).
      runInTaskTerminal: async (command) => {
        if (!terminals?.openTaskTerminal) return { ok: false, reason: 'no_ide' };
        const task = await terminals.openTaskTerminal();
        if (!task) return { ok: false, reason: task === null ? 'no_free_terminal' : 'start_failed' };
        const sessionId = task.getSessionId(); // read first: a shell that exits right after the line clears it
        return await task.sendCommand(command) === true ? { ok: true, session_id: task.getSessionId() || sessionId } : { ok: false, reason: 'send_failed' };
      },
      // Transcript diff rows resolve a ledger changeId to its record and open the diff://change/ review tab.
      openLedgerChangeById: (changeId, options) => { const id = String(changeId || '').trim(); const ledger = options?.secondChat === true ? workspaceChats?.secondLedger() : getChangeLedger(); const change = id ? (ledger?.changes || []).find((entry) => String(entry?.changeId || '') === id) : null; return change ? openChangeDiff(change, { pane: options?.secondChat === true ? 1 : 0 }) : false; },
    };
  }

  return {
    createIdeController,
  };
});
