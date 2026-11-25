/* renderer/shell/renderer-shell-artifact-rails.js - the lazily built rails of the artifact side panel.
 *
 * Split out of renderer-shell-artifact-bridge.js (which builds one per bridge): the Changes undo controller,
 * the code-review, file-preview, task, subagent and project-notes rails, the memory chip / notes entries, and the
 * lazily loaded Background tasks panel with its always-present global API (window.rendererBackgroundTasksPanel), and the
 * lazily loaded chat Terminal panel (row 178, window.rendererChatTerminalPanel while the flag and the pty bridge exist).
 * Each is built once on first use, bound to the stable #artifactReviewPanel container and torn down through
 * registerCleanup; a construction failure is logged and degrades to "no owner". The artifact surface stays
 * with the bridge and is read through getSurface().
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellArtifactRails = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  const jt = (k, d) => (globalRef.jennyI18n && typeof globalRef.jennyI18n.t === 'function' ? globalRef.jennyI18n.t(k, d) : d);
  function noop() {}

  function createShellArtifactRails(ctx) {
    const {
      state,
      windowRef,
      escapeHtml,
      callbacks,
      codeReviewRailDeps,
      registerCleanup,
      sidePanel,
      appendClientLog,
      showToastMessage,
      renderAll,
      setActiveView,
      getSurface,
      ensureArtifactSurface,
      resolveArtifactReviewPanelEl,
      artifactFilePreviewModule,
      taskRailModule,
      subagentRailModule,
    } = ctx;
    let codeReviewRailController = null;
    let codeReviewRailBound = false;
    let filePreviewController = null;
    let filePreviewBound = false;
    let taskRailController = null;
    let subagentRailController = null;
    // Project Notes (renderer-project-notes-entry.js is always loaded; the rail loads lazily).
    let projectNotesRailController = null;
    let projectNotesEntry = null;
    let memoryChatEntry = null;
    // The browser panel (row 114) loads the first time a chat has its Browser row on.
    const BROWSER_PANEL_SCRIPTS = [
      ['renderer/chat/renderer-browser-use-placement.js', 'rendererBrowserUsePlacement'],
      ['renderer/chat/renderer-browser-use-status.js', 'rendererBrowserUseStatus'],
      ['renderer/chat/renderer-browser-use-bar.js', 'rendererBrowserUseBar'],
      ['renderer/chat/renderer-browser-use-panel.js', 'rendererBrowserUsePanel'],
    ];
    let browserPanel = null;
    let browserPanelFailed = false;
    let browserPanelSync = null; // while loading: the newest sync
    // Row 138: the Background tasks panel loads on first open; its global API exists from startup.
    const BACKGROUND_TASKS_SCRIPTS = [['renderer/features/renderer-background-tasks-panel-render.js', 'rendererBackgroundTasksPanelRender'], ['renderer/features/renderer-background-tasks-panel.js', 'rendererBackgroundTasksPanelOwner']];
    let backgroundTasksPanel = null;
    // Row 195: the tab strip's count (Runs), dot (Project) and the Session tab's "Running now" re-read on this event.
    // Sent after the caller returns and once per burst: a signal raised while the strip is rendering must not re-enter it.
    let signalQueued = false;
    const signalsChanged = () => {
      if (signalQueued) return;
      signalQueued = true;
      Promise.resolve().then(() => { signalQueued = false;
        try { windowRef?.dispatchEvent?.(new windowRef.Event('jenny:side-signals-changed')); } catch (_error) { /* no listener, no event */ }
      });
    };
    // Row 178: the chat Terminal panel loads on first open; its global API exists from startup (with the pty bridge and the flag).
    const TERMINAL_PANEL_SCRIPTS = [['renderer/chat/renderer-chat-terminal-panel-render.js', 'rendererChatTerminalPanelRender'], ['renderer/chat/renderer-chat-terminal-panel.js', 'rendererChatTerminalPanelOwner']];
    let terminalPanel = null;

    // One Changes undo controller for both hosts (row 34 S5): the IDE chat
    // dock and the side panel. Created once its lazily loaded script is ready.
    let changesUndoController = null;
    function getChangesUndoController() {
      const factory = globalRef.rendererChangesUndo?.createChangesUndo;
      if (changesUndoController || typeof factory !== 'function') return changesUndoController;
      const renderDiffHunks = codeReviewRailDeps.renderDiffHunks;
      changesUndoController = factory({
        getSessionId: () => String(state.currentSessionId || ''),
        showToast: (...args) => showToastMessage(...args),
        requestRender: () => renderAll(),
        renderDiffBody: typeof renderDiffHunks === 'function'
          ? (change) => renderDiffHunks(change.hunks, escapeHtml, { path: change.path })
          : null,
        escapeHtml,
        appendClientLog: (...args) => appendClientLog(...args),
      });
      registerCleanup(() => changesUndoController?.dispose?.());
      return changesUndoController;
    }

    function ensureCodeReviewRail() {
      if (codeReviewRailController || !getSurface()) {
        return codeReviewRailController;
      }
      const railFactory = codeReviewRailDeps.codeReviewRailFactory;
      const buildLedger = codeReviewRailDeps.buildJennyChangeLedgerFromTurnViewModels;
      const renderDiffHunks = codeReviewRailDeps.renderDiffHunks;
      if (typeof railFactory !== 'function') {
        return null;
      }
      // In split view the review belongs to the chat that owns the side panel.
      const getSessionId = () => String(sidePanel.getSessionId() || '');
      try {
        codeReviewRailController = railFactory({
          state,
          // Same undefined-eager-dep root cause as ensurePanelV2: pass the
          // getElementById-resolved container so the rail's bind() attaches its
          // keydown listener instead of early-returning on a null dep.
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          loadChangesView: codeReviewRailDeps.loadChangesView,
          buildJennyChangeLedgerFromTurnViewModels: typeof buildLedger === 'function' ? buildLedger : null,
          renderDiffBody: typeof renderDiffHunks === 'function'
            ? (change) => (change && Array.isArray(change.hunks) && change.hunks.length
              ? renderDiffHunks(change.hunks, escapeHtml, { path: change.path })
              : '')
            : null,
          getTurnViewModelsForActiveSession: () => codeReviewRailDeps.getTurnViewModelsForActiveSession?.(getSessionId()) || [],
          getActiveSessionId: getSessionId,
          getWorkspaceId: codeReviewRailDeps.getWorkspaceId || (() => 'default'),
          getSessionMessages: () => codeReviewRailDeps.getSessionMessages?.(getSessionId()) || [],
          openInWorkspace: codeReviewRailDeps.openChangeInWorkspace || null,
          claimOwner: (sessionId) => sidePanel.claim(sessionId),
          getUndoController: getChangesUndoController,
          setArtifactRailMode: (mode) => getSurface()?.setArtifactRailMode?.(mode),
          openArtifactRail: (mode) => getSurface()?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => getSurface()?.renderArtifactReviewPanel?.(),
          syncArtifactReviewLayout: () => getSurface()?.syncArtifactReviewLayout?.(),
          appendClientLog: (...args) => appendClientLog(...args),
          showComposerActionError: codeReviewRailDeps.showComposerActionError || noop,
          escapeHtml,
        });
        if (codeReviewRailController && !codeReviewRailBound) {
          codeReviewRailController.bind?.();
          codeReviewRailBound = true;
          registerCleanup(() => codeReviewRailController?.dispose?.());
        }
      } catch (error) {
        codeReviewRailController = null;
        codeReviewRailBound = false;
        appendClientLog('ERROR', 'code_review.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return codeReviewRailController;
    }

    // Read-only chat-rail file preview (file_preview rail mode). Same lazy
    // shape as ensureCodeReviewRail: built once, after the surface controller
    // exists, bound to the stable #artifactReviewPanel container, and torn
    // down through registerCleanup. A construction failure is logged and
    // degrades to "no preview owner", which makes openFilePreviewTarget
    // resolve false so the chat click falls back to the IDE ladder.
    function ensureFilePreviewController() {
      if (filePreviewController || !getSurface()) {
        return filePreviewController;
      }
      if (typeof artifactFilePreviewModule?.createArtifactFilePreview !== 'function') {
        return null;
      }
      try {
        filePreviewController = artifactFilePreviewModule.createArtifactFilePreview({
          state,
          windowRef,
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          escapeHtml,
          getWorkspaceFsApi: () => (windowRef?.jennyShell?.workspaceFs) || null,
          markdownUtils: windowRef?.markdownUtils || globalRef.markdownUtils || null,
          codeHighlight: windowRef?.rendererCodeHighlight || globalRef.rendererCodeHighlight || null,
          frameUtils: windowRef?.rendererHtmlArtifactFrameUtils || globalRef.rendererHtmlArtifactFrameUtils || null,
          openArtifactRail: (mode) => getSurface()?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => getSurface()?.renderArtifactReviewPanel?.(),
          syncArtifactReviewLayout: () => getSurface()?.syncArtifactReviewLayout?.(),
          appendClientLog: (...args) => appendClientLog(...args),
          showToastMessage: (...args) => showToastMessage(...args),
        });
        if (filePreviewController && !filePreviewBound) {
          filePreviewController.bind?.();
          filePreviewBound = true;
          registerCleanup(() => filePreviewController?.dispose?.());
          // A committed workspace-root switch invalidates the preview: its
          // bytes belong to the OLD root while its path now resolves in the
          // new one. Event dispatched by refreshWorkspaceRootDependents.
          const onRootCommitted = () => filePreviewController?.handleWorkspaceRootCommitted?.();
          if (typeof windowRef?.addEventListener === 'function') {
            windowRef.addEventListener('workspace:root-committed', onRootCommitted);
            registerCleanup(() => windowRef.removeEventListener('workspace:root-committed', onRootCommitted));
          }
        }
      } catch (error) {
        filePreviewController = null;
        filePreviewBound = false;
        appendClientLog('ERROR', 'artifact_file_preview.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return filePreviewController;
    }

    function ensureTaskRailController() {
      if (taskRailController) {
        taskRailController.bind?.();
        return taskRailController;
      }
      if (typeof taskRailModule?.createTaskRail !== 'function') return null;
      try {
        const documentRef = windowRef?.document;
        const chatInput = documentRef?.getElementById?.('chatInput') || null;
        taskRailController = taskRailModule.createTaskRail({
          state,
          windowRef,
          dom: {
            artifactReviewPanel: resolveArtifactReviewPanelEl(),
            utilityCluster: documentRef?.getElementById?.('chatTimelineUtilityCluster') || null,
            chatInput,
          },
          escapeHtml,
          openArtifactRail: (mode) => ensureArtifactSurface()?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => ensureArtifactSurface()?.renderArtifactReviewPanel?.(),
          toggleArtifactReview: () => ensureArtifactSurface()?.toggleArtifactReview?.(),
          activateWorkspaceSession: (sessionId) => callbacks.activateWorkspaceSession?.(sessionId),
          // The rail's project scope menu reuses the shared (lazy) project switcher.
          getProjectSwitcher: () => callbacks.getProjectSwitcher?.(),
          setActiveView: (...args) => setActiveView(...args),
          // The composer's own input listener resizes the textarea.
          syncComposerInputHeight: () => chatInput?.dispatchEvent?.(new windowRef.Event('input', { bubbles: true })),
          renderAll: (...args) => renderAll(...args),
          appendClientLog: (...args) => appendClientLog(...args),
          showToastMessage: (...args) => showToastMessage(...args),
          onSignalsChanged: signalsChanged,
          openNotes: () => ensureProjectNotesEntry()?.open?.(), // the entry loads the Notes modules on first use
        });
        taskRailController?.bind?.();
        registerCleanup(() => taskRailController?.dispose?.());
      } catch (error) {
        taskRailController = null;
        appendClientLog('ERROR', 'task_rail.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return taskRailController;
    }

    // The Subagent Monitor rail (renderer-subagent-rail.js): late-bound like the
    // task rail, published on windowRef.rendererSubagentRailHost for the pane
    // monitor controllers, which never see the surface controller directly.
    function ensureSubagentRail() {
      if (subagentRailController) return subagentRailController;
      if (typeof subagentRailModule?.createSubagentRail !== 'function') return null;
      try {
        subagentRailController = subagentRailModule.createSubagentRail({
          state,
          windowRef,
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          openArtifactRail: (mode) => ensureArtifactSurface()?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => getSurface()?.renderArtifactReviewPanel?.(),
          restoreArtifactReviewPrefs: (patch) => getSurface()?.restoreArtifactReviewPrefs?.(patch),
          // Building the surface loads the persisted prefs the snapshot reads.
          getPrefs: () => { ensureArtifactSurface(); return state.ui?.artifactReview || {}; },
          getPanelSessionId: () => sidePanel.getSessionId(),
        });
        subagentRailController?.bind?.();
        registerCleanup(() => subagentRailController?.dispose?.());
      } catch (error) {
        subagentRailController = null;
        appendClientLog('ERROR', 'subagent_rail.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return subagentRailController;
    }

    // The always-loaded Notes entry (toggle, chat rows). Built once the module is
    // present; an absent module stays null and the next ensure retries.
    function ensureProjectNotesEntry() {
      if (projectNotesEntry) return projectNotesEntry;
      if (typeof windowRef?.rendererProjectNotesEntry?.createProjectNotesEntry !== 'function') return null;
      try {
        const documentRef = windowRef?.document;
        projectNotesEntry = windowRef.rendererProjectNotesEntry.createProjectNotesEntry({
          state,
          windowRef,
          escapeHtml,
          dom: {
            utilityCluster: documentRef?.getElementById?.('chatTimelineUtilityCluster') || null,
            artifactReviewPanel: resolveArtifactReviewPanelEl(),
          },
          appendClientLog: (...args) => appendClientLog(...args),
          showToastMessage: (...args) => showToastMessage(...args),
          // The rail loads lazily: asking for the host builds it once its modules are present.
          getHost: () => { ensureProjectNotesRail(); return windowRef.rendererProjectNotesHost || null; },
          onSignalsChanged: signalsChanged,
        }) || null;
        projectNotesEntry?.bind?.();
        const built = projectNotesEntry;
        registerCleanup(() => built?.dispose?.());
      } catch (error) {
        projectNotesEntry = null;
        appendClientLog('ERROR', 'project_notes.entry_init_failed', { message: error?.message || String(error) });
        return null;
      }
      return projectNotesEntry;
    }

    // The memory chip's Undo delegate (renderer-memory-chat-entry.js, row 58 W1).
    function ensureMemoryChatEntry() {
      if (memoryChatEntry) return memoryChatEntry;
      if (typeof windowRef?.rendererMemoryChatEntry?.createMemoryChatEntry !== 'function') return null;
      try {
        memoryChatEntry = windowRef.rendererMemoryChatEntry.createMemoryChatEntry({
          state, windowRef,
          appendClientLog: (...args) => appendClientLog(...args),
          showToastMessage: (...args) => showToastMessage(...args),
        }) || null;
        memoryChatEntry?.bind?.();
        const built = memoryChatEntry;
        registerCleanup(() => built?.dispose?.());
      } catch (error) {
        memoryChatEntry = null;
        appendClientLog('ERROR', 'memory.chat_entry_init_failed', { message: error?.message || String(error) });
      }
      return memoryChatEntry;
    }

    // The Project Notes rail (renderer-project-notes-rail.js): resolved at CALL
    // time because the modules load on first open. Publishes the host the entry drives.
    function ensureProjectNotesRail() {
      if (projectNotesRailController) return projectNotesRailController;
      if (typeof windowRef?.rendererProjectNotesRail?.createProjectNotesRail !== 'function') return null;
      try {
        const controller = windowRef.rendererProjectNotesRail.createProjectNotesRail({
          state,
          windowRef,
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          escapeHtml,
          openArtifactRail: (mode) => ensureArtifactSurface()?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => ensureArtifactSurface()?.renderArtifactReviewPanel?.(),
          toggleArtifactReview: () => ensureArtifactSurface()?.toggleArtifactReview?.(),
          getProjectSwitcher: () => callbacks.getProjectSwitcher?.(),
          getEntry: () => projectNotesEntry,
          appendClientLog: (...args) => appendClientLog(...args),
          showToastMessage: (...args) => showToastMessage(...args),
        });
        controller.bind?.();
        const host = {
          open: () => controller.open() === true,
          toggle: () => { controller.toggle(); return true; },
          isOpen: () => controller.isOpen() === true,
          refresh: () => controller.refresh(),
          markSeen: (...args) => projectNotesEntry?.markSeen?.(...args),
        };
        windowRef.rendererProjectNotesHost = host;
        registerCleanup(() => {
          controller.dispose?.();
          if (windowRef.rendererProjectNotesHost === host) delete windowRef.rendererProjectNotesHost;
        });
        projectNotesRailController = controller;
      } catch (error) {
        projectNotesRailController = null;
        appendClientLog('ERROR', 'project_notes.rail_init_failed', { message: error?.message || String(error) });
        return null;
      }
      return projectNotesRailController;
    }

    // Row 195: a helper's row in Runs opens that helper's page (renderer-subagent-rail.js presses its card).
    const openHelper = (target) => subagentRailModule?.openHelperRun?.({
      ...target, doc: windowRef?.document, panes: state.panes?.panes, panel: resolveArtifactReviewPanelEl,
    }) === true;

    function ensureBackgroundTasksPanel() {
      const owner = windowRef?.rendererBackgroundTasksPanelOwner;
      if (backgroundTasksPanel || typeof owner?.createBackgroundTasksPanel !== 'function') return backgroundTasksPanel;
      try {
        const panel = owner.createBackgroundTasksPanel({
          state,
          windowRef,
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          openArtifactRail: (mode) => ensureArtifactSurface()?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => ensureArtifactSurface()?.renderArtifactReviewPanel?.(),
          toggleArtifactReview: () => ensureArtifactSurface()?.toggleArtifactReview?.(),
          claimOwner: (sessionId) => sidePanel.claim(sessionId),
          getPanelSessionId: () => sidePanel.getSessionId(),
          openSession: (sessionId) => callbacks.activateWorkspaceSession?.(sessionId, { mode: 'replace' }),
          stopSession: owner.createStopSession({ stopSessionStream: (id) => callbacks.stopSessionStream?.(id), getChat: () => windowRef?.jennyShell?.chat }),
          appendClientLog: (...args) => appendClientLog(...args),
          getMessages: (sessionId) => state.messagesBySession?.get?.(sessionId) || [],
          openHelper,
          onSignalsChanged: signalsChanged,
        });
        panel.bind();
        registerCleanup(() => panel.dispose());
        backgroundTasksPanel = panel;
      } catch (error) {
        appendClientLog('ERROR', 'background_tasks.panel_init_failed', { message: error?.message || String(error) });
      }
      return backgroundTasksPanel;
    }

    // ensureScript answers at once for a loaded script and shares one load between concurrent callers.
    const loadScripts = async (list) => {
      for (const [src, name] of list) if (!await windowRef?.scriptLoaderUtils?.ensureScript?.({ src, isReady: () => Boolean(windowRef?.[name]), log: appendClientLog })) return false;
      return true;
    };
    const loadBackgroundTasksPanel = async () => ((await loadScripts(BACKGROUND_TASKS_SCRIPTS)) ? ensureBackgroundTasksPanel() : null);

    // The More menu and the session rail's rows call this; it loads the panel on first use.
    const backgroundTasksApi = {
      async open(options) {
        if (!ensureBackgroundTasksPanel()) await loadBackgroundTasksPanel().catch(() => null);
        if (!backgroundTasksPanel) {
          appendClientLog('WARN', 'background_tasks.panel_load_failed', {});
          showToastMessage(jt('backgroundTasks.unavailable', 'Background tasks are unavailable right now.'));
          return false;
        }
        return backgroundTasksPanel.open(options);
      },
      toggle: (options) => (backgroundTasksApi.isOpen() ? Promise.resolve(!backgroundTasksApi.close()) : backgroundTasksApi.open(options)),
      close: () => backgroundTasksPanel?.close?.() === true,
      isOpen: () => backgroundTasksPanel?.isOpen?.() === true,
      titleHtml: () => backgroundTasksPanel?.titleHtml?.() || '', // the panel chrome's title while a task is open
      // Row 195: one run's page (Session's "Running now" rows), and what the strip and Session read. Empty until the panel loads (on the first run).
      openRun: (id, options) => backgroundTasksApi.open({ ...options, taskId: id }),
      runningCount: () => backgroundTasksPanel?.runningCount?.() || 0,
      // null: the list is not loaded or shows another chat (two panes), so the caller keeps its own source. A server's
      // address is its label in the list and its detail in Session.
      runningRows: (sessionId) => {
        if (!backgroundTasksPanel || String(sessionId || '') !== String(sidePanel.getSessionId() || '')) return null;
        return (backgroundTasksPanel.runningRows?.() || []).map((row) => (row.kind === 'server' ? { ...row, label: row.detail, detail: row.label } : row));
      },
    };
    // The Project tab's dot and switch, for the strip (renderer-app-chat-workbench-composition.js).
    const projectSignals = {
      noteChanged: () => projectNotesEntry?.noteChanged?.() === true,
      preferredSide: () => {
        const session = (Array.isArray(state.sessions) ? state.sessions : []).find((entry) => entry?.id === state.currentSessionId);
        return session ? taskRailModule?.preferredSide?.(String(session.project_id || '').trim() || 'project_general') || '' : '';
      },
      // Jenny's checklist for the Session tab: [{ text, state: 'done' | 'now' | 'todo' }].
      checklist: () => (taskRailModule?.buildSessionChecklist?.(state.messagesBySession?.get?.(state.currentSessionId) || [])?.items || []).map((item) => ({
        text: String(item?.content || ''), state: item?.status === 'completed' ? 'done' : item?.status === 'in_progress' ? 'now' : 'todo',
      })),
      // The tab stopped showing: a held Delete (its Undo line) is carried out.
      settle: () => { taskRailController?.settlePendingDelete?.(); },
    };
    if (windowRef && typeof windowRef === 'object') {
      windowRef.rendererBackgroundTasksPanel = backgroundTasksApi;
      windowRef.rendererProjectTabSignals = projectSignals;
      let stopJobWatch = null;
      const onFirstJob = () => { stopJobWatch?.(); stopJobWatch = null; if (!backgroundTasksPanel) void loadBackgroundTasksPanel().then(signalsChanged, () => {}); };
      try { stopJobWatch = windowRef.jennyShell?.backgroundJobs?.onChanged?.(onFirstJob) || null; } catch (_error) { stopJobWatch = null; }
      Promise.resolve().then(() => windowRef.jennyShell?.backgroundJobs?.getState?.()).then((s) => { if (s?.jobs?.length) onFirstJob(); }, () => {}); // a run already going at load sends no event
      // Helpers live in the chat's messages: after a transcript repaints (at most twice a second) the list re-reads
      // them, and a chat whose first run is a helper loads the list then.
      let helperTimer = 0;
      const readHelpersSoon = () => {
        if (helperTimer) return;
        helperTimer = windowRef.setTimeout(() => { helperTimer = 0;
          if (backgroundTasksPanel) { backgroundTasksPanel.refreshHelpers?.(); return; }
          const messages = state.messagesBySession?.get?.(sidePanel.getSessionId()) || [];
          if (messages.length && (windowRef.rendererSubagentMonitorView?.helperRuns?.(messages) || []).length) onFirstJob();
        }, 500);
      };
      windowRef.document?.addEventListener?.('transcript-view-rendered', readHelpersSoon, true);
      registerCleanup(() => {
        stopJobWatch?.();
        windowRef.document?.removeEventListener?.('transcript-view-rendered', readHelpersSoon, true);
        if (helperTimer) windowRef.clearTimeout(helperTimer);
        if (windowRef.rendererBackgroundTasksPanel === backgroundTasksApi) delete windowRef.rendererBackgroundTasksPanel;
        if (windowRef.rendererProjectTabSignals === projectSignals) delete windowRef.rendererProjectTabSignals;
      });
    }

    const terminalOffered = () => state.features?.featureFlags?.chat_terminal_panel !== false && Boolean(windowRef?.jennyShell?.workspacePty);

    function ensureTerminalPanel() {
      const owner = windowRef?.rendererChatTerminalPanelOwner;
      if (terminalPanel || typeof owner?.createChatTerminalPanel !== 'function') return terminalPanel;
      try {
        const panel = owner.createChatTerminalPanel({
          state,
          windowRef,
          dom: { artifactReviewPanel: resolveArtifactReviewPanelEl() },
          openArtifactRail: (mode) => ensureArtifactSurface()?.openArtifactRail?.(mode),
          renderArtifactReviewPanel: () => ensureArtifactSurface()?.renderArtifactReviewPanel?.(),
          toggleArtifactReview: () => ensureArtifactSurface()?.toggleArtifactReview?.(),
          claimOwner: (sessionId) => sidePanel.claim(sessionId),
          getPanelSessionId: () => sidePanel.getSessionId(),
          getProjectSwitcher: () => callbacks.getProjectSwitcher?.(),
          setActiveView: (...args) => setActiveView(...args),
          appendClientLog: (...args) => appendClientLog(...args),
        });
        panel.bind();
        registerCleanup(() => panel.dispose());
        terminalPanel = panel;
      } catch (error) {
        appendClientLog('ERROR', 'chat_terminal.panel_init_failed', { message: error?.message || String(error) });
      }
      return terminalPanel;
    }

    const loadTerminalPanel = async () => ((await loadScripts(TERMINAL_PANEL_SCRIPTS)) ? ensureTerminalPanel() : null);

    // The More menu, Ctrl+` and the approval cards call this; it loads the panel on first use.
    const terminalApi = {
      isAvailable: () => terminalOffered(),
      async open(options) {
        if (!terminalOffered()) return false;
        if (!ensureTerminalPanel()) await loadTerminalPanel().catch(() => null);
        if (!terminalPanel) {
          appendClientLog('WARN', 'chat_terminal.panel_load_failed', {});
          showToastMessage(jt('chatTerminal.loadFailed', 'The terminal panel is unavailable right now.'));
          return false;
        }
        const sessionId = String(options?.sessionId || state.currentSessionId || '').trim();
        return terminalPanel.open({ ...options, sessionId });
      },
      toggle: (options) => (terminalApi.isOpen() ? Promise.resolve(!terminalApi.close()) : terminalApi.open(options)),
      close: () => terminalPanel?.close?.() === true,
      isOpen: () => terminalPanel?.isOpen?.() === true,
      titleHtml: () => terminalPanel?.titleHtml?.() || '', // the panel chrome's title: the tab strip and actions
    };
    if (windowRef && typeof windowRef === 'object' && terminalOffered()) {
      windowRef.rendererChatTerminalPanel = terminalApi;
      registerCleanup(() => { if (windowRef.rendererChatTerminalPanel === terminalApi) delete windowRef.rendererChatTerminalPanel; });
    }

    async function loadBrowserPanel() {
      try {
        if (!await loadScripts(BROWSER_PANEL_SCRIPTS)) throw new Error('the browser panel scripts did not load');
        browserPanel = windowRef.rendererBrowserUsePanel.connectBrowserUsePanel(ctx);
        browserPanel.sync(browserPanelSync);
      } catch (error) {
        browserPanelFailed = true; // a composer render must not retry the load
        appendClientLog('ERROR', 'browser_use.panel_init_failed', { message: error?.message || String(error) });
      }
      browserPanelSync = null;
    }

    // Called from every composer render, so an unused feature costs one comparison.
    windowRef.rendererSyncBrowserUse = (args) => {
      if (browserPanel) browserPanel.sync(args);
      else if (browserPanelSync) browserPanelSync = args;
      else if (args?.enabled === true && !browserPanelFailed) { browserPanelSync = args; void loadBrowserPanel(); }
    };
    registerCleanup(() => delete windowRef.rendererSyncBrowserUse);

    // Row 197: the Live run view loads when its tab first renders, and not at all while the live_run_view flag is off.
    const LIVE_PANEL_SCRIPTS = [['renderer/chat/renderer-live-run-form.js', 'rendererLiveRunForm'], ['renderer/chat/renderer-live-run-capture.js', 'rendererLiveRunCapture'], ['renderer/chat/renderer-live-run-panel.js', 'rendererLiveRunPanel']];
    let livePanel = null, liveLoad = null; // liveLoad: the load in flight, or 'failed'
    const loadLivePanel = () => loadScripts(LIVE_PANEL_SCRIPTS).then((ok) => {
      if (!ok) throw new Error('the live panel scripts did not load');
      livePanel = windowRef.rendererLiveRunPanel.connectLiveRunPanel(ctx);
      ensureArtifactSurface()?.renderArtifactReviewPanel?.();
    }).catch((error) => { if (!livePanel) liveLoad = 'failed'; appendClientLog('ERROR', 'live_run.panel_init_failed', { message: error?.message || String(error) }); try { ensureArtifactSurface()?.renderArtifactReviewPanel?.(); } catch (_repaintError) { /* the log has it */ } });
    function renderLiveSurface(surface) { // pulled by the `live` mode: true while the panel loads (the load repaints)
      if (state.features?.featureFlags?.live_run_view === false || liveLoad === 'failed') return false;
      if (livePanel) return livePanel.renderRailContent(surface) === true;
      liveLoad = liveLoad || loadLivePanel();
      return true;
    }
    // The session rail's Servers row opens the Browser panel; false while it has not loaded (nothing to show yet).
    const openBrowserUsePanel = () => (browserPanel ? browserPanel.open() !== false : false);
    windowRef.rendererOpenBrowserUsePanel = openBrowserUsePanel;
    registerCleanup(() => { if (windowRef.rendererOpenBrowserUsePanel === openBrowserUsePanel) delete windowRef.rendererOpenBrowserUsePanel; });

    return {
      getBrowserPanel: () => browserPanel,
      getCodeReviewRailController: () => codeReviewRailController,
      getFilePreviewController: () => filePreviewController,
      getSubagentRailController: () => subagentRailController,
      renderBackgroundTasksSurface: (surface) => backgroundTasksPanel?.renderRailContent?.(surface) === true,
      renderTerminalSurface: (surface) => terminalPanel?.renderRailContent?.(surface) === true,
      renderLiveSurface,
      backgroundTasksApi,
      ensureCodeReviewRail,
      ensureFilePreviewController,
      ensureTaskRailController,
      ensureSubagentRail,
      ensureProjectNotesEntry,
      ensureMemoryChatEntry,
      ensureProjectNotesRail,
      getChangesUndoController,
    };
  }

  return { createShellArtifactRails };
});
