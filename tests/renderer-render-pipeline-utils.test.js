const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createPipelineHarness,
  withWindowGlobals,
  createRenderDom,
} = require('./helpers/render-pipeline-test-harness');
const {
  createRenderEffectsPipeline,
} = require('../renderer/chat/renderer-render-pipeline-render-effects');

function withStreamRevealUtilsOverride(override, run) {
  const previousStreamRevealUtils = global.rendererStreamRevealUtils;
  global.rendererStreamRevealUtils = override;
  try {
    return run();
  } finally {
    global.rendererStreamRevealUtils = previousStreamRevealUtils;
  }
}

test('render effects coalesce virtualizer rebuild rAF and cancel it on dispose', () => {
  const dom = createRenderDom();
  const frames = [];
  const cancelled = [];
  let rebuilds = 0;
  let structuralPrepares = 0;
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousRaf = global.requestAnimationFrame;
  const previousCancel = global.cancelAnimationFrame;
  global.window = dom.window;
  global.document = dom.window.document;
  global.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  global.cancelAnimationFrame = (id) => cancelled.push(id);
  try {
    const pipeline = createRenderEffectsPipeline({
      state: { currentSessionId: 'session', features: { featureFlags: {} }, ui: {} },
      dom: { chatTimeline: dom.window.document.getElementById('timeline') },
      callbacks: {
        renderThreadTree: () => '',
        virtualizerFacade: {
          setActiveTurnRoot() {},
          rebuild() { rebuilds += 1; },
          prepareForStructuralMorph() { structuralPrepares += 1; },
          refreshScope() {},
        },
      },
    });
    const args = [[], {}, '', '', '', null, 'sig', {}, new Set(), {}, new Map(), []];
    pipeline.performFullMessageRender(...args);
    pipeline.performFullMessageRender(...args);
    assert.equal(structuralPrepares, 2, 'stateful virtualized nodes reattach before each structural morph');
    assert.equal(frames.length, 1, 'only one virtualizer rebuild frame may be pending');
    frames[0]();
    assert.equal(rebuilds, 1);
    pipeline.performFullMessageRender(...args);
    assert.equal(frames.length, 2, 'frame id is cleared before rebuild so a later render can schedule');
    pipeline.dispose();
    assert.deepEqual(cancelled, [2]);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.requestAnimationFrame = previousRaf;
    global.cancelAnimationFrame = previousCancel;
  }
});

test('streaming Mermaid and math decorators use patched root with timeline fallback', () => {
  const dom = createRenderDom();
  const timeline = dom.window.document.getElementById('timeline');
  timeline.innerHTML = '<article class="chat-entry" data-message-id="active"><div class="target"></div></article>';
  const mermaidRoots = [];
  const mathRoots = [];
  const previousWindow = global.window;
  global.window = dom.window;
  dom.window.markdownUtils = { renderInlineMermaidBlocks: (root) => mermaidRoots.push(root) };
  dom.window.markdownMathUtils = { renderMathInto: (root) => mathRoots.push(root) };
  try {
    const pipeline = createRenderEffectsPipeline({ dom: { chatTimeline: timeline } });
    pipeline.runPostTimelineRenderEffects([], {
      patchedMessageId: 'active',
      inlineMermaidStreaming: true,
      liveThinking: false,
    });
    pipeline.runPostTimelineRenderEffects([], {
      patchedMessageId: 'missing',
      inlineMermaidStreaming: true,
      liveThinking: false,
    });
    assert.equal(mermaidRoots[0].getAttribute('data-message-id'), 'active');
    assert.equal(mathRoots[0], mermaidRoots[0]);
    assert.equal(mermaidRoots[1], timeline);
    assert.equal(mathRoots[1], timeline);
  } finally {
    global.window = previousWindow;
  }
});

