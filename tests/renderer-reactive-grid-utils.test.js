const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const reactiveGridUtils = require('../renderer/shell/renderer-reactive-grid-utils.js');
const reactiveGridCore = require('../renderer/shell/renderer-reactive-grid-core.js');
const surfaceEffectRuntime = require('../renderer/shell/renderer-surface-effect-runtime.js');

function createResizeObserverHarness() {
  const instances = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = [];
      this.unobserveCalls = [];
      this.disconnectCalls = 0;
      instances.push(this);
    }
    observe(target) { this.observeCalls.push(target); }
    unobserve(target) { this.unobserveCalls.push(target); }
    disconnect() { this.disconnectCalls += 1; }
  }
  return { FakeResizeObserver, instances };
}

function createRafHarness() {
  let now = 0;
  let nextId = 1;
  const callbacks = new Map();
  return {
    requestAnimationFrame(callback) {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) { callbacks.delete(id); },
    flush(ms = 16) {
      const pending = Array.from(callbacks.values());
      callbacks.clear();
      now += ms;
      pending.forEach((callback) => callback(now));
      return now;
    },
    get size() { return callbacks.size; },
    get now() { return now; },
  };
}

function createMediaQueryList(initialMatches) {
  const listeners = new Set();
  return {
    matches: Boolean(initialMatches),
    addEventListener(eventName, listener) {
      if (eventName === 'change') listeners.add(listener);
    },
    removeEventListener(eventName, listener) {
      if (eventName === 'change') listeners.delete(listener);
    },
    dispatch(matches) {
      this.matches = Boolean(matches);
      Array.from(listeners).forEach((listener) => listener({ matches: this.matches }));
    },
    listenerCount() { return listeners.size; },
  };
}

function createCanvasRecorder() {
  const frames = [];
  const transforms = [];
  let currentFrame = null;
  let currentArc = null;
  const state = { fillStyle: '', globalAlpha: 1, shadowBlur: 0, shadowColor: '' };
  return {
    frames,
    transforms,
    setTransform(...args) { transforms.push(args); },
    clearRect() {
      currentFrame = { dots: [] };
      frames.push(currentFrame);
    },
    beginPath() { currentArc = null; },
    arc(x, y, radius) { currentArc = { x, y, radius }; },
    fill() {
      if (!currentFrame || !currentArc) return;
      currentFrame.dots.push({
        x: currentArc.x,
        y: currentArc.y,
        radius: currentArc.radius,
        fillStyle: state.fillStyle,
        globalAlpha: state.globalAlpha,
        shadowBlur: state.shadowBlur,
        shadowColor: state.shadowColor,
      });
    },
    get fillStyle() { return state.fillStyle; },
    set fillStyle(value) { state.fillStyle = value; },
    get globalAlpha() { return state.globalAlpha; },
    set globalAlpha(value) { state.globalAlpha = value; },
    get shadowBlur() { return state.shadowBlur; },
    set shadowBlur(value) { state.shadowBlur = value; },
    get shadowColor() { return state.shadowColor; },
    set shadowColor(value) { state.shadowColor = value; },
  };
}

function installCanvasRecorder(window) {
  const contexts = new Map();
  const proto = window.HTMLCanvasElement.prototype;
  const originalGetContext = proto.getContext;
  proto.getContext = function getContext() {
    if (!contexts.has(this)) contexts.set(this, createCanvasRecorder());
    return contexts.get(this);
  };
  return {
    contexts,
    restore() { proto.getContext = originalGetContext; },
  };
}

function setRect(node, { left = 0, top = 0, width = 240, height = 160 } = {}) {
  let callCount = 0;
  node.getBoundingClientRect = () => {
    callCount += 1;
    return { left, top, width, height, right: left + width, bottom: top + height };
  };
  return { get callCount() { return callCount; } };
}

function getLastFrame(contexts, canvas) {
  const ctx = contexts.get(canvas);
  return ctx && ctx.frames.length ? ctx.frames.at(-1) : null;
}

