// SP-20 (backend half) containment: an explicit tool-approval denial that
// terminates the turn (sidecar chat.done stop_reason: 'denied', RPC result
// {status: 'denied'}) must reach the renderer as exactly one terminal and
// must compare-and-clear the persisted active_turn -- pre-fix, the denial
// branch in chat-stream-managed-runtime.js's settleTerminalResult only called
// emitThinkingStatus('') and returned, so no renderer terminal was ever sent
// and active_turn stayed claimed until the launch-time orphan reconciler
// eventually cleared it on restart. The success-path diagnostic dump in
// managed-sidecar-chat.js also hardcoded TERMINAL_STATUS_COMPLETED regardless
// of the actual settled status. See
// docs/reports/ai-harness-review-handoff-2026-07-13/VERIFICATION_RECORD_2026-07-13.md,
// Cluster C, SP-20.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  createManagedChatStreamRuntime,
} = require('../../services/backend/chat-stream-managed-runtime');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
  waitForDiagnosticDump,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

// A chat.send stub whose sidecar denies the turn via the RPC response status
// directly (no bad-stop_reason chat.done notification in between) -- this is
// the settleTerminalResult "denialSilent" path the finding cites
// (chat-stream-managed-runtime.js's settleTerminalResult, reached from
// managed-sidecar-chat.js:772's `await runtime.settleTerminalResult(result)`
// with NO throw, so the turn never reaches the generic catch-block error
// handling at all). This is distinct from the OTHER denial trigger already
// covered by tests/managed-sidecar-chat-dark-paths.test.js (a chat.done
// stop_reason: 'denied' notification, which sets sidecarDoneTerminalError and
// throws into the catch block instead).
function stubDeniedChatSend(service) {
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, options = {}) {
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'denied' };
    },
  };
}

test('SP-20: a denied terminal clears active_turn and emits exactly one renderer terminal', async () => {
  const service = createManagedChatServiceStub();
  stubDeniedChatSend(service);
  const sessionId = 'session_denied_terminal_l06';
  service.sessionStore.createSessionWithId(sessionId, {});

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'Try something risky',
  }));
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;

  assert.equal(
    service.sessionStore.getActiveTurn(sessionId),
    null,
    'a denied terminal must compare-and-clear the persisted active_turn'
  );

  const terminalEvents = service.emittedEvents.filter(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
  );
  assert.equal(terminalEvents.length, 1, 'exactly one renderer terminal must be emitted for the denial');
  assert.equal(terminalEvents[0].payload.status, 'denied');

  assert.equal(
    service.sessionMessages.some((message) => message.role === 'assistant'),
    false,
    'a denied terminal must not persist a phantom assistant failure row'
  );

  // A follow-up send on the same session must be immediately admissible --
  // pre-fix, the un-cleared active_turn wedged the session until the
  // launch-time orphan reconciler eventually reclaimed it on restart.
  const followUp = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'Try something safer',
  }));
  assert.ok(followUp.streamId, 'the follow-up send must be admitted, not rejected as session_busy');
});

test('SP-20: diagnostics record the actual denied status, not a hardcoded completed', async (t) => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-diagnostic-denied-'));
  t.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));
  const service = createManagedChatServiceStub();
  service.options = { userDataPath };
  stubDeniedChatSend(service);
  const sessionId = 'session_denied_diagnostic_l06';
  service.sessionStore.createSessionWithId(sessionId, {});

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'Try something risky',
  }));
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;

  const diagnosticPath = await waitForDiagnosticDump(service, stream.streamId);
  const diagnostic = JSON.parse(fs.readFileSync(diagnosticPath, 'utf8'));
  assert.equal(diagnostic.terminal_status, 'denied');
});

test('SP-20: settleTerminalResult is idempotent across duplicate denial settlements', async () => {
  const streamId = 'stream-denied-dup';
  const sessionId = 'session-denied-dup';
  let activeTurn = { request_id: streamId, stream_id: streamId };
  const clearCalls = [];
  const emittedEvents = [];
  const service = {
    featureFlags: {},
    emit(eventName, payload) {
      emittedEvents.push({ eventName, payload });
    },
    _emitServiceLog() {},
    renameSession: async () => null,
    sessionStore: {
      appendMessage(_sessionId, message) {
        return message;
      },
      setSessionPreferences() {
        return null;
      },
      getActiveTurn() {
        return activeTurn;
      },
      setActiveTurn(_sessionId, next) {
        activeTurn = next;
        return next;
      },
      touchActiveTurn() {
        return null;
      },
      clearActiveTurn(_sessionId, match) {
        clearCalls.push(match);
        if (!activeTurn) {
          return null;
        }
        activeTurn = null;
        return null;
      },
    },
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: sessionId,
    streamId,
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: `user_${streamId}`,
  });

  const first = await runtime.settleTerminalResult({ status: 'denied' });
  const second = await runtime.settleTerminalResult({ status: 'denied' });

  assert.equal(first.status, 'denied');
  assert.equal(second.status, 'denied');
  assert.equal(
    clearCalls.length,
    1,
    'clearActiveTurn must only be invoked once across duplicate denial settlements'
  );
  const terminalEvents = emittedEvents.filter(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
  );
  assert.equal(
    terminalEvents.length,
    1,
    'exactly one terminal event must be emitted across duplicate denial settlements'
  );
});
