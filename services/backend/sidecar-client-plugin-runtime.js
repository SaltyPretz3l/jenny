'use strict';

function initializePluginRuntime(client, payload, { timeoutMs, signal } = {}) {
  return client.request('initialize', {
    mode: 'plugin_runtime',
    plugin_runtime: payload.plugin_runtime,
  }, {
    timeoutMs,
    signal,
    initializeMode: 'plugin_runtime',
  });
}

module.exports = { initializePluginRuntime };
