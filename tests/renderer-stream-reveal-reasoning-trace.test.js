const test = require('node:test');
const assert = require('node:assert/strict');

const {
  JSDOM,
  createImmediateRevealController,
  createStreamRevealController,
  disposeTrackedRevealDoms,
  reasoningStackMarkup,
  trackRevealDom,
} = require('./helpers/renderer-stream-reveal-harness');

test.afterEach(() => {
  disposeTrackedRevealDoms();
});

test('stream reveal patch updates an existing reasoning-only panel body', () => {
  const { timeline, controller } = createImmediateRevealController(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
            <div class="chat-message-content">
              ${reasoningStackMarkup('first chunk')}
            </div>
          </article>
        </div>
      </body>
    </html>
  `);

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });

  const reasoningToggleBefore = timeline.querySelector('[data-reasoning-toggle]');

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      thinkingMarkup: reasoningStackMarkup('first chunk second chunk'),
      innerHtml: '',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });

  assert.equal(
    timeline.querySelector('.reasoning-row-panel-body')?.textContent.trim(),
    'first chunk second chunk'
  );
  assert.equal(
    timeline.querySelector('[data-reasoning-toggle]'),
    reasoningToggleBefore,
    'reasoning toggle node identity should be preserved during same-shape patches'
  );
});

function buildPaintV2State(enabled, sessionId = 'session-1') {
  return {
    currentSessionId: sessionId,
    features: { featureFlags: { chat_stream_paint_v2: enabled } },
  };
}

// The harness's synchronous-immediate rAF leaves queuePatch's patchFrame
// handle truthy after the first patch (the callback zeroes it BEFORE the
// return value is assigned), so repeated patches would silently no-op. A
// flush-controlled rAF mirrors the real async browser ordering instead.
function createFlushableRevealController(html, options = {}) {
  const dom = trackRevealDom(new JSDOM(html));
  const timeline = dom.window.document.getElementById('timeline');
  const frames = [];
  dom.window.requestAnimationFrame = (callback) => frames.push(callback);
  dom.window.cancelAnimationFrame = () => {};
  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: () => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 }),
    escapeSelectorValue: (value) => String(value || ''),
    state: options.state,
    streamClientMetrics: options.streamClientMetrics,
  });
  const flushFrames = () => frames.splice(0).forEach((callback) => callback());
  return { dom, timeline, controller, flushFrames };
}

function driveReasoningHeaderPatch(controller, text) {
  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      thinkingMarkup: reasoningStackMarkup(text),
      innerHtml: '',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });
}

test('chat_stream_paint_v2 ON: summary-only delta morphs the reasoning header in place (Ht-C C1)', () => {
  const { timeline, controller, flushFrames } = createFlushableRevealController(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
            <div class="chat-message-content">
              ${reasoningStackMarkup('first summary')}
            </div>
          </article>
        </div>
      </body>
    </html>
  `, { state: buildPaintV2State(true) });

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });

  const headerBefore = timeline.querySelector('.reasoning-row-header');
  const mainBefore = timeline.querySelector('.reasoning-row-main');
  assert.ok(mainBefore, 'harness markup must render a header main span');

  driveReasoningHeaderPatch(controller, 'first summary grows longer');
  flushFrames();

  const mainAfter = timeline.querySelector('.reasoning-row-main');
  assert.equal(mainAfter?.textContent, 'first summary grows longer');
  assert.equal(
    mainAfter,
    mainBefore,
    'flag ON must update the header text in place â€” the .reasoning-row-main element identity must survive a summary-only delta'
  );
  assert.equal(timeline.querySelector('.reasoning-row-header'), headerBefore);
});

