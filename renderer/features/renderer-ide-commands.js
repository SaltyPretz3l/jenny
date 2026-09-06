/* renderer/features/renderer-ide-commands.js
 *
 * Workspace IDE command source for the global command palette plus the IDE "?"
 * shortcuts overlay. Two jobs, one module so they share the shortcut catalog:
 *
 *   1. getCommandItems() - palette rows (group 'Workspace') that surface the
 *      Monaco built-ins users otherwise can't discover (Format Document, Go to
 *      Symbol, Find All References, Toggle Minimap) plus Reopen Closed Tab.
 *      Returns [] off the IDE view so chat/home palettes stay uncluttered.
 *   2. openHelpOverlay() - the "?" overlay, built on the inventory help-overlay
 *      primitive (focus trap / Esc / scrim) with the body HTML from
 *      renderer-ide-shortcuts (shared with the Welcome cheat-sheet so the two
 *      never drift). This file carries no raw HTML primitives.
 *
 * Monaco actions run through editorHost.runAction(id) (a no-op on the fallback
 * textarea path); the palette items stay listed regardless so discoverability
 * doesn't depend on Monaco having finished loading. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeCommands = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Monaco built-in action ids surfaced as palette rows. Stable across 0.52.
  const ACTION_FORMAT = 'editor.action.formatDocument';
  const ACTION_SYMBOL = 'editor.action.quickOutline';
  const ACTION_REFERENCES = 'editor.action.referenceSearch.trigger';

  // Open the project Search panel (Find in Files) without a controller-wired
  // dependency: activate the Search activity-bar button, reusing the rail's own
  // panel-switch + persist + synchronous render, then focus the search input.
  // The rail button is absent only when Search has been moved to the secondary
  // sidebar, where the input is already mounted - so focus still lands; if it is
  // not mounted at all (closed secondary), this degrades to a no-op. Shared by
  // the keydown handler (windowRef.document) and the palette item (doc).
  function openSearchPanel(doc) {
    if (!doc || typeof doc.querySelector !== 'function') {
      return;
    }
    const railButton = doc.querySelector('[data-ide-rail-panel="search"]');
    if (railButton && typeof railButton.click === 'function') {
      railButton.click();
    }
    const input = doc.querySelector('[data-ide-search-input]');
    if (input && typeof input.focus === 'function') {
      input.focus();
    }
  }

  function createIdeCommands(deps) {
    const options = deps || {};
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    const getActiveView = typeof options.getActiveView === 'function'
      ? options.getActiveView
      : () => '';
    const editorHost = options.editorHost || null;
    const toggleMinimap = typeof options.toggleMinimap === 'function'
      ? options.toggleMinimap
      : () => {};
    const reopenClosedTab = typeof options.reopenClosedTab === 'function'
      ? options.reopenClosedTab
      : () => {};
    const workspaceSymbolPicker = typeof options.workspaceSymbolPicker === 'function'
      ? options.workspaceSymbolPicker
      : () => {};
    const openFileMap = typeof options.openFileMap === 'function' ? options.openFileMap : () => {};
    const revealInMap = typeof options.revealInMap === 'function' ? options.revealInMap : () => {};
    const showBlastRadius = typeof options.showBlastRadius === 'function' ? options.showBlastRadius : () => {};
    // Evaluated per palette open (getCommandItems builds the list fresh), so
    // late feature-flag hydration is honored without a re-bind.
    const isFileMapEnabled = typeof options.isFileMapEnabled === 'function' ? options.isFileMapEnabled : () => true;
    const openPreviewSurface = typeof options.openPreviewSurface === 'function' ? options.openPreviewSurface : () => {};
    const previewActiveFile = typeof options.previewActiveFile === 'function' ? options.previewActiveFile : () => {};
    const isPreviewSurfaceEnabled = typeof options.isPreviewSurfaceEnabled === 'function' ? options.isPreviewSurfaceEnabled : () => false;
    const toggleExplodedView = typeof options.toggleExplodedView === 'function' ? options.toggleExplodedView : () => {};
    const isExplodedViewEnabled = typeof options.isExplodedViewEnabled === 'function' ? options.isExplodedViewEnabled : () => false;
    const toggleBookmark = typeof options.toggleBookmark === 'function' ? options.toggleBookmark : () => {};
    const nextBookmark = typeof options.nextBookmark === 'function' ? options.nextBookmark : () => {};
    const prevBookmark = typeof options.prevBookmark === 'function' ? options.prevBookmark : () => {};
    const listBookmarks = typeof options.listBookmarks === 'function' ? options.listBookmarks : () => {};
    const helpOverlayFactory = typeof options.helpOverlayFactory === 'function'
      ? options.helpOverlayFactory
      : null;
    const buildShortcutsHtml = typeof options.buildShortcutsHtml === 'function'
      ? options.buildShortcutsHtml
      : () => '';

    function runAction(id) {
      try {
        editorHost?.runAction?.(id);
      } catch (_error) {
        /* best-effort; Monaco may not be ready */
      }
    }

    // Palette rows for the active Workspace view. Empty elsewhere so the
    // command palette stays scoped to the surface the user is looking at.
    function getCommandItems() {
      if (getActiveView() !== 'ide') {
        return [];
      }
      return [
        {
          id: 'ide:format-document',
          group: 'Workspace',
          label: 'Format Document',
          description: 'Reformat the active file with the language formatter',
          hint: 'Shift+Alt+F',
          run: () => runAction(ACTION_FORMAT),
        },
        {
          id: 'ide:go-to-symbol',
          group: 'Workspace',
          label: 'Go to Symbol in File',
          description: 'Jump to a function, class, or symbol in the active file',
          hint: 'Ctrl+Shift+O',
          run: () => runAction(ACTION_SYMBOL),
        },
        {
          id: 'ide:go-to-symbol-workspace',
          group: 'Workspace',
          label: 'Go to Symbol in Workspace',
          description: 'Search for a function, class, or symbol across open TS/JS files',
          hint: 'Ctrl+T',
          run: () => { try { workspaceSymbolPicker(); } catch (_error) { /* noop */ } },
        },
        {
          id: 'ide:find-references',
          group: 'Workspace',
          label: 'Find All References',
          description: 'Show every reference to the symbol under the cursor',
          hint: 'Shift+F12',
          run: () => runAction(ACTION_REFERENCES),
        },
        {
          id: 'ide:find-in-files',
          group: 'Workspace',
          label: 'Find in Files',
          description: 'Search across every file in the workspace',
          hint: 'Ctrl+Shift+F',
          run: () => { try { openSearchPanel(doc); } catch (_error) { /* noop */ } },
        },
        ...(isFileMapEnabled() ? [{
          id: 'ide:open-file-map',
          group: 'Workspace',
          label: 'Open File Map',
          description: 'Open the workspace file map (dependency graph)',
          hint: null,
          run: () => { try { openFileMap(); } catch (_error) { /* noop */ } },
        }, {
          id: 'ide:reveal-in-map',
          group: 'Workspace',
          label: 'Reveal Active File in Map',
          description: 'Frame and focus the active file on the workspace file map',
          hint: null,
          run: () => { try { revealInMap(); } catch (_error) { /* noop */ } },
        }, {
          id: 'ide:show-blast-radius',
          group: 'Workspace',
          label: 'Show Blast Radius of Active File',
          description: 'Light every file that depends on the active file (transitive importers)',
          hint: null,
          run: () => { try { showBlastRadius(); } catch (_error) { /* noop */ } },
        }] : []),
        ...(isPreviewSurfaceEnabled() ? [{
          id: 'ide:open-preview',
          group: 'Workspace',
          label: 'Open Preview',
          description: 'Open the workspace Preview stage surface',
          hint: null,
          run: () => { try { openPreviewSurface(); } catch (_error) { /* noop */ } },
        }, {
          id: 'ide:preview-active-file',
          group: 'Workspace',
          label: 'Preview Active File',
          description: 'Preview the active file in the Preview stage surface',
          hint: null,
          run: () => { try { previewActiveFile(); } catch (_error) { /* noop */ } },
        }] : []),
        ...(isExplodedViewEnabled() ? [{
          id: 'ide:toggle-exploded-view',
          group: 'Workspace',
          label: 'Toggle Exploded View',
          description: 'Switch the active TS/JS file between code and an exploded node graph',
          hint: null,
          run: () => { try { toggleExplodedView(); } catch (_error) { /* noop */ } },
        }] : []),
        {
          id: 'ide:toggle-minimap',
          group: 'Workspace',
          label: 'Toggle Minimap',
          description: 'Show or hide the editor minimap',
          hint: null,
          run: () => { try { toggleMinimap(); } catch (_error) { /* noop */ } },
        },
        {
          id: 'ide:reopen-closed-tab',
          group: 'Workspace',
          label: 'Reopen Closed Tab',
          description: 'Reopen the most recently closed editor tab',
          hint: 'Ctrl+Shift+T',
          run: () => { try { reopenClosedTab(); } catch (_error) { /* noop */ } },
        },
        {
          id: 'ide:toggle-bookmark',
          group: 'Workspace',
          label: 'Toggle Bookmark',
          description: 'Add or remove a line bookmark on the active line',
          hint: 'Ctrl+Alt+K',
          run: () => { try { toggleBookmark(); } catch (_error) { /* noop */ } },
        },
        {
          id: 'ide:next-bookmark',
          group: 'Workspace',
          label: 'Next Bookmark',
          description: 'Jump to the next bookmark in the active file',
          hint: 'Ctrl+Alt+L',
          run: () => { try { nextBookmark(); } catch (_error) { /* noop */ } },
        },
        {
          id: 'ide:prev-bookmark',
          group: 'Workspace',
          label: 'Previous Bookmark',
          description: 'Jump to the previous bookmark in the active file',
          hint: 'Ctrl+Alt+J',
          run: () => { try { prevBookmark(); } catch (_error) { /* noop */ } },
        },
        {
          id: 'ide:list-bookmarks',
          group: 'Workspace',
          label: 'List All Bookmarks',
          description: 'Pick from every bookmark and jump to it',
          hint: 'Ctrl+Alt+P',
          run: () => { try { listBookmarks(); } catch (_error) { /* noop */ } },
        },
      ];
    }

    let overlay = null;

    function ensureOverlay() {
      if (overlay || !helpOverlayFactory || !doc) {
        return overlay;
      }
      overlay = helpOverlayFactory({ document: doc, hostId: 'ideHelpOverlay' });
      return overlay;
    }

    function isHelpOpen() {
      return !!(overlay && overlay.isOpen && overlay.isOpen());
    }

    function openHelpOverlay() {
      const inst = ensureOverlay();
      if (!inst || isHelpOpen()) {
        return;
      }
      inst.open({
        title: 'Workspace shortcuts',
        titleId: 'ideHelpOverlayTitle',
        bodyHtml: buildShortcutsHtml(),
        closeLabel: 'Close shortcuts',
      });
    }

    function disposeHelp() {
      if (overlay) {
        try { overlay.destroy(); } catch (_error) { /* best-effort */ }
        overlay = null;
      }
    }

    return {
      getCommandItems,
      openHelpOverlay,
      isHelpOpen,
      disposeHelp,
    };
  }

  // View-scoped IDE keydown handler (capture phase on #ideView), extracted from
  // the controller for the file-size ceiling. The controller still owns the
  // addEventListener/removeEventListener wiring and only sources the handler
  // reference from here. Ctrl+W is Electron-reserved (its default-menu
  // close-window accelerator fires before the renderer), so tab close rides
  // Ctrl+F4 (the Windows document-close standard) and reopen-closed rides
  // Ctrl+Shift+T.
  function createViewKeydownHandler(deps) {
    const options = deps || {};
    const state = options.state || {};
    const saveActiveFile = typeof options.saveActiveFile === 'function'
      ? options.saveActiveFile
      : () => {};
    const tabsController = options.tabsController || null;
    const quickOpen = options.quickOpen || null;
    const bottomPanel = options.bottomPanel || null;
    const chatDock = options.chatDock || null;
    const isChatDockEnabled = typeof options.isChatDockEnabled === 'function' ? options.isChatDockEnabled : () => Boolean(chatDock);
    const reopenClosedTab = typeof options.reopenClosedTab === 'function'
      ? options.reopenClosedTab
      : () => {};
    const workspaceSymbolPicker = typeof options.workspaceSymbolPicker === 'function'
      ? options.workspaceSymbolPicker
      : () => {};
    const navBack = typeof options.navBack === 'function' ? options.navBack : () => {};
    const navForward = typeof options.navForward === 'function' ? options.navForward : () => {};
    const toggleBookmark = typeof options.toggleBookmark === 'function' ? options.toggleBookmark : () => {};
    const nextBookmark = typeof options.nextBookmark === 'function' ? options.nextBookmark : () => {};
    const prevBookmark = typeof options.prevBookmark === 'function' ? options.prevBookmark : () => {};
    const listBookmarks = typeof options.listBookmarks === 'function' ? options.listBookmarks : () => {};
    const ideCommands = options.ideCommands || null;
    const keyboardUtils = options.keyboardUtils || {};
    const windowRef = options.windowRef || (typeof window !== 'undefined' ? window : {});
    const mruSwitcher = options.mruSwitcher || null;
    const getStageSurface = typeof options.getStageSurface === 'function' ? options.getStageSurface : () => 'editor';
    const exitStageSurface = typeof options.exitStageSurface === 'function' ? options.exitStageSurface : () => {};

    return function handleViewKeydown(event) {
      if (state.ui.activeView !== 'ide') {
        return;
      }
      const ctrl = event.ctrlKey || event.metaKey;
      const key = String(event.key).toLowerCase();
      if (ctrl && key === 's' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        saveActiveFile();
        return;
      }
      if (ctrl && key === 'f4' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        tabsController?.closeActiveTab();
        return;
      }
      if (ctrl && (key === 'pageup' || key === 'pagedown') && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        tabsController?.cycleTab(key === 'pageup' ? -1 : 1);
        return;
      }
      if (ctrl && key === 'p' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        quickOpen?.toggle();
        return;
      }
      // Ctrl+E opens the recently-edited jump list (open files in activation
      // order, most-recent first) - the Quick Open sibling on the same chrome.
      if (ctrl && key === 'e' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        quickOpen?.toggleRecent();
        return;
      }
      // Alt+Left / Alt+Right navigate the cross-file cursor history. Guard on
      // altKey AND not-ctrl so they never collide with the Ctrl bindings above.
      if (event.altKey && !ctrl && !event.shiftKey && key === 'arrowleft') {
        event.preventDefault();
        navBack();
        return;
      }
      if (event.altKey && !ctrl && !event.shiftKey && key === 'arrowright') {
        event.preventDefault();
        navForward();
        return;
      }
      // Four Ctrl+Alt chords manage line bookmarks: K toggles, L selects the next,
      // J selects the previous, and P lists them. Guarded on ctrl AND altKey so they never collide with the
      // plain-Ctrl (P/E/T) or plain-Alt (arrows) bindings above.
      if (ctrl && event.altKey && !event.shiftKey) {
        if (key === 'k') { event.preventDefault(); toggleBookmark(); return; }
        if (key === 'l') { event.preventDefault(); nextBookmark(); return; }
        if (key === 'j') { event.preventDefault(); prevBookmark(); return; }
        if (key === 'p') { event.preventDefault(); listBookmarks(); return; }
      }
      // Ctrl+` toggles the bottom panel (Terminal / Problems / Run output).
      if (ctrl && key === '`' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        bottomPanel?.toggle();
        return;
      }
      // Ctrl+\ toggles the Workspace Chat Dock (ide_chat_dock; the live getter
      // keeps the binding inert flag-off). Disjoint from
      // Ctrl+` by design — the dock and the bottom panel are fully independent.
      if (ctrl && key === '\\' && !event.shiftKey && !event.altKey && isChatDockEnabled()) {
        event.preventDefault();
        chatDock?.toggle();
        return;
      }
      // Ctrl+Tab (forward) / Ctrl+Shift+Tab (backward) opens the most-recently-used
      // tab switcher. Guard !altKey (Ctrl+Alt+Tab is a Windows system hotkey). The
      // overlay owns its own Ctrl-keyup commit + Esc cancel once open; 'tab' is a
      // distinct key from the 't' (Ctrl+T) and Shift+'t' (reopen) branches below.
      if (ctrl && key === 'tab' && !event.altKey) {
        event.preventDefault();
        mruSwitcher?.handleTabKey(!event.shiftKey);
        return;
      }
      // Ctrl+Shift+F opens workspace search. The Search rail has no other
      // keyboard entry. The
      // 'f4' tab-close branch above keys on 'f4', so plain 'f' never collides.
      if (ctrl && event.shiftKey && key === 'f' && !event.altKey) {
        event.preventDefault();
        openSearchPanel(windowRef.document);
        return;
      }
      // Ctrl+W is Electron-reserved, so reopen-closed-tab rides Ctrl+Shift+T.
      if (ctrl && event.shiftKey && key === 't' && !event.altKey) {
        event.preventDefault();
        reopenClosedTab();
        return;
      }
      // Ctrl+T (no Shift) opens the workspace symbol picker. Plain Ctrl+T is
      // otherwise unbound; the Shift+T branch above keeps reopen-closed-tab.
      if (ctrl && key === 't' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        workspaceSymbolPicker();
        return;
      }
      // "?" opens the IDE shortcuts overlay (the chat handler stands down while
      // the IDE is active). Skip when a text input owns focus so the literal
      // "?" still types - this capture-phase listener fires before Monaco's, and
      // isTextInputFocused (the same guard the chat "?" handler uses) covers
      // Monaco's hidden textarea while letting buttons/tree rows open it.
      // Scoped to in-#ideView focus by design: this listener is bound on #ideView
      // and the chat document-listener stands down on the IDE view, so "?" with
      // focus parked outside #ideView is a no-op - the command palette's
      // "Keyboard shortcuts" entry is the always-available fallback.
      if (!ctrl && !event.altKey && key === '?') {
        if (!keyboardUtils.isTextInputFocused?.(windowRef.document)) {
          event.preventDefault();
          ideCommands?.openHelpOverlay();
        }
      }
      // Esc exits the Preview stage surface. Scoped to preview ONLY: this listener
      // is capture-phase on #ideView, so an unscoped Esc would swallow the File
      // Map's own Esc handlers (map-a11y focus-return; map-controller clear ladder).
      // The map's exit rung lives in the map controller.
      if (!ctrl && !event.altKey && !event.shiftKey && key === 'escape'
        && getStageSurface() === 'preview'
        && !keyboardUtils.isTextInputFocused?.(windowRef.document)) {
        event.preventDefault();
        exitStageSurface();
        return;
      }
    };
  }

  return { createIdeCommands, createViewKeydownHandler };
});
