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

function setup(articleInner) {
  const dom = new JSDOM(`<!doctype html><body><article id="a">${articleInner}</article></body>`);
  const runtime = { streamingArticleMessageId: 'msg_1', streamingMessageId: 'msg_1', lastThinkingMarkup: '', lastThinkingMarkupKey: '' };
  const headerPatches = [];
  const patcher = createReasoningStackPatcher({
    getRuntime: () => runtime,
    isStreamPaintV2Enabled: () => false,
    noteHeaderPatch: (kind) => headerPatches.push(kind),
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
