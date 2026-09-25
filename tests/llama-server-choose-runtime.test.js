'use strict';

// llamaServer.chooseRuntime: the only way a llama-server executable path enters
// main. A main-owned dialog, the name check and the probe must all pass before
// the path is recorded in the manager's pick registry, which is the only list
// engines.updateSettings will save a new runtime path from.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getBridgeChannel } = require('../services/ipc-contract');
const { registerLlamaServerIpcHandlers } = require('../services/main/llama-server-ipc-handlers');
const { createRuntimePickRegistry } = require('../services/main/llama-server-runtime');
const { ShellConfigService } = require('../services/shell-config-service');
const { registerAuxiliaryIpcHandlers } = require('../services/auxiliary-ipc-handlers');
const { cleanupTrackedResources, trackDirectory } = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const CHANNEL = getBridgeChannel('llamaServer.chooseRuntime', 'invoke');
const FORK = 'G:\\llmmodels\\runtimes\\llama-prism-b10683-cuda13.3\\llama-server.exe';
const TRUSTED = { sender: 'main-window' };
const allowMainWindow = {
  authorize: (event) => event === TRUSTED,
  unauthorizedResult: () => ({ ok: false, authorized: false, code: 'ipc_sender_unauthorized' }),
};

function setup({
  manager = { runtimePicks: createRuntimePickRegistry() },
  dialogResult = { canceled: false, filePaths: [FORK] },
  verdict = { ok: true, build: 10683, supportsMtp: true },
  authorization = allowMainWindow,
  platform = 'win32',
  extra = {},
} = {}) {
  const handlers = new Map();
  const dialogCalls = [];
  const validateCalls = [];
  const logs = [];
  registerLlamaServerIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getManager: () => manager,
    getMainWindow: () => 'main-window',
    dialogImpl: {
      showOpenDialog: async (win, options) => {
        dialogCalls.push({ win, options });
        if (dialogResult instanceof Error) throw dialogResult;
        return dialogResult;
      },
    },
    log: (level, event, details) => logs.push({ level, event, details }),
    authorization,
    platform,
    validateRuntimeExecutableImpl: async (candidate, options) => {
      validateCalls.push({ candidate, options });
      return verdict;
    },
    ...extra,
  });
  const choose = (payload, event = TRUSTED) => handlers.get(CHANNEL)(event, payload);
  return { manager, dialogCalls, validateCalls, logs, choose, handlers };
}

test('a validated pick is recorded with the probe\'s build and returned to the drawer', async () => {
  const { manager, dialogCalls, validateCalls, choose } = setup();
  const result = await choose({});
  assert.deepEqual(result, { ok: true, picked: true, path: FORK, build: 10683, supportsMtp: true });
  assert.deepEqual(manager.runtimePicks.get(FORK), { path: FORK, build: 10683, supportsMtp: true });
  assert.equal(validateCalls.length, 1);
  assert.equal(validateCalls[0].candidate, FORK);
  assert.equal(validateCalls[0].options.platform, 'win32');
  assert.equal(dialogCalls[0].win, 'main-window');
  assert.deepEqual(dialogCalls[0].options, {
    title: 'Select a llama-server build',
    properties: ['openFile'],
    filters: [{ name: 'llama-server', extensions: ['exe'] }],
  });
});

test('outside Windows the dialog has no extension filter', async () => {
  const { dialogCalls, choose } = setup({ platform: 'linux' });
  await choose({});
  assert.equal('filters' in dialogCalls[0].options, false);
});

test('cancel records nothing and never validates', async () => {
  const { manager, validateCalls, choose } = setup({ dialogResult: { canceled: true, filePaths: [] } });
  assert.deepEqual(await choose({}), { ok: true, picked: false, path: '' });
  assert.equal(manager.runtimePicks.size(), 0);
  assert.equal(validateCalls.length, 0);
});

test('a refused file returns the validator\'s reason and records nothing', async () => {
  for (const reason of ['not_llama_server', 'runtime_missing', 'runtime_probe_failed']) {
    const { manager, choose } = setup({ verdict: { ok: false, reason } });
    assert.deepEqual(await choose({}), { ok: false, reason });
    assert.equal(manager.runtimePicks.size(), 0, reason);
  }
});

test('no manager fails before any dialog opens', async () => {
  for (const manager of [null, {}]) {
    const { dialogCalls, choose } = setup({ manager });
    assert.deepEqual(await choose({}), { ok: false, reason: 'manager_unavailable' });
    assert.equal(dialogCalls.length, 0);
  }
});

test('only a trusted sender can open the picker, and a missing authorizer trusts no one', async () => {
  const guarded = setup();
  assert.deepEqual(await guarded.choose({}, { sender: 'webview' }),
    { ok: false, authorized: false, code: 'ipc_sender_unauthorized' });
  assert.equal(guarded.dialogCalls.length, 0);

  const unguarded = setup({ authorization: null });
  const result = await unguarded.choose({});
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ipc_sender_unauthorized');
  assert.equal(unguarded.dialogCalls.length, 0);
  assert.equal(unguarded.manager.runtimePicks.size(), 0);
});

