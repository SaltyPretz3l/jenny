/* renderer/features/renderer-ide-editor-groups-wiring.js - the Workspace's
 * secondary editor groups (row 40 W5): keeps one group view per used group,
 * keeps the layout's editor stacks in step with the tabs' `group` fields, and
 * owns split / move / close-in-group plus the group tab menus.
 *
 * The primary group stays the existing #ideMain editor and tab strip. A file
 * tab lives in exactly one group; a secondary group closes with its last tab,
 * unless a chat or terminal is bound to it (W7c: it stays open, empty). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeEditorGroupsWiring = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const fallbackJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, (m, n) => (Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m)) : d; };
  const noop = () => {};

  function resolveModule(globalName, path) {
    if (globalThis[globalName]) return globalThis[globalName];
    try { return require(path); } catch (_error) { return null; }
  }

  /**
   * @param {object} deps
   * @param {() => object} deps.getIde
   * @param {() => object} deps.getDom ideMain / ideView / ideWorkbench
   * @param {object} deps.editorHost
   * @param {() => object|null} deps.getWorkbenchWiring getLayout / replaceLayout
   * @param {(path: string) => Promise<boolean>} deps.loadDocument background open (no primary activation)
   * @param {(path: string) => void} deps.activatePrimary the primary group shows `path` (fileLifecycle.activateTab)
   * @param {(path: string) => void} deps.requestCloseTab the close flow (dirty prompt)
   * @param {() => object|null} deps.getCloseOrchestrator
   * @param {(path: string) => void} deps.saveFile
   * @param {(path: string) => void} deps.revealInExplorer
   * @param {() => string[]} [deps.getBoundGroups] groups a view is bound to (W7c)
   * @param {(groupId: string) => string} [deps.getBoundText] a bound group's empty-state line
   * @param {(groupId: string) => void} [deps.unbindGroup]
   */
  function createIdeEditorGroupsWiring(deps) {
    const d = deps || {};
    const jt = typeof d.jt === 'function' ? d.jt : fallbackJt;
    const getIde = d.getIde;
    const getDom = typeof d.getDom === 'function' ? d.getDom : () => ({});
    const editorHost = d.editorHost;
    const call = (name, ...args) => (typeof d[name] === 'function' ? d[name](...args) : undefined);
    const groups = d.groupsUtils || resolveModule('rendererIdeEditorGroups', './renderer-ide-editor-groups');
    const viewUtils = d.groupViewUtils || resolveModule('rendererIdeEditorGroupView', './renderer-ide-editor-group-view');
    const ops = d.layoutOps || resolveModule('jennyWorkbenchLayoutOps', '../shared/workbench-layout-ops');
    const contextMenu = d.contextMenu || resolveModule('inventoryContextMenu', '../inventory/context-menu');
    const schedulePersist = typeof d.schedulePersist === 'function' ? d.schedulePersist : noop;
    const requestRender = typeof d.requestRender === 'function' ? d.requestRender : noop;
    // Secondary groups hold text files and session-only diff documents.
    const canHold = typeof d.canHold === 'function' ? d.canHold : (path) => editorHost?.isTextDocument?.(path) === true || editorHost?.getDocumentKind?.(path) === 'diff';

    const views = new Map(); // groupId -> group view
    const loading = new Map(); // path -> its background open in flight
    let focused = ''; // '' = the primary group
    let disposed = false;

    const wiring = () => call('getWorkbenchWiring') || null;
    const layoutNow = () => wiring()?.getLayout?.() || null;
    const groupNumber = (id) => (id ? Number(id.slice(7)) : 1);
    const groupName = (id) => jt('ide.groups.groupLabel', 'Editor group {n}', { n: groupNumber(id) });

    // ---- Reconcile: layout stacks + views follow the tabs ----

    // Groups with tabs plus bound groups, in id order.
    function liveGroups() {
      const used = groups.usedGroups(getIde());
      const bound = call('getBoundGroups') || [];
      return ['editor-2', 'editor-3', 'editor-4'].filter((id) => used.includes(id) || bound.includes(id));
    }

    // Secondary editor stacks in the layout (the first editor stack is the primary).
    function layoutGroups(layout) {
      return (ops?.listEditorGroups?.(layout) || []).slice(1).filter((id) => groups.isGroupId(id));
    }

    // Adds a stack for every used group and drops every stack without tabs; a group the
    // layout cannot take (cap) rejoins the primary. Silent: the caller is rendering.
    function reconcileLayout() {
      const ide = getIde();
      const start = layoutNow();
      if (!start || !ops) return;
      let layout = start;
      const used = groups.usedGroups(ide);
      const bound = call('getBoundGroups') || [];
      for (const id of layoutGroups(layout)) {
        if (!used.includes(id) && !bound.includes(id)) layout = ops.removeEditorGroup(layout, id);
      }
      const primaryBefore = ide.activeTabPath;
      for (const id of used) {
        if (layoutGroups(layout).includes(id)) continue;
        const editors = ops.listEditorGroups(layout);
        const next = ops.addEditorGroup(layout, editors[editors.length - 1], 'right', null, id);
        if (next === layout) groups.releaseGroup(ide, id);
        else layout = next;
      }
      if (layout !== start) wiring()?.replaceLayout?.(layout);
      // A released group gave the empty primary its first tab: show it.
      if (ide.activeTabPath && ide.activeTabPath !== primaryBefore) call('activatePrimary', ide.activeTabPath);
    }

    function viewFor(id) {
      let view = views.get(id);
      if (view) return view;
      const doc = getDom().ideWorkbench?.ownerDocument || globalThis.document;
      view = viewUtils.createIdeEditorGroupView({
        groupId: id,
        groupNumber: groupNumber(id),
        document: doc,
        editorHost,
        escapeHtml: d.escapeHtml,
        jt,
        getTabs: () => groups.tabsIn(getIde(), id),
        getActive: () => groups.getGroupActive(getIde(), id),
        getDirty: (path) => getIde().dirtyByPath?.[path] === true,
        getStale: (path) => getIde().staleByPath?.[path] === true,
        renderReviewBar: (el, path) => call('renderReviewBar', el, path),
        onActivate: (path) => activateInGroup(path),
        onClose: (path) => closeInGroup(path),
        onSave: (path) => { if (path) call('saveFile', path); },
        onFocus: (groupId) => { focused = groupId; call('onActivated', groups.getGroupActive(getIde(), groupId)); },
        onContextMenu: (path, anchor) => openGroupTabMenu(id, path, anchor),
        onOverflow: (anchorEl) => openAllTabsMenu(id, anchorEl),
        onDropTab: (payload, index) => moveToGroup(payload.path, id, index),
        getBoundText: () => call('getBoundText', id) || '',
        onCloseGroup: () => closeGroup(id),
      });
      views.set(id, view);
      return view;
    }

    // Loads a grouped tab's document in the background (no primary activation); one
    // load per path, shared by every caller. Resolves whether the document is there.
    function loadDocument(path) {
      if (editorHost?.hasDocument?.(path)) return Promise.resolve(true);
      if (path.startsWith('diff://')) { moveToGroup(path, ''); return Promise.resolve(false); }
      if (loading.has(path)) return loading.get(path);
      const load = Promise.resolve(call('loadDocument', path)).catch(() => false).then(() => {
        loading.delete(path);
        if (disposed) return false;
        // A restored tab that turned out not to be text rejoins the primary group.
        if (editorHost?.hasDocument?.(path) && !canHold(path)) moveToGroup(path, '');
        else renderViews();
        return editorHost?.hasDocument?.(path) === true;
      });
      loading.set(path, load);
      return load;
    }

    function ensureDocuments() {
      const ide = getIde();
      for (const id of groups.usedGroups(ide)) {
        const path = groups.getGroupActive(ide, id);
        if (path) loadDocument(path);
      }
    }

    // Before the workbench renders: stacks, views and documents match the tabs.
    function reconcile() {
      if (disposed || !groups || !viewUtils) return;
      reconcileLayout();
      const used = liveGroups();
      let refocus = false;
      for (const [id, view] of views) {
        if (used.includes(id)) continue;
        const doc = view.el?.ownerDocument;
        refocus = refocus || Boolean(doc && view.el.contains(doc.activeElement));
        view.dispose();
        views.delete(id);
        if (focused === id) focused = '';
      }
      used.forEach(viewFor);
      ensureDocuments();
      // Its last tab closed by keyboard: focus must not fall to <body>.
      if (refocus) editorHost?.focus?.();
    }

    // A tab strip render after a close or move: when the used groups no longer match the
    // views (a group lost its last tab), the full render reconciles stacks and views.
    function renderViews() {
      if (disposed || !groups || !viewUtils) return;
      const used = liveGroups();
      if (used.length !== views.size || used.some((id) => !views.has(id))) {
        requestRender();
        return;
      }
      for (const view of views.values()) view.render();
    }

    function getElement(id) {
      return views.get(id)?.el || null;
    }

    // ---- Intents ----

    function activateInGroup(path) {
      const ide = getIde();
      const id = groups.groupOf(ide, path);
      if (!id) return false;
      groups.setGroupActive(ide, id, path);
      focused = id;
      call('onActivated', path);
      ensureDocuments();
      views.get(id)?.render();
      return true;
    }

    // An open of a file that sits in a group: shows it there once its document is
    // loaded, so a following editorHost.revealPosition reaches the group's editor.
    // null when the file is not in a secondary group.
    function openInGroup(path) {
      if (!activateInGroup(path)) return null;
      return loadDocument(path).then((ok) => {
        if (!disposed) views.get(groups.groupOf(getIde(), path))?.render();
        return ok;
      });
    }

    // A new file opened while a secondary group has focus moves there once open (W7);
    // a file already open stays where it is. `group` (a bound chat's, W7c) overrides
    // focus: '' keeps the open in the primary group. The open passes through the primary
    // group, which then shows the tab it showed before (not the moved tab's neighbour).
    function openFollowingFocus(path, open, group) {
      const want = group === undefined ? focused : group;
      const target = views.has(want) ? want : '';
      const had = new Set((getIde().openTabs || []).map((tab) => tab.path));
      const before = getIde().activeTabPath || '';
      return Promise.resolve(open()).then((ok) => {
        const opened = getIde().activeTabPath || '';
        if (!ok || !target || !opened || had.has(opened) || disposed || !views.has(target)) return ok;
        if (!moveToGroup(opened, target)) return ok;
        const ide = getIde();
        const keep = before && before !== opened && ide.activeTabPath !== before
          && (ide.openTabs || []).some((tab) => tab.path === before) && groups.groupOf(ide, before) === '';
        if (keep) call('activatePrimary', before);
        return ok;
      });
    }

    // The view state a tab carries out of its group (live when it is showing).
    function captureViewState(path, from) {
      if (from) return views.get(from)?.getViewState(path) || null;
      return editorHost?.getViewState?.(path) || null;
    }

    // Moves a file tab to group `to` ('' = primary) at `index`; returns whether it moved.
    function moveToGroup(path, to, index, layoutAfter) {
      const ide = getIde();
      const from = groups.groupOf(ide, path);
      if (to !== '' && !canHold(path)) return false;
      const state = captureViewState(path, from);
      const wasPrimaryActive = from === '' && ide.activeTabPath === path;
      const result = groups.moveTab(ide, path, to, Number.isInteger(index) ? index : undefined);
      if (!result.ok) return false;
      if (from) views.get(from)?.forget(path);
      if (state) editorHost?.applyViewState?.(path, state);
      if (layoutAfter) wiring()?.replaceLayout?.(layoutAfter);
      if (to === '') {
        call('activatePrimary', path);
      } else if (wasPrimaryActive) {
        if (ide.activeTabPath) call('activatePrimary', ide.activeTabPath);
        else editorHost?.showEmpty?.();
      }
      if (to) focused = to;
      schedulePersist();
      requestRender();
      if (to) views.get(to)?.focus();
      return true;
    }

    // Moves `path` into a new group beside its own group ('right' | 'down').
    function moveToNewGroup(path, dir) {
      const ide = getIde();
      const layout = layoutNow();
      const editors = ops?.listEditorGroups?.(layout) || [];
      const id = groups.freeGroupId(ide, editors);
      if (!layout || !id || !editors.length || !canHold(path)) return false;
      const from = groups.groupOf(ide, path);
      const next = ops.addEditorGroup(layout, from && editors.includes(from) ? from : editors[0], dir, null, id);
      if (next === layout) return false;
      return moveToGroup(path, id, undefined, next);
    }

    // Split Editor Right / Down: the focused group's active file moves to a new group.
    function splitActive(dir) {
      const path = groups.getGroupActive(getIde(), views.has(focused) ? focused : '');
      return path ? moveToNewGroup(path, dir) : false;
    }

    // Nothing changes until the close commits (a dirty prompt can cancel it). The live
    // view state goes to the document first so Reopen Closed Tab restores the cursor;
    // closing the document detaches it from the group's editor.
    function closeInGroup(path) {
      const ide = getIde();
      const id = groups.groupOf(ide, path);
      const next = id && groups.getGroupActive(ide, id) === path ? groups.neighbourInGroup(ide, path) : '';
      const state = id ? views.get(id)?.getViewState(path) : null;
      if (state) editorHost?.applyViewState?.(path, state);
      return Promise.resolve(call('requestCloseTab', path)).then(() => {
        const now = getIde();
        if (disposed || !next || (now.openTabs || []).some((tab) => tab.path === path)) return;
        // The closed tab's right (else left) neighbour, not the group's first tab.
        if (groups.setGroupActive(now, id, next)) renderViews();
      });
    }

    // ---- Keys (the view keydown handler routes Ctrl+S / Ctrl+F4 / Ctrl+PageUp|Down here) ----

    function groupOfTarget(target) {
      const id = target?.closest?.('.ide-group[data-ide-group]')?.getAttribute('data-ide-group') || '';
      return views.has(id) ? id : '';
    }

    function saveActive(id) {
      const path = groups.getGroupActive(getIde(), id);
      if (path) call('saveFile', path);
    }

    function closeActive(id) {
      const path = groups.getGroupActive(getIde(), id);
      if (path) closeInGroup(path);
    }

    function cycle(id, step) {
      const tabs = groups.tabsIn(getIde(), id);
      if (tabs.length < 2) return;
      const at = tabs.findIndex((tab) => tab.path === groups.getGroupActive(getIde(), id));
      activateInGroup(tabs[(at + step + tabs.length) % tabs.length].path);
      views.get(id)?.focus();
    }

    function focusNextGroup() {
      const order = [''].concat(liveGroups());
      if (order.length < 2) return false;
      const next = order[(order.indexOf(focused) + 1) % order.length];
      focused = next;
      if (next) views.get(next)?.focus();
      else editorHost?.focus?.();
      return true;
    }

    // ---- Menus ----

    // Move to Group N / Move to New Group Right|Below for one file tab.
    function moveMenuItems(path) {
      const ide = getIde();
      const tab = (ide.openTabs || []).find((entry) => entry.path === path);
      if (!tab || !['file', 'diff'].includes(tab.kind) || !canHold(path)) return [];
      const from = groups.groupOf(ide, path);
      const items = [''].concat(liveGroups()).filter((id) => id !== from).map((id) => ({
        label: jt('ide.groups.moveTo', 'Move to {group}', { group: groupName(id) }),
        action: () => moveToGroup(path, id),
      }));
      if (groups.freeGroupId(ide, ops?.listEditorGroups?.(layoutNow()) || [])) {
        items.push(
          { label: jt('ide.groups.moveRight', 'Move to New Group Right'), action: () => moveToNewGroup(path, 'right') },
          { label: jt('ide.groups.moveDown', 'Move to New Group Below'), action: () => moveToNewGroup(path, 'down') },
        );
      }
      return items.length ? [{ separator: true }, ...items] : [];
    }

    // The strip's overflow control: every tab of the group, the active one marked.
    function openAllTabsMenu(id, anchorEl) {
      if (typeof contextMenu?.show !== 'function') return;
      const active = groups.getGroupActive(getIde(), id);
      contextMenu.show({
        rootEl: getDom().ideView || null,
        anchorEl,
        items: groups.tabsIn(getIde(), id).map((tab) => ({
          label: String(tab.path).split('/').pop() || tab.path,
          checked: tab.path === active,
          action: () => { activateInGroup(tab.path); views.get(id)?.focus(); },
        })),
      });
    }

    // Close Group: its tabs close, then the group stops being bound and goes. A dirty
    // prompt that keeps a tab open keeps the group and its bindings as they were.
    function closeGroup(id) {
      const orchestrator = call('getCloseOrchestrator');
      return Promise.resolve(groups.tabsIn(getIde(), id).length ? orchestrator?.requestCloseAll(id) : null).then(() => {
        if (disposed) return;
        if (!groups.tabsIn(getIde(), id).length) call('unbindGroup', id);
        requestRender();
      });
    }

    function openGroupTabMenu(id, path, anchor) {
      if (typeof contextMenu?.show !== 'function') return;
      const orchestrator = call('getCloseOrchestrator');
      const count = groups.tabsIn(getIde(), id).length;
      contextMenu.show({
        rootEl: getDom().ideView || null,
        ...anchor,
        items: [
          { label: jt('common.close', 'Close'), action: () => closeInGroup(path) },
          { label: jt('ide.tabs.closeOthers', 'Close Others'), action: () => orchestrator?.requestCloseOthers(path), disabled: count < 2 },
          { label: jt('ide.tabs.closeSaved', 'Close Saved'), action: () => orchestrator?.requestCloseSaved(id) },
          { label: jt('ide.tabs.closeAll', 'Close All'), action: () => orchestrator?.requestCloseAll(id) },
          { label: jt('ide.groups.closeGroup', 'Close Group'), action: () => closeGroup(id) },
          ...moveMenuItems(path),
          { separator: true },
          { label: jt('ide.tabs.revealInExplorer', 'Reveal in Explorer View'), action: () => call('revealInExplorer', path) },
        ],
      });
    }

    // ---- Focus + lifecycle ----

    const onPrimaryFocus = () => { focused = ''; };
    let boundMain = null;

    function bindEvents() {
      const main = getDom().ideMain || null;
      if (!main || main === boundMain) return;
      boundMain?.removeEventListener('focusin', onPrimaryFocus);
      main.addEventListener('focusin', onPrimaryFocus);
      boundMain = main;
    }

    // A root switch: the views (and their per-path view states) belong to the old root.
    function resetForRoot() {
      for (const view of views.values()) view.dispose();
      views.clear();
      loading.clear();
      focused = '';
    }

    function layoutEditors() {
      for (const view of views.values()) view.layout();
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      boundMain?.removeEventListener('focusin', onPrimaryFocus);
      boundMain = null;
      for (const view of views.values()) view.dispose();
      views.clear();
    }

    return {
      reconcile,
      renderViews,
      getElement,
      activateInGroup,
      moveToGroup,
      showPrimary: (path) => call('activatePrimary', path),
      moveToNewGroup,
      splitActive,
      closeInGroup,
      closeGroup,
      openInGroup,
      openFollowingFocus,
      groupOfTarget,
      saveActive,
      closeActive,
      cycle,
      focusNextGroup,
      moveMenuItems,
      groupOf: (path) => groups?.groupOf(getIde(), path) || '',
      getFocusedGroup: () => focused,
      bindEvents,
      resetForRoot,
      layoutEditors,
      dispose,
    };
  }

  return { createIdeEditorGroupsWiring };
});
