const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  createStreamPatchTargetUtils,
} = require('../renderer/chat/renderer-stream-patch-target-utils');

function createUtils(runtime, timeline) {
  return createStreamPatchTargetUtils({
    getRuntime: () => runtime,
    getChatTimeline: () => timeline,
    escapeSelectorValue: (value) => String(value || ''),
    resolveVisibleMessageDomTarget(container, messageId) {
      return container.querySelector(`[data-message-id="${messageId}"]`);
    },
  });
}

test('stream patch target utils resolve row targets before article targets', () => {
  const dom = new JSDOM(`
    <main id="timeline">
      <article data-message-id="assistant_1" data-streaming-message-id="assistant_1">
        <div class="chat-row" data-row-id="turn_1:tool_result:call_1"></div>
      </article>
    </main>
  `);
  const timeline = dom.window.document.getElementById('timeline');
  const runtime = {
    streamingMessageId: 'assistant_1',
    streamingArticleMessageId: 'assistant_1',
    streamingRowTarget: { turnId: 'turn_1', rowKind: 'tool_result', toolCallId: 'call_1' },
  };
  const utils = createUtils(runtime, timeline);

  const target = utils.resolveStreamingPatchTarget();

  assert.equal(target?.getAttribute('data-row-id'), 'turn_1:tool_result:call_1');
  assert.equal(utils.resolvePatchTargetArticle(target)?.getAttribute('data-message-id'), 'assistant_1');
});

test('stream patch target utils normalize row targets and clear streaming article markers', () => {
  const dom = new JSDOM(`
    <main id="timeline">
      <article data-message-id="assistant_2" data-streaming-message-id="assistant_2"></article>
    </main>
  `);
  const timeline = dom.window.document.getElementById('timeline');
  const runtime = {
    streamingMessageId: 'assistant_2',
    streamingArticleMessageId: 'assistant_2',
    streamingRowTarget: null,
  };
  const utils = createUtils(runtime, timeline);
  const article = timeline.querySelector('[data-message-id="assistant_2"]');

  assert.deepEqual(utils.normalizeStreamingRowTarget({ turnId: ' turn ', rowKind: ' reasoning ', toolCallId: ' call ' }), {
    turnId: 'turn',
    rowKind: 'reasoning',
    toolCallId: 'call',
  });
  assert.equal(utils.resolveStreamingPatchTarget(), article);
  utils.clearStreamingArticleMarker();
  assert.equal(article.hasAttribute('data-streaming-message-id'), false);
});

// ── Singleton-marker invariant (post-approval flicker RCA 2026-08-19) ──
// A tool/approval cycle moves the streaming target to a new segment. When the
// marker was left behind on the previous segment's article, the first-match
// resolver kept returning that article, the patch found no live bubble in it,
// and the renderer full-rendered the whole transcript on every delta for the
// rest of the turn. These pin the invariant directly, rather than only through
// the render-ratio replay in tests/renderer-chat-approval-render-mode.test.js.

function createSegmentedTimeline() {
  const dom = new JSDOM(`
    <main id="timeline">
      <article class="chat-entry" data-message-id="assistant_1" data-streaming-message-id="assistant_1_seg1">
        <div class="chat-row" data-row-kind="tool_call"></div>
      </article>
      <article class="chat-entry" data-message-id="assistant_1_seg1">
        <div data-streaming-bubble="true">live text</div>
      </article>
    </main>
  `);
  return dom.window.document.getElementById('timeline');
}

function markerIds(timeline) {
  return [...timeline.querySelectorAll('[data-streaming-message-id]')]
    .map((node) => node.getAttribute('data-message-id'));
}

test('anchorStreamingArticleMarker leaves exactly one marker, on the article holding the live bubble', () => {
  const timeline = createSegmentedTimeline();
  const runtime = {
    streamingMessageId: 'assistant_1_seg1',
    streamingArticleMessageId: 'assistant_1_seg1',
    streamingRowTarget: null,
  };
  const utils = createUtils(runtime, timeline);

  const anchored = utils.anchorStreamingArticleMarker(runtime, timeline);

  assert.equal(anchored?.getAttribute('data-message-id'), 'assistant_1_seg1');
  assert.deepEqual(markerIds(timeline), ['assistant_1_seg1'],
    'the stale marker on the previous segment article must not survive the anchor');
  assert.ok(anchored.querySelector('[data-streaming-bubble="true"]'),
    'the anchored article must be the one holding the live streaming bubble');
});

test('stampStreamingArticleMarker sweeps as it stamps, so a per-delta stamp cannot duplicate the marker', () => {
  const timeline = createSegmentedTimeline();
  const runtime = { streamingMessageId: 'assistant_1_seg1', streamingArticleMessageId: 'assistant_1_seg1' };
  const utils = createUtils(runtime, timeline);
  const live = timeline.querySelector('[data-message-id="assistant_1_seg1"]');

  utils.stampStreamingArticleMarker(live, 'assistant_1_seg1', timeline);
  utils.stampStreamingArticleMarker(live, 'assistant_1_seg1', timeline);

  assert.deepEqual(markerIds(timeline), ['assistant_1_seg1']);
});

test('stampStreamingArticleMarker with an empty id clears every marker', () => {
  const timeline = createSegmentedTimeline();
  const utils = createUtils({}, timeline);
  const live = timeline.querySelector('[data-message-id="assistant_1_seg1"]');

  utils.stampStreamingArticleMarker(live, '', timeline);

  assert.deepEqual(markerIds(timeline), []);
});

test('resolveStreamingArticlePatchTarget self-heals a drifted DOM by preferring the article with the live bubble', () => {
  // Article markup bakes the attribute in, so a rebuild can reintroduce a
  // duplicate between stamps; the resolver must not trust document order.
  const timeline = createSegmentedTimeline();
  timeline.querySelector('[data-message-id="assistant_1_seg1"]')
    .setAttribute('data-streaming-message-id', 'assistant_1_seg1');
  const runtime = { streamingMessageId: 'assistant_1_seg1', streamingArticleMessageId: 'assistant_1_seg1' };
  const utils = createUtils(runtime, timeline);

  const target = utils.resolveStreamingArticlePatchTarget(runtime, timeline);

  assert.equal(target?.getAttribute('data-message-id'), 'assistant_1_seg1');
});
