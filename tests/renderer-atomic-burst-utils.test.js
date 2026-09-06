const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { JSDOM } = require('jsdom');

const atomicBurstUtils = require('../renderer/shell/renderer-atomic-burst-utils.js');

const MODULE_PATH = path.resolve(__dirname, '../renderer/shell/renderer-atomic-burst-utils.js');

// Runs buildSparkleField(w, h, baseSize, density) in a fresh, timeout-bounded child process.
// The pre-fix builder can genuinely infinite-loop (density -> 0) or take an unbounded amount
// of time/memory (tiny cellSize on a huge viewport), so it must never be called directly in
// this (the test-runner) process -- only ever inside a killable child with a hard timeout.
function runSparkleFieldHazardChild(w, h, baseSize, density, timeoutMs) {
  const code = [
    `const utils = require(${JSON.stringify(MODULE_PATH)});`,
    'let s = 1;',
    'function rng() { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 0xffffffff; }',
    `const field = utils.buildSparkleField(${w}, ${h}, ${baseSize}, ${density}, rng);`,
    'process.stdout.write(JSON.stringify({ count: field.all.length }));',
  ].join('\n');
  return spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
}

function createResizeObserverHarness() {
  const instances = [];
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observeCalls = [];
      this.disconnectCalls = 0;
      instances.push(this);
    }
    observe(target) { this.observeCalls.push(target); }
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
      const pending = Array.from(callbacks.entries());
      callbacks.clear();
      now += ms;
      pending.forEach(([, callback]) => callback(now));
      return now;
    },
    get now() { return now; },
    get size() { return callbacks.size; },
  };
}

function createMediaQueryList(initialMatches) {
  const listeners = new Set();
  return {
    matches: Boolean(initialMatches),
    addEventListener(eventName, listener) { if (eventName === 'change') { listeners.add(listener); } },
    removeEventListener(eventName, listener) { if (eventName === 'change') { listeners.delete(listener); } },
    dispatch(matches) {
      this.matches = Boolean(matches);
      listeners.forEach((listener) => listener({ matches: this.matches }));
    },
  };
}

function createCanvasRecorder() {
  const calls = [];
  return {
    calls,
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, arc() {},
    fill() { calls.push({ type: 'fill', fillStyle: this._fillStyle }); },
    stroke() { calls.push({ type: 'stroke', strokeStyle: this.strokeStyle }); },
    save() {}, restore() {}, scale() {}, translate() {}, rotate() {}, setTransform() {},
    clearRect() { calls.push({ type: 'clearRect' }); },
    set fillStyle(v) { this._fillStyle = v; }, get fillStyle() { return this._fillStyle || ''; },
    set globalAlpha(v) { this._globalAlpha = v; }, get globalAlpha() { return this._globalAlpha || 1; },
  };
}

function installCanvasRecorder(window) {
  const contexts = new Map();
  const proto = window.HTMLCanvasElement.prototype;
  const originalGetContext = proto.getContext;
  proto.getContext = function getContext() {
    if (!contexts.has(this)) { contexts.set(this, createCanvasRecorder()); }
    return contexts.get(this);
  };
  return { contexts, restore() { proto.getContext = originalGetContext; } };
}

