const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  validateImageAttachmentsForManagedSend,
} = require('../../services/backend/managed-sidecar-attachments');
const {
  AI_ERROR_CODES,
  SIDECAR_ERROR_CODES,
} = require('../../services/backend/error-codes');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

test('managed sidecar reconnects a stale client before sending a new chat turn', async () => {
  const service = createManagedChatServiceStub();
  let restartCount = 0;
  let chatSendCount = 0;
  service.sidecarManager = {
    process: null,
    getStatus: () => ({ phase: restartCount > 0 ? 'ready' : 'failed' }),
  };
  service.sidecarClient = {
    connected: false,
    async chatSend() {
      throw new Error('stale client should have been replaced');
    },
  };
  service._restartManagedSidecar = async (reason) => {
    restartCount += 1;
    assert.equal(reason, 'chat.preflight_reconnect');
    service.sidecarManager.process = { pid: 4242 };
    service.sidecarClient = {
      connected: true,
      async chatSend(_params, options = {}) {
        chatSendCount += 1;
        options.onNotification({
          method: 'chat.token',
          params: { delta: 'Reconnected.' },
        });
        options.onNotification({
          method: 'chat.done',
          params: {},
        });
        return { status: 'completed' };
      },
    };
    return true;
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_preflight_reconnect',
    prompt: 'Recover before sending',
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(restartCount, 1);
  assert.equal(chatSendCount, 1);
  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
    ),
    true
  );
});

test('managed sidecar preflights Ollama before sending an Ollama-backed chat turn', async () => {
  const service = createManagedChatServiceStub();
  let ensureCount = 0;
  let chatSendCount = 0;
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.ollamaManager = {
    async ensureRunning() {
      ensureCount += 1;
      return { started: true, external: false, ready: true };
    },
  };
  service._resolveModel = async () => 'qwen3.6:35b-a3b-ud-q4_k_xl';
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, options = {}) {
      chatSendCount += 1;
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Ollama is back.' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {},
      });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_ollama_preflight',
    prompt: 'Recover Ollama before sending',
    runtimePreferredModel: 'qwen3.6:35b-a3b-ud-q4_k_xl',
    normalizedPreferences: {
      preferred_model: 'qwen3.6:35b-a3b-ud-q4_k_xl',
    },
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(ensureCount, 1);
  assert.equal(chatSendCount, 1);
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.ollama_preflight_ready'),
    true
  );
  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
    ),
    true
  );
});

test('managed sidecar fails before context assembly when Ollama preflight cannot recover', async () => {
  const service = createManagedChatServiceStub();
  let chatSendCount = 0;
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.ollamaManager = {
    async ensureRunning() {
      return { started: false, external: false, ready: false };
    },
  };
  service._resolveModel = async () => 'qwen3.6:35b-a3b-ud-q4_k_xl';
  service.sidecarClient = {
    connected: true,
    async chatSend() {
      chatSendCount += 1;
      throw new Error('chat.send should not run when Ollama preflight fails');
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_ollama_preflight_failed',
    prompt: 'Fail before provider call',
    runtimePreferredModel: 'qwen3.6:35b-a3b-ud-q4_k_xl',
    normalizedPreferences: {
      preferred_model: 'qwen3.6:35b-a3b-ud-q4_k_xl',
    },
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(chatSendCount, 0);
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.context_assembly_started'),
    false
  );
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.ollama_preflight_unavailable'),
    true
  );
  const assistantFailure = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.ok(assistantFailure);
  assert.equal(assistantFailure.error_code, AI_ERROR_CODES.ENGINE_CONNECTION);
  assert.equal(assistantFailure.recovery_class, 'provider');
  assert.equal(assistantFailure.next_action, 'retry_turn');
});

