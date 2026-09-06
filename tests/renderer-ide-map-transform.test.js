'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const transformModule = require('../renderer/features/renderer-ide-map-transform');
const { createMapTransform, clamp, SCALE_MIN, SCALE_MAX, MIN_CONTENT_VISIBLE } = transformModule;

// Injectable fake timers: rAF flushes synchronously via flushRaf(); setTimeout
// entries flush via flushTimers(). Mirrors the auto-save makeTimers precedent.
function makeTimers() {
  let nextId = 1;
  const timeouts = new Map();
  const rafs = new Map();
  return {
    setTimeout(fn) { const id = nextId; nextId += 1; timeouts.set(id, fn); return id; },
    clearTimeout(id) { timeouts.delete(id); },
    requestAnimationFrame(fn) { const id = nextId; nextId += 1; rafs.set(id, fn); return id; },
    cancelAnimationFrame(id) { rafs.delete(id); },
    pendingTimeouts: () => timeouts.size,
    pendingRafs: () => rafs.size,
    flushRaf() {
      const fns = [...rafs.values()];
      rafs.clear();
      for (const fn of fns) { fn(Date.now()); }
    },
    flushTimers() {
      const fns = [...timeouts.values()];
      timeouts.clear();
      for (const fn of fns) { fn(); }
    },
  };
}

function makeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

// A viewport rect fixed for deterministic coordinate math.
function fixedRect(left = 10, top = 20, width = 800, height = 600) {
  return () => ({ left, top, width, height });
}

function setupDom(t) {
  const dom = new JSDOM('<div id="vp"><div id="content"></div></div>');
  const doc = dom.window.document;
  const viewportEl = doc.getElementById('vp');
  const contentEl = doc.getElementById('content');
  // Provide a PointerEvent shim (jsdom lacks it) mapped onto MouseEvent so the
  // pointer listeners receive pointerId/clientX/clientY.
  function pointer(type, props) {
    const ev = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, ...props });
    Object.defineProperty(ev, 'pointerId', { value: props.pointerId != null ? props.pointerId : 1 });
    return ev;
  }
  t.after(() => { /* no dom.window.close() per house rule */ });
  return { dom, doc, viewportEl, contentEl, pointer };
}

function makeController(t, overrides = {}) {
  const { viewportEl, contentEl, pointer } = setupDom(t);
  const timers = makeTimers();
  const storage = makeStorage(overrides.seedStorage || {});
  const ctrl = createMapTransform({
    viewportEl,
    contentEl,
    workspaceId: overrides.workspaceId || 'ws1',
    timers,
    storage,
    getViewportRect: overrides.getViewportRect || fixedRect(),
    ...overrides.extra,
  });
  t.after(() => ctrl.dispose());
  return { ctrl, timers, storage, viewportEl, contentEl, pointer };
}

// ── FROZEN round-trip test ──────────────────────────────────────────────────
test('FROZEN: clientToContent(contentToClient(p)) === p at several states', (t) => {
  const { ctrl } = makeController(t);
  const points = [{ x: 0, y: 0 }, { x: 123.5, y: -42 }, { x: 800, y: 600 }, { x: -17.25, y: 333.1 }];
  const states = [
    { scale: 1, tx: 0, ty: 0 },
    { scale: 0.2, tx: 50, ty: -30 },
    { scale: 3, tx: -120.5, ty: 400 },
  ];
  for (const s of states) {
    ctrl.setBounds(null);
    ctrl.panTo(s.tx, s.ty);
    ctrl.zoomToward({ x: 0, y: 0 }, s.scale); // adjusts tx/ty but keeps consistency
    for (const p of points) {
      const round = ctrl.clientToContent(ctrl.contentToClient(p));
      assert.deepEqual(
        { x: Number(round.x.toFixed(9)), y: Number(round.y.toFixed(9)) },
        { x: Number(p.x.toFixed(9)), y: Number(p.y.toFixed(9)) },
        `round-trip ${JSON.stringify(p)} at ${JSON.stringify(s)}`,
      );
    }
  }
});

