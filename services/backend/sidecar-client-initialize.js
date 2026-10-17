'use strict';

const { version: DEFAULT_CLIENT_VERSION } = require('../../package.json');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization } = require('../session-runtime/inference-protocol');

async function initializeSidecarClient(client, payload, { timeoutMs, signal, onProgress }, apiVersion) {
  const initialization = beginRuntimeInferenceInitialization(client);
  const { config = {}, secrets = {}, clientVersion = DEFAULT_CLIENT_VERSION, chatWorkspaceCapabilities } = payload || {};
  const requestId = `initialize-${client.nextId}`;
  client.notificationHandlers.set(requestId, typeof onProgress === 'function' ? onProgress : null);
  try {
    const result = await client.request('initialize', {
      accept_version: apiVersion,
      client_version: clientVersion,
      request_id: requestId,
      config,
      secrets,
      // Omitted when absent so a caller that predates the field sends the same request.
      ...(chatWorkspaceCapabilities === undefined ? {} : { chat_workspace_capabilities: chatWorkspaceCapabilities }),
    }, { timeoutMs, signal, requestKey: requestId });
    completeRuntimeInferenceInitialization(client, initialization, result);
    return result;
  } finally { client.notificationHandlers.delete(requestId); }
}

module.exports = { initializeSidecarClient };
