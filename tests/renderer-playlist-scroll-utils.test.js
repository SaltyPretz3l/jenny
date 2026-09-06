const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const playlistScrollUtils = require('../renderer/shell/renderer-playlist-scroll-utils.js');

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
    requestAnimationFrame(callback) { const id = nextId++; callbacks.set(id, callback); return id; },
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
    addEventListener(eventName, listener) { if (eventName === 'change') listeners.add(listener); },
    removeEventListener(eventName, listener) { if (eventName === 'change') listeners.delete(listener); },
    dispatch(matches) {
      this.matches = Boolean(matches);
      Array.from(listeners).forEach((listener) => listener({ matches: this.matches }));
    },
    listenerCount() { return listeners.size; },
  };
}

function createCanvasRecorder() {
  const calls = [];
  const state = {
    fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over', shadowColor: 'transparent', shadowBlur: 0,
  };
  return {
    calls,
    setTransform() {},
    clearRect(...args) { calls.push({ type: 'clearRect', args }); },
    beginPath() {}, moveTo() {}, lineTo() {},
    stroke() { calls.push({ type: 'stroke', lineWidth: state.lineWidth, globalAlpha: state.globalAlpha }); },
    fill() { calls.push({ type: 'fill' }); },
    fillRect(...args) {
      calls.push({ type: 'fillRect', args, fillStyle: state.fillStyle, globalAlpha: state.globalAlpha });
    },
    roundRect(...args) {
      calls.push({
        type: 'roundRect', args, fillStyle: state.fillStyle, globalAlpha: state.globalAlpha,
        shadowColor: state.shadowColor, shadowBlur: state.shadowBlur,
      });
    },
    arc(...args) { calls.push({ type: 'arc', args, lineWidth: state.lineWidth }); },
    createLinearGradient(...args) {
      calls.push({ type: 'createLinearGradient', args });
      return { addColorStop() {} };
    },
    drawImage(...args) { calls.push({ type: 'drawImage', args }); },
    get fillStyle() { return state.fillStyle; }, set fillStyle(value) { state.fillStyle = value; },
    get strokeStyle() { return state.strokeStyle; }, set strokeStyle(value) { state.strokeStyle = value; },
    get lineWidth() { return state.lineWidth; }, set lineWidth(value) { state.lineWidth = value; },
    get globalAlpha() { return state.globalAlpha; }, set globalAlpha(value) { state.globalAlpha = value; },
    get globalCompositeOperation() { return state.globalCompositeOperation; },
    set globalCompositeOperation(value) { state.globalCompositeOperation = value; },
    get shadowColor() { return state.shadowColor; }, set shadowColor(value) { state.shadowColor = value; },
    get shadowBlur() { return state.shadowBlur; }, set shadowBlur(value) { state.shadowBlur = value; },
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
  return { contexts, restore() { proto.getContext = originalGetContext; } };
}

function buildTestEnv(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const raf = createRafHarness();
  const ro = createResizeObserverHarness();
  const mql = createMediaQueryList(options.reducedMotion);
  const savedGlobals = {
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    performance: globalThis.performance,
  };
  globalThis.ResizeObserver = ro.FakeResizeObserver;
  globalThis.requestAnimationFrame = raf.requestAnimationFrame;
  globalThis.cancelAnimationFrame = raf.cancelAnimationFrame;
  globalThis.performance = { now: () => raf.now };
  const recorder = installCanvasRecorder(window);
  return {
    dom, window, raf, ro, mql, recorder,
    cleanupGlobals() {
      Object.keys(savedGlobals).forEach((key) => {
        if (savedGlobals[key] === undefined) delete globalThis[key];
        else globalThis[key] = savedGlobals[key];
      });
    },
  };
}

function addHost(doc, id, role = 'chat-left', rect) {
  const element = doc.createElement('div');
  element.id = id || 'host';
  element.dataset.role = role;
  element.getBoundingClientRect = () => rect || ({ left: 0, top: 0, width: 480, height: 280 });
  doc.body.appendChild(element);
  return { element, role };
}

function context(hosts, overrides = {}) {
  return Object.assign({
    generation: 1,
    staged: false,
    surface: 'chat',
    hosts,
    layout: {
      revision: 1,
      sceneRect: { left: 0, top: 0, width: 480, height: 280 },
      hostRects: hosts.map(({ element }) => element.getBoundingClientRect()),
      interactionBlockRects: [], paintOcclusionRects: [], spawnAvoidanceRects: [],
    },
  }, overrides);
}

function makeController(env, options = {}) {
  return playlistScrollUtils.createPlaylistScrollController(Object.assign({
    documentRef: env.window.document,
    reducedMotionQuery: env.mql,
  }, options));
}

function input(type, role = 'chat-left', overrides = {}) {
  return Object.assign({
    type, surfaceRole: role, pointerId: 1, buttons: 0,
    localX: 100, localY: 90, sceneX: 100, sceneY: 90, timeStamp: 16,
  }, overrides);
}

function inspectEntry(controller, role = 'chat-left') {
  return controller._internals.inspect().entries.find((entry) => entry.role === role);
}

function trackCanvasDimensionWrites(canvas) {
  let widthValue = canvas.width;
  let heightValue = canvas.height;
  let widthWrites = 0;
  let heightWrites = 0;
  Object.defineProperty(canvas, 'width', {
    configurable: true, get: () => widthValue,
    set(value) { widthWrites += 1; widthValue = Number(value); },
  });
  Object.defineProperty(canvas, 'height', {
    configurable: true, get: () => heightValue,
    set(value) { heightWrites += 1; heightValue = Number(value); },
  });
  return {
    get widthWrites() { return widthWrites; },
    get heightWrites() { return heightWrites; },
  };
}

function withEnv(t, options, fn) {
  const env = buildTestEnv(options);
  t.after(async () => {
    env.recorder.restore();
    env.cleanupGlobals();
    await env.dom.window.close();
  });
  return fn(env);
}

test('native context injects one canvas per host and refresh reconciles membership', (t) => {
  withEnv(t, {}, (env) => {
    const hostA = addHost(env.window.document, 'a', 'chat-left');
    const hostB = addHost(env.window.document, 'b', 'chat-right');
    const controller = makeController(env);
    controller.bind(context([hostA, hostB]));
    assert.ok(hostA.element.querySelector('.widget-playlist-scroll-canvas'));
    assert.ok(hostB.element.querySelector('.widget-playlist-scroll-canvas'));
    assert.equal(env.ro.instances.length, 0, 'manager snapshots are the sole geometry owner');
    controller.refresh(context([hostA], { generation: 2 }));
    assert.equal(hostB.element.querySelector('.widget-playlist-scroll-canvas'), null);
    assert.ok(hostA.element.querySelector('.widget-playlist-scroll-canvas'));
    controller.dispose();
    assert.equal(hostA.element.querySelector('.widget-playlist-scroll-canvas'), null);
  });
});

test('scroll is dt-based and moves right-to-left while ambient ghosts keep drawing', (t) => {
  withEnv(t, {}, (env) => {
    const host = addHost(env.window.document);
    const controller = makeController(env);
    controller.bind(context([host]));
    env.raf.flush(16);
    const canvas = host.element.querySelector('.widget-playlist-scroll-canvas');
    const ctx = env.recorder.contexts.get(canvas);
    const start = inspectEntry(controller).totalScroll;
    ctx.calls.length = 0;
    env.raf.flush(50);
    const afterLong = inspectEntry(controller).totalScroll;
    env.raf.flush(8);
    const afterShort = inspectEntry(controller).totalScroll;
    assert.ok(afterLong - start > (afterShort - afterLong) * 3);
    assert.ok(ctx.calls.some((call) => call.type === 'drawImage'), 'cached grid tile draws');
    assert.ok(ctx.calls.some((call) => call.type === 'fillRect'), 'ambient ghosts and accents draw');
    controller.dispose();
  });
});

test('shared frame clock caps ordinary stalls and resets visible long gaps', (t) => {
  withEnv(t, {}, (env) => {
    const host = addHost(env.window.document);
    const controller = makeController(env);
    controller.bind(context([host]));
    env.raf.flush(16);
    const base = inspectEntry(controller).totalScroll;
    env.raf.flush(80);
    const capped = inspectEntry(controller).totalScroll;
    env.raf.flush(200);
    const alsoCapped = inspectEntry(controller).totalScroll;
    assert.ok(Math.abs((capped - base) - (alsoCapped - capped)) < 0.001, '200ms clamps to 80ms');
    env.raf.flush(1000);
    assert.equal(inspectEntry(controller).totalScroll, alsoCapped, 'visible >500ms gap advances by zero');
    controller.dispose();
  });
});

test('reduced motion draws a static frame, suppresses the ambient loop, and resumes cleanly', (t) => {
  withEnv(t, { reducedMotion: true }, (env) => {
    const host = addHost(env.window.document);
    const controller = makeController(env);
    controller.bind(context([host]));
    const canvas = host.element.querySelector('.widget-playlist-scroll-canvas');
    const ctx = env.recorder.contexts.get(canvas);
    assert.ok(ctx.calls.length > 0, 'initial static frame is drawn');
    const calls = ctx.calls.length;
    env.raf.flush(16);
    assert.equal(ctx.calls.length, calls, 'ready reveal does not start ambient painting');
    assert.equal(env.raf.size, 0);
    env.mql.dispatch(false);
    env.raf.flush(16);
    assert.ok(ctx.calls.length > calls);
    controller.dispose();
  });
});

test('hidden reduced-motion bind paints once on foreground without starting an ambient loop', (t) => {
  withEnv(t, { reducedMotion: true }, (env) => {
    Object.defineProperty(env.window.document, 'hidden', {
      configurable: true, writable: true, value: true,
    });
    const host = addHost(env.window.document);
    const controller = makeController(env);
    controller.bind(context([host]));
    const canvas = host.element.querySelector('.widget-playlist-scroll-canvas');
    const ctx = env.recorder.contexts.get(canvas);
    assert.equal(ctx.calls.length, 0, 'hidden activation stays unpainted');
    controller.refresh(context([host], { generation: 2 }));
    assert.equal(ctx.calls.length, 0, 'hidden refresh stays unpainted');
    env.window.document.hidden = false;
    env.window.document.dispatchEvent(new env.window.Event('visibilitychange'));
    assert.ok(ctx.calls.length > 0, 'foreground transition paints the static scene');
    const foregroundCalls = ctx.calls.length;
    env.raf.flush(16);
    assert.equal(ctx.calls.length, foregroundCalls, 'one-shot reveal does not paint an ambient frame');
    assert.equal(env.raf.size, 0);
    controller.dispose();
  });
});

test('draw failures report through the shared fault seam and do not kill the loop', (t) => {
  withEnv(t, {}, (env) => {
    const reports = [];
    const host = addHost(env.window.document);
    const controller = makeController(env, { report: (fault) => reports.push(fault) });
    controller.bind(context([host]));
    env.raf.flush(16);
    const ctx = env.recorder.contexts.get(host.element.querySelector('.widget-playlist-scroll-canvas'));
    const clearRect = ctx.clearRect;
    ctx.clearRect = () => { throw new Error('boom'); };
    assert.doesNotThrow(() => env.raf.flush(16));
    assert.equal(reports.length, 1);
    ctx.clearRect = clearRect;
    const before = ctx.calls.length;
    env.raf.flush(16);
    assert.ok(ctx.calls.length > before, 'subsequent frame still draws');
    controller.dispose();
  });
});

test('manager-routed click draws a full-height user note without vertical placement overshoot', (t) => {
  withEnv(t, {}, (env) => {
    const host = addHost(env.window.document);
    const controller = makeController(env);
    controller.bind(context([host]));
    env.raf.flush(16);
    const ctx = env.recorder.contexts.get(host.element.querySelector('.widget-playlist-scroll-canvas'));
    ctx.calls.length = 0;
    controller.handleInput(input('click'));
    env.raf.flush(16);
    assert.equal(inspectEntry(controller).noteCount, 1);
    assert.equal(inspectEntry(controller).noteSample[0].variation.velocity, 1);
    const noteShapes = ctx.calls.filter((call) => call.type === 'roundRect');
    assert.equal(noteShapes.length, 3);
    noteShapes.slice(0, 2).forEach((call) => {
      assert.equal(call.args[1], 85, 'the initial placement pop remains centered in the snapped lane');
      assert.equal(call.args[3], 26, 'the initial placement pop does not shrink or exceed the usable lane height');
    });
    assert.ok(ctx.calls.some((call) => call.type === 'arc'));
    controller.dispose();
  });
  withEnv(t, { reducedMotion: true }, (env) => {
    const host = addHost(env.window.document);
    const controller = makeController(env);
    controller.bind(context([host]));
    env.raf.flush(16);
    controller.handleInput(input('click'));
    assert.equal(inspectEntry(controller).noteCount, 1);
    assert.equal(inspectEntry(controller).rippleCount, 0);
    controller.dispose();
  });
});

test('baseline rendering preserves fourth-bar accents, two-axis fades, residual note glow, and static flare width', (t) => {
  withEnv(t, {}, (env) => {
    const host = addHost(env.window.document, 'visual', 'chat-left', {
      left: 0, top: 0, width: 300, height: 280,
    });
    host.element.style.setProperty('--playlist-scroll-speed', '4');
    const controller = makeController(env);
    controller.bind(context([host]));
    env.raf.flush(16);
    const canvas = host.element.querySelector('.widget-playlist-scroll-canvas');
    const ctx = env.recorder.contexts.get(canvas);
    const fullHeightMarkers = ctx.calls.filter((call) => (
      call.type === 'fillRect' && call.args[2] === 1.5 && call.args[3] === 280
    ));
    assert.equal(fullHeightMarkers.length, 2, 'one fourth-bar accent plus the playhead render');
    const fades = ctx.calls.filter((call) => call.type === 'createLinearGradient').map((call) => call.args);
    assert.ok(fades.some((args) => args.join(',') === '0,0,300,0'), 'horizontal edge fade renders');
    assert.ok(fades.some((args) => args.join(',') === '0,0,0,280'), 'vertical edge fade renders');

    controller.handleInput(input('click', 'chat-left', { localX: 215, sceneX: 215 }));
    controller.setActivity({
      scopeEpoch: 1, phase: 'streaming', phaseRevision: 1, targetEnergy: 0.46, attentionScale: 1,
    });
    for (let i = 0; i < 12; i += 1) env.raf.flush(16);
    const crossingArcs = ctx.calls.filter((call) => (
      call.type === 'arc' && Math.abs(call.args[0] - 168) < 0.001
    ));
    assert.ok(crossingArcs.length > 0, 'painted note creates a playhead crossing flare');
    assert.ok(crossingArcs.every((call) => call.lineWidth === 1.5), 'streaming never boosts flare width');

    for (let i = 0; i < 4; i += 1) env.raf.flush(80);
    ctx.calls.length = 0;
    env.raf.flush(80);
    const residualGlow = ctx.calls.filter((call) => call.type === 'roundRect')
      .some((call) => Math.abs(call.shadowBlur - 3) < 0.001);
    assert.equal(residualGlow, true, 'settled notes retain the bounded residual glow');
    controller.dispose();
  });
});

test('two chat gutters share one bounded scene note pool', (t) => {
  withEnv(t, { reducedMotion: true }, (env) => {
    const left = addHost(env.window.document, 'left', 'chat-left');
    const right = addHost(env.window.document, 'right', 'chat-right');
    const controller = makeController(env);
    controller.bind(context([left, right]));
    env.raf.flush(16);
    controller.handleInput(input('click', 'timeline'));
    assert.equal(inspectEntry(controller, 'chat-left').noteCount, 0);
    controller.handleInput(input('click', 'chat-left'));
    assert.equal(inspectEntry(controller, 'chat-left').noteCount, 1);
    assert.equal(inspectEntry(controller, 'chat-right').noteCount, 1);
    for (let i = 0; i < 150; i += 1) controller.handleInput(input('click', 'chat-right', { timeStamp: i + 20 }));
    assert.equal(inspectEntry(controller, 'chat-right').noteCount, 96);
    controller.dispose();
  });
});

test('manager snapshot refresh avoids same-size writes and applies changed geometry exactly once', (t) => {
  withEnv(t, {}, (env) => {
    const host = addHost(env.window.document);
    const controller = makeController(env);
    controller.bind(context([host]));
    env.raf.flush(16);
    const canvas = host.element.querySelector('.widget-playlist-scroll-canvas');
    const writes = trackCanvasDimensionWrites(canvas);
    controller.refresh(context([host], { generation: 2 }));
    assert.equal(writes.widthWrites, 0, 'same size does not rewrite backing width');
    assert.equal(writes.heightWrites, 0);
    host.element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 520, height: 320 });
    controller.refresh(context([host], { generation: 3 }));
    assert.equal(writes.widthWrites, 1);
    assert.equal(writes.heightWrites, 1);
    controller.dispose();
    assert.equal(env.raf.size, 0, 'ambient frames are cancelled');
  });
});

