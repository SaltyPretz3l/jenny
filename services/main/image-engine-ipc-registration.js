'use strict';
// Model Library image engine operations use the trusted-sender authorizer.
// Runtime and folder dialogs stay in main; renderer roots are checked before IO.
const path = require('path');
const { dialog } = require('electron');
const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { isLocalAbsolutePath } = require('../shell-config-engines');
const { scanModelFolder, saveModelSet, listModelSets, removeModelSet,
  setDefaultModelSet, loadFamilies, loadRecipes, comfyFolderHealth, setComfyFolder,
  saveComfyModelSet, recipeAdded } = require('../image-model-sets');

const COMFY_SET_KEYS = ['recipe', 'diffusion', 'text_encoder', 'vae', 'label'];
const isHealth = (value) => Boolean(value) && typeof value.folder === 'string';

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
  const announceChanged = () => {
    const engine = backendService.imageEngine;
    try { if (typeof engine.emit === 'function') engine.emit('changed', engine.getState()); }
    catch (_error) { /* the renderer refreshes after its own answer anyway */ }
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
  // Row 127: ComfyUI folder health is a bounded walk of the models folder, so it
  // is kept here and only recomputed when the saved folder moves or the user acts.
  const comfyEnabled = () => backendService.featureFlags?.image_comfyui_enabled !== false;
  let healthCache = null;
  let recipeTable = null; // the shipped recipes never change while Jenny runs
  const recipes = () => (recipeTable ??= loadRecipes().recipes);
  const refreshHealth = () => {
    const result = comfyFolderHealth({ storePath }, { recipes: recipes() });
    healthCache = result === null || isHealth(result) ? { folder: result?.folder ?? null, health: result } : null;
    return result;
  };
  // Which recipes already have a saved set is read from the live store, not the cache.
  const withAdded = (health, sets) => ({
    ...health,
    recipes: Object.fromEntries(Object.entries(health.recipes).map(([id, entry]) => [id, {
      ...entry, added: recipeAdded(sets, id, health.models_root),
    }])),
  });
  const comfyState = (modelSets) => {
    // Labels go out even with the kill switch off, so saved ComfyUI sets keep their names.
    const summary = Object.fromEntries(Object.entries(recipes()).map(([id, recipe]) => [id, {
      label: recipe.label, min_comfyui_version: recipe.min_comfyui_version || '', steps: recipe.locked.steps,
    }]));
    if (!comfyEnabled()) return { comfyui: { enabled: false, health: null }, recipes: summary };
    const stored = modelSets?.comfyui_folder ?? null;
    if (!healthCache || healthCache.folder !== stored) refreshHealth();
    const health = healthCache?.health ? withAdded(healthCache.health, modelSets?.sets || []) : null;
    return { comfyui: { enabled: true, health }, recipes: summary };
  };
  const comfyOnly = (handler) => (_event, payload) => safe(() => {
    if (!comfyEnabled()) fail('image_comfyui_disabled');
    return handler(payload);
  });
  const comfyHealthResult = ({ announce }) => {
    const health = refreshHealth();
    if (health && !isHealth(health)) return health;
    if (announce) announceChanged();
    return { ok: true, health };
  };
  const modelId = (method) => (_event, payload) => safe(() => {
    if (typeof payload?.id !== 'string' || !/^[a-f0-9]{12}$/u.test(payload.id)) fail('invalid_payload');
    return method(payload.id, { storePath });
  });
  return registerIpcInvokeHandlers(ipcMain, {
    'imageEngine.getState': noPayload(() => {
      const modelSets = listModelSets({ storePath });
      return {
        ...backendService.imageEngine.getState(),
        handoff: backendService.chatGpuHandoff?.getState?.() || null,
        model_sets: modelSets,
        families: loadFamilies().families,
        ...comfyState(modelSets),
      };
    }),
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
      if (payload.vision_projector !== undefined) Object.assign(selected, fields(payload, ['vision_projector']));
      chosenRoot(selected.root);
      return saveModelSet({ storePath, ...selected });
    }),
    'imageEngine.chooseComfyFolder': comfyOnly((payload) => {
      if (payload !== undefined) fail('unexpected_payload');
      return choose({ properties: ['openDirectory'] }, (folder) => {
        const saved = setComfyFolder({ storePath, folder });
        return saved.ok ? comfyHealthResult({ announce: true }) : saved;
      });
    }),
    'imageEngine.checkComfyFolder': comfyOnly((payload) => {
      if (payload !== undefined) fail('unexpected_payload');
      return comfyHealthResult({ announce: false });
    }),
    'imageEngine.saveComfySet': comfyOnly((payload) => {
      const selected = fields(payload, ['recipe', 'diffusion', 'text_encoder', 'vae']);
      if (payload.label !== undefined) Object.assign(selected, fields(payload, ['label']));
      if (Object.keys(payload).some((key) => !COMFY_SET_KEYS.includes(key))) fail('invalid_payload');
      const saved = saveComfyModelSet({ storePath, ...selected }, { recipes: recipes() });
      // A save changes no file, so the cached lists stay; a refusal may mean they moved.
      if (saved.ok) announceChanged();
      else refreshHealth();
      return saved;
    }),
    'imageEngine.listModelSets': noPayload(() => listModelSets({ storePath })),
    'imageEngine.removeModelSet': modelId(removeModelSet),
    'imageEngine.setDefaultModelSet': modelId(setDefaultModelSet),
    'imageEngine.reconcile': noPayload(() => backendService.chatGpuHandoff.reconcile()),
    // "Clear anyway": the handoff keeps its own gates (an unconfirmed attempt
    // first, never mid-render); a cleared record re-renders the section.
    'imageEngine.forceClear': (_event, payload) => safe(async () => {
      if (payload?.confirmed !== true) fail('confirmation_required');
      const result = await backendService.chatGpuHandoff.forceClear({ confirmed: true });
      if (result?.ok === true) announceChanged();
      return result;
    }),
  }, authorization);
}

module.exports = { registerImageEngineIpc };
