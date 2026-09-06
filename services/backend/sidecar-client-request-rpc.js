'use strict';

const { MAX_OUTBOUND_FRAME_BODY_BYTES } = require('./sidecar-client-transport-codec');
const {
  buildBoundedElectronToolBridgeResult,
  buildElectronToolBridgeErrorResponse,
  emitSidecarErrorSafely,
} = require('./sidecar-client-reverse-rpc');

async function handleElectronToolRequest(client, message) {
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
    client._writeFrame(bounded.response);
  } catch (error) {
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

module.exports = { handleElectronToolRequest, handlePluginHostRequest };
