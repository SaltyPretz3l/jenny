const test = require('node:test');
const assert = require('node:assert/strict');

const { stopRuntimeWithDependencies } = require('../services/runtime-stop');

test('stopRuntimeWithDependencies stops services in order and emits shutdown done', async () => {
  const calls = [];

  await stopRuntimeWithDependencies({
    shellConfigService: {
      flushPendingWorkspaceWrite() {
        calls.push('flush');
      },
    },
    systemStats: {
      stop() {
        calls.push('stats.stop');
      },
    },
    schedulerService: {
      stop() {
        calls.push('scheduler.stop');
      },
    },
    backendService: {
      async stop(options = {}) {
        calls.push(`backend.stop:${options.ollamaShutdownScope}`);
        options.onProgress('sidecar_stopped', 'Sidecar stopped');
      },
    },
    clearSuggestionCacheImpl(value) {
      calls.push(`clear:${value.id}`);
    },
    suggestionCacheValue: { id: 'cache-1' },
    emitLifecycleProgressImpl(_scenario, phase, detail) {
      calls.push(`progress:${phase}:${detail}`);
    },
    logImpl() {},
    runEmergencyShutdownImpl() {
      calls.push('emergency');
    },
    shutdownStepIndexByPhase: { sidecar_stopped: 3 },
  });

  assert.deepEqual(calls, [
    'flush',
    'stats.stop',
    'scheduler.stop',
    'clear:cache-1',
    'backend.stop:any_local',
    'progress:sidecar_stopped:Sidecar stopped',
    'progress:done:Shutdown complete',
    'emergency',
  ]);
});

test('stopRuntimeWithDependencies still runs aggressive Ollama cleanup after stop failure', async () => {
  const calls = [];
  const logs = [];

  await stopRuntimeWithDependencies({
    backendService: {
      ollamaManager: {
        async stop(options = {}) {
          calls.push(`ollama.stop:${options.scope}`);
        },
      },
      async stop() {
        calls.push('backend.stop');
        throw new Error('sidecar failed');
      },
    },
    clearSuggestionCacheImpl() {
      calls.push('clear');
    },
    suggestionCacheValue: {},
    emitLifecycleProgressImpl(_scenario, phase, detail, _idx, _count, error) {
      calls.push(`progress:${phase}:${detail}:${error || ''}`);
    },
    logImpl(level, event, details) {
      logs.push({ level, event, details });
    },
    runEmergencyShutdownImpl() {
      calls.push('emergency');
    },
  });

  assert.deepEqual(calls, [
    'clear',
    'backend.stop',
    'ollama.stop:any_local',
    'progress:done:Shutdown complete:sidecar failed',
    'emergency',
  ]);
  assert.equal(logs[0].level, 'ERROR');
  assert.equal(logs[0].event, 'backend.stop_failed');
});

test('stopRuntimeWithDependencies still stops the backend gracefully when sandbox close fails', async () => {
  const calls = [];
  const logs = [];
  await stopRuntimeWithDependencies({
    backendService: {
      commandSandbox: {
        async close() {
          calls.push('sandbox.close');
          throw Object.assign(new Error('docker_operation_failed'), { reason: 'docker_operation_failed' });
        },
      },
      ollamaManager: { async stop() { calls.push('ollama.fallback'); } },
      async stop(options = {}) { calls.push(`backend.stop:${options.ollamaShutdownScope}`); },
    },
    clearSuggestionCacheImpl() {},
    suggestionCacheValue: {},
    emitLifecycleProgressImpl(_scenario, phase) { calls.push(`progress:${phase}`); },
    logImpl(level, event, details) { logs.push({ level, event, details }); },
    runEmergencyShutdownImpl() { calls.push('emergency'); },
  });
  assert.deepEqual(calls, ['sandbox.close', 'backend.stop:any_local', 'progress:done', 'emergency']);
  assert.deepEqual(logs, [{ level: 'WARN', event: 'command_sandbox.close_failed', details: { message: 'docker_operation_failed' } }]);
});
