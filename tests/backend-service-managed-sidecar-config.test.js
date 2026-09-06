const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const { BackendService } = require('../services/backend/backend-service');
const {
  DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL,
  DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
  DEFAULT_MANAGED_SHELL_MODEL,
} = require('../services/backend/backend-config');
const {
  applyManagedInitializePayload,
  buildManagedSidecarConfig,
  buildManagedSidecarSecrets,
  refreshManagedConfig,
} = require('../services/backend/managed-sidecar-lifecycle');
const { resolveManagedConfiguredModel, resolveMcpServerAuthSecrets } = require('../services/backend/managed-sidecar-config');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

const LEGACY_MANAGED_VLLM_MODEL = 'Qwen/Qwen3.5-9B';

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar startup vllm fallback switches catalog lookups to ollama', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-managed-model-catalog-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: LEGACY_MANAGED_VLLM_MODEL,
  });
  let capturedEngineType = '';
  service.sidecarClient = {
    async modelsList(engineType) {
      capturedEngineType = String(engineType || '');
      return {
        models: ['qwen3.5:9b', 'llava:7b'],
        available: true,
        reason: '',
      };
    },
  };

  applyManagedInitializePayload(service, {
    active_engine: 'mock',
    active_model: 'mock-v1',
  });

  const models = await service.listModels();

  assert.equal(service.currentEngineType, 'ollama');
  assert.equal(service.currentModel, '');
  assert.equal(service.currentStatus.engine, 'ollama');
  assert.equal(service.currentStatus.model, '');
  assert.equal(service.currentStatus.model_loaded, false);
  assert.equal(capturedEngineType, 'ollama');
  assert.equal(models.active_model, '');
  assert.deepEqual(models.data.map((entry) => entry.id), ['qwen3.5:9b', 'llava:7b']);
});

test('managed sidecar config forwards codex CLI runtime settings from integration patch', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-codex-cli-config-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'codex-cli/default',
    providerIntegrations: [
      {
        getManagedConfigPatch() {
          return {
            codex_cli_enabled: true,
            codex_cli_auth_ready: true,
            codex_cli_auth_reason: null,
            codex_cli_command: 'C:/Tools/codex.exe',
            codex_cli_runtime_root: path.join(userDataPath, 'codex-cli-engine'),
            codex_cli_models: ['codex-cli/gpt-5.5'],
            codex_cli_request_timeout_seconds: 900,
          };
        },
      },
    ],
  });
  service.currentEngineType = 'codex-cli';
  service.currentModel = 'codex-cli/default';

  const config = buildManagedSidecarConfig(service);

  assert.equal(config.engine_type, 'codex-cli');
  assert.equal(config.model, 'codex-cli/default');
  assert.equal(config.codex_cli_enabled, true);
  assert.equal(config.codex_cli_auth_ready, true);
  assert.equal(config.codex_cli_auth_reason, null);
  assert.equal(config.codex_cli_command, 'C:/Tools/codex.exe');
  assert.equal(config.codex_cli_runtime_root, path.join(userDataPath, 'codex-cli-engine'));
  assert.deepEqual(config.codex_cli_models, ['codex-cli/gpt-5.5']);
  assert.equal(config.codex_cli_request_timeout_seconds, 900);
});

test('managed sidecar config forwards internal MCP resource flag default-off', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-mcp-resource-config-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });

  const disabledConfig = buildManagedSidecarConfig(service);
  service.featureFlags = {
    ...(service.featureFlags || {}),
    mcp_resources: true,
  };
  const enabledConfig = buildManagedSidecarConfig(service);

  assert.equal(disabledConfig.tools_mcp_resources_enabled, false);
  assert.equal(enabledConfig.tools_mcp_resources_enabled, true);
});

