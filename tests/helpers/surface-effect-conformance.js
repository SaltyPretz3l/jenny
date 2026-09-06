// Tiered surface-effect conformance battery for Background Effects v3 packet
// S4 (BACKGROUND_EFFECTS_V3_PLAN.md §4 "Tiered conformance", §5 "Test plan").
//
// runNativeV3Conformance is reusable as a plain function and covers every
// shipped controller plus a switchable defect fixture whose negative cases
// prove the battery's lifecycle/fault/listener oracles are non-vacuous.
//
// Shared fakes come from surface-effect-router-harness.js (S2/S3); this file
// extends that harness's fixtures additively, it does not fork them.

const assert = require('node:assert/strict');

const runtime = require('../../renderer/shell/renderer-surface-effect-runtime.js');
const {
  createRafHarness,
  createClock,
  makeRouterManager,
  makeFakeSurfaceElement,
  makeFakeEventTarget,
} = require('./surface-effect-router-harness.js');

// ── bounded history caps (fixture-internal; proves the soak's "no unbounded
// growth" requirement is enforced by the controller itself, not just the
// test sampling it) ─────────────────────────────────────────────────────────

const DT_HISTORY_CAP = 64;
const INPUT_HISTORY_CAP = 32;
const IMPULSE_HISTORY_CAP = 32;
const PRIMITIVE_SNAPSHOT_SAMPLE_COUNT = 6;

// ── small fakes ────────────────────────────────────────────────────────────

// A fake matchMedia-style reduced-motion query: addEventListener/change (the
// modern path) AND addListener/removeListener compatibility, plus a
// listenerCount()/simulateChange() pair the battery
// and the soak lane use to drive + verify cleanup.
function createEffectMediaQueryList(initialMatches) {
  const listeners = new Set();
  const mql = {
    matches: Boolean(initialMatches),
    addEventListener(eventName, listener) { if (eventName === 'change') { listeners.add(listener); } },
    removeEventListener(eventName, listener) { if (eventName === 'change') { listeners.delete(listener); } },
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    listenerCount() { return listeners.size; },
    simulateChange(matches) {
      mql.matches = Boolean(matches);
      Array.from(listeners).forEach((listener) => listener({ matches: mql.matches }));
    },
  };
  return mql;
}

function createFakeCanvasContext(documentRef) {
  const gradient = { addColorStop() {} };
  const ctx = {
    fillRect() {}, clearRect() {}, save() {}, restore() {}, beginPath() {},
    closePath() {}, arc() {}, ellipse() {}, roundRect() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, quadraticCurveTo() {}, bezierCurveTo() {},
    translate() {}, rotate() {}, scale() {}, setTransform() {}, drawImage() {},
    createLinearGradient() { return gradient; },
  };
  // Generic fault injection for REAL native controllers (which, unlike the
  // fixture, have no `defects` switch): a documentRef built with
  // { throwOnDraw: true } hands out contexts whose first draw call throws,
  // so the battery can prove the controller catches frame faults and routes
  // them through reportFault instead of swallowing them.
  if (documentRef && documentRef.__conformanceThrowOnDraw) {
    ctx.save = function save() {
      throw new Error('conformance-induced draw fault');
    };
    ctx.clearRect = ctx.save;
  }
  return ctx;
}

// A fake <canvas>: classList (Set-backed), a getContext() that honors the
// documentRef's __conformanceNullContext escape hatch (null-context removal
// test), and parentNode wired up by makeFakeSurfaceElement's appendChild.
function makeFakeCanvasElement(documentRef) {
  const events = makeFakeEventTarget();
  const classSet = new Set();
  const nullContext = Boolean(documentRef && documentRef.__conformanceNullContext);
  const dataset = {};
  return Object.assign({}, events, {
    tagName: 'CANVAS',
    parentNode: null,
    width: 0,
    height: 0,
    style: {},
    dataset,
    classList: {
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
      contains: (c) => classSet.has(c),
    },
    getContext() { return nullContext ? null : createFakeCanvasContext(documentRef); },
  });
}

function makeFakeSvgElement(documentRef, tag) {
  const events = makeFakeEventTarget();
  const classSet = new Set();
  const attributes = new Map();
  const element = Object.assign({}, events, {
    tagName: String(tag || '').toUpperCase(),
    parentNode: null,
    children: [],
    style: {},
    classList: {
      add: (name) => classSet.add(name),
      remove: (name) => classSet.delete(name),
      contains: (name) => classSet.has(name),
    },
    setAttribute(name, value) {
      if (element.tagName === 'PATH' && name === 'd') {
        element.__pathWriteCount = (element.__pathWriteCount || 0) + 1;
        if (documentRef.__conformanceThrowOnSvgWrite && element.__pathWriteCount > 1) {
          throw new Error('conformance-induced SVG write fault');
        }
      }
      attributes.set(name, String(value));
    },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    appendChild(child) {
      element.children.push(child);
      if (child) child.parentNode = element;
      return child;
    },
    removeChild(child) {
      const index = element.children.indexOf(child);
      if (index !== -1) element.children.splice(index, 1);
      if (child) child.parentNode = null;
      return child;
    },
  });
  return element;
}

