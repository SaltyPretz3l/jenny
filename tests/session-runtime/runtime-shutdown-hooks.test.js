'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createRuntimeShutdownController } = require('../../services/main/runtime-shutdown');

function shutdownFakes() {
  return {
    shutdownLlamaServerSyncImpl: () => ({ hadState: false }),
    shutdownManagedSidecarSyncImpl: () => ({ hadState: false }),
    shutdownAnyLocalOllamaSyncImpl: () => ({ skipped: 'no_owned_state' }),
  };
}

test('normal shutdown latches session runtime before awaiting cleanup stages', async () => {
  const order = [];
  const service = {
    sessionRuntime: {
      beginShutdown(options) {
        order.push(['runtime:begin', options]);
        return { requested: true, completion: Promise.resolve({ ok: true }) };
      },
    },
    async stop() { order.push('backend:stop'); },
  };
  const controller = createRuntimeShutdownController({
    app: { getPath: () => '' },
    clearSuggestionCache: () => {},
    getBackendService: () => service,
    getSetupService: () => ({ disposeActivePulls() { order.push('setup:drain'); } }),
    llamaServerManager: { async stop() { order.push('llama:stop'); }, stopSync() {} },
    log: () => {},
    ...shutdownFakes(),
  });

  await controller.stopRuntimeBeforeQuit();

  assert.deepEqual(order[0], ['runtime:begin', { reason: 'app_shutdown', timeoutMs: 1500 }]);
  assert.ok(order.indexOf('setup:drain') > 0);
  assert.ok(order.indexOf('backend:stop') > order.indexOf('setup:drain'));
});

test('emergency shutdown closes runtime before store drain without claiming cleanup', async () => {
  const order = [];
  const logs = [];
  const service = {
    sessionRuntime: {
      beginShutdown(options) {
        order.push(['runtime:begin', options]);
        return { requested: true, completion: Promise.reject(new Error('late drain failure')) };
      },
    },
    sessionStore: { dispose() { order.push('store:drain'); } },
  };
  const controller = createRuntimeShutdownController({
    app: { getPath: () => '' },
    getBackendService: () => service,
    llamaServerManager: { stopSync() {} },
    log: (level, event, fields) => logs.push({ level, event, fields }),
    ...shutdownFakes(),
  });

  controller.runEmergencyRuntimeShutdownSync();
  await new Promise(resolve => setImmediate(resolve));

  assert.deepEqual(order, [
    ['runtime:begin', { reason: 'emergency_shutdown', timeoutMs: 1500 }],
    'store:drain',
  ]);
  const terminal = logs.find(entry => entry.event === 'runtime.shutdown_stage'
    && entry.fields.stage === 'emergency_fallback');
  assert.equal(terminal.fields.confirmed, false);
  assert.equal(terminal.fields.runtimeShutdownRequested, true);
  assert.ok(logs.some(entry => entry.event === 'session_runtime.shutdown_unconfirmed'
    && entry.fields.reason === 'late drain failure'));
});
