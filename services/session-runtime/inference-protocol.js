'use strict';

const { t } = require('../i18n-main');
const { RUNTIME_ERROR_CODES } = require('../backend/error-codes');
const initializations = new WeakMap();
const RUNTIME_INFERENCE_ADMISSION_VERSION = 1;

function beginRuntimeInferenceInitialization(client) {
  const token = Object.freeze({});
  initializations.set(client, { token, process: client.process, version: null, toolVersion: null,
    continuationVersion: null, budgetVersion: null });
  return token;
}

function completeRuntimeInferenceInitialization(client, token, result) {
  const state = initializations.get(client);
  if (!state || state.token !== token || state.process !== client.process || !client.process) return false;
  state.version = result?.runtime_inference_admission_version === RUNTIME_INFERENCE_ADMISSION_VERSION
    ? RUNTIME_INFERENCE_ADMISSION_VERSION : null;
  state.toolVersion = result?.runtime_tool_resource_admission_version === 1 ? 1 : null;
  state.budgetVersion = result?.runtime_inference_budget_version === 1 ? 1 : null;
  state.continuationVersion = result?.runtime_continuation_version === 1 ? 1 : null;
  return state.version !== null;
}

function invalidateRuntimeInferenceProtocol(client) {
  initializations.delete(client);
}

function assertRuntimeInferenceProtocol(client) {
  const state = client && initializations.get(client);
  if (state?.process && state.process === client.process
    && state.version === RUNTIME_INFERENCE_ADMISSION_VERSION) return true;
  const error = new Error(t('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'));
  error.code = RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = 'runtime_inference_protocol_required';
  error.retryable = false;
  throw error;
}

function assertRuntimeOperationsProtocol(client) {
  assertRuntimeInferenceProtocol(client);
  if (initializations.get(client).toolVersion === 1) return true;
  const error = new Error(t('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'));
  error.code = RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = 'runtime_tool_resource_protocol_required';
  error.retryable = false;
  throw error;
}

function assertRuntimeContinuationProtocol(client) {
  assertRuntimeOperationsProtocol(client);
  if (initializations.get(client).continuationVersion === 1) return true;
  const error = new Error(t('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'));
  error.code = RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = 'runtime_continuation_protocol_required';
  error.retryable = false;
  throw error;
}

function assertRuntimeBudgetProtocol(client) {
  assertRuntimeOperationsProtocol(client);
  if (initializations.get(client).budgetVersion === 1) return true;
  const error = new Error(t('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'));
  error.code = RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = 'runtime_inference_budget_protocol_required';
  error.retryable = false;
  throw error;
}

function supportsRuntimeContinuationProtocol(client) {
  try { return assertRuntimeContinuationProtocol(client) === true; } catch (_error) { return false; }
}

module.exports = { RUNTIME_INFERENCE_ADMISSION_VERSION, beginRuntimeInferenceInitialization,
  completeRuntimeInferenceInitialization, invalidateRuntimeInferenceProtocol, assertRuntimeInferenceProtocol,
  assertRuntimeOperationsProtocol, assertRuntimeContinuationProtocol, supportsRuntimeContinuationProtocol,
  assertRuntimeBudgetProtocol };
