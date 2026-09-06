const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { SetupService } = require('../services/setup-service');
const {
  cloneSetup,
  createConfigService,
  DEFAULT_ASSISTANT_IDENTITY,
} = require('./helpers/setup-service-test-support');

test('setup service backfills readiness without auto-accepting explicit capability choices', () => {
  const configService = createConfigService({
    toolsWorkspaceRoot: 'C:/dev/jenny',
    workspaceRootStatus: { state: 'ready', message: 'Workspace root is configured.' },
  });
  const service = new SetupService({
    configService,
    mcpToolsDiscoveredProvider: () => false,
  });

  const state = service.getState();

  assert.equal(state.setup_complete, false);
  assert.equal(state.setup_state.steps.workspace_root, 'done');
  assert.equal(state.setup_state.steps.personality, 'done');
  assert.equal(state.setup_state.steps.skills, 'skipped');
  assert.equal(state.setup_state.readiness.workspace_root.ready, true);
  assert.equal(state.setup_state.readiness.workspace_root.status, 'ready');
  assert.equal(state.setup_state.readiness.personality.ready, true);
  assert.equal(state.setup_state.readiness.skills.skipped, true);
  assert.equal(configService.getSetupState().steps.workspaceRoot, 'done');
  assert.equal(configService.getSetupState().steps.personality, 'done');
  assert.equal(configService.getSetupState().steps.skills, 'skipped');
  assert.equal(state.setup_state.steps.capabilities, 'pending');
  assert.equal(state.setup_state.readiness.capabilities.ready, false);
  assert.equal(state.setup_state.readiness.capabilities.required, false);
  assert.equal(state.setup_state.readiness.capabilities.source, 'explicit_choice');
});

test('setup service keeps capability choices pending without blocking minimum readiness', () => {
  const configService = createConfigService({
    setup: {
      seen: true,
      dismissed: false,
      setupComplete: false,
      completedAt: '',
      updatedAt: '',
      steps: {
        workspaceRoot: 'done',
        localModel: 'done',
        endpoint: 'done',
        personality: 'done',
        skills: 'done',
        capabilities: 'pending',
      },
    },
    toolsWorkspaceRoot: 'C:/dev/jenny',
  });
  const service = new SetupService({
    configService,
    toolsListProvider: () => [{ name: 'mcp__filesystem__read_file', available: true }],
  });
  service.runtimeReadiness = {
    local_model_available: true,
    local_model_count: 1,
    local_endpoint_available: true,
    runtime_engine: 'ollama',
  };

  const state = service.getState();

  assert.equal(state.setup_state.steps.capabilities, 'pending');
  assert.equal(state.setup_state.readiness.capabilities.ready, false);
  assert.equal(state.setup_state.readiness.capabilities.required, false);
  // Persisted-incomplete profile still derives complete: capabilities never gates it.
  assert.equal(state.setup_complete, true);
});

test('setup service backfills local model and endpoint from readiness provider', async () => {
  const configService = createConfigService({
    toolsWorkspaceRoot: 'C:/dev/jenny',
    workspaceRootStatus: { state: 'ready', message: 'Workspace root is configured.' },
  });
  const service = new SetupService({
    configService,
    mcpToolsDiscoveredProvider: () => false,
    readinessProvider: async () => ({
      local_model_available: true,
      local_model_count: 2,
      local_endpoint_available: true,
      runtime_ready: true,
      runtime_model_loaded: false,
      runtime_engine: 'ollama',
    }),
  });

  const state = await service.refreshReadiness();

  assert.equal(state.setup_complete, true);
  assert.equal(state.setup_state.steps.local_model, 'done');
  assert.equal(state.setup_state.steps.endpoint, 'done');
  assert.equal(state.setup_state.readiness.local_model.ready, true);
  assert.equal(state.setup_state.readiness.local_model.model_count, 2);
  assert.equal(state.setup_state.readiness.endpoint.ready, true);
  assert.equal(configService.getSetupState().steps.localModel, 'done');
  assert.equal(configService.getSetupState().steps.endpoint, 'done');
});

