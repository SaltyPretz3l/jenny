'use strict';

// llamaServer.listLocalGgufs lists one model file once (dogfood TR-001,
// 2026-09-27): a library-root folder entry and a persisted per-model entry for
// the SAME file under different tags collapse to the persisted entry, which
// carries the per-model settings (its llama-server build). Discovery sources
// are covered in tests/llama-server-ipc-handlers-discovery.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getBridgeChannel } = require('../services/ipc-contract');
const { registerLlamaServerIpcHandlers } = require('../services/main/llama-server-ipc-handlers');

function createFakeIpcMain() {
  const invoke = new Map();
  return {
    handle(channel, handler) {
      invoke.set(channel, handler);
    },
    on() {},
    invoke,
  };
}

const listChannel = getBridgeChannel('llamaServer.listLocalGgufs', 'invoke');

test('listLocalGgufs lists a library file once when a persisted tag names the same file (TR-001)', async (t) => {
  // The dogfood layout: <library>/ternary-bonsai-2-27b/Ternary-...gguf scanned
  // under its folder name, and the same file persisted under the picked tag
  // that carries the per-model llama-server build. One entry, the persisted.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-same-file-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, 'gguf');
  const modelDir = path.join(libraryRoot, 'ternary-bonsai-2-27b');
  const otherDir = path.join(libraryRoot, 'qwen-9b');
  fs.mkdirSync(modelDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  const modelPath = path.join(modelDir, 'Ternary-Bonsai-2-27B-PQ2_0.gguf');
  fs.writeFileSync(modelPath, 'bonsai');
  fs.writeFileSync(path.join(otherDir, 'qwen.gguf'), 'qwen');

  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: path.join(root, 'user-data'),
    repoRoot: path.join(root, 'repo'),
    getLibraryRoots: () => [libraryRoot],
    getPersistedModels: () => [{ tag: 'ternary-bonsai-2-27b-pq2_0', modelPath }],
  });
  const result = await ipc.invoke.get(listChannel)();

  assert.deepEqual(
    result.entries.map(({ tag, dir, mainGguf, source }) => ({ tag, dir, mainGguf, source })),
    [
      { tag: 'qwen-9b', dir: otherDir, mainGguf: 'qwen.gguf', source: 'root' },
      {
        tag: 'ternary-bonsai-2-27b-pq2_0',
        dir: modelDir,
        mainGguf: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
        source: 'persisted',
      },
    ]
  );
});
