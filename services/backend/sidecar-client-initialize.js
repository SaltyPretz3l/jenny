'use strict';

const { version: DEFAULT_CLIENT_VERSION } = require('../../package.json');
const { initializePluginRuntime } = require('./sidecar-client-plugin-runtime');
const { beginRuntimeInferenceInitialization, completeRuntimeInferenceInitialization } = require('../session-runtime/inference-protocol');

async function initializeSidecarClient(client, payload, { timeoutMs, signal, onProgress }, apiVersion) {
  if (payload?.mode === 'plugin_runtime') return initializePluginRuntime(client, payload, { timeoutMs, signal });
  const initialization = beginRuntimeInferenceInitialization(client);
  const { config = {}, secrets = {}, clientVersion = DEFAULT_CLIENT_VERSION } = payload || {};
  const requestId = `initialize-${client.nextId}`;
  client.notificationHandlers.set(requestId, typeof onProgress === 'function' ? onProgress : null);
  try {
    const result = await client.request('initialize', {
      accept_version: apiVersion,
      client_version: clientVersion,
      request_id: requestId,
      config,
      secrets,
    }, { timeoutMs, signal, requestKey: requestId, initializeMode: 'full_runtime' });
    completeRuntimeInferenceInitialization(client, initialization, result);
    return result;
  } finally { client.notificationHandlers.delete(requestId); }
}

module.exports = { initializeSidecarClient };
