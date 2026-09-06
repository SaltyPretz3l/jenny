'use strict';

const { WORKSPACE_FS_ERROR_CODES } = require('../backend/error-codes');

const WORKSPACE_FILE_CODE = /^CMP-WORKSPACEFS-\d{4}$/;
const DETAIL_KEYS = new Set([
  'bytes_replaced', 'current_file_version', 'current_generation',
  'durability_uncertain', 'expected_generation', 'file_name', 'max_bytes',
  'operation', 'os_code', 'path_hash', 'reason', 'size',
]);

function boundedValue(value) {
  if (typeof value === 'boolean') return value;
  if (Number.isFinite(value)) return value;
  if (typeof value === 'string') return value.slice(0, 256);
  return undefined;
}

function boundedDetails(details) {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return {};
  const result = {};
  for (const [key, value] of Object.entries(details)) {
    if (!DETAIL_KEYS.has(key)) continue;
    const bounded = boundedValue(value);
    if (bounded !== undefined) result[key] = bounded;
  }
  return result;
}

function failure(error) {
  const candidate = String(error?.error_code || error?.code || '');
  const known = WORKSPACE_FILE_CODE.test(candidate);
  const code = known ? candidate : WORKSPACE_FS_ERROR_CODES.IO_FAILED;
  return {
    ok: false,
    code,
    error_code: code,
    message: known
      ? String(error?.message || 'The workspace file operation was refused.').slice(0, 300)
      : 'The workspace file operation failed safely.',
    details: known ? boundedDetails(error?.details) : {},
  };
}

async function invokeVersionedWorkspaceFile(service, method, payload) {
  if (!service || typeof service[method] !== 'function') return failure(null);
  try {
    const result = await service[method](payload);
    return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
  } catch (error) {
    return failure(error);
  }
}

module.exports = {
  invokeVersionedWorkspaceFile,
};
