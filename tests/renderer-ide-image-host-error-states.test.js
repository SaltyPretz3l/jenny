'use strict';

/* UIUX-034: the image preview pane (renderer-ide-image-host.js) previously had
 * a `load` handler but no `error` handler and no decoded-pixel budget, so a
 * corrupted/unsupported-format file or a decode-bomb-shaped image just left a
 * permanently broken <img> with no user-visible explanation. These tests
 * drive createIdeImagePane directly (no controller/IPC needed) and dispatch
 * synthetic load/error DOM events - jsdom never performs a real image decode,
 * so `naturalWidth`/`naturalHeight` are overridden per-test to simulate what
 * a real decode would report. Also covers blobUrl-over-base64 src selection
 * (renderer-ide-image-memory.js hands the pane a doc shaped either way). */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeImagePane } = require('../renderer/features/renderer-ide-image-host');

function makePane() {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const pane = createIdeImagePane({ getHost: () => host });
  return { dom, host, pane };
}

function setNaturalSize(img, width, height) {
  Object.defineProperty(img, 'naturalWidth', { value: width, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: height, configurable: true });
}

test('a failed/corrupt image decode shows an explicit error state, not a permanently broken <img>', (t) => {
  const { dom, host, pane } = makePane();
  t.after(() => pane.dispose());
  pane.show({ base64: 'not-real-bytes', mime: 'image/png', size: 12 });

  const img = host.querySelector('.ide-image-el');
  const errorEl = host.querySelector('.ide-image-error');
  assert.equal(errorEl.classList.contains('hidden'), true, 'no error shown before decode fails');

  img.dispatchEvent(new dom.window.Event('error'));

  assert.equal(errorEl.classList.contains('hidden'), false, 'error state becomes visible');
  assert.match(errorEl.textContent, /corrupted|unsupported/i);
  assert.equal(img.classList.contains('hidden'), true, 'broken <img> is hidden, not left showing a broken-image icon');
});

test('an oversized decode (past the pixel budget) is treated as an error, not rendered', (t) => {
  const { dom, host, pane } = makePane();
  t.after(() => pane.dispose());
  pane.show({ base64: 'AAAA', mime: 'image/png', size: 999 });

  const img = host.querySelector('.ide-image-el');
  const errorEl = host.querySelector('.ide-image-error');
  // 20000x20000 = 400,000,000 px, well past the 64,000,000 px budget.
  setNaturalSize(img, 20000, 20000);
  img.dispatchEvent(new dom.window.Event('load'));

  assert.equal(errorEl.classList.contains('hidden'), false, 'oversized decode surfaces the error state');
  assert.match(errorEl.textContent, /too large/i);
  assert.equal(img.src, '', 'the oversized decoded bitmap is released, not left live');
});

test('a normal decode within budget renders and never touches the error state', (t) => {
  const { dom, host, pane } = makePane();
  t.after(() => pane.dispose());
  pane.show({ base64: 'AAAA', mime: 'image/png', size: 999 });

  const img = host.querySelector('.ide-image-el');
  const errorEl = host.querySelector('.ide-image-error');
  setNaturalSize(img, 800, 600);
  img.dispatchEvent(new dom.window.Event('load'));

  assert.equal(errorEl.classList.contains('hidden'), true);
  assert.equal(img.classList.contains('hidden'), false);
});

test('re-showing a doc after a previous error clears the error state', (t) => {
  const { dom, host, pane } = makePane();
  t.after(() => pane.dispose());
  pane.show({ base64: 'bad', mime: 'image/png', size: 5 });
  const img = host.querySelector('.ide-image-el');
  const errorEl = host.querySelector('.ide-image-error');
  img.dispatchEvent(new dom.window.Event('error'));
  assert.equal(errorEl.classList.contains('hidden'), false);

  pane.show({ base64: 'AAAA', mime: 'image/png', size: 5 });
  assert.equal(errorEl.classList.contains('hidden'), true, 'switching tabs resets the stale error state');
  assert.equal(img.classList.contains('hidden'), false);
});

test('show() prefers doc.blobUrl over a base64 data URL when both are present', (t) => {
  const { host, pane } = makePane();
  t.after(() => pane.dispose());
  pane.show({ blobUrl: 'blob:fake-url', base64: 'shouldNotBeUsed', mime: 'image/png', size: 5 });
  const img = host.querySelector('.ide-image-el');
  assert.equal(img.src, 'blob:fake-url');
});

test('show() falls back to a data: URL when no blobUrl is present (jsdom / no object-URL support)', (t) => {
  const { host, pane } = makePane();
  t.after(() => pane.dispose());
  pane.show({ base64: 'ZmFrZQ==', mime: 'image/png', size: 5 });
  const img = host.querySelector('.ide-image-el');
  assert.equal(img.src, 'data:image/png;base64,ZmFrZQ==');
});
