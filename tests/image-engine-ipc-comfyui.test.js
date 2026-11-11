'use strict';

// Row 127 S5: ComfyUI folder health in imageEngine.getState and the three ComfyUI image-engine channels,
// run against the real model store and a fake portable folder in a temp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getBridgeChannel } = require('../services/ipc-contract');
const realModels = require('../services/image-model-sets');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');

test.afterEach(cleanupTrackedResources);

const FILES = {
  diffusion: 'diffusion_models/minimax_h3_image_pruned_int8_convrot.safetensors',
  text_encoder: 'text_encoders/qwen3vl_32b_minimax_h3_int8.safetensors',
  vae: 'vae/minimax_h3_image_vae.safetensors',
};
const RECIPE = 'minimax_h3_image';

function fixture({ flags } = {}) {
  const base = createTrackedTempDir('jenny-image-comfy-ipc-');
  const userDataPath = path.join(base, 'userdata');
  fs.mkdirSync(userDataPath);
  const folder = path.join(base, 'ComfyUI_windows_portable');
  const write = (relative, bytes = 'model') => {
    const file = path.join(folder, ...relative.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  };
  write('python_embeded/python.exe', 'py');
  write('ComfyUI/main.py', 'main');
  write('ComfyUI/comfyui_version.py', '__version__ = "0.45.0"\n');
  for (const name of Object.values(FILES)) write(`ComfyUI/models/${name}`);
  const storePath = path.join(userDataPath, 'image-models.json');
  const calls = [];
  const events = [];
  let healthWalks = 0;
  let pick = { canceled: true, filePaths: [] };
  const handlers = new Map();
  const backendService = {
    featureFlags: flags,
    imageEngine: { getState: () => ({ status: 'installed' }), emit: (...args) => { events.push(args); return true; } },
    chatGpuHandoff: { getState: () => ({ active: false }), launchRefusal: () => '' },
  };
  const spied = {
    ...realModels,
    comfyFolderHealth: (...args) => { healthWalks += 1; return realModels.comfyFolderHealth(...args); },
  };
  const modelPath = require.resolve('../services/image-model-sets');
  const registrationPath = require.resolve('../services/main/image-engine-ipc-registration');
  const original = require.cache[modelPath].exports;
  try {
    require.cache[modelPath].exports = spied;
    delete require.cache[registrationPath];
    require(registrationPath).registerImageEngineIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, {
      backendService, platform: process.platform, userDataPath, getMainWindow: () => ({}),
      authorization: { authorize: () => true },
      dialogImpl: { showOpenDialog: async (...args) => { calls.push(['dialog', ...args]); return pick; } },
    });
  } finally {
    require.cache[modelPath].exports = original;
    delete require.cache[registrationPath];
  }
  return {
    base, folder, write, storePath, calls, events, backendService,
    walks: () => healthWalks,
    setPick: (value) => { pick = value; },
    invoke: (method, payload) => handlers.get(getBridgeChannel(`imageEngine.${method}`))({}, payload),
    storeText: () => (fs.existsSync(storePath) ? fs.readFileSync(storePath, 'utf8') : null),
  };
}

const pickFolder = (f) => f.setPick({ canceled: false, filePaths: [f.folder] });

test('getState carries the recipes and ComfyUI health, and walks the models folder once', async () => {
  const f = fixture();
  const first = await f.invoke('getState');
  assert.deepEqual(first.comfyui, { enabled: true, health: null });
  assert.deepEqual(first.recipes, { [RECIPE]: { label: 'MiniMax-H3-Image', min_comfyui_version: '0.45.0', steps: 6 } });
  pickFolder(f);
  assert.equal((await f.invoke('chooseComfyFolder')).ok, true);
  const walksAfterChoose = f.walks();
  const second = await f.invoke('getState');
  const third = await f.invoke('getState');
  assert.equal(f.walks(), walksAfterChoose, 'getState reuses the cached health');
  assert.equal(second.comfyui.health.ok, true);
  assert.equal(second.comfyui.health.folder, fs.realpathSync(f.folder));
  assert.equal(second.comfyui.health.version, '0.45.0');
  assert.deepEqual(third.comfyui, second.comfyui);
  assert.equal(second.comfyui.health.recipes[RECIPE].slots.vae[0].name, FILES.vae);
  assert.equal(second.model_sets.comfyui_folder, fs.realpathSync(f.folder));
});

