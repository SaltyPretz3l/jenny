/* renderer/features/renderer-ide-group-binding.js - a chat or terminal view bound
 * to an editor group (row 40 W7c).
 *
 * The binding lives on the layout tree (`layout.bind`, see workbench-layout-model)
 * and follows the view, not its stack. Files and diffs a bound chat opens land in its
 * group; Run, Debug and New Terminal started while a group has focus use the
 * terminal bound to that group. A bound group stays open while empty. Group ids
 * here are the editor-groups vocabulary: '' = the primary group, editor-2..4. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererIdeGroupBinding = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const fallbackJt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback
    || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, (m, n) => (Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m)) : d; };

  // Changes is not bound on its own: it follows its chat.
  const CHAT_OF = { changes: 'chat', 'changes-2': 'chat-2' };

  /**
   * @param {object} deps
   * @param {() => object|null} deps.getWorkbenchWiring getLayout / commitLayout / views
   * @param {() => object|null} deps.getEditorGroups getFocusedGroup
   * @param {() => object} deps.getIde
   * @param {object} deps.model workbench-layout-model
   * @param {object} deps.ops workbench-layout-ops
   * @param {object} deps.groupsUtils renderer-ide-editor-groups
   * @param {(viewId: string) => boolean} deps.showPanel
   * @param {(viewId: string) => string} [deps.viewLabel]
   */
  function createIdeGroupBinding(deps) {
    const d = deps || {};
    const jt = typeof d.jt === 'function' ? d.jt : fallbackJt;
    const { model, ops, groupsUtils } = d;
    const wiring = () => d.getWorkbenchWiring?.() || null;
    const layoutNow = () => wiring()?.getLayout?.() || null;
    const editorsOf = (layout) => ops.listEditorGroups(layout);
    const keyOf = (viewId) => CHAT_OF[viewId] || viewId;
    const label = (viewId) => (typeof d.viewLabel === 'function' && d.viewLabel(viewId)) || viewId;

    function commit(next) {
      if (next && next !== layoutNow()) wiring()?.commitLayout?.(next);
    }

    // Layout stack id -> group id ('' primary); null when it is no editor stack.
    function groupOfStack(layout, stackId) {
      const editors = editorsOf(layout);
      if (!stackId || !editors.includes(stackId)) return null;
      return stackId === editors[0] ? '' : stackId;
    }

    function stackOfGroup(layout, groupId) {
      const editors = editorsOf(layout);
      if (!groupId) return editors[0] || '';
      return editors.includes(groupId) ? groupId : '';
    }

    // The group a view's opens go to, or undefined when it is not bound.
    function targetOf(viewId) {
      const layout = layoutNow();
      const group = layout ? groupOfStack(layout, ops.bindingOf(layout, viewId)) : null;
      return group === null ? undefined : group;
    }

    // Pane 0 is the Workspace's Chat, pane 1 its Chat 2.
    function chatTarget(pane) {
      return targetOf(Number(pane) === 1 ? 'chat-2' : 'chat');
    }

    // Diff `id` a bound chat opens (Changes, the transcript's diff row, a suggestion) moves into
    // that chat's group once open, and the primary group shows the tab it showed before; a diff
    // tab that was already open stays where it is. The group is the one bound when the open
    // started, and only if it is still bound when the open lands.
    function openDiffFrom(pane, open, id) {
      const group = pane === 0 || pane === 1 ? chatTarget(pane) : undefined;
      const isOpen = (ide, path) => (ide.openTabs || []).some((tab) => tab.path === path);
      const had = isOpen(d.getIde(), id);
      const before = String(d.getIde().activeTabPath || '');
      return Promise.resolve(open()).then((ok) => {
        const ide = d.getIde();
        const groups = d.getEditorGroups?.();
        if (ok !== true || !group || !id || had || !isOpen(ide, id) || groupsUtils.groupOf(ide, id) !== '' || chatTarget(pane) !== group) return ok;
        const wasActive = ide.activeTabPath === id;
        if (!groups?.moveToGroup?.(id, group)) return ok;
        const stillPrimary = isOpen(ide, before) && groupsUtils.groupOf(ide, before) === '';
        if (wasActive && before && before !== id && ide.activeTabPath !== before && stillPrimary) groups.showPrimary?.(before);
        return ok;
      });
    }

    // The terminal bound to the focused group (lowest slot first), else ''.
    function boundTerminal() {
      const layout = layoutNow();
      if (!layout) return '';
      const stackId = stackOfGroup(layout, d.getEditorGroups?.()?.getFocusedGroup?.() || '');
      const bound = model.listViews(layout).filter((id) => model.terminalSlot(id) > 0 && ops.bindingOf(layout, id) === stackId);
      bound.sort((a, b) => model.terminalSlot(a) - model.terminalSlot(b));
      return bound[0] || '';
    }

    // A task tab (Run, Test output) joins the stack of terminal `near`, then shows.
    function revealTask(viewId, near) {
      const layout = layoutNow();
      const at = near && layout ? model.findView(layout, near) : null;
      const own = at ? model.findView(layout, viewId) : null;
      if (!own) return false;
      if (own.stackId !== at.stackId) commit(ops.moveView(layout, viewId, { stackId: at.stackId }));
      return d.showPanel?.(viewId) === true;
    }

    // Secondary groups some view is bound to (they stay open while empty).
    function boundGroups() {
      const layout = layoutNow();
      if (!layout) return [];
      return ops.boundGroups(layout).map((stackId) => groupOfStack(layout, stackId)).filter(Boolean);
    }

    // The empty-state line of a bound group.
    function boundText(groupId) {
      const layout = layoutNow();
      const stackId = layout ? stackOfGroup(layout, groupId) : '';
      if (!stackId) return '';
      const views = model.listViews(layout).filter((id) => model.isBindableView(id) && ops.bindingOf(layout, id) === stackId);
      const chats = views.filter((id) => model.terminalSlot(id) === 0).map(label);
      const terminals = views.filter((id) => model.terminalSlot(id) > 0).map(label);
      if (chats.length) return jt('ide.groups.boundChat', 'Files Jenny opens from {names} land here.', { names: chats.join(', ') });
      return terminals.length ? jt('ide.groups.boundTerminal', 'Runs started here use {names}.', { names: terminals.join(', ') }) : '';
    }

    function unbindGroup(groupId) {
      const layout = layoutNow();
      const stackId = layout ? stackOfGroup(layout, groupId) : '';
      if (stackId) commit(ops.unbindGroup(layout, stackId));
    }

    function bindNew(key) {
      const layout = layoutNow();
      const editors = editorsOf(layout);
      const id = groupsUtils.freeGroupId(d.getIde(), editors);
      const next = id ? ops.addEditorGroup(layout, editors[editors.length - 1], 'right', null, id) : layout;
      if (next !== layout) commit(ops.setBinding(next, key, id));
    }

    // A group's own number, as its strip and Move to rows show it (the primary is 1, editor-N is N).
    const numberOf = (editors, stackId) => (stackId === editors[0] ? 1 : Number(stackId.slice(7)) || 0);

    // The stack menu's binding rows for `viewId` (radio rows, after a separator), in group-number order.
    function menuItems(viewId) {
      const layout = layoutNow();
      const key = keyOf(viewId);
      if (!layout || !model.isBindableView(key) || !model.findView(layout, key)) return [];
      const current = ops.bindingOf(layout, key);
      const editors = editorsOf(layout);
      const set = (stackId) => () => commit(ops.setBinding(layoutNow(), key, stackId));
      const items = [{ separator: true }];
      editors.slice().sort((a, b) => numberOf(editors, a) - numberOf(editors, b)).forEach((stackId) => {
        items.push({ label: jt('ide.groups.bindTo', 'Bind to Editor Group {n}', { n: numberOf(editors, stackId) }), checked: current === stackId, action: set(stackId) });
      });
      items.push({ label: jt('ide.groups.unbound', 'Not bound to a group'), checked: !current, action: set('') });
      if (editors.length < model.MAX_EDITOR_GROUPS && groupsUtils.freeGroupId(d.getIde(), editors)) {
        items.push({ label: jt('ide.groups.bindNew', 'Bind to New Editor Group'), checked: false, action: () => bindNew(key) });
      }
      return items;
    }

    return { chatTarget, openDiffFrom, boundTerminal, revealTask, boundGroups, boundText, unbindGroup, menuItems };
  }

  return { createIdeGroupBinding };
});