test('setup service completes on a cloud engine via the remote endpoint signal', async () => {
  // Regression: with preferredEngineType 'chatgpt' the probe reported every
  // local signal false, hasCurrentMinimumReadiness never opened, and setup
  // could never complete -- the Home setup card showed 6/6 Done forever.
  const configService = createConfigService({
    toolsWorkspaceRoot: 'C:/dev/jenny',
    workspaceRootStatus: { state: 'ready', message: 'Workspace root is configured.' },
  });
  const service = new SetupService({
    configService,
    mcpToolsDiscoveredProvider: () => false,
    readinessProvider: async () => ({
      local_model_available: false,
      local_model_count: 0,
      local_endpoint_available: false,
      remote_endpoint_available: true,
      catalog_available: false,
      runtime_ready: true,
      runtime_model_loaded: false,
      runtime_engine: 'chatgpt',
    }),
  });

  const state = await service.refreshReadiness();

  assert.equal(state.setup_complete, true,
    'a reachable cloud route must satisfy the minimum-readiness gate');
  assert.equal(state.setup_state.readiness.endpoint.ready, true);
  assert.equal(state.setup_state.readiness.endpoint.engine_type, 'chatgpt');
  assert.equal(state.setup_state.steps.endpoint, 'done');
  // A cloud engine is not a local model: that step must stay untouched.
  assert.equal(state.setup_state.readiness.local_model.ready, false);
  assert.equal(state.setup_state.readiness.local_model.model_count, 0);
  assert.equal(state.setup_state.steps.local_model, 'pending');
  assert.equal(configService.getSetupState().steps.localModel, 'pending');
});

test('setup service refuses to complete when the cloud route is unreachable', async () => {
  const configService = createConfigService({
    toolsWorkspaceRoot: 'C:/dev/jenny',
    workspaceRootStatus: { state: 'ready', message: 'Workspace root is configured.' },
  });
  const service = new SetupService({
    configService,
    mcpToolsDiscoveredProvider: () => false,
    readinessProvider: async () => ({
      local_model_available: false,
      local_endpoint_available: false,
      remote_endpoint_available: false,
      catalog_available: false,
      runtime_ready: true,
      runtime_model_loaded: false,
      runtime_engine: 'chatgpt',
    }),
  });

  const state = await service.refreshReadiness();

  assert.equal(state.setup_complete, false);
  assert.equal(state.setup_state.readiness.endpoint.ready, false);
  assert.equal(state.setup_state.steps.endpoint, 'pending');
});

test('setup service logs readiness provider failures without falsely completing runtime steps', async () => {
  const logEvents = [];
  const service = new SetupService({
    configService: createConfigService(),
    mcpToolsDiscoveredProvider: () => false,
    readinessProvider: async () => {
      throw new Error('catalog offline');
    },
    logger: (level, event, details) => logEvents.push({ level, event, details }),
  });

  const state = await service.refreshReadiness();

  assert.equal(state.setup_state.steps.local_model, 'pending');
  assert.equal(state.setup_state.steps.endpoint, 'pending');
  assert.equal(state.setup_state.readiness.local_model.ready, false);
  assert.equal(state.setup_state.readiness.endpoint.ready, false);
  assert.equal(logEvents.some((entry) => entry.event === 'setup.readiness_probe_failed'), true);
});

test('setup service readiness backfill is idempotent across repeated refreshes', async () => {
  const configService = createConfigService({
    toolsWorkspaceRoot: 'C:/dev/jenny',
    workspaceRootStatus: { state: 'ready', message: 'Workspace root is configured.' },
  });
  const service = new SetupService({
    configService,
    mcpToolsDiscoveredProvider: () => false,
    readinessProvider: async () => ({
      local_model_available: true,
      local_model_count: 1,
      local_endpoint_available: true,
      runtime_engine: 'ollama',
    }),
  });

  await service.refreshReadiness();
  const afterFirst = configService.getSetupUpdateCount();
  await service.refreshReadiness();

  assert.equal(configService.getSetupUpdateCount(), afterFirst);
});