// A fake documentRef: addEventListener/removeEventListener/listenerCount
// (for the visibilitychange leak check) + createElement('canvas'). Pass
// { nullContext: true } to make every created canvas fail getContext('2d'),
// exercising runtime.ensureCanvas2d's null-context removal path; pass
// { throwOnDraw: true } to make every created context throw on its first
// draw call (real-controller reportFault conformance).
function makeFixtureDocumentRef({
  nullContext = false,
  hidden = false,
  throwOnDraw = false,
  svgUnavailable = false,
  throwOnSvgWrite = false,
} = {}) {
  const events = makeFakeEventTarget();
  const doc = Object.assign({}, events, {
    hidden,
    __conformanceNullContext: nullContext,
    __conformanceThrowOnDraw: throwOnDraw,
    __conformanceThrowOnSvgWrite: throwOnSvgWrite,
    createElement(tag) {
      if (tag === 'canvas') { return makeFakeCanvasElement(doc); }
      const elEvents = makeFakeEventTarget();
      return Object.assign({}, elEvents, { tagName: String(tag || '').toUpperCase(), parentNode: null, style: {} });
    },
  });
  if (!svgUnavailable) {
    doc.createElementNS = (_namespace, tag) => makeFakeSvgElement(doc, tag);
  }
  return doc;
}

// A fake ResizeObserver constructor that tracks live (non-disconnected)
// instances, so the battery can assert "zero leaked observers after
// dispose" instead of just trusting disconnect() was called.
function createFakeResizeObserverClass() {
  const active = new Set();
  function FakeResizeObserver(callback) {
    this._callback = callback;
    active.add(this);
  }
  FakeResizeObserver.prototype.observe = function observe() {};
  FakeResizeObserver.prototype.unobserve = function unobserve() {};
  FakeResizeObserver.prototype.disconnect = function disconnect() { active.delete(this); };
  FakeResizeObserver.getActiveCount = function getActiveCount() { return active.size; };
  return FakeResizeObserver;
}

// Native-v3 controllers use bare-global rAF/ResizeObserver references. The
// §3.1 factory signature names `runtime`,
// `documentRef`, `reducedMotionQuery` explicitly but not a windowRef, so
// this battery treats requestAnimationFrame/cancelAnimationFrame/
// ResizeObserver as inherited bare globals, stubbed and restored around each
// synchronous battery pass.
function withStubbedGlobals({ raf, ResizeObserverRef } = {}, fn) {
  const saved = {
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
    ResizeObserver: globalThis.ResizeObserver,
  };
  globalThis.requestAnimationFrame = raf.requestAnimationFrame;
  globalThis.cancelAnimationFrame = raf.cancelAnimationFrame;
  if (ResizeObserverRef) { globalThis.ResizeObserver = ResizeObserverRef; }
  try {
    return fn();
  } finally {
    Object.keys(saved).forEach((key) => {
      if (saved[key] === undefined) { delete globalThis[key]; } else { globalThis[key] = saved[key]; }
    });
  }
}

// Additive (S5 W2): a fixture host carrying a real style.getPropertyValue,
// so tests can drive a native controller's readStyles()-style CSS
// custom-property clamping through the SAME fake-object environment the rest
// of this battery uses (no jsdom, which has no real 2d canvas backend). A
// property absent from styleTokens reads back as '' -- readStyles' normal
// "unset" path -- exactly like a real getComputedStyle().
function makeStyledFixtureHost(rect, styleTokens = {}) {
  const element = makeFakeSurfaceElement(rect);
  element.style = {
    getPropertyValue(name) {
      return Object.prototype.hasOwnProperty.call(styleTokens, name) ? String(styleTokens[name]) : '';
    },
    setProperty(name, value) {
      styleTokens[name] = String(value);
    },
  };
  return element;
}

// Builds a §3.1-shaped bind/refresh context from a list of {element, role}.
function rectOfHost(hostDescriptor) {
  const el = hostDescriptor && hostDescriptor.element;
  if (el && typeof el.getBoundingClientRect === 'function') { return el.getBoundingClientRect(); }
  return { left: 0, top: 0, width: 0, height: 0 };
}

