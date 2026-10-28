'use strict';

/* tests/renderer-ide-map-transform-gestures.test.js - pointer/wheel gesture
 * contract for renderer-ide-map-transform.js (2026-10-22 review fixes):
 * pointer capture is deferred past the click slop so a tile click still
 * targets the tile, only the primary button pans, a lost capture or window
 * blur ends the pan, a horizontal-only wheel never zooms, and the
 * --atlas-zoom restyle hook is stamped only on a material scale change or
 * when the camera settles. jsdom; never dom.window.close(). */

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createMapTransform } = require('../renderer/features/renderer-ide-map-transform');

function makeTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const rafs = new Map();
  return {
    setTimeout(fn) { const id = nextId; nextId += 1; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    requestAnimationFrame(fn) { const id = nextId; nextId += 1; rafs.set(id, fn); return id; },
    cancelAnimationFrame(id) { rafs.delete(id); },
    flushRaf() { const fns = [...rafs.values()]; rafs.clear(); for (const fn of fns) fn(Date.now()); },
    flushTimers() { const fns = [...timeouts.values()]; timeouts.clear(); for (const fn of fns) fn(); },
  };
}

function setup(t) {
  const dom = new JSDOM('<div id="vp"><div id="content"><button id="tile" data-map-node="a.js"></button></div></div>');
  const doc = dom.window.document;
  const viewportEl = doc.getElementById('vp');
  const contentEl = doc.getElementById('content');
  const captures = [];
  viewportEl.setPointerCapture = (id) => captures.push(id);
  viewportEl.releasePointerCapture = () => {};
  const timers = makeTimers();
  const ctrl = createMapTransform({
    viewportEl, contentEl, timers, storage: null,
    getViewportRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  });
  t.after(() => ctrl.dispose());
  function pointer(type, props) {
    const ev = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...props });
    Object.defineProperty(ev, 'pointerId', { value: props.pointerId != null ? props.pointerId : 1 });
    return ev;
  }
  function wheel(deltaY, deltaX = 0) {
    const ev = new dom.window.Event('wheel', { bubbles: true, cancelable: true });
    Object.defineProperties(ev, {
      deltaY: { value: deltaY }, deltaX: { value: deltaX }, clientX: { value: 100 }, clientY: { value: 100 },
    });
    return ev;
  }
  return { dom, doc, viewportEl, contentEl, ctrl, timers, captures, pointer, wheel };
}

test('pointer capture waits until the pointer travels past the click slop', (t) => {
  const { doc, viewportEl, ctrl, timers, captures, pointer } = setup(t);
  doc.getElementById('tile').dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100, pointerId: 4 }));
  assert.deepEqual(captures, [], 'no capture on pointerdown: the click must still reach the tile');
  viewportEl.dispatchEvent(pointer('pointermove', { clientX: 102, clientY: 101, pointerId: 4 }));
  assert.deepEqual(captures, [], 'a jitter inside the slop does not capture');
  viewportEl.dispatchEvent(pointer('pointermove', { clientX: 140, clientY: 100, pointerId: 4 }));
  assert.deepEqual(captures, [4], 'capture once it is clearly a pan');
  timers.flushRaf();
  assert.equal(ctrl.getState().tx, 40, 'the pan still follows the pointer');
});

test('only the primary button starts a pan', (t) => {
  const { viewportEl, ctrl, timers, pointer } = setup(t);
  viewportEl.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 10, pointerId: 2, button: 2 }));
  viewportEl.dispatchEvent(pointer('pointermove', { clientX: 90, clientY: 90, pointerId: 2, button: 2 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, { tx: 0, ty: 0 });
});

test('a lost pointer capture ends the pan', (t) => {
  const { viewportEl, ctrl, timers, pointer } = setup(t);
  viewportEl.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 10, pointerId: 3 }));
  viewportEl.dispatchEvent(pointer('pointermove', { clientX: 30, clientY: 10, pointerId: 3 }));
  viewportEl.dispatchEvent(pointer('lostpointercapture', { pointerId: 3 }));
  viewportEl.dispatchEvent(pointer('pointermove', { clientX: 300, clientY: 10, pointerId: 3 }));
  timers.flushRaf();
  assert.equal(ctrl.getState().tx, 20, 'moves after the capture loss do not pan');
});

test('a window blur ends the pan', (t) => {
  const { dom, viewportEl, ctrl, timers, pointer } = setup(t);
  viewportEl.dispatchEvent(pointer('pointerdown', { clientX: 10, clientY: 10, pointerId: 5 }));
  dom.window.dispatchEvent(new dom.window.Event('blur'));
  viewportEl.dispatchEvent(pointer('pointermove', { clientX: 200, clientY: 10, pointerId: 5 }));
  timers.flushRaf();
  assert.equal(ctrl.getState().tx, 0);
});

test('a horizontal-only wheel never zooms', (t) => {
  const { viewportEl, ctrl, timers, wheel } = setup(t);
  viewportEl.dispatchEvent(wheel(0, 120));
  timers.flushRaf();
  assert.equal(ctrl.getState().scale, 1);
});

test('--atlas-zoom restyles only on a material scale change, then lands exactly on settle', (t) => {
  const { ctrl, contentEl, timers } = setup(t);
  ctrl.zoomToward({ x: 0, y: 0 }, 1.02);
  timers.flushRaf();
  assert.notEqual(contentEl.style.getPropertyValue('--atlas-zoom'), '1.02', 'a 2% step does not restyle the subtree');
  ctrl.zoomToward({ x: 0, y: 0 }, 1.5);
  timers.flushRaf();
  assert.equal(contentEl.style.getPropertyValue('--atlas-zoom'), '1.5', 'a large step restyles immediately');
  ctrl.zoomToward({ x: 0, y: 0 }, 1.52);
  timers.flushRaf();
  assert.equal(contentEl.style.getPropertyValue('--atlas-zoom'), '1.5');
  timers.flushTimers();
  assert.equal(contentEl.style.getPropertyValue('--atlas-zoom'), '1.52', 'the settle stamps the exact scale');
});
