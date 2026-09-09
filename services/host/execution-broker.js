'use strict';
const { readJson, writeJson } = require('./durable-json');
const { requestWorker, workerError, UUID } = require('./worker-transport');
const { HOST_ERROR_CODES } = require('../backend/error-codes');
const { ExecutionBroker: SharedBroker, validateCommand } = require('../execution/execution-broker');
function readReceipt(filePath) {
  const value = readJson(filePath, { maxBytes: 4096 });
  if (!value) return { schema_version: 1, pending: null };
  if (value.schema_version !== 1 || Object.keys(value).some((key) => !['schema_version', 'pending'].includes(key))) {
    throw workerError('sandbox_receipt_invalid', HOST_ERROR_CODES.PERSISTENCE);
  }
  const pending = value.pending;
  if (pending !== null && (!pending || typeof pending !== 'object' || Array.isArray(pending)
    || Object.keys(pending).some((key) => !['job_id', 'incarnation'].includes(key))
    || !UUID.test(pending.job_id) || !UUID.test(pending.incarnation))) {
    throw workerError('sandbox_receipt_invalid', HOST_ERROR_CODES.PERSISTENCE);
  }
  return value;
}

// Hosted compatibility adapter; all admission and settlement stays shared.
class ExecutionBroker extends SharedBroker {
  constructor(options) {
    super({ request: requestWorker, readReceiptImpl: readReceipt, writeReceiptImpl: writeJson, ...options });
  }
}
module.exports = { ExecutionBroker, validateCommand, readReceipt };