test('surgical stream patches enqueue only their owning thread rail root', () => {
  const dom = createRenderDom();
  const timeline = dom.window.document.getElementById('timeline');
  timeline.innerHTML = [
    '<section class="chat-thread-root" data-thread-message-id="root-a">',
    '  <article class="chat-entry" data-message-id="active"></article>',
    '</section>',
    '<section class="chat-thread-root" data-thread-message-id="root-b">',
    '  <article class="chat-entry" data-message-id="settled"></article>',
    '</section>',
  ].join('');
  const scheduledRoots = [];
  const pipeline = createRenderEffectsPipeline({
    dom: { chatTimeline: timeline },
    callbacks: {
      scheduleRailResizeUpdate(root) { scheduledRoots.push(root); },
    },
  });

  pipeline.runPostTimelineRenderEffects([], {
    patchedMessageId: 'active',
    liveThinking: false,
  });
  pipeline.runPostTimelineRenderEffects([], {
    patchedMessageId: 'missing',
    liveThinking: false,
  });

  assert.deepEqual(scheduledRoots, [timeline.firstElementChild]);
});

test('active-root replacement refreshes rail observation for the new root only', () => {
  const dom = createRenderDom();
  const timeline = dom.window.document.getElementById('timeline');
  timeline.innerHTML = '<section class="chat-thread-root" data-thread-message-id="active"></section>';
  const oldRoot = timeline.firstElementChild;
  const railRefreshes = [];
  const pipeline = createRenderEffectsPipeline({
    state: { currentSessionId: 'session-1', ui: { chatTimelineBatch4FastPathEnabled: true } },
    dom: { chatTimeline: timeline },
    callbacks: {
      renderThreadNode: () => '<section class="chat-thread-root" data-thread-message-id="active"></section>',
      patchStreamRevealActiveTurnRoot({ buildTurnRootMarkup }) {
        timeline.firstElementChild.outerHTML = buildTurnRootMarkup();
        return true;
      },
      refreshRailRootObservation(nextRoot, previousRoot) {
        railRefreshes.push({ nextRoot, previousRoot });
      },
      virtualizerFacade: {
        setActiveTurnRoot() {},
        refreshScope() {},
      },
    },
  });

  const patched = pipeline.tryPatchActiveTurnRoot(
    [],
    { nodeById: new Map([['active', { id: 'active' }]]), roots: [{ id: 'active' }] },
    new Set(),
    '',
    '',
    '',
    null,
    'signature',
    {
      available: true,
      activeTurnId: 'turn-1',
      activeTurnRootMessageId: 'active',
      activeTurnStructureHash: 'structure',
      activeTurnTailFingerprint: 'tail',
    },
    new Map()
  );

  assert.equal(patched, true);
  assert.equal(railRefreshes.length, 1);
  assert.equal(railRefreshes[0].previousRoot, oldRoot);
  assert.equal(railRefreshes[0].nextRoot, timeline.firstElementChild);
  assert.notEqual(railRefreshes[0].nextRoot, oldRoot);
});

test('render pipeline cache clear removes projection and tool-row session caches together', () => {
  const { pipeline, uiRuntime } = createPipelineHarness();
  uiRuntime.projectionContextBySession.set('session-source', { projectionSignature: 'sig-a' });
  uiRuntime.toolRowProjectionFallbacksBySession.set('session-source', new Set(['missing_projected_row']));
  uiRuntime.toolRowProjectionFailuresBySession.set('session-source', new Set(['project_turn_rows_failed']));

  const didClear = pipeline.clearProjectionContextCacheForSession('session-source');

  assert.equal(didClear, true);
  assert.equal(uiRuntime.projectionContextBySession.has('session-source'), false);
  assert.equal(uiRuntime.toolRowProjectionFallbacksBySession.has('session-source'), false);
  assert.equal(uiRuntime.toolRowProjectionFailuresBySession.has('session-source'), false);
});

test('render pipeline handles an empty transcript during bootstrap', () => {
  const dom = createRenderDom();
  const { pipeline, dom: harnessDom } = createPipelineHarness({ dom });

  withWindowGlobals(harnessDom, () => {
    assert.doesNotThrow(() => pipeline.renderMessages({ forceFullRender: true }));
  });

  assert.equal(dom.window.document.getElementById('timeline').innerHTML, '');
});

