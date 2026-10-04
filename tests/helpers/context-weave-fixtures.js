'use strict';

// Shared fixtures for the Context Weave utils suites: a recording 2D context, the
// recording document/window fakes and the controller mount/tick/settle drivers.

const assert = require('node:assert/strict');

const contextWeave = require('../../renderer/shell/renderer-context-weave-utils.js');
const {
  createEffectMediaQueryList,
  makeStyledFixtureHost,
  buildFixtureContext,
} = require('./surface-effect-conformance.js');

const STYLE_TOKENS = {
  '--widget-context-weave-line-color': 'rgba(150, 160, 186, 0.42)',
  '--widget-context-weave-spacing': '96',
  '--widget-context-weave-density': '1',
  '--widget-context-weave-pointer-radius': '150',
  '--widget-context-weave-interlace': '3',
  '--widget-context-weave-weft-alpha': '0.7',
  '--widget-context-weave-lit-gain': '3',
};

// ── a recording 2D context ──────────────────────────────────────────────────
// The shared conformance fake swallows every draw call; the alpha-cap,
// no-shadow and bucketing oracles need to SEE what was painted, so these
// tests bring their own recorder.
function createRecordingContext(record) {
  const ctx = {
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    strokeStyle: '',
    save() {}, restore() {}, clearRect() { record.frames += 1; }, setTransform() {},
    beginPath() { ctx.__pending = 0; },
    moveTo() {}, lineTo() { ctx.__pending += 1; },
    stroke() {
      record.strokes.push({ alpha: ctx.globalAlpha, segments: ctx.__pending });
      record.shadowBlurs.push(ctx.shadowBlur);
      record.shadowColors.push(ctx.shadowColor);
    },
    __pending: 0,
  };
  return ctx;
}

function makeRecordingDocumentRef(record) {
  const listeners = new Map();
  return {
    hidden: false,
    createElement() {
      const classSet = new Set();
      return {
        tagName: 'CANVAS', parentNode: null, width: 0, height: 0, style: {},
        classList: { add: (c) => classSet.add(c), remove: (c) => classSet.delete(c), contains: (c) => classSet.has(c) },
        setAttribute() {},
        getContext() { return createRecordingContext(record); },
      };
    },
    addEventListener(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
    },
    removeEventListener(name, fn) { if (listeners.has(name)) listeners.get(name).delete(fn); },
    listenerCount(name) { return listeners.has(name) ? listeners.get(name).size : 0; },
    fire(name, payload) { (listeners.get(name) || new Set()).forEach((fn) => fn(payload)); },
  };
}

function newRecord() { return { strokes: [], shadowBlurs: [], shadowColors: [], frames: 0 }; }

function makeFakeWindow(devicePixelRatio = 1) {
  const listeners = new Map();
  return {
    devicePixelRatio,
    addEventListener(name, listener) {
      if (!listeners.has(name)) { listeners.set(name, new Set()); }
      listeners.get(name).add(listener);
    },
    removeEventListener(name, listener) { if (listeners.has(name)) { listeners.get(name).delete(listener); } },
    listenerCount(name) { return listeners.has(name) ? listeners.get(name).size : 0; },
    fire(name) { Array.from(listeners.get(name) || []).forEach((listener) => listener({ type: name })); },
  };
}

const HOST_RECT = { left: 0, top: 0, width: 900, height: 560 };

// A single full-bleed chat host -- the production shape since F1 (2026-08-21).
function mountController({
  raf, record, reducedMotion = false, tokens = STYLE_TOKENS, windowRef = makeFakeWindow(),
}) {
  const documentRef = makeRecordingDocumentRef(record);
  const reducedMotionQuery = createEffectMediaQueryList(reducedMotion);
  const host = makeStyledFixtureHost(HOST_RECT, { ...tokens });
  const controller = contextWeave.createContextWeaveController({
    documentRef, windowRef, reducedMotionQuery, rendererLaunchSeed: 17,
  });
  controller.bind(buildFixtureContext({
    hosts: [{ element: host, role: 'chat-left' }],
    sceneRect: HOST_RECT,
    hostRects: [HOST_RECT],
    spawnAvoidanceRects: [{ left: 300, top: 200, width: 240, height: 160 }],
  }));
  raf.flush(16);
  return { controller, host, documentRef, reducedMotionQuery, windowRef };
}

// Drives `count` animation ticks of `ms` each.
function tick(raf, count, ms = 16) {
  for (let i = 0; i < count; i += 1) { raf.flush(ms); }
}

// Ticks until the loop rests; fails rather than spinning if it never does.
function settle(raf, controller, limit = 200, ms = 16) {
  for (let i = 0; i < limit; i += 1) {
    if (controller._internals.inspect().pendingFrameCount === 0) { return i; }
    raf.flush(ms);
  }
  assert.fail('the loop never came to rest');
  return limit;
}

function alphaSet(record) {
  return new Set(record.strokes.map((entry) => entry.alpha.toFixed(4)));
}

function input(type, x, y, overrides = {}) {
  return Object.assign({
    type, pointerId: 1, pointerType: 'mouse', isPrimary: true,
    buttons: 0, pressure: 0, timeStamp: 32,
    clientX: x, clientY: y, surfaceRole: 'chat-left',
    localX: x, localY: y, sceneX: x, sceneY: y, generation: 1,
  }, overrides);
}

module.exports = {
  STYLE_TOKENS,
  HOST_RECT,
  newRecord,
  makeFakeWindow,
  mountController,
  tick,
  settle,
  alphaSet,
  input,
};