// ── zoom-anchor invariance ──────────────────────────────────────────────────
test('zoomToward keeps the anchor content-point under the cursor', (t) => {
  const { ctrl, timers, contentEl } = makeController(t);
  const cursor = { x: 300, y: 250 };
  const before = ctrl.clientToContent(cursor);
  ctrl.zoomToward(cursor, 2.4);
  timers.flushRaf();
  const after = ctrl.clientToContent(cursor);
  assert.ok(Math.abs(after.x - before.x) < 1e-9, 'anchor x stable');
  assert.ok(Math.abs(after.y - before.y) < 1e-9, 'anchor y stable');
  assert.equal(ctrl.getState().scale, 2.4);
  // The commit stamps the zoom-compensation variable the stylesheet divides
  // chrome sizes by (constant visual border/label size across zooms).
  assert.equal(contentEl.style.getPropertyValue('--atlas-zoom'), '2.4');
});

test('zoomToward clamps to SCALE_MIN / SCALE_MAX', (t) => {
  const { ctrl } = makeController(t);
  ctrl.zoomToward({ x: 0, y: 0 }, 99);
  assert.equal(ctrl.getState().scale, SCALE_MAX);
  ctrl.zoomToward({ x: 0, y: 0 }, 0.001);
  assert.equal(ctrl.getState().scale, SCALE_MIN);
});

// ── clamp pure-function edge cases (DOM-free) ───────────────────────────────
test('clamp: no bounds → only scale clamped, translation untouched', () => {
  assert.deepEqual(clamp({ scale: 5, tx: 1000, ty: -1000 }, null, { width: 800, height: 600 }),
    { scale: SCALE_MAX, tx: 1000, ty: -1000 });
  assert.deepEqual(clamp({ scale: 0.05, tx: 3, ty: 4 }, null, null),
    { scale: SCALE_MIN, tx: 3, ty: 4 });
});

test('clamp: non-finite scale falls back to 1', () => {
  assert.equal(clamp({ scale: NaN, tx: 0, ty: 0 }, null, null).scale, 1);
});

test('clamp: at least MIN_CONTENT_VISIBLE px of actual content stays in the viewport', () => {
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  const viewport = { width: 800, height: 600 };
  // Pushed way off to the right/bottom → clamped back so the content's left
  // edge sits MIN_CONTENT_VISIBLE px inside the viewport's right edge. A
  // padding-based clamp allowed the content itself to end up 100% off-screen
  // (blank-map defect on small graphs with a stale persisted camera).
  const far = clamp({ scale: 1, tx: 100000, ty: 100000 }, bounds, viewport);
  // txMax = vw - overlap - minX*scale = 800 - 48 - 0 = 752 → content [752..852]
  assert.equal(far.tx, viewport.width - MIN_CONTENT_VISIBLE);
  assert.equal(far.ty, viewport.height - MIN_CONTENT_VISIBLE);
  const near = clamp({ scale: 1, tx: -100000, ty: -100000 }, bounds, viewport);
  // txMin = overlap - maxX*scale = 48 - 100 = -52 → content [-52..48]
  assert.equal(near.tx, MIN_CONTENT_VISIBLE - bounds.maxX);
  assert.equal(near.ty, MIN_CONTENT_VISIBLE - bounds.maxY);
});

test('clamp: required overlap shrinks for content smaller than 2× the target', () => {
  // 40px-wide content: overlap = min(48, 40/2, 800/2) = 20 per axis, so the
  // constraint stays satisfiable (txMin <= txMax) for arbitrarily small maps.
  const bounds = { minX: 0, minY: 0, maxX: 40, maxY: 40 };
  const viewport = { width: 800, height: 600 };
  const far = clamp({ scale: 1, tx: 100000, ty: 100000 }, bounds, viewport);
  assert.equal(far.tx, 800 - 20);
  assert.equal(far.ty, 600 - 20);
  const near = clamp({ scale: 1, tx: -100000, ty: -100000 }, bounds, viewport);
  assert.equal(near.tx, 20 - 40);
  assert.equal(near.ty, 20 - 40);
});

test('clamp: zero viewport skips translation clamping', () => {
  const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
  assert.deepEqual(clamp({ scale: 1, tx: 5000, ty: 5000 }, bounds, { width: 0, height: 0 }),
    { scale: 1, tx: 5000, ty: 5000 });
});

