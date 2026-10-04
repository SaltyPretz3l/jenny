// Atomic Burst native core suite: simulation and paint (Background Effects v3 packet S7).
// Split from renderer-atomic-burst-native.test.js to stay under the file-size ceiling;
// the controller contract, frame budget and DPR cases stay there.

const test = require('node:test');
const assert = require('node:assert/strict');

const atomicBurstCore = require('../renderer/shell/renderer-atomic-burst-core.js');
const runtime = require('../renderer/shell/renderer-surface-effect-runtime.js');
const { makeCoreEntry, step } = require('./helpers/atomic-burst-fixtures.js');

// ---- core-level helpers ---------------------------------------------------

function settlePointer(entry, startAt = 0) {
  for (let i = 0; i < 40; i += 1) { step(entry, startAt + i * 80, { dtMs: 80 }); }
  return startAt + 40 * 80;
}

function nonEmptyGroups(simulation) {
  const used = (counts) => Array.from(counts).filter((count) => count > 0).length;
  return used(simulation.groupCount) + used(simulation.haloCount);
}

function subpathCount(fills) {
  return fills.reduce((total, fill) => total + fill.path.filter((op) => op.type === 'move').length, 0);
}

// ---- core: simulation and paint --------------------------------------------

test('advanceFrame reuses its frame state (no per-frame allocation) and the core drops the retired surface', () => {
  const entry = makeCoreEntry();
  const first = atomicBurstCore.advanceFrame(entry, { timestamp: 1000, dtMs: 16, reducedMotion: false });
  const second = atomicBurstCore.advanceFrame(entry, { timestamp: 1016, dtMs: 16, reducedMotion: false });
  assert.equal(second, first);
  assert.equal(entry.simulation.frame, first);
  ['clamp', 'getWindow', 'getComputedStyleSafe', 'clearTransient', 'drawFrame']
    .forEach((name) => assert.equal(atomicBurstCore[name], undefined, name + ' is no longer exported'));
  assert.equal(entry.simulation.activityBrightnessScale, undefined);
  assert.equal(atomicBurstCore.inspectSimulation(entry.simulation).activityBrightnessScale, undefined);
});

test('the pointer fade rises with a ~160ms time constant and decays with ~420ms, so the flare outlasts the leave', () => {
  const entry = makeCoreEntry({ sparkles: [{ x: 150, y: 150 }] });
  atomicBurstCore.updatePointer(entry.simulation, 150, 150);
  step(entry, 0, { dtMs: 80 });
  step(entry, 80, { dtMs: 80 });
  assert.ok(Math.abs(entry.simulation.pointer.fade - (1 - Math.exp(-1))) < 1e-6,
    'after 160ms the fade has covered 1 - 1/e of the way (got ' + entry.simulation.pointer.fade + ')');

  let now = settlePointer(entry, 160);
  assert.equal(entry.simulation.pointer.fade, 1);
  atomicBurstCore.clearPointer(entry.simulation);
  assert.equal(atomicBurstCore.isResponding(entry.simulation), true, 'a fading hover still answers the user');
  for (let i = 0; i < 6; i += 1) { now += 70; step(entry, now, { dtMs: 70 }); }
  assert.ok(Math.abs(entry.simulation.pointer.fade - Math.exp(-1)) < 1e-6,
    'after 420ms the fade has decayed to 1/e (got ' + entry.simulation.pointer.fade + ')');
  assert.ok(entry.simulation.haloCount.some((count) => count > 0), 'the flare persists briefly after leave');

  for (let i = 0; i < 60; i += 1) { now += 80; step(entry, now, { dtMs: 80 }); }
  assert.equal(entry.simulation.pointer.fade, 0);
  assert.ok(entry.simulation.haloCount.every((count) => count === 0), 'and is gone once the fade has decayed');
  assert.equal(atomicBurstCore.isResponding(entry.simulation), false);
});