function buildFixtureContext({
  generation = 1,
  staged = false,
  surface = 'chat',
  hosts = [],
  layoutRevision = 1,
  sceneRect = null,
  hostRects = null,
  interactionBlockRects = [],
  paintOcclusionRects = [],
  spawnAvoidanceRects = [],
} = {}) {
  return {
    generation,
    staged: Boolean(staged),
    surface,
    hosts,
    layout: {
      revision: layoutRevision,
      sceneRect: sceneRect || (hosts.length ? rectOfHost(hosts[0]) : { left: 0, top: 0, width: 0, height: 0 }),
      hostRects: hostRects || hosts.map(rectOfHost),
      interactionBlockRects,
      paintOcclusionRects,
      spawnAvoidanceRects,
    },
  };
}

// ── native-v3 conformance fixture ───────────────────────────────────────────
//
// Minimal but real: binds to context.hosts, injects one canvas per host via
// runtime.ensureCanvas2d, runs a rAF loop through runtime.createFrameClock,
// seeds a PRNG via runtime.makeRng(runtime.computeSceneSeed(...)), records
// handleInput/setActivity/handleActivityImpulse traffic (scopeEpoch-filtered
// per §3.2.1), honors staged/un-staged visibility, reports getStatus()
// ready/dormant by drawable host count, and disposes fully (cancels its own
// rAF, removes its own canvases, disconnects its own ResizeObserver).
//
// defects (all default falsy -- a plain call is a clean, conformant
// controller):
//   leakRaf: true       -- dispose() does not cancel the pending rAF.
//   leakListener: true  -- each host gets a stray mousemove/pointerdown
//                          listener, violating "manager-owned input".
//   throwInFrame: true  -- the first frame tick throws and the fault is
//                          SWALLOWED (no reportFault call) -- the exact v2
//                          problem runtime.createFaultReporter exists to
//                          fix. This is the negative-test bug variant.
//   throwInFrame: 'reported' -- the first frame tick throws AND is caught +
//                          reported via the injected `report` callback --
//                          the correct, conformant variant, used to prove
//                          the reportFault plumbing positively.
//   readRectInFrame: true -- a frame re-reads host DOM geometry instead of
//                          consuming the immutable manager layout snapshot.
function createConformanceFixtureController(factoryOptions) {
  const opts = factoryOptions || {};
  const documentRef = opts.documentRef || null;
  const reducedMotionQuery = opts.reducedMotionQuery || null;
  const runtimeRef = opts.runtime;
  const defects = opts.defects || {};
  const effectId = opts.effectId || 'conformance-fixture';
  const sceneRole = opts.sceneRole || 'chat';
  const rendererLaunchSeed = opts.rendererLaunchSeed != null ? opts.rendererLaunchSeed : 1;
  const reportCallback = typeof opts.report === 'function' ? opts.report : null;

  if (!runtimeRef || typeof runtimeRef.createFrameClock !== 'function') {
    throw new Error('createConformanceFixtureController requires options.runtime (the shared runtime instance)');
  }

  const faultReporter = runtimeRef.createFaultReporter({ report: reportCallback || undefined, windowMs: 0 });

  let bound = false;
  let disposed = false;
  let staged = true;
  let rafHandle = 0;
  let frameIndex = 0;
  let currentScopeEpoch = null;
  let lastSnapshot = null;
  let snapshotCount = 0;
  let acceptedImpulses = [];
  let ignoredImpulseCount = 0;
  let inputCount = 0;
  let recentInputs = [];
  let lastInputPayload = null;
  let recordedDts = [];
  let firstFramePrimitiveSnapshot = null;
  let frameFaultCount = 0;
  let resizeObserverWrapper = null;
  let removeVisibilityMotionListeners = function noop() {};
  const hostEntries = new Map();
  const frameClock = runtimeRef.createFrameClock();
  const rng = runtimeRef.makeRng(runtimeRef.computeSceneSeed({ rendererLaunchSeed, effectId, sceneRole }));

  function pushCapped(arr, value, cap) {
    arr.push(value);
    if (arr.length > cap) { arr.shift(); }
  }

  function createHostEntry(hostDescriptor) {
    const host = hostDescriptor.element;
    const canvas = documentRef && typeof documentRef.createElement === 'function'
      ? documentRef.createElement('canvas') : null;
    if (canvas && typeof host.appendChild === 'function') {
      host.appendChild(canvas);
    }
    const ctx = canvas ? runtimeRef.ensureCanvas2d(canvas, {}) : null;
    if (defects.leakListener && typeof host.addEventListener === 'function') {
      const leaked = function noop() {};
      host.addEventListener('mousemove', leaked);
      host.addEventListener('pointerdown', leaked);
    }
    return { host, role: hostDescriptor.role, canvas, ctx };
  }

  function teardownHostEntry(entry) {
    if (entry.canvas && entry.canvas.parentNode && typeof entry.canvas.parentNode.removeChild === 'function') {
      entry.canvas.parentNode.removeChild(entry.canvas);
    }
  }

  function applyStagedVisibility() {
    hostEntries.forEach((entry) => {
      if (!entry.canvas || !entry.canvas.classList) { return; }
      if (staged) { entry.canvas.classList.remove('fixture-canvas-visible'); } else { entry.canvas.classList.add('fixture-canvas-visible'); }
    });
  }

  function applyContext(context) {
    const ctx2 = context || {};
    staged = Boolean(ctx2.staged);
    const nextHosts = Array.isArray(ctx2.hosts) ? ctx2.hosts : [];
    const nextElements = new Set(nextHosts.map((h) => h.element));
    Array.from(hostEntries.keys()).forEach((el) => {
      if (!nextElements.has(el)) {
        teardownHostEntry(hostEntries.get(el));
        hostEntries.delete(el);
      }
    });
    nextHosts.forEach((h) => {
      if (!hostEntries.has(h.element)) {
        const entry = createHostEntry(h);
        hostEntries.set(h.element, entry);
        if (resizeObserverWrapper) { resizeObserverWrapper.observe(h.element); }
      } else {
        hostEntries.get(h.element).role = h.role;
      }
    });
    applyStagedVisibility();
  }

  function captureFirstFrameSnapshot() {
    const values = [];
    for (let i = 0; i < PRIMITIVE_SNAPSHOT_SAMPLE_COUNT; i += 1) {
      values.push(Number(rng().toFixed(6)));
    }
    firstFramePrimitiveSnapshot = values;
  }

  function frame(nowMs) {
    rafHandle = 0;
    if (disposed) { return; }
    const advance = frameClock.advance(nowMs);
    pushCapped(recordedDts, advance.dtMs, DT_HISTORY_CAP);
    try {
      if (frameIndex === 0 && (defects.throwInFrame === true || defects.throwInFrame === 'reported')) {
        throw new Error('fixture-induced frame fault (' + effectId + ')');
      }
      if (defects.readRectInFrame) {
        const entry = hostEntries.values().next().value;
        if (entry && entry.host && typeof entry.host.getBoundingClientRect === 'function') {
          entry.host.getBoundingClientRect();
        }
      }
      if (frameIndex === 0) { captureFirstFrameSnapshot(); }
      frameIndex += 1;
    } catch (err) {
      frameFaultCount += 1;
      if (defects.throwInFrame === 'reported') {
        faultReporter.reportFault({ effectId, stage: 'frame', recoverable: true, error: err });
      }
      // defects.throwInFrame === true: deliberately swallowed here, no
      // reportFault call -- the negative-test bug variant the battery must
      // catch (§ RED-FIRST).
    }
    if (!disposed) {
      rafHandle = globalThis.requestAnimationFrame(frame);
    }
  }

  function bind(context) {
    if (disposed) { return; }
    if (bound) { refresh(context); return; }
    bound = true;
    removeVisibilityMotionListeners = runtimeRef.bindVisibilityAndMotionListeners({
      documentRef,
      reducedMotionQuery,
      onVisibilityChange: () => {},
      onMotionPreferenceChange: () => {},
    });
    if (typeof globalThis.ResizeObserver !== 'undefined') {
      resizeObserverWrapper = runtimeRef.createCoalescedResizeObserver({
        windowRef: { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame },
        ResizeObserverRef: globalThis.ResizeObserver,
        onResize: () => {},
      });
    }
    applyContext(context);
    rafHandle = globalThis.requestAnimationFrame(frame);
  }

  function refresh(context) {
    if (disposed || !bound) { return; }
    applyContext(context);
  }

  function dispose() {
    if (disposed) { return; }
    disposed = true;
    bound = false;
    if (rafHandle && !defects.leakRaf) {
      globalThis.cancelAnimationFrame(rafHandle);
    }
    // defects.leakRaf === true: deliberately skip cancelAnimationFrame --
    // the negative-test bug variant for the "no leaked rAF" assertion.
    if (!defects.leakRaf) { rafHandle = 0; }
    removeVisibilityMotionListeners();
    removeVisibilityMotionListeners = function noop() {};
    if (resizeObserverWrapper) {
      resizeObserverWrapper.disconnect();
      resizeObserverWrapper = null;
    }
    hostEntries.forEach(teardownHostEntry);
    hostEntries.clear();
  }

  function handleInput(payload) {
    inputCount += 1;
    lastInputPayload = payload;
    pushCapped(recentInputs, payload, INPUT_HISTORY_CAP);
  }

  function setActivity(snapshot) {
    snapshotCount += 1;
    lastSnapshot = snapshot;
    currentScopeEpoch = snapshot ? snapshot.scopeEpoch : currentScopeEpoch;
  }

  function handleActivityImpulse(impulse) {
    if (!impulse || currentScopeEpoch === null || impulse.scopeEpoch !== currentScopeEpoch) {
      ignoredImpulseCount += 1;
      return;
    }
    pushCapped(acceptedImpulses, impulse, IMPULSE_HISTORY_CAP);
  }

  function getStatus() {
    let drawableHostCount = 0;
    hostEntries.forEach((entry) => {
      const rect = entry.host && typeof entry.host.getBoundingClientRect === 'function'
        ? entry.host.getBoundingClientRect() : null;
      const hasSize = rect ? (rect.width > 0 && rect.height > 0) : true;
      if (entry.ctx && hasSize) { drawableHostCount += 1; }
    });
    return {
      state: drawableHostCount > 0 ? 'ready' : 'dormant',
      hostCount: hostEntries.size,
      drawableHostCount,
      reason: '',
    };
  }

  return {
    bind, refresh, dispose, handleInput, setActivity, handleActivityImpulse, getStatus,
    _fixture: {
      getRecordedDts: () => recordedDts.slice(),
      getFirstFramePrimitiveSnapshot: () => (firstFramePrimitiveSnapshot ? firstFramePrimitiveSnapshot.slice() : null),
      getLastInputPayload: () => lastInputPayload,
      getInputCount: () => inputCount,
      getRecentInputs: () => recentInputs.slice(),
      getSnapshotCount: () => snapshotCount,
      getLastSnapshot: () => lastSnapshot,
      getAcceptedImpulses: () => acceptedImpulses.slice(),
      getIgnoredImpulseCount: () => ignoredImpulseCount,
      getHostCount: () => hostEntries.size,
      getFrameFaultCount: () => frameFaultCount,
      isStaged: () => staged,
      isHostVisible(hostElement) {
        const entry = hostEntries.get(hostElement);
        return Boolean(entry && entry.canvas && entry.canvas.classList
          && entry.canvas.classList.contains('fixture-canvas-visible'));
      },
      isDisposed: () => disposed,
      isBound: () => bound,
    },
  };
}

