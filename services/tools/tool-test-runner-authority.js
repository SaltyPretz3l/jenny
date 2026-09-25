'use strict';

const { getTrustedExecutionBinding } = require('../backend/session-execution-authority');
const { RUNTIME_ERROR_CODES } = require('../backend/error-codes');

const { createToolResourceClaim } = require('./tool-resource-execution');

const MAX_INPUT_BYTES = 1024 * 1024;
const executionPorts = new WeakMap();

function cloneInput(input) {
  const serialized = JSON.stringify(input);
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error('Test runner tool input exceeds its encoded size limit.');
  }
  return Object.freeze(JSON.parse(serialized));
}

function authorityError(result) {
  const error = new Error(result?.error?.message || 'Test runner execution authority changed.');
  error.code = result?.error?.code || RUNTIME_ERROR_CODES.ADMISSION_REJECTED;
  error.reason = result?.error?.reason || 'authority_mismatch';
  return error;
}

function createToolTestRunnerService({ service, executionAuthority, binding, callId, input, abortSignal, beforeProducer = null }) {
  const trusted = getTrustedExecutionBinding(binding);
  if (!service || typeof service.run !== 'function' || typeof service.listConfigs !== 'function'
    || !trusted) {
    throw new Error('Test runner execution authority is unavailable.');
  }
  const operationId = String(callId || '').trim();
  if (!operationId) throw new Error('Test runner operation identity is unavailable.');
  const argumentsSnapshot = cloneInput(input);
  const request = Object.freeze({
    api_version: '2026-08-17',
    schema_version: 1,
    request_id: trusted.requestId,
    session_id: trusted.sessionId,
    authority_revision: trusted.authorityRevision,
    operation_id: operationId,
    phase: 'check',
    tool_name: 'verify',
    arguments: argumentsSnapshot,
  });
  const port = Object.freeze({});
  executionPorts.set(port, Object.freeze({
    abortSignal: abortSignal || null,
    beforeProducer,
    toolClaim: beforeProducer ? createToolResourceClaim({ binding, operationId,
      toolName: 'verify', input: argumentsSnapshot, required: true }) : null,
    assertCurrent() {
      if (!executionAuthority || typeof executionAuthority.checkRuntimeOperation !== 'function') {
        throw new Error('Test runner execution authority is unavailable.');
      }
      trusted.assertCurrent();
      if (abortSignal?.aborted) throw authorityError(null);
      const result = executionAuthority.checkRuntimeOperation(binding, request);
      if (result?.status !== 'granted' || result.operation_id !== operationId) {
        throw authorityError(result);
      }
      return true;
    },
  }));
  return Object.freeze({
    listConfigs() {
      executionPorts.get(port).assertCurrent();
      return service.listConfigs();
    },
    run(payload) {
      executionPorts.get(port).assertCurrent();
      return service.run(payload, port);
    },
    getState() {
      executionPorts.get(port).assertCurrent();
      return service.getState?.();
    },
  });
}

function requireToolTestRunnerExecutionPort(port) {
  const state = executionPorts.get(port);
  if (!state) throw new Error('Test runner internal execution port is invalid.');
  return state;
}

module.exports = { createToolTestRunnerService, requireToolTestRunnerExecutionPort };