function getFrameIntensity(frame) {
  if (!frame || !frame.dots.length) return 0;
  return frame.dots.reduce(
    (max, dot) => Math.max(max, dot.globalAlpha + dot.shadowBlur * 0.02),
    0,
  );
}

function getFrameSignature(frame) {
  if (!frame || !frame.dots.length) return '';
  return frame.dots.slice(0, 4).map((dot) => (
    `${Math.round(dot.x * 10)}:${Math.round(dot.y * 10)}:${Math.round(dot.radius * 100)}`
  )).join('|');
}

function trackCanvasDimensionWrites(canvas) {
  let widthValue = canvas.width;
  let heightValue = canvas.height;
  let widthWrites = 0;
  let heightWrites = 0;
  Object.defineProperty(canvas, 'width', {
    configurable: true,
    get() { return widthValue; },
    set(value) { widthWrites += 1; widthValue = Number(value); },
  });
  Object.defineProperty(canvas, 'height', {
    configurable: true,
    get() { return heightValue; },
    set(value) { heightWrites += 1; heightValue = Number(value); },
  });
  return {
    get widthWrites() { return widthWrites; },
    get heightWrites() { return heightWrites; },
  };
}

function applyReactiveGridStyles(host) {
  host.style.setProperty('--reactive-grid-cell-size', '26');
  host.style.setProperty('--reactive-grid-hit-radius', '112');
  host.style.setProperty('--reactive-grid-strength', '1');
  host.style.setProperty('--reactive-grid-idle-amplitude', '0.28');
  host.style.setProperty('--reactive-grid-motion-scale', '1');
  host.style.setProperty('--widget-reactive-grid-dot-idle', 'rgba(157, 197, 255, 0.18)');
  host.style.setProperty('--widget-reactive-grid-dot-active', 'rgba(111, 210, 255, 0.82)');
  host.style.setProperty('--widget-reactive-grid-dot-glow', 'rgba(109, 130, 255, 0.28)');
}

function rectSnapshot(host) {
  const rect = host.getBoundingClientRect();
  return Object.freeze({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    right: rect.right,
    bottom: rect.bottom,
  });
}

