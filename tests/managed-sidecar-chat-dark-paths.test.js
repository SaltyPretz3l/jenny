'use strict';

// Dark-path coverage for services/backend/managed-sidecar-chat.js. Targets the
// uncovered diagnostic/timeout/settlement branches that the existing
// tests/managed-sidecar/*.test.js suite does NOT exercise:
//   - abortStreamForTimeout already-aborted early return (316-317)
//   - deterministic-transcript dump .catch WARN (421-428)
//   - image attachment vs non-mock/non-ollama engine throw (447-450)
//   - context-preference warning WARN log (469-473)
//   - success-path dump .catch WARN (763-770)
//   - clearInteractiveStateOnFailure on failure (790-791)
//   - sidecar terminal-subcode merge into error payload (817-818)
//   - error-path provider-phase .catch WARN (850-857)
//   - error-path dump .catch WARN (889-896)
//   - clearReconnectStateOnFailure else branch on a non-error terminal (915-916)
//   - sidecar restart unavailable WARN (952-958)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  startManagedSidecarChatStream,
} = require('../services/backend/managed-sidecar-chat');
const {
  SIDECAR_ERROR_CODES,
} = require('../services/backend/error-codes');
const { attachManagedPluginRuntime } = require('../services/backend/managed-plugin-runtime');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('./helpers/managed-sidecar-chat-lifecycle-helpers');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// Make dumpTurnDiagnostic({ service }) reject by giving service.options a getter
// that throws. managed-sidecar-chat.js never reads service.options itself; only
// turn-diagnostic-dump.js does, at its very first line, so this isolates the
// rejection to the diagnostic dump (and its sibling provider fetch never touches
// service.options).
function installThrowingOptionsGetter(service, message) {
  Object.defineProperty(service, 'options', {
    configurable: true,
    get() {
      throw new Error(message);
    },
  });
}

async function runToSettle(service, stream) {
  const controller = service.activeStreams.get(stream.streamId);
  assert.ok(controller, 'active stream controller must exist before settle');
  await controller._pendingPromise;
  return controller;
}

// Some catch blocks run on fire-and-forget promises (dump / provider phases)
// scheduled inside the turn but NOT awaited before _pendingPromise resolves.
// Poll the recorded service logs briefly so those tail rejections land.
async function waitForServiceLog(service, event, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = service.serviceLogs.find((log) => log.event === event);
    if (entry) {
      return entry;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

test('managed chat sends the committed plugin runtime authority', async () => {
  const service = createManagedChatServiceStub();
  let capturedAuthority = null;
  const adapter = attachManagedPluginRuntime(service, {
    requestApply: async () => ({ ok: true, attestation: {} }),
  });
  adapter.commit({
    envelope: {
      mode: 'plugin_runtime',
      plugin_runtime: {
        snapshot: {
          registry_revision: 4,
          dependency_graph_hash: 'a'.repeat(64),
          commit_epoch: 9,
          active_generation_id: 'gen-chat-authority',
          declarative_content: { skill_scopes: [{ contribution_id: 'main' }], prompts: [] },
        },
        declarative_content: [],
      },
    },
  });
  service.sidecarClient = {
    async chatSend(params, options = {}) {
      capturedAuthority = params.plugin_runtime_authority;
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_plugin_authority',
    prompt: 'Use plugin context',
  }));
  await runToSettle(service, stream);

  assert.deepEqual(capturedAuthority, {
    mode: 'plugin',
    registry_revision: 4,
    dependency_graph_hash: 'a'.repeat(64),
    commit_epoch: 9,
    active_generation_id: 'gen-chat-authority',
  });
  adapter.detach();
});

test('managed chat normalizes the one-send approval mode onto chat.send', async () => {
  const service = createManagedChatServiceStub();
  let capturedApprovalMode = null;
  service.sidecarClient = {
    async chatSend(params, options = {}) {
      capturedApprovalMode = params.approval_mode;
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    approvalMode: 'auto_run',
  }));
  await runToSettle(service, stream);

  assert.equal(capturedApprovalMode, 'auto_run');
});

test('managed chat forwards and persists enriched skill invocation metadata', async () => {
  const service = createManagedChatServiceStub();
  const invocation = {
    id: 'bundled/humanizer', name: 'Humanizer', scope: 'bundled', command: 'humanize',
  };
  let captured = null;
  service.sidecarClient = {
    async chatSend(params, options = {}) {
      captured = params.skill_invocation;
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_skill_invocation', skillInvocation: invocation,
  }));
  await runToSettle(service, stream);

  assert.deepEqual(captured, invocation);
  assert.deepEqual(service.sessionMessages.find((message) => message.role === 'user').skill_invocation, invocation);
});

