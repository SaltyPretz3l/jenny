'use strict';

// Chat width axis (Appearance > Chat layout > Chat width). Split out of
// tests/appearance-utils.test.js, which sits at the repo file-size ceiling.
// The CSS half of this contract lives in tests/renderer-chat-layout-shell-css.test.js;
// the end-to-end settings wiring in tests/renderer-shell-settings-appearance.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STORAGE_KEY,
  applyAppearanceToDocument,
  getChatWidthPresets,
  loadAppearancePreferences,
  normalizeAppearancePreferences,
  saveAppearancePreferences,
} = require('../renderer/shared/appearance-utils');

function createStorage(initialValue) {
  const values = new Map();
  if (typeof initialValue === 'string') values.set(STORAGE_KEY, initialValue);
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function createRoot() {
  const applied = new Map();
  return {
    root: {
      dataset: {},
      style: {
        setProperty(name, value) { applied.set(name, value); },
        removeProperty(name) { applied.delete(name); },
      },
    },
    applied,
  };
}

test('chat width presets expose the narrow/standard reading-measure ladder', () => {
  assert.deepEqual(getChatWidthPresets().map((preset) => preset.id), ['narrow', 'standard']);
  for (const preset of getChatWidthPresets()) {
    assert.ok(preset.label, `${preset.id} has a label`);
    assert.ok(preset.description, `${preset.id} has a description`);
  }
});

test('normalizeAppearancePreferences defaults and coerces chatWidthId', () => {
  // Standard (1100px) is the default reading measure (owner, 2026-10-02).
  assert.equal(normalizeAppearancePreferences({}).chatWidthId, 'standard');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: 'narrow' }).chatWidthId, 'narrow');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: 'NARROW' }).chatWidthId, 'narrow');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: ' narrow ' }).chatWidthId, 'narrow');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: 'standard' }).chatWidthId, 'standard');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: 'bogus' }).chatWidthId, 'standard');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: null }).chatWidthId, 'standard');
});

test('ids stored before the rename land on the Standard default', () => {
  // `default` was written for every profile whether or not the user chose it.
  assert.equal(normalizeAppearancePreferences({ chatWidthId: 'default' }).chatWidthId, 'standard');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: 'wide' }).chatWidthId, 'standard');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: 'WIDE' }).chatWidthId, 'standard');
  const storage = createStorage(JSON.stringify({ paletteId: 'signal', chatWidthId: 'default' }));
  assert.equal(loadAppearancePreferences(storage).chatWidthId, 'standard');
});

test('a stored v2 blob without the chat width axis loads as Standard', () => {
  const storage = createStorage(JSON.stringify({ paletteId: 'signal', typographyId: 'technical' }));
  const loaded = loadAppearancePreferences(storage);
  assert.equal(loaded.chatWidthId, 'standard', 'a missing field takes the Standard default');
  assert.equal(loaded.paletteId, 'signal', 'the pre-existing axes still round-trip');
});

test('a fresh profile boots Standard', () => {
  const { root } = createRoot();
  const loaded = loadAppearancePreferences(createStorage());
  assert.equal(loaded.chatWidthId, 'standard');
  applyAppearanceToDocument(root, loaded);
  assert.equal(root.dataset.chatWidth, 'standard');
});

test('chat width round-trips through save and load', () => {
  const storage = createStorage();
  const saved = saveAppearancePreferences(storage, { chatWidthId: 'narrow' });
  assert.equal(saved.chatWidthId, 'narrow');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).chatWidthId, 'narrow');
  assert.equal(loadAppearancePreferences(storage).chatWidthId, 'narrow', 'a saved Narrow choice is kept');
});

test('applyAppearanceToDocument stamps the chat width axis onto the root dataset', () => {
  const { root } = createRoot();
  applyAppearanceToDocument(root, { chatWidthId: 'narrow' });
  assert.equal(root.dataset.chatWidth, 'narrow', 'the CSS keys off :root[data-chat-width]');
  applyAppearanceToDocument(root, { chatWidthId: 'bogus' });
  assert.equal(root.dataset.chatWidth, 'standard', 'an unknown id falls back rather than stranding the attribute');
});

test('chat width is a layout axis only -- it does not disturb the font-scale or holo axes', () => {
  const { root, applied } = createRoot();
  applyAppearanceToDocument(root, { fontScaleId: 'large', chatWidthId: 'narrow' });
  assert.equal(applied.get('--font-scale'), '1.3', 'the shell text scale is untouched by chat width');
  assert.equal(root.dataset.fontScale, 'large');
  assert.equal(root.dataset.chatWidth, 'narrow');
});