test('chat_stream_paint_v2 ON: morph reconciles the full header shape â€” meta appears, status tone flips', () => {
  // Mirrors the real renderPhase header (kicker + main + status cluster with
  // optional meta): the meta span APPEARS between deltas and the status-dot
  // tone changes â€” the structural cases the simple text-only pin skips.
  const fullHeaderStack = (text, { meta = '', tone = 'active' } = {}) => `
    <div class="reasoning-row-stack" data-reasoning-row-version="2">
      <div class="reasoning-row-block expanded" data-thinking-id="think_1" data-phase-key="think_1">
        <button class="reasoning-row-header" type="button" data-reasoning-toggle="true" data-message-id="assistant_stream" data-thinking-id="think_1" data-phase-key="think_1">
          <span class="kicker kicker--accent reasoning-row-kicker">Reasoning</span>
          <span class="reasoning-row-main shimmer-active">${text}</span>
          <span class="reasoning-row-status-cluster" aria-hidden="true">
            ${meta ? `<span class="reasoning-row-meta">${meta}</span>` : ''}
            <span class="status-dot status-dot--${tone}"></span>
            <span class="reasoning-row-caret"></span>
          </span>
        </button>
        <div class="reasoning-row-panel expanded" data-thinking-id="think_1" data-phase-key="think_1">
          <div class="reasoning-row-panel-body chat-bubble-markdown"><p>${text}</p></div>
        </div>
      </div>
    </div>
  `;
  const { timeline, controller, flushFrames } = createFlushableRevealController(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
            <div class="chat-message-content">
              ${fullHeaderStack('warming up')}
            </div>
          </article>
        </div>
      </body>
    </html>
  `, { state: buildPaintV2State(true) });

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });

  const mainBefore = timeline.querySelector('.reasoning-row-main');
  assert.equal(timeline.querySelector('.reasoning-row-meta'), null, 'no meta span before the delta');

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      thinkingMarkup: fullHeaderStack('warming up further', { meta: 'Thought for 3s', tone: 'success' }),
      innerHtml: '',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });
  flushFrames();

  assert.equal(timeline.querySelector('.reasoning-row-main'), mainBefore,
    'main span identity survives even when siblings restructure');
  assert.equal(timeline.querySelector('.reasoning-row-main')?.textContent, 'warming up further');
  assert.equal(timeline.querySelector('.reasoning-row-meta')?.textContent, 'Thought for 3s',
    'the meta span appears via the morph path');
  assert.ok(timeline.querySelector('.status-dot--success'), 'status-dot tone updated');
  assert.equal(timeline.querySelector('.status-dot--active'), null, 'old tone class removed');
  assert.ok(timeline.querySelector('.reasoning-row-caret'), 'caret still present');
});

test('chat_stream_paint_v2 OFF: header patch keeps the historical innerHTML-rewrite path byte-identical', () => {
  const { timeline, controller, flushFrames } = createFlushableRevealController(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
            <div class="chat-message-content">
              ${reasoningStackMarkup('first summary')}
            </div>
          </article>
        </div>
      </body>
    </html>
  `, { state: buildPaintV2State(false) });

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });

  const headerBefore = timeline.querySelector('.reasoning-row-header');
  const mainBefore = timeline.querySelector('.reasoning-row-main');

  driveReasoningHeaderPatch(controller, 'first summary grows longer');
  flushFrames();

  const mainAfter = timeline.querySelector('.reasoning-row-main');
  assert.equal(mainAfter?.textContent, 'first summary grows longer');
  assert.notEqual(
    mainAfter,
    mainBefore,
    'flag OFF pins the pre-Ht-C behavior: the header children are rebuilt via innerHTML replacement'
  );
  assert.equal(timeline.querySelector('.reasoning-row-header'), headerBefore,
    'the header button itself was always preserved â€” only its children were rewritten');
});

test('client_timing counters prove the header repaint reduction ON vs OFF (Ht-C acceptance)', () => {
  const { createStreamClientMetrics } = require('../renderer/chat/renderer-stream-client-metrics');
  const summaries = ['s1', 's1 s2', 's1 s2 s3', 's1 s2 s3 s4', 's1 s2 s3 s4 s5'];

  function runStream(flagEnabled) {
    const metrics = createStreamClientMetrics({ now: () => 0, ship: () => {} });
    metrics.noteDelta('stream-1', 'session-1');
    const { controller, flushFrames } = createFlushableRevealController(`
      <!doctype html>
      <html>
        <body>
          <div id="timeline">
            <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
              <div class="chat-message-content">
                ${reasoningStackMarkup('s0')}
              </div>
            </article>
          </div>
        </body>
      </html>
    `, { state: buildPaintV2State(flagEnabled), streamClientMetrics: metrics });
    controller.commitFullRender({
      currentSessionId: 'session-1',
      structureSignature: 10,
      streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
      streamingArticleMessageId: 'assistant_stream',
    });
    for (const summary of summaries) {
      driveReasoningHeaderPatch(controller, summary);
      flushFrames();
    }
    return metrics.take('stream-1');
  }

  const on = runStream(true);
  const off = runStream(false);

  assert.equal(off.reasoning_header_rewrites, summaries.length,
    'flag OFF: every summary delta costs a destructive header innerHTML rewrite');
  assert.equal(off.reasoning_header_morphs, 0);
  assert.equal(on.reasoning_header_rewrites, 0,
    'flag ON: no destructive header rewrites remain');
  assert.equal(on.reasoning_header_morphs, summaries.length);
  assert.ok(
    on.reasoning_header_rewrites < off.reasoning_header_rewrites,
    'the counters must prove the repaint reduction'
  );
});

