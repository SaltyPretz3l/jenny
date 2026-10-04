const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  buildLiveReasoningRowStackMarkup,
  createStreamPatchTargetUtils,
  resolveLiveReasoningScope,
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

test('live reasoning scope prefers the primary id, then the source-id list, then the last stack', () => {
  const dom = new JSDOM(`<div id="list" data-turn-row-list="true">
    <div class="chat-row" id="first" data-row-kind="reasoning" data-source-message-id="seg0" data-source-message-ids="seg0 seg2">
      <div class="reasoning-row-stack"></div>
    </div>
    <div class="chat-row" data-row-kind="tool_call" data-source-message-id="seg2" data-source-message-ids="seg2"></div>
    <div class="chat-row" id="second" data-row-kind="reasoning" data-source-message-id="seg1" data-source-message-ids="seg1">
      <div class="reasoning-row-stack"></div>
    </div>
  </div>`);
  const list = dom.window.document.getElementById('list');
  const byId = (id) => dom.window.document.getElementById(id);

  assert.equal(resolveLiveReasoningScope(list, 'seg1'), byId('second'), 'primary id match');
  assert.equal(
    resolveLiveReasoningScope(list, 'seg2'),
    byId('first'),
    'a reused row names the live segment only in its id list; the tool row is not a reasoning scope'
  );
  assert.equal(resolveLiveReasoningScope(list, 'seg9'), byId('second'), 'no match falls back to the last stack');
  assert.equal(resolveLiveReasoningScope(list, 'seg-2'), byId('second'), 'the list match is whole-token, not substring');
  const empty = dom.window.document.createElement('div');
  assert.equal(resolveLiveReasoningScope(empty, 'seg0'), empty, 'no reasoning at all scopes to the list itself');
});

// HB-010: the incoming stack for a row-model reasoning patch comes from the live
// segment's own row render, never from the message-level widget (which renders
// every phase of the stream), and only for a row that names the live segment.
function reasoningRow(id, source, { status = 'streaming', fp = '', ids = source, body = id } = {}) {
  return `<div class="chat-row" data-row-id="${id}" data-row-kind="reasoning" data-source-message-id="${source}" data-source-message-ids="${ids}">`
    + `<div class="reasoning-row-stack" data-row="${id}"><div class="reasoning-row-block" data-phase-key="${id}" data-reasoning-status="${status}"${fp ? ` data-reasoning-fp="${fp}"` : ''}>${body}</div></div></div>`;
}

function liveRowFixture() {
  const dom = new JSDOM(`<div id="list" data-turn-row-list="true">
    ${reasoningRow('r0', 'seg0', { ids: 'seg0 seg2', status: 'complete', fp: 'f0' })}
    ${reasoningRow('r1', 'seg1', { status: 'complete', fp: 'f1' })}
    ${reasoningRow('r1b', 'seg1')}
    <div class="chat-row" data-row-id="tool" data-row-kind="tool_call" data-source-message-id="seg1"></div>
  </div>`);
  const doc = dom.window.document;
  const calls = { count: 0 };
  const build = (scopeId, messageId, freshRows) => buildLiveReasoningRowStackMarkup({
    scope: doc.querySelector(`[data-row-id="${scopeId}"]`),
    rowModelList: doc.getElementById('list'),
    messageId,
    buildLiveReasoningRowsMarkup: freshRows === undefined ? undefined : () => { calls.count += 1; return freshRows; },
    doc,
  });
  return { build, calls };
}

test('live reasoning row stack markup takes the live row\u2019s own render', () => {
  const { build, calls } = liveRowFixture();
  const fresh = reasoningRow('r1', 'seg1', { status: 'complete', fp: 'f1' }) + reasoningRow('r1b', 'seg1', { body: 'r1b and more' });

  assert.match(build('r1b', 'seg1', fresh), /^<div class="reasoning-row-stack" data-row="r1b">.*r1b and more/, 'the live row\u2019s own stack');
  assert.match(build('r0', 'seg2', reasoningRow('r0', 'seg0', { ids: 'seg0 seg2' })), /data-row="r0"/,
    'a reused row named only in its id list still qualifies');
  assert.equal(calls.count, 2);
});

test('live reasoning row stack markup never rewrites another segment\u2019s row', () => {
  const { build, calls } = liveRowFixture();
  assert.equal(build('r1b', 'seg9', reasoningRow('r1b', 'seg1')), null, 'the last-stack fallback row belongs to another segment');
  assert.equal(build('tool', 'seg1', reasoningRow('r1b', 'seg1')), null, 'only reasoning rows');
  assert.equal(calls.count, 0, 'a scope that does not qualify renders nothing');
  assert.equal(build('r1b', 'seg1', undefined), null, 'no builder wired');
  assert.equal(build('r1b', 'seg1', ''), null, 'the live segment has no projected reasoning rows');
  assert.equal(build('r1b', 'seg1', reasoningRow('r1', 'seg1', { status: 'complete', fp: 'f1' })), null,
    'the scope row is not among the segment\u2019s projected rows');
});

