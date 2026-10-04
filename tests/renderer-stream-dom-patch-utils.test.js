const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const {
  canMorphNode,
  captureCodeBlockScroll,
  restoreCodeBlockScroll,
  setChildrenHtmlPreservingKeyedNodes,
  setInnerHtmlPreservingCodeScroll,
} = require('../renderer/chat/renderer-stream-dom-patch-utils');

function fakePre(scrollLeft = 0, scrollTop = 0) {
  return { tagName: 'PRE', scrollLeft, scrollTop };
}

function fakeRoot(pres) {
  return { querySelectorAll: () => pres };
}

test('stream DOM patch utils preserve code-block scroll by ordinal', () => {
  const saved = captureCodeBlockScroll(fakeRoot([
    fakePre(0, 0),
    fakePre(120, 0),
    fakePre(0, 40),
  ]));
  const fresh = [fakePre(), fakePre(), fakePre()];

  restoreCodeBlockScroll(fakeRoot(fresh), saved);

  assert.deepEqual(saved, [
    { index: 1, left: 120, top: 0 },
    { index: 2, left: 0, top: 40 },
  ]);
  assert.equal(fresh[1].scrollLeft, 120);
  assert.equal(fresh[2].scrollTop, 40);
});

test('stream DOM patch utils preserve keyed nodes while updating unkeyed content', () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"><p data-message-id="m1">old</p><span>drop</span></div></body>');
  const root = dom.window.document.getElementById('root');
  const keyed = root.querySelector('[data-message-id="m1"]');

  const patched = setChildrenHtmlPreservingKeyedNodes(root, '<p data-message-id="m1">new</p><em>added</em>');

  assert.equal(patched, true);
  assert.strictEqual(root.querySelector('[data-message-id="m1"]'), keyed);
  assert.equal(keyed.textContent, 'new');
  assert.equal(root.querySelector('em').textContent, 'added');
  assert.equal(root.querySelector('span'), null);
});

test('time dividers with different target message ids are non-morphable', () => {
  const dom = new JSDOM('<div data-before-message-id="before-a"></div><div data-before-message-id="before-b"></div>');
  const [first, second] = dom.window.document.body.children;

  assert.equal(canMorphNode(first, second), false);
  dom.window.close();
});

test('keyed row-list morphs preserve an inserted divider node across later growth', () => {
  const dom = new JSDOM('<div id="root"><div data-row-id="A">A</div><div data-row-id="B">B</div></div>');
  const root = dom.window.document.getElementById('root');
  const firstGrowth = '<div data-row-id="A">A</div><div data-before-message-id="gap">gap</div>'
    + '<div data-row-id="B">B</div><div data-row-id="C">C</div>';
  const secondGrowth = firstGrowth + '<div data-row-id="D">D</div>';

  assert.equal(setChildrenHtmlPreservingKeyedNodes(root, firstGrowth), true);
  const divider = root.querySelector('[data-before-message-id="gap"]');
  divider.identityMarker = 'preserved';
  assert.equal(setChildrenHtmlPreservingKeyedNodes(root, secondGrowth), true);

  assert.strictEqual(root.children[1], divider);
  assert.equal(root.children[1].identityMarker, 'preserved');
  assert.deepEqual([...root.children].map((node) => node.textContent), ['A', 'gap', 'B', 'C', 'D']);
  dom.window.close();
});

test('a divider is replaced when its target message id changes', () => {
  const dom = new JSDOM('<div id="root"><div data-before-message-id="old-target">gap</div></div>');
  const root = dom.window.document.getElementById('root');
  const previousDivider = root.firstElementChild;
  previousDivider.identityMarker = 'old';

  assert.equal(setChildrenHtmlPreservingKeyedNodes(
    root,
    '<div data-before-message-id="new-target">gap</div>'
  ), true);

  assert.notStrictEqual(root.firstElementChild, previousDivider);
  assert.equal(root.firstElementChild.getAttribute('data-before-message-id'), 'new-target');
  assert.equal(root.firstElementChild.identityMarker, undefined);
  dom.window.close();
});

