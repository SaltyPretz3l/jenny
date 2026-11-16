'use strict';

// Row 140: llamaServer.companionStatus / installCompanion / cancelCompanion.
// Polled, like Move and add's ggufImportStatus. The renderer names a model by
// tag and the path it shows; services/gguf-companion-download.js re-resolves
// both against a fresh scan and owns every filesystem decision. Results carry
// reason codes only.

const path = require('path');

const { registerIpcInvokeHandlers } = require('../ipc-contract');

const REASON = /^[a-z][a-z0-9_]{0,79}$/;

function cleanPayload(payload) {
  const source = payload && typeof payload === 'object' ? payload : {};
  return {
    tag: typeof source.tag === 'string' ? source.tag.slice(0, 512) : '',
    modelPath: typeof source.modelPath === 'string' ? source.modelPath.slice(0, 4096) : '',
    kind: typeof source.kind === 'string' ? source.kind.slice(0, 32) : '',
  };
}

function registerGgufCompanionIpcHandlers(ipcMainLike, { service, authorization, log } = {}) {
  const guarded = async (action, call) => {
    if (!service) return { ok: false, reason: 'unavailable' };
    try {
      const result = await call();
      return result && typeof result === 'object' ? result : { ok: false, reason: 'invalid_result' };
    } catch (error) {
      const reason = REASON.test(String(error?.reason || '')) ? error.reason : 'companion_failed';
      try { log?.warn?.('gguf_companion.ipc_failed', { action, reason }); } catch (_error) { /* never throws */ }
      return { ok: false, reason };
    }
  };
  return registerIpcInvokeHandlers(ipcMainLike, {
    'llamaServer.companionStatus': (_event, payload) => guarded('status', () => service.status(cleanPayload(payload))),
    'llamaServer.installCompanion': (_event, payload) => guarded('install', () => service.install(cleanPayload(payload))),
    'llamaServer.cancelCompanion': () => guarded('cancel', () => service.cancel()),
  }, authorization || {});
}

// The production wiring: catalogs anchored to the repo root (a packaged app's cwd
// is arbitrary), the kill switch, and Local only read from saved settings.
function registerGgufCompanions(ipcMainLike, {
  listLocalGgufs, shellConfigService, featureFlags, authorization, log,
  repoRoot = path.join(__dirname, '..', '..'),
} = {}) {
  // No scan to resolve against: nothing is registered and the drawer rows stay hidden.
  if (typeof listLocalGgufs !== 'function') return null;
  const { createGgufCompanionService } = require('../gguf-companion-download');
  const { loadCompanionCatalog, DEFAULT_CATALOG_PATH } = require('../gguf-companion-catalog');
  const { loadAccelerationCatalog } = require('../backend/llama-server-acceleration');
  let acceleration;
  let catalog;
  const getAccelerationCatalog = () => {
    if (acceleration === undefined) acceleration = loadAccelerationCatalog({ repoRoot }).catalog || null;
    return acceleration;
  };
  const getCatalog = () => {
    if (catalog === undefined) {
      catalog = loadCompanionCatalog({ filePath: DEFAULT_CATALOG_PATH, accelerationCatalog: getAccelerationCatalog() });
      if (catalog?.error) {
        try { log?.warn?.('gguf_companion.catalog_rejected', { reason: 'catalog_invalid' }); } catch (_error) { /* never throws */ }
      }
    }
    return catalog;
  };
  const service = createGgufCompanionService({
    scanLocalGgufs: listLocalGgufs,
    getCatalog,
    getAccelerationCatalog,
    isEnabled: () => featureFlags?.gguf_companions !== false,
    isLocalOnly: () => shellConfigService?.getState?.()?.offlineIntelligence?.mode === 'local_only',
    logger: log,
  });
  registerGgufCompanionIpcHandlers(ipcMainLike, { service, authorization, log });
  return service;
}

module.exports = { registerGgufCompanionIpcHandlers, registerGgufCompanions };
