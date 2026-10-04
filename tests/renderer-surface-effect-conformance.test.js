// Full-roster native-v3 conformance driver for Background Effects v3 S9.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  runNativeV3Conformance,
  createConformanceFixtureController,
} = require('./helpers/surface-effect-conformance.js');

const reactiveGrid = require('../renderer/shell/renderer-reactive-grid-utils.js');
const playlistScroll = require('../renderer/shell/renderer-playlist-scroll-utils.js');
const atomicBurst = require('../renderer/shell/renderer-atomic-burst-utils.js');
const circuitTrace = require('../renderer/shell/renderer-circuit-trace-utils.js');
const contextWeave = require('../renderer/shell/renderer-context-weave-utils.js');
const { getSurfaceEffectPresets } = require('../renderer/shared/appearance-utils.js');

const NATIVE_EFFECT_MODULES = Object.freeze([
  Object.freeze({
    id: 'atomic-burst', factory: atomicBurst.createAtomicBurstController,
    rendererType: 'canvas2d', faultInjection: 'context',
  }),
  Object.freeze({
    id: 'circuit-trace', factory: circuitTrace.createCircuitTraceController,
    rendererType: 'canvas2d', faultInjection: 'context',
  }),
  Object.freeze({
    id: 'context-weave', factory: contextWeave.createContextWeaveController,
    rendererType: 'canvas2d', faultInjection: 'context',
  }),
  Object.freeze({
    id: 'playlist-scroll', factory: playlistScroll.createPlaylistScrollController,
    rendererType: 'canvas2d', faultInjection: 'context',
  }),
  Object.freeze({
    id: 'reactive-grid', factory: reactiveGrid.createReactiveGridController,
    rendererType: 'canvas2d', faultInjection: 'context',
  }),
]);

// Owner direction (2026-09-30): no background effect reacts to the model, so
// every v3 manager-input effect has activityMode 'none'.
const EXPECTED_ACTIVITY_MODES = Object.freeze({
  'reactive-grid': 'none',
  'atomic-burst': 'none',
  'circuit-trace': 'none',
  'context-weave': 'none',
  'playlist-scroll': 'none',
});

test('full-roster conformance driver exactly matches the five v3 manager-input registry entries', () => {
  const presets = getSurfaceEffectPresets().filter((preset) => preset.id !== 'none');
  const registryV3Ids = presets
    .filter((preset) => preset.contractVersion === 3 && preset.inputMode === 'manager')
    .map((preset) => preset.id)
    .sort();
  assert.equal(presets.length, 5);
  assert.equal(registryV3Ids.length, 5);
  assert.deepEqual(NATIVE_EFFECT_MODULES.map((entry) => entry.id).sort(), registryV3Ids);
  presets.forEach((preset) => {
    assert.equal(preset.activityMode, EXPECTED_ACTIVITY_MODES[preset.id],
      preset.id + ' registry activityMode');
  });
});

test('real controllers expose setActivity/handleActivityImpulse exactly when activityMode is native', () => {
  const presets = getSurfaceEffectPresets().filter((preset) => preset.id !== 'none');
  NATIVE_EFFECT_MODULES.forEach((entry) => {
    const preset = presets.find((candidate) => candidate.id === entry.id);
    const controller = entry.factory({});
    const expected = preset.activityMode === 'native' ? 'function' : 'undefined';
    assert.equal(typeof controller.setActivity, expected,
      entry.id + ' setActivity presence matches activityMode ' + preset.activityMode);
    assert.equal(typeof controller.handleActivityImpulse, expected,
      entry.id + ' handleActivityImpulse presence matches activityMode ' + preset.activityMode);
    if (typeof controller.dispose === 'function') controller.dispose();
  });
});

NATIVE_EFFECT_MODULES.forEach((entry) => {
  test('native-v3 conformance battery: real ' + entry.id + ' controller', () => {
    runNativeV3Conformance({
      effectId: entry.id,
      factory: entry.factory,
      options: {},
      rendererType: entry.rendererType,
      faultInjection: entry.faultInjection,
    });
  });
});

test('native-v3 conformance battery: fixture controller', () => {
  runNativeV3Conformance({
    effectId: 'conformance-fixture',
    factory: (options) => createConformanceFixtureController(options),
    options: {},
  });
});

test('conformance battery catches a leaked rAF handle after dispose', () => {
  assert.throws(() => {
    runNativeV3Conformance({
      effectId: 'conformance-fixture-leak-raf',
      factory: (options) => createConformanceFixtureController(options),
      options: { defects: { leakRaf: true } },
      viaManager: false,
    });
  }, /rAF/i);
});

test('conformance battery catches a controller-owned host listener', () => {
  assert.throws(() => {
    runNativeV3Conformance({
      effectId: 'conformance-fixture-leak-listener',
      factory: (options) => createConformanceFixtureController(options),
      options: { defects: { leakListener: true } },
      viaManager: false,
    });
  }, /manager-owned input/i);
});

test('conformance battery catches an unreported frame fault', () => {
  assert.throws(() => {
    runNativeV3Conformance({
      effectId: 'conformance-fixture-throw-in-frame',
      factory: (options) => createConformanceFixtureController(options),
      options: { defects: { throwInFrame: true } },
      viaManager: false,
    });
  }, /reported/i);
});

test('conformance battery catches a controller that reads host geometry in a frame', () => {
  assert.throws(() => {
    runNativeV3Conformance({
      effectId: 'conformance-fixture-read-rect-in-frame',
      factory: (options) => createConformanceFixtureController(options),
      options: { defects: { readRectInFrame: true } },
      viaManager: false,
    });
  }, /geometry|rect/i);
});

test('conformance battery passes an explicitly clean fixture', () => {
  let factoryCalls = 0;
  runNativeV3Conformance({
    effectId: 'conformance-fixture-clean',
    factory: (options) => {
      factoryCalls += 1;
      return createConformanceFixtureController(options);
    },
    options: { defects: {} },
    viaManager: false,
  });
  assert.ok(factoryCalls >= 1);
});
