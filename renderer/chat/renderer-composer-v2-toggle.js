/* renderer/chat/renderer-composer-v2-toggle.js - Composer V2 tool toggle controller. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(
      require('./renderer-composer-v2-state'),
      require('./renderer-composer-v2-model')
    );
    return;
  }
  root.rendererComposerV2Toggle = factory(root.rendererComposerV2State || {}, root.rendererComposerV2Model || {});
})(typeof globalThis !== 'undefined' ? globalThis : this, function (composerV2State, composerV2Model) {
  'use strict';

  const { ensureComposerV2State } = composerV2State || {};
  const {
    TOOL_CATEGORY_CONFIG_KEYS = {},
    TOOL_CATEGORY_SESSION_KEYS = {},
    TOOL_TOGGLE_CATEGORIES = [],
    escapeHtml = (value) => String(value || ''),
    getToolCategoryId = () => '',
    normalizeToolEntry = (entry) => ({ name: String(entry || '').trim(), available: true, reason: '' }),
  } = composerV2Model || {};
  const LOCKDOWN_TOOLTIP = 'Offline lockdown is on for this session';

  function sessionToolOverrideEchoMatches(persisted, sessionId, requestedOverrides) {
    const overrides = persisted?.tool_category_overrides;
    return String(persisted?.id || '').trim() === String(sessionId || '').trim()
      && overrides && typeof overrides === 'object' && !Array.isArray(overrides)
      && Object.entries(requestedOverrides || {}).every(([key, value]) => overrides[key] === value);
  }

  function createComposerV2ToggleController(deps = {}) {
    const state = deps.state || {};
    const persistToolPreference = typeof deps.persistSessionToolPreference === 'function'
      ? deps.persistSessionToolPreference
      : null;
    const onPersistError = typeof deps.onPersistError === 'function'
      ? deps.onPersistError
      : null;
    const getCurrentSessionId = typeof deps.getCurrentSessionId === 'function'
      ? deps.getCurrentSessionId
      : () => '';
    const committedToggleState = new Map();
    const committedOverrideCategories = new Set();
    const persistenceRevisions = new Map();
    let persistenceQueue = Promise.resolve(true);
    let hydrationGeneration = 0;
    if (typeof ensureComposerV2State !== 'function') {
      throw new Error('createComposerV2ToggleController: composer-v2-state is incomplete');
    }
    ensureComposerV2State(state);

    function getComposerState() {
      return ensureComposerV2State(state);
    }

    function isOfflineLockdownActive() {
      if (state.features?.featureFlags?.session_offline_lockdown !== true) return false;
      const sessionId = String(getCurrentSessionId() || state.currentSessionId || '').trim();
      return Boolean(sessionId && (Array.isArray(state.sessions) ? state.sessions : [])
        .find((session) => String(session?.id || '').trim() === sessionId)?.lockdown === true);
    }

    function noteCategory(categoryId, entry) {
      if (!categoryId) return;
      const composer = getComposerState();
      const current = composer.toolCategoryMeta.get(categoryId) || { present: false, available: false, reason: '' };
      const nextAvailable = current.available || entry.available === true;
      const nextMeta = {
        present: true,
        available: nextAvailable,
        reason: nextAvailable ? '' : (current.reason || entry.reason),
      };
      composer.toolCategoryMeta.set(categoryId, nextMeta);
      if (nextAvailable) {
        composer.availableToolCategories.set(categoryId, true);
      }
    }

    function setAvailableTools(availableToolNames) {
      const tools = Array.isArray(availableToolNames) ? availableToolNames : [];
      const composer = getComposerState();
      composer.availableToolCategories.clear();
      composer.toolCategoryMeta.clear();
      for (const tool of tools) {
        const entry = normalizeToolEntry(tool);
        const categoryId = getToolCategoryId(entry.name);
        if (categoryId) noteCategory(categoryId, entry);
      }
      for (const categoryId of composer.availableToolCategories.keys()) {
        if (!composer.toolToggleState.has(categoryId)) {
          composer.toolToggleState.set(categoryId, true);
        }
      }
    }

    function setToggle(categoryId, enabled) {
      const normalizedCategoryId = String(categoryId || '').trim();
      if (!normalizedCategoryId) return Promise.resolve(false);
      if (isOfflineLockdownActive()) return Promise.resolve(false);
      const composer = getComposerState();
      const nextEnabled = enabled === true;
      composer.toolToggleState.set(normalizedCategoryId, nextEnabled);
      const sessionKey = TOOL_CATEGORY_SESSION_KEYS[normalizedCategoryId];
      if (!sessionKey || !persistToolPreference) {
        return Promise.resolve(true);
      }

      const sessionId = String(getCurrentSessionId() || '').trim();
      const generation = hydrationGeneration;
      const revision = (persistenceRevisions.get(normalizedCategoryId) || 0) + 1;
      persistenceRevisions.set(normalizedCategoryId, revision);

      const persist = async () => {
        try {
          await persistToolPreference(sessionKey, nextEnabled, sessionId);
          if (generation === hydrationGeneration && sessionId === String(getCurrentSessionId() || '').trim()) {
            committedToggleState.set(normalizedCategoryId, nextEnabled);
            committedOverrideCategories.add(normalizedCategoryId);
            if (persistenceRevisions.get(normalizedCategoryId) === revision) {
              composer.sessionOverrideCategories.add(normalizedCategoryId);
            }
          }
          return true;
        } catch (error) {
          const isCurrent = generation === hydrationGeneration
            && sessionId === String(getCurrentSessionId() || '').trim();
          if (isCurrent && persistenceRevisions.get(normalizedCategoryId) === revision) {
            composer.toolToggleState.set(
              normalizedCategoryId,
              committedToggleState.get(normalizedCategoryId) !== false
            );
            if (committedOverrideCategories.has(normalizedCategoryId)) {
              composer.sessionOverrideCategories.add(normalizedCategoryId);
            } else {
              composer.sessionOverrideCategories.delete(normalizedCategoryId);
            }
          }
          if (onPersistError) onPersistError(error, normalizedCategoryId, { isCurrent });
          return false;
        }
      };
      const result = persistenceQueue.then(persist, persist);
      persistenceQueue = result;
      return result;
    }

    /**
     * Seed toggle state from the persisted tools.* settings map
     * (features.getState().tools / state.features.tools). Categories whose
     * config key is absent or non-boolean keep their current state.
     */
    function hydrateFromToolSettings(toolSettings) {
      if (!toolSettings || typeof toolSettings !== 'object' || Array.isArray(toolSettings)) {
        return;
      }
      const composer = getComposerState();
      hydrationGeneration += 1;
      committedToggleState.clear();
      committedOverrideCategories.clear();
      persistenceRevisions.clear();
      composer.sessionOverrideCategories.clear();
      for (const category of TOOL_TOGGLE_CATEGORIES) {
        const configKey = TOOL_CATEGORY_CONFIG_KEYS[category.id];
        if (!configKey || typeof toolSettings[configKey] !== 'boolean') continue;
        composer.toolToggleState.set(category.id, toolSettings[configKey]);
        committedToggleState.set(category.id, toolSettings[configKey]);
      }
    }

    function hydrateFromSessionOverrides(overrides) {
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;
      const composer = getComposerState();
      for (const category of TOOL_TOGGLE_CATEGORIES) {
        const sessionKey = TOOL_CATEGORY_SESSION_KEYS[category.id];
        if (sessionKey && typeof overrides[sessionKey] === 'boolean') {
          composer.toolToggleState.set(category.id, overrides[sessionKey]);
          composer.sessionOverrideCategories.add(category.id);
          committedToggleState.set(category.id, overrides[sessionKey]);
          committedOverrideCategories.add(category.id);
        }
      }
    }

    function getToggleStates() {
      const composer = getComposerState();
      const states = {};
      for (const category of TOOL_TOGGLE_CATEGORIES) {
        if (composer.availableToolCategories.get(category.id) === true) {
          states[category.id] = composer.toolToggleState.get(category.id) !== false;
        }
      }
      return states;
    }

    /** Enabled-and-available vs present category counts for the Tools chip. */
    function getToolsChipCount() {
      const composer = getComposerState();
      let present = 0;
      let enabled = 0;
      for (const category of TOOL_TOGGLE_CATEGORIES) {
        const meta = composer.toolCategoryMeta.get(category.id) || {};
        const isPresent = Boolean(meta.present || composer.availableToolCategories.get(category.id));
        if (!isPresent) continue;
        present += 1;
        const available = composer.availableToolCategories.get(category.id) === true;
        if (available && composer.toolToggleState.get(category.id) !== false) {
          enabled += 1;
        }
      }
      return { enabled, present, text: enabled + '/' + present };
    }

    function renderToolToggles() {
      const inv = typeof globalThis !== 'undefined' && globalThis.inventory ? globalThis.inventory : null;
      const ts = inv && typeof inv.toggleSwitch === 'function' ? inv.toggleSwitch : null;
      if (!ts) return '';

      const composer = getComposerState();
      const lockdown = isOfflineLockdownActive();
      const toggles = [];
      let hasPresentCategory = false;
      for (const category of TOOL_TOGGLE_CATEGORIES) {
        const meta = composer.toolCategoryMeta.get(category.id) || {};
        const present = Boolean(meta.present || composer.availableToolCategories.get(category.id));
        const available = composer.availableToolCategories.get(category.id) === true;
        const enabled = composer.toolToggleState.get(category.id) !== false;
        const source = composer.sessionOverrideCategories.has(category.id)
          ? 'Current chat override'
          : 'Settings default';
        const blocker = String(meta.reason || '').trim();
        const reason = lockdown ? LOCKDOWN_TOOLTIP : (blocker ? `${source}. ${blocker}` : source);
        const reasonId = reason ? `tool-toggle-${category.id}-reason` : '';
        if (present) hasPresentCategory = true;

        toggles.push(
          '<div class="inv-composer-toggle-item"'
          + (present ? '' : ' aria-hidden="true" style="display:none"')
          + (reason ? ' title="' + escapeHtml(reason) + '"' : '')
          + '>'
          + (category.icon
            ? '<span class="composer-tools-row-icon" aria-hidden="true">' + category.icon + '</span>'
            : '')
          + ts({
            id: 'tool-toggle-' + category.id,
            label: category.label,
            checked: enabled && available,
            disabled: lockdown || !available,
            description: reason,
            descriptionId: reasonId,
          })
          + '</div>'
        );
      }

      if (!hasPresentCategory) {
        return '';
      }

      const switchGroup = '<div class="inv-composer-toggles" role="group" aria-label="Tool toggles">'
        + toggles.join('')
        + '</div>';

      if (!inv.chip || !inv.popover) {
        return '';
      }
      const count = getToolsChipCount();
      return inv.chip({
        id: 'composer-tools',
        domId: 'composerToolsChip',
        label: 'Tools',
        count: count.text,
        hasPopup: true,
        ariaControls: 'composerToolsPopover',
        ariaLabel: 'Session tools: ' + count.text + ' enabled',
        title: 'Session tools: ' + count.text + ' enabled',
        className: 'composer-tools-chip',
      })
      + inv.popover({
        id: 'composer-tools',
        domId: 'composerToolsPopover',
        ariaLabel: 'Session tools',
        title: 'Session tools',
        className: 'composer-tools-popover',
        trustedHtml: '<div class="composer-tools-popover-header">Workspace tools</div>'
          + switchGroup
          + '<div class="inv-popover-footer">Overrides apply to this chat; Settings owns defaults.</div>',
      });
    }

    return {
      setAvailableTools,
      setToggle,
      getToggleStates,
      getToolsChipCount,
      hydrateFromToolSettings,
      hydrateFromSessionOverrides,
      renderToolToggles,
    };
  }

  return {
    createComposerV2ToggleController,
    LOCKDOWN_TOOLTIP,
    sessionToolOverrideEchoMatches,
  };
});
