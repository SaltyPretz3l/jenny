'use strict';

// The source chat of a forked new chat (row 94 P2, owner pick F1). A primary-chat proposal may start its
// new chat as a fork of another chat at that chat's newest branchable message. The source must exist,
// must not be a primary chat (its transcript spans every project; forkSession refuses it too) and must
// have a message a fork can end on. Visibility is the caller's: the tool asks the session directory.
// Reads the store's cache-neutral peek only.

const { isBranchableMessage } = require('./session-branching');
const { isPrimaryRole } = require('./primary-session');

// The id of the newest message a fork may end on, or null.
function lastBranchableMessageId(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (isBranchableMessage(message) && typeof message.id === 'string' && message.id) return message.id;
  }
  return null;
}

const blankToNull = (value) => (typeof value === 'string' && value.trim() ? value : null);

// -> {ok:true, session_id, title, project_id, preferred_model, reasoning_effort, lockdown, message_id}
//  | {ok:false, reason: 'unknown_fork' | 'fork_primary' | 'fork_empty'}
function readForkSource(sessionStore, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) return { ok: false, reason: 'unknown_fork' };
  let session;
  try {
    session = sessionStore?.peekSession?.(sessionId) || null;
  } catch {
    session = null;
  }
  if (!session || typeof session !== 'object') return { ok: false, reason: 'unknown_fork' };
  if (isPrimaryRole(session)) return { ok: false, reason: 'fork_primary' };
  const messageId = lastBranchableMessageId(session.messages);
  if (!messageId) return { ok: false, reason: 'fork_empty' };
  return {
    ok: true,
    session_id: sessionId,
    title: typeof session.title === 'string' ? session.title : '',
    project_id: blankToNull(session.project_id),
    preferred_model: blankToNull(session.preferred_model),
    reasoning_effort: blankToNull(session.reasoning_effort),
    lockdown: session.lockdown === true,
    message_id: messageId,
  };
}

// The primary_chat_placement kill switch; undefined means on.
const forkingEnabled = (featureFlags) => featureFlags?.primary_chat_placement !== false;

module.exports = { forkingEnabled, lastBranchableMessageId, readForkSource };