function buildEnv(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const raf = createRafHarness();
  const ro = createResizeObserverHarness();
  const mql = createMediaQueryList(options.reducedMotion);
  window.requestAnimationFrame = raf.requestAnimationFrame;
  window.cancelAnimationFrame = raf.cancelAnimationFrame;
  window.ResizeObserver = ro.FakeResizeObserver;
  window.performance = { now: () => raf.now };
  const saved = {
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    performance: globalThis.performance,
    MathRandom: Math.random,
  };
  globalThis.ResizeObserver = ro.FakeResizeObserver;
  globalThis.requestAnimationFrame = raf.requestAnimationFrame;
  globalThis.cancelAnimationFrame = raf.cancelAnimationFrame;
  globalThis.performance = { now: () => raf.now };
  Math.random = () => 0.5;
  const recorder = installCanvasRecorder(window);
  return {
    dom, window, raf, ro, mql, recorder,
    cleanupGlobals() {
      if (saved.ResizeObserver !== undefined) { globalThis.ResizeObserver = saved.ResizeObserver; } else { delete globalThis.ResizeObserver; }
      if (saved.requestAnimationFrame !== undefined) { globalThis.requestAnimationFrame = saved.requestAnimationFrame; } else { delete globalThis.requestAnimationFrame; }
      if (saved.cancelAnimationFrame !== undefined) { globalThis.cancelAnimationFrame = saved.cancelAnimationFrame; } else { delete globalThis.cancelAnimationFrame; }
      if (saved.performance !== undefined) { globalThis.performance = saved.performance; } else { delete globalThis.performance; }
      Math.random = saved.MathRandom;
    },
  };
}

function addHost(doc) {
  const el = doc.createElement('section');
  el.setAttribute('data-widget-modifier', 'atomic-burst');
  el.style.setProperty('--widget-atomic-burst-color-a', 'rgba(255, 90, 160, 0.78)');
  el.style.setProperty('--widget-atomic-burst-color-b', 'rgba(47, 174, 230, 0.74)');
  el.style.setProperty('--widget-atomic-burst-color-c', 'rgba(240, 189, 42, 0.78)');
  el.style.setProperty('--widget-atomic-burst-flare-color', 'rgba(255, 255, 255, 0.96)');
  el.style.setProperty('--widget-atomic-burst-size', '14');
  el.style.setProperty('--widget-atomic-burst-density', '6');
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 240, height: 220, right: 240, bottom: 220 });
  return el;
}

function createController(doc, reducedMotionQuery) {
  return atomicBurstUtils.createAtomicBurstController({
    documentRef: doc,
    reducedMotionQuery,
    rendererLaunchSeed: 4242,
  });
}

function contextForHost(host, overrides = {}) {
  const rect = host && host.getBoundingClientRect
    ? host.getBoundingClientRect()
    : { left: 0, top: 0, width: 0, height: 0 };
  return Object.assign({
    generation: 1,
    staged: false,
    surface: 'chat',
    hosts: host ? [{ element: host, role: 'chat-left' }] : [],
    layout: {
      revision: 1,
      sceneRect: rect,
      hostRects: host ? [rect] : [],
      interactionBlockRects: [],
      paintOcclusionRects: [],
      spawnAvoidanceRects: [],
    },
  }, overrides);
}

function movePayload(type, x, y) {
  return {
    type,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    buttons: 0,
    pressure: 0,
    timeStamp: 16,
    clientX: x,
    clientY: y,
    surfaceRole: 'chat-left',
    localX: x,
    localY: y,
    sceneX: x,
    sceneY: y,
    generation: 1,
  };
}

function trackCanvasDimensionWrites(canvas) {
  let widthValue = canvas.width;
  let heightValue = canvas.height;
  let widthWrites = 0;
  let heightWrites = 0;
  Object.defineProperty(canvas, 'width', {
    configurable: true,
    get() { return widthValue; },
    set(value) {
      widthWrites += 1;
      widthValue = Number(value);
    },
  });
  Object.defineProperty(canvas, 'height', {
    configurable: true,
    get() { return heightValue; },
    set(value) {
      heightWrites += 1;
      heightValue = Number(value);
    },
  });
  return {
    get widthWrites() { return widthWrites; },
    get heightWrites() { return heightWrites; },
  };
}

