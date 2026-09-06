function createDefaultSkillsState() {
  return {
    featureEnabled: false,
    settings: {
      bundledEnabled: true,
      userEnabled: true,
      projectEnabled: true,
    },
    scopes: [],
    warnings: [],
    counts: { total: 0, always: 0, warnings: 0 },
  };
}

function createDefaultTipsState() {
  return {
    featureEnabled: false,
    settings: {
      enabled: true,
      sessionCount: 1,
      historyByTipId: {},
    },
    relevantTips: [],
    activeTip: null,
  };
}

async function emitGuidanceState(listeners, bucket, state, key, payload) {
  const nextState = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? { ...state[key], ...payload }
    : state[key];
  state[key] = nextState;
  await Promise.all((listeners[bucket] || []).map((listener) => listener(nextState)));
}

function createSkillsStub(options, state) {
  return {
    async getState() {
      if (typeof options.skills?.getState === 'function') {
        const payload = await options.skills.getState({ state });
        if (payload && typeof payload === 'object') {
          state.skillsState = { ...state.skillsState, ...payload };
        }
      }
      return state.skillsState;
    },
    async updateSettings(patch) {
      if (typeof options.skills?.updateSettings === 'function') {
        const payload = await options.skills.updateSettings(patch, { state });
        if (payload && typeof payload === 'object') {
          state.skillsState = { ...state.skillsState, ...payload };
        }
        return state.skillsState;
      }
      state.skillsState = {
        ...state.skillsState,
        settings: {
          ...state.skillsState.settings,
          ...(patch && typeof patch === 'object' ? patch : {}),
        },
      };
      return state.skillsState;
    },
    async openScopeFolder(scope) {
      if (typeof options.skills?.openScopeFolder === 'function') {
        const payload = await options.skills.openScopeFolder(scope, { state });
        if (payload && typeof payload === 'object') {
          state.skillsState = { ...state.skillsState, ...payload };
        }
      }
      return state.skillsState;
    },
    onChanged(listener) {
      return typeof options.addListener === 'function'
        ? options.addListener('skills', listener)
        : () => {};
    },
  };
}

function createTipsStub(options, state, addListener) {
  return {
    async getState() {
      if (typeof options.tips?.getState === 'function') {
        const payload = await options.tips.getState({ state });
        if (payload && typeof payload === 'object') {
          state.tipsState = { ...state.tipsState, ...payload };
        }
      }
      return state.tipsState;
    },
    async updateSettings(patch) {
      if (typeof options.tips?.updateSettings === 'function') {
        const payload = await options.tips.updateSettings(patch, { state });
        if (payload && typeof payload === 'object') {
          state.tipsState = { ...state.tipsState, ...payload };
        }
        return state.tipsState;
      }
      state.tipsState = {
        ...state.tipsState,
        settings: {
          ...state.tipsState.settings,
          ...(patch && typeof patch === 'object' ? patch : {}),
        },
      };
      return state.tipsState;
    },
    onChanged(listener) {
      return addListener('tips', listener);
    },
  };
}

module.exports = {
  createDefaultSkillsState,
  createDefaultTipsState,
  createSkillsStub,
  createTipsStub,
  emitGuidanceState,
};
