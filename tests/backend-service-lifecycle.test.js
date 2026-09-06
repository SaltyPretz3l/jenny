const os = require('os');
const path = require('path');
const fs = require('fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const { BackendService } = require('../services/backend/backend-service');
const {
  approveToolCall,
  denyToolCall,
} = require('../services/backend/backend-chat-stream');
const {
  waitForToolApproval,
} = require('../services/backend/chat-stream-tool-handling');
const {
  applyManagedInitializePayload,
  initializeManagedSidecar,
} = require('../services/backend/managed-sidecar-lifecycle');
const { createFakeSafeStorage } = require('./helpers/fake-safe-storage');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');
const {
  collectServiceLogs,
} = require('./helpers/backend-service-helpers');
const {
  markManagedSidecarReady,
} = require('./helpers/managed-sidecar-chat-lifecycle-helpers');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('approve and deny resolve scoped approval ids while legacy raw ids must be unique', () => {
  const resolved = [];
  const policies = [];
  const service = {
    toolPermissionStore: {
      setPolicy(toolName, policy) {
        policies.push({ toolName, policy });
      },
    },
    pendingToolApprovals: new Map([
      ['approval-session-a-stream-a-call-shared', {
        approvalId: 'approval-session-a-stream-a-call-shared',
        callId: 'call-shared',
        streamId: 'stream-a',
        toolName: 'Read',
        resolve(approved, approvalState) {
          resolved.push({ streamId: this.streamId, approved, approvalState });
        },
      }],
      ['approval-session-b-stream-b-call-shared', {
        approvalId: 'approval-session-b-stream-b-call-shared',
        callId: 'call-shared',
        streamId: 'stream-b',
        resolve(approved, approvalState) {
          resolved.push({ streamId: this.streamId, approved, approvalState });
        },
      }],
      ['approval-session-c-stream-c-call-unique', {
        approvalId: 'approval-session-c-stream-c-call-unique',
        callId: 'call-unique',
        streamId: 'stream-c',
        resolve(approved, approvalState) {
          resolved.push({ streamId: this.streamId, approved, approvalState });
        },
      }],
    ]),
  };

  assert.equal(denyToolCall(service, 'call-shared'), false);
  assert.equal(approveToolCall(service, 'approval-session-a-stream-a-call-shared', { alwaysAllow: true }), true);
  assert.equal(denyToolCall(service, 'call-unique'), true);
  assert.deepEqual(resolved, [
    { streamId: 'stream-a', approved: true, approvalState: 'approved' },
    { streamId: 'stream-c', approved: false, approvalState: 'denied' },
  ]);
  assert.deepEqual(policies, [{ toolName: 'Read', policy: 'auto' }]);
  assert.equal(service.pendingToolApprovals.has('approval-session-b-stream-b-call-shared'), true);
});

test('always allow policy write failures do not block current approval', () => {
  const resolved = [];
  const logs = [];
  const service = {
    toolPermissionStore: {
      setPolicy() {
        throw new Error('store unavailable');
      },
    },
    pendingToolApprovals: new Map([
      ['approval-session-a-stream-a-call-write-fails', {
        approvalId: 'approval-session-a-stream-a-call-write-fails',
        callId: 'call-write-fails',
        streamId: 'stream-a',
        toolName: 'Write',
        resolve(approved, approvalState) {
          resolved.push({ approved, approvalState });
        },
      }],
    ]),
    _emitServiceLog(level, event, fields) {
      logs.push({ level, event, fields });
    },
    refreshManagedConfig() {
      throw new Error('should not refresh after failed policy write');
    },
  };

  assert.equal(approveToolCall(service, 'approval-session-a-stream-a-call-write-fails', { alwaysAllow: true }), true);
  assert.deepEqual(resolved, [{ approved: true, approvalState: 'approved' }]);
  assert.equal(service.pendingToolApprovals.size, 0);
  assert.deepEqual(logs, [{
    level: 'WARN',
    event: 'tool_permission.always_allow_update_failed',
    fields: {
      toolName: 'Write',
      message: 'store unavailable',
    },
  }]);
});

test('backend approval never persists always-allow for exit_plan_mode', () => {
  const policies = [];
  const service = {
    toolPermissionStore: {
      setPolicy(toolName, policy) {
        policies.push({ toolName, policy });
      },
    },
    pendingToolApprovals: new Map([[
      'approval-exit-plan-mode',
      {
        approvalId: 'approval-exit-plan-mode',
        callId: 'call-exit-plan-mode',
        streamId: 'stream-exit-plan-mode',
        toolName: 'exit_plan_mode',
        resolve() {},
      },
    ]]),
  };

  assert.equal(approveToolCall(service, 'approval-exit-plan-mode', { alwaysAllow: true }), true);
  assert.deepEqual(policies, []);
});

// SP-13: alwaysAllow must never be applied ahead of settlement. Pre-fix,
// approveToolCall called maybeApplyAlwaysAllowPolicy BEFORE entry.pending.resolve(...),
// so a throw during settlement left the global policy already flipped even
// though the waiter itself could hang forever.
test('approveToolCall settles the waiter before applying the alwaysAllow policy', () => {
  const order = [];
  const service = {
    toolPermissionStore: {
      setPolicy() {
        order.push('policy');
      },
    },
    pendingToolApprovals: new Map([
      ['approval-order-1', {
        approvalId: 'approval-order-1',
        callId: 'call-order-1',
        streamId: 'stream-order-1',
        toolName: 'Write',
        resolve() {
          order.push('resolve');
        },
      }],
    ]),
  };

  assert.equal(approveToolCall(service, 'approval-order-1', { alwaysAllow: true }), true);
  assert.deepEqual(order, ['resolve', 'policy']);
});

test('approveToolCall settles the waiter and applies alwaysAllow even when settlement is poisoned', async () => {
  const logs = [];
  const policies = [];
  let updateMessageCalls = 0;
  const mockService = {
    sessionStore: {
      appendMessage() {},
      updateMessage() {
        updateMessageCalls += 1;
        throw new Error('store write failed');
      },
      getSessionMessages() {
        return [];
      },
    },
    emit() {},
    pendingToolApprovals: new Map(),
    currentModel: 'test-model',
    toolPermissionStore: {
      setPolicy(toolName, policy) {
        policies.push({ toolName, policy });
      },
    },
    _emitServiceLog(level, event, details) {
      logs.push({ level, event, details });
    },
  };

  const controller = new AbortController();
  const resultPromise = waitForToolApproval(
    mockService,
    'stream-approve-poison',
    'session-approve-poison',
    'req-approve-poison',
    {
      tool_name: 'Write',
      tool_call_id: 'call-approve-poison',
      tool_input: { path: 'notes.md' },
    },
    controller
  );

  const [approvalId] = mockService.pendingToolApprovals.keys();
  assert.ok(approvalId);

  // Pre-fix, this call throws synchronously (the poisoned finish() propagates
  // the updateMessage error straight out of entry.pending.resolve(), which
  // approveToolCall never caught) — the waiter never settles and the
  // alwaysAllow policy write (which ran BEFORE resolve) is already committed.
  const approveResult = approveToolCall(mockService, approvalId, { alwaysAllow: true });
  assert.equal(approveResult, true);

  const approved = await resultPromise;
  assert.equal(approved, true);
  assert.equal(updateMessageCalls, 1);
  assert.equal(
    logs.some((entry) => entry.level === 'ERROR' && entry.event === 'chat.tool_approval_settlement_failed'),
    true
  );
  assert.deepEqual(policies, [{ toolName: 'Write', policy: 'auto' }]);
});

test('backend service dispose removes long-lived listeners and clears transient state', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-dispose-managed-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });
  const controller = new AbortController();
  let sidecarDisposed = 0;
  const client = {
    dispose() {
      sidecarDisposed += 1;
    },
    off(event, listener) {
      if (event === 'error') {
        this.removedListener = listener;
      }
    },
  };
  const errorListener = () => {};

  service.sidecarClient = client;
  service._sidecarClientErrorListener = errorListener;
  service.activeStreams.set('stream_dispose', controller);
  service.pendingToolApprovals.set('call_dispose', {
    resolve(approved, approvalState) {
      this.approved = approved;
      this.approvalState = approvalState;
    },
  });

  assert.equal(service.sidecarManager.listenerCount('status') > 0, true);
  assert.equal(service.sidecarManager.listenerCount('log') > 0, true);

  service.dispose();

  assert.equal(controller.signal.aborted, true);
  assert.equal(service.activeStreams.size, 0);
  assert.equal(service.pendingToolApprovals.size, 0);
  assert.equal(sidecarDisposed, 1);
  assert.equal(client.removedListener, errorListener);
  assert.equal(service.sidecarClient, null);
  assert.equal(service.sidecarManager.listenerCount('status'), 0);
  assert.equal(service.sidecarManager.listenerCount('log'), 0);
});

