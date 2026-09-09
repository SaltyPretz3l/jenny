/* renderer/chat/renderer-chat-help-overlay.js
 * Owns the global `?` handler and shortcut catalog; renderer/inventory/help-overlay.js owns the dialog and focus trap.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('./renderer-chat-keyboard-utils')
    );
    return;
  }
  root.rendererChatHelpOverlay = factory(root.stringUtils, root.rendererChatKeyboardUtils);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, keyboardUtils) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var escapeHtml = stringUtils && stringUtils.escapeHtml;
  if (typeof escapeHtml !== 'function') {
    throw new Error('rendererChatHelpOverlay: renderer/shared/string-utils.js must load before this module');
  }
  var isTextInputFocused = keyboardUtils && keyboardUtils.isTextInputFocused;
  if (typeof isTextInputFocused !== 'function') {
    throw new Error('rendererChatHelpOverlay: renderer-chat-keyboard-utils must load before this module');
  }

  const SHORTCUT_CATALOG = [
    {
      heading: 'Navigation',
      entries: [
        { keys: ['Alt', '↓'], description: jt('help.chat.nextMessage', 'Move focus to the next message') },
        { keys: ['Alt', '↑'], description: jt('help.chat.previousMessage', 'Move focus to the previous message') },
        { keys: ['Home'], description: jt('help.chat.firstMessage', 'Jump to the first message') },
        { keys: ['End'], description: jt('help.chat.lastMessage', 'Jump to the last message') },
      ],
    },
    {
      heading: 'Search',
      entries: [
        { keys: ['Ctrl', 'F'], description: jt('help.chat.searchMessages', 'Search messages in this conversation') },
        { keys: ['Enter'], description: jt('help.chat.nextSearchMatch', 'Jump to next match') },
        { keys: ['Shift', 'Enter'], description: jt('help.chat.previousSearchMatch', 'Jump to previous match') },
      ],
    },
    {
      heading: 'Editing',
      entries: [
        { keys: ['Enter'], description: jt('help.chat.editFocusedMessage', 'Edit the focused user message') },
        { keys: ['Esc'], description: jt('help.chat.cancelEditing', 'Cancel editing') },
        { keys: ['Ctrl', 'Enter'], description: jt('help.chat.saveEditAndResend', 'Save edit and resend') },
        { keys: ['Shift', 'Enter'], description: jt('help.chat.newLineInEditor', 'Insert a new line (in editor)') },
      ],
    },
    {
      heading: 'Selection',
      entries: [
        { keys: ['Shift', 'Click'], description: jt('help.chat.enterSelectionMode', 'Enter selection mode (or extend the range)') },
        { keys: ['Ctrl', 'A'], description: jt('help.chat.selectAllMessages', 'Select all messages (while in selection mode)') },
        { keys: ['Esc'], description: jt('help.chat.cancelSelection', 'Cancel selection') },
        { keys: ['Delete'], description: jt('help.chat.deleteSelectedAndAfter', 'Delete selected and everything after') },
      ],
    },
    {
      heading: 'Branching',
      entries: [
        { keys: ['Ctrl', 'Shift', 'B'], description: jt('help.chat.branchFocusedMessage', 'Branch from the focused message') },
        { keys: ['Hover'], description: jt('help.chat.branchHoverAction', 'Branch from any message hover action') },
      ],
    },
    {
      heading: 'Orientation',
      entries: [
        { keys: ['Ctrl', 'Shift', 'U'], description: jt('help.chat.firstUnreadMessage', 'Jump to the first unread message') },
      ],
    },
    {
      heading: 'Composer',
      entries: [
        { keys: ['Enter'], description: jt('help.chat.sendMessage', 'Send the message') },
        { keys: ['Shift', 'Enter'], description: jt('help.chat.newLine', 'Insert a new line') },
        { keys: ['Shift', 'Tab'], description: jt('help.chat.cycleRunMode', 'Cycle run mode (Ask → Auto → Plan)') },
        { keys: ['Alt', 'P'], description: jt('help.chat.togglePlanMode', 'Toggle Plan mode') },
        { keys: ['Ctrl', '+'], description: jt('help.chat.zoomIn', 'Zoom chat in') },
        { keys: ['Ctrl', '-'], description: jt('help.chat.zoomOut', 'Zoom chat out') },
        { keys: ['Ctrl', '0'], description: jt('help.chat.resetZoom', 'Reset chat zoom') },
      ],
    },
    {
      heading: 'Help',
      entries: [
        { keys: ['?'], description: jt('help.chat.openShortcuts', 'Open this shortcuts overlay') },
        { keys: ['Esc'], description: jt('help.chat.closeOverlay', 'Close the overlay') },
      ],
    },
  ];

  function renderKeyChiclets(keys) {
    return keys
      .map(function (key) {
        return '<kbd class="chat-help-overlay-kbd">' + escapeHtml(String(key)) + '</kbd>';
      })
      .join('<span class="chat-help-overlay-plus" aria-hidden="true">+</span>');
  }

  function buildCatalogBodyHtml() {
    return SHORTCUT_CATALOG
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

  function createChatHelpOverlay(deps) {
    const options = deps || {};
    const doc = options.document || (typeof document !== 'undefined' ? document : null);
    // Chat shortcuts are irrelevant in the IDE and Diagnostics workspaces.
    // Leave `?` unclaimed there so each surface can own its keyboard behavior.
    const getActiveView = typeof options.getActiveView === 'function'
      ? options.getActiveView
      : null;
    const helpOverlayFactory = options.helpOverlayFactory
      || (typeof globalThis !== 'undefined' && globalThis.inventoryHelpOverlay
        ? globalThis.inventoryHelpOverlay.createHelpOverlay
        : null);

    let overlay = null;
    function ensureOverlay() {
      if (overlay || !helpOverlayFactory) return overlay;
      overlay = helpOverlayFactory({ document: doc, hostId: 'chatHelpOverlay' });
      return overlay;
    }

    function open() {
      const inst = ensureOverlay();
      if (!inst) return;
      inst.open({
        title: jt('help.chat.title', 'Keyboard shortcuts'),
        titleId: 'chatHelpOverlayTitle',
        bodyHtml: buildCatalogBodyHtml(),
        closeLabel: jt('help.chat.closeShortcuts', 'Close keyboard shortcuts'),
      });
    }

    function close() {
      if (overlay && overlay.isOpen()) {
        overlay.close();
      }
    }

    function isOpen() {
      return !!(overlay && overlay.isOpen());
    }

    function handleGlobalKeydown(event) {
      const key = String(event.key || '');
      if (key !== '?') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (getActiveView && (getActiveView() === 'ide' || getActiveView() === 'logs')) return;
      if (isTextInputFocused(doc)) return;
      if (isOpen()) return;
      event.preventDefault();
      open();
    }

    function attach(registerListener, listenerOptions) {
      if (!doc) return function noopDetachHelpOverlay() {};
      if (typeof registerListener !== 'function') {
        doc.addEventListener('keydown', handleGlobalKeydown, listenerOptions);
        return function detachHelpOverlay() {
          doc.removeEventListener('keydown', handleGlobalKeydown, listenerOptions);
        };
      }
      registerListener(doc, 'keydown', handleGlobalKeydown, listenerOptions);
      return function noopDetachRegisteredHelpOverlay() {};
    }

    function dispose() {
      if (overlay) {
        try { overlay.destroy(); } catch (_err) { /* best-effort */ }
        overlay = null;
      }
    }

    return {
      attach,
      dispose,
      open,
      close,
      isOpen,
      buildCatalogBodyHtml,
    };
  }

  return { createChatHelpOverlay, buildCatalogBodyHtml };
});
