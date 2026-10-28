'use strict';

// Row 69: the profile's one primary chat ("Jenny"). The durable marker is the
// session field `session_role` (schema 26; 'primary' or null). This module owns
// its normalizer, the lazy ensure step run after startup, and the protections
// (never deleted, archived, swept or moved out of General). Nothing here is
// reachable from sessions.create: only the internal ensure path mints a primary.

const { GENERAL_PROJECT_ID } = require('../projects/project-schema');

const PRIMARY_SESSION_ROLE = 'primary';
const PRIMARY_SESSION_TITLE = 'Jenny';
const PRIMARY_PROTECTED = 'primary_protected';

function normalizeSessionRole(value) {
  return value === PRIMARY_SESSION_ROLE ? PRIMARY_SESSION_ROLE : null;
}

// Whether a session summary or record is the primary chat (its stored role, whatever the flags).
function isPrimaryRole(summary) {
  return normalizeSessionRole(summary?.session_role) === PRIMARY_SESSION_ROLE;
}

// The primary_chat kill switch (JENNY_ENABLE_PRIMARY_CHAT=0) turns every primary behaviour off.
function primaryChatEnabled(featureFlags) {
  return featureFlags?.primary_chat !== false;
}

// Primaries oldest first (then by id), so "keep the oldest" is deterministic.
function findPrimarySessions(summaries) {
  return (Array.isArray(summaries) ? summaries : [])
    .filter((summary) => summary && typeof summary.id === 'string' && summary.id
      && isPrimaryRole(summary))
    .sort((left, right) => String(left.created_at || '').localeCompare(String(right.created_at || ''))
      || left.id.localeCompare(right.id));
}

function emit(log, level, event, details) {
  try {
    if (typeof log === 'function') log(level, event, details);
  } catch (_error) {
    // logging must never throw
  }
}

// Demotion writes only the role, without a recency bump, through the store's
// private meta seam (generic updateSession and setSessionMeta never carry it).
function demoteSession(sessionStore, sessionId) {
  return Boolean(sessionStore._updateSessionRecord(sessionId, { session_role: null }, { bumpUpdatedAt: false }));
}

async function ensurePrimarySession({ sessionStore, createSession, featureFlags, log } = {}) {
  const none = { session_id: null, created: false, demoted: [] };
  if (!primaryChatEnabled(featureFlags)) return none;
  try {
    const [keep, ...extra] = findPrimarySessions(sessionStore.listSessions());
    if (keep) {
      const demoted = extra.filter((summary) => demoteSession(sessionStore, summary.id)).map((summary) => summary.id);
      if (extra.length) {
        emit(log, 'WARN', 'primary_session.duplicates_demoted', {
          sessionId: keep.id, demotedIds: demoted, failed: extra.length - demoted.length,
        });
      }
      return { session_id: keep.id, created: false, demoted };
    }
    const result = await createSession({
      title: PRIMARY_SESSION_TITLE, projectId: GENERAL_PROJECT_ID, sessionRole: PRIMARY_SESSION_ROLE,
    });
    const sessionId = typeof result?.data?.id === 'string' ? result.data.id : '';
    if (!sessionId || !isPrimaryRole(result.data)) {
      emit(log, 'WARN', 'primary_session.ensure_failed', { reason: 'create_refused' });
      return none;
    }
    emit(log, 'INFO', 'primary_session.created', { sessionId });
    return { session_id: sessionId, created: true, demoted: [] };
  } catch (error) {
    emit(log, 'WARN', 'primary_session.ensure_failed', {
      reason: 'store_error', errorName: String(error?.name || 'Error').slice(0, 80),
    });
    return none;
  }
}

// Read without a clone where the store allows it (the scheduler asks per admission attempt).
function isPrimarySession(sessionStore, sessionId) {
  const id = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (!id) return false;
  if (typeof sessionStore?.peekSessionSummary === 'function') return isPrimaryRole(sessionStore.peekSessionSummary(id));
  return typeof sessionStore?.getSessionSummary === 'function' && isPrimaryRole(sessionStore.getSessionSummary(id));
}

module.exports = {
  PRIMARY_PROTECTED,
  PRIMARY_SESSION_ROLE,
  PRIMARY_SESSION_TITLE,
  ensurePrimarySession,
  findPrimarySessions,
  isPrimaryRole,
  isPrimarySession,
  normalizeSessionRole,
  primaryChatEnabled,
};
