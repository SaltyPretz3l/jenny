const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assertVisibleStreamAffordancesCleared,
  createHarness,
  createQueuedFrameController,
  createStreamingAffordanceDom,
} = require('./helpers/renderer-stream-handler-harness');

test('stream handler keeps beforeunload listener cleanup symmetric across re-register and dispose', (t) => {
  const fakeWindow = {
    added: [],
    removed: [],
    jennyShell: {
      sessions: {
        async getMessages() {
          return { data: [] };
        },
      },
    },
    addEventListener(eventName, handler) {
      this.added.push({ eventName, handler });
    },
    removeEventListener(eventName, handler) {
      this.removed.push({ eventName, handler });
    },
  };
  const harness = createHarness({
    stateOverrides: {
      window: fakeWindow,
    },
  });
  t.after(() => harness.restore());

  assert.equal(fakeWindow.added.length, 1);
  assert.equal(fakeWindow.added[0].eventName, 'beforeunload');
  assert.equal(fakeWindow.removed.length, 0);

  harness.handler.registerStreamHandler({
    chat: {
      onStream() {
        return () => {};
      },
    },
  });

  assert.equal(fakeWindow.added.length, 2);
  assert.equal(fakeWindow.removed.length, 1);
  assert.equal(fakeWindow.removed[0].eventName, 'beforeunload');
  assert.equal(fakeWindow.removed[0].handler, fakeWindow.added[0].handler);

  harness.handler.dispose();
  assert.equal(fakeWindow.removed.length, 2);
  assert.equal(fakeWindow.removed[1].handler, fakeWindow.added[1].handler);

  harness.handler.dispose();
  assert.equal(fakeWindow.removed.length, 2);
});

test('terminal events clear retained stream maps even when no pending message remains', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  harness.state.toolCallsByStream.set('stream-orphan-terminal', [{ callId: 'call-1' }]);
  harness.state.streamThinkingStatusByStream.set('stream-orphan-terminal', { text: 'Working' });
  harness.state.pendingToolApprovals.set('approval-1', {
    streamId: 'stream-orphan-terminal',
    sessionId: 'session-1',
  });

  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-orphan-terminal',
    content: '',
  });

  assert.equal(harness.state.toolCallsByStream.has('stream-orphan-terminal'), false);
  assert.equal(harness.state.streamThinkingStatusByStream.has('stream-orphan-terminal'), false);
  assert.equal(harness.state.pendingToolApprovals.has('approval-1'), false);
});

// A trailing event must not resurrect a finalized stream's in-flight state.
test('a late delta after complete does not re-add the finalized stream to pendingStreams', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-late' });
  await harness.emit({
    type: 'delta', sessionId: 'session-1', streamId: 'stream-late', content: 'hi', aggregate: 'hi',
  });
  await harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-late', content: 'hi' });

  assert.deepEqual([...harness.state.pendingStreams.keys()], [], 'complete clears pendingStreams');

  // Trailing delta for the already-finalized stream.
  await harness.emit({
    type: 'delta', sessionId: 'session-1', streamId: 'stream-late', content: '!', aggregate: 'hi!',
  });

  assert.deepEqual(
    [...harness.state.pendingStreams.keys()],
    [],
    'a late delta must not resurrect the finalized stream in pendingStreams',
  );
  const message = harness.state.messagesBySession.get('session-1')
    .find((entry) => entry.id === 'assistant_stream-late');
  assert.equal(message.status, 'complete', 'the finalized bubble is not flipped back to streaming');
});

test('a late agent_status after complete does not re-add the finalized stream to pendingStreams', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-late-status' });
  await harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-late-status', content: 'done' });
  await harness.emit({
    type: 'agent_status', sessionId: 'session-1', streamId: 'stream-late-status', status: 'running', summary: 'late',
  });

  assert.deepEqual([...harness.state.pendingStreams.keys()], []);
  assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), false);
});

