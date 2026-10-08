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
    const ideStateUtils = resolveModule('rendererIdeState', './renderer-ide-state');
    const editorHostUtils = resolveModule('rendererIdeEditorHost', './renderer-ide-editor-host');
    const tabsUtils = resolveModule('rendererIdeTabs', './renderer-ide-tabs');
    const wiringUtils = resolveModule('rendererIdeExplorerWiring', './renderer-ide-explorer-wiring');
    const workbenchWiringUtils = resolveModule('rendererIdeWorkbenchWiring', './renderer-ide-workbench-wiring');
    const stageSwitchUtils = resolveModule('rendererIdeStageSwitch', './renderer-ide-stage-switch');
    const searchPanelUtils = resolveModule('rendererIdeSearchPanel', './renderer-ide-search-panel');
    const statusBarUtils = resolveModule('rendererIdeStatusBar', './renderer-ide-statusbar');
    const ledgerUtils = resolveModule('rendererJennyChangeLedger', '../chat/renderer-jenny-change-ledger');
    const tabsControllerUtils = resolveModule('rendererIdeTabsController', './renderer-ide-tabs-controller');
    const quickOpenUtils = resolveModule('rendererIdeQuickOpen', './renderer-ide-quick-open');
    const previewControllerUtils = resolveModule('rendererIdePreviewController', './renderer-ide-preview-controller');
    const diffControllerUtils = resolveModule('rendererIdeDiffController', './renderer-ide-diff-controller');
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
    const layoutModel = resolveModule('jennyWorkbenchLayoutModel', '../shared/workbench-layout-model');
    const mruUtils = resolveModule('rendererIdeMru', './renderer-ide-mru');
    const chatDockUtils = resolveModule('rendererIdeChatDock', './renderer-ide-chat-dock');
    const workspaceChatsUtils = resolveModule('rendererIdeWorkspaceChats', './renderer-ide-workspace-chats');
    const layoutUtils = resolveModule('rendererIdeLayout', './renderer-ide-layout');
    const commandsUtils = resolveModule('rendererIdeCommands', './renderer-ide-commands');
    const navBookmarksUtils = resolveModule('rendererIdeNavBookmarks', './renderer-ide-nav-bookmarks');
    const autoSaveUtils = resolveModule('rendererIdeAutoSave', './renderer-ide-auto-save');
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
    function getWorkspacePtyApi() {
      return windowRef.jennyShell?.workspacePty || null;
    }

    const themeBridge = themeBridgeUtils.createIdeThemeBridge?.({
      documentRef: windowRef.document || null, appendClientLog,
    }) || null;
    const editorHost = editorHostUtils.createIdeEditorHost?.({
      getDocumentWorkspaceId: (path) => fileLifecycle?.fileOperations?.getDocumentToken(path)?.rootId || '',
      getDom,
      log: (...args) => appendClientLog(...args),
      onDirtyChange(path, dirty) {
        fileLifecycle?.noteDirty(path, dirty); ideStateUtils.setTabDirty?.(getIde(), path, dirty);
        renderTabs();
      },
      onSaveRequest() {
        saveActiveFile();
      },
      // PDF/DOCX panes: every mutation feeds the save fence (editVersion) and
      // nothing else -- no preview, gutter, or auto-save hooks for documents.
      onDocumentEdit(path) { fileLifecycle?.noteEdit(path); },
      onCursorActivity(info) {
        // Cursor choke point -> nav-bookmarks facade (drops the null non-file
        // diff/preview case; nav-history coalesces the rest).
        statusBar?.render();
        // A focused group's cursor (W7) feeds the status bar only.
        if (editorHost?.getFocusedGroupPath?.()) return;
        navBookmarks?.recordCursorNav(info);
        // After statusBar (which owns #ideBreadcrumbs innerHTML) so the symbol
        // path segments survive its file-path render.
        symbolNav?.render();
      },
      onModelChange(path) {
        fileLifecycle?.noteEdit(path);
        qol?.previewStage?.handleModelChange(path);
        qol?.presentation?.noteEdit(); // recent-typing signal for presentation policy
        gutterDecorations?.schedule(path);
        autoSave?.onChange(path);
      },
      onGlyphMarginClick(line) { navBookmarks?.toggleAtGlyph(line); },
      onMonacoReady(monacoApi) {
        // Swap the load-time vs-dark default for the palette-matched theme.
        themeBridge?.handleMonacoReady(monacoApi);
        editorPrefsUtils.applyEditorPrefs?.(getIde(), editorHost, chipPicker);
        selectionIntents?.registerActions();
        wordWrap?.registerAction(monacoApi);
        debugInspector?.registerActions(); runScripts?.registerActions();
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
    // Debounced auto-save (default-OFF via the per-user autoSaveEnabled pref).
    // Saves the edited path (a secondary group's file too) through saveFile, so the
    // mtime-conflict + stale guards hold; the module skips non-file/stale tabs and
    // is cancelled on tab switch/close (debounce + gating live in the module).
    const autoSave = autoSaveUtils.createIdeAutoSave?.({
      editorHost,
      getIde: () => getIde(),
      saveFile: (path) => (fileLifecycle ? fileLifecycle.saveFile(path, { unattended: true }) : false),
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
    const tabRestore = resolveModule('rendererIdeTabRestore', './renderer-ide-tab-restore')
      .createIdeTabRestore?.({ getDom, escapeHtml, editorHost, getWorkspaceFsApi, registerCleanup }) || null;
    // Workbench (row 40 W3): the layout tree of splits and stacks. Every panel is a
    // SINGLE instance rendering into its own persistent view host and gated on its
    // view being visible; showPanel reveals a view wherever it lives.
    const workbenchWiring = workbenchWiringUtils.createIdeWorkbenchWiring?.({
      getDom, getIde: () => getIde(), ideStateUtils, schedulePersist: () => schedulePersist(), requestRender: () => renderIde(),
      focusEditor: () => focusIdeEditor(), focusTerminal: () => terminals?.focusTerminal?.() === true,
      // Problems shows only while there are markers of any severity (F7; the statusbar count stays);
      // test output only while the config it shows has output (F6).
      isViewAvailable: (id) => (id === 'test-runner' ? testRunnerWiring?.isAvailable() !== false
        : id === 'chat' || id === 'changes' ? state?.features?.featureFlags?.ide_chat_dock === true
          : id === 'chat-2' || id === 'changes-2' ? workspaceChats?.isAvailable(id) === true // W6b: a second split-view pane
          : id === 'problems' ? problemsPanel?.hasMarkers?.() === true
            : id === 'test-output' ? testOutputPanel?.hasOutput() === true : true),
      counts: {
        'source-control': () => gitFeature?.getDirtyCount() || 0,
        problems: () => problemCount(),
        changes: () => ideChatDock?.getChangesWaitingCount?.() || 0,
        'changes-2': () => workspaceChats?.secondWaitingCount() || 0,
      },
      // New chat activity while that chat was off screen.
      unread: { chat: () => ideChatDock?.hasUnread?.() === true, 'chat-2': () => workspaceChats?.hasSecondUnread() === true },
      labels: { run: () => runScripts?.getRunLabel?.() || '' }, // F5: the Run tab names its task
      viewActions: (id) => terminalActions(id), onViewAction: (id, name) => runTerminalAction(id, name),
      getGroupElement: (id) => editorGroups?.getElement(id) || null, getEditorGroups: () => editorGroups,
    }) || null;
    function problemCount() {
      return problemsPanel?.getBadgeCount?.() || 0;
    }
    // Terminal headers (F3): + opens the next of four terminals beside this one; Kill ends this one.
    let terminalNear = 'terminal';
    function terminalActions(id) {
      if (!terminals || !(layoutModel?.terminalSlot?.(id) > 0)) return [];
      const icons = workbenchWiringUtils.ACTION_ICONS || {};
      return [
        ...(terminals.canAdd() ? [{ name: 'new-terminal', label: jt('ide.terminal.new', 'New Terminal'), icon: icons.add }] : []),
        { name: 'kill-terminal', label: jt('ide.terminal.kill', 'Kill Terminal'), icon: icons.trash },
      ];
    }
    function runTerminalAction(id, name) {
      if (name === 'new-terminal') {
        terminalNear = id;
        terminals?.newTerminal({ start: true });
      } else if (name === 'kill-terminal') {
        terminals?.closeTerminal(id);
      }
    }
    // Palette New Terminal and Ctrl+Shift+`: the + path, offered only while the + is.
    const newTerminalAction = () => (terminals?.canAdd() ? () => terminals.newTerminal({ start: true, near: workbenchWiring?.groupBinding?.boundTerminal() || '' }) : undefined); // W7c: beside the focused group's terminal
    const panelDeps = (id) => workbenchWiring?.viewDeps(id) || {};
    const bottomPanel = workbenchWiring?.bottomPanel || null;
    const showPanel = (id) => workbenchWiring?.showPanel(id) === true;
    const explorer = wiringUtils.createIdeExplorerWiring?.({
      getDom, escapeHtml, getIde, getWorkspaceFsApi, openFile,
      buildFileContextMenuItems, buildPathUtilityMenuItems, schedulePersist,
      getWorkspaceRootApi, showShellErrorToast, appendClientLog, panelDeps,
      showToastMessage: (...args) => showToastMessage(...args),
      getChooseWorkspaceRoot: () => chooseWorkspaceRoot, getProjectSwitcher, peekProjectSwitcher,
      getFileLifecycle: () => fileLifecycle, getSearchPanel: () => searchPanel,
      getCloseOrchestrator: () => closeOrchestrator, getConfirmDialog: () => confirmDialog,
      getGitFeature: () => gitFeature, getTerminalPanel: () => terminals, getBottomPanel: () => bottomPanel,
      getFeatureFlags: () => state?.features?.featureFlags,
    }) || null;
    const tree = explorer?.tree || null;
    // Preview / File map toggles at the end of the editor tab row (qol is built later; thunks).
    const stageSwitch = stageSwitchUtils.createIdeStageSwitch?.({
      getMountEl: () => getDom().ideStageSwitch, actionButton,
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
      onOpenResult: handleSearchResultOpen, appendClientLog, showShellErrorToast: (...args) => showShellErrorToast(...args),
      renderTabs: () => renderTabs(),
      isSaving: () => fileLifecycle?.isSaving() === true,
      // Find-in-Folder reveals Search wherever it lives.
      onActivateSearch: () => showPanel('search'),
    };
    const searchPanel = searchPanelUtils.createIdeSearchPanel?.({ ...searchDeps, ...panelDeps('search') }) || null;

    const ptyTerminalPanelUtils = resolveModule('rendererIdePtyTerminalPanel', './renderer-ide-pty-terminal-panel');
    // Up to four terminals, one PTY panel per terminal view; the layout says which exist.
    const terminals = resolveModule('rendererIdeTerminalWiring', './renderer-ide-terminal-wiring').createIdeTerminalSet?.({
      ptyTerminalPanelUtils, model: layoutModel || {}, viewDeps: panelDeps,
      baseDeps: {
        getDom, getIde: () => getIde(), appendClientLog, getWorkspacePtyApi,
        showError: (message, meta) => showShellErrorToast(message, meta), toErrorMessage: (...args) => toErrorMessage(...args),
      },
      listTerminalViews: () => workbenchWiring?.listViews() || [],
      addTerminalView: (id, near) => workbenchWiring?.addView(id, near || (workbenchWiring.isVisible(terminalNear) ? terminalNear : 'terminal')),
      removeTerminalView: (id) => workbenchWiring?.removeView(id),
      revealView: (id, options) => workbenchWiring?.showPanel(id, options),
    }) || null;

    const statusBar = statusBarUtils.createIdeStatusBar?.({
      getDom,
      escapeHtml,
      getIde: () => getIde(),
      callbacks: {
        getCursorInfo: () => editorHost?.getFocusedCursorInfo?.() || null, getStatusPath: () => editorHost?.getFocusedGroupPath?.() || '',
        getActiveLanguageId: () => editorHost?.getFocusedLanguageId?.() || '',
        getBranch: () => gitFeature?.getBranch() || '',
        getDirtyCount: () => gitFeature?.getDirtyCount() || 0,
        getProblemCounts: () => problemsPanel?.getCounts() || null,
        getBottomPanelOpen: () => bottomPanel?.isOpen() === true, getRunning: () => runScripts?.isRunning() === true,
        onSwitchBranch: () => branchSwitcher?.open(),
        onOpenProblems: () => bottomPanel?.open('problems'),
        onToggleBottomPanel: () => bottomPanel?.toggle(), onOpenRun: () => bottomPanel?.open('run'),
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
        buildExtraMenuItems: (path, opts) => [...(opts?.review ? [] : buildFileContextMenuItems(path)), ...(editorGroups?.moveMenuItems(path) || [])],
        revealInExplorer: (path) => revealInExplorer(path), onDropTab: (payload, index) => editorGroups?.moveToGroup(payload.path, '', index),
        schedulePersist: () => schedulePersist(),
        renderTabs: () => renderTabs(),
        showShellErrorToast: (...args) => showShellErrorToast(...args),
        showToastMessage: (...args) => showToastMessage(...args),
        toErrorMessage: (...args) => toErrorMessage(...args),
      },
    }) || null;

    // Secondary editor groups (row 40 W5): their views, layout stacks and split/move/close intents.
    const editorGroups = resolveModule('rendererIdeEditorGroupsWiring', './renderer-ide-editor-groups-wiring').createIdeEditorGroupsWiring?.({
      getIde: () => getIde(), getDom, editorHost, escapeHtml, getWorkbenchWiring: () => workbenchWiring, getCloseOrchestrator: () => closeOrchestrator,
      loadDocument: (path) => fileLifecycle?.openFile(path, { background: true }) || Promise.resolve(false), activatePrimary: (path) => activateTab(path),
      requestCloseTab: (path) => requestCloseTab(path), saveFile: (path) => saveFile(path), revealInExplorer: (path) => revealInExplorer(path),
      onActivated: (path) => ideMru.record(path), renderReviewBar: (el, path) => diffController?.renderToolbarFor(el, path),
      getBoundGroups: () => workbenchWiring?.groupBinding?.boundGroups() || [], getBoundText: (id) => workbenchWiring?.groupBinding?.boundText(id) || '', unbindGroup: (id) => workbenchWiring?.groupBinding?.unbindGroup(id),
      schedulePersist: () => schedulePersist(), requestRender: () => renderIde(),
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
      buildShortcutsHtml: () => ideShortcutsUtils.buildIdeShortcutsHtml?.() || '',
      onOpenFile: (path) => {
        openFile(path);
      },
      onChooseFolder: () => chooseWorkspaceRoot(),
      // Projects v2: "Your projects" rows + "Switch project…" share the lazy switcher.
      getProjects: () => peekProjectSwitcher?.()?.getProjects?.() || [], getProjectSwitcher,
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
      editorHost, getWorkspacePtyApi, getWorkspaceRootApi, appendClientLog, showToastMessage, saveFile: (path) => saveForLaunch(path),
      openTerminalPanel: () => bottomPanel?.open('terminal'),
      sendTerminalCommand: (builder) => terminals?.sendCommand?.(builder) ?? false,
      // Its own terminal (never the user's shell) when the terminal set is up.
      openTaskTerminal: terminals ? (near) => terminals.openTaskTerminal(near) : undefined, captureTaskTarget: () => workbenchWiring?.groupBinding?.boundTerminal(),
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
      editorHost, appendClientLog,
      toggleMinimap: () => editorPrefsUtils.toggleMinimap?.(getIde(), editorHost, commitEditorPreference, () => statusBar?.render()),
      reopenClosedTab: () => reopenClosedTab(), showPanel,
      layoutActions: workbenchWiring ? {
        togglePrimarySide: () => workbenchWiring.togglePrimarySide(), togglePanel: () => bottomPanel?.toggle(), resetLayout: () => workbenchWiring.resetLayout(),
        get newTerminal() { return newTerminalAction(); },
        // Editor groups need Monaco: the rows show once it has loaded (getters, read per palette open).
        get splitRight() { return editorHost?.getMonaco?.() ? () => editorGroups?.splitActive('right') : undefined; },
        get splitDown() { return editorHost?.getMonaco?.() ? () => editorGroups?.splitActive('down') : undefined; },
        get focusNextGroup() { return editorHost?.getMonaco?.() ? () => editorGroups?.focusNextGroup() : undefined; },
        // Keyboard move (W4): the menu for the panel focus was last in, anchored on its tab.
        moveView: () => { const wb = workbenchWiring.workbench; const viewId = wb?.getFocusedView?.(); return viewId ? wb.openMoveMenu(viewId) : false; },
        // Read per palette open: the flag can hydrate after the controller is built.
        get toggleChat() { return state?.features?.featureFlags?.ide_chat_dock === true ? () => ideChatDock?.toggle() : undefined; },
      } : null,
      workspaceSymbolPicker: () => symbolNav?.openPicker(), openFileMap: () => qol?.mapController?.openFileMap(), revealInMap: () => qol?.revealActiveFileInMap?.(), showBlastRadius: () => qol?.blastActiveFileInMap?.(), toggleExplodedView: () => qol?.explodeController?.toggleActiveTab(), openPreviewSurface: () => qol?.stageSurface?.activate('preview'), previewActiveFile: () => qol?.previewStage?.open(getIde().activeTabPath || ''),
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
      getActivePath: () => editorHost?.getFocusedPath?.() || '',
      escapeHtml,
      actionButton: typeof actionButton === 'function' ? actionButton : null,
      popover: typeof popoverUtils === 'function' ? popoverUtils : popoverUtils?.default,
      onAfterChange: (change) => { void editorPrefsUtils.persistChipChange?.(getIde(), change, commitEditorPreference); },
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
      showDiffTab: (id) => editorGroups?.activateInGroup(id) || editorHost.activateDocument(id),
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
      },
    }) || null;

    // W7c: a diff opened from a bound chat (origin.pane) lands in that chat's group.
    function openDiffFrom(origin, open, id) {
      return workbenchWiring?.groupBinding ? workbenchWiring.groupBinding.openDiffFrom(origin?.pane, open, id) : open();
    }
    function openChangeDiff(change, origin) {
      return openDiffFrom(origin, () => (diffController ? diffController.openChangeDiff(change) : false), diffController?.changeDiffId(change));
    }

    function openUnsavedCompare(path) {
      return diffController ? diffController.openUnsavedCompare(path) : false;
    }

    // Git client + status store + Source Control panel; the tree + statusbar read its getters.
    const gitFeature = gitFeatureUtils.createIdeGitFeature?.({
      showDiffTab: (id) => editorGroups?.activateInGroup(id) || editorHost.activateDocument(id),
      windowRef, getDom, getIde, editorHost, getWorkspaceFsApi, getFileLifecycle: () => fileLifecycle, onDeleteUntracked: (path) => tree?.deleteEntry(path, 'file'), confirmDialog, escapeHtml,
      appendClientLog, showShellErrorToast, renderTabs, schedulePersist, requestRender: renderIde, showPanel,
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
      ...panelDeps('problems'),
      onReveal: (path, line, column) => handleSearchResultOpen(path, line, column),
    }) || null;
    const runScripts = resolveModule('rendererIdeRunScripts', './renderer-ide-run-scripts').createIdeRunScripts?.({
      getDom, escapeHtml, editorHost, getWorkspaceFsApi, appendClientLog, showToastMessage, saveFile: (path) => saveForLaunch(path),
      ...panelDeps('run'),
      isDiffTabId: (p) => ideStateUtils.isDiffTabId?.(p) === true || ideStateUtils.isPreviewTabId?.(p) === true,
      openRunPanel: (near) => workbenchWiring?.groupBinding?.revealTask('run', near) || bottomPanel?.open('run'), getRunTarget: () => workbenchWiring?.groupBinding?.boundTerminal() || '', onAskJenny: onSendToJenny,
      // The statusbar, and the Run tab's "Run: <script>" label (workbench chrome only).
      onRunStateChange: () => { statusBar?.render(); if (state.ui?.activeView === 'ide') workbenchWiring?.render(); },
    }) || null;
    const testRunnerWiring = resolveModule('rendererIdeTestRunnerWiring', './renderer-ide-test-runner-wiring').createIdeTestRunnerWiring?.({ windowRef, actionButton, getMountEl: () => panelDeps('test-runner').getMountEl?.() || null, isActiveView: () => workbenchWiring?.isVisible('test-runner') === true, showShellErrorToast, onAvailabilityChange: () => renderIde(),
      // F6: Show output selects the config and opens its Test output tab; a new run repaints it.
      onShowOutput: (configId) => { testOutputConfigId = String(configId || ''); showPanel('test-output'); testOutputPanel?.render(); },
      onOutputChange: () => { if (state.ui?.activeView === 'ide') renderIde(); } }) || null;
    let testOutputConfigId = '';
    const testOutputPanel = resolveModule('rendererIdeTestOutputPanel', './renderer-ide-test-output-panel').createIdeTestOutputPanel?.({
      ...panelDeps('test-output'), actionButton, escapeHtml, onAskJenny: onSendToJenny,
      getSelection: () => (testOutputConfigId ? { configId: testOutputConfigId } : null),
      getRunOutput: (id) => testRunnerWiring?.getLastRunOutput(id) || null, getConfigLabel: (id) => testRunnerWiring?.getConfigLabel(id) || id,
      onRunAgain: (id) => testRunnerWiring?.runConfig(id),
    }) || null;
    // Focus fallback when a panel closes or hides: the editor (true only if focus got there).
    const focusIdeEditor = () => { editorHost?.focus?.(); const host = getDom().ideEditorHost; return Boolean(host?.contains?.(host.ownerDocument?.activeElement)); };
    // Workspace Chat Dock (ide_chat_dock): the chat subtree relocated into the
    // workbench's chat view. The module owns the session row + the idempotent
    // host reconcile; the chat render pipeline ALSO drives reconcile() from the
    // top of renderLayout before visibility toggles. New-chat
    // reuses the live #newChatButton handler (the button stays in #chatView).
    // The Workspace's chats (row 40 W6): both Changes bindings, the second chat and the Git links.
    const workspaceChats = workspaceChatsUtils?.createIdeWorkspaceChats?.({
      state, getWorkbench: () => workbenchWiring, getTurnViewModels: (sessionId) => getTurnViewModelsForActiveSession(sessionId) || [],
      getSessionMessages: (sessionId) => getSessionMessages(String(sessionId || '')) || [], buildLedger: ledgerUtils.buildJennyChangeLedgerFromTurnViewModels,
      getGitFeature: () => gitFeature, requestRender: () => renderIde(), loadChangesView: async () => globalThis.rendererChangesView || null,
      onCountChange: () => { if (state.ui?.activeView === 'ide') workbenchWiring?.render(); },
      viewDeps: {
        buildLedger: ledgerUtils.buildJennyChangeLedgerFromTurnViewModels, openChangeDiff: (change, origin) => openChangeDiff(change, origin), getUndoController: getChangesUndoController,
        escapeHtml, appendClientLog, openSuggestionDiff: (sessionId, id, origin) => openDiffFrom(origin, () => diffController?.openSuggestionDiff(sessionId, id), diffController?.suggestionDiffId(sessionId)),
      },
    }) || null;
    const ideChatDock = chatDockUtils.createIdeChatDock?.({
      state, getDom, getIde: () => getIde(),
      layoutIdeEditor: () => layoutIdeEditor(), focusEditor: focusIdeEditor,
      // The workbench owns open/closed (the chat stack), the Chat | Changes tabs and the Changes host.
      workbench: workbenchWiring ? {
        setOpen: (open) => workbenchWiring.setChatOpen(open), reveal: (id) => workbenchWiring.showPanel(id),
        isVisible: (id) => workbenchWiring.isVisible(id), getChangesHost: () => panelDeps('changes').getMountEl?.() || null,
        onCountChange: () => { if (state.ui?.activeView === 'ide') workbenchWiring.render(); }, // the Changes tab's waiting count; chrome only
      } : null,
      onNewChat: () => getDom().ideChatDock?.ownerDocument?.getElementById('newChatButton')?.click(),
      // The second chat's session is already on screen as Chat 2: reveal it rather than swap pane 0.
      onSelectSession: (sessionId) => (workspaceChats?.isSecondSession(sessionId) ? workspaceChats.revealSecondChat() : activateWorkspaceSession(sessionId)),
      revealSecondChanges: (target) => workspaceChats?.revealSecondChanges(target) === true, showShellErrorToast, appendClientLog, noteProgrammaticWrite: (reason) => callbacks.noteScrollProgrammaticWrite?.(reason),
      // Split view: the dock hosts pane 0, so pane 0 holds focus while docked.
      onHostChanged: (docked) => globalThis.rendererAppPaneComposition?.getPaneComposition?.()?.handleChatDocked?.(docked),
      // Chat | Changes tabs (row 34 S5): the IDE script manifest has already loaded the view.
      changesView: { loadChangesView: async () => globalThis.rendererChangesView || null, viewDeps: workspaceChats?.primaryViewDeps || {}, onSync: () => workspaceChats?.sync() },
    }) || null;
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
      renderTestOutput: () => testOutputPanel?.render(),
      chatDock: ideChatDock,
    }) || null;
    async function handleSearchResultOpen(path, line, column, origin) {
      const opened = await openFile(path, origin?.pane === undefined ? undefined : { group: workbenchWiring?.groupBinding?.chatTarget(origin.pane) }); // W7c: a bound chat's group
      const normalized = ideStateUtils.normalizeIdeRelativePath?.(path) || '';
      if (opened) editorHost?.revealPosition(normalized, line, column); // a grouped file's group editor included
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
      tabStrip?.renderTabs({ openTabs: primaryTabs, activeTabPath: ide.activeTabPath, dirtyByPath: ide.dirtyByPath, staleByPath: ide.staleByPath || {} });
      tabRestore?.render(ide);
      editorGroups?.renderViews();
      const dom = getDom();
      if (dom.ideEmptyState) {
        dom.ideEmptyState.classList.toggle('hidden', primaryTabs.length > 0);
      }
      tree?.syncSelection();
      statusBar?.render();
      diffController?.renderToolbar();
    }

    // Root-bound persistence pump; wrappers preserve the controller call sites.
    const persistence = resolveModule('rendererIdePersistence', './renderer-ide-persistence')
      .createIdePersistence?.({
        getIde: () => getIde(),
        getWorkspaceIdeApi, getTabRestore: () => tabRestore,
        ideStateUtils,
        appendClientLog, showToastMessage: (...args) => showToastMessage(...args),
        onHydrated: (ide) => welcome?.seedRecent((ide.openTabs || []).map((tab) => tab.path)),
        onLateHydrated: (ide) => { if (!activated || disposed) return; renderIde(); if (ide.activeTabPath) { qol?.stageSurface?.suppressNextActivationReset(); void openFile(ide.activeTabPath); } },
        onPreferenceCommitted: () => statusBar?.render(),
        onPreferenceError: (key) => showShellErrorToast(jt('ide.controller.preferenceSaveFailed', 'That editor preference could not be saved. Your previous setting is still active.'), { title: jt('ide.controller.preferenceSaveFailedTitle', 'Editor Setting Not Saved'), dedupeKey: `ide:preference:${String(key || 'unknown')}` }),
      }) || null;
    function flushPersist() { return persistence?.flushPersist(); }
    function schedulePersist() { persistence?.schedulePersist(); }
    function commitEditorPreference(key, value) {
      if (persistence) return persistence.commitPreference(key, value);
      showShellErrorToast(jt('ide.controller.preferenceSaveFailed', 'That editor preference could not be saved. Your previous setting is still active.'), { title: jt('ide.controller.preferenceSaveFailedTitle', 'Editor Setting Not Saved'), dedupeKey: `ide:preference:${String(key || 'unknown')}` });
      return Promise.resolve({ updated: false, code: 'workspace_ide_settings_unavailable' });
    }
    function hydratePersistedState() {
      return persistence ? persistence.hydratePersistedState() : Promise.resolve();
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
      getWorkspaceRootContext: () => state.workspaceRoot || null, chooseWorkspaceRoot: (...args) => chooseWorkspaceRoot(...args), getChangeLedger: () => getChangeLedger(), openChangeDiff: (change) => openChangeDiff(change), openChangesPanel: () => ideChatDock?.openChanges?.({}), showShellErrorToast: (...args) => showShellErrorToast(...args), // Root context is the canonical File Map identity, never 'default'
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
        showShellErrorToast: (...args) => showShellErrorToast(...args),
        showToastMessage: (...args) => showToastMessage(...args),
        toErrorMessage: (...args) => toErrorMessage(...args), appendClientLog,
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
      autoSave?.cancel();
      workbenchWiring?.workbench?.showEditor?.();
      if (editorGroups?.activateInGroup(path)) return;
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
    function saveForLaunch(targetPath) { return fileLifecycle ? fileLifecycle.saveForLaunch(targetPath) : Promise.resolve(false); }
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
      onExternalDelete: (path) => fileLifecycle?.closeExternalDelete(path),
      onExternalPreviewChange: (change) => { qol?.previewStage?.handleExternalChange?.(change); },
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
      bottomPanel, newTerminal: () => newTerminalAction()?.(),
      chatDock: ideChatDock, isChatDockEnabled: () => state?.features?.featureFlags?.ide_chat_dock === true,
      mruSwitcher: qol?.mruSwitcher || null, editorGroups,
      reopenClosedTab, showPanel,
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
      // tree or a panel; Monaco's own Ctrl+S command covers editor focus.
      dom.ideView.addEventListener('keydown', handleViewKeydown, true);
      explorer?.bindAll(); stageSwitch?.bindEvents(); editorGroups?.bindEvents();
      searchPanel?.bindEvents();
      diffController?.bindEvents(); terminals?.bindEvents();
      statusBar?.bindEvents(); gitFeature?.bindEvents();
      problemsPanel?.bindEvents();
      runScripts?.bindEvents(); testRunnerWiring?.bindEvents();
      ideChatDock?.bindEvents();
      symbolNav?.bindEvents(); qol?.bindAll();
      chipPicker?.initHandlers();
      // Flush the pending debounced persist before a hard window close (mirrors
      // the dashboard scratchpad beforeunload flush) so edits are not lost.
      const flushOnUnload = () => { persistence?.flushIfPending(); };
      windowRef.addEventListener?.('beforeunload', flushOnUnload);
      // Debounced re-render on resize: the workbench solver re-fits the stacks.
      let resizeTimer = null;
      const onWindowResize = () => {
        if (resizeTimer) { clearTimeout(resizeTimer); }
        // Hidden Workspace: skip; activateIde() always re-renders when it is shown again.
        resizeTimer = setTimeout(() => { resizeTimer = null; if (state.ui?.activeView === 'ide') renderIde(); }, 120);
      };
      windowRef.addEventListener?.('resize', onWindowResize);
      registerCleanup(function disposeIdeBindings() {
        disposed = true; lifecycleEpoch += 1;
        bound = false;
        welcome?.dispose();
        confirmDialog?.dispose();
        ideCommands?.disposeHelp();
        chipPicker?.dispose();
        dom.ideView.removeEventListener('keydown', handleViewKeydown, true);
        // Flush any pending persist before teardown (clears the timer internally).
        persistence?.flushIfPending();
        persistence?.dispose();
        windowRef.removeEventListener?.('beforeunload', flushOnUnload);
        windowRef.removeEventListener?.('resize', onWindowResize);
        if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
        watchController?.stop(); fileLifecycle?.dispose();
        debugInspector?.dispose();
        quickOpen?.dispose(); branchSwitcher?.dispose();
        tabsController?.dispose(); statusBar?.dispose();
        gitFeature?.dispose(); problemsPanel?.dispose(); workspaceChats?.dispose();
        runScripts?.dispose(); testRunnerWiring?.dispose();
        workbenchWiring?.dispose(); stageSwitch?.dispose(); editorGroups?.dispose();
        ideChatDock?.dispose();
        terminals?.dispose(); testOutputPanel?.dispose();
        diffController?.dispose();
        searchPanel?.dispose();
        explorer?.disposeAll();
        themeBridge?.dispose();
        autoSave?.dispose();
        gutterDecorations?.dispose();
        navBookmarks?.dispose();
        symbolNav?.dispose(); qol?.disposeAll();
        editorHost?.dispose();
      });
    }

    // Layout (the workbench + panel fan-out) lives in renderer-ide-layout.js; renderTabs
    // stays here (it touches the tree / tab strip / statusbar).
    function renderIde() {
      editorGroups?.reconcile(); // editor stacks follow the tabs' groups before the workbench renders
      workspaceChats?.reconcileLayout(); // and Chat 2 / Changes 2 join it once a second chat exists
      layout?.render();
      renderTabs();
      stageSwitch?.render();
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
        // Quiet window for missing files: from hydrate until the first render settles.
        return (tabRestore ? tabRestore.runRestore : (action) => action())(async () => {
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
          }
        });
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
      fileLifecycle?.resetForRoot(context); ideStateUtils.resetIdeRootState?.(getIde()); tree?.resetForRoot?.(); searchPanel?.resetForRoot?.(); diffController?.resetForRoot?.(); quickOpen?.invalidate(); ideMru?.clear?.(); navBookmarks?.resetForRoot?.(); tabsController?.resetForRoot?.(); editorGroups?.resetForRoot(); testRunnerWiring?.resetForRoot?.(); runScripts?.resetForRoot?.(); gitFeature?.resetForRoot?.(); // Git presentation must not survive a root switch.
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
      openFileAtLine: (path, line, column, origin) => handleSearchResultOpen(path, line, column, origin), // Chat timeline path chips and cite links use the same open-then-revealPosition seam as search; resolves true only when the file actually opened.
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
      openLedgerChangeById: (changeId, options) => { const id = String(changeId || '').trim(); const ledger = options?.secondChat === true ? workspaceChats?.secondLedger() : getChangeLedger(); const change = id ? (ledger?.changes || []).find((entry) => String(entry?.changeId || '') === id) : null; return change ? openChangeDiff(change, { pane: options?.secondChat === true ? 1 : 0 }) : false; },
    };
  }

  return {
    createIdeController,
  };
});