test('hover flare reaches 7x size, brightens alpha 1+1.2f and scale 1+0.5f, swaps to the flare colour above 0.5, and adds one halo', () => {
  const entry = makeCoreEntry({
    sparkles: [
      { x: 185, y: 150 }, // d = 35 -> f = 0.5 exactly (still the tint colour)
      { x: 116, y: 150, tint: 1 }, // d = 34 -> f > 0.5 (flare colour)
      { x: 220, y: 150 }, // d = 70 -> just outside 7 x 10
      { x: 221, y: 150 }, // d = 71 -> outside
    ],
  });
  atomicBurstCore.updatePointer(entry.simulation, 150, 150);
  settlePointer(entry);
  const { simulation } = entry;
  const fills = entry.ctx.frames.at(-1).fills;

  assert.ok(Math.abs(simulation.drawR[0] - 12.5) < 1e-4, 'scale x (1 + 0.5 * 0.5)');
  assert.ok(simulation.drawR[1] > 12.5);
  assert.equal(simulation.drawR[2], 10, 'a sparkle at exactly 7 x size is not flared');
  assert.equal(simulation.drawR[3], 10);

  const dot = (fill) => fill.path.find((op) => op.type === 'arc');
  const halo = fills.find((fill) => fill.fillStyle === 'color-a' && Math.abs(dot(fill).r - 12.5 * 1.9) < 1e-3);
  assert.ok(halo, 'one halo circle of radius 1.9 x size x scale in the sparkle colour');
  assert.ok(Math.abs(halo.globalAlpha - 0.16 * 0.5) < 1e-9, 'halo alpha 0.16 * f');
  const flareHalo = fills.find((fill) => fill.fillStyle === 'flare' && dot(fill) && dot(fill).r > 20);
  assert.ok(flareHalo, 'a sparkle above f = 0.5 is drawn and haloed in the flare colour');
  const sparkleFill = fills.find((fill) => fill.fillStyle === 'color-a' && Math.abs(dot(fill).r - 12.5 * 0.32) < 1e-3);
  assert.ok(sparkleFill, 'the flared sparkle still draws at the tint colour at f = 0.5');
  assert.ok(Math.abs(sparkleFill.globalAlpha - 0.8) < 1e-9, 'alpha x (1 + 1.2 * 0.5)');
  assert.equal(simulation.haloCount.reduce((sum, count) => sum + count, 0), 2,
    'only the two flared sparkles (f > 0.05) get a halo');
  assert.equal(entry.ctx.counters.shadowBlurWrites, 0);
});

test('links go to at most link-max sparkles inside link-radius, 1px, alpha 0.55 x (1 - d/radius)^2 x fade', () => {
  const sparkles = [];
  for (let k = 1; k <= 12; k += 1) { sparkles.push({ x: 150 + k * 10, y: 150 }); }
  const entry = makeCoreEntry({ sparkles, config: { linkMax: 6, linkRadius: 100 } });
  atomicBurstCore.updatePointer(entry.simulation, 150, 150);
  settlePointer(entry);
  const links = entry.ctx.frames.at(-1).strokes.filter((stroke) => stroke.lineWidth === 1);
  assert.equal(links.length, 6, 'capped at link-max although nine sparkles are inside the radius');
  assert.ok(links.every((stroke) => stroke.strokeStyle === 'link'));
  const endpoints = links.map((stroke) => stroke.path.find((op) => op.type === 'line').x).sort((a, b) => a - b);
  assert.deepEqual(endpoints, [160, 170, 180, 190, 200, 210], 'the six nearest sparkles');
  links.forEach((stroke) => {
    const line = stroke.path.find((op) => op.type === 'line');
    const falloff = 1 - (line.x - 150) / 100;
    assert.ok(Math.abs(stroke.globalAlpha - 0.55 * falloff * falloff) < 1e-9);
  });

  // The links fade with the pointer instead of vanishing.
  atomicBurstCore.clearPointer(entry.simulation);
  step(entry, 10000, { dtMs: 70 });
  const fading = entry.ctx.frames.at(-1).strokes.filter((stroke) => stroke.lineWidth === 1);
  assert.equal(fading.length, 6);
  assert.ok(fading[0].globalAlpha < links[0].globalAlpha && fading[0].globalAlpha > 0);
});

