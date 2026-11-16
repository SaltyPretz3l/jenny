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
  // The Settings script manifest loads these before this module (the page
  // shell loads support, foundation and the section registry); Node requires them.
  const load = (globalName, path) => globalThis[globalName] || require(path);
  const settingsSupport = load('rendererSettingsSupport', './renderer-settings-support');
  const settingsCoreRenderers = load('rendererSettingsCoreRenderers', './renderer-settings-core-renderers');
  const sectionRegistry = load('rendererSettingsSectionRegistry', './renderer-settings-section-registry');
  const { applyNote } = load('rendererSettingsFoundation', './renderer-settings-foundation');
  const {
    normalizeFeatureState, normalizeWorkspaceRootState, getToolConfigFieldsForRender,
    buildToolConfigFieldListMarkup, buildUiLanguageFieldMarkup, buildContextToggleListsMarkup,
    buildSettingsToggleListMarkup,
    buildWebSearchSectionMarkup, buildCompactionTuningMarkup,
  } = settingsSupport;
  const {
    buildSettingsControlTowerModel, renderSettingsControlTowerMarkup, syncSettingsControlTowerIndicators,
  } = load('rendererSettingsControlTowerUtils', './renderer-settings-control-tower-utils');
  const { renderSetupSettingsRow } = settingsCoreRenderers;
  const {
    renderLazyManagers, renderSurfaceEffectCopy, renderSurfaceEffectPreview, disposeSurfaceEffectPreview, renderJennyChatModels,
  } = load('rendererSettingsLazyRenderers', './renderer-settings-lazy-renderers');
  const { renderSettingsV2Surfaces, paintSlot } = load('rendererSettingsV2Surfaces', './renderer-settings-v2-surfaces');

  /* Settings > Team (row 123, slice 1g-1). The flag state shows or hides the nav item and card; the
   * page's scripts load only while the `team` flag is exactly true and Team is the section on screen,
   * so with the flag off no team script loads and `jennyShell.team` is never touched. */
  let teamScriptsLoad = null;
  // A Node-only require: the renderer's `require` is Monaco's AMD loader, which throws for any module it does not know.
  const nodeRequire = (id) => { try { return typeof module === 'object' && module.exports ? require(id) : null; } catch (error) { if (error && error.code === 'MODULE_NOT_FOUND') return null; throw error; } };
  // A failed load waits for the next entry into Team instead of retrying on every render pass.
  let teamLoadFailed = false;
  let teamWasActive = false;
  const TEAM_STYLE = 'styles/team-settings.css';
  // E50: with `teamData: false` and no gate loaded, the page's own scripts and stylesheet load without it.
  function loadSectionOnly(windowRef, loader, scripts) {
    const doc = windowRef.document;
    if (doc && !doc.querySelector(`link[data-team-style="${TEAM_STYLE}"]`)) {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = TEAM_STYLE;
      link.setAttribute('data-team-style', TEAM_STYLE);
      doc.head.appendChild(link);
    }
    return scripts.reduce((ready, [src, name]) => ready.then((ok) => ok && Promise.resolve(loader.ensureScript({ src, isReady: () => Boolean(windowRef[name]) }))
      .then((done) => done === true, () => false)), Promise.resolve(true));
  }

  function loadTeamScripts(windowRef, teamData) {
    if (teamScriptsLoad) return teamScriptsLoad;
    const manifest = windowRef.rendererSettingsScriptManifest || nodeRequire('./renderer-settings-script-manifest');
    const scripts = (manifest && manifest.teamSection) || [];
    const loader = windowRef.scriptLoaderUtils;
    if (!scripts.length || typeof loader?.ensureScript !== 'function') return Promise.resolve(false);
    // Otherwise the team assets load through the Team tab gate's loader (slice 1g-2). With the flag on the
    // shell has normally loaded that file already; if not, it is loaded first.
    const [gateSrc, gateName] = ((manifest && manifest.teamGate) || [])[0] || [];
    let assets;
    if (teamData === false && !windowRef[gateName]) {
      assets = loadSectionOnly(windowRef, loader, scripts);
    } else {
      const gate = () => windowRef[gateName] || nodeRequire('../team/renderer-team-tab-gate');
      const gateReady = gate() ? Promise.resolve(true) : Promise.resolve(loader.ensureScript({ src: gateSrc, isReady: () => Boolean(windowRef[gateName]) }));
      assets = gateReady.then(() => (gate() ? gate().ensureTeamAssets({ windowRef, scripts, styles: [TEAM_STYLE] }) : false), () => false);
    }
    teamScriptsLoad = assets.then((ok) => {
      if (ok !== true) { teamScriptsLoad = null; teamLoadFailed = true; }
      return ok === true;
    });
    return teamScriptsLoad;
  }

  function syncTeamSettingsSection({ state, windowRef = globalThis, activeSection = '' } = {}) {
    const doc = windowRef && windowRef.document;
    const flags = (state && state.features && state.features.featureFlags) || {};
    const navUtils = globalThis.rendererSettingsNavUtils || nodeRequire('./renderer-settings-nav-utils');
    navUtils?.syncFeatureFlaggedSettings?.(doc, flags);
    const team = windowRef.rendererSettingsTeamSection;
    const active = flags.team === true && activeSection === 'team';
    const entering = active && !teamWasActive;
    teamWasActive = active;
    if (!active) {
      team?.leaveTeamSection?.();
      return;
    }
    const container = doc?.getElementById?.('teamSettingsSection');
    if (!container) return;
    const teamData = state.features?.teamData;
    if (team) {
      team.showTeamSection({ container, teamData });
      return;
    }
    if (teamLoadFailed && !entering) return;
    teamLoadFailed = false;
    void loadTeamScripts(windowRef, teamData).then((ok) => {
      const still = state.features?.featureFlags?.team === true && state.ui?.activeView === 'settings'
        && sectionRegistry.normalizeSettingsSectionId(state.ui.activeSettingsSection) === 'team';
      if (ok && still) windowRef.rendererSettingsTeamSection?.showTeamSection?.({ container, teamData: state.features?.teamData });
    });
  }

  /* Settings > Jenny chat (row 86, picks S1 + Q1): the Digests group's "While you were away" switch (the
   * primary_digests flag) and one Quiet hours row holding the chatUi digestQuietStart / digestQuietEnd
   * selects, in its own group since row 89 (pick Q1: quiet hours also silence the Jenny chat's desktop
   * notifications, so they stay editable while digests are off). Rendered once, then patched in place, so
   * a select keeps its node and focus across the re-render that follows a save. */
  const QUIET_HOURS_IDS = ['digestQuietStartSelect', 'digestQuietEndSelect'];
  function renderJennyChatDigests(list, state, quietList = list) {
    // The binding module loads after this one; resolve at render time and skip until it is there.
    const pick = (globalName, path) => globalThis[globalName] || (typeof require === 'function' ? require(path) : null);
    const descriptors = pick('rendererSettingsFieldDescriptors', './renderer-settings-field-descriptors');
    const binding = pick('rendererSettingsFieldBinding', './renderer-settings-field-binding');
    const settingsField = globalThis.inventory?.settingsField || pick('inventorySettingsField', '../inventory/settings-field');
    const { escapeHtml } = pick('stringUtils', '../shared/string-utils') || {};
    if (!list || typeof list.querySelector !== 'function' || !quietList || typeof quietList.querySelector !== 'function') return;
    if (!descriptors || !binding || typeof settingsField !== 'function' || !escapeHtml) return;
    const toggle = descriptors.getSettingDescriptor('primaryDigestsToggle');
    const quiet = QUIET_HOURS_IDS.map((id) => descriptors.getSettingDescriptor(id));
    const on = state?.features?.featureFlags?.primary_digests === true;
    const values = quiet.map((descriptor) => descriptors.normalizeSettingValue(descriptor, state?.[descriptor.key]));
    if (!list.firstElementChild) {
      const [start, end] = quiet.map((descriptor, index) => binding.renderSettingControl(descriptor, values[index], { describedBy: 'digestQuietHoursHelp' }));
      const to = escapeHtml(jt('settings.jennyChat.quietHours.to', 'to'));
      const quietRow = settingsField({
        id: 'digestQuietHoursRow', variant: 'row', label: jt('settings.jennyChat.quietHours.label', 'Quiet hours'),
        help: binding.resolveSettingCopy(quiet[0]).description, helpId: 'digestQuietHoursHelp',
        dataset: { 'setting-id': 'digestQuietHoursRow' },
        controlHtml: `<span class="settings-field-stack-line">${start}<span class="settings-field-side" aria-hidden="true">${to}</span>${end}</span>`,
      });
      if (quietList === list) list.innerHTML = binding.renderSettingRow(toggle, on) + quietRow;
      else {
        list.innerHTML = binding.renderSettingRow(toggle, on);
        quietList.innerHTML = quietRow;
      }
      return;
    }
    binding.syncSettingRow(list, toggle, on);
    quiet.forEach((descriptor, index) => binding.syncSettingRow(quietList, descriptor, values[index]));
  }

  function createSettingsRenderer(deps) {
    const { state, shouldPatchSection = () => true } = deps;
    const { ACTIVITY_SCOPE } = deps.constants;
    const {
      appearanceSettingsSection, generalSettingsSection, chatSettingsSection, appearanceSurfaceEffectMeta, appearanceSurfaceEffectPreview,
      appearanceHoloList, appearanceSpellcheckList,
      settingsModelCard,
      modelStartupLoadList, appearanceResetButton,
      modelCatalogEmpty,
      accountSummary, localProfileSettingsMount, backendSummary,
      setupSettingsSummary, setupSettingsActions, setupProgressContainer,
      settingsControlTowerHost,
      contextStatus, contextSettingsSection,
      contextSourcesList, contextRuntimeList, contextCompactionTuning,
      toolsConfigFieldList, permissionsSettingsSection, toolsFilesList, toolsWebList, toolsTerminalList, toolsCodeList,
      toolsWorkspaceLine, toolsApprovalRulesList, toolsWorkspacePath, toolsWorkspaceStatus,
      toolsWorkspaceProject, toolsWorkspaceChooseButton,
      editorStatus, editorSettingsFieldList,
      homeStatus, homeSettingsFieldList, notificationsSettingsSection,
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
      detectActiveThemeBundle = function fallbackDetectActiveThemeBundle() { return null; },
      getActivitySnapshot, getMostRecentActivity, isActivityBusy,
      applyActivityAttributes,
      isDefaultAppearancePreferences,
      renderPersonalityEditor, renderSkillsManager, renderOfflineManager, escapeHtml, getActiveSession,
      getSectionDom = function noopGetSectionDom() { return {}; },
      isSectionInitialized = function alwaysReady() { return true; },
    } = deps.callbacks;
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
    // `afterId` names the row a host missing from index.html is created after.
    function mountSettingRow(section, id, value, { afterId, ...extra } = {}) {
      const fieldBinding = globalThis.rendererSettingsFieldBinding
        || (typeof require === 'function' ? require('./renderer-settings-field-binding') : null);
      let mount = section?.querySelector?.(`[data-setting-mount="${id}"]`);
      const sibling = !mount && afterId ? section?.querySelector?.(`[data-setting-mount="${afterId}"]`) : null;
      if (sibling) {
        mount = sibling.ownerDocument.createElement('div');
        mount.dataset.settingMount = id;
        sibling.after(mount);
      }
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
    // The section on screen, or '' while Settings is not the active view.
    function activeSettingsSection() {
      return state.ui?.activeView === 'settings'
        ? sectionRegistry.normalizeSettingsSectionId(state.ui.activeSettingsSection) : '';
    }

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
      const contextUnavailable = backendMode === 'external';
      const activeSection = activeSettingsSection();
      const toggleSwitch = globalThis.inventory?.toggleSwitch || null;
      if (settingsControlTowerHost) {
        const controlTowerModel = buildSettingsControlTowerModel({
          state,
        });
        paintSlot(settingsControlTowerHost, renderSettingsControlTowerMarkup(controlTowerModel, { escapeHtml }));
        syncSettingsControlTowerIndicators(controlTowerModel, { documentRef: settingsControlTowerHost.ownerDocument });
      }

      // Bundle and palette names run long ("Jenny XJ-9 — Night Patrol"): both
      // take the wide dropdown, so the two stack at one width.
      mountSettingRow(appearanceSettingsSection, 'appearanceThemeBundleSelect', activeThemeBundle ? activeThemeBundle.id : 'custom', { rowClassName: 'settings-field--wide-control' });
      mountSettingRow(appearanceSettingsSection, 'appearancePaletteSelect', appearancePreferences.paletteId, { rowClassName: 'settings-field--wide-control' });
      mountSettingRow(appearanceSettingsSection, 'appearanceTypographySelect', appearancePreferences.typographyId);
      mountSettingRow(appearanceSettingsSection, 'appearanceFontScaleSelect', appearancePreferences.fontScaleId);
      const surfaceEffectMount = mountSettingRow(appearanceSettingsSection, 'appearanceSurfaceEffectSelect', appearancePreferences.surfaceEffectId);
      mountSettingRow(appearanceSettingsSection, 'appearanceAppZoomSelect', appZoomPercent);
      if (state.features?.featureFlags?.team === true) mountSettingRow(appearanceSettingsSection, 'appearanceTeamDensitySelect', appearancePreferences.teamDensityId, { afterId: 'appearanceAppZoomSelect' }); else appearanceSettingsSection?.querySelector?.('[data-setting-mount="appearanceTeamDensitySelect"]')?.remove();
      // Row 133: Chat › Layout and Side panel, General › Machine status (rows that left Appearance).
      mountSettingRow(chatSettingsSection, 'appearanceChatWidthSelect', appearancePreferences.chatWidthId);
      mountSettingRow(chatSettingsSection, 'transcriptViewDefaultSelect', state.transcriptViewDefault);
      mountSettingRow(chatSettingsSection, 'appearanceArtifactAutoOpenToggle', appearancePreferences.artifactAutoOpen === true);
      mountSettingRow(chatSettingsSection, 'changePicturesToggle', state.features?.featureFlags?.change_pictures !== false, { afterId: 'appearanceArtifactAutoOpenToggle' });
      // With sketch blocks off the model is told Mermaid whatever this says: keep the row, greyed out, with the reason.
      const sketchOff = state.features?.featureFlags?.sketch_blocks === false;
      const drawingMount = chatSettingsSection?.querySelector?.('[data-setting-mount="drawingInstructionsSelect"]');
      if (drawingMount && (drawingMount.dataset.sketchOff === 'true') !== sketchOff) drawingMount.replaceChildren();
      const drawingRow = mountSettingRow(chatSettingsSection, 'drawingInstructionsSelect', state.drawingInstructions || 'short', sketchOff
        ? { afterId: 'changePicturesToggle', disabled: true, rowClassName: 'settings-field--unavailable', description: jt('settings.drawingInstructions.unavailable', 'Sketch drawings are turned off, so the model is told to write Mermaid.') }
        : { afterId: 'changePicturesToggle', disabled: false });
      if (drawingRow) drawingRow.dataset.sketchOff = String(sketchOff);
      globalThis.rendererPerformanceSettings?.mountRows(generalSettingsSection, mountSettingRow);
      if (appearanceLanguageField && shouldPatchSection('appearanceLanguage')) {
        appearanceLanguageField.innerHTML = buildUiLanguageFieldMarkup({
          value: state.uiLanguage,
          use24HourTime: state.use24HourTime,
          selectField: typeof globalThis !== 'undefined' ? globalThis.inventory?.selectField : null,
        });
      }
      if (appearanceHoloList) {
        paintSlot(appearanceHoloList, buildSettingsToggleListMarkup({
          escapeHtml,
          toggleSwitch,
          fields: appearanceUtils.getAppearanceToggleFields({ jt, composerHoloOption, appearancePreferences, startupAnimationFlagOff: state.features?.featureFlags?.startup_animation === false }),
        }));
      }
      const titlebarLoadList = generalSettingsSection?.querySelector?.('#generalTitlebarLoadList');
      if (titlebarLoadList) {
        paintSlot(titlebarLoadList, buildSettingsToggleListMarkup({ escapeHtml, toggleSwitch, fields: appearanceUtils.getMachineStatusToggleFields({ appearancePreferences }) }));
      }
      if (appearanceSpellcheckList) {
        paintSlot(appearanceSpellcheckList, buildSettingsToggleListMarkup({
          escapeHtml,
          toggleSwitch,
          fields: [
            { id: 'appearanceSpellcheckToggle', checked: state.features?.featureFlags?.text_spellcheck !== false },
          ],
        }));
      }
      // Running now shows the loaded model; this note is the one place the catalog's failure and its reason show.
      applyNote(modelCatalogEmpty, !modelCatalogUnavailable ? ''
        : modelCatalogReason
          ? jt('settings.modelLibrary.catalogUnavailableReason', 'Model catalog unavailable: {reason} Using the backend default; load actions may not work until the local engine is reachable.', { reason: modelCatalogReason })
          : jt('settings.modelLibrary.catalogUnavailableFallback', 'Model catalog unavailable. Using the backend default; load actions may not work until the local engine is reachable.'));
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
      const contextSaveError = settingsContextActivity?.state === 'error' ? String(settingsContextActivity.message || '').trim() : '';
      applyNote(contextStatus, contextSaveError || (contextUnavailable
        ? jt('settings.context.managedSidecarOnly', 'Context controls are available only when the managed sidecar backend is active.')
        : ''));
      if (contextSaveError && contextStatus && globalThis.inventory?.statusRow) contextStatus.innerHTML = globalThis.inventory.statusRow({ tone: 'danger', message: contextSaveError, compact: true });
      mountSettingRow(contextSettingsSection, 'contextHistoryScopeSelect', contextPreferences.historyScope,
        { disabled: !canEditSessionRuntime || contextUnavailable || isActivityBusy(settingsContextActivity) });
      // Chat › This chat says whose rows these are: the open chat, else (like getCurrentRuntimePreferences) the next one.
      const contextScopeNote = contextSettingsSection?.querySelector?.('#contextScopeNote');
      const openChat = typeof getActiveSession === 'function' ? getActiveSession() : null;
      const scopeText = openChat
        ? jt('settings.chat.thisChat.scopeOpen', 'These change only the chat you have open: {title}.', { title: String(openChat.title || '').trim() || jt('settings.chat.thisChat.untitled', 'New chat') })
        : jt('settings.chat.thisChat.scopeNone', 'No chat is open. These apply to the next chat you start.');
      if (contextScopeNote && contextScopeNote.textContent !== scopeText) contextScopeNote.textContent = scopeText;
      if (modelStartupLoadList) {
        paintSlot(modelStartupLoadList, buildSettingsToggleListMarkup({
          toggleSwitch,
          escapeHtml,
          fields: [{
            id: 'modelStartupLoadToggle',
            checked: state.localEngines?.startupModelLoad !== false,
            disabled: !state.auth.authenticated,
          }],
        }));
      }
      if (contextSourcesList || contextRuntimeList) {
        const contextToggleLists = buildContextToggleListsMarkup({
          contextPreferences,
          featureFlags,
          prefsDisabled: !canEditSessionRuntime || contextUnavailable || isActivityBusy(settingsContextActivity),
          flagsDisabled: contextUnavailable,
          escapeHtml,
          toggleSwitch,
        });
        paintSlot(contextSourcesList, contextToggleLists.sources);
        paintSlot(contextRuntimeList, contextToggleLists.runtime);
      }
      if (contextCompactionTuning && shouldPatchSection('compactionPrompt')) {
        const compactionTuning = state.compactionTuning && typeof state.compactionTuning === 'object' ? state.compactionTuning : {};
        contextCompactionTuning.innerHTML = buildCompactionTuningMarkup({
          customPromptValue: String(compactionTuning.customPrompt || ''),
          disabled: contextUnavailable || isActivityBusy(state.compactionTuningActivity),
          statusMessage: state.compactionTuningActivity?.message || '',
          statusTone: state.compactionTuningActivity?.tone || 'info',
          escapeHtml,
          actionButton: globalThis.inventory?.actionButton || null,
        });
      }
      const toolOn = (key) => (Object.prototype.hasOwnProperty.call(featureTools, key)
        ? featureTools[key] === true : toolConfigFields.find((field) => field.key === key)?.default === true);
      // Permissions (row 133): four fixed rows in the card's mounts, patched in place (never a focused control).
      for (const [id, value] of [['defaultRunModeSelect', state.defaultRunMode], ['safetyModeSelect', state.safetyMode],
        ['unattendedGuardMinutesInput', state.unattendedGuardMinutes], ['autoApproveStreakCapInput', state.autoApproveStreakCap]]) {
        const descriptor = fieldDescriptors?.getSettingDescriptor?.(id);
        if (descriptor) mountSettingRow(permissionsSettingsSection, id, fieldDescriptors.normalizeSettingValue(descriptor, value), { className: '' });
      }
      if (toolsConfigFieldList && shouldPatchSection('toolsConfig')) {
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
      settingsSupport.syncToolDependents(toolsConfigFieldList, {
        toolOn, availability: toolAvailability, inventory: globalThis.inventory || null,
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
      settingsCoreRenderers.paintToolsWorkspaceProject(toolsWorkspaceProject, workspaceRootState.path, workspaceRootStatus.state);
      if (editorSettingsFieldList) {
        globalThis.rendererSettingsEditorSection?.renderEditorSection?.({
          container: editorSettingsFieldList,
          status: editorStatus,
          ide: state.ui?.ide || null,
        });
      }
      if (homeSettingsFieldList) {
        globalThis.rendererSettingsHomeSection?.renderHomeSection?.({ container: homeSettingsFieldList, status: homeStatus, state });
      }
      if (notificationsSettingsSection) {
        globalThis.rendererSettingsNotificationsSection?.renderNotificationsSection?.({ container: notificationsSettingsSection, state });
      }
      const jennyChatDigestsList = typeof document !== 'undefined' ? document.getElementById('jennyChatDigestsList') : null;
      const jennyChatQuietList = jennyChatDigestsList ? document.getElementById('jennyChatQuietList') : null;
      if (jennyChatDigestsList) renderJennyChatDigests(jennyChatDigestsList, state, jennyChatQuietList || jennyChatDigestsList);
      const jennyChatModelList = typeof document !== 'undefined' ? document.getElementById('jennyChatModelList') : null;
      if (jennyChatModelList) renderJennyChatModels(jennyChatModelList, state);
      const dictationSettingsSection = typeof document !== 'undefined' ? document.getElementById('dictationSettingsSection') : null;
      if (dictationSettingsSection) {
        globalThis.rendererSettingsDictationSection?.renderDictationSection?.({ container: dictationSettingsSection, state });
      }
      syncTeamSettingsSection({ state, activeSection });
      if (toolsApprovalRulesList) {
        // Read over IPC, so only while Permissions is the section on screen.
        settingsCoreRenderers.renderApprovalRules({
          container: toolsApprovalRulesList,
          api: (typeof window !== 'undefined' && window.jennyShell?.tools) || null,
          projectsApi: (typeof window !== 'undefined' && window.jennyShell?.projects) || null,
          permissionReviewApi: (typeof window !== 'undefined' && window.jennyShell?.permissionReview) || null,
          escapeHtml,
          active: activeSection === 'permissions',
        });
      }
      renderSupportingSurfaces();
      renderSurfaceEffectCopy({
        descriptionEl: surfaceEffectMount?.querySelector('.settings-field-help') || null,
        metaEl: appearanceSurfaceEffectMeta,
        preset: surfaceEffectPreset,
      });
      renderSurfaceEffectPreview({
        host: appearanceSurfaceEffectPreview,
        effectId: appearancePreferences.surfaceEffectId,
        // Tear down the preview outside Settings > Appearance so its rAF and
        // listeners cannot continue behind a closed panel or another section.
        visible: activeSection === 'appearance',
        windowRef: typeof globalThis !== 'undefined' ? globalThis : undefined,
      });
      applyActivityAttributes(settingsModelCard, runtimeModelActivity);
      applyActivityAttributes(contextStatus, settingsContextActivity);
      renderLazyManagers({
        shouldRenderLazySection,
        renderOfflineManager,
        renderSkillsManager,
        renderPersonalityEditor,
      });
    }

    return {
      renderSettings,
      dispose: () => {
        disposeSurfaceEffectPreview();
        globalThis.rendererSettingsTeamSection?.leaveTeamSection?.();
      },
    };
  }

  return { createSettingsRenderer, renderJennyChatDigests, syncTeamSettingsSection };
});