test('inner HTML swaps preserve wrapped code-block state on morph and fallback paths', () => {
  const markup = (wrapped) => '<div class="markdown-code-block' + (wrapped ? ' is-wrapped' : '')
    + '"><div class="markdown-code-header"><button class="inv-codeblock-wrap-toggle" aria-pressed="'
    + (wrapped ? 'true' : 'false') + '">Wrap</button></div><pre><code>long line</code></pre></div>';
  for (const forceFallback of [false, true]) {
    const dom = new JSDOM('<div id="root">' + markup(true) + '</div>');
    const root = dom.window.document.getElementById('root');
    if (forceFallback) {
      root.ownerDocument.createElement = () => null;
    }

    setInnerHtmlPreservingCodeScroll(root, markup(false));

    const block = root.querySelector('.markdown-code-block');
    assert.equal(block.classList.contains('is-wrapped'), true);
    assert.equal(block.querySelector('.inv-codeblock-wrap-toggle').getAttribute('aria-pressed'), 'true');
    dom.window.close();
  }
});

test('inner HTML swaps preserve expanded code-block state', (t) => {
  const collapsedMarkup = '<article><div class="markdown-code-block inv-codeblock-wrap collapsible collapsed">'
    + '<pre id="md-codeblock-1-pre"><code>streaming code</code></pre>'
    + '<button class="markdown-code-expand-overlay" aria-controls="md-codeblock-1-pre"'
    + ' aria-expanded="false" aria-label="Show more code"><span>Show more</span></button></div></article>';
  const dom = new JSDOM('<div id="root">' + collapsedMarkup + '</div>');
  t.after(() => dom.window.close());
  const root = dom.window.document.getElementById('root');
  const block = root.querySelector('.markdown-code-block');
  const overlay = block.querySelector('.markdown-code-expand-overlay');
  block.classList.remove('collapsed');
  overlay.setAttribute('aria-expanded', 'true');
  overlay.setAttribute('aria-label', 'Show less code');
  overlay.querySelector('span').textContent = 'Show less';
  root.ownerDocument.createElement = () => null;

  setInnerHtmlPreservingCodeScroll(root, collapsedMarkup);

  const patchedBlock = root.querySelector('.markdown-code-block');
  const patchedOverlay = patchedBlock.querySelector('.markdown-code-expand-overlay');
  assert.equal(patchedBlock.classList.contains('collapsed'), false);
  assert.equal(patchedOverlay.getAttribute('aria-expanded'), 'true');
  assert.equal(patchedOverlay.getAttribute('aria-label'), 'Show less code');
  assert.equal(patchedOverlay.querySelector('span').textContent, 'Show less');
});

// The morph path is the one streaming actually takes: a growing block fails
// canMorphNode (its preservation key derives from the code text) and is cloned
// fresh every frame, so the expand must survive a real patch, not just the
// parse-failed fallback write the tests above force.
test('morph patches preserve expanded code-block state while the block grows', (t) => {
  const blockMarkup = (code) => '<article><div class="markdown-code-block inv-codeblock-wrap collapsible collapsed">'
    + '<pre id="md-codeblock-1-pre"><code>' + code + '</code></pre>'
    + '<button class="markdown-code-expand-overlay" aria-controls="md-codeblock-1-pre"'
    + ' aria-expanded="false" aria-label="Show more code"><span>Show more</span></button></div></article>';
  const dom = new JSDOM('<div id="root">' + blockMarkup('line 1') + '</div>');
  t.after(() => dom.window.close());
  const root = dom.window.document.getElementById('root');
  const block = root.querySelector('.markdown-code-block');
  const overlay = block.querySelector('.markdown-code-expand-overlay');
  block.classList.remove('collapsed');
  overlay.setAttribute('aria-expanded', 'true');
  overlay.setAttribute('aria-label', 'Show less code');
  overlay.querySelector('span').textContent = 'Show less';

  setInnerHtmlPreservingCodeScroll(root, blockMarkup('line 1\nline 2'));

  const patchedBlock = root.querySelector('.markdown-code-block');
  const patchedOverlay = patchedBlock.querySelector('.markdown-code-expand-overlay');
  assert.equal(patchedBlock.querySelector('code').textContent, 'line 1\nline 2', 'the patch applied');
  assert.equal(patchedBlock.classList.contains('collapsed'), false);
  assert.equal(patchedOverlay.getAttribute('aria-expanded'), 'true');
  assert.equal(patchedOverlay.getAttribute('aria-label'), 'Show less code');
  assert.equal(patchedOverlay.querySelector('span').textContent, 'Show less');
});