test('backend service dispose cancels queued session migration startup work', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-dispose-migration-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });
  let migrationRan = false;
  service.sessionStore = {
    hasPendingMigrations() {
      return true;
    },
    async runPendingMigrations() {
      migrationRan = true;
      return { success: true, sessionCount: 1 };
    },
    flush() {},
  };
  service.shadowStore = {
    hasPendingMigrations() {
      return false;
    },
    flush() {},
  };

  service._schedulePendingSessionMigrations();
  assert.equal(service._pendingSessionMigrationScheduled, true);

  service.dispose();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(migrationRan, false);
  assert.equal(service._pendingSessionMigrationScheduled, false);
  assert.equal(service._pendingSessionMigrationImmediate, null);
});

test('backend status exposes secure storage readiness without reading secrets', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-secure-status-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    isSafeStorageReady: () => false,
  });

  const status = service.getBackendStatus();
  assert.equal(status.credentialStore.status, 'not_ready');
  assert.equal(status.credentialStore.ready, false);
  assert.equal(status.credentialStore.encryptionAvailable, false);
  assert.match(status.credentialStore.recoveryHint, /restart Jenny/i);

  service.dispose();
});

test('plan decisions preserve decision and feedback without creating an always-allow rule', () => {
  const resolved = [];
  const policies = [];
  const service = {
    toolPermissionStore: { setPolicy: (...args) => policies.push(args) },
    pendingToolApprovals: new Map([['approval-plan', {
      approvalId: 'approval-plan', callId: 'call-plan', streamId: 'stream-plan',
      toolName: 'exit_plan_mode',
      resolve: (...args) => resolved.push(args),
    }]]),
  };
  assert.equal(approveToolCall(service, 'approval-plan', {
    decision: 'approved_auto', feedback: 'Looks good', alwaysAllow: true,
  }), true);
  // The 4th resolve slot carries the W3a edited plan; undefined when no edits rode the approval.
  assert.deepEqual(resolved, [[true, 'approved_auto', 'Looks good', undefined]]);
  assert.deepEqual(policies, []);
});

