const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  trackDirectory,
} = require('../helpers/resource-cleanup');
const {
  collectServiceLogs,
} = require('../helpers/backend-service-helpers');
const {
  waitForChatStreamEvent,
  createManagedService,
} = require('../helpers/managed-sidecar-runtime-helpers');
const {
  DEFAULT_MANAGED_SHELL_MODEL,
} = require('../../services/backend/backend-config');
const {
  SIDECAR_ERROR_CODES,
} = require('../../services/backend/error-codes');
const {
  reconcileManagedSidecarActiveTurns,
} = require('../../services/backend/managed-sidecar-reconciliation');
const {
  restartManagedSidecar,
} = require('../../services/backend/managed-sidecar-lifecycle');
const {
  resolveManagedConfiguredModel,
} = require('../../services/backend/managed-sidecar-config');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('managed sidecar restart reports failure when retry does not reach ready', async () => {
  const logs = [];
  const service = {
    sidecarManager: {
      async retryStart() {
        return { phase: 'failed' };
      },
    },
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
    async refreshStatusSnapshot() {
      throw new Error('refresh should not run before ready');
    },
  };

  const restarted = await restartManagedSidecar(service, 'unit.not_ready');

  assert.equal(restarted, false);
  assert.equal(
    logs.some((entry) => entry.level === 'ERROR' && entry.event === 'sidecar.restart_failed'),
    true
  );
});

test('managed sidecar startup defers the configured Ollama model and reports ready unloaded', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-startup-lazy-ollama-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath, {
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  const logs = collectServiceLogs(service);

  const status = await service.start();

  // Ollama loads models on demand: startup must NOT request the configured
  // default (a failed eager load used to latch model_unavailable and lock the
  // chat behind a manual load). The shell reports ready unloaded and the first
  // prompt lazy-loads the default via resolveModel.
  assert.equal(service.currentEngineType, 'ollama');
  assert.equal(service.currentModel, '');
  assert.equal(service.currentStatus.engine, 'ollama');
  assert.equal(service.currentStatus.model, '');
  assert.equal(service.currentStatus.model_loaded, false);
  assert.equal(service._modelLifecycle.state, 'unloaded');
  assert.equal(status.phase, 'ready');
  assert.equal(status.model_state, 'unloaded');
  assert.equal(
    logs.some(
      (entry) => entry.event === 'backend.default_model_deferred'
        && entry.details?.model === DEFAULT_MANAGED_SHELL_MODEL
        && entry.details?.reason === 'startup_lazy_load'
    ),
    true
  );

  await service.stop();
});

test('resolveManagedConfiguredModel defers the configured default for the Ollama engine', () => {
  const service = {
    currentEngineType: 'ollama',
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    currentModel: '',
    _managedPendingModel: '',
  };
  assert.equal(resolveManagedConfiguredModel(service), '');

  // An explicitly loaded or pending model still re-initializes eagerly
  // (sidecar restart / model switch must restore the active model).
  assert.equal(
    resolveManagedConfiguredModel({ ...service, currentModel: DEFAULT_MANAGED_SHELL_MODEL }),
    DEFAULT_MANAGED_SHELL_MODEL
  );
  assert.equal(
    resolveManagedConfiguredModel({ ...service, _managedPendingModel: 'qwen3.5:9b' }),
    'qwen3.5:9b'
  );
});

test('managed startup is ready for lazy loading when the preferred engine has no startup model', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-startup-unloaded-engine-'));
  trackDirectory(userDataPath);
  const service = createManagedService(userDataPath, {
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
    configService: {
      getState: () => ({ preferredEngineType: 'openai-compatible' }),
    },
  });

  const status = await service.start();

  assert.equal(service.currentEngineType, 'openai-compatible');
  assert.equal(service.currentModel, '');
  assert.equal(service._modelLifecycle.state, 'unloaded');
  assert.equal(status.phase, 'ready');
  assert.equal(status.sidecar_state, 'sidecar_spawned');
  assert.equal(status.model_state, 'unloaded');
  await service.stop();
});

