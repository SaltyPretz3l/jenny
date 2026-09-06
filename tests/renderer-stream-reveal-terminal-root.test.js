const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JSDOM,
  buildRevealSession,
  createDeferred,
  createStreamRevealController,
  loadRendererTestApp,
  waitForUi,
} = require('./helpers/renderer-stream-reveal-harness');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

test('active turn root patch updates only the targeted thread root in place', () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u1"><article data-message-id="u1">u1</article></div>
          <div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u2"><article data-message-id="u2">u2-old</article></div>
        </div>
      </body>
    </html>
  `);
  const timeline = dom.window.document.getElementById('timeline');
  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: () => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 }),
    escapeSelectorValue: (value) => String(value || ''),
  });

  const firstRootBefore = timeline.children[0];
  const secondRootBefore = timeline.children[1];
  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    activeTurnRootMessageId: 'u2',
    activeTurnStructureHash: 100,
    activeTurnTailFingerprint: 'tail:old',
  });

  const patched = controller.patchActiveTurnRoot({
    currentSessionId: 'session-1',
    structureSignature: 11,
    activeTurnRootMessageId: 'u2',
    turnStructureHash: 101,
    turnTailFingerprint: 'tail:new',
    expectedRootOrder: ['u1', 'u2'],
    buildTurnRootMarkup: () => '<div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u2"><article data-message-id="u2">u2-new</article></div>',
  });

  assert.equal(patched, true);
  assert.equal(timeline.children[0], firstRootBefore, 'untouched sibling root should retain its DOM node');
  assert.equal(timeline.children[1], secondRootBefore, 'active turn root should retain its DOM node');
  assert.match(String(timeline.children[1].textContent || ''), /u2-new/);
});

test('active turn root patch falls back when root order drifts', () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u1"><article data-message-id="u1">u1</article></div>
          <div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u2"><article data-message-id="u2">u2-old</article></div>
        </div>
      </body>
    </html>
  `);
  const timeline = dom.window.document.getElementById('timeline');
  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: () => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 }),
    escapeSelectorValue: (value) => String(value || ''),
  });

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    activeTurnRootMessageId: 'u2',
    activeTurnStructureHash: 100,
    activeTurnTailFingerprint: 'tail:old',
  });

  const patched = controller.patchActiveTurnRoot({
    currentSessionId: 'session-1',
    structureSignature: 11,
    activeTurnRootMessageId: 'u2',
    turnStructureHash: 101,
    turnTailFingerprint: 'tail:new',
    expectedRootOrder: ['u2', 'u1'],
    buildTurnRootMarkup: () => '<div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u2"><article data-message-id="u2">u2-new</article></div>',
  });

  assert.equal(patched, false);
  assert.match(String(timeline.children[1].textContent || ''), /u2-old/);
});

test('active turn root patch supersedes the synchronous narrow patch without leaving a queued frame', () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u1">
            <article data-message-id="u1">u1</article>
            <article data-message-id="a1"><div class="chat-bubble" data-streaming-bubble="true">old</div></article>
          </div>
        </div>
      </body>
    </html>
  `);
  const timeline = dom.window.document.getElementById('timeline');
  let queuedFrame = null;
  let cancelledFrameId = 0;
  dom.window.requestAnimationFrame = (callback) => {
    queuedFrame = callback;
    return 91;
  };
  dom.window.cancelAnimationFrame = (frameId) => {
    cancelledFrameId = frameId;
    queuedFrame = null;
  };

  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: () => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 }),
    escapeSelectorValue: (value) => String(value || ''),
  });

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'a1', role: 'assistant', status: 'streaming', content: 'old' },
    activeTurnRootMessageId: 'u1',
    activeTurnStructureHash: 100,
    activeTurnTailFingerprint: 'tail:old',
  });

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'a1',
    streamingMessage: { id: 'a1', role: 'assistant', status: 'streaming', content: 'stale' },
    messages: [{ id: 'a1', role: 'assistant', status: 'streaming', content: 'stale' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: 'stale-narrow-patch',
      innerHtml: '<div class="chat-bubble" data-streaming-bubble="true">stale-narrow-patch</div>',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });

  const patched = controller.patchActiveTurnRoot({
    currentSessionId: 'session-1',
    structureSignature: 11,
    activeTurnRootMessageId: 'u1',
    turnStructureHash: 101,
    turnTailFingerprint: 'tail:new',
    expectedRootOrder: ['u1'],
    buildTurnRootMarkup: () => `
      <div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u1">
        <article data-message-id="u1">u1</article>
        <article data-message-id="a1"><div class="chat-bubble" data-streaming-bubble="true">fresh-root</div></article>
      </div>
    `,
  });

  assert.equal(patched, true);
  assert.equal(cancelledFrameId, 0, 'the synchronous narrow patch should not allocate a frame to cancel');
  assert.equal(queuedFrame, null, 'no stale frame callback should remain');
  assert.match(String(timeline.textContent || ''), /fresh-root/);
  assert.doesNotMatch(String(timeline.textContent || ''), /stale-narrow-patch/);
});

test('active turn root patch falls back safely when turn-root markup building throws', () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <div class="chat-thread-root chat-thread-root-user" data-thread-message-id="u1"><article data-message-id="u1">u1-old</article></div>
        </div>
      </body>
    </html>
  `);
  const timeline = dom.window.document.getElementById('timeline');
  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: () => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 }),
    escapeSelectorValue: (value) => String(value || ''),
  });

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    activeTurnRootMessageId: 'u1',
    activeTurnStructureHash: 100,
    activeTurnTailFingerprint: 'tail:old',
  });

  const patched = controller.patchActiveTurnRoot({
    currentSessionId: 'session-1',
    structureSignature: 11,
    activeTurnRootMessageId: 'u1',
    turnStructureHash: 101,
    turnTailFingerprint: 'tail:new',
    expectedRootOrder: ['u1'],
    buildTurnRootMarkup: () => {
      throw new Error('bad projected root');
    },
  });

  assert.equal(patched, false);
  assert.match(String(timeline.textContent || ''), /u1-old/);
});

