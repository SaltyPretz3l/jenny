const test = require('node:test');
const assert = require('node:assert/strict');

const { createSurfaceActivityWiring } = require('../renderer/app/renderer-app-surface-activity-wiring');
const { createSurfaceStatePipeline } = require('../renderer/chat/renderer-render-pipeline-surface-state');
const { createStreamLiveEventHandlers } = require('../renderer/chat/renderer-stream-handler-live-events');
const { createStreamToolHandlers } = require('../renderer/chat/renderer-stream-handler-tools');
const { createStreamHandlerRuntime } = require('../renderer/chat/renderer-stream-handler-runtime');
const { createSendController } = require('../renderer/chat/renderer-send-utils');

function createFakeManager(overrides = {}) {
  const calls = { setVisibleActivityScope: [], publishActivityPhase: [], publishStreamImpulse: [] };
  return {
    calls,
    setVisibleActivityScope(arg) { calls.setVisibleActivityScope.push(arg); },
    publishActivityPhase(arg) { calls.publishActivityPhase.push(arg); },
    publishStreamImpulse(arg) { calls.publishStreamImpulse.push(arg); },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unit tests: createSurfaceActivityWiring against a fake manager
// ---------------------------------------------------------------------------

test('onChatLifecycleSurfaceSync publishes scope then phase for the resolved session', () => {
  const manager = createFakeManager();
  const phaseCalls = [];
  const wiring = createSurfaceActivityWiring({
    manager,
    resolvePhase: (sessionId) => { phaseCalls.push(sessionId); return 'streaming'; },
    getStreamIdForSession: (sessionId) => (sessionId === 'session-1' ? 'stream-9' : null),
    state: { currentSessionId: 'session-1' },
  });

  wiring.onChatLifecycleSurfaceSync({ sessionId: 'session-1' });

  assert.deepEqual(manager.calls.setVisibleActivityScope, [{ sessionId: 'session-1', streamId: 'stream-9' }]);
  assert.deepEqual(manager.calls.publishActivityPhase, ['streaming']);
  assert.deepEqual(phaseCalls, ['session-1']);
});

test('onChatLifecycleSurfaceSync normalizes a non-string sessionId to a trimmed string', () => {
  const manager = createFakeManager();
  const wiring = createSurfaceActivityWiring({
    manager,
    resolvePhase: () => 'idle',
    getStreamIdForSession: () => '',
    state: {},
  });

  wiring.onChatLifecycleSurfaceSync({ sessionId: '  session-42  ' });

  assert.equal(manager.calls.setVisibleActivityScope[0].sessionId, 'session-42');
});

test('onChatLifecycleSurfaceSync falls back to state.currentSessionId when the payload omits one', () => {
  const manager = createFakeManager();
  const wiring = createSurfaceActivityWiring({
    manager,
    resolvePhase: () => 'idle',
    getStreamIdForSession: (sessionId) => (sessionId === 'session-fallback' ? 'stream-fb' : ''),
    state: { currentSessionId: 'session-fallback' },
  });

  wiring.onChatLifecycleSurfaceSync({});

  assert.equal(manager.calls.setVisibleActivityScope[0].sessionId, 'session-fallback');
  assert.equal(manager.calls.setVisibleActivityScope[0].streamId, 'stream-fb');
});

test('onChatLifecycleSurfaceSync passes streamId "" when the stream getter returns null', () => {
  const manager = createFakeManager();
  const wiring = createSurfaceActivityWiring({
    manager,
    resolvePhase: () => 'idle',
    getStreamIdForSession: () => null,
    state: { currentSessionId: 'session-2' },
  });

  wiring.onChatLifecycleSurfaceSync({ sessionId: 'session-2' });

  assert.deepEqual(manager.calls.setVisibleActivityScope, [{ sessionId: 'session-2', streamId: '' }]);
});

test('impulse wrappers publish the correct kind with sessionId, streamId, and timeStamp', () => {
  const manager = createFakeManager();
  const wiring = createSurfaceActivityWiring({ manager });

  wiring.publishFirstTokenImpulse({ sessionId: 's1', streamId: 'st1', timeStamp: 100 });
  wiring.publishToolStartImpulse({ sessionId: 's1', streamId: 'st1', timeStamp: 200 });
  wiring.publishCompleteImpulse({ sessionId: 's1', streamId: 'st1', timeStamp: 300 });
  wiring.publishCancelImpulse({ sessionId: 's1', streamId: 'st1', timeStamp: 400 });

  assert.deepEqual(manager.calls.publishStreamImpulse, [
    { sessionId: 's1', streamId: 'st1', kind: 'first-token', timeStamp: 100 },
    { sessionId: 's1', streamId: 'st1', kind: 'tool-start', timeStamp: 200 },
    { sessionId: 's1', streamId: 'st1', kind: 'complete', timeStamp: 300 },
    { sessionId: 's1', streamId: 'st1', kind: 'cancel', timeStamp: 400 },
  ]);
});

test('every wiring method is a safe no-op when manager is null', () => {
  const wiring = createSurfaceActivityWiring({ manager: null });

  wiring.onChatLifecycleSurfaceSync({ sessionId: 's1' });
  wiring.publishFirstTokenImpulse({ sessionId: 's1', streamId: 'st1' });
  wiring.publishToolStartImpulse({ sessionId: 's1', streamId: 'st1' });
  wiring.publishCompleteImpulse({ sessionId: 's1', streamId: 'st1' });
  wiring.publishCancelImpulse({ sessionId: 's1', streamId: 'st1' });

  assert.equal(wiring._diagnostics.failures, 0);
});

test('a throwing manager method is swallowed and counted on _diagnostics', () => {
  const manager = createFakeManager({
    setVisibleActivityScope() { throw new Error('boom'); },
  });
  const wiring = createSurfaceActivityWiring({ manager, resolvePhase: () => 'idle', getStreamIdForSession: () => '' });

  wiring.onChatLifecycleSurfaceSync({ sessionId: 's1' });
  wiring.onChatLifecycleSurfaceSync({ sessionId: 's1' });

  assert.equal(wiring._diagnostics.failures, 2);
  assert.equal(manager.calls.publishActivityPhase.length, 0);
});

test('a throwing publishStreamImpulse is swallowed and counted independently from sync failures', () => {
  const manager = createFakeManager({
    publishStreamImpulse() { throw new Error('nope'); },
  });
  const wiring = createSurfaceActivityWiring({ manager });

  wiring.publishCancelImpulse({ sessionId: 's1', streamId: 'st1' });

  assert.equal(wiring._diagnostics.failures, 1);
});

// ---------------------------------------------------------------------------
// Seam 1: renderer-render-pipeline-surface-state.js -- syncStableChatSurfaceState
// ---------------------------------------------------------------------------

test('seam: syncStableChatSurfaceState fires onSurfaceLifecycleSync with the current session on every call', () => {
  const chatView = { dataset: {} };
  const composerWrap = { dataset: {} };
  const composer = { dataset: {} };
  const state = { currentSessionId: 'session-a', ui: { chatMode: 'thread' } };
  const syncCalls = [];
  const pipeline = createSurfaceStatePipeline({
    state,
    dom: { chatView, composerWrap, composer },
    callbacks: {
      getChatSendLifecycle: () => 'streaming',
      onSurfaceLifecycleSync: (payload) => syncCalls.push(payload),
    },
  });

  pipeline.syncStableChatSurfaceState();
  pipeline.syncStableChatSurfaceState();

  assert.deepEqual(syncCalls, [{ sessionId: 'session-a' }, { sessionId: 'session-a' }]);
});

test('seam: syncStableChatSurfaceState behaves unchanged when onSurfaceLifecycleSync is absent', () => {
  const chatView = { dataset: {} };
  const composerWrap = { dataset: {} };
  const composer = { dataset: {} };
  const state = { currentSessionId: 'session-b', ui: { chatMode: 'thread' } };
  const pipeline = createSurfaceStatePipeline({
    state,
    dom: { chatView, composerWrap, composer },
    callbacks: { getChatSendLifecycle: () => 'idle' },
  });

  const changed = pipeline.syncStableChatSurfaceState();

  assert.equal(changed, true);
  assert.equal(chatView.dataset.sendLifecycle, 'idle');
});

// ---------------------------------------------------------------------------
// Seam 2: renderer-stream-handler-live-events.js -- handleDelta first token
// ---------------------------------------------------------------------------

function createLiveEventsHarness(overrides = {}) {
  const streamSegmentState = new Map();
  const handlers = createStreamLiveEventHandlers({
    state: { currentSessionId: 'session-1' },
    normalizeId: (value) => String(value || '').trim(),
    normalizeString: (value) => String(value || '').trim(),
    streamSegmentState,
    streamPhaseState: new Map(),
    reasoningStreamMerger: { drop() {}, merge: () => ({ source: 'none', entries: [] }) },
    pendingStreamCommitQueue: {
      peek: () => null,
      stage: () => {},
      flush: () => {},
      commitNow: () => {},
    },
    ...overrides,
  });
  return { handlers, streamSegmentState };
}

test('seam: handleDelta fires publishFirstTokenImpulse exactly once per stream across repeated deltas', async () => {
  const impulseCalls = [];
  const { handlers } = createLiveEventsHarness({
    publishFirstTokenImpulse: (payload) => impulseCalls.push(payload),
  });

  await handlers.handleStarted({ streamId: 'stream-1', sessionId: 'session-1' });
  await handlers.handleDelta({ streamId: 'stream-1', sessionId: 'session-1', content: 'Hel', timeStamp: 111 });
  await handlers.handleDelta({ streamId: 'stream-1', sessionId: 'session-1', content: 'lo', timeStamp: 222 });
  await handlers.handleDelta({ streamId: 'stream-1', sessionId: 'session-1', content: '!', timeStamp: 333 });

  assert.equal(impulseCalls.length, 1);
  assert.deepEqual(impulseCalls[0], { sessionId: 'session-1', streamId: 'stream-1', timeStamp: 111 });
});

test('seam: handleDelta tracks first-token separately per stream', async () => {
  const impulseCalls = [];
  const { handlers } = createLiveEventsHarness({
    publishFirstTokenImpulse: (payload) => impulseCalls.push(payload),
  });

  await handlers.handleStarted({ streamId: 'stream-a', sessionId: 'session-1' });
  await handlers.handleStarted({ streamId: 'stream-b', sessionId: 'session-1' });
  await handlers.handleDelta({ streamId: 'stream-a', sessionId: 'session-1', content: 'a', timeStamp: 1 });
  await handlers.handleDelta({ streamId: 'stream-b', sessionId: 'session-1', content: 'b', timeStamp: 2 });

  assert.deepEqual(impulseCalls.map((call) => call.streamId), ['stream-a', 'stream-b']);
});

test('seam: handleDelta does not throw when publishFirstTokenImpulse is absent, and still marks the segment seen', async () => {
  const { handlers, streamSegmentState } = createLiveEventsHarness();

  await handlers.handleStarted({ streamId: 'stream-1', sessionId: 'session-1' });
  await handlers.handleDelta({ streamId: 'stream-1', sessionId: 'session-1', content: 'hi', timeStamp: 1 });

  assert.equal(streamSegmentState.get('stream-1').firstDeltaSeen, true);
});

test('seam: handleContextCompacted retains the latest event and caps ordered history at 20', async () => {
  let messages = [{ id: 'assistant-1', role: 'assistant' }];
  const state = {
    currentSessionId: 'session-1',
    pendingStreams: new Map([['stream-1', 'assistant-1']]),
  };
  const { handlers } = createLiveEventsHarness({
    state,
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    getSessionMessages: () => messages,
    updatePendingMessage(_payload, patch) {
      messages = [{ ...messages[0], ...patch }];
      return { activeMessages: messages, index: 0 };
    },
  });
  const event = (index) => ({
    type: 'context_compacted',
    sessionId: 'session-1',
    streamId: 'stream-1',
    tokensBefore: 5000 - index,
    tokensAfter: 4000 - index,
  });

  await handlers.handleContextCompacted(event(1));
  await handlers.handleContextCompacted(event(2));

  assert.equal(messages[0].context_compactions.length, 2);
  assert.deepEqual(messages[0].context_compacted, messages[0].context_compactions[1]);
  assert.match(messages[0].context_compacted.occurredAt, /^\d{4}-\d{2}-\d{2}T/);

  for (let index = 3; index <= 21; index += 1) {
    await handlers.handleContextCompacted(event(index));
  }

  assert.equal(messages[0].context_compactions.length, 20);
  assert.equal(messages[0].context_compactions[0].tokensBefore, event(2).tokensBefore);
  assert.deepEqual(messages[0].context_compacted, messages[0].context_compactions[19]);
});

// A tool call deletes the stream's pendingStreams entry, so the next compaction
// has no current message to read history from: it must start a fresh
// single-entry history on the new segment (per-segment accumulation), not
// throw and not inherit the previous segment's list.
test('seam: handleContextCompacted after a tool boundary starts a fresh per-segment history', async () => {
  let messages = [{ id: 'assistant-1', role: 'assistant', context_compactions: [{ tokensBefore: 9, tokensAfter: 8 }] }];
  const state = {
    currentSessionId: 'session-1',
    pendingStreams: new Map(),
  };
  const patches = [];
  const { handlers } = createLiveEventsHarness({
    state,
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    getSessionMessages: () => messages,
    updatePendingMessage(_payload, patch) {
      patches.push(patch);
      messages = [...messages, { id: 'assistant-2', role: 'assistant', ...patch }];
      return { activeMessages: messages, index: 1 };
    },
  });

  await handlers.handleContextCompacted({
    type: 'context_compacted', sessionId: 'session-1', streamId: 'stream-1', tokensBefore: 5000, tokensAfter: 4000, phase: 'tool_loop',
  });

  assert.equal(patches.length, 1);
  assert.equal(patches[0].context_compactions.length, 1);
  assert.equal(patches[0].context_compactions[0].phase, 'tool_loop');
  assert.equal(messages[0].context_compactions.length, 1, 'the earlier segment keeps its own history');
});

// ---------------------------------------------------------------------------
// Seam 3: renderer-stream-handler-tools.js -- handleToolUse tool-start
// ---------------------------------------------------------------------------

function createToolHandlersHarness(overrides = {}) {
  const state = {
    pendingStreams: new Map(),
    toolCallsByStream: new Map(),
    pendingToolApprovals: new Map(),
  };
  const messagesBySession = new Map();
  const handlers = createStreamToolHandlers({
    state,
    streamSegmentState: new Map(),
    getSessionMessages: (sessionId) => messagesBySession.get(sessionId) || [],
    setSessionMessages: (sessionId, messages) => messagesBySession.set(sessionId, messages),
    createNormalizedMessage: (role, content, extra = {}) => ({ id: extra.id || `${role}_msg`, role, content, ...extra }),
    releaseApprovalToastSessions: () => {},
    clearSessionComposerNotice: () => {},
    setSessionTurnStatusPill: () => {},
    clearSessionTurnStatusPill: () => {},
    queueSessionRender: () => {},
    scheduleLiveToolPatch: () => false,
    showApprovalToast: () => {},
    isCurrentSession: () => true,
    isRowModelEnabled: () => false,
    applyLiveTurnPayload: () => null,
    noteTimelineMessageCreated: () => {},
    MESSAGE_STATUS: { COMPLETE: 'complete' },
    ...overrides,
  });
  return { handlers, state, messagesBySession };
}

test('seam: handleToolUse fires publishToolStartImpulse when the live event status is running', async () => {
  const impulseCalls = [];
  const { handlers } = createToolHandlersHarness({
    publishToolStartImpulse: (payload) => impulseCalls.push(payload),
  });

  await handlers.handleToolUse({
    sessionId: 'session-1', streamId: 'stream-1', toolName: 'Bash', status: 'running',
    summary: 'Running command', input: {}, timeStamp: 42,
  });

  assert.deepEqual(impulseCalls, [{ sessionId: 'session-1', streamId: 'stream-1', timeStamp: 42 }]);
});

test('seam: handleToolUse does not fire publishToolStartImpulse for a non-running status', async () => {
  const impulseCalls = [];
  const { handlers } = createToolHandlersHarness({
    publishToolStartImpulse: (payload) => impulseCalls.push(payload),
  });

  await handlers.handleToolUse({
    sessionId: 'session-1', streamId: 'stream-1', toolName: 'Bash', status: 'pending_approval',
    summary: 'Needs approval', input: {},
  });

  assert.equal(impulseCalls.length, 0);
});

test('seam: handleToolUse does not throw when publishToolStartImpulse is absent', async () => {
  const { handlers } = createToolHandlersHarness();

  const result = await handlers.handleToolUse({
    sessionId: 'session-1', streamId: 'stream-1', toolName: 'Bash', status: 'running',
    summary: 'Running command', input: {},
  });

  assert.deepEqual(result, { buffered: false, terminal: false });
});

// ---------------------------------------------------------------------------
// Seam 4: renderer-stream-handler-runtime.js -- finalizeTerminalStream complete
// ---------------------------------------------------------------------------

function createRuntimeHarness(overrides = {}) {
  const events = [];
  const runtime = createStreamHandlerRuntime({
    state: { pendingToolApprovals: new Map(), streamThinkingStatusByStream: new Map(), pendingStreams: new Map(), toolCallsByStream: new Map() },
    multiStreamController: null,
    appendClientLog: () => {},
    setChatSendLifecycle: (sessionId, lifecycle) => events.push({ type: 'lifecycle', sessionId, lifecycle }),
    clearSessionComposerNotice: () => {},
    clearSessionTurnStatusPill: () => {},
    getQueuedSend: () => null,
    ...overrides,
  });
  return { runtime, events };
}

test('seam: finalizeTerminalStream fires publishCompleteImpulse right after setChatSendLifecycle settles', () => {
  const events = [];
  const { runtime } = createRuntimeHarness({
    setChatSendLifecycle: (sessionId, lifecycle) => events.push({ type: 'lifecycle', sessionId, lifecycle }),
    publishCompleteImpulse: (payload) => events.push({ type: 'impulse', ...payload }),
  });

  runtime.finalizeTerminalStream(new Set(), new Map(), new Map(), {
    sessionId: 'session-1', streamId: 'stream-1', timeStamp: 999,
  });

  assert.deepEqual(events, [
    { type: 'lifecycle', sessionId: 'session-1', lifecycle: 'settling' },
    { type: 'impulse', sessionId: 'session-1', streamId: 'stream-1', timeStamp: 999 },
  ]);
});

test('seam: finalizeTerminalStream does not throw when publishCompleteImpulse is absent', () => {
  const { runtime, events } = createRuntimeHarness();

  runtime.finalizeTerminalStream(new Set(), new Map(), new Map(), {
    sessionId: 'session-1', streamId: 'stream-1',
  });

  assert.deepEqual(events, [{ type: 'lifecycle', sessionId: 'session-1', lifecycle: 'settling' }]);
});

// ---------------------------------------------------------------------------
// Seam 5: renderer-send-utils.js -- handleStopActiveStream cancel
// ---------------------------------------------------------------------------

function createSendControllerHarness({ cancelResult, cancelRefused } = {}, overrides = {}) {
  const previousWindow = global.window;
  const cancelCalls = [];
  global.window = {
    jennyShell: {
      chat: {
        cancelStream: async (streamId) => {
          cancelCalls.push(streamId);
          return cancelResult;
        },
      },
    },
  };
  const state = { currentSessionId: 'session-1', queuedSendBySession: new Map() };
  const controller = createSendController({
    state,
    dom: { chatInput: { value: '' } },
    multiStreamController: {
      getActiveStreamIdForCancel: (sessionId) => (sessionId === 'session-1' ? 'stream-1' : ''),
      isCancelStreamRefused: () => cancelRefused === true,
    },
    thinkingIndicator: null,
    constants: {},
    callbacks: {
      appendClientLog: () => {},
      getQueuedSend: () => null,
      restoreQueuedSendDraft: () => {},
      ...overrides,
    },
  });
  return {
    controller,
    cancelCalls,
    restore() { global.window = previousWindow; },
  };
}

test('seam: handleStopActiveStream fires publishCancelImpulse once the cancel proceeds past the refusal gate', async (t) => {
  const impulseCalls = [];
  const harness = createSendControllerHarness(
    { cancelResult: { ok: true }, cancelRefused: false },
    { publishCancelImpulse: (payload) => impulseCalls.push(payload) }
  );
  t.after(() => harness.restore());

  const result = await harness.controller.handleStopActiveStream();

  assert.deepEqual(result, { streamId: 'stream-1', sessionId: 'session-1' });
  assert.equal(impulseCalls.length, 1);
  assert.equal(impulseCalls[0].sessionId, 'session-1');
  assert.equal(impulseCalls[0].streamId, 'stream-1');
});

test('seam: handleStopActiveStream does not fire publishCancelImpulse when the cancel is refused', async (t) => {
  const impulseCalls = [];
  const harness = createSendControllerHarness(
    { cancelResult: false, cancelRefused: true },
    { publishCancelImpulse: (payload) => impulseCalls.push(payload) }
  );
  t.after(() => harness.restore());

  const result = await harness.controller.handleStopActiveStream();

  assert.equal(result, null);
  assert.equal(impulseCalls.length, 0);
});

test('seam: handleStopActiveStream does not throw when publishCancelImpulse is absent', async (t) => {
  const harness = createSendControllerHarness({ cancelResult: { ok: true }, cancelRefused: false });
  t.after(() => harness.restore());

  const result = await harness.controller.handleStopActiveStream();

  assert.deepEqual(result, { streamId: 'stream-1', sessionId: 'session-1' });
});