test('managed startup timeout leaves a usable model-unavailable shell', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-startup-timeout-'));
  trackDirectory(userDataPath);
  const service = createManagedService(userDataPath, {
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  service._initializeManagedSidecar = async () => {
    service._modelLifecycle = {
      ...service._modelLifecycle,
      state: 'unavailable',
      requested_model: DEFAULT_MANAGED_SHELL_MODEL,
      error_code: SIDECAR_ERROR_CODES.TIMEOUT,
    };
    throw Object.assign(new Error('model acquisition stalled'), {
      error_code: SIDECAR_ERROR_CODES.TIMEOUT,
      category: 'timeout',
      retryable: true,
    });
  };

  const status = await service.start();

  assert.equal(status.phase, 'model_unavailable');
  assert.equal(status.model_state, 'unavailable');
  assert.equal(service._managedReadyOnce, true);

  // The stub above throws before initialization attaches a sidecar client, so
  // this stop has no client to send `shutdown` through: SidecarManager.stop()
  // closing the child's stdin itself is the only thing that lets the fixture
  // exit gracefully instead of surviving to the force-kill fallback (which a
  // loaded machine can lose, orphaning the child onto this file's event loop).
  await service.stop();
});

test('managed sidecar first chat lazy-loads the configured Ollama model', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-first-chat-lazy-ollama-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath, {
    defaultModel: DEFAULT_MANAGED_SHELL_MODEL,
  });
  const logs = collectServiceLogs(service);

  await service.start();
  assert.equal(service.currentModel, '');
  const completed = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete'
  );

  await service.startChatStream({
    prompt: 'Please use the shell default model.',
  });

  await completed;

  assert.equal(service.currentEngineType, 'ollama');
  assert.equal(service.currentModel, DEFAULT_MANAGED_SHELL_MODEL);
  assert.equal(
    logs.some(
      (entry) => entry.event === 'backend.model_lazy_load_started'
        && entry.details?.requestedModel === DEFAULT_MANAGED_SHELL_MODEL
        && entry.details?.reason === 'shell_default_model'
    ),
    true
  );
  assert.equal(
    logs.some(
      (entry) => entry.event === 'backend.model_lazy_load_completed'
        && entry.details?.requestedModel === DEFAULT_MANAGED_SHELL_MODEL
        && entry.details?.reason === 'shell_default_model'
    ),
    true
  );

  await service.stop();
});

test('managed sidecar initialize failures before first successful handshake do not trigger auto reconnect', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-startup-init-failure-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  const logs = collectServiceLogs(service);
  let attemptNumber = 0;

  service.sidecarManager.start = async () => {
    attemptNumber += 1;
    const status = {
      phase: 'ready',
      detail: 'Starting managed sidecar.',
      baseUrl: 'stdio://sidecar',
      pid: 4000 + attemptNumber,
      startupStage: 'spawn_complete',
    };
    service._handleSidecarStatus(status);
    return status;
  };
  service.sidecarManager.retryStart = async () => {
    attemptNumber += 1;
    const status = {
      phase: 'ready',
      detail: 'Starting managed sidecar.',
      baseUrl: 'stdio://sidecar',
      pid: 4000 + attemptNumber,
      startupStage: 'spawn_complete',
    };
    service._handleSidecarStatus(status);
    return status;
  };
  service.sidecarManager.getStatus = () => ({
    phase: attemptNumber > 0 ? 'failed' : 'starting',
    detail: 'constructor mismatch',
    baseUrl: 'stdio://sidecar',
    pid: attemptNumber > 0 ? 4000 + attemptNumber : null,
  });
  service._initializeManagedSidecar = async () => {
    service._handleSidecarStatus({
      phase: 'failed',
      detail: 'constructor mismatch',
      baseUrl: 'stdio://sidecar',
      pid: 4000 + attemptNumber,
    });
    throw new Error('constructor mismatch');
  };

  await assert.rejects(
    () => service.start(),
    /constructor mismatch/i
  );

  assert.equal(service._managedReadyOnce, false);
  assert.equal(
    logs.filter((entry) => entry.event === 'backend.managed_sidecar_spawn_ready').length,
    2,
  );
  assert.equal(
    logs.filter((entry) => entry.event === 'backend.managed_sidecar_failed_before_initialize').length,
    2,
  );
  assert.equal(
    logs.some((entry) => entry.event === 'backend.auto_reconnect_start'),
    false,
  );
});

