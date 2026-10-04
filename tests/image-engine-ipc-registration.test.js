'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { getBridgeChannel, listBridgeMethodPaths } = require('../services/ipc-contract');
const { registerImageEngineIpc } = require('../services/main/image-engine-ipc-registration');
const { registerToolsSettingsIpc } = require('../services/main/tools-settings-ipc-registration');
const modelSets = require('../services/image-model-sets');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

const methods = ['getState', 'install', 'cancelInstall', 'remove', 'chooseRuntime',
  'clearRuntime', 'chooseModelFolder', 'scanModels', 'saveModelSet', 'listModelSets',
  'removeModelSet', 'setDefaultModelSet', 'reconcile'];
const payloadless = ['getState', 'cancelInstall', 'chooseRuntime', 'clearRuntime',
  'chooseModelFolder', 'listModelSets', 'reconcile'];
const validSet = { root: 'Z:\\models', diffusion: 'diffusion.bin', text_encoder: 'encoder.bin',
  vae: 'vae.bin', family: 'test_family', label: 'Test set' };

function fixture({ models = {}, platform = 'win32', tools = false } = {}) {
  const calls = [];
  const authorizations = [];
  const handlers = new Map();
  const engine = Object.fromEntries(['install', 'cancel', 'remove', 'setCustomExecutable',
    'clearCustomExecutable'].map((method) => [method, (...args) => {
    calls.push([method, ...args]); return { ok: true };
  }]));
  engine.getState = () => ({ status: 'installed' });
  const backendService = { imageEngine: engine, chatGpuHandoff: {
    getState: () => ({ active: false, retained: false, closing: false }),
    launchRefusal: () => '',
    reconcile: () => { calls.push(['reconcile']); return { confirmed: true }; },
  }, commandSandbox: {}, pdfAddon: {} };
  const window = {};
  let pick = { canceled: false, filePaths: ['Z:\\engine\\sd-cli.exe'] };
  const userDataPath = createTrackedTempDir('jenny-image-ipc-');
  const options = { backendService, platform, userDataPath, getMainWindow: () => window,
    authorization: { authorize: (event, metadata) => {
      authorizations.push(metadata); return event.trusted === true;
    } },
    dialogImpl: { showOpenDialog: async (...args) => { calls.push(['dialog', ...args]); return pick; } },
  };
  const fakeModels = Object.fromEntries(['scanModelFolder', 'saveModelSet', 'listModelSets',
    'removeModelSet', 'setDefaultModelSet', 'loadFamilies'].map((name) => [name, (...args) => {
    calls.push([name, ...args]);
    if (models[name]) return models[name](...args);
    if (name === 'listModelSets') return { sets: [{ id: 'abcdef012345' }], default_id: 'abcdef012345' };
    if (name === 'loadFamilies') return { families: { test_family: { label: 'Test family' } } };
    return { ok: true };
  }]));
  const modelPath = require.resolve('../services/image-model-sets');
  const registrationPath = require.resolve('../services/main/image-engine-ipc-registration');
  const toolsPath = require.resolve('../services/main/tools-settings-ipc-registration');
  const originalModels = require.cache[modelPath].exports;
  try {
    require.cache[modelPath].exports = fakeModels;
    delete require.cache[registrationPath];
    delete require.cache[toolsPath];
    const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) };
    if (tools) require(toolsPath).registerToolsSettingsIpc(ipcMain, { ...options, dialog: options.dialogImpl });
    else require(registrationPath).registerImageEngineIpc(ipcMain, options);
  } finally {
    require.cache[modelPath].exports = originalModels;
    delete require.cache[registrationPath];
    delete require.cache[toolsPath];
  }
  const invoke = (method, payload, trusted = true) => handlers.get(getBridgeChannel(`imageEngine.${method}`))({ trusted }, payload);
  return { calls, authorizations, handlers, engine, backendService, window, userDataPath, dialogImpl: options.dialogImpl,
    setPick: (value) => { pick = value; },
    invoke,
    // Scans and saves are bound to a folder the user picked in the dialog.
    async choose(root) { pick = { canceled: false, filePaths: [root] }; await invoke('chooseModelFolder'); calls.length = 0; },
  };
}

