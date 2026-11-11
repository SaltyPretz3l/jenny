/* services/shell-config-setup-actions.js - ShellConfigService methods for the Home
 * config, first-run setup, assistant identity and companion mode.
 *
 * Extracted from shell-config-service.js as a behavior-preserving move and
 * installed on ShellConfigService.prototype the same way as the other
 * shell-config-*-actions bags; every method keeps its `this` contract
 * (state, _writeState, _commitState, _getNow).
 */
const { normalizeString } = require('./backend/path-utils');
const {
  DEFAULT_ASSISTANT_IDENTITY,
  normalizeAssistantIdentity,
  normalizeCompanionMode,
  normalizeHomeConfig,
  normalizeSetupState,
} = require('./shell-config-state');

function cloneSetupState(setup) {
  return {
    ...setup,
    steps: {
      ...setup.steps,
    },
  };
}

function cloneAssistantIdentity(identity) {
  return {
    ...identity,
  };
}

const setupActionMethods = {
  getHomeConfig() {
    return normalizeHomeConfig(this.state.home);
  },

  updateHomeConfig(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const current = normalizeHomeConfig(this.state.home);
    // Object-valued home sections merge shallowly so a partial patch (e.g.
    // {scratchpad:{text}} or {widgets:{hidden}}) keeps its sibling fields. Every
    // object-valued key of the home config MUST be listed here: the merge is
    // one level deep, so an unlisted section is overwritten wholesale by the
    // patch instead of merged, silently dropping its untouched fields.
    const mergeHomeSection = (key) => [key, {
      ...current[key],
      ...(source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])
        ? source[key]
        : {}),
    }];
    const nextHome = normalizeHomeConfig({
      ...current,
      ...source,
      ...Object.fromEntries(['widgets', 'scratchpad', 'calendar', 'layout', 'usageStats'].map(mergeHomeSection)),
    });
    if (JSON.stringify(nextHome) === JSON.stringify(current)) {
      return this.getHomeConfig();
    }
    const committed = this._commitState(
      {
        ...this.state,
        home: nextHome,
      },
      'home_config_updated'
    );
    if (!committed.persisted) {
      throw Object.assign(new Error('Home preferences could not be persisted.'), { code: 'home_config_write_failed' });
    }
    return committed.snapshot.home;
  },

  getSetupState() {
    return cloneSetupState(this.state.setup);
  },

  getAssistantIdentity() {
    return cloneAssistantIdentity(this.state.assistantIdentity);
  },

  updateSetupState(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const nowIso = this._getNow().toISOString();
    const nextSetup = normalizeSetupState({
      ...this.state.setup,
      ...source,
      updatedAt: normalizeString(source.updatedAt ?? source.updated_at) || nowIso,
      // Callers send snake_case step keys (workspace_root); stored steps are
      // camelCase, which normalizeSetupSteps reads first, so camel-case the patch.
      steps: {
        ...this.state.setup.steps,
        ...(source.steps && typeof source.steps === 'object' && !Array.isArray(source.steps)
          ? Object.fromEntries(Object.entries(source.steps).map(([key, value]) => [
            key.replace(/_([a-z])/g, (_match, letter) => letter.toUpperCase()), value,
          ]))
          : {}),
      },
    });
    if (JSON.stringify(nextSetup) === JSON.stringify(this.state.setup)) {
      return this.getSetupState();
    }
    const snapshot = this._writeState(
      {
        ...this.state,
        setup: nextSetup,
      },
      'setup_state_updated'
    );
    return cloneSetupState(snapshot.setup);
  },

  markSetupComplete() {
    const nowIso = this._getNow().toISOString();
    const snapshot = this._writeState(
      {
        ...this.state,
        setup: normalizeSetupState({
          ...this.state.setup,
          seen: true,
          setupComplete: true,
          completedAt: nowIso,
          updatedAt: nowIso,
        }),
      },
      'setup_completed'
    );
    return cloneSetupState(snapshot.setup);
  },

  resetSetupState() {
    const nowIso = this._getNow().toISOString();
    const snapshot = this._writeState(
      {
        ...this.state,
        setup: normalizeSetupState({
          updatedAt: nowIso,
        }),
      },
      'setup_reset'
    );
    return cloneSetupState(snapshot.setup);
  },

  updateAssistantIdentity(patch = {}) {
    const source = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    const nowIso = this._getNow().toISOString();
    const nextIdentity = normalizeAssistantIdentity({
      ...this.state.assistantIdentity,
      ...source,
      updatedAt: normalizeString(source.updatedAt ?? source.updated_at) || nowIso,
    });
    if (JSON.stringify(nextIdentity) === JSON.stringify(this.state.assistantIdentity)) {
      return this.getAssistantIdentity();
    }
    const committed = this._commitState(
      {
        ...this.state,
        assistantIdentity: nextIdentity,
      },
      'assistant_identity_updated'
    );
    if (!committed.persisted) {
      throw Object.assign(new Error('Assistant identity could not be persisted.'), { code: 'assistant_identity_write_failed' });
    }
    return cloneAssistantIdentity(committed.snapshot.assistantIdentity);
  },

  resetOnboarding() {
    const nowIso = this._getNow().toISOString();
    const nextSetup = normalizeSetupState({ updatedAt: nowIso });
    const nextIdentity = normalizeAssistantIdentity({
      ...DEFAULT_ASSISTANT_IDENTITY,
      updatedAt: nowIso,
    });
    const committed = this._commitState(
      {
        ...this.state,
        setup: nextSetup,
        assistantIdentity: nextIdentity,
      },
      'onboarding_reset'
    );
    if (!committed.persisted) {
      const error = new Error('Onboarding reset could not be persisted.');
      error.code = 'onboarding_reset_write_failed';
      throw error;
    }
    const { snapshot } = committed;
    return {
      setup: cloneSetupState(snapshot.setup),
      assistantIdentity: cloneAssistantIdentity(snapshot.assistantIdentity),
    };
  },

  setCompanionMode(mode) {
    const normalizedMode = normalizeCompanionMode(mode);
    if (normalizedMode === this.state.companion.mode) {
      return this.getState();
    }
    return this._writeState(
      {
        ...this.state,
        companion: {
          mode: normalizedMode,
        },
      },
      'companion_mode_updated'
    );
  },
};

module.exports = { setupActionMethods };