test('managed edit hop supplies skill invocation replacement to the canonical store', async () => {
  const service = createManagedChatServiceStub();
  const first = { id: 'bundled/humanizer', name: 'Humanizer', scope: 'bundled', command: 'humanize' };
  const second = { id: 'bundled/meeting_notes', name: 'Meeting Notes', scope: 'bundled', command: 'meeting-notes' };
  service.sidecarClient = {
    async chatSend(_params, options = {}) {
      options.onNotification({ method: 'chat.done', params: { stop_reason: 'stop' } });
      return { status: 'completed' };
    },
  };
  const firstStream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_skill_edit', prompt: 'First', skillInvocation: first,
  }));
  await runToSettle(service, firstStream);
  const userMessage = service.sessionMessages.find((message) => message.role === 'user');
  let replacement = null;
  const truncate = service.sessionStore.truncateAfterMessage.bind(service.sessionStore);
  service.sessionStore.truncateAfterMessage = (sessionId, messageId, options) => {
    replacement = options.replaceMessageSkillInvocation;
    return truncate(sessionId, messageId, options);
  };

  const editStream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_skill_edit', prompt: 'Edited', editedMessageId: userMessage.id,
    skillInvocation: second,
  }));
  await runToSettle(service, editStream);
  assert.deepEqual(replacement, second);
});

test('abortStreamForTimeout returns early when the controller is already aborted (316-317)', async () => {
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const timerCallbacks = [];
  const service = createManagedChatServiceStub();

  global.setTimeout = (fn) => {
    timerCallbacks.push(fn);
    return { unref() {} };
  };
  global.clearTimeout = () => {};

  let abortReasons = [];
  service.sidecarClient = {
    async chatSend(_params, options = {}) {
      options.signal.addEventListener('abort', () => {
        abortReasons.push(options.signal.reason);
      }, { once: true });
      // timerCallbacks[0] = absolute backstop timer (armed first),
      // timerCallbacks[1] = idle watchdog (armed by noteStreamActivity next).
      // Fire idle first: it aborts the controller and records the timeout error.
      timerCallbacks[1]();
      // Fire absolute second: the controller is now aborted, so this re-entry
      // must hit the early `return` at 316-317 and NOT replace the abort reason.
      timerCallbacks[0]();
      return new Promise((_, reject) => {
        reject(options.signal.reason || new Error('aborted'));
      });
    },
  };

  try {
    const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
      sessionId: 'session_double_timeout_abort',
      prompt: 'Abort twice',
    }));
    await runToSettle(service, stream);
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }

  // Exactly one abort fired, and its message is the IDLE one — proving the
  // second (absolute) call returned early instead of re-aborting with the
  // absolute-cap message.
  assert.equal(abortReasons.length, 1);
  assert.match(String(abortReasons[0]?.message || ''), /idle for/);
  assert.doesNotMatch(String(abortReasons[0]?.message || ''), /absolute cap/);
  // The idle timeout still drives a single stream_timeout log and a restart.
  assert.equal(
    service.serviceLogs.filter((entry) => entry.event === 'chat.stream_timeout').length,
    1
  );
});

test('deterministic-transcript dump rejection is caught and logged (421-428)', async () => {
  const service = createManagedChatServiceStub();
  installThrowingOptionsGetter(service, 'deterministic-dump-boom');
  const sessionId = 'session_deterministic_dump_catch';
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Transcript recall',
    preferences: { preferred_model: 'mock-v1', session_start_date: '2026-04-29' },
  });
  service.sessionMessages.push({
    id: 'assistant_intro',
    role: 'assistant',
    kind: 'question_batch',
    content: 'shell text that should not win',
    interactive_batch: {
      intro_text: 'First visible Jenny sentence. Which tool should I show?',
      questions: [],
    },
  });
  let sidecarCalled = false;
  service.sidecarClient = {
    async chatSend() {
      sidecarCalled = true;
      throw new Error('sidecar must not run for deterministic recall');
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'What was the first sentence you sent me this session?',
  }));
  await runToSettle(service, stream);

  assert.equal(sidecarCalled, false, 'deterministic recall must not call the sidecar');
  // The deterministic completion still landed...
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.deterministic_transcript_answer_completed'),
    true
  );
  // ...and the rejected diagnostic dump was caught and surfaced as a WARN with
  // the thrown message (NOT swallowed, NOT propagated).
  const dumpWarn = await waitForServiceLog(service, 'chat.turn_diagnostic_dump_unexpected_error');
  assert.ok(dumpWarn, 'a turn_diagnostic_dump_unexpected_error WARN must be logged');
  assert.equal(dumpWarn.level, 'WARN');
  assert.equal(dumpWarn.details.message, 'deterministic-dump-boom');
  assert.equal(dumpWarn.details.sessionId, sessionId);
  assert.equal(dumpWarn.details.streamId, stream.streamId);
});

