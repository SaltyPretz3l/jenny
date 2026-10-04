'use strict';

// timeline-perf 2026-10-04: the per-row reconcile keeps a row whose markup
// equals its stamp unless the row is live. The live check used to query the
// subtree of every stamped row on every reconcile (5 s of a long streamed
// turn). It now queries only rows something wrote into since the stamp; the
// keep/morph decisions are unchanged and a live row is never kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const patch = require('../renderer/chat/renderer-stream-dom-patch-utils');
const { createReasoningStackPatcher } = require('../renderer/chat/renderer-stream-reasoning-patch-utils');

function toolRow(id, body) {
  return { kind: 'row', id, markup: `<div class="chat-row" data-row-id="${id}" data-row-kind="tool_call"><div class="tool-card">${body}</div></div>` };
}

function reasoningBlock(status, body, liveTail) {
  return `<div class="reasoning-row-block" data-reasoning-status="${status}" data-thinking-id="p1" data-phase-key="p1"${liveTail ? ' data-reasoning-live-tail="true"' : ''}>`
    + '<div class="reasoning-row-header"><span class="summary">Thinking</span></div>'
    + `<div class="reasoning-row-panel expanded"><div class="reasoning-row-panel-body">${body}</div></div>`
    + '</div>';
}

function reasoningRow(id, status, body, liveTail = false) {
  return { kind: 'row', id, markup: `<div class="chat-row" data-row-id="${id}" data-row-kind="reasoning"><div class="reasoning-row-stack" data-reasoning-row-version="2">${reasoningBlock(status, body, liveTail)}</div></div>` };
}

function setup(t, segments) {
  const dom = new JSDOM('<!doctype html><body><div id="list" data-turn-row-list="true"></div></body>');
  t.after(() => dom.window.close());
  const document = dom.window.document;
  const list = document.getElementById('list');
  const apply = (next) => {
    let record;
    assert.equal(patch.reconcileKeyedRowList(list, next, { onOutcome: (result) => { record = result; } }), true);
    return [record.stats.kept, record.stats.morphed];
  };
  apply(segments);
  return { dom, document, list, apply };
}

test('an identical reconcile keeps every settled row without querying its subtree', (t) => {
  const segments = Array.from({ length: 30 }, (_, index) => toolRow(`r${index}`, `<p>row ${index}</p>`));
  const { dom, list, apply } = setup(t, segments);
  const proto = dom.window.Element.prototype;
  const original = proto.querySelector;
  let rowQueries = 0;
  proto.querySelector = function countingQuerySelector(selector) {
    if (this.parentElement === list) rowQueries += 1;
    return original.call(this, selector);
  };
  t.after(() => { proto.querySelector = original; });
  assert.deepEqual(apply(segments), [30, 0]);
  assert.equal(rowQueries, 0, 'a kept row is decided from its stamp, not a subtree query');
});

test('a live tail the surgical reasoning patch writes into a stamped settled row is never kept', (t) => {
  const segments = [reasoningRow('r', 'done', '<p>settled</p>'), toolRow('a', 'A')];
  const { document, list, apply } = setup(t, segments);
  const row = list.children[0];
  const runtime = { streamingArticleMessageId: 'm', streamingMessageId: 'm', lastThinkingMarkup: '', lastThinkingMarkupKey: '' };
  const patcher = createReasoningStackPatcher({ getRuntime: () => runtime });
  // Same body: only the block attributes change, so the stack patch is the sole writer.
  const result = patcher.patchReasoningStack(row, {
    thinkingMarkup: `<div class="reasoning-row-stack" data-reasoning-row-version="2">${reasoningBlock('streaming', '<p>settled</p>', true)}</div>`,
  }, document, null);
  assert.equal(result.reason, 'patched');
  assert.equal(row.querySelector('.reasoning-row-block').getAttribute('data-reasoning-live-tail'), 'true');

  assert.deepEqual(apply(segments), [1, 1], 'the row holding a live tail is morphed although its markup matches the stamp');
  assert.strictEqual(list.children[0], row, 'identity is kept');
  assert.equal(row.querySelector('.reasoning-row-block').hasAttribute('data-reasoning-live-tail'), false);
  assert.equal(row.querySelector('.reasoning-row-block').getAttribute('data-reasoning-status'), 'done', 'the canonical markup is restored');
  assert.deepEqual(apply(segments), [2, 0], 'once restored it is kept again');
});

test('writes through the dom-patch entry points flag the row; a row whose live marker is gone again is kept', (t) => {
  const segments = [toolRow('a', 'A'), toolRow('b', 'B')];
  const { document, list, apply } = setup(t, segments);
  const [a, b] = list.children;

  const source = document.createElement('div');
  source.innerHTML = 'A<div class="chat-bubble" data-streaming-bubble="true">streaming</div>';
  assert.equal(patch.morphElementChildren(a.querySelector('.tool-card'), source), true);
  assert.deepEqual(apply(segments), [1, 1], 'a bubble morphed into a stamped row makes it live');
  assert.equal(a.querySelector('[data-streaming-bubble]'), null);

  patch.setInnerHtmlPreservingCodeScroll(b.querySelector('.tool-card'), 'B<span data-streaming-bubble="true"></span>');
  b.querySelector('[data-streaming-bubble]').remove();
  b.querySelector('.tool-card').setAttribute('data-decorated', 'true');
  assert.deepEqual(apply(segments), [2, 0], 'no live descendant left: kept, as the subtree query decided');
  assert.equal(b.querySelector('.tool-card').getAttribute('data-decorated'), 'true', 'the kept row is not re-morphed');
});
