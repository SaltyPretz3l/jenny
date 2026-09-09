(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const settingsSupport = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsSupport)
    || (typeof require === 'function' ? require('./renderer-settings-support') : null)
    || {};
  const settingsOverlays = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsOverlays)
    || (typeof require === 'function' ? require('./renderer-settings-overlays') : null)
    || {};
  const settingsControlTowerUtils = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsControlTowerUtils)
    || (typeof require === 'function' ? require('./renderer-settings-control-tower-utils') : null)
    || {};
  const settingsCoreRenderers = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsCoreRenderers)
    || (typeof require === 'function' ? require('./renderer-settings-core-renderers') : null)
    || {};
  const settingsLazyRenderers = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsLazyRenderers)
    || (typeof require === 'function' ? require('./renderer-settings-lazy-renderers') : null)
    || {};
  const settingsV2Surfaces = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsV2Surfaces)
    || (typeof require === 'function' ? require('./renderer-settings-v2-surfaces') : null)
    || {};
  const settingsComposerMeasure = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsComposerMeasure)
    || (typeof require === 'function' ? require('./renderer-settings-composer-measure') : null)
    || {};
  const settingsFoundation = (typeof globalThis !== 'undefined' && globalThis.rendererSettingsFoundation)
    || (typeof require === 'function' ? require('./renderer-settings-foundation') : null)
    || {};
  const { applyBadgeState = function noopBadge() {}, applyNote = function noopNote() { return ''; } } = settingsFoundation;
  const {
    resolveReasoningEffortSupport = function fallbackResolveReasoningEffortSupport() { return 'unknown'; },
    resolveModelBadge = function fallbackResolveModelBadge() { return {}; },
    normalizeFeatureState = function fallbackNormalizeFeatureState(payload) { return payload || {}; },
    normalizeWorkspaceRootState = function fallbackNormalizeWorkspaceRootState(payload) { return payload || {}; },
    getToolConfigFieldsForRender = function fallbackGetToolConfigFieldsForRender() { return []; },
    buildToolConfigFieldListMarkup = function fallbackBuildToolConfigFieldListMarkup() { return ''; },
    buildUiLanguageFieldMarkup = function fallbackBuildUiLanguageFieldMarkup() { return ''; },
    buildSafetyModeFieldMarkup = function fallbackBuildSafetyModeFieldMarkup() { return ''; },
    buildUnattendedGuardFieldMarkup = function fallbackBuildUnattendedGuardFieldMarkup() { return ''; },
    buildDefaultRunModeFieldMarkup = function fallbackBuildDefaultRunModeFieldMarkup() { return ''; },
    buildContextToggleListsMarkup = function fallbackBuildContextToggleListsMarkup() { return { sources: '', runtime: '' }; },
    buildSettingsToggleListMarkup = function fallbackBuildSettingsToggleListMarkup() { return ''; },
    renderStatusRowContainer = function fallbackRenderStatusRowContainer() {},
    buildSettingsSummaryModel = function fallbackBuildSettingsSummaryModel() { return {}; },
    buildWebSearchSectionMarkup = function fallbackBuildWebSearchSectionMarkup() { return ''; },
    buildCompactionTuningMarkup = function fallbackBuildCompactionTuningMarkup() { return ''; },
  } = settingsSupport;
  const {
    buildSettingsControlTowerModel = function fallbackBuildSettingsControlTowerModel() { return null; },
    renderSettingsControlTowerMarkup = function fallbackRenderSettingsControlTowerMarkup() { return ''; },
    syncSettingsControlTowerIndicators = function fallbackSyncSettingsControlTowerIndicators() {},
  } = settingsControlTowerUtils;
  const {
    renderSetupSettingsRow = function fallbackRenderSetupSettingsRow() {},
  } = settingsCoreRenderers;
  const {
    renderLazyManagers = function fallbackRenderLazyManagers() {},
    renderLazySummaries = function fallbackRenderLazySummaries() {},
    renderSurfaceEffectCopy = function fallbackRenderSurfaceEffectCopy() {},
    renderSurfaceEffectPreview = function fallbackRenderSurfaceEffectPreview() { return null; },
    disposeSurfaceEffectPreview = function fallbackDisposeSurfaceEffectPreview() {},
  } = settingsLazyRenderers;
  const {
    renderSettingsV2Surfaces = function fallbackRenderSettingsV2Surfaces() {},
  } = settingsV2Surfaces;

  function createSettingsRenderer(deps) {
    const { state, composerLayoutRuntime, shouldPatchSection = () => true } = deps;
    const { ACTIVITY_SCOPE } = deps.constants;
    const {
      composerModelSelect, composerEffortSelect,
      appearanceThemeBundleSelect,
      appearancePaletteSelect, appearanceTypographySelect, appearanceFontScaleSelect, appearanceSurfaceEffectSelect,
      appearanceChatWidthMount,
      appearanceSurfaceEffectDescription, appearanceSurfaceEffectMeta, appearanceSurfaceEffectPreview,
      appearanceHoloList, appearanceSpellcheckList, appearanceAppZoomSelect,
      composerSettingsPopover, composerSettingsButton, composerChatZoomSelect, composerChatZoomStatus,
      composerCommandPopover, composerCommandPopoverList, composerTerminalShortcut,
      settingsModelCard,
      modelBadge, modelStatus, appearanceBadge, appearanceStatus, appearanceResetButton,
      modelCatalogEmpty,
      accountBadge, accountSummary, localProfileSettingsMount, backendSummary,
      setupSettingsSummary, setupSettingsActions, setupProgressContainer,
      settingsControlTowerHost,
      skillsSettingsNavItem,
      contextBadge, contextStatus, contextHistoryScopeSelect,
      contextSourcesList, contextRuntimeList, contextCompactionTuning,
      toolsConfigFieldList, toolsApprovalRulesList, toolsWorkspacePath, toolsWorkspaceStatus,
      toolsWorkspaceChooseButton, toolsSummary,
      editorBadge, editorStatus, editorSettingsFieldList,
      homeBadge, homeStatus, homeSettingsFieldList,
      chatInput, composerModelSelectEl,
    } = deps.dom;
    const appearanceLanguageField = deps.dom.appearanceLanguageField
      || (typeof globalThis !== 'undefined' ? globalThis.document?.getElementById('appearanceLanguageField') : null);

    const {
      getCurrentRuntimePreferences, normalizeAppearancePreferences,
      getPalettePresets, getTypographyPresets, getSurfaceEffectPresets,
      getThemeBundles = function fallbackGetThemeBundles() { return []; },
      getComposerHoloOptions = function fallbackGetComposerHoloOptions() {
        return [{ id: 'off', label: jt('common.off', 'Off') }, { id: 'on', label: jt('common.on', 'On') }];
      },
      getFontScalePresets = function fallbackGetFontScalePresets() { return []; },
      getChatWidthPresets = function fallbackGetChatWidthPresets() { return []; },
      getChatZoomOptions = function fallbackGetChatZoomOptions() { return []; },
      normalizeChatZoomPercent = function fallbackNormalizeChatZoomPercent(value) { return Number(value) || 100; },
      detectActiveThemeBundle = function fallbackDetectActiveThemeBundle() { return null; },
      getActivitySnapshot, getMostRecentActivity, isActivityBusy,
      applyActivityAttributes,
      buildModelOptionMarkup, buildSelectOptionMarkup,
      isDefaultAppearancePreferences,
      renderApprovedMemoryManager, renderPersonalityEditor, renderSkillsManager, renderOfflineManager, escapeHtml,
      resolveComposerModelSelectWidth, updateComposerSafeOffset,
      listSlashCommands,
      getSectionDom = function noopGetSectionDom() { return {}; },
      isSectionInitialized = function alwaysReady() { return true; },
    } = deps.callbacks;
    const overlayRenderer = settingsOverlays.createSettingsOverlayRenderer?.({
      state,
      dom: {
        composerSettingsPopover,
        composerSettingsButton,
        composerChatZoomSelect,
        composerChatZoomStatus,
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
      state, composerLayoutRuntime, chatInput, composerModelSelect,
      resolveComposerModelSelectWidth, updateComposerSafeOffset,
    }) || {};
    function shouldRenderLazySection(sectionId) { return isSectionInitialized(sectionId); }
    /* DOM lookup is read-only and inexpensive — return existing static markup
     * even when the section's lazy bindings have not yet been wired, so the
     * initial render can still reflect toggle/state values. Event-handler
     * registration remains gated by ensureSettingsSectionReady. */
    function getLazySectionDom(sectionId) { return getSectionDom(sectionId) || {}; }

    function renderSupportingSurfaces() {
      renderSettingsV2Surfaces({
        escapeHtml,
        slots: {
          setupProgress: setupProgressContainer,
        },
        data: {
          setup: state.setup || {},
        },
      });
    }

    function renderSettings() {
      const models = Array.isArray(state.modelList?.data) ? state.modelList.data : [];
      const activeModel = state.status?.model || state.modelList?.active_model || '';
      const modelCatalogUnavailable = state.modelList?.available === false;
      const modelCatalogReason = String(state.modelList?.reason || '').trim();
      const runtimePreferences = getCurrentRuntimePreferences();
      const appearancePreferences = normalizeAppearancePreferences(state.ui.appearance);
      const palettePresets = getPalettePresets();
      const typographyPresets = getTypographyPresets();
      const fontScalePresets = getFontScalePresets();
      const chatWidthPresets = getChatWidthPresets();
      const themeBundles = getThemeBundles();
      const palettePreset = palettePresets.find((preset) => preset.id === appearancePreferences.paletteId) || palettePresets[0];
      const typographyPreset =
        typographyPresets.find((preset) => preset.id === appearancePreferences.typographyId) || typographyPresets[0];
      const surfaceEffectPresets = getSurfaceEffectPresets();
      const surfaceEffectPreset = surfaceEffectPresets.find((preset) => preset.id === appearancePreferences.surfaceEffectId) || surfaceEffectPresets[0];
      const activeThemeBundle = detectActiveThemeBundle(appearancePreferences);
      const themeBundleOptions = activeThemeBundle
        ? themeBundles
        : themeBundles.concat([{ id: 'custom', label: jt('settings.appearance.custom', 'Custom') }]);
      const composerHoloOptions = getComposerHoloOptions();
      const composerHoloOption = composerHoloOptions.find((option) => option.id === appearancePreferences.composerHoloId) || composerHoloOptions[0];
      // Overall app zoom (Electron webContents.setZoomFactor) — discrete preset
      // ladder. Persisted via jennyShell.windowUi; applied natively by main.
      const appZoomOptions = [90, 100, 110, 125, 150].map((percent) => ({
        id: String(percent),
        label: `${percent}%`,
      }));
      const appZoomPercent = Number(state.ui.appZoomPercent) || 100;
      const runtimeModelActivity = getMostRecentActivity([
        ACTIVITY_SCOPE.settingsModelLoad,
        ACTIVITY_SCOPE.settingsModelUnload,
      ]);
      const runtimeModelBusy = isActivityBusy(runtimeModelActivity);
      const loadingModel = runtimeModelActivity && runtimeModelActivity.scope === ACTIVITY_SCOPE.settingsModelLoad;
      const settingsContextActivity = getActivitySnapshot(ACTIVITY_SCOPE.settingsContextPreferences);
      const contextPreferences = runtimePreferences.contextPreferences;
      state.features = normalizeFeatureState(state.features);
      const featureState = state.features;
      const featureFlags = featureState.featureFlags || {};
      const featureTools = featureState.tools || {};
      const featureAvailability = featureState.availability || {};
      const toolAvailability = featureAvailability.tools || {};
      const toolConfigFields = getToolConfigFieldsForRender(featureState);
      state.workspaceRoot = normalizeWorkspaceRootState(state.workspaceRoot);
      const workspaceRootState = state.workspaceRoot;
      const featureWorkspaceRootStatus = featureAvailability.runtime?.workspaceRootStatus || {
        state: 'missing',
        message: jt('settings.tools.workspaceNotConfigured', 'No workspace root is configured yet.'),
      };
      const workspaceRootStatus = workspaceRootState.status || featureWorkspaceRootStatus;
      const contextScopeLabel = contextPreferences.historyScope === 'recent'
        ? jt('settings.context.historyScope.recent', 'Last 6 turns')
        : contextPreferences.historyScope === 'fresh'
          ? jt('settings.context.historyScope.fresh', 'New prompt only')
          : jt('settings.context.historyScope.full', 'Full session');
      const backendMode = String(state.backend?.mode || '').trim().toLowerCase();
      const managedMode = String(state.offline?.managedSidecar?.mode || state.backend?.mode || '').trim().toLowerCase();
      const contextUnavailable = backendMode === 'external';
      const offlineState = state.offline && typeof state.offline === 'object' ? state.offline : {};
      const personalityState = state.personality && typeof state.personality === 'object' ? state.personality : {};
      const memoryManagerState = state.memoryManager && typeof state.memoryManager === 'object' ? state.memoryManager : {};
      const memoriesDom = getLazySectionDom('memories');
      const offlineDom = getLazySectionDom('offline');
      const personalityDom = getLazySectionDom('personality');
      if (settingsControlTowerHost) {
        const controlTowerModel = buildSettingsControlTowerModel({
          state,
        });
        settingsControlTowerHost.innerHTML = renderSettingsControlTowerMarkup(controlTowerModel, { escapeHtml });
        syncSettingsControlTowerIndicators(controlTowerModel, { documentRef: settingsControlTowerHost.ownerDocument });
      }

      composerModelSelect.innerHTML = buildModelOptionMarkup(models, runtimePreferences.preferredModel, {
        compact: true,
      });
      composerModelSelect.value = runtimePreferences.preferredModel;
      composerMeasure.syncComposerModelSelectWidth?.();
      composerEffortSelect.value = runtimePreferences.reasoningEffort;
      if (appearanceThemeBundleSelect) {
        appearanceThemeBundleSelect.innerHTML = buildSelectOptionMarkup(
          themeBundleOptions,
          activeThemeBundle ? activeThemeBundle.id : 'custom'
        );
        appearanceThemeBundleSelect.value = activeThemeBundle ? activeThemeBundle.id : 'custom';
      }
      appearancePaletteSelect.innerHTML = buildSelectOptionMarkup(palettePresets, appearancePreferences.paletteId);
      appearanceTypographySelect.innerHTML = buildSelectOptionMarkup(typographyPresets, appearancePreferences.typographyId);
      if (appearanceFontScaleSelect) {
        appearanceFontScaleSelect.innerHTML = buildSelectOptionMarkup(fontScalePresets, appearancePreferences.fontScaleId);
      }
      if (appearanceLanguageField && shouldPatchSection('appearanceLanguage')) {
        appearanceLanguageField.innerHTML = buildUiLanguageFieldMarkup({
          value: state.uiLanguage,
          use24HourTime: state.use24HourTime,
          selectField: typeof globalThis !== 'undefined' ? globalThis.inventory?.selectField : null,
        });
      }
      // Chat width mounts through the inventory selectField primitive rather
      // than a raw select element declared in index.html (that file's
      // raw-primitive budget only ever moves down). The select-shell class is
      // passed through so the row is visually identical to its sibling select
      // rows with no new CSS.
      if (appearanceChatWidthMount) {
        const selectField = (typeof globalThis !== 'undefined'
          ? (globalThis.inventory?.selectField || globalThis.inventorySelectField)
          : null) || null;
        const liveChatWidthSelect = appearanceChatWidthMount.querySelector('#appearanceChatWidthSelect');
        if (selectField && !liveChatWidthSelect) {
          appearanceChatWidthMount.innerHTML = selectField({
            id: 'appearanceChatWidthSelect',
            className: 'select-shell',
            ariaLabel: jt('settings.appearance.chatWidthAriaLabel', 'Chat width selector'),
            value: appearancePreferences.chatWidthId,
            options: chatWidthPresets.map((preset) => ({ value: preset.id, label: preset.label })),
          });
        } else if (selectField && liveChatWidthSelect) {
          // Repopulate the LIVE select in place. optionsMarkup exists for
          // exactly this, and keeping the node stable keeps the per-field
          // reset button's listener bound across re-renders.
          liveChatWidthSelect.innerHTML = selectField.optionsMarkup(
            chatWidthPresets.map((preset) => ({ value: preset.id, label: preset.label })),
            appearancePreferences.chatWidthId
          );
        }
      }
      appearanceSurfaceEffectSelect.innerHTML = buildSelectOptionMarkup(surfaceEffectPresets, appearancePreferences.surfaceEffectId);
      if (appearanceHoloList) {
        const holoToggleSwitch = typeof globalThis !== 'undefined' ? globalThis.inventory?.toggleSwitch : null;
        appearanceHoloList.innerHTML = buildSettingsToggleListMarkup({
          escapeHtml,
          toggleSwitch: holoToggleSwitch,
          fields: [
            { id: 'appearanceComposerHoloToggle', label: jt('settings.appearance.holographicTypingBorderLabel', 'Holographic typing border'), checked: composerHoloOption.id !== 'off' },
          ],
        });
      }
      if (appearanceSpellcheckList) {
        const spellcheckToggleSwitch = typeof globalThis !== 'undefined' ? globalThis.inventory?.toggleSwitch : null;
        appearanceSpellcheckList.innerHTML = buildSettingsToggleListMarkup({
          escapeHtml,
          toggleSwitch: spellcheckToggleSwitch,
          fields: [
            { id: 'appearanceSpellcheckToggle', checked: state.features?.featureFlags?.text_spellcheck !== false },
          ],
        });
      }
      if (appearanceAppZoomSelect) {
        appearanceAppZoomSelect.innerHTML = buildSelectOptionMarkup(appZoomOptions, String(appZoomPercent));
      }
      appearancePaletteSelect.value = appearancePreferences.paletteId;
      appearanceTypographySelect.value = appearancePreferences.typographyId;
      if (appearanceFontScaleSelect) {
        appearanceFontScaleSelect.value = appearancePreferences.fontScaleId;
      }
      const mountedChatWidthSelect = appearanceChatWidthMount
        ? appearanceChatWidthMount.querySelector('#appearanceChatWidthSelect')
        : null;
      if (mountedChatWidthSelect) {
        mountedChatWidthSelect.value = appearancePreferences.chatWidthId;
      }
      appearanceSurfaceEffectSelect.value = appearancePreferences.surfaceEffectId;
      if (appearanceAppZoomSelect) {
        appearanceAppZoomSelect.value = String(appZoomPercent);
      }
      const appearanceStatusPrefix = activeThemeBundle
        ? jt('settings.appearance.statusBundle', '{bundle} bundle', { bundle: activeThemeBundle.label })
        : jt('settings.appearance.statusPalette', '{palette} palette', { palette: palettePreset?.label || jt('settings.appearance.themeFallback', 'Theme') });
      applyBadgeState(modelBadge, resolveModelBadge({
        busy: runtimeModelBusy, loadingModel, errored: runtimeModelActivity?.state === 'error',
        catalogUnavailable: modelCatalogUnavailable, activeModel,
      }));
      appearanceBadge.textContent = activeThemeBundle?.label || 'Custom';
      modelStatus.textContent = String(runtimeModelActivity?.message || '').trim() || (
        activeModel && modelCatalogUnavailable && modelCatalogReason
          ? jt('settings.modelLibrary.loadedCatalogUnavailable', 'Loaded model: {model} (catalog unavailable: {reason})', { model: activeModel, reason: modelCatalogReason })
          : activeModel
            ? jt('settings.modelLibrary.loadedModel', 'Loaded model: {model}', { model: activeModel })
            : modelCatalogUnavailable && modelCatalogReason
            ? modelCatalogReason
            : jt('settings.modelLibrary.noneLoaded', 'No model is currently loaded.')
      );
      applyNote(modelCatalogEmpty, modelCatalogUnavailable
        ? jt('settings.modelLibrary.catalogUnavailableFallback', 'Model catalog unavailable. Using the backend default; load actions may not work until the local engine is reachable.')
        : '');
      const appearanceStatusParams = { appearance: appearanceStatusPrefix, typography: typographyPreset?.label || jt('settings.appearance.typeFallback', 'Type'), effect: surfaceEffectPreset?.label || jt('settings.appearance.effectFallback', 'Effect'), border: composerHoloOption?.label || jt('common.off', 'Off') }; appearanceStatus.textContent = state.ui.osReducedMotion ? jt('settings.appearance.statusReducedMotion', '{appearance} • {typography} typography • {effect} effect • Composer typing border {border} • OS reduced motion is active.', appearanceStatusParams) : jt('settings.appearance.status', '{appearance} • {typography} typography • {effect} effect • Composer typing border {border}', appearanceStatusParams);
      const canEditSessionRuntime = Boolean(state.auth.authenticated);
      if (appearanceResetButton) appearanceResetButton.disabled = isDefaultAppearancePreferences(appearancePreferences);
      // The composer render pass (renderComposerState) owns this control's
      // locked state via the inert-readable floor; a native write here would
      // fight it (S3, spec §6).
      accountBadge.textContent = jt('settings.account.localBadge', 'Local');
      const localProfileName = String(state.auth?.user?.display_name || jt('settings.account.localUser', 'Local User')).trim() || jt('settings.account.localUser', 'Local User');
      accountSummary.textContent = jt('settings.account.storedAs', 'Stored on this device as {name}.', { name: localProfileName });
      if (localProfileSettingsMount && localProfileSettingsMount.dataset.profileName !== localProfileName) {
        const textField = (typeof globalThis !== 'undefined' && globalThis.inventoryTextField)
          || (typeof require === 'function' ? require('../inventory/text-field') : null);
        const actionButton = (typeof globalThis !== 'undefined' && globalThis.inventoryActionButton)
          || (typeof require === 'function' ? require('../inventory/action-button') : null);
        if (typeof textField === 'function' && typeof actionButton === 'function') {
          localProfileSettingsMount.innerHTML = textField({
            id: 'localProfileDisplayName',
            label: jt('settings.account.nameLabel', 'Profile name'),
            value: localProfileName,
            maxLength: 80,
            hint: jt('settings.account.nameHint', 'Stored locally; it is not an account identifier.'),
          }) + '<div class="settings-actions">'
            + actionButton({ id: 'save-local-profile', label: jt('settings.account.saveProfile', 'Save profile'), variant: 'primary' })
            + '</div>';
          localProfileSettingsMount.dataset.profileName = localProfileName;
        }
      }
      backendSummary.textContent = jt('settings.account.backendSummary', 'Backend: {phase}{detail}', { phase: state.backend.phase || jt('settings.account.backendPhaseUnknown', 'unknown'), detail: state.backend.detail ? ` - ${state.backend.detail}` : '' });
      renderSetupSettingsRow({
        setupSnapshot: state.setup || {},
        setupSettingsSummary,
        setupSettingsActions,
      });
      if (contextBadge) {
        contextBadge.textContent = contextUnavailable ? jt('settings.context.unavailable', 'Unavailable') : contextScopeLabel;
      }
      if (contextStatus) {
        contextStatus.textContent = String(settingsContextActivity?.message || '').trim() || (
          contextUnavailable
            ? jt('settings.context.managedSidecarOnly', 'Context controls are available only when the managed sidecar backend is active.')
            : jt('settings.context.controlsReady', 'Context controls are ready — edits take effect on your next message.')
        );
      }
      if (contextHistoryScopeSelect) {
        contextHistoryScopeSelect.value = contextPreferences.historyScope;
        contextHistoryScopeSelect.disabled =
          !canEditSessionRuntime || contextUnavailable || isActivityBusy(settingsContextActivity);
      }
      if (contextSourcesList || contextRuntimeList) {
        const toggleSwitchRenderer =
          typeof globalThis !== 'undefined' ? globalThis.inventory?.toggleSwitch : null;
        const contextToggleLists = buildContextToggleListsMarkup({
          contextPreferences,
          featureFlags,
          prefsDisabled: !canEditSessionRuntime || contextUnavailable || isActivityBusy(settingsContextActivity),
          flagsDisabled: contextUnavailable,
          escapeHtml,
          toggleSwitch: toggleSwitchRenderer,
        });
        if (contextSourcesList) {
          contextSourcesList.innerHTML = contextToggleLists.sources;
        }
        if (contextRuntimeList) {
          contextRuntimeList.innerHTML = contextToggleLists.runtime;
        }
      }
      if (contextCompactionTuning && shouldPatchSection('compactionPrompt')) {
        const compactionTuning = state.compactionTuning && typeof state.compactionTuning === 'object' ? state.compactionTuning : {};
        contextCompactionTuning.innerHTML = buildCompactionTuningMarkup({
          customPromptValue: String(compactionTuning.customPrompt || ''),
          disabled: contextUnavailable || isActivityBusy(state.compactionTuningActivity),
          statusMessage: state.compactionTuningActivity?.message || '',
          statusTone: state.compactionTuningActivity?.tone || 'info',
          escapeHtml,
          actionButton: typeof globalThis !== 'undefined' ? globalThis.inventory?.actionButton : null,
        });
      }
      const toolsToggleSwitchRenderer =
        typeof globalThis !== 'undefined' ? globalThis.inventory?.toggleSwitch : null;
      if (toolsConfigFieldList && shouldPatchSection('toolsConfig')) {
        const selectField = typeof globalThis !== 'undefined' ? globalThis.inventory?.selectField : null;
        toolsConfigFieldList.innerHTML = buildSafetyModeFieldMarkup({
          value: state.safetyMode, selectField,
        }) + buildDefaultRunModeFieldMarkup({
          value: state.defaultRunMode,
          selectField,
        }) + buildUnattendedGuardFieldMarkup({
          value: state.unattendedGuardMinutes,
          numberInput: typeof globalThis !== 'undefined' ? globalThis.inventory?.numberInput : null,
        }) + buildToolConfigFieldListMarkup({
          fields: toolConfigFields, tools: featureTools, availability: toolAvailability,
          escapeHtml, toggleSwitch: toolsToggleSwitchRenderer,
        }) + buildWebSearchSectionMarkup({
          visible: featureFlags.web_search_providers === true,
          webSearch: featureState.webSearch, secretStatus: state.webSearchSecrets || null, escapeHtml,
        });
      }
      if (toolsWorkspacePath) {
        toolsWorkspacePath.textContent = workspaceRootState.path || jt('settings.tools.noWorkspaceRootSelected', 'No workspace root selected.');
      }
      if (toolsWorkspaceStatus) {
        toolsWorkspaceStatus.textContent = workspaceRootStatus.state === 'ready'
          ? workspaceRootStatus.message || jt('settings.tools.workspaceRootConfigured', 'Workspace root is configured.')
          : workspaceRootStatus.state === 'invalid'
            ? workspaceRootStatus.message || jt('settings.tools.invalidWorkspaceRoot', 'The current workspace root is invalid. Choose a new root to unlock workspace-aware tools.')
            : jt('settings.tools.chooseWorkspaceDescription', 'Choose a workspace root to unlock workspace-aware tools, project skills, and local guidance.');
      }
      if (toolsWorkspaceChooseButton) {
        toolsWorkspaceChooseButton.textContent = jt('settings.tools.openWorkspace', 'Open Workspace');
      }
      if (toolsSummary) {
        const optionalCapabilityStates = [
          ...toolConfigFields.map((field) => ({
            enabled: featureTools[field.key] === true,
            available: toolAvailability[field.key]?.enabled !== false,
          })),
        ];
        const enabledCapabilityCount = optionalCapabilityStates.filter((entry) => entry.enabled).length;
        const readyCapabilityCount = optionalCapabilityStates.filter((entry) => entry.enabled && entry.available).length;
        const blockedCapabilityCount = enabledCapabilityCount - readyCapabilityCount;
        const workspaceSummary = workspaceRootStatus.state === 'ready'
          ? jt('settings.tools.workspaceSummaryReady', 'workspace ready')
          : workspaceRootStatus.state === 'invalid'
            ? jt('settings.tools.workspaceSummaryInvalid', 'workspace root invalid')
            : jt('settings.tools.workspaceSummaryMissing', 'workspace root missing');
        renderStatusRowContainer(toolsSummary, buildSettingsSummaryModel({
          tone: workspaceRootStatus.state === 'invalid'
            ? 'danger'
            : blockedCapabilityCount > 0 || workspaceRootStatus.state !== 'ready'
              ? 'warning'
              : enabledCapabilityCount > 0
                ? 'success'
                : 'default',
          label: jt('settings.tools.summaryLabel', 'Tools'),
          message: enabledCapabilityCount === 0
            ? jt('settings.tools.noOptionalCapabilities', 'No optional capabilities enabled - {workspaceSummary}.', { workspaceSummary })
            : blockedCapabilityCount > 0
              ? jt('settings.tools.capabilitiesBlocked', '{readyCount}/{enabledCount} enabled capabilities ready - {blockedCount} blocked - {workspaceSummary}.', { readyCount: readyCapabilityCount, enabledCount: enabledCapabilityCount, blockedCount: blockedCapabilityCount, workspaceSummary })
              : jt('settings.tools.capabilitiesReady', '{readyCount} enabled capabilities ready - {workspaceSummary}.', { readyCount: readyCapabilityCount, workspaceSummary }),
          badgeText: workspaceRootStatus.state === 'ready' ? jt('settings.tools.workspaceReady', 'Workspace ready') : jt('settings.tools.workspaceBlocked', 'Workspace blocked'),
        }), escapeHtml);
      }
      if (editorSettingsFieldList) {
        const editorSection = typeof globalThis !== 'undefined' ? globalThis.rendererSettingsEditorSection : null;
        editorSection?.renderEditorSection?.({
          container: editorSettingsFieldList,
          badge: editorBadge,
          status: editorStatus,
          ide: state.ui?.ide || null,
          inlineSuggestVisible: state.features?.featureFlags?.workspace_inline_suggest === true,
          autoSaveVisible: true,
        });
      }
      if (homeSettingsFieldList) {
        const homeSection = typeof globalThis !== 'undefined' ? globalThis.rendererSettingsHomeSection : null;
        homeSection?.renderHomeSection?.({
          container: homeSettingsFieldList,
          badge: homeBadge,
          status: homeStatus,
          state,
        });
      }
      if (toolsApprovalRulesList) {
        settingsCoreRenderers?.renderApprovalRules?.({
          container: toolsApprovalRulesList,
          api: (typeof window !== 'undefined' && window.jennyShell?.tools) || null,
          escapeHtml,
        });
      }
      renderSupportingSurfaces();
      renderLazySummaries({
        memoriesDom,
        offlineDom,
        personalityDom,
        featureFlags,
        featureAvailability,
        memoryManagerState,
        offlineState,
        personalityState,
        state,
        renderStatusRowContainer,
        buildSettingsSummaryModel,
        escapeHtml,
      });
      renderSurfaceEffectCopy({
        descriptionEl: appearanceSurfaceEffectDescription,
        metaEl: appearanceSurfaceEffectMeta,
        preset: surfaceEffectPreset,
      });
      renderSurfaceEffectPreview({
        host: appearanceSurfaceEffectPreview,
        effectId: appearancePreferences.surfaceEffectId,
        // Tear down the preview outside Settings so its rAF cannot continue behind a closed panel.
        visible: state.ui?.activeView === 'settings',
        windowRef: typeof globalThis !== 'undefined' ? globalThis : undefined,
      });
      applyActivityAttributes(settingsModelCard, runtimeModelActivity);
      applyActivityAttributes(modelBadge, runtimeModelActivity);
      applyActivityAttributes(modelStatus, runtimeModelActivity);
      applyActivityAttributes(contextStatus, settingsContextActivity);
      renderLazyManagers({
        shouldRenderLazySection,
        renderOfflineManager,
        renderSkillsManager,
        renderApprovedMemoryManager,
        renderPersonalityEditor,
      });
    }

    return {
      renderSettings,
      renderComposerPopover: (...args) => overlayRenderer.renderComposerPopover?.(...args),
      renderCommandPopover: (...args) => overlayRenderer.renderCommandPopover?.(...args),
      dispose: () => { disposeSurfaceEffectPreview(); overlayRenderer.dispose?.(); },
      syncComposerInputHeight: (...args) => composerMeasure.syncComposerInputHeight?.(...args),
      measureInlineTextWidth: (...args) => composerMeasure.measureInlineTextWidth?.(...args),
      syncComposerModelSelectWidth: (...args) => composerMeasure.syncComposerModelSelectWidth?.(...args),
    };
  }

  return { createSettingsRenderer };
});
