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
const { GENERAL_PROJECT_ID } = require('../../services/projects/project-schema');

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

test('normal policy-2 composition still requires an execution broker', () => {
  assert.throws(() => createHostedBackend({ hostMode: 'server', userDataPath: 'unused',
    hostExecutionPolicyVersion: 2, modelEndpoint: { engine: 'replay', model: 'offline' } }),
  (error) => error.reason === 'execution_broker_required');
});

function makeTempUserDataPath() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-host-composition-'));
}

function removeTempUserDataPath(userDataPath) {
  fs.rmSync(userDataPath, { recursive: true, force: true });
}

function createDiagnosticHost(t) {
  const userDataPath = makeTempUserDataPath();
  const hosted = createHostedBackend({
    hostMode: 'server', userDataPath, workspaceRoot: null,
    credentialService: createCredentialService(),
    modelEndpoint: { engine: 'replay', model: 'offline' },
    sidecarManager: new SidecarHarness(),
    ollamaManager: new EngineManagerHarness('ollama'),
    vllmManager: new EngineManagerHarness('vllm'),
  });
  t.after(async () => {
    await hosted.dispose();
    removeTempUserDataPath(userDataPath);
  });
  return { ...hosted, userDataPath };
}

function readHostedLog(hosted) {
  return fs.readFileSync(path.join(hosted.userDataPath, 'logs', 'shell.log'), 'utf8')
    .trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('hosted service logs persist desktop canonical entries and shutdown events before stop resolves', async (t) => {
  const hosted = createDiagnosticHost(t);
  hosted.backend.emit('service-log', { level: 'WARN', event: 'backend.test_warning',
    details: { message: 'A bounded warning', status: 'failed', stage: 'process_exit' } });
  hosted.backend.emit('service-log', { event: 'backend.test_default', details: { reason: 'metadata only' } });
  hosted.backend.emit('service-log', { level: 'DEBUG', event: 'backend.test_debug' });
  const result = await hosted.stop();
  const entries = readHostedLog(hosted);
  const warning = entries.find((entry) => entry.event === 'backend.test_warning');
  assert.equal(warning.level, 'WARN');
  assert.equal(warning.layer, 'electron');
  assert.equal(warning.component, 'electron.main');
  assert.equal(warning.message, 'A bounded warning');
  assert.equal(warning.status, 'failed');
  assert.deepEqual(warning.data, { message: 'A bounded warning', status: 'failed', stage: 'process_exit' });
  assert.deepEqual(warning.details, warning.data);
  assert.equal(warning.schema_version, 1);
  assert.equal(warning.redaction_mode, 'redacted');
  assert.equal(warning.run_id, hosted.logStore.runId);
  assert.ok(warning.entry_id);
  assert.ok(warning.ts);
  assert.equal(entries.find((entry) => entry.event === 'backend.test_default').message, 'backend.test_default');
  assert.equal(entries.some((entry) => entry.event === 'backend.test_debug'), false);
  assert.ok(entries.some((entry) => entry.event === 'backend.sidecar_shutdown_stage'
    && entry.data.stage === 'process_exit' && entry.status === 'ok'));
  assert.equal(hosted.backend.shellLogStore, hosted.logStore);
  assert.equal(result.exitConfirmed, true);
  assert.equal(result.logFlush.flushed, true);
});

test('hosted mirrored sidecar diagnostics persist with secrets redacted', async (t) => {
  const hosted = createDiagnosticHost(t);
  hosted.backend.emit('diagnostic-entry', {
    level: 'INFO', layer: 'sidecar', component: 'sidecar.runtime', event: 'sidecar.test_record',
    message: 'Authorization: Bearer synthetic-host-secret-12345',
    data: { stage: 'ready', api_key: ['sk', 'synthetic-host-secret-12345'].join('-') },
  });
  await hosted.stop();
  const entry = readHostedLog(hosted).find((item) => item.event === 'sidecar.test_record');
  assert.ok(entry);
  assert.equal(entry.layer, 'sidecar');
  assert.equal(entry.component, 'sidecar.runtime');
  assert.equal(entry.data.stage, 'ready');
  assert.doesNotMatch(JSON.stringify(entry), /synthetic-host-secret/);
  assert.match(entry.message, /\[redacted\]/);
  assert.equal(entry.data.api_key, '[redacted]');
});

test('hosted diagnostic drops and oversized sidecar records update integrity', async (t) => {
  const hosted = createDiagnosticHost(t);
  hosted.backend.emit('diagnostic-drop', { source: 'sidecar', count: 3 });
  hosted.backend.emit('diagnostic-entry', { layer: 'sidecar', event: 'sidecar.diagnostics.oversized_record',
    data: { dropped_count: 2 } });
  hosted.backend.emit('diagnostic-entry', { layer: 'sidecar', event: 'sidecar.diagnostics.oversized_record' });
  const metadata = hosted.logStore.getCurrentDiagnosticsMetadata();
  assert.equal(metadata.integrity.dropped_by_source.sidecar, 6);
  assert.equal(metadata.integrity.complete, false);
  assert.ok(metadata.integrity.partial_reasons.includes('entries_dropped'));
});

test('hosted file write failure stays contained and backend remains usable', async (t) => {
  const hosted = createDiagnosticHost(t);
  fs.mkdirSync(path.join(hosted.userDataPath, 'logs', 'shell.log'), { recursive: true });
  assert.doesNotThrow(() => hosted.backend.emit('service-log', {
    level: 'INFO', event: 'backend.test_failed_sink', details: { message: 'Still running' },
  }));
  await hosted.logStore.writer.flush();
  assert.equal(hosted.logStore.writer.fileDisabled, true);
  assert.doesNotThrow(() => hosted.backend.emit('diagnostic-entry', {
    layer: 'sidecar', event: 'sidecar.after_sink_failure', message: 'Still running',
  }));
  const session = await hosted.backend.createSession({ title: 'After sink failure' });
  assert.ok(session.data.id);
  const metadata = hosted.logStore.getCurrentDiagnosticsMetadata();
  assert.equal(metadata.integrity.complete, false);
  assert.ok(metadata.integrity.partial_reasons.includes('history_writer_unavailable'));
  assert.ok(hosted.logStore.list().some((entry) => entry.event === 'sidecar.after_sink_failure'));
});

test('hosted thrown writer errors never escape backend diagnostic emits', async (t) => {
  const hosted = createDiagnosticHost(t);
  t.mock.method(hosted.logStore.writer, 'write', () => { throw new Error('synthetic sink failure'); });
  assert.doesNotThrow(() => hosted.backend.emit('service-log', { event: 'backend.throwing_sink' }));
  assert.doesNotThrow(() => hosted.backend.emit('diagnostic-entry', {
    layer: 'sidecar', event: 'sidecar.throwing_sink',
  }));
  assert.ok((await hosted.backend.createSession({ title: 'After writer throw' })).data.id);
  assert.ok(hosted.logStore.list().some((entry) => entry.event === 'backend.throwing_sink'));
});

test('hosted dispose drains pending diagnostics and detaches all sink subscriptions', async (t) => {
  const hosted = createDiagnosticHost(t);
  hosted.backend.emit('service-log', { event: 'backend.before_dispose' });
  const drain = hosted.dispose();
  const before = hosted.logStore.list();
  const drops = hosted.logStore.getCurrentDiagnosticsMetadata().integrity.dropped_by_source;
  for (const name of ['service-log', 'diagnostic-entry', 'diagnostic-drop']) {
    assert.equal(hosted.backend.listenerCount(name), 0);
  }
  hosted.backend.emit('service-log', { event: 'backend.after_dispose' });
  hosted.backend.emit('diagnostic-entry', { layer: 'sidecar', event: 'sidecar.after_dispose' });
  hosted.backend.emit('diagnostic-drop', { source: 'sidecar', count: 9 });
  assert.deepEqual(hosted.logStore.list(), before);
  assert.deepEqual(hosted.logStore.getCurrentDiagnosticsMetadata().integrity.dropped_by_source, drops);
  assert.equal((await drain).flushed, true);
  assert.equal(hosted.dispose(), drain);
  assert.ok(readHostedLog(hosted).some((entry) => entry.event === 'backend.before_dispose'));
});

test('hosted stop reports the existing writer timeout outcome without waiting for a stalled file', async (t) => {
  const hosted = createDiagnosticHost(t);
  let finishWrite;
  const originalAppend = fs.promises.appendFile;
  t.mock.method(hosted.logStore.writer.fs.promises, 'appendFile', (filePath, ...args) => {
    if (filePath !== hosted.logStore.filePath) return originalAppend.call(fs.promises, filePath, ...args);
    return new Promise((resolve) => { finishWrite = resolve; });
  });
  hosted.backend.emit('service-log', { event: 'backend.stalled_sink' });
  try {
    const result = await hosted.stop();
    assert.equal(result.exitConfirmed, true);
    assert.equal(result.logFlush.flushed, false);
    assert.ok(result.logFlush.timedOutCount > 0);
    assert.equal(await hosted.stop(), result);
  } finally { finishWrite?.(); }
});

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
    assert.equal(typeof hosted.backend.projectApplicationService?.listProjects, 'function');
    assert.equal(hosted.configService.getToolsWorkspaceRoot(), workspaceRoot);
    const generalProject = hosted.backend.projectService.get(GENERAL_PROJECT_ID);
    assert.equal(generalProject.root_path, null);
    assert.equal(generalProject.root_revision, 0);
    const createdProject = hosted.backend.projectService.create({ name: 'Hosted child' });
    assert.equal(createdProject.ok, true);
    assert.equal(
      hosted.backend.projectService.bindRoot(createdProject.project.id, path.join(workspaceRoot, 'tests')).ok,
      true
    );
    assert.equal(
      hosted.backend.projectService.bindRoot(createdProject.project.id, userDataPath).reason,
      'invalid_root'
    );

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
    await hosted.dispose();

    assert.deepEqual(ollamaManager.calls, []);
    assert.deepEqual(vllmManager.calls, []);
    assert.deepEqual(sidecarManager.calls, ['start', 'stop', 'stop']);
  } finally {
    await hosted.dispose();
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
  } finally { await hosted.dispose(); removeTempUserDataPath(userDataPath); }
});


