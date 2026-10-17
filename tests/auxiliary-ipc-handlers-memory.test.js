'use strict';

// The chat chip's Undo bridge (memory v2, row 58 W1): memory.undo carries only
// the session and the operation; the project comes from the session main-side.

const test = require('node:test');
const assert = require('node:assert/strict');

const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');

// Only the memory handlers are exercised; the other services are inert stubs.
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

test('memory undo IPC forwards only the session and operation ids', async () => {
  const calls = [];
  const handlers = registerMinimalHandlers({
    backendService: {
      async undoMemoryOperation(...args) { calls.push(args); return { status: 'saved' }; },
    },
  });
  assert.deepEqual(
    await handlers.get('memory:undo')({}, { sessionId: 'session-1', operationId: 'tool:abc', projectId: 'project_x' }),
    { status: 'saved' },
  );
  await handlers.get('memory:undo')({}, null);
  assert.deepEqual(calls, [['session-1', 'tool:abc'], [undefined, undefined]]);
});

test('Settings memory IPC forwards the revision options and the new ledger channels', async () => {
  const calls = [];
  const handlers = registerMinimalHandlers({
    backendService: {
      async updateApprovedMemory(...args) { calls.push(['update', ...args]); },
      async deleteApprovedMemory(...args) { calls.push(['delete', ...args]); },
      async undoApprovedMemoryChange(...args) { calls.push(['undoChange', ...args]); return { status: 'saved' }; },
      async acceptPendingMemory(...args) { calls.push(['accept', ...args]); return { accepted: true }; },
    },
  });
  const patch = { title: 'Edited' };

  await handlers.get('memory:update')({}, 7, patch, 'project_garden', { expectedRevision: 3 });
  await handlers.get('memory:update')({}, 7, patch, 'project_garden', 'not-an-object');
  await handlers.get('memory:delete')({}, 7, 'project_garden', { expectedRevision: 3 });
  await handlers.get('memory:delete')({}, 7, 'project_garden', [1]);
  assert.deepEqual(await handlers.get('memory:undo-change')({}, 'rpc:abc', 'project_garden'), { status: 'saved' });
  assert.deepEqual(await handlers.get('memory:accept-pending')({}, 'session-1', 'sha256:abc'), { accepted: true });

  assert.deepEqual(calls, [
    ['update', 7, patch, 'project_garden', { expectedRevision: 3 }],
    ['update', 7, patch, 'project_garden', {}],
    ['delete', 7, 'project_garden', { expectedRevision: 3 }],
    ['delete', 7, 'project_garden', {}],
    ['undoChange', 'rpc:abc', 'project_garden'],
    ['accept', 'session-1', 'sha256:abc', undefined],
  ]);
});

test('pending approve and dismiss forward the queued row project; the W4 Settings channels are registered', async () => {
  const calls = [];
  const handlers = registerMinimalHandlers({
    backendService: {
      async acceptPendingMemory(...args) { calls.push(['accept', ...args]); return { accepted: true }; },
      async deletePendingMemory(...args) { calls.push(['delete', ...args]); return { deleted: true }; },
    },
  });
  await handlers.get('memory:accept-pending')({}, 'session-1', 'sha256:abc', 'project_garden');
  await handlers.get('memory:delete-pending')({}, 'session-1', 'sha256:abc', 'project_garden');
  await handlers.get('memory:delete-pending')({}, 'session-1', 'sha256:abc');
  assert.deepEqual(calls, [
    ['accept', 'session-1', 'sha256:abc', 'project_garden'],
    ['delete', 'session-1', 'sha256:abc', 'project_garden'],
    ['delete', 'session-1', 'sha256:abc', undefined],
  ]);
  for (const channel of ['memory:list-archived', 'memory:restore', 'memory:erase', 'memory:clear-forgotten',
    'memory:list-operations', 'memory:set-always-on', 'memory:export-markdown', 'memory:open-context-file']) {
    assert.equal(handlers.has(channel), true, channel);
  }
});
