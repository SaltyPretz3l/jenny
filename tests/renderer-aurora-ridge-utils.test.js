// Aurora Ridge: the still painted scene and its controller
// (docs/plans/AURORA_THEME_2026-11-13.md).

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../renderer/shell/renderer-aurora-ridge-core.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const { createAuroraRidgeController } = require('../renderer/shell/renderer-aurora-ridge-utils.js');

// A canvas context that writes down every call with rounded arguments.
function createRecordingContext() {
  const calls = [];
  const gradient = { addColorStop() {} };
  const round = (value) => (typeof value === 'number' ? Math.round(value * 100) / 100 : value);
  const ctx = { calls, globalAlpha: 1, fillStyle: '', globalCompositeOperation: 'source-over' };
  ['save', 'restore', 'beginPath', 'closePath', 'fill', 'moveTo', 'lineTo', 'translate', 'rotate', 'ellipse',
    'fillRect', 'clearRect', 'setTransform'].forEach((name) => {
    ctx[name] = (...args) => { calls.push([name, ...args.map(round)]); };
  });
  ctx.createLinearGradient = () => gradient;
  return ctx;
}

function makeHost() {
  const host = {
    children: [],
    isConnected: true,
    style: { getPropertyValue: (name) => host.tokens[name] || '' },
    tokens: {},
    insertBefore(child) { host.children.unshift(child); child.parentNode = host; },
    removeChild(child) { host.children = host.children.filter((item) => item !== child); child.parentNode = null; },
  };
  return host;
}