test('the first getState after start reads a saved folder once, and a changed folder is recomputed', async () => {
  const f = fixture();
  realModels.setComfyFolder({ storePath: f.storePath, folder: f.folder });
  const state = await f.invoke('getState');
  await f.invoke('getState');
  assert.equal(f.walks(), 1);
  assert.equal(state.comfyui.health.ok, true);
  const removed = realModels.setComfyFolder({ storePath: f.storePath, folder: null });
  assert.equal(removed.ok, true);
  assert.deepEqual((await f.invoke('getState')).comfyui, { enabled: true, health: null });
  realModels.setComfyFolder({ storePath: f.storePath, folder: f.folder });
  await f.invoke('getState');
  assert.equal(f.walks(), 3, 'a different stored folder walks again');
});

test('choosing a ComfyUI folder handles cancel, a refused folder and success', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke('chooseComfyFolder'), { ok: false, reason: 'cancelled' });
  assert.deepEqual(f.calls[0].slice(2), [{ properties: ['openDirectory'] }]);
  f.setPick({ canceled: false, filePaths: [path.join(f.base, 'not-a-comfyui-folder')] });
  assert.deepEqual(await f.invoke('chooseComfyFolder'), { ok: false, reason: 'comfyui_folder_invalid' });
  assert.equal(f.storeText(), null, 'a refused folder leaves the store untouched');
  assert.equal(f.events.length, 0);
  f.setPick({ canceled: false, filePaths: ['relative/folder'] });
  assert.deepEqual(await f.invoke('chooseComfyFolder'), { ok: false, reason: 'image_engine_path_rejected' });
  pickFolder(f);
  const chosen = await f.invoke('chooseComfyFolder');
  assert.equal(chosen.ok, true);
  assert.equal(chosen.health.ok, true);
  assert.equal(chosen.health.version, '0.45.0');
  assert.equal(chosen.health.recipes[RECIPE].version_ok, true);
  assert.deepEqual(f.events, [['changed', { status: 'installed' }]]);
  assert.equal(JSON.parse(f.storeText()).comfyui_folder, fs.realpathSync(f.folder));
});

test('checking the ComfyUI folder recomputes, and answers null health when none is saved', async () => {
  const f = fixture();
  assert.deepEqual(await f.invoke('checkComfyFolder'), { ok: true, health: null });
  pickFolder(f);
  await f.invoke('chooseComfyFolder');
  f.write('ComfyUI/comfyui_version.py', '__version__ = "0.43.2"\n');
  assert.equal((await f.invoke('getState')).comfyui.health.version, '0.45.0', 'state alone does not rewalk');
  const checked = await f.invoke('checkComfyFolder');
  assert.equal(checked.ok, true);
  assert.equal(checked.health.version, '0.43.2');
  assert.equal(checked.health.recipes[RECIPE].version_ok, false);
  assert.equal((await f.invoke('getState')).comfyui.health.version, '0.43.2');
  fs.rmSync(path.join(f.folder, 'ComfyUI', 'main.py'));
  const broken = await f.invoke('checkComfyFolder');
  assert.deepEqual(broken.health.recipes, {});
  assert.equal(broken.health.reason, 'comfyui_folder_invalid');
  assert.equal(f.events.length, 1, 'a check changes nothing to announce');
});