test('managed sidecar config threads mcp_http_transport flag into mcpDiscoveryService.getSidecarConfig', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-mcp-http-transport-config-'));
  trackDirectory(userDataPath);

  const capturedArgs = [];
  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  service.mcpDiscoveryService = {
    getSidecarConfig(arg) {
      capturedArgs.push(arg);
      return {};
    },
  };

  buildManagedSidecarConfig(service);
  service.featureFlags = {
    ...(service.featureFlags || {}),
    mcp_http_transport: true,
  };
  buildManagedSidecarConfig(service);

  assert.equal(capturedArgs.length, 2);
  assert.deepEqual(capturedArgs[0], { httpTransportEnabled: false });
  assert.deepEqual(capturedArgs[1], { httpTransportEnabled: true });
});

test('managed sidecar config resolves a bearer secret_ref into auth.token and drops secret_ref', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-mcp-auth-bearer-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  const discoveryRow = Object.freeze({
    name: 'remote-tools',
    transport: 'sse',
    url: 'https://mcp.example.com/sse',
    auth: Object.freeze({ kind: 'bearer', secret_ref: 'mcp:remote-tools' }),
  });
  service.mcpDiscoveryService = {
    getSidecarConfig() {
      return { mcp_servers: [discoveryRow], mcp_sse_enabled: true };
    },
  };
  service.secureStore = {
    getMcpAuthToken(secretRef) {
      assert.equal(secretRef, 'mcp:remote-tools');
      return 'super-secret-bearer-token';
    },
  };

  const config = buildManagedSidecarConfig(service);

  assert.equal(config.mcp_servers.length, 1);
  const forwarded = config.mcp_servers[0];
  assert.equal(forwarded.name, 'remote-tools');
  assert.equal(forwarded.auth.kind, 'bearer');
  assert.equal(forwarded.auth.token, 'super-secret-bearer-token');
  assert.equal(forwarded.auth.client_secret, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(forwarded.auth, 'secret_ref'), false);

  // Discovery-returned row must not be mutated.
  assert.equal(Object.prototype.hasOwnProperty.call(discoveryRow.auth, 'token'), false);
  assert.equal(discoveryRow.auth.secret_ref, 'mcp:remote-tools');
});

test('managed sidecar config resolves an oauth_client_credentials secret_ref into auth.client_secret', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-mcp-auth-oauth-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  service.mcpDiscoveryService = {
    getSidecarConfig() {
      return {
        mcp_servers: [
          {
            name: 'oauth-server',
            transport: 'sse',
            url: 'https://mcp.example.com/sse',
            auth: {
              kind: 'oauth_client_credentials',
              secret_ref: 'mcp:oauth-server',
              token_url: 'https://mcp.example.com/oauth/token',
              client_id: 'jenny-client',
              scope: 'tools:read',
            },
          },
        ],
        mcp_sse_enabled: true,
      };
    },
  };
  service.secureStore = {
    getMcpAuthToken() {
      return 'super-secret-client-secret';
    },
  };

  const config = buildManagedSidecarConfig(service);

  const forwarded = config.mcp_servers[0];
  assert.equal(forwarded.auth.client_secret, 'super-secret-client-secret');
  assert.equal(forwarded.auth.token, undefined);
  assert.equal(forwarded.auth.token_url, 'https://mcp.example.com/oauth/token');
  assert.equal(forwarded.auth.client_id, 'jenny-client');
  assert.equal(forwarded.auth.scope, 'tools:read');
  assert.equal(Object.prototype.hasOwnProperty.call(forwarded.auth, 'secret_ref'), false);
});

test('managed sidecar config fails closed when secureStore is absent for an sse auth server', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-mcp-auth-no-store-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  service.mcpDiscoveryService = {
    getSidecarConfig() {
      return {
        mcp_servers: [
          {
            name: 'remote-tools',
            transport: 'sse',
            url: 'https://mcp.example.com/sse',
            auth: { kind: 'bearer', secret_ref: 'mcp:remote-tools' },
          },
        ],
        mcp_sse_enabled: true,
      };
    },
  };
  service.secureStore = null;

  assert.doesNotThrow(() => {
    const config = buildManagedSidecarConfig(service);
    const forwarded = config.mcp_servers[0];
    assert.equal(forwarded.auth.token, undefined);
    assert.equal(forwarded.auth.client_secret, undefined);
    assert.equal(forwarded.auth.kind, 'bearer');
  });
});

