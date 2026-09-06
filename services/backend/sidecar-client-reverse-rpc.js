'use strict';

const { TOOL_ERROR_CODES } = require('./error-codes');
const {
  MAX_OUTBOUND_FRAME_BODY_BYTES,
  encodeFrame,
} = require('./sidecar-client-transport-codec');
const { redactSensitiveLikeText } = require('./tool-loop-input-sanitization');

const ELECTRON_TOOL_BRIDGE_ERROR_MESSAGE = 'Electron tool bridge failed.';
const MAX_ELECTRON_TOOL_BRIDGE_ERROR_MESSAGE_CHARS = 2048;

function buildElectronToolBridgeErrorResponse(id, messageText, { reason = '' } = {}) {
  const response = {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message: redactSensitiveLikeText(String(messageText || ELECTRON_TOOL_BRIDGE_ERROR_MESSAGE)
        .slice(0, MAX_ELECTRON_TOOL_BRIDGE_ERROR_MESSAGE_CHARS)),
      data: {
        code: TOOL_ERROR_CODES.EXECUTION_FAILED,
        category: 'electron_tool_bridge',
        retryable: false,
        ...(reason ? { reason } : {}),
      },
    },
  };
  if (encodeFrame(response).bodyLength > MAX_OUTBOUND_FRAME_BODY_BYTES) {
    response.error.message = ELECTRON_TOOL_BRIDGE_ERROR_MESSAGE;
  }
  return response;
}

function buildBoundedElectronToolBridgeResult(id, result) {
  const response = {
    jsonrpc: '2.0',
    id,
    result: result && typeof result === 'object' && !Array.isArray(result) ? result : {},
  };
  const { bodyLength } = encodeFrame(response);
  if (bodyLength <= MAX_OUTBOUND_FRAME_BODY_BYTES) {
    return { response, bodyLength, oversized: false };
  }
  return {
    response: buildElectronToolBridgeErrorResponse(
      id,
      'Electron tool bridge response exceeded the transport limit.',
      { reason: 'response_too_large' }
    ),
    bodyLength,
    oversized: true,
  };
}

function emitSidecarErrorSafely(client, error, source) {
  if (client.listenerCount('error') === 0) {
    client.logger?.('WARN', 'sidecar.async_handler_error', {
      source,
      message: String(error?.message || error || '').slice(0, 500),
    });
    return;
  }
  try {
    client.emit('error', error);
  } catch (listenerError) {
    client.logger?.('WARN', 'sidecar.error_listener_failed', {
      source,
      message: String(listenerError?.message || listenerError || '').slice(0, 500),
    });
  }
}

module.exports = {
  buildBoundedElectronToolBridgeResult,
  buildElectronToolBridgeErrorResponse,
  emitSidecarErrorSafely,
};