test('inner HTML swaps keep code blocks collapsed when the user never expanded them', (t) => {
  const markup = '<article><div class="markdown-code-block inv-codeblock-wrap collapsible collapsed">'
    + '<pre><code>streaming code</code></pre>'
    + '<button class="markdown-code-expand-overlay" aria-expanded="false"'
    + ' aria-label="Show more code"><span>Show more</span></button></div></article>';
  const dom = new JSDOM('<div id="root">' + markup + '</div>');
  t.after(() => dom.window.close());
  const root = dom.window.document.getElementById('root');

  setInnerHtmlPreservingCodeScroll(root, markup);

  const block = root.querySelector('.markdown-code-block');
  assert.equal(block.classList.contains('collapsed'), true);
  assert.equal(block.querySelector('.markdown-code-expand-overlay').getAttribute('aria-expanded'), 'false');
});

test('inner HTML swaps do not restore expanded state onto a non-collapsible block', (t) => {
  const expandedMarkup = '<article><div class="markdown-code-block inv-codeblock-wrap collapsible">'
    + '<pre><code>streaming code</code></pre>'
    + '<button class="markdown-code-expand-overlay" aria-expanded="true"'
    + ' aria-label="Show less code"><span>Show less</span></button></div></article>';
  const nonCollapsibleMarkup = '<article><div class="markdown-code-block inv-codeblock-wrap collapsed">'
    + '<pre><code>streaming code</code></pre>'
    + '<button class="markdown-code-expand-overlay" aria-expanded="false"'
    + ' aria-label="Show more code"><span>Show more</span></button></div></article>';
  const dom = new JSDOM('<div id="root">' + expandedMarkup + '</div>');
  t.after(() => dom.window.close());
  const root = dom.window.document.getElementById('root');
  root.ownerDocument.createElement = () => null;

  setInnerHtmlPreservingCodeScroll(root, nonCollapsibleMarkup);

  const block = root.querySelector('.markdown-code-block');
  const overlay = block.querySelector('.markdown-code-expand-overlay');
  assert.equal(block.classList.contains('collapsible'), false);
  assert.equal(block.classList.contains('collapsed'), true);
  assert.equal(overlay.getAttribute('aria-expanded'), 'false');
  assert.equal(overlay.querySelector('span').textContent, 'Show more');
});