test('atomic burst controller mounts a canvas, animates, and tears down cleanly', async (t) => {
  const { dom, raf, mql, recorder, cleanupGlobals } = buildEnv({ reducedMotion: false });
  t.after(async () => { recorder.restore(); cleanupGlobals(); await dom.window.close(); });

  const doc = dom.window.document;
  const root = doc.createElement('div');
  const host = addHost(doc);
  root.append(host);
  doc.body.append(root);

  const controller = createController(doc, mql);
  controller.bind(contextForHost(host));

  const canvas = host.querySelector('.widget-atomic-burst-canvas');
  assert.ok(canvas, 'host should receive a canvas');
  assert.equal(canvas.style.pointerEvents, 'none', 'canvas should not intercept pointer events');
  canvas.getBoundingClientRect = host.getBoundingClientRect;

  raf.flush(16);
  const drawCountBeforePointer = recorder.contexts.get(canvas).calls.length;
  assert.ok(drawCountBeforePointer > 0, 'controller should draw at least once after bind');

  controller.handleInput(movePayload('move', 60, 80));
  raf.flush(16);
  assert.ok(
    recorder.contexts.get(canvas).calls.length > drawCountBeforePointer,
    'pointer movement should trigger redraw',
  );

  controller.dispose();
  assert.equal(host.querySelector('.widget-atomic-burst-canvas'), null, 'canvas should be removed on dispose');
});

test('atomic burst controller honours reduced motion (no continuous loop)', async (t) => {
  const { dom, raf, mql, recorder, cleanupGlobals } = buildEnv({ reducedMotion: true });
  t.after(async () => { recorder.restore(); cleanupGlobals(); await dom.window.close(); });

  const doc = dom.window.document;
  const root = doc.createElement('div');
  const host = addHost(doc);
  root.append(host);
  doc.body.append(root);

  const controller = createController(doc, mql);
  controller.bind(contextForHost(host));
  raf.flush(16);

  const canvas = host.querySelector('.widget-atomic-burst-canvas');
  const stableDrawCount = recorder.contexts.get(canvas).calls.length;

  raf.flush(16);
  raf.flush(16);
  assert.equal(
    recorder.contexts.get(canvas).calls.length,
    stableDrawCount,
    'reduced motion should suppress the continuous animation loop',
  );

  controller.dispose();
});

test('atomic burst manager layout refreshes update backing size without an effect observer', async (t) => {
  const { dom, raf, ro, mql, recorder, cleanupGlobals } = buildEnv({ reducedMotion: false });
  t.after(async () => { recorder.restore(); cleanupGlobals(); await dom.window.close(); });

  const doc = dom.window.document;
  const root = doc.createElement('div');
  const host = addHost(doc);
  root.append(host);
  doc.body.append(root);

  const controller = createController(doc, mql);
  controller.bind(contextForHost(host));

  const canvas = host.querySelector('.widget-atomic-burst-canvas');
  const writes = trackCanvasDimensionWrites(canvas);
  controller.refresh(contextForHost(host));

  assert.equal(writes.widthWrites, 0, 'same-size manager snapshot must not rewrite canvas.width');
  assert.equal(writes.heightWrites, 0, 'same-size manager snapshot must not rewrite canvas.height');
  assert.equal(ro.instances.length, 0, 'geometry observation is manager-owned');

  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 280, height: 240, right: 280, bottom: 240 });
  controller.refresh(contextForHost(host));
  assert.equal(writes.widthWrites, 1, 'real geometry change should rewrite canvas.width once');
  assert.equal(writes.heightWrites, 1, 'real geometry change should rewrite canvas.height once');

  controller.dispose();
});

test('atomic burst refresh rebuilds the field when spawn-avoidance rectangles change', async (t) => {
  const { dom, mql, recorder, cleanupGlobals } = buildEnv({ reducedMotion: true });
  t.after(async () => { recorder.restore(); cleanupGlobals(); await dom.window.close(); });

  const doc = dom.window.document;
  const host = addHost(doc);
  doc.body.append(host);
  const controller = createController(doc, mql);
  const initialContext = contextForHost(host);
  controller.bind(initialContext);
  const initial = controller._internals.inspect().entries[0];
  const [x, y] = initial.sparkleSample[0];
  const avoidanceRect = { left: x - 0.1, top: y - 0.1, width: 0.2, height: 0.2 };

  controller.refresh({
    ...initialContext,
    layout: {
      ...initialContext.layout,
      revision: 2,
      spawnAvoidanceRects: [avoidanceRect],
    },
  });

  const refreshed = controller._internals.inspect().entries[0];
  assert.ok(refreshed.sparkleCount < initial.sparkleCount, 'the newly avoided sparkle is removed');
  assert.equal(
    refreshed.sparkleSample.some(([sparkleX, sparkleY]) => sparkleX === x && sparkleY === y),
    false,
    'the rebuilt field no longer contains the sparkle inside the new avoidance rectangle',
  );
  controller.dispose();
});