test('image attachment against a codex-cli engine reaches chat.send (sidecar owns the capability refusal)', async () => {
  const service = createManagedChatServiceStub();
  const tempDir = createTrackedTempDir('jenny-managed-codex-image-');
  const realImagePath = path.join(tempDir, 'capture.png');
  fs.writeFileSync(realImagePath, Buffer.from('image-bytes'));
  service.attachmentAssetStore = {
    resolveManagedAssetRealPath() {
      return realImagePath;
    },
  };
  service._resolveModel = async () => 'codex-cli/gpt-x';
  let chatSendCount = 0;
  service.sidecarClient = {
    async chatSend(_params, options = {}) {
      chatSendCount += 1;
      options.onNotification({ method: 'chat.token', params: { delta: 'Seen.' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_codex_image_reject',
    prompt: 'Describe this image',
    runtimePreferredModel: 'codex-cli/gpt-x',
    attachments: [{
      id: 'att_codex_img',
      kind: 'image',
      assetPath: path.join(tempDir, 'logical.png'),
      displayName: 'capture.png',
      mimeType: 'image/png',
    }],
  }));
  await runToSettle(service, stream);

  assert.equal(chatSendCount, 1);
  assert.equal(
    service.sessionMessages.some(
      (message) => message.role === 'assistant'
        && String(message.stream_error || '').includes('not supported by the active managed engine')
    ),
    false
  );
});

test('invalid stored context preferences emit a normalization WARN (469-473)', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_ctx_pref_warnings';
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Has bad prefs',
    preferences: { preferred_model: 'mock-v1', session_start_date: '2026-04-29' },
    // history_scope 'galaxy' normalizes to 'fresh' (a downgrade) -> warning;
    // include_memory 'sometimes' is non-boolean -> warning.
    context_preferences: { history_scope: 'galaxy', include_memory: 'sometimes' },
  });
  service.sidecarClient = {
    async chatSend(_params, options = {}) {
      options.onNotification({ method: 'chat.token', params: { delta: 'Hi.' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'Use my prefs',
  }));
  await runToSettle(service, stream);

  const prefWarn = service.serviceLogs.find(
    (entry) => entry.level === 'WARN' && entry.event === 'context.preferences_normalized'
  );
  assert.ok(prefWarn, 'a context.preferences_normalized WARN must be logged');
  assert.equal(prefWarn.details.sessionId, sessionId);
  assert.deepEqual(
    prefWarn.details.warnings.slice().sort(),
    ['context_preferences.history_scope:galaxy', 'context_preferences.include_memory'].sort()
  );
});

test('success-path diagnostic dump rejection is caught and logged (763-770)', async () => {
  const service = createManagedChatServiceStub();
  installThrowingOptionsGetter(service, 'success-dump-boom');
  service.sidecarClient = {
    async chatSend(_params, options = {}) {
      options.onNotification({ method: 'chat.token', params: { delta: 'All done.' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_success_dump_catch',
    prompt: 'Finish cleanly',
  }));
  await runToSettle(service, stream);

  // The turn completed successfully...
  const completeEvent = service.emittedEvents.find(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'complete'
  );
  assert.ok(completeEvent);
  assert.equal(completeEvent.payload.content, 'All done.');
  // ...and the rejected success-path dump was caught, surfacing the thrown
  // message as a WARN rather than crashing the settled turn.
  const dumpWarn = await waitForServiceLog(service, 'chat.turn_diagnostic_dump_unexpected_error');
  assert.ok(dumpWarn, 'success-path dump rejection must log a WARN');
  assert.equal(dumpWarn.level, 'WARN');
  assert.equal(dumpWarn.details.message, 'success-dump-boom');
  assert.equal(dumpWarn.details.streamId, stream.streamId);
});

test('interactive continuation remains retryable when a follow-up turn fails', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_clear_interactive_on_failure';
  const pendingBatch = {
    batch_id: 'ib_retry_after_failure',
    round_index: 1,
    intro_text: 'One detail.',
    questions: [{
      id: 'q1',
      prompt: 'Continue?',
      options: [{ id: 'yes', label: 'Yes' }],
    }],
  };
  // Pre-existing session in an in-flight interactive sequence.
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Interactive turn',
    preferences: {
      preferred_model: 'mock-v1',
      session_start_date: '2026-04-29',
      interactive_sequence_state: 'structured_active',
      pending_question_batch: pendingBatch,
    },
  });
  service.sidecarClient = {
    async chatSend() {
      throw new Error('provider blew up mid-interactive');
    },
  };
  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'My answer to your question',
    normalizedInteractiveResponse: {
      batch_id: pendingBatch.batch_id,
      round_index: 1,
      disposition: 'answered',
      batch_snapshot: pendingBatch,
      answers: [{ question_id: 'q1', option_id: 'yes', text: '' }],
    },
    normalizedPreferences: {
      interactive_sequence_state: 'structured_active',
      pending_question_batch: pendingBatch,
      interactive_round_count: 1,
    },
  }));
  await runToSettle(service, stream);

  const retained = service.sessionStore.getSession(sessionId);
  assert.equal(retained.pending_question_batch.batch_id, pendingBatch.batch_id);
  assert.equal(retained.pending_question_batch.continuation_token.consumed, false);
  assert.equal(retained.interactive_sequence_state, 'structured_active');
  // A failure row was still persisted (the interactive turn genuinely failed).
  const assistantFailure = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.ok(assistantFailure, 'a failure row must be persisted for the failed interactive turn');
  assert.equal(assistantFailure.status, 'runtime_error');
  assert.equal(assistantFailure.stream_error, 'provider blew up mid-interactive');
});

