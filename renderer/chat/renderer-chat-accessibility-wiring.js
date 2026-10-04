/* renderer/chat/renderer-chat-accessibility-wiring.js
 *
 * One call that wires a chat timeline's accessibility surface for
 * renderer-chat-event-utils: the roving-tabindex keyboard controller (E3),
 * the help overlay (E7), the Ctrl+F search overlay (F1+E6), the selection
 * action bar, the unread orientation and the citation jump controllers.
 * A second pane passes `documentLevel: false` and gets no help or search
 * overlay. Every listener goes through the caller's `registerListener`, so
 * cleanup follows the pipeline's dispose.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-chat-keyboard-utils'));
    return;
  }
  root.rendererChatAccessibilityWiring = factory(root.rendererChatKeyboardUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (keyboardUtils) {
  if (!keyboardUtils || typeof keyboardUtils.createChatKeyboardController !== 'function') {
    throw new Error('rendererChatAccessibilityWiring: renderer-chat-keyboard-utils must load before this module');
  }

  function wireChatAccessibility(deps) {
    const options = deps || {};
    const state = options.state || {};
    const chatTimeline = options.chatTimeline || null;
    const chatThreadScroll = options.chatThreadScroll || null;
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const registerListener = options.registerListener;
    const listenerOptions = options.listenerOptions;
    const addCleanup = typeof options.addCleanup === 'function' ? options.addCleanup : null;
    const documentLevel = options.documentLevel !== false; // W2-3: false = a second pane (no help/Ctrl+F overlays)
    // B5: optional virtualizer instance. When present, the keyboard
    // controller gets an ensureMounted callback (Stage 6) and the F1
    // search overlay gets the same virtualizer for pause/resume (Stage 5).
    const timelineVirtualizer = options.timelineVirtualizer || null;
    const virtualizerEnsureMounted = timelineVirtualizer && typeof timelineVirtualizer.ensureMounted === 'function'
      ? function ensureMounted(entryEl) { timelineVirtualizer.ensureMounted(entryEl); }
      : null;
    // F2: optional message-edit controller. When present, Enter on a focused
    // user `.chat-entry` opens the inline editor through enterEdit(messageId).
    const messageEditController = options.messageEditController || null;
    const messageBranchController = options.messageBranchController || null;
    const unreadOrientationController = options.unreadOrientationController || null;
    const enterEditCallback = messageEditController && typeof messageEditController.enterEdit === 'function'
      ? function enterEditFromKeyboard(messageId) { messageEditController.enterEdit(messageId); }
      : (typeof options.onEnterEditFromKeyboard === 'function' ? options.onEnterEditFromKeyboard : null);
    const branchCallback = messageBranchController && typeof messageBranchController.branchFromMessage === 'function'
      ? function branchFromKeyboard(messageId) { messageBranchController.branchFromMessage(messageId); }
      : (typeof options.onBranchFromKeyboard === 'function' ? options.onBranchFromKeyboard : null);
    const jumpToFirstUnreadCallback = unreadOrientationController && typeof unreadOrientationController.jumpToFirstUnread === 'function'
      ? function jumpToFirstUnreadFromKeyboard() { unreadOrientationController.jumpToFirstUnread(); }
      : (typeof options.onJumpToFirstUnread === 'function' ? options.onJumpToFirstUnread : null);
    // F4/F5/F6: optional selection + bulk-actions controllers. When present,
    // wire the multi-select keyboard shortcuts (Ctrl+A select-all and Delete
    // truncate-from-here) plus the floating selection-action-bar mount.
    const selectionController = options.selectionController || null;
    const bulkActionsController = options.bulkActionsController || null;
    const citationJumpUtils = options.citationJumpUtils
      || (typeof globalThis !== 'undefined' ? globalThis.rendererChatCitationJumpUtils : null);
    const selectAllCallback = selectionController && typeof selectionController.selectAll === 'function'
      ? function selectAllFromKeyboard() { selectionController.selectAll(); }
      : null;
    const deleteFromSelectionCallback = bulkActionsController && typeof bulkActionsController.deleteFromHere === 'function'
      ? function deleteFromSelectionKeyboard() { bulkActionsController.deleteFromHere(); }
      : null;
    const isSelectionModeActive = selectionController && typeof selectionController.isSelectMode === 'function'
      ? function isSelectionModeActiveCb() { return selectionController.isSelectMode(); }
      : function isSelectionModeFalse() { return false; };
    const keyboardController = keyboardUtils.createChatKeyboardController({
      chatTimeline: chatTimeline,
      document: doc,
      ensureMounted: virtualizerEnsureMounted,
      onEnterEditFromKeyboard: enterEditCallback,
      onBranchFromKeyboard: branchCallback,
      onJumpToFirstUnread: jumpToFirstUnreadCallback,
      onSelectAllFromKeyboard: selectAllCallback,
      onDeleteFromSelection: deleteFromSelectionCallback,
      isSelectionModeActive: isSelectionModeActive,
    });
    const detachKeyboard = keyboardController.attach(registerListener, listenerOptions);
    if (addCleanup && typeof detachKeyboard === 'function') {
      addCleanup(detachKeyboard);
    }
    // F4/F5/F6: the selectionController's document-level Esc listener and (W3-1)
    // this pane's timeline Shift+Click entry; the action bar mounts further down.
    if (selectionController && typeof selectionController.attach === 'function') {
      try {
        const detachSelection = selectionController.attach(registerListener, listenerOptions, chatTimeline);
        if (addCleanup && typeof detachSelection === 'function') {
          addCleanup(detachSelection);
        }
      } catch (_e) { /* best-effort */ }
    }
    if (unreadOrientationController) {
      if (typeof unreadOrientationController.attachAffordance === 'function') {
        try { unreadOrientationController.attachAffordance(); } catch (_e) { /* best-effort */ }
      }
      if (!options.chatScrollCoordinator && typeof unreadOrientationController.handleScroll === 'function' && chatThreadScroll) {
        if (typeof registerListener === 'function') {
          registerListener(chatThreadScroll, 'scroll', function onUnreadOrientationScroll() {
            unreadOrientationController.handleScroll();
          }, listenerOptions);
        } else if (typeof chatThreadScroll.addEventListener === 'function') {
          var onUnreadOrientationScroll = function onUnreadOrientationScroll() {
            unreadOrientationController.handleScroll();
          };
          chatThreadScroll.addEventListener('scroll', onUnreadOrientationScroll, listenerOptions);
          if (addCleanup) {
            addCleanup(function detachUnreadOrientationScroll() {
              chatThreadScroll.removeEventListener('scroll', onUnreadOrientationScroll, listenerOptions);
            });
          }
        }
      }
    }
    let citationJumpController = null;
    if (citationJumpUtils && typeof citationJumpUtils.createCitationJumpController === 'function') {
      try {
        citationJumpController = citationJumpUtils.createCitationJumpController({
          document: doc,
          window: options.window || (doc ? doc.defaultView : null),
          chatTimeline: chatTimeline,
          getCurrentSessionMessages: options.getCurrentSessionMessages,
          scrollMessageIntoView: options.scrollMessageIntoView,
          viewportReveal: options.viewportReveal,
          focusEntryByMessageId: options.focusEntryByMessageId,
          timelineVirtualizer: timelineVirtualizer,
          appendClientLog: options.appendClientLog,
        });
        const detachCitationJump = citationJumpController.attach(registerListener, listenerOptions);
        if (addCleanup) {
          if (typeof detachCitationJump === 'function') {
            addCleanup(detachCitationJump);
          }
          addCleanup(function disposeCitationJumpController() {
            try { citationJumpController.dispose(); } catch (_e) { /* best-effort */ }
          });
        }
      } catch (error) {
        if (typeof options.appendClientLog === 'function') {
          options.appendClientLog('WARN', 'chat.citation_jump_controller_init_failed', {
            message: String(error?.message || error || '').slice(0, 160),
          });
        }
        citationJumpController = null;
      }
    }
    const selectionBarHost = options.selectionOverlayHost || (documentLevel && doc ? doc.getElementById('chatSelectionOverlayHost') : null);
    let selectionActionBar = null;
    if (
      selectionController
      && bulkActionsController
      && selectionBarHost
      && typeof globalThis !== 'undefined'
      && globalThis.inventorySelectionActionBar
      && typeof globalThis.inventorySelectionActionBar.createSelectionActionBar === 'function'
    ) {
      selectionActionBar = globalThis.inventorySelectionActionBar.createSelectionActionBar({
        document: doc,
        hostId: 'chat-selection-action-bar',
      });
      // Subscribe each bar event to the matching controller verb.
      selectionActionBar.on('copy-md', function onCopyMd() {
        if (typeof bulkActionsController.copyAsMarkdown === 'function') bulkActionsController.copyAsMarkdown();
      });
      selectionActionBar.on('copy-plain', function onCopyPlain() {
        if (typeof bulkActionsController.copyAsPlainText === 'function') bulkActionsController.copyAsPlainText();
      });
      selectionActionBar.on('export:markdown', function onExportMd() {
        if (typeof bulkActionsController.exportMarkdown === 'function') bulkActionsController.exportMarkdown();
      });
      selectionActionBar.on('export:plain', function onExportPlain() {
        if (typeof bulkActionsController.exportPlainText === 'function') bulkActionsController.exportPlainText();
      });
      selectionActionBar.on('export:json', function onExportJson() {
        if (typeof bulkActionsController.exportTurnEventJson === 'function') bulkActionsController.exportTurnEventJson();
      });
      selectionActionBar.on('export:session-json', function onExportSessionJson() {
        if (typeof bulkActionsController.exportSessionJsonPortable === 'function') bulkActionsController.exportSessionJsonPortable();
      });
      selectionActionBar.on('delete-from-here', function onDeleteFromHere() {
        if (typeof bulkActionsController.deleteFromHere === 'function') bulkActionsController.deleteFromHere();
      });
      selectionActionBar.on('cancel', function onCancelSelection() {
        if (typeof selectionController.exitSelectMode === 'function') selectionController.exitSelectMode();
      });
      // Cleanup: dispose the bar when the pipeline tears down.
      if (addCleanup) {
        addCleanup(function disposeSelectionActionBar() {
          try { selectionActionBar.dispose(); } catch (_e) { /* best-effort */ }
        });
      }
      // Expose a sync helper on the selection controller so renderers can call
      // it after every render — this mounts/unmounts the bar to match
      // whether THIS pane owns selection mode and refreshes the count badge.
      selectionController.syncActionBar = function syncActionBar() {
        if (selectionController.isSelectMode()) {
          selectionActionBar.mount(selectionBarHost);
          const ids = typeof selectionController.getSelectedMessageIds === 'function'
            ? selectionController.getSelectedMessageIds() : [];
          selectionActionBar.setSelectionCount(ids.length);
          selectionActionBar.setBusy(state.ui?.bulkTruncateCommitting === true);
        } else {
          selectionActionBar.unmount();
        }
      };
    }
    const helpOverlayUtils = options.helpOverlayUtils
      || (typeof globalThis !== 'undefined' ? globalThis.rendererChatHelpOverlay : null);
    let helpOverlay = null;
    if (documentLevel && helpOverlayUtils && typeof helpOverlayUtils.createChatHelpOverlay === 'function') {
      // getActiveView lets the chat `?` handler stand down while the Workspace
      // IDE (which owns its own shortcuts overlay) is the active view.
      helpOverlay = helpOverlayUtils.createChatHelpOverlay({
        document: doc,
        getActiveView: options.getActiveView || null,
      });
      const detachHelpOverlay = helpOverlay.attach(registerListener, listenerOptions);
      if (addCleanup) {
        if (typeof detachHelpOverlay === 'function') {
          addCleanup(detachHelpOverlay);
        }
        addCleanup(function disposeChatHelpOverlay() {
          try { helpOverlay.dispose(); } catch (_e) { /* best-effort */ }
        });
      }
    }
    const searchOverlayUtils = options.searchOverlayUtils
      || (typeof globalThis !== 'undefined' ? globalThis.rendererChatSearchOverlay : null);
    let searchOverlay = null;
    if (documentLevel && searchOverlayUtils && typeof searchOverlayUtils.createChatSearchOverlay === 'function') {
      const chatView = options.chatView || (doc ? doc.getElementById('chatView') : null);
      try {
        searchOverlay = searchOverlayUtils.createChatSearchOverlay({
          document: doc,
          chatTimeline: chatTimeline,
          chatView: chatView,
          keyboardController: keyboardController,
          // Search indexes canonical bounded documents and mounts only the
          // selected result; virtualization stays active while the overlay is open.
          virtualizer: timelineVirtualizer,
          // Both read THIS pane's session: the shared reader follows the focused pane, and an argument-free turn-event read is empty.
          getCurrentSessionMessages: options.getSessionId && options.getSessionMessages ? () => options.getSessionMessages(options.getSessionId()) : options.getCurrentSessionMessages,
          getSessionTurnEventState: options.getSessionId && options.getSessionTurnEventState ? () => options.getSessionTurnEventState(options.getSessionId()) : options.getSessionTurnEventState,
          getFeatureFlags: () => state.features?.featureFlags || {},
          renderAll: options.renderAll,
          appendClientLog: options.appendClientLog,
          viewportReveal: options.viewportReveal,
          // UIUX-020: same getActiveView the help overlay below uses to
          // stand down on the IDE view -- Ctrl+F belongs to Monaco there.
          getActiveView: options.getActiveView || null,
        });
        searchOverlay.attach(registerListener, listenerOptions);
        if (addCleanup) {
          addCleanup(function disposeChatSearchOverlay() {
            try { searchOverlay.dispose(); } catch (_e) { /* best-effort */ }
          });
        }
      } catch (_e) {
        // Missing inventory primitive or highlight module at boot —
        // log-free best-effort so chat still works without search.
        searchOverlay = null;
      }
    }
    return {
      keyboardController: keyboardController,
      helpOverlay: helpOverlay,
      searchOverlay: searchOverlay,
      // F4/F5/F6: surface the action-bar handle so the parent can call
      // selectionController.syncActionBar() after each renderAll, or callers
      // can manipulate the bar directly in tests.
      selectionActionBar: selectionActionBar,
      selectionController: selectionController,
      bulkActionsController: bulkActionsController,
      unreadOrientationController: unreadOrientationController,
      citationJumpController: citationJumpController,
    };
  }

  return { wireChatAccessibility };
});