test('atomic burst controller pauses the rAF loop while the document is hidden', async (t) => {
  const { dom, raf, mql, recorder, cleanupGlobals } = buildEnv({ reducedMotion: false });
  t.after(async () => { recorder.restore(); cleanupGlobals(); await dom.window.close(); });

  const doc = dom.window.document;
  let visibility = 'visible';
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => visibility });
  Object.defineProperty(doc, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
  const setVisibility = (next) => {
    visibility = next;
    doc.dispatchEvent(new dom.window.Event('visibilitychange'));
  };

  const root = doc.createElement('div');
  const host = addHost(doc);
  root.append(host);
  doc.body.append(root);

  const controller = createController(doc, mql);
  controller.bind(contextForHost(host));
  const canvas = host.querySelector('.widget-atomic-burst-canvas');
  canvas.getBoundingClientRect = host.getBoundingClientRect;
  raf.flush(16);
  const drawsWhileVisible = recorder.contexts.get(canvas).calls.length;
  assert.ok(drawsWhileVisible > 0, 'controller should draw while visible');

  // Background the window: hidden should stop the loop, so flushes produce no draws.
  setVisibility('hidden');
  raf.flush(16);
  raf.flush(16);
  assert.equal(
    recorder.contexts.get(canvas).calls.length,
    drawsWhileVisible,
    'no draws should occur while the document is hidden',
  );

  // Foreground again: drawing must resume.
  setVisibility('visible');
  raf.flush(16);
  assert.ok(
    recorder.contexts.get(canvas).calls.length > drawsWhileVisible,
    'drawing should resume once the document is visible again',
  );

  controller.dispose();
});

test('atomic burst dispose immediately after bind cancels the one-shot fade-in frame', async (t) => {
  // Mirror of living-ink S27: the markReady RAF must be tracked + cancelled on dispose,
  // with no flush in between (otherwise an orphaned frame pins a detached canvas for a tick).
  const { dom, raf, mql, recorder, cleanupGlobals } = buildEnv({ reducedMotion: false });
  t.after(async () => { recorder.restore(); cleanupGlobals(); await dom.window.close(); });

  const doc = dom.window.document;
  const root = doc.createElement('div');
  const host = addHost(doc);
  root.append(host);
  doc.body.append(root);

  const controller = createController(doc, mql);
  controller.bind(contextForHost(host));
  assert.ok(raf.size > 0, 'bind schedules at least the fade-in + step frames');
  controller.dispose(); // no flush between bind and dispose
  assert.equal(raf.size, 0, 'dispose cancels EVERY pending frame, including the fade-in');
});

test('atomic burst refresh() after dispose() injects no canvas and schedules no frame', async (t) => {
  // Mirror of living-ink S28: the public refresh() must be inert once disposed (no orphaned canvas).
  const { dom, raf, mql, recorder, cleanupGlobals } = buildEnv({ reducedMotion: false });
  t.after(async () => { recorder.restore(); cleanupGlobals(); await dom.window.close(); });

  const doc = dom.window.document;
  const root = doc.createElement('div');
  const host = addHost(doc);
  root.append(host);
  doc.body.append(root);

  const controller = createController(doc, mql);
  controller.bind(contextForHost(host));
  raf.flush(16);
  controller.dispose();
  assert.equal(host.querySelector('.widget-atomic-burst-canvas'), null, 'dispose removed the canvas');
  controller.refresh(contextForHost(host));
  assert.equal(host.querySelector('.widget-atomic-burst-canvas'), null, 'refresh after dispose must not re-inject a canvas');
  assert.equal(raf.size, 0, 'refresh after dispose must not schedule a frame');
});