// ── native-v3 conformance ──────────────────────────────────────────────────

const POINTER_LIKE_EVENTS = [
  'pointerenter', 'pointermove', 'pointerleave', 'pointerdown', 'pointerup', 'pointercancel',
  'mousemove', 'mousedown', 'mouseup', 'click',
];

function assertNoPointerListeners(effectId, host, label) {
  POINTER_LIKE_EVENTS.forEach((eventName) => {
    assert.equal(host.listenerCount(eventName), 0,
      effectId + ' ' + label + ' carries no ' + eventName + ' listener (manager-owned input)');
  });
}

function assertNoOwnedPointerListeners(effectId, host, label) {
  assertNoPointerListeners(effectId, host, label);
  Array.from((host && host.children) || []).forEach((child, index) => {
    if (child && typeof child.listenerCount === 'function') {
      assertNoPointerListeners(effectId, child, label + ' canvas[' + index + ']');
    }
  });
}

// Context shape, staged visibility, manager-owned input, dt/frame-clock
// handling, and a full bind->interact->dispose leak cycle (rAF, canvases,
// document/reduced-motion listeners, ResizeObserver instances). Respects
// options.defects so the caller can drive leakRaf/leakListener/throwInFrame
// through the SAME real assertions a clean run exercises.
function runDirectNativeContextConformance({ effectId, factory, options }) {
  const raf = createRafHarness();
  const ResizeObserverRef = createFakeResizeObserverClass();
  const reportCalls = [];
  withStubbedGlobals({ raf, ResizeObserverRef }, () => {
    const documentRef = makeFixtureDocumentRef();
    const reducedMotionQuery = createEffectMediaQueryList(false);
    const hostRectA = { left: 100, top: 40, width: 240, height: 300 };
    const hostRectB = { left: 660, top: 40, width: 240, height: 300 };
    const sceneRect = { left: 100, top: 40, width: 800, height: 300 };
    const gapRect = { left: 340, top: 40, width: 320, height: 300 };
    const hostA = makeFakeSurfaceElement(hostRectA);
    const hostB = makeFakeSurfaceElement(hostRectB);

    const factoryOptions = Object.assign({}, options, {
      effectId, documentRef, reducedMotionQuery, runtime,
      report: (fault) => reportCalls.push(fault),
    });
    const controller = factory(factoryOptions);
    assert.equal(typeof controller, 'object', effectId + ' native factory returns a controller');
    assert.equal(typeof controller.bind, 'function', effectId + ' native controller exposes bind()');
    assert.equal(typeof controller.refresh, 'function', effectId + ' native controller exposes refresh()');
    assert.equal(typeof controller.dispose, 'function', effectId + ' native controller exposes dispose()');

    const stagedContext = buildFixtureContext({
      generation: 1, staged: true,
      hosts: [{ element: hostA, role: 'chat-left' }, { element: hostB, role: 'chat-right' }],
      sceneRect,
      hostRects: [hostRectA, hostRectB],
      interactionBlockRects: [gapRect],
      paintOcclusionRects: [gapRect],
      spawnAvoidanceRects: [gapRect],
    });
    assert.doesNotThrow(() => controller.bind(stagedContext), effectId + ' bind(context) accepts the §3.1 context shape');
    assertNoOwnedPointerListeners(effectId, hostA, 'hostA');
    assertNoOwnedPointerListeners(effectId, hostB, 'hostB');
    if (controller._fixture) {
      assert.equal(controller._fixture.isHostVisible(hostA), false, effectId + ' a staged bind leaves canvases unrevealed');
    }

    const unstagedContext = buildFixtureContext({
      generation: 1, staged: false,
      hosts: [{ element: hostA, role: 'chat-left' }, { element: hostB, role: 'chat-right' }],
      sceneRect,
      hostRects: [hostRectA, hostRectB],
      interactionBlockRects: [gapRect],
      paintOcclusionRects: [gapRect],
      spawnAvoidanceRects: [gapRect],
    });
    assert.doesNotThrow(() => controller.refresh(unstagedContext), effectId + ' refresh(context) accepts the §3.1 context shape');
    if (controller._fixture) {
      assert.equal(controller._fixture.isHostVisible(hostA), true, effectId + ' an un-staged refresh reveals canvases');
    }
    assertNoOwnedPointerListeners(effectId, hostA, 'hostA post-refresh');
    assertNoOwnedPointerListeners(effectId, hostB, 'hostB post-refresh');

    let poisonedReads = 0;
    [hostA, hostB].forEach((host) => {
      host.getBoundingClientRect = () => {
        poisonedReads += 1;
        throw new Error('frame attempted a post-context geometry read');
      };
    });

    // dt handling via the runtime frame clock: a long gap resets to 0, an
    // oversized frame clamps to MAX_DT_MS -- never exceeded either way.
    raf.flush(10);
    raf.flush(5000);
    raf.flush(200);
    raf.flush(16);
    if (controller._fixture) {
      const dts = controller._fixture.getRecordedDts();
      assert.ok(dts.length > 0, effectId + ' records per-frame dts via the runtime frame clock');
      dts.forEach((dt) => {
        assert.ok(dt <= runtime.MAX_DT_MS, effectId + ' a recorded dt of ' + dt + 'ms never exceeds MAX_DT_MS');
      });
      if (!(options.defects && options.defects.throwInFrame)) {
        assert.equal(controller._fixture.getFrameFaultCount(), 0,
          effectId + ' frames consume manager snapshots instead of reading host geometry');
      }
    }
    if (!(options.defects && options.defects.throwInFrame)) {
      assert.equal(reportCalls.length, 0,
        effectId + ' post-context frames produce no geometry-read faults');
    }
    assert.equal(poisonedReads, 0, effectId + ' performs zero host rect reads after context publication');

    // interact: input + an activity snapshot, both accepted without throwing.
    assert.doesNotThrow(() => controller.handleInput({
      type: 'move', pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0, pressure: 0,
      timeStamp: 0, clientX: 10, clientY: 10, surfaceRole: 'chat-left', localX: 10, localY: 10,
      sceneX: 10, sceneY: 10, generation: 1,
    }), effectId + ' handleInput accepts a normalized payload');
    assert.doesNotThrow(() => controller.setActivity({
      scopeEpoch: 1, phase: 'idle', phaseRevision: 1, targetEnergy: 0.08, attentionScale: 1,
    }), effectId + ' setActivity accepts a snapshot');

    if (options.defects && options.defects.throwInFrame) {
      assert.equal(reportCalls.length, 1,
        effectId + ' a throwing frame is caught and reported exactly once via the injected reporter');
    }

    controller.dispose();
    assert.doesNotThrow(() => controller.dispose(), effectId + ' native dispose is idempotent');

    assert.equal(hostA.children.length, 0, effectId + ' dispose removes the injected canvas from hostA');
    assert.equal(hostB.children.length, 0, effectId + ' dispose removes the injected canvas from hostB');
    assert.equal(raf.size, 0, effectId + ' dispose cancels the pending rAF (no leaked frame)');
    assert.equal(documentRef.listenerCount('visibilitychange'), 0,
      effectId + ' dispose removes the visibilitychange listener');
    assert.equal(reducedMotionQuery.listenerCount(), 0, effectId + ' dispose removes the reduced-motion listener');
    assert.equal(ResizeObserverRef.getActiveCount(), 0, effectId + ' dispose disconnects the ResizeObserver');
  });
}