test('managed sidecar startChatStream returns before slow model, personality, and memory preflight completes', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-preflight-return-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();
  // Deterministic ordering instead of wall-clock deltas: each slow preflight
  // dependency parks on a manually-released gate. The gate stays closed across
  // the startChatStream return, so observing the return + an already-listable
  // session WHILE no `started` event has fired proves preflight is deferred,
  // with zero real time elapsed.
  let releasePreflight;
  const preflightGate = new Promise((resolve) => {
    releasePreflight = resolve;
  });
  // Drain the macrotask queue so the detached background turn can advance up to
  // its first parked `await preflightGate` before we assert nothing has fired.
  const flushMacrotasks = async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };

  const originalResolveModel = service._resolveModel.bind(service);
  service._resolveModel = async (...args) => {
    await preflightGate;
    return originalResolveModel(...args);
  };
  service.personalityWorkspace = {
    async getCompiledContext() {
      await preflightGate;
      return '## SOUL\n\nBe steady.';
    },
  };
  service.recallApprovedMemories = async () => {
    await preflightGate;
    return { memories: [] };
  };
  service.recallRecentApprovedMemories = async () => {
    await preflightGate;
    return { memories: [] };
  };

  let startedFired = false;
  service.on('chat-stream', (event) => {
    if (event.type === 'started') {
      startedFired = true;
    }
  });
  const completed = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete'
  );

  const stream = await service.startChatStream({
    prompt: 'Please move slowly through startup.',
  });
  const sessionsImmediately = await service.listSessions();
  await flushMacrotasks();

  // startChatStream resolved and the session is already listable, yet the
  // deferred preflight is still parked on the closed gate so `started` cannot
  // have fired. A regression that awaited preflight before returning would
  // deadlock here (the gate is released only below) or surface startedFired===true.
  assert.equal(stream.sessionId.startsWith('sess_'), true);
  assert.equal(sessionsImmediately.data.length, 1);
  assert.equal(sessionsImmediately.data[0].id, stream.sessionId);
  assert.equal(startedFired, false);

  releasePreflight();
  const startedEvent = await waitForChatStreamEvent(
    service,
    (event) => event.type === 'started'
  );
  assert.ok(startedEvent);

  await completed;

  const sessionsAfterComplete = await service.listSessions();
  assert.equal(sessionsAfterComplete.data.length, 1);
  assert.equal(sessionsAfterComplete.data[0].id, stream.sessionId);

  await service.stop();
});

test('managed sidecar existing-session sends do not await preference persistence before returning', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-pref-persist-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  await service.start();
  const created = await service.createSession({
    title: 'Existing Session',
    preferences: {
      plan_mode: false,
    },
  });

  // Deterministic ordering instead of wall-clock deltas: persistence parks on a
  // manually-released gate. Observing that startChatStream returned and plan_mode
  // is still the pre-send value WHILE the gate is closed proves the persistence
  // is not awaited before returning, with zero real time elapsed.
  let releasePersist;
  const persistGate = new Promise((resolve) => {
    releasePersist = resolve;
  });
  const flushMacrotasks = async () => {
    for (let i = 0; i < 5; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const originalSetSessionPreferences = service.setSessionPreferences.bind(service);
  service.setSessionPreferences = async (...args) => {
    await persistGate;
    return originalSetSessionPreferences(...args);
  };

  const completed = waitForChatStreamEvent(
    service,
    (event) => event.type === 'complete' && event.sessionId === created.data.id
  );

  await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Persist the session preferences in the background.',
    planMode: true,
  });
  await flushMacrotasks();
  const sessionBeforeComplete = service.sessionStore.getSession(created.data.id);

  // startChatStream resolved while the deferred persistence is still parked on
  // the closed gate, so the new planMode has not been written yet. A regression
  // that awaited persistence before returning would deadlock here.
  assert.equal(sessionBeforeComplete.plan_mode, false);

  releasePersist();
  await completed;

  const sessionAfterComplete = service.sessionStore.getSession(created.data.id);
  assert.equal(sessionAfterComplete.plan_mode, true);

  await service.stop();
});

