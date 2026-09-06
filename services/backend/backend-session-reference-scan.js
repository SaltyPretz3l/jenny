'use strict';

// Session enumeration and payload-reference collection for the delete-cleanup
// path. Split out of backend-sessions.js when that file reached its 1015-line
// ceiling. These belong together: they answer one question -- 'which sessions
// still exist, and which externalized payloads do they reference' -- and every
// one of them is failure-sensitive in the same direction, because a reference
// this code fails to report becomes a file the caller deletes.

const { payloadPathsFromMessages } = require('./ipc-payload-retention');

function readStoreMessages(store, methodName, sessionId) {
  if (!store) {
    return [];
  }
  if (typeof store[methodName] !== 'function') {
    throw new Error('Session message reader is unavailable.');
  }
  return store[methodName](sessionId);
}

function listCanonicalSessionIds(service) {
  if (!service.sessionStore) {
    return [];
  }
  if (typeof service.sessionStore.listSessions !== 'function') {
    throw new Error('Canonical session enumeration is unavailable.');
  }
  const sessions = service.sessionStore.listSessions();
  if (!Array.isArray(sessions)) {
    throw new Error('Canonical session enumeration returned an invalid result.');
  }
  return sessions.map((session) => String(session?.id || '').trim()).filter(Boolean);
}

function listShadowSessionIds(service) {
  if (!service.shadowStore) {
    return [];
  }
  if (typeof service.shadowStore.summarize !== 'function') {
    throw new Error('Shadow session enumeration is unavailable.');
  }
  const summaries = service.shadowStore.summarize();
  if (!summaries || typeof summaries !== 'object' || Array.isArray(summaries)) {
    throw new Error('Shadow session enumeration returned an invalid result.');
  }
  return Object.entries(summaries)
    .map(([sessionId, session]) => String(session?.id || sessionId || '').trim())
    .filter(Boolean);
}

// The payload analogue of collectDeletedSessionAssetPaths / the Remaining one
// below. Both stores are read for the same reason the asset collectors read
// both: a session can carry messages in the shadow store that the canonical
// store does not have, and `collectRemainingSessionIds` already unions ids from
// BOTH -- so reading every one of those ids from the canonical store alone
// silently answers `[]` for shadow-only sessions and under-counts references.
function collectDeletedSessionPayloadKeys(service, sessionId) {
  return new Set([
    ...payloadPathsFromMessages(
      readStoreMessages(service.sessionStore, 'getSessionMessages', sessionId)
    ),
    ...payloadPathsFromMessages(
      readStoreMessages(service.shadowStore, 'getMessages', sessionId)
    ),
  ]);
}

// Fail closed on an incomplete read. `getSessionMessages` turns a missing,
// unreadable, or future-schema session into `[]` (electron-session-store.js),
// which is indistinguishable from a genuinely empty session -- except that the
// index summary still reports the real message_count. Pruning against such a
// scan deletes payloads a live session still references, and the delete path
// passes graceMs: 0, so the deletion is immediate. Throwing here degrades the
// cleanup step through recordDeleteCleanupError instead.
function collectRemainingReferencedPayloadKeys(service, deletedSessionId) {
  const referenced = new Set();
  const canonicalCounts = new Map(
    (typeof service.sessionStore?.listSessions === 'function'
      ? service.sessionStore.listSessions()
      : []
    ).map((session) => [String(session?.id || '').trim(), Number(session?.message_count || 0)])
  );
  for (const sessionId of listCanonicalSessionIds(service)) {
    if (sessionId === deletedSessionId) {
      continue;
    }
    const messages = readStoreMessages(service.sessionStore, 'getSessionMessages', sessionId);
    if (messages.length === 0 && (canonicalCounts.get(sessionId) || 0) > 0) {
      throw new Error(`session ${sessionId} read empty but the index expects messages`);
    }
    for (const key of payloadPathsFromMessages(messages)) {
      referenced.add(key);
    }
  }
  for (const sessionId of listShadowSessionIds(service)) {
    if (sessionId === deletedSessionId) {
      continue;
    }
    for (const key of payloadPathsFromMessages(
      readStoreMessages(service.shadowStore, 'getMessages', sessionId)
    )) {
      referenced.add(key);
    }
  }
  return referenced;
}

module.exports = {
  collectDeletedSessionPayloadKeys,
  collectRemainingReferencedPayloadKeys,
  listCanonicalSessionIds,
  listShadowSessionIds,
  readStoreMessages,
};
