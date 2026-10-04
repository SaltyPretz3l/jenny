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
        if (!targetEntry || event.target !== targetEntry) return; // only the article itself opens Edit; a control inside it (Copy, a link) keeps its native Enter
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

  return { createChatKeyboardController, isTextInputFocused, getChatEntries };
});