function buildContext(hostSpecs, {
  generation = 1,
  staged = false,
  surface = 'chat',
  sceneRect = null,
  paintOcclusionRects = [],
  spawnAvoidanceRects = [],
} = {}) {
  const hosts = Object.freeze(hostSpecs.map(({ element, role }) => Object.freeze({ element, role })));
  const hostRects = Object.freeze(hosts.map(({ element }) => rectSnapshot(element)));
  const emptyRects = Object.freeze([]);
  return Object.freeze({
    generation,
    staged,
    surface,
    hosts,
    layout: Object.freeze({
      revision: generation,
      sceneRect: sceneRect || hostRects[0]
        || Object.freeze({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
      hostRects,
      interactionBlockRects: emptyRects,
      paintOcclusionRects: Object.freeze(paintOcclusionRects),
      spawnAvoidanceRects: Object.freeze(spawnAvoidanceRects),
    }),
  });
}

function normalizedInput(type, {
  role = 'chat-left',
  x = 120,
  y = 80,
  sceneX = x,
  sceneY = y,
  timeStamp = 16,
} = {}) {
  return {
    type,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    buttons: 0,
    pressure: 0,
    timeStamp,
    clientX: x,
    clientY: y,
    surfaceRole: role,
    localX: x,
    localY: y,
    sceneX,
    sceneY,
    generation: 1,
  };
}

function createController({ document, mediaQuery, report } = {}) {
  return reactiveGridUtils.createReactiveGridController({
    effectId: 'reactive-grid',
    documentRef: document,
    reducedMotionQuery: mediaQuery,
    runtime: surfaceEffectRuntime,
    rendererLaunchSeed: 4242,
    report,
  });
}

function bindAndPrime(controller, rafHarness, hostSpecs, options) {
  const context = buildContext(hostSpecs, options);
  controller.bind(context);
  rafHarness.flush(16);
  return context;
}

function withReactiveGridGlobals(callback) {
  const saved = {
    window: global.window,
    document: global.document,
    performance: global.performance,
    ResizeObserver: global.ResizeObserver,
    requestAnimationFrame: global.requestAnimationFrame,
    cancelAnimationFrame: global.cancelAnimationFrame,
  };
  const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true, url: 'http://localhost/' });
  const { window } = dom;
  const mediaQuery = createMediaQueryList(false);
  const resizeHarness = createResizeObserverHarness();
  const rafHarness = createRafHarness();
  const canvasHarness = installCanvasRecorder(window);

  window.devicePixelRatio = 2;
  window.requestAnimationFrame = rafHarness.requestAnimationFrame;
  window.cancelAnimationFrame = rafHarness.cancelAnimationFrame;
  global.window = window;
  global.document = window.document;
  global.performance = { now: () => rafHarness.now };
  global.ResizeObserver = resizeHarness.FakeResizeObserver;
  global.requestAnimationFrame = rafHarness.requestAnimationFrame;
  global.cancelAnimationFrame = rafHarness.cancelAnimationFrame;

  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return Promise.resolve();
    cleanedUp = true;
    canvasHarness.restore();
    Object.keys(saved).forEach((key) => {
      if (saved[key] === undefined) delete global[key];
      else global[key] = saved[key];
    });
    return dom.window.close();
  }

  return Promise.resolve(callback({
    window,
    document: window.document,
    mediaQuery,
    resizeHarness,
    rafHarness,
    canvasHarness,
    cleanup,
  })).finally(cleanup);
}

test('resolveGridGeometry caps a large viewport at the 1500-dot primitive budget', () => {
  const geometry = reactiveGridCore.resolveGridGeometry(7680, 4320, 12, reactiveGridCore.MAX_GRID_DOTS);
  assert.ok(geometry.dotCount > 0);
  assert.ok(geometry.dotCount <= 1500, 'large viewport must stay inside the global primitive cap');
  assert.equal(geometry.dotCount, geometry.cols * geometry.rows);
});

test('runtime token schemas accept px lengths and reject trailing garbage', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness }) => {
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    host.style.setProperty('--reactive-grid-cell-size', '12garbage');
    setRect(host, { width: 240, height: 160 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    const context = bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    assert.equal(controller._internals.inspect().entries[0].dotCount, 70, 'malformed length uses the 24px floor');

    host.style.setProperty('--reactive-grid-cell-size', '30px');
    controller.refresh(context);
    assert.equal(controller._internals.inspect().entries[0].dotCount, 40, 'px length is parsed by the runtime schema');
    controller.dispose();
  })
));

test('reactive grid native context injects one canvas per explicit host and reconciles refresh hosts', () => (
  withReactiveGridGlobals(({ document, mediaQuery, resizeHarness, rafHarness }) => {
    const first = document.createElement('section');
    const second = document.createElement('section');
    applyReactiveGridStyles(first);
    applyReactiveGridStyles(second);
    setRect(first, { width: 240, height: 140 });
    setRect(second, { left: 240, width: 220, height: 120 });
    document.body.append(first, second);
    const controller = createController({ document, mediaQuery });

    bindAndPrime(controller, rafHarness, [{ element: first, role: 'chat-left' }]);
    assert.equal(first.querySelectorAll('.widget-reactive-grid-canvas').length, 1);
    assert.equal(first.querySelector('canvas').getAttribute('aria-hidden'), 'true');
    assert.equal(second.querySelectorAll('canvas').length, 0);
    assert.equal(resizeHarness.instances.length, 0, 'manager-owned layout snapshots replace local observers');

    controller.refresh(buildContext([
      { element: first, role: 'chat-left' },
      { element: second, role: 'chat-right' },
    ], { generation: 2 }));
    rafHarness.flush(16);
    assert.equal(second.querySelectorAll('.widget-reactive-grid-canvas').length, 1);

    controller.refresh(buildContext([{ element: second, role: 'chat-right' }], { generation: 3 }));
    assert.equal(first.querySelectorAll('canvas').length, 0);
    controller.dispose();
  })
));