test('stream reveal keeps existing reasoning when patch model omits thinking markup', () => {
  const { timeline, controller } = createImmediateRevealController(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
            <div class="chat-message-content">
              ${reasoningStackMarkup('stable thought')}
            </div>
          </article>
        </div>
      </body>
    </html>
  `);

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });

  const reasoningToggleBefore = timeline.querySelector('[data-reasoning-toggle]');

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      innerHtml: '<div class="unexpected-fallback">fallback should not replace existing reasoning</div>',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });

  assert.equal(timeline.querySelector('.reasoning-row-panel-body')?.textContent.trim(), 'stable thought');
  assert.equal(timeline.querySelector('[data-reasoning-toggle]'), reasoningToggleBefore);
  assert.equal(timeline.querySelector('.unexpected-fallback'), null);
});

test('stream reveal patch updates reasoning and answer content in the same frame', () => {
  const { timeline, controller } = createImmediateRevealController(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
            <div class="chat-message-content">
              ${reasoningStackMarkup('old thought')}
              <div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" data-streaming-bubble="true">
                <div class="chat-stream-unit" data-stream-unit-index="0">old answer</div>
              </div>
            </div>
          </article>
        </div>
      </body>
    </html>
  `);

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: 'new answer' },
    streamingArticleMessageId: 'assistant_stream',
  });

  const reasoningToggleBefore = timeline.querySelector('[data-reasoning-toggle]');

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: 'new answer' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: 'new answer' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: '<div class="chat-stream-unit is-revealed is-streaming-tail" data-stream-unit-index="0">new answer</div>',
      streamUnits: [{ html: 'new answer', revealed: true, tail: true }],
      streamChangedStart: 0,
      thinkingMarkup: reasoningStackMarkup('new thought'),
      innerHtml: '',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });

  assert.equal(timeline.querySelector('.reasoning-row-panel-body')?.textContent.trim(), 'new thought');
  assert.equal(timeline.querySelector('[data-streaming-bubble="true"]')?.textContent.trim(), 'new answer');
  assert.equal(timeline.querySelector('[data-reasoning-toggle]'), reasoningToggleBefore);
});

test('stream reveal inserts reasoning before answer content when reasoning appears late', () => {
  const { timeline, controller } = createImmediateRevealController(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
            <div class="chat-message-content">
              <div class="turn-row-list" data-turn-row-list="true">
                <div class="chat-row" data-row-id="shell:assistant_stream" data-source-message-id="assistant_stream">
                  <div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" data-streaming-bubble="true">
                    <div class="chat-stream-unit" data-stream-unit-index="0">old answer</div>
                  </div>
                </div>
              </div>
            </div>
          </article>
        </div>
      </body>
    </html>
  `);

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: 'new answer' },
    streamingArticleMessageId: 'assistant_stream',
  });

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: 'new answer' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: 'new answer' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: '<div class="chat-stream-unit is-revealed is-streaming-tail" data-stream-unit-index="0">new answer</div>',
      streamUnits: [{ html: 'new answer', revealed: true, tail: true }],
      streamChangedStart: 0,
      thinkingMarkup: reasoningStackMarkup('late thought'),
      innerHtml: `
        <div class="chat-message-content">
          <div class="turn-row-list" data-turn-row-list="true">
            <div class="chat-row" data-row-id="shell:assistant_stream" data-source-message-id="assistant_stream">
              ${reasoningStackMarkup('late thought')}
              <div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" data-streaming-bubble="true">
                <div class="chat-stream-unit is-revealed is-streaming-tail" data-stream-unit-index="0">new answer</div>
              </div>
            </div>
          </div>
        </div>
      `,
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });

  const reasoningStack = timeline.querySelector('.reasoning-row-stack');
  const bubble = timeline.querySelector('[data-streaming-bubble="true"]');
  assert.ok(reasoningStack, 'reasoning row should be inserted before the existing answer bubble');
  assert.equal(timeline.querySelector('.reasoning-row-panel-body')?.textContent.trim(), 'late thought');
  assert.equal(bubble?.textContent.trim(), 'new answer');
  assert.equal(
    reasoningStack.compareDocumentPosition(bubble) & timeline.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    timeline.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING,
    'reasoning row should be before the answer bubble'
  );
});

test('stream reveal requests immediate fallback when reasoning-only markup needs a turn-root rebuild', () => {
  const { timeline, controller } = createImmediateRevealController(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
            <div class="chat-message-content">
              <div class="turn-row-list" data-turn-row-list="true">
                <div class="chat-row" data-row-id="shell:assistant_stream" data-source-message-id="assistant_stream"></div>
              </div>
            </div>
          </article>
        </div>
      </body>
    </html>
  `);

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });

  let fallbackCalls = 0;
  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      thinkingMarkup: reasoningStackMarkup('first thought'),
      innerHtml: `
        <div class="chat-message-content">
          <div class="turn-row-list" data-turn-row-list="true">
            <div class="chat-row" data-row-id="shell:assistant_stream" data-source-message-id="assistant_stream">
              ${reasoningStackMarkup('first thought')}
            </div>
          </div>
        </div>
      `,
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
    onFallback: () => {
      fallbackCalls += 1;
      timeline.querySelector('[data-message-id="assistant_stream"]').innerHTML = `
        <div class="chat-message-content">
          <div class="turn-row-list" data-turn-row-list="true">
            <div class="chat-row" data-row-id="shell:assistant_stream" data-source-message-id="assistant_stream">
              ${reasoningStackMarkup('first thought')}
            </div>
          </div>
        </div>
      `;
    },
  });

  assert.equal(fallbackCalls, 1, 'reasoning-only structural patches should call fallback immediately');
  assert.equal(timeline.querySelector('.reasoning-row-panel-body')?.textContent.trim(), 'first thought');
});