test('managed sidecar config fails closed and warns (without leaking the ref) when secureStore throws', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-mcp-auth-throws-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  service.mcpDiscoveryService = {
    getSidecarConfig() {
      return {
        mcp_servers: [
          {
            name: 'remote-tools',
            transport: 'sse',
            url: 'https://mcp.example.com/sse',
            auth: { kind: 'bearer', secret_ref: 'mcp:remote-tools-super-secret-ref' },
          },
        ],
        mcp_sse_enabled: true,
      };
    },
  };
  service.secureStore = {
    getMcpAuthToken() {
      throw new Error('safeStorage decrypt failed');
    },
  };
  const warnLogs = [];
  service._emitServiceLog = (level, event, details) => {
    warnLogs.push({ level, event, details });
  };

  assert.doesNotThrow(() => {
    const config = buildManagedSidecarConfig(service);
    const forwarded = config.mcp_servers[0];
    assert.equal(forwarded.auth.token, undefined);
    assert.equal(forwarded.auth.client_secret, undefined);
  });

  assert.equal(warnLogs.length, 1);
  assert.equal(warnLogs[0].level, 'WARN');
  assert.equal(warnLogs[0].event, 'mcp.auth_token_read_failed');
  assert.equal(warnLogs[0].details.server, 'remote-tools');
  const serialized = JSON.stringify(warnLogs);
  assert.equal(serialized.includes('mcp:remote-tools-super-secret-ref'), false);
});

test('managed sidecar config leaves a stdio-only mcp_servers payload byte-identical', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-mcp-auth-stdio-only-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  const stdioServers = [{ name: 'jenny_local_tools', transport: 'stdio', command: 'node', args: [] }];
  service.mcpDiscoveryService = {
    getSidecarConfig() {
      return { mcp_servers: stdioServers, mcp_sse_enabled: false };
    },
  };
  let secureStoreCalled = false;
  service.secureStore = {
    getMcpAuthToken() {
      secureStoreCalled = true;
      return 'unused';
    },
  };

  const config = buildManagedSidecarConfig(service);

  assert.deepEqual(config.mcp_servers, stdioServers);
  assert.equal(secureStoreCalled, false);
});

test('managed sidecar config skips resolution entirely when no mcp_servers key is present', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-mcp-auth-no-servers-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  service.mcpDiscoveryService = {
    getSidecarConfig() {
      return {};
    },
  };

  const config = buildManagedSidecarConfig(service);

  assert.equal(Object.prototype.hasOwnProperty.call(config, 'mcp_servers'), false);
});

test('resolveMcpServerAuthSecrets helper is directly importable and unit-testable', () => {
  const service = {
    secureStore: {
      getMcpAuthToken: () => 'direct-token',
    },
  };
  const servers = Object.freeze([
    Object.freeze({
      name: 'direct-server',
      transport: 'sse',
      auth: Object.freeze({ kind: 'bearer', secret_ref: 'mcp:direct-server' }),
    }),
  ]);

  const resolved = resolveMcpServerAuthSecrets(service, servers);

  assert.equal(resolved[0].auth.token, 'direct-token');
  assert.notEqual(resolved[0], servers[0]);
  assert.equal(Object.prototype.hasOwnProperty.call(servers[0].auth, 'token'), false);
});

test('managed sidecar config forwards internal automations flag default-off', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-automations-config-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });

  const disabledConfig = buildManagedSidecarConfig(service);
  service.featureFlags = {
    ...(service.featureFlags || {}),
    tools_automations_enabled: true,
  };
  const enabledConfig = buildManagedSidecarConfig(service);

  assert.equal(disabledConfig.tools_automations_enabled, false);
  assert.equal(enabledConfig.tools_automations_enabled, true);
});

