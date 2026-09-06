/**
 * renderer/features/renderer-artifact-review-prefs.js
 *
 * Artifact-review preference helpers (UMD), including per-session panel widths.
 *
 * Persisted shape (localStorage `jenny.artifactReview.v1`):
 *   { enabled, collapsed, width, userDismissed, widthBySession?, maximizedBySession? }
 * `widthBySession` ({ [sessionId]: clampedWidth }) is OPTIONAL and only
 * written when non-empty, so a flag-off save of a legacy blob round-trips
 * byte-identically. Entries are statically clamped to the 320..4000
 * persistence-sanity range; the real 90%-of-window bound applies at resolve
 * (apply) time only, so a stored width survives a temporarily narrow window
 * instead of being permanently shrunk. NOTE: the mirrored normalizer in
 * renderer/shell/renderer-shell-artifact-bridge.js still hard-codes the old
 * 320..560 clamp. That is benign today (the bridge never WRITES localStorage,
 * and the manager's first ensureArtifactReviewState re-reads the store, whose
 * value wins), but the two should be re-synced when that file is free.
 * The map is bounded at 40 entries with
 * insertion-order (oldest-first) eviction — plain objects preserve string-key
 * insertion order, which suffices because Jenny session ids are non-integer
 * strings. Re-recording an existing session does not refresh its insertion
 * position (eviction is by first-insert age, a deliberate simplification).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererArtifactReviewPrefs = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ARTIFACT_REVIEW_DEFAULT_WIDTH = 420;
  const ARTIFACT_REVIEW_MIN_WIDTH = 320;
  // 4000 is a persistence-sanity ceiling, not a layout cap. Saved wide values
  // must survive narrow windows.
  const ARTIFACT_REVIEW_MAX_WIDTH = 4000;
  const ARTIFACT_REVIEW_WIDTH_WINDOW_FRACTION = 0.9;
  // Reserve 360 pixels for chat, composer, and the resizer.
  const ARTIFACT_REVIEW_CHAT_COLUMN_RESERVE = 360;
  const ARTIFACT_REVIEW_WIDTH_SESSION_LIMIT = 40;

  function clampArtifactReviewWidth(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return ARTIFACT_REVIEW_DEFAULT_WIDTH;
    return Math.max(ARTIFACT_REVIEW_MIN_WIDTH, Math.min(ARTIFACT_REVIEW_MAX_WIDTH, Math.round(numeric)));
  }

  // The applied (layout) maximum. An unknown/degenerate window width yields the
  // sanity ceiling rather than a hard cap: better to keep the user's stored
  // width than to shrink the rail because the measurement was unavailable.
  function resolveArtifactReviewMaxWidth(windowWidth) {
    const numeric = Number(windowWidth);
    if (!Number.isFinite(numeric) || numeric <= 0) return ARTIFACT_REVIEW_MAX_WIDTH;
    return Math.max(
      ARTIFACT_REVIEW_MIN_WIDTH,
      Math.min(
        Math.floor(numeric * ARTIFACT_REVIEW_WIDTH_WINDOW_FRACTION),
        Math.floor(numeric - ARTIFACT_REVIEW_CHAT_COLUMN_RESERVE)
      )
    );
  }

  function normalizeArtifactReviewMode(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'code_review') return 'code_review';
    // Read-only chat-rail file preview (renderer-artifact-file-preview.js).
    if (raw === 'file_preview') return 'file_preview';
    if (raw === 'tasks') return 'tasks';
    return 'artifact';
  }

  // Per-entry validation: non-empty string key, finite positive numeric value
  // (clamped to the 320..4000 sanity range); malformed entries are dropped.
  // Oversized persisted maps are trimmed to the NEWEST 40 entries (matching
  // the oldest-first eviction in recordArtifactReviewWidth).
  function normalizeArtifactReviewWidthBySession(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalized = {};
    for (const key of Object.keys(source)) {
      const sessionId = String(key || '').trim();
      const numeric = Number(source[key]);
      if (!sessionId || !Number.isFinite(numeric) || numeric <= 0) continue;
      normalized[sessionId] = clampArtifactReviewWidth(numeric);
    }
    const keys = Object.keys(normalized);
    for (let i = 0; i < keys.length - ARTIFACT_REVIEW_WIDTH_SESSION_LIMIT; i += 1) {
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
    for (let i = 0; i < keys.length - ARTIFACT_REVIEW_WIDTH_SESSION_LIMIT; i += 1) delete normalized[keys[i]];
    return normalized;
  }

  function normalizeArtifactReviewPreferences(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalized = {
      enabled: source.enabled === true,
      collapsed: source.collapsed === true,
      width: clampArtifactReviewWidth(source.width),
      // Mode is renderer-local, not persisted: enabled/collapsed/width,
      // userDismissed, and widthBySession round-trip through localStorage.
      // See saveArtifactReviewPreferences.
      mode: normalizeArtifactReviewMode(source.mode),
      // WS3: sticky auto-open dismissal. Lockstep contract with the bridge
      // normalizer in renderer-shell-artifact-bridge.js — drift between the
      // two is the named auto-open desync failure mode. That lockstep now
      // also covers widthBySession (Artifact Panel V2): if either normalizer
      // strips it, a later save silently loses all per-session widths.
      userDismissed: source.userDismissed === true,
    };
    const widthBySession = normalizeArtifactReviewWidthBySession(source.widthBySession);
    if (Object.keys(widthBySession).length > 0) {
      normalized.widthBySession = widthBySession;
    }
    const maximizedBySession = normalizeArtifactReviewMaximizedBySession(source.maximizedBySession);
    if (Object.keys(maximizedBySession).length > 0) normalized.maximizedBySession = maximizedBySession;
    return normalized;
  }

  function loadArtifactReviewPreferences(windowRef, storageKey) {
    try {
      const raw = windowRef?.localStorage?.getItem?.(storageKey) ?? null;
      return normalizeArtifactReviewPreferences(raw ? JSON.parse(raw) : {});
    } catch (_) {
      return normalizeArtifactReviewPreferences({});
    }
  }

  function saveArtifactReviewPreferences(windowRef, storageKey, prefs) {
    try {
      const source = prefs && typeof prefs === 'object' ? prefs : {};
      const payload = {
        enabled: source.enabled === true,
        collapsed: source.collapsed === true,
        width: clampArtifactReviewWidth(source.width),
        userDismissed: source.userDismissed === true,
      };
      // Optional key, appended after the legacy fields and only when
      // non-empty: a legacy-only blob round-trips byte-identically flag-off.
      const widthBySession = normalizeArtifactReviewWidthBySession(source.widthBySession);
      if (Object.keys(widthBySession).length > 0) {
        payload.widthBySession = widthBySession;
      }
      const maximizedBySession = normalizeArtifactReviewMaximizedBySession(source.maximizedBySession);
      if (Object.keys(maximizedBySession).length > 0) payload.maximizedBySession = maximizedBySession;
      windowRef.localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch (_) {
      /* ignore localStorage failures */
    }
  }

  // Effective panel width for a session (Artifact Panel V2, flag-gated):
  // widthBySession[sessionId] ?? the legacy global width — the global width
  // IS the migration seed (no migration marker).
  // The APPLIED clamp is min 320, max = resolveArtifactReviewMaxWidth(window)
  // (90% of the window), and it now runs in BOTH flag states: the 90% bound is
  // a layout property of the rail, not a V2 feature. Flag-off still ignores
  // widthBySession and resolves the legacy global width only.
  function resolveEffectiveArtifactReviewWidth(prefs, sessionId, options) {
    const globalWidth = clampArtifactReviewWidth(prefs?.width);
    const max = resolveArtifactReviewMaxWidth(options?.windowWidth);
    if (options?.flagOn !== true) {
      return Math.max(ARTIFACT_REVIEW_MIN_WIDTH, Math.min(max, globalWidth));
    }
    const key = String(sessionId || '').trim();
    const map = prefs?.widthBySession;
    const stored = key && map && typeof map === 'object' && !Array.isArray(map) ? Number(map[key]) : NaN;
    const base = Number.isFinite(stored) && stored > 0 ? clampArtifactReviewWidth(stored) : globalWidth;
    return Math.max(ARTIFACT_REVIEW_MIN_WIDTH, Math.min(max, base));
  }

  // Width write path. Flag-on writes widthBySession[sessionId] (statically
  // clamped) and leaves the global `width` untouched so it stays the fallback
  // seed; flag-off (or no session id) writes the global width — byte-identical
  // legacy behavior. Inserting a 41st session evicts the oldest entries.
  function recordArtifactReviewWidth(prefs, sessionId, width, options) {
    const clamped = clampArtifactReviewWidth(width);
    if (!prefs || typeof prefs !== 'object') return clamped;
    const key = String(sessionId || '').trim();
    if (options?.flagOn !== true || !key) {
      prefs.width = clamped;
      return clamped;
    }
    const map = prefs.widthBySession && typeof prefs.widthBySession === 'object' && !Array.isArray(prefs.widthBySession)
      ? prefs.widthBySession
      : {};
    if (!(key in map)) {
      const keys = Object.keys(map);
      for (let i = 0; i <= keys.length - ARTIFACT_REVIEW_WIDTH_SESSION_LIMIT; i += 1) {
        delete map[keys[i]];
      }
    }
    map[key] = clamped;
    prefs.widthBySession = map;
    return clamped;
  }

  function resolveArtifactReviewMaximized(prefs, sessionId, options) {
    if (options?.flagOn !== true) return false;
    const key = String(sessionId || '').trim();
    return Boolean(key && prefs?.maximizedBySession?.[key] === true);
  }

  function recordArtifactReviewMaximized(prefs, sessionId, maximized, options) {
    if (!prefs || typeof prefs !== 'object' || options?.flagOn !== true) return false;
    const key = String(sessionId || '').trim();
    if (!key) return false;
    const map = normalizeArtifactReviewMaximizedBySession(prefs.maximizedBySession);
    if (maximized === true) {
      if (!(key in map)) {
        const keys = Object.keys(map);
        for (let i = 0; i <= keys.length - ARTIFACT_REVIEW_WIDTH_SESSION_LIMIT; i += 1) delete map[keys[i]];
      }
      map[key] = true;
    } else {
      delete map[key];
    }
    if (Object.keys(map).length > 0) prefs.maximizedBySession = map;
    else delete prefs.maximizedBySession;
    return maximized === true;
  }

  function pruneArtifactReviewSessionPreferences(prefs, validSessionIds) {
    if (!prefs || typeof prefs !== 'object') return prefs;
    const allowed = new Set((Array.isArray(validSessionIds) ? validSessionIds : [])
      .map((entry) => String(entry || '').trim()).filter(Boolean));
    for (const property of ['widthBySession', 'maximizedBySession']) {
      const source = prefs[property];
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      for (const key of Object.keys(source)) if (!allowed.has(key)) delete source[key];
      if (Object.keys(source).length === 0) delete prefs[property];
    }
    return prefs;
  }

  return {
    ARTIFACT_REVIEW_DEFAULT_WIDTH,
    ARTIFACT_REVIEW_MIN_WIDTH,
    ARTIFACT_REVIEW_MAX_WIDTH,
    ARTIFACT_REVIEW_WIDTH_WINDOW_FRACTION,
    ARTIFACT_REVIEW_WIDTH_SESSION_LIMIT,
    clampArtifactReviewWidth,
    resolveArtifactReviewMaxWidth,
    normalizeArtifactReviewMode,
    normalizeArtifactReviewWidthBySession,
    normalizeArtifactReviewMaximizedBySession,
    normalizeArtifactReviewPreferences,
    loadArtifactReviewPreferences,
    saveArtifactReviewPreferences,
    resolveEffectiveArtifactReviewWidth,
    recordArtifactReviewWidth,
    resolveArtifactReviewMaximized,
    recordArtifactReviewMaximized,
    pruneArtifactReviewSessionPreferences,
  };
});