test('reactive grid animates idly and intensifies around normalized pointer input without layout reads', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness, canvasHarness }) => {
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    const rectTracker = setRect(host, { left: 20, top: 16, width: 260, height: 180 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);

    const canvas = host.querySelector('canvas');
    const firstSignature = getFrameSignature(getLastFrame(canvasHarness.contexts, canvas));
    const layoutReadsAfterBind = rectTracker.callCount;
    for (let i = 0; i < 12; i += 1) rafHarness.flush(24);
    const idleFrame = getLastFrame(canvasHarness.contexts, canvas);
    assert.notEqual(getFrameSignature(idleFrame), firstSignature, 'idle field advances');
    assert.equal(rectTracker.callCount, layoutReadsAfterBind, 'frames use context geometry');

    const idleIntensity = getFrameIntensity(idleFrame);
    controller.handleInput(normalizedInput('move', { x: 160, y: 80, sceneX: 180, sceneY: 96 }));
    for (let i = 0; i < 40; i += 1) rafHarness.flush(16);
    assert.ok(getFrameIntensity(getLastFrame(canvasHarness.contexts, canvas)) > idleIntensity);
    assert.equal(rectTracker.callCount, layoutReadsAfterBind, 'input uses router-normalized coordinates');
    controller.dispose();
    assert.equal(rafHarness.size, 0);
  })
));

test('reactive grid routes valid gutter input into one shared scene and repaints both viewports', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness, canvasHarness }) => {
    mediaQuery.matches = true;
    const left = document.createElement('section');
    const right = document.createElement('section');
    applyReactiveGridStyles(left);
    applyReactiveGridStyles(right);
    setRect(left, { width: 120, height: 180 });
    setRect(right, { left: 260, width: 120, height: 180 });
    document.body.append(left, right);
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, [
      { element: left, role: 'chat-left' },
      { element: right, role: 'chat-right' },
    ]);
    const leftCtx = canvasHarness.contexts.get(left.querySelector('canvas'));
    const rightCtx = canvasHarness.contexts.get(right.querySelector('canvas'));
    const leftBefore = leftCtx.frames.length;
    const rightBefore = rightCtx.frames.length;

    controller.handleInput(normalizedInput('move', { role: 'chat-left', x: 60, y: 84 }));
    assert.ok(leftCtx.frames.length > leftBefore);
    assert.ok(rightCtx.frames.length > rightBefore);
    const leftAfter = leftCtx.frames.length;
    const rightAfter = rightCtx.frames.length;
    controller.handleInput(normalizedInput('move', { role: 'chat-right', x: 60, y: 84 }));
    assert.ok(rightCtx.frames.length > rightAfter);
    assert.ok(leftCtx.frames.length > leftAfter);
    controller.dispose();
  })
));

test('normalized move activates the field and leave decays it', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness, canvasHarness }) => {
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 260, height: 180 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    const canvas = host.querySelector('canvas');
    for (let i = 0; i < 8; i += 1) rafHarness.flush(16);
    const idle = getFrameIntensity(getLastFrame(canvasHarness.contexts, canvas));

    controller.handleInput(normalizedInput('move', { x: 130, y: 90 }));
    for (let i = 0; i < 40; i += 1) rafHarness.flush(16);
    const hover = getFrameIntensity(getLastFrame(canvasHarness.contexts, canvas));
    assert.ok(hover > idle);
    controller.handleInput(normalizedInput('leave', { x: 130, y: 90 }));
    for (let i = 0; i < 60; i += 1) rafHarness.flush(16);
    assert.ok(getFrameIntensity(getLastFrame(canvasHarness.contexts, canvas)) < hover);
    controller.dispose();
  })
));

