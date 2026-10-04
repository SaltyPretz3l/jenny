'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const appearance = require('../renderer/shared/appearance-utils');
const { normalizePortablePreferences } = require('../services/data-lifecycle/portable-preferences-store');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

test('artifactAutoOpen defaults off for fresh, partial and garbled records', () => {
  assert.equal(appearance.getDefaultAppearancePreferences().artifactAutoOpen, false);
  for (const value of [undefined, null, {}, 'yes', 1, false]) {
    assert.equal(appearance.normalizeAppearancePreferences({ artifactAutoOpen: value }).artifactAutoOpen, false);
  }
  assert.equal(appearance.normalizeAppearancePreferences({ artifactAutoOpen: true }).artifactAutoOpen, true);
  for (const raw of ['{garbled', '{}', JSON.stringify({ paletteId: 'signal' })]) {
    assert.equal(appearance.loadAppearancePreferences(createStorage({ [appearance.STORAGE_KEY]: raw })).artifactAutoOpen, false);
  }
});

test('artifactAutoOpen saves and loads both choices and stamps the root dataset', () => {
  const storage = createStorage();
  const root = { dataset: {}, style: { setProperty() {}, removeProperty() {} } };
  for (const enabled of [true, false]) {
    const saved = appearance.saveAppearancePreferences(storage, { artifactAutoOpen: enabled });
    assert.equal(saved.artifactAutoOpen, enabled);
    assert.equal(JSON.parse(storage.getItem('jenny.appearance.v2')).artifactAutoOpen, enabled);
    assert.equal(appearance.loadAppearancePreferences(storage).artifactAutoOpen, enabled);
    appearance.applyAppearanceToDocument(root, saved);
    assert.equal(root.dataset.artifactAutoOpen, enabled ? 'on' : 'off');
  }
});

test('artifactAutoOpen is portable but never a theme-bundle axis', () => {
  assert.equal(Object.hasOwn(appearance.pickThemeBundleAxes({ artifactAutoOpen: true, paletteId: 'signal' }), 'artifactAutoOpen'), false);
  for (const enabled of [true, false]) {
    assert.equal(normalizePortablePreferences({ appearance: { artifactAutoOpen: enabled } }).appearance.artifactAutoOpen, enabled);
  }
});

test('Settings offers the default-off artifact toggle and persists changes independently of themes', async (t) => {
  const app = await loadRendererApp();
  t.after(() => app.dispose());
  const { window } = app;
  const doc = window.document;
  const list = doc.querySelector('[data-setting-mount="appearanceArtifactAutoOpenToggle"]');
  const toggle = list.querySelector('[data-inv-toggle="appearanceArtifactAutoOpenToggle"]');
  assert.ok(toggle);
  assert.equal(toggle.getAttribute('aria-checked'), 'false');
  assert.match(list.textContent, /Open the artifact panel when an artifact arrives/);
  assert.match(list.textContent, /a panel you opened, or left open, stays as it was/);
  for (const enabled of [true, false]) {
    list.dispatchEvent(new window.CustomEvent('inv-toggle-change', {
      bubbles: true, detail: { id: 'appearanceArtifactAutoOpenToggle', checked: enabled },
    }));
    await waitForUi(window);
    assert.equal(window.__rendererState.ui.appearance.artifactAutoOpen, enabled);
    assert.equal(JSON.parse(window.localStorage.getItem('jenny.appearance.v2')).artifactAutoOpen, enabled);
    assert.equal(doc.documentElement.dataset.artifactAutoOpen, enabled ? 'on' : 'off');
    const bundle = doc.getElementById('appearanceThemeBundleSelect');
    bundle.value = enabled ? 'pewter' : 'obsidian';
    bundle.dispatchEvent(new window.Event('change', { bubbles: true }));
    await waitForUi(window);
    assert.equal(window.__rendererState.ui.appearance.artifactAutoOpen, enabled);
  }
});