test('F7: render pipeline emits non-entry time dividers for long timestamp gaps', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    { id: 'u1', role: 'user', content: 'Hello', timestamp: '2026-05-12T10:00:00.000Z' },
    { id: 'a1', role: 'assistant', content: 'Hi', timestamp: '2026-05-12T10:02:00.000Z' },
    { id: 'u2', role: 'user', content: 'Later', timestamp: '2026-05-12T10:10:00.000Z' },
  ];
  const { pipeline, dom: harnessDom } = createPipelineHarness({ dom, visibleMessages });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });

  const timeline = dom.window.document.getElementById('timeline');
  const divider = timeline.querySelector('[data-timeline-divider="time-gap"]');
  assert.ok(divider, timeline.innerHTML);
  assert.equal(divider.getAttribute('data-before-message-id'), 'u2');
  assert.equal(divider.getAttribute('data-search-skip'), 'true');
  assert.equal(divider.classList.contains('chat-entry'), false);
  assert.equal(timeline.querySelectorAll('.chat-entry').length, 3);
});

test('F7: render pipeline derives dividers from expanded visible thread rows', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    { id: 'u1', role: 'user', content: 'Root', timestamp: '2026-05-12T10:00:00.000Z' },
    { id: 'a1', role: 'assistant', content: 'Visible reply', streamId: 'stream-1', timestamp: '2026-05-12T10:01:00.000Z' },
    { id: 'u2', role: 'user', content: 'Later', timestamp: '2026-05-12T10:30:00.000Z' },
  ];
  const { pipeline, dom: harnessDom, state } = createPipelineHarness({ dom, visibleMessages });
  state.ui.threadBranchesCollapsedBySession.set('session-source', new Set());

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });

  const timeline = dom.window.document.getElementById('timeline');
  const divider = timeline.querySelector('[data-timeline-divider="time-gap"]');
  assert.ok(divider, timeline.innerHTML);
  assert.equal(divider.getAttribute('data-before-message-id'), 'u2');
  assert.ok(timeline.querySelector('[data-message-id="a1"]'));
});

test('render pipeline cache rekey preserves fresher target projection cache and merges tool-row dedupe sets', () => {
  const { pipeline, uiRuntime } = createPipelineHarness();
  const sourceProjection = { projectionSignature: 'sig-source' };
  const targetProjection = { projectionSignature: 'sig-target' };
  uiRuntime.projectionContextBySession.set('session-source', sourceProjection);
  uiRuntime.projectionContextBySession.set('session-target', targetProjection);
  uiRuntime.toolRowProjectionFallbacksBySession.set('session-source', new Set(['missing_projected_row']));
  uiRuntime.toolRowProjectionFallbacksBySession.set('session-target', new Set(['other_fallback']));
  uiRuntime.toolRowProjectionFailuresBySession.set('session-source', new Set(['project_turn_rows_failed']));

  const resolvedSessionId = pipeline.rekeyProjectionContextCache('session-source', 'session-target');

  assert.equal(resolvedSessionId, 'session-target');
  assert.equal(uiRuntime.projectionContextBySession.get('session-target'), targetProjection);
  assert.equal(uiRuntime.projectionContextBySession.has('session-source'), false);
  assert.deepEqual(
    Array.from(uiRuntime.toolRowProjectionFallbacksBySession.get('session-target') || []).sort(),
    ['missing_projected_row', 'other_fallback']
  );
  assert.deepEqual(
    Array.from(uiRuntime.toolRowProjectionFailuresBySession.get('session-target') || []).sort(),
    ['project_turn_rows_failed']
  );
  assert.equal(uiRuntime.toolRowProjectionFallbacksBySession.has('session-source'), false);
  assert.equal(uiRuntime.toolRowProjectionFailuresBySession.has('session-source'), false);
});

