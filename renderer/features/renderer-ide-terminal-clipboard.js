/* renderer/features/renderer-ide-terminal-clipboard.js - copy/paste for the Workspace PTY
 * terminal (row 82 T1): the keyboard chords and the right-click context menu.
 *
 * Chords (the clipboard half of the xterm host's one custom key handler): Ctrl+Shift+C
 * copies, Ctrl+V and Ctrl+Shift+V paste, and Ctrl+C with a selection copies and clears it
 * instead of sending ^C (no selection: ^C reaches the shell). Pasting goes through
 * term.paste(), so xterm applies bracketed paste; with no session running the io module
 * drops the keystrokes, so nothing is written anywhere.
 *
 * The clipboard is the shell bridge (window.jennyShell.clipboard) when it offers the
 * method, else navigator.clipboard. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeTerminalClipboard = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) {
      return globalRef[globalName];
    }
    return typeof require === 'function' ? require(requirePath) : null;
  }

  // ctx: { windowRef, getTerminal, onClear, logIgnoredError }
  function createTerminalClipboard(ctx) {
    const windowRef = ctx.windowRef;
    const getTerminal = typeof ctx.getTerminal === 'function' ? ctx.getTerminal : () => null;
    const onClear = typeof ctx.onClear === 'function' ? ctx.onClear : noop;
    const logIgnoredError = typeof ctx.logIgnoredError === 'function' ? ctx.logIgnoredError : noop;
    const contextMenu = resolveModule('inventoryContextMenu', '../inventory/context-menu');

    // The key whose keydown a chord consumed; its keypress/keyup are swallowed too so
    // xterm never also handles them. Cleared on the matching keyup.
    let swallowedKey = '';

    function clipboardMethod(name) {
      const shell = windowRef?.jennyShell?.clipboard;
      if (shell && typeof shell[name] === 'function') {
        return shell[name].bind(shell);
      }
      const web = windowRef?.navigator?.clipboard;
      return web && typeof web[name] === 'function' ? web[name].bind(web) : null;
    }

    function hasSelection() {
      const term = getTerminal();
      return Boolean(term && typeof term.hasSelection === 'function' && term.hasSelection());
    }

    function copy() {
      const term = getTerminal();
      const text = term && typeof term.getSelection === 'function' ? String(term.getSelection() || '') : '';
      const write = clipboardMethod('writeText');
      if (!text || !write) {
        return false;
      }
      try {
        Promise.resolve(write(text)).catch((error) => logIgnoredError('clipboard_write', error));
      } catch (error) { logIgnoredError('clipboard_write', error); }
      return true;
    }

    function paste() {
      const read = clipboardMethod('readText');
      if (!read) {
        return Promise.resolve(false);
      }
      try {
        return Promise.resolve(read()).then((text) => {
          const term = getTerminal();
          const value = String(text == null ? '' : text);
          if (!term || !value || typeof term.paste !== 'function') {
            return false;
          }
          term.paste(value);
          return true;
        }).catch((error) => { logIgnoredError('clipboard_read', error); return false; });
      } catch (error) {
        logIgnoredError('clipboard_read', error);
        return Promise.resolve(false);
      }
    }

    function selectAll() {
      const term = getTerminal();
      if (term && typeof term.selectAll === 'function') {
        try { term.selectAll(); } catch (error) { logIgnoredError('select_all', error); }
      }
    }

    function copyAndClear() {
      copy();
      const term = getTerminal();
      if (term && typeof term.clearSelection === 'function') {
        try { term.clearSelection(); } catch (error) { logIgnoredError('clear_selection', error); }
      }
    }

    // The chord a keydown stands for: 'copy' | 'copy-clear' | 'paste' | ''.
    function chordOf(event, key) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) {
        return '';
      }
      if (key === 'c') {
        if (event.shiftKey) {
          return 'copy';
        }
        return hasSelection() ? 'copy-clear' : '';
      }
      return key === 'v' ? 'paste' : '';
    }

    // The clipboard half of the terminal's custom key handler. Returns true when the
    // event was a clipboard chord (xterm must not also handle it); acts on keydown only.
    function handleTerminalKey(event) {
      const key = String(event.key || '').toLowerCase();
      if (event.type !== 'keydown') {
        // Only while the modifier is still down: a plain keypress of the same letter
        // after a lost keyup must still reach the shell.
        const swallowed = swallowedKey !== '' && swallowedKey === key && Boolean(event.ctrlKey || event.metaKey);
        if (event.type === 'keyup') {
          swallowedKey = '';
        }
        return swallowed;
      }
      const chord = chordOf(event, key);
      if (!chord) {
        swallowedKey = '';
        return false;
      }
      swallowedKey = key;
      event.preventDefault();
      if (chord === 'copy') {
        copy();
      } else if (chord === 'copy-clear') {
        copyAndClear();
      } else {
        void paste();
      }
      return true;
    }

    function showContextMenu(event, rootEl) {
      if (!contextMenu || typeof contextMenu.show !== 'function') {
        return false;
      }
      event.preventDefault();
      contextMenu.show({
        rootEl,
        ariaLabel: jt('ide.terminal.contextMenuLabel', 'Terminal actions'),
        anchorX: event.clientX || 0,
        anchorY: event.clientY || 0,
        items: [
          { label: jt('ide.terminal.menuCopy', 'Copy'), shortcutHint: 'Ctrl+Shift+C', disabled: !hasSelection(), action: () => { copy(); } },
          { label: jt('ide.terminal.menuPaste', 'Paste'), shortcutHint: 'Ctrl+V', action: () => paste() },
          { separator: true },
          { label: jt('ide.terminal.menuClear', 'Clear'), action: () => { onClear(); } },
          { label: jt('ide.terminal.menuSelectAll', 'Select All'), action: () => { selectAll(); } },
        ],
      });
      return true;
    }

    // Opens the menu on a right-click anywhere in `el`; returns the unbind function.
    function bindContextMenu(el) {
      if (!el || typeof el.addEventListener !== 'function') {
        return noop;
      }
      const handler = (event) => { showContextMenu(event, el); };
      el.addEventListener('contextmenu', handler);
      return () => el.removeEventListener('contextmenu', handler);
    }

    return {
      bindContextMenu,
      copy,
      handleTerminalKey,
      paste,
      selectAll,
      showContextMenu,
    };
  }

  return {
    createTerminalClipboard,
  };
});
