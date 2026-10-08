/* renderer/features/renderer-ide-workbench-wiring.js - binds the Workspace workbench
 * (renderer-ide-workbench.js) to the IDE controller (row 40 W3).
 *
 * Owns: the view registry (labels, strip icons, counts, availability), the layout
 * commit path (ide.workbenchLayout through renderer-ide-state.js, then persist +
 * render), each panel's mount host + visibility gate (viewDeps), and the facades
 * that keep the pre-workbench call sites working: bottomPanel.open/toggle/close/
 * getActiveViewId, showPanel, the chat dock's open state and the Ctrl+B hook.
 * The rail, secondary sidebar and bottom-panel chrome these replace are gone. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeWorkbenchWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const globalRef = typeof globalThis !== 'undefined' ? globalThis : {};
  function noop() {}

  function resolveModule(globalName, requirePath) {
    if (globalRef[globalName]) return globalRef[globalName];
    if (typeof require === 'function') {
      try {
        return require(requirePath);
      } catch (_error) {
        /* unavailable */
      }
    }
    return null;
  }

  // One 16px stroke icon set for the collapsed strip (F1/F10). Trusted markup.
  function icon(paths) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
  }
  const ICONS = Object.freeze({
    explorer: icon('<path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.5 1.5h4.5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>'),
    search: icon('<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>'),
    'source-control': icon('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="6" r="1.5"/><path d="M4.5 5v6M11.5 7.5c0 2.5-3 2.5-6.5 3.5"/>'),
    terminal: icon('<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M4.5 6.5l2 1.5-2 1.5M8 10h3"/>'),
    problems: icon('<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.2v.1"/>'),
    run: icon('<path d="M5 3.5l7 4.5-7 4.5z"/>'),
    'test-runner': icon('<path d="M6 2.5h4M7 2.5v4l-3.5 6a1 1 0 0 0 .9 1.5h7.2a1 1 0 0 0 .9-1.5L9 6.5v-4"/>'),
    'test-output': icon('<path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M6 8h4M6 10.5h4"/>'),
    chat: icon('<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8.5L5.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/>'),
    changes: icon('<path d="M4 2.5v11M12 2.5v11M2.5 5.5H5.5M10.5 10.5h3M12 9v3"/>'),
  });

  // Icons for views' own header actions (W4: + and Kill on terminals).
  const ACTION_ICONS = Object.freeze({
    add: icon('<path d="M8 3.5v9M3.5 8h9"/>'),
    trash: icon('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
  });

  const VIEW_LABELS = Object.freeze({
    explorer: () => jt('ide.workbench.view.files', 'Files'),
    search: () => jt('ide.workbench.view.search', 'Search'),
    'source-control': () => jt('ide.workbench.view.git', 'Git'),
    terminal: () => jt('ide.workbench.view.terminal', 'Terminal'),
    problems: () => jt('ide.workbench.view.problems', 'Problems'),
    run: () => jt('ide.workbench.view.run', 'Run'),
    'test-runner': () => jt('ide.workbench.view.tests', 'Tests'),
    'test-output': () => jt('ide.workbench.view.testOutput', 'Test output'),
    // Extra terminals (F3): instances of the terminal view.
    'terminal-2': () => jt('ide.workbench.view.terminalN', 'Terminal {n}', { n: 2 }),
    'terminal-3': () => jt('ide.workbench.view.terminalN', 'Terminal {n}', { n: 3 }),
    'terminal-4': () => jt('ide.workbench.view.terminalN', 'Terminal {n}', { n: 4 }),
    chat: () => jt('ide.workbench.view.chat', 'Chat'),
    changes: () => jt('ide.workbench.view.changes', 'Changes'),
    // The second Workspace chat (W6b): split view's second pane and its own Changes.
    'chat-2': () => jt('ide.workbench.view.chatN', 'Chat {n}', { n: 2 }),
    'changes-2': () => jt('ide.workbench.view.changesN', 'Changes {n}', { n: 2 }),
  });
  const BOTTOM_HOME = 'terminal';

  /**
   * @param {object} deps
   * @param {() => object} deps.getDom ideWorkbench / ideMain / ideChatDock
   * @param {() => object} deps.getIde
   * @param {object} deps.ideStateUtils getWorkbenchLayout / commitWorkbenchLayout
   * @param {() => void} deps.schedulePersist
   * @param {() => void} deps.requestRender renderIde
   * @param {() => boolean} deps.focusEditor
   * @param {() => boolean} [deps.focusTerminal]
   * @param {(id: string) => boolean} [deps.isViewAvailable] extra gates (Test Runner, chat dock flag)
   * @param {{[id: string]: () => number}} [deps.counts]
   * @param {{[id: string]: () => boolean}} [deps.unread] a dot on the tab when there is no count (W6)
   * @param {{[id: string]: () => void}} [deps.onShow]
   * @param {{[id: string]: () => string}} [deps.labels] live labels; empty falls back to the static one
   * @param {(id: string) => object[]} [deps.viewActions] a view's header actions while it is active
   * @param {(id: string, name: string) => void} [deps.onViewAction]
   * @param {(id: string) => Element|null} [deps.getGroupElement] a secondary editor group's view (W5)
   * @param {() => object|null} [deps.getEditorGroups] the editor-groups wiring (W7c binding reads its focus)
   */
  function createIdeWorkbenchWiring(deps) {
    const d = deps || {};
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const getIde = typeof d.getIde === 'function' ? d.getIde : () => ({});
    const stateUtils = d.ideStateUtils || {};
    const schedulePersist = typeof d.schedulePersist === 'function' ? d.schedulePersist : noop;
    const requestRender = typeof d.requestRender === 'function' ? d.requestRender : noop;
    const focusEditor = typeof d.focusEditor === 'function' ? d.focusEditor : () => false;
    const focusTerminal = typeof d.focusTerminal === 'function' ? d.focusTerminal : () => false;
    const extraAvailable = typeof d.isViewAvailable === 'function' ? d.isViewAvailable : () => true;
    const counts = d.counts || {};
    const onShow = d.onShow || {};
    const labels = d.labels || {};
    const workbenchUtils = d.workbenchUtils || resolveModule('rendererIdeWorkbench', './renderer-ide-workbench');

    // A view's header actions (W4: + and Kill on terminals) and its live label (Run: <script>).
    const views = {};
    Object.keys(VIEW_LABELS).forEach((id) => {
      views[id] = {
        label: typeof labels[id] === 'function' ? () => labels[id]() || VIEW_LABELS[id]() : VIEW_LABELS[id],
        icon: ICONS[id] || ICONS[id.replace(/-\d$/, '')],
        count: typeof counts[id] === 'function' ? counts[id] : undefined,
        unread: typeof d.unread?.[id] === 'function' ? d.unread[id] : undefined,
        onShow: typeof onShow[id] === 'function' ? onShow[id] : undefined,
        actions: typeof d.viewActions === 'function' ? () => d.viewActions(id) : undefined,
        onAction: typeof d.onViewAction === 'function' ? (name) => d.onViewAction(id, name) : undefined,
      };
    });

    function getLayout() {
      return stateUtils.getWorkbenchLayout?.(getIde()) || null;
    }

    function commitLayout(next) {
      if (stateUtils.commitWorkbenchLayout?.(getIde(), next) === true) schedulePersist();
      requestRender();
    }

    // A commit made while rendering (editor groups follow their tabs, W5): no re-render.
    function replaceLayout(next) {
      if (stateUtils.commitWorkbenchLayout?.(getIde(), next) === true) schedulePersist();
    }

    const workbench = workbenchUtils?.createIdeWorkbench?.({
      getRoot: () => getDom().ideWorkbench || null,
      getLayout,
      commitLayout,
      views,
      isViewAvailable: (id) => extraAvailable(id) !== false,
      getEditorElement: () => getDom().ideMain || null,
      getGroupElement: (id) => (typeof d.getGroupElement === 'function' ? d.getGroupElement(id) : null),
      focusEditor,
      resetLayout: () => resetLayout(),
      extraMenuItems: (id) => groupBinding?.menuItems(id) || [],
      getFontScale: () => {
        const docEl = getDom().ideWorkbench?.ownerDocument?.documentElement;
        const win = docEl?.ownerDocument?.defaultView;
        const raw = docEl && win?.getComputedStyle ? Number.parseFloat(win.getComputedStyle(docEl).getPropertyValue('--font-scale')) : NaN;
        return Number.isFinite(raw) && raw > 0 ? raw : 1;
      },
      jt,
    }) || null;

    // The chat dock element (session picker + transcript body) is the chat view's content.
    function adoptChatDock() {
      const dock = getDom().ideChatDock || null;
      const host = workbench?.hostFor('chat');
      if (dock && host && dock.parentNode !== host) host.appendChild(dock);
    }

    // Each panel's mount host + its visibility gate (replaces the rail/secondary/bottom hosts).
    function viewDeps(id) {
      return {
        getMountEl: () => workbench?.hostFor(id) || null,
        isActivePanel: () => workbench?.isViewVisible(id) === true,
      };
    }

    function isVisible(id) {
      return workbench?.isViewVisible(id) === true;
    }

    function showPanel(id, options = {}) {
      return workbench?.revealView(id, { focus: options.focus === true }) === true;
    }

    // ---- Facades for the retired bottom panel ----
    const bottomPanel = {
      open(view) {
        const id = view || workbench?.getActiveView(BOTTOM_HOME) || BOTTOM_HOME;
        if (!workbench?.revealView(id)) return false;
        if (id === 'terminal') focusTerminal();
        return true;
      },
      close() {
        const wasInside = isFocusInsideStackOf(BOTTOM_HOME);
        workbench?.collapseStackOf(BOTTOM_HOME);
        if (wasInside) focusEditor();
      },
      toggle() {
        const id = workbench?.getActiveView(BOTTOM_HOME) || BOTTOM_HOME;
        if (isVisible(id)) bottomPanel.close();
        else bottomPanel.open(id);
      },
      getActiveViewId: () => workbench?.getActiveView(BOTTOM_HOME) || BOTTOM_HOME,
      isOpen: () => isVisible(workbench?.getActiveView(BOTTOM_HOME) || BOTTOM_HOME),
    };

    function isFocusInsideStackOf(viewId) {
      const host = workbench?.hostFor(viewId);
      const stack = host?.closest?.('[data-wb-stack]');
      const active = host?.ownerDocument?.activeElement;
      return Boolean(stack && active && stack.contains(active));
    }

    // Ctrl+B: toggle the stack holding Files.
    function togglePrimarySide() {
      if (!workbench) return false;
      workbench.toggleViewStack(workbench.getActiveView('explorer') || 'explorer');
      return true;
    }

    // The chat dock's open state is the chat stack's (Ctrl+\ / the dock's own open()).
    function setChatOpen(open) {
      if (!workbench) return;
      if (open) workbench.revealView('chat');
      else workbench.collapseStackOf('chat');
    }

    const layoutModel = () => resolveModule('jennyWorkbenchLayoutModel', '../shared/workbench-layout-model');
    const layoutOps = () => resolveModule('jennyWorkbenchLayoutOps', '../shared/workbench-layout-ops');

    // Palette "Reset Layout": today's arrangement (the model's default tree).
    // Open terminals 2-4 rejoin the terminal stack, so a reset never kills a running shell.
    function resetLayout() {
      let next = layoutModel()?.createDefaultLayout?.();
      let near = 'terminal';
      listViews().filter((id) => /^terminal-\d$/.test(id)).forEach((id) => {
        next = (next && layoutOps()?.addView?.(next, id, near)) || next;
        near = id;
      });
      if (next) commitLayout(next);
    }

    // Instance views (W4: terminal-2..4) join and leave the tree through the layout ops.
    function listViews() {
      const layout = getLayout();
      return layout ? layoutModel()?.listViews?.(layout) || [] : [];
    }

    function changeLayout(change) {
      const layout = getLayout();
      const next = layout ? change(layoutOps() || {}, layout) : null;
      if (!next || next === layout) return false;
      commitLayout(next);
      return true;
    }

    const addView = (viewId, nearViewId) => changeLayout((ops, layout) => ops.addView?.(layout, viewId, nearViewId));
    const removeView = (viewId) => changeLayout((ops, layout) => ops.removeView?.(layout, viewId));

    function render() {
      adoptChatDock();
      workbench?.render();
    }

    function dispose() {
      workbench?.dispose();
      if (active === api) active = null;
    }

    const api = {
      workbench,
      views,
      viewDeps,
      showPanel,
      isVisible,
      bottomPanel,
      togglePrimarySide,
      resetLayout,
      listViews,
      getLayout,
      replaceLayout,
      addView,
      removeView,
      setChatOpen,
      render,
      dispose,
      commitLayout,
    };

    // W7c: chat and terminal views bound to editor groups (the stack menu's rows and the routing).
    const bindingUtils = layoutModel() && layoutOps() ? resolveModule('rendererIdeGroupBinding', './renderer-ide-group-binding') : null;
    const groupBinding = bindingUtils?.createIdeGroupBinding?.({
      getWorkbenchWiring: () => api, getEditorGroups: d.getEditorGroups, getIde, jt,
      model: layoutModel(), ops: layoutOps(), groupsUtils: resolveModule('rendererIdeEditorGroups', './renderer-ide-editor-groups'),
      showPanel: (id) => showPanel(id), viewLabel: (id) => (VIEW_LABELS[id] ? VIEW_LABELS[id]() : id),
    }) || null;
    api.groupBinding = groupBinding;
    active = api;
    return api;
  }

  // The live instance, for the shell's capture-phase Ctrl+B handler (mirrors
  // rendererAppPaneComposition.getPaneComposition).
  let active = null;

  return {
    ICONS,
    ACTION_ICONS,
    VIEW_LABELS,
    createIdeWorkbenchWiring,
    getActive: () => active,
  };
});