test('runtime terminal subcode is merged into an error payload that lacks one (817-818)', async () => {
  const service = createManagedChatServiceStub();
  service.sidecarClient = {
    async chatSend(_params, options = {}) {
      // A chat.error notification records sidecarTerminalSubcode in the runtime
      // error state without putting it on the thrown/returned terminal error.
      options.onNotification({
        method: 'chat.error',
        params: {
          message: 'provider overloaded',
          category: 'runtime',
          terminal_subcode: 'provider_overloaded',
        },
      });
      // A bare runtime_error terminal status carries NO terminal_subcode on the
      // settle error, so the merge at 817-818 must pull it from runtime state.
      return { status: 'runtime_error' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_terminal_subcode_merge',
    prompt: 'Overload the provider',
  }));
  await runToSettle(service, stream);

  const errorEvent = service.emittedEvents.find(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
  );
  assert.ok(errorEvent, 'an error event must be emitted');
  // The subcode reached the emitted payload only via the 817-818 merge.
  assert.equal(errorEvent.payload.terminal_subcode, 'provider_overloaded');
  const assistantFailure = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.ok(assistantFailure);
  assert.equal(assistantFailure.terminal_subcode, 'provider_overloaded');
});

test('error-path provider-phase recording rejection is caught and logged (850-857)', async () => {
  const service = createManagedChatServiceStub();
  // recordServicePhasePercentile delegates to this; make it throw ONLY for the
  // provider phase (not the finally-block completion_to_terminal_persist phase),
  // so the error-path fetchAndRecordProviderDiagnosticPhases() rejects.
  service.phasePercentilesAggregator = {
    record(phaseName) {
      if (phaseName === 'sidecar_request_sent_to_provider_request_start') {
        throw new Error('provider-phase-record-boom');
      }
    },
  };
  service.sidecarClient = {
    async chatSend() {
      const error = new Error('runtime failure with provider diagnostics');
      error.category = 'runtime';
      throw error;
    },
    async harnessTurnDiagnostic() {
      // A finite provider-phase number forces recordServicePhasePercentile to be
      // invoked for the provider phase, which then throws.
      return { provider_diagnostics: { time_to_provider_request_start_ms: 7 } };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_provider_phase_catch',
    prompt: 'Fail with diagnostics',
  }));
  await runToSettle(service, stream);

  const providerWarn = await waitForServiceLog(service, 'chat.provider_phase_percentiles_failed');
  assert.ok(providerWarn, 'a provider_phase_percentiles_failed WARN must be logged');
  assert.equal(providerWarn.level, 'WARN');
  assert.equal(providerWarn.details.message, 'provider-phase-record-boom');
  assert.equal(providerWarn.details.streamId, stream.streamId);
});

