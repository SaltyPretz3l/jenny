'use strict';
// Model Library image engine operations use the trusted-sender authorizer.
// Runtime and folder dialogs stay in main; renderer roots are checked before IO.
const path = require('path');
const { dialog } = require('electron');
const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { isLocalAbsolutePath } = require('../shell-config-engines');
const { scanModelFolder, saveModelSet, listModelSets, removeModelSet,
  setDefaultModelSet, loadFamilies } = require('../image-model-sets');

function registerImageEngineIpc(ipcMain, {
  backendService, authorization, dialogImpl = dialog, getMainWindow = () => null,
  platform = process.platform, userDataPath = '',
}) {
  const storePath = path.join(userDataPath, 'image-models.json');
  // Folders the user picked in the main-owned dialog this run; scans and
  // saves are bound to those or to a saved set's root, never to a free path.
  const chosenRoots = new Set();
  const fail = (reason) => { throw Object.assign(new Error(reason), { reason }); };
  const chosenRoot = (root) => {
    localPath(root);
    if (chosenRoots.has(root)) return root;
    const saved = listModelSets({ storePath });
    if (!Array.isArray(saved?.sets) || !saved.sets.some((set) => set.root === root)) fail('image_engine_root_not_chosen');
    return root;
  };
  // A retained lease (render cleanup unconfirmed), the restore window and
  // shutdown all leave `active` false while a render may still own the engine.
  const whileIdle = (method) => {
    const handoff = backendService.chatGpuHandoff;
    const state = handoff?.getState?.();
    if (state?.active || state?.retained || state?.closing || handoff?.launchRefusal?.()) fail('image_engine_busy');
    return method();
  };
  const safeReason = (reason) => typeof reason === 'string' && /^[a-z_]{1,100}$/u.test(reason)
    ? reason : 'image_engine_operation_failed';
  const safe = async (operation) => {
    try {
      if (!backendService.imageEngine) return { ok: false, reason: 'image_engine_unavailable' };
      const result = await operation();
      return result?.ok === false ? { ...result, reason: safeReason(result.reason) } : { ...result, ok: true };
    } catch (error) {
      return { ok: false, reason: safeReason(error?.reason) };
    }
  };
  const noPayload = (method) => (_event, payload) => safe(() => {
    if (payload !== undefined) fail('unexpected_payload');
    return method();
  });
  const localPath = (value) => {
    if (!isLocalAbsolutePath(value, { platform })) fail('image_engine_path_rejected');
    return value;
  };
  const fields = (payload, keys) => {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('invalid_payload');
    return Object.fromEntries(keys.map((key) => {
      const value = payload[key];
      if (typeof value !== 'string' || value.length > (key === 'label' ? 120 : 1024)) fail('invalid_payload');
      return [key, value];
    }));
  };
  const choose = async (options, method) => {
    const picked = await dialogImpl.showOpenDialog(getMainWindow(), options);
    if (picked.canceled) return { ok: false, reason: 'cancelled' };
    return method(localPath(picked.filePaths?.[0]));
  };
  const modelId = (method) => (_event, payload) => safe(() => {
    if (typeof payload?.id !== 'string' || !/^[a-f0-9]{12}$/u.test(payload.id)) fail('invalid_payload');
    return method(payload.id, { storePath });
  });
  return registerIpcInvokeHandlers(ipcMain, {
    'imageEngine.getState': noPayload(() => ({
      ...backendService.imageEngine.getState(),
      handoff: backendService.chatGpuHandoff?.getState?.() || null,
      model_sets: listModelSets({ storePath }),
      families: loadFamilies().families,
    })),
    'imageEngine.install': (_event, payload) => safe(() => whileIdle(() => backendService.imageEngine.install({ confirmed: payload?.confirmed }))),
    'imageEngine.cancelInstall': noPayload(() => backendService.imageEngine.cancel()),
    'imageEngine.remove': (_event, payload) => safe(() => whileIdle(() => backendService.imageEngine.remove({ confirmed: payload?.confirmed }))),
    'imageEngine.chooseRuntime': noPayload(() => choose({ properties: ['openFile'],
      filters: [{ name: 'sd-cli', extensions: platform === 'win32' ? ['exe'] : ['*'] }],
    }, (filePath) => backendService.imageEngine.setCustomExecutable(filePath))),
    'imageEngine.clearRuntime': noPayload(() => backendService.imageEngine.clearCustomExecutable()),
    'imageEngine.chooseModelFolder': noPayload(() => choose({ properties: ['openDirectory'] }, (root) => {
      chosenRoots.add(root);
      return scanModelFolder(root);
    })),
    'imageEngine.scanModels': (_event, payload) => safe(() => {
      const { root } = fields(payload, ['root']);
      return scanModelFolder(chosenRoot(root));
    }),
    'imageEngine.saveModelSet': (_event, payload) => safe(() => {
      const selected = fields(payload, ['root', 'diffusion', 'text_encoder', 'vae', 'family', 'label']);
      chosenRoot(selected.root);
      return saveModelSet({ storePath, ...selected });
    }),
    'imageEngine.listModelSets': noPayload(() => listModelSets({ storePath })),
    'imageEngine.removeModelSet': modelId(removeModelSet),
    'imageEngine.setDefaultModelSet': modelId(setDefaultModelSet),
    'imageEngine.reconcile': noPayload(() => backendService.chatGpuHandoff.reconcile()),
  }, authorization);
}

module.exports = { registerImageEngineIpc };
