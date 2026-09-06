// Shared harness for the Background Effects v3 surface-effect suites
// (tests/renderer-app-surface-effects.test.js -- S2 manager cases -- and
// tests/renderer-app-surface-input.test.js -- S3 pointer-input router cases).
// Everything here was extracted verbatim from the S2 suite when the S3 cases
// pushed it past the repo's 1015-line file cap; no behavior differs.

const surfaceEffects = require('../../renderer/app/renderer-app-surface-effects.js');

// ── Shared harness ──────────────────────────────────────────────────────────

// Copied from tests/renderer-atomic-burst-utils.test.js's createRafHarness pattern.
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
    cancelAnimationFrame(id) {
      callbacks.delete(id);
    },
    flush(ms = 16) {
      const pending = Array.from(callbacks.entries());
      callbacks.clear();
      now += ms;
      pending.forEach(([, callback]) => callback(now));
      return now;
    },
    get now() {
      return now;
    },
    get size() {
      return callbacks.size;
    },
  };
}

// A controllable clock backing windowRef.performance.now(), so the arbiter's
// 240ms merge window and the 10000ms frame-failure window are deterministic.
function createClock(initial = 0) {
  return { value: initial };
}

function createLogRecorder() {
  const entries = [];
  return {
    entries,
    record(level, event, payload) {
      entries.push({ level, event, payload });
    },
  };
}

// A spy controller matching the {bind, refresh, dispose, getStatus,
// setActivity, handleActivityImpulse} contract. Every call is recorded;
// `overrides.on<Method>` lets a test inject throwing/returning behavior.
function makeFakeController(overrides = {}) {
  const calls = {
    bind: [], refresh: [], dispose: [], getStatus: [], setActivity: [], handleActivityImpulse: [],
    handleInput: [],
  };
  const controller = {
    calls,
    bind(...args) {
      calls.bind.push(args);
      if (typeof overrides.onBind === 'function') return overrides.onBind(...args);
      return undefined;
    },
    refresh(...args) {
      calls.refresh.push(args);
      if (typeof overrides.onRefresh === 'function') return overrides.onRefresh(...args);
      return undefined;
    },
    dispose(...args) {
      calls.dispose.push(args);
      if (typeof overrides.onDispose === 'function') return overrides.onDispose(...args);
      return undefined;
    },
    setActivity(...args) {
      calls.setActivity.push(args);
      if (typeof overrides.onSetActivity === 'function') return overrides.onSetActivity(...args);
      return undefined;
    },
    handleActivityImpulse(...args) {
      calls.handleActivityImpulse.push(args);
      if (typeof overrides.onHandleActivityImpulse === 'function') return overrides.onHandleActivityImpulse(...args);
      return undefined;
    },
    // Input-router contract: every shipped controller receives handleInput.
    handleInput(...args) {
      calls.handleInput.push(args);
      if (typeof overrides.onHandleInput === 'function') return overrides.onHandleInput(...args);
      return undefined;
    },
  };
  if (overrides.getStatus !== undefined) {
    controller.getStatus = (...args) => {
      calls.getStatus.push(args);
      return typeof overrides.getStatus === 'function' ? overrides.getStatus(...args) : overrides.getStatus;
    };
  }
  return controller;
}

// Wires a fresh createSurfaceEffectManager() instance around a rAF harness,
// controllable clock, and log recorder. Every test builds its own manager --
// no shared state across tests.
function makeManager(overrides = {}) {
  const raf = overrides.raf || createRafHarness();
  const clock = overrides.clock || createClock();
  const logs = overrides.logs || createLogRecorder();
  const cleanups = [];
  const registry = overrides.registry || [];
  const windowRef = Object.assign({
    requestAnimationFrame: raf.requestAnimationFrame,
    cancelAnimationFrame: raf.cancelAnimationFrame,
    performance: { now: () => clock.value },
    rendererAppSurfaceLayout: require('../../renderer/app/renderer-app-surface-layout.js'),
  }, overrides.windowRef || {});
  const callbacks = Object.assign({
    appendClientLog: logs.record,
    isDisposed: () => false,
    registerCleanup: (fn) => { cleanups.push(fn); },
    getEffectRegistry: () => registry,
    resolveActivityPhase: null,
  }, overrides.callbacks || {});
  const manager = surfaceEffects.createSurfaceEffectManager({
    state: overrides.state || { ui: { activeView: 'chat', appearance: { surfaceEffectId: 'none' } } },
    windowRef,
    documentRef: overrides.documentRef || null,
    factories: overrides.factories || {},
    options: overrides.options || {},
    dom: overrides.dom || {},
    callbacks,
  });
  return {
    manager, raf, clock, logs, cleanups, registry,
  };
}

function findLog(logs, predicate) {
  return logs.entries.find(predicate);
}