test('managed sidecar blocks chat against the mock fallback when the engine stays down', async () => {
  const service = createManagedChatServiceStub();
  let chatSendCount = 0;
  let reinitializeCount = 0;
  service._lastEngineFallback = {
    requested_engine: 'ollama',
    reason: 'Ollama engine failed to initialize: EngineConnectionError: refused',
  };
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service._initializeManagedSidecar = async () => {
    reinitializeCount += 1;
  };
  service.sidecarClient = {
    connected: true,
    async chatSend() {
      chatSendCount += 1;
      throw new Error('chat.send must not run against the mock fallback engine');
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_engine_fallback_blocked',
    prompt: 'Should not reach the mock',
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(reinitializeCount, 1, 'one recovery attempt per send');
  assert.equal(chatSendCount, 0);
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.engine_fallback_preflight_blocked'),
    true
  );
  const assistantFailure = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.ok(assistantFailure);
  assert.equal(assistantFailure.error_code, AI_ERROR_CODES.ENGINE_CONNECTION);
  assert.equal(assistantFailure.recovery_class, 'provider');
  assert.equal(assistantFailure.next_action, 'retry_turn');
  assert.match(String(assistantFailure.stream_error || ''), /ollama engine is not active/i);
});

test('managed sidecar recovers from a boot-time engine fallback when the engine comes back', async () => {
  const service = createManagedChatServiceStub();
  let chatSendCount = 0;
  service._lastEngineFallback = {
    requested_engine: 'ollama',
    reason: 'Ollama engine failed to initialize: EngineConnectionError: refused',
  };
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service._initializeManagedSidecar = async () => {
    service._lastEngineFallback = null;
  };
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, options = {}) {
      chatSendCount += 1;
      options.onNotification({
        method: 'chat.token',
        params: { delta: 'Engine is back.' },
      });
      options.onNotification({
        method: 'chat.done',
        params: {},
      });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_engine_fallback_recovered',
    prompt: 'Recover the engine before sending',
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(chatSendCount, 1);
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.engine_fallback_recovered'),
    true
  );
  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
    ),
    true
  );
});

test('managed sidecar does not start a second reconnect while auto reconnect is pending', async () => {
  const service = createManagedChatServiceStub();
  let restartCount = 0;
  service._autoReconnectPending = true;
  service.sidecarManager = {
    process: null,
    getStatus: () => ({ phase: 'failed' }),
  };
  service.sidecarClient = {
    connected: false,
    async chatSend() {
      throw new Error('chat.send should not run while reconnect is pending');
    },
  };
  service._restartManagedSidecar = async () => {
    restartCount += 1;
    return false;
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_preflight_reconnect_pending',
    prompt: 'Recover while pending',
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(restartCount, 0);
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.sidecar_preflight_reconnect_pending'),
    true
  );
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.context_assembly_started'),
    false
  );
  const assistantFailure = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.ok(assistantFailure);
  assert.equal(assistantFailure.error_code, SIDECAR_ERROR_CODES.PROCESS_EXIT);
  assert.equal(assistantFailure.terminal_subcode, 'sidecar_reconnect_in_progress');
  assert.equal(assistantFailure.next_action, 'retry_turn');
  assert.equal(assistantFailure.recovery_class, 'sidecar_transport');
});

test('managed sidecar does not restart twice when preflight reconnect fails', async () => {
  const service = createManagedChatServiceStub();
  let restartCount = 0;
  service.sidecarManager = {
    process: null,
    getStatus: () => ({ phase: 'failed' }),
  };
  service.sidecarClient = {
    connected: false,
    async chatSend() {
      throw new Error('chat.send should not run after failed preflight reconnect');
    },
  };
  service._restartManagedSidecar = async () => {
    restartCount += 1;
    return false;
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_preflight_reconnect_failed',
    prompt: 'Reconnect fails',
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(restartCount, 1);
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.sidecar_failure_reconnect_scheduled'),
    false
  );
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.context_assembly_started'),
    false
  );
  const assistantFailure = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.ok(assistantFailure);
  assert.equal(assistantFailure.error_code, SIDECAR_ERROR_CODES.PROCESS_EXIT);
  assert.equal(assistantFailure.terminal_subcode, 'sidecar_reconnect_failed');
  assert.equal(assistantFailure.next_action, 'retry_turn');
});

test('managed sidecar handles unavailable preflight reconnect without rejecting stream', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarManager = {
    process: null,
    getStatus: () => ({ phase: 'failed' }),
  };
  service.sidecarClient = {
    connected: false,
    async chatSend() {
      throw new Error('chat.send should not run without a reconnect helper');
    },
  };
  delete service._restartManagedSidecar;

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_preflight_reconnect_unavailable',
    prompt: 'Reconnect unavailable',
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.sidecar_restart_unavailable'),
    false
  );
  const assistantFailure = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.ok(assistantFailure);
  assert.equal(assistantFailure.error_code, SIDECAR_ERROR_CODES.PROCESS_EXIT);
  assert.equal(assistantFailure.terminal_subcode, 'sidecar_reconnect_failed');
  assert.equal(assistantFailure.next_action, 'retry_turn');
});

