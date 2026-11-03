'use strict';

// The surgical reasoning-stack patch lives in its own module
// (renderer-stream-reasoning-patch-utils.js), split out of the stream-reveal
// controller at its line cap. Contract: a stack whose blocks line up is
// patched in place (same nodes, new header and body text), the unchanged
// markup short-circuits, and every decline names its reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { createReasoningStackPatcher } = require('../renderer/chat/renderer-stream-reasoning-patch-utils');

function block(key, summary, body, status = 'streaming') {
  return `<div class="reasoning-row-block" data-reasoning-status="${status}" data-thinking-id="${key}" data-phase-key="${key}">`
    + `<div class="reasoning-row-header"><span class="summary">${summary}</span></div>`
    + `<div class="reasoning-row-panel expanded"><div class="reasoning-row-panel-body">${body}</div></div>`
    + '</div>';
}

function stack(...blocks) {
  return `<div class="reasoning-row-stack" data-reasoning-row-version="2">${blocks.join('')}</div>`;
}

function setup(articleInner, extraDeps = {}) {
  const dom = new JSDOM(`<!doctype html><body><article id="a">${articleInner}</article></body>`);
  const runtime = { streamingArticleMessageId: 'msg_1', streamingMessageId: 'msg_1', lastThinkingMarkup: '', lastThinkingMarkupKey: '' };
  const headerPatches = [];
  const patcher = createReasoningStackPatcher({
    getRuntime: () => runtime,
    isStreamPaintV2Enabled: () => false,
    noteHeaderPatch: (kind) => headerPatches.push(kind),
    ...extraDeps,
  });
  const document = dom.window.document;
  return { dom, document, article: document.getElementById('a'), runtime, headerPatches, patcher };
}

test('reasoning patch module: aligned blocks patch in place and the unchanged stack short-circuits', (t) => {
  const { dom, document, article, runtime, headerPatches, patcher } = setup(stack(block('p1', 'Thinking', '<p>first</p>')));
  t.after(() => dom.window.close());
  const blockNode = article.querySelector('.reasoning-row-block');
  const bodyNode = article.querySelector('.reasoning-row-panel-body');
  const nextMarkup = stack(block('p1', 'Planning', '<p>first, then second</p>'));

  const result = patcher.patchReasoningStack(article, { thinkingMarkup: nextMarkup }, document, null);
  assert.deepEqual(result, { patched: true, requiresFullFallback: false, hasThinkingMarkup: true, reason: 'patched' });
  assert.strictEqual(article.querySelector('.reasoning-row-block'), blockNode, 'the block keeps its node');
  assert.strictEqual(article.querySelector('.reasoning-row-panel-body'), bodyNode, 'the body keeps its node');
  assert.equal(article.querySelector('.summary').textContent, 'Planning');
  assert.equal(bodyNode.textContent, 'first, then second');
  assert.deepEqual(headerPatches, ['reasoning_header_rewrite']);
  assert.equal(runtime.lastThinkingMarkup, nextMarkup);
  assert.equal(runtime.lastThinkingMarkupKey, 'msg_1');

  const again = patcher.patchReasoningStack(article, { thinkingMarkup: nextMarkup }, document, null);
  assert.equal(again.reason, 'stack_unchanged');
});

test('reasoning patch module: declines name their reason', (t) => {
  const { dom, document, article, patcher } = setup(stack(block('p1', 'Thinking', 'one')));
  t.after(() => dom.window.close());
  assert.equal(patcher.patchReasoningStack(article, {}, document, null).reason, 'no_thinking_markup');
  const countMismatch = patcher.patchReasoningStack(article, {
    thinkingMarkup: stack(block('p1', 'Thinking', 'one'), block('p2', 'More', 'two')),
  }, document, null);
  assert.deepEqual(countMismatch, { patched: false, requiresFullFallback: true, hasThinkingMarkup: true, reason: 'block_count_mismatch' });
  const removed = patcher.patchReasoningStack(article, { thinkingMarkup: '<p>no stack</p>' }, document, null);
  assert.deepEqual(removed, { patched: false, requiresFullFallback: true, hasThinkingMarkup: true, reason: 'stack_removed' });
});

test('reasoning patch module: a new stack lands before the streaming bubble', (t) => {
  const { dom, document, article, patcher } = setup('<div class="chat-bubble" data-streaming-bubble="true">answer</div>');
  t.after(() => dom.window.close());
  const result = patcher.patchReasoningStack(article, { thinkingMarkup: stack(block('p1', 'Thinking', 'one')) }, document, null);
  assert.equal(result.reason, 'stack_inserted');
  assert.strictEqual(article.firstElementChild.className, 'reasoning-row-stack');
});

function unitBody(...units) {
  return units.map((html, index) =>
    `<div class="reasoning-stream-unit" data-stream-unit-index="${index}" data-su-fp="fp${index}-${html.length}">${html}</div>`).join('');
}

