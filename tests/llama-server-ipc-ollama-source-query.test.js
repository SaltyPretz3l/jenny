'use strict';

// 2026-09-22 diagnostics: overlapping Model library scans overran the
// sidecar's Ollama blob worker cap, and the refusals were cached as "no blob".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { getBridgeChannel } = require('../services/ipc-contract');
const { registerLlamaServerIpcHandlers } = require('../services/main/llama-server-ipc-handlers');

function createFakeIpcMain() {
  const invoke = new Map();
  return { handle(channel, handler) { invoke.set(channel, handler); }, on() {}, invoke };
}

const invokeChannel = (methodPath) => getBridgeChannel(methodPath, 'invoke');

test('overlapping listLocalGgufs scans share one Ollama blob query', async () => {
  // Two concurrent scans each sent full batches and overran the sidecar's
  // blob worker cap (2026-09-22 diagnostics: 11 refused lookups).
  let active = 0;
  let peak = 0;
  const lookups = [];
  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: '',
    repoRoot: path.join(os.tmpdir(), 'jenny-llama-no-repo'),
    getOllamaTags: async () => Array.from({ length: 6 }, (_unused, index) => `model-${index}:1b`),
    getOllamaBlob: async (tag) => {
      lookups.push(tag);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return null;
    },
  });
  const list = ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'));
  await Promise.all([list(), list()]);

  assert.equal(lookups.length, 6, 'each tag is looked up once across both scans');
  assert.ok(peak <= 4, `at most one batch in flight (peak ${peak})`);
});

test('a refused Ollama blob lookup is retried on the next scan instead of cached', async () => {
  let refuse = true;
  const lookups = [];
  const ipc = createFakeIpcMain();
  registerLlamaServerIpcHandlers(ipc, {
    getManager: () => null,
    userDataPath: '',
    repoRoot: path.join(os.tmpdir(), 'jenny-llama-no-repo'),
    getOllamaTags: async () => ['gemma4:12b'],
    getOllamaBlob: async (tag) => {
      lookups.push(tag);
      if (refuse) throw Object.assign(new Error('too many active models.ollama_blob requests'), { error_code: 'CMP-RUNTIME-0001' });
      return null;
    },
  });
  const list = ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'));
  await list();
  refuse = false;
  await list();
  await list();

  assert.deepEqual(lookups, ['gemma4:12b', 'gemma4:12b'], 'refusal not cached; the clean result is');
});
