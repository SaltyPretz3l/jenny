/* Shared fakes for the setup-service test suite (split across sibling
 * files to respect the file-size ceiling). */
const {
  DEFAULT_ASSISTANT_IDENTITY,
  DEFAULT_SETUP,
} = require('../../services/shell-config-setup-state');

function cloneSetup(setup = DEFAULT_SETUP) {
  return {
    ...setup,
    steps: {
      ...setup.steps,
    },
  };
}

function createConfigService(state = {}) {
  const store = {
    setup: cloneSetup(state.setup),
    assistantIdentity: { ...(state.assistantIdentity || DEFAULT_ASSISTANT_IDENTITY) },
    toolsWorkspaceRoot: state.toolsWorkspaceRoot || '',
    workspaceRootStatus: state.workspaceRootStatus || null,
    setupUpdateCount: 0,
  };
  return {
    getSetupState: () => cloneSetup(store.setup),
    updateSetupState(patch) {
      store.setupUpdateCount += 1;
      store.setup = {
        ...store.setup,
        ...patch,
        steps: {
          ...store.setup.steps,
          ...(patch.steps || {}),
        },
      };
      return this.getSetupState();
    },
    markSetupComplete() {
      store.setup = {
        ...store.setup,
        setupComplete: true,
        completedAt: '2026-05-07T12:00:00.000Z',
        updatedAt: '2026-05-07T12:00:00.000Z',
      };
      return this.getSetupState();
    },
    resetSetupState() {
      store.setup = {
        ...cloneSetup(),
        updatedAt: '2026-05-07T12:00:00.000Z',
      };
      return this.getSetupState();
    },
    getAssistantIdentity: () => ({ ...store.assistantIdentity }),
    updateAssistantIdentity(patch) {
      store.assistantIdentity = {
        ...store.assistantIdentity,
        ...patch,
      };
      return this.getAssistantIdentity();
    },
    resetOnboarding() {
      store.setup = {
        ...cloneSetup(),
        updatedAt: '2026-05-07T12:00:00.000Z',
      };
      store.assistantIdentity = { ...DEFAULT_ASSISTANT_IDENTITY };
      return {
        setup: this.getSetupState(),
        assistantIdentity: this.getAssistantIdentity(),
      };
    },
    clearToolsWorkspaceRoot() {
      store.toolsWorkspaceRoot = '';
      return this.getState();
    },
    getToolsWorkspaceRoot: () => store.toolsWorkspaceRoot,
    getWorkspaceRootStatus: () => store.workspaceRootStatus || (
      store.toolsWorkspaceRoot
        ? { state: 'ready', message: 'Workspace root is configured.' }
        : { state: 'missing', message: 'No workspace root is configured.' }
    ),
    getSetupUpdateCount: () => store.setupUpdateCount,
    getState: () => ({
      setup: cloneSetup(store.setup),
      assistantIdentity: { ...store.assistantIdentity },
      toolsWorkspaceRoot: store.toolsWorkspaceRoot,
    }),
  };
}

module.exports = {
  cloneSetup,
  createConfigService,
  DEFAULT_ASSISTANT_IDENTITY,
  DEFAULT_SETUP,
};