// Regression test for the production scenario where the streaming bubble keeps
// `chat-bubble-streaming` after `complete`. Differs from the existing post-complete
// test in three ways that mirror real Ollama traffic:
//   1. The session has multiple prior turns (production was on round 12+).
//   2. `thinking_status` arrives between the last delta and `complete` — production
//      always emits this, the existing test does not.
//   3. We do NOT manually set messagesBySession[…].status = 'complete' before
//      emitting `complete`. handleComplete must perform the streaming → complete
//      flip itself, exactly as it does in production.
test('streaming markers clear after complete with prior turns + thinking_status (regression for stuck chat-bubble-streaming)', async (t) => {
  const sessionId = 'session-late-thinking';
  const streamId = 'stream-late-thinking';
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          state.sessions = [buildRevealSession(sessionId, payload)];
          const priorMessages = [];
          for (let i = 0; i < 12; i += 1) {
            priorMessages.push({
              id: `user_prior_${i}`,
              role: 'user',
              content: `Prior prompt ${i}`,
              timestamp: new Date().toISOString(),
            });
            priorMessages.push({
              id: `assistant_stream_prior_${i}`,
              role: 'assistant',
              content: `Prior reply ${i} with some content.`,
              status: 'complete',
              timestamp: new Date().toISOString(),
              finalizedAt: new Date().toISOString(),
            });
          }
          state.messagesBySession.set(sessionId, priorMessages);
          return { sessionId, streamId };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Round seven prompt';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'Round seven! ',
    aggregate: 'Round seven! ',
  });
  await waitForUi(window, 80);
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: "I'm starting to feel like a rhythmic gymnast.",
    aggregate: "Round seven! I'm starting to feel like a rhythmic gymnast.",
  });
  await waitForUi(window, 80);

  // Production divergence #1: thinking_status between last delta and complete.
  await shell.__emitChat({
    type: 'thinking_status',
    sessionId,
    streamId,
    text: 'Wrapping up',
    thinkingId: 'think-1',
  });

  // Production divergence #2: do NOT pre-stage messagesBySession with status:'complete'.
  // handleComplete is responsible for the streaming → complete flip.
  await shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: "Round seven! I'm starting to feel like a rhythmic gymnast.",
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  // Poll until handleComplete's await chain (fetchHydrated + settleRowModel +
  // refreshSnapshots + post-complete queueSessionRender rAFs) has drained the
  // streaming affordances, instead of sleeping a fixed 300ms.
  await waitForUiState(
    window,
    () => window.document.querySelectorAll('.chat-bubble-streaming').length === 0
      && window.document.querySelectorAll('.chat-stream-unit').length === 0
  );

  // Global assertions first — these don't depend on finding the assistant entry,
  // and they're the load-bearing claim of this test.
  const stuckBubbles = window.document.querySelectorAll('.chat-bubble-streaming');
  assert.equal(
    stuckBubbles.length,
    0,
    `after complete, no .chat-bubble-streaming should remain — found ${stuckBubbles.length}`
  );
  const stuckUnits = window.document.querySelectorAll('.chat-stream-unit');
  assert.equal(
    stuckUnits.length,
    0,
    `after complete, no .chat-stream-unit divs should remain — found ${stuckUnits.length}`
  );
  const stuckTails = window.document.querySelectorAll('.chat-stream-unit.is-streaming-tail');
  assert.equal(
    stuckTails.length,
    0,
    `after complete, no .is-streaming-tail unit should remain — found ${stuckTails.length}`
  );
});

