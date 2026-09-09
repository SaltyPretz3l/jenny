'use strict';
const { TOOL_ERROR_CODES } = require('../backend/error-codes');
async function settleExecution(service, streamId, errorPayload = null) {
  const broker = service?.commandSandbox;
  if (!broker?.enabled) return;
  try {
    await service._desktopSandboxBridgeRequests?.get(streamId);
    await broker.drainStream(streamId);
  }
  catch (error) {
    service?._emitServiceLog?.('ERROR', 'sandbox.settlement_uncertain', { streamId, reason: 'sandbox_cleanup_unconfirmed' });
    if (!errorPayload) throw error;
    Object.assign(errorPayload, { category: 'runtime', status: 'runtime_error', retryable: false,
      error_code: TOOL_ERROR_CODES.EXECUTION_FAILED, terminal_subcode: 'execution_uncertain', cancel_reason: '',
      message: 'Docker sandbox cleanup could not be confirmed. Execution remains blocked.' });
  }
}
async function trackSandboxBridgeRequest(service, streamId, execute, settleCancelled) {
  service._desktopSandboxBridgeRequests ||= new Map();
  const requests = service._desktopSandboxBridgeRequests;
  const pending = Promise.resolve().then(execute).then(result => {
    settleCancelled(result);
    return result;
  });
  requests.set(streamId, pending);
  try { return await pending; }
  finally { if (requests.get(streamId) === pending) requests.delete(streamId); }
}
function assertExecutionPolicy(service, engineType) {
  if (service.configService?.getState?.()?.commandSandbox?.enabled !== true) return;
  if (!['mock', 'replay', 'ollama', 'vllm', 'openai-compatible'].includes(engineType)
    || service._desktopPolicyProcess !== service.sidecarManager?.process || !service.sidecarManager?.process) {
    throw new Error('Docker sandbox requires an acknowledged local-model execution policy.');
  }
}
async function settleManagedTerminal(service, streamId, runtime, result) {
  await settleExecution(service, streamId);
  return runtime.settleTerminalResult(result);
}
module.exports = { trackSandboxBridgeRequest, settleExecution, assertExecutionPolicy, settleManagedTerminal };