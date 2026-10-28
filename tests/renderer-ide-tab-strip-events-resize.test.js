'use strict';

/* Editor tab strip overhaul (row 81, review fix): a strip resize (the view shown
 * again, the window narrowed) brings the active tab back into view; the user's own
 * scroll never pulls the strip back. Split from renderer-ide-tab-strip-events.test.js
 * at its 600-line ratchet. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createIdeTabStripEvents } = require('../renderer/features/renderer-ide-tab-strip-events');

test('a resize re-reveals the active tab; a scroll never does', async () => {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { pretendToBeVisual: true });
  let observerCallback = null;
  dom.window.ResizeObserver = class {
    constructor(callback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  };
  const root = dom.window.document.getElementById('root');
  root.innerHTML = '<div class="ide-tabbar"><div class="ide-tabstrip" role="tablist">'
    + '<div class="ide-tab" data-ide-tab="a.js"></div><div class="ide-tab ide-tab--active" data-ide-tab="b.js"></div></div></div>';
  const rig = { win: dom.window, tabbar: root.firstChild, strip: root.querySelector('.ide-tabstrip') };
  const revealed = [];
  dom.window.Element.prototype.scrollIntoView = function scrollIntoView() { revealed.push(this.getAttribute('data-ide-tab')); };
  const events = createIdeTabStripEvents({ root: rig.tabbar, getStrip: () => rig.strip, groupId: '', callbacks: {} });
  const frame = () => new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
  rig.strip.dispatchEvent(new dom.window.Event('scroll'));
  await frame();
  assert.deepEqual(revealed, [], 'scrolling never pulls the strip back');
  observerCallback();
  await frame();
  assert.deepEqual(revealed, ['b.js'], 'a resize brings the active tab back into view');
  events.dispose();
});