test('first-token waits for double-rAF and aborts when the activity epoch changes', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness }) => {
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 260, height: 180 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    controller.setActivity({
      scopeEpoch: 1, phase: 'streaming', phaseRevision: 1, targetEnergy: 0.46, attentionScale: 1,
    });

    controller.handleActivityImpulse({
      scopeEpoch: 1, sequence: 1, kind: 'first-token', timeStamp: rafHarness.now,
    });
    assert.equal(controller._internals.inspect().entries[0].impulseCount, 0);
    rafHarness.flush(16);
    assert.equal(controller._internals.inspect().entries[0].impulseCount, 0, 'outer rAF does not gesture');
    rafHarness.flush(16);
    assert.equal(controller._internals.inspect().entries[0].impulseCount, 1, 'inner rAF creates one gesture');
    assert.equal(controller._internals.inspect().entries[0].impulseOrigins[0].direction, 'outward',
      'first-token releases outward after the preflight inward gather (delight pass 2026-07-22)');

    controller.handleActivityImpulse({
      scopeEpoch: 1, sequence: 2, kind: 'first-token', timeStamp: rafHarness.now,
    });
    controller.setActivity({
      scopeEpoch: 2, phase: 'streaming', phaseRevision: 2, targetEnergy: 0.46, attentionScale: 1,
    });
    rafHarness.flush(16);
    rafHarness.flush(16);
    assert.equal(controller._internals.inspect().entries[0].impulseCount, 1, 'epoch change aborts pending gesture');

    controller.handleActivityImpulse({
      scopeEpoch: 2, sequence: 3, kind: 'first-token', timeStamp: rafHarness.now,
    });
    controller.handleActivityImpulse({ scopeEpoch: 2, sequence: 4, kind: 'cancel', timeStamp: rafHarness.now });
    rafHarness.flush(16);
    rafHarness.flush(16);
    assert.equal(controller._internals.inspect().entries[0].impulseCount, 0, 'cancel removes pending gestures');

    controller.handleActivityImpulse({
      scopeEpoch: 2, sequence: 5, kind: 'first-token', timeStamp: rafHarness.now,
    });
    controller.setActivity({
      scopeEpoch: 2, phase: 'failed', phaseRevision: 3, targetEnergy: 0.04, attentionScale: 1,
    });
    rafHarness.flush(16);
    rafHarness.flush(16);
    assert.equal(controller._internals.inspect().entries[0].impulseCount, 0, 'failed phase removes pending gestures');
    controller.dispose();
  })
));

test('hidden documents do no static work and disconnected hosts cannot keep the loop ready', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness, canvasHarness }) => {
    mediaQuery.matches = true;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 240, height: 160 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    controller.bind(buildContext([{ element: host, role: 'chat-left' }]));
    const ctx = canvasHarness.contexts.get(host.querySelector('canvas'));
    assert.equal(ctx.frames.length, 0, 'hidden bind performs no static draw');
    controller.handleInput(normalizedInput('move'));
    assert.equal(ctx.frames.length, 0, 'hidden input performs no static draw');

    host.remove();
    assert.equal(controller.getStatus().state, 'dormant');
    mediaQuery.dispatch(false);
    assert.equal(rafHarness.size, 0, 'a disconnected host cannot restart the loop');
    controller.dispose();
  })
));

test('a reduced-motion switch while hidden paints a fresh static frame on resume', () => (
  withReactiveGridGlobals(({ window, document, mediaQuery, rafHarness, canvasHarness }) => {
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 240, height: 160 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    const ctx = canvasHarness.contexts.get(host.querySelector('canvas'));
    rafHarness.flush(16);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new window.Event('visibilitychange'));
    mediaQuery.dispatch(true);
    const framesWhileHidden = ctx.frames.length;
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new window.Event('visibilitychange'));
    assert.ok(ctx.frames.length > framesWhileHidden,
      'resume under reduced motion repaints instead of leaving stale animated pixels');
    assert.equal(rafHarness.size, 0, 'reduced motion never restarts the loop');
    controller.dispose();
  })
));