test('backend status includes setup completion contract when setup service is available', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-setup-status-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    setupService: {
      getState() {
        return {
          setup_complete: true,
          setup_state: {
            seen: true,
            setup_complete: true,
            steps: {
              workspace_root: 'done',
            },
          },
        };
      },
    },
  });

  const status = service.getBackendStatus();
  assert.equal(status.setup_complete, true);
  assert.equal(status.setup_state.steps.workspace_root, 'done');

  service.dispose();
});

test('backend service stop aborts streams, unloads the managed model, and then stops the sidecar', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stop-managed-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });
  const serviceLogs = collectServiceLogs(service);
  const controller = new AbortController();
  let unloadCallCount = 0;
  let stopCallCount = 0;
  let stopOptions = null;

  service.activeStreams.set('stream_stop', controller);
  service.sidecarManager.mode = 'managed-dev';
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarManager.stop = async (options) => {
    stopCallCount += 1;
    stopOptions = options;
  };
  service.unloadModel = async () => {
    unloadCallCount += 1;
    return { status: 'ok', model: '' };
  };

  await service.stop();

  assert.equal(controller.signal.aborted, true);
  assert.equal(service.activeStreams.size, 0);
  assert.equal(unloadCallCount, 1);
  assert.equal(stopCallCount, 1);
  assert.ok(Number.isFinite(stopOptions.gracefulDeadlineAt));
  assert.ok(stopOptions.gracefulDeadlineAt - Date.now() <= 5000);
  assert.ok(serviceLogs.some((entry) => entry.event === 'backend.model_unloaded_for_shutdown'));
  const exitStage = serviceLogs.find((entry) => entry.event === 'backend.sidecar_shutdown_stage');
  assert.ok(exitStage && Number.isFinite(exitStage.details.durationMs));
});

