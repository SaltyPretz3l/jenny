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

test('chat width presets expose the default/wide reading-measure ladder', () => {
  assert.deepEqual(getChatWidthPresets().map((preset) => preset.id), ['default', 'wide']);
  for (const preset of getChatWidthPresets()) {
    assert.ok(preset.label, `${preset.id} has a label`);
    assert.ok(preset.description, `${preset.id} has a description`);
  }
});

test('normalizeAppearancePreferences defaults and coerces chatWidthId', () => {
  assert.equal(normalizeAppearancePreferences({}).chatWidthId, 'default');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: 'wide' }).chatWidthId, 'wide');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: 'WIDE' }).chatWidthId, 'wide');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: ' wide ' }).chatWidthId, 'wide');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: 'bogus' }).chatWidthId, 'default');
  assert.equal(normalizeAppearancePreferences({ chatWidthId: null }).chatWidthId, 'default');
});

test('a stored v2 blob predating the chat width axis loads as Default', () => {
  const storage = createStorage(JSON.stringify({ paletteId: 'signal', typographyId: 'technical' }));
  const loaded = loadAppearancePreferences(storage);
  assert.equal(loaded.chatWidthId, 'default', 'existing profiles are not surprised into Wide');
  assert.equal(loaded.paletteId, 'signal', 'the pre-existing axes still round-trip');
});

test('chat width round-trips through save and load', () => {
  const storage = createStorage();
  const saved = saveAppearancePreferences(storage, { chatWidthId: 'wide' });
  assert.equal(saved.chatWidthId, 'wide');
  assert.equal(JSON.parse(storage.getItem(STORAGE_KEY)).chatWidthId, 'wide');
  assert.equal(loadAppearancePreferences(storage).chatWidthId, 'wide');
});

test('applyAppearanceToDocument stamps the chat width axis onto the root dataset', () => {
  const { root } = createRoot();
  applyAppearanceToDocument(root, { chatWidthId: 'wide' });
  assert.equal(root.dataset.chatWidth, 'wide', 'the CSS keys off :root[data-chat-width]');
  applyAppearanceToDocument(root, { chatWidthId: 'bogus' });
  assert.equal(root.dataset.chatWidth, 'default', 'an unknown id falls back rather than stranding the attribute');
});

test('chat width is a layout axis only -- it does not disturb the font-scale or holo axes', () => {
  const { root, applied } = createRoot();
  applyAppearanceToDocument(root, { fontScaleId: 'xlarge', chatWidthId: 'wide' });
  assert.equal(applied.get('--font-scale'), '1.3', 'the shell text scale is untouched by chat width');
  assert.equal(root.dataset.fontScale, 'xlarge');
  assert.equal(root.dataset.chatWidth, 'wide');
});