test('all image invokes are registered and denied through the trusted-sender authorizer', async () => {
  assert.equal(typeof registerImageEngineIpc, 'function');
  assert.equal(typeof registerToolsSettingsIpc, 'function');
  const f = fixture();
  assert.deepEqual(listBridgeMethodPaths({ kind: 'invoke' }).filter((name) => name.startsWith('imageEngine.')),
    methods.map((name) => `imageEngine.${name}`).sort());
  assert.equal(f.handlers.size, methods.length);
  for (const method of methods) {
    const channel = getBridgeChannel(`imageEngine.${method}`);
    assert.ok(f.handlers.has(channel));
    assert.deepEqual(await f.invoke(method, undefined, false), {
      ok: false, authorized: false, code: 'ipc_sender_unauthorized',
    });
    assert.deepEqual(f.authorizations.at(-1), { methodPath: `imageEngine.${method}`, channel });
  }
  assert.deepEqual(f.calls, []);
  assert.equal(getBridgeChannel('imageEngine.onChanged', 'subscribe'), 'image-engine:changed');
});

test('payloadless methods reject all supplied payloads', async () => {
  const f = fixture();
  for (const method of payloadless) {
    for (const payload of [{}, null, false]) {
      assert.deepEqual(await f.invoke(method, payload), { ok: false, reason: 'unexpected_payload' });
    }
  }
  assert.deepEqual(f.calls, []);
});

test('install and remove forward only confirmed and preserve opt-in failures', async () => {
  const f = fixture();
  for (const method of ['install', 'remove']) {
    await f.invoke(method, { confirmed: true, root: '\\\\server\\share', other: true });
    assert.deepEqual(f.calls.at(-1), [method, { confirmed: true }]);
    await f.invoke(method);
    assert.deepEqual(f.calls.at(-1), [method, { confirmed: undefined }]);
    f.engine[method] = () => ({ ok: false, reason: 'opt_in_required' });
    assert.deepEqual(await f.invoke(method, { confirmed: false }), { ok: false, reason: 'opt_in_required' });
  }
});

test('main-owned dialogs reject network, device and relative picks before services or filesystem reads', async () => {
  const f = fixture();
  for (const method of ['chooseRuntime', 'chooseModelFolder']) {
    for (const picked of ['\\\\server\\share\\sd-cli.exe', '\\\\?\\C:\\x', '\\\\.\\C:\\x', 'relative']) {
      f.setPick({ canceled: false, filePaths: [picked] });
      const before = f.calls.length;
      assert.deepEqual(await f.invoke(method), { ok: false, reason: 'image_engine_path_rejected' });
      assert.deepEqual(f.calls.slice(before).map(([name]) => name), ['dialog']);
    }
    f.setPick({ canceled: true, filePaths: [] });
    assert.deepEqual(await f.invoke(method), { ok: false, reason: 'cancelled' });
  }
});

test('dialogs use the supplied owner and platform filters, then forward local mapped-drive picks', async () => {
  for (const platform of ['win32', 'linux']) {
    const f = fixture({ platform });
    const picked = platform === 'win32' ? 'Z:\\engine\\sd-cli.exe' : '/opt/engine/sd-cli';
    f.setPick({ canceled: false, filePaths: [picked] });
    await f.invoke('chooseRuntime');
    assert.deepEqual(f.calls, [['dialog', f.window, { properties: ['openFile'],
      filters: [{ name: 'sd-cli', extensions: platform === 'win32' ? ['exe'] : ['*'] }] }],
    ['setCustomExecutable', picked]]);
    f.calls.length = 0;
    await f.invoke('chooseModelFolder');
    assert.deepEqual(f.calls, [['dialog', f.window, { properties: ['openDirectory'] }], ['scanModelFolder', picked]]);
  }
});

test('scan validates root type, size and locality before the model service', async () => {
  const f = fixture();
  for (const root of ['relative', '\\\\server\\share', '\\\\?\\C:\\x']) {
    assert.deepEqual(await f.invoke('scanModels', { root }), { ok: false, reason: 'image_engine_path_rejected' });
  }
  for (const payload of [undefined, null, { root: 123 }, { root: 'x'.repeat(1025) }]) {
    assert.deepEqual(await f.invoke('scanModels', payload), { ok: false, reason: 'invalid_payload' });
  }
  assert.deepEqual(f.calls, []);
  await f.choose(validSet.root);
  await f.invoke('scanModels', { root: validSet.root, ignored: true });
  assert.deepEqual(f.calls, [['scanModelFolder', validSet.root]]);
});

