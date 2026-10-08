'use strict';

// Session-store seam for suggested changes (row 35): restart settlement on read
// and the one write path for the `suggested_changes` field. Generic session
// patches cannot touch the field (ElectronSessionStore.updateSession strips it).

const {
  normalizeSuggestedChanges,
  settleSuggestedChangesAfterRestart,
} = require('./suggested-changes-records');

const SETTLED_SESSIONS = new WeakMap();

// Runs once per session per store backend, i.e. once after each app start,
// before anything in this process can put a change into `revising`.
function settleSuggestedChangesOnRead({ backend, logger, sessionId, session, normalizeSession }) {
  const audited = SETTLED_SESSIONS.get(backend) || new Set();
  SETTLED_SESSIONS.set(backend, audited);
  if (!session || audited.has(sessionId)) return session;
  audited.add(sessionId);
  try {
    const settled = settleSuggestedChangesAfterRestart(normalizeSuggestedChanges(session.suggested_changes));
    if (!settled.changed || backend.hasNewerSchema()) return session;
    const normalized = normalizeSession(sessionId, { ...session, suggested_changes: settled.state });
    if (backend.upsertSession(sessionId, normalized, { persist: true, alreadyNormalized: true })) {
      return normalized;
    }
  } catch (error) {
    logger?.('WARN', 'session_store.suggested_changes_settlement_failed', {
      sessionId, message: String(error?.message || error || '').slice(0, 240),
    });
  }
  audited.delete(sessionId);
  return session;
}

function readSuggestedChanges(store, sessionId) {
  const session = store?.getSession?.(sessionId);
  return session ? normalizeSuggestedChanges(session.suggested_changes) : null;
}

// Writes the whole field without bumping the session's recency. Returns the
// stored state, or null when the session is gone or the store refused the write.
function writeSuggestedChanges(store, sessionId, state) {
  if (!store || typeof store._updateSessionRecord !== 'function') return null;
  const summary = store._updateSessionRecord(
    sessionId,
    { suggested_changes: normalizeSuggestedChanges(state) },
    { bumpUpdatedAt: false }
  );
  return summary ? readSuggestedChanges(store, sessionId) : null;
}

module.exports = {
  normalizeSuggestedChanges,
  readSuggestedChanges,
  settleSuggestedChangesOnRead,
  writeSuggestedChanges,
};
