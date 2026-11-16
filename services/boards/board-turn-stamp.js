'use strict';

/**
 * The one definition of a turn's board stamp (plan PROJECT_BOARD_2026-11-13, section 7.1; session schema 29).
 *
 * A turn sent from the composer docked beside a board carries that board's id. The stamp is stored on the
 * user message as `board_id` and is the only thing that lets a turn see a board: an unstamped turn is never
 * told boards exist. The renderer decides where a turn was typed; this module decides whether the stamp is
 * believed. A stamp is kept only when it names a live board of the chat's own project. Anything else is
 * dropped and the turn goes on without it, so a stale or forged stamp costs the turn its board, never the send.
 *
 * Pure apart from the two lookups handed in (`service.getBoardService`, `service.sessionStore`). It loads
 * `board-ids.js` only, so the session store's migration chain can require it at startup.
 */

const { GENERAL_PROJECT_ID, isBoardId } = require('./board-ids');

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The stamp a stored row may keep: a board id on a user row, null on every other role or value. */
function messageBoardStampFor(role, value) {
  return role === 'user' && isBoardId(value) ? value : null;
}

/**
 * Apply the rule to one stored message. A message without a `board_id` key is returned as is (old messages
 * gain nothing); a valid stamp on a user row stays; anything else is removed.
 */
function applyBoardStampRule(message) {
  if (!isPlainRecord(message) || !Object.hasOwn(message, 'board_id')) return message;
  if (messageBoardStampFor(message.role, message.board_id)) return message;
  const { board_id: _dropped, ...rest } = message;
  return rest;
}

// v29 adds the optional user-message `board_id`; the step keeps only a valid one and adds nothing.
function repairSessionForV29(session = {}) {
  const source = isPlainRecord(session) ? session : {};
  if (!Array.isArray(source.messages)) return { ...source };
  return { ...source, messages: source.messages.map(applyBoardStampRule) };
}

function storedMessages(sessionStore, sessionId) {
  if (typeof sessionStore?.peekSessionMessages === 'function') return sessionStore.peekSessionMessages(sessionId);
  return typeof sessionStore?.getSession === 'function' ? sessionStore.getSession(sessionId)?.messages || [] : [];
}

/** The stamp stored on one user message, or null. */
function storedBoardStamp(sessionStore, sessionId, messageId) {
  const id = String(messageId || '').trim();
  if (!id) return null;
  try {
    const row = (storedMessages(sessionStore, sessionId) || []).find((message) => message?.id === id);
    return row ? messageBoardStampFor(row.role, row.board_id) : null;
  } catch (_error) { return null; }
}

function sessionProjectOf(sessionStore, sessionId) {
  if (!sessionId) return '';
  const summary = typeof sessionStore?.getSessionSummary === 'function'
    ? sessionStore.getSessionSummary(sessionId) : sessionStore?.getSession?.(sessionId);
  if (!summary) return '';
  return String(summary.project_id || '').trim() || GENERAL_PROJECT_ID;
}

/**
 * The stamp this turn runs with, or null.
 *
 * A new turn offers `boardId` from its payload. An edit or a regenerate (`editedMessageId`) re-sends a stored
 * turn, so its stamp is the stored row's and the payload's is ignored. Either way the stamp is kept only when
 * boards are on, the chat already has a stored record, and the board is a live board of that chat's project.
 * A dropped stamp is logged with a reason code and no content.
 */
async function resolveBoardStamp(service, { boardId, sessionId, editedMessageId } = {}) {
  const sessionKey = String(sessionId || '').trim();
  const edited = String(editedMessageId || '').trim();
  const candidate = edited ? storedBoardStamp(service?.sessionStore, sessionKey, edited) : boardId;
  if (candidate === undefined || candidate === null || candidate === '') return null;
  const drop = (reason) => {
    service?._emitServiceLog?.('INFO', 'boards.turn_stamp_dropped', { sessionId: sessionKey, reason });
    return null;
  };
  if (!isBoardId(candidate)) return drop('invalid');
  // The desktop has one board service and ignores the argument; a team host answers the boards of this chat's project.
  const boards = typeof service?.getBoardService === 'function' ? service.getBoardService(sessionKey) : null;
  if (!boards || typeof boards.list !== 'function') return drop('disabled');
  let projectId;
  try { projectId = sessionProjectOf(service.sessionStore, sessionKey); } catch (_error) { projectId = ''; }
  if (!projectId) return drop('no_session');
  let listed;
  try { listed = await boards.list({ projectId }); } catch (_error) { return drop('io'); }
  if (!listed || listed.ok !== true || !Array.isArray(listed.boards)) return drop(String(listed?.reason || 'io'));
  return listed.boards.some((entry) => entry?.id === candidate) ? candidate : drop('not_in_project');
}

module.exports = {
  applyBoardStampRule,
  messageBoardStampFor,
  repairSessionForV29,
  resolveBoardStamp,
  storedBoardStamp,
};
