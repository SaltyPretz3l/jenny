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