test('a late/duplicate started after complete does not strand the session as send-busy', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-dup' });
  await harness.emit({ type: 'complete', sessionId: 'session-1', streamId: 'stream-dup', content: 'done' });

  assert.equal(harness.multiStreamController.isSessionSendBusy('session-1'), false);

  // A duplicate `started` for the finalized stream must not re-register it.
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-dup' });

  assert.equal(
    harness.multiStreamController.isSessionSendBusy('session-1'),
    false,
    'a late started must not re-register the finalized stream and disable follow-up actions',
  );
  assert.deepEqual(harness.multiStreamController.getStreamingSessionIds(), []);
});

test('complete terminal event clears visible stream affordances before queued render frames run', async (t) => {
  const frames = createQueuedFrameController();
  const { dom, timeline } = createStreamingAffordanceDom();
  const harness = createHarness({
    requestAnimationFrameImpl: frames.requestAnimationFrame,
    cancelAnimationFrameImpl: frames.cancelAnimationFrame,
    domOverrides: { chatTimeline: timeline },
    stateOverrides: {
      window: dom.window,
      messagesBySession: new Map([[
        'session-1',
        [{
          id: 'assistant_stream-visible',
          role: 'assistant',
          content: 'Already done.',
          status: 'streaming',
          streamId: 'stream-visible',
        }],
      ]]),
    },
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-visible',
    content: 'Already done.',
  });

  assert.equal(harness.calls.renderMessages, 1, 'terminal message render should run synchronously');
  assert.equal(frames.pendingCount() > 0, true, 'post-terminal work may still queue follow-up frames');
  assertVisibleStreamAffordancesCleared(dom.window.document);
  assert.equal(timeline.getAttribute('aria-busy'), 'false');
});

test('complete terminal event is not reverted by a staged delta render frame', async (t) => {
  const frames = createQueuedFrameController();
  const { dom, timeline } = createStreamingAffordanceDom();
  const harness = createHarness({
    requestAnimationFrameImpl: frames.requestAnimationFrame,
    cancelAnimationFrameImpl: frames.cancelAnimationFrame,
    domOverrides: { chatTimeline: timeline },
    stateOverrides: {
      window: dom.window,
      messagesBySession: new Map([[
        'session-1',
        [{
          id: 'assistant_stream-visible',
          role: 'assistant',
          content: 'Almost done.',
          status: 'streaming',
          streamId: 'stream-visible',
        }],
      ]]),
    },
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-visible',
    content: 'Already done.',
    aggregate: 'Already done.',
  });
  assert.equal(frames.pendingCount() > 0, true, 'delta should stage a render frame');

  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-visible',
    content: 'Already done.',
  });

  assert.equal(harness.calls.renderMessages, 1, 'complete should synchronously drain staged message render');
  assertVisibleStreamAffordancesCleared(dom.window.document);
  await frames.drainNextFrame();
  assertVisibleStreamAffordancesCleared(dom.window.document);
  assert.equal(timeline.getAttribute('aria-busy'), 'false');
});

test('error terminal event clears visible stream affordances before queued render frames run', async (t) => {
  const frames = createQueuedFrameController();
  const { dom, timeline } = createStreamingAffordanceDom();
  const harness = createHarness({
    requestAnimationFrameImpl: frames.requestAnimationFrame,
    cancelAnimationFrameImpl: frames.cancelAnimationFrame,
    domOverrides: { chatTimeline: timeline },
    stateOverrides: {
      window: dom.window,
      messagesBySession: new Map([[
        'session-1',
        [{
          id: 'assistant_stream-visible',
          role: 'assistant',
          content: 'Almost done.',
          status: 'streaming',
          streamId: 'stream-visible',
        }],
      ]]),
    },
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-visible',
    message: 'stream failed',
  });

  assert.equal(harness.calls.renderMessages, 1, 'terminal error render should run synchronously');
  assert.equal(frames.pendingCount() > 0, true, 'post-terminal work may still queue follow-up frames');
  assertVisibleStreamAffordancesCleared(dom.window.document);
  assert.equal(timeline.getAttribute('aria-busy'), 'false');
});