test('managed sidecar runtime rejects image attachments outside the managed asset store', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-vision-boundary-'));
  trackDirectory(userDataPath);
  const imagePath = path.join(userDataPath, 'capture.png');
  fs.writeFileSync(imagePath, 'fake-image');

  const service = createManagedService(userDataPath);
  service.attachmentAssetStore = {
    isManagedAssetPath() {
      return false;
    },
  };
  await service.start();

  await assert.rejects(
    () => service.startChatStream({
      prompt: 'Describe the attached image.',
      attachments: [{
        id: 'image_1',
        kind: 'image',
        displayName: 'capture.png',
        mimeType: 'image/png',
        sizeBytes: 2048,
        width: 640,
        height: 360,
        assetPath: imagePath,
        sourceKind: 'capture',
      }],
    }),
    /app-managed local asset store/i
  );

  await service.stop();
});

test('managed sidecar startup reconciliation clears orphaned active turns and appends sidecar_crash', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-reconcile-orphan-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  const created = service.sessionStore.createSession({ title: 'Crash Recovery' });
  service.sessionStore.appendMessage(created.id, {
    id: 'user_stream-orphan',
    role: 'user',
    content: 'Please continue',
    timestamp: new Date().toISOString(),
  });
  service.sessionStore.appendMessage(created.id, {
    id: 'tool_use_call-orphan',
    role: 'assistant',
    kind: 'tool_use',
    content: 'write_file notes.md',
    timestamp: new Date().toISOString(),
    tool_call: {
      call_id: 'call-orphan',
      tool_name: 'write_file',
      input_json: JSON.stringify({ path: 'notes.md' }),
      input: { path: 'notes.md' },
      summary: 'write_file notes.md',
      status: 'pending_approval',
      approval_state: 'pending',
      duration_ms: 0,
      parent_stream_id: 'stream-orphan',
    },
  }, { updatePreview: false });
  service.sessionStore.setActiveTurn(created.id, {
    request_id: 'stream-orphan',
    stream_id: 'stream-orphan',
    user_message_id: 'user_stream-orphan',
    started_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    status: 'streaming',
  });
  const result = await reconcileManagedSidecarActiveTurns(service);
  const reloadedSession = service.sessionStore.getSession(created.id);
  const messages = service.sessionStore.getSessionMessages(created.id);
  const assistantFailure = messages.find((message) => message.id === 'assistant_stream-orphan');
  const repairedToolUse = messages.find((message) => message.id === 'tool_use_call-orphan');

  assert.deepEqual(result, { scanned: 1, reconciled: 1 });
  assert.equal(reloadedSession.active_turn, null);
  assert.ok(assistantFailure);
  assert.equal(assistantFailure.status, 'runtime_error');
  assert.equal(assistantFailure.terminal_subcode, 'sidecar_crash');
  assert.equal(assistantFailure.error_code, SIDECAR_ERROR_CODES.PROCESS_EXIT);
  assert.equal(assistantFailure.next_action, 'retry_turn');
  assert.equal(repairedToolUse.tool_call.status, 'cancelled');
  assert.equal(repairedToolUse.tool_call.approval_state, 'cancelled');
});

