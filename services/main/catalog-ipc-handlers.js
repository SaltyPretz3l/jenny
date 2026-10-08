'use strict';

// catalog.* IPC for Settings › Tools "Search by meaning" (roadmap row 41):
// status, the bring-your-own embedding model picker, the persisted choice
// (localEngines.embedding) and the catalog actions. Registered only while the
// semantic_catalog flag is on. The picked file is validated here, before it is
// persisted, so a chat model or a non-GGUF file is refused at the picker.

const { registerIpcInvokeHandlers } = require('../ipc-contract');
const { t } = require('../i18n-main');
const { loadEmbeddingProfiles, validateEmbeddingModel } = require('../embedding-model-profiles');

function failure(reason) {
  return { ok: false, reason };
}

function settingsPatch(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const patch = {};
  if (typeof source.enabled === 'boolean') patch.enabled = source.enabled;
  if (source.device === 'cpu' || source.device === 'gpu') patch.device = source.device;
  if (typeof source.profileId === 'string') patch.profileId = source.profileId.slice(0, 32);
  if (Number.isInteger(source.dims) && source.dims >= 0 && source.dims <= 4096) patch.dims = source.dims;
  return patch;
}

// The Advanced fold's profile choices: id, label and allowed dimensions only.
function profileChoices(profiles) {
  return (Array.isArray(profiles) ? profiles : []).map((profile) => ({
    id: String(profile.id),
    label: String(profile.label || profile.id),
    dims: Array.isArray(profile.dims) ? profile.dims.filter(Number.isSafeInteger) : [],
  }));
}

function registerCatalogIpcHandlers(ipcMainLike, {
  enabled = false,
  getCatalogService = () => null,
  shellConfigService = null,
  dialog = null,
  getOwnerWindow = () => null,
  validateModel = validateEmbeddingModel,
  listProfiles = () => loadEmbeddingProfiles(),
  authorization,
} = {}) {
  if (!enabled) return [];
  const service = () => getCatalogService();
  const settings = () => shellConfigService?.getLocalEngines?.()?.embedding || null;

  return registerIpcInvokeHandlers(ipcMainLike, {
    'catalog.getStatus': async () => {
      const current = service();
      if (!current) return failure('unavailable');
      return {
        ok: true,
        settings: settings(),
        status: await current.getDetailedStatus(),
        profiles: profileChoices(listProfiles()),
      };
    },
    'catalog.updateSettings': (_, payload) => {
      const patch = settingsPatch(payload);
      if (!Object.keys(patch).length) return failure('invalid_settings');
      const next = shellConfigService?.updateEmbeddingSettings?.(patch);
      return next ? { ok: true, settings: next } : failure('unavailable');
    },
    'catalog.chooseModel': async () => {
      if (!dialog || typeof dialog.showOpenDialog !== 'function') return failure('picker_unavailable');
      const result = await dialog.showOpenDialog(getOwnerWindow(), {
        title: t('main.dialog.catalog.chooseModel', 'Choose an embedding model'),
        properties: ['openFile'],
        filters: [{ name: 'GGUF', extensions: ['gguf'] }],
      });
      if (result.canceled || !Array.isArray(result.filePaths) || !result.filePaths[0]) {
        return failure('canceled');
      }
      const modelPath = result.filePaths[0];
      const verdict = validateModel(modelPath);
      if (!verdict || verdict.ok !== true) return failure(String(verdict?.reason || 'unreadable'));
      // A new model starts from the detected profile and its default dims.
      const next = shellConfigService?.updateEmbeddingSettings?.({ modelPath, profileId: '', dims: 0 });
      return next ? { ok: true, settings: next } : failure('unavailable');
    },
    'catalog.rebuild': async () => {
      const current = service();
      return current ? current.purge({ rebuild: true }) : failure('unavailable');
    },
    'catalog.deleteCatalog': async () => {
      const current = service();
      return current ? current.purge({ rebuild: false }) : failure('unavailable');
    },
    'catalog.retry': () => {
      const current = service();
      if (!current) return failure('unavailable');
      current.notifyChanged('settings');
      return { ok: true };
    },
  }, authorization);
}

module.exports = { registerCatalogIpcHandlers, settingsPatch };
