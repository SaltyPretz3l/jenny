/* renderer/shell/renderer-settings-shell-controller.js - Internal settings-surface composition. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsShellControllerUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const settingsSectionRegistry = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsSectionRegistry)
    || (typeof require === 'function' ? require('./renderer-settings-section-registry') : null)
    || {};
  const settingsRefreshUtils = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsRefreshUtils)
    || (typeof require === 'function' ? require('./renderer-settings-refresh-utils') : null)
    || {};
  const persistenceAdaptersUtils = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsPersistenceAdapters)
    || (typeof require === 'function' ? require('./renderer-settings-persistence-adapters') : null)
    || {};
  const fieldResetUtils = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsFieldReset)
    || (typeof require === 'function' ? require('./renderer-settings-field-reset') : null)
    || {};
  const settingsSnapshotPoll = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsSnapshotPoll)
    || (typeof require === 'function' ? require('./renderer-settings-snapshot-poll') : null)
    || {};
  const DEFAULT_SETTINGS_SECTION = settingsSectionRegistry.DEFAULT_SETTINGS_SECTION || 'models';
  const SETTINGS_STORAGE_KEY = settingsSectionRegistry.SETTINGS_STORAGE_KEY || 'jenny.settings.activeSection';
  function isLazySettingsSection(sectionId) {
    if (typeof settingsSectionRegistry.isLazySettingsSection === 'function') {
      return settingsSectionRegistry.isLazySettingsSection(sectionId);
    }
    return new Set([
      'skills',
      'offline',
      'personality',
      'memories',
      'usage',
    ]).has(String(sectionId || '').trim());
  }
  function normalizeSettingsSectionId(sectionId) {
    if (typeof settingsSectionRegistry.normalizeSettingsSectionId === 'function') {
      return settingsSectionRegistry.normalizeSettingsSectionId(sectionId);
    }
    return String(sectionId || '').trim() || DEFAULT_SETTINGS_SECTION;
  }
  /* Hidden sections merged into a host card (Skills -> Plugins & Extensions). The
   * host readies + refreshes them as companions when it is shown, so the merged
   * subsections behave exactly like their former standalone sections did. */
  function companionSectionIds(sectionId) {
    if (typeof settingsSectionRegistry.getSettingsCompanionSectionIds === 'function') {
      return settingsSectionRegistry.getSettingsCompanionSectionIds(sectionId) || [];
    }
    return [];
  }

  function createSettingsShellController(deps) {
    const { state, composerLayoutRuntime } = deps;
    const dom = deps.dom || {};
    const callbacks = deps.callbacks || {};
    const factories = deps.factories || {};
    const globalWindow = typeof globalThis !== 'undefined' ? globalThis.window || null : null;
    const globalDocument = typeof globalThis !== 'undefined' ? globalThis.document || null : null;

    // UIUX-009: the 15s snapshot poll (renderer-app-shell-bindings.js) rerenders
    // Settings on every tick. Two subtrees repaint via innerHTML from
    // last-persisted state -- compaction custom-prompt textarea, web-search
    // provider/API-key fields -- and would otherwise erase in-progress typing.
    // This guard is consulted by renderSettings() (via deps.shouldPatchSection
    // below) before either subtree repaints: it never patches across an active
    // focus or an unsaved local draft, and skips the repaint entirely when the
    // underlying data signature hasn't changed. showToastMessage is the
    // existing settings notice idiom (see the "Key saved..." toast in
    // renderer-settings-event-utils.js) reused here for the rare case where a
    // patch is held back because a draft collided with a real upstream change.
    const settingsToastSource = (deps.constants && deps.constants.TOAST_SOURCE) || {};
    function notifySettingsConflict(message, dedupeKey) {
      if (typeof showToastMessage !== 'function') return;
      showToastMessage(message, {
        title: 'Settings Updated Elsewhere',
        tone: 'warning',
        source: settingsToastSource.settings,
        dedupeKey,
      });
    }
    const WEB_SEARCH_GUARD_KEY_IDS = ['brave', 'tavily', 'serper', 'google_pse', 'google_pse_cx'];
    const settingsPatchGuard = settingsSnapshotPoll.createSectionPatchGuard?.({
      state,
      documentRef: () => globalDocument,
      sections: {
        compactionPrompt: {
          containerId: 'contextCompactionTuning',
          fieldSelector: '[data-compaction-field]',
          signature: (s) => settingsSnapshotPoll.buildSignature([
            'compaction', s.compactionTuning, s.compactionTuningActivity,
            globalThis.rendererCompactionCoordinator?.getCompactionActivity?.(s, s.currentSessionId),
            s.features?.featureFlags?.compaction_manual, s.backend?.mode,
            callbacks.getCurrentRuntimePreferences?.()?.preferredModel,
            s.status?.model, s.modelList?.active_model,
          ]),
          fields: {
            customPrompt: (s) => String(s.compactionTuning?.customPrompt || ''),
          },
          fieldKeyForElement: (fieldEl) => (
            typeof fieldEl.getAttribute === 'function' && fieldEl.getAttribute('data-compaction-field') === 'customPrompt'
              ? 'customPrompt'
              : null
          ),
          onConflict: () => notifySettingsConflict(
            'Compaction settings changed elsewhere while you were editing. Your draft is kept -- save it or reopen Settings to see the latest.',
            `${settingsToastSource.settings}:compaction:conflict`
          ),
        },
        toolsConfig: {
          containerId: 'toolsConfigFieldList',
          fieldSelector: '[data-web-search-key-field], [data-web-search-field]',
          signature: (s) => settingsSnapshotPoll.buildSignature([
            'tools', s.features?.tools, s.features?.availability?.tools,
            s.features?.featureFlags?.web_search_providers, s.features?.webSearch, s.webSearchSecrets,
          ]),
          fields: {
            'webSearch:provider': (s) => String(s.features?.webSearch?.provider || 'duckduckgo'),
            'webSearch:searxngUrl': (s) => String(s.features?.webSearch?.searxngUrl || ''),
            // Key/password fields are NEVER pre-filled with a real secret (see
            // buildWebSearchKeyFieldMarkup) -- the painted baseline is always ''.
            ...Object.fromEntries(WEB_SEARCH_GUARD_KEY_IDS.map((keyId) => [`webSearch:key:${keyId}`, () => ''])),
          },
          fieldKeyForElement: (fieldEl) => {
            if (typeof fieldEl.getAttribute !== 'function') return null;
            const keyFieldId = fieldEl.getAttribute('data-web-search-key-field');
            if (keyFieldId) return `webSearch:key:${keyFieldId}`;
            const fieldName = fieldEl.getAttribute('data-web-search-field');
            if (fieldName === 'provider') return 'webSearch:provider';
            if (fieldName === 'searxngUrl') return 'webSearch:searxngUrl';
            return null;
          },
          onConflict: () => notifySettingsConflict(
            'Web search settings changed elsewhere while you were editing. Your draft is kept -- save it or reopen Settings to see the latest.',
            `${settingsToastSource.settings}:tools:conflict`
          ),
        },
      },
    }) || null;
    const shouldPatchSection = settingsPatchGuard
      ? (sectionId) => settingsPatchGuard.shouldPatchSection(sectionId)
      : () => true;

    const settingsRendererUtils = factories.settingsRendererUtils || globalThis.rendererSettingsUtils || {};
    const settingsEventUtils = factories.settingsEventUtils || globalThis.rendererSettingsEventUtils || {};
    const settingsNavUtils = factories.settingsNavUtils || globalThis.rendererSettingsNavUtils || {};

    const {
      setActiveView = function noopSetActiveView() {},
      renderAll = function noopRenderAll() {},
      renderLogs = function noopRenderLogs() {},
      renderSessions = function noopRenderSessions() {},
      setSidebarCollapsed,
      upsertApprovedMemoryDraft,
      getApprovedMemoryById,
      hasApprovedMemoryDraftChanges,
      clearApprovedMemoryDraft,
      handleApprovedMemorySave,
      handleApprovedMemoryDelete,
      applyAppearancePreferences,
      applyChatZoomPercent,
      appearanceUtils,
      getDefaultAppearancePreferences,
      applySurfaceEffect,
      activateSurfaceEffect,
      handlePersonalityTabChange,
      getPersonalityActiveFile,
      setPersonalityDraft,
      renderPersonalityEditor,
      handlePersonalitySave,
      handlePersonalityReset,
      handlePersonalityOpenFolder,
      hasPersonalityUnsavedChanges,
      refreshMemoryContextFiles,
      renderMemoryContextFiles,
      loadMemoryContextFile,
      setMemoryContextDraft,
      getMemoryContextActiveFile,
      saveMemoryContextFile,
      resetMemoryContextFile,
      hasMemoryContextUnsavedChanges,
      showToastMessage,
      showShellErrorToast,
      toErrorMessage,
      appendClientLog = function noopAppendClientLog() {},
      showSessionActionError,
      getCurrentRuntimePreferences,
      getRuntimePreferenceSnapshot,
      runRuntimePreferenceActivity,
      handleWorkspaceRootChoose,
      handleRunSetupAgain,
      showSetupHelp,
      showFactoryReset,
      refreshSkillsState,
      bindSkillsShellEvents = function noopBindSkillsShellEvents() {},
      updateSkillsSettings,
      openSkillsScopeFolder,
      refreshOfflineState,
      bindOfflineShellEvents = function noopBindOfflineShellEvents() {},
      handleOfflineModeChange,
      refreshFeatureState,
      getCurrentSessionId = function noopGetCurrentSessionId() { return ''; },
      openSession = function noopOpenSession() {},
      navigateToDiagnosticsTrace = function noopNavigateToDiagnosticsTrace() {},
      refreshApprovedMemories,
      refreshPendingMemories,
      refreshMemoryStatus,
      refreshPersonalityWorkspace,
      listSlashCommands = function noopListSlashCommands() { return []; },
      normalizeAppearancePreferences,
      getPalettePresets,
      getTypographyPresets,
      getSurfaceEffectPresets,
      getThemeBundles = function fallbackGetThemeBundles() { return []; },
      getComposerHoloOptions = function fallbackGetComposerHoloOptions() { return []; },
      getFontScalePresets = function fallbackGetFontScalePresets() { return []; },
      getChatWidthPresets = function fallbackGetChatWidthPresets() { return []; },
      detectActiveThemeBundle = function fallbackDetectActiveThemeBundle() { return null; },
      getChatZoomOptions = function fallbackGetChatZoomOptions() { return []; },
      normalizeChatZoomPercent = function fallbackNormalizeChatZoomPercent(value) { return Number(value) || 100; },
      getActivitySnapshot,
      getMostRecentActivity,
      isActivityBusy,
      applyActivityAttributes,
      getActiveSession,
      buildModelOptionMarkup,
      buildSelectOptionMarkup,
      isDefaultAppearancePreferences,
      isDefaultChatZoomPercent,
      resolveComposerModelSelectWidth,
      updateComposerSafeOffset,
      renderApprovedMemoryManager,
      renderSkillsManager,
      renderOfflineManager,
      escapeHtml,
    } = callbacks;
    const getSectionDom = typeof dom.getSectionDom === 'function'
      ? dom.getSectionDom
      : function noopGetSectionDom() { return {}; };
    const initializedSections = new Set(['models', 'appearance', 'context', 'tools', 'account', 'editor', 'home']);
    const refreshPromises = new Map();
    let usageController = null;
    let usageConfirmDialog = null;

    function ensureUsageController() {
      if (usageController) return usageController;
      const usageUtils = factories.usageControllerUtils || globalThis.rendererUsageController || {};
      const windowRef = deps.windowRef || globalWindow || globalThis;
      usageController = usageUtils.createUsageController?.({
        window: windowRef,
        dom: getSectionDom('usage'),
        callbacks: {
          getCurrentSessionId,
          isVisible: () => state.ui.activeView === 'settings'
            && normalizeSettingsSectionId(state.ui.activeSettingsSection) === 'usage',
          openSession,
          openTrace: (target) => navigateToDiagnosticsTrace(target),
          appendClientLog,
          confirmClear: async () => {
            if (!usageConfirmDialog) {
              const factory = windowRef.rendererIdeConfirmDialog?.createIdeConfirmDialog;
              const helpOverlayFactory = windowRef.inventoryHelpOverlay?.createHelpOverlay;
              if (typeof factory === 'function' && typeof helpOverlayFactory === 'function') {
                usageConfirmDialog = factory({
                  document: windowRef.document,
                  actionButton: windowRef.inventoryActionButton,
                  helpOverlayFactory,
                  hostId: 'usageHistoryClearConfirmOverlay',
                });
              }
            }
            return usageConfirmDialog?.confirm?.({
              title: 'Clear usage history?',
              message: 'This permanently removes all retained local usage rows and totals.',
              confirmLabel: 'Clear history',
              cancelLabel: 'Cancel',
              variant: 'danger',
            }) || false;
          },
        },
      }) || null;
      return usageController;
    }

    const sectionInitHooks = Object.freeze({
      offline: () => bindOfflineShellEvents(),
      skills: () => bindSkillsShellEvents(true),
      usage: () => ensureUsageController()?.bind?.(),
    });

    const sectionRefreshers = Object.freeze({
      skills: () => Promise.resolve(refreshSkillsState?.()),
      offline: () => Promise.resolve(refreshOfflineState?.()),
      personality: () => Promise.resolve(refreshPersonalityWorkspace?.()),
      memories: () => runRefreshBatch('memories', [
        { name: 'memory_context_files', run: () => refreshMemoryContextFiles?.() },
        { name: 'approved_memories', run: () => refreshApprovedMemories?.({ force: true }) },
        { name: 'pending_memories', run: () => refreshPendingMemories?.({ force: true }) },
        { name: 'memory_status', run: () => refreshMemoryStatus?.({ force: true }) },
      ]),
      usage: () => ensureUsageController()?.activate?.(),
    });

    function runRefreshBatch(sectionId, tasks) {
      return settingsRefreshUtils.runSettingsRefreshBatch?.({
        sectionId,
        tasks,
        state,
        appendClientLog,
      }) || Promise.allSettled(tasks.map((task) => {
        try {
          return Promise.resolve(task.run());
        } catch (error) {
          return Promise.reject(error);
        }
      }));
    }

    function refreshSectionWithWarning(sectionId, options = {}) {
      refreshSettingsSection(sectionId, options).catch((error) => {
        appendClientLog('WARN', 'settings.section_refresh_failed', {
          message: error.message || String(error),
          section: sectionId,
        });
      });
    }

    function isSectionInitialized(sectionId) {
      return initializedSections.has(String(sectionId || '').trim());
    }

    // Accessor for the search layer's queued-flash hardening: a field hit can
    // navigate to a lazy section before its refresh (and therefore its DOM)
    // has settled — flashing immediately then blinks an empty card. Callers
    // check this after navigating and, if it returns a pending promise, defer
    // the flash to its .finally() instead of the next animation frame.
    function getSectionRefreshPromise(sectionId) {
      return refreshPromises.get(normalizeSettingsSectionId(sectionId)) || null;
    }

    // Bind + init a single lazy section (no companion fan-out). Eager/already-init
    // sections are a no-op. Companions are readied by ensureSettingsSectionReady.
    function readySectionBindings(sectionId) {
      if (!isLazySettingsSection(sectionId) || initializedSections.has(sectionId)) {
        return;
      }
      getSectionDom(sectionId);
      const didBindSection = settingsEventBindings?.ensureSectionBindings?.(sectionId);
      if (didBindSection === false) {
        return;
      }
      initializedSections.add(sectionId);
      sectionInitHooks[sectionId]?.();
    }

    function ensureSettingsSectionReady(sectionId) {
      const normalizedSectionId = normalizeSettingsSectionId(sectionId);
      readySectionBindings(normalizedSectionId);
      // Ready merged-in companions (Skills under Plugins & Extensions) so
      // their controls bind the first time the host card is shown.
      companionSectionIds(normalizedSectionId).forEach(readySectionBindings);
      return normalizedSectionId;
    }

    // Fire-and-forget lazy refresh of a single section (used for merged companions
    // so a non-lazy host like Tools still drives Skills' deferred MCP discovery).
    // Honors the host's render flag so a silent (render:false) host refresh stays silent.
    function refreshSectionLazily(sectionId, renderOnSettle) {
      if (!isLazySettingsSection(sectionId) || refreshPromises.has(sectionId)) {
        return;
      }
      const refreshTask = sectionRefreshers[sectionId]?.() || null;
      if (!refreshTask) {
        return;
      }
      const guardedTask = Promise.resolve(refreshTask)
        .finally(() => {
          refreshPromises.delete(sectionId);
          if (renderOnSettle && bound) {
            renderSettings();
          }
        });
      refreshPromises.set(sectionId, guardedTask);
    }

    function refreshSettingsSection(sectionId, options = {}) {
      const normalizedSectionId = normalizeSettingsSectionId(sectionId);
      ensureSettingsSectionReady(normalizedSectionId);
      // Opt-in narrowed render for the host section (the 2s diagnostics poll
      // repaints only its own section instead of the whole settings page);
      // defaults to the full render, and companions always full-render below.
      const renderSettle = typeof options.renderOverride === 'function'
        ? options.renderOverride
        : renderSettings;
      // Refresh merged-in companions alongside the host (regardless of host laziness).
      const renderCompanions = options.render !== false;
      companionSectionIds(normalizedSectionId).forEach((companionId) => {
        refreshSectionLazily(companionId, renderCompanions);
      });
      if (!isLazySettingsSection(normalizedSectionId)) {
        if (options.render !== false) {
          renderSettle();
        }
        return Promise.resolve();
      }
      if (refreshPromises.has(normalizedSectionId)) {
        return refreshPromises.get(normalizedSectionId);
      }
      const refreshTask = sectionRefreshers[normalizedSectionId]?.() || null;
      if (!refreshTask) {
        if (options.render !== false) {
          renderSettle();
        }
        return Promise.resolve();
      }
      const guardedTask = Promise.resolve(refreshTask)
        .finally(() => {
          refreshPromises.delete(normalizedSectionId);
          if (options.render !== false && bound) {
            renderSettle();
          }
        });
      refreshPromises.set(normalizedSectionId, guardedTask);
      return guardedTask;
    }

    function persistActiveSection(sectionId) {
      try {
        globalWindow?.localStorage?.setItem?.(SETTINGS_STORAGE_KEY, sectionId);
      } catch (error) {
        appendClientLog('WARN', 'settings.active_section_persist_failed', {
          section: sectionId,
          message: error.message || String(error),
        });
      }
    }

    function confirmSettingsSectionChange(nextSectionId, previousSectionId) {
      const hasUnsavedChanges = previousSectionId === 'personality'
        ? hasPersonalityUnsavedChanges?.() === true
        : previousSectionId === 'memories' && hasMemoryContextUnsavedChanges?.() === true;
      if (!hasUnsavedChanges || nextSectionId === previousSectionId) return true;
      return typeof globalWindow?.confirm === 'function'
        ? globalWindow.confirm('You have unsaved context-file changes. Leave this section without saving?')
        : false;
    }

    function navigateSettingsSection(sectionId, options = {}) {
      const normalizedSectionId = normalizeSettingsSectionId(sectionId);
      const previousSectionId = state.ui.activeSettingsSection;
      setActiveView('settings');
      if (settingsNavController?.setActiveSection) {
        if (settingsNavController.setActiveSection(normalizedSectionId) === false) return false;
        if (options.refresh === true && previousSectionId === normalizedSectionId) {
          refreshSectionWithWarning(normalizedSectionId, { render: options.render !== false });
        }
      } else {
        if (!confirmSettingsSectionChange(normalizedSectionId, previousSectionId)) return false;
        state.ui.activeSettingsSection = normalizedSectionId;
        persistActiveSection(normalizedSectionId);
        ensureSettingsSectionReady(normalizedSectionId);
        if (options.refresh === true) {
          refreshSectionWithWarning(normalizedSectionId, { render: options.render !== false });
        }
      }
      if (normalizedSectionId !== 'usage') usageController?.deactivate?.();
    }

    function openSettingsSection(sectionId, options) {
      return navigateSettingsSection(sectionId, options);
    }

    const settingsController = settingsRendererUtils.createSettingsRenderer?.({
      state,
      composerLayoutRuntime,
      shouldPatchSection,
      constants: { ACTIVITY_SCOPE: deps.constants.ACTIVITY_SCOPE },
      dom: {
        composerModelSelect: dom.composerModelSelect,
        composerEffortSelect: dom.composerEffortSelect,
        appearanceThemeBundleSelect: dom.appearanceThemeBundleSelect,
        appearancePaletteSelect: dom.appearancePaletteSelect,
        appearanceTypographySelect: dom.appearanceTypographySelect,
        appearanceFontScaleSelect: dom.appearanceFontScaleSelect,
        appearanceChatWidthMount: dom.appearanceChatWidthMount,
        appearanceSurfaceEffectSelect: dom.appearanceSurfaceEffectSelect,
        appearanceSurfaceEffectDescription: dom.appearanceSurfaceEffectDescription,
        appearanceSurfaceEffectMeta: dom.appearanceSurfaceEffectMeta,
        appearanceSurfaceEffectPreview: dom.appearanceSurfaceEffectPreview,
        appearanceHoloList: dom.appearanceHoloList,
        appearanceSpellcheckList: dom.appearanceSpellcheckList,
        appearanceAppZoomSelect: dom.appearanceAppZoomSelect,
        composerSettingsPopover: dom.composerSettingsPopover,
        composerSettingsButton: dom.composerSettingsButton,
        composerChatZoomSelect: dom.composerChatZoomSelect,
        composerChatZoomStatus: dom.composerChatZoomStatus,
        composerCommandPopover: dom.composerCommandPopover,
        composerCommandPopoverList: dom.composerCommandPopoverList,
        composerTerminalShortcut: dom.composerTerminalShortcut,
        settingsModelCard: dom.settingsModelCard,
        modelBadge: dom.modelBadge,
        modelStatus: dom.modelStatus,
        appearanceBadge: dom.appearanceBadge,
        appearanceStatus: dom.appearanceStatus,
        appearanceResetButton: dom.appearanceResetButton,
        modelCatalogEmpty: dom.modelCatalogEmpty,
        accountBadge: dom.accountBadge,
        accountSummary: dom.accountSummary,
        localProfileSettingsMount: dom.localProfileSettingsMount,
        backendSummary: dom.backendSummary,
        setupSettingsSummary: dom.setupSettingsSummary,
        setupSettingsActions: dom.setupSettingsActions,
        setupProgressContainer: dom.setupProgressContainer,
        settingsControlTowerHost: dom.settingsControlTowerHost,
        skillsSettingsNavItem: dom.skillsSettingsNavItem,
        skillsSettingsSection: dom.skillsSettingsSection,
        contextBadge: dom.contextBadge,
        contextStatus: dom.contextStatus,
        contextHistoryScopeSelect: dom.contextHistoryScopeSelect,
        contextSourcesList: dom.contextSourcesList,
        contextRuntimeList: dom.contextRuntimeList,
        contextCompactionTuning: dom.contextCompactionTuning,
        toolsConfigFieldList: dom.toolsConfigFieldList,
        toolsApprovalRulesList: dom.toolsApprovalRulesList,
        toolsWorkspacePath: dom.toolsWorkspacePath,
        toolsWorkspaceStatus: dom.toolsWorkspaceStatus,
        toolsWorkspaceChooseButton: dom.toolsWorkspaceChooseButton,
        toolsSummary: dom.toolsSummary,
        editorBadge: dom.editorBadge,
        editorStatus: dom.editorStatus,
        editorSettingsFieldList: dom.editorSettingsFieldList,
        homeBadge: dom.homeBadge,
        homeStatus: dom.homeStatus,
        homeSettingsFieldList: dom.homeSettingsFieldList,
        contextPreview: dom.contextPreview,
        chatInput: deps.chatInput,
        composerModelSelectEl: dom.composerModelSelect,
      },
      callbacks: {
        getCurrentRuntimePreferences,
        normalizeAppearancePreferences,
        getPalettePresets,
        getTypographyPresets,
        getSurfaceEffectPresets,
        getThemeBundles,
        getComposerHoloOptions,
        getFontScalePresets,
        getChatWidthPresets,
        detectActiveThemeBundle,
        getChatZoomOptions,
        normalizeChatZoomPercent,
        getActivitySnapshot,
        getMostRecentActivity,
        isActivityBusy,
        applyActivityAttributes,
        getActiveSession,
        buildModelOptionMarkup,
        buildSelectOptionMarkup,
        isDefaultAppearancePreferences,
        isDefaultChatZoomPercent,
        renderApprovedMemoryManager,
        renderPersonalityEditor,
        renderSkillsManager,
        renderOfflineManager,
        escapeHtml,
        resolveComposerModelSelectWidth,
        updateComposerSafeOffset: (...args) => updateComposerSafeOffset(...args),
        listSlashCommands: () => listSlashCommands(),
        getSectionDom: (...args) => getSectionDom(...args),
        isSectionInitialized: (...args) => isSectionInitialized(...args),
      },
    }) || null;

    const {
      renderSettings = function noopRenderSettings() {},
      renderComposerPopover = function noopRenderComposerPopover() {},
      renderCommandPopover = function noopRenderCommandPopover() {},
      syncComposerInputHeight = function noopSyncComposerInputHeight() {},
      syncComposerModelSelectWidth = function noopSyncComposerModelSelectWidth() {},
    } = settingsController || {};

    const settingsEventBindings = settingsEventUtils.createSettingsEventBindings?.({
      state,
      constants: {
        TOAST_SOURCE: deps.constants.TOAST_SOURCE,
        ACTIVITY_SCOPE: deps.constants.ACTIVITY_SCOPE,
      },
      dom: {
        settingsView: dom.settingsView,
        appearanceThemeBundleSelect: dom.appearanceThemeBundleSelect,
        appearancePaletteSelect: dom.appearancePaletteSelect,
        appearanceTypographySelect: dom.appearanceTypographySelect,
        appearanceFontScaleSelect: dom.appearanceFontScaleSelect,
        appearanceChatWidthMount: dom.appearanceChatWidthMount,
        appearanceSurfaceEffectSelect: dom.appearanceSurfaceEffectSelect,
        appearanceSurfaceEffectDescription: dom.appearanceSurfaceEffectDescription,
        appearanceSurfaceEffectMeta: dom.appearanceSurfaceEffectMeta,
        appearanceSurfaceEffectPreview: dom.appearanceSurfaceEffectPreview,
        appearanceHoloList: dom.appearanceHoloList,
        appearanceSpellcheckList: dom.appearanceSpellcheckList,
        composerChatZoomSelect: dom.composerChatZoomSelect,
        appearanceAppZoomSelect: dom.appearanceAppZoomSelect,
        toolsWorkspaceChooseButton: dom.toolsWorkspaceChooseButton,
        contextHistoryScopeSelect: dom.contextHistoryScopeSelect,
        contextSourcesList: dom.contextSourcesList,
        contextRuntimeList: dom.contextRuntimeList,
        contextCompactionTuning: dom.contextCompactionTuning,
        toolsConfigFieldList: dom.toolsConfigFieldList,
        toolsApprovalRulesList: dom.toolsApprovalRulesList,
        editorSettingsFieldList: dom.editorSettingsFieldList,
        homeSettingsFieldList: dom.homeSettingsFieldList,
        getSectionDom: (...args) => getSectionDom(...args),
      },
      callbacks: {
        renderSettings,
        renderComposerPopover,
        renderAll,
        renderSessions,
        setSidebarCollapsed,
        upsertApprovedMemoryDraft,
        getApprovedMemoryById,
        hasApprovedMemoryDraftChanges,
        clearApprovedMemoryDraft,
        handleApprovedMemorySave,
        handleApprovedMemoryDelete,
        applyAppearancePreferences,
        applyChatZoomPercent,
        appearanceUtils,
        getDefaultAppearancePreferences,
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
        showToastMessage,
        showShellErrorToast,
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
      },
    }) || null;

    const settingsNavController = settingsNavUtils.createSettingsNavController?.({
      state,
      settingsNav: dom.settingsView?.querySelector('.settings-nav'),
      settingsContentScroll: dom.settingsView?.querySelector('.settings-content-scroll'),
      appendClientLog,
      getSectionRefreshPromise,
      beforeSectionChange: confirmSettingsSectionChange,
      onSectionChange: function (nextSection) {
        if (nextSection !== 'usage') usageController?.deactivate?.();
        ensureSettingsSectionReady(nextSection);
        if (state.ui.activeView === 'settings') {
          refreshSectionWithWarning(nextSection);
        }
      },
    }) || null;

    // Shared appearance adapter (createAppearanceAdapter, localStorage-backed):
    // both the Tier C JSON slice (item 8) and the per-field/section reset
    // module (item 10) consume the SAME instance -- one localStorage read
    // path, one `apply` hook (applyAppearancePreferences).
    let cachedAppearanceAdapter = null;
    function getAppearanceAdapter() {
      if (cachedAppearanceAdapter) {
        return cachedAppearanceAdapter;
      }
      if (typeof persistenceAdaptersUtils.createAppearanceAdapter !== 'function') {
        return null;
      }
      const storage = globalWindow?.localStorage;
      if (!storage) {
        return null;
      }
      try {
        cachedAppearanceAdapter = persistenceAdaptersUtils.createAppearanceAdapter({
          storage,
          appearanceUtils,
          applyAppearance: (preferences) => applyAppearancePreferences(preferences, { persist: false }),
          log: (message) => appendClientLog('WARN', 'settings.appearance_adapter', { message }),
        });
      } catch (_error) {
        cachedAppearanceAdapter = null;
      }
      return cachedAppearanceAdapter;
    }

    // Per-field reset plus the guarded Appearance section reset. Appearance
    // remains localStorage-owned; contextual chat zoom retains its existing
    // IPC boundary and keyboard reset path.
    let fieldReset = null;
    function mountFieldReset() {
      if (fieldReset) {
        // Re-bind after dispose(): the cached instance was unmounted, so
        // re-mount it (idempotent while already mounted).
        fieldReset.mount();
        return;
      }
      if (typeof fieldResetUtils.createSettingsFieldReset !== 'function') {
        return;
      }
      const appearanceAdapter = getAppearanceAdapter();
      if (!appearanceAdapter) {
        return;
      }
      fieldReset = fieldResetUtils.createSettingsFieldReset({
        documentRef: globalDocument,
        adapters: { appearance: appearanceAdapter },
        appearanceUtils,
        onAfterReset: () => renderSettings(),
        log: (message) => appendClientLog('WARN', 'settings.field_reset', { message }),
        resetActions: {
          appearance: () => {
            return appearanceAdapter.write(getDefaultAppearancePreferences()).then((saved) => {
              applySurfaceEffect();
              activateSurfaceEffect(saved.surfaceEffectId);
              renderAll();
              return saved;
            });
          },
        },
      });
      fieldReset.mount();
    }

    let bound = false;

    function bind() {
      if (bound) {
        return;
      }
      bound = true;
      settingsNavController?.bind?.();
      settingsEventBindings?.bind?.();
      // Render BEFORE mounting the per-field affordances. mountFieldEntry()
      // resolves each select by id and mount() latches after its first pass,
      // so a control that renderSettings() mounts (rather than index.html
      // declaring inline) would otherwise never get a reset button. Chat width
      // is the first such control: index.html's raw-primitive budget only ever
      // moves down, so it comes from the inventory selectField instead.
      renderSettings();
      mountFieldReset();
    }

    function dispose() {
      for (const sectionId of initializedSections) {
        if (isLazySettingsSection(sectionId)) initializedSections.delete(sectionId);
      }
      if (!bound) {
        usageController?.dispose?.();
        usageConfirmDialog?.dispose?.();
        usageController = null;
        usageConfirmDialog = null;
        settingsController?.dispose?.();
        return;
      }
      bound = false;
      settingsEventBindings?.dispose?.();
      settingsNavController?.dispose?.();
      fieldReset?.dispose?.();
      settingsController?.dispose?.();
      usageController?.dispose?.();
      usageConfirmDialog?.dispose?.();
      usageController = null;
      usageConfirmDialog = null;
    }

    return {
      bind,
      dispose,
      renderSettings,
      renderComposerPopover,
      renderCommandPopover,
      syncComposerInputHeight,
      syncComposerModelSelectWidth,
      navigateSettingsSection,
      openSettingsSection,
      restoreSettingsNavSection: () => settingsNavController?.restoreActiveSection?.(),
      ensureSettingsSectionReady,
      refreshSettingsSection,
      isSectionInitialized,
      getSectionRefreshPromise,
      notifyUsageTurnSettled: () => usageController?.notifyTurnSettled?.(),
      syncUsageVisibility: () => {
        const visible = state.ui.activeView === 'settings'
          && normalizeSettingsSectionId(state.ui.activeSettingsSection) === 'usage';
        return visible ? ensureUsageController()?.activate?.() : usageController?.deactivate?.();
      },
      markSettingsSectionState: (sectionId, nextState, options) => (
        settingsNavController?.markSectionState?.(sectionId, nextState, options)
      ),
      setSettingsSectionDirty: (sectionId, dirty) => (
        settingsNavController?.setNavItemDirty?.(sectionId, dirty)
      ),
    };
  }

  return {
    createSettingsShellController,
  };
});
