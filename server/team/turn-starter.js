'use strict';

const { memberAuthor } = require('../../services/backend/message-author');

// The running turn of a conversation and the member who started it (slice 3-7's read, shared with
// slice 3-6b's approvals). Answers null when no turn runs, else `{ starter }`: the member who wrote the
// turn's user message, or null when it has no member author. Read from the cache-neutral active-turn
// registry (`peekActiveTurn`, which also holds a turn a crash left behind) and, only when a turn runs,
// the stored messages by reference, searched from the end. A lookup that is missing or throws is a
// running turn with no starter (fail closed).
function runningTurn(backend, sessionId) {
  try {
    const store = backend?.sessionStore;
    if (typeof store?.peekActiveTurn !== 'function' || typeof store.peekSessionMessages !== 'function') {
      return { starter: null };
    }
    const turn = store.peekActiveTurn(sessionId);
    if (!turn && backend.sessionTurnActors?.hasActiveLifecycle?.(sessionId) !== true) return null;
    const messageId = turn?.user_message_id;
    const message = messageId ? store.peekSessionMessages(sessionId).findLast((row) => row?.id === messageId) : null;
    return { starter: memberAuthor(message?.author?.member_id)?.member_id ?? null };
  } catch (_error) {
    return { starter: null };
  }
}

// The starter alone: the prompter of an approval or a question batch, or null (no turn, no member author).
function turnStarter(backend, sessionId) {
  return runningTurn(backend, sessionId)?.starter ?? null;
}

module.exports = { runningTurn, turnStarter };