test('setup service reset response leaves cleared steps pending even when readiness exists', async () => {
  const configService = createConfigService({
    setup: {
      seen: true,
      dismissed: false,
      setupComplete: true,
      completedAt: '2026-05-07T12:00:00.000Z',
      updatedAt: '2026-05-07T12:00:00.000Z',
      steps: {
        workspaceRoot: 'done',
        localModel: 'done',
        endpoint: 'done',
        personality: 'done',
        skills: 'done',
      },
    },
    toolsWorkspaceRoot: 'C:/dev/jenny',
    workspaceRootStatus: { state: 'ready', message: 'Workspace root is configured.' },
  });
  const service = new SetupService({
    configService,
    mcpToolsDiscoveredProvider: () => false,
    readinessProvider: async () => ({
      local_model_available: true,
      local_endpoint_available: true,
      runtime_engine: 'ollama',
    }),
  });
  await service.refreshReadiness();

  const state = service.reset();

  assert.equal(state.setup_complete, false);
  assert.equal(state.setup_state.steps.workspace_root, 'pending');
  assert.equal(state.setup_state.steps.local_model, 'pending');
  assert.equal(state.setup_state.steps.endpoint, 'pending');
  assert.equal(state.setup_state.steps.personality, 'pending');
  assert.equal(state.setup_state.steps.skills, 'pending');
});

test('setup service ignores stale readiness probe results after reset', async () => {
  let resolveProbe;
  const service = new SetupService({
    configService: createConfigService({
      toolsWorkspaceRoot: 'C:/dev/jenny',
      workspaceRootStatus: { state: 'ready', message: 'Workspace root is configured.' },
    }),
    mcpToolsDiscoveredProvider: () => false,
    readinessProvider: () => new Promise((resolve) => {
      resolveProbe = resolve;
    }),
  });

  const refresh = service.refreshReadiness();
  const resetState = service.reset();
  resolveProbe({
    local_model_available: true,
    local_endpoint_available: true,
    runtime_engine: 'ollama',
  });
  await refresh;
  const state = service.getState();

  assert.equal(resetState.setup_state.steps.local_model, 'pending');
  assert.equal(resetState.setup_state.steps.endpoint, 'pending');
  assert.equal(state.setup_state.steps.local_model, 'pending');
  assert.equal(state.setup_state.steps.endpoint, 'pending');
});

test('setup service coalesces concurrent readiness refreshes', async () => {
  let providerCalls = 0;
  let resolveProbe;
  const service = new SetupService({
    configService: createConfigService(),
    mcpToolsDiscoveredProvider: () => false,
    readinessProvider: () => {
      providerCalls += 1;
      return new Promise((resolve) => {
        resolveProbe = resolve;
      });
    },
  });

  const first = service.refreshReadiness();
  const second = service.refreshReadiness();
  assert.equal(providerCalls, 1);
  resolveProbe({
    local_model_available: true,
    local_endpoint_available: true,
    runtime_engine: 'ollama',
  });
  const [firstState, secondState] = await Promise.all([first, second]);

  assert.equal(providerCalls, 1);
  assert.equal(firstState.setup_state.steps.local_model, 'done');
  assert.equal(secondState.setup_state.steps.local_model, 'done');
});

test('setup service requires current route readiness before deriving a new setup completion', () => {
  const service = new SetupService({
    configService: createConfigService({
      setup: {
        seen: true,
        dismissed: false,
        setupComplete: false,
        completedAt: '',
        updatedAt: '',
        steps: {
          workspaceRoot: 'done',
          localModel: 'done',
          endpoint: 'skipped',
          personality: 'done',
          skills: 'done',
        },
      },
      toolsWorkspaceRoot: 'C:/dev/jenny',
    }),
    toolsListProvider: () => [{ name: 'mcp__filesystem__read_file', available: true }],
  });

  const staleState = service.getState();
  assert.equal(staleState.setup_complete, false);

  service.runtimeReadiness = {
    local_model_available: true,
    local_model_count: 1,
    local_endpoint_available: true,
    runtime_engine: 'ollama',
  };
  const state = service.getState();

  assert.equal(state.setup_complete, true);
  assert.equal(state.setup_state.steps.workspace_root, 'done');
  assert.equal(state.setup_state.steps.local_model, 'done');
  assert.equal(state.setup_state.tools_workspace_root_configured, true);
  assert.equal(state.setup_state.mcp_tools_discovered, true);
});

