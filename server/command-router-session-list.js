'use strict';

// sessions.list (split out of command-router.js for slice 3-2): only the
// conversations the caller may read, each re-checked through the one
// authorization function after the awaited read, and `total` is that count.
// On the single-owner host every well-formed row is readable; `total` counts the
// rows returned (before slice 3-2 it also counted rows with no id).
//
// Row 175 F9 (`waitingCounts`, a team host only): each row carries `waiting: { approvals, questions }`, the backend's
// pending approvals and question batches of that conversation at read time, each capped at MAX_WAITING, so a member
// client knows them at connect without waiting for the next event. One pass over each pending map per read; the
// single-owner host's rows keep their keys.

const MAX_WAITING = 64;

// Pending entries per conversation id in one backend map (`sessionId` on each entry), capped per conversation.
function countBySession(map) {
  const counts = new Map();
  if (!(map instanceof Map)) return counts;
  for (const pending of map.values()) {
    const id = typeof pending?.sessionId === 'string' ? pending.sessionId : '';
    if (id) counts.set(id, Math.min(MAX_WAITING, (counts.get(id) ?? 0) + 1));
  }
  return counts;
}

function createSessionList({ backend, identity, allows, safeSession, safeBackendError, waitingCounts = false }) {
  return async function listSessions(command, context) {
    try {
      const value = await backend.listSessions();
      const failure = identity(command, context);
      if (failure) return failure;
      const data = Array.isArray(value?.data) ? value.data : (Array.isArray(value) ? value : []);
      const sessions = data.map(safeSession).filter((session) => session
        && allows(command, context, 'session.read', { kind: 'session', id: session.session_id }));
      if (waitingCounts) {
        const approvals = countBySession(backend.pendingToolApprovals);
        const questions = countBySession(backend.pendingUserQuestions);
        for (const session of sessions) {
          session.waiting = { approvals: approvals.get(session.session_id) ?? 0,
            questions: questions.get(session.session_id) ?? 0 };
        }
      }
      return { ok: true, sessions, total: sessions.length };
    } catch (error) { return safeBackendError(error, command.request_id); }
  };
}

module.exports = { MAX_WAITING, createSessionList };
