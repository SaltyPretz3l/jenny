/* renderer/shell/renderer-settings-event-utils.js - UMD event bindings extracted from renderer/app.js. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('../shared/async-fence'));
    return;
  }
  root.rendererSettingsEventUtils = factory(root.rendererAsyncFence);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (asyncFenceModule) {
  const settingsCoreRenderers = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsCoreRenderers)
    || (typeof require === 'function' ? require('./renderer-settings-core-renderers') : null)
    || {};
  const settingsSupport = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsSupport)
    || (typeof require === 'function' ? require('./renderer-settings-support') : null)
    || {};
  const settingsSectionBinders = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsSectionBinders)
    || (typeof require === 'function' ? require('./renderer-settings-section-binders') : null)
    || {};
  const settingsPersistenceAdapters = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsPersistenceAdapters)
    || (typeof require === 'function' ? require('./renderer-settings-persistence-adapters') : null)
    || {};
  const {
    getToolConfigFieldsForRender = function fallbackGetToolConfigFieldsForRender() { return []; },
    resolveToolConfigToggleEvent = function fallbackResolveToolConfigToggleEvent() { return null; },
    normalizeDefaultRunMode = function fallbackNormalizeDefaultRunMode() { return 'ask'; },
    resolveDefaultRunModeChangeEvent = function fallbackResolveDefaultRunModeChangeEvent() { return null; },
    resolveWebSearchFieldChangeEvent = function fallbackResolveWebSearchFieldChangeEvent() { return null; },
    resolveWebSearchKeySaveClickEvent = function fallbackResolveWebSearchKeySaveClickEvent() { return null; },
    resolveCompactionFieldChangeEvent = function fallbackResolveCompactionFieldChangeEvent() { return null; },
    WEB_SEARCH_SECRET_KEY_IDS = ['brave', 'tavily', 'serper', 'google_pse', 'google_pse_cx'],
  } = settingsSupport;

  function createSettingsEventBindings(deps) {
    const { state } = deps;
    const webSearchSecretStatusGate = asyncFenceModule.createGenerationGate();

    // UIUX-028(c) + audit hardening: the overall-app-zoom path predates
    // createSettingsAdapter and writes state.ui.appZoomPercent directly, so
    // it shares the adapters' settle-group tracker: the newest write
    // reconciles immediately; rollback DEFERS to group close, targeting the
    // true pre-group baseline -- never a prior overlapping write's
    // un-persisted optimistic value (the audited double-failure strand).
    const appZoomWriteGroup = typeof settingsPersistenceAdapters.createWriteGroup === 'function'
      ? settingsPersistenceAdapters.createWriteGroup()
      : { open: () => 0, isNewest: () => true, settle: () => null };
    function reconcileAppZoomGroupClose(closed) {
      if (closed && (Number(state.ui.appZoomPercent) || 100) !== closed.value) {
        state.ui.appZoomPercent = closed.value;
        renderSettings();
      }
    }

    const {
      settingsView,
      appearanceThemeBundleSelect,
      appearancePaletteSelect,
      appearanceTypographySelect,
      appearanceFontScaleSelect,
      appearanceChatWidthMount,
      appearanceSurfaceEffectSelect,
      appearanceHoloList,
      appearanceSpellcheckList,
      composerChatZoomSelect,
      appearanceAppZoomSelect,
      toolsWorkspaceChooseButton,
      contextHistoryScopeSelect,
      contextSourcesList,
      contextRuntimeList,
      contextCompactionTuning,
      toolsConfigFieldList,
      toolsApprovalRulesList,
      editorSettingsFieldList,
      homeSettingsFieldList,
      getSectionDom,
    } = deps.dom;

    const {
      renderAll,
      renderSettings,
      renderComposerPopover,
      applyAppearancePreferences,
      applyChatZoomPercent,
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
    let defaultRunModeWriteVersion = 0;
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

      // Tools > Approval rules: Remove clears a per-tool policy or deletes a
      // path-scoped rule through tools.*, then refetches the list.
      settingsCoreRenderers.bindApprovalRules?.({
        container: toolsApprovalRulesList,
        api: (typeof window !== 'undefined' && window.jennyShell?.tools) || null,
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
        },
      }) || null;

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

      registerListener(contextHistoryScopeSelect, 'change', () => {
        const previousValue = getRuntimePreferenceSnapshot();
        runRuntimePreferenceActivity({
          patch: {
            contextPreferences: {
              ...getCurrentRuntimePreferences().contextPreferences,
              historyScope: contextHistoryScopeSelect.value,
            },
          },
          scopes: [ACTIVITY_SCOPE.settingsContextPreferences],
          previousValue,
          failureMessage: () => 'Could not save context history scope.',
          successMessage: '',
        }).catch((error) => {
          showSessionActionError(error, 'Context Update Failed');
        });
      }, listenerOptions);

      // Context toggles are inventory switches rendered into two delegated
      // containers. Route each inv-toggle-change back to its persistence path:
      // "sources" are session runtime preferences; "runtime" are feature flags.
      const CONTEXT_PREF_TOGGLES = {
        contextIncludePersonalityToggle: 'includePersonality',
        contextIncludeMemoryToggle: 'includeMemory',
      };
      const CONTEXT_FLAG_TOGGLES = {
        contextTokenBudgetToggle: 'token_budget',
        contextCompactionToggle: 'context_compaction',
      };
      function handleContextToggleChange(event) {
        const id = String(event?.detail?.id || '');
        const checked = Boolean(event?.detail?.checked);
        const prefKey = CONTEXT_PREF_TOGGLES[id];
        if (prefKey) {
          const previousValue = getRuntimePreferenceSnapshot();
          runRuntimePreferenceActivity({
            patch: {
              contextPreferences: {
                ...getCurrentRuntimePreferences().contextPreferences,
                [prefKey]: checked,
              },
            },
            scopes: [ACTIVITY_SCOPE.settingsContextPreferences],
            previousValue,
            failureMessage: () => 'Could not save context preferences.',
            successMessage: '',
          }).catch((error) => {
            showSessionActionError(error, 'Context Update Failed');
          });
          return;
        }
        const flagKey = CONTEXT_FLAG_TOGGLES[id];
        if (flagKey) {
          applyFeatureSettings({
            featureOverrides: { [flagKey]: checked },
          }, 'Context Feature Update Failed');
        }
      }
      registerListener(contextSourcesList, 'inv-toggle-change', handleContextToggleChange, listenerOptions);
      registerListener(contextRuntimeList, 'inv-toggle-change', handleContextToggleChange, listenerOptions);

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
        resolveCompactionFieldChangeEvent,
        showSessionActionError,
      });

      registerListener(toolsConfigFieldList, 'inv-toggle-change', (event) => {
        const resolvedToggle = resolveToolConfigToggleEvent(
          event,
          getToolConfigFieldsForRender(state.features)
        );
        if (!resolvedToggle) {
          return;
        }
        if (state.features?.availability?.tools?.[resolvedToggle.key]?.enabled === false) {
          renderSettings();
          return;
        }
        applyFeatureSettings({
          tools: {
            [resolvedToggle.key]: resolvedToggle.checked,
          },
        }, `${resolvedToggle.label || 'Tool'} Update Failed`);
      }, listenerOptions);

      registerListener(toolsConfigFieldList, 'change', (event) => {
        const resolved = resolveDefaultRunModeChangeEvent(event);
        if (!resolved) return;
        const api = (typeof window !== 'undefined' && window.jennyShell?.chatUi) || null;
        if (!api || typeof api.updateSettings !== 'function') {
          renderSettings();
          showSessionActionError(new Error('Chat settings are unavailable.'), 'Default Run Mode Update Failed');
          return;
        }
        const version = ++defaultRunModeWriteVersion;
        Promise.resolve(api.updateSettings({ defaultRunMode: resolved.value })).then((snapshot) => {
          if (!bound || version !== defaultRunModeWriteVersion) return;
          if (!Object.prototype.hasOwnProperty.call(snapshot || {}, 'defaultRunMode')) {
            throw new Error('The saved run mode could not be confirmed.');
          }
          const persisted = normalizeDefaultRunMode(snapshot.defaultRunMode);
          if (persisted !== resolved.value) {
            throw new Error('The saved run mode could not be confirmed.');
          }
          state.defaultRunMode = persisted;
          if (!state.currentSessionId && state.runtimeDraft) state.runtimeDraft.runMode = persisted;
          renderSettings();
        }).catch((error) => {
          if (!bound || version !== defaultRunModeWriteVersion) return;
          renderSettings();
          showSessionActionError(error, 'Default Run Mode Update Failed');
        });
      }, listenerOptions);

      // Web search provider section: renders inside the same toolsConfigFieldList
      // container (no dedicated index.html host this wave). Provider/URL fields
      // route through the existing applyFeatureSettings -> features.updateSettings
      // path; the per-provider key fields go straight to the dedicated secret IPC
      // (never persisted through the general feature-settings patch).
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
      registerListener(toolsConfigFieldList, 'change', (event) => {
        const resolved = resolveWebSearchFieldChangeEvent(event);
        if (!resolved) {
          return;
        }
        if (resolved.field === 'provider') {
          ensureWebSearchSecretStatus();
          applyFeatureSettings({ webSearch: { provider: resolved.value } }, 'Web Search Provider Update Failed');
          return;
        }
        if (resolved.field === 'searxngUrl') {
          applyFeatureSettings({ webSearch: { searxngUrl: resolved.value } }, 'SearXNG URL Update Failed');
        }
      }, listenerOptions);
      registerListener(toolsConfigFieldList, 'click', (event) => {
        const testButton = event.target?.closest?.('[data-web-search-test]');
        if (testButton) {
          const status = toolsConfigFieldList.querySelector('[data-web-search-test-status]');
          testButton.disabled = true;
          if (status) status.textContent = 'Testing the selected provider…';
          Promise.resolve(window.jennyShell?.harness?.inspect?.({ web_search_probe: true }))
            .then((snapshot) => {
              const probe = snapshot?.web_search_probe || {};
              if (status) status.textContent = probe.ok === true
                ? `Connected to ${String(probe.provider || 'the selected provider')}.`
                : `Connection failed: ${String(probe.error || 'provider unavailable').slice(0, 160)}`;
            })
            .catch(() => {
              if (status) status.textContent = 'Connection test unavailable. Local chat is unaffected.';
            })
            .finally(() => { testButton.disabled = false; });
          return;
        }
        const resolved = resolveWebSearchKeySaveClickEvent(event);
        if (!resolved || !WEB_SEARCH_SECRET_KEY_IDS.includes(resolved.keyId)) {
          return;
        }
        const input = toolsConfigFieldList.querySelector(`[data-web-search-key-field="${resolved.keyId}"]`);
        const api = webSearchApi();
        if (!input || !api || typeof api.setWebSearchSecret !== 'function') {
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
                'Key saved. It will apply after the sidecar config refreshes or Jenny restarts.',
                { title: 'Web Search Key Saved', tone: 'info', source: TOAST_SOURCE.settings }
              );
            }
          }
          renderSettings();
        }).catch((error) => {
          showSessionActionError(error, 'Web Search Key Update Failed');
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
            showSessionActionError(error, 'Setup Help Failed');
          });
          return;
        }
        if (action === 'settingsOpenFactoryReset') {
          Promise.resolve(showFactoryReset?.()).catch((error) => {
            showSessionActionError(error, 'Factory Reset Failed');
          });
          return;
        }
        if (typeof handleRunSetupAgain === 'function') {
          Promise.resolve(handleRunSetupAgain()).catch((error) => {
            showSessionActionError(error, 'Setup Run Again Failed');
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

      registerListener(appearanceThemeBundleSelect, 'change', () => {
        var bundleId = String(appearanceThemeBundleSelect?.value || '').trim().toLowerCase();
        if (!bundleId || bundleId === 'custom') {
          renderSettings();
          return;
        }
        var appearanceUtilsRef = appearanceUtils && typeof appearanceUtils === 'object' ? appearanceUtils : null;
        var bundle = appearanceUtilsRef?.resolveThemeBundle?.(bundleId);
        if (!bundle || !bundle.preferences) {
          renderSettings();
          return;
        }
        // A theme bundle owns only palette, typography, surface, and the
        // Composer effect. Applying
        // bundle.preferences wholesale (it is always fully normalized, so it
        // ALWAYS carries a fontScaleId/timelineStyleId even though no bundle
        // defines one) silently reset Extra Large text back to Default on
        // every bundle switch. Merge only the bundle's own axes onto the
        // CURRENT preferences instead of replacing them outright.
        var bundleAxes = appearanceUtilsRef?.pickThemeBundleAxes?.(bundle.preferences) || bundle.preferences;
        var appliedPreferences = applyAppearancePreferences({ ...state.ui.appearance, ...bundleAxes }) || state.ui.appearance;
        applySurfaceEffect();
        activateSurfaceEffect(appliedPreferences.surfaceEffectId || 'none');
        renderSettings();
      }, listenerOptions);

      registerListener(appearancePaletteSelect, 'change', () => {
        applyAppearancePreferences({
          ...state.ui.appearance,
          paletteId: appearancePaletteSelect.value,
        });
        renderSettings();
      }, listenerOptions);

      registerListener(appearanceTypographySelect, 'change', () => {
        applyAppearancePreferences({
          ...state.ui.appearance,
          typographyId: appearanceTypographySelect.value,
        });
        renderSettings();
      }, listenerOptions);

      registerListener(appearanceFontScaleSelect, 'change', () => {
        applyAppearancePreferences({
          ...state.ui.appearance,
          fontScaleId: appearanceFontScaleSelect.value,
        });
        renderSettings();
      }, listenerOptions);

      // Delegated: the select is mounted by renderSettings(), so there is no
      // stable node to capture at bootstrap. `change` bubbles from it.
      registerListener(appearanceChatWidthMount, 'change', (event) => {
        const target = event && event.target;
        if (!target || target.id !== 'appearanceChatWidthSelect') return;
        applyAppearancePreferences({
          ...state.ui.appearance,
          chatWidthId: target.value,
        });
        renderSettings();
      }, listenerOptions);

      registerListener(appearanceSurfaceEffectSelect, 'change', () => {
        var appliedPreferences = applyAppearancePreferences({
          ...state.ui.appearance,
          surfaceEffectId: appearanceSurfaceEffectSelect.value,
        }) || state.ui.appearance;
        applySurfaceEffect();
        activateSurfaceEffect(appliedPreferences.surfaceEffectId || 'none');
        renderSettings();
      }, listenerOptions);

      registerListener(appearanceHoloList, 'inv-toggle-change', (event) => {
        const detail = (event && event.detail) || {};
        if (detail.id !== 'appearanceComposerHoloToggle') return;
        applyAppearancePreferences({
          ...state.ui.appearance,
          composerHoloId: detail.checked === true ? 'on' : 'off',
        });
        renderSettings();
      }, listenerOptions);

      registerListener(appearanceSpellcheckList, 'inv-toggle-change', (event) => {
        const detail = (event && event.detail) || {};
        if (detail.id !== 'appearanceSpellcheckToggle') return;
        applyFeatureSettings({
          featureOverrides: { text_spellcheck: detail.checked === true },
        }, 'Spell Check Update Failed');
      }, listenerOptions);

      registerListener(composerChatZoomSelect, 'change', () => {
        applyChatZoomPercent(Number(composerChatZoomSelect.value))
          .then(() => {
            renderSettings();
            renderComposerPopover();
          })
          .catch((error) => {
            showSessionActionError(error, 'Chat Zoom Update Failed');
          });
      }, listenerOptions);

      registerListener(appearanceAppZoomSelect, 'change', () => {
        // Overall app zoom persists + applies in the main process
        // (webContents.setZoomFactor); we optimistically reflect the chosen
        // value, then reconcile with the normalized value main returns.
        // UIUX-028(c): failure rollback + stale-response suppression run
        // through the settle group (see reconcileAppZoomGroupClose above).
        var requestedPercent = Number(appearanceAppZoomSelect.value) || 100;
        var myAppZoomToken = appZoomWriteGroup.open(() => Number(state.ui.appZoomPercent) || 100);
        state.ui.appZoomPercent = requestedPercent;
        Promise.resolve(window.jennyShell?.windowUi?.updateSettings?.({ appZoomPercent: requestedPercent }))
          .then((nextWindowUi) => {
            var appliedPercent = Number(nextWindowUi?.appZoomPercent);
            var finalPercent = Number.isFinite(appliedPercent) ? appliedPercent : requestedPercent;
            if (appZoomWriteGroup.isNewest(myAppZoomToken)) {
              state.ui.appZoomPercent = finalPercent;
              renderSettings();
            }
            reconcileAppZoomGroupClose(appZoomWriteGroup.settle(myAppZoomToken, true, finalPercent));
          })
          .catch((error) => {
            reconcileAppZoomGroupClose(appZoomWriteGroup.settle(myAppZoomToken, false));
            showSessionActionError(error, 'App Zoom Update Failed');
          });
      }, listenerOptions);

      // The Appearance reset is guarded by renderer-settings-field-reset.js.
    }

    return {
      bind,
      dispose,
      ensureSectionBindings(...args) {
        return ensureSectionBindings(...args);
      },
    };
  }

  return { createSettingsEventBindings };
});
