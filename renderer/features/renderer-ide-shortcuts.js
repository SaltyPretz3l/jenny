/* renderer/features/renderer-ide-shortcuts.js
 *
 * Single source of truth for the Workspace IDE keyboard-shortcut catalog and
 * its catalog-body HTML: the command registry's bindings (row 82) first, then the
 * Monaco built-ins and picker hints below. Shared by the Welcome pane cheat-sheet
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
  const escapeHtml = ((typeof globalThis !== 'undefined' && globalThis.stringUtils)
    || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;
  const registryUtils = (typeof globalThis !== 'undefined' && globalThis.rendererIdeCommandRegistry)
    || (typeof require === 'function' ? require('./renderer-ide-command-registry') : null);

  // The static half of the catalog: Monaco built-ins (Monaco's defaults, listed for
  // discoverability, not bound by Jenny), picker hints and gestures, and the keys that
  // live outside the command registry. Every chord Jenny binds comes from the registry
  // (buildIdeShortcutsHtml(registry)), so the overlay and the dispatcher never drift.
  const IDE_SHORTCUTS = [
    {
      heading: jt('ide.shortcuts.sectionEditor', 'Editor'),
      entries: [
        { keys: ['Alt', 'Z'], description: jt('ide.shortcuts.toggleWordWrap', 'Toggle word wrap') },
        { keys: ['Shift', 'Alt', 'F'], description: jt('ide.shortcuts.formatDocument', 'Format document') },
        { keys: ['Ctrl', 'Shift', 'O'], description: jt('ide.shortcuts.goToSymbolInFile', 'Go to symbol in file') },
        { keys: ['F12'], description: jt('ide.shortcuts.goToDefinition', 'Go to definition') },
        { keys: ['Shift', 'F12'], description: jt('ide.shortcuts.findAllReferences', 'Find all references') },
        { keys: ['F2'], description: jt('ide.shortcuts.renameSymbol', 'Rename symbol') },
        { keys: ['Ctrl', 'F'], description: jt('ide.shortcuts.findInFile', 'Find in the active file') },
        { keys: ['Ctrl', 'H'], description: jt('ide.shortcuts.replaceInFile', 'Replace in the active file') },
        { keys: ['Ctrl', '/'], description: jt('ide.shortcuts.toggleLineComment', 'Toggle line comment') },
        { keys: ['Alt', '↑'], description: jt('ide.shortcuts.moveLineUp', 'Move line up (Alt+↓ moves it down)') },
        { keys: ['Ctrl', 'D'], description: jt('ide.shortcuts.addNextOccurrence', 'Add the next occurrence to the selection') },
        { keys: ['Ctrl', 'Space'], description: jt('ide.shortcuts.triggerSuggest', 'Show suggestions') },
      ],
    },
    {
      heading: jt('ide.shortcuts.sectionPickers', 'Quick Open and tabs'),
      entries: [
        { keys: [':'], description: jt('ide.shortcuts.quickOpenLineHint', 'In Quick Open, type :42 or :42:5 to jump to a line') },
        { keys: ['@'], description: jt('ide.shortcuts.quickOpenSymbolHint', 'In Quick Open, type @ to jump to a symbol in the file') },
        { keys: ['Ctrl', 'Tab'], description: jt('ide.shortcuts.mruSwitcher', 'Switch to a recently used tab (Ctrl+Shift+Tab goes back)') },
        { keys: ['Double-click'], description: jt('ide.shortcuts.pinTab', 'Pin or unpin a tab (also on the tab right-click menu)') },
      ],
    },
    {
      heading: jt('ide.shortcuts.sectionWorkspace', 'Workspace'),
      entries: [
        { keys: ['Ctrl', 'K'], description: jt('ide.shortcuts.openCommandPaletteOutsideEditor', 'Open the command palette (outside the editor and terminal)') },
        { keys: ['?'], description: jt('ide.shortcuts.openOverlay', 'Open this shortcuts overlay') },
        { keys: ['Esc'], description: jt('ide.shortcuts.closeOverlay', 'Close the overlay') },
        { keys: ['Esc'], description: jt('ide.shortcuts.exitPreview', 'Leave the Preview surface and return to the editor') },
        { keys: ['Esc', 'Esc'], description: jt('ide.shortcuts.exitZen', 'Leave Zen Mode') },
      ],
    },
  ];

  const REGISTRY_SECTIONS = [
    { navigate: false, heading: () => jt('ide.shortcuts.sectionCommands', 'Commands') },
    { navigate: true, heading: () => jt('ide.shortcuts.sectionViews', 'Views') },
  ];

  // One catalog row per bound command with every chord it carries, each chord split
  // into its steps ('Ctrl+K Z' -> ['Ctrl+K', 'Z']).
  function registrySections(registry) {
    if (!registry || typeof registry.bindings !== 'function') return [];
    const chordsById = new Map();
    registry.bindings().forEach(function (binding) {
      if (!chordsById.has(binding.id)) chordsById.set(binding.id, []);
      chordsById.get(binding.id).push(binding.chord);
    });
    const display = (registryUtils && registryUtils.displayChord) || function (chord) { return chord; };
    return REGISTRY_SECTIONS.map(function (section) {
      const entries = [];
      chordsById.forEach(function (chords, id) {
        const command = registry.get(id);
        if (!command || (command.group === 'Navigate') !== section.navigate) return;
        entries.push({
          chords: chords.map(function (chord) { return display(chord).split(' '); }),
          description: command.label,
        });
      });
      return { heading: section.heading(), entries: entries };
    }).filter(function (section) { return section.entries.length > 0; });
  }

  function renderKeyChiclets(keys) {
    return (keys || [])
      .map(function (key) {
        return '<kbd class="chat-help-overlay-kbd">' + escapeHtml(String(key)) + '</kbd>';
      })
      .join('<span class="chat-help-overlay-plus" aria-hidden="true">+</span>');
  }

  // A registry row: each chord is a list of steps; several chords are alternatives.
  function renderChords(chords) {
    const then = '<span class="chat-help-overlay-plus">' + escapeHtml(jt('ide.shortcuts.chordThen', 'then')) + '</span>';
    const or = '<span class="chat-help-overlay-plus">' + escapeHtml(jt('ide.shortcuts.chordOr', 'or')) + '</span>';
    return chords.map(function (steps) {
      return steps.map(function (step) { return renderKeyChiclets(step.split('+')); }).join(then);
    }).join(or);
  }

  function renderSection(section) {
    var rows = section.entries
      .map(function (entry) {
        return ''
          + '<div class="chat-help-overlay-row">'
          + '<dt class="chat-help-overlay-keys">' + (entry.chords ? renderChords(entry.chords) : renderKeyChiclets(entry.keys)) + '</dt>'
          + '<dd class="chat-help-overlay-description">' + escapeHtml(entry.description) + '</dd>'
          + '</div>';
      })
      .join('');
    return ''
      + '<section class="chat-help-overlay-section">'
      + '<h3 class="chat-help-overlay-section-heading">' + escapeHtml(section.heading) + '</h3>'
      + '<dl class="chat-help-overlay-list">' + rows + '</dl>'
      + '</section>';
  }

  // registry (optional): the IDE command registry; its bindings lead the catalog.
  function buildIdeShortcutsHtml(registry) {
    return registrySections(registry).concat(IDE_SHORTCUTS).map(renderSection).join('');
  }

  return { IDE_SHORTCUTS: IDE_SHORTCUTS, buildIdeShortcutsHtml: buildIdeShortcutsHtml };
});
