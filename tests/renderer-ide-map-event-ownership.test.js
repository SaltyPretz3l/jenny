'use strict';

/* tests/renderer-ide-map-event-ownership.test.js - red-first coverage for
 * renderer/features/renderer-ide-map-event-ownership.js (WIDE-029) plus the
 * behavioral regression gate for the consumers it was wired into
 * (renderer-ide-map-transform.js pointer pan + wheel zoom,
 * renderer-ide-map-a11y.js keyboard shortcuts). Uses jsdom directly. Always
 * dispose via t.after(), never dom.window.close(), per the project's
 * test-cleanup convention.
 *
 * Coverage maps to the WIDE-029 design points:
 *   1. classifyMapEventTarget() categories               -> pure unit tests
 *   2. ownsCanvasPointerEvent/-Keyboard/-WheelZoom gates  -> pure unit tests
 *   3. pointer-id normalization + mismatch gate           -> pure unit tests
 *      + a live transform.js mismatched-move/up regression test
 *   4. control-click does not pan/zoom                   -> transform tests
 *   5. contenteditable interaction does not pan           -> transform test
 *   6. empty-canvas drag still pans                       -> transform test
 *   7. Overview/findings never zoom or pan the map        -> transform test
 *   8. map keyboard shortcuts bail on control/contenteditable targets
 *      -> a11y tests
 *   9. production script order: event-ownership.js loads before every
 *      consumer -> script-order test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ownership = require('../renderer/features/renderer-ide-map-event-ownership');
const {
  classifyMapEventTarget,
  ownsCanvasPointerEvent,
  ownsMapKeyboardEvent,
  ownsMapWheelZoom,
  normalizePointerId,
  createPointerIdGate,
} = ownership;

const { createMapTransform } = require('../renderer/features/renderer-ide-map-transform');
const { createMapA11y } = require('../renderer/features/renderer-ide-map-a11y');

// ── Pure classification ─────────────────────────────────────────────────────

function domWithClasses() {
  const dom = new JSDOM(`
    <div id="viewport">
      <div id="content">
        <button id="node" data-map-node="a.js">a.js</button>
        <div id="district" data-map-district="lib">
          <div id="districtChild">nested dot region</div>
          <button id="districtButton">edit</button>
        </div>
        <div id="plain">plain decoration</div>
      </div>
      <div id="overview" class="ide-map-overview"><div id="overviewChild"></div></div>
      <div id="findings" class="ide-map-findings"><span id="findingsChild"></span></div>
      <div id="controls" class="ide-map-controls">
        <input id="filterInput" />
        <select id="lensSelect"><option value="a">a</option></select>
        <button id="genBtn">Generate</button>
      </div>
      <div id="rail" class="ide-map-activity-rail"><div id="railChild">activity feed</div></div>
      <div id="editable" contenteditable="true"></div>
      <div id="ariaBtn" role="button"></div>
    </div>
  `);
  return dom;
}

test('classifyMapEventTarget: node wins over everything else', () => {
  const dom = domWithClasses();
  const { document } = dom.window;
  assert.equal(classifyMapEventTarget(document.getElementById('node')), 'node');
});

test('classifyMapEventTarget: district classifies a target inside [data-map-district]', () => {
  const dom = domWithClasses();
  const { document } = dom.window;
  assert.equal(classifyMapEventTarget(document.getElementById('district')), 'district');
  assert.equal(classifyMapEventTarget(document.getElementById('districtChild')), 'district');
});

test('classifyMapEventTarget: an interactive control inside a district still classifies as control', () => {
  const dom = domWithClasses();
  const { document } = dom.window;
  // control/contenteditable/panel-surface categories are all more specific
  // than 'district' and must win even when nested inside one.
  assert.equal(classifyMapEventTarget(document.getElementById('districtButton')), 'control');
});

test('classifyMapEventTarget: panel surfaces classify by nearest ancestor, including the rail', () => {
  const dom = domWithClasses();
  const { document } = dom.window;
  assert.equal(classifyMapEventTarget(document.getElementById('overviewChild')), 'overview');
  assert.equal(classifyMapEventTarget(document.getElementById('findingsChild')), 'findings');
  assert.equal(classifyMapEventTarget(document.getElementById('railChild')), 'rail');
  assert.equal(classifyMapEventTarget(document.getElementById('rail')), 'rail');
});

test('classifyMapEventTarget: interactive controls classify as control', () => {
  const dom = domWithClasses();
  const { document } = dom.window;
  assert.equal(classifyMapEventTarget(document.getElementById('filterInput')), 'control');
  assert.equal(classifyMapEventTarget(document.getElementById('lensSelect')), 'control');
  assert.equal(classifyMapEventTarget(document.getElementById('genBtn')), 'control');
  assert.equal(classifyMapEventTarget(document.getElementById('ariaBtn')), 'control');
});

test('classifyMapEventTarget: contenteditable is its own category', () => {
  const dom = domWithClasses();
  const { document } = dom.window;
  assert.equal(classifyMapEventTarget(document.getElementById('editable')), 'contenteditable');
});

test('classifyMapEventTarget: falls back to canvas for plain decoration + the bare viewport', () => {
  const dom = domWithClasses();
  const { document } = dom.window;
  assert.equal(classifyMapEventTarget(document.getElementById('plain')), 'canvas');
  assert.equal(classifyMapEventTarget(document.getElementById('viewport')), 'canvas');
});

test('classifyMapEventTarget: null/undefined/non-element targets are canvas, never throw', () => {
  assert.equal(classifyMapEventTarget(null), 'canvas');
  assert.equal(classifyMapEventTarget(undefined), 'canvas');
  assert.equal(classifyMapEventTarget({}), 'canvas');
});

// ── Ownership gate booleans ─────────────────────────────────────────────────

test('ownsCanvasPointerEvent: true for canvas + node + district (node drag is retired) — rail/panels/controls all false', () => {
  const dom = domWithClasses();
  const { document } = dom.window;
  for (const id of ['plain', 'node', 'district', 'districtChild']) {
    assert.equal(ownsCanvasPointerEvent(document.getElementById(id)), true, `${id} should still pan`);
  }
  for (const id of ['districtButton', 'railChild', 'overviewChild', 'findingsChild', 'filterInput', 'editable']) {
    assert.equal(ownsCanvasPointerEvent(document.getElementById(id)), false, `${id} must not own canvas pan`);
  }
});

test('ownsMapKeyboardEvent: true for canvas + node + district, false for the rail and every control/panel/contenteditable', () => {
  const dom = domWithClasses();
  const { document } = dom.window;
  for (const id of ['plain', 'node', 'district', 'districtChild']) {
    assert.equal(ownsMapKeyboardEvent(document.getElementById(id)), true, `${id} should still trigger map shortcuts`);
  }
  for (const id of ['railChild', 'overviewChild', 'findingsChild', 'filterInput', 'editable']) {
    assert.equal(ownsMapKeyboardEvent(document.getElementById(id)), false, `${id} must not trigger map shortcuts`);
  }
});

test('ownsMapWheelZoom: true for canvas + node + district, false for the rail and every panel/control/contenteditable', () => {
  const dom = domWithClasses();
  const { document } = dom.window;
  for (const id of ['plain', 'node', 'district', 'districtChild']) {
    assert.equal(ownsMapWheelZoom(document.getElementById(id)), true, `${id} should still zoom`);
  }
  for (const id of ['railChild', 'overviewChild', 'findingsChild', 'filterInput', 'editable']) {
    assert.equal(ownsMapWheelZoom(document.getElementById(id)), false, `${id} must not zoom on wheel`);
  }
});

// ── Pointer id normalization + gate ──────────────────────────────────────────

test('normalizePointerId: passes through a real pointerId, defaults to "mouse" when absent', () => {
  assert.equal(normalizePointerId({ pointerId: 7 }), 7);
  assert.equal(normalizePointerId({ pointerId: null }), 'mouse');
  assert.equal(normalizePointerId({}), 'mouse');
  assert.equal(normalizePointerId(null), 'mouse');
});

test('createPointerIdGate: matches only the captured id; release clears it', () => {
  const gate = createPointerIdGate();
  assert.equal(gate.isActive(), false);
  assert.equal(gate.matches({ pointerId: 1 }), false, 'nothing captured yet');
  gate.capture(normalizePointerId({ pointerId: 1 }));
  assert.equal(gate.isActive(), true);
  assert.equal(gate.matches({ pointerId: 1 }), true, 'same id matches');
  assert.equal(gate.matches({ pointerId: 2 }), false, 'different id ignored');
  assert.equal(gate.matches({}), false, 'normalized "mouse" id does not match a captured real id');
  gate.release();
  assert.equal(gate.isActive(), false);
  assert.equal(gate.matches({ pointerId: 1 }), false, 'nothing captured after release');
});

// ── Production script order ─────────────────────────────────────────────────

test('production script graph loads event-ownership before every File Map consumer', (t) => {
  const root = path.resolve(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const consumers = [
    'renderer-ide-map-transform.js',
    'renderer-ide-map-atlas-layout.js',
    'renderer-ide-map-atlas-view.js',
    'renderer-ide-map-a11y.js',
    'renderer-ide-map-controller.js',
  ];
  const ownershipOffset = html.indexOf('renderer-ide-map-event-ownership.js');
  assert.ok(ownershipOffset >= 0, 'event-ownership module is declared in production index.html');
  for (const name of consumers) {
    const offset = html.indexOf(name);
    assert.ok(offset >= 0, `${name} is declared in production index.html`);
    assert.ok(ownershipOffset < offset, `event-ownership loads before ${name}`);
  }

  // Also verify it is actually eval-order-correct in a real script graph: eval
  // event-ownership.js first, then each consumer, and confirm each consumer's
  // global-lookup path actually finds the shared module (not the permissive
  // require() fallback, which is a Node-only test convenience unavailable to
  // a real <script> tag in the browser).
  const dom = new JSDOM('', { runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const evalFile = (name) => dom.window.eval(fs.readFileSync(path.join(root, 'renderer', 'features', name), 'utf8'));
  evalFile('renderer-ide-map-event-ownership.js');
  assert.equal(typeof dom.window.rendererIdeMapEventOwnership?.classifyMapEventTarget, 'function');
  for (const name of consumers) {
    if (name === 'renderer-ide-map-controller.js') continue; // pulls in many other siblings; order-only check above suffices
    evalFile(name);
  }
  assert.equal(typeof dom.window.rendererIdeMapTransform?.createMapTransform, 'function');
  assert.equal(typeof dom.window.rendererIdeMapAtlasLayout?.layout, 'function');
  assert.equal(typeof dom.window.rendererIdeMapAtlasView?.createAtlasView, 'function');
  assert.equal(typeof dom.window.rendererIdeMapA11y?.createMapA11y, 'function');
});

// ── Behavioral regression: transform.js pointer pan + wheel zoom ────────────

function pointerEvent(win, type, { clientX = 0, clientY = 0, pointerId = 1 } = {}) {
  const ev = new win.MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(ev, 'pointerId', { value: pointerId, configurable: true });
  return ev;
}

function wheelEvent(win, { deltaY = -120, clientX = 0, clientY = 0 } = {}) {
  const ev = new win.Event('wheel', { bubbles: true, cancelable: true });
  Object.defineProperties(ev, {
    deltaY: { value: deltaY, configurable: true },
    clientX: { value: clientX, configurable: true },
    clientY: { value: clientY, configurable: true },
  });
  return ev;
}

function setupTransformDom() {
  const dom = new JSDOM(`
    <div id="viewport">
      <div id="content"></div>
      <div id="controls" class="ide-map-controls"><button id="genBtn">Generate</button></div>
      <div id="overview" class="ide-map-overview"><div id="overviewInner">text</div></div>
      <div id="editable" contenteditable="true"></div>
    </div>
  `);
  const { document } = dom.window;
  const viewportEl = document.getElementById('viewport');
  const contentEl = document.getElementById('content');
  viewportEl.setPointerCapture = () => {};
  viewportEl.releasePointerCapture = () => {};
  viewportEl.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 });
  return { dom, viewportEl, contentEl };
}

function makeTimers() {
  let nextId = 1;
  const rafs = new Map();
  return {
    setTimeout: () => 0,
    clearTimeout: () => {},
    requestAnimationFrame(fn) { const id = nextId; nextId += 1; rafs.set(id, fn); return id; },
    cancelAnimationFrame(id) { rafs.delete(id); },
    flushRaf() {
      const fns = [...rafs.values()];
      rafs.clear();
      for (const fn of fns) fn(Date.now());
    },
  };
}

test('transform: pointerdown on a control does not start a pan', (t) => {
  const { dom, viewportEl } = setupTransformDom();
  const win = dom.window;
  t.after(() => dom.window.close());
  const timers = makeTimers();
  const ctrl = createMapTransform({ viewportEl, contentEl: win.document.getElementById('content'), timers, storage: null });
  t.after(() => ctrl.dispose());

  const genBtn = win.document.getElementById('genBtn');
  genBtn.dispatchEvent(pointerEvent(win, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 1 }));
  viewportEl.dispatchEvent(pointerEvent(win, 'pointermove', { clientX: 60, clientY: 60, pointerId: 1 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, { tx: 0, ty: 0 }, 'control-click never pans');
});

test('transform: pointerdown inside a contenteditable region does not start a pan', (t) => {
  const { dom, viewportEl } = setupTransformDom();
  const win = dom.window;
  t.after(() => dom.window.close());
  const timers = makeTimers();
  const ctrl = createMapTransform({ viewportEl, contentEl: win.document.getElementById('content'), timers, storage: null });
  t.after(() => ctrl.dispose());

  const editable = win.document.getElementById('editable');
  editable.dispatchEvent(pointerEvent(win, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 1 }));
  viewportEl.dispatchEvent(pointerEvent(win, 'pointermove', { clientX: 90, clientY: 90, pointerId: 1 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, { tx: 0, ty: 0 }, 'contenteditable interaction never pans');
});

test('transform: pointerdown on the empty canvas still pans', (t) => {
  const { dom, viewportEl } = setupTransformDom();
  const win = dom.window;
  t.after(() => dom.window.close());
  const timers = makeTimers();
  const ctrl = createMapTransform({ viewportEl, contentEl: win.document.getElementById('content'), timers, storage: null });
  t.after(() => ctrl.dispose());

  viewportEl.dispatchEvent(pointerEvent(win, 'pointerdown', { clientX: 10, clientY: 10, pointerId: 1 }));
  viewportEl.dispatchEvent(pointerEvent(win, 'pointermove', { clientX: 40, clientY: 25, pointerId: 1 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, { tx: 30, ty: 15 }, 'empty-canvas drag pans by the client delta');
});

test('transform: wheel over the Overview panel or a control never zooms (nested scroll stays native)', (t) => {
  const { dom, viewportEl } = setupTransformDom();
  const win = dom.window;
  t.after(() => dom.window.close());
  const timers = makeTimers();
  const ctrl = createMapTransform({ viewportEl, contentEl: win.document.getElementById('content'), timers, storage: null });
  t.after(() => ctrl.dispose());

  const overviewInner = win.document.getElementById('overviewInner');
  const wheelOverOverview = wheelEvent(win, { deltaY: -120, clientX: 5, clientY: 5 });
  let overviewPrevented = false;
  wheelOverOverview.preventDefault = () => { overviewPrevented = true; };
  overviewInner.dispatchEvent(wheelOverOverview);
  timers.flushRaf();
  assert.equal(overviewPrevented, false, 'wheel over Overview does not preventDefault (native scroll proceeds)');
  assert.equal(ctrl.getState().scale, 1, 'wheel over Overview never zooms the map');

  const genBtn = win.document.getElementById('genBtn');
  const wheelOverControl = wheelEvent(win, { deltaY: -120, clientX: 5, clientY: 5 });
  let controlPrevented = false;
  wheelOverControl.preventDefault = () => { controlPrevented = true; };
  genBtn.dispatchEvent(wheelOverControl);
  timers.flushRaf();
  assert.equal(controlPrevented, false, 'wheel over a control does not preventDefault');
  assert.equal(ctrl.getState().scale, 1, 'wheel over a control never zooms the map');
});

test('transform: wheel over the bare canvas still zooms', (t) => {
  const { dom, viewportEl } = setupTransformDom();
  const win = dom.window;
  t.after(() => dom.window.close());
  const timers = makeTimers();
  const ctrl = createMapTransform({ viewportEl, contentEl: win.document.getElementById('content'), timers, storage: null });
  t.after(() => ctrl.dispose());

  const wheel = wheelEvent(win, { deltaY: -120, clientX: 400, clientY: 300 });
  let prevented = false;
  wheel.preventDefault = () => { prevented = true; };
  viewportEl.dispatchEvent(wheel);
  timers.flushRaf();
  assert.equal(prevented, true, 'canvas wheel still preventDefaults');
  assert.ok(ctrl.getState().scale > 1, 'canvas wheel still zooms in');
});

test('transform: a pointermove/pointerup with a mismatched pointerId is ignored', (t) => {
  const { dom, viewportEl } = setupTransformDom();
  const win = dom.window;
  t.after(() => dom.window.close());
  const timers = makeTimers();
  const ctrl = createMapTransform({ viewportEl, contentEl: win.document.getElementById('content'), timers, storage: null });
  t.after(() => ctrl.dispose());

  viewportEl.dispatchEvent(pointerEvent(win, 'pointerdown', { clientX: 0, clientY: 0, pointerId: 5 }));
  // A second, unrelated pointer moving must not perturb the gesture.
  viewportEl.dispatchEvent(pointerEvent(win, 'pointermove', { clientX: 500, clientY: 500, pointerId: 9 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, { tx: 0, ty: 0 }, 'mismatched-id move ignored');

  // The real pointer moving still drives the pan.
  viewportEl.dispatchEvent(pointerEvent(win, 'pointermove', { clientX: 20, clientY: 10, pointerId: 5 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, { tx: 20, ty: 10 }, 'matching-id move still pans');

  // An unrelated pointerup must not end the real gesture.
  viewportEl.dispatchEvent(pointerEvent(win, 'pointerup', { clientX: 20, clientY: 10, pointerId: 9 }));
  viewportEl.dispatchEvent(pointerEvent(win, 'pointermove', { clientX: 40, clientY: 10, pointerId: 5 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, { tx: 40, ty: 10 }, 'mismatched-id up did not end the real gesture');

  // The real pointerup ends it: further moves under the same old id no longer pan.
  viewportEl.dispatchEvent(pointerEvent(win, 'pointerup', { clientX: 40, clientY: 10, pointerId: 5 }));
  viewportEl.dispatchEvent(pointerEvent(win, 'pointermove', { clientX: 999, clientY: 999, pointerId: 5 }));
  timers.flushRaf();
  assert.deepEqual({ tx: ctrl.getState().tx, ty: ctrl.getState().ty }, { tx: 40, ty: 10 }, 'gesture ended by the matching pointerup');
});

// ── Behavioral regression: a11y keyboard shortcuts ──────────────────────────

function fakeView(nodes) {
  const els = new Map();
  for (const n of nodes) {
    els.set(n.id, { tabIndex: -1, focus() {}, dataset: { mapNode: n.id } });
  }
  return {
    getRenderedSet: () => new Set(nodes.map((n) => n.id)),
    getNodeElement: (id) => els.get(id) || null,
    ensureTileFor: (id) => els.get(id) || null,
    setSpotlightSet: () => {},
  };
}

test('a11y: keydown targeting a control never navigates or preventDefaults', (t) => {
  const dom = new JSDOM(`
    <div id="viewport" tabindex="0">
      <div id="content"></div>
      <div id="controls" class="ide-map-controls"><input id="filterInput" /></div>
    </div>
  `);
  const win = dom.window;
  t.after(() => dom.window.close());
  const viewportEl = win.document.getElementById('viewport');
  const contentEl = win.document.getElementById('content');
  const nodes = [{ id: 'a.js', x: 0, y: 0 }, { id: 'b.js', x: 100, y: 0 }];
  const view = fakeView(nodes);
  const a11y = createMapA11y({
    viewportEl,
    contentEl,
    view,
    transform: { getState: () => ({ scale: 1, tx: 0, ty: 0 }), panTo: () => {} },
    getGraph: () => ({ nodes, edges: [] }),
  });
  t.after(() => a11y.dispose());

  const filterInput = win.document.getElementById('filterInput');
  const event = new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: filterInput, configurable: true });
  let prevented = false;
  event.preventDefault = () => { prevented = true; };
  viewportEl.dispatchEvent(event);
  assert.equal(prevented, false, 'arrow key typed into the filter is never intercepted');
});

test('a11y: keydown targeting a contenteditable region never navigates or preventDefaults', (t) => {
  const dom = new JSDOM(`
    <div id="viewport" tabindex="0">
      <div id="content"></div>
      <div id="editable" contenteditable="true"></div>
    </div>
  `);
  const win = dom.window;
  t.after(() => dom.window.close());
  const viewportEl = win.document.getElementById('viewport');
  const contentEl = win.document.getElementById('content');
  const nodes = [{ id: 'a.js', x: 0, y: 0 }];
  const view = fakeView(nodes);
  const a11y = createMapA11y({
    viewportEl,
    contentEl,
    view,
    transform: { getState: () => ({ scale: 1, tx: 0, ty: 0 }), panTo: () => {} },
    getGraph: () => ({ nodes, edges: [] }),
  });
  t.after(() => a11y.dispose());

  const editable = win.document.getElementById('editable');
  const event = new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: editable, configurable: true });
  let prevented = false;
  event.preventDefault = () => { prevented = true; };
  viewportEl.dispatchEvent(event);
  assert.equal(prevented, false, 'Escape typed into a contenteditable region is never intercepted');
});

test('a11y: keydown targeting the canvas/viewport itself still navigates', (t) => {
  const dom = new JSDOM(`
    <div id="viewport" tabindex="0">
      <div id="content"></div>
    </div>
  `);
  const win = dom.window;
  t.after(() => dom.window.close());
  const viewportEl = win.document.getElementById('viewport');
  const contentEl = win.document.getElementById('content');
  const nodes = [{ id: 'a.js', x: 0, y: 0 }, { id: 'b.js', x: 100, y: 0 }];
  const view = fakeView(nodes);
  const a11y = createMapA11y({
    viewportEl,
    contentEl,
    view,
    transform: { getState: () => ({ scale: 1, tx: 0, ty: 0 }), panTo: () => {} },
    getGraph: () => ({ nodes, edges: [] }),
  });
  t.after(() => a11y.dispose());

  const event = new win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: viewportEl, configurable: true });
  let prevented = false;
  event.preventDefault = () => { prevented = true; };
  viewportEl.dispatchEvent(event);
  assert.equal(prevented, true, 'arrow key on the bare viewport still navigates the map');
});
