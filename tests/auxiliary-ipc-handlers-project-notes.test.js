'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const { getBridgeChannel } = require('../services/ipc-contract');

// Only the project-notes handlers are exercised; the other services are inert stubs.
function registerMinimalHandlers(overrides = {}) {
  const handlers = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle(channel, handler) { handlers.set(channel, handler); } },
    personalityWorkspace: {},
    artifactService: {},
    backendService: {},
    getProactiveStatePayload: () => ({}),
    shellConfigService: { getState: () => ({}) },
    companionService: {},
    suggestionCache: {},
    getCachedOrGenerateSuggestions: () => [],
    offlineIntelligenceService: {},
    dialog: {},
    getMainWindow: () => null,
    chooseWorkspaceRoot: async () => null,
    clearWorkspaceRoot: () => null,
    prepareAttachmentEntries: () => ({ accepted: [], rejected: [] }),
    attachmentAssetStore: null,
    processRef: { cwd: () => process.cwd() },
    os: {},
    isChildPath: () => false,
    clipboard: { writeText() {} },
    log: () => null,
    getMainLifecycle: () => null,
    toolExecutor: { registry: { getAllTools: () => [] } },
    toolPermissionStore: {},
    usageHistory: {},
    ...overrides,
  });
  return handlers;
}

function invoke(handlers, method, ...args) {
  return handlers.get(getBridgeChannel(method, 'invoke'))({}, ...args);
}

test('project notes handlers marshal their arguments to the service and return its result', async () => {
  const calls = [];
  const record = (name, result) => (...args) => {
    calls.push([name, ...args]);
    return result;
  };
  const handlers = registerMinimalHandlers({
    projectNotesService: {
      get: record('get', { ok: true, note: { text: 'a' } }),
      save: record('save', { ok: true, note: { text: 'b' } }),
      undo: record('undo', { ok: false, reason: 'changed_since' }),
      lease: record('lease', { ok: true, held: true, expiresAt: 'later' }),
    },
  });

  assert.deepEqual(await invoke(handlers, 'projectNotes.get', 'project_alpha'), { ok: true, note: { text: 'a' } });
  assert.deepEqual(await invoke(handlers, 'projectNotes.save', 'project_alpha', 'text', 3), { ok: true, note: { text: 'b' } });
  assert.deepEqual(await invoke(handlers, 'projectNotes.undo', 'project_alpha', 'pnj_1'), { ok: false, reason: 'changed_since' });
  assert.deepEqual(await invoke(handlers, 'projectNotes.lease', 'project_alpha', true), { ok: true, held: true, expiresAt: 'later' });
  assert.deepEqual(calls, [
    ['get', 'project_alpha'],
    ['save', 'project_alpha', 'text', 3],
    ['undo', 'project_alpha', 'pnj_1'],
    ['lease', 'project_alpha', true],
  ]);
});

test('project notes handlers return unavailable when the service is missing', async () => {
  const handlers = registerMinimalHandlers();
  for (const [method, args] of [
    ['projectNotes.get', ['project_alpha']],
    ['projectNotes.save', ['project_alpha', 'x', 0]],
    ['projectNotes.undo', ['project_alpha', 'e']],
    ['projectNotes.lease', ['project_alpha', true]],
  ]) {
    assert.deepEqual(await invoke(handlers, method, ...args), { ok: false, reason: 'unavailable' }, method);
  }
});
