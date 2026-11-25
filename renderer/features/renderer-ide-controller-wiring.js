/* renderer/features/renderer-ide-controller-wiring.js - the dependency-heavy component
 * factories of renderer-ide-controller.js: the editor host (with its editor callbacks), the
 * workbench, the status bar, the tabs controller, the Git links + chat dock and the
 * view-scoped keydown handler. Split out of the controller for the file-size ceiling. Each
 * factory runs at the point the controller used to build that component and reads the
 * controller's other components through the lazy `parts` accessor `p` (getters: a name read
 * before its component exists throws, as the inline code did). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeControllerWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createEditorHost(p) {
    const { mods, getDom, appendClientLog, getIde, renderTabs, ideStateUtils } = p;
    return mods.editorHostUtils.createIdeEditorHost?.({
      getDocumentWorkspaceId: (path) => p.fileLifecycle?.fileOperations?.getDocumentToken(path)?.rootId || '',
      getDom,
      log: appendClientLog,
      onDirtyChange(path, dirty) {
        p.fileLifecycle?.noteDirty(path, dirty); ideStateUtils.setTabDirty?.(getIde(), path, dirty);
        renderTabs();
      },
      onSaveRequest() {
        p.saveActiveFile();
      },
      // PDF/DOCX panes: every mutation feeds the save fence (editVersion) and
      // nothing else -- no preview, gutter, or auto-save hooks for documents.
      onDocumentEdit(path) { p.fileLifecycle?.noteEdit(path); },
      onCursorActivity(info) {
        // Cursor choke point -> nav-bookmarks facade (drops the null non-file
        // diff/preview case; nav-history coalesces the rest).
        p.statusBar?.render(); p.qol?.outline?.noteCursor(); // the Outline follows any group's cursor
        // A focused group's cursor (W7) feeds the status bar only.
        if (p.editorHost?.getFocusedGroupPath?.()) return;
        p.navBookmarks?.recordCursorNav(info);
        // After statusBar (which owns #ideBreadcrumbs innerHTML) so the symbol
        // path segments survive its file-path render.
        p.symbolNav?.render();
      },
      onModelChange(path) {
        p.fileLifecycle?.noteEdit(path);
        p.qol?.previewStage?.handleModelChange(path);
        p.qol?.presentation?.noteEdit(); // recent-typing signal for presentation policy
        p.gutterDecorations?.schedule(path);
        p.autoSave?.onChange(path);
      },
      onGlyphMarginClick(line) { p.navBookmarks?.toggleAtGlyph(line); },
      onMonacoReady(monacoApi) {
        // Swap the load-time vs-dark default for the palette-matched theme.
        p.themeBridge?.handleMonacoReady(monacoApi);
        mods.editorPrefsUtils.applyEditorPrefs?.(getIde(), p.editorHost, p.chipPicker);
        p.selectionIntents?.registerActions();
        p.wordWrap?.registerAction(monacoApi);
        p.debugInspector?.registerActions(); p.runScripts?.registerActions(); p.ideCommands?.registerMonacoKeymap(monacoApi); // row 82: Ctrl+K chords
        p.symbolNav?.handleMonacoReady(monacoApi);
      },
    }) || null;
  }

  // Workbench (row 40 W3): the layout tree of splits and stacks. Every panel is a
  // SINGLE instance rendering into its own persistent view host and gated on its
  // view being visible; showPanel reveals a view wherever it lives.
  function createWorkbenchWiring(p) {
    const { mods, state, getDom, getIde, ideStateUtils } = p;
    return mods.workbenchWiringUtils.createIdeWorkbenchWiring?.({
      getDom, getIde: () => getIde(), ideStateUtils, schedulePersist: () => p.schedulePersist(), requestRender: () => p.renderIde(),
      focusEditor: () => p.focusIdeEditor(), focusTerminal: () => p.terminals?.focusTerminal?.() === true, canAdoptChatDock: () => state?.ui?.activeView !== 'board',
      // Problems shows only while there are markers of any severity (F7; the statusbar count stays);
      // test output only while the config it shows has output (F6).
      isViewAvailable: (id) => (id === 'activity' ? state.features?.featureFlags?.activity_monitor === true : id === 'test-runner' ? p.testRunnerWiring?.isAvailable() !== false
        : id === 'chat' || id === 'changes' ? state?.features?.featureFlags?.ide_chat_dock === true
          : id === 'problems' ? p.problemsPanel?.hasMarkers?.() === true
            : id === 'test-output' ? p.testOutputPanel?.hasOutput() === true : true),
      counts: {
        'source-control': () => p.gitFeature?.getDirtyCount() || 0,
        problems: () => p.problemCount(),
        activity: () => p.activityView?.getSnapshot()?.items.filter(row=>row.group !== 'finished').length || 0,
        changes: () => p.ideChatDock?.getChangesWaitingCount?.() || 0,
      },
      // New chat activity while that chat was off screen.
      unread: { chat: () => p.ideChatDock?.hasUnread?.() === true },
      // Row 190 Wave 4: the shown Chat tab names the dock's chat; a click on it opens the chat picker.
      labels: { run: () => p.runScripts?.getRunLabel?.() || '', chat: () => p.ideChatDock?.chatTabLabel?.(p.workbenchWiring?.workbench?.getActiveView?.('chat') === 'chat' && p.workbenchWiring?.isVisible?.('chat') === true) || '' },
      onActiveTabClick: { chat: (tab) => p.ideChatDock?.openSwitcher?.(tab) }, labelOverride: (id) => p.terminals?.labelOf(id) || '', // F5: the Run tab names its task; T2: a renamed terminal
      // Terminal headers (F3, T2): +, the shell-profile chevron and Kill, plus Rename in the More menu; the set owns them.
      viewActions: (id) => p.terminals?.viewActions(id) || [], onViewAction: (id, name, el) => p.terminals?.runViewAction(id, name, el), viewMenuItems: (id) => p.terminals?.menuItems(id) || [],
      getGroupElement: (id) => p.editorGroups?.getElement(id) || null, getEditorGroups: () => p.editorGroups,
    }) || null;
  }

  function createStatusBar(p) {
    const { mods, getDom, escapeHtml, getIde, isReviewTab } = p;
    return mods.statusBarUtils.createIdeStatusBar?.({
      getDom,
      escapeHtml,
      getIde: () => getIde(),
      callbacks: {
        getCursorInfo: () => p.editorHost?.getFocusedCursorInfo?.() || null, getStatusPath: () => p.editorHost?.getFocusedGroupPath?.() || '',
        getActiveLanguageId: () => p.editorHost?.getFocusedLanguageId?.() || '',
        getBranch: () => p.gitFeature?.getBranch() || '',
        getDirtyCount: () => p.gitFeature?.getDirtyCount() || 0,
        getProblemCounts: () => p.problemsPanel?.getCounts() || null,
        getBottomPanelOpen: () => p.bottomPanel?.isOpen() === true, getRunning: () => p.runScripts?.isRunning() === true,
        onSwitchBranch: () => p.branchSwitcher?.open(),
        onOpenProblems: () => p.bottomPanel?.open('problems'),
        onToggleBottomPanel: () => p.bottomPanel?.toggle(), onOpenRun: () => p.bottomPanel?.open('run'),
        getEol: (path) => p.editorHost?.getEol(path) || 'lf',
        getTabSize: () => p.editorHost?.getTabSize?.() || 2, getIndentInfo: (path) => p.editorHost?.getIndentInfo?.(path), getEncodingInfo: (path) => p.editorHost?.getEncodingInfo?.(path),
        onPickTabSize: (anchor) => p.chipPicker?.openTabSizePicker(anchor), onPickIndentation: (anchor) => p.chipPicker?.openIndentationPicker(anchor), onPickLanguage: (anchor) => p.chipPicker?.openLanguagePicker(anchor), onPickEncoding: (anchor) => p.chipPicker?.openEncodingInfo(anchor),
        onPickEol: (anchor) => p.chipPicker?.openEolPicker(anchor),
        isDirty: (path) => p.editorHost?.isDirty(path) === true,
        isDiffTab: isReviewTab,
        getDocumentKind: (path) => p.editorHost?.getDocumentKind(path) || '',
        isLargeFile: (path) => p.editorHost?.isLargeFile?.(path) === true,
        onGoToLine: () => p.editorHost?.triggerGoToLine(),
        onToggleWordWrap: () => p.wordWrap?.toggle(),
        getFollowJenny: () => p.qol?.follow?.getSwitch() ?? null, onToggleFollowJenny: () => p.qol?.follow?.toggleSwitch(),
      },
    }) || null;
  }

  function createTabsController(p) {
    const { mods, getDom, getIde, isDiffTab, isPreviewTab, showShellErrorToast, showToastMessage, toErrorMessage } = p;
    return mods.tabsControllerUtils.createIdeTabsController?.({
      getDom,
      getIde: () => getIde(),
      callbacks: {
        activateTab: (path) => p.activateTab(path),
        closeTab: (path) => p.requestCloseTab(path),
        closeOthers: (path) => p.closeOrchestrator?.requestCloseOthers(path),
        closeAll: () => p.closeOrchestrator?.requestCloseAll(),
        closeSaved: () => p.closeOrchestrator?.requestCloseSaved(),
        closeToRight: (path) => p.closeOrchestrator?.requestCloseToRight(path), reopenClosedTab: () => p.reopenClosedTab(), onCloseSurface: (surface) => p.qol?.stageSurface?.toggle(surface),
        openUnsavedCompare: (path) => p.openUnsavedCompare(path),
        isDirty: (path) => p.editorHost?.isDirty(path) === true,
        isDiffTabId: isDiffTab, isPreviewTabId: isPreviewTab,
        buildExtraMenuItems: (path, opts) => [...(opts?.review ? [] : p.buildFileContextMenuItems(path)), ...(p.editorGroups?.moveMenuItems(path) || [])],
        revealInExplorer: (path) => p.revealInExplorer(path), onDropTab: (payload, index) => p.editorGroups?.moveToGroup(payload.path, '', index),
        schedulePersist: () => p.schedulePersist(),
        renderTabs: () => p.renderTabs(),
        showShellErrorToast,
        showToastMessage,
        toErrorMessage,
      },
    }) || null;
  }

  // The Git links of the IDE's chat (row 40 W6 F8): Source Control marks the files Jenny changed in the
  // chat the dock shows, and the dock's Changes view reads that chat's turns. Pane 0 is the IDE's
  // chat: with two split-view panes it stays the chat the dock shows.
  const MARKER_DEBOUNCE_MS = 400;

  /**
   * @param {object} deps
   * @param {object} deps.state renderer state (ui.activeView, features, currentSessionId, workspaceRoot)
   * @param {() => object|null} deps.getWorkbench the workbench wiring (showPanel, viewDeps)
   * @param {() => object|null} [deps.getPaneComposition] split view's pane composition
   * @param {(sessionId?: string) => object[]} deps.getTurnViewModels pane 0's projected turns for a session
   * @param {(sessionId: string) => object[]} deps.getSessionMessages
   * @param {(vms: object[], meta: object) => object} deps.buildLedger buildJennyChangeLedgerFromTurnViewModels
   * @param {() => object|null} deps.getGitFeature isRepo / getDecoration / subscribe / refreshJennyMarkers
   * @param {object} deps.viewDeps the Changes view deps (diff openers, undo, escapeHtml, log)
   */
  function createGitLinks(deps = {}) {
    const state = deps.state || {};
    const getWorkbench = typeof deps.getWorkbench === 'function' ? deps.getWorkbench : () => null;
    const getPaneComposition = typeof deps.getPaneComposition === 'function'
      ? deps.getPaneComposition
      : () => globalThis.rendererAppPaneComposition?.getPaneComposition?.() || null;
    const getTurnViewModels = typeof deps.getTurnViewModels === 'function' ? deps.getTurnViewModels : () => [];
    const getSessionMessages = typeof deps.getSessionMessages === 'function' ? deps.getSessionMessages : () => [];
    const buildLedger = typeof deps.buildLedger === 'function' ? deps.buildLedger : () => ({ changes: [] });
    const getGitFeature = typeof deps.getGitFeature === 'function' ? deps.getGitFeature : () => null;
    const setTimer = typeof deps.setTimeout === 'function' ? deps.setTimeout : (fn, ms) => setTimeout(fn, ms);
    const clearTimer = typeof deps.clearTimeout === 'function' ? deps.clearTimeout : (id) => clearTimeout(id);
    let disposed = false;

    const isFlagOn = () => state.features?.featureFlags?.ide_chat_dock === true;
    const inWorkspace = () => state.ui?.activeView === 'ide';
    const workspaceId = () => String(state.workspaceRoot?.rootId || '');

    /** The chat the IDE shows (pane 0): its own session with two panes, else the current one. */
    function primarySessionId() {
      const panes = getPaneComposition();
      const split = panes && typeof panes.getPaneCount === 'function' && panes.getPaneCount() > 1;
      const id = split && typeof panes.getPaneSessionId === 'function' ? panes.getPaneSessionId(0) : '';
      return String(id || state.currentSessionId || '');
    }

    function getGitState(path) {
      const git = getGitFeature();
      if (!git || git.isRepo?.() !== true) return null;
      return git.getDecoration?.(path) ? 'changed' : 'clean';
    }

    function subscribeGit(fn) {
      return getGitFeature()?.subscribe?.(fn) || null;
    }

    // Open in Git shows Source Control, brings the file's row into view and focuses it, as the
    // Jenny marker focuses Changes: Changes may share Git's stack and have just been hidden.
    function openInGit(path) {
      const workbench = getWorkbench();
      workbench?.showPanel?.('source-control');
      const rows = workbench?.viewDeps?.('source-control')?.getMountEl?.()?.querySelectorAll?.('[data-ide-scm-path]') || [];
      const row = Array.from(rows).find((item) => item.getAttribute('data-ide-scm-path') === String(path || ''));
      row?.scrollIntoView?.({ block: 'nearest' });
      row?.querySelector?.('[data-ide-scm-action="diff"]')?.focus?.();
    }

    // Path -> Jenny's latest change to it in the IDE's chat, rebuilt only when its turns change.
    let jennyIndex = { sessionId: '', vms: [], byPath: new Map() };
    function jennyIndexNow() {
      const sessionId = primarySessionId();
      const vms = getTurnViewModels(sessionId) || [];
      const same = sessionId === jennyIndex.sessionId && vms.length === jennyIndex.vms.length
        && vms.every((vm, i) => vm === jennyIndex.vms[i]);
      if (!same) {
        const byPath = new Map();
        for (const change of buildLedger(vms, { sessionId, workspaceId: workspaceId() }).changes || []) {
          byPath.set(change.path, { turnId: change.turnId, fileKey: change.fileKey });
        }
        jennyIndex = { sessionId, vms: vms.slice(), byPath }; // a copy: an array grown in place must still read as changed
      }
      return jennyIndex;
    }

    /** Jenny's change to `path` in the IDE's chat, or null (always null without the dock: Changes lives there). */
    function jennyChangeFor(path) {
      if (!isFlagOn()) return null;
      return jennyIndexNow().byPath.get(String(path || '')) || null;
    }

    // The markers follow the ledger: a chat render re-checks it (debounced) and repaints Source Control on a change.
    let markerSig = '';
    let markerIndex = null;
    let markerTimer = null;
    function scheduleMarkerRefresh() {
      if (disposed || markerTimer || !inWorkspace()) return;
      markerTimer = setTimer(() => {
        markerTimer = null;
        if (disposed) return;
        // An unchanged index (the same turns) cannot move a marker: skip the signature.
        const index = jennyIndexNow();
        if (index === markerIndex) return;
        markerIndex = index;
        const sig = Array.from(index.byPath, ([path, c]) => `${path}\x1f${c.turnId}\x1f${c.fileKey}`).join('\x1e');
        if (sig === markerSig) return;
        markerSig = sig;
        getGitFeature()?.refreshJennyMarkers?.();
      }, MARKER_DEBOUNCE_MS);
    }

    // The dock's Changes view deps: its chat's pane (pane 0) names itself on the diffs it opens (W7c).
    const shared = deps.viewDeps || {};
    const viewDeps = {
      ...shared,
      openChangeDiff: (change) => shared.openChangeDiff?.(change, { pane: 0 }),
      openSuggestionDiff: (sessionId, id) => shared.openSuggestionDiff?.(sessionId, id, { pane: 0 }),
      getGitState, subscribeGit, openInGit,
      getTurnViewModels: () => getTurnViewModels(primarySessionId()) || [],
      getSessionId: primarySessionId,
      getWorkspaceId: workspaceId,
      getSessionMessages: () => getSessionMessages(primarySessionId()) || [],
    };

    function dispose() {
      if (disposed) return;
      disposed = true;
      if (markerTimer) clearTimer(markerTimer);
      markerTimer = null;
    }

    return { viewDeps, primarySessionId, jennyChangeFor, openInGit, scheduleMarkerRefresh, dispose };
  }

  // The Workspace Chat Dock (ide_chat_dock): the chat subtree relocated into the
  // workbench's chat view. The module owns the session row + the idempotent
  // host reconcile; the chat render pipeline ALSO drives reconcile() from the
  // top of renderLayout before visibility toggles. New-chat
  // reuses the live #newChatButton handler (the button stays in #chatView).
  function createChatSurfaces(p) {
    const {
      mods, state, getDom, getIde, appendClientLog, showShellErrorToast, callbacks, getTurnViewModelsForActiveSession,
      getSessionMessages, getChangesUndoController, activateWorkspaceSession, escapeHtml,
    } = p;
    const { ledgerUtils } = mods;
    const gitLinks = createGitLinks({
      state, getWorkbench: () => p.workbenchWiring, getTurnViewModels: (sessionId) => getTurnViewModelsForActiveSession(sessionId) || [],
      getSessionMessages: (sessionId) => getSessionMessages(String(sessionId || '')) || [], buildLedger: ledgerUtils.buildJennyChangeLedgerFromTurnViewModels,
      getGitFeature: () => p.gitFeature,
      viewDeps: {
        buildLedger: ledgerUtils.buildJennyChangeLedgerFromTurnViewModels, openChangeDiff: (change, origin) => p.openChangeDiff(change, origin), getUndoController: getChangesUndoController,
        escapeHtml, appendClientLog, openSuggestionDiff: (sessionId, id, origin) => p.openDiffFrom(origin, () => p.diffController?.openSuggestionDiff(sessionId, id), p.diffController?.suggestionDiffId(sessionId)),
      },
    });
    // shared: the one controller of this app state; the Board page adds itself to the same one (row 150).
    const ideChatDock = mods.chatDockUtils.createIdeChatDock?.({
      shared: true, state, getDom, getIde: () => getIde(),
      layoutIdeEditor: () => p.layoutIdeEditor(), focusEditor: p.focusIdeEditor,
      // The workbench owns open/closed (the chat stack), the Chat | Changes tabs and the Changes host.
      workbench: p.workbenchWiring ? {
        setOpen: (open) => p.workbenchWiring.setChatOpen(open), reveal: (id) => p.workbenchWiring.showPanel(id),
        isVisible: (id) => p.workbenchWiring.isVisible(id), getChangesHost: () => p.panelDeps('changes').getMountEl?.() || null,
        onCountChange: () => { if (state.ui?.activeView === 'ide') p.workbenchWiring.render(); }, // the Changes tab's waiting count; chrome only
      } : null,
      onNewChat: () => getDom().ideChatDock?.ownerDocument?.getElementById('newChatButton')?.click(),
      onSelectSession: (sessionId) => activateWorkspaceSession(sessionId),
      showShellErrorToast, appendClientLog, noteProgrammaticWrite: (reason) => callbacks.noteScrollProgrammaticWrite?.(reason),
      // Split view: the dock hosts pane 0, so pane 0 holds focus while docked.
      onHostChanged: (docked) => globalThis.rendererAppPaneComposition?.getPaneComposition?.()?.handleChatDocked?.(docked),
      // Chat | Changes tabs (row 34 S5): the IDE script manifest has already loaded the view.
      changesView: { loadChangesView: async () => globalThis.rendererChangesView || null, viewDeps: gitLinks.viewDeps, onSync: () => gitLinks.scheduleMarkerRefresh() },
    }) || null;
    return { gitLinks, ideChatDock };
  }

  // View-scoped keymap (capture phase on #ideView; row 82). The dispatcher and the
  // keymap / palette / status-bar command rows live in renderer-ide-commands and its
  // registrars; the controller keeps the listener wiring.
  function createViewKeydownHandler(p) {
    const {
      mods, state, getIde, saveActiveFile, saveFile, appendClientLog, showToastMessage, windowRef, callbacks,
      revealInExplorer, commitEditorPreference, reopenClosedTab, showPanel,
    } = p;
    return mods.commandsUtils.createViewKeydownHandler?.({
      state, getIde, saveActiveFile, saveFile, tabsController: p.tabsController, quickOpen: p.quickOpen, editorHost: p.editorHost, workbenchWiring: p.workbenchWiring, chipPicker: p.chipPicker, appendClientLog, showToastMessage, isRepo: () => p.gitFeature?.isRepo?.() === true,
      bottomPanel: p.bottomPanel, newTerminal: () => p.newTerminalAction()?.(), canAddTerminal: () => p.terminals?.canAdd?.() === true, terminals: p.terminals, getActiveTerminalViewId: () => p.terminals?.activeViewId?.() || p.workbenchWiring?.workbench?.getActiveView?.('terminal') || 'terminal',
      revealInExplorer, chooseWorkspaceRoot: () => p.chooseWorkspaceRoot(), getWorkspaceRoot: () => state.workspaceRoot || null, getClipboardApi: () => windowRef.jennyShell?.clipboard || null, getCloseOrchestrator: () => p.closeOrchestrator, getFileLifecycle: () => p.fileLifecycle, problemsPanel: p.problemsPanel, runScripts: p.runScripts,
      commitEditorPreference, applyEditorPrefs: () => mods.editorPrefsUtils.applyEditorPrefs?.(getIde(), p.editorHost, p.chipPicker), previewActiveFile: () => p.qol?.previewStage?.openActiveFile(),
      chatDock: p.ideChatDock, isChatDockEnabled: () => state?.features?.featureFlags?.ide_chat_dock === true,
      mruSwitcher: p.qol?.mruSwitcher || null, editorGroups: p.editorGroups, getOutlineView: () => p.qol?.outline || null,
      reopenClosedTab, showPanel, gitFeature: p.gitFeature, gutterDecorations: p.gutterDecorations, openEditorSettings: () => callbacks.openSettingsSection?.('editor'),
      workspaceSymbolPicker: () => p.symbolNav?.openPicker(),
      navBack: () => p.navBookmarks?.back(),
      navForward: () => p.navBookmarks?.forward(),
      ...(p.navBookmarks?.bookmarkActions),
      ideCommands: p.ideCommands, follow: p.qol?.follow || null,
      keyboardUtils: mods.keyboardUtils, getStageSurface: () => p.qol?.stageSurface?.getEffectiveSurface?.() || 'editor', exitStageSurface: () => p.qol?.stageSurface?.activate('editor'),
      windowRef,
    }) || (() => {});
  }

  return {
    createEditorHost, createWorkbenchWiring, createStatusBar, createTabsController, createChatSurfaces, createGitLinks, createViewKeydownHandler,
  };
});