function makeHarness() {
  const contexts = [];
  const timers = new Map();
  const frames = [];
  let nextTimer = 1;
  const documentRef = {
    hidden: false,
    createElement() {
      const classes = new Set();
      const canvas = {
        style: {}, width: 0, height: 0, parentNode: null,
        setAttribute() {},
        classList: { add: (name) => classes.add(name), contains: (name) => classes.has(name) },
        getContext() { const ctx = createRecordingContext(); contexts.push(ctx); return ctx; },
      };
      return canvas;
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const windowRef = {
    devicePixelRatio: 1,
    setTimeout(fn) { const id = nextTimer; nextTimer += 1; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  const frameRuntime = Object.assign({}, runtime, {
    requestFrame(fn) { frames.push(fn); return frames.length; },
    cancelFrame() {},
    scheduleCanvasReady(entry, options) {
      return runtime.scheduleCanvasReady(entry, Object.assign({}, options, {
        requestFrame: (fn) => { frames.push(fn); return frames.length; },
      }));
    },
  });
  return {
    contexts, timers, frames, documentRef, windowRef,
    runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); },
    create(extra) {
      return createAuroraRidgeController(Object.assign({ documentRef, windowRef, runtime: frameRuntime }, extra));
    },
  };
}

function contextFor(host, width, height) {
  const rect = { left: 0, top: 0, width, height };
  return {
    generation: 1,
    staged: false,
    hosts: [{ element: host, role: 'chat-left' }],
    layout: { sceneRect: rect, hostRects: [rect] },
  };
}

function paintedCalls(harness) {
  return harness.contexts.reduce((total, ctx) => total + ctx.calls.length, 0);
}

test('the same size and seed paint the same scene; another seed moves the trees', () => {
  const first = createRecordingContext();
  const second = createRecordingContext();
  const sceneA = core.paintScene(first, 900, 600, 7);
  const sceneB = core.paintScene(second, 900, 600, 7);
  assert.ok(first.calls.length > 5000, 'the painting is made of thousands of brush touches');
  assert.deepEqual(first.calls, second.calls);
  assert.deepEqual(sceneA.trees, sceneB.trees);
  assert.notDeepEqual(core.layoutScene(900, 600, 8).trees, sceneA.trees);
});

test('a larger window is painted with larger dabs, not many more of them', () => {
  const small = createRecordingContext();
  const large = createRecordingContext();
  core.paintScene(small, 1200, 800, 7);
  core.paintScene(large, 2400, 1600, 7);
  const ratio = large.calls.length / small.calls.length;
  assert.ok(ratio > 0.8 && ratio < 1.25, 'call count ratio for four times the area was ' + ratio.toFixed(2));
});

test('paintScene draws nothing for an empty size', () => {
  const ctx = createRecordingContext();
  assert.equal(core.paintScene(ctx, 0, 600, 7), null);
  assert.deepEqual(ctx.calls, []);
});

test('parseHexColor reads short and long hex and falls back on anything else', () => {
  assert.deepEqual(core.parseHexColor('#46e3a0', '#000000'), [70, 227, 160]);
  assert.deepEqual(core.parseHexColor(' #fa0 ', '#000000'), [255, 170, 0]);
  assert.deepEqual(core.parseHexColor('#fa08', '#000000'), [255, 170, 0]);
  assert.deepEqual(core.parseHexColor('#ffb85c80', '#000000'), [255, 184, 92]);
  assert.deepEqual(core.parseHexColor('rgb(1, 2, 3)', '#102030'), [16, 32, 48]);
  assert.deepEqual(core.parseHexColor('', '#102030'), [16, 32, 48]);
});

test('bind paints once and asks for no animation frame beyond revealing the canvas', () => {
  const harness = makeHarness();
  const host = makeHost();
  const controller = harness.create();
  controller.bind(contextFor(host, 800, 500));
  const state = controller._internals.inspect();
  assert.equal(state.paintCount, 1);
  assert.equal(host.children.length, 1);
  assert.equal(host.children[0].className, 'widget-aurora-ridge-canvas');
  assert.equal(harness.frames.length, 1, 'the only frame request is the one that reveals the canvas');
  harness.frames.shift()();
  assert.equal(host.children[0].classList.contains('surface-canvas-ready'), true);
  assert.equal(harness.frames.length, 0);
  assert.equal(harness.timers.size, 0);
  controller.dispose();
});

test('a refresh with nothing changed does not repaint', () => {
  const harness = makeHarness();
  const host = makeHost();
  const controller = harness.create();
  controller.bind(contextFor(host, 800, 500));
  const before = paintedCalls(harness);
  controller.refresh(contextFor(host, 800, 500));
  harness.runTimers();
  assert.equal(controller._internals.inspect().paintCount, 1);
  assert.equal(paintedCalls(harness), before);
  controller.dispose();
});

test('a resize repaints once, after the size settles', () => {
  const harness = makeHarness();
  const host = makeHost();
  const controller = harness.create();
  controller.bind(contextFor(host, 800, 500));
  controller.refresh(contextFor(host, 900, 520));
  controller.refresh(contextFor(host, 1000, 560));
  assert.equal(controller._internals.inspect().paintCount, 1, 'no repaint while the size is still changing');
  assert.equal(controller._internals.inspect().repaintPending, true);
  assert.equal(harness.timers.size, 1, 'the earlier wait was replaced, not stacked');
  assert.equal(host.children[0].style.width, '1000px', 'the old painting is stretched to the new size meanwhile');
  harness.runTimers();
  const state = controller._internals.inspect();
  assert.equal(state.paintCount, 2);
  assert.deepEqual([state.entries[0].w, state.entries[0].h], [1000, 560]);
  assert.equal(host.children[0].width, 1000);
  controller.dispose();
});

test('a changed light colour repaints; an unreadable one keeps the default', () => {
  const harness = makeHarness();
  const host = makeHost();
  const controller = harness.create();
  controller.bind(contextFor(host, 800, 500));
  host.tokens['--widget-aurora-ridge-lamp-color'] = '#ff0000';
  controller.refresh(contextFor(host, 800, 500));
  harness.runTimers();
  assert.equal(controller._internals.inspect().paintCount, 2);
  host.tokens['--widget-aurora-ridge-lamp-color'] = 'not a colour at all';
  controller.refresh(contextFor(host, 800, 500));
  harness.runTimers();
  assert.equal(controller._internals.inspect().paintCount, 3, 'back to the default lamp colour');
  controller.dispose();
});

test('a painting that fails is reported, leaves the context balanced and is tried again', () => {
  const harness = makeHarness();
  const host = makeHost();
  const faults = [];
  const controller = harness.create({ report: (fault) => faults.push(fault) });
  controller.bind(contextFor(host, 800, 500));
  const ctx = harness.contexts[0];
  const realEllipse = ctx.ellipse;
  ctx.ellipse = () => { throw new Error('canvas lost'); };
  controller.refresh(contextFor(host, 900, 500));
  harness.runTimers();
  assert.equal(faults.length, 1);
  assert.equal(faults[0].stage, 'frame');
  const saves = ctx.calls.filter((call) => call[0] === 'save').length;
  const restores = ctx.calls.filter((call) => call[0] === 'restore').length;
  assert.equal(saves, restores);
  assert.equal(controller._internals.inspect().entries[0].painted, false);
  ctx.ellipse = realEllipse;
  controller.refresh(contextFor(host, 900, 500));
  assert.equal(controller._internals.inspect().entries[0].painted, true, 'an unpainted host is painted at once');
  controller.dispose();
});

test('a second host is painted at once, not after the resize wait', () => {
  const harness = makeHarness();
  const first = makeHost();
  const second = makeHost();
  const controller = harness.create();
  controller.bind(contextFor(first, 800, 500));
  const rect = { left: 0, top: 0, width: 800, height: 500 };
  controller.refresh({
    generation: 1, staged: false,
    hosts: [{ element: first, role: 'chat-left' }, { element: second, role: 'chat-right' }],
    layout: { sceneRect: rect, hostRects: [rect, rect] },
  });
  assert.equal(controller._internals.inspect().paintCount, 2);
  assert.equal(harness.timers.size, 0);
  controller.dispose();
});

test('input is ignored and dispose removes the canvas and any pending repaint', () => {
  const harness = makeHarness();
  const host = makeHost();
  const controller = harness.create();
  controller.bind(contextFor(host, 800, 500));
  const before = paintedCalls(harness);
  controller.handleInput({ type: 'click', surfaceRole: 'chat-left', sceneX: 10, sceneY: 10, isPrimary: true });
  controller.handleInput({ type: 'move', surfaceRole: 'chat-left', sceneX: 40, sceneY: 40, isPrimary: true });
  assert.equal(paintedCalls(harness), before);
  assert.equal(typeof controller.setActivity, 'undefined');
  controller.refresh(contextFor(host, 900, 500));
  assert.equal(harness.timers.size, 1);
  controller.dispose();
  assert.equal(host.children.length, 0);
  assert.equal(harness.timers.size, 0);
  assert.equal(controller.getStatus().state, 'dormant');
});