test('hosted runtime is composed by default and force-deny preserves inspection while blocking Start', async () => {
  const prior = process.env.JENNY_ENABLE_SESSION_RUNTIME;
  const userDataPath = makeTempUserDataPath(); let hosted;
  try {
    process.env.JENNY_ENABLE_SESSION_RUNTIME = '0';
    hosted = createHostedBackend({ hostMode: 'server', userDataPath, repoRoot: path.resolve(__dirname, '../..'),
      credentialService: createCredentialService(), modelEndpoint: { engine: 'replay', model: 'replay-model' },
      featureFlags: { session_runtime: true }, sidecarManager: new SidecarHarness(),
      ollamaManager: new EngineManagerHarness('ollama'), vllmManager: new EngineManagerHarness('vllm') });
    const app = hosted.backend.runtimeApplicationService;
    const view = app.getSnapshot(); assert.equal(view.ok, true); assert.equal(view.enabled, false);
    const session = (await hosted.backend.createSession({ title: 'Inspect while off' })).data.id;
    const result = await app.start({ session_id: session, idempotency_key: 'off_start', purpose: 'Inspect', prompt: 'Do work',
      limits: { inference_requests: 1, input_tokens: 10, output_tokens: 10 } });
    assert.equal(result.ok, false); assert.equal(hosted.backend.sessionRuntime.store.listReadyCandidates().length, 0);
  } finally {
    if (prior === undefined) delete process.env.JENNY_ENABLE_SESSION_RUNTIME; else process.env.JENNY_ENABLE_SESSION_RUNTIME = prior;
    await hosted?.dispose(); removeTempUserDataPath(userDataPath);
  }
});