test('render pipeline resolves tool and segmented message ids to the coalesced assistant article id', () => {
  const { pipeline } = createPipelineHarness();
  const projectionContext = {
    turnIdByMessageId: new Map([
      ['assistant_turn_1', 'turn_1'],
      ['tool_use_turn_1', 'turn_1'],
      ['assistant_turn_1_seg1', 'turn_1'],
    ]),
    turnById: new Map([
      ['turn_1', { primary_assistant_message_id: 'assistant_turn_1' }],
    ]),
  };

  assert.equal(pipeline.resolveTurnArticleMessageId('assistant_turn_1', projectionContext), 'assistant_turn_1');
  assert.equal(pipeline.resolveTurnArticleMessageId('tool_use_turn_1', projectionContext), 'assistant_turn_1');
  assert.equal(pipeline.resolveTurnArticleMessageId('assistant_turn_1_seg1', projectionContext), 'assistant_turn_1');
  assert.equal(pipeline.resolveTurnArticleMessageId('user_turn_1', projectionContext), 'user_turn_1');
});

test('render pipeline records turn_article_missing_primary when a projected turn has no primary assistant anchor', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    {
      id: 'assistant_stream_missing_primary',
      role: 'assistant',
      kind: 'interactive_round_recap',
      status: 'complete',
      streamId: 'stream_missing_primary',
      content: 'Recap without a standard assistant anchor.',
      interactive_round_recap: {
        request_id: 'recap_request_missing_primary',
        asked_count: 1,
        items: [],
      },
    },
  ];
  const { pipeline, rolloutSignals, dom: harnessDom } = createPipelineHarness({
    dom,
    visibleMessages,
    rowModelEnabled: true,
    currentSessionId: 'session-row-model',
  });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });

  assert.ok(
    rolloutSignals.some((entry) =>
      entry.signal === 'turn_article_missing_primary'
      && entry.details?.turnId === 'stream_missing_primary'
      && entry.details?.messageId === 'assistant_stream_missing_primary'
    )
  );
  assert.ok(dom.window.document.querySelector('[data-message-id="assistant_stream_missing_primary"]'));
});

test('render pipeline fallback recap parsing accepts camelCase answerCount metadata', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    {
      id: 'assistant_stream_missing_primary_camel',
      role: 'assistant',
      kind: 'interactive_round_recap',
      status: 'complete',
      streamId: 'stream_missing_primary_camel',
      content: 'CamelCase recap metadata should still project.',
      interactive_round_recap: {
        requestId: 'recap_request_missing_primary_camel',
        answerCount: 1,
        items: [],
      },
    },
  ];
  const { pipeline, rolloutSignals, dom: harnessDom } = createPipelineHarness({
    dom,
    visibleMessages,
    rowModelEnabled: true,
    currentSessionId: 'session-row-model',
  });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });

  assert.ok(
    rolloutSignals.some((entry) =>
      entry.signal === 'turn_article_missing_primary'
      && entry.details?.turnId === 'stream_missing_primary_camel'
      && entry.details?.messageId === 'assistant_stream_missing_primary_camel'
    )
  );
});

test('render pipeline renders a trace tool_call row and folds the tool_result message to a thread-compat anchor', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    { id: 'user_trace_rows', role: 'user', content: 'Inspect a file', status: 'complete' },
    {
      id: 'tool_use_trace_rows',
      role: 'assistant',
      kind: 'tool_use',
      status: 'complete',
      content: '',
      tool_call: {
        call_id: 'call_trace_rows',
        tool_name: 'Read',
        parent_stream_id: 'trace_rows_turn',
        status: 'completed',
        input: 'README.md',
      },
    },
    {
      id: 'tool_result_trace_rows',
      role: 'assistant',
      kind: 'tool_result',
      status: 'complete',
      content: '',
      tool_result: {
        call_id: 'call_trace_rows',
        parent_stream_id: 'trace_rows_turn',
        output_text: 'done',
      },
    },
    {
      id: 'assistant_trace_rows',
      role: 'assistant',
      status: 'complete',
      content: 'Finished.',
      streamId: 'trace_rows_turn',
    },
  ];
  const { pipeline, dom: harnessDom } = createPipelineHarness({
    dom,
    visibleMessages,
    rowModelEnabled: true,
    currentSessionId: 'session-trace-rollout',
  });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });

  // The completed tool_use renders a trace tool_call row whose state has already
  // reconciled to completed. The matching tool_result message is folded into a
  // thread-compat anchor on the turn article rather than rendering as its own
  // standalone row in this message-tree path, so neither a tool_result row nor a
  // tool_result message article is present in the visible timeline.
  const toolCallRow = dom.window.document.querySelector('[data-row-kind="tool_call"]');
  assert.ok(toolCallRow);
  assert.equal(toolCallRow.getAttribute('data-row-state'), 'completed');
  assert.match(toolCallRow.textContent, /Success/);
  assert.equal(dom.window.document.querySelector('[data-row-kind="tool_result"]'), null);
  assert.equal(dom.window.document.querySelector('[data-message-kind="tool_result"]'), null);
});