test('runtime long-gap reset clears pointer, velocity, and active impulses', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness }) => {
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 260, height: 180 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    controller.handleInput(normalizedInput('move', { x: 80, y: 90, timeStamp: 20 }));
    controller.handleInput(normalizedInput('move', { x: 190, y: 90, timeStamp: 36 }));
    controller.handleInput(normalizedInput('click', { x: 190, y: 90, timeStamp: 36 }));
    rafHarness.flush(16);
    const active = controller._internals.inspect().entries[0];
    assert.equal(active.pointerActive, true);
    assert.ok(active.maxAbsDotVelocity > 0);
    assert.equal(active.impulseCount, 1);

    rafHarness.flush(600);
    const reset = controller._internals.inspect().entries[0];
    assert.equal(reset.pointerActive, false);
    assert.equal(reset.pointerVelocityX, 0);
    assert.equal(reset.pointerVelocityY, 0);
    assert.equal(reset.maxAbsDotVelocity, 0);
    assert.equal(reset.impulseCount, 0);
    controller.dispose();
  })
));

test('reduced motion draws static input and dispose cleans listener resources idempotently', () => (
  withReactiveGridGlobals(({ document, mediaQuery, resizeHarness, rafHarness, canvasHarness }) => {
    mediaQuery.matches = true;
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 240, height: 160 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    const ctx = canvasHarness.contexts.get(host.querySelector('canvas'));
    const before = ctx.frames.length;
    assert.equal(mediaQuery.listenerCount(), 1);
    assert.equal(rafHarness.size, 0);

    controller.handleInput(normalizedInput('move'));
    assert.ok(ctx.frames.length > before);
    assert.equal(rafHarness.size, 0, 'static highlight starts no ambient loop');
    controller.dispose();
    assert.equal(host.querySelectorAll('canvas').length, 0);
    assert.equal(resizeHarness.instances.length, 0);
    assert.equal(mediaQuery.listenerCount(), 0);
    controller.dispose();
    assert.equal(resizeHarness.instances.length, 0);
  })
));

test('draw errors report a recoverable frame fault and the loop continues', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness, canvasHarness }) => {
    const reports = [];
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 200, height: 120 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery, report: (fault) => reports.push(fault) });
    bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    const ctx = canvasHarness.contexts.get(host.querySelector('canvas'));
    const framesBefore = ctx.frames.length;
    const originalClearRect = ctx.clearRect;
    ctx.clearRect = function throwOnce() {
      ctx.clearRect = originalClearRect;
      throw new Error('simulated draw failure');
    };

    rafHarness.flush(16);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].effectId, 'reactive-grid');
    assert.equal(reports[0].stage, 'frame');
    assert.equal(reports[0].recoverable, true);
    assert.equal(rafHarness.size, 1, 'frame loop reschedules after containment');
    rafHarness.flush(16);
    assert.ok(ctx.frames.length > framesBefore);
    controller.dispose();
  })
));

test('manager refresh snapshots update backing size and drawing config', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness, canvasHarness }) => {
    mediaQuery.matches = true;
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 240, height: 160 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    const canvas = host.querySelector('canvas');
    const writes = trackCanvasDimensionWrites(canvas);
    const beforeSignature = getFrameSignature(getLastFrame(canvasHarness.contexts, canvas));
    host.style.setProperty('--reactive-grid-cell-size', '48');

    controller.refresh(buildContext([{ element: host, role: 'chat-left' }], { generation: 2 }));
    assert.equal(writes.widthWrites, 0);
    assert.equal(writes.heightWrites, 0);
    assert.notEqual(getFrameSignature(getLastFrame(canvasHarness.contexts, canvas)), beforeSignature,
      'explicit manager refresh re-reads geometry-affecting style tokens');

    setRect(host, { width: 300, height: 180 });
    controller.refresh(buildContext([{ element: host, role: 'chat-left' }], { generation: 3 }));
    assert.equal(writes.widthWrites, 1);
    assert.equal(writes.heightWrites, 1);
    controller.dispose();
  })
));

