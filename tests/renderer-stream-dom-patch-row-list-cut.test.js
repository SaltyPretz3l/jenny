'use strict';

// timeline-perf (2026-10-04): the active-turn-root repaint and the streaming
// article rewrite reconcile the host's turn row list per row, so the settled
// rows of the parsed markup were never read -- yet the whole turn markup,
// settled rows included, was parsed on every event. Only the shell (the
// markup with that row list's body cut out) is parsed now. Contract: the
// resulting DOM is the one the whole-markup morph produces (same rows, same
// order, unchanged rows keep their nodes, the other row lists morph as
// before), a re-created host article is finished from the whole markup, and
// a warm repaint parses a small fraction of the markup.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { setOuterHtmlPreservingCodeScroll } = require('../renderer/chat/renderer-stream-dom-patch-utils');

function rowSegment(id, body) {
  return { kind: 'row', id, markup: `<div class="chat-row" data-row-id="${id}" data-row-kind="tool_call"><span class="chat-row-node-dot"></span><div class="tool-card"><pre><code>${body}</code></pre><p>${body} detail text that pads the row to a realistic size</p></div></div>` };
}

function rows(count, changed = {}) {
  return Array.from({ length: count }, (_, index) => rowSegment(`t:r${index}`, changed[index] || `row ${index}`));
}

function rootHtml(segments, { header = 'one', userText = 'question', wrapper = 'div' } = {}) {
  return `<div class="chat-thread-root" data-thread-message-id="u1">`
    + `<article class="chat-entry user" data-message-id="u1"><div class="turn-row-list" data-turn-row-list="true"><div class="chat-row" data-row-id="u:1">${userText}</div></div></article>`
    + `<${wrapper} class="chat-thread-children">`
    + `<article class="chat-entry assistant" data-message-id="a1"><header>${header}</header>`
    + `<div class="turn-row-list" data-turn-row-list="true" data-turn-live="true">${segments.map((segment) => segment.markup).join('')}</div>`
    + `<div class="chat-hover-row">actions</div></article></${wrapper}></div>`;
}

function setup(t) {
  const dom = new JSDOM('<!doctype html><body><div id="timeline"></div></body>');
  const document = dom.window.document;
  const parsed = { chars: 0 };
  const createElement = document.createElement.bind(document);
  const innerHtml = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'innerHTML');
  document.createElement = (tagName, ...rest) => {
    const element = createElement(tagName, ...rest);
    if (String(tagName).toLowerCase() === 'template') {
      Object.defineProperty(element, 'innerHTML', {
        configurable: true,
        get() { return innerHtml.get.call(this); },
        set(value) { parsed.chars += String(value).length; innerHtml.set.call(this, value); },
      });
    }
    return element;
  };
  t.after(() => dom.window.close());
  const mount = (html) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    const root = host.firstElementChild;
    document.getElementById('timeline').appendChild(root);
    return root;
  };
  return { document, parsed, mount };
}

test('active-root repaint: parsing the shell gives the whole-markup DOM and keeps unchanged rows', (t) => {
  const { parsed, mount } = setup(t);
  const first = rows(40);
  const root = mount(rootHtml(first));
  const twin = mount(rootHtml(first));
  const options = (segments) => ({ rowListSegments: segments, rowListHostId: 'a1' });
  setOuterHtmlPreservingCodeScroll(root, rootHtml(first), options(first));
  const keptRow = root.querySelector('[data-row-id="t:r3"]');
  const changedRow = root.querySelector('[data-row-id="t:r39"]');

  const next = [...rows(40, { 39: 'row 39 grew' }), rowSegment('t:r40', 'a new row')];
  const nextHtml = rootHtml(next, { header: 'two', userText: 'question (edited)' });
  parsed.chars = 0;
  const result = setOuterHtmlPreservingCodeScroll(root, nextHtml, options(next));
  const parsedChars = parsed.chars;
  setOuterHtmlPreservingCodeScroll(twin, nextHtml, {});

  assert.equal(result.outcome, 'morph_applied');
  assert.equal(result.rowList?.outcome, 'reconcile_applied');
  assert.equal(root.outerHTML, twin.outerHTML, 'the DOM is the whole-markup morph result');
  assert.strictEqual(root.querySelector('[data-row-id="t:r3"]'), keptRow, 'an unchanged row keeps its node');
  assert.strictEqual(root.querySelector('[data-row-id="t:r39"]'), changedRow, 'a changed row is morphed in place');
  assert.match(root.querySelector('[data-message-id="u1"]').textContent, /edited/, "the user shell's own row list morphs as before");
  assert.ok(parsedChars * 4 < nextHtml.length, `parsed ${parsedChars} of ${nextHtml.length} chars`);
});

test('active-root repaint: a re-created host article is finished from the whole markup', (t) => {
  const { mount } = setup(t);
  const first = rows(6);
  const root = mount(rootHtml(first));
  const twin = mount(rootHtml(first));
  // The host article moves into a different container element, so the morph
  // re-creates it instead of reaching its existing row list.
  const next = rows(6, { 2: 'changed' });
  const nextHtml = rootHtml(next, { wrapper: 'section' });
  const result = setOuterHtmlPreservingCodeScroll(root, nextHtml, { rowListSegments: next, rowListHostId: 'a1' });
  setOuterHtmlPreservingCodeScroll(twin, nextHtml, {});
  assert.equal(result.outcome, 'morph_applied');
  assert.equal(root.querySelectorAll('[data-message-id="a1"] .chat-row').length, 6, 'the rows are there');
  assert.equal(root.outerHTML, twin.outerHTML);
});

test('a body that is not found once inside a row-list tag is parsed whole', (t) => {
  const { parsed, mount } = setup(t);
  const first = rows(4);
  const root = mount(rootHtml(first));
  const twin = mount(rootHtml(first));
  const next = rows(4, { 1: 'changed' });
  // The same body twice in the markup: the cut would be ambiguous.
  const nextHtml = rootHtml(next).replace('<div class="chat-hover-row">actions</div>',
    `<div class="chat-hover-row">${next.map((segment) => segment.markup).join('')}</div>`);
  parsed.chars = 0;
  const result = setOuterHtmlPreservingCodeScroll(root, nextHtml, { rowListSegments: next, rowListHostId: 'a1' });
  setOuterHtmlPreservingCodeScroll(twin, nextHtml, {});
  assert.equal(result.outcome, 'morph_applied');
  assert.ok(parsed.chars >= nextHtml.length, 'the whole markup was parsed');
  assert.equal(root.outerHTML, twin.outerHTML);
});
