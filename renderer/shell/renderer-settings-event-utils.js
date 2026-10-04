/* renderer/shell/renderer-settings-event-utils.js - UMD event bindings extracted from renderer/app.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererSettingsEventUtils = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFenceModule) {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const FIELD_ERROR_TITLES = Object.freeze({
    use24HourTime: jt('settings.timeFormat.updateFailed', 'Time Format Update Failed'),
    uiLanguage: jt('settings.uiLanguage.updateFailed', 'Language Update Failed'),
    safetyMode: jt('settings.safetyMode.updateFailed', 'Safety Mode Update Failed'),
    unattendedGuardMinutes: jt('settings.unattendedGuard.updateFailed', 'Unattended Guard Update Failed'),
    autoApproveStreakCap: jt('settings.autoApproveStreakCap.updateFailed', 'Auto-approval Streak Cap Update Failed'),
    transcriptViewDefault: jt('settings.transcriptView.updateFailed', 'Transcript View Update Failed'),
    defaultRunMode: jt('settings.runMode.updateFailed', 'Default Run Mode Update Failed'),
    startupModelLoad: jt('settings.models.startupLoad.updateFailed', 'Startup Load Update Failed'),
    appZoomPercent: jt('settings.appearance.appZoomUpdateFailed', 'App Zoom Update Failed'),
    'featureFlags.text_spellcheck': jt('settings.editor.spellCheckUpdateFailed', 'Spell Check Update Failed'),
    'webSearch.provider': jt('settings.tools.webSearch.providerUpdateFailed', 'Web Search Provider Update Failed'),
    'webSearch.searxngUrl': jt('settings.tools.webSearch.searxngUrlUpdateFailed', 'SearXNG URL Update Failed'),
  });
  const settingsCoreRenderers = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsCoreRenderers)
    || (typeof require === 'function' ? require('./renderer-settings-core-renderers') : null)
    || {};
  const settingsSupport = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsSupport)
    || (typeof require === 'function' ? require('./renderer-settings-support') : null)
    || {};
  const settingsSectionBinders = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsSectionBinders)
    || (typeof require === 'function' ? require('./renderer-settings-section-binders') : null)
    || {};
  const {
    getToolConfigFieldsForRender = function fallbackGetToolConfigFieldsForRender() { return []; },
    resolveToolConfigToggleEvent = function fallbackResolveToolConfigToggleEvent() { return null; },
    toolConfigRowId = function fallbackToolConfigRowId(id) { return id; },
    normalizeFeatureState = function fallbackNormalizeFeatureState(payload) { return payload || {}; },
    resolveWebSearchKeySaveClickEvent = function fallbackResolveWebSearchKeySaveClickEvent() { return null; },
    WEB_SEARCH_SECRET_KEY_IDS = ['brave', 'tavily', 'serper', 'google_pse', 'google_pse_cx'],
  } = settingsSupport;

  function createSettingsEventBindings(deps) {
    const { state } = deps;
    const webSearchSecretStatusGate = asyncFenceModule.createGenerationGate();

    const {
      settingsView,
      appearanceSettingsSection,
      toolsWorkspaceChooseButton,
      contextSettingsSection,
      contextSourcesList,
      contextRuntimeList,
      modelStartupLoadList,
      contextCompactionTuning,
      toolsConfigFieldList,
      toolsApprovalRulesList,
      editorSettingsFieldList,
      homeSettingsFieldList,
      notificationsSettingsSection,
      notificationsStatus,
      getSectionDom,
    } = deps.dom;

    const {
      renderAll,
      renderSettings,
      applyAppearancePreferences,
      appearanceUtils,
      applySurfaceEffect,
      activateSurfaceEffect,
      handlePersonalityTabChange,
      getPersonalityActiveFile,
      setPersonalityDraft,
      renderPersonalityEditor,
      handlePersonalitySave,
      handlePersonalityReset,
      handlePersonalityOpenFolder,
      renderMemoryContextFiles,
      loadMemoryContextFile,
      setMemoryContextDraft,
      getMemoryContextActiveFile,
      saveMemoryContextFile,
      resetMemoryContextFile,
      showShellErrorToast,
      showToastMessage,
      toErrorMessage,
      appendClientLog,
      showSessionActionError,
      getCurrentRuntimePreferences,
      getRuntimePreferenceSnapshot,
      runRuntimePreferenceActivity,
      openSettingsSection,
      handleRunSetupAgain,
      showSetupHelp,
      showFactoryReset,
      updateSkillsSettings,
      openSkillsScopeFolder,
      handleOfflineModeChange,
      refreshFeatureState,
      setActiveView,
      openSession,
      renderLogs,
    } = deps.callbacks;

    const {
      TOAST_SOURCE,
      ACTIVITY_SCOPE,
    } = deps.constants;

    let bindAbortController = null;
    let bound = false;
    let listenerOptions = undefined;
    let ensureSectionBindings = function noopEnsureSectionBindings() {};
    let sectionShown = function noopSectionShown() {};
    const cleanupFns = [];
    const boundSections = new Set();

    function getLazySectionDom(sectionId) {
      return typeof getSectionDom === 'function' ? (getSectionDom(sectionId) || {}) : {};
    }

    function addCleanup(cleanup) {
      if (typeof cleanup === 'function') {
        cleanupFns.push(cleanup);
      }
    }

    function registerListener(target, eventName, handler, options) {
      if (!target || typeof target.addEventListener !== 'function') {
        return false;
      }
      target.addEventListener(eventName, handler, options);
      if (!bindAbortController) {
        addCleanup(() => {
          target.removeEventListener(eventName, handler, options);
        });
      }
      return true;
    }

    // Settings cohesion: one adapter per persisted object (chatUi, features,
    // engines, runtimePreferences, appearance, windowUi), registered once and
    // applied after the owner acknowledges the save; each delegated container
    // binds its descriptor ids.
    const fieldBinding = globalThis.rendererSettingsFieldBinding
      || (typeof require === 'function' ? require('./renderer-settings-field-binding') : null);
    const fieldDescriptors = globalThis.rendererSettingsFieldDescriptors
      || (typeof require === 'function' ? require('./renderer-settings-field-descriptors') : null);
    const settingsRegistry = typeof fieldBinding?.createSettingsAdapterRegistry === 'function'
      ? fieldBinding.createSettingsAdapterRegistry({ log: appendClientLog })
      : null;
    const confirmError = () => new Error(jt('settings.chatUi.confirmError', 'The saved setting could not be confirmed.'));
    function createChatUiAdapter() {
      const owned = fieldDescriptors.listSettingDescriptors({ adapterId: 'chatUi' });
      const byKey = new Map(owned.map((descriptor) => [descriptor.key, descriptor]));
      const normalizeKey = (key, value) => (byKey.has(key) ? fieldDescriptors.normalizeSettingValue(byKey.get(key), value) : value);
      return {
        id: 'chatUi',
        mode: 'patch',
        optimistic: false,
        read: () => Object.fromEntries(owned.map((descriptor) => [descriptor.key, state[descriptor.key]])),
        normalize: (source) => Object.fromEntries(Object.keys(source || {}).map((key) => [key, normalizeKey(key, source[key])])),
        // The transcript view default saves through its controller, which resets
        // the sessions that inherit it once the save is confirmed.
        write: (patch) => {
          const { transcriptViewDefault: view, ...rest } = patch;
          const api = (typeof window !== 'undefined' && window.jennyShell?.chatUi) || null;
          const controller = globalThis.rendererTranscriptViewController;
          const hasRest = Object.keys(rest).length > 0;
          if ((hasRest && typeof api?.updateSettings !== 'function') || (view !== undefined && typeof controller?.setDefault !== 'function')) {
            throw new Error('Chat settings are unavailable.');
          }
          return Promise.all([hasRest ? api.updateSettings(rest) : {}, view === undefined ? undefined : controller.setDefault(view)])
            .then(([snapshot, confirmed]) => (view === undefined ? snapshot : { ...snapshot, transcriptViewDefault: confirmed ?? state.transcriptViewDefault }));
        },
        ack: (snapshot, patch, composed) => {
          const next = { ...composed };
          Object.keys(patch).forEach((key) => {
            if (!Object.prototype.hasOwnProperty.call(snapshot || {}, key) || normalizeKey(key, snapshot[key]) !== patch[key]) throw confirmError();
            next[key] = normalizeKey(key, snapshot[key]);
          });
          return next;
        },
        apply: (next, keys) => {
          if (!bound) return;
          keys.forEach((key) => { state[key] = next[key]; });
          if (keys.includes('use24HourTime')) {
            globalThis.jennyI18n?.setTimeFormat?.(state.use24HourTime);
            renderAll();
          }
          renderSettings();
        },
        // Side effects of a confirmed save only (apply also runs on rollback).
        onSettled: (ok, keys) => {
          if (!ok || !bound) return;
          if (keys.includes('defaultRunMode') && !state.currentSessionId && state.runtimeDraft) state.runtimeDraft.runMode = state.defaultRunMode;
          if (!keys.includes('uiLanguage')) return;
          try { window.localStorage.setItem('jenny.ui.language', state.uiLanguage); } catch (_error) { /* best effort */ }
          if (typeof showToastMessage === 'function') showToastMessage(jt('settings.language.savedToast', 'Language saved. Restart Jenny to switch the interface.'), { tone: 'info', dedupeKey: 'settings:ui-language' });
        },
      };
    }
    // Feature settings: toolConfig.<key> reads the tool switches (manifest fields)
    // and writes `tools`; featureFlags.<flag> writes `featureOverrides`.
    // refreshFeatureState makes the one bridge call and folds the payload into
    // state.features (with its side effects), so apply only re-renders.
    const FEATURE_PATCH_GROUPS = { toolConfig: 'tools', featureFlags: 'featureOverrides' };
    function projectFeatures(features) {
      const source = features && typeof features === 'object' ? features : {};
      const tools = source.tools || {};
      return { ...source, toolConfig: Object.fromEntries(getToolConfigFieldsForRender(source).map((field) => [field.key, Object.prototype.hasOwnProperty.call(tools, field.key) ? tools[field.key] === true : field.default])) };
    }
    function createFeaturesAdapter() {
      return {
        id: 'features',
        mode: 'patch',
        optimistic: false,
        read: () => projectFeatures(state.features),
        normalize: (source) => source || {},
        write: (payload) => {
          const current = projectFeatures(state.features);
          const patch = {};
          const changed = [];
          Object.keys(payload).forEach((group) => Object.keys(payload[group] || {}).forEach((name) => {
            if (payload[group][name] === current[group]?.[name]) return;
            if (group === 'toolConfig' && state.features?.availability?.tools?.[name]?.enabled === false) {
              throw new Error(jt('settings.tools.blockedByRuntime', 'Currently blocked by runtime availability.'));
            }
            const target = FEATURE_PATCH_GROUPS[group] || group;
            patch[target] = { ...patch[target], [name]: payload[group][name] };
            changed.push([group, name]);
          }));
          return Promise.resolve(refreshFeatureState(patch)).then((result) => ({ result, changed }));
        },
        ack: ({ result, changed }, payload) => {
          if (result === undefined) throw confirmError();
          const next = projectFeatures(normalizeFeatureState(result));
          changed.forEach(([group, name]) => { if (next[group]?.[name] !== payload[group][name]) throw confirmError(); });
          return next;
        },
        apply: () => { if (bound) renderSettings(); },
      };
    }
    function createEnginesAdapter() {
      return {
        id: 'engines',
        mode: 'patch',
        optimistic: false,
        read: () => ({ ...state.localEngines }),
        normalize: (source) => source || {},
        write: (patch) => window.jennyShell.engines.updateSettings(patch),
        ack: (result, patch) => {
          Object.keys(patch).forEach((key) => { if (result?.localEngines?.[key] !== patch[key]) throw confirmError(); });
          return { ...result.localEngines };
        },
        apply: (next) => {
          if (!bound) return;
          state.localEngines = next;
          renderSettings();
        },
      };
    }
    // Context preferences: runRuntimePreferenceActivity owns the activity row and
    // the undo snapshot; the acknowledgement is the re-read preference state.
    function createRuntimePreferencesAdapter() {
      return {
        id: 'runtimePreferences',
        mode: 'patch',
        optimistic: false,
        read: () => ({ contextPreferences: { ...getCurrentRuntimePreferences().contextPreferences } }),
        normalize: (source) => source || {},
        write: (patch) => Promise.resolve(runRuntimePreferenceActivity({
          patch,
          scopes: [ACTIVITY_SCOPE.settingsContextPreferences],
          previousValue: getRuntimePreferenceSnapshot(),
          failureMessage: () => jt('settings.context.preferencesSaveFailed', 'Could not save context preferences.'),
          successMessage: '',
        })).then(() => getCurrentRuntimePreferences()),
        ack: (preferences, patch) => {
          const saved = preferences?.contextPreferences || {};
          Object.keys(patch.contextPreferences).forEach((key) => { if (saved[key] !== patch.contextPreferences[key]) throw confirmError(); });
          return { contextPreferences: { ...saved } };
        },
        apply: () => { if (bound) renderSettings(); },
      };
    }
    // Appearance (renderer-local store, jenny.appearance.v2). The view carries
    // the Composer border as a boolean and the theme bundle its axes match
    // ('custom' when none does); a bundle id composed onto it is a bundle choice.
    const appearanceModel = (typeof appearanceUtils?.normalizeAppearancePreferences === 'function' && appearanceUtils)
      || globalThis.appearanceUtils
      || (typeof require === 'function' ? require('../shared/appearance-utils') : null);
    function createAppearanceAdapter() {
      const storedOf = (view) => appearanceModel.normalizeAppearancePreferences({ ...view, composerHoloId: view?.composerHoloId === false ? 'off' : view?.composerHoloId });
      const bundleIdOf = (preferences) => appearanceModel.detectActiveThemeBundle(preferences)?.id || 'custom';
      return {
        id: 'appearance',
        mode: 'object',
        optimistic: false,
        read: () => state.ui.appearance,
        normalize: (source) => {
          const stored = storedOf(source);
          const chosen = typeof source?.themeBundleId === 'string' && source.themeBundleId;
          return { ...stored, composerHoloId: stored.composerHoloId !== 'off', themeBundleId: chosen || bundleIdOf(stored) };
        },
        write: (view) => {
          const current = appearanceModel.normalizeAppearancePreferences(state.ui.appearance);
          let next = storedOf(view);
          // A bundle owns palette, typography, surface and the Composer border:
          // Text size and Chat width survive a bundle switch.
          const bundle = view.themeBundleId !== bundleIdOf(current) ? appearanceModel.resolveThemeBundle(view.themeBundleId) : null;
          if (bundle) next = appearanceModel.normalizeAppearancePreferences({ ...next, ...appearanceModel.pickThemeBundleAxes(bundle.preferences) });
          // 'custom', an unknown bundle or an unchanged view writes nothing.
          if (JSON.stringify(next) === JSON.stringify(current)) return { applied: current, written: next };
          return { applied: applyAppearancePreferences(next), written: next };
        },
        // applyAppearancePreferences returns the previous preferences when the
        // store refuses the write, so every written axis must come back.
        ack: ({ applied, written }) => {
          const saved = appearanceModel.normalizeAppearancePreferences(applied);
          if (!applied || Object.keys(written).some((key) => saved[key] !== written[key])) throw confirmError();
          return saved;
        },
        apply: (next, keys) => {
          if (!bound) return;
          if (keys.includes('surfaceEffectId') || keys.includes('themeBundleId')) {
            applySurfaceEffect();
            activateSurfaceEffect(next.surfaceEffectId || 'none');
          }
          // The title-bar load read-out lives in the header, which renderAll repaints.
          if (keys.includes('titlebarLoad')) renderAll(); else renderSettings();
        },
      };
    }
    // Overall app zoom persists and applies in the main process
    // (webContents.setZoomFactor); the echoed value is the acknowledgement.
    // The Ctrl +/- shortcuts write the same value on their own
    // (renderer-lifecycle-appearance-utils.js): a settle replaces only what a
    // select edit put in state, never a shortcut step taken since.
    function createWindowUiAdapter() {
      let own = null;
      return {
        id: 'windowUi',
        mode: 'patch',
        optimistic: true,
        read: () => ({ appZoomPercent: Number(state.ui.appZoomPercent) || 110 }), // APP_ZOOM_DEFAULT (services/shell-config-zoom-state.js)
        normalize: (source) => source || {},
        write: (patch) => {
          const api = (typeof window !== 'undefined' && window.jennyShell?.windowUi) || null;
          if (typeof api?.updateSettings !== 'function') throw confirmError();
          return api.updateSettings({ appZoomPercent: patch.appZoomPercent });
        },
        ack: (result, patch) => {
          const echoed = Number(result?.appZoomPercent);
          if (!Number.isFinite(echoed) || echoed !== patch.appZoomPercent) throw confirmError();
          return { appZoomPercent: echoed };
        },
        apply: (next, _keys, phase) => {
          if (!bound) return;
          if (!phase?.settled || Number(state.ui.appZoomPercent) === own) {
            state.ui.appZoomPercent = next.appZoomPercent;
            own = next.appZoomPercent;
          }
          renderSettings();
        },
      };
    }
    function fieldErrorTitle(descriptor) {
      if (FIELD_ERROR_TITLES[descriptor.key]) return FIELD_ERROR_TITLES[descriptor.key];
      if (descriptor.adapterId === 'runtimePreferences') return jt('settings.context.updateFailed', 'Context Update Failed');
      if (descriptor.key.startsWith('featureFlags.')) return jt('settings.context.featureUpdateFailed', 'Context Feature Update Failed');
      if (descriptor.key.startsWith('toolConfig.')) return jt('settings.tools.toggleUpdateFailed', '{label} Update Failed', { label: fieldBinding.resolveSettingCopy(descriptor).label });
      return jt('settings.chatUi.updateFailed', 'Setting Update Failed');
    }
    function bindDescriptorFields(container, ids, onApplied) {
      if (!settingsRegistry || !fieldDescriptors || typeof fieldBinding?.bindSettingFields !== 'function') return null;
      if (!settingsRegistry.has('chatUi')) {
        [createChatUiAdapter, createFeaturesAdapter, createEnginesAdapter, createRuntimePreferencesAdapter, createAppearanceAdapter, createWindowUiAdapter]
          .forEach((create) => settingsRegistry.register(create()));
      }
      return fieldBinding.bindSettingFields({
        container,
        ids,
        registry: settingsRegistry,
        registerListener,
        listenerOptions,
        onApplied,
        // The reason shows on the row or under the switch; a toast only when it has no place on the page.
        onError: (descriptor, error, shown) => {
          if (bound && !shown?.inline) showSessionActionError(error, fieldErrorTitle(descriptor));
        },
      });
    }

    function dispose() {
      if (!bound) {
        return;
      }
      bound = false;
      if (bindAbortController) {
        bindAbortController.abort();
        bindAbortController = null;
      }
      listenerOptions = undefined;
      boundSections.clear();
      while (cleanupFns.length) {
        const cleanup = cleanupFns.pop();
        try {
          cleanup();
        } catch (error) {
          // Ignore teardown failures during renderer shutdown.
        }
      }
    }

    function bind() {
      if (bound) {
        return;
      }
      bound = true;
      bindAbortController = typeof AbortController === 'function' ? new AbortController() : null;
      listenerOptions = bindAbortController ? { signal: bindAbortController.signal } : undefined;

      // Editor settings section: delegated select/toggle handlers that persist a
      // partial workspaceIde patch + re-render (logic lives in the section module).
      const editorSection = typeof globalThis !== 'undefined' ? globalThis.rendererSettingsEditorSection : null;
      editorSection?.bindEditorSection?.({
        container: editorSettingsFieldList,
        state,
        renderSettings,
        registerListener,
        listenerOptions,
        showShellErrorToast,
        openSettingsSection,
        appendClientLog,
      });

      // Home settings section: delegated select/toggle handlers that persist the
      // whole scratchpad.settings object via home.updateConfig + re-render
      // (logic lives in the section module).
      const homeSection = typeof globalThis !== 'undefined' ? globalThis.rendererSettingsHomeSection : null;
      homeSection?.bindHomeSection?.({
        container: homeSettingsFieldList,
        status: deps.dom.homeStatus,
        state,
        renderSettings,
        registerListener,
        listenerOptions,
      });

      // Notifications: each switch writes the whole windowUi.notifications
      // object and adopts the acknowledged copy (logic in the section module).
      const notificationsSection = typeof globalThis !== 'undefined' ? globalThis.rendererSettingsNotificationsSection : null;
      notificationsSection?.bindNotificationsSection?.({
        container: notificationsSettingsSection,
        status: notificationsStatus,
        state,
        renderSettings,
        registerListener,
        listenerOptions,
      });

      // Tools > Approval rules: Remove clears a per-tool policy or deletes a
      // path-scoped rule through tools.*, then refetches the list.
      settingsCoreRenderers.bindApprovalRules?.({
        container: toolsApprovalRulesList,
        api: (typeof window !== 'undefined' && window.jennyShell?.tools) || null,
        projectsApi: (typeof window !== 'undefined' && window.jennyShell?.projects) || null,
        permissionReviewApi: (typeof window !== 'undefined' && window.jennyShell?.permissionReview) || null,
        registerListener,
        listenerOptions,
        onError: showSessionActionError,
      });


      async function applyFeatureSettings(patch, errorTitle) {
        try {
          await refreshFeatureState(patch);
          renderSettings();
        } catch (error) {
          showSessionActionError(error, errorTitle);
        }
      }
      function openControlTowerAction(controlTowerAction) {
        if (controlTowerAction?.dataset?.settingsControlAction === 'resume-setup' && typeof handleRunSetupAgain === 'function') {
          Promise.resolve().then(() => handleRunSetupAgain()).catch((error) => {
            showSessionActionError(error, jt('settings.shell.setupRunAgainFailed', 'Setup Run Again Failed'));
          });
          return;
        }
        const chooseRoot = deps.callbacks?.handleWorkspaceRootChoose;
        if (controlTowerAction?.dataset?.settingsControlAction === 'choose-workspace' && typeof chooseRoot === 'function') {
          Promise.resolve().then(() => chooseRoot()).catch((error) => {
            showSessionActionError(error, jt('settings.controlTower.chooseFolderFailed', 'Could not choose a folder'));
          });
          return;
        }
        const sectionId = String(controlTowerAction?.dataset?.settingsControlSection || '').trim();
        if (sectionId === '__diagnostics') {
          setActiveView?.('logs');
          return;
        }
        if (sectionId === '__memory') {
          openSettingsSection('memories', { source: 'control_tower' });
          return;
        }
        if (sectionId) {
          openSettingsSection(sectionId, { source: 'control_tower' });
        }
      }
      const sectionBinders = settingsSectionBinders.createSettingsSectionBinders?.({
        state,
        windowRef: typeof window !== 'undefined' ? window : globalThis,
        constants: { TOAST_SOURCE },
        getLazySectionDom,
        callbacks: {
          renderAll,
          renderSettings,
          handlePersonalityTabChange,
          getPersonalityActiveFile,
          setPersonalityDraft,
          renderPersonalityEditor,
          handlePersonalitySave,
          handlePersonalityReset,
          handlePersonalityOpenFolder,
          renderMemoryContextFiles,
          loadMemoryContextFile,
          setMemoryContextDraft,
          getMemoryContextActiveFile,
          saveMemoryContextFile,
          resetMemoryContextFile,
          showShellErrorToast,
          toErrorMessage,
          appendClientLog,
          showSessionActionError,
          openSettingsSection,
          updateSkillsSettings,
          openSkillsScopeFolder,
          handleOfflineModeChange,
          applyFeatureSettings,
          renderLogs,
          openSession,
          setActiveView,
          // Settings > Projects: the Workspace folder pick / close, the chat
          // list repaint, the Chats panel reveal and the project switcher.
          handleWorkspaceRootChoose: deps.callbacks.handleWorkspaceRootChoose,
          clearWorkspaceRoot: deps.callbacks.clearWorkspaceRoot,
          renderSessions: deps.callbacks.renderSessions,
          setSidebarCollapsed: deps.callbacks.setSidebarCollapsed,
          getProjectSwitcher: deps.callbacks.getProjectSwitcher,
        },
      }) || null;
      // Diagnostics › Runs attaches through this binder set, so its poll ends with it.
      addCleanup(() => sectionBinders?.dispose?.());

      sectionShown = (sectionId) => sectionBinders?.sectionShown?.(sectionId);
      ensureSectionBindings = function ensureSectionBindings(sectionId) {
        const normalizedSectionId = String(sectionId || '').trim();
        if (!bound || !normalizedSectionId || boundSections.has(normalizedSectionId)) {
          return boundSections.has(normalizedSectionId);
        }
        let didBindSection = false;
        function registerSectionListener(target, eventName, handler) {
          if (registerListener(target, eventName, handler, listenerOptions)) {
            didBindSection = true;
          }
        }
        function markSectionBound() {
          didBindSection = true;
        }
        function finalizeSectionBindings() {
          if (didBindSection) {
            boundSections.add(normalizedSectionId);
          }
          return didBindSection;
        }
        if (sectionBinders) {
          return sectionBinders.bindSection(normalizedSectionId, {
            registerSectionListener,
            finalizeSectionBindings,
            markSectionBound,
            addCleanup,
          });
        }
        return finalizeSectionBindings();
      };

      // History scope shares the runtimePreferences adapter with the two switches
      // (one write path for contextPreferences, so a queued write never carries a
      // stale scope); its row is mounted by renderSettings, so the card delegates.
      bindDescriptorFields(contextSettingsSection, ['contextHistoryScopeSelect']);
      bindDescriptorFields(contextSourcesList, ['contextIncludePersonalityToggle', 'contextIncludeMemoryToggle']);
      bindDescriptorFields(contextRuntimeList, ['contextCompactionToggle']);
      bindDescriptorFields(modelStartupLoadList, ['modelStartupLoadToggle']);

      // Compaction tuning fields (Compaction Tunability + Manual Compact):
      // logic lives in the section module (extraction pattern shared with the
      // Editor/Home sections) to keep this file under the size ceiling.
      const compactionSection = typeof globalThis !== 'undefined' ? globalThis.rendererSettingsCompactionSection : null;
      compactionSection?.bindCompactionSection?.({
        container: contextCompactionTuning,
        state,
        renderSettings,
        registerListener,
        listenerOptions,
        showSessionActionError,
      });

      // Tools: the chatUi scalars, the tool switches and the web-search fields.
      const toolsFields = bindDescriptorFields(toolsConfigFieldList, (fieldDescriptors?.listSettingDescriptors({ sectionId: 'tools' }) || [])
        .filter((descriptor) => descriptor.adapterId === 'chatUi' || descriptor.adapterId === 'features').map((descriptor) => descriptor.id),
      (descriptor) => { if (descriptor.key === 'webSearch.provider') ensureWebSearchSecretStatus(); });
      // Manifest tool fields without a descriptor bind through one derived from
      // a described tool switch (queued descriptor amendment).
      registerListener(toolsConfigFieldList, 'inv-toggle-change', (event) => {
        const id = String(event.detail?.id || '');
        const tool = resolveToolConfigToggleEvent(event, getToolConfigFieldsForRender(state.features));
        if (!tool || !toolsFields || fieldDescriptors.getSettingDescriptorByControlId(id)) return;
        void toolsFields.commit({ ...fieldDescriptors.getSettingDescriptor('settings-tool-config-web'), id: toolConfigRowId(id), controlId: id, key: `toolConfig.${tool.key}`, copy: { label: tool.label, description: '' } }, tool.checked);
      }, listenerOptions);
      bindDescriptorFields(settingsView, ['use24HourTime', 'uiLanguageSelect', 'transcriptViewDefaultSelect']);

      // Web search provider section: renders inside the same toolsConfigFieldList
      // container, in toolsWebList. Provider/URL fields
      // are descriptor fields bound above (features adapter); the per-provider
      // key fields go straight to the dedicated secret IPC (never persisted
      // through the general feature-settings patch).
      function webSearchApi() {
        return (typeof window !== 'undefined' && window.jennyShell && window.jennyShell.features) || null;
      }
      // Plain JSON-shaped equality: the secret-status payload is booleans +
      // strings only (see buildWebSearchSecretStatus), so a JSON round-trip
      // comparison is sufficient and avoids pulling in a generic deep-equal.
      function webSearchSecretStatusEqual(a, b) {
        if (a === b) {
          return true;
        }
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
          return false;
        }
        try {
          return JSON.stringify(a) === JSON.stringify(b);
        } catch (_error) {
          return false;
        }
      }
      // True when a masked web-search key input currently has focus or
      // in-flight (non-empty, unsaved) text — re-rendering here would wipe it.
      function hasInFlightWebSearchKeyInput() {
        if (!toolsConfigFieldList || typeof toolsConfigFieldList.querySelectorAll !== 'function') {
          return false;
        }
        const activeElement = (typeof document !== 'undefined' && document.activeElement) || null;
        const inputs = toolsConfigFieldList.querySelectorAll('[data-web-search-key-field]');
        for (let index = 0; index < inputs.length; index += 1) {
          const input = inputs[index];
          if (input === activeElement || String(input.value || '') !== '') {
            return true;
          }
        }
        return false;
      }
      function refreshWebSearchSecretStatus() {
        const api = webSearchApi();
        if (!api || typeof api.getWebSearchSecretStatus !== 'function') {
          return;
        }
        const statusToken = webSearchSecretStatusGate.capture();
        Promise.resolve(api.getWebSearchSecretStatus()).then((status) => {
          if (!webSearchSecretStatusGate.isCurrent(statusToken)) {
            return;
          }
          if (!status || typeof status !== 'object') {
            return;
          }
          const unchanged = webSearchSecretStatusEqual(status, state.webSearchSecrets);
          state.webSearchSecrets = status;
          if (unchanged || hasInFlightWebSearchKeyInput()) {
            return;
          }
          renderSettings();
        }).catch(() => {});
      }
      let webSearchSecretsHydrated = false;
      function ensureWebSearchSecretStatus() {
        if (webSearchSecretsHydrated || state.webSearchSecrets) {
          return;
        }
        webSearchSecretsHydrated = true;
        refreshWebSearchSecretStatus();
      }
      // If the flag is already on when Settings binds (not just flipped on via a
      // provider change), hydrate the configured-key hints once up front.
      if (state.features?.featureFlags?.web_search_providers === true) {
        ensureWebSearchSecretStatus();
      }
      registerListener(toolsConfigFieldList, 'click', (event) => {
        const testButton = event.target?.closest?.('[data-web-search-test]');
        if (testButton) {
          if (testButton.disabled) return;
          const status = toolsConfigFieldList.querySelector('[data-web-search-test-status]');
          // A busy lock, like a settings write: the Web tools sync leaves it alone, and the
          // release below re-reads availability so a test cannot unlock a parent-off row.
          testButton.setAttribute('data-setting-busy', '');
          testButton.disabled = true;
          if (status) status.textContent = jt('settings.shell.webSearchTesting', 'Testing the selected provider…');
          Promise.resolve(window.jennyShell?.harness?.inspect?.({ web_search_probe: true }))
            .then((snapshot) => {
              const probe = snapshot?.web_search_probe || {};
              if (status) status.textContent = probe.ok === true
                ? jt('settings.shell.webSearchConnected', 'Connected to {provider}.', { provider: String(probe.provider || jt('settings.tools.webSearch.selectedProviderFallback', 'the selected provider')) }).replace('{provider}', () => String(probe.provider || jt('settings.tools.webSearch.selectedProviderFallback', 'the selected provider')))
                : jt('settings.shell.webSearchConnectionFailed', 'Connection failed: {error}', { error: String(probe.error || jt('settings.tools.webSearch.providerUnavailableFallback', 'provider unavailable')).slice(0, 160) }).replace('{error}', () => String(probe.error || jt('settings.tools.webSearch.providerUnavailableFallback', 'provider unavailable')).slice(0, 160));
            })
            .catch(() => {
              if (status) status.textContent = jt('settings.shell.webSearchTestUnavailable', 'Connection test unavailable. Local chat is unaffected.');
            })
            .finally(() => {
              testButton.removeAttribute('data-setting-busy');
              testButton.disabled = testButton.hasAttribute('data-setting-unavailable');
            });
          return;
        }
        const resolved = resolveWebSearchKeySaveClickEvent(event);
        if (!resolved || !WEB_SEARCH_SECRET_KEY_IDS.includes(resolved.keyId)) {
          return;
        }
        const input = toolsConfigFieldList.querySelector(`[data-web-search-key-field="${resolved.keyId}"]`);
        const api = webSearchApi();
        if (!input || input.disabled || !api || typeof api.setWebSearchSecret !== 'function') {
          return;
        }
        const value = String(input.value || '');
        webSearchSecretStatusGate.bump();
        Promise.resolve(api.setWebSearchSecret({ keyId: resolved.keyId, value })).then((status) => {
          if (status && typeof status === 'object') {
            webSearchSecretStatusGate.bump();
            state.webSearchSecrets = status;
            // The key persisted even if the sidecar's managed-config refresh
            // failed afterward (see applyWebSearchSecret) - surface that as a
            // success note, not a failure toast, so the user isn't told their
            // save was lost when it wasn't.
            if (status.configRefreshed === false && typeof showToastMessage === 'function') {
              showToastMessage(
                jt('settings.shell.webSearchKeySaved', 'Key saved. It will apply after the sidecar config refreshes or Jenny restarts.'),
                { title: jt('settings.shell.webSearchKeySavedTitle', 'Web Search Key Saved'), tone: 'info', source: TOAST_SOURCE.settings }
              );
            }
          }
          renderSettings();
        }).catch((error) => {
          showSessionActionError(error, jt('settings.tools.webSearch.keyUpdateFailed', 'Web Search Key Update Failed'));
        });
      }, listenerOptions);
      // Save-on-Enter for the key fields (the section spec's other save path).
      registerListener(toolsConfigFieldList, 'keydown', (event) => {
        if (event.key !== 'Enter') {
          return;
        }
        const target = event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-web-search-key-field]')
          : null;
        if (!target) {
          return;
        }
        event.preventDefault();
        const keyId = target.getAttribute('data-web-search-key-field');
        const saveButton = toolsConfigFieldList.querySelector(`[data-web-search-key-save="${keyId}"]`);
        if (saveButton && typeof saveButton.click === 'function') {
          saveButton.click();
        }
      }, listenerOptions);

      registerListener(toolsWorkspaceChooseButton, 'click', () => {
        setActiveView('ide');
      }, listenerOptions);

      registerListener(settingsView, 'click', (event) => {
        const memoryPageLink = event.target.closest('[data-action="open-memory-page"]');
        if (memoryPageLink) {
          openSettingsSection('memories', { source: 'context' });
          return;
        }
        const personalityPageLink = event.target.closest('[data-action="open-personality-page"]');
        if (personalityPageLink) {
          openSettingsSection('personality', { source: 'context' });
          return;
        }
        const controlTowerAction = event.target.closest('[data-settings-control-section]');
        if (!controlTowerAction) {
          return;
        }
        openControlTowerAction(controlTowerAction);
      }, listenerOptions);
      registerListener(settingsView, 'keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') {
          return;
        }
        const controlTowerAction = event.target.closest('[data-settings-control-section]');
        if (!controlTowerAction) {
          return;
        }
        if (String(controlTowerAction.tagName || '').toLowerCase() === 'button') {
          return;
        }
        event.preventDefault();
        openControlTowerAction(controlTowerAction);
      }, listenerOptions);

      registerListener(settingsView, 'click', (event) => {
        const target = event.target.closest && event.target.closest(
          '[data-action="runSetupAgain"], [data-action="settingsOpenSetupHelp"], [data-action="settingsOpenFactoryReset"]'
        );
        if (!target || target.disabled === true) {
          return;
        }
        const action = target.dataset.action;
        if (action === 'settingsOpenSetupHelp') {
          Promise.resolve(showSetupHelp?.()).catch((error) => {
            showSessionActionError(error, jt('settings.shell.setupHelpFailed', 'Setup Help Failed'));
          });
          return;
        }
        if (action === 'settingsOpenFactoryReset') {
          Promise.resolve(showFactoryReset?.()).catch((error) => {
            showSessionActionError(error, jt('settings.shell.factoryResetFailed', 'Factory Reset Failed'));
          });
          return;
        }
        if (typeof handleRunSetupAgain === 'function') {
          Promise.resolve(handleRunSetupAgain()).catch((error) => {
            showSessionActionError(error, jt('settings.shell.setupRunAgainFailed', 'Setup Run Again Failed'));
          });
        }
      }, listenerOptions);

      registerListener(settingsView, 'click', (event) => {
        const skillsAction = event.target.closest('[data-skills-action]');
        if (!skillsAction) {
          return;
        }
        const action = String(skillsAction.dataset.skillsAction || '').trim();
        const scope = String(skillsAction.dataset.skillsScope || '').trim();
        if (action === 'open-folder' && scope) {
          openSkillsScopeFolder(scope);
        }
      }, listenerOptions);

      // Appearance: the mounted selects, the Advanced switches and spellcheck
      // delegate from the card (the language row binds with settingsView above).
      const appearanceFields = bindDescriptorFields(appearanceSettingsSection, (fieldDescriptors?.listSettingDescriptors({ sectionId: 'appearance' }) || [])
        .filter((descriptor) => descriptor.adapterId !== 'chatUi').map((descriptor) => descriptor.id));
      // The health popover's "Show load in title bar" action writes the same switch.
      if (typeof document !== 'undefined') {
        registerListener(document, 'jenny:titlebar-load-toggle', (event) => {
          const descriptor = fieldDescriptors?.getSettingDescriptor('appearanceTitlebarLoadToggle');
          if (appearanceFields && descriptor) void appearanceFields.commit(descriptor, event?.detail?.enabled === true);
        }, listenerOptions);
      }

      // The Appearance reset is guarded by renderer-settings-field-reset.js.
    }

    return {
      bind,
      dispose,
      ensureSectionBindings(...args) {
        return ensureSectionBindings(...args);
      },
      // A section became visible (the shell's section refresher).
      sectionShown(sectionId) {
        sectionShown(sectionId);
      },
    };
  }

  return { createSettingsEventBindings };
});