test('terminal complete clears visible stream affordances before post-complete hydration settles', async (t) => {
  const sessionId = 'session-delayed-terminal';
  const streamId = 'stream-delayed-terminal';
  const terminalHydration = createDeferred();
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          state.sessions = [buildRevealSession(sessionId, payload)];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  const stopButton = window.document.getElementById('stopStreamButton');
  const chatView = window.document.getElementById('chatView');
  shell.sessions.getMessages = async () => terminalHydration.promise;

  input.value = 'Finish visibly before terminal hydration';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);
  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'Already done.',
    aggregate: 'Already done.',
  });
  await waitForUi(window, 80);

  const completePromise = shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: 'Already done.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 100);

  try {
    assert.equal(chatView.dataset.sendLifecycle, 'idle');
    assert.equal(stopButton.classList.contains('hidden'), true);
    assert.equal(window.document.querySelectorAll('.chat-bubble-streaming').length, 0);
    assert.equal(window.document.querySelectorAll('[data-streaming-bubble="true"]').length, 0);
    assert.equal(window.document.querySelectorAll('.chat-stream-unit').length, 0);
    assert.equal(window.document.querySelectorAll('.chat-stream-unit.is-streaming-tail').length, 0);
    assert.equal(window.document.querySelectorAll('[data-streaming-row="true"]').length, 0);
    assert.equal(window.document.querySelectorAll('[data-streaming-message-id]').length, 0);
    assert.equal(window.document.querySelectorAll('article.chat-entry.pending').length, 0);
    assert.equal(window.document.getElementById('chatTimeline')?.getAttribute('aria-busy'), 'false');
  } finally {
    terminalHydration.resolve({ data: shell.__state.messagesBySession.get(sessionId) || [] });
    await completePromise;
  }
});

