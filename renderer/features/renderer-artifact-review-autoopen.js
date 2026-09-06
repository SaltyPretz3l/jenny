/**
 * renderer/features/renderer-artifact-review-autoopen.js
 *
 * Artifact-review auto-presentation controller (UMD). Hooked from the
 * per-render artifact-review pass because artifacts are render-time-derived.
 * Presents the panel at most once per session (FIFO <=50 session ids, never
 * persisted), respects sticky dismissal and persisted open/collapsed state,
 * and selects the newest artifact without expanding or animating the panel.
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
      getActiveSessionId = () => '',
      getArtifactReviewState = () => null,
      saveArtifactReviewPreferences = noop,
      isArtifactReviewEligible = () => false,
      getArtifactCount = () => 0,
      getAutoOpenedSessionIds = () => [],
      setAutoOpenedSessionIds = noop,
      selectNewestArtifact = () => '',
      appendClientLog = noop,
    } = deps || {};

    let disposed = false;

    function maybeAutoOpen() {
      if (disposed) {
        return false;
      }
      const sessionId = String(getActiveSessionId() || '').trim();
      if (!sessionId) {
        return false;
      }
      const prefs = getArtifactReviewState();
      if (!prefs || prefs.userDismissed === true) {
        return false;
      }
      const openedIds = getAutoOpenedSessionIds();
      const opened = Array.isArray(openedIds) ? openedIds : [];
      if (opened.includes(sessionId)) {
        return false;
      }
      if (!(Number(getArtifactCount()) >= 1)) {
        return false;
      }
      if (isArtifactReviewEligible() !== true) {
        return false;
      }

      const wasEnabled = prefs.enabled === true;
      prefs.enabled = true;
      // The first automatic presentation starts collapsed. Once the user has
      // enabled the panel, their persisted open/collapsed choice is authoritative.
      if (!wasEnabled) {
        prefs.collapsed = true;
      }

      const next = opened.concat(sessionId);
      while (next.length > AUTO_OPENED_SESSION_FIFO_LIMIT) {
        next.shift();
      }
      setAutoOpenedSessionIds(next);
      const newestArtifactId = String(selectNewestArtifact() || '').trim();
      saveArtifactReviewPreferences();
      appendClientLog('INFO', 'artifacts.review_auto_presented', {
        artifactId: newestArtifactId,
        source: 'auto-present-collapsed',
      });
      return true;
    }

    function dispose() {
      disposed = true;
    }

    return { maybeAutoOpen, dispose };
  }

  return { createArtifactReviewAutoOpen };
});
