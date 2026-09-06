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

test('shared scene advances exactly once and keeps one bounded note pool for every viewport', () => {
  const scene = core.createSceneState(42);
  core.resetSceneGeometry(scene, config, 600, 280);
  const snapped = core.snapScenePosition(scene, { sceneX: 220, sceneY: 70 }, config, 600, 280);
  assert.equal(core.commitNote(scene, snapped, {
    makeRng: (seed) => core._internals.makePrng(seed),
    timeStamp: 10,
    reducedMotion: false,
    spawnAllowed: () => true,
  }), true);
  core.advanceScene(scene, { dtMs: 16.667 }, 30, config, 600, 280, () => true);
  assert.ok(Math.abs(scene.totalScroll - 2) < 0.001);
  assert.equal(scene.notes.length, 1);
  assert.equal(scene.notes[0].velocity, 1, 'a user-painted note fills its snapped lane');
  assert.equal(scene.ripples.length, 1);
});

test('spawn avoidance rejects notes, ambient ghosts, and crossing flares without pausing simulation', () => {
  const scene = core.createSceneState(7);
  core.resetSceneGeometry(scene, config, 600, 280);
  const snapped = core.snapScenePosition(scene, { sceneX: 240, sceneY: 84 }, config, 600, 280);
  assert.equal(core.commitNote(scene, snapped, {
    makeRng: (seed) => core._internals.makePrng(seed),
    timeStamp: 0,
    reducedMotion: false,
    spawnAllowed: () => false,
  }), false);
  core.advanceScene(scene, { dtMs: 16.667 }, 20, config, 600, 280, () => false);
  assert.equal(scene.totalScroll, 2, 'scene time advances while every spawn point is avoided');
  assert.equal(scene.notes.length, 0);
  assert.equal(scene.ghostNotes.length, 0);
  assert.equal(scene.crossingFlares.length, 0);
});

test('scene identity reset decorrelates roles without retaining user transients', () => {
  const scene = core.createSceneState(11);
  scene.totalScroll = 20;
  scene.notes.push({ worldX: 30, width: 10 });
  scene.preview = { sceneX: 10, lane: 0, width: 20 };
  core.resetSceneIdentity(scene, 99);
  assert.equal(scene.seed, 99);
  assert.equal(scene.totalScroll, 0);
  assert.equal(scene.notes.length, 0);
  assert.equal(scene.preview, null);
});

test('deterministic helper exports preserve the established playlist utility contract', () => {
  const first = core._internals.generateGhostNoteForBar(42, 8, [2], 10, 4);
  const second = core._internals.generateGhostNoteForBar(42, 8, [2], 10, 4);
  assert.deepEqual(first, second);
  assert.deepEqual(core._internals.parseRgba('rgba(10,20,30,0.5)'), { r: 10, g: 20, b: 30, a: 0.5 });
  assert.equal(core._internals.NOTE_MAX_CONCURRENT, 96);
});

const makeRng = (seed) => core._internals.makePrng(seed);

function composerOpts(rate, overrides = {}) {
  return Object.assign({
    notesPerSecond: rate, makeRng, spawnAllowed: () => true, sceneWidth: 600, sceneHeight: 280,
  }, overrides);
}

test('auto-composer accrues real-time credit into deterministic soft notes ahead of the playhead', () => {
  function run() {
    const scene = core.createSceneState(42);
    core.resetSceneGeometry(scene, config, 600, 280);
    for (let i = 0; i < 240; i += 1) {
      core.advanceAutoComposer(scene, config, { dtMs: 16.667 }, 1000 + i * 16.667, composerOpts(0.5));
    }
    return scene;
  }
  const first = run();
  assert.ok(first.notes.length >= 1 && first.notes.length <= 2, '0.5 notes/s over 4s composes 1-2 notes');
  const step = config.barWidth / config.subdivisions;
  first.notes.forEach((note) => {
    assert.equal(note.source, 'auto');
    assert.equal(note.crossed, false, 'auto notes spawn ahead of the playhead, uncrossed');
    assert.ok(note.worldX > first.playheadX, 'world placement is strictly ahead of the playhead');
    assert.equal(note.worldX % step, 0, 'placement is quantized to the subdivision grid');
    assert.ok(note.velocity >= 0.35 && note.velocity <= 0.65, 'auto notes stay softer than user notes');
  });
  const second = run();
  assert.deepEqual(
    second.notes.map((n) => [n.worldX, n.lane, n.colorIndex, n.velocity]),
    first.notes.map((n) => [n.worldX, n.lane, n.colorIndex, n.velocity]),
    'the same seed reproduces the same composition',
  );
});

