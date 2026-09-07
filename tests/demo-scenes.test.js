'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { VIEW_TAB_ORDER } = require('../capture-scenarios');
const { getPalettePresets } = require('../renderer/shared/appearance-utils');
const {
  DEMO_SCENES,
  STEP_TYPES,
  RECORDING,
  PRESENTATION_DEFAULTS,
  TARGET_SECONDS_MIN,
  TARGET_SECONDS_MAX,
  replayScriptPath,
  assertScenesValid,
  assertPresentationDefaultsValid,
} = require('../scripts/demo/demo-scenes');
const { hasDateTokens } = require('../scripts/demo/demo-dates');

test('the shipped demo scene table is valid and complete', () => {
  assert.strictEqual(assertScenesValid(DEMO_SCENES), true);
  assert.deepStrictEqual(
    DEMO_SCENES.map((scene) => scene.id),
    ['streaming-tools', 'assistant-edit', 'calendar-week', 'ide-tour', 'palette-reel']
  );
  assert.strictEqual(new Set(DEMO_SCENES.map((scene) => scene.id)).size, DEMO_SCENES.length);
});

test('recording geometry and presentation defaults are the ones the docs describe', () => {
  assert.strictEqual(RECORDING.deviceScaleFactor, 1.75);
  assert.strictEqual(RECORDING.captureWidth, 1280);
  assert.strictEqual(RECORDING.maximized, true);
  assert.strictEqual(assertPresentationDefaultsValid(PRESENTATION_DEFAULTS), true);
  assert.match(PRESENTATION_DEFAULTS.modelLabel, /^ornith15 /);
  assert.throws(
    () => assertPresentationDefaultsValid({ ...PRESENTATION_DEFAULTS, telemetry: { ...PRESENTATION_DEFAULTS.telemetry, gpu: 140 } }),
    /<= 100/
  );
});

test('every scene starts a fresh chat before recording (the seeded profile boots into its last chat)', () => {
  for (const scene of DEMO_SCENES) {
    const recordAt = scene.steps.findIndex((step) => step.type === 'record-start');
    const preroll = scene.steps.slice(0, recordAt);
    assert.ok(
      preroll.some((step) => step.type === 'dom-click' && step.selector === '#newChatButton'),
      `${scene.id} clicks New chat in its pre-roll`
    );
    assert.ok(
      !scene.steps.slice(recordAt).some((step) => step.type === 'dom-click'),
      `${scene.id} never uses the cursorless dom-click while recording`
    );
  }
});

test('the calendar scene is the only one that speaks in relative dates, and the edit scene approves once', () => {
  const tokenScenes = DEMO_SCENES.filter((scene) => scene.steps.some((step) => hasDateTokens(step.text)));
  assert.deepStrictEqual(tokenScenes.map((scene) => scene.id), ['calendar-week']);
  const edit = DEMO_SCENES.find((scene) => scene.id === 'assistant-edit');
  const approveClicks = edit.steps.filter((step) => step.type === 'click' && /tool-approve-btn/.test(step.selector));
  assert.strictEqual(approveClicks.length, 1);
  assert.match(approveClicks[0].selector, /data-approval-scope="once"/, 'the demo never persists an always-allow rule');
  const streaming = DEMO_SCENES.find((scene) => scene.id === 'streaming-tools');
  assert.ok(streaming.steps.some((step) => step.type === 'assert-absent' && /tool-approval-block/.test(step.selector)));
});

test('scenes use current views, palettes, steps, and duration bounds', () => {
  const paletteIds = new Set(getPalettePresets().map((preset) => preset.id));
  for (const scene of DEMO_SCENES) {
    assert.ok(VIEW_TAB_ORDER.includes(scene.view), `${scene.id} uses a current view`);
    for (const seconds of scene.targetSeconds) {
      assert.ok(
        seconds >= TARGET_SECONDS_MIN && seconds <= TARGET_SECONDS_MAX,
        `${scene.id} target ${seconds} is within ${TARGET_SECONDS_MIN}-${TARGET_SECONDS_MAX} seconds`
      );
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

test('assertScenesValid rejects a non-boolean click.optional', () => {
  const valid = DEMO_SCENES[0];
  const invalid = { ...valid, steps: [...valid.steps, { type: 'click', selector: '#x', optional: 'yes' }] };
  assert.throws(() => assertScenesValid([invalid]), /click\.optional/i);
});

test('assertScenesValid rejects an unknown step type', () => {
  const valid = DEMO_SCENES[0];
  const invalid = { ...valid, steps: [...valid.steps, { type: 'launch-confetti' }] };
  assert.throws(() => assertScenesValid([invalid]), /unknown step type/i);
});
