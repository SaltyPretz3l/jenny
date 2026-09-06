// SP-19 (backend half) containment: a refused active_turn claim or a refused
// user-message persist must fail the managed start BEFORE any provider
// invocation. Pre-fix, chat-stream-managed-runtime.js's persistUserMessage()
// discarded startActiveTurn's return value and, on a refused user-message
// append, logged a WARN but still called rememberPersistedUserStream(),
// still set userMessagePersisted = true, and returned true -- so the turn
// went on to call the sidecar and paint a visible completion for a prompt
// that was never durably saved (see
// docs/reports/ai-harness-review-handoff-2026-07-13/VERIFICATION_RECORD_2026-07-13.md,
// Cluster D, SP-19).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  startManagedSidecarChatStream,
} = require('../../services/backend/managed-sidecar-chat');
const {
  getPersistedUserStreamRegistry,
  hasPersistedUserStream,
} = require('../../services/backend/chat-stream-persisted-user-registry');
const {
  buildManagedChatRequest,
  createManagedChatServiceStub,
} = require('../helpers/managed-sidecar-chat-lifecycle-helpers');

// A chat.send stub that counts invocations and would complete normally if
// ever reached -- proves a refused start never talks to the sidecar at all.
function stubCountingChatSend(service) {
  let callCount = 0;
  service.sidecarManager = {
    process: { pid: 4242 },
    getStatus: () => ({ phase: 'ready' }),
  };
  service.sidecarClient = {
    connected: true,
    async chatSend(_params, options = {}) {
      callCount += 1;
      options.onNotification({ method: 'chat.token', params: { delta: 'should never run' } });
      options.onNotification({ method: 'chat.done', params: {} });
      return { status: 'completed' };
    },
  };
  return {
    get callCount() {
      return callCount;
    },
  };
}

test('SP-19 (a): a refused active_turn claim fails the start before any provider invocation', async () => {
  const service = createManagedChatServiceStub();
  const sidecar = stubCountingChatSend(service);
  const sessionId = 'session_refused_claim';
  service.sessionStore.createSessionWithId(sessionId, {});

  // Refuse only the active_turn claim (setActiveTurn); appendMessage
  // (persistUserTurn) is left working normally so this test isolates the
  // claim-refusal path from the persist-refusal path covered below.
  service.sessionStore.setActiveTurn = () => null;

  await assert.rejects(
    startManagedSidecarChatStream(service, buildManagedChatRequest({
      sessionId,
      prompt: 'a prompt whose active_turn claim is refused',
    })),
    /active_turn claim was refused/
  );

  assert.equal(sidecar.callCount, 0, 'a refused active_turn claim must never reach the sidecar');
  assert.equal(
    getPersistedUserStreamRegistry(service).size,
    0,
    'the persisted-user registry must not be marked for a refused start'
  );
  assert.equal(
    service.sessionMessages.some((message) => message.role === 'user'),
    false,
    'no user message may be persisted when the active_turn claim itself was refused'
  );
  assert.equal(service.activeStreams.size, 0, 'no stream controller is published for a refused claim');
});

test('SP-19 (b): a refused user-message persist fails the start before any provider invocation', async () => {
  const service = createManagedChatServiceStub();
  const sidecar = stubCountingChatSend(service);
  const sessionId = 'session_refused_user_persist';
  service.sessionStore.createSessionWithId(sessionId, {});

  // Refuse only the user-message append; the active_turn claim itself
  // succeeds, so the fix must also release that claim before failing.
  service.sessionStore.appendMessage = () => null;

  const stream = await startManagedSidecarChatStream(service, buildManagedChatRequest({
    sessionId,
    prompt: 'a prompt the store refuses to persist',
  }));
  const controller = service.activeStreams.get(stream.streamId);
  await controller._pendingPromise;

  assert.equal(sidecar.callCount, 0, 'a refused user-message persist must never reach the sidecar');
  assert.equal(
    hasPersistedUserStream(service, stream.streamId),
    false,
    'the persisted-user registry must not be marked for a refused start'
  );
  assert.equal(
    service.sessionStore.getActiveTurn(sessionId),
    null,
    'the active_turn claim must be released when the user-message persist is refused'
  );
  const errorEvents = service.emittedEvents.filter(
    (entry) => entry.eventName === 'chat-stream' && entry.payload?.type === 'error'
  );
  assert.equal(errorEvents.length, 1, 'the renderer must receive exactly one terminal error');
});
