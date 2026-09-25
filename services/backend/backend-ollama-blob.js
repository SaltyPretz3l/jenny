'use strict';

const { SIDECAR_ERROR_CODES, RUNTIME_ERROR_CODES } = require('./error-codes');

async function getOllamaModelBlob(service, modelId) {
  const status = service?.sidecarManager?.getStatus?.();
  if (String(status?.phase || '') !== 'ready' || !service?.sidecarClient) {
    return null;
  }
  try {
    const payload = await service.sidecarClient.modelsOllamaBlob(modelId);
    const blobPath = String(payload?.blob_path || '').trim();
    if (payload?.available !== true || !blobPath) {
      return null;
    }
    return {
      blobPath,
      mmprojPath: String(payload?.mmproj_path || '').trim(),
    };
  } catch (error) {
    const errorCode = String(error?.error_code || '');
    const isTimeout = errorCode === SIDECAR_ERROR_CODES.TIMEOUT;
    // The sidecar's worker cap refused the lookup: transient, not a failure
    // of this model. Rethrow so the caller does not cache it as "no blob".
    const isCapacity = errorCode === RUNTIME_ERROR_CODES.RESOURCE_EXCEEDED;
    service._emitServiceLog?.(isTimeout || isCapacity ? 'DEBUG' : 'WARN', 'backend.models_ollama_blob_failed', {
      message: String(error?.message || error),
    });
    if (isCapacity) throw error;
    return null;
  }
}

module.exports = {
  getOllamaModelBlob,
};
