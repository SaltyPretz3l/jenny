'use strict';

// timeline-perf 2026-09-30: the non-passive Ctrl+wheel zoom listener exists
// only while Ctrl is held. Pane 0 owns the window-level tracker through its own
// registerListener (its listeners die with pane 0's abort signal); a second
// pane subscribes to the same tracker. Astra finding: a pane-0 dispose while
// Ctrl was down used to orphan the second pane's non-passive listener (nothing
// could release it any more), and a pane-0 re-bind used to install a fresh
// tracker the second pane was not subscribed to.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const gate = require('../renderer/chat/renderer-chat-ctrl-wheel-gate');

function makeWindow(t) {
  const dom = new JSDOM('<!doctype html><div id="p0"></div><div id="p1"></div>');
  t.after(() => dom.window.close());
  return dom.window;
}

function bindPane(win, id, documentLevel) {
  const controller = new win.AbortController();
  const cleanups = [];
  const chatView = win.document.getElementById(id);
  const ticks = { count: 0 };
  const registerListener = (target, type, handler, options) => {
    target.addEventListener(type, handler, { ...(options || {}), signal: controller.signal });
  };
  const gated = gate.bindCtrlGatedWheelZoom({
    chatView,
    windowRef: win,
    documentLevel,
    registerListener,
    listenerOptions: { signal: controller.signal },
    addCleanup: (fn) => cleanups.push(fn),
    bindAbortController: controller,
    onWheel: () => { ticks.count += 1; },
  });
  return {
    gated,
    // One Ctrl+wheel tick on this pane: did the zoom handler run?
    zooms() {
      const before = ticks.count;
      chatView.dispatchEvent(new win.WheelEvent('wheel', { ctrlKey: true, deltaY: 10, bubbles: true }));
      return ticks.count > before;
    },
    dispose() {
      controller.abort();
      if (documentLevel) gate.releaseCtrlKeyTracker(win);
      while (cleanups.length) cleanups.pop()();
    },
  };
}

const ctrlDown = (win) => win.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
const ctrlUp = (win) => win.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'Control', ctrlKey: false }));

test('a pane-0 dispose while Ctrl is held releases the second pane\'s non-passive listener', (t) => {
  const win = makeWindow(t);
  const pane0 = bindPane(win, 'p0', true);
  const pane1 = bindPane(win, 'p1', false);
  assert.equal(pane0.gated, true);
  assert.equal(pane1.gated, true, 'pane 1 subscribes to pane 0\'s tracker');
  assert.equal(pane1.zooms(), false, 'no listener before Ctrl (the tick scrolls; the passive re-sync attaches it)');
  ctrlUp(win);
  ctrlDown(win);
  assert.equal(pane1.zooms(), true, 'Ctrl held: pane 1 zooms');
  pane0.dispose();
  assert.equal(pane1.zooms(), false, 'pane 0 gone: pane 1\'s non-passive listener is detached, not orphaned');
  pane1.dispose();
});

test('a second pane keeps zooming across a pane-0 re-bind', (t) => {
  const win = makeWindow(t);
  let pane0 = bindPane(win, 'p0', true);
  const pane1 = bindPane(win, 'p1', false);
  pane0.dispose();
  ctrlDown(win);
  assert.equal(pane1.zooms(), false, 'no tracker listeners between dispose and re-bind');
  pane0 = bindPane(win, 'p0', true);
  ctrlDown(win);
  assert.equal(pane1.zooms(), true, 'the re-bound tracker drives the existing subscription');
  ctrlUp(win);
  assert.equal(pane1.zooms(), false);
  pane1.dispose();
  pane0.dispose();
});

test('a pane bound before pane 0 keeps the always-on listener until the tracker exists, then migrates to the gate', (t) => {
  const win = makeWindow(t);
  const pane1 = bindPane(win, 'p1', false);
  assert.equal(pane1.gated, false, 'no tracker listeners yet: always-on binding');
  assert.equal(pane1.zooms(), true, 'the always-on listener zooms without Ctrl tracking');
  const pane0 = bindPane(win, 'p0', true);
  assert.equal(pane0.gated, true);
  ctrlUp(win);
  assert.equal(pane1.zooms(), false, 'pane 0 installed the tracker: pane 1 no longer blocks plain scrolling');
  ctrlDown(win);
  assert.equal(pane1.zooms(), true, 'Ctrl held: the migrated pane zooms');
  pane1.dispose();
  assert.equal(pane1.zooms(), false, 'dispose removes the listener');
  pane0.dispose();
});
