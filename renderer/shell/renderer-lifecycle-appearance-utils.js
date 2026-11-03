(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLifecycleAppearanceUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const fallbackEscapeHtml = (globalThis.stringUtils || (typeof require === 'function' ? require('../shared/string-utils') : null)).escapeHtml;

  function createLifecycleAppearanceUtils(deps) {
    const settings = deps || {};
    const state = settings.state;
    const constants = settings.constants || {};
    const callbacks = settings.callbacks || {};
    const fwd = settings.fwd || {};
    const call = settings.call || {};
    const windowObject = settings.window || (typeof window !== 'undefined' ? window : null);
    const documentObject = settings.document || (typeof document !== 'undefined' ? document : null);
    const appendClientLog = typeof settings.appendClientLog === 'function'
      ? settings.appendClientLog
      : function noopAppendClientLog() {};
    const escapeHtml = typeof settings.escapeHtml === 'function' ? settings.escapeHtml : fallbackEscapeHtml;
    const {
      APPEARANCE_STORAGE_KEY,
    } = constants;
    const {
      getDefaultAppearancePreferences,
      normalizeAppearancePreferences,
      applyAppearanceToDocument,
      saveStoredAppearancePreferences,
      getDefaultChatZoomPercent,
      applyChatZoomToDocument,
    } = callbacks;

    function saveAppearancePreferences(preferences = state.ui.appearance) {
      try {
        return saveStoredAppearancePreferences(windowObject.localStorage, preferences);
      } catch (error) {
        appendClientLog('WARN', 'appearance.preferences_write_failed', {
          message: error.message || String(error),
          storageKey: APPEARANCE_STORAGE_KEY,
        });
        return null;
      }
    }

    function applyAppearancePreferences(preferences, { persist = true } = {}) {
      let normalized = normalizeAppearancePreferences(preferences);
      if (persist) {
        const saved = saveAppearancePreferences(normalized);
        if (!saved) return state.ui.appearance;
        normalized = saved;
      }
      state.ui.appearance = applyAppearanceToDocument(documentObject, normalized);
      const pretextUtils = globalThis.rendererPretextUtils || null;
      if (pretextUtils && typeof pretextUtils.invalidateAll === 'function') {
        pretextUtils.invalidateAll();
      }
      if (typeof call.refreshActiveSurfaceEffect === 'function') {
        call.refreshActiveSurfaceEffect();
      }
      const mermaidThemeBridge = globalThis.rendererMermaidThemeBridge || null;
      if (mermaidThemeBridge && typeof mermaidThemeBridge.refreshSharedMermaidTheme === 'function') {
        mermaidThemeBridge.refreshSharedMermaidTheme();
      }
      if (
        typeof fwd.syncComposerVisualState === 'function'
        || typeof fwd.updateAssistantSpritePosition === 'function'
      ) {
        const refreshAppearanceSurfaces = () => {
          fwd.syncComposerVisualState?.();
          fwd.updateAssistantSpritePosition?.();
        };
        if (windowObject && typeof windowObject.requestAnimationFrame === 'function') {
          windowObject.requestAnimationFrame(refreshAppearanceSurfaces);
        } else {
          refreshAppearanceSurfaces();
        }
      }
      return state.ui.appearance;
    }

    function refreshChatZoomLayout() {
      const pretextUtils = globalThis.rendererPretextUtils || null;
      if (pretextUtils && typeof pretextUtils.invalidateAll === 'function') {
        pretextUtils.invalidateAll();
      }
      const updateLayout = () => {
        fwd.updateComposerSafeOffset({
          force: true,
          syncViewport: true,
          preserveSurfaceEffectWidths: true,
        });
        fwd.updateAssistantSpritePosition();
      };
      if (windowObject && typeof windowObject.requestAnimationFrame === 'function') {
        windowObject.requestAnimationFrame(updateLayout);
      } else {
        updateLayout();
      }
      if (state.ui?.activeView === 'settings') {
        fwd.renderSettings();
      }
    }

    // Retired axis: keeps the document clear and state at 100 without writing
    // the persisted chatUi.zoomPercent (user state is preserved, just unused).
    async function applyChatZoomPercent(_percent) {
      state.ui.chatZoomPercent = applyChatZoomToDocument(documentObject, getDefaultChatZoomPercent());
      return state.ui.chatZoomPercent;
    }

    // App zoom steps for the Ctrl+wheel / Ctrl +/-/0 shortcuts. These drive
    // the same persisted windowUi.appZoomPercent the Settings select writes
    // (Electron webContents.setZoomFactor); the retired chat zoom no longer
    // has its own axis.
    const APP_ZOOM_DEFAULT = 110; // Mirrors services/shell-config-zoom-state.js.
    const APP_ZOOM_STEPS = [80, 90, 100, 110, 125, 150];

    function nextAppZoomPercent(current, direction) {
      const value = Number(current) || APP_ZOOM_DEFAULT;
      if (direction > 0) {
        return APP_ZOOM_STEPS.find((step) => step > value) ?? APP_ZOOM_STEPS[APP_ZOOM_STEPS.length - 1];
      }
      for (let index = APP_ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
        if (APP_ZOOM_STEPS[index] < value) return APP_ZOOM_STEPS[index];
      }
      return APP_ZOOM_STEPS[0];
    }

    // Shortcut writes are optimistic and can overlap (a held Ctrl+=). Only the
    // newest write may settle the visible value; a failure rolls back to the
    // last persisted value, never to another write's optimistic one.
    let appZoomWriteSeq = 0;
    let appZoomWritesInFlight = 0;
    let committedAppZoomPercent = APP_ZOOM_DEFAULT;

    async function applyAppZoomPercent(percent) {
      const previousPercent = Number(state.ui?.appZoomPercent) || APP_ZOOM_DEFAULT;
      const requested = Number(percent) || APP_ZOOM_DEFAULT;
      if (requested === previousPercent) return previousPercent;
      if (appZoomWritesInFlight === 0) committedAppZoomPercent = previousPercent;
      const seq = ++appZoomWriteSeq;
      appZoomWritesInFlight += 1;
      state.ui.appZoomPercent = requested;
      try {
        const nextWindowUi = await windowObject?.jennyShell?.windowUi?.updateSettings?.({
          appZoomPercent: requested,
        });
        const applied = Number(nextWindowUi?.appZoomPercent);
        committedAppZoomPercent = Number.isFinite(applied) && applied > 0 ? applied : requested;
        if (seq === appZoomWriteSeq) state.ui.appZoomPercent = committedAppZoomPercent;
      } catch (error) {
        if (seq === appZoomWriteSeq) state.ui.appZoomPercent = committedAppZoomPercent;
        appendClientLog('WARN', 'app.zoom_update_failed', {
          message: error?.message || String(error || 'Could not update app zoom.'),
          zoomPercent: requested,
        });
        throw error;
      } finally {
        appZoomWritesInFlight -= 1;
      }
      const select = documentObject?.getElementById?.('appearanceAppZoomSelect');
      if (select && select.value !== String(state.ui.appZoomPercent)) {
        select.value = String(state.ui.appZoomPercent);
      }
      refreshChatZoomLayout();
      return state.ui.appZoomPercent;
    }

    async function adjustAppZoomPercent(direction) {
      const stepDirection = Number(direction);
      if (!Number.isFinite(stepDirection) || stepDirection === 0) {
        return Number(state.ui?.appZoomPercent) || APP_ZOOM_DEFAULT;
      }
      return applyAppZoomPercent(nextAppZoomPercent(state.ui?.appZoomPercent, stepDirection));
    }

    async function resetAppZoomPercent() {
      return applyAppZoomPercent(APP_ZOOM_DEFAULT);
    }

    // Row 88 D8: the Jenny chat's settings tools read and change palette, typography, text size
    // and chat width through main's one-shot appearance relay. A change goes through
    // applyAppearancePreferences with the merged stored preferences, exactly what the Settings
    // appearance controls write; the reply carries the values now in effect (a refused save shows
    // the old value, which main reports as a failed apply). Option lists are the model presets the
    // Settings option sources use, so no Settings page has to be mounted. Never throws.
    const RELAY_FIELDS = [
      ['paletteId', 'getPalettePresets'], ['typographyId', 'getTypographyPresets'],
      ['fontScaleId', 'getFontScalePresets'], ['chatWidthId', 'getChatWidthPresets'],
    ];
    const RELAY_REQUEST_ID = /^ar_[0-9]{1,12}$/;
    function appearanceModel() {
      return settings.appearanceModel || globalThis.appearanceUtils
        || (typeof require === 'function' ? require('../shared/appearance-utils') : null);
    }
    function relaySnapshot() {
      const model = appearanceModel();
      const current = normalizeAppearancePreferences(state.ui.appearance);
      const values = {};
      const options = {};
      for (const [field, getter] of RELAY_FIELDS) {
        values[field] = String(current[field]);
        options[field] = (model[getter]() || []).map((preset) => ({ value: String(preset.id), label: String(preset.label || preset.id) }));
      }
      return { values, options };
    }
    function relayApply(requested) {
      const source = requested && typeof requested === 'object' && !Array.isArray(requested) ? requested : null;
      const keys = source ? Object.keys(source) : [];
      const { options } = relaySnapshot();
      const allowed = keys.length > 0 && keys.every((key) => Array.isArray(options[key])
        && typeof source[key] === 'string' && options[key].some((option) => option.value === source[key]));
      if (!allowed) return false;
      applyAppearancePreferences({ ...state.ui.appearance, ...source });
      if (state.ui?.activeView === 'settings') fwd.renderSettings?.();
      return true;
    }
    function handleAppearanceRelayRequest(payload) {
      const requestId = payload && typeof payload.request_id === 'string' ? payload.request_id : '';
      const respond = windowObject?.jennyShell?.appearance?.respondRelay;
      if (!RELAY_REQUEST_ID.test(requestId) || typeof respond !== 'function') return;
      let reply;
      try {
        if (payload.op === 'read') reply = { request_id: requestId, ok: true, ...relaySnapshot() };
        else if (payload.op === 'apply') {
          reply = relayApply(payload.values)
            ? { request_id: requestId, ok: true, ...relaySnapshot() }
            : { request_id: requestId, ok: false, reason: 'invalid_value' };
        } else reply = { request_id: requestId, ok: false, reason: 'unavailable' };
      } catch (error) {
        appendClientLog('WARN', 'appearance.relay_failed', { message: error?.message || String(error) });
        reply = { request_id: requestId, ok: false, reason: 'unavailable' };
      }
      try {
        Promise.resolve(respond(reply)).catch(() => {});
      } catch (_error) { /* an unsendable reply degrades to main's timeout */ }
    }
    let relayUnsubscribe = null;
    function bindAppearanceRelay() {
      if (relayUnsubscribe) return disposeAppearanceRelay;
      const subscribe = windowObject?.jennyShell?.appearance?.onRelayRequest;
      if (typeof subscribe !== 'function') return disposeAppearanceRelay;
      try {
        relayUnsubscribe = subscribe(handleAppearanceRelayRequest) || (() => {});
      } catch (_error) {
        relayUnsubscribe = null;
      }
      return disposeAppearanceRelay;
    }
    function disposeAppearanceRelay() {
      const unsubscribe = relayUnsubscribe;
      relayUnsubscribe = null;
      if (typeof unsubscribe === 'function') { try { unsubscribe(); } catch (_error) { /* best effort */ } }
    }

    function isDefaultAppearancePreferences(preferences) {
      const normalized = normalizeAppearancePreferences(preferences);
      const defaults = getDefaultAppearancePreferences();
      return (
        normalized.paletteId === defaults.paletteId &&
        normalized.typographyId === defaults.typographyId &&
        normalized.surfaceEffectId === defaults.surfaceEffectId &&
        normalized.composerHoloId === defaults.composerHoloId &&
        normalized.fontScaleId === defaults.fontScaleId &&
        normalized.chatWidthId === defaults.chatWidthId
      );
    }

    function buildSelectOptionMarkup(options, activeValue) {
      return (Array.isArray(options) ? options : [])
        .map((option) => {
          const value = String(option?.id || '');
          const selected = value === String(activeValue || '');
          return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(option?.label || value)}</option>`;
        })
        .join('');
    }

    return {
      // The chat shortcuts keep their historical callback names but now drive
      // app zoom.
      adjustChatZoomPercent: adjustAppZoomPercent,
      adjustAppZoomPercent,
      applyAppearancePreferences,
      applyAppZoomPercent,
      applyChatZoomPercent,
      bindAppearanceRelay,
      disposeAppearanceRelay,
      buildSelectOptionMarkup,
      isDefaultAppearancePreferences,
      refreshChatZoomLayout,
      resetAppZoomPercent,
      resetChatZoomPercent: resetAppZoomPercent,
      saveAppearancePreferences,
    };
  }

  return {
    createLifecycleAppearanceUtils,
  };
});
