/* renderer/features/renderer-ide-commands.js
 *
 * Workspace IDE command source for the global command palette, the "?"
 * shortcuts overlay and the view keydown dispatcher (row 82: one command
 * registry, renderer-ide-command-registry, behind all three):
 *
 *   1. createIdeCommands() owns the registry and registers the palette-only
 *      rows (Monaco built-ins users otherwise can't discover, the File Map,
 *      Preview and layout rows). getCommandItems() is registry.list({ ctx }),
 *      empty off the IDE view so chat/home palettes stay uncluttered.
 *   2. openHelpOverlay() - the "?" overlay, built on the inventory help-overlay
 *      primitive with the body HTML from renderer-ide-shortcuts (generated from
 *      the registry's bindings). This file carries no raw HTML primitives.
 *   3. createViewKeydownHandler() registers the keymap (renderer-ide-keymap),
 *      the palette rows (renderer-ide-palette-commands) and the status-bar rows
 *      (the chip picker) into the same registry, then resolves every keydown
 *      on #ideView through registry.resolveChord.
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

  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try { return require(requirePath); } catch (_error) { /* unavailable */ }
    }
    return {};
  }
  const registryUtils = resolveModule('rendererIdeCommandRegistry', './renderer-ide-command-registry');
  const keymapUtils = resolveModule('rendererIdeKeymap', './renderer-ide-keymap');
  // Pending first step of a two-step chord (Ctrl+K ...) and the Esc Esc window.
  const CHORD_PENDING_MS = 1500;
  const DOUBLE_ESCAPE_MS = 500;

  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  // Monaco built-in action ids surfaced as palette rows. Stable across 0.52.
  const ACTION_FORMAT = 'editor.action.formatDocument';
  const ACTION_SYMBOL = 'editor.action.quickOutline';
  const ACTION_REFERENCES = 'editor.action.referenceSearch.trigger';

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
    // Workbench layout actions (row 40 W3) that have no chord; each row shows only when wired.
    const layoutActions = options.layoutActions || {};
    const getIde = typeof options.getIde === 'function' ? options.getIde : () => ({});
    const isRepo = typeof options.isRepo === 'function' ? options.isRepo : () => false;
    const openFileMap = typeof options.openFileMap === 'function' ? options.openFileMap : () => {};
    const revealInMap = typeof options.revealInMap === 'function' ? options.revealInMap : () => {};
    const showBlastRadius = typeof options.showBlastRadius === 'function' ? options.showBlastRadius : () => {};
    const openPreviewSurface = typeof options.openPreviewSurface === 'function' ? options.openPreviewSurface : () => {};
    const toggleExplodedView = typeof options.toggleExplodedView === 'function' ? options.toggleExplodedView : () => {};
    const helpOverlayFactory = typeof options.helpOverlayFactory === 'function'
      ? options.helpOverlayFactory
      : null;
    const buildShortcutsHtml = typeof options.buildShortcutsHtml === 'function'
      ? options.buildShortcutsHtml
      : () => '';

    const appendClientLog = typeof options.appendClientLog === 'function' ? options.appendClientLog : () => {};
    // Palette commands call into other controllers; a throw must not escape the
    // palette, but it stays visible in the client log.
    const logIgnoredError = (site, error) => registryUtils.logIgnoredCommandError(appendClientLog, site, error);
    const guarded = (site, fn) => registryUtils.guardCommand(appendClientLog, site, () => fn());

    function runAction(id) {
      try {
        editorHost?.runAction?.(id);
      } catch (error) {
        logIgnoredError(id, error); // Monaco may not be ready
      }
    }

    const registry = options.registry || registryUtils.createIdeCommandRegistry();

    // The `when` context (plan 5.1) for a key event's target or, from the palette,
    // the element that had focus.
    function getContext(target) {
      return keymapUtils.buildCommandContext({
        activeView: getActiveView(),
        ide: getIde(),
        isRepo: (() => { try { return isRepo() === true; } catch (_error) { return false; } })(),
        target: target === undefined ? doc?.activeElement || null : target,
      });
    }

    // One palette-only Workspace row (the chorded rows live in renderer-ide-keymap).
    function row(id, label, description, hint, run, when) {
      registry.register({ id, group: 'Workspace', label, description, hint, run, when });
    }
    const ide = registryUtils.inIde;
    const layoutRow = (action) => (ctx) => ide(ctx) && typeof layoutActions[action] === 'function';

    row('ide:format-document', jt('ide.commands.formatDocument', 'Format Document'),
      jt('ide.commands.formatDocumentDescription', 'Reformat the active file with the language formatter'), 'Shift+Alt+F', () => runAction(ACTION_FORMAT));
    row('ide:go-to-symbol', jt('ide.commands.goToSymbolInEditor', 'Go to Symbol in Editor...'),
      jt('ide.commands.goToSymbolInFileDescription', 'Jump to a function, class, or symbol in the active file'), 'Ctrl+Shift+O', () => runAction(ACTION_SYMBOL));
    row('ide:find-references', jt('ide.commands.findAllReferences', 'Find All References'),
      jt('ide.commands.findAllReferencesDescription', 'Show every reference to the symbol under the cursor'), 'Shift+F12', () => runAction(ACTION_REFERENCES));
    row('ide:move-view', jt('ide.commands.moveView', 'Move View to…'),
      jt('ide.commands.moveViewDescription', 'Move the panel you were last in to another place'), null, guarded('moveView', () => layoutActions.moveView()), layoutRow('moveView'));
    row('ide:reset-layout', jt('ide.commands.resetLayoutView', 'View: Reset Layout'),
      jt('ide.commands.resetLayoutDescription', 'Put every Workspace panel back where it started'), null, guarded('resetLayout', () => layoutActions.resetLayout()), layoutRow('resetLayout'));
    row('ide:focus-next-editor-group', jt('ide.commands.focusNextGroup', 'Focus Next Editor Group'),
      jt('ide.commands.focusNextGroupDescription', 'Move focus to the next editor group'), null, guarded('focusNextGroup', () => layoutActions.focusNextGroup()), layoutRow('focusNextGroup'));
    row('ide:open-file-map', jt('ide.commands.openFileMap', 'Open File Map'),
      jt('ide.commands.openFileMapDescription', 'Open the workspace file map (dependency graph)'), null, guarded('openFileMap', openFileMap));
    row('ide:reveal-in-map', jt('ide.commands.revealActiveFileInMap', 'Reveal Active File in Map'),
      jt('ide.commands.revealActiveFileInMapDescription', 'Frame and focus the active file on the workspace file map'), null, guarded('revealInMap', revealInMap));
    row('ide:show-blast-radius', jt('ide.commands.showBlastRadius', 'Show Blast Radius of Active File'),
      jt('ide.commands.showBlastRadiusDescription', 'Light every file that depends on the active file (transitive importers)'), null, guarded('showBlastRadius', showBlastRadius));
    row('ide:open-preview', jt('ide.commands.openPreview', 'Open Preview'),
      jt('ide.commands.openPreviewDescription', 'Open the workspace Preview stage surface'), null, guarded('openPreviewSurface', openPreviewSurface));
    row('ide:toggle-exploded-view', jt('ide.commands.toggleExplodedView', 'Toggle Exploded View'),
      jt('ide.commands.toggleExplodedViewDescription', 'Switch the active TS/JS file between code and an exploded node graph'), null, guarded('toggleExplodedView', toggleExplodedView));
    row('ide:toggle-minimap', jt('ide.commands.toggleMinimapView', 'View: Toggle Minimap'),
      jt('ide.commands.toggleMinimapDescription', 'Show or hide the editor minimap'), null, guarded('toggleMinimap', toggleMinimap));

    // Palette rows for the active Workspace view. Empty elsewhere so the
    // command palette stays scoped to the surface the user is looking at.
    function getCommandItems() {
      if (getActiveView() !== 'ide') {
        return [];
      }
      return registry.list({ ctx: getContext() });
    }

    // Monaco owns its Ctrl+K prefix: bind the two-step chords as editor actions (onMonacoReady).
    function registerMonacoKeymap(monacoApi) {
      return keymapUtils.bindMonacoKeymap(registry, { editorHost, monacoApi, getContext: () => getContext() });
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
        title: jt('ide.commands.workspaceShortcuts', 'Workspace shortcuts'),
        titleId: 'ideHelpOverlayTitle',
        bodyHtml: buildShortcutsHtml(registry),
        closeLabel: jt('ide.commands.closeShortcuts', 'Close shortcuts'),
      });
    }

    function disposeHelp() {
      if (overlay) {
        try { overlay.destroy(); } catch (error) { logIgnoredError('help_overlay_destroy', error); }
        overlay = null;
      }
    }

    return {
      registry,
      getContext,
      getCommandItems,
      registerMonacoKeymap,
      openHelpOverlay,
      isHelpOpen,
      disposeHelp,
    };
  }

  // View-scoped IDE keydown dispatcher (capture phase on #ideView), extracted from
  // the controller for the file-size ceiling; the controller keeps the
  // addEventListener/removeEventListener wiring. Every chord resolves through the
  // command registry: the keymap, palette and status-bar rows register into it here
  // (deps is one bag; each registrar reads the names it needs). Ctrl+Tab (it commits
  // on Ctrl keyup), "?" and Esc stay outside the registry.
  function createViewKeydownHandler(deps) {
    const options = deps || {};
    const state = options.state || {};
    const ideCommands = options.ideCommands || null;
    const keyboardUtils = options.keyboardUtils || {};
    const windowRef = options.windowRef || (typeof window !== 'undefined' ? window : {});
    const mruSwitcher = options.mruSwitcher || null;
    const getStageSurface = typeof options.getStageSurface === 'function' ? options.getStageSurface : () => 'editor';
    const exitStageSurface = typeof options.exitStageSurface === 'function' ? options.exitStageSurface : () => {};
    const getWorkbench = () => options.workbenchWiring || globalRef.rendererIdeWorkbenchWiring?.getActive?.() || null;
    const registry = options.registry || ideCommands?.registry || registryUtils.createIdeCommandRegistry();
    const bag = Object.assign({ document: windowRef.document || null }, options, {
      openKeyboardShortcuts: options.openKeyboardShortcuts || (ideCommands ? () => ideCommands.openHelpOverlay() : undefined),
    });
    keymapUtils.registerIdeKeymapCommands?.(registry, bag);
    resolveModule('rendererIdePaletteCommands', './renderer-ide-palette-commands').registerIdePaletteCommands?.(registry, bag);
    options.chipPicker?.registerCommands?.(registry);

    function getContext(target) {
      if (ideCommands?.getContext) return ideCommands.getContext(target);
      return keymapUtils.buildCommandContext({
        activeView: state.ui?.activeView,
        ide: typeof options.getIde === 'function' ? options.getIde() : {},
        isRepo: typeof options.isRepo === 'function' && options.isRepo() === true,
        target,
      });
    }

    let pending = null;
    let pendingAt = 0;
    let lastEscapeAt = 0;

    // Esc exits the Preview stage surface; Esc Esc leaves Zen Mode. Scoped: this
    // listener is capture-phase on #ideView, so an unscoped Esc would swallow the
    // File Map's own Esc handlers (map-a11y focus-return; map-controller clear ladder).
    function handleEscape(event) {
      const workbench = getWorkbench();
      if (workbench?.isZen?.() === true) {
        const now = Date.now();
        if (now - lastEscapeAt <= DOUBLE_ESCAPE_MS) {
          lastEscapeAt = 0;
          event.preventDefault();
          workbench.toggleZen();
          return;
        }
        lastEscapeAt = now;
      }
      if (getStageSurface() === 'preview' && !keyboardUtils.isTextInputFocused?.(windowRef.document)) {
        event.preventDefault();
        exitStageSurface();
      }
    }

    // A chord: single steps run at once (and never reach Monaco or the shell when
    // they fire there); Ctrl+K starts a two-step chord, which Monaco resolves itself
    // through the keymap's editor actions when one of its editors has focus.
    function dispatchChord(event) {
      const step = registryUtils.stepFromEvent(event);
      if (!step) return;
      const now = Date.now();
      const prefix = pending && now - pendingAt <= CHORD_PENDING_MS ? pending : null;
      pending = null;
      const target = event.target || null;
      const ctx = getContext(target);
      const result = registry.resolveChord(event, prefix, ctx);
      if (!result) return;
      const inKeymapEditor = keymapUtils.isKeymapEditor(target);
      if (result.pending) {
        if (ctx.focused === 'terminal') return; // Ctrl+K is the shell's kill-line
        pending = result.pending;
        pendingAt = now;
        if (!inKeymapEditor) {
          event.preventDefault();
          if (ctx.focused === 'editor') event.stopPropagation(); // a diff editor never enters its own chord
        }
        return;
      }
      if (prefix && inKeymapEditor) return;
      if (!prefix && ctx.focused === 'terminal' && keymapUtils.TERMINAL_PASSTHROUGH.has(step)) return;
      event.preventDefault();
      if (ctx.focused === 'editor' || ctx.focused === 'terminal') event.stopPropagation();
      registry.run(result.id, ctx);
    }

    return function handleViewKeydown(event) {
      if (state.ui?.activeView !== 'ide' || event.defaultPrevented || event.isComposing) {
        return;
      }
      const ctrl = event.ctrlKey || event.metaKey;
      const key = String(event.key).toLowerCase();
      // Ctrl+Tab (forward) / Ctrl+Shift+Tab (backward) opens the most-recently-used
      // tab switcher. Guard !altKey (Ctrl+Alt+Tab is a Windows system hotkey). The
      // overlay owns its own Ctrl-keyup commit + Esc cancel once open.
      if (ctrl && key === 'tab' && !event.altKey) {
        event.preventDefault();
        mruSwitcher?.handleTabKey(!event.shiftKey);
        return;
      }
      // "?" opens the IDE shortcuts overlay (the chat handler stands down while
      // the IDE is active). Skip when a text input owns focus so the literal
      // "?" still types - this capture-phase listener fires before Monaco's, and
      // isTextInputFocused covers Monaco's hidden textarea while letting
      // buttons/tree rows open it. With focus parked outside #ideView "?" is a
      // no-op; Ctrl+K Ctrl+S and the palette's "Keyboard shortcuts" entry remain.
      if (!ctrl && !event.altKey && key === '?') {
        if (!keyboardUtils.isTextInputFocused?.(windowRef.document)) {
          event.preventDefault();
          ideCommands?.openHelpOverlay();
        }
        return;
      }
      if (!ctrl && !event.altKey && !event.shiftKey && key === 'escape') {
        handleEscape(event);
        return;
      }
      dispatchChord(event);
    };
  }

  // Binds the view handler capture-phase on #ideView, plus a document listener for
  // focus parked outside it: on the page body (Close All Editors leaves it there) or
  // the top rail's tabs (a click on Workspace keeps it). VS Code's chords work from
  // anywhere in the window; overlays and other surfaces keep their own keys, and an open
  // modal owns every key (focus drops to the body on a click in its dead space).
  const MODAL_SELECTOR = '[aria-modal="true"], dialog[open]';
  function bindViewKeydown(viewEl, handler) {
    const doc = viewEl?.ownerDocument;
    if (!doc || typeof handler !== 'function') return () => {};
    // Runs on every key in the window: the cheap identity checks go before the rail walk.
    const parked = (event) => {
      const target = event.target;
      const parkedTarget = target === doc.body || target === doc.documentElement || target === doc || target?.closest?.('#topRail');
      if (parkedTarget && !doc.querySelector(MODAL_SELECTOR)) handler(event);
    };
    viewEl.addEventListener('keydown', handler, true);
    doc.addEventListener('keydown', parked);
    return () => {
      viewEl.removeEventListener('keydown', handler, true);
      doc.removeEventListener('keydown', parked);
    };
  }

  return { createIdeCommands, createViewKeydownHandler, bindViewKeydown };
});
