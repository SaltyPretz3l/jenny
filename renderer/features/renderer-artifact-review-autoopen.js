/**
 * renderer/features/renderer-artifact-review-autoopen.js
 *
 * Artifact-review auto-presentation controller (UMD). Hooked from the
 * per-render artifact-review pass because artifacts are render-time-derived.
 * With the appearance opt-in enabled, presents at most once per session (FIFO <=50 session ids, never
 * persisted): the first artifact in a chat opens the panel expanded and
 * selects the newest artifact, unless the user closed the panel in that chat
 * (prefs.dismissedForSession, D1). There is no global dismissal. Only an
 * artifact produced during this run presents (owner decision 2026-09-29): a
 * chat reopened after a restart keeps its older artifacts closed until one
 * arrives; the strip toggle still opens them on demand.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactReviewAutoopen = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const AUTO_OPENED_SESSION_FIFO_LIMIT = 50;

  function noop() {}

  function createArtifactReviewAutoOpen(deps) {
    const {
      isAutoOpenEnabled = () => false,
      getActiveSessionId = () => '',
      getArtifactReviewState = () => null,
      saveArtifactReviewPreferences = noop,
      isArtifactReviewEligible = () => false,
      // The chat's artifacts; one timestamped at or after `runStartedAt` (or
      // with no readable time, so a live one is never held back) is new.
      getArtifacts = () => [],
      runStartedAt = Date.now(),
      getAutoOpenedSessionIds = () => [],
      setAutoOpenedSessionIds = noop,
      selectNewestArtifact = () => '',
      appendClientLog = noop,
      // Split view W3-2: told the session after a successful presentation, so
      // the side panel owner can claim it (a no-op with one pane).
      onAutoOpened = noop,
    } = deps || {};

    let disposed = false;

    function isFromThisRun(artifact) {
      const time = Date.parse(String(artifact?.timestamp || ''));
      return !Number.isFinite(time) || time >= runStartedAt;
    }

    // Spends the chat's one presentation without presenting (FIFO bounded).
    function markPresented(sessionId) {
      const id = String(sessionId || '').trim();
      const openedIds = getAutoOpenedSessionIds();
      const opened = Array.isArray(openedIds) ? openedIds : [];
      if (!id || opened.includes(id)) return false;
      const next = opened.concat(id);
      while (next.length > AUTO_OPENED_SESSION_FIFO_LIMIT) {
        next.shift();
      }
      setAutoOpenedSessionIds(next);
      return true;
    }

    function maybeAutoOpen() {
      if (isAutoOpenEnabled() !== true) return false;
      if (disposed) {
        return false;
      }
      const sessionId = String(getActiveSessionId() || '').trim();
      if (!sessionId) {
        return false;
      }
      const prefs = getArtifactReviewState();
      if (!prefs || prefs.dismissedForSession?.[sessionId] === true) {
        return false;
      }
      const openedIds = getAutoOpenedSessionIds();
      const opened = Array.isArray(openedIds) ? openedIds : [];
      if (opened.includes(sessionId)) {
        return false;
      }
      const artifacts = getArtifacts();
      if (!Array.isArray(artifacts) || !artifacts.some(isFromThisRun)) {
        return false;
      }
      if (isArtifactReviewEligible() !== true) {
        return false;
      }

      // A rail the user has open on Tasks (or a file preview) is theirs: do
      // not swap it out. Closing it spends the presentation (the rail's
      // close marks the chat presented), so the Close is never undone.
      const mode = String(prefs.mode || 'artifact');
      if (prefs.enabled === true && mode !== 'artifact') {
        return false;
      }

      // The first automatic presentation opens the panel expanded, showing
      // the artifact: a closed rail last left on Tasks would otherwise reopen
      // on Tasks.
      prefs.enabled = true;
      prefs.mode = 'artifact';

      markPresented(sessionId);
      const newestArtifactId = String(selectNewestArtifact() || '').trim();
      saveArtifactReviewPreferences();
      appendClientLog('INFO', 'artifacts.review_auto_presented', {
        artifactId: newestArtifactId,
        source: 'auto-present-expanded',
      });
      onAutoOpened(sessionId);
      return true;
    }

    function dispose() {
      disposed = true;
    }

    return { maybeAutoOpen, markPresented, dispose };
  }

  return { createArtifactReviewAutoOpen };
});
