'use strict';

// Load-path helpers for the managed NInfer runtime (row 54), kept out of
// backend-runtime.js so loadModel/unloadModel grow by branches, not bodies.

const { AI_ERROR_CODES } = require('./error-codes');
const { managedModelKey } = require('../shell-config-engines');

const SERVER_LABELS = Object.freeze({
  llama_server: 'llama-server',
  ninfer: 'NInfer runtime',
});

// The pinned NInfer artifact a model id names (its model_id, as the sidecar
// addresses it, or its artifact id), null for any other model.
function findNinferArtifactForModel(service, modelName) {
  const pins = service?.ninferRuntime?.artifacts?.artifacts;
  if (!Array.isArray(pins)) return null;
  const token = String(modelName || '').trim();
  if (!token) return null;
  return pins.find((pin) => pin && (pin.model_id === token || pin.id === token)) || null;
}

// True when a load of anything else must stop the NInfer manager's server
// (live, mid-transition, crashed, or a parked launch failure to clear).
function ninferServerStops(manager) {
  const status = manager?.getStatus?.() || null;
  if (!status) return false;
  return ['ready', 'starting', 'stopping', 'crashed'].includes(status.state) || Boolean(status.lastError);
}

// Stops a managed server with proof before another engine (or the other
// managed server) takes the GPU; an unconfirmed stop aborts the switch so the
// GPU is never double-loaded. `kind` is 'llama_server' or 'ninfer'.
async function stopManagedServerOrAbort(service, manager, kind, to) {
  const label = SERVER_LABELS[kind] || kind;
  let stopFailure;
  try {
    const stopped = await manager.stop();
    stopFailure = String(stopped?.lastError || '');
  } catch (error) {
    stopFailure = String(error?.message || error) || 'stop_failed';
  }
  if (stopFailure) {
    service._emitServiceLog?.('WARN', `backend.engine_switch_stop_${kind}_failed`, { to, message: stopFailure });
    throw Object.assign(
      new Error(
        `The managed ${label} could not be confirmed stopped; `
        + 'the engine switch was aborted so the GPU is not double-loaded.'
      ),
      {
        error_code: AI_ERROR_CODES.ENGINE_CONNECTION,
        category: 'engine_switch_aborted',
        retryable: true,
      }
    );
  }
  service._emitServiceLog?.('INFO', `backend.engine_switch_stop_${kind}`, { to });
}

// The managed server an openai-compatible load failure belongs to, stamped on
// the record so every surface names NInfer or llama-server for what was
// attempted rather than for whatever serves later. '' for other engines or
// when no managed server is involved (a user-run endpoint).
function managedServerKindForFailure(service, engine) {
  if (String(engine || '').trim() !== 'openai-compatible') return '';
  const live = (status) => ['starting', 'ready', 'stopping'].includes(String(status?.state || ''));
  const ninfer = service?.options?.getNinferManager?.()?.getStatus?.() || null;
  const llama = service?.options?.getLlamaServerManager?.()?.getStatus?.() || null;
  if (ninfer && (live(ninfer) || ninfer.state === 'crashed' || (ninfer.lastError && !live(llama)))) return 'ninfer';
  return llama && (live(llama) || llama.state === 'crashed' || Boolean(llama.lastError)) ? 'llama-server' : '';
}

// The managed server behind an openai-compatible catalog entry, so the picker
// groups it as NInfer or llama-server rather than as a user-run endpoint:
// 'ninfer' for a pinned artifact, 'llama-server' for a model the managed
// llama-server is set to serve or is serving, '' otherwise. With
// `{ routing: true }` (a chat send or engine-less load, gate F27) the answer
// must be loadable: NInfer only while its manager exists, and a remembered
// alias only while the server is starting or ready, so a disabled managed
// block or a stopped server never selects an engine loadModel then declines.
function managedServerKindForModel(service, modelId, { routing = false } = {}) {
  const id = String(modelId || '').trim();
  if (!id) return '';
  if (findNinferArtifactForModel(service, id)
    && (!routing || Boolean(service?.options?.getNinferManager?.()))) return 'ninfer';
  const token = managedModelKey(id);
  const managed = service?.configService?.getLocalEngines?.()?.openaiCompatible?.managed || null;
  if (managed?.enabled === true && managed.perModel?.[token]?.engine === 'llama-server') return 'llama-server';
  const status = service?.options?.getLlamaServerManager?.()?.getStatus?.() || null;
  if (routing && !['starting', 'ready'].includes(String(status?.state || ''))) return '';
  // status.alias drops :latest, which the catalog id may still carry.
  const aliasKey = (value) => managedModelKey(String(value || '').replace(/:latest$/i, ''));
  const alias = String(status?.alias || '');
  return alias && aliasKey(alias) === aliasKey(id) ? 'llama-server' : '';
}

module.exports = {
  findNinferArtifactForModel,
  managedServerKindForFailure,
  managedServerKindForModel,
  ninferServerStops,
  stopManagedServerOrAbort,
};
