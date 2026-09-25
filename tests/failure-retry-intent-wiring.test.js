'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reconcileAcceptedRegenerate,
} = require('../renderer/chat/renderer-send-flow-helpers');
const {
  createSendMessageActions,
} = require('../renderer/chat/renderer-send-message-actions');
const {
  createShellRuntimeController,
} = require('../renderer/shell/renderer-shell-runtime-utils');
const {
  createManagedChatStreamRuntime,
} = require('../services/backend/chat-stream-managed-runtime');
const {
  BackendService,
} = require('../services/backend/backend-service');
const {
  startLocalEngineChatStream,
} = require('../services/backend/local-engine-requests');
const {
  startManagedSidecarChatStream,
} = require('../services/backend/managed-sidecar-chat');
const {
  SessionTurnActorRegistry,
} = require('../services/backend/session-turn-actor');

test('retry recovery is the only renderer action that originates failureRetry', async () => {
  const controller = createShellRuntimeController({ state: {}, callbacks: {} });
  const calls = [];

  await controller.handleErrorRecoveryAction(
    { action: 'retry', messageId: 'assistant_failed' },
    { handleRegenerateMessage: async (...args) => calls.push(args) }
  );

  assert.deepEqual(calls, [[
    'assistant_failed',
    { failureRetry: true },
  ]]);
});

test('regenerate forwards failureRetry only when the caller supplies the retry intent', async () => {
  const sendCalls = [];
  const reconcileCalls = [];
  const actions = createSendMessageActions({
    resolveFollowUpActionBlock: () => ({ blocked: false, reason: '' }),
    getCurrentSessionMessages: () => [
      { id: 'user_1', role: 'user', content: 'Prompt' },
      { id: 'assistant_1', role: 'assistant', content: 'Failed attempt' },
    ],
    getLatestReplyAssistantMessageId: () => 'assistant_1',
    resolveRegenerateRequest: () => ({
      allowed: true,
      prompt: 'Prompt',
      visiblePrompt: 'Prompt',
      replayImageAttachments: [],
      sourceMessageId: 'user_1',
      targetMessageId: 'assistant_1',
    }),
    getCurrentSessionId: () => 'session_1',
    startPromptSend: async (_prompt, options) => {
      sendCalls.push(options);
      options.onAuthoritativeStart({ identity: { userMessageId: 'user_1' } });
      return { sessionId: 'session_1', streamId: 'stream_1' };
    },
    reconcileAcceptedRegenerate: (payload) => {
      reconcileCalls.push(payload);
      return true;
    },
  });

  await actions.handleRegenerateMessage('assistant_1', { failureRetry: true });
  await actions.handleRegenerateMessage('assistant_1');

  assert.equal(sendCalls[0].failureRetry, true);
  assert.equal(reconcileCalls[0].failureRetry, true);
  assert.equal(Object.hasOwn(sendCalls[1], 'failureRetry'), false);
  assert.equal(Object.hasOwn(reconcileCalls[1], 'failureRetry'), false);
});

function captureManagedTruncateOptions(failureRetry) {
  const streamId = failureRetry === true ? 'stream_retry' : 'stream_edit';
  const turnLease = {
    identity: {
      streamId,
      turnId: streamId,
    },
  };
  const truncateCalls = [];
  const service = {
    sessionStore: {
      getActiveTurn() {
        return { request_id: streamId, stream_id: streamId };
      },
      truncateAfterMessage(sessionId, messageId, options) {
        truncateCalls.push({ sessionId, messageId, options });
        return { id: messageId };
      },
    },
    _emitServiceLog() {},
  };
  const runtime = createManagedChatStreamRuntime({
    service,
    resolvedSessionId: 'session_1',
    streamId,
    normalizedPreferences: {
      conversation_mode: 'chat',
      interactive_round_count: 0,
    },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user_1',
    reuseExistingUserMessage: true,
    failureRetry,
    turnLease,
  });

  assert.equal(runtime.persistUserMessage(), true);
  assert.equal(truncateCalls.length, 1);
  return truncateCalls[0].options;
}

test('managed persistence maps failureRetry to preserveSupersededTurn only for a retry', () => {
  const retryOptions = captureManagedTruncateOptions(true);
  const editOptions = captureManagedTruncateOptions(undefined);

  assert.equal(retryOptions.preserveSupersededTurn, true);
  assert.equal(Object.hasOwn(editOptions, 'preserveSupersededTurn'), false);
});

function reconcileMessages(failureRetry) {
  const messages = [
    { id: 'user_1', role: 'user', content: 'Prompt' },
    { id: 'assistant_1', role: 'assistant', content: 'Failed attempt' },
  ];
  let reconciledMessages = null;
  let summaryPatch = null;
  let renderCount = 0;
  let logCount = 0;
  const payload = {
    sessionId: 'session_1',
    sourceMessageId: 'user_1',
    targetMessageId: 'assistant_1',
    startResult: { identity: { userMessageId: 'user_1' } },
    ...(failureRetry === true ? { failureRetry: true } : {}),
  };
  const accepted = reconcileAcceptedRegenerate(payload, {
    getSessionMessages: () => messages,
    setSessionMessages: (_sessionId, nextMessages) => { reconciledMessages = nextMessages; },
    patchSessionSummary: (_sessionId, patch) => { summaryPatch = patch; },
    clearProjectionContextCacheForSession() {},
    renderAll: () => { renderCount += 1; },
    appendClientLog: () => { logCount += 1; },
  });
  return { accepted, reconciledMessages, summaryPatch, renderCount, logCount };
}

