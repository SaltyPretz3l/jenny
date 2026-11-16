'use strict';

// sessions.list (split out of command-router.js for slice 3-2): only the
// conversations the caller may read, each re-checked through the one
// authorization function after the awaited read, and `total` is that count.
// On the single-owner host every well-formed row is readable; `total` counts the
// rows returned (before slice 3-2 it also counted rows with no id).

function createSessionList({ backend, identity, allows, safeSession, safeBackendError }) {
  return async function listSessions(command, context) {
    try {
      const value = await backend.listSessions();
      const failure = identity(command, context);
      if (failure) return failure;
      const data = Array.isArray(value?.data) ? value.data : (Array.isArray(value) ? value : []);
      const sessions = data.map(safeSession).filter((session) => session
        && allows(command, context, 'session.read', { kind: 'session', id: session.session_id }));
      return { ok: true, sessions, total: sessions.length };
    } catch (error) { return safeBackendError(error, command.request_id); }
  };
}

module.exports = { createSessionList };