test('setup complete rejects a degraded future completion but preserves minimum-ready and grandfathered paths', async () => {
  const logEvents = [];
  const degradedConfig = createConfigService({
    setup: {
      setupComplete: false,
      steps: { workspaceRoot: 'skipped', localModel: 'skipped', endpoint: 'skipped' },
    },
  });
  const degradedService = new SetupService({
    configService: degradedConfig,
    logger: (level, event, details) => logEvents.push({ level, event, details }),
  });

  const rejected = await degradedService.complete();
  assert.equal(rejected.setup_complete, false);
  assert.equal(degradedConfig.getSetupState().setupComplete, false);
  assert.ok(logEvents.some((entry) => entry.event === 'setup.complete_rejected'));

  const readyConfig = createConfigService({
    setup: {
      setupComplete: false,
      steps: { workspaceRoot: 'done', localModel: 'done', endpoint: 'pending' },
    },
    toolsWorkspaceRoot: 'C:/dev/jenny',
  });
  const readyService = new SetupService({ configService: readyConfig });
  readyService.runtimeReadiness = {
    local_model_available: true,
    local_model_count: 1,
    runtime_engine: 'ollama',
  };
  assert.equal((await readyService.complete()).setup_complete, true);
  assert.equal(readyConfig.getSetupState().setupComplete, true);

  const legacyConfig = createConfigService({ setup: { setupComplete: true, steps: {} } });
  const legacyService = new SetupService({ configService: legacyConfig });
  assert.equal((await legacyService.complete()).setup_complete, true, 'persisted true remains grandfathered');
});

test('setup service can derive MCP discovery from a lightweight provider', () => {
  let listToolsCount = 0;
  const service = new SetupService({
    configService: createConfigService(),
    toolsListProvider: () => {
      listToolsCount += 1;
      return [];
    },
    mcpToolsDiscoveredProvider: () => true,
  });

  const state = service.getState();

  assert.equal(state.setup_state.mcp_tools_discovered, true);
  assert.equal(listToolsCount, 0);
});

test('setup service updateState persists assistant identity alongside setup state', () => {
  const service = new SetupService({
    configService: createConfigService(),
  });

  const state = service.updateState({
    seen: true,
    assistantIdentity: {
      agentName: 'Juniper',
      profile: 'mentor',
      customText: 'Patient and practical.',
    },
  });

  assert.equal(state.setup_state.seen, true);
  assert.equal(state.setup_state.assistant_identity.agentName, 'Juniper');
  assert.equal(state.setup_state.assistant_identity.profile, 'mentor');
  assert.equal(state.setup_state.assistant_identity.customText, 'Patient and practical.');
});

test('setup service updateState ignores malformed assistant identity patches', () => {
  let identityUpdateCount = 0;
  const configService = {
    getSetupState: () => cloneSetup(),
    getAssistantIdentity: () => ({ ...DEFAULT_ASSISTANT_IDENTITY }),
    updateSetupState: () => cloneSetup(),
    updateAssistantIdentity: () => {
      identityUpdateCount += 1;
      return { agentName: 'Broken', profile: 'mentor', customText: '', updatedAt: '' };
    },
    getToolsWorkspaceRoot: () => '',
  };
  const service = new SetupService({ configService });

  const state = service.updateState({
    assistantIdentity: 'mentor',
  });

  assert.equal(identityUpdateCount, 0);
  assert.equal(state.setup_state.assistant_identity.agentName, 'Jenny');
});

test('setup service reset onboarding clears setup and identity but preserves workspace root', async () => {
  const configService = createConfigService({
    setup: {
      seen: true,
      dismissed: false,
      setupComplete: true,
      completedAt: '2026-05-07T12:00:00.000Z',
      updatedAt: '2026-05-07T12:00:00.000Z',
      steps: {
        workspaceRoot: 'done',
        localModel: 'done',
        endpoint: 'done',
        personality: 'done',
        skills: 'done',
      },
    },
    assistantIdentity: {
      agentName: 'Echo',
      profile: 'creative',
      customText: 'curious',
      updatedAt: '2026-05-07T12:00:00.000Z',
    },
    toolsWorkspaceRoot: 'C:/dev/jenny',
  });
  const service = new SetupService({ configService });

  const state = await service.factoryReset();

  assert.equal(state.setup_complete, false);
  assert.equal(state.setup_state.steps.workspace_root, 'pending');
  assert.equal(state.setup_state.tools_workspace_root_configured, true);
  assert.deepEqual(state.setup_state.assistant_identity, DEFAULT_ASSISTANT_IDENTITY);
  assert.equal(configService.getState().toolsWorkspaceRoot, 'C:/dev/jenny');
  assert.equal(state.factoryResetResult.completed, true);
});

