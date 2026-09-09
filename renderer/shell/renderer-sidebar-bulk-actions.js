/* View-scoped sidebar selection. The backend remains the deletion authority. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.rendererSidebarBulkActions = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  /* Feather icons (archive, trash-2, rotate-ccw), https://feathericons.com, MIT.
   * Copyright (c) 2013-2023 Cole Bemis
   * Permission is hereby granted, free of charge, to any person obtaining a copy
   * of this software and associated documentation files (the "Software"), to deal
   * in the Software without restriction, including without limitation the rights
   * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
   * copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions:
   * The above copyright notice and this permission notice shall be included in
   * all copies or substantial portions of the Software.
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
   * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
   * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
   * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
   * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
   * THE SOFTWARE.
   */
  const icon = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  const icons = {
    archive: icon('<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>'),
    delete: icon('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>'),
    restore: icon('<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>'),
  };

  function createSidebarBulkActions(deps) {
    const { state, windowRef, callbacks, scheduler } = deps;
    const doc = windowRef.document;
    const groups = doc.getElementById('conversationGroups');
    const search = doc.getElementById('conversationSearch');
    const button = deps.actionButton || windowRef.inventoryActionButton;
    const popover = deps.popover || windowRef.inventoryPopover;
    const entry = doc.getElementById('chatsSelectionEntry');
    const section = doc.getElementById('sidebarHistorySection');
    if (!groups || !button || !popover || !entry || !section) return null;
    const selected = new Set();
    let selecting = false;
    let busy = false;
    let confirmation = null;
    let disposed = false;
    let scopeKey = '';
    let batch = null;
    const toolbar = doc.createElement('div');
    toolbar.className = 'sidebar-bulk-actions';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', jt("sidebarBulkActions.chatSelectionActions", "Chat selection actions"));
    const status = doc.createElement('span');
    status.setAttribute('role', 'status');
    status.tabIndex = -1;
    status.className = 'sidebar-bulk-status';
    const summaryGroup = doc.createElement('div');
    summaryGroup.className = 'sidebar-bulk-summary';
    const actions = doc.createElement('div');
    actions.className = 'sidebar-bulk-buttons';
    const controls = {};
    const labels = { select: jt("sidebarBulkActions.select", "Select"), all: jt("sidebarBulkActions.selectAllShown", "Select all shown"), clear: jt('common.clear', 'Clear'), archive: jt("sidebarBulkActions.archiveSelected", "Archive selected"), delete: jt("sidebarBulkActions.deleteSelected", "Delete selected"), confirm: jt("sidebarBulkActions.confirmDelete", "Confirm delete"), cancel: jt("sidebarBulkActions.cancelDelete", "Cancel delete"), done: jt('common.done', 'Done') };
    function addControl(host, id, options = {}) {
      host.insertAdjacentHTML('beforeend', button({ id: 'sidebar-bulk-' + id, label: labels[id],
        ariaLabel: labels[id], title: labels[id], size: 'sm', variant: 'ghost',
        plain: true, className: 'sidebar-bulk-control sidebar-bulk-control--' + id, ...options }));
      controls[id] = host.lastElementChild;
      controls[id].addEventListener('click', () => act(id));
    }
    addControl(entry, 'select');
    addControl(summaryGroup, 'all', { trustedHtml: '<span class="session-row__selection" aria-hidden="true"></span>' });
    controls.all.setAttribute('role', 'checkbox');
    summaryGroup.append(status);
    addControl(actions, 'archive', { trustedHtml: icons.archive });
    addControl(actions, 'delete', { trustedHtml: icons.delete, ariaHaspopup: 'dialog' });
    addControl(actions, 'done');
    toolbar.append(summaryGroup, actions);
    toolbar.insertAdjacentHTML('beforeend', popover({ id: 'sidebar-bulk-confirm', domId: 'sidebarBulkConfirm',
      className: 'sidebar-bulk-confirm', labelledBy: 'sidebarBulkConfirmMessage' }));
    const dialog = toolbar.lastElementChild;
    const question = doc.createElement('p');
    question.id = 'sidebarBulkConfirmMessage';
    const confirmActions = doc.createElement('div');
    confirmActions.className = 'sidebar-bulk-confirm-actions';
    dialog.append(question, confirmActions);
    addControl(confirmActions, 'cancel');
    addControl(confirmActions, 'confirm', { plain: false, variant: 'danger', className: 'sidebar-bulk-confirm-submit' });
    controls.delete.setAttribute('aria-controls', dialog.id);
    controls.delete.setAttribute('aria-expanded', 'false');
    groups.before(toolbar);

    function rows() { return [...groups.querySelectorAll('.conversation-item[data-session-id]')]; }
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
    function paint(event) {
      if (disposed) return;
      const key = `${state.ui.sidebarArchivedView === true}|${search?.value || ''}`;
      if (key !== scopeKey) { selected.clear(); confirmation = null; scopeKey = key; }
      const mountedRows = rows();
      const visible = new Set(mountedRows.map((row) => row.dataset.sessionId));
      if (!busy && event?.type === 'sidebar-rendered') for (const id of selected) if (!visible.has(id)) selected.delete(id);
      toolbar.hidden = !selecting;
      controls.select.hidden = selecting;
      status.textContent = busy ? jt("ide.changes.working", "Working…") : jt("sidebarBulkActions.valueSelected", "{value1} selected", { value1: String(selected.size) });
      const checkedCount = mountedRows.filter((row) => selected.has(row.dataset.sessionId)).length;
      const allShown = visible.size > 0 && checkedCount === visible.size;
      controls.all.setAttribute('aria-checked', allShown ? 'true' : checkedCount ? 'mixed' : 'false');
      setLabel(controls.all, allShown ? labels.clear : labels.all);
      for (const [id, control] of Object.entries(controls)) {
        control.disabled = busy || (Boolean(confirmation) && !['confirm', 'cancel', 'delete'].includes(id))
          || (['archive', 'delete'].includes(id) && !selected.size) || (id === 'all' && !visible.size);
      }
      const archiveKind = state.ui.sidebarArchivedView ? 'restore' : 'archive';
      setLabel(controls.archive, archiveKind === 'restore' ? jt("sidebarBulkActions.restoreSelected", "Restore selected") : labels.archive);
      if (controls.archive.dataset.icon !== archiveKind) {
        controls.archive.dataset.icon = archiveKind;
        controls.archive.innerHTML = icons[archiveKind];
      }
      if (confirmation) question.textContent = jt("sidebarBulkActions.deleteValueChatsBusyChatsWillBeSkipped", "Delete {value1} chats? Busy chats will be skipped.", { value1: String(confirmation.length) });
      else {
        const restoreFocus = dialog.contains(doc.activeElement);
        popover.close(dialog);
        if (restoreFocus && !busy) focusSelection();
      }
      mountedRows.forEach((row) => paintRow(row));
      if (!busy && doc.activeElement === status) focusSelection();
    }
    function focusSelection() {
      (controls.all.disabled ? status : controls.all).focus({ preventScroll: true });
    }
    function setLabel(control, label) {
      control.setAttribute('aria-label', label);
      control.title = label;
      control.dataset.tooltip = label;
    }
    function paintRow(row) {
      const open = row.querySelector('[data-session-open]');
      const menu = row.querySelector('[data-session-action="menu"]');
      if (!open) return;
      row.classList.toggle('sidebar-bulk-selecting', selecting);
      row.classList.toggle('sidebar-bulk-selected', selecting && selected.has(row.dataset.sessionId));
      if (menu) {
        menu.hidden = selecting;
        menu.tabIndex = selecting ? -1 : open.tabIndex;
      }
      if (selecting) {
        if (!Object.prototype.hasOwnProperty.call(open.dataset, 'bulkOriginalLabel')) open.dataset.bulkOriginalLabel = open.getAttribute('aria-label') || '';
        open.setAttribute('role', 'checkbox');
        open.setAttribute('aria-checked', String(selected.has(row.dataset.sessionId)));
        open.setAttribute('aria-disabled', String(busy || Boolean(confirmation)));
        open.setAttribute('aria-label', jt('sidebarBulkActions.selectChat', 'Select {title}', { title: summary(row.dataset.sessionId)?.title || jt('sidebar.sessionActions.newChat', 'New Chat') }));
      } else {
        open.removeAttribute('role'); open.removeAttribute('aria-checked'); open.removeAttribute('aria-disabled');
        if (Object.prototype.hasOwnProperty.call(open.dataset, 'bulkOriginalLabel')) {
          open.setAttribute('aria-label', open.dataset.bulkOriginalLabel);
          delete open.dataset.bulkOriginalLabel;
        }
      }
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
      busy = true; state.ui.sidebarBulkBusy = true; paint();
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
        busy = false; state.ui.sidebarBulkBusy = false;
        callbacks.renderSessions(); paint();
        if (!disposed) report(archivedAt ? 'archived' : 'restored', counts);
      }
    }
    function scheduleDelete(ids) {
      const candidates = ids.filter((id) => !isBusy(id));
      const stamps = new Map(candidates.map((id) => [id, stamp(summary(id))]));
      const counts = { ok: 0, skipped: ids.length - candidates.length, failed: 0 };
      confirmation = null;
      if (!candidates.length) { report('deleted', counts); paint(); return; }
      busy = true; state.ui.sidebarBulkBusy = true;
      batch = candidates;
      const release = () => {
        mark(candidates, false); batch = null;
        busy = false; state.ui.sidebarBulkBusy = false; paint();
      };
      const scheduled = scheduler.schedule(['sidebar-bulk'], {
        windowMs: deps.undoWindowMs ?? 6000,
        label: jt("sidebarBulkActions.deleteValueChats", "delete {value1} chats", { value1: String(candidates.length) }),
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
        onCommitError: (error) => { release(); callbacks.showSessionActionError(error, jt("sidebarBulkActions.bulkDeleteFailed", "Bulk Delete Failed")); },
        buildToast: ({ onUndo }) => ({ message: jt("sidebarBulkActions.valueChatsScheduledForDeletionValueSkipped", "{value1} chats scheduled for deletion. {value2} skipped.", { value1: String(candidates.length), value2: String(counts.skipped) }), options: { durationMs: deps.undoWindowMs ?? 6000, actions: [{ id: 'sidebar-bulk-undo', label: jt("ide.changes.undo", "Undo"), onClick: onUndo }] } }),
      });
      if (!scheduled) release();
    }
    function act(id) {
      if (busy || disposed) return;
      if (confirmation && !['confirm', 'cancel'].includes(id)) return;
      if (['archive', 'delete'].includes(id) && !selected.size) return;
      if (id === 'select') selecting = true;
      if (id === 'all') {
        const mountedRows = rows();
        if (mountedRows.every((row) => selected.has(row.dataset.sessionId))) selected.clear();
        else mountedRows.forEach((row) => selected.add(row.dataset.sessionId));
      }
      if (id === 'clear') selected.clear();
      if (id === 'done') { selecting = false; selected.clear(); }
      if (id === 'cancel') confirmation = null;
      if (id === 'delete') confirmation = [...selected];
      if (id === 'confirm' && confirmation) {
        try { scheduleDelete([...confirmation]); }
        catch (error) {
          if (batch) mark(batch, false);
          batch = null; busy = false; state.ui.sidebarBulkBusy = false;
          callbacks.showSessionActionError(error, jt("sidebarBulkActions.bulkDeleteFailed", "Bulk Delete Failed"));
        }
      }
      if (id === 'archive') void archive([...selected]);
      paint();
      if (id === 'select') focusSelection();
      if (id === 'done') controls.select.focus({ preventScroll: true });
      if (id === 'cancel') controls.delete.focus({ preventScroll: true });
      if (id === 'delete') popover.open(dialog, { trigger: controls.delete });
      if (busy) status.focus({ preventScroll: true });
      else if (id === 'confirm') focusSelection();
    }
    function intercept(event) {
      if (!selecting) return;
      const row = event.target.closest?.('.conversation-item[data-session-id]');
      if (!row || !groups.contains(row)) return;
      if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (busy || confirmation || event.type === 'contextmenu') return;
      const id = row.dataset.sessionId;
      if (selected.has(id)) selected.delete(id); else selected.add(id);
      paint();
    }
    function reset() { selected.clear(); confirmation = null; paint(); }
    function escape(event) {
      if (event.key !== 'Escape' || !selecting || busy) return;
      event.preventDefault(); event.stopImmediatePropagation();
      act(confirmation ? 'cancel' : 'done');
    }
    function dismissOutside(event) {
      if (!confirmation || dialog.contains(event.target) || controls.delete.contains(event.target)) return;
      confirmation = null;
      paint();
      // Dismissing against a row must not also select or open that row.
      if (groups.contains(event.target)) {
        event.preventDefault(); event.stopImmediatePropagation();
        controls.delete.focus({ preventScroll: true });
      }
    }
    function syncPopover(event) {
      if (event.target !== dialog || event.detail?.open !== false || !confirmation) return;
      confirmation = null;
      paint();
    }
    groups.addEventListener('click', intercept, true);
    groups.addEventListener('keydown', intercept, true);
    groups.addEventListener('contextmenu', intercept, true);
    groups.addEventListener('sidebar-rendered', paint);
    search?.addEventListener('input', reset);
    section.addEventListener('keydown', escape, true);
    doc.addEventListener('click', dismissOutside, true);
    dialog.addEventListener('inv-popover-toggle', syncPopover);
    callbacks.registerCleanup(() => {
      disposed = true;
      if (batch) mark(batch, false);
      state.ui.sidebarBulkBusy = false;
      groups.removeEventListener('click', intercept, true);
      groups.removeEventListener('keydown', intercept, true);
      groups.removeEventListener('contextmenu', intercept, true);
      groups.removeEventListener('sidebar-rendered', paint);
      search?.removeEventListener('input', reset);
      section.removeEventListener('keydown', escape, true);
      doc.removeEventListener('click', dismissOutside, true);
      dialog.removeEventListener('inv-popover-toggle', syncPopover);
      selecting = false;
      rows().forEach(paintRow);
      popover.close(dialog);
      controls.select.remove();
      toolbar.remove();
    });
    paint();
    return { paint, act, selected };
  }
  return { createSidebarBulkActions };
});
