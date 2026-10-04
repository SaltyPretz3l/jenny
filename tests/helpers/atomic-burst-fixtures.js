'use strict';

// Shared fixtures for the Atomic Burst native suites: a recording 2d context and
// the core-level entry builders (used by the controller and core/paint suites).

const atomicBurstCore = require('../../renderer/shell/renderer-atomic-burst-core.js');
const runtime = require('../../renderer/shell/renderer-surface-effect-runtime.js');

// with the path batched into it, so batching, bucket use and forbidden calls
// (shadowBlur, per-sparkle save/translate/rotate/scale) are observable.
function createRecordingContext() {
  const frames = [];
  const counters = { shadowBlurWrites: 0, saves: 0, transforms: 0 };
  let frame = null;
  let path = [];
  const ctx = {
    frames,
    counters,
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    lineCap: 'butt',
    save() { counters.saves += 1; },
    restore() {},
    translate() { counters.transforms += 1; },
    rotate() { counters.transforms += 1; },
    scale() { counters.transforms += 1; },
    setTransform() {},
    clearRect() { frame = { fills: [], strokes: [] }; frames.push(frame); },
    beginPath() { path = []; },
    moveTo(x, y) { path.push({ type: 'move', x, y }); },
    lineTo(x, y) { path.push({ type: 'line', x, y }); },
    closePath() { path.push({ type: 'close' }); },
    arc(x, y, r) { path.push({ type: 'arc', x, y, r }); },
    fill() {
      if (frame) { frame.fills.push({ fillStyle: ctx.fillStyle, globalAlpha: ctx.globalAlpha, path }); }
      path = [];
    },
    stroke() {
      if (frame) {
        frame.strokes.push({
          strokeStyle: ctx.strokeStyle, lineWidth: ctx.lineWidth, globalAlpha: ctx.globalAlpha, path,
        });
      }
      path = [];
    },
  };
  Object.defineProperty(ctx, 'shadowBlur', {
    get() { return 0; },
    set() { counters.shadowBlurWrites += 1; },
  });
  return ctx;
}

function makeSparkle(overrides = {}) {
  // breathRate 0 + phase pi/2 pins the breath at 1 (alpha and scale factors 1).
  return Object.assign({
    x: 0, y: 0, size: 10, depth: 1, shape: 0, tint: 0, baseOpacity: 0.5,
    breathPhase: Math.PI / 2, breathRate: 0, flareStart: -1,
  }, overrides);
}

function makeCoreEntry({ sparkles = null, config = {}, width = 300, height = 300, empty = false } = {}) {
  const simulation = atomicBurstCore.createSimulationState();
  const fullConfig = Object.assign({
    baseSize: 14, density: 6.2,
    colorA: 'color-a', colorB: 'color-b', colorC: 'color-c',
    flareColor: 'flare', linkColor: 'link', waveColor: 'wave',
    linkRadius: 100, linkMax: 6, waveLifetime: 1000,
  }, config);
  if (empty) {
    // No field at all: only rings and the pointer have anything to draw.
  } else if (sparkles) {
    // A one-row field of exactly N cells, then overwritten with hand-placed sparkles.
    atomicBurstCore.rebuildField(
      simulation, 100 * sparkles.length, 100,
      Object.assign({}, fullConfig, { baseSize: 100, density: 1 }), 1, runtime.makeRng,
    );
    simulation.sparkles.forEach((sparkle, index) => Object.assign(sparkle, makeSparkle(sparkles[index])));
  } else {
    atomicBurstCore.rebuildField(simulation, width, height, fullConfig, 1, runtime.makeRng);
  }
  return {
    simulation, config: fullConfig, w: width, h: height, dpr: 1, canvas: {}, ctx: createRecordingContext(),
  };
}

function step(entry, timestamp, extra = {}) {
  const frame = atomicBurstCore.advanceFrame(entry, Object.assign({
    timestamp, dtMs: 16, longGap: false, reducedMotion: false,
  }, extra));
  atomicBurstCore.drawViewport(entry, frame, { viewportX: 0, viewportY: 0 });
  return frame;
}

module.exports = {
  createRecordingContext,
  makeSparkle,
  makeCoreEntry,
  step,
};
