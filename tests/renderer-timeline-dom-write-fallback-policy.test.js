const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const streamDomPatchUtils = require('../renderer/chat/renderer-stream-dom-patch-utils');
const {
  createRenderPipelineMessageRenderer,
} = require('../renderer/chat/renderer-render-pipeline-message-renderer');
const {
  createPipelineHarness,
  createRenderDom,
  withWindowGlobals,
} = require('./helpers/render-pipeline-test-harness');

function timelineWrites(signalCalls) {
  return signalCalls.filter((call) => call.signal === 'timeline_dom_write');
}

test('children-scope helper returns the shared outcome shape and preserves compatibility', (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="root"><p data-message-id="m1">old</p></div></body>');
  const root = dom.window.document.getElementById('root');

  const applied = streamDomPatchUtils.setInnerHtmlPreservingCodeScroll(
    root,
    '<p data-message-id="m1">new</p><span>added</span>',
    { collectStats: true }
  );

  assert.equal(applied.outcome, 'morph_applied');
  for (const field of ['reused', 'cloned', 'removed']) {
    assert.ok(Number.isFinite(applied.stats[field]), `${field} should be finite`);
  }
  assert.deepEqual(
    streamDomPatchUtils.setInnerHtmlPreservingCodeScroll(null, '<p>ignored</p>'),
    { outcome: 'no_element', stats: undefined }
  );

  const fallbackTarget = {
    ownerDocument: { createElement: () => null },
    innerHTML: '',
    querySelectorAll: () => [],
  };
  const fallback = streamDomPatchUtils.setInnerHtmlPreservingCodeScroll(
    fallbackTarget,
    '<p>fallback</p>',
    { collectStats: true }
  );
  assert.notEqual(fallback.outcome, 'morph_applied');
  assert.equal(fallbackTarget.innerHTML, '<p>fallback</p>');

  const compatibilityTarget = {
    ownerDocument: { createElement: () => null },
    innerHTML: '',
    querySelectorAll: () => [],
  };
  streamDomPatchUtils.setInnerHtmlPreservingCodeScroll(
    compatibilityTarget,
    '<p>no options</p>'
  );
  assert.equal(compatibilityTarget.innerHTML, '<p>no options</p>');
});

test('full_render preserves code scroll when the children morph cannot take', (t) => {
  const dom = createRenderDom();
  const documentRef = dom.window.document;
  const timeline = documentRef.getElementById('timeline');
  timeline.innerHTML = '<article data-message-id="old"><pre>old</pre></article>';
  const oldPre = timeline.querySelector('pre');
  oldPre.scrollLeft = 31;
  oldPre.scrollTop = 47;
  const harness = createPipelineHarness({
    dom,
    visibleMessages: [{
      id: 'assistant-1',
      role: 'assistant',
      status: 'complete',
      content: '<pre data-fallback-result="true">new</pre>',
    }],
  });
  harness.state.features = { featureFlags: { chat_timeline_render_telemetry: true } };
  t.after(() => harness.pipeline.dispose?.());

  const originalCreateElement = documentRef.createElement;
  documentRef.createElement = function createElementWithFailedTemplate(tagName, options) {
    if (String(tagName).toLowerCase() === 'template') return null;
    return originalCreateElement.call(this, tagName, options);
  };
  try {
    withWindowGlobals(dom, () => harness.pipeline.renderMessages({ forceFullRender: true }));
  } finally {
    documentRef.createElement = originalCreateElement;
  }

  const replacementPre = timeline.querySelector('pre[data-fallback-result="true"]');
  assert.ok(replacementPre, 'fallback html should land in the timeline');
  assert.equal(replacementPre.scrollLeft, 31);
  assert.equal(replacementPre.scrollTop, 47);
  const writes = timelineWrites(harness.rolloutSignals).filter(
    (call) => call.details?.lane === 'full_render'
  );
  assert.equal(writes.length, 1);
});

test('legacy_article_innerhtml keeps its label and uses the preserving helper', (t) => {
  const dom = new JSDOM(`<!doctype html><html><body>
    <div id="scroll"><div id="timeline">
      <article class="chat-entry assistant" data-message-id="assistant_stream">
        <pre>old</pre>
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
    <pre>first</pre>
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
        innerHtml: '<pre data-legacy-result="true">fallback</pre>',
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

  withWindowGlobals(dom, () => renderer.renderMessages());
  const firstPre = documentRef.querySelector('[data-message-id="assistant_stream"] pre');
  firstPre.scrollLeft = 19;
  firstPre.scrollTop = 23;

  const originalSetInner = streamDomPatchUtils.setInnerHtmlPreservingCodeScroll;
  let preservingHelperCalls = 0;
  streamDomPatchUtils.setInnerHtmlPreservingCodeScroll = function preservingHelperSpy(...args) {
    preservingHelperCalls += 1;
    return originalSetInner(...args);
  };
  t.after(() => {
    streamDomPatchUtils.setInnerHtmlPreservingCodeScroll = originalSetInner;
  });
  articleMarkup = '<div>not an article</div>';
  withWindowGlobals(dom, () => renderer.renderMessages());

  const legacyPre = documentRef.querySelector('pre[data-legacy-result="true"]');
  assert.equal(preservingHelperCalls, 1);
  assert.ok(legacyPre, 'legacy fallback html should land in the article');
  assert.equal(legacyPre.scrollLeft, 19);
  assert.equal(legacyPre.scrollTop, 23);
  assert.equal(timelineWrites(signalCalls).at(-1)?.details?.outcome, 'legacy_article_innerhtml');
});