test('backend service stop still stops the sidecar when managed model unload fails', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stop-managed-fail-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });
  const serviceLogs = collectServiceLogs(service);
  let stopCallCount = 0;

  service.sidecarManager.mode = 'managed-dev';
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarManager.stop = async () => {
    stopCallCount += 1;
  };
  service.unloadModel = async () => {
    throw new Error('unload denied');
  };

  await service.stop();

  assert.equal(stopCallCount, 1);
  const failureLog = serviceLogs.find(
    (entry) => entry.event === 'backend.model_unload_on_shutdown_failed'
  );
  assert.ok(failureLog);
  assert.equal(failureLog.level, 'WARN');
  assert.match(failureLog.details.message, /unload denied/i);
});

test('backend service stop still stops the sidecar when managed model unload hangs', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stop-managed-timeout-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });
  const serviceLogs = collectServiceLogs(service);
  let stopCallCount = 0;

  service.sidecarManager.mode = 'managed-dev';
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarManager.stop = async () => {
    stopCallCount += 1;
  };
  service.unloadModel = async () => new Promise(() => {});

  await service.stop();

  assert.equal(stopCallCount, 1);
  const failureLog = serviceLogs.find(
    (entry) => entry.event === 'backend.model_unload_on_shutdown_failed'
  );
  assert.ok(failureLog);
  assert.match(failureLog.details.message, /timed out/i);
});

test('backend service persists late sidecar events into tool_result audit metadata when the call resolves', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-late-sidecar-event-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });
  const created = service.sessionStore.createSession({ title: 'Late Event Audit' });
  service.sessionStore.appendMessage(created.id, {
    id: 'tool_result_call-late',
    role: 'tool',
    kind: 'tool_result',
    content: 'write_file done',
    timestamp: new Date().toISOString(),
    tool_result: {
      call_id: 'call-late',
      tool_name: 'write_file',
      output_text: 'done',
      summary: 'write_file done',
      is_error: false,
      error_code: '',
      exit_code: null,
      duration_ms: 0,
      parent_stream_id: 'stream-late',
      generated_artifacts: [],
      metadata: {
        approval_plan_hash: 'plan-1',
      },
    },
  }, { updatePreview: false });

  const persisted = service._recordLateSidecarEvent({
    method: 'tool.result',
    params: {
      session_id: created.id,
      tool_call_id: 'call-late',
      request_id: 'req-late',
      trace_id: 'trace-late',
    },
  });

  const reloadedMessage = service.sessionStore.getSessionMessages(created.id)
    .find((message) => message.id === 'tool_result_call-late');
  assert.equal(persisted, true);
  assert.equal(reloadedMessage.tool_result.metadata.trace_id, 'trace-late');
  assert.deepEqual(reloadedMessage.tool_result.metadata.late_events, [{
    kind: 'late_notification',
    method: 'tool.result',
    request_id: 'req-late',
    trace_id: 'trace-late',
    received_at: reloadedMessage.tool_result.metadata.late_events[0].received_at,
    rpc_id: null,
  }]);
});

test('backend service stop still stops ollama when sidecarManager.stop() throws', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stop-ollama-guarantee-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });
  const serviceLogs = collectServiceLogs(service);
  let ollamaStopCallCount = 0;
  let vllmStopCallCount = 0;

  service.sidecarManager.mode = 'managed-dev';
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarManager.stop = async () => {
    throw new Error('sidecar stop failed');
  };
  service.unloadModel = async () => {
    return { status: 'ok', model: '' };
  };
  service.ollamaManager.stop = async () => {
    ollamaStopCallCount += 1;
  };
  service.vllmManager.stop = async () => {
    vllmStopCallCount += 1;
  };

  await service.stop();

  assert.equal(ollamaStopCallCount, 1, 'ollamaManager.stop() must be called even when sidecar stop throws');
  assert.equal(vllmStopCallCount, 1, 'vllmManager.stop() must be called even when sidecar stop throws');
  const failLog = serviceLogs.find(
    (entry) => entry.event === 'backend.sidecar_stop_failed'
  );
  assert.ok(failLog, 'should log sidecar stop failure');
});