// null-context canvas removal: a documentRef whose canvases always fail
// getContext('2d') must never leave a dangling canvas in the host, and the
// controller must report 'dormant' (initialized, no drawable host) rather
// than 'ready' or a false 'failed'.
function runMissingRendererConformance({ effectId, factory, options, rendererType }) {
  const raf = createRafHarness();
  withStubbedGlobals({ raf }, () => {
    const documentRef = makeFixtureDocumentRef(
      rendererType === 'svg' ? { svgUnavailable: true } : { nullContext: true },
    );
    const reducedMotionQuery = createEffectMediaQueryList(false);
    const host = makeFakeSurfaceElement({ left: 0, top: 0, width: 300, height: 300 });
    const factoryOptions = Object.assign({}, options, { effectId, documentRef, reducedMotionQuery, runtime, defects: {} });
    const controller = factory(factoryOptions);
    const context = buildFixtureContext({ generation: 1, staged: false, hosts: [{ element: host, role: 'chat-left' }] });
    controller.bind(context);
    assert.equal(host.children.length, 0, effectId + ' a missing renderer leaves no dangling child');
    if (typeof controller.getStatus === 'function') {
      const status = controller.getStatus();
      assert.equal(status.state, 'dormant', effectId + ' a host with no drawable context reports dormant, not ready');
    }
    controller.dispose();
  });
}

