/* renderer/features/renderer-ide-keymap.js - the Workspace IDE keymap (row 82 slice K;
 * plan docs/plans/IDE_VSCODE_PARITY_2026-10-26.md sections 5.1 and 6.1).
 *
 * Three pieces the view keydown dispatcher (renderer-ide-commands) composes:
 *   - registerIdeKeymapCommands(registry, deps): every command that carries a section
 *     6.1 chord (VS Code default spelling), registered into the shared command registry
 *     so the palette lists it and the dispatcher resolves it.
 *   - buildCommandContext(...) / focusZone(target): the `when` context and where focus is.
 *   - bindMonacoKeymap(registry, ...): Monaco owns its Ctrl+K prefix, so the two-step
 *     chords are bound inside Monaco through editorHost.addEditorAction and run the same
 *     registry command. Single-step chords never reach Monaco: the capture-phase
 *     dispatcher handles them first and stops the event there.
 *
 * Owns no DOM of its own; every dep is optional and a missing one hides its row. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeKeymap = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  // The shared command registry (loaded before this module on the IDE manifest).
  const registryUtils = globalRef.rendererIdeCommandRegistry || require('./renderer-ide-command-registry');

  // Chords that stay with the shell while the terminal has focus (readline and
  // PSReadLine own them: delete word, next history, end of line, word moves, SIGQUIT).
  // Everything else Jenny binds goes to the workbench, as VS Code's commandsToSkipShell.
  const TERMINAL_PASSTHROUGH = Object.freeze(new Set([
    'ctrl+w', 'ctrl+n', 'ctrl+g', 'ctrl+e', 'ctrl+t', 'ctrl+\\', 'alt+left', 'alt+right',
    'ctrl+alt+k', 'ctrl+alt+l', 'ctrl+alt+j', 'ctrl+alt+p',
  ]));
  const REVIEW_KINDS = Object.freeze({ 'diff://': 'diff', 'preview://': 'preview', 'map://': 'map' });
  const PANE_SAVE_SELECTOR = '[data-ide-save-shortcut="pane"]';
  const GROUP_COUNT = 4;

  function closest(target, selector) {
    try {
      return target && typeof target.closest === 'function' ? target.closest(selector) : null;
    } catch (_error) {
      return null;
    }
  }

  // Where a key event (or the focused element) sits: the Monaco editor, a terminal,
  // another text input, or anything else.
  function focusZone(target) {
    if (closest(target, '.monaco-editor')) return 'editor';
    if (closest(target, '.xterm, .ide-terminal-panel')) return 'terminal';
    const tag = String((target && target.tagName) || '').toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'INPUT' || (target && target.isContentEditable)) return 'input';
    return 'other';
  }

  // A Monaco editor that carries the keymap's editor actions (the primary and group
  // editors); diff editors do not, so their two-step chords stay with the dispatcher.
  function isKeymapEditor(target) {
    return Boolean(closest(target, '.monaco-editor')) && !closest(target, '.monaco-diff-editor');
  }

  function activeKindOf(path) {
    const value = String(path || '');
    if (!value) return '';
    const prefix = Object.keys(REVIEW_KINDS).find((scheme) => value.indexOf(scheme) === 0);
    if (prefix) return REVIEW_KINDS[prefix];
    return value.indexOf('://') === -1 ? 'file' : 'other';
  }

  // The `when` context of section 5.1. groupCount counts the primary plus every
  // secondary group a tab sits in.
  function buildCommandContext({ activeView, ide, isRepo, target } = {}) {
    const state = ide || {};
    const activeKind = activeKindOf(state.activeTabPath);
    const groups = new Set();
    (Array.isArray(state.openTabs) ? state.openTabs : []).forEach((tab) => { if (tab && tab.group) groups.add(tab.group); });
    return {
      activeView: String(activeView || ''),
      hasActiveFile: activeKind === 'file',
      activeKind,
      isRepo: isRepo === true,
      groupCount: 1 + groups.size,
      focused: focusZone(target),
      target: target || null,
    };
  }

  // The shell's command palette module (an eager global in the app; required under Node).
  function paletteModule() {
    if (globalRef.rendererCommandPaletteUtils) return globalRef.rendererCommandPaletteUtils;
    if (typeof require === 'function') {
      try { return require('../shell/renderer-command-palette'); } catch (_error) { /* unavailable */ }
    }
    return null;
  }

  function fn(value) {
    return typeof value === 'function' ? value : null;
  }

  function registerIdeKeymapCommands(registry, deps) {
    const d = deps || {};
    const doc = d.document || (typeof document !== 'undefined' ? document : null);
    const getIde = fn(d.getIde) || (() => ({}));
    const appendClientLog = fn(d.appendClientLog) || (() => {});
    const editorHost = d.editorHost || null;
    const quickOpen = d.quickOpen || null;
    const tabsController = d.tabsController || null;
    const editorGroups = d.editorGroups || null;
    const bottomPanel = d.bottomPanel || null;
    const chatDock = d.chatDock || null;
    const isChatDockEnabled = fn(d.isChatDockEnabled) || (() => Boolean(chatDock));
    const getWorkbench = () => d.workbenchWiring || globalRef.rendererIdeWorkbenchWiring?.getActive?.() || null;
    const openPalette = fn(d.openCommandPalette) || (() => paletteModule()?.getActive?.()?.open?.({ scope: 'commands' }));
    const hasPalette = fn(d.openCommandPalette) ? () => true : () => Boolean(paletteModule()?.getActive?.());
    const ide = registryUtils.inIde;
    const hasMonaco = () => Boolean(editorHost?.getMonaco?.());
    const disposers = [];

    const guarded = (site, run) => registryUtils.guardCommand(appendClientLog, site, (ctx) => run(ctx || {}));

    // One row; `need` is the dep the row needs (absent: not registered).
    function add(need, id, label, keys, run, options) {
      if (!need) return;
      const opts = options || {};
      disposers.push(registry.register({
        id,
        label,
        group: opts.group || 'Workspace',
        description: opts.description || '',
        hint: opts.hint,
        keys,
        when: opts.when || ide,
        run: guarded(id, run),
      }));
    }

    const activePath = () => String(getIde().activeTabPath || '');
    const groupOf = (ctx) => editorGroups?.groupOfTarget?.(ctx.target) || '';

    // Views: reveal (and focus) wherever the view lives; a view that already holds
    // focus closes its stack instead (VS Code's toggle on Ctrl+Shift+M and Ctrl+`).
    function focusInside(viewId) {
      const host = getWorkbench()?.workbench?.hostFor?.(viewId);
      const active = host?.ownerDocument?.activeElement;
      return Boolean(host && active && host !== active && host.contains?.(active));
    }
    function revealView(viewId) {
      if (fn(d.showPanel)) return d.showPanel(viewId, { focus: true }) !== false;
      return getWorkbench()?.showPanel?.(viewId, { focus: true }) === true;
    }
    function toggleView(viewId) {
      const wb = getWorkbench();
      if (focusInside(viewId)) {
        wb?.workbench?.collapseStackOf?.(viewId);
        editorHost?.focus?.();
        return;
      }
      revealView(viewId);
    }
    function focusSearchField(selector) {
      revealView('search');
      const input = doc?.querySelector?.(selector);
      if (input && typeof input.focus === 'function') input.focus();
    }

    // Ctrl+1..4: focus group N; a missing group is created by splitting right (O1).
    function focusGroup(n) {
      if (!editorGroups) return;
      const target = n === 1 ? '' : 'editor-' + n;
      if (n !== 1 && !editorGroups.getElement?.(target)) {
        if (hasMonaco()) editorGroups.splitActive?.('right');
        return;
      }
      // Already the focused group: step once around the ring so the group's editor
      // takes DOM focus again (a lone primary group just focuses the editor).
      if (editorGroups.getFocusedGroup?.() === target && editorGroups.focusNextGroup?.() !== true) {
        editorHost?.focus?.();
        return;
      }
      for (let i = 0; i < GROUP_COUNT && editorGroups.getFocusedGroup?.() !== target; i += 1) {
        if (editorGroups.focusNextGroup?.() !== true) break;
      }
    }

    add(true, 'ide:command-palette', jt('ide.keymap.showAllCommands', 'Show All Commands'), ['ctrl+shift+p', 'f1'],
      () => openPalette(), { when: (ctx) => ide(ctx) && hasPalette() });
    add(quickOpen, 'ide:quick-open', jt('ide.keymap.goToFile', 'Go to File...'), ['ctrl+p'], () => quickOpen.toggle?.());
    add(quickOpen?.toggleRecent, 'ide:open-recent-file', jt('ide.keymap.openRecentFile', 'Go to Recently Edited File...'), ['ctrl+e'],
      () => quickOpen.toggleRecent());
    add(editorHost || quickOpen, 'ide:go-to-line', jt('ide.keymap.goToLine', 'Go to Line/Column...'), ['ctrl+g'], (ctx) => {
      if (ctx.hasActiveFile !== false && editorHost?.triggerGoToLine?.() === true) return;
      // No Monaco editor: Quick Open's own ":line" mode, prefilled.
      quickOpen?.toggle?.();
      const input = doc?.querySelector?.('[data-ide-quick-open-input]');
      if (!input) return;
      input.value = ':';
      if (typeof doc.defaultView?.Event === 'function') input.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
    });
    add(true, 'ide:save', jt('ide.keymap.save', 'File: Save'), ['ctrl+s'], (ctx) => {
      // Pane-owned saves run in the bubble phase after in-pane editors commit.
      if (closest(ctx.target, PANE_SAVE_SELECTOR)) return undefined;
      const group = groupOf(ctx);
      if (group) return editorGroups.saveActive(group);
      return fn(d.saveActiveFile)?.();
    });
    add(true, 'ide:close-editor', jt('ide.keymap.closeEditor', 'View: Close Editor'), ['ctrl+w', 'ctrl+f4'], (ctx) => {
      const group = groupOf(ctx);
      if (group) editorGroups.closeActive(group);
      else tabsController?.closeActiveTab?.();
    });
    add(fn(d.reopenClosedTab), 'ide:reopen-closed-tab', jt('ide.keymap.reopenClosedEditor', 'View: Reopen Closed Editor'), ['ctrl+shift+t'],
      () => d.reopenClosedTab());
    [['ide:previous-editor', jt('ide.keymap.previousEditor', 'View: Open Previous Editor'), 'ctrl+pageup', -1],
      ['ide:next-editor', jt('ide.keymap.nextEditor', 'View: Open Next Editor'), 'ctrl+pagedown', 1]].forEach(([id, label, chord, step]) => {
      add(true, id, label, [chord], (ctx) => {
        const group = groupOf(ctx);
        if (group) editorGroups.cycle(group, step);
        else tabsController?.cycleTab?.(step);
      });
    });
    add(fn(d.navBack), 'ide:go-back', jt('ide.keymap.goBack', 'Go Back'), ['alt+left'], () => d.navBack());
    add(fn(d.navForward), 'ide:go-forward', jt('ide.keymap.goForward', 'Go Forward'), ['alt+right'], () => d.navForward());
    add(fn(d.workspaceSymbolPicker), 'ide:go-to-symbol-workspace', jt('ide.commands.goToSymbolInWorkspace', 'Go to Symbol in Workspace'), ['ctrl+t'],
      () => d.workspaceSymbolPicker(),
      { description: jt('ide.commands.goToSymbolInWorkspaceDescription', 'Search for a function, class, or symbol across open TS/JS files') });
    [['toggleBookmark', 'ide:toggle-bookmark', jt('ide.commands.toggleBookmark', 'Toggle Bookmark'), 'ctrl+alt+k'],
      ['nextBookmark', 'ide:next-bookmark', jt('ide.commands.nextBookmark', 'Next Bookmark'), 'ctrl+alt+l'],
      ['prevBookmark', 'ide:prev-bookmark', jt('ide.commands.previousBookmark', 'Previous Bookmark'), 'ctrl+alt+j'],
      ['listBookmarks', 'ide:list-bookmarks', jt('ide.commands.listAllBookmarks', 'List All Bookmarks'), 'ctrl+alt+p']].forEach(([dep, id, label, chord]) => {
      add(fn(d[dep]), id, label, [chord], () => d[dep]());
    });

    // Layout: side bars, panel, terminal.
    add(true, 'ide:toggle-primary-side', jt('ide.keymap.togglePrimarySide', 'View: Toggle Primary Side Bar'), ['ctrl+b'],
      () => getWorkbench()?.togglePrimarySide?.(), { when: (ctx) => ide(ctx) && Boolean(getWorkbench()) });
    add(chatDock, 'ide:toggle-chat', jt('ide.keymap.toggleSecondarySide', 'View: Toggle Secondary Side Bar'), ['ctrl+alt+b'],
      () => chatDock.toggle?.(), { when: (ctx) => ide(ctx) && isChatDockEnabled() });
    add(chatDock, 'ide:chat-dock-switch', jt('ide.keymap.chatDockSwitch', 'Chat: Switch Between Chat and Changes'), ['ctrl+alt+g'],
      () => chatDock.toggleChangesTab(), { when: (ctx) => ide(ctx) && isChatDockEnabled() && typeof chatDock.toggleChangesTab === 'function' });
    add(bottomPanel, 'ide:toggle-panel', jt('ide.keymap.togglePanel', 'View: Toggle Panel'), ['ctrl+j'], () => bottomPanel.toggle?.());
    add(bottomPanel, 'ide:toggle-terminal', jt('ide.keymap.toggleTerminal', 'View: Toggle Terminal'), ['ctrl+`'], (ctx) => {
      if (ctx.focused === 'terminal') {
        bottomPanel.close?.();
        return;
      }
      bottomPanel.open?.('terminal');
    });
    add(fn(d.newTerminal), 'ide:new-terminal', jt('ide.keymap.newTerminal', 'Terminal: Create New Terminal'), ['ctrl+shift+`'],
      () => d.newTerminal(), { when: (ctx) => ide(ctx) && (fn(d.canAddTerminal) ? d.canAddTerminal() : true) });

    // Views, focused (group Navigate, as VS Code's Focus commands).
    add(true, 'ide:focus-explorer', jt('ide.keymap.focusExplorer', 'Focus Explorer'), ['ctrl+shift+e'], (ctx) => {
      const path = activePath();
      if (ctx.hasActiveFile && fn(d.revealInExplorer)) d.revealInExplorer(path, { expandSelf: false });
      else revealView('explorer');
    }, { group: 'Navigate' });
    add(true, 'ide:find-in-files', jt('ide.commands.findInFiles', 'Find in Files'), ['ctrl+shift+f'],
      () => focusSearchField('[data-ide-search-input]'),
      { description: jt('ide.commands.findInFilesDescription', 'Search across every file in the workspace') });
    add(true, 'ide:replace-in-files', jt('ide.keymap.replaceInFiles', 'Replace in Files'), ['ctrl+shift+h'],
      () => focusSearchField('[data-ide-replace-input]'));
    add(true, 'ide:focus-source-control', jt('ide.keymap.focusSourceControl', 'Focus Source Control'), ['ctrl+shift+g'],
      () => revealView('source-control'), { group: 'Navigate' });
    add(true, 'ide:focus-problems', jt('ide.keymap.focusProblems', 'Focus Problems'), ['ctrl+shift+m'],
      () => toggleView('problems'), { group: 'Navigate' });
    add(true, 'ide:focus-run', jt('ide.keymap.focusRun', 'Focus Run'), ['ctrl+shift+d'],
      () => revealView('run'), { group: 'Navigate' });

    // Editor groups (they need Monaco: the rows appear once it has loaded).
    add(editorGroups, 'ide:split-editor-right', jt('ide.commands.splitRight', 'Split Editor Right'), ['ctrl+\\'],
      () => editorGroups.splitActive('right'), { when: (ctx) => ide(ctx) && hasMonaco() });
    add(editorGroups, 'ide:split-editor-down', jt('ide.commands.splitDown', 'Split Editor Down'), ['ctrl+k ctrl+\\'],
      () => editorGroups.splitActive('down'), { when: (ctx) => ide(ctx) && hasMonaco() });
    for (let n = 1; n <= GROUP_COUNT; n += 1) {
      add(editorGroups, 'ide:focus-group-' + n, jt('ide.keymap.focusGroup', 'View: Focus into Editor Group {n}', { n }), ['ctrl+' + n],
        () => focusGroup(n), { when: (ctx) => ide(ctx) && hasMonaco() });
    }
    add(true, 'ide:toggle-zen', jt('ide.keymap.toggleZen', 'View: Toggle Zen Mode'), ['ctrl+k z'],
      () => getWorkbench()?.toggleZen?.(), { when: (ctx) => ide(ctx) && typeof getWorkbench()?.toggleZen === 'function' });

    // Preview and help.
    add(fn(d.previewActiveFile), 'ide:preview-active-file', jt('ide.commands.previewActiveFile', 'Preview Active File'), ['ctrl+shift+v'],
      () => d.previewActiveFile(),
      { description: jt('ide.commands.previewActiveFileDescription', 'Preview the active file in the Preview stage surface') });
    // Wave 2 if the Preview stage cannot host per group: until then it is Ctrl+Shift+V.
    add(fn(d.previewActiveFile), 'ide:preview-to-the-side', jt('ide.keymap.previewToSide', 'Open Preview to the Side'), ['ctrl+k v'],
      () => d.previewActiveFile());
    add(fn(d.openKeyboardShortcuts), 'ide:keyboard-shortcuts', jt('ide.keymap.keyboardShortcuts', 'Preferences: Open Keyboard Shortcuts'), ['ctrl+k ctrl+s'],
      () => d.openKeyboardShortcuts());

    return function disposeKeymap() {
      while (disposers.length) {
        try { disposers.pop()(); } catch (_error) { /* already gone */ }
      }
    };
  }

  // ---- Monaco side: the two-step chords ----

  const MONACO_KEYS = Object.freeze({
    '\\': 'Backslash', '`': 'Backquote', ',': 'Comma', '.': 'Period', '/': 'Slash', '-': 'Minus', '=': 'Equal',
    '[': 'BracketLeft', ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote',
    up: 'UpArrow', down: 'DownArrow', left: 'LeftArrow', right: 'RightArrow',
    pageup: 'PageUp', pagedown: 'PageDown', escape: 'Escape', space: 'Space', tab: 'Tab', enter: 'Enter',
  });

  function monacoKeyCode(name, KeyCode) {
    if (/^[a-z]$/.test(name)) return KeyCode['Key' + name.toUpperCase()];
    if (/^\d$/.test(name)) return KeyCode['Digit' + name];
    if (/^f\d{1,2}$/.test(name)) return KeyCode['F' + name.slice(1)];
    return MONACO_KEYS[name] ? KeyCode[MONACO_KEYS[name]] : undefined;
  }

  function monacoStep(step, monacoApi) {
    const parts = String(step || '').split('+');
    const name = parts.pop();
    const code = monacoKeyCode(name, monacoApi.KeyCode || {});
    if (code == null) return null;
    const mods = monacoApi.KeyMod || {};
    let value = code;
    if (parts.indexOf('ctrl') !== -1) value |= mods.CtrlCmd;
    if (parts.indexOf('alt') !== -1) value |= mods.Alt;
    if (parts.indexOf('shift') !== -1) value |= mods.Shift;
    return value;
  }

  // 'ctrl+k z' -> KeyMod.chord(Ctrl+K, Z); null for a single step or an unmapped key.
  function monacoChord(chord, monacoApi) {
    const steps = String(chord || '').split(' ');
    if (steps.length !== 2 || !monacoApi || typeof monacoApi.KeyMod?.chord !== 'function') return null;
    const first = monacoStep(steps[0], monacoApi);
    const second = monacoStep(steps[1], monacoApi);
    return first == null || second == null ? null : monacoApi.KeyMod.chord(first, second);
  }

  function bindMonacoKeymap(registry, { editorHost, monacoApi, getContext } = {}) {
    if (!registry || typeof editorHost?.addEditorAction !== 'function' || !monacoApi) return 0;
    const context = typeof getContext === 'function' ? getContext : () => ({ activeView: 'ide' });
    const byId = new Map();
    registry.bindings().forEach(({ chord, id }) => {
      const keybinding = monacoChord(chord, monacoApi);
      if (keybinding == null) return;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(keybinding);
    });
    byId.forEach((keybindings, id) => {
      const command = registry.get(id);
      editorHost.addEditorAction({
        id: 'jenny.keymap.' + id.slice(4),
        label: command ? command.label : id,
        keybindings,
        run: () => { registry.run(id, Object.assign({}, context(), { focused: 'editor' })); },
      });
    });
    return byId.size;
  }

  return {
    TERMINAL_PASSTHROUGH,
    buildCommandContext,
    bindMonacoKeymap,
    focusZone,
    isKeymapEditor,
    monacoChord,
    registerIdeKeymapCommands,
  };
});
