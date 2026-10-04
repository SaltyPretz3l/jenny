'use strict';

/* Split view pixel floor (gate F3, 2026-09-27) beyond the divider gestures:
 * the floor must also show on hydration (sync) and after a window resize,
 * without ever rewriting the persisted ratio (Astra review). */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHarness, roundTo4, FRAGMENT } = require('./helpers/pane-resizer-harness');

test('pixel floor: sync() shows a persisted ratio below the floor through the clamp and never rewrites it', (t) => {
  const h = createHarness(t, { startRatio: 0.2, deps: { minPaneWidth: 320, measureWidth: () => 870 } });
  h.resizer.sync();
  assert.equal(h.paneA(), `${roundTo4(320 / 870)}fr`, 'hydration shows the floor, not the 172px pane the saved 0.2 gives');
  assert.equal(h.valueNow(), '37');
  assert.deepEqual(h.record.setSplitRatio, [], 'the model is not written');
  assert.deepEqual(h.record.persisted, [], 'nothing is persisted');
  assert.equal(h.model.ratio, 0.2, 'the saved preference survives for a wider window');
});

test('pixel floor: a window resize re-applies the floor from the persisted ratio, except during a drag', (t) => {
  let width = 2000;
  const h = createHarness(t, { startRatio: 0.2, deps: { minPaneWidth: 320, measureWidth: () => width } });
  h.resizer.sync();
  assert.equal(h.paneA(), '0.2fr', 'wide enough: the saved ratio shows as is');
  width = 870;
  h.window.dispatchEvent(new h.window.Event('resize'));
  assert.equal(h.paneA(), `${roundTo4(320 / 870)}fr`, 'narrowed: the floor shows');
  assert.equal(h.model.ratio, 0.2, 'still not rewritten');
  width = 2000;
  h.pointer('pointerdown', { clientX: 500 });
  h.window.dispatchEvent(new h.window.Event('resize'));
  assert.equal(h.paneA(), `${roundTo4(320 / 870)}fr`, 'a resize during a drag leaves the gesture alone');
  h.pointer('pointerup', { clientX: 500 });
  const off = createHarness(t, { startRatio: 0.2, deps: { minPaneWidth: 0, measureWidth: () => 870 } });
  off.resizer.sync();
  assert.equal(off.paneA(), '0.2fr', 'without a floor sync() shows the ratio as is');
});

test('pixel floor: with ResizeObserver the floor follows the chat view\'s own size (hidden -> shown), not the window', (t) => {
  const { JSDOM } = require('jsdom');
  const { createChatPaneResizer } = require('../renderer/chat/renderer-chat-pane-resizer');
  const dom = new JSDOM(FRAGMENT);
  t.after(() => dom.window.close());
  const observers = [];
  dom.window.ResizeObserver = class {
    constructor(cb) { this.cb = cb; this.observed = []; this.disconnected = 0; observers.push(this); }
    observe(el) { this.observed.push(el); }
    disconnect() { this.disconnected += 1; }
  };
  const chatViewEl = dom.window.document.getElementById('chatView');
  const resizerEl = dom.window.document.getElementById('chatPaneResizer');
  let width = 0; // hidden: nothing to measure
  const model = { ratio: 0.2 };
  const resizer = createChatPaneResizer({
    resizerEl, chatViewEl, minPaneWidth: 320, measureWidth: () => width,
    getSplitRatio: () => model.ratio, setSplitRatio: (ratio) => { model.ratio = ratio; return ratio; }, onPersist() {},
  });
  resizer.bind();
  resizer.sync();
  assert.equal(chatViewEl.style.getPropertyValue('--chat-pane-a'), '0.2fr', 'hidden: no floor can be measured');
  assert.equal(observers.length, 1, 'one observer');
  assert.deepEqual(observers[0].observed, [chatViewEl, dom.window.document.getElementById('chatPane0')], 'both the view and pane 0 are observed so a rail resize re-applies the floor');
  width = 870; // shown again, at a narrow width
  observers[0].cb([]);
  assert.equal(chatViewEl.style.getPropertyValue('--chat-pane-a'), `${roundTo4(320 / 870)}fr`, 'the floor re-applies when the view gets its size');
  assert.equal(model.ratio, 0.2, 'the persisted ratio is untouched');
  resizer.dispose();
  assert.equal(observers[0].disconnected, 1, 'dispose disconnects the observer');
});
