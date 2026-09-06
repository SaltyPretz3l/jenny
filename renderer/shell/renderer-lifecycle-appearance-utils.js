(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererLifecycleAppearanceUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function fallbackEscapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function createLifecycleAppearanceUtils(deps) {
    const settings = deps || {};
    const state = settings.state;
    const dom = settings.dom || {};
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
      normalizeChatZoomPercent,
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
        const refreshHoloSurfaces = () => {
          fwd.syncComposerVisualState?.();
          fwd.updateAssistantSpritePosition?.(
            undefined,
            undefined,
            { refreshHolo: true }
          );
        };
        if (windowObject && typeof windowObject.requestAnimationFrame === 'function') {
          windowObject.requestAnimationFrame(refreshHoloSurfaces);
        } else {
          refreshHoloSurfaces();
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

    async function applyChatZoomPercent(percent, { persist = true } = {}) {
      const previousZoomPercent = normalizeChatZoomPercent(
        state.ui?.chatZoomPercent ?? getDefaultChatZoomPercent()
      );
      const normalized = normalizeChatZoomPercent(percent);
      state.ui.chatZoomPercent = applyChatZoomToDocument(documentObject, normalized);
      refreshChatZoomLayout();
      if (!persist) {
        return state.ui.chatZoomPercent;
      }
      try {
        const persistedState = await windowObject?.jennyShell?.chatUi?.updateSettings?.({
          zoomPercent: normalized,
        });
        const persistedZoomPercent = normalizeChatZoomPercent(
          persistedState?.zoomPercent ?? normalized
        );
        state.ui.chatZoomPercent = applyChatZoomToDocument(documentObject, persistedZoomPercent);
        refreshChatZoomLayout();
        return state.ui.chatZoomPercent;
      } catch (error) {
        state.ui.chatZoomPercent = applyChatZoomToDocument(documentObject, previousZoomPercent);
        refreshChatZoomLayout();
        appendClientLog('WARN', 'chat.zoom_update_failed', {
          message: error?.message || String(error || 'Could not persist chat zoom.'),
          zoomPercent: normalized,
        });
        throw error;
      }
    }

    async function adjustChatZoomPercent(direction, options = {}) {
      const stepDirection = Number(direction);
      if (!Number.isFinite(stepDirection) || stepDirection === 0) {
        return state.ui.chatZoomPercent;
      }
      return applyChatZoomPercent(
        state.ui.chatZoomPercent + (stepDirection > 0 ? 5 : -5),
        options
      );
    }

    async function resetChatZoomPercent(options = {}) {
      return applyChatZoomPercent(getDefaultChatZoomPercent(), options);
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
      adjustChatZoomPercent,
      applyAppearancePreferences,
      applyChatZoomPercent,
      buildSelectOptionMarkup,
      isDefaultAppearancePreferences,
      refreshChatZoomLayout,
      resetChatZoomPercent,
      saveAppearancePreferences,
    };
  }

  return {
    createLifecycleAppearanceUtils,
  };
});
