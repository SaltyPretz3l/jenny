const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JSDOM,
  createStreamRevealController,
} = require('./helpers/renderer-stream-reveal-harness');
const {
  createPipelineHarness,
  createRenderDom,
  withWindowGlobals,
} = require('./helpers/render-pipeline-test-harness');
const {
  createRenderPipelineMessageRenderer,
} = require('../renderer/chat/renderer-render-pipeline-message-renderer');

function timelineWrites(signalCalls) {
  return signalCalls.filter((call) => call.signal === 'timeline_dom_write');
}

function assertTimelineWrite(call, lane) {
  assert.ok(call, `${lane} should emit timeline_dom_write`);
  assert.strictEqual(call.details.lane, lane);
  assert.ok(String(call.details.outcome || '').trim(), `${lane} should report a non-empty outcome`);
  for (const field of ['reused', 'cloned', 'removed']) {
    if (call.details[field] !== undefined) {
      assert.ok(Number.isFinite(call.details[field]), `${lane}.${field} should be finite when present`);
    }
  }
}

test('full_render emits timeline_dom_write and keeps the telemetry gate', (t) => {
  const enabledDom = createRenderDom();
  const enabled = createPipelineHarness({
    dom: enabledDom,
    visibleMessages: [{ id: 'u1', role: 'user', status: 'complete', content: 'hello' }],
  });
  enabled.state.features = { featureFlags: { chat_timeline_render_telemetry: true } };
  t.after(() => enabled.pipeline.dispose?.());
  withWindowGlobals(enabledDom, () => enabled.pipeline.renderMessages({ forceFullRender: true }));

  const enabledWrite = timelineWrites(enabled.rolloutSignals).find(
    (call) => call.details?.lane === 'full_render'
  );
  assertTimelineWrite(enabledWrite, 'full_render');

  const disabledDom = createRenderDom();
  const disabled = createPipelineHarness({
    dom: disabledDom,
    visibleMessages: [{ id: 'u2', role: 'user', status: 'complete', content: 'hello' }],
  });
  disabled.state.features = { featureFlags: { chat_timeline_render_telemetry: false } };
  t.after(() => disabled.pipeline.dispose?.());
  withWindowGlobals(disabledDom, () => disabled.pipeline.renderMessages({ forceFullRender: true }));

  assert.equal(
    timelineWrites(disabled.rolloutSignals).length,
    0,
    'full_render should not emit timeline_dom_write when telemetry is disabled'
  );
});