// determinism: two independently-constructed controllers with the same
// {rendererLaunchSeed, effectId, sceneRole} produce an identical first-frame
// primitive snapshot (§3.7).
function runDeterminismConformance({ effectId, factory, options }) {
  const seedParams = { rendererLaunchSeed: 4242, effectId, sceneRole: 'chat' };
  function buildAndCapture() {
    const raf = createRafHarness();
    let snapshot = null;
    withStubbedGlobals({ raf }, () => {
      const documentRef = makeFixtureDocumentRef();
      const reducedMotionQuery = createEffectMediaQueryList(false);
      const host = makeFakeSurfaceElement({ left: 0, top: 0, width: 300, height: 300 });
      const factoryOptions = Object.assign({}, options, seedParams, {
        documentRef, reducedMotionQuery, runtime, defects: {},
      });
      const controller = factory(factoryOptions);
      const context = buildFixtureContext({ generation: 1, staged: false, hosts: [{ element: host, role: 'chat-left' }] });
      controller.bind(context);
      raf.flush(16);
      if (controller._fixture) { snapshot = controller._fixture.getFirstFramePrimitiveSnapshot(); }
      controller.dispose();
    });
    return snapshot;
  }
  const snapshotA = buildAndCapture();
  const snapshotB = buildAndCapture();
  if (snapshotA !== null || snapshotB !== null) {
    assert.deepEqual(snapshotA, snapshotB, effectId + ' the same seed produces an identical first-frame primitive snapshot');
    assert.ok(Array.isArray(snapshotA) && snapshotA.length > 0, effectId + ' the first-frame primitive snapshot is non-trivial');
  }
}

