'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');

const { buildManagedSidecarSecrets } = require('../../services/backend/managed-sidecar-config');
const {
  ensureManagedLlamaServerReadyForChat,
  ensureManagedOllamaReadyForChat,
  ensureManagedSidecarReadyForChat,
} = require('../../services/backend/managed-sidecar-chat-reconnect');
const { initializeManagedSidecar } = require('../../services/backend/managed-sidecar-lifecycle');
const { BackendService } = require('../../services/backend/backend-service');
const { createHostedBackend } = require('../../services/host/service-composition');

class SidecarHarness extends EventEmitter {
  constructor() {
    super();
    this.isStopping = false;
    this.calls = [];
  }

  getStatus() {
    return { phase: 'stopped', detail: 'test harness' };
  }

  async start() {
    this.calls.push('start');
    return { phase: 'failed', detail: 'test harness does not spawn a sidecar' };
  }

  async retryStart() {
    this.calls.push('retryStart');
    return { phase: 'failed', detail: 'test harness does not spawn a sidecar' };
  }

  async stop() {
    this.calls.push('stop');
    return { exitConfirmed: true, forced: false };
  }
}

class EngineManagerHarness {
  constructor(name) {
    this.name = name;
    this.calls = [];
  }

  async start() {
    this.calls.push('start');
    return { started: true };
  }

  async stop() {
    this.calls.push('stop');
    return { stopped: true };
  }

  async unload() {
    this.calls.push('unload');
    return { unloaded: true };
  }
}

function createCredentialService() {
  const reads = [];
  return {
    reads,
    get(key) {
      reads.push(key);
      return key === 'openai_compatible_api_key' ? 'test-key' : '';
    },
    getStatus() {
      return { ready: true, status: 'ready' };
    },
  };
}

function makeTempUserDataPath() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-composition-'));
}

function removeTempUserDataPath(userDataPath) {
  fs.rmSync(userDataPath, { recursive: true, force: true });
}

test('hosted composition uses external endpoint policy across lifecycle and chat preflight', async (t) => {
  const userDataPath = makeTempUserDataPath();
  // Keep the fixture home separate even when CI checks out inside the real home.
  t.mock.method(os, 'homedir', () => path.join(userDataPath, 'home'));
  const sidecarManager = new SidecarHarness();
  const ollamaManager = new EngineManagerHarness('ollama');
  const vllmManager = new EngineManagerHarness('vllm');
  const credentialService = createCredentialService();
  const workspaceRoot = path.resolve(__dirname, '../..');
  const hosted = createHostedBackend({
    hostMode: 'server',
    credentialService,
    modelEndpoint: {
      engine: 'openai-compatible',
      model: 'host-model',
      apiUrl: 'http://127.0.0.1:8000/v1',
    },
    userDataPath,
    workspaceRoot,
    repoRoot: path.resolve(__dirname, '../..'),
    sidecarManager,
    ollamaManager,
    vllmManager,
  });

  try {
    assert.equal(hosted.backend.hostMode, 'server');
    assert.equal(hosted.backend.hostPorts.posture.ownsEngineLifecycle, false);
    assert.equal(hosted.configService.getToolsWorkspaceRoot(), workspaceRoot);

    const sidecarConfig = hosted.backend._buildManagedSidecarConfig();
    assert.equal(sidecarConfig.host_mode, 'server');
    assert.equal(sidecarConfig.host_execution_policy_version, 1);
    assert.equal(sidecarConfig.feature_flags.multiplexer, true);
    assert.equal(sidecarConfig.feature_flags.chat_cancel, true);
    assert.equal(sidecarConfig.tools_shell_enabled, false);
    assert.equal(sidecarConfig.tools_workspace_root, workspaceRoot);
    assert.equal(sidecarConfig.api_url, 'http://127.0.0.1:8000/v1');
    assert.equal(sidecarConfig.model, 'host-model');
    assert.equal(sidecarConfig.openai_compatible_api_key, undefined);

    const secrets = buildManagedSidecarSecrets(hosted.backend);
    assert.equal(secrets.openai_compatible_api_key, 'test-key');
    assert.deepEqual(credentialService.reads, ['openai_compatible_api_key']);
    hosted.backend.currentEngineType = 'chatgpt';
    hosted.backend.chatgptAuthService = { getCachedAccessToken: () => { throw new Error('must not read desktop credentials'); } };
    assert.deepEqual(buildManagedSidecarSecrets(hosted.backend), { openai_compatible_api_key: 'test-key' });
    hosted.backend.currentEngineType = 'openai-compatible';

    assert.equal(
      await ensureManagedOllamaReadyForChat(hosted.backend, { engineType: 'ollama' }),
      false
    );
    assert.equal(
      await ensureManagedLlamaServerReadyForChat(hosted.backend, { engineType: 'openai-compatible' }),
      false
    );

    await hosted.start();
    await hosted.stop();
    await assert.rejects(() => hosted.start(), /lifecycle has ended/);
    hosted.dispose();

    assert.deepEqual(ollamaManager.calls, []);
    assert.deepEqual(vllmManager.calls, []);
    assert.deepEqual(sidecarManager.calls, ['start', 'stop', 'stop']);
  } finally {
    hosted.dispose();
    removeTempUserDataPath(userDataPath);
  }
});