test('identical manager refreshes do not churn canvas backing dimensions', () => (
  withReactiveGridGlobals(({ document, mediaQuery, resizeHarness, rafHarness }) => {
    mediaQuery.matches = true;
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 240, height: 160 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    const context = bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    const writes = trackCanvasDimensionWrites(host.querySelector('canvas'));
    controller.refresh(context);
    controller.refresh(context);
    controller.refresh(context);
    assert.equal(writes.widthWrites, 0);
    assert.equal(writes.heightWrites, 0);
    assert.equal(resizeHarness.instances.length, 0);
    controller.dispose();
  })
));

test('paint occlusion clears one viewport while the shared simulation and sibling paint continue', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness, canvasHarness }) => {
    const left = document.createElement('section');
    const right = document.createElement('section');
    applyReactiveGridStyles(left);
    applyReactiveGridStyles(right);
    setRect(left, { left: 100, top: 40, width: 240, height: 180 });
    setRect(right, { left: 660, top: 40, width: 240, height: 180 });
    document.body.append(left, right);
    const sceneRect = { left: 100, top: 40, width: 800, height: 180 };
    const specs = [
      { element: left, role: 'chat-left' },
      { element: right, role: 'chat-right' },
    ];
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, specs, { sceneRect });
    controller.handleInput(normalizedInput('move', {
      role: 'chat-left', x: 80, y: 80, sceneX: 80, sceneY: 80, timeStamp: 10,
    }));
    controller.handleInput(normalizedInput('move', {
      role: 'chat-left', x: 180, y: 80, sceneX: 180, sceneY: 80, timeStamp: 26,
    }));
    const velocityBefore = controller._internals.inspect().entries[0].pointerVelocityX;
    assert.ok(velocityBefore > 0);

    controller.refresh(buildContext(specs, {
      generation: 2,
      sceneRect,
      paintOcclusionRects: [{ left: 100, top: 40, width: 240, height: 180 }],
    }));
    rafHarness.flush(16);
    const snapshot = controller._internals.inspect();
    assert.ok(snapshot.entries[0].pointerVelocityX < velocityBefore, 'the scene tick still advances');
    const leftContext = canvasHarness.contexts.get(left.querySelector('canvas'));
    const rightContext = canvasHarness.contexts.get(right.querySelector('canvas'));
    assert.equal(Math.abs(leftContext.transforms.at(-1)[4]), 0);
    assert.equal(rightContext.transforms.at(-1)[4] / rightContext.transforms.at(-1)[0], -560,
      'right canvas paints the adjacent scene viewport instead of duplicating local coordinates');
    assert.equal(getLastFrame(canvasHarness.contexts, left.querySelector('canvas')).dots.length, 0,
      'the covered viewport is cleared after painting');
    assert.ok(getLastFrame(canvasHarness.contexts, right.querySelector('canvas')).dots.length > 0,
      'the sibling viewport remains painted');
    controller.dispose();
  })
));

test('dispose cancels the pending animation frame without an effect-owned geometry observer', () => (
  withReactiveGridGlobals(({ document, mediaQuery, resizeHarness, rafHarness }) => {
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 240, height: 160 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    assert.ok(rafHarness.size >= 1);
    controller.dispose();
    assert.equal(rafHarness.size, 0);
    assert.equal(resizeHarness.instances.length, 0);
  })
));

