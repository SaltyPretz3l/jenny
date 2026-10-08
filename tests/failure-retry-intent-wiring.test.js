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
