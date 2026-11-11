/* renderer/shell/renderer-settings-external-sync.js - chatUi / windowUi / IDE preference sync.
 *
 * Split out of renderer-settings-support.js (which keeps re-exporting the surface): the value
 * normalizers for the chatUi preferences and the external-change sync that folds a commit made
 * elsewhere (the Jenny chat's settings tool, another window) into renderer state.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsExternalSync = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  const RUN_MODES = Object.freeze(['ask', 'auto', 'plan', 'propose']);
  // Propose (row 35) is chosen per chat, never as the new-chat default.
  const DEFAULT_RUN_MODES = Object.freeze(['ask', 'auto', 'plan']);
  const UI_LANGUAGE_TAGS = Object.freeze(['en', 'es', 'fr', 'de', 'it', 'pt-BR', 'nl', 'pl', 'ru', 'uk', 'tr', 'ar', 'hi', 'id', 'vi', 'ja', 'ko', 'zh-CN', 'zh-TW']);
  const SAFETY_MODES = Object.freeze(['normal', 'strict', 'paranoid']);

  function normalizeRunMode(value, { planModeFallback = false } = {}) {
    const token = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return RUN_MODES.includes(token) ? token : (planModeFallback === true ? 'plan' : 'ask');
  }

  function normalizeDefaultRunMode(value, options) {
    const mode = normalizeRunMode(value, options);
    return DEFAULT_RUN_MODES.includes(mode) ? mode : 'ask';
  }

  function normalizeUiLanguageTag(value) {
    if (typeof value !== 'string') return 'en';
    const normalized = value.toLowerCase();
    return UI_LANGUAGE_TAGS.find((tag) => tag.toLowerCase() === normalized) || 'en';
  }
  function normalizeSafetyMode(value) {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return SAFETY_MODES.includes(normalized) ? normalized : 'normal';
  }
  function normalizeBoundedCount(value, max, fallback) {
    if (!['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return parsed <= 0 ? 0 : Math.min(max, Math.max(fallback === 0 ? 1 : 0, Math.trunc(parsed)));
  }
  const normalizeUnattendedGuardMinutes = (value) => normalizeBoundedCount(value, 120, 0);
  const normalizeAutoApproveStreakCap = (value) => normalizeBoundedCount(value, 500, 50);
  // Row 86 digest quiet hours: the one normalizer main uses too (renderer/shared/string-utils.js).
  const { normalizeDigestQuietStart, normalizeDigestQuietEnd } = globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : {});

  // Row 88 D6: a chatUi / windowUi / workspace-IDE preferences commit made in main by any
  // writer (the Jenny chat's settings tool, its Undo, another window) arrives on three bridge
  // events. Each handler folds the payload into renderer state through the same state fields
  // and side effects the Settings controls use after a confirmed save, then repaints. Echo-safe:
  // a payload equal to current state changes and repaints nothing, and nothing here ever writes
  // back to main, so there is no update loop. renderSettings() keeps its own dirty-draft guard.
  function createExternalSettingsSync(options) {
    const o = options && typeof options === 'object' ? options : {};
    const state = o.state || {};
    const windowRef = o.windowRef || globalThis;
    const noop = function noop() {};
    const renderAll = typeof o.renderAll === 'function' ? o.renderAll : noop;
    const renderSettings = typeof o.renderSettings === 'function' ? o.renderSettings : noop;
    const reapplyIde = typeof o.reapplyIde === 'function' ? o.reapplyIde : noop;
    const log = typeof o.appendClientLog === 'function' ? o.appendClientLog : noop;
    const hasKey = (source, key) => Object.prototype.hasOwnProperty.call(source, key);
    const CHAT_UI_FIELDS = [
      ['defaultRunMode', (value) => normalizeRunMode(value)],
      ['uiLanguage', normalizeUiLanguageTag],
      ['use24HourTime', (value) => value === true],
      ['safetyMode', normalizeSafetyMode],
      ['unattendedGuardMinutes', normalizeUnattendedGuardMinutes],
      ['autoApproveStreakCap', normalizeAutoApproveStreakCap],
      ['digestQuietStart', normalizeDigestQuietStart],
      ['digestQuietEnd', normalizeDigestQuietEnd],
    ];

    function applyChatUi(payload) {
      if (!isPlainObject(payload)) return [];
      const changed = [];
      for (const [key, normalize] of CHAT_UI_FIELDS) {
        if (!hasKey(payload, key)) continue;
        const next = normalize(payload[key]);
        if (state[key] === next) continue;
        state[key] = next;
        changed.push(key);
      }
      if (changed.includes('use24HourTime')) globalThis.jennyI18n?.setTimeFormat?.(state.use24HourTime);
      if (changed.includes('defaultRunMode') && !state.currentSessionId && state.runtimeDraft) state.runtimeDraft.runMode = state.defaultRunMode;
      if (changed.includes('uiLanguage')) {
        try { windowRef.localStorage.setItem('jenny.ui.language', state.uiLanguage); } catch (_error) { /* best effort */ }
      }
      // The transcript default also resets the sessions that inherit it (adoptDefault is idempotent).
      if (hasKey(payload, 'transcriptViewDefault')) {
        const controller = windowRef.rendererTranscriptViewController;
        const before = state.transcriptViewDefault;
        if (typeof controller?.adoptDefault === 'function') controller.adoptDefault(payload.transcriptViewDefault, 'external');
        if (state.transcriptViewDefault !== before) changed.push('transcriptViewDefault');
      }
      if (!changed.length) return changed;
      // Timestamps and the composer's run-mode chip render from state; the rest paint on the Settings page only.
      if (changed.includes('use24HourTime') || changed.includes('defaultRunMode')) renderAll();
      renderSettings();
      return changed;
    }

    function applyWindowUi(payload) {
      if (!isPlainObject(payload)) return [];
      const ui = isPlainObject(state.ui) ? state.ui : (state.ui = {});
      const changed = [];
      const zoom = Number(payload.appZoomPercent);
      if (Number.isFinite(zoom) && zoom > 0 && zoom !== Number(ui.appZoomPercent)) {
        ui.appZoomPercent = zoom;
        changed.push('appZoomPercent');
      }
      const normalizeNotifications = windowRef.rendererDesktopNotifications?.normalizeNotificationSettings;
      if (hasKey(payload, 'notifications') && typeof normalizeNotifications === 'function') {
        const next = normalizeNotifications(payload.notifications);
        if (JSON.stringify(next) !== JSON.stringify(ui.notifications)) {
          ui.notifications = next;
          changed.push('notifications');
        }
      }
      if (isPlainObject(payload.dictation) && typeof payload.dictation.deviceId === 'string'
        && payload.dictation.deviceId !== (ui.dictation && ui.dictation.deviceId)) {
        ui.dictation = { ...(ui.dictation || {}), deviceId: payload.dictation.deviceId };
        changed.push('dictation');
      }
      if (changed.length) renderSettings();
      return changed;
    }

    // Before Settings has loaded its editor section, the open IDE's slice still takes the change
    // (normalized by the eager IDE state module): the IDE persists its live preferences on every
    // snapshot, so a slice left stale would write the old value back over the external change.
    function adoptIntoIdeSlice(payload) {
      const ide = state.ui && isPlainObject(state.ui.ide) ? state.ui.ide : null;
      const normalize = windowRef.rendererIdeState?.normalizeEditorPrefs;
      if (!ide || typeof normalize !== 'function') return [];
      const prefs = normalize(payload);
      const changed = [];
      for (const key of Object.keys(prefs)) {
        const present = key in payload || (key === 'autoSaveEnabled' && 'autoSaveMode' in payload);
        if (!present || JSON.stringify(ide[key]) === JSON.stringify(prefs[key])) continue;
        ide[key] = prefs[key];
        changed.push(key);
      }
      return changed;
    }

    function applyIdePreferences(payload) {
      if (!isPlainObject(payload)) return [];
      const editor = windowRef.rendererSettingsEditorSection;
      const changed = typeof editor?.adoptExternalPreferences === 'function'
        ? editor.adoptExternalPreferences(state, payload) : adoptIntoIdeSlice(payload);
      if (!changed.length) return changed;
      renderSettings();
      reapplyIde(changed);
      return changed;
    }

    // Subscribes the three events once; returns one teardown. A handler error is logged,
    // never thrown into the bridge.
    function bind() {
      const shell = (typeof o.getShell === 'function' ? o.getShell() : windowRef.jennyShell) || {};
      const offs = [
        [shell.chatUi, 'onChanged', applyChatUi, 'chat_ui'],
        [shell.windowUi, 'onChanged', applyWindowUi, 'window_ui'],
        [shell.workspaceIde, 'onPreferencesChanged', applyIdePreferences, 'ide_preferences'],
      ].map(([api, method, apply, label]) => {
        if (typeof api?.[method] !== 'function') return noop;
        const off = api[method]((payload) => {
          try { apply(payload); } catch (error) { log('WARN', 'settings.external_change_failed', { scope: label, message: String(error?.message || error).slice(0, 200) }); }
        });
        return typeof off === 'function' ? off : noop;
      });
      return function unbind() { offs.forEach((off) => { try { off(); } catch (_error) { /* already gone */ } }); };
    }

    return { applyChatUi, applyWindowUi, applyIdePreferences, bind };
  }

  return {
    UI_LANGUAGE_TAGS,
    normalizeRunMode,
    normalizeDefaultRunMode,
    normalizeUiLanguageTag,
    normalizeSafetyMode,
    normalizeUnattendedGuardMinutes,
    normalizeAutoApproveStreakCap,
    normalizeDigestQuietStart,
    normalizeDigestQuietEnd,
    createExternalSettingsSync,
  };
});
