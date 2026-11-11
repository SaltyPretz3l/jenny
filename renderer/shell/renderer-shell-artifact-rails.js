/* renderer/shell/renderer-shell-artifact-rails.js - the lazily built rails of the artifact side panel.
 *
 * Split out of renderer-shell-artifact-bridge.js (which builds one per bridge): the Changes undo controller,
 * the code-review, file-preview, task, subagent and project-notes rails, and the memory chip / notes entries.
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

    async function loadBrowserPanel() {
      try {
        for (const [src, name] of BROWSER_PANEL_SCRIPTS) {
          const isReady = () => Boolean(windowRef[name]);
          if (!isReady() && !await windowRef.scriptLoaderUtils?.ensureScript?.({ src, isReady, log: appendClientLog })) throw new Error(`${name} did not load`);
        }
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

    return {
      getBrowserPanel: () => browserPanel,
      getCodeReviewRailController: () => codeReviewRailController,
      getFilePreviewController: () => filePreviewController,
      getSubagentRailController: () => subagentRailController,
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
