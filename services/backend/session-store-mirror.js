function isSessionStoreLike(store) {
  return Boolean(
    store
    && typeof store === 'object'
    && typeof store._read === 'function'
    && typeof store._write === 'function'
  );
}

function persistSessionToStore(store, session) {
  if (!isSessionStoreLike(store)) {
    throw new Error('Session store is unavailable.');
  }
  const sessionId = String(session?.id || '').trim();
  if (!sessionId) {
    throw new Error('Session id is required.');
  }
  const payload = store._read();
  const sessions =
    payload.sessions && typeof payload.sessions === 'object' && !Array.isArray(payload.sessions)
      ? payload.sessions
      : {};
  payload.sessions = sessions;
  sessions[sessionId] = session;
  if (store._write(payload) === false) {
    throw new Error('session_persist_failed');
  }
  return session;
}

function persistSessionWithShadow(sessionStore, session, { shadowStore = null } = {}) {
  persistSessionToStore(sessionStore, session);
  if (shadowStore && shadowStore !== sessionStore && isSessionStoreLike(shadowStore)) {
    try {
      persistSessionToStore(shadowStore, session);
    } catch (error) {
      if (error?.message !== 'session_persist_failed') throw error;
    }
  }
  return typeof sessionStore._toSummary === 'function'
    ? sessionStore._toSummary(session)
    : session;
}

module.exports = {
  persistSessionToStore,
  persistSessionWithShadow,
};
