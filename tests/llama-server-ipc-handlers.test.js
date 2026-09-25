'use strict';

// llamaServer.* IPC handlers (services/main/llama-server-ipc-handlers.js):
// fail-soft manager passthrough, launch-spec sanitizing, local GGUF discovery
// with the aux-file filter, and the native .gguf picker.

const { describe, test } = require('node:test');
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

describe('registerLlamaServerIpcHandlers', () => {
  test('registers nothing when getManager is missing', () => {
    const ipc = createFakeIpcMain();
    assert.deepEqual(registerLlamaServerIpcHandlers(ipc), []);
    assert.equal(ipc.invoke.size, 0);
  });

  test('getStatus fails soft when the manager is unavailable', async () => {
    const ipc = createFakeIpcMain();
    const logs = [];
    registerLlamaServerIpcHandlers(ipc, {
      getManager: () => null,
      log: (...args) => logs.push(args),
    });
    const result = await ipc.invoke.get(invokeChannel('llamaServer.getStatus'))();
    assert.deepEqual(result, { ok: false, reason: 'manager_unavailable', state: 'stopped' });
    assert.deepEqual(logs, [[
      'WARN', 'llama.server.ipc_get_status', { ok: false, reason: 'manager_unavailable' },
    ]]);
  });

  test('start passes only normalized launch keys to the manager', async () => {
    // Absolute on every platform: a drive-rooted literal is relative on POSIX
    // and normalizeSpec drops it there.
    const modelPath = path.resolve('models', 'gemma.gguf');
    const ipc = createFakeIpcMain();
    const starts = [];
    const manager = {
      getStatus: () => ({ state: 'ready' }),
      start: async (spec) => {
        starts.push(spec);
        return { state: 'ready', alias: 'gemma4-12b-qat' };
      },
    };
    registerLlamaServerIpcHandlers(ipc, { getManager: () => manager });
    const result = await ipc.invoke.get(invokeChannel('llamaServer.start'))({}, {
      modelTag: '  gemma4-12b-qat  ',
      modelPath: `  ${modelPath}  `,
      profileId: '  local-profile  ',
      mtp: { mode: '  mtp  ', draftNMax: '4', extra: 'drop-me' },
      extraArgs: ['--unsafe'],
      apiKey: 'drop-me',
    });
    assert.deepEqual(starts, [{
      modelTag: 'gemma4-12b-qat',
      modelPath,
      profileId: 'local-profile',
      mtp: { mode: 'mtp', draftNMax: 4 },
    }]);
    assert.deepEqual(result, { ok: true, state: 'ready', alias: 'gemma4-12b-qat' });
  });

  test('a launch that resolves without reaching ready reports ok:false with the manager error', async () => {
    const ipc = createFakeIpcMain();
    const manager = {
      getStatus: () => ({ state: 'stopped' }),
      start: async () => ({ state: 'stopped', lastError: 'llama_server_binary_not_found' }),
      restart: async () => ({ state: 'stopped', lastError: '' }),
    };
    const logs = [];
    registerLlamaServerIpcHandlers(ipc, { getManager: () => manager, log: (...entry) => logs.push(entry) });
    const started = await ipc.invoke.get(invokeChannel('llamaServer.start'))({}, {});
    assert.deepEqual(started, {
      ok: false, reason: 'llama_server_binary_not_found', state: 'stopped', lastError: 'llama_server_binary_not_found',
    });
    assert.deepEqual(logs.at(-1), ['WARN', 'llama.server.ipc_start', { ok: false, reason: 'llama_server_binary_not_found' }]);
    const restarted = await ipc.invoke.get(invokeChannel('llamaServer.restart'))({}, {});
    assert.deepEqual(restarted, { ok: false, state: 'stopped', lastError: '' });
  });

  test('a throwing manager returns its status and never rejects', async () => {
    const ipc = createFakeIpcMain();
    const manager = {
      getStatus: () => ({ state: 'crashed', lastError: 'launch failed' }),
      start: async () => { throw new Error('launch failed'); },
    };
    registerLlamaServerIpcHandlers(ipc, { getManager: () => manager });
    let result;
    await assert.doesNotReject(async () => {
      result = await ipc.invoke.get(invokeChannel('llamaServer.start'))({}, {});
    });
    assert.deepEqual(result, {
      ok: false,
      reason: 'launch failed',
      state: 'crashed',
      lastError: 'launch failed',
    });
  });

  test('listLocalGgufs classifies main and auxiliary files without recursing', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-ipc-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userDataPath = path.join(root, 'user-data');
    const repoRoot = path.join(root, 'repo');
    const modelDir = path.join(userDataPath, 'models', 'gemma4-12b-qat');
    const auxDir = path.join(repoRoot, '.jenny', 'models', 'aux-only');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.mkdirSync(auxDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'mtp-x.gguf'), 'draft');
    fs.writeFileSync(path.join(modelDir, 'mmproj.gguf'), 'projector');
    fs.writeFileSync(path.join(modelDir, 'Z-main.gguf'), 'main');
    fs.writeFileSync(path.join(auxDir, 'mtp-only.gguf'), 'draft');
    fs.writeFileSync(path.join(auxDir, 'mmproj.gguf'), 'projector');

    const ipc = createFakeIpcMain();
    registerLlamaServerIpcHandlers(ipc, { getManager: () => null, userDataPath, repoRoot });
    const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();
    assert.equal(result.ok, true);
    assert.deepEqual(result.entries.map((entry) => entry.tag), ['aux-only', 'gemma4-12b-qat']);
    assert.deepEqual(result.entries.find((entry) => entry.tag === 'gemma4-12b-qat'), {
      tag: 'gemma4-12b-qat',
      dir: modelDir,
      mainGguf: 'Z-main.gguf',
      drafterGguf: 'mtp-x.gguf',
      mmproj: true,
      sizeBytes: 4,
      source: 'root',
    });
    assert.equal(result.entries.find((entry) => entry.tag === 'aux-only').mainGguf, '');
  });

  test('listLocalGgufs lists a Bonsai-style folder as one vision model and never the projector', async (t) => {
    // PrismML names its projector infix-style (<model>-mmproj-<quant>). The
    // projector must set mmproj:true and never enter the main-model size index,
    // or a same-size Ollama blob would be re-homed onto it as the model.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-ipc-bonsai-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userDataPath = path.join(root, 'user-data');
    const modelDir = path.join(userDataPath, 'models', 'ternary-bonsai-2-27b');
    const blobPath = path.join(root, 'ollama', 'sha256-proj');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.mkdirSync(path.dirname(blobPath), { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'Ternary-Bonsai-2-27B-PQ2_0.gguf'), 'model-bytes');
    fs.writeFileSync(path.join(modelDir, 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf'), 'proj');
    fs.writeFileSync(blobPath, 'blob');

    const ipc = createFakeIpcMain();
    registerLlamaServerIpcHandlers(ipc, {
      getManager: () => null,
      userDataPath,
      repoRoot: path.join(root, 'repo'),
      getOllamaTags: async () => ['bonsai:vision'],
      getOllamaBlob: async () => ({ blobPath, mmprojPath: '' }),
    });
    const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

    assert.equal(result.ok, true);
    assert.deepEqual(result.entries, [
      {
        tag: 'bonsai:vision',
        dir: path.dirname(blobPath),
        mainGguf: 'sha256-proj',
        drafterGguf: '',
        mmproj: false,
        sizeBytes: 4,
        source: 'ollama',
      },
      {
        tag: 'ternary-bonsai-2-27b',
        dir: modelDir,
        mainGguf: 'Ternary-Bonsai-2-27B-PQ2_0.gguf',
        drafterGguf: '',
        mmproj: true,
        sizeBytes: 11,
        source: 'root',
      },
    ]);
  });

  test('listLocalGgufs reports mmproj per model, exactly as the launch pairs it [F2]', async (t) => {
    // One flat folder holds a text model and the Bonsai pair: only Bonsai is vision.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-ipc-flat-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const flat = path.join(root, 'llmmodels');
    fs.mkdirSync(flat, { recursive: true });
    for (const name of ['Qwen3-8B-Q4_K_M.gguf', 'Ternary-Bonsai-2-27B-PQ2_0.gguf', 'Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf']) {
      fs.writeFileSync(path.join(flat, name), 'x');
    }

    const ipc = createFakeIpcMain();
    registerLlamaServerIpcHandlers(ipc, {
      getManager: () => null,
      userDataPath: path.join(root, 'user-data'),
      repoRoot: path.join(root, 'repo'),
      getPersistedModels: () => [
        { tag: 'qwen3:8b', modelPath: path.join(flat, 'Qwen3-8B-Q4_K_M.gguf') },
        { tag: 'ternary-bonsai-2-27b', modelPath: path.join(flat, 'Ternary-Bonsai-2-27B-PQ2_0.gguf') },
      ],
    });
    const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

    assert.deepEqual(result.entries.map(({ tag, mainGguf, mmproj }) => ({ tag, mainGguf, mmproj })), [
      { tag: 'qwen3:8b', mainGguf: 'Qwen3-8B-Q4_K_M.gguf', mmproj: false },
      { tag: 'ternary-bonsai-2-27b', mainGguf: 'Ternary-Bonsai-2-27B-PQ2_0.gguf', mmproj: true },
    ]);
  });

  test('listLocalGgufs sizes a split model by its whole set, not its first shard', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-ipc-shards-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'glm');
    fs.mkdirSync(dir, { recursive: true });
    // A second set and a plain quant in the same folder keep their own sizes.
    const sizes = {
      'GLM-4.6-UD-Q2_K_XL-00001-of-00003.gguf': 10, 'GLM-4.6-UD-Q2_K_XL-00002-of-00003.gguf': 20,
      'GLM-4.6-UD-Q2_K_XL-00003-of-00003.gguf': 30, 'GLM-4.6-Q8_0-00001-of-00002.gguf': 7,
      'GLM-4.6-Q8_0-00002-of-00002.gguf': 9, 'GLM-4.6-Q4_K_M.gguf': 5,
    };
    for (const [name, size] of Object.entries(sizes)) fs.writeFileSync(path.join(dir, name), Buffer.alloc(size));

    const ipc = createFakeIpcMain();
    registerLlamaServerIpcHandlers(ipc, {
      getManager: () => null,
      userDataPath: path.join(root, 'user-data'),
      repoRoot: path.join(root, 'repo'),
      getPersistedModels: () => [
        { tag: 'glm-4.6-ud-q2_k_xl', modelPath: path.join(dir, 'GLM-4.6-UD-Q2_K_XL-00001-of-00003.gguf') },
        { tag: 'glm-4.6-q8_0', modelPath: path.join(dir, 'GLM-4.6-Q8_0-00001-of-00002.gguf') },
        { tag: 'glm-4.6-q4_k_m', modelPath: path.join(dir, 'GLM-4.6-Q4_K_M.gguf') },
      ],
    });
    const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

    assert.deepEqual(result.entries.map(({ tag, sizeBytes }) => ({ tag, sizeBytes })), [
      { tag: 'glm-4.6-q4_k_m', sizeBytes: 5 },
      { tag: 'glm-4.6-q8_0', sizeBytes: 16 },
      { tag: 'glm-4.6-ud-q2_k_xl', sizeBytes: 60 },
    ]);
  });

  test('listLocalGgufs shows each quant of a one-model snapshot as vision [R1]', async (t) => {
    // unsloth's layout: several quants of one model beside generic projectors.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-ipc-snapshot-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const userDataPath = path.join(root, 'user-data');
    const modelDir = path.join(userDataPath, 'models', 'gemma-3-4b-it');
    fs.mkdirSync(modelDir, { recursive: true });
    for (const name of ['gemma-3-4b-it-BF16.gguf', 'gemma-3-4b-it-Q4_K_M.gguf', 'mmproj-BF16.gguf', 'mmproj-F16.gguf']) {
      fs.writeFileSync(path.join(modelDir, name), 'x');
    }

    const ipc = createFakeIpcMain();
    registerLlamaServerIpcHandlers(ipc, {
      getManager: () => null,
      userDataPath,
      repoRoot: path.join(root, 'repo'),
      // The Q4_K_M quant, added from the library under its own tag.
      getPersistedModels: () => [{ tag: 'unsloth-q4', modelPath: path.join(modelDir, 'gemma-3-4b-it-Q4_K_M.gguf') }],
    });
    const result = await ipc.invoke.get(invokeChannel('llamaServer.listLocalGgufs'))();

    assert.deepEqual(result.entries.map(({ tag, mainGguf, mmproj }) => ({ tag, mainGguf, mmproj })), [
      { tag: 'gemma-3-4b-it', mainGguf: 'gemma-3-4b-it-BF16.gguf', mmproj: true },
      { tag: 'unsloth-q4', mainGguf: 'gemma-3-4b-it-Q4_K_M.gguf', mmproj: true },
    ]);
  });

  test('chooseGguf handles cancel, invalid picks, and a valid drafter sibling', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-picker-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const modelPath = path.join(root, 'model.GGUF');
    fs.writeFileSync(modelPath, 'main');
    fs.writeFileSync(path.join(root, 'mtp-z.gguf'), 'draft');
    fs.writeFileSync(path.join(root, 'mtp-a.gguf'), 'draft');
    let pickerResult = { canceled: true, filePaths: [] };
    const calls = [];
    const ipc = createFakeIpcMain();
    registerLlamaServerIpcHandlers(ipc, {
      getManager: () => null,
      getMainWindow: () => 'main-window',
      dialogImpl: {
        showOpenDialog: async (...args) => {
          calls.push(args);
          return pickerResult;
        },
      },
    });
    const choose = ipc.invoke.get(invokeChannel('llamaServer.chooseGguf'));
    assert.deepEqual(await choose(), { ok: true, picked: false, path: '' });
    pickerResult = { canceled: false, filePaths: [path.join(root, 'notes.txt')] };
    assert.deepEqual(await choose(), { ok: false, reason: 'not_gguf' });
    pickerResult = { canceled: false, filePaths: [modelPath] };
    assert.deepEqual(await choose(), {
      ok: true,
      picked: true,
      path: modelPath,
      dir: root,
      drafterGguf: 'mtp-a.gguf',
    });
    assert.deepEqual(calls[0], ['main-window', {
      title: 'Select a GGUF model',
      properties: ['openFile'],
      filters: [{ name: 'GGUF models', extensions: ['gguf'] }],
    }]);
  });

  test('chooseGguf forwards an existing absolute directory as the dialog defaultPath', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-picker-default-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    let options = null;
    const ipc = createFakeIpcMain();
    registerLlamaServerIpcHandlers(ipc, {
      getManager: () => null,
      dialogImpl: {
        showOpenDialog: async (_window, dialogOptions) => {
          options = dialogOptions;
          return { canceled: true, filePaths: [] };
        },
      },
    });

    await ipc.invoke.get(invokeChannel('llamaServer.chooseGguf'))({}, { defaultPath: root });

    assert.equal(options.defaultPath, root);
  });

  test('chooseGguf omits relative and non-existent default paths from dialog options', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-picker-missing-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const options = [];
    const ipc = createFakeIpcMain();
    registerLlamaServerIpcHandlers(ipc, {
      getManager: () => null,
      dialogImpl: {
        showOpenDialog: async (_window, dialogOptions) => {
          options.push(dialogOptions);
          return { canceled: true, filePaths: [] };
        },
      },
    });
    const choose = ipc.invoke.get(invokeChannel('llamaServer.chooseGguf'));

    await choose({}, { defaultPath: 'relative-models' });
    await choose({}, { defaultPath: path.join(root, 'missing') });

    assert.equal(Object.hasOwn(options[0], 'defaultPath'), false);
    assert.equal(Object.hasOwn(options[1], 'defaultPath'), false);
  });

  test('chooseGguf logs whether a file was picked without logging its path', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-llama-picker-log-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const modelPath = path.join(root, 'model.gguf');
    fs.writeFileSync(modelPath, 'main');
    let pickerResult = { canceled: true, filePaths: [] };
    const logs = [];
    const ipc = createFakeIpcMain();
    registerLlamaServerIpcHandlers(ipc, {
      getManager: () => null,
      dialogImpl: { showOpenDialog: async () => pickerResult },
      log: (...args) => logs.push(args),
    });
    const choose = ipc.invoke.get(invokeChannel('llamaServer.chooseGguf'));

    await choose();
    pickerResult = { canceled: false, filePaths: [modelPath] };
    await choose();

    assert.deepEqual(logs, [
      ['INFO', 'llama.server.ipc_choose_gguf', { ok: true, picked: false }],
      ['INFO', 'llama.server.ipc_choose_gguf', { ok: true, picked: true }],
    ]);
  });
});