// ── subscribe / unsubscribe ─────────────────────────────────────────────────
test('subscribe is notified on commit and unsubscribe stops it', (t) => {
  const { ctrl, timers } = makeController(t);
  const seen = [];
  const off = ctrl.subscribe((s) => seen.push(s));
  ctrl.panBy(10, 20, 'pan');
  timers.flushRaf();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].reason, 'pan');
  assert.equal(seen[0].tx, 10);
  off();
  ctrl.panBy(5, 5);
  timers.flushRaf();
  assert.equal(seen.length, 1, 'no notifications after unsubscribe');
});

test('multiple commits before rAF coalesce into a single notification', (t) => {
  const { ctrl, timers } = makeController(t);
  const seen = [];
  ctrl.subscribe((s) => seen.push(s));
  ctrl.panBy(1, 0);
  ctrl.panBy(1, 0);
  ctrl.panBy(1, 0);
  assert.equal(timers.pendingRafs(), 1, 'one rAF queued');
  timers.flushRaf();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].tx, 3, 'all pans applied, one commit');
});

// ── persist / restore round-trip with fake storage + timers ─────────────────
test('persist debounces 150ms then writes; restore reads it back', (t) => {
  const { ctrl, timers, storage } = makeController(t, { workspaceId: 'abc' });
  ctrl.panTo(42, -7, 'pan');
  timers.flushRaf();
  assert.equal(timers.pendingTimeouts(), 1, 'persist timer scheduled');
  assert.equal(storage.getItem('jenny.fileMap.view.abc'), null, 'not written before debounce fires');
  timers.flushTimers();
  const raw = storage.getItem('jenny.fileMap.view.abc');
  assert.ok(raw, 'written after debounce');
  assert.deepEqual(JSON.parse(raw), { scale: 1, tx: 42, ty: -7 });

  // A fresh controller restores from the same storage.
  const seed = { 'jenny.fileMap.view.abc': raw };
  const { ctrl: ctrl2 } = makeController(t, { workspaceId: 'abc', seedStorage: seed });
  assert.deepEqual(ctrl2.getState(), { scale: 1, tx: 42, ty: -7 });
});

test('restore ignores corrupt storage entries', (t) => {
  const { ctrl } = makeController(t, {
    workspaceId: 'zz',
    seedStorage: { 'jenny.fileMap.view.zz': '{not json' },
  });
  assert.deepEqual(ctrl.getState(), { scale: 1, tx: 0, ty: 0 });
});

// ── pointer pan with capture ────────────────────────────────────────────────
test('empty-canvas pan drags via pointer events and uses setPointerCapture', (t) => {
  const { ctrl, timers, viewportEl, pointer } = makeController(t);
  let captured = null;
  viewportEl.setPointerCapture = (id) => { captured = id; };
  viewportEl.releasePointerCapture = () => {};
  viewportEl.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100, pointerId: 7 }));
  assert.equal(captured, 7, 'pointer captured on down');
  viewportEl.dispatchEvent(pointer('pointermove', { clientX: 130, clientY: 90, pointerId: 7 }));
  timers.flushRaf();
  assert.deepEqual(
    { tx: ctrl.getState().tx, ty: ctrl.getState().ty },
    { tx: 30, ty: -10 },
    'content translated by the client delta',
  );
  viewportEl.dispatchEvent(pointer('pointerup', { clientX: 130, clientY: 90, pointerId: 7 }));
  // After release, moves no longer pan.
  viewportEl.dispatchEvent(pointer('pointermove', { clientX: 200, clientY: 200, pointerId: 7 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, { tx: 30, ty: -10 });
});

// DELETED: 'pan is suppressed when the pointerdown target is a map node'
// asserted the OLD node-drag contract (a map-node pointerdown started a drag
// gesture instead of a canvas pan). Node dragging is retired by the Living
// Atlas rework; renderer-ide-map-event-ownership.js's ownsCanvasPointerEvent
// now explicitly includes 'node' alongside 'canvas'/'district' — a
// pointerdown on a map node pans the canvas exactly like the empty
// background does. Replaced with the inverse assertion below.

