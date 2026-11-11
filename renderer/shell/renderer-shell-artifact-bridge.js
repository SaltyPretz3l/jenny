(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../inventory/action-button'), (function loadPanelV2() {
      try { return require('../features/renderer-artifact-panel-v2-render'); } catch (_error) { return null; }
    })(), (function loadFilePreview() {
      try { return require('../features/renderer-artifact-file-preview'); } catch (_error) { return null; }
    })(), (function loadTaskRail() {
      try { return require('../features/renderer-task-rail'); } catch (_error) { return null; }
    })(), (function loadSubagentRail() {
      try { return require('../features/renderer-subagent-rail'); } catch (_error) { return null; }
    })());
    return;
  }
  root.rendererShellArtifactBridgeUtils = factory(
    root.inventoryActionButton,
    root.rendererArtifactPanelV2 || null,
    root.rendererArtifactFilePreview || null,
    root.rendererTaskRail || null,
    root.rendererSubagentRail || null
  );
})(typeof globalThis !== 'undefined' ? globalThis : this, function (inventoryActionButton, artifactPanelV2Module, artifactFilePreviewModule, taskRailModule, subagentRailModule) {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}
  function noopNull() { return null; }
  function noopArr() { return []; }
  const loadSiblingModule = (globalName, modulePath) => globalRef[globalName] || (typeof require === 'function' ? require(modulePath) : null);
  const prefsUtils = loadSiblingModule('rendererShellArtifactPrefs', './renderer-shell-artifact-prefs');
  const sidePanelUtils = loadSiblingModule('rendererShellSidePanel', './renderer-shell-side-panel');
  const railsUtils = loadSiblingModule('rendererShellArtifactRails', './renderer-shell-artifact-rails');

  function createShellArtifactBridge(deps) {
    const {
      state,
      windowRef = globalRef.window || globalRef,
      dom = {},
      lazyDom = {},
      constants = {},
      buildArtifactsFromMessages = noopArr,
      artifactsUtils = {},
      registerCleanup = noop,
      callbacks = {},
      codeReview = {},
      sidePanelOwner = globalRef.rendererSidePanelOwner || null,
    } = deps || {};

    const {
      workspace = null,
      sidebar = null,
      sidebarResizer = null,
      chatView = null,
      chatTimeline = null,
      artifactReviewPanel = null,
    } = dom;
    const codeReviewRailDeps = codeReview && typeof codeReview === 'object' ? codeReview : {};
    const {
      getArtifactsDom = noopArr,
    } = lazyDom;
    const {
      escapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml,
      getActiveSession = noopNull,
      getSessionMonogram = noop,
      setActiveView = noop,
      scrollMessageIntoView = noop,
      renderAll = noop,
      updateComposerSafeOffset = noop,
      appendClientLog = noop,
      showToastMessage = noop,
      getProjectionContext = noopNull,
      getChatTimelineRowModelEnabled = function noopGetChatTimelineRowModelEnabled() { return false; },
      recordChatTimelineRolloutSignal = function noopRecordChatTimelineRolloutSignal() { return { logged: false, count: 0 }; },
      rollbackChatTimelineRowModel = function noopRollbackChatTimelineRowModel() { return false; },
      toErrorMessage = function fallbackToErrorMessage(error) {
        return String(error && error.message || error || '');
      },
    } = callbacks;

    // The prefs module owns the key; a test may pass its own.
    const artifactReviewPrefs = globalRef.rendererArtifactReviewPrefs
      || (typeof require === 'function' ? require('../features/renderer-artifact-review-prefs') : null);
    const ARTIFACT_REVIEW_STORAGE_KEY =
      String(constants.ARTIFACT_REVIEW_STORAGE_KEY || artifactReviewPrefs?.ARTIFACT_REVIEW_STORAGE_KEY || '');

    let artifactSurfaceController = null;
    let artifactSurfaceBound = false;
    // The manager is built lazily (often when a chat's first artifact
    // arrives), so the run's start is recorded here, at boot: auto-open
    // presents only artifacts produced since (owner decision 2026-09-29).
    const runStartedAt = Date.now();
    let panelV2Controller = null;
    const artifactSessionCache = new Map();
    let rails = null; // built below, once the artifact surface accessors exist
    const { getArtifactReviewPreferenceState } = prefsUtils.createArtifactReviewPrefsReader({
      state,
      windowRef,
      ARTIFACT_REVIEW_STORAGE_KEY,
    });

    function isArtifactReviewVisible() {
      if (artifactSurfaceController?.isArtifactReviewVisible) {
        return artifactSurfaceController.isArtifactReviewVisible();
      }
      // No width clause (W1-5): stage width only picks split-vs-overlay inside
      // the surface (syncArtifactReviewLayout); gating lazy-init on it would
      // leave narrow windows with no artifact surface at all now that the
      // studio fallback is gone.
      const prefs = getArtifactReviewPreferenceState();
      return state.ui?.activeView === 'chat'
        && prefs.enabled === true;
    }

    function getArtifactsForSession(sessionId) {
      const key = String(sessionId || '').trim();
      if (!key) {
        return [];
      }
      const messages = state.messagesBySession.get(key) || [];
      const cached = artifactSessionCache.get(key);
      if (cached && cached.messagesRef === messages) {
        return cached.artifacts;
      }
      const artifacts = buildArtifactsFromMessages(messages, { sessionId: key });
      artifactSessionCache.set(key, { messagesRef: messages, artifacts });
      return artifacts;
    }

    function invalidateSessionArtifacts(sessionId, messages) {
      const key = String(sessionId || '').trim();
      if (!key) {
        return;
      }
      if (Array.isArray(messages)) {
        artifactSessionCache.set(key, {
          messagesRef: messages,
          artifacts: buildArtifactsFromMessages(messages, { sessionId: key }),
        });
      } else {
        artifactSessionCache.delete(key);
      }
      artifactSurfaceController?.invalidateSessionArtifacts?.(key);
    }

    function rekeySessionArtifacts(oldSessionId, newSessionId) {
      const sourceSessionId = String(oldSessionId || '').trim();
      const targetSessionId = String(newSessionId || '').trim();
      if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) {
        return targetSessionId || sourceSessionId;
      }
      artifactSessionCache.delete(sourceSessionId);
      artifactSessionCache.delete(targetSessionId);
      artifactSurfaceController?.rekeySessionArtifacts?.(sourceSessionId, targetSessionId);
      return targetSessionId;
    }

    function pruneSessionArtifacts(validSessionIds) {
      const allowed = new Set(
        (Array.isArray(validSessionIds) ? validSessionIds : [])
          .map((entry) => String(entry || '').trim())
          .filter(Boolean)
      );
      for (const key of [...artifactSessionCache.keys()]) {
        if (!allowed.has(key)) {
          artifactSessionCache.delete(key);
        }
      }
      artifactSurfaceController?.pruneSessionArtifacts?.(validSessionIds);
    }

    const { sidePanel, getPanelSession } = sidePanelUtils.createShellSidePanel({
      state,
      windowRef,
      sidePanelOwner,
      getActiveSession,
      getSubagentRailController: () => rails?.getSubagentRailController() || null,
    });

    // The owning pane closed (the layout reconcile's 'collapse'): collapse a
    // showing panel WITHOUT the sticky dismissal, so auto-open still works.
    function collapseSidePanel() {
      if (!artifactSurfaceController?.collapseArtifactReview || !isArtifactReviewVisible()) return false;
      artifactSurfaceController.collapseArtifactReview();
      return true;
    }

    function resetArtifactsState() {
      artifactSessionCache.clear();
      if (state.artifacts && typeof state.artifacts === 'object') {
        // WS3 auto-open once-per-session FIFO (never persisted).
        state.artifacts.autoOpenedSessionIds = [];
      }
      if (artifactSurfaceController?.resetArtifactsState) {
        artifactSurfaceController.resetArtifactsState();
        return;
      }
      state.artifacts.filter = 'all';
      state.artifacts.selectedArtifactId = '';
      state.artifacts.selectedSessionId = '';
      state.artifacts.loadedArtifactId = '';
      state.artifacts.loadedArtifactContent = '';
      state.artifacts.dirtyContent = '';
      state.artifacts.lastError = '';
      state.artifacts.loading = false;
      state.artifacts.savePending = false;
      state.artifacts.mermaidViewMode = 'preview';
    }

    // Resolve the static #artifactReviewPanel CONTAINER for the artifact-review
    // surfaces (V2 chrome install + code-review rail bind). The bridge's
    // `artifactReviewPanel` dom dep is undefined in practice: the id lives only
    // in the lazy getArtifactDom resolver, never in the eager dom registry
    // app.js destructures, so it threads through as undefined. That left BOTH
    // consumers broken on the real boot path: ensurePanelV2() early-returned
    // (V2 never installed -> panel stayed legacy regardless of the flag), and
    // the code-review rail's bind() early-returns on !artifactReviewPanel (its
    // click/keydown listeners never attached -> rail dead-on-arrival). Fall back
    // to a direct getElementById of the container. Scoped to these two
    // consumers ONLY (NOT added to the eager registry) because making the eager
    // dep non-null flips unrelated eager consumers' behavior -- it regressed the
    // chat-zoom Ctrl+0 shortcut. getElementById resolves just the container, so
    // it does NOT trigger the lazy child id-query: the V2 install still runs
    // BEFORE getArtifactsDom() resolves the children, and the rail delegates off
    // the stable container (surviving V2's innerHTML swap).
    function resolveArtifactReviewPanelEl() {
      return artifactReviewPanel
        || windowRef?.document?.getElementById?.('artifactReviewPanel')
        || null;
    }

    // Artifact panel chrome: when the sibling render module is available,
    // replace #artifactReviewPanel's CHILDREN with the Canvas chrome BEFORE
    // the getArtifactsDom() spread below so the lazy id-query naturally
    // resolves to the new nodes. A missing module is a strict no-op — the
    // static index.html shell and everything downstream stay byte-identical.
    function ensurePanelV2() {
      const panelEl = resolveArtifactReviewPanelEl();
      if (panelV2Controller || !panelEl || !artifactPanelV2Module?.createArtifactPanelV2) {
        return panelV2Controller;
      }
      const controller = artifactPanelV2Module.createArtifactPanelV2({
        panelEl,
        state,
        windowRef,
        escapeHtml,
        appendClientLog: (...args) => appendClientLog(...args),
        showToastMessage: (...args) => showToastMessage(...args),
      });
      if (controller?.installed?.()) {
        panelV2Controller = controller;
      }
      return panelV2Controller;
    }

    function ensureArtifactSurface() {
      if (artifactSurfaceController) {
        return artifactSurfaceController;
      }
      try {
        ensurePanelV2();
        artifactSurfaceController = artifactsUtils.createArtifactManager?.({
          state,
          dom: {
            workspace,
            sidebar,
            sidebarResizer,
            chatView,
            chatTimeline,
            ...getArtifactsDom(),
          },
          callbacks: {
            escapeHtml,
            getActiveSession: () => getPanelSession(),
            getSessionMonogram: (...args) => getSessionMonogram(...args),
            setActiveView: (...args) => setActiveView(...args),
            scrollMessageIntoView: (...args) => scrollMessageIntoView(...args),
            renderAll: (...args) => renderAll(...args),
            updateComposerSafeOffset: (...args) => updateComposerSafeOffset(...args),
            appendClientLog: (...args) => appendClientLog(...args),
            showToastMessage: (...args) => showToastMessage(...args),
            getProjectionContext: (...args) => getProjectionContext(...args),
            getChatTimelineRowModelEnabled: (...args) => getChatTimelineRowModelEnabled(...args),
            recordChatTimelineRolloutSignal: (...args) => recordChatTimelineRolloutSignal(...args),
            rollbackChatTimelineRowModel: (...args) => rollbackChatTimelineRowModel(...args),
            toErrorMessage: (...args) => toErrorMessage(...args),
            renderCodeReviewSurface: (surface) => rails.getCodeReviewRailController()?.renderRailContent?.(surface),
            // Late-bound like the code-review rail: the preview controller is
            // built after the surface (it needs the surface's rail helpers).
            renderFilePreviewSurface: (surface) => rails.getFilePreviewController()?.renderRailContent?.(surface),
            renderTasksSurface: (surface) => ensureTaskRailController()?.renderRailContent?.(surface) === true,
            renderSubagentsSurface: (surface) => rails.getSubagentRailController()?.renderSubagentsSurface?.(surface) === true,
            renderNotesSurface: (surface) => ensureProjectNotesRail()?.renderRailContent?.(surface) === true,
            renderBrowserSurface: (surface) => rails.getBrowserPanel()?.renderRailContent?.(surface) === true,
            resetFilePreview: () => rails.getFilePreviewController()?.reset?.(),
            panelV2: panelV2Controller,
            sidePanel,
            getRunStartedAt: () => runStartedAt,
            getScrollCoordinators: () => callbacks.getScrollCoordinators?.() || [], // the side-panel column motion's reader anchor
          },
        }) || null;
        if (artifactSurfaceController && !artifactSurfaceBound) {
          artifactSurfaceController.bind?.();
          artifactSurfaceBound = true;
          registerCleanup(() => artifactSurfaceController?.dispose?.());
        }
        ensureCodeReviewRail();
        ensureFilePreviewController();
        ensureTaskRailController();
        ensureProjectNotesEntry();
        ensureMemoryChatEntry();
        ensureSubagentRail();
        if (panelV2Controller) {
          panelV2Controller.bind();
          panelV2Controller.connect({
            selectArtifact: (artifactId) => artifactSurfaceController?.selectArtifact?.(artifactId),
            setArtifactDocumentViewMode: (surfaceKey, mode) => artifactSurfaceController?.setArtifactDocumentViewMode?.(surfaceKey, mode),
            getArtifactDocumentViewMode: (surfaceKey) => artifactSurfaceController?.getArtifactDocumentViewMode?.(surfaceKey),
            copySelectedArtifact: () => artifactSurfaceController?.copySelectedArtifactSource?.(),
            getSelectedArtifactSource: () => artifactSurfaceController?.getSelectedArtifactSource?.() ?? null,
            setArtifactViewMode: (kind, mode) => artifactSurfaceController?.setArtifactViewMode?.(kind, mode),
            getArtifactViewMode: (kind) => artifactSurfaceController?.getArtifactViewMode?.(kind),
            getArtifacts: () => {
              const session = getPanelSession();
              return session ? artifactSurfaceController?.getArtifactsForSession?.(session.id) || [] : [];
            },
            toggleMaximize: () => artifactSurfaceController?.toggleArtifactReviewMaximized?.(),
            isMaximized: () => artifactSurfaceController?.isArtifactReviewMaximized?.() === true,
            isSelectedArtifactMarkdownGenerated: () => artifactSurfaceController?.isSelectedArtifactMarkdownGenerated?.() === true,
          });
          registerCleanup(() => panelV2Controller?.dispose?.());
        }
      } catch (error) {
        artifactSurfaceController?.dispose?.();
        artifactSurfaceController = null;
        artifactSurfaceBound = false;
        appendClientLog('ERROR', 'artifacts.surface_init_failed', {
          message: error?.message || String(error),
        });
        return null;
      }
      return artifactSurfaceController;
    }

    rails = railsUtils.createShellArtifactRails({
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
      getSurface: () => artifactSurfaceController,
      ensureArtifactSurface,
      resolveArtifactReviewPanelEl,
      artifactFilePreviewModule,
      taskRailModule,
      subagentRailModule,
    });
    const {
      ensureCodeReviewRail,
      ensureFilePreviewController,
      ensureTaskRailController,
      ensureSubagentRail,
      ensureProjectNotesEntry,
      ensureMemoryChatEntry,
      ensureProjectNotesRail,
      getChangesUndoController,
    } = rails;

    async function openFilePreviewTarget(payload) {
      ensureArtifactSurface();
      const controller = ensureFilePreviewController();
      if (!controller) {
        return false;
      }
      return (await controller.openFilePreviewTarget(payload)) === true;
    }

    function openCodeReviewTarget(payload) {
      if (codeReviewRailDeps.revealInDock?.(payload) === true) return true;
      sidePanel.claim();
      ensureArtifactSurface();
      const rail = ensureCodeReviewRail();
      if (!rail) {
        return false;
      }
      return rail.openCodeReviewTarget(payload);
    }

    function openArtifactTarget() {
      return ensureArtifactSurface()?.openArtifactTarget?.(...arguments);
    }
    // The session rail's detail entry points (renderer-chat-workspace-detail.js) drive the panels this bridge owns; configured at
    // construction and lazy, so a rail click builds the artifact surface and code review rail on first use.
    globalRef.rendererChatWorkspaceDetail?.configure?.({ claimOwner: (sessionId) => sidePanel.claim(sessionId), openArtifact: (ref) => openArtifactTarget(ref, { source: 'session-rail' }), openChanges: (context) => { ensureArtifactSurface(); return ensureCodeReviewRail()?.openWorkingTree?.(context) === true; }, closePanel: () => artifactSurfaceController?.collapseArtifactReview?.() });

    function jumpToArtifactSource(...args) {
      return ensureArtifactSurface()?.jumpToArtifactSource?.(...args);
    }

    // WS3: cheap pre-check for whether the auto-open hook could fire this
    // render. Without it, a dormant panel (prefs.enabled=false, controller
    // never built) short-circuits below and the per-render auto-open hook in
    // renderArtifactReviewPanel never runs for exactly the users auto-open
    // targets. Checks are ordered cheapest-first; the artifact projection is
    // cached per messages-array reference.
    function shouldConsiderArtifactAutoOpen() {
      if (state.ui?.appearance?.artifactAutoOpen !== true) return false;
      if (state.ui?.activeView !== 'chat') {
        return false;
      }
      // The panel is hidden here (a showing panel has built its controller).
      const sessionId = sidePanel.getAutoOpenSessionId(false);
      if (!sessionId) {
        return false;
      }
      const openedIds = state.artifacts?.autoOpenedSessionIds;
      if (Array.isArray(openedIds) && openedIds.includes(sessionId)) {
        return false;
      }
      // D1: a Close in this chat, never a global dismissal.
      if (getArtifactReviewPreferenceState().dismissedForSession?.[sessionId] === true) {
        return false;
      }
      // No width clause (W1-5): narrow stages auto-open into the overlay
      // drawer instead of being skipped (the studio fallback is gone).
      return getArtifactsForSession(sessionId).length > 0;
    }

    function renderArtifactReviewPanelSafe() {
      ensureTaskRailController();
      ensureProjectNotesEntry()?.checkSession?.(); // a chat switch re-aims the Notes accent dot
      ensureSubagentRail();
      if (!artifactSurfaceController) {
        if (!isArtifactReviewVisible() && !shouldConsiderArtifactAutoOpen()) {
          return null;
        }
      }
      return ensureArtifactSurface()?.renderArtifactReviewPanel?.(...arguments);
    }

    function syncArtifactReviewLayout() {
      if (!artifactSurfaceController) {
        if (!isArtifactReviewVisible()) {
          return null;
        }
      }
      return ensureArtifactSurface()?.syncArtifactReviewLayout?.(...arguments);
    }

    function selectArtifact() {
      return ensureArtifactSurface()?.selectArtifact?.(...arguments);
    }

    // Always-functional split-view toggle (owner report 2026-07-05): the
    // surface controller's bind() owns the toggle's click listener, but every
    // passive builder above defers until the panel is already visible or
    // auto-open eligible — so in any state where the panel never showed, the
    // surface never built and #artifactSplitViewToggle was a dead button.
    // This boot-time priming listener handles ONLY the never-built case: it
    // builds the surface on demand and forwards the click once. The surface's
    // own listener attaches during this same dispatch and (per DOM dispatch
    // semantics) does not receive the in-flight event, so the click is handled
    // exactly once; every later click no-ops here and is owned by the surface.
    (function bindSplitViewTogglePrimer() {
      const toggleEl = windowRef?.document?.getElementById?.('artifactSplitViewToggle');
      if (!toggleEl?.addEventListener) {
        return;
      }
      const primeFromToggle = () => {
        if (artifactSurfaceController) {
          return;
        }
        ensureArtifactSurface()?.toggleArtifactReview?.();
      };
      toggleEl.addEventListener('click', primeFromToggle);
      registerCleanup(() => toggleEl.removeEventListener('click', primeFromToggle));
    })();

    // The memory chip's Undo is one document-level delegate; bind it now, so a
    // chat whose artifact surface was never built still undoes a note.
    ensureMemoryChatEntry();
    // Row 64: the review findings list's Fix / Show in diff delegate, bound the same way.
    try {
      const findingsEntry = windowRef?.rendererReviewFindings?.createReviewFindingsEntry?.({
        windowRef, getCurrentSessionId: () => String(state.currentSessionId || ''),
        appendClientLog: (...args) => appendClientLog(...args), showToastMessage: (...args) => showToastMessage(...args),
      });
      if (findingsEntry) { findingsEntry.bind(); registerCleanup(() => findingsEntry.dispose()); }
    } catch (error) {
      appendClientLog('ERROR', 'review_findings.entry_init_failed', { message: error?.message || String(error) });
    }

    // A monitor Open can arrive before anything built the artifact surface; the
    // pane controllers call this to build the rail instead of falling back to
    // the in-stage aside.
    if (windowRef && typeof windowRef === 'object') {
      const ensureRailHook = () => ensureSubagentRail();
      windowRef.rendererEnsureSubagentRail = ensureRailHook;
      registerCleanup(() => {
        if (windowRef.rendererEnsureSubagentRail === ensureRailHook) delete windowRef.rendererEnsureSubagentRail;
      });
    }

    return {
      getArtifactReviewPreferenceState,
      isArtifactReviewVisible,
      getArtifactsForSession,
      invalidateSessionArtifacts,
      rekeySessionArtifacts,
      pruneSessionArtifacts,
      resetArtifactsState,
      ensureArtifactSurface,
      openArtifactTarget,
      jumpToArtifactSource,
      openCodeReviewTarget,
      openFilePreviewTarget,
      renderArtifactReviewPanelSafe,
      syncArtifactReviewLayout,
      selectArtifact,
      sidePanel,
      collapseSidePanel,
      getChangesUndoController,
    };
  }

  return {
    createShellArtifactBridge,
  };
});