test('error-path diagnostic dump rejection is caught and logged (889-896)', async () => {
  const service = createManagedChatServiceStub();
  installThrowingOptionsGetter(service, 'error-dump-boom');
  service.sidecarClient = {
    async chatSend() {
      const error = new Error('runtime failure that triggers a dump');
      error.category = 'runtime';
      throw error;
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_error_dump_catch',
    prompt: 'Fail and dump',
  }));
  await runToSettle(service, stream);

  // The error path reached the non-completed terminal dump, which rejected on
  // the throwing options getter and was caught as a WARN.
  const dumpWarn = await waitForServiceLog(service, 'chat.turn_diagnostic_dump_unexpected_error');
  assert.ok(dumpWarn, 'error-path dump rejection must log a WARN');
  assert.equal(dumpWarn.level, 'WARN');
  assert.equal(dumpWarn.details.message, 'error-dump-boom');
  assert.equal(dumpWarn.details.streamId, stream.streamId);
  // It is the error path: an error event was emitted for the runtime failure.
  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
    ),
    true
  );
});

test('a denied terminal clears reconnect state instead of persisting a failure row (915-916)', async () => {
  const service = createManagedChatServiceStub();
  const sessionId = 'session_denied_terminal';
  service.sessionStore.createSessionWithId(sessionId, {
    title: 'Denied turn',
    preferences: { preferred_model: 'mock-v1', session_start_date: '2026-04-29' },
  });
  service.sidecarClient = {
    async chatSend(_params, options = {}) {
      // chat.done with a non-success stop_reason of 'denied' settles the turn as
      // a DENIED terminal: not an error status, so persistAssistantFailure and
      // logOnlyLateFailure are both false -> the else branch (clearReconnect).
      options.onNotification({
        method: 'chat.done',
        params: { stop_reason: 'denied' },
      });
      return { status: 'denied' };
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'Get denied',
  }));
  await runToSettle(service, stream);

  // No assistant failure row was written (the else branch ran, not persistFailureMessage)...
  const assistantMessage = service.sessionMessages.find((message) => message.role === 'assistant');
  assert.equal(assistantMessage, undefined, 'denied terminal must not persist an assistant failure row');
  // ...no error event was emitted (denied is silent)...
  assert.equal(
    service.emittedEvents.some(
      (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
    ),
    false
  );
  // ...and clearReconnectStateOnFailure cleared the active turn that
  // persistUserMessage had started.
  assert.equal(service.sessionStore.getActiveTurn(sessionId), null);
});

test('a process-exit failure with no restart helper logs sidecar_restart_unavailable (952-958)', async () => {
  const service = createManagedChatServiceStub();
  // Reaching the restart-helper-unavailable branch requires a restart reason
  // (process_exit) AND no _restartManagedSidecar on the service.
  delete service._restartManagedSidecar;
  service.sidecarClient = {
    connected: true,
    async chatSend() {
      const error = new Error('managed sidecar exited');
      error.error_code = SIDECAR_ERROR_CODES.PROCESS_EXIT;
      error.category = 'process_exit';
      error.retryable = true;
      throw error;
    },
  };

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId: 'session_restart_unavailable',
    prompt: 'Exit without a restarter',
  }));
  await runToSettle(service, stream);

  // The failure scheduled a process_exit reconnect reason...
  assert.equal(
    service.serviceLogs.some((entry) => entry.event === 'chat.sidecar_failure_reconnect_scheduled'),
    true
  );
  // ...but with no restart helper, the finally block logged the unavailable WARN
  // (instead of awaiting a restart).
  const unavailableWarn = service.serviceLogs.find(
    (entry) => entry.level === 'WARN' && entry.event === 'chat.sidecar_restart_unavailable'
  );
  assert.ok(unavailableWarn, 'a sidecar_restart_unavailable WARN must be logged');
  assert.equal(unavailableWarn.details.reason, 'chat.process_exit');
  assert.equal(unavailableWarn.details.streamId, stream.streamId);
});