test('pan is NOT suppressed when the pointerdown target is a map node (node dragging is retired)', (t) => {
  const { ctrl, timers, viewportEl, contentEl, pointer } = makeController(t);
  const node = contentEl.ownerDocument.createElement('div');
  node.setAttribute('data-map-node', 'src/a.js');
  contentEl.appendChild(node);
  node.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 100, pointerId: 3 }));
  viewportEl.dispatchEvent(pointer('pointermove', { clientX: 150, clientY: 150, pointerId: 3 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, { tx: 50, ty: 50 },
    'a pointerdown on a map node pans the canvas exactly like the empty background does');
});

// ── wheel zoom ──────────────────────────────────────────────────────────────
test('wheel zoom preventDefaults and zooms toward the cursor', (t) => {
  const { ctrl, timers, viewportEl, dom } = { ...makeController(t) };
  // Rebuild a wheel event with preventDefault tracking.
  const wheel = new viewportEl.ownerDocument.defaultView.Event('wheel', { bubbles: true, cancelable: true });
  Object.defineProperties(wheel, {
    deltaY: { value: -120 },
    clientX: { value: 400 },
    clientY: { value: 300 },
  });
  let prevented = false;
  wheel.preventDefault = () => { prevented = true; };
  const anchorBefore = ctrl.clientToContent({ x: 400, y: 300 });
  viewportEl.dispatchEvent(wheel);
  timers.flushRaf();
  assert.equal(prevented, true, 'preventDefault called');
  assert.ok(ctrl.getState().scale > 1, 'scrolled up → zoomed in');
  const anchorAfter = ctrl.clientToContent({ x: 400, y: 300 });
  assert.ok(Math.abs(anchorAfter.x - anchorBefore.x) < 1e-9, 'wheel anchor stable x');
  assert.ok(Math.abs(anchorAfter.y - anchorBefore.y) < 1e-9, 'wheel anchor stable y');
  void dom;
});

// ── fitToContent ────────────────────────────────────────────────────────────
test('fitToContent frames the bounds centered in the viewport and returns true', (t) => {
  const { ctrl, timers } = makeController(t, { getViewportRect: fixedRect(0, 0, 800, 600) });
  const applied = ctrl.fitToContent({ minX: 0, minY: 0, maxX: 400, maxY: 300 });
  assert.equal(applied, true, 'a computable fit reports success');
  timers.flushRaf();
  const s = ctrl.getState();
  // scale = min(800/400, 600/300)*0.9 = min(2,2)*0.9 = 1.8
  assert.equal(Number(s.scale.toFixed(9)), 1.8, 'fit scale');
  // center (200,150) maps to viewport center (400,300)
  const center = ctrl.contentToClient({ x: 200, y: 150 });
  assert.deepEqual(
    { x: Number(center.x.toFixed(9)), y: Number(center.y.toFixed(9)) },
    { x: 400, y: 300 },
    'content center framed at the viewport center',
  );
});

test('fitToContent on a 0×0 viewport returns false and keeps the camera', (t) => {
  // A map mounted while its stage is hidden measures 0×0: the fit must
  // report failure so the controller can retry once the viewport has size,
  // instead of latching "fitted" on a no-op (blank-map defect).
  const { ctrl, timers } = makeController(t, { getViewportRect: fixedRect(0, 0, 0, 0) });
  const before = ctrl.getState();
  const applied = ctrl.fitToContent({ minX: 0, minY: 0, maxX: 400, maxY: 300 });
  assert.equal(applied, false, 'an uncomputable fit reports failure');
  timers.flushRaf();
  assert.deepEqual(ctrl.getState(), before, 'camera unchanged');
});

// ── dispose no-op behavior ──────────────────────────────────────────────────
test('dispose removes listeners, cancels work, and no-ops all methods', (t) => {
  const { ctrl, timers, storage, viewportEl, pointer } = makeController(t);
  const seen = [];
  ctrl.subscribe((s) => seen.push(s));
  ctrl.panBy(10, 10); // state mutates synchronously; commit is rAF-deferred
  const baseline = { tx: ctrl.getState().tx, ty: ctrl.getState().ty };
  assert.deepEqual(baseline, { tx: 10, ty: 10 });
  ctrl.dispose();
  assert.equal(timers.pendingRafs(), 0, 'rAF cancelled on dispose');
  // Post-dispose mutations do nothing and never notify.
  ctrl.panBy(50, 50);
  ctrl.zoomToward({ x: 0, y: 0 }, 3);
  ctrl.fitToContent({ minX: 0, minY: 0, maxX: 10, maxY: 10 });
  timers.flushRaf();
  timers.flushTimers();
  assert.equal(seen.length, 0, 'no notifications after dispose');
  assert.equal(storage.getItem('jenny.fileMap.view.ws1'), null, 'no persist after dispose');
  // Listeners removed: a pointer sequence does not move state.
  viewportEl.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0, pointerId: 1 }));
  viewportEl.dispatchEvent(pointer('pointermove', { clientX: 99, clientY: 99, pointerId: 1 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, baseline);
});