test('refresh re-reads palette tokens and rebuilds the cached tile on the next paint', (t) => {
  withEnv(t, {}, (env) => {
    const host = addHost(env.window.document);
    const controller = makeController(env);
    controller.bind(context([host]));
    env.raf.flush(16);
    const before = env.recorder.contexts.size;
    host.element.style.setProperty('--playlist-scroll-accent-color', 'rgba(10, 200, 30, 0.9)');
    controller.refresh(context([host], { generation: 2 }));
    env.raf.flush(16);
    assert.equal(env.recorder.contexts.size, before + 1, 'palette change rebuilds the cached tile canvas');
    controller.dispose();
  });
});

test('paint occlusion clears only the projected host region after rendering', (t) => {
  withEnv(t, {}, (env) => {
    const host = addHost(env.window.document, 'occluded', 'chat-left', {
      left: 100, top: 50, width: 300, height: 280,
    });
    const controller = makeController(env);
    const snapshot = context([host]);
    snapshot.layout.sceneRect = { left: 100, top: 50, width: 300, height: 280 };
    snapshot.layout.paintOcclusionRects = [{ left: 130, top: 90, width: 40, height: 60 }];
    controller.bind(snapshot);
    env.raf.flush(16);
    const canvas = host.element.querySelector('.widget-playlist-scroll-canvas');
    const ctx = env.recorder.contexts.get(canvas);
    assert.ok(ctx.calls.some((call) => (
      call.type === 'clearRect' && call.args.join(',') === '30,40,40,60'
    )), 'client-space occlusion is clipped and projected to host-local coordinates');
    assert.ok(controller._internals.inspect().scene.totalScroll >= 0,
      'paint masking does not alter the scene simulation');
    controller.dispose();
  });
});