test('auto-composer is inert at zero dt or rate, respects user headroom, and never retries a blocked seed', () => {
  const scene = core.createSceneState(9);
  core.resetSceneGeometry(scene, config, 600, 280);
  assert.equal(core.advanceAutoComposer(scene, config, { dtMs: 0 }, 5, composerOpts(1)), false);
  assert.equal(scene.autoCredit, 0, 'zero dt accrues no credit');
  assert.equal(core.advanceAutoComposer(scene, config, { dtMs: 16.667 }, 5, composerOpts(0)), false);

  scene.autoCredit = 0;
  const blockedSeq = scene.autoNoteSequence;
  assert.equal(
    core.advanceAutoComposer(scene, config, { dtMs: 2000 }, 6, composerOpts(1, { spawnAllowed: () => false })),
    false,
  );
  assert.equal(scene.autoNoteSequence, blockedSeq + 1, 'a blocked attempt still consumes its seed');
  assert.equal(scene.notes.length, 0);

  for (let i = 0; i < core._internals.AUTO_NOTE_HEADROOM; i += 1) {
    scene.notes.push({ worldX: 10, lane: 0, width: 30 });
  }
  const cappedSeq = scene.autoNoteSequence;
  assert.equal(core.advanceAutoComposer(scene, config, { dtMs: 2000 }, 7, composerOpts(1)), false);
  assert.equal(scene.autoNoteSequence, cappedSeq + 1);
  assert.equal(scene.notes.length, core._internals.AUTO_NOTE_HEADROOM,
    'auto insertion never evicts existing notes past the headroom floor');
});

test('auto-composer attempts are frame-rate independent for equal wall time', () => {
  function run(frameMs, frames) {
    const scene = core.createSceneState(77);
    core.resetSceneGeometry(scene, config, 600, 280);
    for (let i = 0; i < frames; i += 1) {
      core.advanceAutoComposer(scene, config, { dtMs: frameMs }, i * frameMs, composerOpts(0.7));
    }
    return scene;
  }
  const fine = run(20, 3000);
  const coarse = run(50, 1200);
  assert.ok(fine.autoNoteSequence >= 30, 'a minute at 0.7 notes/s produces a real composition');
  assert.equal(coarse.autoNoteSequence, fine.autoNoteSequence,
    'equal wall time yields equal attempt counts regardless of frame partitioning');
  assert.deepEqual(
    coarse.notes.map((n) => [n.worldX, n.lane, n.colorIndex, n.velocity]),
    fine.notes.map((n) => [n.worldX, n.lane, n.colorIndex, n.velocity]),
    'the seeded composition is identical across frame rates',
  );
});

test('scripted lifecycle notes land on the quantized playhead column with isolated variation', () => {
  const scene = core.createSceneState(21);
  core.resetSceneGeometry(scene, config, 600, 280);
  scene.totalScroll = 37;
  const commit = (overrides) => core.commitScriptedNote(scene, config, Object.assign({
    makeRng, spawnAllowed: () => true, sceneHeight: 280,
    lane: 4, leadSteps: 0, velocityMin: 0.6, velocitySpan: 0.3, variationSeed: 5, timeStamp: 10,
  }, overrides));
  assert.equal(commit({}), true);
  const note = scene.notes[0];
  assert.equal(note.source, 'lifecycle');
  assert.equal(note.worldX, 240, 'leadSteps 0 snaps to the column at/behind the world playhead');
  assert.equal(note.crossed, true, 'a chord voice never re-flares at the playhead');
  assert.equal(commit({ spawnAllowed: () => false }), false, 'blocked lanes refuse the voice');
  assert.equal(scene.noteSequence, 0, 'scripted notes never touch the user RNG sequence');
});

test('auto and lifecycle commits never shift the user note variation stream', () => {
  function userVariations(withInterference) {
    const scene = core.createSceneState(64);
    core.resetSceneGeometry(scene, config, 600, 280);
    const commitUser = (sceneX) => {
      const snapped = core.snapScenePosition(scene, { sceneX, sceneY: 70 }, config, 600, 280);
      core.commitNote(scene, snapped, { makeRng, timeStamp: 5, reducedMotion: true, spawnAllowed: () => true });
      const note = scene.notes[scene.notes.length - 1];
      return [note.colorIndex, note.velocity];
    };
    const first = commitUser(220);
    if (withInterference) {
      core.advanceAutoComposer(scene, config, { dtMs: 4000 }, 8, composerOpts(1));
      core.commitScriptedNote(scene, config, {
        makeRng, spawnAllowed: () => true, sceneHeight: 280,
        lane: 2, leadSteps: 1, velocityMin: 0.85, velocitySpan: 0.15, variationSeed: 3, timeStamp: 9,
      });
    }
    const second = commitUser(340);
    return [first, second];
  }
  assert.deepEqual(userVariations(true), userVariations(false));
});

test('scripted flares scheduled in the future are retained but not drawn until due', () => {
  const scene = core.createSceneState(3);
  core.resetSceneGeometry(scene, config, 600, 280);
  core.spawnScriptedFlare(scene, 50, 100);
  core.spawnScriptedFlare(scene, 90, 400);
  const arcs = [];
  const ctx = {
    setTransform() {}, clearRect() {}, beginPath() {}, stroke() {},
    arc(x, y, radius) { arcs.push([x, y, radius]); },
  };
  const entry = { config, ctx, w: 600, h: 280, dpr: 1, host: null, tileCanvas: null };
  core.drawViewport(scene, entry, { now: 150, viewportX: 0, viewportY: 0, sceneHeight: 280 });
  assert.equal(arcs.length, 1, 'only the due flare draws; the staggered one waits');
  core.advanceScene(scene, { dtMs: 16 }, 150, config, 600, 280, () => true);
  assert.equal(scene.crossingFlares.length, 2, 'pruning keeps the future flare alive');
  core.advanceScene(scene, { dtMs: 16 }, 1000, config, 600, 280, () => true);
  assert.equal(scene.crossingFlares.length, 0, 'both flares expire after their lifetimes');
});
