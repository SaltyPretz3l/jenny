/* renderer/features/renderer-ide-controller-modules.js - the sibling-module table of
 * renderer-ide-controller.js: every collaborator the controller composes, resolved the same way
 * it always was (the browser global the manifest loaded, else a Node require; an unavailable
 * module degrades to an empty object so the controller's `?.` guards keep working). Split out of
 * the controller for the file-size ceiling. Requires resolve relative to this directory. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeControllerModules = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

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

  // name -> [browser global, require path]
  const MODULES = {
    ideStateUtils: ['rendererIdeState', './renderer-ide-state'],
    editorHostUtils: ['rendererIdeEditorHost', './renderer-ide-editor-host'],
    tabsUtils: ['rendererIdeTabs', './renderer-ide-tabs'],
    wiringUtils: ['rendererIdeExplorerWiring', './renderer-ide-explorer-wiring'],
    workbenchWiringUtils: ['rendererIdeWorkbenchWiring', './renderer-ide-workbench-wiring'],
    stageSwitchUtils: ['rendererIdeStageSwitch', './renderer-ide-stage-switch'],
    searchPanelUtils: ['rendererIdeSearchPanel', './renderer-ide-search-panel'],
    statusBarUtils: ['rendererIdeStatusBar', './renderer-ide-statusbar'],
    ledgerUtils: ['rendererJennyChangeLedger', '../chat/renderer-jenny-change-ledger'],
    tabsControllerUtils: ['rendererIdeTabsController', './renderer-ide-tabs-controller'],
    quickOpenUtils: ['rendererIdeQuickOpen', './renderer-ide-quick-open'],
    previewControllerUtils: ['rendererIdePreviewController', './renderer-ide-preview-controller'],
    diffControllerUtils: ['rendererIdeDiffController', './renderer-ide-diff-controller'],
    themeBridgeUtils: ['rendererIdeThemeBridge', './renderer-ide-theme-bridge'],
    actionButton: ['inventoryActionButton', '../inventory/action-button'],
    pathMenuUtils: ['rendererIdePathMenu', './renderer-ide-path-menu'],
    welcomeUtils: ['rendererIdeWelcome', './renderer-ide-welcome'],
    ideShortcutsUtils: ['rendererIdeShortcuts', './renderer-ide-shortcuts'],
    selectionIntentsUtils: ['rendererIdeSelectionIntents', './renderer-ide-selection-intents'],
    closedTabsUtils: ['rendererIdeClosedTabs', './renderer-ide-closed-tabs'],
    confirmDialogUtils: ['rendererIdeConfirmDialog', './renderer-ide-confirm-dialog'],
    closeOrchestratorUtils: ['rendererIdeCloseOrchestrator', './renderer-ide-close-orchestrator'],
    helpOverlayUtils: ['inventoryHelpOverlay', '../inventory/help-overlay'],
    watchControllerUtils: ['rendererIdeWatchController', './renderer-ide-watch-controller'],
    chipPickerUtils: ['rendererIdeChipPicker', './renderer-ide-chip-picker'],
    editorPrefsUtils: ['rendererIdeEditorPrefs', './renderer-ide-editor-prefs'],
    popoverUtils: ['inventoryPopover', '../inventory/popover'],
    gitFeatureUtils: ['rendererIdeGitFeature', './renderer-ide-git-feature'],
    problemsPanelUtils: ['rendererIdeProblemsPanel', './renderer-ide-problems-panel'],
    debugInspectorUtils: ['rendererIdeDebugInspector', './renderer-ide-debug-inspector'],
    layoutModel: ['jennyWorkbenchLayoutModel', '../shared/workbench-layout-model'],
    mruUtils: ['rendererIdeMru', './renderer-ide-mru'],
    chatDockUtils: ['rendererIdeChatDock', './renderer-ide-chat-dock'],
    workspaceChatsUtils: ['rendererIdeWorkspaceChats', './renderer-ide-workspace-chats'],
    layoutUtils: ['rendererIdeLayout', './renderer-ide-layout'],
    commandsUtils: ['rendererIdeCommands', './renderer-ide-commands'],
    navBookmarksUtils: ['rendererIdeNavBookmarks', './renderer-ide-nav-bookmarks'],
    autoSaveUtils: ['rendererIdeAutoSave', './renderer-ide-auto-save'],
    branchSwitcherUtils: ['rendererIdeBranchSwitcher', './renderer-ide-branch-switcher'],
    keyboardUtils: ['rendererChatKeyboardUtils', '../chat/renderer-chat-keyboard-utils'],
    gutterDecorationsUtils: ['rendererIdeGutterDecorations', './renderer-ide-gutter-decorations'],
    symbolNavUtils: ['rendererIdeSymbolNav', './renderer-ide-symbol-nav'],
    tabRestoreUtils: ['rendererIdeTabRestore', './renderer-ide-tab-restore'],
    terminalSetUtils: ['rendererIdeTerminalSet', './renderer-ide-terminal-set'],
    ptyTerminalPanelUtils: ['rendererIdePtyTerminalPanel', './renderer-ide-pty-terminal-panel'],
    editorGroupsWiringUtils: ['rendererIdeEditorGroupsWiring', './renderer-ide-editor-groups-wiring'],
    runScriptsUtils: ['rendererIdeRunScripts', './renderer-ide-run-scripts'],
    activityWiringUtils: ['rendererIdeActivityWiring', './renderer-ide-activity-wiring'],
    persistenceUtils: ['rendererIdePersistence', './renderer-ide-persistence'],
    qolWiringUtils: ['rendererIdeQolWiring', './renderer-ide-qol-wiring'],
    fileLifecycleUtils: ['rendererIdeFileLifecycle', './renderer-ide-file-lifecycle'],
    viewLifecycleUtils: ['rendererIdeViewLifecycle', './renderer-ide-view-lifecycle'],
    controllerWiringUtils: ['rendererIdeControllerWiring', './renderer-ide-controller-wiring'],
  };

  function resolveControllerModules() {
    const resolved = {};
    for (const [name, [globalName, requirePath]] of Object.entries(MODULES)) {
      resolved[name] = resolveModule(globalName, requirePath);
    }
    return resolved;
  }

  return { resolveControllerModules };
});