test('setup service reports an unavailable onboarding transaction without mutating state', async () => {
  const configService = createConfigService({
    setup: { seen: true, setupComplete: true },
    assistantIdentity: { agentName: 'Echo', profile: 'creative' },
    toolsWorkspaceRoot: 'C:/dev/jenny',
  });
  configService.resetOnboarding = undefined;
  const service = new SetupService({ configService });

  const state = await service.factoryReset();

  assert.equal(state.factoryResetResult.completed, false);
  assert.equal(state.factoryResetResult.code, 'onboarding_reset_unavailable');
  assert.equal(configService.getState().toolsWorkspaceRoot, 'C:/dev/jenny');
  assert.equal(configService.getState().setup.setupComplete, true);
  assert.equal(configService.getState().assistantIdentity.agentName, 'Echo');
});

test('setup service returns a bounded reset failure without invoking the state-persisting getter', async () => {
  const configService = createConfigService({ setup: { seen: true, setupComplete: true } });
  configService.resetOnboarding = () => {
    throw Object.assign(new Error('disk unavailable'), { code: 'onboarding_reset_write_failed' });
  };
  const service = new SetupService({ configService });
  service.getState = () => {
    throw new Error('failure path must not use the persisting getter');
  };

  const state = await service.factoryReset();

  assert.equal(state.factoryResetResult.completed, false);
  assert.equal(state.factoryResetResult.code, 'onboarding_reset_write_failed');
  assert.equal(configService.getState().setup.setupComplete, true);
});

test('setup service validates only local endpoint types', async () => {
  const requested = [];
  const service = new SetupService({
    configService: createConfigService(),
    fetchImpl: async (url) => {
      requested.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => String(url).includes('/api/tags')
          ? ({ models: [{ name: 'qwen3:8b' }] })
          : ({ data: [{ id: 'local-model' }] }),
      };
    },
  });

  const ollama = await service.validateEndpoint({ engineType: 'ollama', apiUrl: 'http://127.0.0.1:11434' });
  const openaiCompat = await service.validateEndpoint({
    engineType: 'openai-compatible',
    apiUrl: 'http://127.0.0.1:8033/v1',
  });
  const cloud = await service.validateEndpoint({
    engineType: 'openai',
    apiUrl: 'https://api.openai.com/v1',
  });

  assert.equal(ollama.ok, true);
  assert.equal(openaiCompat.ok, true);
  assert.equal(cloud.ok, false);
  assert.equal(cloud.code, 'unsupported_engine');
  assert.deepEqual(requested, [
    'http://127.0.0.1:11434/api/tags',
    'http://127.0.0.1:8033/v1/models',
  ]);
});

test('setup service strips endpoint query strings before appending probe paths', async () => {
  const requested = [];
  const service = new SetupService({
    configService: createConfigService(),
    fetchImpl: async (url) => {
      requested.push(String(url));
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'local-model' }] }) };
    },
  });

  const result = await service.validateEndpoint({
    engineType: 'openai-compatible',
    apiUrl: 'http://127.0.0.1:8033/v1?source=settings',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requested, ['http://127.0.0.1:8033/v1/models']);
});

test('setup save marks endpoint done only after managed configuration refresh succeeds', async () => {
  const configService = createConfigService();
  const writes = [];
  configService.saveSetupEndpoint = (payload) => {
    writes.push(payload);
    return { saved: true };
  };
  const failedRefresh = new SetupService({
    configService,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) }),
    refreshManagedConfig: async () => { throw new Error('refresh failed'); },
  });
  const failed = await failedRefresh.saveEndpoint({ engineType: 'ollama' });
  assert.equal(failed.endpoint_result.code, 'config_refresh_failed');
  assert.equal(configService.getSetupState().steps.endpoint, 'pending');

  const successful = new SetupService({
    configService,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) }),
    refreshManagedConfig: async () => ({ ok: true }),
    readinessProvider: async () => ({
      local_model_available: true,
      local_model_count: 1,
      local_endpoint_available: true,
      runtime_engine: 'ollama',
    }),
  });
  const saved = await successful.saveEndpoint({ engineType: 'ollama' });
  assert.equal(saved.endpoint_result.ok, true);
  assert.equal(configService.getSetupState().steps.endpoint, 'done');
  assert.equal(writes.length, 2, 'every save must revalidate and persist through the canonical service');
});

