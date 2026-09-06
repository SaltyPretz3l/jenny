const test = require('node:test');
const assert = require('node:assert/strict');

const { startManagedSidecarChatStream } = require('../../services/backend/managed-sidecar-chat');

function createService({ sessionSummary, sessionMessages, linkedMessages }) {
  let capturedParams = null;
  let activeTurn = null;
  const persistedMessages = [];
  const linkedSummary = {
    id: 'linked_1',
    title: 'Linked Session',
    updated_at: '2026-03-19T08:30:00.000Z',
    linked_session_ids: [],
  };
  const service = {
    activeStreams: new Map(),
    pendingToolApprovals: new Map(),
    currentModel: 'mock-v1',
    personalityWorkspace: {
      getCompiledContext: async () => '## Personality\nBe grounded.',
    },
    attachmentAssetStore: null,
    emittedEvents: [],
    serviceLogs: [],
    sessionStore: {
      createSessionWithId() {},
      getSession(sessionId) {
        if (sessionId === 'linked_1') {
          return linkedSummary;
        }
        return sessionSummary;
      },
      getSessionMessages(sessionId) {
        return sessionId === 'linked_1' ? linkedMessages : sessionMessages;
      },
      getActiveTurn() {
        return activeTurn;
      },
      appendMessage(_sessionId, message) {
        persistedMessages.push(message);
        // Mirror the real store contract: a truthy return means ACCEPTED.
        // Bare `{}` (pre-fix) worked only because startActiveTurn/persistUserTurn's
        // return values were discarded; SP-19 containment now fails the start
        // on a falsy return (chat-stream-managed-runtime.js persistUserMessage).
        return message;
      },
      updateMessage() {},
      setActiveTurn(_sessionId, nextActiveTurn) {
        activeTurn = nextActiveTurn || null;
        return activeTurn;
      },
      clearActiveTurn() {
        activeTurn = null;
        return true;
      },
      setTurnIdentity(_sessionId, identity) {
        sessionSummary.session_incarnation = identity.session_incarnation;
        sessionSummary.turn_generation = identity.turn_generation;
        return sessionSummary;
      },
      flushSession() {
        return true;
      },
      setSessionPreferences() {},
    },
    emit(eventName, payload) {
      this.emittedEvents.push({ eventName, payload });
    },
    _emitServiceLog(level, event, details) {
      this.serviceLogs.push({ level, event, details });
    },
    async _resolveModel() {
      return 'mock-v1';
    },
    async recallApprovedMemories() {
      return { memories: [] };
    },
    async recallRecentApprovedMemories() {
      return { memories: [] };
    },
    async setSessionPreferences() {},
    async renameSession() {},
    async _restartManagedSidecar() {},
    sidecarClient: {
      async chatSend(params, options = {}) {
        capturedParams = params;
        options.onNotification?.({
          method: 'chat.token',
          params: { delta: 'done' },
        });
        options.onNotification?.({
          method: 'chat.done',
          params: {
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
              provider: 'mock',
              model: 'mock-v1',
              estimated: false,
            },
          },
        });
        return { status: 'completed' };
      },
    },
  };
  return { service, persistedMessages, getCapturedParams: () => capturedParams };
}

async function runManagedSend(overrides = {}) {
  const { service, getCapturedParams } = createService({
    sessionSummary: {
      id: 'active',
      linked_session_ids: ['linked_1'],
      context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    },
    sessionMessages: [
      { role: 'user', content: 'Earlier active session question', timestamp: '2026-03-19T09:00:00.000Z' },
      { role: 'user', content: 'Another active turn', timestamp: '2026-03-19T09:05:00.000Z' },
    ],
    linkedMessages: [
      { role: 'user', content: 'How should we plan the migration?', timestamp: '2026-03-19T08:00:00.000Z' },
      { role: 'assistant', content: 'Start with the service layer.', timestamp: '2026-03-19T08:01:00.000Z' },
    ],
    ...overrides,
  });

  const stream = await startManagedSidecarChatStream(service, {
    sessionId: 'active',
    prompt: 'Plan the migration work',
    visiblePrompt: 'Plan the migration work',
    attachments: [],
    runtimePreferredModel: 'mock-v1',
    normalizedInteractiveResponse: null,
    normalizedPreferences: {
      preferred_model: 'mock-v1',
      reasoning_effort: 'default',
      conversation_mode: 'chat',
      pending_question_batch: null,
      interactive_sequence_state: 'idle',
      interactive_round_count: 0,
      plan_mode: false,
    },
  });

  await service.activeStreams.get(stream.streamId)._pendingPromise;
  return getCapturedParams();
}

function contextBlockKinds(params) {
  return (params.context_blocks || []).map((block) => block.kind);
}

test('managed sidecar chat injects linked session recall for managed sends with links', async () => {
  const params = await runManagedSend();
  // The per-turn overlays ride the TYPED `context_blocks` channel, never
  // `params.messages`. Request history is untrusted on the sidecar: its
  // semantic admission gate drops every {role:'system'} row history carries,
  // so a spliced overlay was silently discarded before inference. See
  // services/backend/chat-send-context-blocks.js for the contract.
  assert.deepEqual(contextBlockKinds(params), ['personality', 'linked_session']);
  const [personalityBlock, linkedBlock] = params.context_blocks;
  assert.equal(personalityBlock.content, '## Personality\nBe grounded.');
  assert.match(linkedBlock.content, /Linked session context:/);
  assert.match(linkedBlock.content, /Start with the service layer/);
  assert.equal(params.messages.some((message) => message.role === 'system'), false);
});

test('managed sidecar chat skips linked session recall for fresh history and no links', async () => {
  const freshParams = await runManagedSend({
    sessionSummary: {
      id: 'active',
      linked_session_ids: ['linked_1'],
      context_preferences: { history_scope: 'fresh', include_personality: true, include_memory: true },
    },
  });
  // Each case pins the FULL kind list rather than only asserting the absence of
  // linked recall: an absence-only oracle would stay green even if context
  // assembly stopped emitting blocks altogether (which is exactly how the
  // pre-`context_blocks` version of this test kept passing after the overlays
  // moved off `params.messages`).
  assert.deepEqual(contextBlockKinds(freshParams), ['personality']);

  const noLinkParams = await runManagedSend({
    sessionSummary: {
      id: 'active',
      linked_session_ids: [],
      context_preferences: { history_scope: 'session', include_personality: true, include_memory: true },
    },
  });
  assert.deepEqual(contextBlockKinds(noLinkParams), ['personality']);
});
