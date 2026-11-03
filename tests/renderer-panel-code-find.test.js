'use strict';

/* Find in file for the chat side panel's code bodies: the pure matcher, the inline find field
 * (keys, count, wrapping), Custom Highlight API painting over a stubbed registry (jsdom has
 * none), the class fallback, re-render refresh and teardown. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createPanelCodeFind, findMatches } = require('../renderer/features/renderer-panel-code-find');
const actionButton = require('../renderer/inventory/action-button');
const textField = require('../renderer/inventory/text-field');

const ROWS = [
  '<li class="row" data-n="1"><span class="gut">1</span><code><span>const </span><span class="tok">Foo</span><span> = foo(1);</span></code></li>',
  '<li class="row" data-n="2"><span class="gut">2</span><code><span>return </span><span>FOO</span></code></li>',
  '<li class="row" data-n="3"><span class="gut">3</span><code>nothing here</code></li>',
  '<li class="row" data-n="4"><span class="gut">4</span><code>a foo b</code></li>',
].join('');

function setup({ highlights = true, withPrimitives = false } = {}) {
  // Without explicit primitives the module resolves the inventory ones itself.
  const dom = new JSDOM(`<!doctype html><body><div id="host"><button id="outside">x</button><ol id="body" tabindex="0">${ROWS}</ol></div></body>`);
  const win = dom.window;
  const doc = win.document;
  const timers = [];
  const frames = [];
  win.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  win.clearTimeout = (id) => { if (timers[id - 1]) timers[id - 1].fn = null; };
  win.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
  win.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
  const scrolled = [];
  win.HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) { scrolled.push({ n: this.dataset.n, options }); };
  if (highlights) {
    class Highlight {
      constructor(...ranges) { this.ranges = ranges; }
    }
    win.Highlight = Highlight;
    win.CSS = { highlights: new Map() };
  }
  const finder = createPanelCodeFind({
    documentRef: doc,
    windowRef: win,
    jt: (key, fallback, params) => (params ? fallback.replace(/\{(\w+)\}/g, (m, n) => params[n]) : fallback),
    ...(withPrimitives ? { textField, actionButton } : {}),
  });
  const body = doc.getElementById('body');
  const handle = finder.attach(body, { rowSelector: '.row', textSelector: 'code' });
  const flushTimers = () => timers.splice(0).forEach((t) => t.fn && t.fn());
  const flushFrames = () => frames.splice(0).forEach((fn) => fn && fn());
  const key = (target, init) => {
    const event = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(event);
    return event;
  };
  const field = () => doc.querySelector('.panel-code-find');
  const input = () => doc.querySelector('.panel-code-find-input');
  const count = () => doc.querySelector('.panel-code-find-count').textContent;
  const type = (text) => {
    input().value = text;
    input().dispatchEvent(new win.Event('input', { bubbles: true }));
    flushTimers();
  };
  const ranges = (name) => (win.CSS.highlights.get(name)?.ranges || []).map((r) => r.toString());
  return { win, doc, body, finder, handle, flushTimers, flushFrames, frames, key, field, input, count, type, ranges, scrolled, timers, close: () => win.close() };
}

test('findMatches is case-insensitive and returns every non-overlapping hit per row', () => {
  const rows = ['Foo foo FOO', 'none', 'aaaa'];
  assert.deepEqual(findMatches(rows, 'foo').map((m) => [m.row, m.start, m.end]), [[0, 0, 3], [0, 4, 7], [0, 8, 11]]);
  assert.deepEqual(findMatches(rows, 'aa').map((m) => [m.row, m.start]), [[2, 0], [2, 2]]);
  assert.deepEqual(findMatches(rows, ''), []);
  assert.deepEqual(findMatches([], 'x'), []);
});

test('findMatches caps the result at 5000 matches', () => {
  const rows = [];
  for (let i = 0; i < 6; i += 1) rows.push('x'.repeat(1000));
  assert.equal(findMatches(rows, 'x').length, 5000);
});

test('Ctrl/Cmd+F opens the field only when focus is inside the body, as the body previous sibling', (t) => {
  const h = setup();
  t.after(h.close);
  const outside = h.key(h.doc.getElementById('outside'), { key: 'f', ctrlKey: true });
  assert.equal(outside.defaultPrevented, false);
  assert.equal(h.field(), null);

  assert.equal(h.key(h.body, { key: 'f', ctrlKey: true, shiftKey: true }).defaultPrevented, false, 'Ctrl+Shift+F is not ours');
  assert.equal(h.field(), null);

  const inside = h.key(h.body.querySelector('.tok'), { key: 'f', ctrlKey: true });
  assert.equal(inside.defaultPrevented, true);
  assert.equal(h.field().nextElementSibling, h.body);
  assert.equal(h.doc.activeElement, h.input());
  assert.equal(h.input().getAttribute('aria-label'), 'Find in file');
  assert.equal(h.doc.querySelector('.panel-code-find-count').getAttribute('aria-live'), 'polite');
  assert.equal(h.doc.querySelectorAll('.panel-code-find button').length, 3);

  h.handle.close();
  h.key(h.body, { key: 'F', metaKey: true });
  assert.ok(h.field(), 'Cmd+F opens it again');
});

test('typing debounces to one search and updates the count, with a no-results message', (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.input().value = 'f';
  h.input().dispatchEvent(new h.win.Event('input'));
  h.input().value = 'foo';
  h.input().dispatchEvent(new h.win.Event('input'));
  assert.equal(h.count(), '', 'nothing until the debounce fires');
  assert.equal(h.timers[0].ms, 80);
  h.flushTimers();
  assert.equal(h.count(), '1 of 4');
  h.type('zzz');
  assert.equal(h.count(), 'No results');
  h.type('');
  assert.equal(h.count(), '');
});

test('Enter and Shift+Enter step through the matches and wrap around; the buttons do the same', (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.type('foo');
  const enter = h.key(h.input(), { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(h.count(), '2 of 4');
  h.key(h.input(), { key: 'Enter' });
  h.key(h.input(), { key: 'Enter' });
  assert.equal(h.count(), '4 of 4');
  h.key(h.input(), { key: 'Enter' });
  assert.equal(h.count(), '1 of 4', 'wraps forward');
  h.key(h.input(), { key: 'Enter', shiftKey: true });
  assert.equal(h.count(), '4 of 4', 'wraps backward');
  h.doc.querySelector('.panel-code-find-prev').click();
  assert.equal(h.count(), '3 of 4');
  h.doc.querySelector('.panel-code-find-next').click();
  assert.equal(h.count(), '4 of 4');
});

test('Enter right after typing runs the pending search instead of stepping past the first match', (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.input().value = 'foo';
  h.input().dispatchEvent(new h.win.Event('input'));
  h.key(h.input(), { key: 'Enter' });
  assert.equal(h.count(), '1 of 4');
});

test('Escape closes the field, clears highlights, focuses the body, and reopening keeps the query selected', (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.type('foo');
  assert.ok(h.win.CSS.highlights.get('panel-code-find'));
  const escape = h.key(h.input(), { key: 'Escape' });
  assert.equal(escape.defaultPrevented, true);
  assert.equal(h.field(), null);
  assert.equal(h.win.CSS.highlights.size, 0);
  assert.equal(h.doc.activeElement, h.body);

  h.key(h.body, { key: 'f', ctrlKey: true });
  assert.equal(h.input().value, 'foo');
  assert.equal(h.input().selectionStart, 0);
  assert.equal(h.input().selectionEnd, 3);
  assert.equal(h.count(), '1 of 4');

  h.key(h.body, { key: 'Escape' });
  assert.equal(h.field(), null, 'Escape inside the body closes an open field too');
});

test('Escape in the body does nothing while the field is closed', (t) => {
  const h = setup();
  t.after(h.close);
  assert.equal(h.key(h.body, { key: 'Escape' }).defaultPrevented, false);
});

test('highlights cover every match across token spans and mark the current one', (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.type('foo');
  assert.deepEqual(h.ranges('panel-code-find'), ['Foo', 'foo', 'FOO', 'foo']);
  assert.deepEqual(h.ranges('panel-code-find-current'), ['Foo']);
  h.key(h.input(), { key: 'Enter' });
  assert.deepEqual(h.ranges('panel-code-find-current'), ['foo']);
  assert.equal(h.body.querySelector('.is-find-current'), null, 'no class when the API exists');

  h.type('= foo(');
  assert.deepEqual(h.ranges('panel-code-find'), ['= foo(']);
  assert.equal(h.body.querySelectorAll('span').length, 9, 'code text nodes are never mutated');

  h.type('const Foo');
  assert.deepEqual(h.ranges('panel-code-find'), ['const Foo'], 'a match spanning two token spans');
  h.type('t Fo');
  assert.deepEqual(h.ranges('panel-code-find'), ['t Fo']);
});

test('the current match scrolls its row into view with block nearest', (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.type('foo');
  assert.deepEqual(h.scrolled.at(-1), { n: '1', options: { block: 'nearest' } });
  h.key(h.input(), { key: 'Enter', shiftKey: true });
  assert.equal(h.scrolled.at(-1).n, '4');
});

test('highlights set by someone else are left alone on close', (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.type('foo');
  const foreign = new h.win.Highlight();
  h.win.CSS.highlights.set('panel-code-find', foreign);
  h.handle.close();
  assert.equal(h.win.CSS.highlights.get('panel-code-find'), foreign);
  assert.equal(h.win.CSS.highlights.has('panel-code-find-current'), false);
});

test('without the Custom Highlight API only the current row gets is-find-current', (t) => {
  const h = setup({ highlights: false });
  t.after(h.close);
  h.handle.open();
  h.type('foo');
  assert.deepEqual([...h.body.querySelectorAll('.is-find-current')].map((r) => r.dataset.n), ['1']);
  h.key(h.input(), { key: 'Enter' });
  h.key(h.input(), { key: 'Enter' });
  assert.deepEqual([...h.body.querySelectorAll('.is-find-current')].map((r) => r.dataset.n), ['2']);
  assert.equal(h.count(), '3 of 4');
  h.handle.close();
  assert.equal(h.body.querySelector('.is-find-current'), null);
});

test('a re-render of the body is picked up through one coalesced frame and keeps the current index when valid', async (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.type('foo');
  h.key(h.input(), { key: 'Enter' });
  assert.equal(h.count(), '2 of 4');

  h.body.insertAdjacentHTML('beforeend', '<li class="row" data-n="5"><span class="gut">5</span><code>foo again</code></li>');
  h.body.insertAdjacentHTML('beforeend', '<li class="row" data-n="6"><span class="gut">6</span><code>foo</code></li>');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.count(), '2 of 4', 'nothing runs before the frame');
  h.flushFrames();
  assert.equal(h.count(), '2 of 6');
  assert.equal(h.ranges('panel-code-find').length, 6);

  h.body.innerHTML = '<li class="row" data-n="9"><code>a foo b</code></li>';
  await new Promise((resolve) => setImmediate(resolve));
  h.flushFrames();
  assert.equal(h.count(), '1 of 1', 'an index past the new end falls back to the first match');
  assert.deepEqual(h.ranges('panel-code-find'), ['foo']);
});

test('changes outside the rows (a live elapsed ticker) schedule no re-search; a row text change does', async (t) => {
  const h = setup();
  t.after(h.close);
  const ticker = h.doc.createElement('span');
  h.body.appendChild(ticker);
  h.handle.open();
  h.type('foo');
  for (const text of ['1s', '2s', '3s']) ticker.textContent = text;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.frames.filter(Boolean).length, 0);

  h.body.querySelector('[data-n="3"] code').firstChild.nodeValue = 'foo now';
  await new Promise((resolve) => setImmediate(resolve));
  h.flushFrames();
  assert.equal(h.count(), '1 of 5');
});

test('stepping swaps only the current highlight and keeps the all-matches set', (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.type('foo');
  const all = h.win.CSS.highlights.get('panel-code-find');
  h.key(h.input(), { key: 'Enter' });
  assert.equal(h.win.CSS.highlights.get('panel-code-find'), all);
  assert.equal(h.win.CSS.highlights.get('panel-code-find-current').ranges[0], all.ranges[1]);
});

test('refresh() re-runs the query on demand and is a no-op while closed', (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.refresh();
  assert.equal(h.field(), null);
  h.handle.open();
  h.type('foo');
  h.body.querySelector('.row[data-n="4"] code').textContent = 'none';
  h.handle.refresh();
  assert.equal(h.count(), '1 of 3');
});

test('detach removes the field, listeners, observer and highlights', async (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.type('foo');
  h.handle.detach();
  assert.equal(h.field(), null);
  assert.equal(h.win.CSS.highlights.size, 0);
  assert.equal(h.key(h.body, { key: 'f', ctrlKey: true }).defaultPrevented, false);
  assert.equal(h.field(), null);
  h.body.insertAdjacentHTML('beforeend', '<li class="row"><code>foo</code></li>');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.frames.length, 0, 'no frame is requested after detach');
  assert.equal(h.win.CSS.highlights.size, 0);
});

test('dispose detaches every attachment', (t) => {
  const h = setup();
  t.after(h.close);
  h.handle.open();
  h.type('foo');
  h.finder.dispose();
  assert.equal(h.field(), null);
  assert.equal(h.win.CSS.highlights.size, 0);
  assert.equal(h.key(h.body, { key: 'f', ctrlKey: true }).defaultPrevented, false);
});

test('the field is built from the inventory text-field and action-button primitives, given or resolved', (t) => {
  const resolved = setup();
  resolved.handle.open();
  assert.ok(resolved.field().querySelector('input.inv-text-field-control'));
  resolved.close();
  const h = setup({ withPrimitives: true });
  t.after(h.close);
  h.handle.open();
  assert.ok(h.field().querySelector('input.panel-code-find-input.inv-text-field-control'));
  const buttons = [...h.field().querySelectorAll('button')];
  assert.deepEqual(buttons.map((b) => b.className), ['panel-code-find-prev', 'panel-code-find-next', 'panel-code-find-close']);
  assert.deepEqual(buttons.map((b) => b.getAttribute('aria-label')), ['Previous match', 'Next match', 'Close find']);
  h.type('foo');
  buttons[1].click();
  assert.equal(h.count(), '2 of 4');
  buttons[2].click();
  assert.equal(h.field(), null);
  assert.equal(h.doc.activeElement, h.body);
});

test('diff-style rows: a row without a text element is skipped and the match lands on the right row', async (t) => {
  const dom = new JSDOM('<!doctype html><body><div><div id="d" tabindex="0">'
    + '<div class="diff-line meta">@@ -1 +1 @@</div>'
    + '<div class="diff-line"><span class="diff-gutter">1</span><span class="diff-marker">+</span><span class="diff-content">let <b>needle</b></span></div>'
    + '</div></div></body>');
  const win = dom.window;
  win.HTMLElement.prototype.scrollIntoView = () => {};
  t.after(() => win.close());
  const finder = createPanelCodeFind({ documentRef: win.document, windowRef: win });
  const handle = finder.attach(win.document.getElementById('d'), { rowSelector: '.diff-line', textSelector: '.diff-content' });
  handle.open();
  win.document.querySelector('.panel-code-find-input').value = 'needle';
  win.document.querySelector('.panel-code-find-input').dispatchEvent(new win.Event('input'));
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(win.document.querySelector('.panel-code-find-count').textContent, '1 of 1');
  assert.deepEqual([...win.document.querySelectorAll('.is-find-current')].map((r) => r.className), ['diff-line is-find-current']);
  assert.equal(win.document.querySelector('.is-find-current .diff-marker').textContent, '+');
});