test('managed sidecar initialize preserves tool classification metadata in status snapshot', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-tool-status-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });

  applyManagedInitializePayload(service, {
    active_engine: 'ollama',
    active_model: DEFAULT_MANAGED_SHELL_MODEL,
    tools_status: {
      web_search: {
        available: true,
        reason: '',
        display_name: 'Web Search',
        source_kind: 'builtin',
        tool_family: 'web',
      },
      list_dir: {
        available: false,
        reason: 'Workspace root is required.',
        displayName: 'List Directory',
        sourceKind: 'builtin',
        toolFamily: 'filesystem',
      },
    },
  });

  assert.equal(service.currentStatus.tools_status.web_search.source_kind, 'builtin');
  assert.equal(service.currentStatus.tools_status.web_search.tool_family, 'web');
  assert.equal(service.currentStatus.tools_status.list_dir.display_name, 'List Directory');
  assert.equal(service.currentStatus.tools_status.list_dir.source_kind, 'builtin');
  assert.equal(service.currentStatus.tools_status.list_dir.tool_family, 'filesystem');
});

test('managed sidecar initialize enriches worktree tool status with compact registry counts', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-worktree-status-'));
  trackDirectory(userDataPath);
  const workspaceRoot = path.join(userDataPath, 'workspace');
  const calls = [];

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: {
      getToolsWorkspaceRoot() {
        return workspaceRoot;
      },
    },
    worktreeService: {
      describeStatus(args) {
        calls.push(args);
        return {
          kind: 'worktree',
          active_root_configured: true,
          registry_count: 3,
          stale_count: 1,
          missing_count: 1,
          registry_readable: true,
        };
      },
    },
  });

  applyManagedInitializePayload(service, {
    active_engine: 'ollama',
    active_model: DEFAULT_MANAGED_SHELL_MODEL,
    tools_status: {
      worktree_list: {
        available: true,
        reason: '',
        display_name: 'List Worktrees',
        source_kind: 'builtin',
        tool_family: 'git',
      },
      list_dir: {
        available: true,
        reason: '',
        display_name: 'List Directory',
        source_kind: 'builtin',
        tool_family: 'filesystem',
      },
    },
  });

  assert.deepEqual(calls, [{ workspaceRoot }]);
  assert.equal(service.currentStatus.tools_status.worktree_list.kind, 'worktree');
  assert.equal(service.currentStatus.tools_status.worktree_list.registry_count, 3);
  assert.equal(service.currentStatus.tools_status.worktree_list.stale_count, 1);
  assert.equal(service.currentStatus.tools_status.worktree_list.missing_count, 1);
  assert.equal(service.currentStatus.tools_status.worktree_list.registry_readable, true);
  assert.equal(service.currentStatus.tools_status.worktree_list.active_root_configured, true);
  assert.equal(service.currentStatus.tools_status.list_dir.registry_count, undefined);
  assert.deepEqual(service.currentStatus.tools_available, ['worktree_list', 'list_dir']);
  assert.equal(JSON.stringify(service.currentStatus.tools_status).includes(workspaceRoot), false);
});

test('managed sidecar initialize preserves mcp startup diagnostics in status snapshot', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-mcp-status-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });

  applyManagedInitializePayload(service, {
    active_engine: 'ollama',
    active_model: DEFAULT_MANAGED_SHELL_MODEL,
    tools_status: {
      mcp__local_docs__search: {
        available: true,
        reason: '',
        display_name: 'Search Docs',
        source_kind: 'mcp',
        tool_family: 'filesystem',
        server_name: 'local_docs',
      },
    },
    mcp_servers: [
      { name: 'local_docs', transport: 'stdio' },
      { name: 'slow_docs', transport: 'stdio' },
    ],
    mcp_servers_connected: [],
    mcp_servers_failed: [
      {
        name: 'jenny_local_tools',
        code: 'CMP-MCP-0004',
        message: 'command path is outside trusted roots',
      },
    ],
    mcp_server_cooldowns: [
      { name: 'slow_docs', remaining_seconds: 30, reason: 'restart_failed' },
    ],
  });

  assert.equal(service.currentStatus.tools_status.mcp__local_docs__search.server_name, 'local_docs');
  assert.deepEqual(service.currentStatus.mcp_servers, [
    { name: 'local_docs', transport: 'stdio' },
    { name: 'slow_docs', transport: 'stdio' },
  ]);
  assert.deepEqual(service.currentStatus.mcp_servers_connected, []);
  assert.deepEqual(service.currentStatus.mcp_servers_failed, [
    {
      name: 'jenny_local_tools',
      code: 'CMP-MCP-0004',
      message: 'command path is outside trusted roots',
    },
  ]);
  assert.deepEqual(service.currentStatus.mcp_server_cooldowns, [
    { name: 'slow_docs', remaining_seconds: 30, reason: 'restart_failed' },
  ]);
});