test('renderer reconciliation keeps a failed attempt for retry and still slices an edit', () => {
  const retry = reconcileMessages(true);
  const edit = reconcileMessages(false);

  assert.equal(retry.accepted, true);
  assert.deepEqual(retry.reconciledMessages.map((message) => message.id), ['user_1', 'assistant_1']);
  assert.equal(retry.summaryPatch.message_count, 2);
  assert.equal(retry.summaryPatch.last_message_preview, 'Failed attempt');
  assert.equal(retry.renderCount, 1);
  assert.equal(retry.logCount, 1);

  assert.equal(edit.accepted, true);
  assert.deepEqual(edit.reconciledMessages.map((message) => message.id), ['user_1']);
  assert.equal(edit.summaryPatch.message_count, 1);
  assert.equal(edit.summaryPatch.last_message_preview, 'Prompt');
  assert.equal(edit.renderCount, 1);
  assert.equal(edit.logCount, 1);
});

// The two forwarding hops, behaviourally.
//
// The version of this coverage that came back from the implementer asserted
// REGEXES against the source of five files -- including an exact count of
// `failureRetry,` lines in local-engine-requests.js. That breaks on harmless
// reformatting and, worse, can pass while the value is shadowed or dropped:
// it pins syntax, not behaviour. Both hops are reachable with small stubs, so
// they are tested by driving them.

test('editAndRegenerate forwards the retry intent, and omits it otherwise', async () => {
  // editAndRegenerate touches only `this.startChatStream`, so a fake receiver
  // is enough and no BackendService has to be constructed.
  const captured = [];
  const receiver = {
    startChatStream: async (payload) => { captured.push(payload); return { streamId: 'stream_1' }; },
  };
  const call = (extra) => BackendService.prototype.editAndRegenerate.call(receiver, {
    sessionId: 'session_1',
    editedMessageId: 'user_1',
    ...extra,
  });

  await call({ failureRetry: true });
  await call({});
  // The contract says non-boolean must behave exactly as today, so a truthy
  // string must NOT be promoted into the retry mode.
  await call({ failureRetry: 'yes' });

  // Always a boolean past this boundary -- a stronger contract than
  // absent-when-false, and the reason the normalization is here at all.
  assert.equal(captured[0].failureRetry, true);
  assert.equal(captured[1].failureRetry, false);
  assert.equal(
    captured[2].failureRetry,
    false,
    'a truthy non-boolean must not turn a prompt edit into a history-preserving retry'
  );
});

test('the local-engine request shape carries failureRetry to the managed call', async () => {
  // This hop is why the first fenced run stopped: startLocalEngineChatStream
  // destructures a FIXED request shape, so a field it does not name is dropped
  // silently and the flag would never reach either store.
  //
  // One service per call, sequentially: a second start against the same stub
  // session trips the interrupted-turn recovery guard rather than the wiring.
  async function captureManagedArgs(extra) {
    const managedCalls = [];
    // No editedMessageId: this file forwards `failureRetry` from its fixed
    // request shape regardless of the edit anchor, and asking reserveStart for
    // the edit path would mean building turn-recovery scaffolding to prove a
    // hop that does not depend on it.
    const session = {
      id: 's',
      active_turn: null,
    };
    const store = {
      getSession: () => session,
      getSessionMessages: () => [],
      getActiveTurn: () => session.active_turn,
      setTurnIdentity(_sessionId, identity) { Object.assign(session, identity); return session; },
      setActiveTurn: (_id, activeTurn) => { session.active_turn = activeTurn; return session; },
      clearActiveTurn: () => { session.active_turn = null; return session; },
      flushSession: () => true,
    };
    const service = {
      sessionStore: store,
      activeStreams: new Map(),
      offlineIntelligenceService: undefined,
      _startManagedSidecarChatStream: (args) => { managedCalls.push(args); return 'MANAGED_STREAM'; },
    };
    await startLocalEngineChatStream(service, {
      sessionId: 's',
      prompt: 'p',
      visiblePrompt: 'p',
      traceId: 't',
      attachments: [],
      ...extra,
    });
    assert.equal(managedCalls.length, 1);
    return managedCalls[0];
  }

  assert.equal(
    (await captureManagedArgs({ failureRetry: true })).failureRetry,
    true,
    'the retry intent must survive the fixed request shape'
  );
  assert.equal((await captureManagedArgs({ failureRetry: false })).failureRetry, false);
});

function reservationLease() {
  return {
    identity: {
      sessionId: 'session_1',
      sessionIncarnation: 'inc_1',
      generation: 1,
      turnId: 'stream_1',
      streamId: 'stream_1',
      userMessageId: 'user_1',
    },
    editedMessageId: 'user_1',
  };
}

