'use strict';

// Appearance and History scope rows render into [data-setting-mount] hosts and
// write through the shared Settings binding (appearance / windowUi adapters).

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRendererApp, waitForUi } = require('./helpers/renderer-shell-harness');
const { segmentedGroup, segmentedValue } = require('./helpers/segmented-control');

const STORAGE_KEY = 'jenny.appearance.v2';

async function loadApp(t, options) {
  const app = await loadRendererApp(options);
  t.after(async () => {
    await app.dispose();
  });
  return app;
}

function change(window, select, value) {
  select.value = value;
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
}

function storedAppearance(window) {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
}

function rowError(doc, id) {
  const error = doc.querySelector(`[data-settings-field="${id}"] .settings-field-error`);
  return error && !error.hidden ? error.textContent : '';
}

function refuseAppearanceWrites(window) {
  const original = window.Storage.prototype.setItem;
  window.Storage.prototype.setItem = function setItem(key, value) {
    if (key === STORAGE_KEY) throw new Error('quota exceeded');
    return original.call(this, key, value);
  };
  return () => { window.Storage.prototype.setItem = original; };
}

test('mounted Appearance selects keep their nodes across renders and option-list changes', async (t) => {
  const { window, shell } = await loadApp(t);
  const doc = window.document;
  const palette = doc.getElementById('appearancePaletteSelect');
  const bundle = doc.getElementById('appearanceThemeBundleSelect');
  assert.ok(palette && bundle, 'both rows are mounted');
  assert.ok(palette.closest('[data-setting-mount="appearancePaletteSelect"]'));
  const bundleValues = () => [...bundle.options].map((option) => option.value);
  assert.equal(bundleValues().includes('custom'), false, 'a matching bundle needs no Custom entry');

  await shell.__emitFeaturesChanged({ featureFlags: { text_spellcheck: false } });
  await waitForUi(window, 20);
  assert.equal(doc.getElementById('appearancePaletteSelect'), palette);
  assert.equal(doc.getElementById('appearanceThemeBundleSelect'), bundle);

  change(window, palette, 'signal');
  await waitForUi(window, 20);
  assert.equal(bundleValues().at(-1), 'custom', 'a hand-tuned palette adds the Custom entry');
  assert.equal(bundle.value, 'custom');
  assert.equal(doc.getElementById('appearanceThemeBundleSelect'), bundle, 'the option list is patched in place');
  assert.equal(doc.getElementById('appearancePaletteSelect'), palette);

  change(window, bundle, 'lexicon');
  await waitForUi(window, 20);
  assert.equal(bundleValues().includes('custom'), false, 'choosing a bundle drops the Custom entry');
  assert.equal(bundle.value, 'lexicon');
  assert.equal(palette.value, 'lexicon');
  assert.equal(doc.getElementById('appearanceThemeBundleSelect'), bundle);
  assert.equal(doc.getElementById('appearancePaletteSelect'), palette);
});

test('a palette change persists through the appearance adapter; a refused write rolls back and shows the row error', async (t) => {
  const { window } = await loadApp(t);
  const doc = window.document;
  const palette = doc.getElementById('appearancePaletteSelect');

  change(window, palette, 'signal');
  await waitForUi(window, 20);
  assert.equal(storedAppearance(window).paletteId, 'signal');
  assert.equal(window.__rendererState.ui.appearance.paletteId, 'signal');
  assert.equal(doc.documentElement.dataset.palette, 'signal');
  assert.equal(rowError(doc, 'appearancePaletteSelect'), '');

  const restore = refuseAppearanceWrites(window);
  t.after(restore);
  change(window, palette, 'paper');
  await waitForUi(window, 20);
  assert.equal(palette.value, 'signal', 'the control returns to the last acknowledged value');
  assert.notEqual(rowError(doc, 'appearancePaletteSelect'), '', 'the row shows the failure');
  assert.equal(storedAppearance(window).paletteId, 'signal');
  assert.equal(window.__rendererState.ui.appearance.paletteId, 'signal');
  assert.equal(doc.documentElement.dataset.palette, 'signal', 'nothing is half-applied');
});

