/**
 * renderer/features/renderer-artifact-review-prefs.js
 *
 * Artifact-review preference helpers (UMD).
 *
 * Persisted shape (localStorage `jenny.artifactReview.v1`):
 *   { enabled, textWrap: { output, code, diff }, dismissedForSession? }
 * Schema step (shell-chrome area 3, migrateArtifactReviewPreferences):
 *   - the global sticky `userDismissed` is removed and ignored on load; Close
 *     records `dismissedForSession[sessionId]` instead (capped at 40 sessions);
 *   - `collapsed` merged into the one closed state (`enabled: false`);
 *   - `textWrap` is one wrap state per body kind, wrapped by default;
 *   - the panel's width, per-chat widths and maximize are retired: the room's
 *     right stack owns the panel's size, and an old blob that carries them loads
 *     with those fields ignored (and is rewritten without them at boot).
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
  const ARTIFACT_REVIEW_SESSION_FLAG_LIMIT = 40;
  // Keys a pre-schema blob may carry that the current schema no longer persists.
  const RETIRED_PERSISTED_KEYS = ['userDismissed', 'collapsed', 'maximizedBySession', 'mode', 'width', 'widthBySession'];

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
    // The Project Notes rail (renderer-project-notes-rail.js). Renderer-local like
    // `subagents`: the loader and saver never carry the mode, so a restart cannot
    // reopen the rail.
    if (raw === 'notes') return 'notes';
    // The browser panel (renderer-browser-use-panel.js). Renderer-local too: its page never outlives the app.
    if (raw === 'browser') return 'browser';
    if (raw === 'live') return 'live'; // row 197: the Live tab
    // The Background tasks panel (row 138, renderer-background-tasks-panel.js). Renderer-local like `notes`.
    if (raw === 'background_tasks') return 'background_tasks';
    // The chat Terminal panel (row 178, renderer-chat-terminal-panel.js). Renderer-local too: its terminals are the Workspace's.
    if (raw === 'terminal') return 'terminal';
    return 'artifact';
  }

  // A per-session `true`-only map (the Close dismissal): non-empty string
  // keys, trimmed to the NEWEST 40 entries.
  function normalizeArtifactReviewSessionFlags(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalized = {};
    for (const key of Object.keys(source)) {
      const sessionId = String(key || '').trim();
      if (sessionId && source[key] === true) normalized[sessionId] = true;
    }
    const keys = Object.keys(normalized);
    for (let i = 0; i < keys.length - ARTIFACT_REVIEW_SESSION_FLAG_LIMIT; i += 1) delete normalized[keys[i]];
    return normalized;
  }

  // One wrap state per body kind: `output` (tool output), `code` (editor,
  // source view, file preview) and `diff` (Changes). Wrapped by default. The
  // pre-schema renderer-local boolean (`textWrap: false`) maps onto output and code.
  function normalizeArtifactReviewTextWrap(value) {
    if (value === false) return { output: false, code: false, diff: true };
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return { output: source.output !== false, code: source.code !== false, diff: source.diff !== false };
  }

  function normalizeArtifactReviewPreferences(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const normalized = {
      // One closed state: a retired `collapsed: true` reads as closed.
      enabled: source.enabled === true && source.collapsed !== true,
      // Mode is renderer-local, never persisted (saveArtifactReviewPreferences).
      mode: normalizeArtifactReviewMode(source.mode),
      textWrap: normalizeArtifactReviewTextWrap(source.textWrap),
    };
    const dismissedForSession = normalizeArtifactReviewSessionFlags(source.dismissedForSession);
    if (Object.keys(dismissedForSession).length > 0) normalized.dismissedForSession = dismissedForSession;
    return normalized;
  }

  // Explicit schema step for a persisted blob: the global sticky dismissal is
  // dropped (ignored, not converted: the new dismissal is per chat), a
  // collapsed panel becomes the one closed state, and a persisted width, maximize or
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
        textWrap: normalizeArtifactReviewTextWrap(source.textWrap),
      };
      // Optional map, written only when non-empty.
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
        for (let i = 0; i <= keys.length - ARTIFACT_REVIEW_SESSION_FLAG_LIMIT; i += 1) delete map[keys[i]];
      }
      map[key] = true;
    } else {
      delete map[key];
    }
    if (Object.keys(map).length > 0) prefs[property] = map;
    else delete prefs[property];
    return value === true;
  }

  function resolveArtifactReviewDismissed(prefs, sessionId) {
    const key = String(sessionId || '').trim();
    return Boolean(key && prefs?.dismissedForSession?.[key] === true);
  }

  // D1 close: remembered for this chat only; an explicit open clears it.
  function recordArtifactReviewDismissed(prefs, sessionId, dismissed) {
    return recordSessionFlag(prefs, 'dismissedForSession', sessionId, dismissed);
  }

  function normalizeTextWrapKind(kind) { return kind === 'output' || kind === 'diff' ? kind : 'code'; }

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
    const source = prefs.dismissedForSession;
    if (!source || typeof source !== 'object' || Array.isArray(source)) return prefs;
    for (const key of Object.keys(source)) if (!allowed.has(key)) delete source[key];
    if (Object.keys(source).length === 0) delete prefs.dismissedForSession;
    return prefs;
  }

  // Moves a session's per-chat Close entry to its new id when a draft chat
  // is rekeyed; an entry already under the new id is replaced.
  function rekeyArtifactReviewSessionPreferences(prefs, fromSessionId, toSessionId) {
    const from = String(fromSessionId || '').trim();
    const to = String(toSessionId || '').trim();
    if (!prefs || typeof prefs !== 'object' || !from || !to || from === to) return prefs;
    const source = prefs.dismissedForSession;
    if (!source || typeof source !== 'object' || Array.isArray(source) || !(from in source)) return prefs;
    const value = source[from];
    delete source[from];
    delete source[to];
    source[to] = value;
    return prefs;
  }

  return {
    ARTIFACT_REVIEW_STORAGE_KEY,
    ARTIFACT_REVIEW_SESSION_FLAG_LIMIT,
    normalizeArtifactReviewMode,
    normalizeArtifactReviewSessionFlags,
    normalizeArtifactReviewTextWrap,
    normalizeArtifactReviewPreferences,
    migrateArtifactReviewPreferences,
    migrateArtifactReviewPreferencesStorage,
    loadArtifactReviewPreferences,
    saveArtifactReviewPreferences,
    resolveArtifactReviewDismissed,
    recordArtifactReviewDismissed,
    resolveArtifactReviewTextWrap,
    setArtifactReviewTextWrap,
    pruneArtifactReviewSessionPreferences,
    rekeyArtifactReviewSessionPreferences,
  };
});