// Ht-C ACCEPTANCE C2 pin: the handoff's reconcile prefix-skip is satisfied on
// live main by the data-su-fp fingerprint fast-path — unchanged prefix units
// must never be re-touched (no innerHTML write, child identity preserved).
test('reconcileStreamUnits skips fingerprint-unchanged prefix units entirely', () => {
  const { reconcileStreamUnits } = require('../renderer/chat/renderer-stream-dom-patch-utils');
  const unit = (index, fp, html) =>
    `<div class="reasoning-stream-unit" data-stream-unit-index="${index}" data-su-fp="${fp}">${html}</div>`;
  const dom = new JSDOM(`<!doctype html><body>
    <div id="container">${unit(0, 'fp-a', '<p>alpha</p>')}${unit(1, 'fp-b', '<p>beta</p>')}${unit(2, 'fp-c', '<p>gam</p>')}</div>
    <div id="next">${unit(0, 'fp-a', '<p>alpha</p>')}${unit(1, 'fp-b', '<p>beta</p>')}${unit(2, 'fp-c2', '<p>gamma</p>')}${unit(3, 'fp-d', '<p>delta</p>')}</div>
  </body>`);
  const doc = dom.window.document;
  const container = doc.getElementById('container');
  const next = doc.getElementById('next');
  const prefixChildrenBefore = [
    container.children[0].firstChild,
    container.children[1].firstChild,
  ];

  reconcileStreamUnits(container, next, doc, { unitClassName: 'reasoning-stream-unit', revealCap: 2 });

  assert.equal(container.children.length, 4);
  assert.strictEqual(container.children[0].firstChild, prefixChildrenBefore[0],
    'unchanged prefix unit 0 must not be re-rendered');
  assert.strictEqual(container.children[1].firstChild, prefixChildrenBefore[1],
    'unchanged prefix unit 1 must not be re-rendered');
  assert.equal(container.children[2].textContent, 'gamma');
  assert.equal(container.children[2].getAttribute('data-su-fp'), 'fp-c2');
  assert.equal(container.children[3].textContent, 'delta');
});

test('reconcileStreamUnits does not serialize an unchanged fingerprinted unit', () => {
  const { reconcileStreamUnits } = require('../renderer/chat/renderer-stream-dom-patch-utils');
  const dom = new JSDOM(`<!doctype html><body>
    <div id="container"><div data-stream-unit-index="0" data-su-fp="same"><p>alpha</p></div></div>
    <div id="next"><div data-stream-unit-index="0" data-su-fp="same"><p>alpha</p></div></div>
  </body>`);
  const doc = dom.window.document;
  const container = doc.getElementById('container');
  const next = doc.getElementById('next');
  Object.defineProperty(next.firstElementChild, 'innerHTML', {
    get() {
      throw new Error('unchanged unit was serialized');
    },
  });

  reconcileStreamUnits(container, next, doc);

  assert.equal(container.firstElementChild.textContent, 'alpha');
  dom.window.close();
});

// timeline-perf 2026-09-30: per-row reconcile of a turn row list. The keyed
// fallback used to re-parse and morph every node of every row per delta.
const {
  reconcileKeyedRowList, morphChildren: morphChildrenForStamp, invalidateRowStamp, setOuterHtmlPreservingCodeScroll,
} = require('../renderer/chat/renderer-stream-dom-patch-utils');

function rowSegment(id, body, extra = '') {
  return { kind: 'row', id, markup: `<div class="chat-row" data-row-id="${id}" data-row-kind="tool_call"${extra}><span class="chat-row-node-dot"></span><div class="tool-card">${body}</div></div>` };
}

function reconcileFixture(segments) {
  const dom = new JSDOM('<!doctype html><body><div id="list" data-turn-row-list="true"></div></body>');
  const list = dom.window.document.getElementById('list');
  const outcomes = [];
  const apply = (next) => {
    const ok = reconcileKeyedRowList(list, next, { onOutcome: (record) => outcomes.push(record) });
    return { ok, stats: outcomes[outcomes.length - 1]?.stats, outcome: outcomes[outcomes.length - 1]?.outcome };
  };
  const first = apply(segments);
  return { dom, list, apply, first, outcomes };
}