test('stream reveal resolves a targeted trace row before falling back to the article shell', () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_trace_root" data-streaming-message-id="assistant_trace_stream">
            <div class="chat-message-content">
              <div class="turn-row-list" data-turn-row-list="true">
                <div class="chat-row" data-row-id="turn_trace:tool_result:call_trace" data-row-kind="tool_result">row</div>
              </div>
            </div>
          </article>
        </div>
      </body>
    </html>
  `);
  trackRevealDom(dom);
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
    streamingMessage: { id: 'assistant_trace_stream', role: 'assistant', status: 'streaming', content: 'patched' },
    streamingArticleMessageId: 'assistant_trace_root',
    streamingRowTarget: { turnId: 'turn_trace', rowKind: 'tool_result', toolCallId: 'call_trace' },
    activeTurnRootMessageId: 'user_trace_root',
    activeTurnStructureHash: 100,
    activeTurnTailFingerprint: 'tail:trace',
  });

  const resolvedRow = controller.resolveStreamingPatchTarget({
    streamingMessageId: 'assistant_trace_stream',
    streamingArticleMessageId: 'assistant_trace_root',
    streamingRowTarget: { turnId: 'turn_trace', rowKind: 'tool_result', toolCallId: 'call_trace' },
  }, timeline);
  assert.equal(resolvedRow?.getAttribute('data-row-id'), 'turn_trace:tool_result:call_trace');

  const resolvedFallbackArticle = controller.resolveStreamingPatchTarget({
    streamingMessageId: 'assistant_trace_stream',
    streamingArticleMessageId: 'assistant_trace_root',
    streamingRowTarget: { turnId: 'turn_trace', rowKind: 'tool_result', toolCallId: 'missing_call' },
  }, timeline);
  assert.equal(resolvedFallbackArticle?.getAttribute('data-message-id'), 'assistant_trace_root');
});

test('stream reveal clears a stale trace row target before queueing an article-level patch', () => {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <div id="timeline">
          <article class="chat-entry assistant pending" data-message-id="assistant_trace_root" data-streaming-message-id="assistant_trace_stream">
            <div class="chat-message-content">
              <div class="turn-row-list" data-turn-row-list="true">
                <div class="chat-row" data-row-id="turn_trace:tool_result:call_trace" data-row-kind="tool_result">row</div>
                <div class="chat-row" data-row-kind="assistant_text" data-source-message-id="assistant_trace_stream">
                  <div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" data-streaming-bubble="true">old</div>
                </div>
              </div>
            </div>
          </article>
        </div>
      </body>
    </html>
  `);
  trackRevealDom(dom);
  const timeline = dom.window.document.getElementById('timeline');
  dom.window.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  dom.window.cancelAnimationFrame = () => {};

  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: () => ({
      html: '<span>patched</span>',
      units: [{ html: '<span>patched</span>', revealed: true, tail: true }],
      fingerprints: ['patched'],
      changedStartIndex: 0,
    }),
    escapeSelectorValue: (value) => String(value || ''),
  });

  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_trace_stream', role: 'assistant', status: 'streaming', content: 'old' },
    streamingArticleMessageId: 'assistant_trace_root',
    streamingRowTarget: { turnId: 'turn_trace', rowKind: 'tool_result', toolCallId: 'call_trace' },
    activeTurnRootMessageId: 'user_trace_root',
    activeTurnStructureHash: 100,
    activeTurnTailFingerprint: 'tail:trace',
  });

  controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_trace_stream',
    streamingMessage: { id: 'assistant_trace_stream', role: 'assistant', status: 'streaming', content: 'patched' },
    streamingRowTarget: null,
    messages: [{ id: 'assistant_trace_stream', role: 'assistant', status: 'streaming', content: 'patched' }],
    buildRowNodeMarkup: () => '<div class="chat-row" data-row-id="turn_trace:tool_result:call_trace" data-row-kind="tool_result">WRONG</div>',
    buildMessageNodeState: () => ({
      bubbleInnerHtml: '<span>patched</span>',
      innerHtml: '<div class="chat-bubble chat-bubble-markdown chat-bubble-streaming" data-streaming-bubble="true"><span>patched</span></div>',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });

  assert.match(
    String(timeline.querySelector('[data-streaming-bubble="true"]')?.innerHTML || ''),
    /patched/
  );
  assert.equal(
    timeline.querySelector('[data-row-id="turn_trace:tool_result:call_trace"]')?.textContent,
    'row',
    'article-level patch should not mutate the stale trace row target'
  );
});