test('managed sidecar startup reconciliation preserves trace correlation on emitted sidecar_crash events', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-reconcile-trace-'));
  trackDirectory(userDataPath);

  const service = createManagedService(userDataPath);
  const created = service.sessionStore.createSession({ title: 'Crash Recovery Trace' });
  service.sessionStore.setActiveTurn(created.id, {
    request_id: 'stream-trace',
    stream_id: 'stream-trace',
    trace_id: 'trace-orphaned-turn',
    user_message_id: 'user_stream-trace',
    started_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    status: 'streaming',
  });
  const eventPromise = waitForChatStreamEvent(service, (event) =>
    event?.type === 'error' && event?.streamId === 'stream-trace'
  );

  await reconcileManagedSidecarActiveTurns(service, { emitChatStream: true });
  const event = await eventPromise;

  assert.equal(event.requestId, 'stream-trace');
  assert.equal(event.traceId, 'trace-orphaned-turn');
  assert.equal(event.trace_id, 'trace-orphaned-turn');
  assert.equal(event.terminal_subcode, 'sidecar_crash');
});

test('managed sidecar reconciliation preserves a turn with a matching Electron stream controller', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-reconcile-live-'));
  trackDirectory(userDataPath);
  const service = createManagedService(userDataPath);
  const logs = collectServiceLogs(service);
  const created = service.sessionStore.createSession({ title: 'Live Turn' });
  service.sessionStore.setActiveTurn(created.id, {
    request_id: 'stream-live',
    stream_id: 'stream-live',
    user_message_id: 'user_stream-live',
    started_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    status: 'streaming',
  });
  service.activeStreams.set('stream-live', new AbortController());

  const result = await reconcileManagedSidecarActiveTurns(service);

  assert.deepEqual(result, { scanned: 1, reconciled: 0 });
  assert.notEqual(service.sessionStore.getActiveTurn(created.id), null);
  assert.equal(
    service.sessionStore.getSessionMessages(created.id)
      .some((message) => message.id === 'assistant_stream-live'),
    false
  );
  assert.equal(
    logs.some((entry) => entry.event === 'backend.active_turn_reconcile_skipped'
      && entry.details?.reason === 'electron_stream_active'),
    true
  );
});

test('an unrelated Electron stream does not protect a controller-less stale turn', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-reconcile-unrelated-'));
  trackDirectory(userDataPath);
  const service = createManagedService(userDataPath);
  const created = service.sessionStore.createSession({ title: 'Stale Turn' });
  service.sessionStore.setActiveTurn(created.id, {
    request_id: 'stream-stale',
    stream_id: 'stream-stale',
    user_message_id: 'user_stream-stale',
    started_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    status: 'streaming',
  });
  service.activeStreams.set('stream-other', new AbortController());

  const result = await reconcileManagedSidecarActiveTurns(service);

  assert.deepEqual(result, { scanned: 1, reconciled: 1 });
  assert.equal(service.sessionStore.getActiveTurn(created.id), null);
  assert.equal(
    service.sessionStore.getSessionMessages(created.id)
      .some((message) => message.id === 'assistant_stream-stale'),
    true
  );
});

test('managed sidecar reconciliation fails safe when the Electron stream registry is unavailable', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-managed-reconcile-no-registry-'));
  trackDirectory(userDataPath);
  const service = createManagedService(userDataPath);
  const logs = collectServiceLogs(service);
  const created = service.sessionStore.createSession({ title: 'Unknown Liveness' });
  service.sessionStore.setActiveTurn(created.id, {
    request_id: 'stream-unknown',
    stream_id: 'stream-unknown',
    user_message_id: 'user_stream-unknown',
    started_at: new Date().toISOString(),
    last_event_at: new Date().toISOString(),
    status: 'streaming',
  });
  service.activeStreams = null;

  const result = await reconcileManagedSidecarActiveTurns(service);

  assert.deepEqual(result, { scanned: 1, reconciled: 0 });
  assert.notEqual(service.sessionStore.getActiveTurn(created.id), null);
  const warning = logs.find((entry) =>
    entry.event === 'backend.active_turn_reconcile_registry_unavailable'
  );
  assert.equal(warning?.level, 'WARN');
});

