'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const core = require('../renderer/shell/renderer-playlist-scroll-core.js');

const config = Object.freeze({
  laneHeight: 28,
  subdivisions: 4,
  barWidth: 120,
  speed: 2,
});
const STEP = config.barWidth / config.subdivisions;

function makeEnv(overrides = {}) {
  return Object.assign({
    config, sceneWidth: 600, sceneHeight: 280, spawnAllowed: () => true,
    timestamp: 0, dtMs: 0, longGap: false, reducedMotion: false,
  }, overrides);
}

function commit(scene, col, lane, overrides = {}) {
  return core.commitCell(scene, col, lane, config, Object.assign({
    timeStamp: 0, reducedMotion: false, spawnAllowed: () => true,
  }, overrides));
}

test('shared scene advances exactly once and keeps one bounded note pool for every viewport', () => {
  const scene = core.createSceneState(42);
  core.resetSceneGeometry(scene, config, 600, 280);
  const snapped = core.snapScenePosition(scene, { sceneX: 220, sceneY: 70 }, config, 600, 280);
  assert.deepEqual([snapped.col, snapped.lane, snapped.sceneX, snapped.width], [7, 2, 210, 30]);
  assert.equal(commit(scene, snapped.col, snapped.lane, { timeStamp: 10 }), true);
  core.advanceScene(scene, makeEnv({ dtMs: 16.667, timestamp: 30 }));
  assert.ok(Math.abs(scene.totalScroll - 2) < 0.001);
  assert.equal(scene.notes.length, 1);
  assert.equal(scene.ripples.length, 1);
});

test('the commit path carries no model-reactive state or entry points', () => {
  const scene = core.createSceneState(1);
  ['autoNoteSequence', 'autoCredit', 'autoNextCost', 'autoPrevLane', 'noteSequence'].forEach((field) => {
    assert.equal(field in scene, false, field + ' is gone from the scene');
  });
  ['resetAutoComposer', 'advanceAutoComposer', 'commitScriptedNote', 'spawnScriptedFlare', 'laneCenterY',
    'updatePreview', 'clearTransient'].forEach((name) => {
    assert.equal(core[name], undefined, name + ' is no longer exported');
  });
  assert.equal(core._internals.AUTO_NOTE_HEADROOM, undefined);
});

test('spawn avoidance rejects notes and crossing flares but never pauses simulation', () => {
  const scene = core.createSceneState(7);
  core.resetSceneGeometry(scene, config, 600, 280);
  assert.equal(commit(scene, 8, 3, { spawnAllowed: () => false }), false);
  core.advanceScene(scene, makeEnv({ dtMs: 16.667, timestamp: 20, spawnAllowed: () => false }));
  assert.equal(scene.totalScroll, 2, 'scene time advances while every spawn point is avoided');
  assert.equal(scene.notes.length, 0);
  assert.equal(scene.crossingFlares.length, 0);
  assert.ok(scene.ghostNotes.length > 0, 'ambient ghosts are not spawn-avoidance gated');
});

test('spawn-avoidance-only changes keep the ghosts identical (they are a pure function of the seed)', () => {
  function ghostsFor(spawnAllowed) {
    const scene = core.createSceneState(42);
    core.resetSceneGeometry(scene, config, 600, 280);
    core.advanceScene(scene, makeEnv({ spawnAllowed }));
    return JSON.stringify(scene.ghostNotes);
  }
  const open = ghostsFor(() => true);
  assert.notEqual(open, '[]');
  assert.equal(ghostsFor(() => false), open, 'an avoidance rect never removes or re-rolls a ghost');
  assert.equal(ghostsFor((x) => x > 300), open);

  // A regenerated window (geometry reset at the same scroll) reproduces them too.
  const scene = core.createSceneState(42);
  core.resetSceneGeometry(scene, config, 600, 280);
  core.advanceScene(scene, makeEnv());
  core.resetSceneGeometry(scene, config, 600, 280);
  core.advanceScene(scene, makeEnv());
  assert.equal(JSON.stringify(scene.ghostNotes), open);
});

test('scene identity reset decorrelates roles without retaining user transients', () => {
  const scene = core.createSceneState(11);
  scene.totalScroll = 20;
  scene.notes.push({ worldX: 30, width: 10, placedAt: 0, lane: 0 });
  core.updatePointer(scene, 10, 10, config, 600, 280, false);
  assert.ok(scene.preview);
  core.resetSceneIdentity(scene, 99);
  assert.equal(scene.seed, 99);
  assert.equal(scene.totalScroll, 0);
  assert.equal(scene.notes.length, 0);
  assert.equal(scene.preview, null);
  assert.equal(scene.pointer.active, false);
});