function addHostWithTokens(doc, sizeToken, densityToken, rectW, rectH) {
  const el = addHost(doc);
  el.style.setProperty('--widget-atomic-burst-size', sizeToken);
  el.style.setProperty('--widget-atomic-burst-density', densityToken);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: rectW, height: rectH, right: rectW, bottom: rectH });
  return el;
}

test('SFX-V3-S1: readStyles clamps --widget-atomic-burst-size/-density via the inline schema', async (t) => {
  const { dom, raf, mql, recorder, cleanupGlobals } = buildEnv({ reducedMotion: false });
  t.after(async () => { recorder.restore(); cleanupGlobals(); await dom.window.close(); });

  const doc = dom.window.document;

  // Out-of-range tokens (size 500 > max 200, density 0.1 < min 0.5) must clamp to
  // (200, 0.5) and therefore draw an IDENTICAL sparkle field to a host that already
  // uses (200, 0.5) directly -- proving the clamp is actually applied, not just declared.
  const rootA = doc.createElement('div');
  const hostA = addHostWithTokens(doc, '500', '0.1', 240, 220);
  rootA.append(hostA);
  doc.body.append(rootA);

  const rootB = doc.createElement('div');
  const hostB = addHostWithTokens(doc, '200', '0.5', 240, 220);
  rootB.append(hostB);
  doc.body.append(rootB);

  const controllerA = createController(doc, mql);
  const controllerB = createController(doc, mql);
  controllerA.bind(contextForHost(hostA));
  controllerB.bind(contextForHost(hostB));
  raf.flush(16);

  const canvasA = hostA.querySelector('.widget-atomic-burst-canvas');
  const canvasB = hostB.querySelector('.widget-atomic-burst-canvas');
  const callsA = recorder.contexts.get(canvasA).calls;
  const callsB = recorder.contexts.get(canvasB).calls;

  assert.ok(callsA.length > 0, 'clamped host should still draw');
  assert.deepEqual(callsA, callsB, 'an out-of-range (500, 0.1) config must clamp to (200, 0.5) and match it exactly');

  controllerA.dispose();
  controllerB.dispose();
});

test('SFX-V3-S1: buildSparkleField floors cellSize so zero density cannot spin cols/rows to Infinity', () => {
  // density=0 pre-fix makes cellSize=0, so cols/rows become Infinity and the field-building
  // loop never terminates -- run only in a killable, timeout-bounded child process.
  const result = runSparkleFieldHazardChild(400, 400, 14, 0, 4000);
  assert.ok(
    result.stdout,
    `hazardous call must complete and print JSON within the timeout (stdout=${JSON.stringify(result.stdout)}, signal=${result.signal}, error=${result.error && result.error.message})`,
  );
  const parsed = JSON.parse(result.stdout);
  assert.ok(Number.isFinite(parsed.count) && parsed.count > 0, 'must produce a finite, non-zero sparkle count');
  assert.ok(parsed.count <= 1500, `sparkle count must stay within MAX_ATOMIC_SPARKLES, got ${parsed.count}`);
});

test('SFX-V3-S1: buildSparkleField caps total cell count so a floored cellSize cannot explode on a huge viewport', () => {
  // baseSize/density at the schema minimums still floor to a small but valid cellSize;
  // without a cap, a huge viewport turns that into tens of millions of primitives.
  const result = runSparkleFieldHazardChild(20000, 20000, 4, 0.5, 4000);
  assert.ok(
    result.stdout,
    `hazardous call must complete and print JSON within the timeout (stdout=${JSON.stringify(result.stdout)}, signal=${result.signal}, error=${result.error && result.error.message})`,
  );
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.count <= 1500, `cell count must stay within MAX_ATOMIC_SPARKLES, got ${parsed.count}`);
});