// ISSUE-001 (docs/operations/MAJOR_ISSUES.md): terminal completion for the
// current session must settle chat DOM affordances and rebuild message chrome
// even when the active view is not chat. The message model update is not gated
// by visibility; the terminal UI cleanup cannot be gated either, because the
// hidden chat timeline may still contain the active streaming bubble.
test('ISSUE-001: complete on a non-visible chat session clears stream affordances', async (t) => {
  const frames = createQueuedFrameController();
  const { dom, timeline } = createStreamingAffordanceDom();
  const harness = createHarness({
    requestAnimationFrameImpl: frames.requestAnimationFrame,
    cancelAnimationFrameImpl: frames.cancelAnimationFrame,
    domOverrides: { chatTimeline: timeline },
    stateOverrides: {
      window: dom.window,
      currentSessionId: 'session-1',
      // Current session, but the chat view is not on screen -> not "visible".
      ui: { activeView: 'settings' },
      messagesBySession: new Map([[
        'session-1',
        [{
          id: 'assistant_stream-visible',
          role: 'assistant',
          content: 'Already done.',
          status: 'streaming',
          streamId: 'stream-visible',
        }],
      ]]),
    },
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'complete',
    sessionId: 'session-1',
    streamId: 'stream-visible',
    content: 'Already done.',
  });

  assert.equal(
    harness.state.messagesBySession.get('session-1')[0].status,
    'complete',
    'message status flips to complete in state regardless of visibility',
  );
  assert.equal(
    harness.calls.renderMessages,
    1,
    'terminal message render should run for the hidden current chat session',
  );
  assertVisibleStreamAffordancesCleared(dom.window.document);
  assert.equal(timeline.getAttribute('aria-busy'), 'false');
});

test('terminal affordance settle ignores malformed non-current terminal payloads', async (t) => {
  const { dom, timeline } = createStreamingAffordanceDom();
  const harness = createHarness({
    domOverrides: { chatTimeline: timeline },
    stateOverrides: {
      window: dom.window,
      currentSessionId: 'session-1',
      messagesBySession: new Map([
        ['session-1', []],
        ['session-2', []],
      ]),
    },
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'error',
    sessionId: 'session-2',
    message: 'background stream failed',
  });

  assert.equal(
    dom.window.document.querySelectorAll('.chat-bubble-streaming[data-streaming-bubble="true"]').length,
    1,
    'malformed background terminal event must not clear current-session streaming DOM',
  );
  assert.equal(
    dom.window.document.querySelectorAll('.chat-stream-unit.is-streaming-tail').length,
    1,
    'current-session caret target remains owned by the current stream',
  );
  assert.equal(timeline.getAttribute('aria-busy'), 'true');
});

test('finish terminal alias routes through complete handling', async (t) => {
  const harness = createHarness({
    stateOverrides: {
      messagesBySession: new Map([[
        'session-1',
        [{
          id: 'assistant_stream-finish',
          role: 'assistant',
          content: 'Done',
          status: 'streaming',
          streamId: 'stream-finish',
        }],
      ]]),
    },
  });
  t.after(() => harness.restore());

  await harness.emit({
    type: 'finish',
    sessionId: 'session-1',
    streamId: 'stream-finish',
    content: 'Done',
  });

  const message = harness.state.messagesBySession
    .get('session-1')
    .find((entry) => entry.streamId === 'stream-finish');
  assert.equal(message?.status, 'complete');
  assert.equal(
    harness.calls.presence.some((payload) =>
      payload.type === 'complete' && payload.terminalStatus === 'completed'
    ),
    true
  );
});

