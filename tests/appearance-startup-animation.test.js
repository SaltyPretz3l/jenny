'use strict';

// Status loader (area 5, 2026-09-29): the "Startup animation" appearance
// field (default on, persisted, lossless migration) and its
// startup_animation kill-switch flag.
const test = require('node:test');
const assert = require('node:assert/strict');

const appearance = require('../renderer/shared/appearance-utils.js');
const {
  buildFeatureFlags,
  INTERNAL_FEATURE_FLAG_KEYS,
} = require('../services/feature-flags.js');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

test('startupAnimation defaults on for fresh, partial and garbled records', () => {
  assert.equal(appearance.getDefaultAppearancePreferences().startupAnimation, true);
  assert.equal(appearance.normalizeAppearancePreferences({}).startupAnimation, true);
  assert.equal(appearance.normalizeAppearancePreferences({ startupAnimation: 'nope' }).startupAnimation, true);
  assert.equal(appearance.normalizeAppearancePreferences({ startupAnimation: false }).startupAnimation, false);
});

test('startupAnimation persists through save and load', () => {
  const storage = createStorage();
  const saved = appearance.saveAppearancePreferences(storage, {
    ...appearance.getDefaultAppearancePreferences(),
    startupAnimation: false,
  });
  assert.equal(saved.startupAnimation, false);
  assert.equal(JSON.parse(storage.getItem(appearance.STORAGE_KEY)).startupAnimation, false);
  assert.equal(appearance.loadAppearancePreferences(storage).startupAnimation, false);
});

test('an older stored record without the field loads losslessly with the animation on', () => {
  const older = {
    paletteId: 'signal',
    typographyId: 'editorial',
    surfaceEffectId: 'circuit-trace',
    composerHoloId: 'off',
    fontScaleId: 'large',
    chatWidthId: 'narrow',
    typeScaleVersion: appearance.TYPE_SCALE_VERSION,
  };
  const storage = createStorage({ [appearance.STORAGE_KEY]: JSON.stringify(older) });
  const loaded = appearance.loadAppearancePreferences(storage);
  const { typeScaleVersion: _stamp, ...olderFields } = older;
  assert.deepEqual(loaded, { ...olderFields, startupAnimation: true, titlebarLoad: false, artifactAutoOpen: false });

  const legacy = { paletteId: 'midnight', fontScaleId: 'xlarge' };
  const legacyStorage = createStorage({ [appearance.LEGACY_STORAGE_KEY]: JSON.stringify(legacy) });
  const migrated = appearance.loadAppearancePreferences(legacyStorage);
  assert.equal(migrated.startupAnimation, true);
  assert.equal(migrated.fontScaleId, 'small', 'the type-scale migration still runs (v1 xlarge -> v2 large -> v3 small)');
  assert.equal(JSON.parse(legacyStorage.getItem(appearance.STORAGE_KEY)).startupAnimation, true);
});

test('the field reaches the document so the boot curtain can read it before any script runs', () => {
  const root = { dataset: {}, style: { setProperty() {}, removeProperty() {} } };
  appearance.applyAppearanceToDocument(root, { startupAnimation: false });
  assert.equal(root.dataset.startupAnimation, 'off');
  appearance.applyAppearanceToDocument(root, {});
  assert.equal(root.dataset.startupAnimation, 'on');
});

test('theme bundles never touch the startup animation choice', () => {
  const picked = appearance.pickThemeBundleAxes({ startupAnimation: false, paletteId: 'signal' });
  assert.equal(Object.prototype.hasOwnProperty.call(picked, 'startupAnimation'), false);
});

test('startup_animation flag defaults on and rolls back with JENNY_ENABLE_STARTUP_ANIMATION=0', () => {
  assert.equal(buildFeatureFlags({}).startup_animation, true);
  assert.equal(buildFeatureFlags({ JENNY_ENABLE_STARTUP_ANIMATION: '0' }).startup_animation, false);
  assert.ok(INTERNAL_FEATURE_FLAG_KEYS.includes('startup_animation'));
});

test('Settings > Appearance offers the Startup animation toggle and persists it', async (t) => {
  const app = await loadRendererApp();
  t.after(async () => app.dispose());
  const { window } = app;
  const list = window.document.getElementById('appearanceHoloList');
  const toggle = list.querySelector('[data-inv-toggle="appearanceStartupAnimationToggle"]');
  assert.ok(toggle, 'the toggle renders in the Appearance list');
  assert.match(list.textContent, /Startup animation/);
  assert.match(list.textContent, /A short starfield while Jenny opens\. Off shows a plain curtain\. Follows your system's reduced-motion setting\./);
  list.dispatchEvent(new window.CustomEvent('inv-toggle-change', {
    bubbles: true, detail: { id: 'appearanceStartupAnimationToggle', checked: false },
  }));
  await waitForUi(window);
  assert.equal(window.document.documentElement.dataset.startupAnimation, 'off');
  assert.equal(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).startupAnimation, false);
});