test('saving a ComfyUI set validates the payload, returns the set and announces the change', async () => {
  const f = fixture();
  const payload = { recipe: RECIPE, ...FILES, label: 'MiniMax' };
  assert.deepEqual(await f.invoke('saveComfySet', payload), { ok: false, reason: 'comfyui_folder_missing' });
  pickFolder(f);
  await f.invoke('chooseComfyFolder');
  f.events.length = 0;
  for (const bad of [undefined, null, [], { ...payload, vae: 5 }, { ...payload, diffusion: 'x'.repeat(1025) },
    { ...payload, label: 'x'.repeat(121) }, { ...payload, recipe: undefined }, { ...payload, root: 'Z:\\x' }, { ...payload, storePath: 'x' }]) {
    assert.deepEqual(await f.invoke('saveComfySet', bad), { ok: false, reason: 'invalid_payload' });
  }
  assert.deepEqual(await f.invoke('saveComfySet', { ...payload, recipe: 'nope' }), { ok: false, reason: 'unknown_recipe' });
  assert.deepEqual(await f.invoke('saveComfySet', { ...payload, vae: '../vae' }), { ok: false, reason: 'invalid_name' });
  assert.deepEqual(await f.invoke('saveComfySet', { ...payload, vae: FILES.diffusion }), { ok: false, reason: 'recipe_file_mismatch' });
  assert.equal(f.events.length, 0);
  assert.equal(JSON.parse(f.storeText()).sets.length, 0);
  const walksBeforeSave = f.walks();
  const saved = await f.invoke('saveComfySet', payload);
  assert.equal(saved.ok, true);
  assert.equal(f.walks(), walksBeforeSave, 'a save changes no file, so it does not walk the folder');
  assert.equal(saved.set.backend, 'comfyui');
  assert.equal(saved.set.recipe, RECIPE);
  assert.equal(saved.set.label, 'MiniMax');
  assert.deepEqual(Object.keys(saved.set.files).sort(), ['diffusion', 'text_encoder', 'vae']);
  assert.equal(f.events.length, 1);
  assert.equal((await f.invoke('getState')).comfyui.health.recipes[RECIPE].added, true);
  // The label is optional.
  const { label, ...unlabelled } = payload;
  assert.equal(label, 'MiniMax');
  assert.equal((await f.invoke('saveComfySet', unlabelled)).ok, true);
  // Removing the set clears "added" without another walk.
  const walks = f.walks();
  assert.equal((await f.invoke('removeModelSet', { id: saved.set.id })).ok, true);
  assert.equal((await f.invoke('getState')).comfyui.health.recipes[RECIPE].added, false);
  assert.equal(f.walks(), walks);
});

test('the kill switch refuses all three channels before any dialog or store access', async () => {
  const f = fixture({ flags: { image_comfyui_enabled: false } });
  pickFolder(f);
  const refused = { ok: false, reason: 'image_comfyui_disabled' };
  assert.deepEqual(await f.invoke('chooseComfyFolder'), refused);
  assert.deepEqual(await f.invoke('checkComfyFolder'), refused);
  assert.deepEqual(await f.invoke('saveComfySet', { recipe: RECIPE, ...FILES }), refused);
  assert.deepEqual(f.calls, []);
  assert.equal(f.storeText(), null);
  const state = await f.invoke('getState');
  assert.deepEqual(state.comfyui, { enabled: false, health: null });
  // Labels still go out, so saved ComfyUI sets keep their names in the list.
  assert.deepEqual(state.recipes, { [RECIPE]: { label: 'MiniMax-H3-Image', min_comfyui_version: '0.45.0', steps: 6 } });
  assert.equal(f.walks(), 0);
  const on = fixture({ flags: { image_comfyui_enabled: true } });
  assert.equal((await on.invoke('getState')).comfyui.enabled, true);
});

test('a failed save re-checks the folder, and a set from another folder does not count as added', async () => {
  const f = fixture();
  pickFolder(f);
  await f.invoke('chooseComfyFolder');
  const payload = { recipe: RECIPE, ...FILES };
  assert.equal((await f.invoke('saveComfySet', payload)).ok, true);
  fs.rmSync(path.join(f.folder, 'ComfyUI', 'models', ...FILES.vae.split('/')));
  const walks = f.walks();
  assert.deepEqual(await f.invoke('saveComfySet', payload), { ok: false, reason: 'file_missing' });
  assert.equal(f.walks(), walks + 1, 'a refusal re-reads the folder');
  assert.deepEqual((await f.invoke('getState')).comfyui.health.recipes[RECIPE].slots.vae, []);
  // A second install with the same files: the old set lives under the first folder.
  const other = path.join(f.base, 'Other_ComfyUI');
  for (const relative of ['python_embeded/python.exe', 'ComfyUI/main.py', ...Object.values(FILES).map((name) => `ComfyUI/models/${name}`)]) {
    fs.mkdirSync(path.dirname(path.join(other, ...relative.split('/'))), { recursive: true });
    fs.writeFileSync(path.join(other, ...relative.split('/')), 'model');
  }
  f.setPick({ canceled: false, filePaths: [other] });
  const moved = await f.invoke('chooseComfyFolder');
  assert.equal(moved.health.recipes[RECIPE].added, false);
  assert.equal((await f.invoke('getState')).comfyui.health.recipes[RECIPE].added, false);
});