test('dispose is idempotent and releases motion listener, canvas, and frames', (t) => {
  withEnv(t, {}, (env) => {
    const host = addHost(env.window.document);
    const controller = makeController(env);
    controller.bind(context([host]));
    assert.equal(env.mql.listenerCount(), 1);
    controller.dispose();
    assert.equal(env.mql.listenerCount(), 0);
    assert.equal(env.ro.instances.length, 0);
    assert.equal(host.element.querySelector('.widget-playlist-scroll-canvas'), null);
    assert.equal(env.raf.size, 0);
    controller.dispose();
    assert.equal(env.ro.instances.length, 0);
  });
});

test('ghost generation remains deterministic and lane/subdivision bounded', () => {
  const { generateGhostNoteForBar } = playlistScrollUtils._internals;
  assert.deepEqual(
    generateGhostNoteForBar(123, 7, [], 12, 4),
    generateGhostNoteForBar(123, 7, [], 12, 4),
  );
  assert.notDeepEqual(
    generateGhostNoteForBar(123, 7, [], 12, 4),
    generateGhostNoteForBar(124, 7, [], 12, 4),
  );
  for (let bar = 0; bar < 24; bar += 1) {
    const note = generateGhostNoteForBar(42, bar, [], 8, 4);
    assert.ok(note.lane >= 0 && note.lane <= 7);
    assert.ok(note.subOffset >= 0 && note.subOffset <= 3);
  }
});

test('color helpers and subdivision schema preserve bounded legacy utility behavior', () => {
  const { parseRgba, shadeRgba, resolveSubdivisions } = playlistScrollUtils._internals;
  const color = parseRgba('rgba(120, 60, 200, 0.5)');
  assert.deepEqual(color, { r: 120, g: 60, b: 200, a: 0.5 });
  assert.deepEqual(shadeRgba(color, 0.5), { r: 60, g: 30, b: 100, a: 0.5 });
  assert.ok(shadeRgba(color, 1.5).r > color.r);
  assert.equal(parseRgba('not-a-color'), null);
  assert.equal(resolveSubdivisions('999999999'), 64);
  assert.equal(resolveSubdivisions('-50'), 1);
  assert.equal(resolveSubdivisions(''), 4);
  assert.equal(resolveSubdivisions('16'), 16);
});
