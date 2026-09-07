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