test('refresh re-reads palette tokens without host churn', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness, canvasHarness }) => {
    mediaQuery.matches = true;
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 240, height: 160 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    const context = bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    const canvas = host.querySelector('canvas');
    assert.equal(getLastFrame(canvasHarness.contexts, canvas).dots[0].fillStyle, 'rgba(157, 197, 255, 0.180)');

    host.style.setProperty('--widget-reactive-grid-dot-idle', 'rgba(10, 20, 30, 0.5)');
    controller.refresh(context);
    assert.equal(getLastFrame(canvasHarness.contexts, canvas).dots[0].fillStyle, 'rgba(10, 20, 30, 0.500)');
    controller.dispose();
  })
));

test('hover drawing blends idle and active colors through multiple buckets', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness, canvasHarness }) => {
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 260, height: 180 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    controller.handleInput(normalizedInput('move', { x: 130, y: 90 }));
    for (let i = 0; i < 40; i += 1) rafHarness.flush(16);
    const frame = getLastFrame(canvasHarness.contexts, host.querySelector('canvas'));
    const fillStyles = new Set(frame.dots.map((dot) => dot.fillStyle));
    assert.ok(fillStyles.size >= 3, 'hover frame should use at least three interpolated colour buckets');
    controller.dispose();
  })
));

test('reactive grid produces a similar end-state at 60Hz and 144Hz tick rates', async () => {
  function runScenario(msPerFrame, frameCount) {
    return withReactiveGridGlobals(({ document, mediaQuery, rafHarness, canvasHarness }) => {
      const host = document.createElement('section');
      applyReactiveGridStyles(host);
      setRect(host, { width: 260, height: 180 });
      document.body.append(host);
      const controller = createController({ document, mediaQuery });
      bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
      controller.handleInput(normalizedInput('move', { x: 130, y: 90 }));
      for (let i = 0; i < frameCount; i += 1) rafHarness.flush(msPerFrame);
      const result = {
        intensity: getFrameIntensity(getLastFrame(canvasHarness.contexts, host.querySelector('canvas'))),
        elapsed: rafHarness.now,
      };
      controller.dispose();
      return result;
    });
  }
  const [slowRate, fastRate] = await Promise.all([runScenario(16, 60), runScenario(7, 137)]);
  assert.ok(slowRate.intensity > 0 && fastRate.intensity > 0);
  const peak = Math.max(slowRate.intensity, fastRate.intensity);
  const ratio = Math.abs(slowRate.intensity - fastRate.intensity) / peak;
  assert.ok(
    ratio < 0.15,
    `end-state intensity must be similar across rates (ratio=${ratio.toFixed(3)}, slow=${slowRate.intensity.toFixed(3)}, fast=${fastRate.intensity.toFixed(3)})`,
  );
});

test('dispose is terminal: later bind, refresh, input, activity, and motion changes are inert', () => (
  withReactiveGridGlobals(({ document, mediaQuery, rafHarness }) => {
    const host = document.createElement('section');
    applyReactiveGridStyles(host);
    setRect(host, { width: 200, height: 120 });
    document.body.append(host);
    const controller = createController({ document, mediaQuery });
    const context = bindAndPrime(controller, rafHarness, [{ element: host, role: 'chat-left' }]);
    controller.dispose();
    const before = controller._internals.inspect();

    mediaQuery.dispatch(true);
    controller.bind(context);
    controller.refresh(context);
    controller.handleInput(normalizedInput('move'));
    controller.setActivity({
      scopeEpoch: 9, phase: 'streaming', phaseRevision: 1, targetEnergy: 0.46, attentionScale: 1,
    });
    controller.handleActivityImpulse({ scopeEpoch: 9, sequence: 1, kind: 'complete', timeStamp: 0 });
    assert.deepEqual(controller._internals.inspect(), before);
    assert.equal(before.disposed, true);
    assert.equal(host.querySelectorAll('canvas').length, 0);
    assert.equal(rafHarness.size, 0);
  })
));