test('render pipeline leaves trace row-target patching disabled while the active stream is assistant text', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    { id: 'user_trace_streaming', role: 'user', content: 'Use a tool', status: 'complete' },
    {
      id: 'tool_use_trace_streaming',
      role: 'assistant',
      kind: 'tool_use',
      status: 'complete',
      content: '',
      tool_call: {
        call_id: 'call_trace_streaming',
        tool_name: 'Read',
        status: 'completed',
        input: 'trace.txt',
      },
    },
    {
      id: 'tool_result_trace_streaming',
      role: 'assistant',
      kind: 'tool_result',
      status: 'complete',
      content: '',
      tool_result: {
        call_id: 'call_trace_streaming',
        output_text: 'trace output',
      },
    },
    {
      id: 'assistant_trace_streaming',
      role: 'assistant',
      status: 'streaming',
      content: 'Continuing with the answer',
      streamId: 'trace_streaming_turn',
    },
  ];
  let committedStreamingRowTarget = undefined;

  withStreamRevealUtilsOverride({
    createStreamRevealController() {
      return {
        buildTimelineStructureSignature() {
          return 'trace-streaming-signature';
        },
        updateTailState() {},
        commitFullRender(options) {
          committedStreamingRowTarget = options?.streamingRowTarget ?? null;
        },
        canPatchMessage() {
          return false;
        },
      };
    },
  }, () => {
    const { pipeline, dom: harnessDom } = createPipelineHarness({
      dom,
      visibleMessages,
      rowModelEnabled: true,
      currentSessionId: 'session-trace-streaming',
    });

    withWindowGlobals(harnessDom, () => {
      pipeline.renderMessages({ forceFullRender: true });
    });
  });

  assert.equal(committedStreamingRowTarget, null);
});

test('render pipeline records stream mismatch signals while visible coalesced siblings render', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    { id: 'user_stream_signal_turn', role: 'user', content: 'Use a tool', status: 'complete' },
    {
      id: 'assistant_stream_signal_turn',
      role: 'assistant',
      streamId: 'stream_signal_turn',
      content: 'I am checking now.',
      status: 'complete',
      finalizedAt: '2026-03-20T12:00:00.000Z',
    },
    {
      id: 'tool_use_stream_signal_turn',
      role: 'assistant',
      kind: 'tool_use',
      status: 'completed',
      tool_call: {
        call_id: 'call_signal_turn',
        tool_name: 'Read',
        parent_stream_id: 'stream_signal_turn',
        status: 'completed',
        summary: 'Read plan.md',
      },
    },
    {
      id: 'assistant_stream_signal_turn_seg1',
      role: 'assistant',
      streamId: 'stream_signal_turn',
      content: 'I found the issue.',
      status: 'complete',
      finalizedAt: '2026-03-20T12:00:01.000Z',
    },
  ];
  const { pipeline, rolloutSignals, dom: harnessDom } = createPipelineHarness({
    dom,
    visibleMessages,
    rowModelEnabled: true,
    currentSessionId: 'session-row-model',
  });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });

  const suppressedSignals = rolloutSignals.filter((entry) => entry.signal === 'turn_article_suppressed_sibling');
  assert.deepEqual(suppressedSignals, []);
  assert.ok(dom.window.document.querySelector('[data-message-id="tool_use_stream_signal_turn"]'));
  assert.ok(dom.window.document.querySelector('[data-message-id="assistant_stream_signal_turn_seg1"]'));

  const streamingDom = createRenderDom();
  const streamingMessages = [
    { id: 'user_stream_signal_live', role: 'user', content: 'Keep streaming', status: 'complete' },
    {
      id: 'assistant_stream_signal_live',
      role: 'assistant',
      streamId: 'stream_signal_live',
      content: 'Working',
      status: 'streaming',
    },
  ];
  const { pipeline: streamingPipeline, rolloutSignals: streamingSignals, dom: streamingHarnessDom } = createPipelineHarness({
    dom: streamingDom,
    visibleMessages: streamingMessages,
    rowModelEnabled: true,
    currentSessionId: 'session-row-model',
  });

  withWindowGlobals(streamingHarnessDom, () => {
    streamingPipeline.renderMessages();
  });

  assert.ok(
    streamingSignals.some((entry) =>
      entry.signal === 'turn_article_stream_mismatch'
      && entry.details?.streamingMessageId === 'assistant_stream_signal_live'
      && entry.details?.streamingArticleMessageId === 'assistant_stream_signal_live'
    )
  );
});

