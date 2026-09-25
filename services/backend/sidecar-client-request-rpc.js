'use strict';
const { projectToolResourceWait } = require('../tools/tool-resource-execution');
const { projectDecisionPause } = require('./runtime-decision-control');
const { RUNTIME_ERROR_CODES } = require('./error-codes');

const { MAX_OUTBOUND_FRAME_BODY_BYTES } = require('./sidecar-client-transport-codec');
const {
  buildBoundedElectronToolBridgeResult,
  buildElectronToolBridgeErrorResponse,
  emitSidecarErrorSafely,
} = require('./sidecar-client-reverse-rpc');

const retainedSettlements = new WeakMap();

// Cancellation settles the transport promise before the provider necessarily
// stops. Retain only its settlement callback until the execution owner drains it.
function retainRuntimeSettlementHandler(client, requestId, handler) {
  if (!client?.process || typeof handler !== 'function' || typeof requestId !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u.test(requestId)) {
    throw new TypeError('runtime_settlement_binding_invalid');
  }
  const entries = retainedSettlements.get(client) || new Map();
  for (const [key, entry] of entries) if (entry.process !== client.process) entries.delete(key);
  if (entries.has(requestId) || entries.size >= 64) throw new Error('runtime_settlement_capacity');
  const entry = { process: client.process, handler };
  entries.set(requestId, entry);
  retainedSettlements.set(client, entries);
  return () => {
    if (entries.get(requestId) !== entry) return false;
    return entries.delete(requestId);
  };
}

async function handleElectronToolRequest(client, message) {
  const sourceProcess = client.process;
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const requestId = String(params.request_id || '').trim();
  const handler = requestId ? client.electronToolHandlers.get(requestId) : null;
  if (requestId && client._batch4TransportEnabled() && client._isCancelledRequestKey(requestId)) {
    client.logger?.('WARN', 'sidecar.late_electron_tool_request', {
      request_id: requestId, trace_id: String(params.trace_id || requestId).trim() || requestId,
      late_event: true, incoming_method: 'tool.execute_electron', incoming_id: message.id,
      tool_call_id: String(params.tool_call_id || '').trim().slice(0, 256),
      tool_name: String(params.tool_name || '').trim().slice(0, 256),
    });
    client._safeEmitNotificationEvent('late-notification', message);
    client._writeFrame(buildElectronToolBridgeErrorResponse(
      message.id, 'Electron tool bridge request arrived after the chat request was cancelled.'
    ));
    return;
  }
  try {
    if (typeof handler !== 'function') throw new Error('Electron tool bridge is unavailable for this request.');
    const bounded = buildBoundedElectronToolBridgeResult(message.id, await handler(params));
    if (bounded.oversized) client.logger?.('WARN', 'sidecar.electron_tool_response_too_large', {
      bodyLength: bounded.bodyLength, maxBytes: MAX_OUTBOUND_FRAME_BODY_BYTES, incoming_id: message.id,
    });
    if (client.process === sourceProcess) client._writeFrame(bounded.response);
  } catch (error) {
    if (client.process !== sourceProcess) return;
    const wait = params.runtime_resource_gate?.phase === 'prepare' && projectToolResourceWait(error);
    if (wait) {
      client._writeFrame({ jsonrpc: '2.0', id: message.id, result: { runtime_resource_wait: wait } });
      return;
    }
    const pause = params.tool_name === 'ask_user' && projectDecisionPause(error);
    if (pause) {
      client._writeFrame({ jsonrpc: '2.0', id: message.id, result: { runtime_decision_pause: pause } });
      return;
    }
    const text = String(error?.message || error || 'Electron tool bridge failed.');
    client._writeFrame(buildElectronToolBridgeErrorResponse(message.id, text));
    if (client.listenerCount('error') > 0) client.emit('error', error instanceof Error ? error : new Error(text));
  }
}

async function handlePluginHostRequest(client, message) {
  const params = message.params && typeof message.params === 'object' ? message.params : {};
  const handler = client.pluginHostHandlers.get(String(params.request_id || '').trim());
  try {
    if (typeof handler !== 'function') throw new Error('Plugin host bridge is unavailable for this request.');
    client._writeFrame(buildBoundedElectronToolBridgeResult(message.id, await handler(params)).response);
  } catch (error) {
    const text = String(error?.message || error || 'Plugin host bridge failed.');
    client._writeFrame(buildElectronToolBridgeErrorResponse(message.id, text, { reason: 'plugin_host_failed' }));
    emitSidecarErrorSafely(client, error instanceof Error ? error : new Error(text), 'plugin_host_handler');
  }
}

function runtimeOperationRejected(params, reason, message) {
  return {
    schema_version: 1,
    status: 'rejected',
    operation_id: String(params?.operation_id || '').trim().slice(0, 256),
    error: {
      code: RUNTIME_ERROR_CODES.ADMISSION_REJECTED,
      reason,
      message: String(message || 'Runtime operation was rejected.').slice(0, 300),
    },
  };
}

async function handleRuntimeOperationRequest(client, message) {
  const sourceProcess = client.process;
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params)
    ? message.params : {};
  const requestId = String(params.request_id || '').trim();
  const cancelled = requestId && client._isCancelledRequestKey(requestId);
  const retained = ['inference', 'tool'].includes(params.kind) && params.phase === 'settle'
    ? retainedSettlements.get(client)?.get(requestId) : null;
  const settlementHandler = retained?.process === client.process ? retained?.handler : null;
  const handler = settlementHandler || (requestId ? client.runtimeOperationHandlers.get(requestId) : null);
  let result;
  if (cancelled && !settlementHandler) {
    client.logger?.('WARN', 'sidecar.late_runtime_operation', {
      request_id: requestId,
      incoming_method: 'runtime.operation',
      incoming_id: message.id,
      operation_id: String(params.operation_id || '').trim().slice(0, 256),
    });
    client._safeEmitNotificationEvent('late-notification', message);
    result = runtimeOperationRejected(params, 'request_cancelled',
      'Runtime operation arrived after the chat request was cancelled.');
  } else if (typeof handler !== 'function') {
    result = runtimeOperationRejected(params, 'request_not_active',
      'Runtime operation is not correlated with an active chat request.');
  } else {
    try {
      result = await handler(params);
    } catch (error) {
      result = runtimeOperationRejected(params, 'authority_check_failed', error?.message);
      emitSidecarErrorSafely(client, error instanceof Error ? error : new Error(String(error)),
        'runtime_operation_handler');
    }
  }
  const bounded = buildBoundedElectronToolBridgeResult(message.id, result);
  // Awaiting even a synchronous handler yields; never write an old producer's
  // response into a replacement sidecar's independently numbered RPC stream.
  if (client.process !== sourceProcess) return;
  client._writeFrame(bounded.response);
}

module.exports = {
  handleElectronToolRequest,
  handlePluginHostRequest,
  handleRuntimeOperationRequest,
  retainRuntimeSettlementHandler,
};