test('backend service stop forwards aggressive ollama shutdown scope when requested', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-stop-ollama-scope-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });
  const stopScopes = [];

  service.sidecarManager.mode = 'managed-dev';
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarManager.stop = async () => {};
  service.unloadModel = async () => ({ status: 'ok', model: '' });
  service.ollamaManager.stop = async (options = {}) => {
    stopScopes.push(options.scope || 'app_owned');
  };
  service.vllmManager.stop = async () => {};

  await service.stop({ ollamaShutdownScope: 'any_local' });

  assert.deepEqual(stopScopes, ['any_local']);
});

test('backend service emits a sidecar-crash event only after the managed sidecar has initialized', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-crash-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });
  const crashEvents = [];
  let reconnectAttempts = 0;

  service.on('sidecar-crash', (payload) => {
    crashEvents.push(payload);
  });
  service._attemptAutoReconnect = () => {
    reconnectAttempts += 1;
  };

  service._handleSidecarStatus({ phase: 'failed', detail: 'startup failure' });
  service._handleSidecarStatus({ phase: 'ready', detail: 'ready' });
  service._handleSidecarStatus({ phase: 'failed', detail: 'initialize crash' });
  service._markManagedSidecarInitialized();
  service._handleSidecarStatus({ phase: 'failed', detail: 'runtime exit' });

  assert.equal(crashEvents.length, 1);
  assert.equal(crashEvents[0].detail, 'runtime exit');
  assert.equal(reconnectAttempts, 1);
});

test('backend service tolerates malformed sidecar status payloads', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-sidecar-status-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });

  const backendStatusEvents = [];
  service.on('backend-status', (payload) => backendStatusEvents.push(payload));

  assert.doesNotThrow(() => service._handleSidecarStatus(null));
  assert.doesNotThrow(() => service._handleSidecarStatus(undefined));
  assert.doesNotThrow(() => service._handleSidecarStatus('ready'));

  assert.equal(backendStatusEvents.length, 3);
  for (const payload of backendStatusEvents) {
    assert.equal(payload.sidecar_state, 'stopped');
    assert.equal(payload.model_state, 'unloaded');
    assert.equal(payload.model_lifecycle.state, 'unloaded');
  }
});

test('managed status snapshot normalizes partial local runtime readiness and sources', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-local-runtime-status-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'qwen3.5:9b',
  });

  const snapshot = service._buildManagedStatusSnapshot({
    engine: 'ollama',
    model: 'qwen3.5:9b',
    model_loaded: true,
    active_model_capabilities: { text: true, tool_calling: true, thinking: true },
    local_runtime: {
      contract_version: '2',
      engine: { type: 'ollama' },
      model: { id: 'qwen3.5:9b', loaded: true },
      readiness: { status: 'ready' },
      capabilities: {
        text: { available: true },
        tool_calling: { available: true },
        thinking: { available: true, source: 'model_metadata' },
      },
      reasoning: { support: 'supported' },
      context: {
        configured_context_length: 8192,
        native_context_length: 32768,
      },
    },
  });

  assert.equal(snapshot.local_runtime.readiness.status, 'ready');
  assert.equal(snapshot.local_runtime.readiness.ready, true);
  assert.equal(snapshot.local_runtime.readiness.model_loaded, true);
  assert.equal(snapshot.local_runtime.capabilities.text.source, 'engine_default');
  assert.equal(snapshot.local_runtime.capabilities.tool_calling.source, 'engine_default');
  assert.equal(snapshot.local_runtime.context.effective_context_length, 8192);
});

