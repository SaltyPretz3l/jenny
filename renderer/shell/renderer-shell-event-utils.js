/* global window */
/* renderer/shell/renderer-shell-event-utils.js - Shell-level event bindings (sidebar, sessions, logs). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellEventUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const COPY_FEEDBACK_MS = 1500;

  function createShellEventBindings(deps) {
    const { state } = deps;

    const {
      searchInput,
      chatsOverflowButton,
      sidebarResizer,
      conversationGroups,
      sessionActionButton,
      localProfileSettingsMount,
      checkUpdatesButton,
      updateSettingsSummary,
      copyLogsReportButton,
      logList,
      chatInput,
    } = deps.dom;

    const {
      renderSessions,
      resetSidebarWidth,
      loadMoreChats,
      setRovingChatSession,
      handleSidebarResizeStart,
      handleSidebarResizeMove,
      finishSidebarResize,
      handleSidebarResizeKeydown,
      renderAll,
      showToastMessage,
      appendClientLog,
      renderLogs,
      showSessionActionError,
      getCurrentRuntimePreferences,
      openSessionRowMenu,
      openPanelOverflowMenu,
      toggleArchivedView,
      openSession,
      setActiveView,
      getActiveStreamIdForCancel,
      isSendPreflightPending,
      resetAttachmentQueue,
      ensureLogRowMounted,
      scrollLogsToBottom,
      navigateToDiagnosticsTrace,
      refreshPhasePercentiles,
      resetPhasePercentiles,
      handleWorkspaceShortcut,
    } = deps.callbacks;

    const {
      TOAST_SOURCE,
    } = deps.constants;

    // CTL-009 refusal-contract owner. Resolved inside the factory rather than
    // at module scope because this shell script loads before the chat utils
    // script in index.html; by composition time (when this factory runs) the
    // global is present, and Node tests resolve via require.
    const { isCancelStreamRefused } = (typeof globalThis !== 'undefined' && globalThis.rendererMultiStreamUtils)
      || (typeof require === 'function' ? require('../chat/renderer-multi-stream-utils') : null)
      || {};

    let bindAbortController = null;
    let bound = false;
    let logsV2Bindings = null;
    let copyFeedbackTimeout = null;
    const cleanupFns = [];

    function addCleanup(cleanup) {
      if (typeof cleanup === 'function') {
        cleanupFns.push(cleanup);
      }
    }

    function flashCopyFeedback(button, restoreLabel) {
      if (!button) { return; }
      if (copyFeedbackTimeout !== null) clearTimeout(copyFeedbackTimeout);
      button.textContent = 'Copied';
      button.classList.add('copied');
      copyFeedbackTimeout = setTimeout(() => {
        copyFeedbackTimeout = null;
        button.textContent = restoreLabel;
        button.classList.remove('copied');
      }, COPY_FEEDBACK_MS);
    }

    function registerListener(target, eventName, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') {
        return;
      }
      target.addEventListener(eventName, handler, options);
      if (!bindAbortController) {
        addCleanup(() => {
          target.removeEventListener(eventName, handler, options);
        });
      }
    }

    function getConversationButtons() {
      return conversationGroups
        ? [...conversationGroups.querySelectorAll('[data-session-open]')]
        : [];
    }

    async function openConversationCard(card) {
      const sessionId = String(card?.dataset?.sessionId || '').trim();
      if (!sessionId) {
        return;
      }
      const opened = await openSession(sessionId);
      if (opened === false) return;
      if (card?.dataset?.sessionType !== 'plugin') setActiveView('chat');
      renderAll();
    }

    function clearConversationSearch() {
      if (!searchInput || !String(searchInput.value || '').trim()) {
        return false;
      }
      searchInput.value = '';
      renderSessions({ resetLimit: true });
      return true;
    }

    function focusConversationButtonAt(index) {
      const buttons = getConversationButtons();
      if (!buttons.length) {
        return;
      }
      const nextIndex = Math.max(0, Math.min(index, buttons.length - 1));
      const target = buttons[nextIndex];
      setRovingChatSession?.(target?.dataset?.sessionId);
      target?.focus();
    }

    async function handleConversationCardKeydown(event) {
      const openButton = event.target.closest('[data-session-open]');
      if (!openButton) {
        return;
      }
      const card = event.target.closest('.conversation-item[data-session-id]');
      const buttons = getConversationButtons();
      const currentIndex = buttons.indexOf(openButton);
      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
        event.preventDefault();
        const cardRect = card.getBoundingClientRect();
        openSessionRowMenu({
          sessionId: card.dataset.sessionId,
          anchorX: cardRect.left + 24,
          anchorY: cardRect.bottom,
          trigger: openButton,
        });
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusConversationButtonAt(currentIndex + 1);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusConversationButtonAt(currentIndex - 1);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        focusConversationButtonAt(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        focusConversationButtonAt(buttons.length - 1);
        return;
      }
      if (event.key === 'Escape' && clearConversationSearch()) {
        event.preventDefault();
        searchInput?.focus();
      }
    }

    function dispose() {
      if (!bound) {
        return;
      }
      bound = false;
      if (bindAbortController) {
        bindAbortController.abort();
        bindAbortController = null;
      }
      if (logsV2Bindings && typeof logsV2Bindings.dispose === 'function') {
        logsV2Bindings.dispose();
        logsV2Bindings = null;
      }
      if (copyFeedbackTimeout !== null) {
        clearTimeout(copyFeedbackTimeout);
        copyFeedbackTimeout = null;
      }
      while (cleanupFns.length) {
        const cleanup = cleanupFns.pop();
        try {
          cleanup();
        } catch (error) {
          // Ignore teardown failures during renderer shutdown.
        }
      }
    }

    function bind() {
      if (bound) {
        return;
      }
      bound = true;
      bindAbortController = typeof AbortController === 'function' ? new AbortController() : null;
      const listenerOptions = bindAbortController ? { signal: bindAbortController.signal } : undefined;
      if (typeof globalThis !== 'undefined'
        && globalThis.rendererDiagnosticsEventBindings
        && typeof globalThis.rendererDiagnosticsEventBindings.createLogsEventBindings === 'function') {
        logsV2Bindings = globalThis.rendererDiagnosticsEventBindings.createLogsEventBindings({
          state,
          dom: { logList },
          callbacks: {
            renderLogs,
            refreshPhasePercentiles,
            resetPhasePercentiles,
            scrollLogsToBottom,
            ensureLogRowMounted,
          },
        });
        logsV2Bindings.bind(listenerOptions);
      }

      registerListener(searchInput, 'input', () => renderSessions({ resetLimit: true }), listenerOptions);
      registerListener(searchInput, 'keydown', (event) => {
        if (event.key === 'Escape' && clearConversationSearch()) {
          event.preventDefault();
        }
      }, listenerOptions);
      registerListener(chatsOverflowButton, 'click', () => {
        const buttonRect = chatsOverflowButton.getBoundingClientRect();
        openPanelOverflowMenu({
          anchorX: buttonRect.left,
          anchorY: buttonRect.bottom + 4,
          trigger: chatsOverflowButton,
        });
      }, listenerOptions);
      registerListener(sidebarResizer, 'pointerdown', handleSidebarResizeStart, listenerOptions);
      registerListener(sidebarResizer, 'pointermove', handleSidebarResizeMove, listenerOptions);
      registerListener(sidebarResizer, 'pointerup', finishSidebarResize, listenerOptions);
      registerListener(sidebarResizer, 'pointercancel', finishSidebarResize, listenerOptions);
      registerListener(sidebarResizer, 'dblclick', () => {
        resetSidebarWidth();
      }, listenerOptions);
      registerListener(sidebarResizer, 'keydown', handleSidebarResizeKeydown, listenerOptions);
      registerListener(window, 'keydown', handleWorkspaceShortcut, listenerOptions);
      // keyup feeds the same handler so it can commit the Alt+Tab MRU cycle when
      // the Ctrl modifier is released (it branches on event.type internally).
      registerListener(window, 'keyup', handleWorkspaceShortcut, listenerOptions);

      registerListener(conversationGroups, 'click', async (event) => {
        try {
          if (event.target.closest('[data-chats-load-more]')) {
            loadMoreChats?.();
            return;
          }
          const actionButton = event.target.closest('[data-session-action]');
          if (actionButton) {
            if (actionButton.dataset.sessionAction === 'menu') {
              const buttonRect = actionButton.getBoundingClientRect();
              openSessionRowMenu({
                sessionId: actionButton.dataset.sessionId,
                anchorX: buttonRect.left,
                anchorY: buttonRect.bottom + 4,
                trigger: actionButton,
              });
            }
            return;
          }

          const openButton = event.target.closest('[data-session-open]');
          const card = openButton?.closest('[data-session-id]');
          if (!card) {
            return;
          }
          await openConversationCard(card);
        } catch (error) {
          showSessionActionError(error, 'Session Action Failed');
        }
      }, listenerOptions);
      registerListener(conversationGroups, 'contextmenu', (event) => {
        const card = event.target.closest('.conversation-item[data-session-id]');
        if (!card) {
          return;
        }
        event.preventDefault();
        const cardRect = card.getBoundingClientRect();
        openSessionRowMenu({
          sessionId: card.dataset.sessionId,
          // The keyboard ContextMenu key fires this event without pointer
          // coordinates; fall back to the row's own box.
          anchorX: event.clientX || cardRect.left + 24,
          anchorY: event.clientY || cardRect.bottom,
          trigger: event.target.closest('button') || card.querySelector('[data-session-open]'),
        });
      }, listenerOptions);
      registerListener(conversationGroups, 'keydown', handleConversationCardKeydown, listenerOptions);

      registerListener(sessionActionButton, 'click', async () => {
        try {
          if (!state.auth.authenticated) {
            return;
          }
          if (isSendPreflightPending()) {
            return;
          }

          const activeStreamId = String(
            typeof getActiveStreamIdForCancel === 'function'
              ? getActiveStreamIdForCancel()
              : state.activeStreamId
          ).trim();
          if (activeStreamId) {
            const cancelResult = await window.jennyShell.chat.cancelStream(activeStreamId);
            // CTL-009: a refused cancel (the stream had already finished by
            // the time this IPC round-trip landed) is logged, then falls
            // through to the same "end session" path today's code takes
            // unconditionally. Refusal shape owned by isCancelStreamRefused.
            if (isCancelStreamRefused(cancelResult)) {
              appendClientLog('WARN', 'chat.cancel_refused', { streamId: activeStreamId });
            } else {
              return;
            }
          }

          state.runtimeDraft = getCurrentRuntimePreferences();
          state.currentSessionId = '';
          resetAttachmentQueue();
          renderAll();
          chatInput.focus();
          appendClientLog('INFO', 'chat.session_ended');
        } catch (error) {
          showSessionActionError(error, 'Session Update Failed');
        }
      }, listenerOptions);

      registerListener(localProfileSettingsMount, 'click', async (event) => {
        const action = event.target?.closest?.('[data-action="save-local-profile"]');
        if (!action) return;
        const input = localProfileSettingsMount.querySelector('#localProfileDisplayName');
        const displayName = String(input?.value || '').trim();
        try {
          action.disabled = true;
          state.auth = await window.jennyShell.auth.updateLocalProfile({ displayName });
          renderAll();
          showToastMessage('Local profile saved.', {
            title: 'Profile updated',
            tone: 'success',
            source: 'settings.local_profile',
          });
        } catch (error) {
          showSessionActionError(error, 'Profile Update Failed');
        } finally {
          action.disabled = false;
        }
      }, listenerOptions);

      const summarizeUpdateState = (payload) => {
        const source = payload && typeof payload === 'object' ? payload : {};
        const version = source.currentVersion ? `Jenny ${source.currentVersion}` : 'Jenny';
        const pending = source.latestVersion ? `Update ${source.latestVersion}` : 'An update';
        let suffix = 'Updates are checked only when you ask.';
        if (source.status === 'disabled') {
          suffix = source.reason || 'Automatic updates are unavailable in this install.';
        } else if (source.status === 'available' || source.status === 'downloading') {
          suffix = `${pending} is available.`;
        } else if (source.status === 'downloaded') {
          suffix = `${pending} is ready to install.`;
        } else if (source.status === 'error') {
          suffix = 'The last update check failed.';
        }
        return `${version} — ${suffix}`;
      };

      let updatesUiDisposed = false;
      addCleanup(() => {
        updatesUiDisposed = true;
      });

      if (updateSettingsSummary && window.jennyShell?.updates?.getState) {
        window.jennyShell.updates.getState().then((payload) => {
          if (!updatesUiDisposed) {
            updateSettingsSummary.textContent = summarizeUpdateState(payload);
          }
        }).catch(() => {});
      }

      registerListener(checkUpdatesButton, 'click', async () => {
        const updates = window.jennyShell?.updates;
        if (!updates || typeof updates.check !== 'function') {
          showSessionActionError(
            new Error('The update service is unavailable in this build.'),
            'Update Check Failed'
          );
          return;
        }
        const dialog = window.jennyUpdateDialog;
        if (dialog && typeof dialog.open === 'function') {
          dialog.open();
        }
        try {
          // The dialog repaints from updates.onChanged pushes; only the
          // settings note needs the resolved payload.
          const payload = await updates.check();
          if (!updatesUiDisposed && updateSettingsSummary) {
            updateSettingsSummary.textContent = summarizeUpdateState(payload);
          }
        } catch (error) {
          if (updatesUiDisposed) {
            return;
          }
          if (dialog && typeof dialog.render === 'function') {
            dialog.render({
              status: 'error',
              reason: String((error && error.message) || error || 'Update check failed.'),
            });
          }
          showSessionActionError(error, 'Update Check Failed');
        }
      }, listenerOptions);

      registerListener(copyLogsReportButton, 'click', () => {
        const buildReport = window.diagnosticsReportUtils?.buildDiagnosticReport;
        if (typeof buildReport !== 'function') { return; }
        const text = buildReport({ ...(state.diagnosticsSnapshot || {}), entries: state.logs }, state.diagnosticsStatus || {}, {
          runId: state.ui.logs.selectedRunId,
        });
        const write = window.jennyShell?.clipboard?.writeText;
        if (!write) { return; }
        Promise.resolve(write(text))
          .then(() => {
            flashCopyFeedback(copyLogsReportButton, 'Copy report');
            showToastMessage(
              'Copied a redacted Diagnostics report with runtime, integrity, issues, and a bounded event tail.',
              {
                title: 'Report Copied',
                tone: 'success',
                source: TOAST_SOURCE.logs,
                dedupeKey: `${TOAST_SOURCE.logs}:copy-report`,
              }
            );
          })
          .catch((error) => {
            try {
              if (typeof appendClientLog === 'function') {
                appendClientLog('WARN', 'logs.copy_failed', { reason: String(error && error.message || error || '') });
              }
            } catch (_err) { /* noop */ }
            showToastMessage('Clipboard unavailable. Copy failed.', {
              title: 'Copy failed',
              tone: 'warning',
              source: TOAST_SOURCE.logs,
              dedupeKey: `${TOAST_SOURCE.logs}:copy-report-failed`,
            });
          });
      }, listenerOptions);

    }

    return { bind, dispose };
  }

  return { createShellEventBindings };
});
