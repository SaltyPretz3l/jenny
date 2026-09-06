'use strict';

const DEFAULT_CONTEXT = Object.freeze({
  rootPath: 'G:/renderer-harness',
  rootId: 'root_renderer_harness',
  generation: 1,
  phase: 'ready',
});

function createWorkspaceIdeStub(options, state) {
  if (!options) return undefined;
  const context = options.context || DEFAULT_CONTEXT;
  return {
    async getState() {
      const result = typeof options.getState === 'function'
        ? await options.getState({ state })
        : null;
      if (!result || result.ok === false || result.context) return result;
      return { ok: true, context, ...result };
    },
    async updateSettings(patch) {
      return typeof options.updateSettings === 'function'
        ? options.updateSettings(patch, { state })
        : null;
    },
    async updateState(payload) {
      return typeof options.updateState === 'function'
        ? options.updateState(payload, { state })
        : { updated: true, context };
    },
  };
}

module.exports = { createWorkspaceIdeStub };
