'use strict';

// getResidentModels(service): normalizes the sidecar's `models.resident`
// RPC (snake_case Ollama /api/ps payload) into a camelCase shape for the
// model-fit-observer (services/model-fit-observer.js) to poll while waiting
// for a just-selected model to show up as resident.
//
// Split out of backend-runtime.js (already at the ~600-line soft cap) rather
// than added inline. Mirrors getHardwareVramUsage's guard shape: only queries
// the sidecar when the phase is 'ready', and degrades to null on any failure
// so a flaky/absent Ollama daemon never breaks the caller's poll loop.
const { SIDECAR_ERROR_CODES } = require('./error-codes');

function _toNonNegInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function normalizeResidentModelEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const name = String(entry.name || '').trim();
  if (!name) return null;
  return {
    name,
    digest: String(entry.digest || '').trim(),
    sizeBytes: _toNonNegInt(entry.size),
    vramBytes: _toNonNegInt(entry.size_vram),
    contextLength: Number.isFinite(Number(entry.context_length)) && Number(entry.context_length) > 0
      ? Math.floor(Number(entry.context_length))
      : null,
    parameterSize: String(entry.parameter_size || '').trim(),
    quantizationLevel: String(entry.quantization_level || '').trim(),
    expiresAt: entry.expires_at != null ? String(entry.expires_at) : null,
  };
}

async function getResidentModels(service) {
  const status = service?.sidecarManager?.getStatus?.();
  if (String(status?.phase || '') !== 'ready') {
    return null;
  }
  if (!service?.sidecarClient) {
    return null;
  }
  try {
    const payload = await service.sidecarClient.modelsResident();
    if (!payload || payload.available !== true) {
      return null;
    }
    const rawModels = Array.isArray(payload.models) ? payload.models : [];
    return rawModels.map(normalizeResidentModelEntry).filter(Boolean);
  } catch (error) {
    const isTimeout = String(error?.error_code || '') === SIDECAR_ERROR_CODES.TIMEOUT;
    service._emitServiceLog?.(isTimeout ? 'DEBUG' : 'WARN', 'backend.models_resident_failed', {
      message: String(error?.message || error),
    });
    return null;
  }
}

module.exports = {
  getResidentModels,
  normalizeResidentModelEntry,
};
