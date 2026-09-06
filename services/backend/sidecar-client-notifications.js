'use strict';

const JSONRPC_VERSION = '2.0';
const ENGINE_ACTIVITY_METHOD = 'engine.activity';
const SESSION_RUN_MODE_UPDATED_METHOD = 'session.run_mode_updated';

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

function notifySessionRunModeUpdated(client, { sessionId, approvalMode, readOnly } = {}) {
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
    },
  }, {
    onThrow: () => {},
  });
}

module.exports = {
  notifyEngineActivity,
  notifySessionRunModeUpdated,
};
