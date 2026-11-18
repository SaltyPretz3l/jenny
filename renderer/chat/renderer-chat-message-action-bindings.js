/* renderer/chat/renderer-chat-message-action-bindings.js owns the message
 * action clicks in one pane timeline: the multi-select handle, the unsaved
 * reply's copy / save-retry / discard, the inline editor's Save and Cancel,
 * and the hover actions (edit, copy, regenerate, branch, elaborate,
 * follow-up, proactive suggestion use / save / later). Loaded before
 * renderer-chat-event-transcript-bindings.js, which creates it per pane.
 *
 * It also owns the chat's one "Pin to board" entry (row 150 slice C5): openPinMenu() is what the message's Pin button,
 * a sketch drawing, a picture, a file link and the side panel's selected text all call. It answers false at once with
 * the `project_boards` flag off, takes the project from the chat (General when it has none), loads the board picker
 * (renderer/features/board/board-pin-menu.js) on first use through the script loader, and opens it. pinEnabled() is
 * the flag as the last bindings made here saw it, for the places that draw a Pin control without an app state.
 * openBoardFromMark(): a named board under a sent prompt opens that board, through the same module. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./renderer-unsaved-reply-actions'));
    return;
  }
  root.rendererChatMessageActionBindings = factory(root.rendererUnsavedReplyActions || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (unsavedReplyActions) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };

  const GENERAL_PROJECT_ID = 'project_general';
  const PIN_MENU_SRC = 'renderer/features/board/board-pin-menu.js';
  const pinHolder = { state: null };
  const flagOf = (state) => Boolean(state && state.features && state.features.featureFlags && state.features.featureFlags.project_boards === true);
  const oneLine = (text, max) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
  const elementOf = (node) => (node && node.nodeType === 1 ? node : (node && node.parentElement) || null);

  function pinEnabled() { return flagOf(pinHolder.state); }

  function projectIdOf(state, chatId) {
    const session = (Array.isArray(state.sessions) ? state.sessions : []).find((entry) => String(entry && entry.id || '').trim() === chatId);
    return String(session && session.project_id || '').trim() || GENERAL_PROJECT_ID;
  }

  // Runs `call(module)` once the lazy board-pin-menu module is in the page; false when it cannot be loaded.
  function withPinMenu(win, call) {
    const run = () => (win.rendererBoardPinMenu ? call(win.rendererBoardPinMenu) : undefined);
    if (win.rendererBoardPinMenu) { void Promise.resolve(run()).catch(() => {}); return true; }
    const loader = win.scriptLoaderUtils;
    if (!loader || typeof loader.ensureScript !== 'function') return false;
    Promise.resolve(loader.ensureScript({ src: PIN_MENU_SRC, isReady: () => Boolean(win.rendererBoardPinMenu) })).then(run).catch(() => {});
    return true;
  }

  function openPinMenu(args) {
    const options = args || {};
    const state = options.state || pinHolder.state;
    if (!flagOf(state)) return false;
    const win = options.windowRef || globalThis;
    const call = {
      anchorEl: options.anchorEl, anchorX: options.anchorX, anchorY: options.anchorY, rootEl: options.rootEl,
      item: options.item, heading: options.heading, sessionId: options.sessionId, messageId: options.messageId,
      projectId: projectIdOf(state, String(options.sessionId || state.currentSessionId || '').trim()),
      deps: { state, windowRef: win },
    };
    return withPinMenu(win, (menu) => (typeof menu.open === 'function' ? menu.open(call) : undefined));
  }

  // Post to Team (row 175 D5): an answer's hover action.
  const postModule = () => globalThis.rendererChatPostToTeam?.getDefault?.({ canQueue: true }) || null;
  // { visible, enabled, reason } for the button; null while the Team flag is off.
  function postToTeamState(message) {
    if (pinHolder.state?.features?.featureFlags?.team !== true || !message?.id || !String(message.content || '').trim()) return null;
    const verdict = postModule()?.availability(message.content) || { ok: false, reason: jt('chat.postToTeam.reason.noTeam', 'Join a team to post there.') };
    return { visible: true, enabled: verdict.ok, reason: verdict.reason };
  }

  // The named board under a sent prompt opens that board (saved as the project's open one, then the Board view).
  function openBoardFromMark(args) {
    const options = args || {};
    const state = options.state || pinHolder.state;
    const boardId = String(options.boardId || '').trim();
    if (!boardId || !flagOf(state)) return false;
    const win = options.windowRef || globalThis;
    const deps = { state, windowRef: win, projectId: projectIdOf(state, String(state.currentSessionId || '').trim()) };
    return withPinMenu(win, (menu) => (typeof menu.openBoard === 'function' ? menu.openBoard(boardId, deps) : undefined));
  }

  /** A context-menu item that opens the picker for `args.item`, or null while the flag is off. */
  function pinMenuItem(args) {
    if (!flagOf((args && args.state) || pinHolder.state)) return null;
    return { label: (args && args.label) || jt('board.pin.menuItem', 'Pin to board'), action: () => { openPinMenu(args); } };
  }

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
    if (state) pinHolder.state = state;
    // The text selected inside this message's own entry (never in its hover row), or ''.
    function selectedTextIn(entry) {
      const selection = doc && typeof doc.getSelection === 'function' ? doc.getSelection() : null;
      if (!entry || !selection || selection.isCollapsed || selection.rangeCount < 1) return '';
      const inside = (node) => {
        const el = elementOf(node);
        return Boolean(el) && entry.contains(el) && !el.closest('[data-hover-row]');
      };
      return inside(selection.anchorNode) && inside(selection.focusNode) ? selection.toString().trim() : '';
    }

    function messageOf(chatId, messageId) {
      const list = state && state.messagesBySession && typeof state.messagesBySession.get === 'function' ? state.messagesBySession.get(chatId) : null;
      return Array.isArray(list) ? list.find((entry) => String(entry && entry.id || '').trim() === messageId) : null;
    }

    // The selection inside the answer, else the whole answer.
    function postToTeamMessage(messageId, button) {
      const message = messageOf(String(state?.currentSessionId || '').trim(), messageId);
      if (message) postModule()?.open({ text: selectedTextIn(button.closest('.chat-entry')) || String(message.content || ''), trigger: button });
    }

    function pinMessage(messageId, button) {
      const chatId = String(state && state.currentSessionId || '').trim();
      const message = messageOf(chatId, messageId);
      if (!message || !chatId) return;
      const selected = selectedTextIn(button.closest('.chat-entry'));
      const session = (Array.isArray(state.sessions) ? state.sessions : []).find((entry) => String(entry && entry.id || '').trim() === chatId);
      openPinMenu({
        state, windowRef: doc && doc.defaultView, anchorEl: button, rootEl: doc && doc.body, sessionId: chatId, messageId,
        item: selected ? { kind: 'note', text: selected }
          : { kind: 'chat', sessionId: chatId, messageId, title: oneLine(session && session.title, 200), excerpt: oneLine(message.content, 400) },
        heading: selected ? jt('board.pin.headingSelection', 'Pin selection to board') : undefined,
      });
    }

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

      const boardMark = event.target.closest('[data-message-mark="board"][data-board-id]');
      if (boardMark && openBoardFromMark({ state, windowRef: doc && doc.defaultView, boardId: boardMark.dataset.boardId })) {
        event.preventDefault();
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
        if (messageAction === 'pin') {
          pinMessage(messageId, actionButton);
          return true;
        }
        if (messageAction === 'post-to-team') {
          postToTeamMessage(messageId, actionButton);
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

  return { createMessageActionBindings, openPinMenu, openBoardFromMark, pinMenuItem, pinEnabled, postToTeamState };
});
