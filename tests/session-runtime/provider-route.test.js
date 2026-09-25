'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isRuntimeRoute } = require('../../services/session-runtime/lanes');
const {
  assertSessionRuntimeProviderRouteCurrent,
  captureSessionRuntimeProviderRoute,
  restoreSessionRuntimeProviderRoute,
} = require('../../services/backend/session-runtime-provider-route');

function service(engineType, overrides = {}) {
  const state = {
    localEngines: {
      vllm: { port: 8000, maxModelLen: 32768 },
      openaiCompatible: { port: 8033, apiUrl: '' },
    },
    codexCli: { enabled: true, commandPath: '', models: [] },
  };
  return {
    currentEngineType: engineType,
    currentModel: 'model text must not classify a route',
    configService: { getState: () => state },
    ...overrides,
    _testState: state,
  };
}

test('built-in routes use closed trusted classifications and exact immutable fields', () => {
  const expected = new Map([
    ['ollama', ['local', true]],
    ['vllm', ['local', true]],
    ['mock', ['local', false]],
    ['replay', ['local', false]],
    ['chatgpt', ['cloud', false]],
    ['codex-cli', ['cloud', false]],
    ['openai-compatible', ['local', true]],
  ]);
  for (const [engineType, [resourceClass, requiresGpu]] of expected) {
    const auth = { hasCredential: () => true, getCredentialEpoch: () => 4 };
    const routeService = service(engineType, {
      chatgptAuthService: auth,
      _chatgptRuntimeCredentialEpoch: 4,
      codexCliRuntimeService: {
        getState: () => ({ status: 'ready', authType: 'chatgpt' }),
      },
      codexCliAuthService: { getCredentialEpoch: () => 3 },
    });
    const route = captureSessionRuntimeProviderRoute(routeService);
    assert.equal(isRuntimeRoute(route), true);
    assert.equal(Object.isFrozen(route), true);
    assert.deepEqual(Object.keys(route).sort(), [
      'configuration_revision', 'engine_type', 'provider_id', 'requires_gpu', 'resource_class',
    ]);
    assert.equal(route.engine_type, engineType);
    assert.equal(route.provider_id, engineType);
    assert.equal(route.resource_class, resourceClass);
    assert.equal(route.requires_gpu, requiresGpu);
    assert.match(route.configuration_revision, /^cfg:[a-f0-9]{64}$/u);
  }
});

test('model text and endpoint hostname cannot spoof openai-compatible locality', () => {
  const routeService = service('openai-compatible', {
    currentModel: 'chatgpt/cloud-please',
    hostMode: 'server',
    options: {
      modelEndpoint: {
        engine: 'openai-compatible',
        model: 'remote-model',
        apiUrl: 'https://models.example.test/v1',
        resource_class: 'cloud',
        requires_gpu: false,
        apiKey: 'placeholder-key-must-never-enter-route-or-digest-input',
      },
    },
  });
  const route = captureSessionRuntimeProviderRoute(routeService);
  assert.equal(route.resource_class, 'local');
  assert.equal(route.requires_gpu, true);
  assert.equal(JSON.stringify(route).includes('must-never-enter'), false);
});

test('trusted force-local selection can capture its verified engine without model inference', () => {
  const routeService = service('chatgpt', {
    currentModel: 'chatgpt/cloud-model',
    offlineIntelligenceService: {
      getState: () => ({
        mode: 'local_only',
        preferredLocalModel: 'attacker-controlled-model-text',
        selectedLocalEngineType: 'ollama',
      }),
    },
  });
  const route = captureSessionRuntimeProviderRoute(routeService, { engineType: 'ollama' });
  assert.deepEqual(
    [route.engine_type, route.resource_class, route.requires_gpu],
    ['ollama', 'local', true]
  );
  assert.throws(
    () => captureSessionRuntimeProviderRoute(routeService, {
      engineType: 'ollama',
      preferredModel: 'chatgpt/cloud-model',
    }),
    error => error.code === 'runtime_provider_capture_invalid'
  );
});

test('captured selection stays bound while config and credential changes fail revalidation', () => {
  let credentialEpoch = 7;
  const routeService = service('chatgpt', {
    chatgptAuthService: {
      hasCredential: () => true,
      getCredentialEpoch: () => credentialEpoch,
    },
    _chatgptRuntimeCredentialEpoch: 7,
  });
  const chatgptRoute = captureSessionRuntimeProviderRoute(routeService);
  routeService.currentEngineType = 'ollama';
  assert.equal(assertSessionRuntimeProviderRouteCurrent(routeService, chatgptRoute), chatgptRoute);
  credentialEpoch = 8;
  assert.throws(
    () => assertSessionRuntimeProviderRouteCurrent(routeService, chatgptRoute),
    error => error.code === 'runtime_provider_credentials_unavailable'
  );
  routeService._chatgptRuntimeCredentialEpoch = 8;
  assert.throws(
    () => assertSessionRuntimeProviderRouteCurrent(routeService, chatgptRoute),
    error => error.code === 'runtime_provider_credentials_changed'
  );

  const openAiService = service('openai-compatible');
  const openAiRoute = captureSessionRuntimeProviderRoute(openAiService);
  openAiService._testState.localEngines.openaiCompatible.apiUrl = 'https://changed.example.test/v1';
  assert.throws(
    () => assertSessionRuntimeProviderRouteCurrent(openAiService, openAiRoute),
    error => error.code === 'runtime_provider_configuration_changed'
  );
});

