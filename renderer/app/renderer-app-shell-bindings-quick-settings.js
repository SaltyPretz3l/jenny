/* renderer/app/renderer-app-shell-bindings-quick-settings.js
 * Create persistence adapters, register Ctrl/Cmd+Comma, and expose an absent-safe controller global used by the command palette.
 */
(function (root) {
  'use strict';

  function buildAdapters(ctx) {
    const state = ctx.state;
    const windowRef = ctx.windowRef;
    const documentRef = ctx.documentRef;
    const callbacks = ctx.callbacks || {};
    const appendClientLog = typeof callbacks.appendClientLog === 'function' ? callbacks.appendClientLog : function noop() {};
    const persistenceAdaptersUtils = root.rendererSettingsPersistenceAdapters || {};
    const appearanceUtils = root.appearanceUtils || null;
    const chatZoomUtils = root.chatZoomUtils || null;

    // Some sandboxed/opaque-origin documents (and jsdom without a URL) throw
    // synchronously on localStorage access rather than returning null --
    // never let that take the whole binder down.
    function resolveLocalStorage() {
      try {
        return (windowRef && windowRef.localStorage) || null;
      } catch (_error) {
        return null;
      }
    }
    const storage = resolveLocalStorage();

    let appearanceAdapter = null;
    if (storage && appearanceUtils && typeof persistenceAdaptersUtils.createAppearanceAdapter === 'function') {
      try {
        appearanceAdapter = persistenceAdaptersUtils.createAppearanceAdapter({
          storage,
          appearanceUtils,
          // The adapter owns persistence and rollback; its apply hook only
          // projects the normalized value into renderer state and tokens.
          applyAppearance: (preferences) => callbacks.applyAppearancePreferences(preferences, { persist: false }),
          log: (message) => appendClientLog('WARN', 'quick_settings.appearance_adapter', { message }),
        });
      } catch (_error) {
        appearanceAdapter = null;
      }
    }

    let zoomAdapter = null;
    if (chatZoomUtils && typeof persistenceAdaptersUtils.createZoomAdapter === 'function') {
      try {
        zoomAdapter = persistenceAdaptersUtils.createZoomAdapter({
          chatZoomUtils,
          getCurrent: () => (state && state.ui ? state.ui.chatZoomPercent : undefined),
          updateSettings: (patch) => windowRef && windowRef.jennyShell && windowRef.jennyShell.chatUi
            && windowRef.jennyShell.chatUi.updateSettings
            ? windowRef.jennyShell.chatUi.updateSettings(patch)
            : undefined,
          applyZoom: (percent) => {
            if (state && state.ui) {
              state.ui.chatZoomPercent = chatZoomUtils.applyChatZoomToDocument(documentRef, percent);
            }
          },
          log: (message) => appendClientLog('WARN', 'quick_settings.zoom_adapter', { message }),
        });
      } catch (_error) {
        zoomAdapter = null;
      }
    }

    let offlineAdapter = null;
    if (typeof persistenceAdaptersUtils.createOfflineAdapter === 'function') {
      try {
        offlineAdapter = persistenceAdaptersUtils.createOfflineAdapter({
          getCurrent: () => (state && state.offline) || {},
          updateSettings: (patch) => windowRef && windowRef.jennyShell && windowRef.jennyShell.offline
            && windowRef.jennyShell.offline.updateSettings
            ? windowRef.jennyShell.offline.updateSettings(patch)
            : undefined,
          // Mirrors renderer-settings-section-binders.js bindOffline(): optimistic
          // merge into the cached slice; richer readiness fields settle on the
          // next natural refreshOfflineState() poll/section-activate.
          apply: (value) => {
            if (state) {
              state.offline = Object.assign({}, state.offline, value);
            }
          },
          log: (message) => appendClientLog('WARN', 'quick_settings.offline_adapter', { message }),
        });
      } catch (_error) {
        offlineAdapter = null;
      }
    }

    const sessionOpenPrefs = root.sessionOpenPrefUtils || null;
    const sessionOpenAdapter = sessionOpenPrefs ? {
      read: () => sessionOpenPrefs.getOpenSessionsInNewTab?.() === true,
      write: async (value) => {
        sessionOpenPrefs.setOpenSessionsInNewTab?.(value === true);
        return value === true;
      },
    } : null;

    return { appearance: appearanceAdapter, zoom: zoomAdapter, offline: offlineAdapter, sessionOpen: sessionOpenAdapter };
  }

  function bindQuickSettings(ctx) {
    const state = (ctx && ctx.state) || null;
    const windowRef = (ctx && ctx.windowRef) || root;
    const documentRef = (ctx && ctx.documentRef) || root.document;
    const callbacks = (ctx && ctx.callbacks) || {};
    const controllers = (ctx && ctx.controllers) || {};
    const registerCleanup = typeof callbacks.registerCleanup === 'function' ? callbacks.registerCleanup : function noop() {};

    const factory = (root.rendererQuickSettingsModalUtils || {}).createQuickSettingsModal;
    if (typeof factory !== 'function' || !state || !documentRef) {
      return null;
    }

    const adapters = buildAdapters({ state, windowRef, documentRef, callbacks });

    const controller = factory({
      documentRef,
      windowRef,
      state,
      overlayManager: controllers.overlayManager || null,
      inertTargets: () => {
        const appShell = documentRef.getElementById && documentRef.getElementById('appShell');
        return appShell ? [appShell] : [];
      },
      adapters,
      runtimePrefs: {
        getCurrent: callbacks.getCurrentRuntimePreferences,
      },
      openSettingsSection: callbacks.openSettingsSection,
      openModelTuning: (modelId, restoreFocusTo) => (
        windowRef.rendererModelTuningDrawerController?.open?.(modelId, restoreFocusTo)
      ),
      appendClientLog: callbacks.appendClientLog,
    });

    if (!controller) {
      return null;
    }

    windowRef.rendererQuickSettingsModalController = controller;
    controllers.quickSettingsModalController = controller;

    function isQuickSettingsFlagEnabled() {
      const flags = state.features && state.features.featureFlags;
      return !flags || flags.quick_settings !== false;
    }

    function handleChordKeydown(event) {
      const isModifierChord = (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
        && (event.key === ',' || event.code === 'Comma');
      if (!isModifierChord) return;
      if (event.defaultPrevented) return;
      if (event.isComposing) return;
      // Modifier chords never insert text, so this must fire even from the composer.
      if (!isQuickSettingsFlagEnabled()) return;
      event.preventDefault();
      event.stopPropagation();
      controller.toggle();
    }

    windowRef.addEventListener('keydown', handleChordKeydown, true);
    registerCleanup(() => {
      windowRef.removeEventListener('keydown', handleChordKeydown, true);
      controller.dispose?.();
      if (controllers.quickSettingsModalController === controller) {
        controllers.quickSettingsModalController = null;
      }
      if (windowRef.rendererQuickSettingsModalController === controller) {
        windowRef.rendererQuickSettingsModalController = null;
      }
    });

    return controller;
  }

  root.rendererAppShellBindingsQuickSettings = {
    bindQuickSettings,
  };
})(window);