test('managed initialize reattaches an existing client to the current sidecar process before retrying', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-initialize-reattach-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'qwen3.5:9b',
  });
  const previousProcess = new EventEmitter();
  const currentProcess = new EventEmitter();
  const attachedProcesses = [];
  let initializeCallCount = 0;

  service.sidecarManager.process = currentProcess;
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    process: previousProcess,
    connected: false,
    attachProcess(process) {
      attachedProcesses.push(process);
      this.process = process;
      this.connected = true;
    },
    async initialize() {
      initializeCallCount += 1;
      return {
        active_engine: 'ollama',
        active_model: 'qwen3.5:9b',
        active_model_capabilities: { text: true },
      };
    },
  };

  await initializeManagedSidecar(service);

  assert.equal(initializeCallCount, 1);
  assert.deepEqual(attachedProcesses, [currentProcess]);
  assert.equal(service.sidecarClient.process, currentProcess);
  assert.equal(service.sidecarClient.connected, true);
});

test('managed sidecar initialize timeout aborts the in-flight initialize request', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-initialize-timeout-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'qwen3.5:9b',
  });
  const serviceLogs = collectServiceLogs(service);
  let receivedSignal = null;
  let abortCount = 0;

  service.sidecarManager.process = {};
  service.sidecarManager.getStatus = () => ({ phase: 'initializing' });
  service.sidecarClient = {
    process: service.sidecarManager.process,
    connected: true,
    attachProcess(process) {
      this.process = process;
      this.connected = true;
    },
    initialize(_payload, { signal } = {}) {
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener('abort', () => {
          abortCount += 1;
          reject(signal.reason);
        }, { once: true });
      });
    },
  };

  await assert.rejects(
    service._initializeManagedSidecar({ timeoutMs: 5 }),
    /timed out after 5ms/i
  );
  assert.ok(receivedSignal);
  assert.equal(receivedSignal.aborted, true);
  assert.equal(abortCount, 1);

  const timeoutLog = serviceLogs.find(
    (entry) => entry.event === 'backend.managed_sidecar_initialize_failed'
  );
  assert.ok(timeoutLog);
  assert.match(timeoutLog.details.message, /timed out after 5ms/i);
  assert.equal(timeoutLog.details.phase, 'initializing');
});

test('managed sidecar initialize timeout still rejects when a custom client ignores abort signals', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-initialize-timeout-fallback-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'qwen3.5:9b',
  });
  const serviceLogs = collectServiceLogs(service);
  let receivedSignal = null;

  service.sidecarManager.process = {};
  service.sidecarManager.getStatus = () => ({ phase: 'initializing' });
  service.sidecarClient = {
    process: service.sidecarManager.process,
    connected: true,
    initialize(_payload, { signal } = {}) {
      receivedSignal = signal;
      return new Promise(() => {});
    },
  };

  await assert.rejects(
    service._initializeManagedSidecar({ timeoutMs: 5 }),
    (error) => {
      assert.match(error.message, /timed out after 5ms/i);
      assert.equal(error.error_code, 'CMP-SIDECAR-0001');
      assert.equal(error.category, 'timeout');
      assert.equal(error.retryable, true);
      return true;
    }
  );
  assert.ok(receivedSignal);
  assert.equal(receivedSignal.aborted, true);

  const timeoutLog = serviceLogs.find(
    (entry) => entry.event === 'backend.managed_sidecar_initialize_failed'
  );
  assert.ok(timeoutLog);
  assert.match(timeoutLog.details.message, /timed out after 5ms/i);
});

test('managed sidecar unload model uses JSON-RPC and clears local runtime state', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-unload-managed-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'qwen3.5:9b',
  });
  let unloadRpcCallCount = 0;

  service.currentModel = 'qwen3.5:9b';
  service.currentEngineType = 'ollama';
  service.currentStatus = service._buildManagedStatusSnapshot({
    engine: 'ollama',
    model: 'qwen3.5:9b',
    model_loaded: true,
  });
  service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  service.sidecarClient = {
    async modelsUnload() {
      unloadRpcCallCount += 1;
      return { status: 'ok', model: '' };
    },
  };

  const result = await service.unloadModel();

  assert.equal(unloadRpcCallCount, 1);
  assert.equal(result.status, 'ok');
  assert.equal(service.currentModel, '');
  assert.equal(service.currentStatus.model, '');
  assert.equal(service.currentStatus.model_loaded, false);
});