test('BackendService keeps desktop engine lifecycle ownership by default', async () => {
  const userDataPath = makeTempUserDataPath();
  const sidecarManager = new SidecarHarness();
  const ollamaManager = new EngineManagerHarness('ollama');
  const vllmManager = new EngineManagerHarness('vllm');
  const backend = new BackendService({
    userDataPath,
    defaultModel: 'desktop-model',
    sidecarManager,
    ollamaManager,
    vllmManager,
  });

  try {
    assert.equal(backend.hostMode, 'desktop');
    await backend.start();
    await backend.stop();
    backend.dispose();
    assert.deepEqual(ollamaManager.calls, ['start', 'stop']);
    assert.deepEqual(vllmManager.calls, ['stop', 'stop']);
  } finally {
    backend.dispose();
    removeTempUserDataPath(userDataPath);
  }
});

test('hosted composition rejects desktop mode and endpoint aliases at the boundary', () => {
  const userDataPath = makeTempUserDataPath();
  const credentialService = createCredentialService();
  try {
    assert.throws(
      () => createHostedBackend({
        hostMode: 'desktop',
        credentialService,
        modelEndpoint: { engine: 'replay', model: 'replay-model' },
        userDataPath,
      }),
      (error) => error.code === 'CMP-HOST-0001' && error.reason === 'server_host_mode_required'
    );
    assert.throws(
      () => createHostedBackend({
        hostMode: 'server',
        credentialService,
        modelEndpoint: {
          engine: 'openai-compatible',
          model: 'host-model',
          api_url: 'http://127.0.0.1:8000/v1',
        },
        userDataPath,
      }),
      (error) => error.code === 'CMP-HOST-0001' && error.reason === 'invalid_model_endpoint_url'
    );
  } finally {
    removeTempUserDataPath(userDataPath);
  }
});

test('hosted composition validates direct workspace-root input before creating stores', (t) => {
  const userDataPath = makeTempUserDataPath();
  t.after(() => removeTempUserDataPath(userDataPath));
  const filePath = path.join(userDataPath, 'not-a-directory');
  fs.writeFileSync(filePath, 'file');
  const base = {
    hostMode: 'server',
    credentialService: createCredentialService(),
    modelEndpoint: { engine: 'replay', model: 'test' },
    userDataPath,
  };
  for (const workspaceRoot of ['relative/path', filePath, userDataPath, os.homedir()]) {
    assert.throws(() => createHostedBackend({ ...base, workspaceRoot }),
      (error) => error.code === 'CMP-HOST-0001'
        && ['invalid_workspace_root', 'workspace_root_not_directory',
          'workspace_root_home_overlap', 'workspace_root_profile_overlap'].includes(error.reason));
  }
  assert.equal(fs.existsSync(path.join(userDataPath, 'sessions')), false);
});

test('a replacement sidecar cannot pass chat readiness using the prior process policy ACK', async () => {
  const userDataPath = makeTempUserDataPath();
  const sidecarManager = new SidecarHarness();
  sidecarManager.process = {};
  sidecarManager.getStatus = () => ({ phase: 'ready' });
  const hosted = createHostedBackend({ hostMode: 'server', credentialService: createCredentialService(),
    userDataPath, workspaceRoot: null, sidecarManager,
    modelEndpoint: { engine: 'openai-compatible', model: 'test', apiUrl: 'http://127.0.0.1:8000/v1' } });
  let payload = { host_execution_policy_version: 1, active_engine: 'openai-compatible',
    feature_flags: { multiplexer: true, chat_cancel: true } };
  const client = { connected: true, process: sidecarManager.process,
    initialize: async () => payload, dispose() {} };
  hosted.backend.sidecarClient = client;
  try {
    await initializeManagedSidecar(hosted.backend, { applyResult: false });
    assert.equal(await ensureManagedSidecarReadyForChat(hosted.backend, {}), false);
    for (const flags of [undefined, {}, { multiplexer: true }, { multiplexer: false, chat_cancel: true }]) {
      payload.feature_flags = flags;
      await assert.rejects(() => initializeManagedSidecar(hosted.backend, { applyResult: false }),
        (error) => error.error_code === 'CMP-HOST-0005' && error.category === 'transport');
      assert.equal(hosted.backend._hostedPolicyProcess, null);
    }
    sidecarManager.process = {};
    client.process = sidecarManager.process;
    payload = {};
    await assert.rejects(() => initializeManagedSidecar(hosted.backend, { applyResult: false }),
      (error) => error.error_code === 'CMP-HOST-0001');
    let reconnects = 0;
    hosted.backend._restartManagedSidecar = async () => { reconnects++; return false; };
    await assert.rejects(() => ensureManagedSidecarReadyForChat(hosted.backend, {}), /unavailable after reconnect/);
    assert.equal(reconnects, 1);
    assert.equal(hosted.backend._hostedPolicyProcess, null);
  } finally { hosted.dispose(); removeTempUserDataPath(userDataPath); }
});