test('stream handler only queues chrome renders for background session deltas', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-2', streamId: 'stream-2' });
  await harness.emit({ type: 'delta', sessionId: 'session-2', streamId: 'stream-2', aggregate: 'background' });

  assert.equal(harness.calls.renderMessages, 0);
  assert.equal(harness.calls.renderWorkspaceChrome > 0 || harness.calls.renderSessions > 0, true);
  assert.deepEqual(harness.calls.indicator, []);
  assert.equal(harness.state.ui.chatSendLifecycleBySession.get('session-2'), 'streaming');
});

test('stream handler coalesces same-frame pending message writes for visible deltas', async (t) => {
  const frameController = createQueuedFrameController();
  const harness = createHarness({
    requestAnimationFrameImpl: frameController.requestAnimationFrame.bind(frameController),
    cancelAnimationFrameImpl: frameController.cancelAnimationFrame.bind(frameController),
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-coalesce-1' });
  const writesAfterStarted = harness.calls.setSessionMessages.length;

  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-coalesce-1', aggregate: 'h' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-coalesce-1', aggregate: 'he' });
  await harness.emit({ type: 'delta', sessionId: 'session-1', streamId: 'stream-coalesce-1', aggregate: 'hey' });

  assert.equal(harness.calls.setSessionMessages.length, writesAfterStarted + 1);

  await frameController.drainNextFrame();

  assert.equal(harness.calls.setSessionMessages.length, writesAfterStarted + 2);
  const assistantMessage = harness.state.messagesBySession.get('session-1')
    .find((message) => message.streamId === 'stream-coalesce-1');
  assert.equal(assistantMessage.content, 'hey');
});

test('F10: stream handler notifies unread hook when a visible assistant stream row is created', async (t) => {
  const unreadEvents = [];
  const harness = createHarness({
    callbackOverrides: {
      noteTimelineMessageCreated(event) {
        unreadEvents.push(event);
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-unread-1' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-unread-1',
    content: 'Hello',
    aggregate: 'Hello',
  });

  assert.deepEqual(unreadEvents, [{
    sessionId: 'session-1',
    messageId: 'assistant_stream-unread-1',
    role: 'assistant',
    kind: '',
    visible: true,
  }]);
});

test('F10: stream handler notifies unread hook when a visible tool-use row is created', async (t) => {
  const unreadEvents = [];
  const harness = createHarness({
    callbackOverrides: {
      noteTimelineMessageCreated(event) {
        unreadEvents.push(event);
      },
    },
  });
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-unread-tool' });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-unread-tool',
    callId: 'call-unread',
    toolName: 'Read',
    status: 'running',
    summary: 'Reading file',
  });

  assert.deepEqual(unreadEvents, [{
    sessionId: 'session-1',
    messageId: 'tool_use_stream-unread-tool_call-unread',
    role: 'assistant',
    kind: 'tool_use',
    visible: true,
  }]);
});

test('stream handler forwards phase and terminal presence events for comet/overlay consumers', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({
    type: 'started',
    sessionId: 'session-1',
    streamId: 'stream-presence-1',
  });
  await harness.emit({
    type: 'phase_started',
    sessionId: 'session-1',
    streamId: 'stream-presence-1',
    phaseId: 'phase-1',
    phaseKind: 'approval_wait',
  });
  await harness.emit({
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-presence-1',
    message: 'cancelled',
    status: 'cancelled',
    terminal_subcode: 'approval',
  });

  assert.deepEqual(harness.calls.presence, [{
    type: 'phase_started',
    sessionId: 'session-1',
    streamId: 'stream-presence-1',
    phaseId: 'phase-1',
    phaseKind: 'approval_wait',
  }, {
    type: 'error',
    sessionId: 'session-1',
    streamId: 'stream-presence-1',
    message: 'cancelled',
    status: 'cancelled',
    terminal_subcode: 'approval',
    terminalStatus: 'cancelled',
    terminalSubcode: 'approval',
  }]);
});