test('managed sidecar reconnects after process-exit chat failures without replaying the turn', async () => {
  const service = createManagedChatServiceStub();
  let chatSendCount = 0;
  const restartReasons = [];
  service.sidecarManager = {
    process: { pid: 4343 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service._restartManagedSidecar = async (reason) => {
    restartReasons.push(reason);
    return true;
  };
  service.sidecarClient = {
    connected: true,
    chatSend: async () => {
      chatSendCount += 1;
      const error = new Error('managed sidecar exited');
      error.error_code = SIDECAR_ERROR_CODES.PROCESS_EXIT;
      error.category = 'process_exit';
      error.retryable = true;
      throw error;
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_process_exit_recovery',
    prompt: 'Fail once',
  }));

  await service.activeStreams.get(stream.streamId)._pendingPromise;

  assert.equal(chatSendCount, 1);
  assert.deepEqual(restartReasons, ['chat.process_exit']);
  const assistantFailure = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.ok(assistantFailure);
  assert.equal(assistantFailure.error_code, SIDECAR_ERROR_CODES.PROCESS_EXIT);
  assert.equal(assistantFailure.next_action, 'retry_turn');
  assert.equal(assistantFailure.recovery_class, 'sidecar_transport');
  assert.deepEqual(
    assistantFailure.recovery_actions.map((entry) => entry.id),
    ['retry_turn', 'restart_sidecar', 'open_diagnostics']
  );
  const assistantErrorEvent = service.sessionStore
    .getSessionTurnEvents('session_process_exit_recovery')
    .find((event) => event.kind === 'assistant_error');
  assert.ok(assistantErrorEvent);
  assert.equal(assistantErrorEvent.payload.next_action, 'retry_turn');
  assert.deepEqual(
    assistantErrorEvent.payload.recovery_actions.map((entry) => entry.id),
    ['retry_turn', 'restart_sidecar', 'open_diagnostics']
  );
});

test('managed sidecar rejects the send when auto-created session storage refuses the write', async () => {
  const service = createManagedChatServiceStub();
  let chatSendCount = 0;
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.sidecarClient = {
    connected: true,
    async chatSend() {
      chatSendCount += 1;
      throw new Error('chat.send should not run when the session could not be created');
    },
  };
  service.sessionStore.createSessionWithId = () => null;

  await assert.rejects(
    startManagedSidecarChatStream(service, buildManagedChatRequest({
      sessionId: '',
      prompt: 'No session to write into',
    })),
    /session could not be created/i
  );

  assert.equal(chatSendCount, 0);
  assert.equal(service.activeStreams.size, 0, 'rejected preflight must not leak an active stream');
});

// B3 (activeStreams leak on preflight throw): validateImageAttachmentsForManagedSend
// runs AFTER activeStreams used to be registered (managed-sidecar-chat.js ~165 vs
// the former ~125 registration site). Registration now happens only after this
// preflight validation passes, so a rejected image attachment must not leak an
// activeStreams entry — see services/backend/chat-stream-admission.js.
test('managed sidecar rejects an invalid image attachment before registering the stream (B3)', async () => {
  const service = createManagedChatServiceStub();
  let chatSendCount = 0;
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.attachmentAssetStore = {
    resolveManagedAssetRealPath() {
      // Falsy return forces validateImageAttachmentsForManagedSend to throw
      // "Image attachments must come from the app-managed local asset store."
      return '';
    },
  };
  service.sidecarClient = {
    connected: true,
    async chatSend() {
      chatSendCount += 1;
      throw new Error('chat.send should not run when image validation rejects the send');
    },
  };

  await assert.rejects(
    startManagedSidecarChatStream(service, buildManagedChatRequest({
      sessionId: 'session_preflight_bad_image',
      prompt: 'Describe this image',
      attachments: [{
        id: 'att_preflight_bad_image',
        kind: 'image',
        assetPath: '/not/a/managed/asset.png',
        displayName: 'asset.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        width: 1,
        height: 1,
      }],
    })),
    /app-managed local asset store/
  );

  assert.equal(chatSendCount, 0);
  assert.equal(service.activeStreams.size, 0, 'rejected preflight must not leak an active stream');
});

test('managed image validation fails closed without a containment resolver', () => {
  const attachments = [{ assetPath: __filename }];
  assert.throws(
    () => validateImageAttachmentsForManagedSend({}, attachments),
    /app-managed local asset store/
  );
  assert.throws(
    () => validateImageAttachmentsForManagedSend({
      attachmentAssetStore: { isManagedAssetPath: () => true },
    }, attachments),
    /app-managed local asset store/
  );
});

test('managed chat logs normalized renderer timing on send initiation', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, { onNotification }) {
      onNotification({ method: 'chat.token', params: { delta: 'Timed.' } });
      onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_send_timing',
    clientTiming: {
      send_started_at_ms: Date.now() - 20,
      local_render_latency_ms: 12,
    },
  }));
  await service.activeStreams.get(stream.streamId)._pendingPromise;

  const sendInitiated = service.serviceLogs.find((entry) => entry.event === 'chat.send_initiated');
  assert.equal(Number.isFinite(sendInitiated.details.ipc_latency_ms), true);
  assert.equal(sendInitiated.details.local_render_latency_ms, 12);
});
