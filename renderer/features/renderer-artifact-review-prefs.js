/**
 * renderer/features/renderer-artifact-review-prefs.js
 *
 * Artifact-review preference helpers (UMD), including per-session panel widths.
 *
 * Persisted shape (localStorage `jenny.artifactReview.v1`):
 *   { enabled, width, textWrap: { output, code }, widthBySession?, dismissedForSession? }
 * Schema step (shell-chrome area 3, migrateArtifactReviewPreferences):
 *   - the global sticky `userDismissed` is removed and ignored on load; Close
 *     records `dismissedForSession[sessionId]` instead (same 40-session cap);
 *   - `collapsed` merged into the one closed state (`enabled: false`);
 *   - `maximizedBySession` is session-local (kept in memory, never persisted);
 *   - `textWrap` is one wrap state per body kind, wrapped by default.
 * `widthBySession` ({ [sessionId]: clampedWidth }) is OPTIONAL and only
 * written when non-empty. A width drag writes the session entry AND the
 * global seed, so new chats open at the last width. Entries are statically
 * clamped to the 320..4000
 * persistence-sanity range; the real 90%-of-stage bound applies at resolve
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
  // Renderer boot: rewrite a pre-schema blob before any reader parses it.
  root.rendererArtifactReviewPrefs.migrateArtifactReviewPreferencesStorage(root, root.rendererArtifactReviewPrefs.ARTIFACT_REVIEW_STORAGE_KEY);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // The one localStorage key for these prefs (the manager's rail and the shell bridge read it from here).
  const ARTIFACT_REVIEW_STORAGE_KEY = 'jenny.artifactReview.v1';
  const ARTIFACT_REVIEW_DEFAULT_WIDTH = 420;
  const ARTIFACT_REVIEW_MIN_WIDTH = 320;
  // 4000 is a persistence-sanity ceiling, not a layout cap. Saved wide values
  // must survive narrow windows.
  const ARTIFACT_REVIEW_MAX_WIDTH = 4000;
  const ARTIFACT_REVIEW_WIDTH_WINDOW_FRACTION = 0.9;
  // 320px composer floor + 10px resizer + 30px slack.
  const ARTIFACT_REVIEW_CHAT_COLUMN_RESERVE = 360;
  const ARTIFACT_REVIEW_WIDTH_SESSION_LIMIT = 40;
  // Keys a pre-schema blob may carry that the current schema no longer persists.
  const RETIRED_PERSISTED_KEYS = ['userDismissed', 'collapsed', 'maximizedBySession', 'mode'];

  function clampArtifactReviewWidth(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return ARTIFACT_REVIEW_DEFAULT_WIDTH;
    return Math.max(ARTIFACT_REVIEW_MIN_WIDTH, Math.min(ARTIFACT_REVIEW_MAX_WIDTH, Math.round(numeric)));
  }

  // The applied maximum uses chat stage width (workspace minus sidebar), with
  // window width only as a fallback. An unknown/degenerate width yields the
  // sanity ceiling rather than a hard cap: better to keep the user's stored
  // width than to shrink the rail because the measurement was unavailable.
  function resolveArtifactReviewMaxWidth(availableWidth, reserve = ARTIFACT_REVIEW_CHAT_COLUMN_RESERVE) {
    const numeric = Number(availableWidth);
    if (!Number.isFinite(numeric) || numeric <= 0) return ARTIFACT_REVIEW_MAX_WIDTH;
    return Math.max(
      ARTIFACT_REVIEW_MIN_WIDTH,
      Math.min(
        Math.floor(numeric * ARTIFACT_REVIEW_WIDTH_WINDOW_FRACTION),
        Math.floor(numeric - reserve)
      )
    );
  }

  function normalizeArtifactReviewMode(value) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'code_review') return 'code_review';
    // Read-only chat-rail file preview (renderer-artifact-file-preview.js).
    if (raw === 'file_preview') return 'file_preview';
    if (raw === 'tasks') return 'tasks';
    // The Subagent Monitor rail (renderer-subagent-rail.js). Renderer-local like every
    // mode; loadArtifactReviewPreferences never restores it, so a restart cannot
    // reopen an empty monitor.
    if (raw === 'subagents') return 'subagents';
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

  // A per-session `true`-only map (maximize, dismissal): non-empty string
  // keys, trimmed to the NEWEST 40 entries like widthBySession.
  function normalizeArtifactReviewSessionFlags(value) {
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

  const normalizeArtifactReviewMaximizedBySession = normalizeArtifactReviewSessionFlags;

  // One wrap state per body kind: `output` (tool output) and `code` (editor,
  // source view, file preview). Wrapped by default. The pre-schema
  // renderer-local boolean (`textWrap: false`) maps onto both kinds.
  function normalizeArtifactReviewTextWrap(value) {
    if (value === false) return { output: false, code: false };
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return { output: source.output !== false, code: source.code !== false };
  }

  function normalizeArtifactReviewPreferences(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalized = {
      // One closed state: a retired `collapsed: true` reads as closed.
      enabled: source.enabled === true && source.collapsed !== true,
      width: clampArtifactReviewWidth(source.width),
      // Mode is renderer-local, never persisted (saveArtifactReviewPreferences).
      mode: normalizeArtifactReviewMode(source.mode),
      textWrap: normalizeArtifactReviewTextWrap(source.textWrap),
    };
    const widthBySession = normalizeArtifactReviewWidthBySession(source.widthBySession);
    if (Object.keys(widthBySession).length > 0) {
      normalized.widthBySession = widthBySession;
    }
    const dismissedForSession = normalizeArtifactReviewSessionFlags(source.dismissedForSession);
    if (Object.keys(dismissedForSession).length > 0) normalized.dismissedForSession = dismissedForSession;
    // Session-local (in memory only): the saver never writes it.
    const maximizedBySession = normalizeArtifactReviewSessionFlags(source.maximizedBySession);
    if (Object.keys(maximizedBySession).length > 0) normalized.maximizedBySession = maximizedBySession;
    return normalized;
  }

  // Explicit schema step for a persisted blob: the global sticky dismissal is
  // dropped (ignored, not converted: the new dismissal is per chat), a
  // collapsed panel becomes the one closed state, and a persisted maximize or
  // mode is not restored. Everything else carries over unchanged.
  function migrateArtifactReviewPreferences(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const migrated = { ...source };
    if (migrated.collapsed === true) migrated.enabled = false;
    for (const key of RETIRED_PERSISTED_KEYS) delete migrated[key];
    return migrated;
  }

  function loadArtifactReviewPreferences(windowRef, storageKey) {
    try {
      const raw = windowRef?.localStorage?.getItem?.(storageKey) ?? null;
      return normalizeArtifactReviewPreferences(migrateArtifactReviewPreferences(raw ? JSON.parse(raw) : {}));
    } catch (_) {
      return normalizeArtifactReviewPreferences({});
    }
  }

  function saveArtifactReviewPreferences(windowRef, storageKey, prefs) {
    try {
      const source = prefs && typeof prefs === 'object' ? prefs : {};
      const payload = {
        enabled: source.enabled === true && source.collapsed !== true,
        width: clampArtifactReviewWidth(source.width),
        textWrap: normalizeArtifactReviewTextWrap(source.textWrap),
      };
      // Optional maps, written only when non-empty.
      const widthBySession = normalizeArtifactReviewWidthBySession(source.widthBySession);
      if (Object.keys(widthBySession).length > 0) {
        payload.widthBySession = widthBySession;
      }
      const dismissedForSession = normalizeArtifactReviewSessionFlags(source.dismissedForSession);
      if (Object.keys(dismissedForSession).length > 0) payload.dismissedForSession = dismissedForSession;
      windowRef.localStorage.setItem(storageKey, JSON.stringify(payload));
    } catch (_) {
      /* ignore localStorage failures */
    }
  }

  // One-time storage rewrite of a pre-schema blob, run when the module loads in
  // the renderer so every reader of the raw blob (including the shell bridge's
  // own mirrored normalizer) stops seeing the retired keys. True only when it wrote.
  function migrateArtifactReviewPreferencesStorage(windowRef, storageKey) {
    try {
      const raw = windowRef?.localStorage?.getItem?.(storageKey) ?? null;
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
      if (!RETIRED_PERSISTED_KEYS.some((key) => key in parsed) && 'textWrap' in parsed) return false;
      saveArtifactReviewPreferences(windowRef, storageKey, normalizeArtifactReviewPreferences(migrateArtifactReviewPreferences(parsed)));
      return true;
    } catch (_) {
      return false;
    }
  }

  // Effective panel width for a session:
  // widthBySession[sessionId] ?? the global width (the seed a drag keeps
  // current). The APPLIED clamp is min 320, max = resolveArtifactReviewMaxWidth(stage)
  // (90% of the stage, less the reserve): the bound is a layout property of the rail.
  function resolveEffectiveArtifactReviewWidth(prefs, sessionId, options) {
    const globalWidth = clampArtifactReviewWidth(prefs?.width);
    const stageWidth = options?.stageWidth;
    const max = resolveArtifactReviewMaxWidth(
      Number.isFinite(stageWidth) && stageWidth > 0 ? stageWidth : options?.windowWidth,
      options?.reserve
    );
    const key = String(sessionId || '').trim();
    const map = prefs?.widthBySession;
    const stored = key && map && typeof map === 'object' && !Array.isArray(map) ? Number(map[key]) : NaN;
    const base = Number.isFinite(stored) && stored > 0 ? clampArtifactReviewWidth(stored) : globalWidth;
    return Math.max(ARTIFACT_REVIEW_MIN_WIDTH, Math.min(max, base));
  }

  // Width write path. Writes widthBySession[sessionId] (statically clamped)
  // and the global `width` seed, so a chat without its own entry (a new one)
  // opens at the last width. Inserting a 41st session evicts the oldest entries.
  function recordArtifactReviewWidth(prefs, sessionId, width) {
    const clamped = clampArtifactReviewWidth(width);
    if (!prefs || typeof prefs !== 'object') return clamped;
    prefs.width = clamped;
    const key = String(sessionId || '').trim();
    if (!key) return clamped;
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

  // Shared writer for the `true`-only session maps: inserting a 41st session
  // evicts the oldest; clearing the last entry drops the key.
  function recordSessionFlag(prefs, property, sessionId, value) {
    if (!prefs || typeof prefs !== 'object') return false;
    const key = String(sessionId || '').trim();
    if (!key) return false;
    const map = normalizeArtifactReviewSessionFlags(prefs[property]);
    if (value === true) {
      if (!(key in map)) {
        const keys = Object.keys(map);
        for (let i = 0; i <= keys.length - ARTIFACT_REVIEW_WIDTH_SESSION_LIMIT; i += 1) delete map[keys[i]];
      }
      map[key] = true;
    } else {
      delete map[key];
    }
    if (Object.keys(map).length > 0) prefs[property] = map;
    else delete prefs[property];
    return value === true;
  }

  function resolveArtifactReviewMaximized(prefs, sessionId) {
    const key = String(sessionId || '').trim();
    return Boolean(key && prefs?.maximizedBySession?.[key] === true);
  }

  function recordArtifactReviewMaximized(prefs, sessionId, maximized) {
    return recordSessionFlag(prefs, 'maximizedBySession', sessionId, maximized);
  }

  function resolveArtifactReviewDismissed(prefs, sessionId) {
    const key = String(sessionId || '').trim();
    return Boolean(key && prefs?.dismissedForSession?.[key] === true);
  }

  // D1 close: remembered for this chat only; an explicit open clears it.
  function recordArtifactReviewDismissed(prefs, sessionId, dismissed) {
    return recordSessionFlag(prefs, 'dismissedForSession', sessionId, dismissed);
  }

  function normalizeTextWrapKind(kind) { return kind === 'output' ? 'output' : 'code'; }

  function resolveArtifactReviewTextWrap(prefs, kind) {
    return normalizeArtifactReviewTextWrap(prefs?.textWrap)[normalizeTextWrapKind(kind)];
  }

  function setArtifactReviewTextWrap(prefs, kind, wrapped) {
    const next = normalizeArtifactReviewTextWrap(prefs?.textWrap);
    next[normalizeTextWrapKind(kind)] = wrapped !== false;
    if (prefs && typeof prefs === 'object') prefs.textWrap = next;
    return next[normalizeTextWrapKind(kind)];
  }

  function pruneArtifactReviewSessionPreferences(prefs, validSessionIds) {
    if (!prefs || typeof prefs !== 'object') return prefs;
    const allowed = new Set((Array.isArray(validSessionIds) ? validSessionIds : [])
      .map((entry) => String(entry || '').trim()).filter(Boolean));
    for (const property of ['widthBySession', 'maximizedBySession', 'dismissedForSession']) {
      const source = prefs[property];
      if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
      for (const key of Object.keys(source)) if (!allowed.has(key)) delete source[key];
      if (Object.keys(source).length === 0) delete prefs[property];
    }
    return prefs;
  }

  // Moves a session's per-chat entries (width, maximize, Close) to its new id
  // when a draft chat is rekeyed; an entry already under the new id is replaced.
  function rekeyArtifactReviewSessionPreferences(prefs, fromSessionId, toSessionId) {
    const from = String(fromSessionId || '').trim();
    const to = String(toSessionId || '').trim();
    if (!prefs || typeof prefs !== 'object' || !from || !to || from === to) return prefs;
    for (const property of ['widthBySession', 'maximizedBySession', 'dismissedForSession']) {
      const source = prefs[property];
      if (!source || typeof source !== 'object' || Array.isArray(source) || !(from in source)) continue;
      const value = source[from];
      delete source[from];
      delete source[to];
      source[to] = value;
    }
    return prefs;
  }

  return {
    ARTIFACT_REVIEW_STORAGE_KEY,
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
    normalizeArtifactReviewSessionFlags,
    normalizeArtifactReviewTextWrap,
    normalizeArtifactReviewPreferences,
    migrateArtifactReviewPreferences,
    migrateArtifactReviewPreferencesStorage,
    loadArtifactReviewPreferences,
    saveArtifactReviewPreferences,
    resolveEffectiveArtifactReviewWidth,
    recordArtifactReviewWidth,
    resolveArtifactReviewMaximized,
    recordArtifactReviewMaximized,
    resolveArtifactReviewDismissed,
    recordArtifactReviewDismissed,
    resolveArtifactReviewTextWrap,
    setArtifactReviewTextWrap,
    pruneArtifactReviewSessionPreferences,
    rekeyArtifactReviewSessionPreferences,
  };
});
