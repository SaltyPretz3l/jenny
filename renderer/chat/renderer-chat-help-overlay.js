/* renderer/chat/renderer-chat-help-overlay.js
 * Owns the global `?` handler and shortcut catalog; renderer/inventory/help-overlay.js owns the dialog and focus trap.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('../shared/string-utils'),
      require('./renderer-chat-keyboard-utils'),
      require('../inventory/text-field')
    );
    return;
  }
  root.rendererChatHelpOverlay = factory(root.stringUtils, root.rendererChatKeyboardUtils, root.inventoryTextField);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stringUtils, keyboardUtils, textFieldModule) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  var escapeHtml = stringUtils && stringUtils.escapeHtml;
  if (typeof escapeHtml !== 'function') {
    throw new Error('rendererChatHelpOverlay: renderer/shared/string-utils.js must load before this module');
  }
  var isTextInputFocused = keyboardUtils && keyboardUtils.isTextInputFocused;
  if (typeof isTextInputFocused !== 'function') {
    throw new Error('rendererChatHelpOverlay: renderer-chat-keyboard-utils must load before this module');
  }

  const SEARCH_ID = 'chatHelpOverlaySearch';

  // A chord is an array of key names; an entry lists one or more chords.
  // Headings and descriptions are translated once, at load, like every other
  // catalog in the renderer.
  // Every key is a literal so the string ledger can scan it.
  function group(id, heading, column, entries) {
    return {
      id,
      heading,
      column,
      entries: entries.map(function (entry) {
        return { id: entry[0], description: entry[1], keys: entry[2] };
      }),
    };
  }

  const SHORTCUT_CATALOG = [
    group('everywhere', jt('help.group.everywhere', 'Everywhere'), 1, [
      ['commandPalette', jt('help.shortcut.commandPalette', 'Command palette'), [['Ctrl', 'K']]],
      ['quickSettings', jt('help.shortcut.quickSettings', 'Quick settings'), [['Ctrl', ',']]],
      ['switchView', jt('help.shortcut.switchView', 'Go to Home, Chat, Workspace, Diagnostics, Settings'), [['Ctrl', '1–5']]],
      ['teamView', jt('help.shortcut.teamView', 'Go to Team'), [['Ctrl', '6']]],
      ['newChat', jt('help.shortcut.newChat', 'New chat'), [['Ctrl', 'N']]],
      ['togglePanel', jt('help.shortcut.togglePanel', 'Show or hide the side panel'), [['Ctrl', 'B']]],
      ['closePanel', jt('help.shortcut.closePanel', 'Close the open side panel'), [['Ctrl', '\\']]],
      ['splitView', jt('help.shortcut.splitView', 'Split view: open beside, or close the other pane'), [['Ctrl', 'Shift', '\\']]],
      ['quickCapture', jt('help.shortcut.quickCapture', 'Quick capture to scratchpad'), [['Ctrl', 'Shift', 'Space']]],
      ['reload', jt('help.shortcut.reload', 'Reload the window'), [['Ctrl', 'Shift', 'R']]],
      ['shortcuts', jt('help.shortcut.shortcuts', 'Keyboard shortcuts'), [['?']]],
    ]),
    group('composer', jt('help.group.composer', 'Composer'), 2, [
      ['send', jt('help.shortcut.send', 'Send'), [['Enter']]],
      ['newLine', jt('help.shortcut.newLine', 'New line'), [['Shift', 'Enter']]],
      ['cycleRunMode', jt('help.shortcut.cycleRunMode', 'Cycle run mode: Ask, Auto, Plan, Propose'), [['Shift', 'Tab']]],
      ['planMode', jt('help.shortcut.planMode', 'Plan mode on or off'), [['Alt', 'P']]],
      ['dictate', jt('help.shortcut.dictate', 'Dictate (hold), or tap for hands-free'), [['Ctrl', 'Space']]],
      ['zoom', jt('help.shortcut.zoom', 'Zoom chat in / out / reset'), [['Ctrl', '+'], ['Ctrl', '−'], ['Ctrl', '0']]],
    ]),
    group('messages', jt('help.group.messages', 'Messages'), 2, [
      ['nextPrevious', jt('help.shortcut.nextPrevious', 'Next / previous message'), [['Alt', '↓'], ['Alt', '↑']]],
      ['firstLast', jt('help.shortcut.firstLast', 'First / last message'), [['Home'], ['End']]],
      ['firstUnread', jt('help.shortcut.firstUnread', 'First unread message'), [['Ctrl', 'Shift', 'U']]],
      ['wideTranscript', jt('help.shortcut.wideTranscript', 'Wide transcript on or off'), [['Ctrl', 'Alt', 'W']]],
      ['branch', jt('help.shortcut.branch', 'Branch from the focused message'), [['Ctrl', 'Shift', 'B']]],
    ]),
    group('find', jt('help.group.find', 'Find in chat'), 1, [
      ['search', jt('help.shortcut.search', 'Search this conversation'), [['Ctrl', 'F']]],
      ['nextPreviousMatch', jt('help.shortcut.nextPreviousMatch', 'Next / previous match'), [['Enter'], ['Shift', 'Enter']]],
      ['nextMatchAnywhere', jt('help.chat.nextSearchMatchAnywhere', 'Next match, from anywhere in the chat'), [['F3']]],
      ['previousMatchAnywhere', jt('help.chat.previousSearchMatchAnywhere', 'Previous match, from anywhere in the chat'), [['Shift', 'F3']]],
      ['matchCase', jt('help.chat.searchMatchCase', 'Match case (in the find field)'), [['Alt', 'C']]],
      ['wholeWord', jt('help.chat.searchWholeWord', 'Whole word (in the find field)'), [['Alt', 'W']]],
    ]),
    group('editing', jt('help.group.editing', 'Editing a message'), 1, [
      ['edit', jt('help.shortcut.edit', 'Edit the focused message'), [['Enter']]],
      ['saveResend', jt('help.shortcut.saveResend', 'Save and resend'), [['Ctrl', 'Enter']]],
      ['cancelEdit', jt('help.shortcut.cancelEdit', 'Cancel'), [['Esc']]],
    ]),
    group('selecting', jt('help.group.selecting', 'Selecting messages'), 2, [
      ['select', jt('help.shortcut.select', 'Start or extend a selection'), [['Shift', 'Click']]],
      ['selectAll', jt('help.shortcut.selectAll', 'Select all'), [['Ctrl', 'A']]],
      ['deleteAfter', jt('help.shortcut.deleteAfter', 'Delete selected and everything after'), [['Delete']]],
      ['cancelSelect', jt('help.shortcut.cancelSelect', 'Cancel'), [['Esc']]],
    ]),
    group('team', jt('help.group.team', 'Team'), 2, [
      ['teamNextRegion', jt('help.shortcut.teamNextRegion', 'Next region'), [['F6']]],
      ['teamPrevRegion', jt('help.shortcut.teamPrevRegion', 'Previous region'), [['Shift', 'F6']]],
      ['teamSearch', jt('help.shortcut.teamSearch', 'Search Team'), [['Ctrl', 'F']]],
      ['teamRowUpDown', jt('help.shortcut.teamRowUpDown', 'Previous or next row in the column'), [['Alt', '↑'], ['Alt', '↓']]],
      ['teamMessageMenu', jt('help.shortcut.teamMessageMenu', 'Message menu'), [['Shift', 'F10']]],
    ]),
  ];

  const PLUS_HTML = '<span class="chat-help-overlay-plus" aria-hidden="true">+</span>';
  const ALT_HTML = '<span class="chat-help-overlay-alt" aria-hidden="true">/</span>';

  function renderChord(keys) {
    return keys
      .map(function (key) {
        return '<kbd class="chat-help-overlay-kbd">' + escapeHtml(String(key)) + '</kbd>';
      })
      .join(PLUS_HTML);
  }

  // Chords that differ only in their last key (Alt+↓ / Alt+↑) print the shared
  // modifiers once: Alt + ↓ / ↑.
  function sharesLeadingKeys(chords) {
    if (chords.length < 2) return false;
    const length = chords[0].length;
    if (length < 2) return false;
    return chords.every(function (chord) {
      return chord.length === length && chord.slice(0, -1).every(function (key, i) { return key === chords[0][i]; });
    });
  }

  function renderChords(chords) {
    if (sharesLeadingKeys(chords)) {
      const lead = chords[0].slice(0, -1);
      const tails = chords.map(function (chord) { return renderChord(chord.slice(-1)); });
      return renderChord(lead) + PLUS_HTML + tails.join(ALT_HTML);
    }
    return chords.map(renderChord).join(ALT_HTML);
  }

  function chordsLabel(chords) {
    return chords
      .map(function (chord) { return chord.join('+'); })
      .join(' ' + jt('help.chord.or', 'or') + ' ');
  }

  // Wraps the first case-insensitive match of the query in a <mark>; the
  // surrounding text and the match are escaped separately.
  function highlight(text, needle) {
    const source = String(text);
    if (!needle) return escapeHtml(source);
    const lower = source.toLowerCase();
    const at = lower.length === source.length ? lower.indexOf(needle) : -1;
    if (at < 0) return escapeHtml(source);
    return escapeHtml(source.slice(0, at))
      + '<mark class="chat-help-overlay-mark">' + escapeHtml(source.slice(at, at + needle.length)) + '</mark>'
      + escapeHtml(source.slice(at + needle.length));
  }

  function renderGroup(entry, needle, headingHit) {
    const rows = entry.entries
      .filter(function (row) {
        return !needle || headingHit || row.description.toLowerCase().indexOf(needle) >= 0;
      })
      .map(function (row) {
        return ''
          + '<div class="chat-help-overlay-row" data-shortcut="' + escapeHtml(row.id) + '">'
          + '<dt class="chat-help-overlay-description">' + highlight(row.description, needle) + '</dt>'
          + '<dd class="chat-help-overlay-keys" aria-label="' + escapeHtml(chordsLabel(row.keys)) + '">'
          + renderChords(row.keys)
          + '</dd>'
          + '</div>';
      });
    if (!rows.length) return '';
    return ''
      + '<section class="chat-help-overlay-section" data-group="' + escapeHtml(entry.id) + '">'
      + '<h3 class="chat-help-overlay-section-heading">' + escapeHtml(entry.heading) + '</h3>'
      + '<dl class="chat-help-overlay-list">' + rows.join('') + '</dl>'
      + '</section>';
  }

  function buildCatalogBodyHtml(query) {
    const trimmed = String(query == null ? '' : query).trim();
    const needle = trimmed.toLowerCase();
    const columns = [1, 2]
      .map(function (column) {
        return SHORTCUT_CATALOG
          .filter(function (entry) { return entry.column === column; })
          .map(function (entry) {
            return renderGroup(entry, needle, !!needle && entry.heading.toLowerCase().indexOf(needle) >= 0);
          })
          .join('');
      })
      .filter(Boolean);
    if (!columns.length) {
      return '<p class="chat-help-overlay-empty">'
        + escapeHtml(jt('help.search.empty', 'No shortcut matches “{query}”.', { query: trimmed }))
        + '</p>';
    }
    return '<div class="chat-help-overlay-columns">'
      + columns.map(function (html) { return '<div class="chat-help-overlay-column">' + html + '</div>'; }).join('')
      + '</div>';
  }

  function buildSearchFieldHtml() {
    const textField = typeof textFieldModule === 'function' ? textFieldModule : globalThis.inventoryTextField;
    if (typeof textField !== 'function') return '';
    return textField({
      id: SEARCH_ID,
      placeholder: jt('help.search.placeholder', 'Search shortcuts'),
      ariaLabel: jt('help.search.label', 'Search keyboard shortcuts'),
      className: 'chat-help-overlay-search',
      spellcheck: false,
    });
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
        headerHtml: buildSearchFieldHtml(),
        size: 'wide',
        initialFocusSelector: '#' + SEARCH_ID,
        bodyHtml: buildCatalogBodyHtml(''),
        closeLabel: jt('help.chat.closeShortcuts', 'Close keyboard shortcuts'),
        onRender: bindSearch,
      });
    }

    function bindSearch(dialogEl) {
      const input = dialogEl && dialogEl.querySelector('#' + SEARCH_ID);
      const body = dialogEl && dialogEl.querySelector('.inv-help-overlay-body');
      if (!input || !body) return;
      input.addEventListener('input', function () {
        body.innerHTML = buildCatalogBodyHtml(String(input.value || ''));
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