test('ring crossing tests the drawn (parallaxed) position and a crossed sparkle flares for 520ms', () => {
  function run(offsetX) {
    const entry = makeCoreEntry({ sparkles: [{ x: 88, y: 0, depth: 2 }] });
    const sparkle = entry.simulation.sparkles[0];
    atomicBurstCore.spawnWave(entry.simulation, { x: 0, y: 0, startTime: 0, config: entry.config });
    step(entry, 1, { dtMs: 1 });
    entry.simulation.parallaxOffset[2].x = offsetX;
    step(entry, 60);
    return { entry, sparkle };
  }
  const control = run(0);
  assert.equal(control.sparkle.flareStart, -1, 'the base position (88) is outside the ring front at t=60');
  const parallaxed = run(-18);
  assert.equal(parallaxed.sparkle.flareStart, 60, 'the drawn position (~72) is inside it');

  const { entry, sparkle } = parallaxed;
  for (let t = 76; t <= 200; t += 16) { step(entry, t); }
  const start = sparkle.flareStart;
  assert.ok(start >= 60 && start <= 200);
  step(entry, start + 519);
  assert.equal(sparkle.flareStart, start, 'still flaring just inside 520ms');
  assert.ok(entry.simulation.flareCount > 0);
  step(entry, start + 521);
  assert.equal(sparkle.flareStart, -1, 'the flare has expired after 520ms');
  assert.equal(entry.simulation.flareCount, 0);
});

test('rings: at most four (oldest evicted), eased to 500px over the lifetime, two strokes, a short flash, and no particles', () => {
  const entry = makeCoreEntry();
  [10, 20, 30, 40, 50].forEach((x) => atomicBurstCore.spawnWave(
    entry.simulation, { x, y: 60, startTime: 0, config: entry.config },
  ));
  let inspection = atomicBurstCore.inspectSimulation(entry.simulation);
  assert.equal(inspection.waveCount, 4);
  assert.deepEqual(inspection.waveOrigins.map((wave) => wave.x), [20, 30, 40, 50]);

  const single = makeCoreEntry({ empty: true });
  atomicBurstCore.spawnWave(single.simulation, { x: 100, y: 100, startTime: 0, config: single.config });
  step(single, 100);
  let frame = single.ctx.frames.at(-1);
  assert.equal(frame.fills.length, 1, 'only the centre flash (p < 0.18) fills');
  assert.deepEqual(frame.fills[0].path, [{ type: 'arc', x: 100, y: 100, r: 12 }]);
  assert.equal(frame.fills[0].fillStyle, 'flare');
  assert.ok(Math.abs(frame.fills[0].globalAlpha - 0.5 * (1 - 0.1 / 0.18)) < 1e-9);
  assert.equal(frame.strokes.length, 2);
  const expectedRadius = (1 - Math.pow(0.9, 2.4)) * 500;
  const [halo, core] = frame.strokes;
  assert.equal(halo.strokeStyle, 'wave');
  assert.equal(core.strokeStyle, 'wave');
  assert.equal(halo.lineWidth, 10);
  assert.equal(core.lineWidth, 2);
  assert.ok(Math.abs(halo.globalAlpha - 0.18 * 0.9) < 1e-9);
  assert.ok(Math.abs(core.globalAlpha - 0.6 * 0.9) < 1e-9);
  assert.ok(Math.abs(halo.path[0].r - expectedRadius) < 1e-9, 'radius follows 500 * (1 - (1 - p)^2.4)');

  step(single, 250);
  frame = single.ctx.frames.at(-1);
  assert.equal(frame.fills.length, 0, 'no flash and no particle dust once the ring is established');
  assert.equal(frame.strokes.length, 2);
  step(single, 1200);
  assert.equal(atomicBurstCore.inspectSimulation(single.simulation).waveCount, 0, 'a ring is released at its lifetime');
});

