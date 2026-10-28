'use strict';

const JSONRPC_VERSION = '2.0';
const ENGINE_ACTIVITY_METHOD = 'engine.activity';
const SESSION_RUN_MODE_UPDATED_METHOD = 'session.run_mode_updated';
const SESSION_MAIL_ARRIVED_METHOD = 'session.mail_arrived';

// Canonical stream_id is physical; turn_id may span multiple attempts.
function notificationRequestId(message) {
  const params = message?.params || {};
  const request = String(params.request_id || '').trim();
  if (message?.method !== 'turn.event') return request;
  const stream = String(params.stream_id || '').trim();
  if (stream && request && stream !== request) return null;
  return stream || request;
}

function canNotify(client) {
  return Boolean(client?.process?.stdin && client.connected);
}

function notifyEngineActivity(client) {
  if (!canNotify(client) || client._batch4TransportEnabled() !== true) return;
  client._writeFrame({
    jsonrpc: JSONRPC_VERSION,
    method: ENGINE_ACTIVITY_METHOD,
    params: {},
  }, {
    onThrow: () => {},
  });
}

function notifySessionRunModeUpdated(client, {
  sessionId,
  approvalMode,
  readOnly,
  reason,
} = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  if (
    !normalizedSessionId
    || !canNotify(client)
    || client._batch4TransportEnabled() !== true
  ) return;
  client._writeFrame({
    jsonrpc: JSONRPC_VERSION,
    method: SESSION_RUN_MODE_UPDATED_METHOD,
    params: {
      session_id: normalizedSessionId,
      approval_mode: approvalMode === 'auto_run' ? 'auto_run' : 'prompt',
      read_only: readOnly === true,
      ...(reason === 'unattended_idle' ? { reason } : {}),
    },
  }, {
    onThrow: () => {},
  });
}

// Mid-turn mail (row 70 W2a): context rows for the live chat.send `requestId` of
// `sessionId`. Returns true only when the frame was handed to the transport; the
// caller releases its reservation otherwise. Never logs the rows.
function notifySessionMailArrived(client, { sessionId, requestId, rows } = {}) {
  const normalizedSessionId = String(sessionId || '').trim();
  const normalizedRequestId = String(requestId || '').trim();
  if (
    !normalizedSessionId
    || !normalizedRequestId
    || !Array.isArray(rows)
    || rows.length === 0
    || !canNotify(client)
    || client._batch4TransportEnabled() !== true
  ) return false;
  let threw = false;
  const written = client._writeFrame({
    jsonrpc: JSONRPC_VERSION,
    method: SESSION_MAIL_ARRIVED_METHOD,
    params: { session_id: normalizedSessionId, request_id: normalizedRequestId, rows },
  }, {
    onThrow: () => { threw = true; },
  });
  return written === true && !threw;
}

module.exports = {
  notificationRequestId,
  notifyEngineActivity,
  notifySessionMailArrived,
  notifySessionRunModeUpdated,
};
