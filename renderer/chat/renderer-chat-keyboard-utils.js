/* renderer/chat/renderer-chat-keyboard-utils.js
 *
 * E3: roving-tabindex focus controller for `.chat-entry` rows in the
 * timeline. Owns no DOM mutation outside of `tabindex` / `.focus()` on
 * chat-entry rows. All key handlers are registered via the caller-supplied
 * AbortSignal so cleanup is automatic on pipeline dispose
 * (AGENTS.md §5: listeners must be cleanable).
 *
 * Key handling:
 *   Alt+ArrowDown  -> focus next chat-entry
 *   Alt+ArrowUp    -> focus previous chat-entry
 *   Home           -> focus first chat-entry (only when timeline is the
 *                     active focus region — guard via document.activeElement)
 *   End            -> focus last chat-entry  (same guard)
 *
 * Roving model: at most one `.chat-entry` carries `tabindex="0"`, the
 * remainder carry `tabindex="-1"`. The markup builders in
 * renderer-turn-shell.js / renderer-render-pipeline-utils.js emit every
 * chat-entry with `tabindex="-1"` by default; this controller promotes the
 * focused entry to `tabindex="0"` and demotes the previous one. After a
 * re-render the controller restores the active index on the next user
 * interaction (or via `syncTabindex()` called externally).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatKeyboardUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * Shared focus probe: returns true when the document's active element is
   * a text-editing target (textarea, text-y input, contenteditable). Used by
   * both the timeline keyboard controller (E3) and the help-overlay `?`
   * handler (E7) to avoid intercepting keys while the user is typing.
   */
  /**
   * Shared timeline-entries query. Used by the keyboard controller (E3)
   * for roving-tabindex traversal and by the B5 virtualizer to enumerate
   * candidates for mount/unmount. Returns a plain Array (snapshot) so
   * callers can iterate without worrying about live-NodeList mutation
   * during their loop.
   */
  function getChatEntries(chatTimeline) {
    if (!chatTimeline || typeof chatTimeline.querySelectorAll !== 'function') {
      return [];
    }
    return Array.from(chatTimeline.querySelectorAll('.chat-entry'));
  }

  function isTextInputFocused(doc) {
    const document = doc || (typeof globalThis !== 'undefined' ? globalThis.document : null);
    const activeEl = document && document.activeElement;
    if (!activeEl) return false;
    const tag = String(activeEl.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = String(activeEl.type || '').toLowerCase();
      return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
    }
    if (activeEl.isContentEditable) return true;
    return false;
  }

  function createChatKeyboardController(deps) {
    const options = deps || {};
    const chatTimeline = options.chatTimeline || null;
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    // B5: optional restore-on-focus callback. If a target chat-entry has
    // been virtualized (data-virtualized="true"), the keyboard
    // controller calls ensureMounted(target) before .focus() so the
    // restored DOM is addressable. No-op when the virtualizer is absent
    // or below threshold.
    const ensureMounted = typeof options.ensureMounted === 'function'
      ? options.ensureMounted
      : null;
    // F2: optional callback invoked when the user presses Enter on a
    // focused user-message row. Wired from the messageEditController so
    // Enter on a user `.chat-entry` opens inline edit mode. No-op when
    // missing — the focused row stays focused and the keystroke falls
    // through.
    const onEnterEditFromKeyboard = typeof options.onEnterEditFromKeyboard === 'function'
      ? options.onEnterEditFromKeyboard
      : null;
    // F3: Ctrl+Shift+B on a focused row creates a branch at that message.
    const onBranchFromKeyboard = typeof options.onBranchFromKeyboard === 'function'
      ? options.onBranchFromKeyboard
      : null;
    // F10: Ctrl+Shift+U jumps to the first unread row when the unread
    // orientation controller has one queued.
    const onJumpToFirstUnread = typeof options.onJumpToFirstUnread === 'function'
      ? options.onJumpToFirstUnread
      : null;
    // F4/F5/F6: optional callbacks invoked when the user presses Ctrl+A
    // (select all) or Delete (truncate-from-first-selected) while selection
    // mode is active. The keyboard controller doesn't read selection state
    // directly — the callbacks consult the selectionController internally so
    // the keyboard layer stays decoupled. No-op when missing.
    const onSelectAllFromKeyboard = typeof options.onSelectAllFromKeyboard === 'function'
      ? options.onSelectAllFromKeyboard
      : null;
    const onDeleteFromSelection = typeof options.onDeleteFromSelection === 'function'
      ? options.onDeleteFromSelection
      : null;
    const isSelectionModeActive = typeof options.isSelectionModeActive === 'function'
      ? options.isSelectionModeActive
      : function alwaysFalse() { return false; };

    let activeMessageId = '';

    function getEntries() { return getChatEntries(chatTimeline); }

    // Write tabindex on each entry only when the value actually changes, so
    // a re-sync after a render doesn't cause N no-op DOM mutations (each of
    // which can trigger style/layout invalidation downstream).
    function applyRovingTabindex(entries, activeIndex) {
      for (let i = 0; i < entries.length; i++) {
        const next = i === activeIndex ? '0' : '-1';
        if (entries[i].getAttribute('tabindex') !== next) {
          entries[i].setAttribute('tabindex', next);
        }
      }
    }

    function syncTabindex() {
      const entries = getEntries();
      if (!entries.length) {
        activeMessageId = '';
        return;
      }
      let activeIndex = -1;
      if (activeMessageId) {
        activeIndex = entries.findIndex(function (entry) {
          return entry.getAttribute('data-message-id') === activeMessageId;
        });
      }
      if (activeIndex < 0) {
        activeIndex = 0;
        activeMessageId = entries[0].getAttribute('data-message-id') || '';
      }
      applyRovingTabindex(entries, activeIndex);
    }

    function focusEntryAtIndex(index) {
      const entries = getEntries();
      if (!entries.length) {
        return false;
      }
      const clamped = Math.max(0, Math.min(entries.length - 1, index));
      const target = entries[clamped];
      if (!target) {
        return false;
      }
      activeMessageId = target.getAttribute('data-message-id') || '';
      applyRovingTabindex(entries, clamped);
      // B5: if the target was virtualized, restore its DOM synchronously
      // before focus — focus() on an empty placeholder leaves the user
      // with no caret target and Home/End would silently no-op.
      if (ensureMounted && target.getAttribute('data-virtualized') === 'true') {
        try { ensureMounted(target); } catch (_e) { /* best-effort */ }
      }
      target.focus({ preventScroll: false });
      return true;
    }

    function indexFromEvent(event) {
      const entries = getEntries();
      if (!entries.length) return -1;
      const targetEntry = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('.chat-entry')
        : null;
      if (targetEntry) {
        const idx = entries.indexOf(targetEntry);
        if (idx >= 0) {
          activeMessageId = targetEntry.getAttribute('data-message-id') || '';
          return idx;
        }
      }
      if (activeMessageId) {
        const restored = entries.findIndex(function (entry) {
          return entry.getAttribute('data-message-id') === activeMessageId;
        });
        if (restored >= 0) return restored;
      }
      return -1;
    }

    function handleTimelineKeydown(event) {
      const key = String(event.key || '');
      if (event.altKey && (key === 'ArrowDown' || key === 'ArrowUp')) {
        const currentIndex = indexFromEvent(event);
        const entries = getEntries();
        if (!entries.length) return;
        const base = currentIndex >= 0 ? currentIndex : 0;
        const next = key === 'ArrowDown' ? base + 1 : base - 1;
        event.preventDefault();
        focusEntryAtIndex(next);
        return;
      }
      if (key === 'Home' && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        if (isTextInputFocused(doc)) return;
        event.preventDefault();
        focusEntryAtIndex(0);
        return;
      }
      if (key === 'End' && !event.ctrlKey && !event.shiftKey && !event.altKey) {
        if (isTextInputFocused(doc)) return;
        event.preventDefault();
        const entries = getEntries();
        focusEntryAtIndex(entries.length - 1);
        return;
      }
      // F2: Enter on a focused user-message row → enter inline edit mode.
      // Guarded so it never intercepts Enter inside a text input, and
      // never with modifiers (Ctrl/Shift/Alt/Meta have their own meanings).
      if (
        (key === 'b' || key === 'B')
        && (event.ctrlKey || event.metaKey)
        && event.shiftKey
        && !event.altKey
        && onBranchFromKeyboard
      ) {
        if (isTextInputFocused(doc)) return;
        const targetEntry = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('.chat-entry')
          : null;
        if (!targetEntry) return;
        const messageId = String(targetEntry.getAttribute('data-message-id') || '').trim();
        if (!messageId) return;
        event.preventDefault();
        try {
          onBranchFromKeyboard(messageId);
        } catch (_e) { /* best-effort */ }
        return;
      }
      if (
        (key === 'u' || key === 'U')
        && (event.ctrlKey || event.metaKey)
        && event.shiftKey
        && !event.altKey
        && onJumpToFirstUnread
      ) {
        if (isTextInputFocused(doc)) return;
        event.preventDefault();
        try { onJumpToFirstUnread(); } catch (_e) { /* best-effort */ }
        return;
      }
      if (
        key === 'Enter'
        && !event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey
        && onEnterEditFromKeyboard
      ) {
        if (isTextInputFocused(doc)) return;
        const targetEntry = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('.chat-entry')
          : null;
        if (!targetEntry) return;
        const role = String(targetEntry.getAttribute('data-message-role') || '').trim();
        if (role !== 'user') return;
        const messageId = String(targetEntry.getAttribute('data-message-id') || '').trim();
        if (!messageId) return;
        event.preventDefault();
        try {
          onEnterEditFromKeyboard(messageId);
        } catch (_e) { /* best-effort — focus stays on the row */ }
        return;
      }
      // F4: Ctrl+A while selection mode is active → select all messages.
      // Bail on text-input focus so the browser default (select-all in the
      // textarea) wins inside the composer.
      if (
        (key === 'a' || key === 'A')
        && (event.ctrlKey || event.metaKey)
        && !event.altKey && !event.shiftKey
        && onSelectAllFromKeyboard
        && isSelectionModeActive() === true
      ) {
        if (isTextInputFocused(doc)) return;
        event.preventDefault();
        try { onSelectAllFromKeyboard(); } catch (_e) { /* best-effort */ }
        return;
      }
      // F4: Delete while selection mode is active and ≥1 row selected →
      // truncate from the earliest-selected message onward via the bulk
      // controller's delete-from-here path.
      if (
        (key === 'Delete' || key === 'Del')
        && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
        && onDeleteFromSelection
        && isSelectionModeActive() === true
      ) {
        if (isTextInputFocused(doc)) return;
        event.preventDefault();
        try { onDeleteFromSelection(); } catch (_e) { /* best-effort */ }
      }
    }

    function handleTimelineFocusIn(event) {
      const targetEntry = event.target && typeof event.target.closest === 'function'
        ? event.target.closest('.chat-entry')
        : null;
      if (!targetEntry) return;
      const entries = getEntries();
      const idx = entries.indexOf(targetEntry);
      if (idx < 0) return;
      activeMessageId = targetEntry.getAttribute('data-message-id') || '';
      applyRovingTabindex(entries, idx);
    }

    function attach(registerListener, listenerOptions) {
      if (!chatTimeline) {
        return function noopDetachKeyboard() {};
      }
      if (typeof registerListener !== 'function') {
        // Fall back to direct addEventListener when no register helper is
        // provided. The returned function detaches both listeners.
        chatTimeline.addEventListener('keydown', handleTimelineKeydown, listenerOptions);
        chatTimeline.addEventListener('focusin', handleTimelineFocusIn, listenerOptions);
        return function detachKeyboardController() {
          chatTimeline.removeEventListener('keydown', handleTimelineKeydown, listenerOptions);
          chatTimeline.removeEventListener('focusin', handleTimelineFocusIn, listenerOptions);
        };
      }
      registerListener(chatTimeline, 'keydown', handleTimelineKeydown, listenerOptions);
      registerListener(chatTimeline, 'focusin', handleTimelineFocusIn, listenerOptions);
      return function noopDetachRegisteredKeyboard() {};
    }

    return {
      attach,
      syncTabindex,
      focusEntryAtIndex,
      getActiveMessageId: function () { return activeMessageId; },
    };
  }

  // Convenience wire-up for renderer-chat-event-utils. Keeps the parent
  // bind() function lean (file is at the 1000-line cap) by delegating
  // E3 (keyboard controller), E7 (help overlay), and F1+E6 (Ctrl+F
  // search overlay) registration here.
  function wireChatAccessibility(deps) {
    const options = deps || {};
    const state = options.state || {};
    const chatTimeline = options.chatTimeline || null;
    const chatThreadScroll = options.chatThreadScroll || null;
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const registerListener = options.registerListener;
    const listenerOptions = options.listenerOptions;
    const addCleanup = typeof options.addCleanup === 'function' ? options.addCleanup : null;
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
    const keyboardController = createChatKeyboardController({
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
    // F4/F5/F6: attach the selectionController's document-level Esc listener
    // and mount the inventory action bar when selection mode flips on.
    if (selectionController && typeof selectionController.attach === 'function') {
      try {
        const detachSelection = selectionController.attach(registerListener, listenerOptions);
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
    const selectionBarHost = doc ? doc.getElementById('chatSelectionOverlayHost') : null;
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
      // state.ui.selectionMode and refreshes the count badge.
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
    if (helpOverlayUtils && typeof helpOverlayUtils.createChatHelpOverlay === 'function') {
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
    if (searchOverlayUtils && typeof searchOverlayUtils.createChatSearchOverlay === 'function') {
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
          getCurrentSessionMessages: options.getCurrentSessionMessages,
          getSessionTurnEventState: options.getSessionTurnEventState,
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

  return { createChatKeyboardController, wireChatAccessibility, isTextInputFocused, getChatEntries };
});
