'use strict';

const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');

const { UNINSTALL_CHANNELS } = require('../services/data-lifecycle/uninstall-contract');

test('uninstall preload exposes only the narrow lifecycle bridge and disposes listeners', async () => {
  const captured = { api: null, invokes: [], listeners: [] };
  const originalLoad = Module._load;
  const resolved = require.resolve('../uninstall-preload');
  delete require.cache[resolved];
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return {
        contextBridge: { exposeInMainWorld: (name, api) => { captured.api = { name, api }; } },
        ipcRenderer: {
          invoke: async (channel, ...args) => { captured.invokes.push([channel, args]); return { ok: true }; },
          on: (channel, listener) => captured.listeners.push([channel, listener]),
          removeListener: (channel, listener) => captured.listeners.push([channel, listener, 'removed']),
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require(resolved);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }

  assert.equal(captured.api.name, 'jennyUninstall');
  assert.deepEqual(Object.keys(captured.api.api).sort(), [
    'cancel', 'chooseArchiveDestination', 'complete', 'createArchive',
    'getOverview', 'onProgress', 'prepareRemoval', 'previewWorkspaceArchive',
  ]);
  await captured.api.api.previewWorkspaceArchive();
  assert.deepEqual(captured.invokes[0], [UNINSTALL_CHANNELS.previewWorkspaceArchive, []]);
  await captured.api.api.prepareRemoval({ choice: 'app_only' });
  assert.deepEqual(captured.invokes[1], [UNINSTALL_CHANNELS.prepareRemoval, [{ choice: 'app_only' }]]);
  const dispose = captured.api.api.onProgress(() => {});
  dispose();
  assert.equal(captured.listeners[0][0], UNINSTALL_CHANNELS.progress);
  assert.equal(captured.listeners[1][2], 'removed');
});