test('mixed text+tool turns keep the preamble bubble and slice post-tool segments from the aggregate (W3.6)', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());

  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-mixed' });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-mixed',
    content: 'Let me check that. ',
    aggregate: 'Let me check that. ',
  });
  await harness.emit({
    type: 'tool_use',
    sessionId: 'session-1',
    streamId: 'stream-mixed',
    callId: 'call-1',
    toolName: 'Read',
    summary: 'Reading a.txt',
    status: 'running',
    input: { path: 'a.txt' },
  });
  await harness.emit({
    type: 'delta',
    sessionId: 'session-1',
    streamId: 'stream-mixed',
    content: 'It says hi.',
    aggregate: 'Let me check that. It says hi.',
  });

  const messages = harness.state.messagesBySession.get('session-1');
  const preamble = messages.find((message) => message.id === 'assistant_stream-mixed');
  assert.ok(preamble, 'preamble bubble retained');
  assert.equal(preamble.content, 'Let me check that. ');
  assert.equal(preamble.status, 'complete');
  const answer = messages.find((message) => message.id === 'assistant_stream-mixed_seg1');
  assert.ok(answer, 'post-tool segment got its own bubble');
  assert.equal(answer.content, 'It says hi.');
  assert.equal(answer.status, 'streaming');
});

test('expired buffered head with a fresh sparse tail replays unchanged', async (t) => {
  const canonical = 'complete head tail';
  const canonicalRow = { id: 'assistant_sparse', role: 'assistant', content: canonical, status: 'streaming' };
  const harness = createHarness({ stateOverrides: {
    sessions: [{ id: 'session-1' }], messagesBySession: new Map([['session-1', []]]),
    window: { jennyShell: { sessions: { getMessages: async () => ({ data: [canonicalRow] }) } } }, } });
  t.after(() => harness.restore());
  harness.multiStreamController.registerPreflight('session-bg', { pending: true, sessionId: 'session-bg', streamId: 'stream-sparse' });
  await harness.emit({ type: 'started', sessionId: 'session-bg', streamId: 'stream-sparse' });
  await harness.emit({ type: 'delta', sessionId: 'session-bg', streamId: 'stream-sparse', content: 'complete head ', aggregate: 'complete head ' });
  await harness.emit({ type: 'thinking_status', sessionId: 'session-bg', streamId: 'stream-sparse', summary: 'working' });
  await harness.emit({ type: 'delta', sessionId: 'session-bg', streamId: 'stream-sparse', content: 'tail', aggregateLength: canonical.length });
  const buffered = harness.state.bufferedStreamEventsByStream.get('stream-sparse');
  buffered.slice(0, 2).forEach((event) => { event._bufferedAt = Date.now() - 61_000; });
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-foreground' });
  harness.state.messagesBySession.set('session-bg', []);
  const result = await harness.handler.flushBufferedStreamEvents('stream-sparse');
  const liveRow = harness.state.messagesBySession.get('session-bg').find((message) => message.role === 'assistant');
  assert.equal(liveRow?.content, canonical);
  assert.deepEqual(result, { flushedCount: 4, terminal: false, discardedCount: 0 });
});

test('fresh buffered stream replays unchanged', async (t) => {
  const harness = createHarness();
  t.after(() => harness.restore());
  const stream = { sessionId: 'session-2', streamId: 'stream-fresh', _bufferedAt: Date.now() };
  harness.state.bufferedStreamEventsByStream.set('stream-fresh', [{ ...stream, type: 'started' }, { ...stream, type: 'delta', content: 'fresh', aggregate: 'fresh' }]);
  await harness.emit({ type: 'started', sessionId: 'session-1', streamId: 'stream-trigger' });
  const result = await harness.handler.flushBufferedStreamEvents('stream-fresh');
  const liveRow = harness.state.messagesBySession.get('session-2').find((message) => message.streamId === 'stream-fresh');
  assert.equal(liveRow?.content, 'fresh');
  assert.deepEqual(result, { flushedCount: 2, terminal: false, discardedCount: 0 });
});