test('dispose is idempotent', (t) => {
  const { ctrl } = makeController(t);
  const baseline = ctrl.getState();
  ctrl.dispose();
  ctrl.dispose();
  // Second dispose leaves the (frozen) state untouched and methods no-op.
  assert.deepEqual(ctrl.getState(), baseline, 'state unchanged across double dispose');
});

// ── exported constants sanity ───────────────────────────────────────────────
test('exports the pure clamp and scale constants', () => {
  assert.equal(typeof clamp, 'function');
  assert.equal(SCALE_MIN, 0.2);
  assert.equal(SCALE_MAX, 3.0);
  assert.equal(MIN_CONTENT_VISIBLE, 48);
});

// ── flyTo / flyToFit (animated camera, atlas polish) ────────────────────────

test('flyTo eases toward the target across frames and lands exactly', (t) => {
  let fakeNow = 0;
  const { ctrl, timers } = makeController(t, { extra: { now: () => fakeNow } });
  ctrl.setBounds(null);
  ctrl.flyTo({ tx: 350, ty: 700, scale: 2 }, 'fly-test');
  // First step ran synchronously at t=0: still at the origin state.
  timers.flushRaf(); // commit the t=0 frame
  const early = ctrl.getState();
  assert.ok(early.tx < 350 && early.scale < 2, 'not at target yet');

  fakeNow = 175; // halfway
  timers.flushRaf(); // next animation step
  timers.flushRaf(); // its commit
  const mid = ctrl.getState();
  assert.ok(mid.tx > early.tx && mid.tx < 350, `monotonic progress (got ${mid.tx})`);

  fakeNow = 350; // done
  timers.flushRaf();
  timers.flushRaf();
  const done = ctrl.getState();
  assert.equal(Math.round(done.tx), 350);
  assert.equal(Math.round(done.ty), 700);
  assert.equal(done.scale, 2);
});

test('a user gesture (panTo / zoomToward / new flyTo) cancels the in-flight flight', (t) => {
  let fakeNow = 0;
  const { ctrl, timers } = makeController(t, { extra: { now: () => fakeNow } });
  ctrl.setBounds(null);
  ctrl.flyTo({ tx: 1000, ty: 0 }, 'fly');
  timers.flushRaf();
  ctrl.panTo(-50, -60); // gesture wins
  fakeNow = 350;
  timers.flushRaf();
  timers.flushRaf();
  const s = ctrl.getState();
  assert.equal(s.tx, -50, 'flight cancelled; pan target holds');
  assert.equal(s.ty, -60);
});

test('flyToFit reaches the same target fitToContent computes, without narrowing clamp bounds', (t) => {
  let fakeNow = 0;
  const { ctrl, timers } = makeController(t, { extra: { now: () => fakeNow } });
  const wide = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
  const district = { minX: 0, minY: 0, maxX: 400, maxY: 300 };
  ctrl.setBounds(wide);

  // Reference: what an instant fit lands on (then restore state for the flight).
  ctrl.fitToContent(district, 'ref');
  timers.flushRaf();
  const ref = ctrl.getState();
  ctrl.setBounds(wide);
  ctrl.panTo(0, 0);
  timers.flushRaf();

  ctrl.flyToFit(district, 'district');
  fakeNow = 350;
  timers.flushRaf();
  timers.flushRaf();
  const flown = ctrl.getState();
  assert.equal(Math.round(flown.tx), Math.round(ref.tx));
  assert.equal(Math.round(flown.ty), Math.round(ref.ty));
  assert.equal(Number(flown.scale.toFixed(6)), Number(ref.scale.toFixed(6)));
  assert.deepEqual(ctrl._internals.bounds, wide, 'clamp bounds untouched by the flight');
});
