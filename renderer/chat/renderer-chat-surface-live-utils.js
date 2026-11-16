/* renderer/chat/renderer-chat-surface-live-utils.js
 * The one shared "is a chat surface live?" predicate (Workspace Chat Dock).
 *
 * Chat is live in the Chat view, in an open, enabled Workspace dock, or in the
 * Board page's open chat column.
 *
 * Pure state → boolean; no DOM, no deps (unit-testable, not c8-excluded).
 * It also holds the one rule for a turn's board stamp (`boardStampForSend`, row 150) and the names of the
 * boards seen in this run, which the mark on a stamped message reads.
 * Reads the renderer state shape: `state.ui.activeView`,
 * `state.features.featureFlags.ide_chat_dock` / `.project_boards`, and the
 * renderer-only UI mirrors `state.ui.ideChatDockOpen` (set by
 * renderer-ide-chat-dock.js) and `state.ui.boardChatDockOpen` (set by
 * renderer/features/board/board-chat-dock.js).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererChatSurfaceLiveUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function isChatSurfaceLive(state) {
    var view = state && state.ui && state.ui.activeView;
    if (view === 'chat') return true;
    var features = (state && state.features) || {};
    var flags = features.featureFlags || {};
    // The Board page (row 150) docks the same chat; its own mirror is state.ui.boardChatDockOpen.
    if (view === 'board') return flags.project_boards === true && state.ui.boardChatDockOpen === true;
    if (view !== 'ide') return false;
    return flags.ide_chat_dock === true && state.ui.ideChatDockOpen === true;
  }

  // The chat is live inside a page's dock (the Workspace's or the Board's), not in the Chat view.
  function isDockedChatLive(state) {
    var view = state && state.ui && state.ui.activeView;
    return (view === 'ide' || view === 'board') && isChatSurfaceLive(state);
  }

  // The board id pattern of services/boards/board-ids.js (BOARD_ID_RE); a test pins that the two agree.
  var BOARD_ID_RE = /^board_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var MAX_BOARD_NAMES = 64;
  var boardNames = new Map();

  function isBoardId(value) {
    return typeof value === 'string' && value.length === 42 && BOARD_ID_RE.test(value);
  }

  /* The board a turn is stamped with, or '' (plan PROJECT_BOARD_2026-11-13, section 7.1).
   * A queued send, a retry and a durable replay carry the stamp they were typed with (`settings.boardId`) and
   * never gain one later. Otherwise a turn is stamped only when it was typed in the composer
   * (`attachImageEditDraft === true`) while the Board page shows this chat beside a board of the chat's own
   * project (`state.ui.boardChat`, set by board-chat-dock.js). An edit or a regenerate sends no stamp: the main
   * process keeps the one stored on the message. The main process checks the board again either way. */
  function boardStampForSend(state, settings, sessionId) {
    var options = settings || {};
    if (options.editedMessageId || options.editAndRegenerate) return '';
    if (options.boardId !== undefined && options.boardId !== null && options.boardId !== '') {
      return isBoardId(options.boardId) ? options.boardId : '';
    }
    if (options.attachImageEditDraft !== true || options.outboxDispatch || options.failedPayloadId || options.failureRetry) return '';
    var ui = (state && state.ui) || {};
    var stamp = ui.boardChat;
    if (ui.activeView !== 'board' || !stamp || !isChatSurfaceLive(state)) return '';
    if (String(sessionId || '') !== String(state.currentSessionId || '')) return '';
    return isBoardId(stamp.boardId) ? stamp.boardId : '';
  }

  // Board names seen in this run, newest last and bounded. Text only: the reader escapes it.
  function rememberBoardName(boardId, name) {
    var text = String(name || '').trim().slice(0, 120);
    if (!isBoardId(boardId) || !text) return;
    boardNames.delete(boardId);
    boardNames.set(boardId, text);
    if (boardNames.size > MAX_BOARD_NAMES) boardNames.delete(boardNames.keys().next().value);
  }

  function boardNameOf(boardId) {
    return boardNames.get(boardId) || '';
  }

  return {
    isChatSurfaceLive: isChatSurfaceLive,
    isDockedChatLive: isDockedChatLive,
    boardStampForSend: boardStampForSend,
    rememberBoardName: rememberBoardName,
    boardNameOf: boardNameOf,
  };
});
