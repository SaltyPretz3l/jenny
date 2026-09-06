'use strict';

const { SIDECAR_ERROR_CODES } = require('./error-codes');

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
    const isTimeout = String(error?.error_code || '') === SIDECAR_ERROR_CODES.TIMEOUT;
    service._emitServiceLog?.(isTimeout ? 'DEBUG' : 'WARN', 'backend.models_ollama_blob_failed', {
      message: String(error?.message || error),
    });
    return null;
  }
}

module.exports = {
  getOllamaModelBlob,
};