test('reconcileKeyedRowList keeps unchanged rows untouched and morphs only the rows whose markup changed', () => {
  const segments = [rowSegment('a', 'A'), rowSegment('b', 'B'), rowSegment('c', 'C')];
  const { dom, list, apply, first } = reconcileFixture(segments);
  assert.equal(first.ok, true);
  assert.equal(first.outcome, 'reconcile_applied');
  assert.deepEqual([first.stats.added, first.stats.kept, first.stats.morphed, first.stats.removed], [3, 0, 0, 0]);
  const [a, b, c] = list.children;
  // A post-patch decorator touched row A; an unchanged segment must not undo it.
  a.querySelector('.tool-card').setAttribute('data-code-highlighted', 'true');

  const second = apply([rowSegment('a', 'A'), rowSegment('b', 'B grew'), rowSegment('c', 'C')]);
  assert.deepEqual([second.stats.added, second.stats.kept, second.stats.morphed, second.stats.removed], [0, 2, 1, 0]);
  assert.strictEqual(list.children[0], a);
  assert.strictEqual(list.children[1], b);
  assert.strictEqual(list.children[2], c);
  assert.equal(a.querySelector('.tool-card').getAttribute('data-code-highlighted'), 'true', 'a kept row is not re-morphed');
  assert.equal(b.textContent, 'B grew');
  dom.window.close();
});

test('reconcileKeyedRowList inserts, reorders and removes rows by key while keeping the others', () => {
  const { dom, list, apply } = reconcileFixture([rowSegment('a', 'A'), rowSegment('b', 'B'), rowSegment('c', 'C')]);
  const [a, b, c] = list.children;
  const result = apply([
    rowSegment('c', 'C'),
    { kind: 'divider', id: 'msg-9', markup: '<div class="chat-timeline-divider" data-before-message-id="msg-9">gap</div>' },
    rowSegment('a', 'A'),
    rowSegment('d', 'D'),
  ]);
  assert.deepEqual([result.stats.added, result.stats.kept, result.stats.morphed, result.stats.removed], [2, 2, 0, 1]);
  assert.deepEqual([...list.children].map((node) => node.getAttribute('data-row-id') || node.getAttribute('data-before-message-id')), ['c', 'msg-9', 'a', 'd']);
  assert.strictEqual(list.children[0], c, 'moved rows keep identity');
  assert.strictEqual(list.children[2], a);
  assert.equal(b.isConnected, false, 'a row absent from the segments is removed');
  // The divider is keyed by its target message id and kept on the next pass.
  const divider = list.children[1];
  const again = apply([
    rowSegment('c', 'C'),
    { kind: 'divider', id: 'msg-9', markup: '<div class="chat-timeline-divider" data-before-message-id="msg-9">gap</div>' },
    rowSegment('a', 'A'),
    rowSegment('d', 'D'),
  ]);
  assert.equal(again.stats.kept, 4);
  assert.strictEqual(list.children[1], divider);
  dom.window.close();
});

test('reconcileKeyedRowList always morphs live rows, even when their markup is unchanged', () => {
  const liveRow = (body) => rowSegment('live', body, ' data-streaming-row="true"');
  const reasoningRow = (body) => ({ kind: 'row', id: 'r', markup: `<div class="chat-row" data-row-id="r" data-row-kind="reasoning"><div class="reasoning-row-stack"><div class="reasoning-row-block" data-reasoning-live-tail="true">${body}</div></div></div>` });
  const { dom, list, apply } = reconcileFixture([reasoningRow('think'), liveRow('L')]);
  // The surgical patch wrote into the live rows behind the reconcile's back.
  list.children[0].querySelector('.reasoning-row-block').textContent = 'patched elsewhere';
  list.children[1].querySelector('.tool-card').textContent = 'patched elsewhere';
  const result = apply([reasoningRow('think'), liveRow('L')]);
  assert.deepEqual([result.stats.kept, result.stats.morphed], [0, 2], 'live rows are never memo hits');
  assert.equal(list.children[0].textContent, 'think');
  assert.equal(list.children[1].textContent, 'L');
  // A row leaving the live state is morphed once more (the incoming markup no longer says live).
  const settled = apply([{ kind: 'row', id: 'r', markup: '<div class="chat-row" data-row-id="r" data-row-kind="reasoning"><div class="reasoning-row-stack"><div class="reasoning-row-block">think</div></div></div>' }, rowSegment('live', 'L')]);
  assert.deepEqual([settled.stats.kept, settled.stats.morphed], [0, 2]);
  const settledAgain = apply([{ kind: 'row', id: 'r', markup: '<div class="chat-row" data-row-id="r" data-row-kind="reasoning"><div class="reasoning-row-stack"><div class="reasoning-row-block">think</div></div></div>' }, rowSegment('live', 'L')]);
  assert.deepEqual([settledAgain.stats.kept, settledAgain.stats.morphed], [2, 0], 'settled rows are kept from then on');
  dom.window.close();
});