test('render pipeline suppresses turn-article rollout diagnostics when the row-model rollout is disabled', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    {
      id: 'assistant_rollout_disabled_notice',
      role: 'assistant',
      kind: 'interactive_round_recap',
      status: 'complete',
      streamId: 'stream_rollout_disabled_notice',
      content: 'No rollout diagnostics should be recorded when disabled.',
      interactive_round_recap: {
        request_id: 'recap_rollout_disabled_notice',
        asked_count: 1,
        items: [],
      },
    },
  ];
  const { pipeline, rolloutSignals, dom: harnessDom } = createPipelineHarness({
    dom,
    visibleMessages,
    rowModelEnabled: false,
    currentSessionId: 'session-row-model-disabled',
  });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });

  assert.deepEqual(rolloutSignals, []);
});

test('streaming structural shift repaints the visible live article and syncs viewport', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    { id: 'user_stream_structural_shift', role: 'user', content: 'Think out loud', status: 'complete' },
    {
      id: 'assistant_stream_structural_shift',
      role: 'assistant',
      streamId: 'stream-structural-shift',
      content: 'First chunk',
      status: 'streaming',
    },
  ];
  const viewportSyncCalls = [];
  const { pipeline, dom: harnessDom } = withWindowGlobals(dom, () => createPipelineHarness({
    dom,
    visibleMessages,
    currentSessionId: 'session-structural-shift',
    renderThinkingWidget(message) {
      const entries = Array.isArray(message?.reasoning?.entries) ? message.reasoning.entries : [];
      if (!entries.length) return '';
      const body = entries.map((entry) => String(entry?.text || '')).join('\n');
      return `<div class="reasoning-row-stack" data-testid="live-reasoning">${body}</div>`;
    },
    scheduleMessageViewportSync(messages) {
      viewportSyncCalls.push(messages.map((message) => String(message?.id || '')).join('|'));
    },
  }));

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });

  const timeline = harnessDom.window.document.getElementById('timeline');
  const articleBefore = timeline.querySelector('[data-message-id="assistant_stream_structural_shift"]');
  assert.ok(articleBefore);
  assert.match(articleBefore.textContent, /First chunk/);
  assert.doesNotMatch(articleBefore.textContent, /live reasoning/);
  viewportSyncCalls.length = 0;

  visibleMessages[1].reasoning = {
    source: 'provider',
    entries: [{ id: 'reasoning_1', text: 'live reasoning is visible' }],
  };
  visibleMessages[1].content = 'First chunk plus live response';

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages();
  });

  const articleAfter = timeline.querySelector('[data-message-id="assistant_stream_structural_shift"]');
  assert.equal(articleAfter, articleBefore);
  assert.match(articleAfter.textContent, /live reasoning is visible/);
  assert.match(articleAfter.textContent, /live response/);
  assert.equal(viewportSyncCalls.length, 1);
});