test('managed sidecar initialize preserves schema-version registry rows in status snapshot', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-schema-status-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });

  applyManagedInitializePayload(service, {
    active_engine: 'ollama',
    active_model: DEFAULT_MANAGED_SHELL_MODEL,
    schema_versions: [
      {
        id: 'sidecar.memory_store',
        surface: 'Memory store',
        owner: 'sidecar',
        kind: 'sqlite_schema',
        version: 5,
        forward_policy: 'reject_future',
        source: 'sidecar/ai/memory/store_migrations.py',
      },
    ],
  });

  assert.deepEqual(service.currentStatus.schema_versions, [
    {
      id: 'sidecar.memory_store',
      surface: 'Memory store',
      owner: 'sidecar',
      kind: 'sqlite_schema',
      version: 5,
      forward_policy: 'reject_future',
      source: 'sidecar/ai/memory/store_migrations.py',
    },
  ]);
  const backendStatus = service.getBackendStatus();
  assert.equal(
    backendStatus.schemaVersions.some((entry) => entry.id === 'sidecar.memory_store'),
    true
  );
});

test('managed sidecar config includes the personality workspace root', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-personality-root-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    personalityWorkspace: {
      workspacePath: 'C:/Users/test/AppData/Roaming/Jenny/personality',
    },
  });

  const config = buildManagedSidecarConfig(service);

  // Personality v3: the sidecar never read this key; Electron no longer sends it.
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'personality_workspace_root'), false);
});

test('managed sidecar config forwards the agent name and no retired profile keys', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-identity-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: {
      getState() {
        return {
          // A v46 payload still carrying the retired keys must be tolerated
          // and ignored, not forwarded.
          assistantIdentity: {
            agentName: 'Echo',
            profile: 'creative',
            customText: 'curious and vivid',
          },
        };
      },
    },
  });

  const config = buildManagedSidecarConfig(service);

  assert.deepEqual(config.assistant_identity, { agent_name: 'Echo' });
  assert.equal(Object.prototype.hasOwnProperty.call(config, 'personality_profile'), false);
});

test('managed sidecar config refresh forwards assistant identity changes without restart', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-identity-refresh-'));
  trackDirectory(userDataPath);
  let identity = {
    agentName: 'Jenny',
    profile: 'balanced',
    customText: '',
  };
  const initializeConfigs = [];

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: {
      getState() {
        return { assistantIdentity: identity };
      },
    },
  });
  service.sidecarManager = {
    process: {},
    getStatus() { return { phase: 'ready' }; },
  };
  service.sidecarClient = {
    process: service.sidecarManager.process,
    connected: true,
    async initialize(payload) {
      initializeConfigs.push(payload.config.assistant_identity);
      return {
        active_engine: 'ollama',
        active_model: 'qwen3.5:9b',
      };
    },
  };
  service.refreshStatusSnapshot = async () => service.currentStatus;
  service._emitServiceLog = () => {};

  identity = {
    agentName: 'Echo',
    profile: 'concise',
    customText: 'warm but brief',
  };
  await refreshManagedConfig(service, 'assistant_identity_updated');

  assert.deepEqual(initializeConfigs.at(-1), { agent_name: 'Echo' });
});

