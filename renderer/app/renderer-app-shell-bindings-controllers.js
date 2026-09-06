(function (root) {
  'use strict';

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
      getLogEntryById,
      ensureLogRowMounted = () => false,
      handleDeleteSessionWithWorkspace,
      handleRenameSession,
      handleStopActiveStream = async () => null,
      handleSidebarResizeKeydown,
      handleSidebarResizeMove,
      handleSidebarResizeStart,
      handleWorkspaceShortcut,
      isSendPreflightPending,
      loadMoreChats,
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
        toggleChatsScope,
        // Locking a streaming session stops it through the Stop path so the
        // outbox hold keeps a queued send from starting a replacement turn.
        stopSessionStream: (sessionId) => handleStopActiveStream(sessionId),
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
          ariaLabel: 'Chats panel actions',
          title: 'Chats panel actions',
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
        copyLogsReportButton: dom.copyLogsReportButton,
        logList: dom.logList,
        chatInput: dom.chatInput,
      },
      callbacks: {
        renderSessions,
        resetSidebarWidth,
        loadMoreChats,
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
        toggleArchivedView: () => {
          if (typeof toggleChatsScope === 'function') return toggleChatsScope();
          return sessionActionsController?.toggleArchivedView?.();
        },
        openSession: (...a) => activateWorkspaceSession(...a),
        setActiveView,
        getActiveStreamIdForCancel: () => (
          multiStreamController?.getActiveStreamIdForCancel?.(state.currentSessionId)
          || state.activeStreamId
          || ''
        ),
        isSendPreflightPending,
        resetAttachmentQueue,
        getLogEntryById,
        ensureLogRowMounted,
        scrollLogsToBottom,
        navigateToDiagnosticsTrace: (...a) => navigateToDiagnosticsTrace(...a),
        refreshPhasePercentiles: (...a) => refreshPhasePercentiles?.(...a),
        resetPhasePercentiles: (...a) => resetPhasePercentiles?.(...a),
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
        toggleArchivedView: () => sessionActionsController?.toggleArchivedView?.(),
        sweepEmptyChats: () => { Promise.resolve(sessionActionsController?.sweepEmptyChats?.()).catch(() => {}); },
        // Workspace IDE palette commands (Tier 1.5). Gated on the active view so
        // the IDE controller is never force-created off-IDE (it already exists
        // once you're on the IDE view); empty elsewhere keeps the palette scoped.
        getIdeCommandItems: () => (state.ui?.activeView === 'ide' ? getIdeCommandItemsCb() : []),
        getPluginCommandItems: () => [],
        // Settings rows ride the same navigate-to-section seam the Settings
        // page's own search box uses, so the palette never re-implements the
        // jump (or drifts from it).
        openSettingsSection: (...a) => openSettingsSection?.(...a),
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
    // Ctrl+B panel toggle, Ctrl+Shift+Space scratchpad capture.
    const globalShortcutsController = (root.rendererGlobalShortcuts || {}).createGlobalShortcutsController?.({
      windowRef,
      callbacks: {
        setActiveView: (...a) => setActiveView(...a),
        newChat: () => { try { dom.newChatButton?.click?.(); } catch (_err) { /* noop */ } },
        togglePanel: () => root.rendererTopNavShellController?.togglePanelForActiveView?.() === true,
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

  }

  function bindAttachments(ctx) {
    const { state, constants, dom, refs, callbacks } = ctx;
    const {
      appendClientLog,
      closeCommandPopover,
      closeComposerPopover,
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
      syncComposerModelSelectWidth,
      toErrorMessage,
      updateComposerSafeOffset,
    } = callbacks;

    const attachmentEventBindings = (root.rendererAttachmentEventUtils || {}).createAttachmentEventBindings?.({
      state,
      constants: { TOAST_SOURCE: constants.TOAST_SOURCE },
      dom: {
        attachmentTray: dom.attachmentTray,
        composerSettingsPopover: dom.composerSettingsPopover,
        composerSettingsButton: dom.composerSettingsButton,
        composerCommandPopover: dom.composerCommandPopover,
        composerTerminalShortcut: dom.composerTerminalShortcut,
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
        renderCommandPopover: (...args) => refs.getRenderCommandPopover()(...args),
        syncComposerModelSelectWidth,
        updateComposerSafeOffset,
        closeComposerPopover: (...args) => closeComposerPopover(...args),
        closeCommandPopover: (...args) => closeCommandPopover(...args),
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

    if (!attachmentEventBindings && dom.composerTerminalShortcut) {
      dom.composerTerminalShortcut.onclick = () => {
        const renderCommandPopover = refs.getRenderCommandPopover();
        if (state.ui.commandPopoverOpen) {
          state.ui.commandPopoverOpen = false;
          renderCommandPopover();
          dom.composerTerminalShortcut.focus();
          return;
        }
        if (state.ui.composerPopoverOpen) {
          closeComposerPopover();
        }
        state.ui.commandPopoverOpen = true;
        renderCommandPopover();
      };
      registerCleanup(() => {
        if (dom.composerTerminalShortcut.onclick) {
          dom.composerTerminalShortcut.onclick = null;
        }
      });
    }

  }

  root.rendererAppShellBindingsControllers = {
    bindShellEventControllers,
    bindAttachments,
  };
})(window);