test('backend service restores managed session history across restarts', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-userdata-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
    defaultModel: 'mock-v1',
  });
  markManagedSidecarReady(service);
  service._resolveModel = async () => 'mock-v1';
  service.sidecarClient = {
    connected: true,
    dispose() {},
    async request(method) {
      throw new Error(`Unexpected sidecar request: ${method}`);
    },
    async chatSend(_params, { onNotification }) {
      onNotification({ method: 'chat.token', params: { delta: 'Hello from Jenny' } });
      onNotification({ method: 'chat.done', params: { stop_reason: 'end_turn' } });
      return { status: 'completed' };
    },
  };

  const streamComplete = new Promise((resolve) => {
    service.on('chat-stream', (event) => {
      if (event.type === 'complete') {
        resolve(event);
      }
    });
  });

  const created = await service.createSession({
    title: 'Initial Session',
    preferences: { context_preferences: { include_memory: false } },
  });
  const stream = await service.startChatStream({
    sessionId: created.data.id,
    prompt: 'Hello sidecar',
  });

  const completed = await streamComplete;
  assert.equal(completed.sessionId, stream.sessionId);

  const messages = await service.getSessionMessages(stream.sessionId);
  assert.equal(messages.data.length, 2);
  assert.equal(messages.data[0].role, 'user');
  assert.equal(messages.data[1].role, 'assistant');
  assert.equal(messages.data[0].id, `user_${stream.streamId}`);
  assert.equal(messages.data[1].id, `assistant_${stream.streamId}`);
  assert.match(messages.data[1].content, /Hello from Jenny/);
  assert.deepEqual(messages.data[1].reasoning, {
    source: 'none',
    entries: [],
  });

  service.dispose();

  const restarted = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });

  const restoredMessages = await restarted.getSessionMessages(stream.sessionId);
  assert.equal(restoredMessages.data.length, 2);
  assert.equal(restoredMessages.data[1].id, `assistant_${stream.streamId}`);
  assert.match(restoredMessages.data[1].content, /Hello from Jenny/);
  assert.deepEqual(restoredMessages.data[1].reasoning, {
    source: 'none',
    entries: [],
  });

  restarted.dispose();
});

test('managed sidecar initialize forwards provider_capability_profiles to status snapshot', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-profiles-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });

  const profiles = [
    {
      profile_id: 'ollama@http://localhost:11434::qwen2.5:14b',
      endpoint_id: 'ollama@http://localhost:11434',
      model_id: 'qwen2.5:14b',
      generated_at: '2026-05-01T00:00:00.000Z',
      expires_at: '2026-05-01T00:05:00.000Z',
      probe_status: 'ready',
      selected_route: 'native_tools',
      features: {
        chat_supported: true,
        alternate_response_api_supported: false,
        streaming_supported: true,
        native_tools_supported: true,
        parallel_tool_calls_supported: false,
        thinking_or_reasoning_supported: false,
        content_null_between_deltas_seen: false,
      },
      observed: {
        tool_call_delta_shape: 'unknown',
        max_context_advertised: 32768,
        observed_first_token_latency_ms: null,
        observed_tool_call_latency_ms: null,
      },
      diagnostics: { reason: null, last_error_code: null },
    },
  ];

  applyManagedInitializePayload(service, {
    active_engine: 'ollama',
    active_model: 'qwen2.5:14b',
    provider_capability_profiles: profiles,
  });

  assert.deepEqual(service.currentStatus.provider_capability_profiles, profiles);

  service.dispose();
});

test('managed sidecar initialize defaults provider_capability_profiles to empty array when missing', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-shell-managed-profiles-empty-'));
  trackDirectory(userDataPath);

  const service = new BackendService({
    userDataPath,
    safeStorage: createFakeSafeStorage(),
  });

  applyManagedInitializePayload(service, {
    active_engine: 'ollama',
    active_model: 'qwen2.5:14b',
  });

  assert.deepEqual(service.currentStatus.provider_capability_profiles, []);

  service.dispose();
});
