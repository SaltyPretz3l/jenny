'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeShutdownController } = require('../services/main/runtime-shutdown');

function createProbe({ dispose, backend = {} } = {}) {
  const calls = [];
  const logs = [];
  const controller = createRuntimeShutdownController({
    app: { getPath: () => '' },
    clearSuggestionCache: () => {},
    getBackendService: () => ({
      toolExecutor: { browserUse: { dispose: () => { calls.push('browser_use'); return dispose?.(); } } },
      async stop() { calls.push('backend'); },
      ...backend,
    }),
    llamaServerManager: { stop: async () => { calls.push('llama'); }, stopSync() {} },
    // Every emergency edge is inert. Never signal the user's running processes.
    shutdownAnyLocalOllamaSyncImpl: () => ({ skipped: 'no_owned_state' }),
    shutdownManagedSidecarSyncImpl: () => ({ hadState: false }),
    shutdownLlamaServerSyncImpl: () => ({ hadState: false }),
    log: (level, event, fields) => logs.push({ level, event, fields }),
  });
  return { controller, calls, logs };
}

const stageLog = (logs, stage) => logs.find((entry) => entry.event === 'runtime.shutdown_stage' && entry.fields.stage === stage);

test('the browser pages are disposed in their own stage before llama-server stops', async () => {
  const probe = createProbe();
  await probe.controller.stopRuntimeBeforeQuit({});
  assert.ok(probe.calls.includes('browser_use'));
  assert.ok(probe.calls.indexOf('browser_use') < probe.calls.indexOf('llama'));
  assert.equal(stageLog(probe.logs, 'browser_use')?.fields.status, 'ok');
});

test('the stage waits for an asynchronous dispose to finish', async () => {
  let finished = false;
  const probe = createProbe({ dispose: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); finished = true; } });
  await probe.controller.stopRuntimeBeforeQuit({});
  assert.equal(finished, true);
  assert.ok(probe.calls.includes('llama'));
});

test('a throwing dispose is logged and shutdown carries on', async () => {
  const probe = createProbe({ dispose: () => { throw new Error('dispose failed'); } });
  await probe.controller.stopRuntimeBeforeQuit({});
  assert.equal(stageLog(probe.logs, 'browser_use')?.fields.status, 'failed');
  assert.ok(probe.calls.includes('llama'));
  assert.ok(probe.calls.includes('backend'));
});

test('a rejecting dispose is survived the same way', async () => {
  const probe = createProbe({ dispose: () => Promise.reject(new Error('later')) });
  await probe.controller.stopRuntimeBeforeQuit({});
  assert.equal(stageLog(probe.logs, 'browser_use')?.fields.status, 'failed');
  assert.ok(probe.calls.includes('llama'));
});

test('a backend with no browser service is simply skipped', async () => {
  const calls = [];
  const controller = createRuntimeShutdownController({
    app: { getPath: () => '' },
    clearSuggestionCache: () => {},
    getBackendService: () => ({ async stop() { calls.push('backend'); } }),
    llamaServerManager: { stop: async () => { calls.push('llama'); }, stopSync() {} },
    shutdownAnyLocalOllamaSyncImpl: () => ({ skipped: 'no_owned_state' }),
    shutdownManagedSidecarSyncImpl: () => ({ hadState: false }),
    shutdownLlamaServerSyncImpl: () => ({ hadState: false }),
  });
  await controller.stopRuntimeBeforeQuit({});
  assert.deepEqual(calls, ['llama', 'backend']);
});

test('an already cancelled shutdown does not dispose the browser', async () => {
  const probe = createProbe();
  const abort = new AbortController();
  abort.abort();
  await probe.controller.stopRuntimeBeforeQuit({ signal: abort.signal });
  assert.deepEqual(probe.calls, []);
});
