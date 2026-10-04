'use strict';

// Type-scale generations: stored Text size records written under an earlier
// generation walk each migration step once on load and are stamped with
// typeScaleVersion. Generation 2 (2026-09-28) rebased the role tokens larger
// (step down one preset); generation 3 (2026-09-29) rebased the presets around
// the old Extra Large (1.2 is now Default with one step either side; xlarge
// retired).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  TYPE_SCALE_VERSION,
  getFontScalePresets,
  loadAppearancePreferences,
  migrateStoredAppearancePreferences,
  normalizeAppearancePreferences,
  saveAppearancePreferences,
} = require('../renderer/shared/appearance-utils');

function memoryStorage(entries) {
  const values = new Map(entries);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('the current generation is 3 with a three-step scale around 1.2', () => {
  assert.equal(TYPE_SCALE_VERSION, 3);
  assert.deepEqual(getFontScalePresets().map((p) => [p.id, p.value]), [['small', 1.1], ['default', 1.2], ['large', 1.3]]);
});

test('a generation-2 record keeps its multiplier where one still exists and stamps the record', () => {
  // v2 xlarge (1.2) -> v3 default (1.2); v2 large (1.1) -> v3 small (1.1);
  // v2 default (1.0) and small (0.9) -> v3 small (1.1), the closest remaining size.
  for (const [stored, expected] of [['xlarge', 'default'], ['large', 'small'], ['default', 'small'], ['small', 'small']]) {
    const storage = memoryStorage([[STORAGE_KEY, JSON.stringify({ paletteId: 'slate', fontScaleId: stored, typeScaleVersion: 2 })]]);
    const loaded = loadAppearancePreferences(storage);
    assert.equal(loaded.fontScaleId, expected, `v2 ${stored} migrates to ${expected}`);
    const persisted = JSON.parse(storage.values.get(STORAGE_KEY));
    assert.equal(persisted.typeScaleVersion, TYPE_SCALE_VERSION);
    assert.equal(persisted.fontScaleId, expected);
    // Idempotent: the stamped record is not remapped again.
    assert.equal(loadAppearancePreferences(storage).fontScaleId, expected);
  }
});

test('an unstamped (generation-1) record walks both steps once', () => {
  // v1 xlarge -> v2 large -> v3 small; v1 large -> v2 default -> v3 small;
  // v1 default -> v3 small; v1 small -> v3 small.
  for (const [stored, expected] of [['xlarge', 'small'], ['large', 'small'], ['default', 'small'], ['small', 'small']]) {
    const storage = memoryStorage([[STORAGE_KEY, JSON.stringify({ paletteId: 'slate', fontScaleId: stored })]]);
    const loaded = loadAppearancePreferences(storage);
    assert.equal(loaded.fontScaleId, expected, `v1 ${stored} migrates to ${expected}`);
    const persisted = JSON.parse(storage.values.get(STORAGE_KEY));
    assert.equal(persisted.typeScaleVersion, TYPE_SCALE_VERSION);
    assert.equal(loadAppearancePreferences(storage).fontScaleId, expected);
  }
  // A record with no text-size choice at all lands on Default, never Small.
  const bare = memoryStorage([[STORAGE_KEY, JSON.stringify({ paletteId: 'slate' })]]);
  assert.equal(loadAppearancePreferences(bare).fontScaleId, 'default');
});

test('a stamped record and a live UI choice are never remapped', () => {
  const storage = memoryStorage([[STORAGE_KEY, JSON.stringify({ fontScaleId: 'large', typeScaleVersion: TYPE_SCALE_VERSION })]]);
  assert.equal(loadAppearancePreferences(storage).fontScaleId, 'large');
  const saved = saveAppearancePreferences(storage, { fontScaleId: 'large' });
  assert.equal(saved.fontScaleId, 'large');
  assert.equal(loadAppearancePreferences(storage).fontScaleId, 'large');
  assert.equal(normalizeAppearancePreferences({ fontScaleId: 'large' }).fontScaleId, 'large');
  // The retired id is not a live choice; normalization falls back to Default.
  assert.equal(normalizeAppearancePreferences({ fontScaleId: 'xlarge' }).fontScaleId, 'default');
});

test('migrateStoredAppearancePreferences handles portable projections and legacy v1 records', () => {
  assert.equal(migrateStoredAppearancePreferences({ fontScaleId: 'xlarge' }).fontScaleId, 'small');
  assert.equal(migrateStoredAppearancePreferences({ fontScaleId: 'xlarge', typeScaleVersion: 2 }).fontScaleId, 'default');
  assert.equal(migrateStoredAppearancePreferences({ fontScaleId: 'large', typeScaleVersion: 3 }).fontScaleId, 'large');
  assert.equal(migrateStoredAppearancePreferences({ fontScaleId: 'large', typeScaleVersion: 99 }).fontScaleId, 'large', 'a newer stamp passes through');
  assert.equal(Object.hasOwn(migrateStoredAppearancePreferences({}), 'typeScaleVersion'), false);
  const legacy = memoryStorage([[LEGACY_STORAGE_KEY, JSON.stringify({ fontScaleId: 'large' })]]);
  assert.equal(loadAppearancePreferences(legacy).fontScaleId, 'small');
});
