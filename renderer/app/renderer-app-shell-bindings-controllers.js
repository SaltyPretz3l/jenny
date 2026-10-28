(function (root) {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const noop = () => {};

  function bindShellEventControllers(ctx) {
    const { state, constants, dom, controllers, callbacks, windowRef } = ctx;
    const { chatShellController, multiStreamController } = controllers;
    const {
      activateWorkspaceSession,
      appendClientLog,
      dismissToast,
      escapeHtml,
      finishSidebarResize,
      getCurrentRuntimePreferences,
      getIdeCommandItems: getIdeCommandItemsCb = () => [],
      ensureLogRowMounted = () => false,
      handleDeleteSessionWithWorkspace,
      handleLinkedSessionPopover = () => {},
      handleRenameSession,
      handleStopActiveStream = async () => null,
      handleSidebarResizeKeydown,
      handleSidebarResizeMove,
      handleSidebarResizeStart,
      handleWorkspaceShortcut,
      isSendPreflightPending,
      loadSessions,
      navigateToDiagnosticsTrace,
      openIdeHelpOverlay = noop,
      openSettingsSection = noop,
      registerCleanup,
      renderAll,
      renderLogs,
      renderSessions,
      refreshPhasePercentiles,
      resetAttachmentQueue,
      resetPhasePercentiles,
      resetLogsViewState,
      resetSidebarWidth,
      scrollLogsToBottom,
      setActiveView,
      setSidebarCollapsed,
      setRovingChatSession,
      showSessionActionError,
      showToastMessage,
      toggleChatsScope,
    } = callbacks;

    // Addressed messaging (row 59 cp4): the row menu's "Send to chat..." and the sidebar unread
    // count between summary refreshes. Both are absent where the bridge is (hosted browser).
    const chatMessagesBridge = windowRef.jennyShell?.chatMessages || null;
    const sendToChatReady = Boolean(chatMessagesBridge && root.rendererChatSendModal && root.inventoryStepModal);
    if (chatMessagesBridge) {
      root.rendererChatMessagesReview?.getDefaultReview?.({ appendClientLog, openSession: (sessionId) => activateWorkspaceSession(sessionId, { mode: 'replace' }) });
      registerCleanup(root.rendererSessionUnread?.bindUnreadSync?.({
        bridge: chatMessagesBridge,
        apply: (sessionId, unread, failed) => {
          const next = root.rendererSessionUnread.patchMailCounts(state.sessions, sessionId, unread, failed);
          if (!next) return;
          state.sessions = next;
          renderSessions();
        },
      }) || noop);
    }

    // Primary Jenny chat controls (row 76): the shared paused-state store behind the row tag, the row menu
    // and the composer notice. The Activity / Reset / Forget dialogs arrive as late globals, so a missing one is a no-op.
    const primaryChatStore = root.rendererPrimaryChatStore?.getDefaultPrimaryChatStore?.({ getBridge: () => windowRef.jennyShell?.primaryChat || null, state, onChanged: () => callbacks.renderSessions?.(), appendClientLog }) || null;
    if (windowRef.jennyShell?.primaryChat) primaryChatStore?.start();
    if (primaryChatStore) registerCleanup(() => primaryChatStore.dispose());
    const primaryDialogDeps = () => ({ documentRef: windowRef.document, stepModal: root.inventoryStepModal, overlayManager: controllers.overlayManager || null, appendClientLog, state, getBridge: () => windowRef.jennyShell?.primaryChat || null });
    // After a Reset: drop the pane's cached transcript, re-read the sessions list and repaint the (now empty) chat.
    const afterPrimaryReset = (result) => {
      const sessionId = String(result?.session_id || primaryChatStore?.getSnapshot?.().session_id || '');
      if (sessionId) root.rendererChatMessageEditUtils?.purgeChatSessionCaches?.(state, sessionId, callbacks.clearProjectionContextCacheForSession);
      Promise.resolve(loadSessions?.(state.currentSessionId, { skipOpenCurrent: true })).then(() => {
        if (sessionId && state.currentSessionId === sessionId) activateWorkspaceSession(sessionId, { mode: 'replace' });
        callbacks.renderAll?.();
        showToastMessage?.(result?.forgotten ? jt('chat.primary.forget.done', 'The Jenny chat was reset and its memories removed.') : jt('chat.primary.reset.done', 'The Jenny chat was reset.'));
      }).catch((error) => appendClientLog?.('WARN', 'primary_chat.reset_reload_failed', { reason: (error && (error.code || error.name)) || 'error' }));
    };
    const primaryResetDialog = () => root.rendererPrimaryResetDialog?.getDefaultPrimaryResetDialog?.({ ...primaryDialogDeps(), afterReset: afterPrimaryReset });

    // Session row actions (nav overhaul W7): context menu, inline rename,
    // pin/archive meta, and undo-windowed delete. Created before the event
    // bindings (which surface its menu) and the palette (which lists its
    // pending undos).
    const sessionActionsController = (root.rendererSessionActionsUtils || {}).createSessionActionsController?.({
      state,
      windowRef,
      constants: { TOAST_SOURCE: constants.TOAST_SOURCE },
      callbacks: {
        hardDeleteSession: (...a) => handleDeleteSessionWithWorkspace(...a),
        renameSession: (...a) => handleRenameSession(...a),
        refreshSessions: () => loadSessions(state.currentSessionId, { skipOpenCurrent: true }),
        renderSessions,
        renderAll,
        setActiveView,
        activateWorkspaceSession: (...a) => activateWorkspaceSession(...a),
        showToastMessage,
        dismissToast,
        showSessionActionError,
        appendClientLog,
        registerCleanup,
        // Locking a streaming session stops it through the Stop path so the
        // outbox hold keeps a queued send from starting a replacement turn.
        stopSessionStream: (sessionId) => handleStopActiveStream(sessionId),
        // "Move to project ›" (row menu) and the bulk bar's Move open the
        // shared project switcher's move menu.
        getProjectSwitcher: (...a) => callbacks.getProjectSwitcher?.(...a),
        // "Link sessions…" (row menu) opens the rail's linked-session popover
        // anchored on the row's ⋯, so linking works with a single open chat.
        openLinkedSessions: (sessionId, anchor) => handleLinkedSessionPopover(sessionId, anchor),
        getPrimaryChatStore: () => primaryChatStore,
        openPrimaryActivity: (request) => root.rendererPrimaryActivity?.getDefaultPrimaryActivity?.(primaryDialogDeps())?.open(request),
        confirmPrimaryReset: (request) => primaryResetDialog()?.confirmReset(request),
        confirmPrimaryForget: (request) => primaryResetDialog()?.confirmForget(request),
        openSendToChat: sendToChatReady
          ? (sessionId, trigger) => root.rendererChatSendModal.getDefaultModal({ showToast: showToastMessage, toastSource: constants.TOAST_SOURCE?.sessionAction, appendClientLog }).open({
            sourceSessionId: sessionId,
            sourceProjectId: (state.sessions || []).find((session) => session?.id === sessionId)?.project_id || '',
            trigger,
          })
          : undefined,
      },
    }) || null;

    // Chats-panel overflow menu. Search is always visible; the inventory
    // action-button keeps new raw primitives out of the shell document.
    const chatsPanelTools = ctx.documentRef.getElementById('chatsPanelTools');
    const inventoryActionButtonRef = root.inventoryActionButton;
    if (
      chatsPanelTools
      && typeof inventoryActionButtonRef === 'function'
      && !chatsPanelTools.querySelector('[data-action]')
    ) {
      chatsPanelTools.insertAdjacentHTML('beforeend',
        inventoryActionButtonRef({
          id: 'chats-overflow',
          plain: true,
          className: 'icon-button chats-tool-button',
          domId: 'chatsOverflowButton',
          ariaLabel: jt('app.shell.chatsPanelActions', 'Chats panel actions'),
          title: jt('app.shell.chatsPanelActions', 'Chats panel actions'),
          trustedHtml: '<svg viewBox="0 0 16 16" aria-hidden="true" class="chats-tool-icon chats-tool-icon--dots"><circle cx="3.25" cy="8" r="1.25" /><circle cx="8" cy="8" r="1.25" /><circle cx="12.75" cy="8" r="1.25" /></svg>',
        }));
    }

    const shellEventBindings = (root.rendererShellEventUtils || {}).createShellEventBindings?.({
      state,
      constants: {
        TOAST_SOURCE: constants.TOAST_SOURCE,
      },
      dom: {
        searchInput: dom.searchInput,
        chatsOverflowButton: ctx.documentRef.getElementById('chatsOverflowButton'),
        sidebarResizer: dom.sidebarResizer,
        conversationGroups: dom.conversationGroups,
        sessionActionButton: dom.sessionActionButton,
        localProfileSettingsMount: dom.localProfileSettingsMount,
        checkUpdatesButton: ctx.documentRef.getElementById('checkUpdatesButton'),
        updateSettingsSummary: ctx.documentRef.getElementById('updateSettingsSummary'),
        aboutVersionLine: ctx.documentRef.getElementById('aboutVersionLine'),
        copyLogsReportButton: dom.copyLogsReportButton,
        logList: dom.logList,
        chatInput: dom.chatInput,
      },
      callbacks: {
        renderSessions,
        resetSidebarWidth,
        setRovingChatSession,
        handleSidebarResizeStart,
        handleSidebarResizeMove,
        finishSidebarResize,
        handleSidebarResizeKeydown,
        renderAll,
        showToastMessage,
        appendClientLog: (...a) => appendClientLog(...a),
        resetLogsViewState,
        renderLogs,
        showSessionActionError,
        getCurrentRuntimePreferences,
        openSessionRowMenu: (...a) => sessionActionsController?.openSessionRowMenu?.(...a) || false,
        openPanelOverflowMenu: (...a) => sessionActionsController?.openPanelOverflowMenu?.(...a) || false,
        toggleArchivedView: () => toggleChatsScope(),
        openSession: (...a) => activateWorkspaceSession(...a),
        setActiveView,
        openSetupTile: (...args) => callbacks.openSetupTile?.(...args),
        openSettingsSection: (...args) => callbacks.openSettingsSection?.(...args),
        getActiveStreamIdForCancel: () => (
          multiStreamController?.getActiveStreamIdForCancel?.(state.currentSessionId)
          || state.activeStreamId
          || ''
        ),
        isSendPreflightPending,
        resetAttachmentQueue,
        ensureLogRowMounted,
        scrollLogsToBottom,
        navigateToDiagnosticsTrace: (...a) => navigateToDiagnosticsTrace(...a),
        refreshPhasePercentiles: (...a) => refreshPhasePercentiles?.(...a),
        resetPhasePercentiles: (...a) => resetPhasePercentiles?.(...a),
        // Passed through unwrapped: Diagnostics publishes its presence as the folder-picker action flag.
        chooseWorkspaceRoot: callbacks.chooseWorkspaceRoot,
        handleWorkspaceShortcut: (...a) => handleWorkspaceShortcut(...a),
      },
    }) || null;
    if (shellEventBindings) {
      shellEventBindings.bind();
      registerCleanup(() => shellEventBindings.dispose?.());
    }

    const commandPaletteController = (root.rendererCommandPaletteUtils || {}).createCommandPaletteController?.({
      state,
      // Injected so the palette won't open over a manager-registered overlay
      // (e.g. the quick-settings modal, next wave); see isAnotherOverlayOpen
      // in renderer-command-palette.js. Absent-safe if unbound.
      overlayManager: controllers.overlayManager,
      dom: {
        commandPaletteOverlay: dom.commandPaletteOverlay,
        commandPaletteInput: dom.commandPaletteInput,
        commandPaletteList: dom.commandPaletteList,
        commandPaletteScope: dom.commandPaletteScope,
        commandPaletteCount: dom.commandPaletteCount,
        commandPaletteLegend: dom.commandPaletteLegend,
        commandPaletteStatus: dom.commandPaletteStatus,
        commandPaletteFieldIcon: dom.commandPaletteFieldIcon,
        titlebarPalettePill: dom.titlebarPalettePill,
      },
      callbacks: {
        setActiveView: (...a) => setActiveView(...a),
        activateWorkspaceSession: (...a) => activateWorkspaceSession(...a),
        listSlashCommands: () => chatShellController?.listSlashCommands?.() || [],
        tryExecuteSlashCommand: (prompt) => chatShellController?.startPromptSend?.(prompt)
          ?? chatShellController?.tryExecuteSlashCommand?.(prompt) ?? false,
        insertSlashCommand: (prompt) => chatShellController?.insertSlashCommand?.(prompt) || false,
        clickNewChat: () => { try { dom.newChatButton?.click?.(); } catch (_err) { /* noop */ } },
        focusConversationSearch: () => { try { dom.searchInput?.focus?.(); } catch (_err) { /* noop */ } },
        toggleSidebarCollapsed: () => {
          try {
            root.rendererTopNavShellController?.togglePanelForActiveView?.();
          } catch (_err) { /* noop */ }
        },
        appendClientLog: (...a) => appendClientLog(...a),
        showToastMessage: (...a) => showToastMessage(...a),
        escapeHtml,
        listPendingUndos: () => sessionActionsController?.listPendingUndos?.() || [],
        // Session hygiene commands (nav overhaul W11). The async controller
        // paths surface their own error toasts; swallow the rejections here.
        togglePinActiveSession: () => { Promise.resolve(sessionActionsController?.togglePinSession?.(state.currentSessionId)).catch(() => {}); },
        toggleArchiveActiveSession: () => { Promise.resolve(sessionActionsController?.toggleArchiveSession?.(state.currentSessionId)).catch(() => {}); },
        toggleArchivedView: () => toggleChatsScope(),
        sweepEmptyChats: () => { Promise.resolve(sessionActionsController?.sweepEmptyChats?.()).catch(() => {}); },
        // Workspace IDE palette commands (Tier 1.5). Gated on the active view so
        // the IDE controller is never force-created off-IDE (it already exists
        // once you're on the IDE view); empty elsewhere keeps the palette scoped.
        getIdeCommandItems: () => (state.ui?.activeView === 'ide' ? getIdeCommandItemsCb() : []),
        // Settings rows ride the same navigate-to-section seam the Settings
        // page's own search box uses, so the palette never re-implements the
        // jump (or drifts from it).
        openSettingsSection: (...a) => openSettingsSection?.(...a),
        ensureSettingsPage: () => controllers.settingsShellController?.ensureSettingsPage?.(),
        // "Keyboard shortcuts" routes to the IDE overlay on the IDE view, else
        // the chat shortcuts overlay (replaces the prior no-op hint toast).
        openKeyboardShortcuts: () => {
          if (state.ui?.activeView === 'ide') {
            openIdeHelpOverlay();
          } else {
            try { chatShellController?.openKeyboardShortcuts?.(); } catch (_err) { /* noop */ }
          }
        },
      },
    }) || null;
    if (commandPaletteController) {
      commandPaletteController.bind();
      registerCleanup(() => commandPaletteController.dispose?.());
      // This bind ran on placeholder flags (command_palette absent, so the
      // gate failed); bootstrapAppShell re-binds once real flags are loaded.
      ctx.controllers.commandPaletteController = commandPaletteController;
    }

    // Scratchpad quick-capture (Phase 3 "capture from anywhere"): a global popover
    // backed by a lightweight, capture-only scratchpad-actions instance, so
    // Ctrl+Shift+Space saves a thought to the active Home note from any view
    // without opening Home. Bound here (always-alive) rather than in the lazy
    // dashboard controller so the chord works even before Home is first rendered.
    // The instance shares the single source of truth in state.homeConfig.scratchpad
    // and writes immediately (no debounce / no timer).
    let scratchpadCaptureController = null;
    {
      const captureActions = (root.rendererDashboardScratchpadActions || {}).createScratchpadActions?.({
        shell: windowRef?.jennyShell || root.jennyShell || null,
        appendClientLog: (...a) => appendClientLog(...a),
        getScratchpad: () => (state.homeConfig ? state.homeConfig.scratchpad : null),
        getHomeConfig: () => state.homeConfig,
        onHomeConfig: (config) => {
          if (config && typeof config === 'object') {
            state.homeConfig = config;
          }
          renderAll();
        },
      }) || null;
      if (captureActions) {
        scratchpadCaptureController = (root.rendererScratchpadCapture || {}).createScratchpadCaptureController?.({
          documentRef: ctx.documentRef,
          textField: root.inventoryTextField,
          showToastMessage,
          appendClientLog: (...a) => appendClientLog(...a),
          onCapture: (text, options) => captureActions.captureToScratchpad(text, options),
        }) || null;
      }
      if (scratchpadCaptureController) {
        registerCleanup(() => scratchpadCaptureController.dispose?.());
      }
    }

    // App-level shortcuts (nav overhaul W10): Ctrl+1-6 views, Ctrl+N new chat,
    // Ctrl+B panel toggle, Ctrl+Shift+Space scratchpad capture, Ctrl+Shift+\ split toggle.
    const globalShortcutsController = (root.rendererGlobalShortcuts || {}).createGlobalShortcutsController?.({
      windowRef,
      // The startup curtain owns the keyboard until it is removed, like a modal.
      isOverlayOpen: () => Boolean(ctx.documentRef?.getElementById?.('startupOverlay'))
        || (controllers.overlayManager?.getDepth?.() || 0) > 0,
      overlayManager: controllers.overlayManager || null,
      // The palette is a launcher, not a modal: the capture chord dismisses it.
      captureYieldingOverlayIds: [(root.rendererCommandPaletteUtils || {}).COMMAND_PALETTE_OVERLAY_ID],
      callbacks: {
        setActiveView: (...a) => setActiveView(...a),
        newChat: () => { try { dom.newChatButton?.click?.(); } catch (_err) { /* noop */ } },
        // In the Workspace, Ctrl+B toggles the side that holds Files (row 40 W3).
        togglePanel: () => (state?.ui?.activeView === 'ide' && root.rendererIdeWorkbenchWiring?.getActive?.()?.togglePrimarySide?.() === true)
          || root.rendererTopNavShellController?.togglePanelForActiveView?.() === true,
        togglePaneSplit: () => root.rendererAppPaneComposition?.getPaneComposition?.()?.toggleSplit?.() === true,
        appendClientLog: (...a) => appendClientLog(...a),
        openCapture: () => {
          // Respect the per-user opt-out (Settings ▸ Home ▸ Quick-capture
          // shortcut). Defaults on when the setting is absent/not yet loaded.
          if (state?.homeConfig?.scratchpad?.settings?.globalCapture === false) {
            return;
          }
          try { scratchpadCaptureController?.open?.(); } catch (_err) { /* noop */ }
        },
      },
    }) || null;
    if (globalShortcutsController) {
      globalShortcutsController.bind();
      registerCleanup(() => globalShortcutsController.dispose?.());
    }

    const textFieldContextMenuController = root.rendererChatEventInteractiveBindings
      ?.bindTextFieldContextMenu?.({
        delegateRoot: ctx.documentRef,
        addCleanup: registerCleanup,
        spellcheckApi: windowRef?.jennyShell?.spellcheck || null,
        appendClientLog: (...a) => appendClientLog(...a),
        showActionError: showSessionActionError,
        isEnabled: () => state?.features?.featureFlags?.text_spellcheck !== false,
      }) || null;
    if (textFieldContextMenuController) {
      registerCleanup(() => textFieldContextMenuController.dispose?.());
    }

    // Push-to-talk dictation (row 84): the mic beside Send and the Ctrl+Space hold.
    const dictationController = (root.rendererDictationController || {}).createDictationController?.({
      windowRef,
      documentRef: ctx.documentRef,
      state,
      appendClientLog: (...a) => appendClientLog(...a),
      getPrimaryComposerInput: () => dom.chatInput || null,
      getPaneComposition: () => root.rendererAppPaneComposition?.getPaneComposition?.() || null,
      isOverlayOpen: () => Boolean(ctx.documentRef?.getElementById?.('startupOverlay'))
        || (controllers.overlayManager?.getDepth?.() || 0) > 0,
      openSettingsSection: (...a) => openSettingsSection?.(...a),
    }) || null;
    if (dictationController) {
      dictationController.bind();
      root.rendererDictationLive = dictationController;
      registerCleanup(() => {
        dictationController.dispose();
        if (root.rendererDictationLive === dictationController) root.rendererDictationLive = null;
      });
    }

  }

  function bindAttachments(ctx) {
    const { state, constants, dom, refs, callbacks } = ctx;
    const {
      appendClientLog,
      closeComposerPopover,
      openComposerPopover,
      escapeHtml,
      getDroppedFilePaths,
      beginAttachmentToken,
      cancelAttachmentToken,
      handleAttachmentPicker,
      prepareDroppedAttachments,
      queueInlineImageAttachment,
      registerCleanup,
      removeQueuedAttachment,
      renderAttachmentTray,
      resetAttachmentQueue,
      setDropActive,
      showToastMessage,
      suppressFileDropNavigation,
      toErrorMessage,
      updateComposerSafeOffset,
    } = callbacks;

    const attachmentEventBindings = (root.rendererAttachmentEventUtils || {}).createAttachmentEventBindings?.({
      state,
      constants: { TOAST_SOURCE: constants.TOAST_SOURCE },
      dom: {
        attachmentTray: dom.attachmentTray,
        composerAttachMenu: dom.composerAttachMenu,
        composerAttachShortcut: dom.composerAttachShortcut,
        chatInput: dom.chatInput,
        chatView: dom.chatView,
        attachFilesButton: dom.attachFilesButton,
        captureScreenButton: dom.captureScreenButton,
      },
      callbacks: {
        resetAttachmentQueue,
        removeQueuedAttachment,
        renderAttachmentTray,
        suppressFileDropNavigation,
        setDropActive,
        prepareDroppedAttachments,
        getDroppedFilePaths,
        beginAttachmentToken,
        cancelAttachmentToken,
        renderComposerPopover: (...args) => refs.getRenderComposerPopover()(...args),
        updateComposerSafeOffset,
        closeComposerPopover: (...args) => closeComposerPopover(...args),
        openComposerPopover: (...args) => openComposerPopover(...args),
        appendClientLog: (...a) => appendClientLog(...a),
        queueInlineImageAttachment,
        handleAttachmentPicker,
        showToastMessage,
        toErrorMessage,
      },
    }) || null;
    if (attachmentEventBindings) {
      attachmentEventBindings.bind();
      registerCleanup(() => attachmentEventBindings.dispose?.());
    }

  }

  root.rendererAppShellBindingsControllers = {
    bindShellEventControllers,
    bindAttachments,
  };
})(window);
