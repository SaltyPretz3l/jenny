(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.rendererSkillsUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const windowRef = typeof globalThis !== 'undefined' ? globalThis : {};

  function createSkillsManager(deps) {
    const { state } = deps;
    const { TOAST_SOURCE } = deps.constants;
    const skillsSettingsSection = deps.dom.skillsSettingsSection;
    const {
      escapeHtml,
      renderSettings,
      showToastMessage,
      showShellErrorToast,
      toErrorMessage,
    } = deps.callbacks;
    const toggleSwitch = (typeof globalThis !== 'undefined' && globalThis.inventoryToggleSwitch?.toggleSwitch)
      || (typeof require === 'function' ? require('../inventory/toggle-switch').toggleSwitch : null);
    const actionButton = (typeof globalThis !== 'undefined' && globalThis.inventoryActionButton)
      || (typeof require === 'function' ? require('../inventory/action-button') : null);
    let foldersExpanded = false;

    function text(value) {
      return String(value || '').trim();
    }

    function normalizeEntry(entry) {
      const source = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
      return {
        id: text(source.id),
        enabled: source.enabled !== false,
        scope: text(source.scope),
        name: text(source.name) || 'Unnamed Skill',
        description: text(source.description),
        command: text(source.command),
        allowedTools: Array.isArray(source.allowedTools)
          ? source.allowedTools.map(text).filter(Boolean)
          : [],
      };
    }

    function normalizeWarning(warning) {
      const source = warning && typeof warning === 'object' && !Array.isArray(warning) ? warning : {};
      return { message: text(source.message) || 'A skill file could not be loaded.' };
    }

    function normalizeScope(scope) {
      const source = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
      return {
        scope: text(source.scope),
        label: text(source.label || source.scope) || 'Scope',
        path: text(source.path),
        enabled: source.enabled === true,
        status: text(source.status) || 'missing',
        blocked: source.blocked === true || source.status === 'blocked',
        entries: Array.isArray(source.entries) ? source.entries.map(normalizeEntry) : [],
        warnings: Array.isArray(source.warnings) ? source.warnings.map(normalizeWarning) : [],
      };
    }

    function normalizeSkillsState(payload) {
      const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
      const settings = source.settings && typeof source.settings === 'object' && !Array.isArray(source.settings)
        ? source.settings
        : {};
      const scopes = Array.isArray(source.scopes) ? source.scopes.map(normalizeScope) : [];
      const disabledSkillIds = Array.isArray(settings.disabledSkillIds)
        ? Array.from(new Set(settings.disabledSkillIds.map(text).filter(Boolean)))
        : [];
      const autoIndex = ['auto', 'on', 'off'].includes(settings.autoIndex) ? settings.autoIndex : 'auto';
      return {
        loaded: true,
        featureEnabled: source.featureEnabled === true,
        settings: {
          bundledEnabled: settings.bundledEnabled !== false,
          userEnabled: settings.userEnabled === true,
          projectEnabled: settings.projectEnabled === true,
          disabledSkillIds,
          autoIndex,
        },
        scopes,
        entries: Array.isArray(source.entries) ? source.entries.map(normalizeEntry) : [],
        warnings: Array.isArray(source.warnings) ? source.warnings.map(normalizeWarning) : [],
      };
    }

    function applySkillsPayload(payload) {
      state.skills = normalizeSkillsState(payload);
      return state.skills;
    }

    async function refreshSkillsState() {
      const payload = await windowRef.jennyShell.skills.getState();
      applySkillsPayload(payload);
      return state.skills;
    }

    function skillRowMarkup(entry) {
      const command = entry.command || 'unavailable';
      const description = entry.description || 'No description provided.';
      const toolCount = entry.allowedTools.length ? ` · ${entry.allowedTools.length} tools` : '';
      return '<div class="settings-field-row skills-settings-row'
        + (entry.enabled ? '' : ' settings-field-row--muted') + '" data-skill-id="' + escapeHtml(entry.id) + '">'
        + '<span class="settings-field-row-text"><strong>' + escapeHtml(entry.name) + '</strong><small>/'
        + escapeHtml(command) + ' · ' + escapeHtml(description) + escapeHtml(toolCount) + '</small></span>'
        + (toggleSwitch?.({ id: 'skillToggle:' + entry.id, checked: entry.enabled,
          label: entry.name + ' enabled', className: 'skills-settings-row-toggle' }) || '') + '</div>';
    }

    function autoIndexRowMarkup(skillsState) {
      const autoCopy = 'Adds a short skill index to every turn (~900 tokens). '
        + 'Auto: on for cloud models, off for local models.';
      return '<div class="settings-field-row skills-settings-row" data-skills-auto-index-row>'
        + '<span class="settings-field-row-text"><strong>Let Jenny choose skills automatically</strong><small>'
        + autoCopy + '</small></span>'
        + (toggleSwitch?.({ id: 'skillsAutoIndexToggle', checked: skillsState.settings.autoIndex === 'on',
          label: 'Let Jenny choose skills automatically', className: 'skills-settings-row-toggle' }) || '') + '</div>';
    }

    function warningMarkup(skillsState, scopes) {
      const warnings = skillsState.warnings.length
        ? skillsState.warnings
        : scopes.flatMap((scope) => scope.warnings);
      if (!warnings.length) return '';
      const noun = warnings.length === 1 ? 'skill file' : 'skill files';
      return '<p class="settings-note" data-skills-warning>' + warnings.length + ' ' + noun
        + ' skipped: ' + escapeHtml(warnings[0].message) + '</p>';
    }

    function scopeByName(skillsState, scopeName) {
      return skillsState.scopes.find((scope) => scope.scope === scopeName) || normalizeScope({ scope: scopeName });
    }

    function folderControlsMarkup(scope, toggleId) {
      const blocked = scope.blocked || scope.status === 'blocked';
      return '<span class="skills-folder-row-controls">'
        + (toggleSwitch?.({ id: toggleId, checked: scope.enabled,
          label: (scope.scope === 'user' ? 'Personal' : 'Project') + ' skills enabled',
          className: 'skills-settings-row-toggle' }) || '')
        + (actionButton?.({ label: 'Open folder', variant: 'ghost', size: 'sm', disabled: blocked,
          dataset: { 'skills-action': 'open-folder', 'skills-scope': scope.scope } }) || '') + '</span>';
    }

    function foldersMarkup(skillsState) {
      const userScope = scopeByName(skillsState, 'user');
      const projectScope = scopeByName(skillsState, 'project');
      const userPath = userScope.path || 'Folder unavailable';
      const projectPath = projectScope.path || 'no workspace root';
      const manageButton = actionButton?.({ label: 'Manage', variant: 'ghost', size: 'sm',
        ariaExpanded: foldersExpanded, ariaControls: 'skillsFoldersDisclosure',
        dataset: { 'skills-action': 'toggle-folders' } }) || '';
      return '<div class="settings-field-row skills-folders-summary">'
        + '<span class="settings-field-row-text"><strong>Your skill folders</strong><small>'
        + escapeHtml(userPath) + ' · ' + (userScope.enabled ? 'on' : 'off') + ' · '
        + escapeHtml(projectPath) + ' · ' + (projectScope.enabled ? 'on' : 'off') + '</small></span>'
        + manageButton + '</div>'
        + '<div class="skills-folders-disclosure" id="skillsFoldersDisclosure" data-skills-folders-region'
        + (foldersExpanded ? '' : ' hidden') + '>'
        + '<div class="settings-field-row"><span class="settings-field-row-text"><strong>Personal skills</strong><small>'
        + escapeHtml(userPath) + '</small></span>' + folderControlsMarkup(userScope, 'skillsUserToggle') + '</div>'
        + '<div class="settings-field-row"><span class="settings-field-row-text"><strong>Project skills</strong><small>'
        + escapeHtml(projectScope.path || 'Set a workspace root first') + '</small></span>'
        + folderControlsMarkup(projectScope, 'skillsProjectToggle') + '</div></div>';
    }

    function renderSkillsManager() {
      if (!skillsSettingsSection) return;
      const rowsHost = skillsSettingsSection.querySelector('#skillsRowsHost');
      const foldersHost = skillsSettingsSection.querySelector('#skillsFoldersHost');
      if (!rowsHost || !foldersHost) return;
      const priorDisclosure = foldersHost.querySelector('[data-skills-folders-region]');
      if (priorDisclosure) foldersExpanded = !priorDisclosure.hidden;
      const skillsState = state.skills || normalizeSkillsState({});
      if (!skillsState.featureEnabled) {
        rowsHost.innerHTML = '<p class="settings-note">Skills are turned off by the JENNY_ENABLE_SKILLS_SYSTEM kill switch.</p>';
        foldersHost.innerHTML = '';
        return;
      }
      const scopeOrder = new Map([['bundled', 0], ['user', 1], ['project', 2]]);
      const enabledScopes = skillsState.scopes.filter((scope) => scope.enabled)
        .sort((left, right) => (scopeOrder.get(left.scope) ?? 99) - (scopeOrder.get(right.scope) ?? 99));
      const entries = enabledScopes.length
        ? enabledScopes.flatMap((scope) => scope.entries)
        : skillsState.entries;
      rowsHost.innerHTML = entries.map(skillRowMarkup).join('')
        + warningMarkup(skillsState, enabledScopes) + autoIndexRowMarkup(skillsState);
      foldersHost.innerHTML = foldersMarkup(skillsState);
    }

    async function updateSettings(patch) {
      try {
        const payload = await windowRef.jennyShell.skills.updateSettings(patch);
        applySkillsPayload(payload);
        renderSettings();
      } catch (error) {
        showShellErrorToast(toErrorMessage(error, 'Could not update skills settings.'), {
          title: 'Skills Update Failed',
          source: TOAST_SOURCE.settings,
          dedupeKey: `${TOAST_SOURCE.settings}:skills:error`,
        });
      }
    }

    async function openScopeFolder(scope) {
      try {
        const payload = await windowRef.jennyShell.skills.openScopeFolder(scope);
        applySkillsPayload(payload);
        renderSettings();
        showToastMessage('Opened skill folder.', {
          title: 'Skills',
          tone: 'success',
          source: TOAST_SOURCE.settings,
          dedupeKey: `${TOAST_SOURCE.settings}:skills:open:${scope}`,
        });
      } catch (error) {
        showShellErrorToast(toErrorMessage(error, 'Could not open the skill folder.'), {
          title: 'Skills Folder Failed',
          source: TOAST_SOURCE.settings,
          dedupeKey: `${TOAST_SOURCE.settings}:skills:open:error`,
        });
      }
    }

    function bindShellEvents() {
      const cleanupFns = [];
      if (windowRef.jennyShell?.skills?.onChanged) {
        cleanupFns.push(windowRef.jennyShell.skills.onChanged((payload) => {
          applySkillsPayload(payload);
          renderSettings();
        }));
      }
      return () => {
        while (cleanupFns.length) {
          const cleanup = cleanupFns.pop();
          if (typeof cleanup === 'function') cleanup();
        }
      };
    }

    return {
      applySkillsPayload,
      refreshSkillsState,
      renderSkillsManager,
      updateSettings,
      openScopeFolder,
      bindShellEvents,
    };
  }

  return { createSkillsManager };
});