test('defaultPath is passed only when it is an existing directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-choose-runtime-'));
  trackDirectory(dir);
  const file = path.join(dir, 'llama-server.exe');
  fs.writeFileSync(file, 'x');
  for (const [defaultPath, expected] of [
    [dir, dir],
    [file, undefined],
    [path.join(dir, 'missing'), undefined],
    ['relative\\dir', undefined],
    [`${dir}\nC:\\`, undefined],
    [42, undefined],
  ]) {
    // Real directories: this host's path rules.
    const { dialogCalls, choose } = setup({ platform: process.platform });
    await choose({ defaultPath });
    assert.equal(dialogCalls[0].options.defaultPath, expected, JSON.stringify(defaultPath));
  }
});

test('a network or device defaultPath is never touched or passed, for either picker', async () => {
  // Never the real fs: stat on a UNC path would reach the named host.
  const touched = [];
  const fsImpl = {
    ...fs,
    statSync(target) {
      touched.push(String(target));
      return { isDirectory: () => true, isFile: () => false };
    },
  };
  const { dialogCalls, choose, handlers } = setup({ extra: { fsImpl } });
  const chooseGguf = handlers.get(getBridgeChannel('llamaServer.chooseGguf', 'invoke'));
  const remote = [
    '\\\\attacker.example\\share',
    '//attacker.example/share',
    '\\\\?\\UNC\\attacker.example\\share',
    '\\\\.\\C:\\',
  ];
  for (const defaultPath of remote) {
    await choose({ defaultPath });
    await chooseGguf(TRUSTED, { defaultPath });
  }
  assert.deepEqual(touched, []);
  assert.deepEqual(dialogCalls.map((call) => call.options.defaultPath), remote.flatMap(() => [undefined, undefined]));
});

test('logs carry only ok, picked and reason, never the path, even when the dialog throws', async () => {
  const picked = setup();
  await picked.choose({});
  const refused = setup({ verdict: { ok: false, reason: 'not_llama_server' } });
  await refused.choose({});
  const thrown = setup({ dialogResult: new Error(`EACCES: ${FORK}`) });
  assert.deepEqual(await thrown.choose({}), { ok: false, reason: 'runtime_pick_failed' });
  const logs = [...picked.logs, ...refused.logs, ...thrown.logs];
  assert.deepEqual(logs.map((entry) => [entry.level, entry.event, entry.details]), [
    ['INFO', 'llama.server.ipc_choose_runtime', { ok: true, picked: true }],
    ['WARN', 'llama.server.ipc_choose_runtime', { ok: false, reason: 'not_llama_server' }],
    ['WARN', 'llama.server.ipc_choose_runtime', { ok: false, reason: 'runtime_pick_failed' }],
  ]);
  assert.equal(JSON.stringify(logs).includes('llama-prism'), false);
});

test('a text file named llama-server.exe is refused by the real validator', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-choose-runtime-fake-'));
  trackDirectory(dir);
  const fake = path.join(dir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  fs.writeFileSync(fake, 'not a program');
  const handlers = new Map();
  const manager = { runtimePicks: createRuntimePickRegistry() };
  registerLlamaServerIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    getManager: () => manager,
    dialogImpl: { showOpenDialog: async () => ({ canceled: false, filePaths: [fake] }) },
    authorization: allowMainWindow,
  });
  const result = await handlers.get(CHANNEL)(TRUSTED, {});
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'runtime_probe_failed');
  assert.equal(manager.runtimePicks.size(), 0);
});

test('a pick from the dialog is what engines.updateSettings saves, once', async () => {
  const win32 = process.platform === 'win32';
  const hostFork = win32 ? FORK : '/opt/llama-prism-b10683/llama-server';
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-choose-runtime-e2e-'));
  trackDirectory(userDataPath);
  const service = new ShellConfigService({ userDataPath, env: {} });
  const { manager, choose } = setup({
    dialogResult: { canceled: false, filePaths: [hostFork] },
    platform: process.platform,
  });
  const aux = new Map();
  registerAuxiliaryIpcHandlers({
    ipcMainLike: { handle(channel, handler) { aux.set(channel, handler); } },
    backendService: { options: { getLlamaServerManager: () => manager } },
    shellConfigService: service,
    processRef: { env: { JENNY_ENABLE_LLAMA_SERVER_ACCELERATION: '1' } },
    log: () => {},
  });
  const entry = {
    engine: 'llama-server',
    tag: 'ternary-bonsai-2-27b-pq2_0',
    modelPath: win32
      ? 'G:\\llmmodels\\gguf\\ternary-bonsai-2-27b\\Ternary-Bonsai-2-27B-PQ2_0.gguf'
      : '/models/ternary-bonsai-2-27b/Ternary-Bonsai-2-27B-PQ2_0.gguf',
    mtp: { mode: 'off' },
  };
  const write = (runtimePath) => aux.get('engines:update-settings')({}, {
    managed: { perModel: { 'ternary-bonsai-2-27b-pq2-0': { ...entry, runtimePath } } },
  });
  const saved = () => service.getLocalEngines().openaiCompatible.managed.perModel['ternary-bonsai-2-27b-pq2-0'];

  write(hostFork);
  assert.equal('runtimePath' in saved(), false, 'nothing was picked yet');
  const picked = await choose({});
  write(picked.path);
  assert.equal(saved().runtimePath, hostFork);
  assert.equal(saved().runtimeBuild, 10683);
  assert.equal(manager.runtimePicks.has(hostFork), false, 'the pick is spent');
});