test('active-turn structural tool update preserves existing projected tool row nodes', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    { id: 'user_tool_preserve', role: 'user', content: 'Use a tool', status: 'complete' },
    {
      id: 'assistant_tool_preserve',
      role: 'assistant',
      streamId: 'stream-tool-preserve',
      content: 'I will check.',
      status: 'complete',
      finalizedAt: '2026-05-26T12:00:00.000Z',
    },
    {
      id: 'tool_use_preserve',
      role: 'assistant',
      kind: 'tool_use',
      streamId: 'stream-tool-preserve',
      status: 'running',
      finalizedAt: '2026-05-26T12:00:00.000Z',
      tool_call: {
        call_id: 'call_tool_preserve',
        tool_name: 'bash',
        parent_stream_id: 'stream-tool-preserve',
        status: 'running',
        summary: 'Inspect workspace',
      },
    },
  ];
  const { pipeline, dom: harnessDom } = createPipelineHarness({
    dom,
    visibleMessages,
    rowModelEnabled: true,
    currentSessionId: 'session-tool-preserve',
  });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });

  const timeline = harnessDom.window.document.getElementById('timeline');
  const rootBefore = timeline.querySelector('[data-thread-message-id="user_tool_preserve"]');
  const toolNodeBefore = timeline.querySelector('[data-thread-message-id="tool_use_preserve"]');
  const toolArticleBefore = timeline.querySelector('[data-message-id="tool_use_preserve"]');
  const toolRowBefore = timeline.querySelector('[data-row-kind="tool_call"][data-tool-call-id="call_tool_preserve"]');
  assert.ok(rootBefore);
  assert.ok(toolNodeBefore);
  assert.ok(toolArticleBefore);
  assert.ok(toolRowBefore);

  visibleMessages[2] = {
    ...visibleMessages[2],
    status: 'completed',
    tool_call: {
      ...visibleMessages[2].tool_call,
      status: 'completed',
    },
  };
  visibleMessages.push({
    id: 'tool_result_preserve',
    role: 'assistant',
    kind: 'tool_result',
    status: 'complete',
    content: 'workspace ok',
    finalizedAt: '2026-05-26T12:00:01.000Z',
    tool_result: {
      call_id: 'call_tool_preserve',
      tool_name: 'bash',
      parent_stream_id: 'stream-tool-preserve',
      output_text: 'workspace ok',
      summary: 'Inspect workspace complete',
      metadata: {
        stdout: 'workspace ok',
        exitCode: 0,
      },
    },
  });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages();
  });

  const rootAfter = timeline.querySelector('[data-thread-message-id="user_tool_preserve"]');
  const toolNodeAfter = timeline.querySelector('[data-thread-message-id="tool_use_preserve"]');
  const toolArticleAfter = timeline.querySelector('[data-message-id="tool_use_preserve"]');
  const toolRowAfter = timeline.querySelector('[data-row-kind="tool_call"][data-tool-call-id="call_tool_preserve"]');
  assert.equal(rootAfter, rootBefore);
  assert.equal(toolNodeAfter, toolNodeBefore);
  assert.equal(toolArticleAfter, toolArticleBefore);
  assert.equal(toolRowAfter, toolRowBefore);
  assert.equal(toolRowAfter.getAttribute('data-row-state'), 'completed');
  assert.match(toolRowAfter.textContent, /Success/);
});