test('Codex CLI route detects nonsecret credential generation changes', () => {
  let credentialEpoch = 2;
  const routeService = service('codex-cli', {
    codexCliRuntimeService: {
      getState: () => ({ status: 'ready', authType: 'chatgpt' }),
    },
    codexCliAuthService: { getCredentialEpoch: () => credentialEpoch },
  });
  const route = captureSessionRuntimeProviderRoute(routeService);
  assert.equal(assertSessionRuntimeProviderRouteCurrent(routeService, route), route);
  credentialEpoch += 1;
  assert.throws(
    () => assertSessionRuntimeProviderRouteCurrent(routeService, route),
    error => error.code === 'runtime_provider_credentials_changed'
  );
});

test('only the trusted registry can classify plugin providers and unknown metadata fails closed', () => {
  let revision = 'plugin-config-1';
  const routeService = service('plugin-cloud', {
    sessionRuntimeProviderRouteRegistry: {
      resolve: engineType => ({
        route: {
          engine_type: engineType,
          provider_id: 'trusted-plugin',
          configuration_revision: revision,
          resource_class: 'cloud',
          requires_gpu: false,
        },
        credential: { required: true, available: true, revision: 'credential-1' },
      }),
    },
  });
  const route = captureSessionRuntimeProviderRoute(routeService);
  assert.equal(route.provider_id, 'trusted-plugin');
  revision = 'plugin-config-2';
  assert.throws(
    () => assertSessionRuntimeProviderRouteCurrent(routeService, route),
    error => error.code === 'runtime_provider_configuration_changed'
  );

  assert.throws(
    () => captureSessionRuntimeProviderRoute(service('unknown-provider', {
      modelMetadata: { resource_class: 'cloud', requires_gpu: false },
    })),
    error => error.code === 'runtime_provider_unsupported'
  );
  assert.throws(
    () => captureSessionRuntimeProviderRoute(service('plugin-cloud', {
      sessionRuntimeProviderRouteRegistry: { resolve: () => ({
        route: {
          engine_type: 'plugin-cloud', provider_id: 'plugin-cloud',
          configuration_revision: 'config-1', resource_class: 'cloud', requires_gpu: false,
          endpoint: 'https://attacker.example.test',
        },
        credential: { required: false, available: true, revision: 'none' },
      }) },
    })),
    error => error.code === 'runtime_provider_metadata_invalid'
  );
});

test('serialized routes cannot be used as captured revalidation authority', () => {
  const route = captureSessionRuntimeProviderRoute(service('mock'));
  const serialized = JSON.parse(JSON.stringify(route));
  assert.throws(
    () => assertSessionRuntimeProviderRouteCurrent(service('mock'), serialized),
    error => error.code === 'runtime_provider_route_untrusted'
  );
});

test('restore rebuilds a fresh capability for the persisted engine without retargeting selection', () => {
  const routeService = service('openai-compatible');
  const captured = captureSessionRuntimeProviderRoute(routeService);
  const persisted = JSON.parse(JSON.stringify(captured));
  routeService.currentEngineType = 'chatgpt';
  routeService.chatgptAuthService = { hasCredential: () => false };

  const restored = restoreSessionRuntimeProviderRoute(routeService, persisted);
  assert.notEqual(restored, captured);
  assert.equal(isRuntimeRoute(restored), true);
  assert.deepEqual(restored, persisted);
  assert.equal(assertSessionRuntimeProviderRouteCurrent(routeService, restored), restored);
});

test('restore compares stored evidence with trusted current configuration before issuing authority', () => {
  const routeService = service('openai-compatible');
  const persisted = JSON.parse(JSON.stringify(captureSessionRuntimeProviderRoute(routeService)));
  routeService._testState.localEngines.openaiCompatible.port = 9999;
  assert.throws(
    () => restoreSessionRuntimeProviderRoute(routeService, persisted),
    error => error.code === 'runtime_provider_configuration_changed'
  );
  assert.throws(
    () => restoreSessionRuntimeProviderRoute(routeService, { ...persisted, endpoint: 'spoofed' }),
    error => error.code === 'runtime_provider_route_invalid'
  );
  assert.throws(
    () => restoreSessionRuntimeProviderRoute(service('mock'), {
      ...persisted,
      engine_type: 'unknown-provider',
      provider_id: 'unknown-provider',
    }),
    error => error.code === 'runtime_provider_unsupported'
  );
});
