'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { VIEW_TAB_ORDER } = require('../capture-scenarios');
const { getPalettePresets } = require('../renderer/shared/appearance-utils');
const {
  DEMO_SCENES,
  STEP_TYPES,
  replayScriptPath,
  assertScenesValid,
} = require('../scripts/demo/demo-scenes');

test('the shipped demo scene table is valid and complete', () => {
  assert.strictEqual(assertScenesValid(DEMO_SCENES), true);
  assert.deepStrictEqual(
    DEMO_SCENES.map((scene) => scene.id),
    ['palette-reel', 'streaming-tools', 'ide-tour']
  );
  assert.strictEqual(new Set(DEMO_SCENES.map((scene) => scene.id)).size, DEMO_SCENES.length);
});

test('scenes use current views, palettes, steps, and duration bounds', () => {
  const paletteIds = new Set(getPalettePresets().map((preset) => preset.id));
  for (const scene of DEMO_SCENES) {
    assert.ok(VIEW_TAB_ORDER.includes(scene.view), `${scene.id} uses a current view`);
    for (const seconds of scene.targetSeconds) {
      assert.ok(seconds >= 8 && seconds <= 18, `${scene.id} target ${seconds} is within 8-18 seconds`);
    }
    assert.strictEqual(
      scene.steps.filter((step) => step.type === 'record-start').length,
      1,
      `${scene.id} has one record-start`
    );
    for (const paletteId of scene.palettes || []) {
      assert.ok(paletteIds.has(paletteId), `${scene.id} palette ${paletteId} exists`);
    }
    for (const step of scene.steps) {
      assert.ok(STEP_TYPES.includes(step.type), `${scene.id} step ${step.type} is supported`);
      if (step.view !== undefined) {
        assert.ok(VIEW_TAB_ORDER.includes(step.view), `${scene.id} step view ${step.view} exists`);
      }
      if (step.type === 'select-option' && step.selector === '#quickSettingsPalette') {
        assert.ok(paletteIds.has(step.value), `${scene.id} selected palette ${step.value} exists`);
      }
    }
    const scriptPath = replayScriptPath(scene);
    if (scriptPath !== null) {
      assert.ok(fs.existsSync(scriptPath), `${scene.id} replay script exists`);
    }
  }
});

test('assertScenesValid rejects multiple recording starts', () => {
  const valid = DEMO_SCENES[0];
  const invalid = { ...valid, steps: [...valid.steps, { type: 'record-start' }] };
  assert.throws(() => assertScenesValid([invalid]), /exactly one record-start/i);
});

test('assertScenesValid rejects an unknown step type', () => {
  const valid = DEMO_SCENES[0];
  const invalid = { ...valid, steps: [...valid.steps, { type: 'launch-confetti' }] };
  assert.throws(() => assertScenesValid([invalid]), /unknown step type/i);
});