// reportFault plumbing, proven positively and unconditionally (independent
// of whatever options.defects the caller is negative-testing elsewhere).
// Two injection modes:
//   'defects' — the fixture's throwInFrame:'reported' switch (exactly one
//               report, used by the fixture driver).
//   'context' — a documentRef whose canvas contexts throw on their first
//               draw call; works against ANY real canvas2d native controller
//               with no test-only switches in production code.
function runReportFaultConformance({ effectId, factory, options, faultInjection = 'defects' }) {
  const raf = createRafHarness();
  const reportCalls = [];
  withStubbedGlobals({ raf }, () => {
    const documentRef = makeFixtureDocumentRef(faultInjection === 'context'
      ? { throwOnDraw: true }
      : (faultInjection === 'svg' ? { throwOnSvgWrite: true } : {}));
    const reducedMotionQuery = createEffectMediaQueryList(false);
    const host = makeFakeSurfaceElement({ left: 0, top: 0, width: 300, height: 300 });
    const factoryOptions = Object.assign({}, options, {
      effectId, documentRef, reducedMotionQuery, runtime,
      report: (fault) => reportCalls.push(fault),
    });
    if (faultInjection === 'defects') {
      factoryOptions.defects = { throwInFrame: 'reported' };
    }
    const controller = factory(factoryOptions);
    const context = buildFixtureContext({ generation: 1, staged: false, hosts: [{ element: host, role: 'chat-left' }] });
    controller.bind(context);
    raf.flush(16);
    controller.dispose();
  });
  if (faultInjection === 'defects') {
    assert.equal(reportCalls.length, 1, effectId + ' a throwing frame is caught and reported exactly once via reportFault');
  } else {
    assert.ok(reportCalls.length >= 1, effectId + ' a throwing draw context is caught and reported via reportFault');
  }
  reportCalls.forEach((fault) => {
    assert.equal(fault.effectId, effectId, effectId + ' the reported fault carries the effect id');
    assert.equal(fault.stage, 'frame', effectId + ' the reported fault stage is "frame"');
  });
}

