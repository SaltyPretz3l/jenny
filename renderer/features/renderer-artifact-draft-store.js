/* renderer/features/renderer-artifact-draft-store.js
 *
 * Dirty drafts are keyed by sessionId::artifactId, restored once, pruned with
 * session caches, and cleared on reset or disposal.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactDraftStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function draftKey(sessionId, artifactId) {
    const session = String(sessionId || '').trim();
    const artifact = String(artifactId || '').trim();
    return session && artifact ? `${session}::${artifact}` : '';
  }

  function createArtifactDraftStore() {
    const drafts = new Map();

    function stash(sessionId, artifactId, value) {
      const key = draftKey(sessionId, artifactId);
      if (!key) return false;
      drafts.set(key, String(value == null ? '' : value));
      return true;
    }

    function has(sessionId, artifactId) {
      const key = draftKey(sessionId, artifactId);
      return Boolean(key) && drafts.has(key);
    }

    // Single-use restore: once a stashed draft is taken back out for the
    // artifact it belongs to, it is removed — the live editor buffer is now
    // the sole owner of that content again.
    function take(sessionId, artifactId) {
      const key = draftKey(sessionId, artifactId);
      if (!key || !drafts.has(key)) return null;
      const value = drafts.get(key);
      drafts.delete(key);
      return value;
    }

    function discard(sessionId, artifactId) {
      const key = draftKey(sessionId, artifactId);
      if (!key) return false;
      return drafts.delete(key);
    }

    function pruneToAllowedSessions(allowedSessionIds) {
      const allowed = allowedSessionIds instanceof Set
        ? allowedSessionIds
        : new Set((Array.isArray(allowedSessionIds) ? allowedSessionIds : []).map((entry) => String(entry || '').trim()).filter(Boolean));
      for (const key of [...drafts.keys()]) {
        const sessionId = key.split('::')[0] || '';
        if (!allowed.has(sessionId)) drafts.delete(key);
      }
    }

    function clear() {
      drafts.clear();
    }

    function size() {
      return drafts.size;
    }

    return { stash, has, take, discard, pruneToAllowedSessions, clear, size };
  }

  return { createArtifactDraftStore };
});