test('Revert on a modified palette writes the descriptor default through the adapter', async (t) => {
  const { window } = await loadApp(t);
  const doc = window.document;
  const descriptor = window.rendererSettingsFieldDescriptors.getSettingDescriptor('appearancePaletteSelect');
  const other = descriptor.default === 'signal' ? 'paper' : 'signal';
  const palette = doc.getElementById('appearancePaletteSelect');

  change(window, palette, other);
  await waitForUi(window, 20);
  const revert = doc.querySelector('[data-setting-revert="appearancePaletteSelect"]');
  assert.ok(revert && !revert.hidden, 'a modified palette offers Revert');

  revert.click();
  await waitForUi(window, 20);
  assert.equal(storedAppearance(window).paletteId, descriptor.default);
  assert.equal(palette.value, descriptor.default);
  assert.equal(doc.querySelector('[data-settings-field="appearancePaletteSelect"]').getAttribute('data-modified'), null);
});

test('a theme-bundle switch writes only the bundle axes and keeps a non-default Text size', async (t) => {
  const { window } = await loadApp(t);
  const doc = window.document;

  segmentedGroup(doc, 'appearanceFontScaleSelect').querySelector('[data-value="large"]').click();
  await waitForUi(window, 20);
  segmentedGroup(doc, 'appearanceChatWidthSelect').querySelector('[data-value="narrow"]').click();
  await waitForUi(window, 20);
  change(window, doc.getElementById('appearanceThemeBundleSelect'), 'pewter');
  await waitForUi(window, 20);

  const stored = storedAppearance(window);
  assert.equal(stored.paletteId, 'pewter');
  assert.equal(stored.fontScaleId, 'large', 'Text size survives the bundle switch');
  assert.equal(stored.chatWidthId, 'narrow', 'Chat width survives the bundle switch');
  assert.equal(segmentedValue(doc, 'appearanceFontScaleSelect'), 'large');
  assert.equal(doc.getElementById('appearanceThemeBundleSelect').value, 'pewter');
});

test('an app-zoom echo without appZoomPercent is a rejection: the control rolls back and the row shows the error', async (t) => {
  const { window, shell } = await loadApp(t);
  const doc = window.document;
  const calls = [];
  window.jennyShell.windowUi.updateSettings = async (patch) => { calls.push(patch); return {}; };
  const zoom = doc.getElementById('appearanceAppZoomSelect');
  assert.equal(zoom.value, '110');

  change(window, zoom, '125');
  await waitForUi(window, 20);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [{ appZoomPercent: 125 }]);
  assert.equal(zoom.value, '110', 'the control returns to the last acknowledged value');
  assert.equal(window.__rendererState.ui.appZoomPercent, 110);
  assert.notEqual(rowError(doc, 'appearanceAppZoomSelect'), '');
  assert.equal(shell.__state.windowUiState.appZoomPercent, 110);
});

test('the title-bar load document event persists the switch through the registry and reports a refused write', async (t) => {
  const { window } = await loadApp(t);
  const doc = window.document;
  const toggle = () => doc.querySelector('[data-inv-toggle="appearanceTitlebarLoadToggle"]');
  const fire = (enabled) => doc.dispatchEvent(new window.CustomEvent('jenny:titlebar-load-toggle', { detail: { enabled } }));

  fire(true);
  await waitForUi(window, 20);
  assert.equal(storedAppearance(window).titlebarLoad, true);
  assert.equal(doc.documentElement.dataset.titlebarLoad, 'on');
  assert.equal(toggle().getAttribute('aria-checked'), 'true');

  const restore = refuseAppearanceWrites(window);
  t.after(restore);
  fire(false);
  await waitForUi(window, 20);
  assert.equal(storedAppearance(window).titlebarLoad, true);
  assert.equal(toggle().getAttribute('aria-checked'), 'true', 'the switch keeps the acknowledged value');
  assert.match(doc.getElementById('toastViewport').textContent, /could not be confirmed/i, 'the refused write is reported');
});