test('a local root the user never picked is refused unless a saved set already lives there', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke('scanModels', { root: 'Z:\\somewhere' }), { ok: false, reason: 'image_engine_root_not_chosen' });
  assert.deepEqual(await f.invoke('saveModelSet', { ...validSet, root: 'Z:\\somewhere' }), { ok: false, reason: 'image_engine_root_not_chosen' });
  assert.equal(f.calls.some(([name]) => name === 'scanModelFolder' || name === 'saveModelSet'), false);
  const saved = fixture({ models: { listModelSets: () => ({ sets: [{ id: 'abcdef012345', root: 'Z:\\saved' }], default_id: 'abcdef012345' }) } });
  await saved.invoke('scanModels', { root: 'Z:\\saved' });
  assert.deepEqual(saved.calls.at(-1), ['scanModelFolder', 'Z:\\saved']);
});

test('install and remove are refused while an image handoff holds the GPU', async () => {
  const f = fixture();
  f.backendService.chatGpuHandoff.getState = () => ({ active: true, retained: false });
  for (const method of ['install', 'remove']) {
    assert.deepEqual(await f.invoke(method, { confirmed: true }), { ok: false, reason: 'image_engine_busy' });
  }
  assert.deepEqual(f.calls, []);
});

test('install and remove are refused for retained, closing and restoring handoff states with zero service calls', async () => {
  const states = {
    retained: { handoff: { active: false, retained: true, closing: false }, refusal: 'gpu_lease_held' },
    closing: { handoff: { active: false, retained: false, closing: true }, refusal: 'runtime_closing' },
    restoring: { handoff: { active: false, retained: false, closing: false }, refusal: 'gpu_lease_held' },
    // A handoff fake without launchRefusal is still fenced by getState alone.
    retainedWithoutRefusal: { handoff: { active: false, retained: true, closing: false }, refusal: null },
    closingWithoutRefusal: { handoff: { active: false, retained: false, closing: true }, refusal: null },
  };
  for (const [name, { handoff, refusal }] of Object.entries(states)) {
    const f = fixture();
    f.backendService.chatGpuHandoff.getState = () => handoff;
    if (refusal === null) delete f.backendService.chatGpuHandoff.launchRefusal;
    else f.backendService.chatGpuHandoff.launchRefusal = () => refusal;
    for (const method of ['install', 'remove']) {
      assert.deepEqual(await f.invoke(method, { confirmed: true }), { ok: false, reason: 'image_engine_busy' }, `${name} ${method}`);
    }
    assert.deepEqual(f.calls, [], name);
  }
  const idle = fixture();
  idle.backendService.chatGpuHandoff.launchRefusal = () => '';
  for (const method of ['install', 'remove']) {
    assert.deepEqual(await idle.invoke(method, { confirmed: true }), { ok: true });
  }
  assert.deepEqual(idle.calls, [['install', { confirmed: true }], ['remove', { confirmed: true }]]);
});

test('save validates all fields, drops unknown keys and routes the main-owned store path', async () => {
  const f = fixture();
  await f.choose(validSet.root);
  for (const key of Object.keys(validSet)) {
    for (const value of [null, 123, 'x'.repeat(key === 'label' ? 121 : 1025)]) {
      assert.deepEqual(await f.invoke('saveModelSet', { ...validSet, [key]: value }), {
        ok: false, reason: 'invalid_payload',
      });
    }
  }
  assert.deepEqual(await f.invoke('saveModelSet', { ...validSet, root: '\\\\server\\share' }), {
    ok: false, reason: 'image_engine_path_rejected',
  });
  assert.deepEqual(f.calls, []);
  await f.invoke('saveModelSet', { ...validSet, storePath: 'untrusted', other: true });
  assert.deepEqual(f.calls, [['saveModelSet', { storePath: path.join(f.userDataPath, 'image-models.json'), ...validSet }]]);
});

test('model-set ids are validated, and removal and default use the owned store', async () => {
  const f = fixture();
  for (const method of ['removeModelSet', 'setDefaultModelSet']) {
    for (const id of ['malformed', 'ABCDEF012345', 'abcdef0123456', null, 123]) {
      assert.deepEqual(await f.invoke(method, { id }), { ok: false, reason: 'invalid_payload' });
    }
    await f.invoke(method, { id: 'abcdef012345', storePath: 'untrusted' });
    assert.deepEqual(f.calls.at(-1), [method, 'abcdef012345', { storePath: path.join(f.userDataPath, 'image-models.json') }]);
  }
});