test('reasoning patch module: the streaming tail unit goes through the tail writer keyed per block', (t) => {
  const writes = [];
  const keys = [];
  const { dom, document, article, patcher } = setup(stack(block('p1', 'Thinking', unitBody('<p>first</p>', '<p>sec</p>'))), {
    getReasoningTailWriter: (blockKey) => {
      keys.push(blockKey);
      return (el, html, index) => { writes.push({ index, html }); el.innerHTML = html; };
    },
  });
  t.after(() => dom.window.close());
  const result = patcher.patchReasoningStack(article, {
    thinkingMarkup: stack(block('p1', 'Thinking', unitBody('<p>first</p>', '<p>second</p>'))),
  }, document, null);
  assert.equal(result.reason, 'patched');
  assert.deepEqual(writes, [{ index: 1, html: '<p>second</p>' }]);
  assert.deepEqual(keys, ['p1']);
  assert.equal(article.querySelectorAll('.reasoning-stream-unit')[1].textContent, 'second');
});

test('reasoning patch module: a null tail writer keeps the plain innerHTML path', (t) => {
  let asked = 0;
  const { dom, document, article, patcher } = setup(stack(block('p1', 'Thinking', unitBody('<p>first</p>'))), {
    getReasoningTailWriter: () => { asked += 1; return null; },
  });
  t.after(() => dom.window.close());
  patcher.patchReasoningStack(article, {
    thinkingMarkup: stack(block('p1', 'Thinking', unitBody('<p>first and more</p>'))),
  }, document, null);
  assert.equal(asked, 1);
  assert.equal(article.querySelector('.reasoning-stream-unit').innerHTML, '<p>first and more</p>');
  assert.equal(article.querySelectorAll('.chat-stream-token').length, 0);
});

test('reasoning patch module: fade spans never persist once the body settles', (t) => {
  const tokenFade = require('../renderer/chat/renderer-stream-token-fade-utils');
  const tracker = tokenFade.createStreamTokenFadeTracker();
  const { dom, document, article, patcher } = setup(stack(block('p1', 'Thinking', unitBody('<p>first</p>'))), {
    getReasoningTailWriter: (blockKey) => (el, html, index) => {
      tracker.reset(`msg_1:${blockKey}`);
      tracker.applyTailUnit(el, html, index);
    },
  });
  t.after(() => dom.window.close());
  patcher.patchReasoningStack(article, {
    thinkingMarkup: stack(block('p1', 'Thinking', unitBody('<p>first and more</p>'))),
  }, document, null);
  assert.ok(article.querySelectorAll('.chat-stream-token').length > 0, 'the live tail fades its new text');

  patcher.patchReasoningStack(article, {
    thinkingMarkup: stack(block('p1', 'Thinking', '<p>first and more, settled</p>', 'complete')),
  }, document, null);
  assert.equal(article.querySelectorAll('.chat-stream-token').length, 0, 'settled body takes the bulk path');
  assert.equal(article.querySelector('.reasoning-row-panel-body').textContent, 'first and more, settled');
});

// Row 101 Phase 2: a patch copies fresh attributes onto the body; the live box
// marker and its top fade survive it, and the flip to complete keeps the marker
// (the cap holds into the collapse) and shows the end of the settled body.
test('reasoning patch module: the live box marker and fade survive a patch and the settle flip', (t) => {
  const liveBox = require('../renderer/chat/renderer-reasoning-live-box-follow');
  const { dom, document, article, patcher } = setup(stack(block('p1', 'Thinking', '<p>one</p>')));
  t.after(() => dom.window.close());
  const timeline = document.createElement('div');
  timeline.className = 'chat-timeline';
  article.replaceWith(timeline);
  timeline.appendChild(article);
  const body = article.querySelector('.reasoning-row-panel-body');
  let height = 900;
  Object.defineProperty(body, 'scrollHeight', { configurable: true, get: () => height });
  Object.defineProperty(body, 'clientHeight', { configurable: true, get: () => 300 });
  let top = 0;
  Object.defineProperty(body, 'scrollTop', { configurable: true, get: () => top, set: (value) => { top = Math.max(0, Math.min(value, height - 300)); } });
  const follow = liveBox.createReasoningLiveBoxFollow({ requestFrame: () => 1, cancelFrame: () => {}, reducedMotionQuery: { matches: false } });
  t.after(() => follow.dispose());
  follow.sync(timeline);
  assert.equal(body.getAttribute('data-live-box'), 'true');
  assert.equal(body.classList.contains('has-scrolled'), true, 'attach snapped to the bottom');

  patcher.patchReasoningStack(article, { thinkingMarkup: stack(block('p1', 'Thinking', '<p>one two</p>')) }, document, null);
  assert.strictEqual(article.querySelector('.reasoning-row-panel-body'), body);
  assert.equal(body.getAttribute('data-live-box'), 'true', 'marker carried across the attribute copy');
  assert.equal(body.classList.contains('has-scrolled'), true, 'top fade carried across');

  top = 0;
  height = 1500; // the settled body holds the full text
  patcher.patchReasoningStack(article, { thinkingMarkup: stack(block('p1', 'Thought', '<p>one two three</p>', 'complete')) }, document, null);
  assert.equal(body.getAttribute('data-live-box'), 'true', 'marker kept at the flip');
  assert.equal(top, 1200, 'the settled body shows its end');
});
