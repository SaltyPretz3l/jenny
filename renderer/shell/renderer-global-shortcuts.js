/* renderer/shell/renderer-global-shortcuts.js – app-level keyboard shortcuts (UMD)
   Ctrl+1..5 (view tabs, order = VIEW_TAB_ORDER), Ctrl+N (new chat), Ctrl+B
   (toggle the active view's panel).

   Text-editing surfaces own Ctrl+1..5/N/B. The Ctrl+Shift+Space capture chord
   is exempt by design and may fire from anywhere, including editors.
   Every chord here stands down while the shared overlay manager reports an
   open overlay, with one exception: over a launcher-style overlay listed in
   deps.captureYieldingOverlayIds (the command palette) the capture chord
   dismisses it through the owner's close path and proceeds.
   After a view switch lands, focus moves to the destination toprail tab
   via window.rendererTopNavShellController. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererGlobalShortcuts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var DIGIT_KEYS = ['1', '2', '3', '4', '5'];

  // Same predicate as renderer-chat-keyboard-utils.js's isTextInputFocused,
  // duplicated (not required) so this module has no load-order dependency on
  // the chat bundle -- it must work even when chat scripts haven't run yet.
  function isTextEditingSurfaceFocused(doc) {
    const activeEl = doc && doc.activeElement;
    if (!activeEl) return false;
    const tag = String(activeEl.tagName || '').toUpperCase();
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') {
      const type = String(activeEl.type || '').toLowerCase();
      return type !== 'checkbox' && type !== 'radio' && type !== 'button' && type !== 'submit';
    }
    return Boolean(activeEl.isContentEditable);
  }

  function createGlobalShortcutsController(deps) {
    const windowRef = deps.windowRef || (typeof window !== 'undefined' ? window : null);
    const documentRef = deps.documentRef || (windowRef && windowRef.document)
      || (typeof document !== 'undefined' ? document : null);
    const {
      setActiveView,
      newChat,
      togglePanel,
      openCapture,
      appendClientLog,
    } = deps.callbacks || {};
    const isOverlayOpen = typeof deps.isOverlayOpen === 'function'
      ? deps.isOverlayOpen
      : function () { return false; };
    const rootRef = typeof globalThis !== 'undefined' ? globalThis : {};
    // Single source of truth shared with the rail; never re-declare the order.
    const viewOrder = (rootRef.rendererTopRailUtils || {}).VIEW_TAB_ORDER
      || ['home', 'chat', 'ide', 'logs', 'settings'];
    // A launcher-style overlay (the command palette) yields to the capture
    // chord: the chord dismisses it through the owner's close path -- the same
    // one Escape runs -- and proceeds. A modal, or anything stacked on the
    // launcher, still stands every chord down.
    const overlayManager = deps.overlayManager || null;
    const captureYieldingOverlayIds = Array.isArray(deps.captureYieldingOverlayIds)
      ? deps.captureYieldingOverlayIds.filter(Boolean) : [];

    function isCaptureChord(event) {
      return Boolean(event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey
        && !event.defaultPrevented && !event.isComposing
        && (event.key === ' ' || event.code === 'Space'));
    }

    function dismissCaptureYieldingOverlay() {
      if (!overlayManager || typeof overlayManager.getDepth !== 'function'
        || typeof overlayManager.requestClose !== 'function') return false;
      let depth;
      try { depth = overlayManager.getDepth(); } catch (_err) { return false; }
      if (depth !== 1) return false;
      const id = captureYieldingOverlayIds.find((candidate) => overlayManager.isOpen?.(candidate) === true);
      return Boolean(id) && overlayManager.requestClose(id, 'capture_chord') === true;
    }

    function handleKeydown(event) {
      // A managed overlay (quick settings, a confirm dialog) owns the keyboard
      // while it is up: switching views or creating a chat behind a modal --
      // and handing focus to a rail tab the overlay just marked inert -- is
      // never what the chord meant. The capture chord stands down too, unless
      // the only open overlay is a launcher it may dismiss (the palette).
      let overlayOpen = false;
      try { overlayOpen = isOverlayOpen() === true; } catch (_err) { /* noop */ }
      if (overlayOpen && !(isCaptureChord(event) && dismissCaptureYieldingOverlay())) {
        return;
      }
      // Ctrl+Shift+Space → scratchpad quick-capture, handled before the no-shift
      // guard below (this is the one shifted chord we own). Fires from any view
      // and even from inside editors — it is the dedicated capture trigger.
      if (isCaptureChord(event)) {
        if (typeof openCapture === 'function') {
          event.preventDefault();
          openCapture();
          appendClientLog?.('INFO', 'shortcuts.scratchpad_capture', { key: 'Ctrl+Shift+Space' });
        }
        return;
      }
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
      }
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      // UIUX-020: Monaco, the terminal, the composer, and every other
      // text-editing surface own their own keystrokes while focused --
      // digit/N/B must not steal focus out from under someone mid-edit.
      // The Ctrl+Shift+Space chord above is exempt by design; everything
      // past this point is not.
      if (isTextEditingSurfaceFocused(documentRef)) {
        return;
      }
      const key = String(event.key || '');
      const digitIndex = DIGIT_KEYS.indexOf(key);
      if (digitIndex >= 0) {
        event.preventDefault();
        const viewId = viewOrder[digitIndex];
        if (viewId && typeof setActiveView === 'function') {
          setActiveView(viewId);
          appendClientLog?.('INFO', 'shortcuts.view_switch', { viewId, key: `Ctrl+${key}` });
          // Land focus on the destination toprail tab -- the same handoff
          // activateRailTab() does for mouse/arrow-key rail navigation, so
          // Ctrl+1..5 never leaves focus stranded on a control that just
          // moved into a hidden/inert view.
          rootRef.rendererTopNavShellController?.focusActiveViewTab?.(viewId);
        }
        return;
      }
      const lower = key.toLowerCase();
      if (lower === 'n') {
        event.preventDefault();
        newChat?.();
        appendClientLog?.('INFO', 'shortcuts.new_chat', { key: 'Ctrl+N' });
        return;
      }
      if (lower === 'b') {
        event.preventDefault();
        const toggled = togglePanel?.();
        appendClientLog?.('INFO', 'shortcuts.panel_toggle', { toggled: toggled === true });
      }
    }

    function bind() {
      windowRef?.addEventListener?.('keydown', handleKeydown, true);
    }

    function dispose() {
      windowRef?.removeEventListener?.('keydown', handleKeydown, true);
    }

    return { bind, dispose, handleKeydown };
  }

  return { createGlobalShortcutsController };
});
