/* renderer/shell/renderer-global-shortcuts.js – app-level keyboard shortcuts (UMD)
   Ctrl+1..5 (view tabs, order = VIEW_TAB_ORDER), Ctrl+N (new chat), Ctrl+B
   (toggle the active view's panel), Ctrl+Shift+\ (split view W1-4c: open the
   most recent other tab beside, or close the non-focused pane).

   Inside the Workspace view (row 82, picks O1/O2) Ctrl+1..5 and Ctrl+N belong to
   the IDE keymap (editor groups, new file); Ctrl+Alt+1..5 switch views from
   anywhere. Ctrl+B also fires from the Workspace's Monaco editor (VS Code's
   toggle side bar works from the editor).

   Text-editing surfaces own Ctrl+1..5/N/B. The Ctrl+Shift+Space capture chord
   is exempt by design and may fire from anywhere, including editors. The
   split chord also fires from a chat composer (.composer-input) and stands
   down in every other editor (Monaco binds Ctrl+Shift+\ to jump-to-bracket).
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

  function isForeignTextEditingSurfaceFocused(doc) {
    if (!isTextEditingSurfaceFocused(doc)) return false;
    return !(doc.activeElement.classList && doc.activeElement.classList.contains('composer-input'));
  }

  function closestOf(target, selector) {
    try {
      return target && typeof target.closest === 'function' ? target.closest(selector) : null;
    } catch (_err) { return null; }
  }

  function isInsideWorkspaceView(event) {
    return Boolean(closestOf(event.target, '#ideView'));
  }

  function isPaneSplitChord(event) {
    return Boolean(event.ctrlKey && event.shiftKey && !event.metaKey && !event.altKey
      && !event.defaultPrevented && !event.isComposing
      && (event.code === 'Backslash' || event.key === '\\' || event.key === '|'));
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
      togglePaneSplit,
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
          // A held chord auto-repeats keydown; act on the first press only.
          if (event.repeat) return;
          openCapture();
          appendClientLog?.('INFO', 'shortcuts.scratchpad_capture', { key: 'Ctrl+Shift+Space' });
        }
        return;
      }
      if (isPaneSplitChord(event)) {
        if (typeof togglePaneSplit !== 'function' || isForeignTextEditingSurfaceFocused(documentRef)) return;
        event.preventDefault();
        if (event.repeat) return;
        const toggled = togglePaneSplit();
        appendClientLog?.('INFO', 'shortcuts.pane_split_toggle', { toggled: toggled === true });
        return;
      }
      // Ctrl+Alt+1..5: the view tabs from anywhere, editors included (O1). AltGr
      // reports Ctrl+Alt on Windows layouts that type characters with it.
      if (event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey
        && !event.defaultPrevented && !event.isComposing
        && !(typeof event.getModifierState === 'function' && event.getModifierState('AltGraph'))
        && DIGIT_KEYS.indexOf(digitOf(event)) >= 0) {
        switchView(event, DIGIT_KEYS.indexOf(digitOf(event)), `Ctrl+Alt+${digitOf(event)}`);
        return;
      }
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) {
        return;
      }
      if (event.defaultPrevented || event.isComposing) {
        return;
      }
      const lowerKey = String(event.key || '').toLowerCase();
      // Ctrl+B from the Workspace's Monaco editor toggles the side that holds Files.
      const workspaceEditorB = lowerKey === 'b' && isInsideWorkspaceView(event)
        && Boolean(closestOf(event.target, '.monaco-editor'));
      // UIUX-020: Monaco, the terminal, the composer, and every other
      // text-editing surface own their own keystrokes while focused --
      // digit/N/B must not steal focus out from under someone mid-edit.
      // The Ctrl+Shift+Space chord above is exempt by design; everything
      // past this point is not.
      if (isTextEditingSurfaceFocused(documentRef) && !workspaceEditorB) {
        return;
      }
      const key = String(event.key || '');
      const digitIndex = DIGIT_KEYS.indexOf(key);
      const lower = key.toLowerCase();
      // The Workspace keymap owns Ctrl+1..5 (editor groups) and Ctrl+N (new file).
      if ((digitIndex >= 0 || lower === 'n') && isInsideWorkspaceView(event)) {
        return;
      }
      if (digitIndex >= 0) {
        switchView(event, digitIndex, `Ctrl+${key}`);
        return;
      }
      if (lower === 'n') {
        event.preventDefault();
        if (event.repeat) return;
        newChat?.();
        appendClientLog?.('INFO', 'shortcuts.new_chat', { key: 'Ctrl+N' });
        return;
      }
      if (lower === 'b') {
        event.preventDefault();
        if (event.repeat) return;
        const toggled = togglePanel?.();
        appendClientLog?.('INFO', 'shortcuts.panel_toggle', { toggled: toggled === true });
      }
    }

    // Digit from the physical key so Ctrl+Alt+digit holds on layouts where Alt
    // changes event.key.
    function digitOf(event) {
      const code = String(event.code || '');
      return /^Digit[1-5]$/.test(code) ? code.slice(5) : String(event.key || '');
    }

    function switchView(event, digitIndex, chord) {
      event.preventDefault();
      const viewId = viewOrder[digitIndex];
      if (viewId && typeof setActiveView === 'function') {
        setActiveView(viewId);
        appendClientLog?.('INFO', 'shortcuts.view_switch', { viewId, key: chord });
        // Land focus on the destination toprail tab -- the same handoff
        // activateRailTab() does for mouse/arrow-key rail navigation, so the
        // chord never leaves focus stranded on a control that just moved into
        // a hidden/inert view.
        rootRef.rendererTopNavShellController?.focusActiveViewTab?.(viewId);
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