async function captureLocalReservation(failureRetry) {
  const calls = [];
  const registry = new SessionTurnActorRegistry();
  registry.reserveStart = (args) => {
    calls.push(args);
    return reservationLease();
  };
  const service = {
    sessionStore: {},
    activeStreams: new Map(),
    sessionTurnActorRegistry: registry,
    _startManagedSidecarChatStream: async () => ({ streamId: 'stream_1' }),
  };
  await startLocalEngineChatStream(service, {
    sessionId: 'session_1',
    prompt: 'Prompt',
    visiblePrompt: 'Prompt',
    attachments: [],
    editedMessageId: 'user_1',
    failureRetry,
  });
  return calls[0];
}

async function captureManagedFallbackReservation(failureRetry) {
  const calls = [];
  const registry = new SessionTurnActorRegistry();
  registry.reserveStart = (args) => {
    calls.push(args);
    return reservationLease();
  };
  registry.attachController = () => false;
  const service = {
    sessionStore: {
      getSession: () => ({
        id: 'session_1',
        title: 'Existing',
        created_at: '2026-09-04T00:00:00.000Z',
        session_start_date: '2026-09-04',
        messages: [{ id: 'user_1', role: 'user', content: 'Prompt' }],
      }),
    },
    activeStreams: new Map(),
    sessionTurnActorRegistry: registry,
    featureFlags: {},
  };
  await assert.rejects(
    startManagedSidecarChatStream(service, {
      sessionId: 'session_1',
      prompt: 'Prompt',
      visiblePrompt: 'Prompt',
      attachments: [],
      normalizedInteractiveResponse: null,
      normalizedPreferences: {
        plan_mode: false,
        interactive_round_count: 0,
      },
      editedMessageId: 'user_1',
      failureRetry,
    }),
    /deleted before the stream could start/i
  );
  return calls[0];
}

test('both actor reservation call sites forward only strict boolean failureRetry', async () => {
  for (const capture of [captureLocalReservation, captureManagedFallbackReservation]) {
    assert.equal((await capture(true)).failureRetry, true);
    assert.equal((await capture(false)).failureRetry, false);
    assert.equal((await capture('yes')).failureRetry, false);
    assert.equal((await capture(undefined)).failureRetry, false);
  }
});

test('snapshot capture precedes truncation and capture failure warns once without blocking retry', () => {
  const order = [];
  const logs = [];
  const session = {
    id: 'session_1',
    session_incarnation: 'inc_1',
    turn_generation: 0,
    active_turn: null,
    messages: [
      { id: 'user_1', role: 'user', content: 'Prompt', turn_id: 'old_turn' },
      {
        id: 'assistant_old',
        role: 'assistant',
        content: 'Failed',
        status: 'runtime_error',
        parent_stream_id: 'old_turn',
      },
    ],
  };
  const store = {
    getSession: () => session,
    getSessionMessages: () => session.messages,
    getActiveTurn: () => session.active_turn,
    setTurnIdentity(_sessionId, identity) {
      session.session_incarnation = identity.session_incarnation;
      session.turn_generation = identity.turn_generation;
      return session;
    },
    setActiveTurn(_sessionId, activeTurn) {
      session.active_turn = activeTurn;
      return session;
    },
    clearActiveTurn() {
      session.active_turn = null;
      return session;
    },
    flushSession: () => true,
    captureFailureRetryReasoning() {
      order.push('capture');
      throw new Error('secret reasoning payload must stay redacted');
    },
    truncateAfterMessage() {
      order.push('truncate');
      return { id: 'session_1' };
    },
  };
  const registry = new SessionTurnActorRegistry({
    logger(level, event, details) {
      logs.push({ level, event, details });
    },
  });
  const lease = registry.reserveStart({
    sessionId: 'session_1',
    store,
    activeStreams: new Map(),
    editedMessageId: 'user_1',
    failureRetry: true,
    failureRetryReasoningCarry: true,
  });
  const runtime = createManagedChatStreamRuntime({
    service: { sessionStore: store, sessionTurnActors: registry, _emitServiceLog() {} },
    resolvedSessionId: 'session_1',
    streamId: lease.identity.streamId,
    normalizedPreferences: { conversation_mode: 'chat', interactive_round_count: 0 },
    normalizedInteractiveResponse: null,
    normalizedAttachments: [],
    transcriptPrompt: 'Prompt',
    userMessageId: 'user_1',
    reuseExistingUserMessage: true,
    failureRetry: true,
    turnLease: lease,
  });

  assert.equal(runtime.persistUserMessage(), true, 'retry must continue after snapshot failure');
  assert.deepEqual(order, ['capture', 'truncate']);
  const warnings = logs.filter((entry) => (
    entry.event === 'chat.failure_retry_reasoning_snapshot_failed'
  ));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, 'WARN');
  assert.equal(warnings[0].details.sessionId, 'session_1');
  assert.equal(warnings[0].details.streamId, lease.identity.streamId);
  assert.equal(warnings[0].details.reason, 'snapshot_capture_exception');
  assert.equal(JSON.stringify(warnings).includes('secret reasoning payload'), false);
});
