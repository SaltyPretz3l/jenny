'use strict';

const { getTrustedExecutionBinding } = require('../backend/session-execution-authority');
const { getToolResourceOperations } = require('../session-runtime/resource-operations');
const { t } = require('../i18n-main');
const { RUNTIME_ERROR_CODES } = require('../backend/error-codes');

const waits = new WeakMap();
function projectToolResourceWait(error) { return waits.get(error) || null; }
function resourceError(reason, waiting = false) {
  const error = new Error(t('error.protocol.invalidRequest', 'Invalid JSON-RPC request.'));
  error.code = waiting ? RUNTIME_ERROR_CODES.RESOURCE_EXCEEDED : RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = reason;
  error.retryable = waiting;
  return error;
}

// Capture the branded gateway before dispatch. Its exact settlement capability
// survives cancellation; it cannot grant another operation after revocation.
function createToolResourceClaim({ binding, operationId, toolName, input, required = false }) {
  const gateway = getToolResourceOperations(binding);
  if (!gateway && !required) return null;
  const trusted = getTrustedExecutionBinding(binding);
  if (!gateway || !trusted) throw resourceError('runtime_tool_resources_unavailable');
  const identity = Object.freeze({
    api_version: '2026-08-17', schema_version: 1, kind: 'tool',
    request_id: trusted.requestId, session_id: trusted.sessionId,
    authority_revision: trusted.authorityRevision, operation_id: operationId,
  });
  let admitted = false;
  let admitting = false;
  let waitingError = null;
  const captureWait = result => {
    waitingError = resourceError(result.reason || 'runtime_tool_resources_waiting', true);
    return waitingError;
  };
  const confirmWait = error => {
    if (error !== waitingError || !error
      || !gateway.confirmUnstartedNodeWait(operationId, toolName, input)) return false;
    waits.set(error, Object.freeze({ schema_version: 1, operation_id: operationId,
      ...gateway.getResourceWait(operationId), status: 'waiting' }));
    return true;
  };
  return Object.freeze({
    isWaiting: error => error != null && error === waitingError,
    confirmWait,
    createSandboxPreparation(options) {
      if (toolName !== 'run_command' || admitted || admitting) throw resourceError('sandbox_preparation_invalid');
      return gateway.createSandboxPreparation(operationId, { ...options, argumentsValue: input,
        onWaiting: result => { throw captureWait(result); } });
    },
    async admit({ preparation = null, workerBinding = null } = {}) {
      if (admitted || admitting) throw resourceError('runtime_tool_duplicate_admission');
      admitting = true;
      try {
        const params = { ...identity, phase: 'admit', tool_name: toolName, arguments: input };
        const result = await (preparation
          ? gateway.admitPrepared(params, preparation, workerBinding) : gateway.admitNode(params));
        if (result?.status === 'waiting' && result.resource_class) {
          const error = captureWait(result);
          confirmWait(error);
          throw error;
        }
        if (result?.status !== 'granted') throw resourceError(
          result?.reason || result?.error?.reason || 'runtime_tool_resources_unavailable',
          result?.status === 'waiting');
        admitted = true;
      } finally { admitting = false; }
    },
    settle({ status, cleanup }) {
      if (!admitted) return false;
      const result = gateway.settleNode({ ...identity, phase: 'settle', status, cleanup });
      if (result?.status !== 'settled') throw resourceError('runtime_tool_settlement_rejected');
      return true;
    },
  });
}

module.exports = { createToolResourceClaim, projectToolResourceWait };
