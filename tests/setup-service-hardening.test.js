'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { SetupService } = require('../services/setup-service');
const { SetupEndpointService } = require('../services/setup-endpoint-service');
const { OllamaPullService } = require('../services/ollama-pull-service');
const {
  shouldRefreshManagedConfigForShellConfigReason,
  shouldBroadcastFeatureState,
} = require('../services/main/main-process-policy');
const { createConfigService } = require('./helpers/setup-service-test-support');

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test('A1 updateState never persists completion; setupComplete:false still passes through', () => {
  const configService = createConfigService();
  const service = new SetupService({ configService });
  const state = service.updateState({
    setupComplete: true,
    setup_complete: true,
    completedAt: '2026-01-01T00:00:00.000Z',
    completed_at: '2026-01-01T00:00:00.000Z',
    seen: true,
  });
  const persisted = configService.getSetupState();
  assert.equal(persisted.setupComplete, false);
  assert.ok(!persisted.completedAt);
  assert.equal(persisted.seen, true, 'unrelated patch fields still persist');
  assert.equal(state.setup_complete, false);

  const done = createConfigService({ setup: { setupComplete: true, completedAt: '2026-01-01T00:00:00.000Z', steps: {} } });
  const doneService = new SetupService({ configService: done });
  doneService.updateState({ setupComplete: false });
  assert.equal(done.getSetupState().setupComplete, false);
});

test('A2 the factory-reset commit refreshes the managed config but stays a non-feature reason', () => {
  assert.equal(shouldRefreshManagedConfigForShellConfigReason('onboarding_reset'), true);
  assert.equal(shouldBroadcastFeatureState('onboarding_reset'), false);
});

test('A3 detectOllama probes only loopback hosts and drops userinfo', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(String(url)); throw new Error('ECONNREFUSED'); };
  const service = new SetupService({
    configService: createConfigService(), fetchImpl, commandLookupImpl: async () => '', fileExists: () => false,
  });
  await service.detectOllama({ host: 'http://user:pw@example.com:11434' });
  await service.detectOllama({ host: 'http://user:pw@127.0.0.1:11500' });
  await service.detectOllama({ host: 'http://192.168.1.5:11434' });
  assert.deepEqual(urls, [
    'http://127.0.0.1:11434/api/version',
    'http://127.0.0.1:11500/api/version',
    'http://127.0.0.1:11434/api/version',
  ]);
});

test('A4 endpoint validation and Ollama detection refuse redirects', async () => {
  const inits = [];
  const endpoint = new SetupEndpointService({
    fetchImpl: async (_url, init) => { inits.push(init); throw new TypeError('fetch failed'); },
  });
  const result = await endpoint.validate({ engineType: 'vllm', apiUrl: 'http://127.0.0.1:8000/v1' });
  assert.equal(result.code, 'request_failed');
  assert.equal(inits[0].redirect, 'error');

  const detectInits = [];
  const service = new SetupService({
    configService: createConfigService(),
    fetchImpl: async (_url, init) => { detectInits.push(init); throw new Error('ECONNREFUSED'); },
    commandLookupImpl: async () => '',
    fileExists: () => false,
  });
  await service.detectOllama();
  assert.equal(detectInits[0].redirect, 'error');
});

test('A5 startOllamaPullPublic returns a structured failure for an invalid model name', () => {
  let spawned = 0;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => { spawned += 1; return fakeChild(); },
  });
  let result;
  assert.doesNotThrow(() => { result = service.startOllamaPullPublic({ model: 'bad name; rm -rf' }); });
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'invalid_tag');
  assert.equal(spawned, 0);
});

test('A6 pull dedupe treats an implicit tag as :latest without changing the spawned name', async () => {
  const spawns = [];
  const service = new OllamaPullService({
    spawnImpl: (_cmd, args) => { spawns.push(args); return fakeChild(); },
    killProcessTreeImpl: async () => ({ terminated: true }),
  });
  const first = service.start({ model: 'llama3' });
  const second = service.start({ model: 'llama3:latest' });
  assert.equal(second, first);
  assert.deepEqual(spawns, [['pull', 'llama3']]);
  const refused = await service.delete({ model: 'llama3:latest' });
  assert.equal(refused.code, 'pull_in_progress');
  const cancelled = await service.cancel({ model: 'llama3:latest' });
  assert.equal(cancelled.status, 'cancelled');
});

test('A6 namespaced and hosted names stay distinct from their latest siblings', () => {
  const spawns = [];
  const service = new OllamaPullService({
    spawnImpl: (_cmd, args) => { spawns.push(args[1]); return fakeChild(); },
  });
  service.start({ model: 'hf.co/org/repo:Q4' });
  service.start({ model: 'org/model' });
  service.start({ model: 'org/model:latest' });
  assert.deepEqual(spawns, ['hf.co/org/repo:Q4', 'org/model']);
  service.signalActive();
});