test('state merges engine, handoff, model sets and family labels in one call', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke('getState'), { ok: true, status: 'installed', handoff: { active: false, retained: false, closing: false },
    model_sets: { sets: [{ id: 'abcdef012345' }], default_id: 'abcdef012345' },
    families: { test_family: { label: 'Test family' } },
  });
  delete f.backendService.chatGpuHandoff;
  assert.equal((await f.invoke('getState')).handoff, null);
  await f.invoke('listModelSets');
  assert.deepEqual(f.calls.at(-1), ['listModelSets', { storePath: path.join(f.userDataPath, 'image-models.json') }]);
});

test('cancel, clear and reconcile reach their owning services', async () => {
  const f = fixture();
  await f.invoke('cancelInstall');
  await f.invoke('clearRuntime');
  assert.deepEqual(await f.invoke('reconcile'), { ok: true, confirmed: true });
  assert.deepEqual(f.calls, [['cancel'], ['clearCustomExecutable'], ['reconcile']]);
});

test('service and dialog exceptions never reject or leak invalid reasons', async () => {
  const f = fixture();
  for (const reason of ['engine_failed', 'C:\\private\\runtime', 'x'.repeat(101), undefined]) {
    f.engine.cancel = () => { throw Object.assign(new Error('private detail'), { reason }); };
    assert.deepEqual(await f.invoke('cancelInstall'), { ok: false,
      reason: reason === 'engine_failed' ? reason : 'image_engine_operation_failed' });
  }
  f.engine.getState = () => { throw new Error('state failed'); };
  assert.deepEqual(await f.invoke('getState'), { ok: false, reason: 'image_engine_operation_failed' });
  const throwing = fixture({ models: { scanModelFolder: () => { throw new Error('scan failed'); } } });
  throwing.setPick({ canceled: false, filePaths: [validSet.root] });
  assert.deepEqual(await throwing.invoke('chooseModelFolder'), { ok: false, reason: 'image_engine_operation_failed' });
  assert.deepEqual(await throwing.invoke('scanModels', { root: validSet.root }), {
    ok: false, reason: 'image_engine_operation_failed',
  });
  f.dialogImpl.showOpenDialog = async () => { throw new Error('private dialog detail'); };
  assert.deepEqual(await f.invoke('chooseRuntime'), { ok: false, reason: 'image_engine_operation_failed' });
  f.engine.install = async () => { throw Object.assign(new Error('install failed'), { reason: 'engine_failed' }); };
  assert.deepEqual(await f.invoke('install', { confirmed: true }), { ok: false, reason: 'engine_failed' });
  f.engine.remove = () => ({ ok: false, reason: 'C:\\private\\path' });
  assert.deepEqual(await f.invoke('remove', { confirmed: true }), { ok: false, reason: 'image_engine_operation_failed' });
});

test('tools-settings registration passes userDataPath and the dialog owner to image IPC', async () => {
  const f = fixture({ tools: true, platform: process.platform });
  await f.invoke('listModelSets');
  assert.deepEqual(f.calls.at(-1), ['listModelSets', { storePath: path.join(f.userDataPath, 'image-models.json') }]);
  f.setPick({ canceled: true, filePaths: [] });
  assert.deepEqual(await f.invoke('chooseRuntime'), { ok: false, reason: 'cancelled' });
  assert.equal(f.calls.at(-1)[1], f.window);
});

test('actual model store roundtrip preserves user model files', async () => {
  const f = fixture({ models: modelSets, platform: process.platform });
  const root = path.join(f.userDataPath, 'models');
  fs.mkdirSync(root);
  const files = { diffusion: 'diffusion.safetensors', text_encoder: 'encoder.bin', vae: 'vae.bin' };
  for (const name of Object.values(files)) fs.writeFileSync(path.join(root, name), 'user model');
  const family = Object.keys(modelSets.loadFamilies().families)[0];
  await f.choose(root);
  const saved = await f.invoke('saveModelSet', { root, ...files, family, label: 'Test set' });
  assert.equal(saved.ok, true);
  const id = saved.set.id;
  assert.equal((await f.invoke('listModelSets')).default_id, id);
  assert.equal((await f.invoke('setDefaultModelSet', { id })).ok, true);
  assert.equal((await f.invoke('removeModelSet', { id })).ok, true);
  assert.deepEqual((await f.invoke('listModelSets')).sets, []);
  for (const name of Object.values(files)) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), 'user model');
});