test('setup save retains a pending endpoint step when live readiness cannot confirm the saved route', async () => {
  const configService = createConfigService();
  configService.saveSetupEndpoint = () => ({ saved: true });
  const service = new SetupService({
    configService,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ models: [{ name: 'qwen3:8b' }] }) }),
    refreshManagedConfig: async () => ({ ok: true }),
    readinessProvider: async () => ({
      local_model_available: false,
      local_endpoint_available: false,
      runtime_engine: 'ollama',
    }),
  });

  const saved = await service.saveEndpoint({ engineType: 'ollama' });
  assert.equal(saved.endpoint_result.code, 'readiness_unavailable');
  assert.equal(saved.endpoint_result.retryable, true);
  assert.equal(configService.getSetupState().steps.endpoint, 'pending');
});

test('setup service rejects public OpenAI-compatible endpoints without probing them', async () => {
  const requested = [];
  const service = new SetupService({
    configService: createConfigService(),
    fetchImpl: async (url) => {
      requested.push(String(url));
      return { ok: true, status: 200 };
    },
  });

  const result = await service.validateEndpoint({
    engineType: 'openai-compatible',
    apiUrl: 'https://api.openai.com/v1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'non_local_endpoint');
  assert.deepEqual(requested, []);
});

test('setup service does not treat public hostnames with IPv6-like prefixes as local', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });

  const result = await service.validateEndpoint({
    engineType: 'openai-compatible',
    apiUrl: 'https://fc-example.com/v1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'non_local_endpoint');
});

test('setup service reports invalid URLs before local endpoint checks', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    fetchImpl: async () => {
      throw new Error('fetch should not be called for invalid URLs');
    },
  });

  const result = await service.validateEndpoint({
    engineType: 'vllm',
    apiUrl: 'ftp://127.0.0.1:8000',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_url');
});

test('setup service times out endpoint validation probes', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    endpointTimeoutMs: 5,
    fetchImpl: (_url, options = {}) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('probe aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });

  const result = await service.validateEndpoint({
    engineType: 'ollama',
    apiUrl: 'http://127.0.0.1:11434',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'request_timeout');
});

test('setup service reuses an active Ollama pull and emits progress', async () => {
  const progressEvents = [];
  let spawnCount = 0;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      spawnCount += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        child.killed = true;
      };
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('pulling manifest\n'));
        child.stdout.emit('data', Buffer.from('success\n'));
        child.emit('exit', 0);
      });
      return child;
    },
    requestIdProvider: () => 'pull-test-1',
  });
  service.on('model-pull-progress', (event) => progressEvents.push(event));

  const first = service.startOllamaPull({ model: 'llama3.2:latest' });
  const second = service.startOllamaPull({ model: 'llama3.2:latest' });
  const result = await first.promise;

  assert.equal(first.requestId, 'pull-test-1');
  assert.equal(second.requestId, 'pull-test-1');
  assert.equal(spawnCount, 1);
  assert.equal(result.status, 'completed');
  assert.equal(progressEvents.at(-1).status, 'completed');
  assert.ok(progressEvents.length >= 2, 'start and terminal transitions must always emit');
});

test('setup service avoids request id collisions across active Ollama pulls', () => {
  let spawnCount = 0;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      spawnCount += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      return child;
    },
    requestIdProvider: () => 'generated-second',
  });

  const first = service.startOllamaPull({ model: 'llama3.2:latest', requestId: 'shared-request' });
  const second = service.startOllamaPull({ model: 'qwen3:latest', requestId: 'shared-request' });

  assert.equal(first.requestId, 'shared-request');
  assert.equal(second.requestId, 'generated-second');
  assert.equal(spawnCount, 2);
});

test('setup service fails Ollama pulls that exit by signal without an exit code', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => child.emit('exit', null, 'SIGTERM'));
      return child;
    },
    requestIdProvider: () => 'pull-signal-1',
  });

  const pull = service.startOllamaPull({ model: 'llama3.2:latest' });
  const result = await pull.promise;

  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, null);
  assert.match(result.error, /SIGTERM/);
});

test('setup service surfaces the real ollama error line on a failed pull', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('pulling manifest\n'));
        child.stderr.emit('data', Buffer.from('Error: pull model manifest: file does not exist\n'));
        child.emit('exit', 1);
      });
      return child;
    },
    requestIdProvider: () => 'pull-fail-1',
  });

  const pull = service.startOllamaPull({ model: 'llama3.2:latest' });
  const result = await pull.promise;

  assert.equal(result.status, 'failed');
  assert.equal(result.exitCode, 1);
  assert.match(result.error, /Error: pull model manifest: file does not exist/);
  assert.match(result.error, /code 1/);
});