test('terminal complete settles final markdown without waiting for requestAnimationFrame', async (t) => {
  const sessionId = 'session-held-terminal-raf';
  const streamId = 'stream-held-terminal-raf';
  const terminalHydration = createDeferred();
  const heldFrames = [];
  const scheduledFrames = new Map();
  let heldFrameRequestCount = 0;
  let holdFrames = false;
  let nextFrameId = 1;
  t.after(() => {
    holdFrames = false;
    heldFrames.length = 0;
    for (const timer of scheduledFrames.values()) {
      clearTimeout(timer);
    }
    scheduledFrames.clear();
  });
  const { window, shell } = await loadRendererTestApp(t, {
    requestAnimationFrame(callback) {
      const frameId = nextFrameId;
      nextFrameId += 1;
      if (holdFrames) {
        heldFrameRequestCount += 1;
        heldFrames.push({ frameId, callback });
        return frameId;
      }
      const timer = setTimeout(() => {
        scheduledFrames.delete(frameId);
        callback(Date.now());
      }, 0);
      scheduledFrames.set(frameId, timer);
      return frameId;
    },
    cancelAnimationFrame(frameId) {
      const timer = scheduledFrames.get(frameId);
      if (timer) {
        clearTimeout(timer);
        scheduledFrames.delete(frameId);
      }
      const heldIndex = heldFrames.findIndex((entry) => entry.frameId === frameId);
      if (heldIndex !== -1) {
        heldFrames.splice(heldIndex, 1);
      }
    },
    shell: {
      chat: {
        async startStream(payload, { state }) {
          state.sessions = [buildRevealSession(sessionId, payload)];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');
  shell.sessions.getMessages = async () => terminalHydration.promise;

  input.value = 'Settle without a frame';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);
  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'Final text.',
    aggregate: 'Final text.',
  });
  await waitForUi(window, 80);

  holdFrames = true;
  const completePromise = shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: 'Final text.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUi(window, 25);

  try {
    const rendererMessages = window.__rendererState?.messagesBySession?.get(sessionId) || [];
    const assistantMessage = rendererMessages.find((message) => message.id === `assistant_${streamId}`);
    const assistantEntry = window.document.querySelector(`[data-message-id="assistant_${streamId}"]`);
    const bubble = assistantEntry?.querySelector('.chat-bubble');

    assert.equal(assistantMessage?.status, 'complete');
    assert.equal(window.document.querySelectorAll('.chat-bubble-streaming').length, 0);
    assert.equal(window.document.querySelectorAll('[data-streaming-bubble="true"]').length, 0);
    assert.equal(window.document.querySelectorAll('.chat-stream-unit').length, 0);
    assert.equal(window.document.querySelectorAll('.chat-stream-unit.is-streaming-tail').length, 0);
    assert.equal(window.document.querySelectorAll('[data-streaming-row="true"]').length, 0);
    assert.equal(window.document.querySelectorAll('article.chat-entry.pending').length, 0);
    assert.equal(bubble?.className, 'chat-bubble chat-bubble-markdown');
    assert.equal(bubble?.innerHTML, '<p>Final text.</p>\n');
    assert.ok(heldFrameRequestCount > 0, 'test must hold at least one deferred frame');
  } finally {
    holdFrames = false;
    terminalHydration.resolve({
      data: window.__rendererState?.messagesBySession?.get(sessionId) || [],
    });
    await completePromise;
  }
});

// Regression test for canonical-preferred dedup at the projection index layer
// (renderer-render-message-index-utils.js). After complete, no two chat-rows
// share (data-row-kind, data-source-message-id) and no two reasoning rows
// share (data-source-message-id, data-row-id-phase). Rank: canonical > reconciled
// > live; overlay rows tagged by overlayProjectedRows lose the collision.
test('streaming bubble dedup keeps a single chat-row per primary_message_id after complete', async (t) => {
  const sessionId = 'session-dedup-canonical';
  const streamId = 'stream-dedup-canonical';
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          state.sessions = [buildRevealSession(sessionId, payload)];
          const priorMessages = [];
          for (let i = 0; i < 12; i += 1) {
            priorMessages.push({
              id: `user_prior_${i}`,
              role: 'user',
              content: `Prior prompt ${i}`,
              timestamp: new Date().toISOString(),
            });
            priorMessages.push({
              id: `assistant_stream_prior_${i}`,
              role: 'assistant',
              content: `Prior reply ${i} with some content.`,
              status: 'complete',
              timestamp: new Date().toISOString(),
              finalizedAt: new Date().toISOString(),
            });
          }
          state.messagesBySession.set(sessionId, priorMessages);
          return { sessionId, streamId };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Round eight prompt';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'Round eight! ',
    aggregate: 'Round eight! ',
  });
  await waitForUi(window, 80);
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'Confirming dedup at the row level.',
    aggregate: 'Round eight! Confirming dedup at the row level.',
  });
  await waitForUi(window, 80);
  await shell.__emitChat({
    type: 'thinking_status',
    sessionId,
    streamId,
    text: 'Wrapping up',
    thinkingId: 'think-dedup',
  });
  await shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: 'Round eight! Confirming dedup at the row level.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUiState(window, () => window.document.querySelectorAll('.chat-stream-unit').length === 0);

  const rowKindCounts = new Map();
  const rows = window.document.querySelectorAll('.chat-row[data-row-kind][data-source-message-id]');
  rows.forEach((row) => {
    const rowKind = row.getAttribute('data-row-kind') || '';
    const sourceMessageId = row.getAttribute('data-source-message-id') || '';
    if (!rowKind || !sourceMessageId) {
      return;
    }
    const key = `${rowKind}|${sourceMessageId}`;
    rowKindCounts.set(key, (rowKindCounts.get(key) || 0) + 1);
  });
  for (const [key, count] of rowKindCounts.entries()) {
    if (key.startsWith('reasoning|')) {
      // Reasoning rows can legitimately repeat across phases — each phase has
      // a distinct phase_id but shares the primary_message_id, so don't assert
      // uniqueness on (kind, source_message_id) alone for reasoning here.
      continue;
    }
    assert.ok(
      count <= 1,
      `after complete, no duplicate chat-row should share key ${key} — found ${count}`
    );
  }
  // Reasoning dedup keys on (data-source-message-id, data-row-id) where row_id
  // includes the phase id (turn:reasoning:<phase>). Two reasoning rows with the
  // same row_id would indicate (primary_message_id, phase_id) duplication.
  const reasoningRowIdCounts = new Map();
  const reasoningRows = window.document.querySelectorAll('.chat-row[data-row-kind="reasoning"][data-source-message-id][data-row-id]');
  reasoningRows.forEach((row) => {
    const sourceMessageId = row.getAttribute('data-source-message-id') || '';
    const rowId = row.getAttribute('data-row-id') || '';
    if (!sourceMessageId || !rowId) {
      return;
    }
    const key = `${sourceMessageId}|${rowId}`;
    reasoningRowIdCounts.set(key, (reasoningRowIdCounts.get(key) || 0) + 1);
  });
  for (const [key, count] of reasoningRowIdCounts.entries()) {
    assert.ok(
      count <= 1,
      `after complete, no duplicate reasoning chat-row should share key ${key} — found ${count}`
    );
  }
});

