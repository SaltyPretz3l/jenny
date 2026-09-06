/**
 * tests/helpers/renderer-shell-harness-personality.js
 *
 * Renderer-harness stubs for the personality v3 IPC surface (spec G):
 * `jennyShell.personality.getState/save/clear/openWorkspaceFolder` and
 * `jennyShell.memory.contextFiles.getState/writeFile/resetFile`.
 *
 * The retired per-file read/write/reset surface is deliberately absent -- a
 * stub that outlives its channel is how a renderer test goes on passing
 * against an API nobody ships.
 */

function emptyCompiled() {
  return { text: '', chars: 0, tokensEstimate: 0, sections: [] };
}

function createPersonalityStub(personalityOptions, state) {
  const options = personalityOptions || {};
  return {
    async getState() {
      if (typeof options.getState === 'function') {
        return options.getState({ state });
      }
      return {
        agentName: 'Jenny',
        files: { personality: { body: '', chars: 0 }, user: { body: '', chars: 0 } },
        budgets: { personality: 1500, user: 1000, memory: 1500 },
        compiled: emptyCompiled(),
        schemaVersion: 3,
        migration: { mergedFrom: [], archivedFiles: [] },
      };
    },
    async save(payload) {
      if (typeof options.save === 'function') {
        return options.save(payload, { state });
      }
      return {
        ok: true,
        agentName: String((payload && payload.agentName) || 'Jenny'),
        compiled: emptyCompiled(),
      };
    },
    async clear() {
      if (typeof options.clear === 'function') {
        return options.clear({ state });
      }
      return { ok: true, compiled: emptyCompiled() };
    },
    async openWorkspaceFolder() {
      if (typeof options.openWorkspaceFolder === 'function') {
        return options.openWorkspaceFolder({ state });
      }
      return { ok: true, message: '' };
    },
  };
}

function createMemoryNotesStub(memoryOptions, state) {
  const options = memoryOptions || {};
  return {
    async getState() {
      if (typeof options.contextFilesState === 'function') {
        return options.contextFilesState({ state });
      }
      return { body: '', chars: 0, budget: 1500, compiledChars: 0 };
    },
    async writeFile(payload) {
      if (typeof options.contextFilesWrite === 'function') {
        return options.contextFilesWrite(payload, { state });
      }
      return { ok: true };
    },
    async resetFile() {
      if (typeof options.contextFilesReset === 'function') {
        return options.contextFilesReset({ state });
      }
      return { ok: true };
    },
  };
}

module.exports = {
  createMemoryNotesStub,
  createPersonalityStub,
};
