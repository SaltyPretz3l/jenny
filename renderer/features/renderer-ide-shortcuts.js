/* renderer/features/renderer-ide-shortcuts.js
 *
 * Single source of truth for the Workspace IDE keyboard-shortcut catalog and
 * its catalog-body HTML. Shared by the Welcome pane cheat-sheet
 * (renderer-ide-welcome) and the IDE "?" shortcuts overlay
 * (renderer-ide-commands) so the two never drift.
 *
 * The markup mirrors renderer/chat/renderer-chat-help-overlay.js so it reuses
 * the existing .chat-help-overlay-* styles (no new CSS) and carries no raw
 * button/input primitives (kbd/dl/section only) - keeps
 * check_no_raw_html_primitives.py clean. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeShortcuts = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Bindings the IDE owns plus the Monaco built-ins it surfaces (these last few
  // are Monaco defaults - listed for discoverability, not bound by Jenny).
  const IDE_SHORTCUTS = [
    {
      heading: 'Files & tabs',
      entries: [
        { keys: ['Ctrl', 'S'], description: jt('ide.shortcuts.saveActiveFile', 'Save the active file') },
        { keys: ['Ctrl', 'P'], description: jt('ide.shortcuts.quickOpenFile', 'Quick Open a file by name') },
        { keys: [':'], description: jt('ide.shortcuts.quickOpenLineHint', 'In Quick Open, type :42 or :42:5 to jump to a line') },
        { keys: ['@'], description: jt('ide.shortcuts.quickOpenSymbolHint', 'In Quick Open, type @ to jump to a symbol in the file') },
        { keys: ['Ctrl', 'E'], description: jt('ide.shortcuts.recentlyEditedFile', 'Jump to a recently-edited file') },
        { keys: ['Ctrl', 'Shift', 'F'], description: jt('ide.shortcuts.findInFiles', 'Find in Files (open the Search panel)') },
        { keys: ['Ctrl', 'F4'], description: jt('ide.shortcuts.closeActiveTab', 'Close the active tab') },
        { keys: ['Double-click'], description: jt('ide.shortcuts.pinTab', 'Pin or unpin a tab (also on the tab right-click menu)') },
        { keys: ['Ctrl', 'Shift', 'T'], description: jt('ide.shortcuts.reopenClosedTab', 'Reopen the last closed tab') },
        { keys: ['Ctrl', 'PageUp'], description: jt('ide.shortcuts.previousTab', 'Previous tab') },
        { keys: ['Ctrl', 'PageDown'], description: jt('ide.shortcuts.nextTab', 'Next tab') },
      ],
    },
    {
      heading: 'Editor',
      entries: [
        { keys: ['Alt', 'Z'], description: jt('ide.shortcuts.toggleWordWrap', 'Toggle word wrap') },
        { keys: ['Ctrl', 'G'], description: jt('ide.shortcuts.goToLine', 'Go to line') },
        { keys: ['Shift', 'Alt', 'F'], description: jt('ide.shortcuts.formatDocument', 'Format document') },
        { keys: ['Ctrl', 'Shift', 'O'], description: jt('ide.shortcuts.goToSymbolInFile', 'Go to symbol in file') },
        { keys: ['Ctrl', 'T'], description: jt('ide.shortcuts.goToSymbolInWorkspace', 'Go to symbol in workspace') },
        { keys: ['F12'], description: jt('ide.shortcuts.goToDefinition', 'Go to definition') },
        { keys: ['Shift', 'F12'], description: jt('ide.shortcuts.findAllReferences', 'Find all references') },
        { keys: ['F2'], description: jt('ide.shortcuts.renameSymbol', 'Rename symbol') },
        { keys: ['Alt', '←'], description: jt('ide.shortcuts.goBack', 'Go back (cursor navigation history)') },
        { keys: ['Alt', '→'], description: jt('ide.shortcuts.goForward', 'Go forward (cursor navigation history)') },
      ],
    },
    {
      heading: 'Bookmarks',
      entries: [
        { keys: ['Ctrl', 'Alt', 'K'], description: jt('ide.shortcuts.toggleBookmark', 'Toggle a bookmark on the active line') },
        { keys: ['Ctrl', 'Alt', 'L'], description: jt('ide.shortcuts.nextBookmark', 'Jump to the next bookmark') },
        { keys: ['Ctrl', 'Alt', 'J'], description: jt('ide.shortcuts.previousBookmark', 'Jump to the previous bookmark') },
        { keys: ['Ctrl', 'Alt', 'P'], description: jt('ide.shortcuts.listBookmarks', 'List all bookmarks') },
      ],
    },
    {
      heading: 'Workspace',
      entries: [
        { keys: ['Ctrl', 'K'], description: jt('ide.shortcuts.openCommandPalette', 'Open the command palette') },
        { keys: ['Ctrl', '`'], description: jt('ide.shortcuts.toggleBottomPanel', 'Toggle the bottom panel (Terminal / Problems)') },
        { keys: ['?'], description: jt('ide.shortcuts.openOverlay', 'Open this shortcuts overlay') },
        { keys: ['Esc'], description: jt('ide.shortcuts.closeOverlay', 'Close the overlay') },
        { keys: ['Esc'], description: jt('ide.shortcuts.exitPreview', 'Leave the Preview surface and return to the editor') },
      ],
    },
  ];

  function renderKeyChiclets(keys) {
    return (keys || [])
      .map(function (key) {
        return '<kbd class="chat-help-overlay-kbd">' + escapeHtml(String(key)) + '</kbd>';
      })
      .join('<span class="chat-help-overlay-plus" aria-hidden="true">+</span>');
  }

  function buildIdeShortcutsHtml() {
    return IDE_SHORTCUTS
      .map(function (section) {
        var rows = section.entries
          .map(function (entry) {
            return ''
              + '<div class="chat-help-overlay-row">'
              + '<dt class="chat-help-overlay-keys">' + renderKeyChiclets(entry.keys) + '</dt>'
              + '<dd class="chat-help-overlay-description">' + escapeHtml(entry.description) + '</dd>'
              + '</div>';
          })
          .join('');
        return ''
          + '<section class="chat-help-overlay-section">'
          + '<h3 class="chat-help-overlay-section-heading">' + escapeHtml(section.heading) + '</h3>'
          + '<dl class="chat-help-overlay-list">' + rows + '</dl>'
          + '</section>';
      })
      .join('');
  }

  return { IDE_SHORTCUTS: IDE_SHORTCUTS, buildIdeShortcutsHtml: buildIdeShortcutsHtml };
});