test('painting is bucketed: fills are bounded by the group count, not the sparkle count, with no shadowBlur or per-sparkle state', () => {
  [{ baseSize: 14, density: 1 }, { baseSize: 6, density: 1 }].forEach((tokens) => {
    const entry = makeCoreEntry({ config: tokens });
    const { simulation } = entry;
    atomicBurstCore.updatePointer(simulation, 150, 150);
    settlePointer(entry);
    step(entry, 5000);
    const frame = entry.ctx.frames.at(-1);
    assert.ok(simulation.count > 400, 'a dense field (' + simulation.count + ' sparkles)');
    assert.equal(frame.fills.length, nonEmptyGroups(simulation), 'one fill per occupied colour/alpha group');
    assert.ok(frame.fills.length <= 3 * 4 * 25 + 3 * 4 * 8, 'bounded by the bucket count');
    assert.ok(frame.fills.length < simulation.count / 2, 'far fewer fills than sparkles');
    const drawnSparkles = Array.from(simulation.groupCount).reduce((sum, count) => sum + count, 0);
    const haloed = Array.from(simulation.haloCount).reduce((sum, count) => sum + count, 0);
    assert.equal(subpathCount(frame.fills), drawnSparkles + haloed, 'every sparkle is a subpath inside a shared path');
    assert.equal(drawnSparkles, simulation.count);
    assert.equal(entry.ctx.counters.shadowBlurWrites, 0, 'shadowBlur is never set');
    assert.equal(entry.ctx.counters.saves, 0, 'no per-sparkle save');
    assert.equal(entry.ctx.counters.transforms, 0, 'no per-sparkle translate/rotate/scale');
  });
  const capped = makeCoreEntry({ config: { baseSize: 6, density: 1 } });
  assert.ok(capped.simulation.count <= atomicBurstCore.MAX_ATOMIC_SPARKLES);
  assert.ok(capped.simulation.count > 1000);
});

test('depth-0 sparkles never drop below a 0.36 alpha floor; other depths are not floored', () => {
  const entry = makeCoreEntry({
    sparkles: [{ x: 50, y: 50, depth: 0, baseOpacity: 0.1 }, { x: 150, y: 50, depth: 1, baseOpacity: 0.12 }],
  });
  step(entry, 1000);
  const alphas = entry.ctx.frames.at(-1).fills.map((fill) => fill.globalAlpha).sort((a, b) => a - b);
  assert.equal(alphas.length, 2);
  assert.ok(Math.abs(alphas[0] - 0.12) < 1e-9, 'a depth-1 sparkle keeps its own dim alpha');
  assert.ok(Math.abs(alphas[1] - 0.36) < 1e-9, 'a depth-0 sparkle is floored at 0.36');
});

test('idle breathing: alpha factor 0.55 to 1 and scale 0.85 to 1 over a per-sparkle 6-15s cycle, with no rotation', () => {
  const period = 10000;
  const entry = makeCoreEntry({
    sparkles: [{ x: 50, y: 50, depth: 1, baseOpacity: 0.8, breathPhase: 0, breathRate: (Math.PI * 2) / period }],
  });
  step(entry, period / 4);
  assert.ok(Math.abs(entry.simulation.drawR[0] - 10) < 1e-4, 'peak breath: full size');
  assert.ok(Math.abs(entry.ctx.frames.at(-1).fills[0].globalAlpha - 0.8) < 1e-9, 'peak breath: full alpha');
  step(entry, (period * 3) / 4);
  assert.ok(Math.abs(entry.simulation.drawR[0] - 8.5) < 1e-4, 'trough breath: 0.85 scale');
  assert.ok(Math.abs(entry.ctx.frames.at(-1).fills[0].globalAlpha - 0.44) < 1e-9, 'trough breath: 0.55 alpha');
  assert.equal(entry.ctx.counters.transforms, 0, 'no rotation wobble');

  const field = atomicBurstCore.buildSparkleField(400, 400, 14, 6.2, runtime.makeRng(5));
  field.all.forEach((sparkle) => {
    const cycleMs = (Math.PI * 2) / sparkle.breathRate;
    assert.ok(cycleMs >= 6000 && cycleMs <= 15000, 'each sparkle has its own 6-15s cycle');
  });
});

