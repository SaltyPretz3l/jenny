/* renderer/features/board/board-page-workbench.js - the Board's binding to the workbench (UMD).
 *
 * The Workspace's workbench (renderer-ide-workbench.js) draws a layout tree of resizable, collapsible
 * columns. The Board is a second instance of it, handed its own root element, its own layout (the `board`
 * profile: boards | canvas | chat + changes), a three-view registry and the canvas where the Workspace has
 * its editor. This binding is the Board's counterpart of renderer-ide-workbench-wiring.js, without
 * terminals, Zen mode or editor groups. The `chat` and `changes` views get host elements marked
 * `data-board-chat-host` and `data-board-changes-host`: board-chat-dock.js moves the chat dock into the first
 * while the Board is on screen. Element ids carry the prefix `board-`, because the Workspace's workbench can
 * be in the same document. `onLayoutChange` is called after a layout the person changed is drawn. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererBoardPageWorkbench = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const SVG_OPEN = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">';
  const ICONS = Object.freeze({
    boards: `${SVG_OPEN}<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><path d="M9 11.25h4.5"/></svg>`,
    chat: `${SVG_OPEN}<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H8.5L5.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"/></svg>`,
    changes: `${SVG_OPEN}<path d="M4 2.5v11M12 2.5v11M2.5 5.5H5.5M10.5 10.5h3M12 9v3"/></svg>`,
  });

  function createBoardPageWorkbench(deps) {
    const { workbenchUtils, layoutModel, store, rootEl, centreEl, listEl, jt } = deps;
    const doc = rootEl.ownerDocument;
    let layout = store.loadLayout();
    let disposed = false;
    // Row 190 Wave 4: the dock (board-chat-dock.js) names its chat on the shown Chat tab and opens its picker there.
    let chatTab = null;
    const chatShown = () => workbench.isViewVisible('chat') && workbench.getActiveView('chat') === 'chat';

    const views = {
      boards: { label: () => jt('board.view.boards', 'Boards'), icon: ICONS.boards },
      chat: {
        label: () => (chatTab && chatTab.label(chatShown())) || jt('board.view.chat', 'Chat'),
        icon: ICONS.chat,
        onActiveTabClick: (tab) => { if (chatTab) chatTab.onActiveTabClick(tab); },
      },
      changes: { label: () => jt('board.view.changes', 'Changes'), icon: ICONS.changes },
    };

    function focusCanvas() {
      const canvas = centreEl.querySelector('.inv-board-canvas');
      if (!canvas || typeof canvas.focus !== 'function') return false;
      canvas.focus({ preventScroll: true });
      return true;
    }

    function commit(next) {
      if (disposed || !next) return;
      layout = next;
      store.saveLayout(layout);
      workbench.render();
      if (typeof deps.onLayoutChange === 'function') deps.onLayoutChange();
    }

    const workbench = workbenchUtils.createIdeWorkbench({
      getRoot: () => rootEl,
      idPrefix: 'board-',
      getLayout: () => layout,
      commitLayout: commit,
      views,
      isViewAvailable: () => true,
      getEditorElement: () => centreEl,
      getGroupElement: () => null,
      focusEditor: focusCanvas,
      resetLayout: () => { if (roomStack) roomStack.releaseViews(); commit(layoutModel.createDefaultLayout('board')); },
      getFontScale: () => {
        const win = doc.defaultView;
        const raw = win && win.getComputedStyle ? Number.parseFloat(win.getComputedStyle(doc.documentElement).getPropertyValue('--font-scale')) : NaN;
        return Number.isFinite(raw) && raw > 0 ? raw : 1;
      },
      jt,
    });

    // The three views' persistent hosts: the list fills the first, the other two wait empty for the chat dock.
    workbench.hostFor('boards').appendChild(listEl);
    const chatHost = doc.createElement('div');
    chatHost.className = 'board-chat-host';
    chatHost.setAttribute('data-board-chat-host', '');
    workbench.hostFor('chat').appendChild(chatHost);
    const changesHost = doc.createElement('div');
    changesHost.className = 'board-changes-host';
    changesHost.setAttribute('data-board-changes-host', '');
    workbench.hostFor('changes').appendChild(changesHost);

    // Row 190 Wave 4, row 195: the side panel's Artifacts, Project and Runs join the chat's stack when one opens here (renderer-chat-right-stack.js).
    const rightStackUtils = deps.rightStackUtils || globalThis.rendererChatRightStack || null;
    const layoutOps = deps.layoutOps || globalThis.jennyWorkbenchLayoutOps || null;
    const roomStack = rightStackUtils && rightStackUtils.createRoomStack && layoutOps ? rightStackUtils.createRoomStack({
      workbench, getLayout: () => layout, commit, model: layoutModel, ops: layoutOps, jt, doc,
      modeViews: { artifact: 'artifacts', tasks: 'project', notes: 'project', background_tasks: 'runs', subagents: 'runs' }, near: ['runs', 'project', 'artifacts', 'changes', 'chat'],
    }) : null;
    if (roomStack) Object.assign(views, roomStack.views());
    const leaveRoom = roomStack ? rightStackUtils.registerRoom('board', () => (disposed ? null : roomStack)) : () => {};

    const isOpen = (id) => { const found = layoutModel.findView(layout, id); return Boolean(found) && found.collapsed !== true; };
    const setOpen = (id, open) => { if (disposed) return; if (open) workbench.revealView(id); else workbench.collapseStackOf(id); };

    return {
      workbench,
      chatHost,
      changesHost,
      focusCanvas,
      getLayout: () => layout,
      // The chat column is open while its stack is not collapsed, whichever of its tabs shows.
      isChatOpen: () => isOpen('chat'),
      setChatOpen: (open) => setOpen('chat', open),
      setChatTab: (hooks) => { chatTab = hooks || null; if (!disposed) workbench.render(); },
      // Ctrl+B and Ctrl+Alt+B: flips the `boards` or `chat` column; false once disposed.
      toggle: (id) => !disposed && (setOpen(id, !isOpen(id)), true),
      // Shows the Changes view and puts focus on its heading (board-proposals-view.js keeps that heading in the host).
      revealChanges: () => {
        if (disposed) return false;
        workbench.revealView('changes');
        const heading = changesHost.querySelector('[data-board-changes-title]');
        if (heading && typeof heading.focus === 'function') heading.focus({ preventScroll: true });
        return true;
      },
      render: () => { if (!disposed) workbench.render(); },
      dispose() {
        if (disposed) return;
        disposed = true;
        leaveRoom();
        workbench.dispose();
      },
    };
  }

  return { createBoardPageWorkbench, ICONS };
});