test('managed sidecar config defers the ollama fallback model after startup vllm fallback', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-config-fallback-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: LEGACY_MANAGED_VLLM_MODEL,
  });

  applyManagedInitializePayload(service, {
    active_engine: 'mock',
    active_model: 'mock-v1',
  });

  const config = buildManagedSidecarConfig(service);

  assert.equal(config.engine_type, 'ollama');
  // Ollama boots unloaded; the fallback default loads lazily on first chat.
  assert.equal(config.model, '');
});

test('managed sidecar initialize payload populates managed context metadata', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-context-status-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: LEGACY_MANAGED_VLLM_MODEL,
  });

  applyManagedInitializePayload(service, {
    active_engine: 'vllm',
    active_model: LEGACY_MANAGED_VLLM_MODEL,
    native_context_length: 131072,
    configured_context_length: DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
    effective_context_length: 131072,
  });

  const status = await service.refreshStatusSnapshot();

  assert.equal(status.native_context_length, 131072);
  assert.equal(status.configured_context_length, DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH);
  assert.equal(status.effective_context_length, 131072);
});

test('managed sidecar unload clears managed context metadata', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-context-unload-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: LEGACY_MANAGED_VLLM_MODEL,
  });
  let unloadCalled = false;
  service.sidecarClient = {
    async modelsUnload() {
      unloadCalled = true;
    },
  };
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });

  applyManagedInitializePayload(service, {
    active_engine: 'vllm',
    active_model: LEGACY_MANAGED_VLLM_MODEL,
    native_context_length: 131072,
    configured_context_length: DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
    effective_context_length: 131072,
  });
  service.currentModel = LEGACY_MANAGED_VLLM_MODEL;
  service.currentEngineType = 'vllm';

  await service.unloadModel();

  assert.equal(unloadCalled, true);
  assert.equal(service.currentStatus.native_context_length, null);
  assert.equal(service.currentStatus.configured_context_length, null);
  assert.equal(service.currentStatus.effective_context_length, null);
});

test('managed sidecar startup fallback clears stale context metadata', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-context-fallback-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: LEGACY_MANAGED_VLLM_MODEL,
  });

  applyManagedInitializePayload(service, {
    active_engine: 'vllm',
    active_model: LEGACY_MANAGED_VLLM_MODEL,
    native_context_length: 131072,
    configured_context_length: DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
    effective_context_length: 131072,
  });
  applyManagedInitializePayload(service, {
    active_engine: 'mock',
    active_model: 'mock-v1',
    native_context_length: 131072,
    configured_context_length: DEFAULT_MANAGED_SHELL_CONTEXT_LENGTH,
    effective_context_length: 131072,
  });

  assert.equal(service.currentStatus.model, '');
  assert.equal(service.currentStatus.model_loaded, false);
  assert.equal(service.currentStatus.engine, 'ollama');
  assert.equal(service.currentStatus.native_context_length, null);
  assert.equal(service.currentStatus.configured_context_length, null);
  assert.equal(service.currentStatus.effective_context_length, null);
});

test('managed sidecar resolveModel lazy-loads the ollama fallback model after startup vllm fallback', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-managed-fallback-default-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: LEGACY_MANAGED_VLLM_MODEL,
  });
  let loadedModel = '';
  service.sidecarClient = {
    async modelsList(engineType) {
      assert.equal(engineType, 'ollama');
      return {
        models: ['qwen3.5:9b', 'llava:7b'],
        available: true,
        reason: '',
      };
    },
  };
  service.loadModel = async (model) => {
    loadedModel = String(model || '');
    service.currentModel = loadedModel;
    service.currentEngineType = 'ollama';
    return { status: 'ok', model: loadedModel };
  };

  applyManagedInitializePayload(service, {
    active_engine: 'mock',
    active_model: 'mock-v1',
  });

  const resolved = await service._resolveModel('');

  assert.equal(loadedModel, DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL);
  assert.equal(resolved, DEFAULT_MANAGED_OLLAMA_FALLBACK_MODEL);
});
