'use strict';

// Diagnostics carries which llama-server build is running as one bounded token
// (runtime_label) and never the executable's path.

const test = require('node:test');
const assert = require('node:assert/strict');

const { getJennyStatus } = require('../services/backend/jenny-status-composer');

function serviceWithLlamaStatus(status) {
  return {
    getBackendStatus: () => ({ phase: 'ready', detail: '', error: '', appVersion: '1.0.0-test' }),
    currentStatus: { engine: 'openai-compatible', model: 'ternary-bonsai-2-27b-pq2_0', model_loaded: true, tools_status: {} },
    shellLogStore: {
      list: () => [],
      getCurrentDiagnosticsMetadata: () => ({ sources: {}, integrity: { complete: true, partial_reasons: [] } }),
    },
    toolPermissionStore: { getSnapshot: () => ({ version: 1, legacy_policies: {}, rules: [] }) },
    options: { getLlamaServerManager: () => ({ getStatus: () => ({ state: 'ready', ...status }) }) },
  };
}

test('runtime_label passes bounded build tokens through', async () => {
  for (const label of ['bundled', 'env', 'build 10683', 'custom', 'unknown', '']) {
    const status = await getJennyStatus(serviceWithLlamaStatus({ runtimeLabel: label }));
    assert.equal(status.runtime.llama_server.runtime_label, label);
  }
});

test('runtime_label drops anything path-like, oversized or non-string, and binaryPath never leaks', async () => {
  const binaryPath = 'C:\\Users\\example\\runtimes\\llama-prism-b10683-cuda13.3\\llama-server.exe';
  for (const label of [binaryPath, '/opt/llama/llama-server', 'build 1'.padEnd(33, '0'), 'build\n10683', 42, null, { build: 1 }]) {
    const status = await getJennyStatus(serviceWithLlamaStatus({ runtimeLabel: label, binaryPath }));
    assert.equal(status.runtime.llama_server.runtime_label, '', JSON.stringify(label));
    assert.equal(JSON.stringify(status.runtime.llama_server).includes('llama-server.exe'), false);
  }
});
