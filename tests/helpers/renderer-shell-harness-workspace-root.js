function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function getMissingWorkspaceRootStatus() {
  return {
    state: 'missing',
    message: 'No workspace root is configured yet.',
  };
}

function getSelectedWorkspaceRootPayload() {
  return {
    workspaceRoot: 'G:/workspace/selected',
    workspaceRootStatus: {
      state: 'ready',
      message: 'Workspace root is configured.',
    },
  };
}

function createDefaultProactiveState(options = {}) {
  return cloneJson(
    options.proactive?.state || {
      toolsWorkspaceRoot: '',
      workspaceRootStatus: {
        state: 'missing',
        message: 'Workspace-dependent proactive behaviors are blocked until a workspace root is configured.',
      },
      proactive: {
        reminders: [],
      },
    }
  );
}

function createInitialWorkspaceRootState(options = {}) {
  return cloneJson(
    options.workspaceRoot?.state || {
      workspaceRoot:
        options.proactive?.state?.toolsWorkspaceRoot
        || options.companion?.state?.workspaceSnapshot?.workspaceRoot
        || '',
      workspaceRootStatus:
        options.proactive?.state?.workspaceRootStatus
        || options.companion?.state?.workspaceSnapshot?.workspaceRootStatus
        || options.features?.state?.availability?.runtime?.workspaceRootStatus
        || getMissingWorkspaceRootStatus(),
    }
  );
}

function syncWorkspaceRootDependents(state) {
  const rootState = state.workspaceRootState || {
    workspaceRoot: '',
    workspaceRootStatus: getMissingWorkspaceRootStatus(),
  };
  const workspaceReady = rootState.workspaceRootStatus?.state === 'ready';
  const managedSidecarActive = state.featuresState?.availability?.runtime?.managedSidecarActive !== false;

  state.proactiveState = {
    ...state.proactiveState,
    toolsWorkspaceRoot: rootState.workspaceRoot || '',
    workspaceRootStatus: {
      ...(rootState.workspaceRootStatus || {}),
    },
  };
  state.featuresState = {
    ...state.featuresState,
    availability: {
      ...(state.featuresState.availability || {}),
      runtime: {
        ...((state.featuresState.availability || {}).runtime || {}),
        workspaceRootStatus: {
          ...(rootState.workspaceRootStatus || {}),
        },
      },
      tools: {
        ...((state.featuresState.availability || {}).tools || {}),
        todo: {
          ...((state.featuresState.availability || {}).tools || {}).todo,
          enabled: managedSidecarActive && workspaceReady,
        },
        workspaceRoot: {
          ...((state.featuresState.availability || {}).tools || {}).workspaceRoot,
          enabled: workspaceReady,
        },
        glob_files: {
          ...((state.featuresState.availability || {}).tools || {}).glob_files,
          enabled: managedSidecarActive && workspaceReady,
        },
        grep_search: {
          ...((state.featuresState.availability || {}).tools || {}).grep_search,
          enabled: managedSidecarActive && workspaceReady,
        },
        edit_file: {
          ...((state.featuresState.availability || {}).tools || {}).edit_file,
          enabled: managedSidecarActive && workspaceReady,
        },
        shell: {
          ...((state.featuresState.availability || {}).tools || {}).shell,
          enabled: managedSidecarActive && workspaceReady,
        },
        background_shell: {
          ...((state.featuresState.availability || {}).tools || {}).background_shell,
          enabled: managedSidecarActive && workspaceReady,
        },
        checkpoint_backups: {
          ...((state.featuresState.availability || {}).tools || {}).checkpoint_backups,
          enabled: workspaceReady,
        },
      },
      featureFlags: {
        ...((state.featuresState.availability || {}).featureFlags || {}),
        git_tracking: {
          ...((state.featuresState.availability || {}).featureFlags || {}).git_tracking,
          enabled: managedSidecarActive && workspaceReady,
        },
      },
    },
  };
  state.companionState = {
    ...state.companionState,
    workspaceSnapshot: {
      ...(state.companionState.workspaceSnapshot || {}),
      workspaceRoot: rootState.workspaceRoot || '',
      workspaceRootStatus: {
        ...(rootState.workspaceRootStatus || {}),
      },
    },
  };
}

function applyWorkspaceRootPayload(state, payload = {}) {
  state.workspaceRootState = {
    workspaceRoot: String(payload.workspaceRoot || '').trim(),
    workspaceRootStatus:
      payload.workspaceRootStatus && typeof payload.workspaceRootStatus === 'object'
        ? { ...payload.workspaceRootStatus }
        : getMissingWorkspaceRootStatus(),
  };
  syncWorkspaceRootDependents(state);
  return state.workspaceRootState;
}

function initializeWorkspaceRootHarnessState(options, state) {
  state.proactiveState = createDefaultProactiveState(options);
  state.workspaceRootState = createInitialWorkspaceRootState(options);
  syncWorkspaceRootDependents(state);
}

function getProactiveStatePayload(state) {
  return {
    ...state.proactiveState,
    toolsWorkspaceRoot: state.workspaceRootState.workspaceRoot || '',
    workspaceRootStatus: {
      ...state.workspaceRootState.workspaceRootStatus,
    },
  };
}