test('stream reveal animates an open reasoning panel closed when its phase completes', () => {
  const phaseMarkup = (text, status, expanded) => `
    <div class="reasoning-row-stack" data-reasoning-row-version="2">
      <div class="reasoning-row-block${expanded ? ' expanded' : ''}" data-thinking-id="think_1" data-phase-key="think_1" data-reasoning-status="${status}">
        <button class="reasoning-row-header" type="button" data-reasoning-toggle="true" aria-expanded="${expanded}" data-message-id="assistant_stream" data-thinking-id="think_1" data-phase-key="think_1">
          <span class="reasoning-row-main">${text}</span>
        </button>
        <div class="reasoning-row-panel${expanded ? ' expanded' : ''}" data-thinking-id="think_1" data-phase-key="think_1"${expanded ? '' : ' hidden'}>
          <div class="reasoning-row-panel-body chat-bubble-markdown"><p>${text}</p></div>
        </div>
      </div>
    </div>
  `;
  const dom = trackRevealDom(new JSDOM(`
    <div id="timeline">
      <article class="chat-entry assistant pending" data-message-id="assistant_stream" data-streaming-message-id="assistant_stream">
        <div class="chat-message-content">${phaseMarkup('live thought', 'streaming', true)}</div>
      </article>
    </div>
  `));
  const timeline = dom.window.document.getElementById('timeline');
  const frames = [];
  dom.window.requestAnimationFrame = (callback) => frames.push(callback);
  dom.window.cancelAnimationFrame = () => {};
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
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_stream',
  });

  const panel = timeline.querySelector('.reasoning-row-panel');
  // Height follows the body: the live body is taller than the settled one.
  Object.defineProperty(panel, 'scrollHeight', {
    configurable: true,
    get: () => (panel.textContent.includes('settled') ? 120 : 300),
  });
  const settledPatch = (text) => controller.queuePatch({
    currentSessionId: 'session-1',
    structureSignature: 10,
    latestAssistantMessageId: 'assistant_stream',
    streamingMessage: { id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' },
    messages: [{ id: 'assistant_stream', role: 'assistant', status: 'streaming', content: '' }],
    buildMessageNodeState: () => ({
      bubbleInnerHtml: null,
      thinkingMarkup: phaseMarkup(text, 'complete', false),
      innerHtml: '',
      pending: true,
      entryReveal: false,
      status: 'streaming',
      finalizedAt: '',
    }),
  });
  settledPatch('settled thought');

  assert.equal(panel.hidden, false, 'the patch frame keeps the panel visible for collapse');
  assert.equal(panel.dataset.collapsing, 'true');
  assert.equal(panel.querySelector('.reasoning-row-panel-body')?.textContent.trim(), 'settled thought');
  assert.equal(panel.style.maxHeight, '120px', 'the collapse starts from the settled body height (measured after the swap)');

  // A second settled patch mid-collapse must not strip the animation state.
  settledPatch('settled thought again');
  assert.equal(panel.hidden, false, 'a concurrent patch leaves the collapsing panel visible');
  assert.equal(panel.dataset.collapsing, 'true');
  assert.equal(panel.querySelector('.reasoning-row-panel-body')?.textContent.trim(), 'settled thought again');

  frames.splice(0).forEach((callback) => callback());
  assert.ok(panel.classList.contains('expanded'), '.expanded is kept while the height animates');
  const transitionEnd = new dom.window.Event('transitionend', { bubbles: true });
  Object.defineProperty(transitionEnd, 'propertyName', { value: 'max-height' });
  panel.dispatchEvent(transitionEnd);
  assert.equal(panel.hidden, true);
  assert.equal(panel.hasAttribute('data-collapsing'), false);
});

