(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSettingsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const jt = (globalThis.jennyI18n && globalThis.jennyI18n.t) || globalThis.jennyI18nFallback || function (k, d, p) { return p ? String(d).replace(/\{(\w+)\}/g, function (m, n) { return Object.prototype.hasOwnProperty.call(p, n) ? String(p[n]) : m; }) : d; };
  const appearanceUtils = (typeof globalThis !== 'undefined' && globalThis.appearanceUtils)
    || (typeof require === 'function' ? require('../shared/appearance-utils') : null);
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
      appearanceSettingsSection, appearanceSurfaceEffectMeta, appearanceSurfaceEffectPreview,
      appearanceHoloList, appearanceSpellcheckList,
      composerAttachMenu,
      composerAttachShortcut,
      composerCommandPopover, composerCommandPopoverList, composerTerminalShortcut,
      settingsModelCard,
      modelBadge, modelStatus, modelStartupLoadList, appearanceResetButton,
      modelCatalogEmpty,
      accountSummary, localProfileSettingsMount, backendSummary,
      setupSettingsSummary, setupSettingsActions, setupProgressContainer,
      settingsControlTowerHost,
      skillsSettingsNavItem,
      contextStatus, contextSettingsSection,
      contextSourcesList, contextRuntimeList, contextCompactionTuning,
      toolsConfigFieldList, toolsPermissionsList, toolsFilesList, toolsWebList, toolsTerminalList, toolsCodeList,
      toolsCommandSandboxHost, toolsWorkspaceLine, toolsApprovalRulesList, toolsWorkspacePath, toolsWorkspaceStatus,
      toolsWorkspaceProject, toolsWorkspaceChooseButton,
      editorStatus, editorSettingsFieldList,
      homeStatus, homeSettingsFieldList, notificationsSettingsSection,
      chatInput, composerModelSelectEl,
    } = deps.dom;
    const appearanceLanguageField = deps.dom.appearanceLanguageField
      || (typeof globalThis !== 'undefined' ? globalThis.document?.getElementById('appearanceLanguageField') : null);

    const {
      getCurrentRuntimePreferences, getRuntimePreferencesFromSession = null, normalizeAppearancePreferences,
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
    const fieldDescriptors = globalThis.rendererSettingsFieldDescriptors
      || (typeof require === 'function' ? require('./renderer-settings-field-descriptors') : null);
    // One option list per Appearance select: the control, edit validation and
    // the "Default: <label>" meta all read it.
    const presetOptions = (presets) => presets.map((preset) => ({ value: preset.id, label: preset.label }));
    const optionSources = {
      themeBundles: () => {
        const bundles = presetOptions(getThemeBundles());
        return detectActiveThemeBundle(normalizeAppearancePreferences(state.ui.appearance))
          ? bundles
          : bundles.concat([{ value: 'custom', label: jt('settings.appearance.custom', 'Custom') }]);
      },
      palettes: () => presetOptions(getPalettePresets()),
      typography: () => presetOptions(getTypographyPresets()),
      fontScales: () => presetOptions(getFontScalePresets()),
      chatWidths: () => presetOptions(getChatWidthPresets()),
      surfaceEffects: () => presetOptions(getSurfaceEffectPresets()),
      // Overall app zoom (Electron webContents.setZoomFactor), persisted via jennyShell.windowUi.
      // The Ctrl +/- steps, plus a stored value between them (the service keeps any 5% step from 80 to 150).
      appZoomPresets: () => [...new Set([80, 90, 100, 110, 125, 150, Number(state.ui.appZoomPercent) || 110])]
        .sort((left, right) => left - right).map((percent) => ({ value: percent, label: `${percent}%` })),
    };
    Object.keys(optionSources).forEach((name) => fieldDescriptors?.registerOptionSource?.(name, optionSources[name]));
    // Rendered once into its [data-setting-mount] host, patched in place afterwards.
    // The binding module loads after this one, so it resolves at render time.
    function mountSettingRow(section, id, value, extra) {
      const fieldBinding = globalThis.rendererSettingsFieldBinding
        || (typeof require === 'function' ? require('./renderer-settings-field-binding') : null);
      const mount = section?.querySelector?.(`[data-setting-mount="${id}"]`);
      const descriptor = fieldDescriptors?.getSettingDescriptor?.(id);
      if (!mount || !descriptor || typeof fieldBinding?.mountSettingRow !== 'function') return null;
      fieldBinding.mountSettingRow(mount, descriptor, value, { className: 'select-shell', ...extra });
      return mount;
    }
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
      const surfaceEffectPresets = getSurfaceEffectPresets();
      const surfaceEffectPreset = surfaceEffectPresets.find((preset) => preset.id === appearancePreferences.surfaceEffectId) || surfaceEffectPresets[0];
      const activeThemeBundle = detectActiveThemeBundle(appearancePreferences);
      const composerHoloOptions = getComposerHoloOptions();
      const composerHoloOption = composerHoloOptions.find((option) => option.id === appearancePreferences.composerHoloId) || composerHoloOptions[0];
      const appZoomPercent = Number(state.ui.appZoomPercent) || 110; // APP_ZOOM_DEFAULT (services/shell-config-zoom-state.js)
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
      // Bundle and palette names run long ("Jenny XJ-9 — Night Patrol"): both
      // take the wide dropdown, so the two stack at one width.
      mountSettingRow(appearanceSettingsSection, 'appearanceThemeBundleSelect', activeThemeBundle ? activeThemeBundle.id : 'custom', { rowClassName: 'settings-field--wide-control' });
      mountSettingRow(appearanceSettingsSection, 'appearancePaletteSelect', appearancePreferences.paletteId, { rowClassName: 'settings-field--wide-control' });
      mountSettingRow(appearanceSettingsSection, 'appearanceTypographySelect', appearancePreferences.typographyId);
      mountSettingRow(appearanceSettingsSection, 'appearanceFontScaleSelect', appearancePreferences.fontScaleId);
      mountSettingRow(appearanceSettingsSection, 'appearanceChatWidthSelect', appearancePreferences.chatWidthId);
      const surfaceEffectMount = mountSettingRow(appearanceSettingsSection, 'appearanceSurfaceEffectSelect', appearancePreferences.surfaceEffectId);
      mountSettingRow(appearanceSettingsSection, 'appearanceAppZoomSelect', appZoomPercent);
      mountSettingRow(appearanceSettingsSection, 'transcriptViewDefaultSelect', state.transcriptViewDefault);
      mountSettingRow(appearanceSettingsSection, 'appearanceArtifactAutoOpenToggle', appearancePreferences.artifactAutoOpen === true);
      if (appearanceLanguageField && shouldPatchSection('appearanceLanguage')) {
        appearanceLanguageField.innerHTML = buildUiLanguageFieldMarkup({
          value: state.uiLanguage,
          use24HourTime: state.use24HourTime,
          selectField: typeof globalThis !== 'undefined' ? globalThis.inventory?.selectField : null,
        });
      }
      if (appearanceHoloList) {
        appearanceHoloList.innerHTML = buildSettingsToggleListMarkup({
          escapeHtml,
          toggleSwitch: typeof globalThis !== 'undefined' ? globalThis.inventory?.toggleSwitch : null,
          fields: appearanceUtils.getAppearanceToggleFields({ jt, composerHoloOption, appearancePreferences, startupAnimationFlagOff: state.features?.featureFlags?.startup_animation === false }),
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
      const modelBadgeState = resolveModelBadge({
        busy: runtimeModelBusy, loadingModel, errored: runtimeModelActivity?.state === 'error',
        catalogUnavailable: modelCatalogUnavailable, activeModel,
      });
      if (activeModel && modelBadgeState.text === activeModel) modelBadgeState.text = activeModel.slice(activeModel.lastIndexOf('/') + 1);
      applyBadgeState(modelBadge, modelBadgeState);
      modelBadge.title = activeModel;
      modelStatus.textContent = String(runtimeModelActivity?.message || '').trim() || (
        activeModel && modelCatalogUnavailable && modelCatalogReason
          ? jt('settings.modelLibrary.loadedCatalogUnavailable', 'Loaded model: {model} (catalog unavailable: {reason})', { model: activeModel, reason: modelCatalogReason })
          : activeModel
            ? ''
            : modelCatalogUnavailable && modelCatalogReason
            ? modelCatalogReason
            : jt('settings.modelLibrary.noneLoaded', 'No model is currently loaded.')
      );
      applyNote(modelCatalogEmpty, modelCatalogUnavailable
        ? jt('settings.modelLibrary.catalogUnavailableFallback', 'Model catalog unavailable. Using the backend default; load actions may not work until the local engine is reachable.')
        : '');
      const canEditSessionRuntime = Boolean(state.auth.authenticated);
      if (appearanceResetButton) appearanceResetButton.disabled = isDefaultAppearancePreferences(appearancePreferences);
      // The composer render pass (renderComposerState) owns this control's
      // locked state via the inert-readable floor; a native write here would
      // fight it (S3, spec §6).
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
      applyNote(contextStatus, (isActivityBusy(settingsContextActivity) || settingsContextActivity?.state === 'error'
        ? String(settingsContextActivity?.message || '').trim() : '') || (contextUnavailable
          ? jt('settings.context.managedSidecarOnly', 'Context controls are available only when the managed sidecar backend is active.')
          : ''));
      mountSettingRow(contextSettingsSection, 'contextHistoryScopeSelect', contextPreferences.historyScope,
        { disabled: !canEditSessionRuntime || contextUnavailable || isActivityBusy(settingsContextActivity) });
      if (modelStartupLoadList) {
        modelStartupLoadList.innerHTML = buildSettingsToggleListMarkup({
          toggleSwitch: typeof globalThis !== 'undefined' ? globalThis.inventory?.toggleSwitch : null,
          escapeHtml,
          fields: [{
            id: 'modelStartupLoadToggle',
            checked: state.localEngines?.startupModelLoad !== false,
            disabled: !state.auth.authenticated,
          }],
        });
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
      const toolOn = (key) => (Object.prototype.hasOwnProperty.call(featureTools, key)
        ? featureTools[key] === true : toolConfigFields.find((field) => field.key === key)?.default === true);
      if (toolsConfigFieldList && shouldPatchSection('toolsConfig')) {
        if (toolsPermissionsList) {
          // Four fixed rows: mounted once, then patched in place like the Appearance rows.
          const permissionRows = [['safetyModeSelect', state.safetyMode], ['defaultRunModeSelect', state.defaultRunMode],
            ['unattendedGuardMinutesInput', state.unattendedGuardMinutes], ['autoApproveStreakCapInput', state.autoApproveStreakCap]];
          if (!toolsPermissionsList.firstElementChild) {
            toolsPermissionsList.innerHTML = permissionRows.map(([id]) => `<div data-setting-mount="${id}"></div>`).join('');
          }
          for (const [id, value] of permissionRows) {
            const descriptor = fieldDescriptors?.getSettingDescriptor?.(id);
            if (descriptor) mountSettingRow(toolsPermissionsList, id, fieldDescriptors.normalizeSettingValue(descriptor, value), { className: '' });
          }
        }
        const groups = [
          [toolsFilesList, ['fileTools', 'richFiles', 'imageRead']],
          [toolsWebList, ['web']],
          [toolsTerminalList, ['bash']],
          [toolsCodeList, ['pythonRuntime', 'lsp', 'worktree', 'subagents']],
        ];
        const knownKeys = groups.flatMap(([, keys]) => keys);
        for (const [host, keys] of groups) {
          if (!host) continue;
          host.innerHTML = buildToolConfigFieldListMarkup({
            fields: toolConfigFields.filter((field) => keys.includes(field.key) || (host === toolsCodeList && !knownKeys.includes(field.key))),
            tools: featureTools, availability: toolAvailability, pdfAddonNeeded: toolsConfigFieldList.dataset.pdfAddonNeeded === 'true',
          });
        }
        if (toolsWebList) toolsWebList.insertAdjacentHTML('beforeend', buildWebSearchSectionMarkup({
          visible: featureFlags.web_search_providers === true, parentOff: !toolOn(settingsSupport.TOOL_DEPENDENTS?.webSearch),
          webSearch: featureState.webSearch, secretStatus: state.webSearchSecrets || null, escapeHtml,
        }));
      }
      // Dependent rows follow their parent on every render: the guard above holds the lists
      // while one of them has focus or an unsaved key, and a held row must not stay writable.
      settingsSupport.syncToolDependents?.(toolsConfigFieldList, {
        toolOn, availability: toolAvailability, inventory: typeof globalThis !== 'undefined' ? globalThis.inventory : null,
      });
      const setStatusText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
      if (toolsWorkspaceLine) toolsWorkspaceLine.dataset.state = workspaceRootStatus.state === 'ready' ? 'ready' : 'blocked';
      setStatusText(toolsWorkspacePath, workspaceRootState.path || jt('settings.tools.noWorkspaceRootSelected', 'No workspace root selected.'));
      setStatusText(toolsWorkspaceStatus, workspaceRootStatus.state === 'ready'
        ? ''
        : workspaceRootStatus.state === 'invalid'
          ? workspaceRootStatus.message || jt('settings.tools.invalidWorkspaceRoot', 'The current workspace root is invalid. Choose a new root to unlock workspace-aware tools.')
          : jt('settings.tools.chooseWorkspaceDescription', 'Choose a workspace root to unlock workspace-aware tools, project skills, and local guidance.'));
      if (toolsWorkspaceChooseButton) {
        toolsWorkspaceChooseButton.textContent = jt('settings.tools.openWorkspace', 'Open Workspace');
      }
      settingsCoreRenderers?.paintToolsWorkspaceProject?.(toolsWorkspaceProject, workspaceRootState.path, workspaceRootStatus.state);
      if (editorSettingsFieldList) {
        const editorSection = typeof globalThis !== 'undefined' ? globalThis.rendererSettingsEditorSection : null;
        editorSection?.renderEditorSection?.({
          container: editorSettingsFieldList,
          status: editorStatus,
          ide: state.ui?.ide || null,
        });
      }
      if (homeSettingsFieldList) {
        const homeSection = typeof globalThis !== 'undefined' ? globalThis.rendererSettingsHomeSection : null;
        homeSection?.renderHomeSection?.({ container: homeSettingsFieldList, status: homeStatus, state });
      }
      if (notificationsSettingsSection) {
        const notificationsSection = typeof globalThis !== 'undefined' ? globalThis.rendererSettingsNotificationsSection : null;
        notificationsSection?.renderNotificationsSection?.({ container: notificationsSettingsSection, state });
      }
      if (toolsApprovalRulesList) {
        settingsCoreRenderers?.renderApprovalRules?.({
          container: toolsApprovalRulesList,
          api: (typeof window !== 'undefined' && window.jennyShell?.tools) || null,
          projectsApi: (typeof window !== 'undefined' && window.jennyShell?.projects) || null,
          permissionReviewApi: (typeof window !== 'undefined' && window.jennyShell?.permissionReview) || null,
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
        descriptionEl: surfaceEffectMount?.querySelector('.settings-field-help') || null,
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
    };
  }

  return { createSettingsRenderer };
});
