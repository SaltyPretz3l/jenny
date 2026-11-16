'use strict';

/* services/primary-check-model.js - row 144 (plan SCHEDULED_CHECK_MODEL_FLOOR_2026-11-13.md section 3.1): which model
 * a scheduled check would run on, and whether it may.
 *
 * Resolution order: the "Scheduled checks run on" model (primaryChat.checkModel), Jenny's model pin (primaryChat.model),
 * the Jenny chat's own preferred_model, the Model Library default a Default chat runs on, then the loaded model. The
 * answer is one of:
 *   fit          run on `model` (the caller pins it on the request, so the gate and the run use the same model)
 *   too_small    under the floor, or of unknown size (owner decision D2)
 *   unavailable  the model is not in the backend's model list
 *   pending      the backend or its model list is not ready yet; ask again shortly
 * `override` (the user's Run anyway) skips only the size test. Reads only; never loads a model. Model ids stay out
 * of logs.
 */

const fs = require('node:fs');
const { readGgufHeader, GENERAL_ONLY } = require('./gguf-header');
const { CLOUD_ENGINE_TYPES, classifyModelSize } = require('./model-size-class');
const { managedModelKey } = require('./shell-config-engines');
const { modelInstallState, resolveDefaultChatModel } = require('./backend/backend-chat-model-resolution');
const { inferEngineTypeFromModel } = require('./backend/backend-service-utils');
const { managedServerKindForModel } = require('./backend/ninfer-load-path');

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const modelKey = (name) => text(name).toLowerCase().replace(/:latest$/, '');

// general.size_label of a GGUF, cached by path, size and mtime. Null when the file or the key is missing.
function createSizeLabelReader({ fsImpl = fs, readHeader = readGgufHeader, maxEntries = 32 } = {}) {
  const cache = new Map();
  return function readSizeLabel(filePath) {
    try {
      const { size, mtimeMs } = fsImpl.statSync(filePath);
      const hit = cache.get(filePath);
      if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.label;
      let label = null; // an unreadable header is cached too, so a held check does not re-read it on every retry
      try { label = text(readHeader(filePath, { fsImpl, maxBytes: 1024 * 1024, [GENERAL_ONLY]: true }).kv?.['general.size_label']) || null; } catch { /* no label */ }
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(filePath, { size, mtimeMs, label });
      return label;
    } catch {
      return null;
    }
  };
}

function engineTypeFor(service, model, { fromLoaded = false } = {}) {
  const current = text(service.currentEngineType).toLowerCase();
  if (fromLoaded && CLOUD_ENGINE_TYPES.has(current)) return current;
  const inferred = text(inferEngineTypeFromModel(model)).toLowerCase();
  if (CLOUD_ENGINE_TYPES.has(inferred)) return inferred;
  const hinted = text(service._modelEngineHints?.get?.(model)).toLowerCase();
  if (hinted) return hinted;
  return managedServerKindForModel(service, model) ? 'openai-compatible' : current;
}

function createCheckModelGate(service, { readSizeLabel = createSizeLabelReader() } = {}) {
  const read = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const ready = () => text(read(() => service.getBackendStatus?.()?.phase, '')) === 'ready';

  function resolve(summary) {
    const block = read(() => service.configService?.getState?.()?.primaryChat, null) || {};
    const chosen = [block.checkModel, block.model, summary?.preferred_model].map(text).find(Boolean)
      || text(read(() => resolveDefaultChatModel(service), ''));
    if (chosen) return { model: chosen, fromLoaded: false };
    const loaded = text(service.currentModel);
    return loaded ? { model: loaded, fromLoaded: true } : null;
  }

  function sizeLabelOf(model) {
    const managed = read(() => service.configService?.getLocalEngines?.()?.openaiCompatible?.managed, null);
    const modelPath = text(managed?.perModel?.[managedModelKey(model)]?.modelPath);
    return modelPath ? readSizeLabel(modelPath) : null;
  }

  // (summary, { override }) -> { status, model, engine_type, params_b, source }
  return async function checkModel(summary, { override = false } = {}) {
    const picked = resolve(summary);
    if (!picked) return { status: ready() ? 'unavailable' : 'pending', model: '', engine_type: '', params_b: null, source: 'unknown' };
    const { model } = picked;
    const engineType = engineTypeFor(service, model, picked);
    const answer = (status, size = {}) => ({ status, model, engine_type: engineType, params_b: size.params_b ?? null, source: size.source || 'unknown' });
    if (CLOUD_ENGINE_TYPES.has(engineType)) return answer('fit', { source: 'cloud' });
    if (!ready()) return answer('pending');
    const list = await Promise.resolve().then(() => service.listModels?.()).catch(() => null);
    const entries = Array.isArray(list?.data) ? list.data : null;
    if (!entries || list.available === false) return answer('pending');
    // The list carries one engine family at a time: a model it lacks is missing only when the shared install check
    // says so (a managed server's own config, an engine hint or a family the list does cover vouch either way).
    const entry = entries.find((row) => modelKey(row?.id) === modelKey(model));
    if (!entry && await modelInstallState(service, model, { listing: list }).catch(() => 'unknown') === 'missing') return answer('unavailable');
    if (override) return answer('fit', { source: 'override' });
    const size = classifyModelSize({ model, engineType, parameterSize: entry?.parameterSize, ggufSizeLabel: sizeLabelOf(model) });
    return answer(size.fit ? 'fit' : 'too_small', size);
  };
}

module.exports = { createCheckModelGate, createSizeLabelReader };
