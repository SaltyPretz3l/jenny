'use strict';

// llamaServer.listLocalGgufs over a GGUF library folder that holds several quants
// (services/main/llama-server-ipc-handlers.js). Split from
// tests/llama-server-ipc-handlers-discovery.test.js at its 600-line ceiling.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getBridgeChannel } = require('../services/ipc-contract');
const { registerLlamaServerIpcHandlers } = require('../services/main/llama-server-ipc-handlers');

function createFakeIpcMain() {
  const invoke = new Map();
  const send = new Map();
  return {
    handle(channel, handler) {
      invoke.set(channel, handler);
    },
    on(channel, handler) {
      send.set(channel, handler);
    },
    invoke,
    send,
  };
}

const invokeChannel = (methodPath) => getBridgeChannel(methodPath, 'invoke');

// Gate 2026-10-14 F7: a library folder holding two quants listed only one.
test('listLocalGgufs lists every quant in a library folder, each with the folder drafter and projector', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-library-quants-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'library');
  const modelDir = path.join(libraryRoot, 'q');
  fs.mkdirSync(modelDir, { recursive: true });
  for (const name of ['A-Q6_K.gguf', 'A-Q4_K_XL.gguf', 'mtp-A-Q4_0.gguf', 'mmproj-F16.gguf']) {
    fs.writeFileSync(path.join(modelDir, name), 'model');
  }
  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getLibraryRoots: () => [libraryRoot],
  });
  const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

  const quants = result.entries.filter((entry) => entry.dir === modelDir);
  assert.deepEqual(quants.map((entry) => [entry.tag, entry.mainGguf]).sort(),
    [['A-Q4_K_XL', 'A-Q4_K_XL.gguf'], ['A-Q6_K', 'A-Q6_K.gguf']]);
  for (const entry of quants) {
    assert.equal(entry.drafterGguf, 'mtp-A-Q4_0.gguf');
    assert.equal(entry.mmproj, true);
  }
});