// The renderer's workspace-root mutations now run through the root-transition
// controller (renderer/shell/renderer-workspace-root-transition.js), which
// talks to this stub as the prepare/commit bridge: captureContext ->
// prepareChoose/prepareClear -> commit (or cancel). The legacy proactive
// overrides keep their old payload shape: they resolve the transition target at
// prepare time and the payload is applied on commit. Payloads may signal
// `canceled: true` or `changed: false` to abort the transition at prepare.
function createWorkspaceRootStub(options, state) {
  let generation = 1;
  let transitionCounter = 0;
  const pendingTransitions = new Map();

  function currentContext() {
    const rootPath = state.workspaceRootState?.workspaceRoot || '';
    return {
      rootPath,
      rootId: rootPath ? 'root-harness' : null,
      generation,
      phase: 'ready',
    };
  }

  async function resolveTargetPayload(mode) {
    if (mode === 'choose') {
      if (typeof options.proactive?.chooseWorkspaceRoot === 'function') {
        const payload = await options.proactive.chooseWorkspaceRoot({ state });
        return {
          ...payload,
          workspaceRoot: payload?.workspaceRoot || payload?.toolsWorkspaceRoot,
          workspaceRootStatus: payload?.workspaceRootStatus,
        };
      }
      return getSelectedWorkspaceRootPayload();
    }
    if (typeof options.proactive?.clearWorkspaceRoot === 'function') {
      const payload = await options.proactive.clearWorkspaceRoot({ state });
      return {
        ...payload,
        workspaceRoot: payload?.workspaceRoot || payload?.toolsWorkspaceRoot,
        workspaceRootStatus: payload?.workspaceRootStatus,
      };
    }
    return {
      workspaceRoot: '',
      workspaceRootStatus: getMissingWorkspaceRootStatus(),
    };
  }

  async function prepare(mode) {
    const previous = currentContext();
    const payload = await resolveTargetPayload(mode);
    if (payload?.canceled === true) {
      return { prepared: false, canceled: true, changed: false };
    }
    const nextRoot = String(payload?.workspaceRoot || '').trim();
    if (payload?.changed === false || nextRoot === previous.rootPath) {
      return { prepared: false, canceled: false, changed: false, noop: true };
    }
    const transitionId = `harness-transition-${++transitionCounter}`;
    pendingTransitions.set(transitionId, { payload, previous });
    return {
      prepared: true,
      transitionId,
      changed: true,
      canceled: false,
      previous,
      candidate: {
        rootPath: nextRoot,
        rootId: nextRoot ? 'root-harness' : null,
        generation: generation + 1,
        phase: 'preparing',
      },
    };
  }

  return {
    async captureContext() {
      if (typeof options.workspaceRoot?.captureContext === 'function') {
        return options.workspaceRoot.captureContext({ state });
      }
      return currentContext();
    },
    async prepareChoose() {
      if (typeof options.workspaceRoot?.prepareChoose === 'function') {
        return options.workspaceRoot.prepareChoose({ state });
      }
      return prepare('choose');
    },
    async prepareClear() {
      if (typeof options.workspaceRoot?.prepareClear === 'function') {
        return options.workspaceRoot.prepareClear({ state });
      }
      return prepare('clear');
    },
    async commit(request) {
      if (typeof options.workspaceRoot?.commit === 'function') {
        return options.workspaceRoot.commit(request, { state });
      }
      const entry = pendingTransitions.get(request?.transitionId);
      if (!entry) {
        return { committed: false, changed: false, blocked: true, code: 'unknown_transition' };
      }
      pendingTransitions.delete(request.transitionId);
      generation += 1;
      applyWorkspaceRootPayload(state, entry.payload);
      return {
        committed: true,
        changed: true,
        previous: entry.previous,
        context: currentContext(),
      };
    },
    async cancel(request) {
      if (typeof options.workspaceRoot?.cancel === 'function') {
        return options.workspaceRoot.cancel(request, { state });
      }
      const known = pendingTransitions.delete(request?.transitionId);
      return { canceled: known, changed: false, code: known ? '' : 'unknown_transition' };
    },
    async getState() {
      if (typeof options.workspaceRoot?.getState === 'function') {
        const payload = await options.workspaceRoot.getState({ state });
        if (payload && typeof payload === 'object') {
          applyWorkspaceRootPayload(state, payload);
        }
      } else if (typeof options.proactive?.getState === 'function') {
        const payload = await options.proactive.getState({ state });
        if (payload && typeof payload === 'object') {
          applyWorkspaceRootPayload(state, {
            workspaceRoot: payload.workspaceRoot || payload.toolsWorkspaceRoot,
            workspaceRootStatus: payload.workspaceRootStatus,
          });
        }
      }
      return state.workspaceRootState;
    },
  };
}

module.exports = {
  applyWorkspaceRootPayload,
  createWorkspaceRootStub,
  getProactiveStatePayload,
  initializeWorkspaceRootHarnessState,
};
