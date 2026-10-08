(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsChrome = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const settingsOverlays = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsOverlays)
    || (typeof require === 'function' ? require('./renderer-settings-overlays') : null)
    || {};
  const settingsComposerMeasure = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsComposerMeasure)
    || (typeof require === 'function' ? require('./renderer-settings-composer-measure') : null)
    || {};

  function createSettingsRenderer(deps) {
    const { state, composerLayoutRuntime } = deps;
    const windowRef = deps.windowRef || globalThis;
    const {
      composerModelSelect, composerEffortSelect, chatInput,
      composerAttachMenu, composerAttachShortcut,
      composerCommandPopover, composerCommandPopoverList, composerTerminalShortcut,
    } = deps.dom;
    const {
      getCurrentRuntimePreferences, getRuntimePreferencesFromSession = null,
      buildModelOptionMarkup, buildSelectOptionMarkup, listSlashCommands, escapeHtml,
      getChatZoomOptions = function fallbackGetChatZoomOptions() { return []; },
      normalizeChatZoomPercent = function fallbackNormalizeChatZoomPercent(value) { return Number(value) || 100; },
      resolveComposerModelSelectWidth, updateComposerSafeOffset,
    } = deps.callbacks;
    const overlayRenderer = settingsOverlays.createSettingsOverlayRenderer?.({
      state,
      dom: {
        composerAttachMenu,
        composerAttachShortcut,
        composerCommandPopover,
        composerCommandPopoverList,
        composerTerminalShortcut,
      },
      callbacks: {
        listSlashCommands,
        escapeHtml,
        getChatZoomOptions,
        normalizeChatZoomPercent,
        buildSelectOptionMarkup,
      },
    }) || {};
    const composerMeasure = settingsComposerMeasure.createComposerMeasure?.({
      state, composerLayoutRuntime, chatInput,
      resolveComposerModelSelectWidth, updateComposerSafeOffset,
    }) || {};
    function renderComposerCarriers() {
      const models = Array.isArray(state.modelList?.data) ? state.modelList.data : [];
      const activeModel = state.status?.model || state.modelList?.active_model || '';
      const runtimePreferences = getCurrentRuntimePreferences();
      // "Use default" (value '') runs on this model; the effort control reads it
      // from here to offer that model's efforts. Stamped before the rebuild so
      // the rebuild's mutation-driven reconcile sees the current pair.
      composerModelSelect.dataset.backendModel = String(activeModel || '').trim();
      composerModelSelect.dataset.backendEngineType = String(
        state.status?.engine || state.status?.engine_type || state.modelList?.engine_type || ''
      ).trim().toLowerCase();
      // Split view W2-2a: pane 0's rail carriers carry pane 0's session (one pane: the current preferences).
      const composerPreferences = globalThis.rendererRenderPipelineChromeUtils?.resolvePaneRuntimePreferences?.({ state, sessionId: globalThis.rendererPaneVisibilityUtils?.resolvePaneSessionId?.(state, 0), fromSession: getRuntimePreferencesFromSession, current: () => runtimePreferences }) || runtimePreferences;
      composerModelSelect.innerHTML = buildModelOptionMarkup(models, composerPreferences.preferredModel, {
        compact: true,
      });
      composerModelSelect.value = composerPreferences.preferredModel;
      globalThis.rendererComposerModelPicker?.instance?.syncPill?.();
      composerEffortSelect.dataset.requestedEffort = String(composerPreferences.reasoningEffort || '');
      composerEffortSelect.value = composerPreferences.reasoningEffort;
      // The Force-local posture (dot, row, tooltip) belongs to the offline manager; painting it here as well
      // lets a Quick Settings change show on the next render pass instead of the next offline refresh.
      if (state.offline) globalThis.rendererOfflineUtils?.renderComposerPosture?.(state.offline);
    }

    let pageRenderer = null;
    let pageLoad = null;
    let dirty = false;
    let disposed = false;
    const readyCallbacks = [];

    function whenSettingsPageReady(fn) {
      if (disposed) return;
      if (pageRenderer) fn();
      else readyCallbacks.push(fn);
    }

    function ensureSettingsPage() {
      if (disposed) return Promise.resolve(null);
      if (pageRenderer) return Promise.resolve(pageRenderer);
      if (pageLoad) return pageLoad;
      const scripts = Array.isArray(windowRef.rendererSettingsScriptManifest) ? windowRef.rendererSettingsScriptManifest : [];
      // Start the whole batch synchronously: async=false preserves document order.
      // A missing predecessor invalidates later evaluation-time captures too.
      const loads = scripts.map(([src, name], index) => {
        const isReady = () => scripts.slice(0, index + 1).every(([, globalName]) => Boolean(windowRef[globalName]));
        try {
          return Promise.resolve(windowRef.scriptLoaderUtils?.ensureScript?.({ src, isReady }))
            .then((loaded) => loaded === true, () => false);
        } catch (_error) {
          return Promise.resolve(false);
        }
      });
      pageLoad = Promise.all(loads).then((results) => {
        if (disposed) return null;
        const failed = scripts.findIndex(([, name], index) => !results[index] || !windowRef[name]);
        if (failed >= 0 || !scripts.length) {
          deps.callbacks.appendClientLog?.('WARN', 'settings.page_load_failed', { src: scripts[failed]?.[0] || '' });
          // Only entries that resolved false lost their ensureScript cache; a cached
          // success must keep its global or a retry can never re-inject it.
          scripts.forEach(([, name], index) => { if (!results[index]) delete windowRef[name]; });
          return null;
        }
        pageRenderer = windowRef.rendererSettingsUtils.createSettingsRenderer(deps);
        // One throwing callback must not drop the ones queued behind it.
        readyCallbacks.splice(0).forEach((fn) => {
          try { fn(); } catch (error) { deps.callbacks.appendClientLog?.('WARN', 'settings.page_ready_callback_failed', { message: String(error?.message || error) }); }
        });
        return pageRenderer;
      }).finally(() => { pageLoad = null; });
      return pageLoad;
    }

    let loadFailed = false;
    let wasOnSettings = false;
    function renderSettings() {
      if (disposed) return;
      // The composer carriers never wait for the page (direct callers on chat rely on this).
      renderComposerCarriers();
      if (pageRenderer) {
        dirty = false;
        pageRenderer.renderSettings();
        return;
      }
      dirty = true;
      const onSettings = state.ui.activeView === 'settings';
      // A failed load is retried on the next Settings activation, not on every render pass.
      if (onSettings && !wasOnSettings) loadFailed = false;
      wasOnSettings = onSettings;
      if (onSettings && !loadFailed) {
        ensureSettingsPage().then((page) => {
          if (!page) loadFailed = true;
          else if (dirty && !disposed) renderSettings();
        });
      }
    }

    function dispose() {
      pageRenderer?.dispose?.();
      overlayRenderer.dispose?.();
      disposed = true;
      readyCallbacks.length = 0;
    }

    return {
      renderSettings,
      renderComposerCarriers,
      renderComposerPopover: (...args) => overlayRenderer.renderComposerPopover?.(...args),
      renderCommandPopover: (...args) => overlayRenderer.renderCommandPopover?.(...args),
      syncComposerInputHeight: (...args) => composerMeasure.syncComposerInputHeight?.(...args),
      measureInlineTextWidth: (...args) => composerMeasure.measureInlineTextWidth?.(...args),
      ensureSettingsPage,
      whenSettingsPageReady,
      isSettingsPageLoaded: () => Boolean(pageRenderer),
      dispose,
    };
  }

  return { createSettingsRenderer };
});