test('deterministic helper exports preserve the established playlist utility contract', () => {
  const first = core._internals.generateGhostNoteForBar(42, 8, [2], 10, 4);
  const second = core._internals.generateGhostNoteForBar(42, 8, [2], 10, 4);
  assert.deepEqual(first, second);
  assert.deepEqual(core._internals.parseRgba('rgba(10,20,30,0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(core._internals.NOTE_MAX_CONCURRENT, 96);
  assert.equal(core._internals.shadeRgba, undefined, 'the retired gradient shade helper is gone');
});

test('one note per cell: a repeat commit of the same cell is refused and leaves no extra ripple', () => {
  const scene = core.createSceneState(3);
  core.resetSceneGeometry(scene, config, 600, 280);
  assert.equal(commit(scene, 4, 2), true);
  assert.equal(commit(scene, 4, 2), false, 'the same cell never doubles');
  assert.equal(scene.notes.length, 1);
  assert.equal(scene.ripples.length, 1);
  assert.equal(commit(scene, 4, 3), true, 'the same column in another lane is a different cell');
  assert.equal(commit(scene, 5, 2), true, 'the next column is a different cell');
  assert.equal(scene.notes.length, 3);
});

test('drag interpolation fills every cell between two samples on the cell grid', () => {
  const scene = core.createSceneState(5);
  core.resetSceneGeometry(scene, config, 600, 280);
  const painted = core.commitCellRun(scene, { col: 0, lane: 0 }, { col: 6, lane: 3 }, config, {
    timeStamp: 1, reducedMotion: false, spawnAllowed: () => true,
  });
  assert.equal(painted, 6, 'one note per step of the longer axis');
  const cells = scene.notes.map((note) => [Math.round(note.worldX / STEP), note.lane]);
  assert.deepEqual(cells, [[1, 1], [2, 1], [3, 2], [4, 2], [5, 3], [6, 3]]);
  assert.equal(core.commitCellRun(scene, { col: 6, lane: 3 }, { col: 6, lane: 3 }, config, {}), 0,
    'an unchanged cell paints nothing');
  const again = core.commitCellRun(scene, { col: 0, lane: 0 }, { col: 6, lane: 3 }, config, {
    timeStamp: 2, reducedMotion: false, spawnAllowed: () => true,
  });
  assert.equal(again, 0, 're-painting an already painted path adds nothing');
});

test('the hover preview re-snaps at every advance so it tracks the scroll', () => {
  const scene = core.createSceneState(9);
  core.resetSceneGeometry(scene, config, 600, 280);
  core.updatePointer(scene, 47, 55, config, 600, 280, false);
  assert.deepEqual([scene.preview.sceneX, scene.preview.lane], [30, 1]);
  scene.totalScroll = 40;
  assert.deepEqual([scene.preview.sceneX, scene.preview.lane], [30, 1], 'untouched until the next paint');
  core.advanceScene(scene, makeEnv({ dtMs: 0, timestamp: 100 }));
  assert.equal(scene.preview.sceneX, Math.floor((47 + 40) / STEP) * STEP - 40);
  assert.notEqual(scene.preview.sceneX, 30);
  core.clearPointer(scene, false);
  assert.equal(scene.preview, null);
});

test('the pointer highlight fades toward its target and is binary in reduced motion', () => {
  const scene = core.createSceneState(9);
  core.resetSceneGeometry(scene, config, 600, 280);
  core.updatePointer(scene, 47, 55, config, 600, 280, false);
  assert.equal(scene.pointer.fade, 0, 'an animated hover fades in rather than popping');
  core.advanceScene(scene, makeEnv({ dtMs: 220, timestamp: 100 }));
  assert.ok(Math.abs(scene.pointer.fade - (1 - Math.exp(-1))) < 1e-6, 'time constant is 220 ms');
  for (let i = 0; i < 40; i += 1) { core.advanceScene(scene, makeEnv({ dtMs: 80, timestamp: 200 + i * 80 })); }
  assert.equal(scene.pointer.fade, 1);
  core.clearPointer(scene, false);
  assert.equal(scene.pointer.fade, 1, 'leave fades out over the next frames');
  for (let i = 0; i < 40; i += 1) { core.advanceScene(scene, makeEnv({ dtMs: 80, timestamp: 4000 + i * 80 })); }
  assert.equal(scene.pointer.fade, 0);
  assert.equal(scene.pointer.hasSnap, false);

  core.updatePointer(scene, 47, 55, config, 600, 280, true);
  assert.equal(scene.pointer.fade, 1, 'reduced motion shows the highlight at once');
  core.clearPointer(scene, true);
  assert.equal(scene.pointer.fade, 0, 'and clears it at once');
});

test('cancel-style pointer clearing keeps notes and ripples; motion reset only drops live rings', () => {
  const scene = core.createSceneState(2);
  core.resetSceneGeometry(scene, config, 600, 280);
  commit(scene, 3, 1, { timeStamp: 5 });
  core.updatePointer(scene, 100, 50, config, 600, 280, false);
  core.clearPointer(scene, false);
  assert.equal(scene.notes.length, 1);
  assert.equal(scene.ripples.length, 1);
  core.resetMotion(scene);
  assert.equal(scene.notes.length, 1, 'notes are user work and survive a motion-preference switch');
  assert.equal(scene.ripples.length, 0);
});

test('notes expire after 12 s, scroll off, and reduced motion drops them at the next static paint past their life', () => {
  const scene = core.createSceneState(8);
  core.resetSceneGeometry(scene, config, 600, 280);
  commit(scene, 10, 1, { timeStamp: 1000 });
  core.advanceScene(scene, makeEnv({ timestamp: 12999 }));
  assert.equal(scene.notes.length, 1, 'alive until the 12 s mark');
  core.advanceScene(scene, makeEnv({ timestamp: 13000 }));
  assert.equal(scene.notes.length, 0, 'removed at 12 s');

  commit(scene, 10, 1, { timeStamp: 1000 });
  core.advanceScene(scene, makeEnv({ timestamp: 12999, reducedMotion: true }));
  assert.equal(scene.notes.length, 1, 'a static frame holds a live note');
  core.advanceScene(scene, makeEnv({ timestamp: 99999, reducedMotion: true }));
  assert.equal(scene.notes.length, 0, 'a static paint past its life drops it');
});

test('notes crossing the playhead fire one bounded flare and respect spawn avoidance', () => {
  const scene = core.createSceneState(4);
  core.resetSceneGeometry(scene, config, 600, 280);
  commit(scene, 8, 1, { timeStamp: 0 });
  assert.equal(scene.notes[0].crossed, false);
  const fast = Object.assign({}, config, { speed: 30 });
  for (let i = 0; i < 4; i += 1) {
    core.advanceScene(scene, makeEnv({ config: fast, dtMs: 16.667, timestamp: i * 16.667 }));
  }
  assert.equal(scene.notes[0].crossed, true);
  assert.equal(scene.crossingFlares.length, 1);
  assert.ok(scene.crossingFlares.length <= core._internals.CROSSING_FLARE_MAX_CONCURRENT);
});

// A recording 2d context: every primitive logged with the style in force at the call.
function createRecordingContext() {
  const calls = [];
  const state = { fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1, globalCompositeOperation: 'source-over' };
  const ctx = {
    calls,
    setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    clearRect() { calls.length = 0; },
    fillRect(...args) { calls.push({ type: 'fillRect', args, fillStyle: state.fillStyle, globalAlpha: state.globalAlpha }); },
    roundRect(...args) { calls.push({ type: 'roundRect', args }); },
    fill() {
      const pending = calls.filter((call) => call.type === 'roundRect' && call.fillStyle === undefined);
      pending.forEach((call) => { call.fillStyle = state.fillStyle; call.globalAlpha = state.globalAlpha; });
      calls.push({ type: 'fill', fillStyle: state.fillStyle, globalAlpha: state.globalAlpha });
    },
    arc(...args) { calls.push({ type: 'arc', args, globalAlpha: state.globalAlpha, strokeStyle: state.strokeStyle }); },
    drawImage() {}, createLinearGradient() { return { addColorStop() {} }; },
  };
  ['fillStyle', 'strokeStyle', 'globalAlpha', 'lineWidth', 'globalCompositeOperation'].forEach((name) => {
    Object.defineProperty(ctx, name, { get: () => state[name], set: (value) => { state[name] = value; } });
  });
  return ctx;
}

function drawEntry(scene, overrides = {}) {
  const ctx = createRecordingContext();
  const entry = Object.assign({
    config: Object.assign({
      barWidth: 120, laneHeight: 28, subdivisions: 4, contrast: 1,
      laneAlpha: 0.1, barAlpha: 0.18, subAlpha: 0.07, accentAlpha: 0.25, playheadAlpha: 0.18, edgeFade: 0,
      lineString: 'rgba(1,2,3,1)', ghostString: 'rgba(4,5,6,0.2)',
      accentString: 'rgba(10,200,30,1)', noteString: 'rgba(10,200,30,0.9)',
    }, overrides.config || {}),
    ctx, w: 300, h: 280, dpr: 1, host: null, tileCanvas: null,
  }, overrides.entry || {});
  return { ctx, entry };
}

function draw(scene, entry, now, extra = {}) {
  core.drawViewport(scene, entry, Object.assign({
    now, runtime: null, viewportX: 0, viewportY: 0, sceneHeight: 280, settled: false,
  }, extra));
}

test('a note fills with the accent colour, flat, with no shadow glow and one batched fill', () => {
  const scene = core.createSceneState(6);
  core.resetSceneGeometry(scene, config, 300, 280);
  commit(scene, 1, 1, { timeStamp: 0 });
  commit(scene, 2, 2, { timeStamp: 0 });
  const { ctx, entry } = drawEntry(scene);
  let shadowWrites = 0;
  Object.defineProperty(ctx, 'shadowBlur', { get: () => 0, set: () => { shadowWrites += 1; } });
  draw(scene, entry, 1000);
  const noteFills = ctx.calls.filter((call) => call.type === 'fill' && call.fillStyle === 'rgba(10,200,30,0.9)');
  assert.equal(noteFills.length, 1, 'both settled notes share one path and one fill');
  assert.equal(noteFills[0].globalAlpha, 1);
  assert.equal(ctx.calls.filter((call) => call.type === 'roundRect').length, 2);
  assert.equal(shadowWrites, 0, 'no per-note shadowBlur glow');
});

test('notes fade linearly over the final 2 s and are skipped once gone', () => {
  const scene = core.createSceneState(6);
  core.resetSceneGeometry(scene, config, 300, 280);
  commit(scene, 1, 1, { timeStamp: 0 });
  const alphaAt = (now) => {
    const { ctx, entry } = drawEntry(scene);
    draw(scene, entry, now);
    const fill = ctx.calls.find((call) => call.type === 'fill' && call.fillStyle === 'rgba(10,200,30,0.9)');
    return fill ? fill.globalAlpha : null;
  };
  assert.equal(alphaAt(9999), 1, 'full strength before the fade window');
  assert.equal(alphaAt(10000), 1);
  assert.ok(Math.abs(alphaAt(11000) - 0.5) < 1e-9, 'half way through the fade window');
  assert.ok(Math.abs(alphaAt(11500) - 0.25) < 1e-9);
  assert.equal(alphaAt(12000), null, 'drawn no more at 12 s');
  assert.equal(core._internals.NOTE_LIFETIME_MS, 12000);
  assert.equal(core._internals.NOTE_FADE_MS, 2000);
});

test('the placement pop scales 1.15 to 1 over 200 ms, and a settled (reduced-motion) draw skips it', () => {
  const scene = core.createSceneState(6);
  core.resetSceneGeometry(scene, config, 300, 280);
  commit(scene, 1, 1, { timeStamp: 0 });
  const widthAt = (now, settled) => {
    const { ctx, entry } = drawEntry(scene);
    draw(scene, entry, now, { settled });
    return ctx.calls.find((call) => call.type === 'roundRect').args[2];
  };
  assert.ok(Math.abs(widthAt(0, false) - STEP * 1.15) < 1e-9, 'a new note starts at 1.15x');
  assert.ok(widthAt(100, false) > STEP && widthAt(100, false) < STEP * 1.15);
  assert.equal(widthAt(200, false), STEP, 'settles at exactly 1x after 200 ms');
  assert.equal(widthAt(0, true), STEP, 'a static paint draws the note already settled');
});

test('the playhead is invisible at idle and its alpha follows the pointer fade', () => {
  const scene = core.createSceneState(6);
  core.resetSceneGeometry(scene, config, 300, 280);
  const playheadAlpha = () => {
    const { ctx, entry } = drawEntry(scene);
    draw(scene, entry, 50);
    const hit = ctx.calls.find((call) => call.type === 'fillRect' && call.args[2] === 2
      && call.args[3] === 280 && call.args[0] === Math.round(scene.playheadX) - 1);
    return hit ? hit.globalAlpha : 0;
  };
  assert.equal(playheadAlpha(), 0, 'no playhead at idle');
  core.updatePointer(scene, 100, 100, config, 300, 280, false);
  assert.equal(playheadAlpha(), 0, 'nothing on the very first hovered frame');
  core.advanceScene(scene, makeEnv({ sceneWidth: 300, dtMs: 220, timestamp: 50 }));
  const rising = playheadAlpha();
  assert.ok(rising > 0 && rising < 0.18, 'fades in toward 0.36 x line alpha x contrast');
  for (let i = 0; i < 40; i += 1) { core.advanceScene(scene, makeEnv({ sceneWidth: 300, dtMs: 80, timestamp: 100 + i * 80 })); }
  assert.ok(Math.abs(playheadAlpha() - 0.18) < 1e-9, 'settles at the configured peak');
  core.clearPointer(scene, false);
  core.advanceScene(scene, makeEnv({ sceneWidth: 300, dtMs: 220, timestamp: 9000 }));
  assert.ok(playheadAlpha() < 0.18, 'fades back out after leave');
});

test('click ripple grows 4 to 26 px over 280 ms at 0.5 to 0 alpha; the crossing ring is 3 to 17 at 0.6', () => {
  const scene = core.createSceneState(6);
  core.resetSceneGeometry(scene, config, 300, 280);
  commit(scene, 1, 1, { timeStamp: 0 });
  scene.crossingFlares.push({ sceneY: 40, placedAt: 0 });
  const arcsAt = (now) => {
    const { ctx, entry } = drawEntry(scene);
    draw(scene, entry, now);
    return ctx.calls.filter((call) => call.type === 'arc');
  };
  const start = arcsAt(0);
  assert.equal(start.length, 2);
  assert.deepEqual([start[0].args[2], start[0].globalAlpha, start[0].strokeStyle], [4, 0.5, 'rgba(10,200,30,1)']);
  assert.deepEqual([start[1].args[2], start[1].globalAlpha], [3, 0.6]);
  const end = arcsAt(280);
  assert.deepEqual([end[0].args[2], end[0].globalAlpha], [26, 0]);
  assert.deepEqual([end[1].args[2], end[1].globalAlpha], [17, 0]);
});

test('ghost notes draw with their own pre-boosted colour', () => {
  const scene = core.createSceneState(6);
  core.resetSceneGeometry(scene, config, 300, 280);
  core.advanceScene(scene, makeEnv({ sceneWidth: 300 }));
  const { ctx, entry } = drawEntry(scene);
  draw(scene, entry, 0);
  assert.ok(ctx.calls.some((call) => call.type === 'fillRect' && call.fillStyle === 'rgba(4,5,6,0.2)'));
});

test('a note past its life no longer holds its cell, so a later click there lands (reduced motion)', () => {
  const scene = core.createSceneState(9);
  core.resetSceneGeometry(scene, config, 600, 280);
  assert.equal(commit(scene, 4, 2, { timeStamp: 1000, reducedMotion: true }), true);
  assert.equal(commit(scene, 4, 2, { timeStamp: 5000, reducedMotion: true }), false, 'a live note still dedupes');
  assert.equal(commit(scene, 4, 2, { timeStamp: 14000, reducedMotion: true }), true, 'the expired occupant is ignored');
  core.advanceScene(scene, makeEnv({ timestamp: 14000, reducedMotion: true }));
  assert.equal(scene.notes.length, 1, 'the static paint prunes the old note and keeps the new one');
  assert.equal(scene.notes[0].placedAt, 14000);
});

test('shrinking the scene never folds two notes into one cell; the newest wins', () => {
  const scene = core.createSceneState(10);
  core.resetSceneGeometry(scene, config, 600, 280);
  commit(scene, 2, 4, { timeStamp: 10 });
  commit(scene, 2, 5, { timeStamp: 20 });
  commit(scene, 3, 5, { timeStamp: 30 });
  core.resetSceneGeometry(scene, config, 600, 56);
  const cells = scene.notes.map((note) => `${Math.round(note.worldX / STEP)}:${note.lane}`);
  assert.deepEqual(cells.slice().sort(), ['2:1', '3:1'], 'one note per cell after the lane clamp');
  assert.equal(scene.notes.find((note) => Math.round(note.worldX / STEP) === 2).placedAt, 20, 'newest kept');
});