test('a whole-list morph drops the reconcile stamp so the next reconcile re-checks that row', () => {
  const { dom, list, apply } = reconcileFixture([rowSegment('a', 'A'), rowSegment('b', 'B')]);
  const a = list.children[0];
  // Another lane morphs the list (same markup for A, B changed) through morphChildren.
  const template = dom.window.document.createElement('template');
  template.innerHTML = rowSegment('a', 'A').markup + rowSegment('b', 'B2').markup;
  morphChildrenForStamp(list, template.content);
  assert.strictEqual(list.children[0], a);
  const result = apply([rowSegment('a', 'A'), rowSegment('b', 'B2')]);
  assert.deepEqual([result.stats.kept, result.stats.morphed], [0, 2], 'rows another lane morphed are re-morphed once, then stamped');
  const again = apply([rowSegment('a', 'A'), rowSegment('b', 'B2')]);
  assert.deepEqual([again.stats.kept, again.stats.morphed], [2, 0]);
  dom.window.close();
});

// Astra finding (timeline-perf 2026-09-30): the live tool patch writes a row's
// DOM directly. It drops the stamp, so an identical later segment restores
// the canonical markup instead of trusting the stamp.
test('invalidateRowStamp makes the next identical reconcile re-morph a directly written row', () => {
  const { dom, list, apply } = reconcileFixture([rowSegment('a', 'Read'), rowSegment('b', 'B')]);
  const a = list.children[0];
  a.querySelector('.tool-card').textContent = 'read_file';
  const trusted = apply([rowSegment('a', 'Read'), rowSegment('b', 'B')]);
  assert.deepEqual([trusted.stats.kept, trusted.stats.morphed], [2, 0], 'without invalidation the stamp is trusted');
  assert.equal(a.querySelector('.tool-card').textContent, 'read_file');
  invalidateRowStamp(a.querySelector('.tool-card'));
  const rechecked = apply([rowSegment('a', 'Read'), rowSegment('b', 'B')]);
  assert.deepEqual([rechecked.stats.kept, rechecked.stats.morphed], [1, 1], 'the invalidated row is re-morphed, the other kept');
  assert.strictEqual(list.children[0], a, 'identity is kept');
  assert.equal(a.querySelector('.tool-card').textContent, 'Read', 'the canonical markup is restored');
  dom.window.close();
});

