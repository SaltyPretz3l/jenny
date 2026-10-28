'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeImagePane } = require('../renderer/features/renderer-ide-image-host');

test('releasing an oversized bitmap keeps the "too large" message (its error event is ignored)', (t) => {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>');
  const host = dom.window.document.getElementById('host');
  const pane = createIdeImagePane({ getHost: () => host });
  t.after(() => { pane.dispose(); dom.window.close(); });
  pane.show({ base64: 'AAAA', mime: 'image/png', size: 999 });
  const img = host.querySelector('.ide-image-el');
  Object.defineProperty(img, 'naturalWidth', { value: 20000, configurable: true });
  Object.defineProperty(img, 'naturalHeight', { value: 20000, configurable: true });
  img.dispatchEvent(new dom.window.Event('load'));
  // A browser queues an error event for the released source.
  img.dispatchEvent(new dom.window.Event('error'));
  const errorEl = host.querySelector('.ide-image-error');
  assert.match(errorEl.textContent, /too large/i);
  assert.doesNotMatch(errorEl.textContent, /could not load/i);
  assert.equal(img.src, '', 'the oversized bitmap is still released');
});

test('the pane surface no longer exposes the unused isVisible', () => {
  const pane = createIdeImagePane({ getHost: () => null });
  assert.deepEqual(Object.keys(pane).sort(), ['dispose', 'hide', 'show']);
});
