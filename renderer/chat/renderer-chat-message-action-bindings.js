/* renderer/chat/renderer-chat-message-action-bindings.js owns the message
 * action clicks in one pane timeline: the multi-select handle, the unsaved
 * reply's copy / save-retry / discard, the inline editor's Save and Cancel,
 * and the hover actions (edit, copy, regenerate, branch, elaborate,
 * follow-up, proactive suggestion use / save / later). Loaded before
 * renderer-chat-event-transcript-bindings.js, which creates it per pane. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-unsaved-reply-actions'));
    return;
  }
  root.rendererChatMessageActionBindings = factory(root.rendererUnsavedReplyActions || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (unsavedReplyActions) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  function createMessageActionBindings(deps) {
    const {
      state,
      doc,
      selectionController,
      handleSelectClickInput,
      handleCopyMessage,
      handleRegenerateMessage,
      handleElaborateMessage,
      handleBranchMessage,
      handleEditMessage,
      handleEditCommit,
      handleEditCancel,
      handleFollowUpMessage,
      handleUseProactiveSuggestionMessage,
      handleSaveProactiveSuggestionMessage,
      handleLaterProactiveSuggestionMessage,
      appendClientLog,
      showComposerActionError,
      refreshRecoveredSession,
    } = deps;
    const unsavedReplyController = unsavedReplyActions.createUnsavedReplyActionController?.({
      state,
      windowRef: doc?.defaultView || (typeof window !== 'undefined' ? window : null),
      handleCopyMessage,
      appendClientLog,
      onResolved: refreshRecoveredSession,
    }) || null;
    let handleSelectClick;
    if (typeof handleSelectClickInput === 'function') {
      handleSelectClick = handleSelectClickInput;
    } else if (selectionController) {
      handleSelectClick = function defaultHandleSelectClick(messageId, opts) {
        const inMode = typeof selectionController.isSelectMode === 'function'
          ? selectionController.isSelectMode() === true
          : false;
        const shift = opts && opts.shiftKey === true;
        if (!inMode) {
          if (typeof selectionController.enterSelectMode === 'function') {
            selectionController.enterSelectMode();
          }
          if (typeof selectionController.toggleMessage === 'function') {
            selectionController.toggleMessage(messageId);
          }
          return;
        }
        if (shift && typeof selectionController.selectRange === 'function') {
          selectionController.selectRange(messageId);
          return;
        }
        if (typeof selectionController.toggleMessage === 'function') {
          selectionController.toggleMessage(messageId);
        }
      };
    } else {
      handleSelectClick = function noopHandleSelectClick() { /* no-op */ };
    }

    // The transcript click delegate's message-action branches, in its order;
    // true when the click belonged to one of them.
    function handleMessageActionClick(event) {
      // F4/F5/F6: selection-handle click (multi-select toggle / range). Runs
      // BEFORE the edit/message-action cascade so the click on the checkbox
      // affordance never bubbles into the underlying bubble copy action.
      const selectionHandleTarget = event.target.closest('[data-select-message-id]');
      if (selectionHandleTarget) {
        event.preventDefault();
        event.stopPropagation();
        const messageId = String(selectionHandleTarget.dataset.selectMessageId || '').trim();
        if (messageId) {
          try {
            handleSelectClick(messageId, {
              shiftKey: event.shiftKey === true,
              ctrlKey: event.ctrlKey === true || event.metaKey === true,
            });
          } catch (error) {
            appendClientLog('ERROR', 'chat.selection_click_failed', {
              messageId,
              message: error && error.message || String(error),
            });
          }
        }
        return true;
      }

      const unsavedReplyTarget = event.target.closest('[data-unsaved-reply-action]');
      if (unsavedReplyTarget && unsavedReplyController) {
        event.preventDefault();
        const action = String(unsavedReplyTarget.dataset.unsavedReplyAction || '').trim();
        unsavedReplyController.dispatch(unsavedReplyTarget).catch((error) => {
          if (action === 'copy') {
            appendClientLog('ERROR', 'chat.message_copy_failed', {
              messageId: String(unsavedReplyTarget.dataset.messageId || '').slice(0, 30),
              message: error?.message || String(error),
            });
            return;
          }
          showComposerActionError(
            error,
            action === 'discard' ? jt('chat.transcript.discardFailedTitle', 'Discard Failed') : jt('chat.transcript.saveRetryFailedTitle', 'Save Retry Failed')
          );
        });
        return true;
      }

      // Single .closest() walk finds either the inline edit Save/Cancel
      // buttons (F2) or any hover-action button. data-edit-action wins
      // when both attributes are present so the inline editor's buttons
      // route to the edit controller, not the hover cascade.
      const dispatchTarget = event.target.closest('[data-edit-action], [data-message-action]');
      if (dispatchTarget && dispatchTarget.dataset.editAction) {
        event.preventDefault();
        const editAction = String(dispatchTarget.dataset.editAction || '').trim();
        if (editAction === 'save') {
          try {
            const maybePromise = handleEditCommit();
            if (maybePromise && typeof maybePromise.catch === 'function') {
              maybePromise.catch((error) => showComposerActionError(error, jt('chat.transcript.editFailedTitle', 'Edit Failed')));
            }
          } catch (error) {
            showComposerActionError(error, jt('chat.transcript.editFailedTitle', 'Edit Failed'));
          }
        } else if (editAction === 'cancel') {
          try {
            handleEditCancel();
          } catch (_) { /* cancel is best-effort */ }
        }
        return true;
      }

      const actionButton = dispatchTarget;
      if (actionButton) {
        const { messageAction, messageId } = actionButton.dataset;
        event.preventDefault();
        if (!messageId) {
          return true;
        }
        if (messageAction === 'edit') {
          try {
            handleEditMessage(messageId);
          } catch (error) {
            showComposerActionError(error, jt('chat.transcript.editFailedTitle', 'Edit Failed'));
          }
          return true;
        }
        if (messageAction === 'copy') {
          handleCopyMessage(messageId).catch((error) => {
            appendClientLog('ERROR', 'chat.message_copy_failed', {
              messageId,
              message: error.message || String(error),
            });
          });
          return true;
        }
        if (messageAction === 'regenerate') {
          handleRegenerateMessage(messageId).catch((error) => {
            showComposerActionError(error, jt('chat.transcript.regenerateFailedTitle', 'Regenerate Failed'));
          });
          return true;
        }
        if (messageAction === 'branch') {
          handleBranchMessage(messageId).catch((error) => {
            showComposerActionError(error, jt('chat.transcript.branchFailedTitle', 'Branch Failed'));
          });
          return true;
        }
        if (messageAction === 'elaborate') {
          handleElaborateMessage(messageId).catch((error) => {
            showComposerActionError(error, jt('chat.transcript.elaborateFailedTitle', 'Elaborate Failed'));
          });
          return true;
        }
        if (messageAction === 'follow-up') {
          handleFollowUpMessage(messageId).catch((error) => {
            showComposerActionError(error, jt('chat.transcript.followUpFailedTitle', 'Follow-up Failed'));
          });
          return true;
        }
        if (messageAction === 'use-suggestion') {
          handleUseProactiveSuggestionMessage(messageId).catch((error) => {
            showComposerActionError(error, jt('chat.transcript.suggestionFailedTitle', 'Suggestion Failed'));
          });
          return true;
        }
        if (messageAction === 'save-suggestion') {
          handleSaveProactiveSuggestionMessage(messageId).catch((error) => {
            showComposerActionError(error, jt('chat.transcript.saveFailedTitle', 'Save Failed'));
          });
          return true;
        }
        if (messageAction === 'later-suggestion') {
          handleLaterProactiveSuggestionMessage(messageId).catch((error) => {
            showComposerActionError(error, jt('chat.transcript.laterFailedTitle', 'Later Failed'));
          });
          return true;
        }
        return true;
      }
      return false;
    }

    return { handleMessageActionClick };
  }

  return { createMessageActionBindings };
});