// The streaming article rewrite morphs the whole article; with the row
// segments it reconciles the row list per row and keeps the stamps, so the
// next queuePatch fallback stays warm.
test('setOuterHtmlPreservingCodeScroll with rowListSegments reconciles the row list per row and keeps the stamps', () => {
  const segments = [rowSegment('a', 'A'), rowSegment('b', 'B'), rowSegment('c', 'C')];
  const { dom, list, apply } = reconcileFixture(segments);
  const article = dom.window.document.createElement('article');
  article.setAttribute('data-message-id', 'm1');
  article.innerHTML = '<header class="h">one</header>';
  article.appendChild(list);
  dom.window.document.body.appendChild(article);
  const [a, b] = list.children;
  const next = [rowSegment('a', 'A'), rowSegment('b', 'B2'), rowSegment('c', 'C')];
  const html = `<article data-message-id="m1"><header class="h">two</header><div id="list" data-turn-row-list="true">${next.map((s) => s.markup).join('')}</div></article>`;
  const result = setOuterHtmlPreservingCodeScroll(article, html, { rowListSegments: next });
  assert.equal(result.outcome, 'morph_applied');
  assert.equal(result.rowList.outcome, 'reconcile_applied');
  assert.deepEqual([result.rowList.stats.kept, result.rowList.stats.morphed], [2, 1]);
  assert.equal(article.querySelector('header').textContent, 'two', 'the rest of the article is morphed');
  assert.strictEqual(list.children[0], a);
  assert.strictEqual(list.children[1], b);
  assert.equal(b.textContent, 'B2');
  const warm = apply(next);
  assert.deepEqual([warm.stats.kept, warm.stats.morphed], [3, 0], 'the stamps survived the article morph');
  const plain = setOuterHtmlPreservingCodeScroll(article, html, {});
  assert.equal(plain.outcome, 'morph_applied');
  assert.equal(plain.rowList, undefined, 'without segments the article morph descends as before');
  const cold = apply(next);
  assert.deepEqual([cold.stats.kept, cold.stats.morphed], [0, 3], 'and drops the stamps');
  dom.window.close();
});

test('reconcileKeyedRowList lands a repeated segment key once', () => {
  const { dom, list, first } = reconcileFixture([rowSegment('a', 'A'), rowSegment('b', 'B'), rowSegment('a', 'A again')]);
  assert.deepEqual([first.stats.added, first.stats.kept], [2, 0]);
  assert.equal(list.children.length, 2, 'the duplicate does not become an extra row');
  assert.equal(list.children[0].textContent, 'A', 'the first copy wins');
  dom.window.close();
});

test('reconcileKeyedRowList reports unusable input without touching the list', () => {
  const { dom, list, apply, outcomes } = reconcileFixture([rowSegment('a', 'A')]);
  assert.equal(apply([]).ok, false);
  assert.equal(outcomes[outcomes.length - 1].outcome, 'no_segments');
  assert.equal(reconcileKeyedRowList(null, [rowSegment('a', 'A')]), false);
  assert.equal(list.children.length, 1);
  // Segments without a key or markup are skipped, not fatal.
  const result = apply([{ kind: 'row', id: '', markup: '<div></div>' }, rowSegment('a', 'A')]);
  assert.equal(result.ok, true);
  assert.deepEqual([result.stats.kept, result.stats.removed], [1, 0]);
  dom.window.close();
});

test('reconcileKeyedRowList preserves code-block scroll and expand state inside a morphed row', () => {
  const codeRow = (body) => ({ kind: 'row', id: 'code', markup: `<div class="chat-row" data-row-id="code" data-row-kind="assistant_text"><div class="markdown-code-block collapsible collapsed"><div class="markdown-code-expand-overlay" aria-expanded="false"><span>Show more</span></div><pre><code>${body}</code></pre></div></div>` });
  const { dom, list, apply } = reconcileFixture([codeRow('line 1'), rowSegment('b', 'B')]);
  const block = list.querySelector('.markdown-code-block');
  block.classList.remove('collapsed');
  const pre = block.querySelector('pre');
  Object.defineProperty(pre, 'scrollLeft', { value: 40, writable: true, configurable: true });
  const result = apply([codeRow('line 1\nline 2'), rowSegment('b', 'B')]);
  assert.deepEqual([result.stats.kept, result.stats.morphed], [1, 1]);
  // The code component is keyed by its source, so a grown block is a new
  // node (same as the whole-list morph); its user-expanded state carries over.
  const patchedBlock = list.querySelector('.markdown-code-block');
  assert.equal(patchedBlock.classList.contains('collapsed'), false, 'the user-expanded state survives the row morph');
  assert.match(patchedBlock.textContent, /line 2/);
  dom.window.close();
});