test('a full render that settles an open reasoning panel replays the eased collapse', (t) => {
  const phaseMarkup = (text, status, expanded) => `
    <div class="reasoning-row-stack" data-reasoning-stack="true">
      <div class="reasoning-row-block" data-thinking-id="think_1" data-phase-key="think_1" data-status="${status}">
        <div class="reasoning-row-header" role="button" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="panel-think-1">Thinking</div>
        <div class="reasoning-row-panel${expanded ? ' expanded' : ''}" id="panel-think-1" data-thinking-id="think_1" data-phase-key="think_1"${expanded ? '' : ' hidden'}>
          <div class="reasoning-row-panel-body chat-bubble-markdown"><p>${text}</p></div>
        </div>
      </div>
    </div>
  `;
  const articleMarkup = (text, status, expanded, pending) => `
    <article class="chat-entry assistant${pending ? ' pending' : ''}" data-message-id="assistant_full" data-streaming-message-id="assistant_full">
      <div class="chat-message-content">${phaseMarkup(text, status, expanded)}</div>
    </article>`;
  const dom = trackRevealDom(new JSDOM(`<div id="timeline">${articleMarkup('live thought', 'streaming', true, true)}</div>`));
  const timeline = dom.window.document.getElementById('timeline');
  const frames = [];
  dom.window.requestAnimationFrame = (callback) => frames.push(callback);
  dom.window.cancelAnimationFrame = () => {};
  const controller = createStreamRevealController({
    windowRef: dom.window,
    chatTimeline: timeline,
    reducedMotionQuery: { matches: false },
    renderStreamingMarkdownUnits: () => ({ html: '', units: [], fingerprints: [], changedStartIndex: -1 }),
    escapeSelectorValue: (value) => String(value || ''),
  });
  // Mid-stream commit: the open panel is remembered.
  controller.commitFullRender({
    currentSessionId: 'session-1',
    structureSignature: 10,
    streamingMessage: { id: 'assistant_full', role: 'assistant', status: 'streaming', content: '' },
    streamingArticleMessageId: 'assistant_full',
  });

  // The turn settles through a whole-timeline render: new nodes, panel hidden.
  timeline.innerHTML = articleMarkup('settled thought', 'complete', false, false);
  controller.commitFullRender({ currentSessionId: 'session-1', structureSignature: 11, streamingMessage: null });

  const panel = timeline.querySelector('.reasoning-row-panel');
  assert.equal(panel.hidden, false, 'the settled panel is re-opened for the eased collapse in the same task');
  assert.equal(panel.dataset.collapsing, 'true');
  assert.ok(panel.classList.contains('expanded'));
  assert.equal(panel.querySelector('.reasoning-row-panel-body')?.textContent.trim(), 'settled thought');

  frames.splice(0).forEach((callback) => callback());
  assert.equal(panel.style.maxHeight, '0px');
  const transitionEnd = new dom.window.Event('transitionend', { bubbles: true });
  Object.defineProperty(transitionEnd, 'propertyName', { value: 'max-height' });
  panel.dispatchEvent(transitionEnd);
  assert.equal(panel.hidden, true);
  assert.equal(panel.hasAttribute('data-collapsing'), false);

  // A later unrelated full render must not replay the collapse again.
  timeline.innerHTML = articleMarkup('settled thought', 'complete', false, false);
  controller.commitFullRender({ currentSessionId: 'session-1', structureSignature: 12, streamingMessage: null });
  const again = timeline.querySelector('.reasoning-row-panel');
  assert.equal(again.hidden, true);
  assert.equal(again.hasAttribute('data-collapsing'), false);
});