test('isStreaming gate clears completed turn markers when an earlier source message stays streaming', async (t) => {
  const sessionId = 'session-isstreaming-gate';
  const streamId = 'stream-isstreaming-gate';
  const firstAssistantId = `assistant_${streamId}`;
  const secondAssistantId = `assistant_${streamId}_seg1`;
  const { window, shell } = await loadRendererTestApp(t, {
    shell: {
      chat: {
        async startStream(payload, { state }) {
          state.sessions = [buildRevealSession(sessionId, payload)];
          state.messagesBySession.set(sessionId, []);
          return { sessionId, streamId };
        },
      },
    },
  });
  const input = window.document.getElementById('chatInput');
  const sendButton = window.document.getElementById('sendButton');

  input.value = 'Use a tool, then finish.';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  sendButton.click();
  await waitForUi(window, 40);

  await shell.__emitChat({ type: 'started', sessionId, streamId });
  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: 'First segment before the tool.',
    aggregate: 'First segment before the tool.',
  });
  await waitForUi(window, 80);

  await shell.__emitChat({
    type: 'tool_use',
    sessionId,
    streamId,
    callId: 'call_isstreaming_gate',
    toolName: 'Read',
    status: 'running',
    summary: 'Read context',
  });
  await waitForUi(window, 80);

  await shell.__emitChat({
    type: 'delta',
    sessionId,
    streamId,
    content: ' Final segment after the tool.',
    aggregate: 'First segment before the tool. Final segment after the tool.',
  });
  await waitForUi(window, 80);

  shell.__state.messagesBySession.set(sessionId, [
    {
      id: `user_${streamId}`,
      role: 'user',
      content: 'Use a tool, then finish.',
      status: 'complete',
      timestamp: new Date().toISOString(),
    },
    {
      id: firstAssistantId,
      role: 'assistant',
      content: 'First segment before the tool.',
      status: 'streaming',
      streamId,
      finalizedAt: null,
      timestamp: new Date().toISOString(),
    },
    {
      id: 'tool_use_call_isstreaming_gate',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call_isstreaming_gate',
        tool_name: 'Read',
        parent_stream_id: streamId,
        status: 'completed',
        summary: 'Read context',
      },
      finalizedAt: new Date().toISOString(),
    },
    {
      id: secondAssistantId,
      role: 'assistant',
      content: 'Final segment after the tool.',
      status: 'complete',
      streamId,
      finalizedAt: new Date().toISOString(),
      timestamp: new Date().toISOString(),
    },
  ]);

  await shell.__emitChat({
    type: 'complete',
    sessionId,
    streamId,
    content: 'First segment before the tool. Final segment after the tool.',
    interactiveProtocolDrift: false,
    interactiveProtocolDriftPreview: '',
  });
  await waitForUiState(
    window,
    () => (shell.__state.messagesBySession.get(sessionId) || [])
      .find((message) => message.id === secondAssistantId)?.status === 'complete'
      && window.document.querySelectorAll('.chat-stream-unit').length === 0
  );

  const finalMessages = shell.__state.messagesBySession.get(sessionId) || [];
  const staleFirstSegment = finalMessages.find((message) => message.id === firstAssistantId);
  const terminalSegment = finalMessages.find((message) => message.id === secondAssistantId);
  assert.equal(staleFirstSegment?.status, 'streaming');
  assert.equal(terminalSegment?.status, 'complete');
  assert.equal(window.document.querySelectorAll('.chat-bubble-streaming').length, 0);
  assert.equal(window.document.querySelectorAll('.chat-stream-unit').length, 0);
  assert.equal(window.document.querySelectorAll('.chat-stream-unit.is-streaming-tail').length, 0);
  assert.equal(window.document.querySelectorAll('[data-streaming-row="true"]').length, 0);
  assert.equal(window.document.querySelectorAll('article.chat-entry.assistant.pending').length, 0);
});