const NATIVE_ENTRY = Object.freeze({
  id: 'fake-native', contractVersion: 3, inputMode: 'manager', interaction: Object.freeze({ captureOnPress: false }),
});
const NATIVE_CAPTURE_ENTRY = Object.freeze({
  id: 'fake-native-capture', contractVersion: 3, inputMode: 'manager', interaction: Object.freeze({ captureOnPress: true }),
});
const NATIVE_ENTRY_2 = Object.freeze({
  id: 'fake-native-2', contractVersion: 3, inputMode: 'manager', interaction: Object.freeze({ captureOnPress: false }),
});
// Plain-object event target: addEventListener/removeEventListener recording
// listeners into a Set per event name, plus a `fire` helper tests use to
// simulate the browser dispatching an event to registered listeners.
function makeFakeEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(eventName, listener) {
      if (!listeners.has(eventName)) listeners.set(eventName, new Set());
      listeners.get(eventName).add(listener);
    },
    removeEventListener(eventName, listener) {
      const set = listeners.get(eventName);
      if (set) set.delete(listener);
    },
    listenerCount(eventName) {
      const set = listeners.get(eventName);
      return set ? set.size : 0;
    },
    fire(eventName, event) {
      const set = listeners.get(eventName);
      if (!set) return;
      Array.from(set).forEach((listener) => listener(event || { type: eventName }));
    },
  };
}

// A fake surface/gutter DOM node: configurable getBoundingClientRect, plus
// setPointerCapture/releasePointerCapture and dispatchEvent recording.
// appendChild/removeChild/children (S4 addition, additive-only): lets a
// v3 conformance fixtures inject/remove a per-host canvas and let
// tests assert on child count for leak checks, without touching real DOM.
function makeFakeSurfaceElement(rect) {
  const events = makeFakeEventTarget();
  const element = Object.assign({}, events, {
    rect: rect || { left: 0, top: 0, width: 0, height: 0 },
    dispatched: [],
    captureCalls: [],
    releaseCalls: [],
    children: [],
    getBoundingClientRect() { return element.rect; },
    dispatchEvent(event) {
      element.dispatched.push(event);
      events.fire(event.type, event);
      return true;
    },
    setPointerCapture(pointerId) { element.captureCalls.push(pointerId); },
    releasePointerCapture(pointerId) { element.releaseCalls.push(pointerId); },
    appendChild(node) {
      if (node && node.parentNode && typeof node.parentNode.removeChild === 'function' && node.parentNode !== element) {
        node.parentNode.removeChild(node);
      }
      // Re-appending a node this element already holds MOVES it in the real DOM.
      // Pushing again would leave two entries for one node and quietly inflate
      // every child-count assertion made through this fake.
      const existing = element.children.indexOf(node);
      if (existing !== -1) { element.children.splice(existing, 1); }
      element.children.push(node);
      if (node) { node.parentNode = element; }
      return node;
    },
    removeChild(node) {
      const idx = element.children.indexOf(node);
      if (idx === -1) {
        // Real DOM throws NotFoundError here. Staying silent let a double-dispose
        // detach the same node twice and still satisfy an idempotence oracle that
        // would have thrown against a real node.
        const error = new Error(
          'removeChild: the node to be removed is not a child of this node',
        );
        error.name = 'NotFoundError';
        throw error;
      }
      element.children.splice(idx, 1);
      if (node) { node.parentNode = null; }
      return node;
    },
  });
  return element;
}

// Chat publishes exactly one full-bleed effect host (F1, 2026-08-21). The
// former right gutter was `display: none` in production yet still published,
// so the old two-element default made every manager test assert a canvas the
// user could never see. `leftRect` therefore defaults to the whole chat rect.
function makeRouterDom(rects = {}) {
  return {
    chatView: makeFakeSurfaceElement(rects.chatRect || { left: 0, top: 0, width: 800, height: 600 }),
    homeView: makeFakeSurfaceElement(rects.homeRect || { left: 0, top: 0, width: 800, height: 600 }),
    chatSurfaceEffectLeft: makeFakeSurfaceElement(rects.leftRect || { left: 0, top: 0, width: 800, height: 600 }),
  };
}

function makePointerEvent(type, overrides = {}) {
  return Object.assign({
    type,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    buttons: 0,
    pressure: 0,
    timeStamp: 0,
    clientX: 0,
    clientY: 0,
    composedPath: () => [],
  }, overrides);
}

// Wires makeManager() with a windowRef that carries rendererAppSurfaceInput
// (so the manager constructs the real router), a fake document with a
// `hidden` flag, and a dom carrying chatView/homeView/gutter fakes. Loads the
// router module lazily (call-time, not file-load-time) so that only the
// tests which actually exercise the router fail if the module is absent
// (red-first evidence for S3 needs the S2 cases green without it).
function makeRouterManager(overrides = {}) {
  const surfaceInput = require('../../renderer/app/renderer-app-surface-input.js');
  const raf = overrides.raf || createRafHarness();
  const dom = overrides.dom || makeRouterDom();
  const windowEvents = makeFakeEventTarget();
  const documentRef = overrides.documentRef || Object.assign({ hidden: false }, makeFakeEventTarget());
  const windowRef = Object.assign({
    addEventListener: windowEvents.addEventListener,
    removeEventListener: windowEvents.removeEventListener,
    fire: windowEvents.fire,
    listenerCount: windowEvents.listenerCount,
    rendererAppSurfaceInput: surfaceInput,
  }, overrides.windowRef || {});
  const built = makeManager(Object.assign({}, overrides, { raf, dom, documentRef, windowRef }));
  return Object.assign(built, {
    dom, documentRef, windowExtras: windowEvents, surfaceInput,
  });
}

module.exports = {
  createRafHarness,
  createClock,
  createLogRecorder,
  makeFakeController,
  makeManager,
  findLog,
  NATIVE_ENTRY,
  NATIVE_CAPTURE_ENTRY,
  NATIVE_ENTRY_2,
  makeFakeEventTarget,
  makeFakeSurfaceElement,
  makeRouterDom,
  makePointerEvent,
  makeRouterManager,
};