test('live reasoning row stack markup defers to the row-list morph for a structural change in the segment', () => {
  const { build } = liveRowFixture();
  const settled = reasoningRow('r1', 'seg1', { status: 'complete', fp: 'f1' });
  assert.equal(build('r1b', 'seg1', settled + reasoningRow('r1b', 'seg1') + reasoningRow('r1c', 'seg1')), null,
    'a phase the row list has not rendered yet (checkpoint continuation) needs the morph');
  assert.equal(build('r1b', 'seg1', reasoningRow('r1', 'seg1', { status: 'complete', fp: 'changed' }) + reasoningRow('r1b', 'seg1')), null,
    'a sibling phase whose settled state changed needs the morph');
  assert.ok(build('r1b', 'seg1', settled + reasoningRow('r1b', 'seg1')), 'unchanged siblings do not block the row patch');
});

test('live reasoning row stack markup names why it declined (timeline-perf diagnostics)', () => {
  const { build: _build } = liveRowFixture();
  const dom = new JSDOM(`<div id="list" data-turn-row-list="true">
    ${reasoningRow('r1', 'seg1', { status: 'complete', fp: 'f1' })}
    ${reasoningRow('r1b', 'seg1')}
    <div class="chat-row" data-row-id="tool" data-row-kind="tool_call" data-source-message-id="seg1"></div>
  </div>`);
  const doc = dom.window.document;
  const reasonFor = (scopeId, messageId, freshRows) => {
    const diagnostics = { reason: '' };
    const markup = buildLiveReasoningRowStackMarkup({
      scope: doc.querySelector(`[data-row-id="${scopeId}"]`), rowModelList: doc.getElementById('list'), messageId,
      buildLiveReasoningRowsMarkup: freshRows === undefined ? undefined : () => freshRows, doc, diagnostics,
    });
    return markup == null ? diagnostics.reason : 'ok';
  };
  const settled = reasoningRow('r1', 'seg1', { status: 'complete', fp: 'f1' });
  assert.equal(reasonFor('r1b', 'seg1', settled + reasoningRow('r1b', 'seg1')), 'ok');
  assert.equal(reasonFor('r1b', 'seg1'), 'helper_unavailable');
  assert.equal(reasonFor('tool', 'seg1', settled), 'scope_not_reasoning_row');
  assert.equal(reasonFor('r1b', 'seg9', settled), 'scope_names_other_segment');
  assert.equal(reasonFor('r1b', 'seg1', settled + reasoningRow('r1b', 'seg1') + reasoningRow('r1c', 'seg1')), 'segment_row_not_rendered');
  assert.equal(reasonFor('r1b', 'seg1', reasoningRow('r1', 'seg1', { status: 'complete', fp: 'changed' }) + reasoningRow('r1b', 'seg1')),
    'segment_row_state_mismatch');
  assert.equal(reasonFor('r1b', 'seg1', settled + '<div class="chat-row" data-row-id="r1b" data-row-kind="reasoning" data-source-message-id="seg1"></div>'),
    'scope_stack_missing');
});

test('reasoning patch block resolution names why it declined', () => {
  const { resolveReasoningPatchBlocks } = require('../renderer/chat/renderer-stream-patch-target-utils');
  const dom = new JSDOM(`<div id="list" data-turn-row-list="true">
    ${reasoningRow('r0', 'seg0', { status: 'complete', fp: 'f0' })}
    ${reasoningRow('r1', 'seg1')}
  </div>`);
  const doc = dom.window.document;
  const list = doc.getElementById('list');
  const scope = doc.querySelector('[data-row-id="r1"]');
  const key = (block, index) => block.getAttribute('data-phase-key') || `index:${index}`;
  const stackOf = (html) => { const t = doc.createElement('template'); t.innerHTML = html; return t.content.firstElementChild; };
  const block = (id, status = 'streaming', fp = '') =>
    `<div class="reasoning-row-block" data-phase-key="${id}" data-reasoning-status="${status}"${fp ? ` data-reasoning-fp="${fp}"` : ''}></div>`;
  const resolve = (nextHtml) => {
    const diagnostics = { reason: '' };
    const existing = Array.from(scope.querySelectorAll('.reasoning-row-block'));
    const out = resolveReasoningPatchBlocks(existing, stackOf(`<div class="reasoning-row-stack">${nextHtml}</div>`), scope, list, key, diagnostics);
    return out ? 'ok' : diagnostics.reason;
  };
  assert.equal(resolve(block('r0', 'complete', 'f0') + block('r1')), 'ok');
  assert.equal(resolve(block('r1') + block('r1')), 'duplicate_block_key');
  assert.equal(resolve(block('r0', 'complete', 'f0') + block('rX')), 'block_unaligned');
  assert.equal(resolve(block('r7', 'complete', 'f0') + block('r1')), 'sibling_missing');
  assert.equal(resolve(block('r0', 'streaming', 'f0') + block('r1')), 'sibling_status_mismatch');
  assert.equal(resolve(block('r0', 'complete', 'f9') + block('r1')), 'sibling_fp_mismatch');
  // Duplicate keys among the OTHER rendered rows reject before any alignment.
  list.insertAdjacentHTML('beforeend', reasoningRow('r0', 'seg2', { status: 'complete', fp: 'f0' }));
  assert.equal(resolve(block('r0', 'complete', 'f0') + block('r1')), 'sibling_duplicate_key');
});
