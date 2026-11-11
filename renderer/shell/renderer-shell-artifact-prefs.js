/* renderer/shell/renderer-shell-artifact-prefs.js - the shell's reader of the artifact review preferences.
 *
 * Split out of renderer-shell-artifact-bridge.js (which builds one reader per bridge): the normalizers for
 * the persisted review-panel preferences and the cached localStorage read behind
 * getArtifactReviewPreferenceState.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererShellArtifactPrefs = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createArtifactReviewPrefsReader(deps) {
    const { state, windowRef, ARTIFACT_REVIEW_STORAGE_KEY } = deps;
    // Cache the parsed review prefs keyed by the raw stored string. renderAll (per
    // streaming frame, while the surface controller is still null) re-reads this;
    // keying on the literal stored value means a write here or in another window
    // is picked up on the next read, so the cache only ever skips re-parsing an
    // unchanged blob -- it cannot go stale.
    let cachedReviewPrefsRaw = null;
    let cachedReviewPrefs = null;
    // Artifact Panel V2: per-entry validation for the per-session width map —
    // non-empty string key, finite positive number, clamped to the static
    // 320..560 range; malformed entries dropped; oversized maps trimmed to the
    // newest 40 (matching the prefs module's oldest-first eviction).
    function normalizeArtifactReviewWidthBySession(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const normalized = {};
      for (const key of Object.keys(source)) {
        const sessionId = String(key || '').trim();
        const numeric = Number(source[key]);
        if (!sessionId || !Number.isFinite(numeric) || numeric <= 0) continue;
        normalized[sessionId] = Math.max(320, Math.min(560, Math.round(numeric)));
      }
      const keys = Object.keys(normalized);
      for (let i = 0; i < keys.length - 40; i += 1) {
        delete normalized[keys[i]];
      }
      return normalized;
    }

    function normalizeArtifactReviewMaximizedBySession(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const normalized = {};
      for (const key of Object.keys(source)) {
        const sessionId = String(key || '').trim();
        if (sessionId && source[key] === true) normalized[sessionId] = true;
      }
      const keys = Object.keys(normalized);
      for (let i = 0; i < keys.length - 40; i += 1) delete normalized[keys[i]];
      return normalized;
    }

    function normalizeArtifactReviewPreferences(value) {
      const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
      const textWrap = source.textWrap && typeof source.textWrap === 'object' ? source.textWrap : {};
      const normalized = {
        // One closed state: a retired `collapsed: true` reads as closed.
        enabled: source.enabled === true && source.collapsed !== true,
        width: Math.max(320, Math.min(560, Math.round(Number(source.width || 420) || 420))),
        // Must stay in lockstep with the manager-side normalizer
        // (renderer-artifact-review-prefs.js, wired through
        // renderer-artifacts-utils.js): the two drifting is the named auto-open
        // desync failure mode. The lockstep covers widthBySession (Artifact
        // Panel V2), the per-chat dismissal (shell chrome area 3, D1) and the
        // per-kind wrap: stripping any here would make the next save lose it.
        // The retired global `userDismissed` is ignored, never carried.
        textWrap: { output: source.textWrap === false ? false : textWrap.output !== false, code: source.textWrap === false ? false : textWrap.code !== false },
      };
      const widthBySession = normalizeArtifactReviewWidthBySession(source.widthBySession);
      if (Object.keys(widthBySession).length > 0) {
        normalized.widthBySession = widthBySession;
      }
      const dismissedForSession = normalizeArtifactReviewMaximizedBySession(source.dismissedForSession);
      if (Object.keys(dismissedForSession).length > 0) normalized.dismissedForSession = dismissedForSession;
      const maximizedBySession = normalizeArtifactReviewMaximizedBySession(source.maximizedBySession);
      if (Object.keys(maximizedBySession).length > 0) normalized.maximizedBySession = maximizedBySession;
      return normalized;
    }

    function loadArtifactReviewPreferences() {
      try {
        const raw = windowRef?.localStorage?.getItem?.(ARTIFACT_REVIEW_STORAGE_KEY) ?? null;
        if (raw === cachedReviewPrefsRaw && cachedReviewPrefs) {
          return cachedReviewPrefs;
        }
        cachedReviewPrefsRaw = raw;
        cachedReviewPrefs = normalizeArtifactReviewPreferences(raw ? JSON.parse(raw) : {});
        return cachedReviewPrefs;
      } catch (_error) {
        cachedReviewPrefsRaw = null;
        cachedReviewPrefs = null;
        return normalizeArtifactReviewPreferences({});
      }
    }

    function getArtifactReviewPreferenceState() {
      const existing = state.ui?.artifactReview && typeof state.ui.artifactReview === 'object'
        ? state.ui.artifactReview
        : {};
      state.ui.artifactReview = normalizeArtifactReviewPreferences({
        ...existing,
        ...loadArtifactReviewPreferences(),
      });
      return state.ui.artifactReview;
    }

    return { getArtifactReviewPreferenceState };
  }

  return { createArtifactReviewPrefsReader };
});
