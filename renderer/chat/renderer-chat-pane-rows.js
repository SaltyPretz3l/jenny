/* renderer/chat/renderer-chat-pane-rows.js - one header row per chat pane in the Chat workbench (UMD).
 *
 * Row 190 Wave 3 (owner D4-D6). Each pane's button cluster becomes its one header row: that pane's tabs first,
 * its buttons after. Pane 0's row hosts the app's tab rail (#workspaceRailShell, moved in); pane 1's row gets a
 * second rail built from the same callbacks (window.rendererWorkspaceChromeKit). A tab belongs to the pane that
 * last showed it; the record is the sparse `workspace.tabPanes` map ({ sessionId: 1 }) the main process keeps
 * (shell-config v60). Eight tabs across both panes, as before (D5); Ctrl+Tab cycles the focused pane's tabs (D6).
 * Disposed, nothing here runs and the rail goes back where it came from. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatPaneRows = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CLOSE_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M4 4l8 8M12 4l-8 8"/></svg>';

  // Which pane a tab belongs to: a tab a pane shows is that pane's; otherwise the stored map; one pane owns all.
  function paneOf(id, layout, tabPanes) {
    const panes = (layout && layout.panes) || [];
    if (panes.length < 2) return 0;
    if (panes[1] && panes[1].sessionId === id) return 1;
    if (panes[0] && panes[0].sessionId === id) return 0;
    return tabPanes && tabPanes[id] === 1 ? 1 : 0;
  }

  // The sparse map for a layout: only pane 1's tabs, in tab order; {} with one pane.
  function tabPanesFor(openIds, layout, tabPanes) {
    const next = {};
    if (((layout && layout.panes) || []).length < 2) return next;
    (openIds || []).forEach((id) => { if (paneOf(id, layout, tabPanes) === 1) next[id] = 1; });
    return next;
  }

  // Ctrl+Tab inside the focused pane: the next (or previous) of its tabs, or '' when there is nowhere to go.
  function cycleTarget(openIds, layout, tabPanes, direction) {
    const panes = (layout && layout.panes) || [];
    if (panes.length < 2) return null; // one pane: the app's own MRU cycle
    const focused = layout.focusedPaneId === 1 ? 1 : 0;
    const ids = (openIds || []).filter((id) => paneOf(id, layout, tabPanes) === focused);
    if (ids.length < 2) return '';
    const at = ids.indexOf(panes[focused] && panes[focused].sessionId);
    return ids[(at + (direction < 0 ? -1 : 1) + ids.length) % ids.length];
  }

  /* deps = { doc, win, state, getKit() -> window.rendererWorkspaceChromeKit, jt(key, fallback), log?() } */
  function createChatPaneRows(deps) {
    const d = deps || {};
    const doc = d.doc;
    const jt = typeof d.jt === 'function' ? d.jt : (key, fallback) => fallback;
    let attached = false;
    let home = null;
    let row1 = null;
    let chrome1 = null;
    let closeButton = null;
    let tabPanes = {};
    let persistTimer = 0;
    // The saved second pane's chat while the app has not reopened that pane yet (boot): the saved map stands until
    // it does, or a one-pane render here would file every pane-1 tab under pane 0 and save that.
    let awaitedPaneOne = '';
    const listeners = [];

    const kit = () => (typeof d.getKit === 'function' ? d.getKit() : null);
    const paneLayout = () => kit()?.getPaneLayout?.() || null;
    const layoutNow = () => paneLayout()?.getLayout?.() || { panes: [], focusedPaneId: 0 };
    const cluster = (paneId) => doc.querySelector(`#chatView > .chat-pane[data-pane-id="${paneId}"] [data-chat-node="chatTimelineUtilityCluster"]`);
    const openIds = () => (d.state && d.state.workspace && d.state.workspace.openSessionIds) || [];

    // A click or key in a pane's row focuses that pane first, so the tab opens there.
    function focusOnUse(el, paneId) {
      const run = () => { if (layoutNow().panes.length > 1) paneLayout()?.setFocusedPane?.(paneId); };
      ['pointerdown', 'keydown'].forEach((type) => { el.addEventListener(type, run, true); listeners.push([el, type, run]); });
    }
    // The row's entries leave with the row, so a closed second pane keeps nothing alive.
    function forgetListeners(el) {
      for (let i = listeners.length - 1; i >= 0; i -= 1) {
        if (listeners[i][0] !== el) continue;
        el.removeEventListener(listeners[i][1], listeners[i][2], true);
        listeners.splice(i, 1);
      }
    }

    function persist() {
      if (persistTimer) return;
      persistTimer = d.win.setTimeout(() => {
        persistTimer = 0;
        Promise.resolve(d.win.jennyShell?.workspace?.updateState?.({ tabPanes: { ...tabPanes } }))
          .catch((error) => d.log?.('WARN', 'chat_pane_rows.persist_failed', { message: String((error && error.message) || error).slice(0, 200) }));
      }, 250);
    }

    function attach() {
      if (attached) return;
      attached = true;
      Promise.resolve(d.win.jennyShell?.workspace?.getState?.()).then((saved) => {
        if (!attached || !saved || typeof saved.tabPanes !== 'object' || !saved.tabPanes) return;
        tabPanes = { ...saved.tabPanes };
        const paneOne = Array.isArray(saved.panes) ? saved.panes[1] : null;
        awaitedPaneOne = layoutNow().panes.length < 2 ? String((paneOne && typeof paneOne === 'object' ? paneOne.sessionId : paneOne) || '') : '';
        kit()?.renderChrome?.();
      }).catch(() => {});
    }

    function placeMainRail() {
      const shell = doc.getElementById('workspaceRailShell');
      const target = cluster(0);
      if (!shell || !target) return null;
      if (!home) {
        home = { parent: shell.parentNode, next: shell.nextSibling };
        focusOnUse(shell, 0);
      }
      if (shell.parentNode !== target) target.prepend(shell);
      shell.classList.add('chat-pane-tabs');
      return shell;
    }

    function dropRow1() {
      if (chrome1 && typeof chrome1.dispose === 'function') chrome1.dispose();
      chrome1 = null;
      if (row1) { forgetListeners(row1); row1.remove(); }
      row1 = null;
      if (closeButton) closeButton.remove();
      closeButton = null;
    }

    function placeRow1() {
      const target = cluster(1);
      if (!target) return null;
      if (!row1 || !row1.isConnected || row1.parentNode !== target) {
        dropRow1();
        row1 = doc.createElement('div');
        row1.className = 'workspace-rail-shell chat-pane-tabs';
        target.prepend(row1);
        focusOnUse(row1, 1);
        chrome1 = kit()?.create?.(row1, {}) || null;
        const label = jt('chat.paneRows.closePane', 'Close this pane');
        const holder = doc.createElement('div');
        holder.innerHTML = d.win.inventory.actionButton({ plain: true, className: 'chat-timeline-utility-button chat-pane-row-close', ariaLabel: label, title: label, trustedHtml: CLOSE_ICON });
        closeButton = holder.firstElementChild;
        closeButton.addEventListener('click', () => paneLayout()?.closePane?.(1));
        target.appendChild(closeButton);
      }
      return row1;
    }

    // data = { runtimeOnly, openIds, sessions, streaming, approvals, attention } from renderWorkspaceChrome.
    function render(data) {
      const main = kit()?.getMainChrome?.();
      if (!attached || !main || !placeMainRail()) return;
      const layout = layoutNow();
      const ids = data.openIds || [];
      // Still waiting only while that chat is an open tab: a pane that will not come back releases the map.
      if (awaitedPaneOne && (layout.panes.length > 1 || ids.indexOf(awaitedPaneOne) < 0)) awaitedPaneOne = '';
      const next = awaitedPaneOne ? tabPanes : tabPanesFor(ids, layout, tabPanes);
      if (JSON.stringify(next) !== JSON.stringify(tabPanes)) { tabPanes = next; persist(); }
      const split = layout.panes.length > 1 && placeRow1();
      if (!split) dropRow1();
      const active = (paneId) => (layout.panes[paneId] && layout.panes[paneId].sessionId)
        || (paneId === 0 ? (d.state.workspace?.activeSessionId || d.state.currentSessionId || '') : '');
      const rows = [[main, 0], [split ? chrome1 : null, 1]];
      rows.forEach(([chrome, paneId]) => {
        if (!chrome) return;
        const own = ids.filter((id) => paneOf(id, layout, tabPanes) === paneId);
        if (data.runtimeOnly) chrome.patchRailRuntime(active(paneId), data.streaming, data.approvals, data.attention);
        else chrome.renderRail(own, active(paneId), data.sessions, data.streaming, data.approvals, data.attention);
      });
    }

    function cycle(direction) {
      if (!attached) return false;
      const target = cycleTarget(openIds(), layoutNow(), tabPanes, direction);
      if (target === null) return false;
      if (target) kit()?.activate?.(target);
      return true;
    }

    function detach() {
      if (!attached) return;
      attached = false;
      if (persistTimer) d.win.clearTimeout(persistTimer);
      persistTimer = 0;
      awaitedPaneOne = '';
      dropRow1();
      listeners.splice(0).forEach(([el, type, fn]) => el.removeEventListener(type, fn, true));
      const shell = doc.getElementById('workspaceRailShell');
      if (shell && home && home.parent) {
        shell.classList.remove('chat-pane-tabs');
        home.parent.insertBefore(shell, home.next && home.next.parentNode === home.parent ? home.next : null);
      }
      home = null;
    }

    return {
      attach,
      detach,
      isActive: () => attached,
      render,
      cycle,
      getTabPanes: () => ({ ...tabPanes }),
      dispose: detach,
    };
  }

  return { createChatPaneRows, paneOf, tabPanesFor, cycleTarget };
});
