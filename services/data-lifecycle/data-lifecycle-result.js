'use strict';

const { DATA_ERROR_CODES } = require('../backend/error-codes');

function boundedDataError(error) {
  return {
    code: /^CMP-DATA-\d{4}$/.test(String(error?.code || ''))
      ? String(error.code)
      : DATA_ERROR_CODES.INVALID_REQUEST,
    reason: String(error?.reason || 'operation_failed').slice(0, 80),
  };
}

function dataLifecycleResult(status, fields = {}, operationId = '') {
  const source = fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {};
  return {
    ...source,
    ok: true,
    operationId: String(operationId || ''),
    status: String(status || ''),
    counts: source.counts && typeof source.counts === 'object' && !Array.isArray(source.counts)
      ? source.counts
      : {},
    warnings: Array.isArray(source.warnings) ? source.warnings : [],
  };
}

function dataLifecycleFailure(error, operationId = '') {
  return {
    ok: false,
    operationId: String(operationId || ''),
    status: 'failed',
    counts: {},
    warnings: [],
    error: boundedDataError(error),
  };
}

function unauthorizedDataLifecycleResult() {
  return {
    ...dataLifecycleFailure({ code: DATA_ERROR_CODES.INVALID_REQUEST, reason: 'ipc_sender_unauthorized' }),
    authorized: false,
  };
}

module.exports = {
  boundedDataError,
  dataLifecycleFailure,
  dataLifecycleResult,
  unauthorizedDataLifecycleResult,
};