test('streaming_article emits timeline_dom_write for both rebuild sub-paths', () => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="scroll"><div id="timeline">
      <article class="chat-entry assistant" data-message-id="assistant_stream">
        <div data-row-id="stable">old</div>
      </article>
    </div></div>
  </body></html>`);
  const documentRef = dom.window.document;
  const messages = [{
    id: 'assistant_stream',
    role: 'assistant',
    status: 'streaming',
    content: 'next',
    streamId: 'stream-1',
  }];
  const state = {
    currentSessionId: 'session-streaming',
    ui: { chatMode: 'thread', animateNextChatActivation: false },
    auth: { authenticated: true },
    backend: { phase: 'ready' },
    features: { featureFlags: {
      chat_timeline_render_telemetry: true,
      chat_timeline_streaming_article_morph: true,
    } },
  };
  const uiRuntime = {
    recapExpansionSignature: 'recap',
    threadBranchSignature: 'thread',
    projectionCommittedRevisionKey: '',
  };
  const signalCalls = [];
  let renderSequence = 0;
  let articleMarkup = `<article class="chat-entry assistant" data-message-id="assistant_stream">
    <div data-row-id="stable">morphed</div>
  </article>`;
  const renderer = createRenderPipelineMessageRenderer({
    state,
    dom: {
      chatTimeline: documentRef.getElementById('timeline'),
      chatThreadScroll: documentRef.getElementById('scroll'),
    },
    runtime: { uiRuntime },
    callbacks: {
      buildCanonicalTranscriptMessages: () => messages,
      buildMessageArticleInnerHtml: (_message, innerHtml) => innerHtml,
      buildMessageArticleMarkup: () => articleMarkup,
      buildMessageInnerMarkup: () => ({
        innerHtml: '<div>legacy</div>',
        pending: true,
        entryReveal: false,
        status: 'streaming',
        finalizedAt: '',
      }),
      buildMessageRenderSignature: () => `render:${renderSequence += 1}`,
      buildProjectionContext: () => ({ activeTurnRootMessageId: 'assistant_stream' }),
      buildRecapExpansionSignature: () => 'recap',
      buildThreadExpansionSignature: () => 'thread',
      buildTranscriptThreadTree: () => ({ roots: [], nodeById: new Map() }),
      collectThreadBranchIds: () => new Set(),
      computeDerivedMessageState: () => ({
        latestAssistantMessageId: 'assistant_stream',
        latestReplyAssistantMessageId: 'assistant_stream',
        thinkingMessageIds: [],
        streamingMessage: messages[0],
        idToIndex: new Map([['assistant_stream', 0]]),
      }),
      computeStructureHash: () => renderSequence,
      getCurrentVisibleMessages: () => messages,
      recordTurnArticleRolloutSignal: (signal, details) => {
        signalCalls.push({ signal, details });
        return { logged: true, count: signalCalls.length };
      },
      resolveTurnArticleMessageId: () => 'assistant_stream',
      resolveVisibleTurnArticleTarget: () => documentRef.querySelector('[data-message-id="assistant_stream"]'),
    },
  });

  withWindowGlobals(dom, () => {
    renderer.renderMessages();
    articleMarkup = '<div>not an article</div>';
    renderer.renderMessages();
  });

  const writes = timelineWrites(signalCalls);
  assert.equal(writes.length, 2, 'streaming_article should emit for both article rebuild sub-paths');
  writes.forEach((call) => assertTimelineWrite(call, 'streaming_article'));
  assert.deepEqual(
    writes.map((call) => call.details.outcome),
    ['morph_applied', 'legacy_article_innerhtml']
  );
});

test('active_turn_root emits timeline_dom_write', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="timeline">
    <div class="chat-thread-root" data-thread-message-id="u1">
      <article data-message-id="u1">old</article>
    </div>
  </div></body>`);
  const signalCalls = [];
  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: dom.window.document.getElementById('timeline'),
    reducedMotionQuery: { matches: false },
    state: { features: { featureFlags: { chat_timeline_render_telemetry: true } } },
    recordChatTimelineRolloutSignal(sessionId, signal, details) {
      signalCalls.push({ sessionId, signal, details });
      return { logged: true, count: signalCalls.length };
    },
  });
  controller.commitFullRender({
    currentSessionId: 'session-active-root',
    structureSignature: 1,
    activeTurnRootMessageId: 'u1',
    activeTurnStructureHash: 10,
    activeTurnTailFingerprint: 'old',
  });

  assert.equal(controller.patchActiveTurnRoot({
    currentSessionId: 'session-active-root',
    structureSignature: 2,
    activeTurnRootMessageId: 'u1',
    turnStructureHash: 10,
    turnTailFingerprint: 'new',
    expectedRootOrder: ['u1'],
    buildTurnRootMarkup: () => `<div class="chat-thread-root" data-thread-message-id="u1">
      <article data-message-id="u1">new</article>
    </div>`,
  }), true);

  const write = timelineWrites(signalCalls).find((call) => call.details?.lane === 'active_turn_root');
  assertTimelineWrite(write, 'active_turn_root');
});

test('turn_row_list emits timeline_dom_write', () => {
  const dom = new JSDOM(`<!doctype html><body><div id="timeline">
    <article class="chat-entry assistant pending" data-message-id="assistant_stream">
      <div data-turn-row-list="true">
        <div class="chat-row" data-row-id="row-1">old</div>
      </div>
    </article>
  </div></body>`);
  const timeline = dom.window.document.getElementById('timeline');
  const signalCalls = [];
  const streamingMessage = {
    id: 'assistant_stream',
    role: 'assistant',
    status: 'streaming',
    content: 'new',
  };
  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    state: { features: { featureFlags: { chat_timeline_render_telemetry: true } } },
    escapeSelectorValue: (value) => String(value || ''),
    recordChatTimelineRolloutSignal(sessionId, signal, details) {
      signalCalls.push({ sessionId, signal, details });
      return { logged: true, count: signalCalls.length };
    },
  });
  controller.commitFullRender({
    currentSessionId: 'session-row-list',
    structureSignature: 1,
    streamingMessage,
    streamingArticleMessageId: 'assistant_stream',
  });

  controller.queuePatch({
    currentSessionId: 'session-row-list',
    structureSignature: 2,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage,
    messages: [streamingMessage],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: '<span>new</span>',
      innerHtml: '<div>legacy fallback must not be used</div>',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
    buildTurnRowListMarkup: () => '<div class="chat-row" data-row-id="row-1">new</div>',
  });

  const write = timelineWrites(signalCalls).find((call) => call.details?.lane === 'turn_row_list');
  assertTimelineWrite(write, 'turn_row_list');
});