test('a benign line containing "errors" does not mask the failure output', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        // Substring "errors" mid-line must NOT be captured as the error line;
        // the surfaced text must fall back to the actual last output.
        child.stdout.emit('data', Buffer.from('verifying layers: 0 errors so far\n'));
        child.stderr.emit('data', Buffer.from('pull failed: connection reset by peer\n'));
        child.emit('exit', 1);
      });
      return child;
    },
    requestIdProvider: () => 'pull-fail-2',
  });

  const pull = service.startOllamaPull({ model: 'llama3.2:latest' });
  const result = await pull.promise;

  assert.equal(result.status, 'failed');
  assert.match(result.error, /pull failed: connection reset by peer/);
  assert.doesNotMatch(result.error, /0 errors so far/);
});

test('an anchored Error line wins over later progress output on failure', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stderr.emit('data', Buffer.from('Error: registry unreachable\n'));
        child.stdout.emit('data', Buffer.from('retrying download\n'));
        child.emit('exit', 1);
      });
      return child;
    },
    requestIdProvider: () => 'pull-fail-3',
  });

  const pull = service.startOllamaPull({ model: 'llama3.2:latest' });
  const result = await pull.promise;

  assert.equal(result.status, 'failed');
  assert.match(result.error, /Error: registry unreachable/);
});

test('setup service leaves error empty on a successful pull', async () => {
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('pulling manifest\n'));
        child.stdout.emit('data', Buffer.from('success\n'));
        child.emit('exit', 0);
      });
      return child;
    },
    requestIdProvider: () => 'pull-success-1',
  });

  const pull = service.startOllamaPull({ model: 'llama3.2:latest' });
  const result = await pull.promise;

  assert.equal(result.status, 'completed');
  assert.equal(result.error, '');
});

test('setup service pull-progress events carry model and requestId for renderer-side filtering', async () => {
  const events = [];
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('pulling manifest\n'));
        child.emit('exit', 0);
      });
      return child;
    },
    requestIdProvider: () => 'pull-tagged-1',
  });
  service.on('model-pull-progress', (event) => events.push(event));

  const pull = service.startOllamaPull({ model: 'llama3.2:latest' });
  await pull.promise;

  assert.ok(events.length > 0);
  for (const event of events) {
    assert.equal(event.model, 'llama3.2:latest');
    assert.equal(event.requestId, 'pull-tagged-1');
  }
});

test('cancelOllamaPull terminates the owned process tree and confirms exit', async () => {
  let killed = false;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 4321;
      child.kill = () => {
        killed = true;
      };
      return child;
    },
    requestIdProvider: () => 'pull-cancel-1',
    killProcessTreeImpl: async (pid, options) => {
      assert.equal(pid, 4321);
      assert.equal(options.confirmExit, true);
      killed = true;
      return { terminated: true };
    },
  });

  service.startOllamaPull({ model: 'llama3.2:latest' });
  const result = await service.cancelOllamaPull({ model: 'llama3.2:latest' });

  assert.equal(result.cancelled, true);
  assert.equal(result.termination_confirmed, true);
  assert.equal(killed, true);
});

test('setup service accepts Ollama model tags with quantization underscores (e.g. ornith:9b-q8_0)', () => {
  let spawnedArgs = null;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: (_cmd, args) => {
      spawnedArgs = args;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      return child;
    },
  });

  service.startOllamaPull({ model: 'ornith:9b-q8_0' });

  assert.deepEqual(spawnedArgs, ['pull', 'ornith:9b-q8_0']);
});

test('setup service still rejects Ollama model names with embedded newlines or empty strings', () => {
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => new EventEmitter(),
  });

  assert.throws(
    () => service.startOllamaPull({ model: 'llama3.2\nlatest' }),
    /valid Ollama model name/
  );
  assert.throws(
    () => service.startOllamaPull({ model: '' }),
    /valid Ollama model name/
  );
});

test('setup service rejects option-shaped Ollama model names before spawning', () => {
  let spawnCount = 0;
  const service = new SetupService({
    configService: createConfigService(),
    spawnImpl: () => {
      spawnCount += 1;
      return new EventEmitter();
    },
  });

  assert.throws(
    () => service.startOllamaPull({ model: '--help' }),
    /valid Ollama model name/
  );
  assert.equal(spawnCount, 0);
});
