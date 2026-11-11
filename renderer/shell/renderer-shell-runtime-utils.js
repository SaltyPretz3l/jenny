(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-new-chat-entry'), require('../chat/renderer-composer-tools-slot'), require('./renderer-diagnostics-view-state'));
    return;
  }
  root.rendererShellRuntimeUtils = factory(root.rendererNewChatEntry, root.rendererComposerToolsSlot, root.rendererDiagnosticsViewState);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (newChatEntryUtils, composerToolsSlotUtils, diagnosticsViewStateUtils) {
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}
  function noopAsync() { return Promise.resolve(); }
  function noopNull() { return null; }
  function noopArr() { return []; }
  const loadSiblingModule = (globalName, modulePath) => globalRef[globalName] || (typeof require === 'function' ? require(modulePath) : null);
  const contextRingUtils = loadSiblingModule('rendererShellContextRing', './renderer-shell-context-ring');
  const recoveryActionsUtils = loadSiblingModule('rendererShellRecoveryActions', './renderer-shell-recovery-actions');
  const { deriveCanonicalSessionDisplayState } = contextRingUtils;
  function createShellRuntimeController(deps) {
    const {
      state,
      windowRef = globalRef.window || globalRef,
      dom = {},
      constants = {},
      modules = {},
      callbacks = {},
    } = deps || {};

    const { TOAST_SOURCE = {} } = constants;
    const {
      composerContextUsageSlot = null,
      composerPlanUsageSlot = null,
      composerToolToggleSlot = null,
    } = dom;
    const {
      contextUsageModule = null,
      composerToggleModule = null,
    } = modules;
    const {
      appendClientLog = noop,
      renderAll = noop,
      renderSettings = noop,
      renderWorkspaceChrome = noop,
      renderComposerState = noop,
      syncComposerInputHeight = noop,
      showToastMessage = noop,
      toErrorMessage = function fallbackToErrorMessage(error) {
        return String(error && error.message || error || '');
      },
      showComposerActionError = noop,
      openSettingsSection = noop,
      setActiveView = noop,
      getLatestReplyAssistantMessageId = function fallbackGetLatestReplyAssistantMessageId(messages) {
        const source = Array.isArray(messages) ? messages : [];
        for (let index = source.length - 1; index >= 0; index -= 1) {
          const message = source[index];
          if (String(message?.role || '').trim() === 'assistant') {
            return String(message?.id || '').trim();
          }
        }
        return '';
      },
      getCurrentVisibleMessages = noopArr,
      getCurrentMessageById = noopNull,
      getCurrentRuntimePreferences = noopNull,
      isSendPreflightPending = () => false,
      loadSessions = noopAsync,
      refreshSessionSummaries = noopAsync,
      handleCreateSession = noopAsync,
      handleDeleteSession = noopAsync,
      syncWorkspaceFromStore = noopAsync,
      applyWorkspaceSnapshot = noop,
      renderComposerEnhancementsHook = null,
      renderSessions = noop,
      activateWorkspaceSession = noopAsync,
      openArtifactTarget = noopAsync,
      openIdeFileAtLine = noopAsync,
      revealIdePath = noopAsync,
      openFilePreviewTarget = noopAsync,
      openProjectFileInIde = null,
      getProjectRoots = null,
      focusComposer = noop,
    } = callbacks;

    // Chat-path listeners are page-lifetime, and the module resolves its menu
    // dependencies from window globals.
    const chatPathOpenUtils = windowRef.rendererChatPathOpen || null;
    if (chatPathOpenUtils && typeof chatPathOpenUtils.createChatPathOpenController === 'function') {
      chatPathOpenUtils.createChatPathOpenController({
        windowRef,
        chatTimeline: windowRef.document?.getElementById?.('chatTimeline') || null,
        pathRoots: [windowRef.document?.getElementById?.('subagentInspector')].filter(Boolean),
        paneHost: windowRef.document || null, // split view: another pane's timeline/inspector, found per event
        state,
        setActiveView: (...a) => setActiveView(...a),
        openIdeFileAtLine: (...a) => openIdeFileAtLine(...a),
        // A folder chip shows the folder in the IDE explorer tree (true only when it was revealed).
        revealInIdeTree: async (relPath) => (await revealIdePath(relPath, { expandSelf: true })) === true,
        openFilePreviewTarget: (...a) => openFilePreviewTarget(...a),
        // Another registered project's file (primary chat links): the IDE route and the folder list.
        openProjectFileInIde: openProjectFileInIde && ((...a) => openProjectFileInIde(...a)),
        getProjectRoots: getProjectRoots && ((...a) => getProjectRoots(...a)),
        showToastMessage: (...a) => showToastMessage(...a),
        appendClientLog: (...a) => appendClientLog(...a),
      }).attach();
    }

    function getKnownSessionIds() {
      return Array.isArray(state.sessions)
        ? state.sessions
          .map((session) => String(session?.id || '').trim())
          .filter(Boolean)
        : [];
    }

    function pruneContextUsageCache() {
      if (!contextUsageModule || typeof contextUsageModule.pruneUsage !== 'function') return;
      const keepSessionIds = getKnownSessionIds();
      contextUsageModule.pruneUsage({
        keepSessionIds,
        maxEntries: Math.max(100, keepSessionIds.length + 32),
      });
    }

    const composerToolsSlot = composerToolsSlotUtils.createComposerToolsSlot({
      state, windowRef, slot: composerToolToggleSlot, controller: composerToggleModule, appendClientLog,
    });

    const { renderContextRing, ensureContextFeed } = contextRingUtils.createShellContextRing({
      state,
      windowRef,
      contextUsageModule,
      composerContextUsageSlot,
      getCurrentRuntimePreferences,
      getCurrentVisibleMessages,
    });

    function renderComposerEnhancements() {
      renderContextRing();
      ensureContextFeed()?.sync();
      if (composerPlanUsageSlot) {
        /* ChatGPT plan-usage ring: its own store/memo/popover, sibling of the
           context ring; empty string when inactive keeps the slot inert. */
        windowRef.rendererPlanUsageMeter?.render?.(composerPlanUsageSlot, state);
      }
      composerToolsSlot.render();
      if (typeof renderComposerEnhancementsHook === 'function') {
        renderComposerEnhancementsHook();
      }
    }

    function refreshComposerToolToggles() { return composerToolsSlot.refresh(); }
    function getToolPreferences() { return composerToolsSlot.getToolPreferences(); }
    function handleComposerToggleChange(event) { return composerToolsSlot.handleToggleChange(event); }

    function queueDeferredStartupTask(task, options = {}) {
      const {
        event = 'renderer.startup_task_failed',
        rerender = false,
      } = options;
      Promise.resolve()
        .then(() => task())
        .catch((error) => {
          appendClientLog('WARN', event, {
            message: error?.message || String(error),
          });
        })
        .finally(() => {
          if (!rerender) {
            return;
          }
          try {
            renderAll();
          } catch (_error) {
            // Global renderer safeguards handle any follow-on render issues.
          }
        });
    }

    const {
      resolveActionMessageId,
      openLogsForStream,
      handleErrorRecoveryAction,
      handleArtifactAction,
    } = recoveryActionsUtils.createShellRecoveryActions({
      state,
      windowRef,
      TOAST_SOURCE,
      diagnosticsViewStateUtils,
      appendClientLog,
      renderAll,
      showToastMessage,
      showComposerActionError,
      openSettingsSection,
      setActiveView,
      openArtifactTarget,
      getLatestReplyAssistantMessageId,
      getCurrentVisibleMessages,
    });

    function shouldSyncWorkspaceAfterSessionReload() {
      return Boolean(
        state.workspaceRestoreDeferred === true
        || state.workspace?.activeSessionId
        || state.workspace?.openSessionIds?.length
        || !state.currentSessionId
      );
    }

    async function loadSessionsWithWorkspace() {
      const result = await loadSessions(...arguments);
      pruneContextUsageCache();
      if (shouldSyncWorkspaceAfterSessionReload()) {
        await syncWorkspaceFromStore();
      }
      return result;
    }

    async function refreshSessionSummariesWithWorkspace() {
      const result = await refreshSessionSummaries(...arguments);
      pruneContextUsageCache();
      if (shouldSyncWorkspaceAfterSessionReload()) {
        await syncWorkspaceFromStore({ preserveCurrentSession: true });
      }
      return result;
    }

    // "+ New chat" (F37 latest wins, D7 Chats filter follow, X3 reuse of an
    // untouched empty chat) lives in renderer-new-chat-entry.js.
    const newChatEntry = newChatEntryUtils?.createNewChatEntry?.({
      state,
      windowRef,
      callbacks: { appendClientLog, handleCreateSession, activateWorkspaceSession, renderWorkspaceChrome, renderSessions, focusComposer },
    }) || null;
    async function handleCreateSessionWithWorkspace() {
      if (newChatEntry) return newChatEntry.handleCreateSessionWithWorkspace(...arguments);
      return String(await handleCreateSession(...arguments) || '').trim(); // module missing: plain create
    }

    async function handleDeleteSessionWithWorkspace() {
      let deleteResult;
      let deleteError = null;
      try {
        deleteResult = await handleDeleteSession(...arguments);
      } catch (error) {
        deleteError = error;
      }
      try {
        await syncWorkspaceFromStore();
      } catch (syncError) {
        if (!deleteError) {
          throw syncError;
        }
        appendClientLog('WARN', 'workspace.sync_after_delete_failed', {
          message: toErrorMessage(syncError),
        });
      }
      if (deleteError) {
        throw deleteError;
      }
      return deleteResult;
    }

    return {
      getKnownSessionIds,
      pruneContextUsageCache,
      renderComposerEnhancements,
      refreshComposerToolToggles,
      getToolPreferences,
      handleComposerToggleChange,
      queueDeferredStartupTask,
      resolveActionMessageId,
      openLogsForStream,
      handleErrorRecoveryAction,
      handleArtifactAction,
      loadSessionsWithWorkspace,
      refreshSessionSummariesWithWorkspace,
      handleCreateSessionWithWorkspace,
      handleDeleteSessionWithWorkspace,
    };
  }

  return {
    createShellRuntimeController,
    deriveCanonicalSessionDisplayState,
  };
});
