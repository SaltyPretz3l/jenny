// new-test-file: a new surface (board canvas input: dragHandle and canvasSurface); the card and connector cases are in inventory-board-cards-connectors.test.js to stay under the line cap.
const assert = require('node:assert/strict');
const test = require('node:test');
const { JSDOM } = require('jsdom');

const dragHandle = require('../renderer/inventory/drag-handle');
const canvasSurface = require('../renderer/inventory/canvas-surface');
const boardCard = require('../renderer/inventory/board-card');

const VIEWPORT = { left: 100, top: 50, width: 800, height: 600 };

// One DOM per test. The primitives build elements with the global document, as in the app.
function makeEnv() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  globalThis.document = window.document;
  const frames = [];
  window.requestAnimationFrame = (callback) => { frames.push(callback); return frames.length; };
  window.cancelAnimationFrame = (id) => { frames[id - 1] = null; };
  return {
    window,
    flushFrames() { const pending = frames.splice(0); pending.forEach((cb) => cb && cb(0)); return pending.filter(Boolean).length; },
    pendingFrames: () => frames.filter(Boolean).length,
  };
}

function pointer(win, type, init = {}) {
  return new win.PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, isPrimary: true, button: 0, ...init });
}
function fire(win, target, type, init) { const event = pointer(win, type, init); target.dispatchEvent(event); return event; }
function key(win, target, name, init = {}) {
  const event = new win.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
function counter() {
  const calls = [];
  const fn = (...args) => { calls.push(args); };
  fn.calls = calls;
  return fn;
}
function surface(env, options = {}) {
  const canvas = canvasSurface(options);
  env.window.document.body.appendChild(canvas.element);
  canvas.element.getBoundingClientRect = () => ({
    ...VIEWPORT, x: VIEWPORT.left, y: VIEWPORT.top, right: VIEWPORT.left + VIEWPORT.width, bottom: VIEWPORT.top + VIEWPORT.height,
  });
  return canvas;
}
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message || 'value'}: ${actual} is not ${expected}`);
}

// ---------------------------------------------------------------- dragHandle

function handleFixture(options = {}) {
  const env = makeEnv();
  const element = env.window.document.createElement('div');
  env.window.document.body.appendChild(element);
  const cb = { onStart: counter(), onMove: counter(), onEnd: counter(), onCancel: counter() };
  const handle = dragHandle(element, { ...cb, ...options });
  return { env, element, cb, handle };
}

test('dragHandle fires nothing until the pointer moves past the threshold, so a click stays a click', () => {
  const { env, element, cb } = handleFixture();
  fire(env.window, element, 'pointerdown', { clientX: 10, clientY: 10 });
  fire(env.window, element, 'pointermove', { clientX: 11, clientY: 11 });
  assert.equal(cb.onStart.calls.length, 0);
  assert.equal(cb.onMove.calls.length, 0);
  fire(env.window, element, 'pointerup', { clientX: 11, clientY: 11 });
  assert.equal(cb.onEnd.calls.length, 0, 'a click is not a drag');

  fire(env.window, element, 'pointerdown', { clientX: 10, clientY: 10 });
  fire(env.window, element, 'pointermove', { clientX: 30, clientY: 15 });
  assert.equal(cb.onStart.calls.length, 1);
  const move = cb.onMove.calls[0][0];
  assert.equal(move.dx, 20);
  assert.equal(move.dy, 5);
  assert.equal(move.clientX, 30);
  assert.ok(move.event);
  fire(env.window, element, 'pointermove', { clientX: 40, clientY: 10 });
  assert.equal(cb.onStart.calls.length, 1);
  assert.equal(cb.onMove.calls[1][0].dx, 30, 'dx stays measured from the start point');
  fire(env.window, element, 'pointerup', { clientX: 40, clientY: 10 });
  assert.equal(cb.onEnd.calls.length, 1);
  assert.equal(cb.onEnd.calls[0][0].dx, 30);
});

test('dragHandle honours a custom threshold', () => {
  const { env, element, cb } = handleFixture({ threshold: 10 });
  fire(env.window, element, 'pointerdown', { clientX: 0, clientY: 0 });
  fire(env.window, element, 'pointermove', { clientX: 8, clientY: 0 });
  assert.equal(cb.onMove.calls.length, 0);
  fire(env.window, element, 'pointermove', { clientX: 12, clientY: 0 });
  assert.equal(cb.onMove.calls.length, 1);
});

test('dragHandle cancels on Escape and ignores the rest of the gesture', () => {
  const { env, element, cb } = handleFixture();
  fire(env.window, element, 'pointerdown', { clientX: 0, clientY: 0 });
  fire(env.window, element, 'pointermove', { clientX: 20, clientY: 0 });
  const escape = key(env.window, env.window.document, 'Escape');
  assert.equal(cb.onCancel.calls.length, 1);
  assert.equal(escape.defaultPrevented, true);
  fire(env.window, element, 'pointermove', { clientX: 50, clientY: 0 });
  fire(env.window, element, 'pointerup', { clientX: 50, clientY: 0 });
  assert.equal(cb.onMove.calls.length, 1);
  assert.equal(cb.onEnd.calls.length, 0);
  key(env.window, env.window.document, 'Escape');
  assert.equal(cb.onCancel.calls.length, 1, 'Escape outside a drag does nothing');
});

test('dragHandle ignores a non-primary button and a non-primary pointer', () => {
  const { env, element, cb } = handleFixture();
  for (const init of [{ button: 2 }, { button: 1 }, { isPrimary: false }]) {
    fire(env.window, element, 'pointerdown', { clientX: 0, clientY: 0, ...init });
    fire(env.window, element, 'pointermove', { clientX: 40, clientY: 0 });
    fire(env.window, element, 'pointerup', { clientX: 40, clientY: 0 });
  }
  assert.equal(cb.onStart.calls.length, 0);
  assert.equal(cb.onMove.calls.length, 0);
  assert.equal(cb.onEnd.calls.length, 0);
});

test('dragHandle dispose removes every listener it added and cancels a live drag', () => {
  const env = makeEnv();
  const element = env.window.document.createElement('div');
  env.window.document.body.appendChild(element);
  const added = new Map();
  const track = (target) => {
    const add = target.addEventListener.bind(target);
    const remove = target.removeEventListener.bind(target);
    target.addEventListener = (type, fn, opts) => { added.set(`${type}`, (added.get(type) || 0) + 1); add(type, fn, opts); };
    target.removeEventListener = (type, fn, opts) => { added.set(`${type}`, (added.get(type) || 0) - 1); remove(type, fn, opts); };
  };
  track(element);
  track(env.window.document);
  const cb = { onStart: counter(), onMove: counter(), onEnd: counter(), onCancel: counter() };
  const handle = dragHandle(element, cb);
  fire(env.window, element, 'pointerdown', { clientX: 0, clientY: 0 });
  fire(env.window, element, 'pointermove', { clientX: 20, clientY: 0 });
  handle.dispose();
  assert.equal(cb.onCancel.calls.length, 1, 'a live drag is cancelled');
  assert.deepEqual([...added].filter(([, count]) => count !== 0), [], 'every added listener is removed');
  fire(env.window, element, 'pointerdown', { clientX: 0, clientY: 0 });
  fire(env.window, element, 'pointermove', { clientX: 60, clientY: 0 });
  assert.equal(cb.onStart.calls.length, 1);
  assert.equal(cb.onMove.calls.length, 1);
  handle.dispose();
});

// ------------------------------------------------------------- canvasSurface

test('canvasSurface exposes an accessible focusable viewport with two layers sharing one transform', () => {
  const env = makeEnv();
  const canvas = surface(env);
  assert.equal(canvas.element.getAttribute('role'), 'application');
  assert.ok(canvas.element.getAttribute('aria-label'));
  assert.equal(canvas.element.tabIndex, 0);
  assert.equal(canvas.layer.parentNode, canvas.element);
  assert.equal(canvas.underlay.parentNode, canvas.element);
  canvas.setView({ x: 12, y: -7, zoom: 2 });
  const transform = 'translate(12px, -7px) scale(2)';
  assert.equal(canvas.layer.style.transform, transform);
  assert.equal(canvas.underlay.style.transform, transform);
  assert.deepEqual(canvas.getView(), { x: 12, y: -7, zoom: 2 });
  // The view's custom properties live on the childless grid: on the canvas they would
  // restyle every card on each pan frame.
  const grid = canvas.element.querySelector('.inv-board-grid');
  assert.equal(grid.childNodes.length, 0);
  assert.equal(grid.style.getPropertyValue('--inv-board-x'), '12px');
  assert.equal(grid.style.getPropertyValue('--inv-board-zoom'), '2');
  assert.equal(canvas.element.style.getPropertyValue('--inv-board-x'), '');
  // Zoomed out, every second dot goes each time the dots would stand closer than 16px on screen: the grid never
  // turns into a grey sheet. A coarser grid's dots are dots of the finer one, so none jumps. Zoomed in, nothing changes.
  const gridScale = (zoom) => { canvas.setView({ x: 0, y: 0, zoom }); return grid.style.getPropertyValue('--inv-board-grid-scale'); };
  assert.deepEqual([4, 2, 1, 0.67, 0.66, 0.5, 0.34, 0.33, 0.2, 0.1].map(gridScale), ['1', '1', '1', '1', '2', '2', '2', '4', '4', '8']);
  canvas.dispose();
});

test('canvasSurface clamps zoom to its limits and ignores a non-finite view', () => {
  const env = makeEnv();
  const canvas = surface(env);
  canvas.setView({ x: 0, y: 0, zoom: 100 });
  assert.equal(canvas.getView().zoom, 4);
  canvas.setView({ x: 0, y: 0, zoom: 0.0001 });
  assert.equal(canvas.getView().zoom, 0.1);
  canvas.setView({ x: Number.NaN, y: 5, zoom: Number.NaN });
  assert.deepEqual(canvas.getView(), { x: 0, y: 5, zoom: 0.1 }, 'a non-finite field keeps its current value');
  const narrow = surface(env, { minZoom: 0.5, maxZoom: 2 });
  narrow.setView({ x: 0, y: 0, zoom: 9 });
  assert.equal(narrow.getView().zoom, 2);
  narrow.setView({ x: 0, y: 0, zoom: 0.2 });
  assert.equal(narrow.getView().zoom, 0.5);
});

test('canvasSurface zoomAt keeps the board point under the pointer fixed, also at the zoom limit', () => {
  const env = makeEnv();
  const canvas = surface(env);
  canvas.setView({ x: 30, y: -20, zoom: 1.5 });
  const before = canvas.toBoard(400, 300);
  canvas.zoomAt({ x: 400, y: 300 }, 2);
  near(canvas.getView().zoom, 3, 'zoom');
  const after = canvas.toBoard(400, 300);
  near(after.x, before.x, 'board x');
  near(after.y, before.y, 'board y');
  canvas.zoomAt({ clientX: 650, clientY: 420 }, 1000);
  assert.equal(canvas.getView().zoom, 4);
  const target = canvas.toBoard(650, 420);
  canvas.zoomAt({ x: 650, y: 420 }, 0.5);
  const moved = canvas.toBoard(650, 420);
  near(moved.x, target.x, 'board x after zoom out');
  near(moved.y, target.y, 'board y after zoom out');
});

test('canvasSurface toBoard and toClient are exact inverses at three zooms', () => {
  const env = makeEnv();
  const canvas = surface(env);
  for (const zoom of [0.25, 1, 3]) {
    canvas.setView({ x: 37.5, y: -81.25, zoom });
    for (const [cx, cy] of [[100, 50], [433.3, 271.7], [-20, 900]]) {
      const board = canvas.toBoard(cx, cy);
      const client = canvas.toClient(board.x, board.y);
      near(client.x, cx, `client x at ${zoom}`);
      near(client.y, cy, `client y at ${zoom}`);
    }
  }
  canvas.setView({ x: 0, y: 0, zoom: 2 });
  assert.deepEqual(canvas.toBoard(140, 90), { x: 20, y: 20 });
});

test('canvasSurface: wheel pans and Ctrl+wheel zooms at the pointer', () => {
  const env = makeEnv();
  const canvas = surface(env);
  const wheel = (init) => {
    const event = new env.window.WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    canvas.element.dispatchEvent(event);
    return event;
  };
  const pan = wheel({ deltaX: 10, deltaY: 20, clientX: 300, clientY: 200 });
  assert.deepEqual(canvas.getView(), { x: -10, y: -20, zoom: 1 });
  assert.equal(pan.defaultPrevented, true);
  const point = canvas.toBoard(300, 200);
  const zoomed = wheel({ deltaY: -100, ctrlKey: true, clientX: 300, clientY: 200 });
  assert.ok(canvas.getView().zoom > 1, 'a negative delta zooms in');
  assert.equal(zoomed.defaultPrevented, true);
  near(canvas.toBoard(300, 200).x, point.x, 'point under the pointer x');
  near(canvas.toBoard(300, 200).y, point.y, 'point under the pointer y');
  const before = canvas.getView().zoom;
  wheel({ deltaY: 100, ctrlKey: true, clientX: 300, clientY: 200 });
  assert.ok(canvas.getView().zoom < before, 'a positive delta zooms out');
});

test('canvasSurface draws a marquee in board units and reports Shift as additive', () => {
  const env = makeEnv();
  const onMarquee = counter();
  const onBackgroundClick = counter();
  const canvas = surface(env, { onMarquee, onBackgroundClick });
  canvas.setView({ x: 20, y: 10, zoom: 2 });
  fire(env.window, canvas.element, 'pointerdown', { clientX: 200, clientY: 150 });
  fire(env.window, canvas.element, 'pointermove', { clientX: 300, clientY: 250 });
  assert.ok(canvas.element.querySelector('[data-board-marquee]:not([hidden])'), 'the rectangle is shown while dragging');
  fire(env.window, canvas.element, 'pointerup', { clientX: 300, clientY: 250 });
  assert.equal(onMarquee.calls.length, 1);
  assert.deepEqual(onMarquee.calls[0][0], { x: 40, y: 45, w: 50, h: 50 });
  assert.equal(onMarquee.calls[0][1].additive, false);
  assert.equal(onBackgroundClick.calls.length, 0, 'a drag is not a click');
  assert.equal(canvas.element.querySelector('[data-board-marquee]:not([hidden])'), null, 'the rectangle goes away');

  // dragging up and to the left still gives a positive rectangle
  fire(env.window, canvas.element, 'pointerdown', { clientX: 300, clientY: 250, shiftKey: true });
  fire(env.window, canvas.element, 'pointermove', { clientX: 200, clientY: 150, shiftKey: true });
  fire(env.window, canvas.element, 'pointerup', { clientX: 200, clientY: 150, shiftKey: true });
  assert.deepEqual(onMarquee.calls[1][0], { x: 40, y: 45, w: 50, h: 50 });
  assert.equal(onMarquee.calls[1][1].additive, true);
});

test('canvasSurface reports background click and double click in board units', () => {
  const env = makeEnv();
  const onBackgroundClick = counter();
  const onBackgroundDoubleClick = counter();
  const onMarquee = counter();
  const canvas = surface(env, { onBackgroundClick, onBackgroundDoubleClick, onMarquee });
  canvas.setView({ x: 0, y: 0, zoom: 2 });
  fire(env.window, canvas.underlay, 'pointerdown', { clientX: 140, clientY: 90 });
  fire(env.window, canvas.underlay, 'pointerup', { clientX: 140, clientY: 90 });
  assert.equal(onBackgroundClick.calls.length, 1);
  assert.equal(onBackgroundClick.calls[0][0].x, 20);
  assert.equal(onBackgroundClick.calls[0][0].y, 20);
  assert.equal(onMarquee.calls.length, 0);
  canvas.element.dispatchEvent(new env.window.MouseEvent('dblclick', { bubbles: true, clientX: 180, clientY: 110 }));
  assert.equal(onBackgroundDoubleClick.calls.length, 1);
  assert.equal(onBackgroundDoubleClick.calls[0][0].x, 40);
  assert.equal(onBackgroundDoubleClick.calls[0][0].y, 30);
});

test('canvasSurface: a gesture that starts on a card is never a background gesture', () => {
  const env = makeEnv();
  const onBackgroundClick = counter();
  const onBackgroundDoubleClick = counter();
  const onMarquee = counter();
  const canvas = surface(env, { onBackgroundClick, onBackgroundDoubleClick, onMarquee });
  const card = boardCard({ id: 'c1', kind: 'note', x: 0, y: 0, w: 100, h: 60, text: 'hello' });
  canvas.layer.appendChild(card);
  const inner = card.querySelector('[data-card-body]');
  for (const target of [card, inner]) {
    fire(env.window, target, 'pointerdown', { clientX: 150, clientY: 100 });
    fire(env.window, target, 'pointermove', { clientX: 260, clientY: 220 });
    fire(env.window, target, 'pointerup', { clientX: 260, clientY: 220 });
    fire(env.window, target, 'pointerdown', { clientX: 150, clientY: 100 });
    fire(env.window, target, 'pointerup', { clientX: 150, clientY: 100 });
    target.dispatchEvent(new env.window.MouseEvent('dblclick', { bubbles: true, clientX: 150, clientY: 100 }));
  }
  assert.equal(onMarquee.calls.length, 0);
  assert.equal(onBackgroundClick.calls.length, 0);
  assert.equal(onBackgroundDoubleClick.calls.length, 0);
  assert.deepEqual(canvas.getView(), { x: 0, y: 0, zoom: 1 });
});

test('canvasSurface pans with the middle button and with Space plus the primary button', () => {
  const env = makeEnv();
  const onMarquee = counter();
  const canvas = surface(env, { onMarquee });
  fire(env.window, canvas.element, 'pointerdown', { button: 1, clientX: 300, clientY: 300 });
  fire(env.window, canvas.element, 'pointermove', { button: 1, clientX: 340, clientY: 270 });
  fire(env.window, canvas.element, 'pointerup', { button: 1, clientX: 340, clientY: 270 });
  assert.deepEqual(canvas.getView(), { x: 40, y: -30, zoom: 1 });

  const space = key(env.window, canvas.element, ' ');
  assert.equal(space.defaultPrevented, true, 'Space on the canvas does not scroll the page');
  fire(env.window, canvas.element, 'pointerdown', { clientX: 300, clientY: 300 });
  fire(env.window, canvas.element, 'pointermove', { clientX: 310, clientY: 320 });
  fire(env.window, canvas.element, 'pointerup', { clientX: 310, clientY: 320 });
  assert.deepEqual(canvas.getView(), { x: 50, y: -10, zoom: 1 });
  assert.equal(onMarquee.calls.length, 0);
  canvas.element.dispatchEvent(new env.window.KeyboardEvent('keyup', { key: ' ', bubbles: true }));
  fire(env.window, canvas.element, 'pointerdown', { clientX: 300, clientY: 300 });
  fire(env.window, canvas.element, 'pointermove', { clientX: 340, clientY: 340 });
  fire(env.window, canvas.element, 'pointerup', { clientX: 340, clientY: 340 });
  assert.equal(onMarquee.calls.length, 1, 'after Space is released a primary drag is a marquee again');
});

test('canvasSurface pans with the right button held, over a card too; the menu of that release is held back, a plain right click and a field keep theirs', () => {
  const env = makeEnv();
  const canvas = surface(env);
  const card = boardCard({ id: 'c1', kind: 'note', x: 0, y: 0, w: 100, h: 60, text: 'hello' });
  canvas.layer.appendChild(card);
  const menu = (target) => {
    const event = new env.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event.defaultPrevented;
  };
  fire(env.window, canvas.element, 'pointerdown', { button: 2, clientX: 300, clientY: 300 });
  assert.equal(canvas.element.hasAttribute('data-panning'), true);
  fire(env.window, canvas.element, 'pointermove', { button: 2, clientX: 340, clientY: 270 });
  fire(env.window, canvas.element, 'pointerup', { button: 2, clientX: 340, clientY: 270 });
  assert.deepEqual(canvas.getView(), { x: 40, y: -30, zoom: 1 });
  assert.equal(canvas.element.hasAttribute('data-panning'), false);
  assert.equal(menu(env.window.document.body), true, 'the menu of the release is held back, wherever the pointer ended');
  assert.equal(menu(canvas.element), false, 'once only');

  fire(env.window, card, 'pointerdown', { button: 2, clientX: 60, clientY: 40 });
  fire(env.window, card, 'pointermove', { button: 2, clientX: 70, clientY: 60 });
  fire(env.window, card, 'pointerup', { button: 2, clientX: 70, clientY: 60 });
  assert.deepEqual(canvas.getView(), { x: 50, y: -10, zoom: 1 }, 'a card under the pointer does not stop it');
  fire(env.window, canvas.element, 'pointerdown', { clientX: 300, clientY: 300 });
  fire(env.window, canvas.element, 'pointerup', { clientX: 300, clientY: 300 });
  assert.equal(menu(canvas.element), false, 'a menu that never came is not owed to the next press');

  fire(env.window, canvas.element, 'pointerdown', { button: 2, clientX: 300, clientY: 300 });
  fire(env.window, canvas.element, 'pointerup', { button: 2, clientX: 301, clientY: 300 });
  assert.deepEqual(canvas.getView(), { x: 50, y: -10, zoom: 1 });
  assert.equal(menu(canvas.element), false, 'a right click that did not move keeps its menu');

  const field = env.window.document.createElement('textarea');
  card.appendChild(field);
  fire(env.window, field, 'pointerdown', { button: 2, clientX: 60, clientY: 40 });
  fire(env.window, field, 'pointermove', { button: 2, clientX: 160, clientY: 140 });
  fire(env.window, field, 'pointerup', { button: 2, clientX: 160, clientY: 140 });
  assert.deepEqual(canvas.getView(), { x: 50, y: -10, zoom: 1 }, 'a text field keeps its right button');
  assert.equal(menu(field), false);
  canvas.dispose();
});

test('canvasSurface fit handles an empty and a non-empty rectangle', () => {
  const env = makeEnv();
  const canvas = surface(env);
  canvas.setView({ x: 99, y: 99, zoom: 3 });
  assert.deepEqual(canvas.fit(null), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(canvas.getView(), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(canvas.fit({ x: 0, y: 0, w: 0, h: 0 }, 40), { x: 0, y: 0, zoom: 1 });

  const bounds = { x: 0, y: 0, w: 1600, h: 1200 };
  const view = canvas.fit(bounds, 50);
  near(view.zoom, 500 / 1200, 'zoom fits the tighter axis');
  assert.deepEqual(canvas.getView(), view);
  const topLeft = canvas.toClient(0, 0);
  const bottomRight = canvas.toClient(1600, 1200);
  assert.ok(topLeft.x >= VIEWPORT.left + 50 - 1e-9 && topLeft.y >= VIEWPORT.top + 50 - 1e-9);
  assert.ok(bottomRight.x <= VIEWPORT.left + VIEWPORT.width - 50 + 1e-9);
  near(bottomRight.y, VIEWPORT.top + VIEWPORT.height - 50, 'the tighter axis touches the padding');
  near(topLeft.x - VIEWPORT.left, VIEWPORT.left + VIEWPORT.width - bottomRight.x, 'the other axis is centred');

  const small = canvas.fit({ x: 10, y: 10, w: 40, h: 20 }, 50);
  assert.equal(small.zoom, 1, 'a small board is not magnified past 100%');
});

test('canvasSurface reports view changes at most once per animation frame', () => {
  const env = makeEnv();
  const onViewChange = counter();
  const canvas = surface(env, { onViewChange });
  canvas.setView({ x: 1, y: 1, zoom: 1 });
  canvas.setView({ x: 2, y: 2, zoom: 1 });
  canvas.zoomAt({ x: 300, y: 300 }, 1.2);
  assert.equal(onViewChange.calls.length, 0, 'nothing fires before the frame');
  assert.equal(env.pendingFrames(), 1);
  env.flushFrames();
  assert.equal(onViewChange.calls.length, 1);
  assert.deepEqual(onViewChange.calls[0][0], canvas.getView());
  assert.equal(env.flushFrames(), 0, 'no frame is left over');
  canvas.setView({ x: 5, y: 5, zoom: 1 }, { silent: true });
  assert.equal(env.pendingFrames(), 0, 'a silent change schedules nothing');
});

test('canvasSurface dispose removes its listeners and cancels a pending notification', () => {
  const env = makeEnv();
  const onViewChange = counter();
  const canvas = surface(env, { onViewChange });
  canvas.setView({ x: 3, y: 3, zoom: 1 });
  canvas.dispose();
  env.flushFrames();
  assert.equal(onViewChange.calls.length, 0);
  canvas.element.dispatchEvent(new env.window.WheelEvent('wheel', { deltaY: 50, bubbles: true, cancelable: true }));
  assert.deepEqual(canvas.getView(), { x: 3, y: 3, zoom: 1 });
});
