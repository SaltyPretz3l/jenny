/* Modeless sidebar selection: Ctrl/Shift click and keys pick chats, menus act on them. The backend remains the deletion authority. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.rendererSidebarBulkActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const jtn = (globalThis.jennyI18n && globalThis.jennyI18n.tn) || function (k, count, params, one, other) { return jt.call(null, k, count === 1 ? one : other, params); };
  const ROW = '.conversation-item[data-session-id]';
  const RANGE_KEYS = ['ArrowUp', 'ArrowDown', 'Home', 'End'];

  function createSidebarBulkActions(deps) {
    const { state, windowRef, callbacks, scheduler } = deps;
    const doc = windowRef.document;
    const groups = doc.getElementById('conversationGroups');
    const search = doc.getElementById('conversationSearch');
    const contextMenu = deps.contextMenu || windowRef.inventoryContextMenu;
    if (!groups || !doc.getElementById('sidebarHistorySection') || !contextMenu) return null;
    const selected = new Set();
    let anchorId = '';
    let lit = false; // some mounted row was painted selected at the last paint
    let busy = false;
    function setBusy(value) { busy = value; state.ui.sidebarBulkBusy = value; }
    const windowMs = deps.undoWindowMs ?? 6000;
    let disposed = false;
    let scopeKey = '';
    let batch = null;
    const status = doc.createElement('span');
    status.setAttribute('role', 'status');
    status.className = 'sidebar-bulk-status sr-only';
    groups.before(status);

    // The primary "Jenny" chat (row 69) is never selectable: no move, archive or delete.
    function rows() { return [...groups.querySelectorAll(`${ROW}:not([data-session-role="primary"])`)]; }
    function rowFor(id) { return rows().find((row) => row.dataset.sessionId === id) || null; }
    function openOf(row) { return row.querySelector('[data-session-open]'); }
    function summary(id) { return state.sessions.find((item) => item.id === id); }
    function stamp(item) { return `${item?.updated_at || ''}|${item?.message_count || 0}`; }
    function pendingIds() { return state.ui.pendingSessionDeletes || []; }
    function isBusy(id) {
      const item = summary(id);
      const streams = windowRef.rendererMultiStreamController;
      return !item || Boolean(state.ui.sidebarMetaPending?.has(id)) || Boolean(item.plugin_session) || item.session_type === 'plugin'
        || Boolean(streams?.getPreflight?.(id))
        || Boolean(streams?.getActiveStreamIdForCancel?.(id))
        || Boolean(state.sendOutboxBySession?.get?.(id)?.length)
        || (state.sendPreflight?.sessionId === id) || (state.sendPreflight?.optimisticSessionId === id)
        || pendingIds().includes(id);
    }
    function rangeIds(fromId, toId) {
      const ids = rows().map((row) => row.dataset.sessionId);
      const from = ids.indexOf(fromId);
      const to = ids.indexOf(toId);
      return from < 0 || to < 0 ? [] : ids.slice(Math.min(from, to), Math.max(from, to) + 1);
    }

    // Last painted selected state per open button: the panel rebuilds a row's innerHTML (a new
    // button), so the memo keys on the button and a rebuilt selected row is painted again.
    const painted = new WeakMap();
    function paintRow(row) {
      const open = openOf(row);
      if (!open) return;
      const on = selected.has(row.dataset.sessionId);
      if ((painted.get(open) === true) === on) return;
      painted.set(open, on);
      row.classList.toggle('sidebar-bulk-selected', on);
      if (on) {
        if (!Object.prototype.hasOwnProperty.call(open.dataset, 'bulkOriginalLabel')) open.dataset.bulkOriginalLabel = open.getAttribute('aria-label') || '';
        open.setAttribute('aria-label', jt('sidebarBulkActions.selectedChatLabel', '{label}, selected', { label: open.dataset.bulkOriginalLabel }));
      } else if (Object.prototype.hasOwnProperty.call(open.dataset, 'bulkOriginalLabel')) {
        open.setAttribute('aria-label', open.dataset.bulkOriginalLabel);
        delete open.dataset.bulkOriginalLabel;
      }
    }
    function paint(event) {
      if (disposed) return;
      const key = `${Boolean(state.ui.sidebarArchivedView)}|${search?.value || ''}`;
      if (key !== scopeKey) { selected.clear(); anchorId = ''; scopeKey = key; }
      // Nothing selected now or at the last paint: no row can need a change (the common render).
      if (selected.size || lit) {
        const mounted = rows();
        if (!busy && selected.size && event?.type === 'sidebar-rendered') {
          const visible = new Set(mounted.map((row) => row.dataset.sessionId));
          for (const id of selected) if (!visible.has(id)) selected.delete(id);
        }
        mounted.forEach(paintRow);
        lit = selected.size > 0;
      }
      const n = selected.size;
      const text = busy ? jt('ide.changes.working', 'Working…')
        : n ? jtn('sidebarBulkActions.selectedCount', n, { count: n }, '{count} chat selected', '{count} chats selected') : '';
      // A live region re-announces on every write; renders during streaming must not repeat it.
      if (status.textContent !== text) status.textContent = text;
    }
    function clear() { selected.clear(); paint(); }
    function setSelection(ids, additive) {
      if (!additive) selected.clear();
      ids.forEach((id) => selected.add(id));
      paint();
    }
    function toggle(id) {
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      anchorId = id;
      paint();
    }
    function focusRow(row) {
      openOf(row)?.focus({ preventScroll: true });
      callbacks.setRovingChatSession?.(row.dataset.sessionId);
    }

    function mark(ids, pending) {
      const set = new Set(pendingIds());
      ids.forEach((id) => pending ? set.add(id) : set.delete(id));
      state.ui.pendingSessionDeletes = [...set];
      callbacks.renderSessions();
    }
    function report(action, counts) {
      const params = { count: counts.ok, skipped: counts.skipped, failed: counts.failed };
      const message = action === 'archived'
        ? jt('sidebarBulkActions.archivedResult', '{count} archived; {skipped} skipped; {failed} failed.', params)
        : action === 'restored'
          ? jt('sidebarBulkActions.restoredResult', '{count} restored; {skipped} skipped; {failed} failed.', params)
          : jt('sidebarBulkActions.deletedResult', '{count} deleted; {skipped} skipped; {failed} failed.', params);
      callbacks.showToastMessage(message, { tone: counts.failed ? 'warning' : 'info' });
    }
    async function archive(ids) {
      const counts = { ok: 0, skipped: 0, failed: 0 };
      const archivedAt = state.ui.sidebarArchivedView ? null : new Date().toISOString();
      setBusy(true); paint();
      try {
        for (const id of ids) {
          if (disposed) break;
          if (!summary(id) || state.ui.sidebarMetaPending?.has(id) || pendingIds().includes(id)) { counts.skipped++; continue; }
          try {
            const updated = await windowRef.jennyShell.sessions.setMeta(id, { archived_at: archivedAt });
            if (updated?.id !== id || (updated.archived_at || null) !== archivedAt) throw new Error('Archive acknowledgement mismatch.');
            const item = summary(id);
            if (item) item.archived_at = archivedAt;
            selected.delete(id); counts.ok++;
          } catch (_) { counts.failed++; }
        }
      } finally {
        setBusy(false);
        callbacks.renderSessions(); paint();
        if (!disposed) report(archivedAt ? 'archived' : 'restored', counts);
      }
    }
    // The switcher skips busy chats and names them in its toast (with Undo);
    // moved chats leave the selection, like archived ones.
    async function openMove(ids, trigger) {
      let switcher;
      try { switcher = await callbacks.getProjectSwitcher(); } catch (_) { switcher = null; }
      if (disposed || !switcher || typeof switcher.openMoveMenu !== 'function') return;
      const anchorEl = trigger && trigger.isConnected !== false ? trigger
        : ids.map(rowFor).find(Boolean)?.querySelector('[data-session-action="menu"]') || null;
      await switcher.openMoveMenu(anchorEl, ids, {
        source: 'bulk',
        onMoved: (result) => {
          const moved = Array.isArray(result?.moved) ? result.moved : ids;
          moved.forEach((id) => selected.delete(id));
          paint();
        },
      });
    }
    function scheduleDelete(ids) {
      const candidates = ids.filter((id) => !isBusy(id));
      const stamps = new Map(candidates.map((id) => [id, stamp(summary(id))]));
      const counts = { ok: 0, skipped: ids.length - candidates.length, failed: 0 };
      if (!candidates.length) { report('deleted', counts); paint(); return; }
      setBusy(true);
      batch = candidates;
      const release = () => {
        mark(candidates, false); batch = null;
        setBusy(false); paint();
      };
      const scheduled = scheduler.schedule(['sidebar-bulk'], {
        windowMs: windowMs,
        label: jt('sidebarBulkActions.deleteValueChats', 'delete {value1} chats', { value1: String(candidates.length) }),
        markPending: () => { mark(candidates, true); paint(); },
        onUndo: release,
        onDisposeCleanup: release,
        commit: async () => {
          // Pending-delete membership is our own marker, not busy activity.
          try {
            for (const id of candidates) {
              if (disposed) break;
              mark([id], false);
              if (isBusy(id) || stamp(summary(id)) !== stamps.get(id)) { counts.skipped++; continue; }
              mark([id], true);
              try {
                const result = await callbacks.hardDeleteSession(id, { onlyIfIdle: true, expectedUpdatedAt: summary(id).updated_at });
                if (result?.deleted === true) { counts.ok++; selected.delete(id); }
                else counts.skipped++;
              } catch (_) { counts.failed++; }
            }
          } finally { release(); if (!disposed) report('deleted', counts); }
        },
        onCommitError: (error) => { release(); callbacks.showSessionActionError(error, jt('sidebarBulkActions.bulkDeleteFailed', 'Bulk Delete Failed')); },
        buildToast: ({ onUndo }) => ({ message: jt('sidebarBulkActions.valueChatsScheduledForDeletionValueSkipped', '{value1} chats scheduled for deletion. {value2} skipped.', { value1: String(candidates.length), value2: String(counts.skipped) }), options: { durationMs: windowMs, actions: [{ id: 'sidebar-bulk-undo', label: jt('ide.changes.undo', 'Undo'), onClick: onUndo }] } }),
      });
      if (!scheduled) release();
    }
    function confirmDelete(ids) {
      try { scheduleDelete(ids); }
      catch (error) {
        if (batch) mark(batch, false);
        batch = null; setBusy(false); paint();
        callbacks.showSessionActionError(error, jt('sidebarBulkActions.bulkDeleteFailed', 'Bulk Delete Failed'));
      }
    }

    function show(anchor, heading, items) {
      contextMenu.show({
        rootEl: doc.body, anchorX: anchor.anchorX, anchorY: anchor.anchorY, restoreFocusTo: anchor.trigger, heading, items,
        onActionError: (error) => callbacks.showSessionActionError?.(error, jt('sidebar.sessionActions.actionFailed', 'Session Action Failed')),
      });
    }
    function openDeleteConfirm(ids, anchor) {
      if (busy || disposed || !ids.length) return;
      const n = ids.length;
      show(anchor, jtn('sidebarBulkActions.deleteConfirm', n, { count: n }, 'Delete {count} chat? Busy chats will be skipped.', 'Delete {count} chats? Busy chats will be skipped.'), [
        // Cancel first: the menu focuses its first item, so Delete then Enter commits nothing.
        { label: jt('common.cancel', 'Cancel'), action: () => {} },
        { label: jtn('sidebarBulkActions.deleteConfirmAction', n, { count: n }, 'Delete {count} chat', 'Delete {count} chats'), danger: true, action: () => confirmDelete(ids) },
      ]);
    }
    function openBulkMenu(anchor) {
      if (busy || disposed || !selected.size) return;
      const ids = [...selected];
      const n = ids.length;
      const params = { count: n };
      const items = [];
      if (typeof callbacks.getProjectSwitcher === 'function') {
        items.push({ label: jtn('sidebarBulkActions.moveChats', n, params, 'Move {count} chat to project…', 'Move {count} chats to project…'), action: () => openMove(ids, anchor.trigger) });
      }
      items.push({ label: state.ui.sidebarArchivedView
        ? jtn('sidebarBulkActions.restoreChats', n, params, 'Restore {count} chat', 'Restore {count} chats')
        : jtn('sidebarBulkActions.archiveChats', n, params, 'Archive {count} chat', 'Archive {count} chats'), action: () => archive(ids) });
      items.push({ separator: true },
        { label: jtn('sidebarBulkActions.deleteChats', n, params, 'Delete {count} chat…', 'Delete {count} chats…'), danger: true, action: () => openDeleteConfirm(ids, anchor) },
        { separator: true },
        { label: jt('sidebarBulkActions.clearSelection', 'Clear selection'), action: clear });
      show(anchor, jtn('sidebarBulkActions.selectedCount', n, params, '{count} chat selected', '{count} chats selected'), items);
    }
    // A menu gesture on a selected row (with two or more selected) replaces the single-chat menu;
    // on a row outside the selection it clears the selection and lets that menu open.
    // `anchor` is a function so the layout read happens only when the bulk menu really opens.
    function routeMenu(event, row, anchor) {
      if (!selected.has(row.dataset.sessionId)) { if (selected.size && !busy) clear(); return; }
      if (selected.size < 2) return;
      event.preventDefault(); event.stopImmediatePropagation();
      openBulkMenu(anchor());
    }
    function rowAnchor(row, trigger) {
      const rect = row.getBoundingClientRect();
      return { anchorX: rect.left + 24, anchorY: rect.bottom, trigger };
    }

    // The inline rename editor mounts inside the open button; its clicks and keys stay its own.
    function rowOfOpen(target) {
      if (target.closest?.('[data-session-action], [data-session-toggle], input, textarea, [contenteditable]')) return null;
      const row = target.closest?.('[data-session-open]')?.closest(ROW);
      return row && groups.contains(row) ? row : null;
    }
    function swallow(event) { event.preventDefault(); event.stopImmediatePropagation(); }
    function onMouseDown(event) {
      if (event.button === 0 && event.shiftKey && rowOfOpen(event.target)) event.preventDefault();
    }
    function onClick(event) {
      const menuButton = event.target.closest?.('[data-session-action="menu"]');
      if (menuButton) {
        const row = menuButton.closest(ROW);
        if (row && groups.contains(row)) {
          routeMenu(event, row, () => {
            const rect = menuButton.getBoundingClientRect();
            return { anchorX: rect.left, anchorY: rect.bottom + 4, trigger: menuButton };
          });
        }
        return;
      }
      const row = rowOfOpen(event.target);
      if (!row) return;
      const id = row.dataset.sessionId;
      const additive = event.ctrlKey || event.metaKey;
      if (!additive && !event.shiftKey) {
        if (selected.size) clear();
        if (row.dataset.sessionRole !== 'primary') anchorId = id;
        return;
      }
      swallow(event);
      // The primary chat is never selected; a modified click on it neither opens it nor drops the selection.
      if (row.dataset.sessionRole === 'primary') return;
      if (busy) return;
      if (event.shiftKey) {
        let start = id;
        if (anchorId && rowFor(anchorId)) start = anchorId;
        else if (state.currentSessionId && rowFor(state.currentSessionId)) start = state.currentSessionId;
        anchorId = start;
        setSelection(rangeIds(start, id), additive);
      } else toggle(id);
      focusRow(row);
    }
    function onContextMenu(event) {
      const row = event.target.closest?.(ROW);
      if (!row || !groups.contains(row) || event.target.closest('input, textarea, [contenteditable]')) return;
      const trigger = event.target.closest('button') || openOf(row);
      routeMenu(event, row, () => (event.clientX || event.clientY
        ? { anchorX: event.clientX, anchorY: event.clientY, trigger }
        : rowAnchor(row, trigger)));
    }
    function onKeydown(event) {
      const open = event.target.closest?.('[data-session-open]');
      const row = open?.closest(ROW);
      if (!row || !groups.contains(row) || event.target !== open) return;
      const id = row.dataset.sessionId;
      const { key } = event;
      const additive = event.ctrlKey || event.metaKey;
      if (key === 'ContextMenu' || (event.shiftKey && key === 'F10')) { routeMenu(event, row, () => rowAnchor(row, open)); return; }
      if (key === 'Escape') { if (selected.size) { swallow(event); clear(); } return; }
      if (additive && key === ' ') {
        swallow(event);
        if (!busy && row.dataset.sessionRole !== 'primary') toggle(id);
        return;
      }
      if (additive && (key === 'a' || key === 'A')) {
        swallow(event);
        if (!busy) setSelection(rows().map((item) => item.dataset.sessionId), true);
        return;
      }
      if (key === 'Delete' && !additive && !event.shiftKey && !event.altKey) {
        // Only from a row in the selection, so the confirm is about what the user is looking at.
        if (!selected.has(id)) return;
        event.preventDefault();
        openDeleteConfirm([...selected], rowAnchor(row, open));
        return;
      }
      if (event.shiftKey && !additive && !event.altKey && RANGE_KEYS.includes(key) && !busy) extendRange(open, key);
    }
    // The shell's own keydown handler moves focus over this same button order (rows and project
    // headers) after this capture listener returns. A microtask would run before it, so the target
    // is computed here, synchronously, the way handleVerticalNavKey picks it. Focus is left to the shell.
    function extendRange(open, key) {
      const buttons = [...groups.querySelectorAll('[data-session-open], [data-project-toggle]')];
      const index = buttons.indexOf(open);
      if (index < 0) return;
      const last = buttons.length - 1;
      const next = key === 'Home' ? 0 : key === 'End' ? last
        : Math.max(0, Math.min(last, index + (key === 'ArrowDown' ? 1 : -1)));
      const landed = buttons[next].matches('[data-session-open]') ? buttons[next].closest(ROW) : null;
      if (!landed || landed.dataset.sessionRole === 'primary') return;
      const focusedId = open.closest(ROW).dataset.sessionId;
      // With nothing selected the range starts here, not at a row clicked long ago.
      if (!selected.size || !anchorId || !rowFor(anchorId)) {
        if (!rowFor(focusedId)) return;
        anchorId = focusedId;
      }
      setSelection(rangeIds(anchorId, landed.dataset.sessionId), false);
    }

    const listeners = [['mousedown', onMouseDown], ['click', onClick], ['contextmenu', onContextMenu], ['keydown', onKeydown]];
    listeners.forEach(([type, handler]) => groups.addEventListener(type, handler, true));
    groups.addEventListener('sidebar-rendered', paint);
    search?.addEventListener('input', clear);
    callbacks.registerCleanup(() => {
      disposed = true;
      if (batch) mark(batch, false);
      state.ui.sidebarBulkBusy = false;
      listeners.forEach(([type, handler]) => groups.removeEventListener(type, handler, true));
      groups.removeEventListener('sidebar-rendered', paint);
      search?.removeEventListener('input', clear);
      selected.clear();
      rows().forEach(paintRow);
      status.remove();
    });
    paint();
    return { paint, selected, clear };
  }
  return { createSidebarBulkActions };
});