// setActivity/handleActivityImpulse driven through a real manager instance
// (manager.setVisibleActivityScope / manager.publishStreamImpulse), proving
// scopeEpoch-mismatch impulses are ignored per §3.2.1.
function runManagerDrivenActivityConformance({ effectId, factory, options }) {
  const raf = createRafHarness();
  const clock = createClock();
  const registryEntry = { id: effectId, contractVersion: 3, inputMode: 'manager', interaction: { captureOnPress: false } };
  withStubbedGlobals({ raf }, () => {
    const documentRef = makeFixtureDocumentRef();
    const reducedMotionQuery = createEffectMediaQueryList(false);
    let controller = null;
    const built = makeRouterManager({
      raf,
      clock,
      registry: [registryEntry],
      factories: { [effectId]: (factoryOptions) => {
        controller = factory(factoryOptions);
        return controller;
      } },
      options: Object.assign({}, options, { effectId, documentRef, reducedMotionQuery, runtime, defects: {} }),
    });
    built.manager.activateSurfaceEffect(effectId);
    built.raf.flush();
    assert.ok(controller, effectId + ' activates through a real manager instance');

    if (controller._fixture) {
      built.manager.setVisibleActivityScope({ sessionId: 's1', streamId: 'stream-a' });
      const snapshot = controller._fixture.getLastSnapshot();
      assert.ok(snapshot, effectId + ' setActivity received a snapshot after a scope change');
      const epochAfterScope = snapshot.scopeEpoch;

      const acceptedBefore = controller._fixture.getAcceptedImpulses().length;
      built.manager.publishStreamImpulse({ sessionId: 's1', streamId: 'stream-a', kind: 'first-token' });
      assert.equal(controller._fixture.getAcceptedImpulses().length, acceptedBefore + 1,
        effectId + ' an impulse matching the current scope is accepted');

      // publishStreamImpulse already filters by sessionId/streamId before
      // ever reaching the controller, so the scope-EPOCH mismatch a
      // controller itself must honor (§3.2.1) is driven directly here.
      const ignoredBefore = controller._fixture.getIgnoredImpulseCount();
      controller.handleActivityImpulse({
        scopeEpoch: epochAfterScope - 1, sequence: 999, kind: 'first-token', timeStamp: 0,
      });
      assert.equal(controller._fixture.getIgnoredImpulseCount(), ignoredBefore + 1,
        effectId + ' an impulse with a stale scopeEpoch is ignored, not applied');
    }

    built.manager.activateSurfaceEffect('none');
  });
}

function runNativeV3Conformance({
  effectId,
  factory,
  options = {},
  viaManager = true,
  faultInjection = 'defects',
  rendererType = 'canvas2d',
} = {}) {
  assert.equal(typeof factory, 'function', effectId + ' exports a native factory function');
  runDirectNativeContextConformance({ effectId, factory, options });
  runMissingRendererConformance({ effectId, factory, options, rendererType });
  runDeterminismConformance({ effectId, factory, options });
  runReportFaultConformance({ effectId, factory, options, faultInjection });
  if (viaManager) {
    runManagerDrivenActivityConformance({ effectId, factory, options });
  }
}

module.exports = {
  runNativeV3Conformance,
  createConformanceFixtureController,
  createEffectMediaQueryList,
  createFakeResizeObserverClass,
  makeFixtureDocumentRef,
  makeStyledFixtureHost,
  buildFixtureContext,
  withStubbedGlobals,
};