test('reduced-motion core paints static sparkles, a binary flare within reach, and no links, halo or rings', () => {
  const entry = makeCoreEntry({
    sparkles: [{ x: 185, y: 150 }, { x: 240, y: 150 }],
    config: { linkMax: 6 },
  });
  atomicBurstCore.updatePointer(entry.simulation, 150, 150);
  atomicBurstCore.spawnWave(entry.simulation, { x: 100, y: 100, startTime: 0, config: entry.config });
  step(entry, 1000, { reducedMotion: true, dtMs: 0 });
  const { simulation } = entry;
  assert.equal(simulation.pointer.fade, 1, 'binary: fully on while hovered');
  assert.ok(Math.abs(simulation.drawR[0] - 15) < 1e-4, 'in reach: full flare (scale x 1.5), not a distance ramp');
  assert.equal(simulation.drawR[1], 10, 'out of reach: untouched, with the breath pinned at 1');
  const frame = entry.ctx.frames.at(-1);
  assert.equal(frame.strokes.length, 0, 'no links and no rings');
  assert.ok(simulation.haloCount.every((count) => count === 0), 'no halo');
  assert.equal(atomicBurstCore.inspectSimulation(simulation).waveCount, 0, 'rings are cleared');
  assert.ok(frame.fills.some((fill) => fill.fillStyle === 'flare'));

  atomicBurstCore.clearPointer(simulation);
  step(entry, 1016, { reducedMotion: true, dtMs: 0 });
  assert.equal(simulation.pointer.fade, 0, 'off immediately on leave');
  assert.equal(simulation.drawR[0], 10);
});

test('star outlines come from precomputed unit tables, not per-sparkle trig', () => {
  const entry = makeCoreEntry({
    sparkles: [{ x: 50, y: 50, shape: 1, size: 20 }, { x: 150, y: 50, shape: 2, size: 20, tint: 1 }],
  });
  const originalSin = Math.sin;
  const originalCos = Math.cos;
  let trig = 0;
  Math.sin = (value) => { trig += 1; return originalSin(value); };
  Math.cos = (value) => { trig += 1; return originalCos(value); };
  try {
    step(entry, 1000);
  } finally {
    Math.sin = originalSin;
    Math.cos = originalCos;
  }
  const paths = entry.ctx.frames.at(-1).fills.map((fill) => fill.path);
  const vertices = (path) => path.filter((op) => op.type === 'move' || op.type === 'line').length;
  assert.equal(vertices(paths.find((path) => path[0].x < 100)), 8, 'four-point star: 4 tips + 4 notches');
  assert.equal(vertices(paths.find((path) => path[0].x > 100)), 12, 'six-point star: 6 tips + 6 notches');
  assert.equal(trig, 2, 'only the per-sparkle breath sin runs in the frame (no outline trig)');
});

test('retired atomic tuning tokens (bloom, wave-speed) are gone from the registry, schema and styles', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const appearance = require('../renderer/shared/appearance-utils.js');
  const retired = ['--widget-atomic-burst-bloom', '--widget-atomic-burst-wave-speed'];
  const preset = appearance.getSurfaceEffectPresets().find((item) => item.id === 'atomic-burst');
  retired.forEach((name) => {
    assert.equal(preset.requiredTokens.includes(name), false, `${name} is not a required token`);
    assert.equal(runtime.getTokenSchema(name), null, `${name} has no schema row`);
  });
  const stylesDir = path.join(__dirname, '..', 'styles');
  fs.readdirSync(stylesDir).filter((file) => file.endsWith('.css')).forEach((file) => {
    const css = fs.readFileSync(path.join(stylesDir, file), 'utf8');
    retired.forEach((name) => assert.equal(css.includes(name), false, `${file} does not declare ${name}`));
  });
});