test('view catch-up render patches hidden streaming deltas without replacing timeline nodes', async () => {
  const dom = createRenderDom();
  const visibleMessages = [
    { id: 'user_catchup_1', role: 'user', content: 'Keep this stable', status: 'complete' },
    {
      id: 'assistant_stream_catchup',
      role: 'assistant',
      streamId: 'stream-catchup',
      content: 'First chunk',
      status: 'streaming',
    },
  ];
  dom.window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};
  const { pipeline, state, logs, dom: harnessDom } = withWindowGlobals(dom, () => createPipelineHarness({
    dom,
    visibleMessages,
    currentSessionId: 'session-catchup',
  }));
  state.ui.chatTimelineVisibilityTracker.setLogger((level, event, data) => {
    logs.push({ level, event, data });
  });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });

  const timeline = harnessDom.window.document.getElementById('timeline');
  const userEntryBefore = timeline.querySelector('[data-message-id="user_catchup_1"]');
  const assistantEntryBefore = timeline.querySelector('[data-message-id="assistant_stream_catchup"]');
  assert.ok(userEntryBefore);
  assert.ok(assistantEntryBefore);

  state.ui.chatTimelineVisibilityTracker.markRenderableEvent('session-catchup', {
    streamId: 'stream-catchup',
    eventType: 'delta',
    visible: false,
    current: true,
  });
  visibleMessages[1].content = 'First chunk plus hidden text';

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ reason: 'view_catchup' });
  });
  const previousWindow = global.window;
  global.window = harnessDom.window;
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
  } finally {
    global.window = previousWindow;
  }

  assert.equal(timeline.querySelector('[data-message-id="user_catchup_1"]'), userEntryBefore);
  assert.equal(timeline.querySelector('[data-message-id="assistant_stream_catchup"]'), assistantEntryBefore);
  assert.match(assistantEntryBefore.textContent, /hidden text/);
  assert.equal(state.ui.chatTimelineVisibilityTracker.isCatchupInProgress('session-catchup'), false);
  assert.equal(
    logs.some((entry) => entry.event === 'timeline.catchup_patched'),
    true
  );
});

test('view catch-up full-render fallback records one render commit', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    { id: 'user_catchup_fallback_1', role: 'user', content: 'Keep this stable', status: 'complete' },
    {
      id: 'assistant_stream_catchup_fallback',
      role: 'assistant',
      streamId: 'stream-catchup-fallback',
      content: 'Hidden text',
      status: 'streaming',
    },
  ];
  const { pipeline, state, logs, dom: harnessDom } = withWindowGlobals(dom, () => createPipelineHarness({
    dom,
    visibleMessages,
    currentSessionId: 'session-catchup-fallback',
  }));
  state.ui.chatTimelineVisibilityTracker.setLogger((level, event, data) => {
    logs.push({ level, event, data });
  });
  state.ui.chatTimelineVisibilityTracker.markRenderableEvent('session-catchup-fallback', {
    streamId: 'stream-catchup-fallback',
    eventType: 'delta',
    visible: false,
    current: true,
  });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ reason: 'view_catchup' });
  });

  const fallbackLogs = logs.filter((entry) => entry.event === 'timeline.catchup_full_render_fallback');
  assert.equal(fallbackLogs.length, 1);
  assert.equal(fallbackLogs[0].data.reason, 'missing_streaming_article');
  assert.equal(state.ui.chatTimelineVisibilityTracker.peek('session-catchup-fallback').lastVisibleRenderEpoch, 1);
});

test('view catch-up final full render fallback is informational', () => {
  const dom = createRenderDom();
  const visibleMessages = [
    { id: 'user_catchup_final_1', role: 'user', content: 'Keep this stable', status: 'complete' },
    {
      id: 'assistant_stream_catchup_final',
      role: 'assistant',
      streamId: 'stream-catchup-final',
      content: 'Hidden text',
      status: 'streaming',
    },
  ];
  const { pipeline, state, logs, dom: harnessDom } = withWindowGlobals(dom, () => createPipelineHarness({
    dom,
    visibleMessages,
    currentSessionId: 'session-catchup-final',
  }));
  state.ui.chatTimelineVisibilityTracker.setLogger((level, event, data) => {
    logs.push({ level, event, data });
  });
  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ forceFullRender: true });
  });
  logs.length = 0;
  state.ui.chatTimelineVisibilityTracker.markRenderableEvent('session-catchup-final', {
    streamId: 'stream-catchup-final',
    eventType: 'delta',
    visible: false,
    current: true,
  });

  withWindowGlobals(harnessDom, () => {
    pipeline.renderMessages({ reason: 'view_catchup', forceFullRender: true });
  });

  const fallbackLogs = logs.filter((entry) => entry.event === 'timeline.catchup_full_render_fallback');
  assert.equal(fallbackLogs.length, 1);
  assert.equal(fallbackLogs[0].level, 'INFO');
  assert.equal(fallbackLogs[0].data.reason, 'final_full_render');
});
