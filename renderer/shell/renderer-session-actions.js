/* renderer/shell/renderer-session-actions.js
 *
 * Session row actions for the chats panel (nav overhaul W7): the ⋯ /
 * right-click context menu (Pin / Rename / Archive / Delete), inline title
 * rename via the inventory inline-title-editor, pin/archive toggles over the
 * sessions:set-meta IPC, and optimistic session delete with an undo toast —
 * the real delete IPC is deferred for the undo window via the shared
 * destructive-undo scheduler, so the palette Undo group picks it up through
 * listPendingUndos().
 *
 * Pending deletes are tracked renderer-side on state.ui.pendingSessionDeletes
 * (array of session ids); renderSessions() filters those rows out and its
 * signature includes the list, so marking/unmarking rebuilds immediately.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSessionActionsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SESSION_DELETE_UNDO_MS_DEFAULT = 6000;

  function createSessionActionsController(deps) {
    const { state, windowRef } = deps;
    const { TOAST_SOURCE } = deps.constants;
    const undoWindowMs = Number.isFinite(deps.constants.SESSION_DELETE_UNDO_MS)
      ? deps.constants.SESSION_DELETE_UNDO_MS
      : SESSION_DELETE_UNDO_MS_DEFAULT;
    const {
      hardDeleteSession,
      renameSession,
      refreshSessions,
      renderSessions,
      renderAll,
      setActiveView,
      activateWorkspaceSession,
      showToastMessage,
      dismissToast,
      showSessionActionError,
      appendClientLog,
      registerCleanup,
      toggleChatsScope,
      stopSessionStream,
    } = deps.callbacks;

    const contextMenu = deps.inventory?.contextMenu || windowRef.inventoryContextMenu;
    const inlineTitleEditor = deps.inventory?.inlineTitleEditor || windowRef.inventoryInlineTitleEditor;
    const destructiveUndoUtils = deps.modules?.destructiveUndoUtils || windowRef.rendererDestructiveUndoUtils;

    const deleteUndoScheduler = destructiveUndoUtils.createDestructiveUndoScheduler({
      keyFn: (sessionId) => String(sessionId || ''),
      registerCleanup,
      showToastMessage,
      dismissToast,
    });

    function getSummary(sessionId) {
      return (Array.isArray(state.sessions) ? state.sessions : [])
        .find((session) => session?.id === sessionId) || null;
    }

    function patchSummary(sessionId, patch) {
      state.sessions = (Array.isArray(state.sessions) ? state.sessions : []).map((session) =>
        session?.id === sessionId ? { ...session, ...patch } : session
      );
    }

    function isOfflineLockdownEnabled() {
      return state.features?.featureFlags?.session_offline_lockdown === true;
    }

    async function toggleOfflineLockdown(sessionId) {
      const summary = getSummary(sessionId);
      if (!summary || !isOfflineLockdownEnabled()) return false;
      const nextLockdown = summary.lockdown !== true;
      const activeStreamId = nextLockdown
        ? String(windowRef.rendererMultiStreamController?.getActiveStreamIdForCancel?.(sessionId) || '').trim()
        : '';
      let turnStopped = false;
      if (activeStreamId) {
        // Same path as the Stop button: its outbox hold makes the cancelled
        // terminal restore a queued send instead of starting a replacement
        // turn before the lockdown preference is written. A refused stop
        // (stream already finished) still locks, but claims no stopped turn.
        const stopped = typeof stopSessionStream === 'function'
          ? await stopSessionStream(sessionId)
          : await windowRef.jennyShell.chat.cancelStream(activeStreamId);
        turnStopped = stopped !== null;
      }
      const persisted = await windowRef.jennyShell.sessions.setPreferences(sessionId, {
        lockdown: nextLockdown,
      });
      if (
        String(persisted?.id || '').trim() !== String(sessionId || '').trim()
        || persisted.lockdown !== nextLockdown
      ) {
        throw new Error('Offline lockdown persistence acknowledgement did not match the requested change.');
      }
      patchSummary(sessionId, { lockdown: nextLockdown });
      renderAll();
      if (turnStopped) showToastMessage('Turn stopped: session locked.');
      appendClientLog('INFO', 'sessions.offline_lockdown_updated', {
        sessionId,
        lockdown: nextLockdown,
      });
      return true;
    }

    function clipTitle(value) {
      const normalized = String(value || 'New Chat').replace(/\s+/g, ' ').trim() || 'New Chat';
      return normalized.length <= 40 ? normalized : `${normalized.slice(0, 37).trim()}...`;
    }

    function getPendingDeleteIds() {
      return Array.isArray(state.ui.pendingSessionDeletes) ? state.ui.pendingSessionDeletes : [];
    }

    function isSessionPendingDelete(sessionId) {
      return getPendingDeleteIds().includes(sessionId);
    }

    function markPendingDelete(sessionId) {
      state.ui.pendingSessionDeletes = [...getPendingDeleteIds().filter((id) => id !== sessionId), sessionId];
      renderSessions();
    }

    function unmarkPendingDelete(sessionId) {
      state.ui.pendingSessionDeletes = getPendingDeleteIds().filter((id) => id !== sessionId);
      renderSessions();
    }

    /* Pending sessions still mutate while the undo toast is up (an active
       stream finishing, a queued send landing). Deleting fresher data than
       the user saw when they clicked Delete is never right — cancel instead. */
    function buildActivityStamp(summary) {
      return `${summary?.updated_at || ''}|${summary?.message_count || 0}`;
    }

    function requestDeleteSession(sessionId) {
      const summary = getSummary(sessionId);
      if (!summary || isSessionPendingDelete(sessionId)) {
        return false;
      }
      const title = clipTitle(summary.title);
      const activityStamp = buildActivityStamp(summary);
      let scheduled;
      try {
        scheduled = deleteUndoScheduler.schedule([sessionId], {
          windowMs: undoWindowMs,
          label: `delete "${title}"`,
          markPending: () => markPendingDelete(sessionId),
          onUndo: () => {
            unmarkPendingDelete(sessionId);
            appendClientLog('INFO', 'sessions.delete_undone', { sessionId });
          },
          commit: async () => {
            const current = getSummary(sessionId);
            if (current && buildActivityStamp(current) !== activityStamp) {
              unmarkPendingDelete(sessionId);
              appendClientLog('INFO', 'sessions.delete_canceled_by_activity', { sessionId });
              showToastMessage(`"${title}" got new activity, so it was not deleted.`, {
                title: 'Delete Canceled',
                tone: 'info',
                source: TOAST_SOURCE.sessionAction,
              });
              return;
            }
            try {
              await hardDeleteSession(sessionId);
            } finally {
              state.ui.pendingSessionDeletes = getPendingDeleteIds().filter((id) => id !== sessionId);
            }
          },
          onCommitError: (error) => {
            unmarkPendingDelete(sessionId);
            showSessionActionError(error, 'Delete Failed');
          },
          buildToast: ({ onUndo }) => ({
            message: `Deleted "${title}"`,
            options: {
              title: 'Chat Deleted',
              tone: 'danger',
              durationMs: undoWindowMs,
              source: TOAST_SOURCE.sessionAction,
              actions: [
                { id: 'session-delete-undo', label: 'Undo', kind: 'primary', onClick: onUndo },
                {
                  id: 'session-delete-now',
                  label: 'Delete now',
                  kind: 'secondary',
                  onClick: () => deleteUndoScheduler.flush([sessionId]),
                },
              ],
            },
          }),
        });
      } catch (error) {
        unmarkPendingDelete(sessionId);
        showSessionActionError(error, 'Delete Failed');
        return false;
      }
      return scheduled;
    }

    function listPendingUndos() {
      return deleteUndoScheduler.list().map((entry) => ({
        kind: 'session-delete',
        key: entry.key,
        label: entry.label,
        deadline: entry.deadline,
        undo: entry.undo,
      }));
    }

    async function togglePinSession(sessionId) {
      const summary = getSummary(sessionId);
      if (!summary) return;
      const nextPinned = !(summary.pinned === true);
      let updated;
      try {
        updated = await windowRef.jennyShell.sessions.setMeta(sessionId, { pinned: nextPinned });
      } catch (error) {
        showSessionActionError(error, nextPinned ? 'Pin Failed' : 'Unpin Failed');
        return;
      }
      if (!updated || typeof updated !== 'object' || !updated.id) {
        showSessionMetaUnavailable();
        return;
      }
      patchSummary(sessionId, { pinned: updated.pinned === true, archived_at: updated.archived_at || null });
      renderSessions();
      appendClientLog('INFO', 'sessions.meta_updated', { sessionId, pinned: updated.pinned === true });
    }

    async function toggleArchiveSession(sessionId) {
      const summary = getSummary(sessionId);
      if (!summary) return;
      const nextArchivedAt = summary.archived_at ? null : new Date().toISOString();
      let updated;
      try {
        updated = await windowRef.jennyShell.sessions.setMeta(sessionId, { archived_at: nextArchivedAt });
      } catch (error) {
        showSessionActionError(error, nextArchivedAt ? 'Archive Failed' : 'Unarchive Failed');
        return;
      }
      if (!updated || typeof updated !== 'object' || !updated.id) {
        showSessionMetaUnavailable();
        return;
      }
      patchSummary(sessionId, { pinned: updated.pinned === true, archived_at: updated.archived_at || null });
      renderSessions();
      appendClientLog('INFO', 'sessions.meta_updated', { sessionId, archived: Boolean(updated.archived_at) });
      showToastMessage(
        updated.archived_at ? `Archived "${clipTitle(summary.title)}"` : `Restored "${clipTitle(summary.title)}" from the archive`,
        { tone: 'info', source: TOAST_SOURCE.sessionAction, dedupeKey: `${TOAST_SOURCE.sessionAction}:archive:${sessionId}` }
      );
    }

    function showSessionMetaUnavailable() {
      showToastMessage('Pinning and archiving are not available with this backend mode.', {
        title: 'Not Available',
        tone: 'warning',
        source: TOAST_SOURCE.sessionAction,
        dedupeKey: `${TOAST_SOURCE.sessionAction}:meta-unavailable`,
      });
    }

    function escapeSelectorValue(value) {
      const cssRef = windowRef.CSS;
      if (cssRef && typeof cssRef.escape === 'function') {
        return cssRef.escape(value);
      }
      return String(value || '').replace(/"/g, '\\"');
    }

    function beginInlineRename(sessionId) {
      const summary = getSummary(sessionId);
      const row = windowRef.document.querySelector(
        `.conversation-item[data-session-id="${escapeSelectorValue(sessionId)}"]`
      );
      const titleEl = row?.querySelector('.session-row__title');
      if (!summary || !titleEl) {
        return false;
      }
      const editor = inlineTitleEditor.startInlineTitleEdit({
        titleEl,
        initialValue: summary.title || 'New Chat',
        ariaLabel: 'Rename chat',
        onCommit: (value) => {
          Promise.resolve(renameSession(sessionId, value))
            .catch((error) => showSessionActionError(error, 'Rename Failed'));
        },
        // renderSessions() suppresses structural rebuilds while the editor is
        // mounted; flush any update that queued up behind the edit.
        onCancel: () => renderSessions(),
      });
      return Boolean(editor);
    }

    // Mirrors the sidebar's openConversationCard: open the session in an explicit
    // tab mode, switch to chat, and repaint. Used by the context-menu override.
    async function openSessionWithMode(sessionId, mode) {
      if (typeof activateWorkspaceSession !== 'function') { return; }
      await activateWorkspaceSession(sessionId, { mode });
      if (typeof setActiveView === 'function') { setActiveView('chat'); }
      if (typeof renderAll === 'function') { renderAll(); }
    }

    function openSessionRowMenu({ sessionId, anchorX, anchorY, trigger }) {
      const summary = getSummary(sessionId);
      if (!summary || isSessionPendingDelete(sessionId)) {
        return false;
      }
      const pinned = summary.pinned === true;
      const archived = Boolean(summary.archived_at);
      const lockdown = summary.lockdown === true;
      // Offer the OPPOSITE of the current default so the user can override it
      // per-click: default replace → "Open in New Tab"; default new-tab → "Open
      // in This Tab". Only shown when the open path + preference are both wired.
      const defaultNewTab = globalThis.sessionOpenPrefUtils?.getOpenSessionsInNewTab?.() === true;
      const overrideItems = typeof activateWorkspaceSession === 'function'
        ? [
          {
            label: defaultNewTab ? 'Open in This Tab' : 'Open in New Tab',
            action: () => openSessionWithMode(sessionId, defaultNewTab ? 'replace' : 'new-tab'),
          },
          { separator: true },
        ]
        : [];
      contextMenu.show({
        rootEl: windowRef.document.body,
        anchorX,
        anchorY,
        restoreFocusTo: trigger || windowRef.document.querySelector(
          `.conversation-item[data-session-id="${escapeSelectorValue(sessionId)}"] [data-session-action="menu"]`
        ),
        onActionError: (error) => showSessionActionError(error, 'Session Action Failed'),
        items: [
          ...overrideItems,
          { label: pinned ? 'Unpin' : 'Pin', action: () => togglePinSession(sessionId) },
          ...(isOfflineLockdownEnabled()
            ? [{
                label: 'Offline lockdown',
                shortcutHint: lockdown ? 'On' : 'Off',
                action: () => toggleOfflineLockdown(sessionId),
              }]
            : []),
          { label: 'Rename', action: () => beginInlineRename(sessionId) },
          { label: archived ? 'Unarchive' : 'Archive', action: () => toggleArchiveSession(sessionId) },
          { separator: true },
          { label: 'Delete', action: () => requestDeleteSession(sessionId) },
        ],
      });
      return true;
    }

    function toggleArchivedView() {
      if (typeof toggleChatsScope === 'function') {
        return toggleChatsScope();
      }
      state.ui.sidebarArchivedView = !(state.ui.sidebarArchivedView === true);
      renderSessions();
      appendClientLog('INFO', 'sessions.archived_view_toggled', {
        visible: state.ui.sidebarArchivedView === true,
      });
    }

    /* Sweep is two-step: a dry run sizes the batch, then a toast action
       performs the actual deletes — no window.confirm, mirroring the
       undo-toast posture of single deletes. */
    async function sweepEmptyChats() {
      let dryRun;
      try {
        dryRun = await windowRef.jennyShell.sessions.sweepEmpty({
          dryRun: true,
          currentSessionId: state.currentSessionId || null,
        });
      } catch (error) {
        showSessionActionError(error, 'Sweep Failed');
        return;
      }
      const candidateCount = Array.isArray(dryRun?.candidateIds) ? dryRun.candidateIds.length : 0;
      if (!candidateCount) {
        showToastMessage('No empty chats to sweep.', {
          title: 'Sweep Empty Chats',
          tone: 'info',
          source: TOAST_SOURCE.sessionAction,
          dedupeKey: `${TOAST_SOURCE.sessionAction}:sweep-empty`,
        });
        return;
      }
      const plural = candidateCount === 1 ? '' : 's';
      showToastMessage(
        `Sweeping will delete ${candidateCount} empty chat${plural} (untitled, no messages).`,
        {
          title: 'Sweep Empty Chats',
          tone: 'warning',
          durationMs: 10000,
          source: TOAST_SOURCE.sessionAction,
          actions: [
            {
              id: 'session-sweep-confirm',
              label: `Delete ${candidateCount}`,
              kind: 'primary',
              onClick: () => {
                runSweep().catch((error) => showSessionActionError(error, 'Sweep Failed'));
              },
            },
          ],
        }
      );
    }

    async function runSweep() {
      const result = await windowRef.jennyShell.sessions.sweepEmpty({
        dryRun: false,
        currentSessionId: state.currentSessionId || null,
      });
      const deleted = Number(result?.deleted || 0);
      await refreshSessions();
      renderSessions();
      appendClientLog('INFO', 'sessions.swept_empty', { deleted });
      showToastMessage(`Swept ${deleted} empty chat${deleted === 1 ? '' : 's'}.`, {
        tone: 'success',
        source: TOAST_SOURCE.sessionAction,
        dedupeKey: `${TOAST_SOURCE.sessionAction}:sweep-done`,
      });
    }

    function openPanelOverflowMenu({ anchorX, anchorY, trigger }) {
      contextMenu.show({
        rootEl: windowRef.document.body,
        anchorX,
        anchorY,
        restoreFocusTo: trigger,
        onActionError: (error) => showSessionActionError(error, 'Session Action Failed'),
        onHide: () => { if (trigger?.dataset) delete trigger.dataset.menuOpen; },
        items: [
          { label: 'Sweep empty chats', action: () => sweepEmptyChats() },
        ],
      });
      // The trigger rests at opacity 0 and only paints on sidebar hover/focus,
      // so without this flag the dots vanish the moment the pointer leaves the
      // sidebar for the menu they just opened. Set it AFTER show(): show()
      // hides any open menu first, and that hide fires the previous onHide --
      // which would delete the flag we just wrote when reopening on the same
      // trigger.
      if (trigger?.dataset) trigger.dataset.menuOpen = '';
      return true;
    }

    registerCleanup(() => contextMenu.hide({ restoreFocus: false }));

    return {
      openSessionRowMenu,
      openPanelOverflowMenu,
      beginInlineRename,
      togglePinSession,
      toggleOfflineLockdown,
      toggleArchiveSession,
      toggleArchivedView,
      requestDeleteSession,
      sweepEmptyChats,
      isSessionPendingDelete,
      listPendingUndos,
    };
  }

  return { createSessionActionsController };
});