test('SFX-V3-S1: spawnWave caps concurrent waves at 4, evicting the oldest', async (t) => {
  const { dom, raf, mql, recorder, cleanupGlobals } = buildEnv({ reducedMotion: false });
  t.after(async () => { recorder.restore(); cleanupGlobals(); await dom.window.close(); });

  const doc = dom.window.document;

  // Returns the total draw-call count of the frame in which `clickCount` waves are all
  // simultaneously alive (sparkle draws + wave draws). Sparkle draws are a constant
  // per-frame term across all runs (same seeded field), so subtracting the clickCount=0
  // baseline below isolates the wave-only contribution.
  function waveFrameTotal(clickCount) {
    const root = doc.createElement('div');
    const host = addHost(doc);
    root.append(host);
    doc.body.append(root);
    const controller = createController(doc, mql);
    controller.bind(contextForHost(host));
    const canvas = host.querySelector('.widget-atomic-burst-canvas');
    canvas.getBoundingClientRect = host.getBoundingClientRect;
    raf.flush(16); // settle a sparkle-only frame before spawning any waves
    const beforeWaves = recorder.contexts.get(canvas).calls.length;
    // Click well outside the host rect so findNearestSparkle never matches and the
    // per-sparkle click-flare decoration (an unrelated draw-call source) stays at zero.
    for (let i = 0; i < clickCount; i++) {
      controller.handleInput(movePayload('click', -1000, -1000));
    }
    raf.flush(16);
    const afterWaves = recorder.contexts.get(canvas).calls.length;
    controller.dispose();
    return afterWaves - beforeWaves;
  }

  const zeroWaveTotal = waveFrameTotal(0);
  const oneWaveTotal = waveFrameTotal(1);
  const sixWaveTotal = waveFrameTotal(6);
  const oneWaveContribution = oneWaveTotal - zeroWaveTotal;
  const sixWaveContribution = sixWaveTotal - zeroWaveTotal;

  assert.ok(oneWaveContribution > 0, 'a single wave must add draw calls to its frame');
  assert.equal(
    sixWaveContribution,
    oneWaveContribution * 4,
    'spawning 6 waves at once must still only draw MAX_ATOMIC_WAVES (4) concurrent waves (oldest evicted)',
  );
});

test('SFX-V3-S1: refresh() re-reads tokens for an already-tracked host so a palette change takes effect without host churn', async (t) => {
  const { dom, raf, mql, recorder, cleanupGlobals } = buildEnv({ reducedMotion: false });
  t.after(async () => { recorder.restore(); cleanupGlobals(); await dom.window.close(); });

  const doc = dom.window.document;
  const root = doc.createElement('div');
  const host = addHost(doc);
  root.append(host);
  doc.body.append(root);

  const controller = createController(doc, mql);
  controller.bind(contextForHost(host));
  raf.flush(16);

  const canvas = host.querySelector('.widget-atomic-burst-canvas');
  const before = recorder.contexts.get(canvas).calls.length;

  const newColorA = 'rgb(10, 200, 10)';
  const newColorB = 'rgb(20, 210, 20)';
  const newColorC = 'rgb(30, 220, 30)';
  host.style.setProperty('--widget-atomic-burst-color-a', newColorA);
  host.style.setProperty('--widget-atomic-burst-color-b', newColorB);
  host.style.setProperty('--widget-atomic-burst-color-c', newColorC);

  controller.refresh(contextForHost(host));
  assert.equal(host.querySelector('.widget-atomic-burst-canvas'), canvas, 'refresh() must not churn (recreate) the canvas for an already-tracked host');

  raf.flush(16);
  const after = recorder.contexts.get(canvas).calls.slice(before);
  const usedNewColor = after.some((c) => c.fillStyle === newColorA || c.fillStyle === newColorB || c.fillStyle === newColorC);
  assert.ok(usedNewColor, 'a frame drawn after refresh() must pick up the new palette tokens, not the stale ones read at addHost() time');

  controller.dispose();
});
