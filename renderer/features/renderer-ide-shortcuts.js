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
        { keys: ['Ctrl', 'S'], description: 'Save the active file' },
        { keys: ['Ctrl', 'P'], description: 'Quick Open a file by name' },
        { keys: [':'], description: 'In Quick Open, type :42 or :42:5 to jump to a line' },
        { keys: ['@'], description: 'In Quick Open, type @ to jump to a symbol in the file' },
        { keys: ['Ctrl', 'E'], description: 'Jump to a recently-edited file' },
        { keys: ['Ctrl', 'Shift', 'F'], description: 'Find in Files (open the Search panel)' },
        { keys: ['Ctrl', 'F4'], description: 'Close the active tab' },
        { keys: ['Double-click'], description: 'Pin or unpin a tab (also on the tab right-click menu)' },
        { keys: ['Ctrl', 'Shift', 'T'], description: 'Reopen the last closed tab' },
        { keys: ['Ctrl', 'PageUp'], description: 'Previous tab' },
        { keys: ['Ctrl', 'PageDown'], description: 'Next tab' },
      ],
    },
    {
      heading: 'Editor',
      entries: [
        { keys: ['Alt', 'Z'], description: 'Toggle word wrap' },
        { keys: ['Ctrl', 'G'], description: 'Go to line' },
        { keys: ['Shift', 'Alt', 'F'], description: 'Format document' },
        { keys: ['Ctrl', 'Shift', 'O'], description: 'Go to symbol in file' },
        { keys: ['Ctrl', 'T'], description: 'Go to symbol in workspace' },
        { keys: ['F12'], description: 'Go to definition' },
        { keys: ['Shift', 'F12'], description: 'Find all references' },
        { keys: ['F2'], description: 'Rename symbol' },
        { keys: ['Alt', '←'], description: 'Go back (cursor navigation history)' },
        { keys: ['Alt', '→'], description: 'Go forward (cursor navigation history)' },
      ],
    },
    {
      heading: 'Bookmarks',
      entries: [
        { keys: ['Ctrl', 'Alt', 'K'], description: 'Toggle a bookmark on the active line' },
        { keys: ['Ctrl', 'Alt', 'L'], description: 'Jump to the next bookmark' },
        { keys: ['Ctrl', 'Alt', 'J'], description: 'Jump to the previous bookmark' },
        { keys: ['Ctrl', 'Alt', 'P'], description: 'List all bookmarks' },
      ],
    },
    {
      heading: 'Workspace',
      entries: [
        { keys: ['Ctrl', 'K'], description: 'Open the command palette' },
        { keys: ['Ctrl', '`'], description: 'Toggle the bottom panel (Terminal / Problems)' },
        { keys: ['?'], description: 'Open this shortcuts overlay' },
        { keys: ['Esc'], description: 'Close the overlay' },
        { keys: ['Esc'], description: 'Leave the Preview surface and return to the editor' },
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
